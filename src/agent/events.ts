/**
 * Normalized agent events.
 *
 * The runner translates the SDK's verbose `SDKMessage` stream into this small,
 * stable union. Both transports (WS frames, HTTP buffering, SSE) consume these
 * events, so the wire contract never depends on SDK internals.
 */
import type { RunStatus, TokenUsage } from "../types.js";
import { emptyUsage } from "../types.js";

export type AgentEvent =
  /** First event of every run: the session id (capture it to resume later). */
  | { type: "session"; sessionId: string; model: string }
  /** Streaming partial assistant text (only when streaming is enabled). */
  | { type: "delta"; text: string }
  /** Streaming partial reasoning/thinking text. */
  | { type: "thinking"; text: string }
  /** A complete assistant/user turn (text content joined). */
  | { type: "message"; role: "assistant" | "user"; text: string }
  /** The agent invoked a tool. */
  | { type: "tool_use"; id: string; name: string; input: unknown }
  /** A tool returned a result. */
  | { type: "tool_result"; toolUseId: string; isError: boolean; content: string }
  /** Incremental usage/cost snapshot. */
  | { type: "usage"; usage: TokenUsage; costUsd: number }
  /** Terminal event: final text plus totals. */
  | {
      type: "result";
      status: RunStatus;
      result: string;
      turns: number;
      usage: TokenUsage;
      costUsd: number;
      durationMs: number;
    }
  /** Terminal error event. */
  | { type: "error"; code: string; message: string }
  /** WS-only liveness reply. */
  | { type: "pong" };

/** Extract our TokenUsage shape from the SDK's usage object (best-effort). */
export function toTokenUsage(usage: unknown): TokenUsage {
  const u = (usage ?? {}) as Record<string, number | undefined>;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
  };
}

export const zeroUsage = emptyUsage;

/**
 * Map a single SDK message to zero or more AgentEvents.
 *
 * We read fields structurally (rather than importing Beta content-block types)
 * to stay resilient across SDK minor versions; `skipLibCheck` keeps this honest
 * without coupling us to the exact block typing.
 */
export function mapSdkMessage(msg: any): AgentEvent[] {
  switch (msg?.type) {
    case "system":
      if (msg.subtype === "init") {
        return [{ type: "session", sessionId: msg.session_id, model: msg.model }];
      }
      return [];

    case "stream_event": {
      const ev = msg.event;
      if (ev?.type === "content_block_delta") {
        const d = ev.delta;
        if (d?.type === "text_delta" && d.text) return [{ type: "delta", text: d.text }];
        if (d?.type === "thinking_delta" && d.thinking)
          return [{ type: "thinking", text: d.thinking }];
      }
      return [];
    }

    case "assistant":
    case "user": {
      const events: AgentEvent[] = [];
      const blocks = msg.message?.content;
      const role: "assistant" | "user" = msg.type;
      if (Array.isArray(blocks)) {
        const texts: string[] = [];
        for (const b of blocks) {
          if (b?.type === "text" && typeof b.text === "string") texts.push(b.text);
          else if (b?.type === "tool_use")
            events.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
          else if (b?.type === "tool_result")
            events.push({
              type: "tool_result",
              toolUseId: b.tool_use_id,
              isError: Boolean(b.is_error),
              content: stringifyToolContent(b.content),
            });
        }
        if (texts.length) events.push({ type: "message", role, text: texts.join("") });
      }
      return events;
    }

    case "result": {
      const usage = toTokenUsage(msg.usage);
      const costUsd = msg.total_cost_usd ?? 0;
      return [
        { type: "usage", usage, costUsd },
        {
          type: "result",
          status: msg.subtype as RunStatus,
          result: typeof msg.result === "string" ? msg.result : "",
          turns: msg.num_turns ?? 0,
          usage,
          costUsd,
          durationMs: msg.duration_ms ?? 0,
        },
      ];
    }

    default:
      return [];
  }
}

function stringifyToolContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c?.type === "text" ? c.text : JSON.stringify(c)))
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}
