import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const { default: migration0074 } = (await import(
  '../../../../drizzle/scripts/0074_bridge_legacy_migration_lineage'
)) as { default: { run(db: Database.Database): void } };

const LEGACY_LINEAGE = [
  [
    47,
    '0047_add_session_summary.sql',
    '44c224320ca6f5059d5184deae8f5d074f97bfa6502f3d73a54894a962edaf15',
  ],
  [
    60,
    '0060_orange_penance.sql',
    'd1dcd9ee1279ef86f5e0a136b8e1b786b11d462373f8ed464476ae3062312ffb',
  ],
  [
    62,
    '0062_third_pepper_potts.sql',
    '8a3ba2f92ebc495995f23a3727a65398fce1a877ffcb08d99df8705f21f49837',
  ],
  [
    63,
    '0063_secret_dreaming_celestial.sql',
    'd07bdac33796fe1ba80230207f0bf5834d0bf9c9df0c68fe372cbbba42bc7ee8',
  ],
  [
    64,
    '0064_amusing_white_tiger.sql',
    'ef297d4140b49cb3f6e87d58ea76e7f5a427fc6b3857a02210b9108650dcab23',
  ],
] as const;

const CANONICAL_LINEAGE = [
  [47, '0047_lame_malice.sql', '06bfc3ee9e88b6c12fe951e027fb45d647d2a6d20b9745e611f8abf0e6e1d3de'],
  [
    60,
    '0060_orange_penance.sql',
    'c102a337791107a5e5e747851b259b7fe77e6e3452e878977c174da7e51b9240',
  ],
  [62, '0062_flaky_mimic.sql', '77b8741ac31c159eb422746c0165d102ad65693236c80d0ff055fd70cd43fe68'],
  [
    63,
    '0063_handy_tenebrous.sql',
    '25951e494866345cbbd0cf9031b486d086598f94ed95bbca137905381aed814a',
  ],
  [
    64,
    '0064_icy_bruce_banner.sql',
    '94b35ed3f35d5908bd6810007e3017c761b5e68ac6b3b43e80b22aed0b89feae',
  ],
] as const;

function createLegacyDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE migration_history (
      seq INTEGER PRIMARY KEY NOT NULL,
      file_name TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL,
      permission_mode TEXT
    );
    CREATE TABLE schedule_runs (
      id TEXT PRIMARY KEY NOT NULL
    );
    INSERT INTO sessions (id, permission_mode) VALUES
      ('legacy-plan', 'plan'),
      ('plain', 'acceptEdits');
  `);
  const insert = db.prepare(
    `INSERT INTO migration_history (seq, file_name, content_hash, applied_at)
     VALUES (?, ?, ?, ?)`,
  );
  for (const [seq, fileName, hash] of LEGACY_LINEAGE) {
    insert.run(seq, fileName, hash, 1_000 + seq);
  }
  return db;
}

function columnNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info('${tableName}')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}

function historyRows(db: Database.Database): unknown[] {
  return db
    .prepare(
      `SELECT seq, file_name, content_hash, applied_at
       FROM migration_history
       ORDER BY seq`,
    )
    .all();
}

describe('0074 legacy migration lineage bridge', () => {
  it('atomically fills canonical semantics and canonicalizes the exact legacy lineage', () => {
    const db = createLegacyDb();
    try {
      migration0074.run(db);

      expect(columnNames(db, 'sessions')).toEqual(
        expect.arrayContaining(['plan_mode_enabled', 'active_turn_started_at', 'active_turn_pid']),
      );
      expect(columnNames(db, 'schedule_runs')).toContain('heartbeat_at');
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_aliases'")
          .get(),
      ).toBeTruthy();
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_project_aliases_updated_at'",
          )
          .get(),
      ).toBeTruthy();
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='device_link_ownership'",
          )
          .get(),
      ).toBeTruthy();
      expect(
        db
          .prepare(
            `SELECT id, permission_mode, plan_mode_enabled
           FROM sessions
           ORDER BY id`,
          )
          .all(),
      ).toEqual([
        { id: 'legacy-plan', permission_mode: 'ask', plan_mode_enabled: 1 },
        { id: 'plain', permission_mode: 'acceptEdits', plan_mode_enabled: 0 },
      ]);
      expect(historyRows(db)).toEqual(
        CANONICAL_LINEAGE.map(([seq, file_name, content_hash]) => ({
          seq,
          file_name,
          content_hash,
          applied_at: 1_000 + seq,
        })),
      );

      // canonicalized 后再次调用应严格 no-op，不能重复改数据或 applied_at。
      const snapshot = historyRows(db);
      migration0074.run(db);
      expect(historyRows(db)).toEqual(snapshot);
    } finally {
      db.close();
    }
  });

  it('does not touch schema, data, or history for a partially matching lineage', () => {
    const db = createLegacyDb();
    try {
      const [seq, fileName, hash] = CANONICAL_LINEAGE[4];
      db.prepare(`UPDATE migration_history SET file_name = ?, content_hash = ? WHERE seq = ?`).run(
        fileName,
        hash,
        seq,
      );
      const before = historyRows(db);

      migration0074.run(db);

      expect(historyRows(db)).toEqual(before);
      expect(columnNames(db, 'sessions')).not.toContain('plan_mode_enabled');
      expect(
        db.prepare("SELECT permission_mode FROM sessions WHERE id='legacy-plan'").pluck().get(),
      ).toBe('plan');
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_aliases'")
          .get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('does not canonicalize an unknown legacy hash', () => {
    const db = createLegacyDb();
    try {
      const unknownHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      db.prepare(`UPDATE migration_history SET content_hash = ? WHERE seq = 60`).run(unknownHash);

      migration0074.run(db);

      expect(
        db.prepare(`SELECT content_hash FROM migration_history WHERE seq = 60`).pluck().get(),
      ).toBe(unknownHash);
      expect(columnNames(db, 'sessions')).not.toContain('plan_mode_enabled');
    } finally {
      db.close();
    }
  });
});
