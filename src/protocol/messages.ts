/**
 * Wire protocol schemas (zod). One source of truth for both the HTTP routes and
 * the WebSocket handler, so the run payload is validated identically everywhere.
 */
import { z } from "zod";
import type { Attachment, RunRequest } from "../types.js";

const PermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
]);

/** A single attachment: image or document, via inline base64 (`data`) or `url`. */
const AttachmentSchema = z
  .object({
    type: z.enum(["image", "document"]),
    media_type: z.string().optional(),
    data: z.string().optional(),
    url: z.string().url().optional(),
  })
  .refine((a) => Boolean(a.data || a.url), {
    message: "attachment requires 'data' (base64) or 'url'",
  });

type AttachmentInput = z.infer<typeof AttachmentSchema>;

/** Normalize wire attachment → internal Attachment, parsing any data: URL prefix. */
function normalizeAttachment(a: AttachmentInput): Attachment {
  let mediaType = a.media_type;
  let data = a.data;
  if (data) {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(data);
    if (m) {
      mediaType = mediaType ?? m[1];
      data = m[2];
    }
  }
  return { type: a.type, mediaType, data, url: a.url };
}

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
  attachments: z.array(AttachmentSchema).max(20).optional(),
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
    attachments: input.attachments?.map(normalizeAttachment),
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
