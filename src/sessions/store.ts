/**
 * Session metadata store.
 *
 * This indexes sessions for listing/accounting. It is NOT the source of truth
 * for conversation context — Claude Code persists full transcripts under
 * ~/.claude/projects, and the SDK rehydrates them on `resume`. We only track
 * lightweight metadata (usage, cost, timestamps) so we can list and meter
 * without parsing transcripts.
 *
 * The interface is deliberately small so the in-memory implementation can be
 * swapped for SQLite later without touching callers.
 */
import type { SessionRecord } from "../types.js";

export interface SessionStore {
  get(id: string): Promise<SessionRecord | undefined>;
  list(): Promise<SessionRecord[]>;
  /** Create or update a record (used after each run completes). */
  upsert(record: SessionRecord): Promise<void>;
  delete(id: string): Promise<boolean>;
}
