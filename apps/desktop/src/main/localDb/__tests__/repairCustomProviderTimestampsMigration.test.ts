import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Migration companion scripts intentionally use CommonJS so the runtime loader can replay them.
const { default: migration0094 } = (await import(
  '../../../../drizzle/scripts/0094_repair_custom_provider_timestamps'
)) as { default: { run(db: Database.Database): void } };

describe('0094 repair custom provider timestamps', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes legacy numeric, ISO, and invalid values without touching good integers', () => {
    const db = new Database(':memory:');
    const migrationNow = 2_000_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(migrationNow);
    try {
      db.exec(`
        CREATE TABLE custom_providers (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          runtimes TEXT NOT NULL DEFAULT '{}',
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      db.prepare(
        `INSERT INTO custom_providers
          (id, name, runtimes, sort_order, created_at, updated_at)
         VALUES (?, ?, '{}', 0, ?, ?)`,
      ).run('integer', 'Integer', 1, 1_500);
      db.prepare(
        `INSERT INTO custom_providers
          (id, name, runtimes, sort_order, created_at, updated_at)
         VALUES (?, ?, '{}', 0, ?, ?)`,
      ).run('numeric-text', 'Numeric text', 1, '1234');
      db.prepare(
        `INSERT INTO custom_providers
          (id, name, runtimes, sort_order, created_at, updated_at)
         VALUES (?, ?, '{}', 0, ?, ?)`,
      ).run('iso-text', 'ISO text', 1, '2026-08-19T01:45:07Z');
      db.prepare(
        `INSERT INTO custom_providers
          (id, name, runtimes, sort_order, created_at, updated_at)
         VALUES (?, ?, '{}', 0, ?, ?)`,
      ).run('invalid-text', 'Invalid text', 1, 'not-a-timestamp');

      migration0094.run(db);

      expect(db.prepare('SELECT id, updated_at, typeof(updated_at) AS type FROM custom_providers ORDER BY id').all())
        .toEqual([
          { id: 'integer', updated_at: 1_500, type: 'integer' },
          { id: 'invalid-text', updated_at: migrationNow, type: 'integer' },
          { id: 'iso-text', updated_at: Date.parse('2026-08-19T01:45:07Z'), type: 'integer' },
          { id: 'numeric-text', updated_at: 1_234, type: 'integer' },
        ]);

      expect(() => migration0094.run(db)).not.toThrow();
      expect(db.prepare('SELECT COUNT(*) AS count FROM custom_providers').get()).toEqual({ count: 4 });
    } finally {
      db.close();
    }
  });

  it('is safe when the custom provider table is absent', () => {
    const db = new Database(':memory:');
    try {
      expect(() => migration0094.run(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('surfaces an unexpected schema error instead of marking repair successful', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE custom_providers (
          id TEXT PRIMARY KEY NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
      expect(() => migration0094.run(db)).toThrow(/no such column: updated_at/i);
    } finally {
      db.close();
    }
  });
});
