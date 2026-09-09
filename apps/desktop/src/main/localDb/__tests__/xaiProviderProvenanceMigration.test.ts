import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

// Migration companion scripts intentionally use CommonJS so the runtime loader can replay them.
const { default: migration0090 } = (await import(
  '../../../../drizzle/scripts/0090_distinguish_xai_provider_provenance'
)) as { default: { run(db: Database.Database): void } };

describe('0090 xAI provider provenance migration', () => {
  it('namespaces only Pi xai rows that predate official SuperGrok support', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY NOT NULL,
          agent_kind TEXT NOT NULL,
          provider_id TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE schedules (
          id TEXT PRIMARY KEY NOT NULL,
          agent_kind TEXT NOT NULL,
          provider_id TEXT,
          created_at INTEGER NOT NULL
        );
        INSERT INTO sessions (id, agent_kind, provider_id, created_at) VALUES
          ('pi-legacy-custom', 'pi', 'xai', 1785540088999),
          ('pi-official-boundary', 'pi', 'xai', 1785540089000),
          ('pi-official-later', 'pi', 'xai', 1785540089001),
          ('pi-already-namespaced', 'pi', 'custom:xai', 1785540088999),
          ('pi-unspecified', 'pi', NULL, 1785540088999),
          ('claude-official', 'claude-code', 'xai', 1785540088999),
          ('codex-official', 'codex', 'xai', 1785540088999);
        INSERT INTO schedules (id, agent_kind, provider_id, created_at) VALUES
          ('schedule-pi-legacy-custom', 'pi', 'xai', 1785540088999),
          ('schedule-pi-official', 'pi', 'xai', 1785540089000),
          ('schedule-pi-already-namespaced', 'pi', 'custom:xai', 1785540088999),
          ('schedule-claude-official', 'claude-code', 'xai', 1785540088999);
      `);

      migration0090.run(db);

      expect(db.prepare('SELECT id, provider_id FROM sessions ORDER BY id').all()).toEqual([
        { id: 'claude-official', provider_id: 'xai' },
        { id: 'codex-official', provider_id: 'xai' },
        { id: 'pi-already-namespaced', provider_id: 'custom:xai' },
        { id: 'pi-legacy-custom', provider_id: 'custom:xai' },
        { id: 'pi-official-boundary', provider_id: 'xai' },
        { id: 'pi-official-later', provider_id: 'xai' },
        { id: 'pi-unspecified', provider_id: null },
      ]);
      expect(db.prepare('SELECT id, provider_id FROM schedules ORDER BY id').all()).toEqual([
        { id: 'schedule-claude-official', provider_id: 'xai' },
        { id: 'schedule-pi-already-namespaced', provider_id: 'custom:xai' },
        { id: 'schedule-pi-legacy-custom', provider_id: 'custom:xai' },
        { id: 'schedule-pi-official', provider_id: 'xai' },
      ]);
    } finally {
      db.close();
    }
  });

  it('is safe for partial legacy replay schemas and reruns', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY NOT NULL,
          agent_kind TEXT NOT NULL,
          provider_id TEXT,
          created_at INTEGER NOT NULL
        );
        INSERT INTO sessions (id, agent_kind, provider_id, created_at)
        VALUES ('pi-legacy-custom', 'pi', 'xai', 1);
      `);

      expect(() => migration0090.run(db)).not.toThrow();
      expect(() => migration0090.run(db)).not.toThrow();
      expect(db.prepare('SELECT provider_id FROM sessions').pluck().get()).toBe('custom:xai');
    } finally {
      db.close();
    }
  });

  it('leaves ambiguous rows untouched when a partial schema lacks creation time', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY NOT NULL,
          agent_kind TEXT NOT NULL,
          provider_id TEXT
        );
        INSERT INTO sessions (id, agent_kind, provider_id)
        VALUES ('pi-ambiguous', 'pi', 'xai');
      `);

      expect(() => migration0090.run(db)).not.toThrow();
      expect(db.prepare('SELECT provider_id FROM sessions').pluck().get()).toBe('xai');
    } finally {
      db.close();
    }
  });
});
