/**
 * WebSocket transport — the real-time channel.
 *
 * Protocol:
 *   client → { type: "run", payload: <RunRequest> }   start/resume an agent
 *   client → { type: "cancel" }                        abort the active run
 *   client → { type: "ping" }                          liveness check
 *   server → AgentEvent frames: session | delta | thinking | message |
 *            tool_use | tool_result | usage | result | error | pong
 *
 * One active run per socket. To continue a conversation, wait for `result`,
 * then send another `run` carrying the `session_id` from the `session` frame.
 */
import type { FastifyInstance } from "fastify";
import { extractToken, isAuthorized } from "../auth.js";
import { AppError } from "../errors.js";
import { logger } from "../logger.js";
import { WsClientFrameSchema, toRunRequest } from "../protocol/messages.js";
import type { AgentEvent } from "../agent/events.js";
import type { Orchestrator, RunHandle } from "../agent/orchestrator.js";

/** Minimal structural type for the `ws` socket (avoids a hard type dependency). */
interface WsSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message" | "close" | "error", cb: (arg: Buffer) => void): void;
}

export function registerWsRoute(app: FastifyInstance, orchestrator: Orchestrator): void {
  app.get("/v1/ws", { websocket: true }, (socket: WsSocket, req) => {
    const token = extractToken(
      req.headers as Record<string, unknown>,
      req.query as Record<string, unknown>,
    );
    if (!isAuthorized(token)) {
      socket.send(JSON.stringify({ type: "error", code: "UNAUTHORIZED", message: "Invalid token" }));
      socket.close(1008, "unauthorized");
      return;
    }

    let current: RunHandle | null = null;
    const send = (event: AgentEvent | Record<string, unknown>) =>
      socket.send(JSON.stringify(event));

    const startRun = async (payload: unknown) => {
      if (current) {
        send({ type: "error", code: "SESSION_BUSY", message: "A run is already active on this socket" });
        return;
      }
      let handle: RunHandle;
      try {
        handle = orchestrator.submit(toRunRequest(payload as never), { stream: true });
      } catch (err) {
        const code = err instanceof AppError ? err.code : "INTERNAL";
        send({ type: "error", code, message: err instanceof Error ? err.message : String(err) });
        return;
      }
      current = handle;
      send({ type: "session", sessionId: handle.sessionId, model: "" });
      try {
        for await (const event of handle.events) {
          if (event.type === "session") continue; // already announced with id
          send(event);
        }
      } catch (err) {
        logger.error({ err }, "ws run error");
        send({ type: "error", code: "INTERNAL", message: "run failed" });
      } finally {
        current = null;
      }
    };

    socket.on("message", (raw: Buffer) => {
      let frame;
      try {
        frame = WsClientFrameSchema.parse(JSON.parse(raw.toString()));
      } catch {
        send({ type: "error", code: "BAD_REQUEST", message: "Malformed frame" });
        return;
      }
      switch (frame.type) {
        case "ping":
          send({ type: "pong" });
          break;
        case "cancel":
          current?.cancel("client cancel");
          break;
        case "run":
          void startRun(frame.payload);
          break;
      }
    });

    socket.on("close", () => current?.cancel("socket closed"));
    socket.on("error", () => current?.cancel("socket error"));
  });
}
