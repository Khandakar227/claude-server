/**
 * Fastify application factory. Wires plugins, the global error handler, and all
 * routes (HTTP + WebSocket) onto a single instance. Kept side-effect-free so it
 * can be constructed in tests without binding a port.
 */
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { toErrorPayload } from "./errors.js";
import { Orchestrator } from "./agent/orchestrator.js";
import { InMemorySessionStore } from "./sessions/memory-store.js";
import { registerHttpRoutes } from "./transport/http.js";
import { registerWsRoute } from "./transport/ws.js";
import type { SessionStore } from "./sessions/store.js";

export interface AppContext {
  app: FastifyInstance;
  store: SessionStore;
  orchestrator: Orchestrator;
}

export async function buildApp(): Promise<AppContext> {
  // Cast keeps Fastify's instance on its default logger generic so route
  // registrations type-check; pino is structurally compatible at runtime.
  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    bodyLimit: 5 * 1024 * 1024,
  });

  const store = new InMemorySessionStore();
  const orchestrator = new Orchestrator(store);

  // Global error handler — maps AppError / unexpected errors to a stable shape.
  app.setErrorHandler((err, _req, reply) => {
    const { status, body } = toErrorPayload(err);
    if (status >= 500) app.log.error({ err }, "request error");
    reply.code(status).send(body);
  });

  await app.register(websocket, {
    options: { maxPayload: 5 * 1024 * 1024 },
  });

  registerHttpRoutes(app, { orchestrator, store });
  registerWsRoute(app, orchestrator);

  return { app, store, orchestrator };
}
