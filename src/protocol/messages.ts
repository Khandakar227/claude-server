/**
 * Wire protocol schemas (zod). One source of truth for both the HTTP routes and
 * the WebSocket handler, so the run payload is validated identically everywhere.
 */
import { z } from "zod";
import type { RunRequest } from "../types.js";

const PermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
]);

/** The canonical run-request payload accepted over HTTP and WS. */
export const RunRequestSchema = z.object({
  user_prompt: z.string().min(1, "user_prompt is required"),
  system_prompt: z.string().optional(),
  session_id: z.string().min(1).optional(),
  system_prompt_mode: z.enum(["append", "replace"]).default("append"),
  persist: z.boolean().optional(),
  model: z.string().optional(),
  permission_mode: PermissionModeSchema.optional(),
  max_turns: z.number().int().positive().optional(),
  max_budget_usd: z.number().positive().optional(),
  allowed_tools: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type RunRequestInput = z.infer<typeof RunRequestSchema>;

/** Map the snake_case wire payload to the internal camelCase RunRequest. */
export function toRunRequest(input: RunRequestInput): RunRequest {
  return {
    userPrompt: input.user_prompt,
    systemPrompt: input.system_prompt,
    sessionId: input.session_id,
    systemPromptMode: input.system_prompt_mode,
    persist: input.persist,
    model: input.model,
    permissionMode: input.permission_mode,
    maxTurns: input.max_turns,
    maxBudgetUsd: input.max_budget_usd,
    allowedTools: input.allowed_tools,
    disallowedTools: input.disallowed_tools,
    cwd: input.cwd,
    metadata: input.metadata,
  };
}

/**
 * Inbound WebSocket frames. A client opens a socket then sends one of these.
 * `run` starts (or resumes) an agent; `cancel` aborts the active run; `ping`
 * is a liveness check answered with a `pong` event.
 */
export const WsClientFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run"), payload: RunRequestSchema }),
  z.object({ type: z.literal("cancel") }),
  z.object({ type: z.literal("ping") }),
]);

export type WsClientFrame = z.infer<typeof WsClientFrameSchema>;
