import type { SessionMeta, SessionStorage } from '@cindy/maker-core';
import type Database from 'better-sqlite3';
import { openHeadlessSqlite } from './sqlite.js';

interface SessionRow {
  id: string;
  data: string;
}

export class SqliteSessionStorage implements SessionStorage {
  private readonly db: Database.Database;

  constructor(filePath: string) {
    this.db = openHeadlessSqlite(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS headless_sessions (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  async create(meta: Omit<SessionMeta, 'createdAt' | 'updatedAt'>): Promise<SessionMeta> {
    const now = Date.now();
    const row: SessionMeta = { ...meta, createdAt: now, updatedAt: now };
    this.db.prepare('INSERT INTO headless_sessions (id, data, updated_at) VALUES (?, ?, ?)').run(row.id, JSON.stringify(row), now);
    return row;
  }

  async get(id: string): Promise<SessionMeta | null> {
    const row = this.db.prepare('SELECT id, data FROM headless_sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return row ? JSON.parse(row.data) as SessionMeta : null;
  }

  async list(): Promise<SessionMeta[]> {
    const rows = this.db.prepare('SELECT id, data FROM headless_sessions ORDER BY updated_at DESC').all() as unknown as SessionRow[];
    return rows.map((row) => JSON.parse(row.data) as SessionMeta);
  }

  async update(id: string, patch: Partial<SessionMeta>): Promise<SessionMeta> {
    const current = await this.get(id);
    if (!current) throw new Error(`unknown session ${id}`);
    const row: SessionMeta = { ...current, ...patch, id: current.id, updatedAt: Date.now() };
    this.db.prepare('UPDATE headless_sessions SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(row), row.updatedAt, id);
    return row;
  }

  async compareAndClearSdkSessionId(id: string, expectedSdkSessionId: string): Promise<boolean> {
    return this.db.transaction(() => {
      const stored = this.db.prepare('SELECT id, data FROM headless_sessions WHERE id = ?').get(id) as SessionRow | undefined;
      if (!stored) return false;
      const current = JSON.parse(stored.data) as SessionMeta;
      if (current.sdkSessionId !== expectedSdkSessionId) return false;
      const row: SessionMeta = { ...current, sdkSessionId: undefined, updatedAt: Date.now() };
      const update = this.db.prepare('UPDATE headless_sessions SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(row), row.updatedAt, id);
      return update.changes === 1;
    })();
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM headless_sessions WHERE id = ?').run(id);
  }

  close(): void {
    this.db.close();
  }
}
