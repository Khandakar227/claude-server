/**
 * Typed application errors. Each carries a stable machine-readable `code` and an
 * HTTP `status`, so the HTTP layer and the WebSocket layer can render them
 * consistently. Use `toErrorPayload()` to serialize for the wire.
 */

export type ErrorCode =
  | "UNAUTHORIZED"
  | "BAD_REQUEST"
  | "SESSION_BUSY"
  | "QUEUE_FULL"
  | "TIMEOUT"
  | "CANCELLED"
  | "AGENT_ERROR"
  | "AUTH_EXPIRED"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, status: number, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const Errors = {
  unauthorized: (msg = "Missing or invalid bearer token") =>
    new AppError("UNAUTHORIZED", 401, msg),
  badRequest: (msg: string, details?: unknown) =>
    new AppError("BAD_REQUEST", 400, msg, details),
  sessionBusy: (sessionId: string) =>
    new AppError(
      "SESSION_BUSY",
      409,
      `Session ${sessionId} already has a run in progress`,
    ),
  queueFull: (max: number) =>
    new AppError("QUEUE_FULL", 429, `Run queue is full (max ${max})`),
  timeout: (ms: number) =>
    new AppError("TIMEOUT", 504, `Run exceeded timeout of ${ms}ms`),
  cancelled: (msg = "Run was cancelled") => new AppError("CANCELLED", 499, msg),
  agent: (msg: string, details?: unknown) =>
    new AppError("AGENT_ERROR", 502, msg, details),
  authExpired: () =>
    new AppError(
      "AUTH_EXPIRED",
      503,
      "Claude Code authentication failed — run `claude` interactively to re-login",
    ),
  internal: (msg = "Internal server error") => new AppError("INTERNAL", 500, msg),
} as const;

export interface ErrorPayload {
  error: { code: ErrorCode; message: string; details?: unknown };
}

export function toErrorPayload(err: unknown): { status: number; body: ErrorPayload } {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message, details: err.details } },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  // Heuristic: surface auth/login failures from the SDK as a clear, actionable code.
  if (/login|credential|oauth|unauthorized|401/i.test(message)) {
    const e = Errors.authExpired();
    return { status: e.status, body: { error: { code: e.code, message: e.message } } };
  }
  // The SDK locates Claude Code via PATH; a packaged exe inherits the user's
  // PATH. If it can't be found, say so plainly instead of a generic 500.
  if (/ENOENT|not found|spawn .*claude|could not (find|locate).*claude/i.test(message)) {
    return {
      status: 503,
      body: {
        error: {
          code: "AGENT_ERROR",
          message:
            "Claude Code CLI not found on PATH. Install Claude Code and ensure `claude` is on your PATH.",
        },
      },
    };
  }
  return { status: 500, body: { error: { code: "INTERNAL", message } } };
}
