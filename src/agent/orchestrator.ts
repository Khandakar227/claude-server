/**
 * Orchestrator: governs how runs execute.
 *
 *  - Bounds concurrency with a semaphore (MAX_CONCURRENT_RUNS).
 *  - Queues overflow up to MAX_QUEUE; rejects beyond that (429).
 *  - Enforces one in-flight run per session id (resuming the same session
 *    concurrently corrupts its transcript) — rejects collisions (409).
 *  - Tracks active runs so they can be cancelled (by run id or session id).
 *  - Updates the session store with usage/cost when a run completes.
 *
 * `submit()` performs the synchronous admission checks (so transports can return
 * 409/429 immediately) and returns a handle whose `events` generator lazily
 * acquires a concurrency slot, runs the agent, and always releases its slot and
 * locks in a finally block.
 */
import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../config.js";
import { Errors } from "../errors.js";
import { logger } from "../logger.js";
import { emptyUsage, type RunRequest, type SessionRecord } from "../types.js";
import type { SessionStore } from "../sessions/store.js";
import { runAgent } from "./runner.js";
import type { AgentEvent } from "./events.js";

/** A simple FIFO counting semaphore with abortable acquisition. */
class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  acquire(signal: AbortSignal): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener("abort", onAbort);
        resolve(); // permit handed directly to us; no decrement here
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error("aborted while queued"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(grant);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.permits++;
  }
}

export interface RunHandle {
  /** Server-assigned run id (distinct from the conversation session id). */
  runId: string;
  /** The session id (pre-assigned for new sessions, given for resumes). */
  sessionId: string;
  /** Whether this run resumes an existing session. */
  resumed: boolean;
  /** Lazily-started event stream; awaiting it acquires a concurrency slot. */
  events: AsyncGenerator<AgentEvent>;
  /** Cancel this run (while queued or running). */
  cancel: (reason?: string) => void;
}

interface ActiveRun {
  abort: AbortController;
  sessionId: string;
}

export class Orchestrator {
  private readonly sem: Semaphore;
  private inFlight = 0;
  private readonly sessionLocks = new Set<string>();
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(private readonly store: SessionStore) {
    this.sem = new Semaphore(config.MAX_CONCURRENT_RUNS);
  }

  stats() {
    return {
      inFlight: this.inFlight,
      queued: this.sem.waiting,
      maxConcurrent: config.MAX_CONCURRENT_RUNS,
      maxQueue: config.MAX_QUEUE,
      activeSessions: [...this.sessionLocks],
    };
  }

  /** Cancel by run id. Returns true if a matching active run was found. */
  cancelRun(runId: string, reason = "cancelled"): boolean {
    const run = this.activeRuns.get(runId);
    if (!run) return false;
    run.abort.abort(reason);
    return true;
  }

  /** Cancel whatever run currently holds the given session id. */
  cancelSession(sessionId: string, reason = "cancelled"): boolean {
    for (const run of this.activeRuns.values()) {
      if (run.sessionId === sessionId) {
        run.abort.abort(reason);
        return true;
      }
    }
    return false;
  }

  /**
   * Admit a run. Throws AppError synchronously on a busy session or full queue.
   * On success returns a handle; iterate `handle.events` to drive the run.
   */
  submit(req: RunRequest, opts: { stream: boolean }): RunHandle {
    // Admission control --------------------------------------------------
    if (req.sessionId && this.sessionLocks.has(req.sessionId)) {
      throw Errors.sessionBusy(req.sessionId);
    }
    const willQueue = this.inFlight >= config.MAX_CONCURRENT_RUNS;
    if (willQueue && this.sem.waiting >= config.MAX_QUEUE) {
      throw Errors.queueFull(config.MAX_QUEUE);
    }

    const resumed = Boolean(req.sessionId);
    const sessionId = req.sessionId ?? randomUUID();
    const runId = randomUUID();
    const cwd = req.cwd ?? join(config.WORKSPACE_ROOT, sessionId);
    const persist = req.persist ?? config.PERSIST_SESSIONS;
    const abort = new AbortController();

    // Reserve the lock immediately so a racing request sees it as busy.
    this.sessionLocks.add(sessionId);
    this.activeRuns.set(runId, { abort, sessionId });

    const events = this.drive(req, { runId, sessionId, resumed, cwd, persist, abort, ...opts });

    return {
      runId,
      sessionId,
      resumed,
      events,
      cancel: (reason = "cancelled") => abort.abort(reason),
    };
  }

