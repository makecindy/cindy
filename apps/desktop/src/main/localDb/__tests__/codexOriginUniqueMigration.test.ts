import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

// Migration companion scripts intentionally use CommonJS so the runtime loader can replay them.
const migration0090 =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../../../drizzle/scripts/0090_chunky_william_stryker.ts') as {
    run(db: Database.Database): void;
  };

describe('0090 schedule origin uniqueness migration', () => {
  it('clears duplicate legacy origins before creating the unique index', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE schedules (
          id TEXT PRIMARY KEY NOT NULL,
          origin_kind TEXT,
          origin_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO schedules (id, origin_kind, origin_id, created_at, updated_at) VALUES
          ('older', 'codex-automation', 'daily', 100, 200),
          ('newer', 'codex-automation', 'daily', 150, 300),
          ('other', 'codex-automation', 'weekly', 100, 100),
          ('partial', 'codex-automation', NULL, 100, 100),
          ('local', NULL, NULL, 100, 100);
      `);

      migration0090.run(db);
      migration0090.run(db);

      expect(
        db.prepare('SELECT id, origin_kind, origin_id FROM schedules ORDER BY id').all(),
      ).toEqual([
        { id: 'local', origin_kind: null, origin_id: null },
        { id: 'newer', origin_kind: 'codex-automation', origin_id: 'daily' },
        { id: 'older', origin_kind: null, origin_id: null },
        { id: 'other', origin_kind: 'codex-automation', origin_id: 'weekly' },
        { id: 'partial', origin_kind: 'codex-automation', origin_id: null },
      ]);
      expect(
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='index' AND name='uniq_schedules_origin'",
          )
          .get(),
      ).toBeTruthy();
      expect(() =>
        db
          .prepare(
            `
            INSERT INTO schedules (id, origin_kind, origin_id, created_at, updated_at)
            VALUES ('duplicate', 'codex-automation', 'daily', 400, 400)
          `,
          )
          .run(),
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      db.close();
    }
  });

  it('is a no-op for partial replay databases without schedules', () => {
    const db = new Database(':memory:');
    try {
      expect(() => migration0090.run(db)).not.toThrow();
    } finally {
      db.close();
    }
  });
});
