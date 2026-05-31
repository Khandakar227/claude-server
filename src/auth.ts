/**
 * Bearer-token authentication, shared by the HTTP and WebSocket transports.
 *
 * Localhost binding is the first line of defense; this token is the second.
 * Comparison is constant-time to avoid leaking the token via timing.
 */
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Extract a bearer token from an Authorization header or `?token=` query. */
export function extractToken(
  headers: Record<string, unknown>,
  query?: Record<string, unknown>,
): string | undefined {
  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim();
  }
  // WebSocket clients in browsers cannot set headers; allow a query token.
  const q = query?.["token"];
  if (typeof q === "string" && q.length > 0) return q;
  return undefined;
}

export function isAuthorized(token: string | undefined): boolean {
  return token != null && safeEqual(token, config.AUTH_TOKEN);
}
