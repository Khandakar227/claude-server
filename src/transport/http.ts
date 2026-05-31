/**
 * HTTP transport. Registers REST routes for buffered runs, an SSE streaming
 * endpoint, session management, and usage accounting. The WebSocket route is
 * registered separately (see ws.ts).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { extractToken, isAuthorized } from "../auth.js";
import { Errors, toErrorPayload } from "../errors.js";
import { logger } from "../logger.js";
import { RunRequestSchema, toRunRequest } from "../protocol/messages.js";
import type { AgentEvent } from "../agent/events.js";
import type { Orchestrator } from "../agent/orchestrator.js";
import type { SessionStore } from "../sessions/store.js";

export interface HttpDeps {
  orchestrator: Orchestrator;
  store: SessionStore;
}

/** preHandler that rejects unauthenticated requests. */
function requireAuth(req: FastifyRequest, reply: FastifyReply, done: () => void) {
  const token = extractToken(req.headers as Record<string, unknown>, req.query as Record<string, unknown>);
  if (!isAuthorized(token)) {
    const { status, body } = toErrorPayload(Errors.unauthorized());
    reply.code(status).send(body);
    return;
  }
  done();
}

/** Parse + validate a run body into a RunRequest, throwing AppError on failure. */
function parseRunBody(body: unknown) {
  const parsed = RunRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw Errors.badRequest("Invalid run request", parsed.error.flatten());
  }
  return toRunRequest(parsed.data);
}

export function registerHttpRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const { orchestrator, store } = deps;

  // --- Health (public) ---------------------------------------------------
  app.get("/health", async () => ({
    status: "ok",
    uptimeSec: Math.round(process.uptime()),
    ...orchestrator.stats(),
  }));

  // --- Buffered run ------------------------------------------------------
  app.post("/v1/agents/run", { preHandler: requireAuth }, async (req, reply) => {
    const request = parseRunBody(req.body);
    const handle = orchestrator.submit(request, { stream: false });

    const toolCalls: Array<{ name: string; input: unknown }> = [];
    const assistantText: string[] = [];
    let terminal: Extract<AgentEvent, { type: "result" }> | undefined;
    let errorEvent: Extract<AgentEvent, { type: "error" }> | undefined;

    for await (const event of handle.events) {
      switch (event.type) {
        case "message":
          if (event.role === "assistant") assistantText.push(event.text);
          break;
        case "tool_use":
          toolCalls.push({ name: event.name, input: event.input });
          break;
        case "result":
          terminal = event;
          break;
        case "error":
          errorEvent = event;
          break;
      }
    }

    if (errorEvent) {
      const { status, body } = toErrorPayload(Errors.agent(errorEvent.message));
      return reply.code(errorEvent.code === "CANCELLED" ? 499 : status).send(body);
    }

    return reply.send({
      session_id: handle.sessionId,
      result: terminal?.result || assistantText.join("\n"),
      status: terminal?.status ?? "error_during_execution",
      turns: terminal?.turns ?? 0,
      tool_calls: toolCalls,
      usage: terminal?.usage,
      cost_usd: terminal?.costUsd ?? 0,
      duration_ms: terminal?.durationMs ?? 0,
    });
  });

  // --- SSE streaming run -------------------------------------------------
  app.post("/v1/agents/stream", { preHandler: requireAuth }, async (req, reply) => {
    const request = parseRunBody(req.body);
    const handle = orchestrator.submit(request, { stream: true });

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const send = (event: AgentEvent) => {
      raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    // Cancel the run if the client disconnects.
    raw.on("close", () => handle.cancel("client disconnected"));

    // Emit the session id first thing, before any model output.
    send({ type: "session", sessionId: handle.sessionId, model: "" });

    try {
      for await (const event of handle.events) {
        if (event.type === "session") continue; // already sent above (with id)
        send(event);
      }
    } catch (err) {
      logger.error({ err }, "SSE stream error");
      send({ type: "error", code: "INTERNAL", message: "stream failed" });
    } finally {
      raw.write("event: done\ndata: {}\n\n");
      raw.end();
    }
  });

  // --- Sessions ----------------------------------------------------------
  app.get("/v1/sessions", { preHandler: requireAuth }, async () => ({
    sessions: await store.list(),
  }));

  app.get<{ Params: { id: string } }>(
    "/v1/sessions/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const record = await store.get(req.params.id);
      if (!record) return reply.code(404).send(toErrorPayload(Errors.badRequest("Unknown session")).body);
      return record;
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/v1/sessions/:id",
    { preHandler: requireAuth },
    async (req) => {
      orchestrator.cancelSession(req.params.id, "session deleted");
      const deleted = await store.delete(req.params.id);
      return { deleted };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/sessions/:id/cancel",
    { preHandler: requireAuth },
    async (req) => ({ cancelled: orchestrator.cancelSession(req.params.id) }),
  );

  // --- Usage ledger ------------------------------------------------------
  app.get("/v1/usage", { preHandler: requireAuth }, async () => {
    const sessions = await store.list();
    const totals = sessions.reduce(
      (acc, s) => {
        acc.input += s.usage.inputTokens;
        acc.output += s.usage.outputTokens;
        acc.cacheRead += s.usage.cacheReadInputTokens;
        acc.cacheCreation += s.usage.cacheCreationInputTokens;
        acc.costUsd += s.totalCostUsd;
        acc.runs += s.numRuns;
        return acc;
      },
      { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0, runs: 0 },
    );
    return { sessions: sessions.length, totals };
  });
}
