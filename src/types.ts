/**
 * Shared domain types used across the agent, transport, and session layers.
 */
import type { PermissionMode } from "./config.js";

/** Token accounting captured from the SDK's usage object. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
});

/** Terminal status of an agent run, mirroring the SDK result subtypes. */
export type RunStatus =
  | "success"
  | "error_max_turns"
  | "error_max_budget_usd"
  | "error_during_execution"
  | "cancelled"
  | "timeout";

/**
 * A normalized request to run the agent. Built from validated HTTP/WS input.
 * Fields left undefined fall back to server defaults in the runner.
 */
export interface RunRequest {
  systemPrompt?: string;
  userPrompt: string;
  /** When set, resume an existing session; otherwise a new one is created. */
  sessionId?: string;
  /** "append" keeps Claude Code's harness prompt; "replace" overrides it fully. */
  systemPromptMode: "append" | "replace";
  /**
   * When false, the conversation is ephemeral: no transcript is written to
   * ~/.claude/projects and the session cannot be resumed. Defaults to the
   * server's PERSIST_SESSIONS config when omitted.
   */
  persist?: boolean;
  model?: string;
  permissionMode?: PermissionMode;
  maxTurns?: number;
  maxBudgetUsd?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Override working directory; defaults to the per-session workspace. */
  cwd?: string;
  /** Arbitrary caller metadata stored with the session. */
  metadata?: Record<string, unknown>;
}

/** Summary persisted per session in the store. */
export interface SessionRecord {
  id: string;
  createdAt: number;
  lastUsedAt: number;
  title?: string;
  model?: string;
  cwd?: string;
  numRuns: number;
  numTurns: number;
  usage: TokenUsage;
  totalCostUsd: number;
  lastStatus?: RunStatus;
  metadata?: Record<string, unknown>;
}
