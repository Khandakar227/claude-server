/**
 * In-memory SessionStore implementation.
 *
 * Sufficient for a personal, single-process server. Records are lost on restart,
 * but sessions remain *resumable* regardless because the SDK owns the real
 * transcripts on disk — only the listing/accounting index is volatile. Swap for
 * a SQLite-backed store to make metadata durable.
 */
import type { SessionRecord } from "../types.js";
import type { SessionStore } from "./store.js";

export class InMemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>();

  async get(id: string): Promise<SessionRecord | undefined> {
    return this.records.get(id);
  }

  async list(): Promise<SessionRecord[]> {
    return [...this.records.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  async upsert(record: SessionRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async delete(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
}
