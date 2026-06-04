/**
 * Structured logger (pino). Pretty-prints in dev when LOG_PRETTY=1.
 * Redacts known sensitive fields so tokens never leak into logs.
 *
 * Pretty output uses pino-pretty as an IN-PROCESS stream rather than pino's
 * transport mechanism: transports spawn a worker thread from a file on disk,
 * which does not exist inside a single-file bundle / packaged exe and would
 * crash at startup. The in-process stream bundles cleanly.
 */
import { pino } from "pino";
import prettyFactory from "pino-pretty";
import { config } from "./config.js";

const options = {
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
};

function build() {
  if (config.LOG_PRETTY) {
    try {
      const stream = prettyFactory({ colorize: true, translateTime: "HH:MM:ss.l" });
      return pino(options, stream);
    } catch {
      // pino-pretty unavailable for some reason — fall back to JSON logging.
    }
  }
  return pino(options);
}

export const logger = build();
export type Logger = typeof logger;