  private async *drive(
    req: RunRequest,
    ctx: {
      runId: string;
      sessionId: string;
      resumed: boolean;
      cwd: string;
      persist: boolean;
      abort: AbortController;
      stream: boolean;
    },
  ): AsyncGenerator<AgentEvent> {
    const timer = setTimeout(() => ctx.abort.abort("timeout"), config.RUN_TIMEOUT_MS);
    let slotHeld = false;
    let model: string | undefined;

    try {
      await this.sem.acquire(ctx.abort.signal);
      slotHeld = true;
      this.inFlight++;

      for await (const event of runAgent(req, {
        abortController: ctx.abort,
        stream: ctx.stream,
        cwd: ctx.cwd,
        persist: ctx.persist,
        newSessionId: ctx.resumed ? undefined : ctx.sessionId,
      })) {
        if (event.type === "session") model = event.model;
        if (event.type === "result" && ctx.persist) {
          // Only index persisted sessions; ephemeral runs leave no trace.
          await this.persist(ctx.sessionId, req, ctx.cwd, model, event);
        }
        yield event;
      }
    } catch (err) {
      // The only throw path here is an aborted acquire (cancelled while queued).
      logger.debug({ err, runId: ctx.runId }, "run rejected before start");
      yield { type: "error", code: "CANCELLED", message: "Run cancelled while queued" };
    } finally {
      clearTimeout(timer);
      if (slotHeld) {
        this.inFlight--;
        this.sem.release();
      }
      this.activeRuns.delete(ctx.runId);
      this.sessionLocks.delete(ctx.sessionId);
      if (!ctx.persist) await this.cleanupEphemeral(ctx.sessionId, ctx.cwd);
    }
  }

  /**
   * Best-effort no-trace cleanup for ephemeral runs. `persistSession: false`
   * already suppresses the conversation, but Claude Code may still leave a tiny
   * title stub and the per-session workspace dir — remove both.
   */
  private async cleanupEphemeral(sessionId: string, cwd: string): Promise<void> {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
    try {
      const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
      const projects = join(configDir, "projects");
      const entries = await readdir(projects);
      await Promise.all(
        entries
          .filter((name) => name.includes(sessionId))
          .map((name) => rm(join(projects, name), { recursive: true, force: true }).catch(() => {})),
      );
    } catch {
      // projects dir may not exist or be unreadable — nothing to clean.
    }
  }

  private async persist(
    sessionId: string,
    req: RunRequest,
    cwd: string,
    model: string | undefined,
    result: Extract<AgentEvent, { type: "result" }>,
  ): Promise<void> {
    const now = Date.now();
    const prev = await this.store.get(sessionId);
    const usage = prev?.usage ?? emptyUsage();

    const record: SessionRecord = {
      id: sessionId,
      createdAt: prev?.createdAt ?? now,
      lastUsedAt: now,
      title: prev?.title ?? req.userPrompt.slice(0, 80),
      model: model ?? prev?.model,
      cwd,
      numRuns: (prev?.numRuns ?? 0) + 1,
      numTurns: (prev?.numTurns ?? 0) + result.turns,
      usage: {
        inputTokens: usage.inputTokens + result.usage.inputTokens,
        outputTokens: usage.outputTokens + result.usage.outputTokens,
        cacheCreationInputTokens:
          usage.cacheCreationInputTokens + result.usage.cacheCreationInputTokens,
        cacheReadInputTokens:
          usage.cacheReadInputTokens + result.usage.cacheReadInputTokens,
      },
      totalCostUsd: (prev?.totalCostUsd ?? 0) + result.costUsd,
      lastStatus: result.status,
      metadata: req.metadata ?? prev?.metadata,
    };
    await this.store.upsert(record);
  }
}
