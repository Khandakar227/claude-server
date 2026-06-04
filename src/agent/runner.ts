/**
 * Agent runner: the single place that calls the Claude Agent SDK's `query()`.
 *
 * It maps a normalized RunRequest to SDK options, drives the message stream, and
 * yields our small AgentEvent union. It is transport-agnostic — HTTP and WS both
 * consume the same generator. Concurrency, queueing, timeouts, and session locks
 * are the orchestrator's job, not the runner's.
 */
import { mkdir } from "node:fs/promises";
import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { RunRequest } from "../types.js";
import { mapSdkMessage, type AgentEvent } from "./events.js";
import { resolveClaudeExecutable } from "./claude-path.js";

export interface RunnerOptions {
  /** Owned by the caller (orchestrator) so it can cancel / time out the run. */
  abortController: AbortController;
  /** Emit partial `delta`/`thinking` events. WS uses true; buffered HTTP false. */
  stream: boolean;
  /** Resolved working directory for this run. */
  cwd: string;
  /**
   * For NEW sessions, a pre-generated UUID to use as the session id (so the
   * caller knows the id up front and can isolate the workspace). Ignored when
   * the request resumes an existing session.
   */
  newSessionId?: string;
  /** When false, run ephemerally — no transcript written, not resumable. */
  persist: boolean;
}

/**
 * Build the SDK `prompt`. With no attachments it's a plain string. With
 * attachments we switch to streaming-input mode and yield a single structured
 * user message whose content is the attachment blocks followed by the text.
 */
function buildPrompt(req: RunRequest): string | AsyncIterable<SDKUserMessage> {
  if (!req.attachments?.length) return req.userPrompt;

  const blocks: Array<Record<string, unknown>> = [];
  for (const att of req.attachments) {
    const source = att.url
      ? { type: "url", url: att.url }
      : {
          type: "base64",
          media_type: att.mediaType ?? (att.type === "document" ? "application/pdf" : "image/png"),
          data: att.data,
        };
    blocks.push({ type: att.type, source });
  }
  blocks.push({ type: "text", text: req.userPrompt });

  const message = { role: "user", content: blocks };
  async function* once(): AsyncGenerator<SDKUserMessage> {
    yield { type: "user", message, parent_tool_use_id: null } as unknown as SDKUserMessage;
  }
  return once();
}

/** Build the SDK `systemPrompt` option from the request. */
function buildSystemPrompt(req: RunRequest): Options["systemPrompt"] {
  if (req.systemPromptMode === "replace" && req.systemPrompt) {
    return req.systemPrompt; // full override — no Claude Code harness prompt
  }
  // Default: keep Claude Code's preset and append the caller's instructions.
  return {
    type: "preset",
    preset: "claude_code",
    ...(req.systemPrompt ? { append: req.systemPrompt } : {}),
  };
}

function buildOptions(req: RunRequest, opts: RunnerOptions): Options {
  const options: Options = {
    abortController: opts.abortController,
    cwd: opts.cwd,
    model: req.model ?? config.DEFAULT_MODEL,
    permissionMode: req.permissionMode ?? config.DEFAULT_PERMISSION_MODE,
    maxTurns: req.maxTurns ?? config.DEFAULT_MAX_TURNS,
    includePartialMessages: opts.stream,
    systemPrompt: buildSystemPrompt(req),
    // Honor the user's ~/.claude settings & MCP servers, but not arbitrary
    // project/local files under the (possibly caller-supplied) cwd.
    settingSources: ["user"],
    stderr: (data: string) => logger.debug({ stderr: data.trim() }, "claude stderr"),
  };

  // Point the SDK at the system-installed Claude Code so the bundle/exe doesn't
  // depend on the SDK's optional native-CLI package. Falls back to the SDK
  // default when no executable is found.
  const claudePath = resolveClaudeExecutable();
  if (claudePath) options.pathToClaudeCodeExecutable = claudePath;

  if (req.sessionId) options.resume = req.sessionId;
  else if (opts.newSessionId) options.sessionId = opts.newSessionId;
  if (!opts.persist) options.persistSession = false; // ephemeral: no transcript on disk
  if (req.maxBudgetUsd != null) options.maxBudgetUsd = req.maxBudgetUsd;
  if (req.allowedTools) options.allowedTools = req.allowedTools;
  if (req.disallowedTools) options.disallowedTools = req.disallowedTools;

  return options;
}

/**
 * Run the agent, yielding AgentEvents until a terminal `result` or `error`.
 * Always finishes with exactly one terminal event.
 */
export async function* runAgent(
  req: RunRequest,
  opts: RunnerOptions,
): AsyncGenerator<AgentEvent> {
  await mkdir(opts.cwd, { recursive: true }).catch(() => {});

  const options = buildOptions(req, opts);
  const startedAt = Date.now();
  let sawResult = false;

  try {
    const stream = query({ prompt: buildPrompt(req), options });
    for await (const msg of stream) {
      for (const event of mapSdkMessage(msg)) {
        if (event.type === "result") sawResult = true;
        yield event;
      }
    }
    // The SDK ended without a result message (rare) — synthesize a terminal one.
    if (!sawResult) {
      yield {
        type: "error",
        code: "AGENT_ERROR",
        message: "Agent stream ended without a result",
      };
    }
  } catch (err) {
    const aborted = opts.abortController.signal.aborted;
    const reason = String(opts.abortController.signal.reason ?? "");
    if (aborted) {
      const isTimeout = reason === "timeout";
      yield {
        type: "error",
        code: isTimeout ? "TIMEOUT" : "CANCELLED",
        message: isTimeout ? "Run timed out" : "Run cancelled",
      };
    } else {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "agent run failed");
      yield {
        type: "error",
        code: /login|credential|oauth|401/i.test(message)
          ? "AUTH_EXPIRED"
          : "AGENT_ERROR",
        message,
      };
    }
  } finally {
    logger.debug(
      { durationMs: Date.now() - startedAt, sessionId: req.sessionId },
      "agent run finished",
    );
  }
}
