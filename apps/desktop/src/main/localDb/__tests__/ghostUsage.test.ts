import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { GhostUsageDb } from '../ghostUsage';
import { getGhostUsage7d, recordGhostUsage, shiftedLocalDayKey } from '../ghostUsage';
import * as schema from '../schema';

const MIGRATION_0089 = path.resolve(__dirname, '../../../../drizzle/0089_complex_fixer.sql');

function freshDb(): { raw: Database.Database; db: GhostUsageDb } {
  const raw = new Database(':memory:');
  const sqlText = fs.readFileSync(MIGRATION_0089, 'utf8');
  for (const statement of sqlText.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed) raw.exec(trimmed);
  }
  return {
    raw,
    db: drizzle(raw, { schema }) as unknown as GhostUsageDb,
  };
}

function localTimestamp(year: number, month: number, day: number, hour = 12): number {
  return new Date(year, month - 1, day, hour, 0, 0, 0).getTime();
}

describe('ghost usage daily counters', () => {
  it('atomically increments one plugin three times on the same local day', async () => {
    const { raw, db } = freshDb();
    try {
      const now = localTimestamp(2026, 8, 9);
      await Promise.all([
        recordGhostUsage('art', db, now),
        recordGhostUsage('art', db, now + 1),
        recordGhostUsage('art', db, now + 2),
      ]);

      expect(await getGhostUsage7d(['art'], db, now)).toEqual({ art: 3 });
      expect(
        raw
          .prepare('SELECT call_count, updated_at FROM ghost_usage_daily WHERE ghost_id = ?')
          .get('art'),
      ).toEqual({ call_count: 3, updated_at: now + 2 });
    } finally {
      raw.close();
    }
  });

  it('keeps concurrent increments for different plugins isolated', async () => {
    const { raw, db } = freshDb();
    try {
      const now = localTimestamp(2026, 8, 9);
      await Promise.all([
        recordGhostUsage('art', db, now),
        recordGhostUsage('calendar', db, now),
        recordGhostUsage('art', db, now + 1),
        recordGhostUsage('calendar', db, now + 1),
      ]);

      expect(await getGhostUsage7d(['art', 'calendar'], db, now)).toEqual({
        art: 2,
        calendar: 2,
      });
    } finally {
      raw.close();
    }
  });

  it('starts a new bucket across local midnight', async () => {
    const { raw, db } = freshDb();
    try {
      const beforeMidnight = localTimestamp(2026, 8, 9, 23) + 59 * 60_000;
      const afterMidnight = localTimestamp(2026, 8, 10, 0) + 60_000;
      await recordGhostUsage('art', db, beforeMidnight);
      await recordGhostUsage('art', db, afterMidnight);

      expect(
        raw
          .prepare(
            'SELECT local_day, call_count FROM ghost_usage_daily WHERE ghost_id = ? ORDER BY local_day',
          )
          .all('art'),
      ).toEqual([
        { local_day: '2026-08-09', call_count: 1 },
        { local_day: '2026-08-10', call_count: 1 },
      ]);
      expect(await getGhostUsage7d(['art'], db, afterMidnight)).toEqual({ art: 2 });
    } finally {
      raw.close();
    }
  });

  it('includes today and the preceding six local days, excluding the eighth day', async () => {
    const { raw, db } = freshDb();
    try {
      const now = localTimestamp(2026, 8, 9);
      await recordGhostUsage('art', db, now);
      await recordGhostUsage('art', db, new Date(2026, 7, 3, 12).getTime());
      await recordGhostUsage('art', db, new Date(2026, 7, 2, 12).getTime());
      await recordGhostUsage('art', db, new Date(2026, 7, 10, 12).getTime());
      await recordGhostUsage('calendar', db, now);

      expect(await getGhostUsage7d(['art', 'art'], db, now)).toEqual({ art: 2 });
    } finally {
      raw.close();
    }
  });

  it('retains 90 local days and removes only rows before that boundary', async () => {
    const { raw, db } = freshDb();
    try {
      const now = localTimestamp(2026, 8, 9);
      const retainedDay = shiftedLocalDayKey(now, -89);
      const expiredDay = shiftedLocalDayKey(now, -90);
      const insert = raw.prepare(
        'INSERT INTO ghost_usage_daily (ghost_id, local_day, call_count, updated_at) VALUES (?, ?, ?, ?)',
      );
      insert.run('retained', retainedDay, 4, now);
      insert.run('expired', expiredDay, 5, now);

      await recordGhostUsage('art', db, now);

      expect(
        raw.prepare('SELECT ghost_id, local_day FROM ghost_usage_daily ORDER BY ghost_id').all(),
      ).toEqual([
        { ghost_id: 'art', local_day: '2026-08-09' },
        { ghost_id: 'retained', local_day: retainedDay },
      ]);
    } finally {
      raw.close();
    }
  });

  it('returns an empty mapping without touching the database for an empty id list', async () => {
    const { raw, db } = freshDb();
    raw.close();
    await expect(getGhostUsage7d([], db, localTimestamp(2026, 8, 9))).resolves.toEqual({});
  });
});
