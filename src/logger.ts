/**
 * Structured logger (pino). Pretty-prints in dev when LOG_PRETTY=1.
 * Redacts known sensitive fields so tokens never leak into logs.
 */
import { pino } from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "headers.authorization",
      "authToken",
      "token",
      "*.AUTH_TOKEN",
      "*.ANTHROPIC_API_KEY",
    ],
    censor: "[redacted]",
  },
  ...(config.LOG_PRETTY
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss.l" },
        },
      }
    : {}),
});

export type Logger = typeof logger;
