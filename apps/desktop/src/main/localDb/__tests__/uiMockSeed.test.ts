/**
 * Dev `--mock` sandbox seeding (docs/dev-rules/ui-mock-data.md).
 *
 * Runs seedUiMockData against a database built by the real migration chain, so a
 * schema change that the shared catalog no longer satisfies (new NOT NULL column,
 * narrowed enum) fails here instead of leaving `--mock` with an empty task list.
 * A second start must keep what the developer changed while testing, and finish a
 * start that was interrupted between writing a task and its messages.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { UI_MOCK_TASKS } from '@cindy/maker-shared/ui-mock';
import { describe, expect, it } from 'vitest';

import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { runMigrationReplay } from '../migrationRunner';
import * as schema from '../schema';
import { seedUiMockData } from '../uiMockSeed';

// Bundled sqlite-vec ships for macOS / Windows only, same guard as migrationReplay.
const canReplayMigrations = process.platform === 'win32' || process.platform === 'darwin';
const desktopRoot = path.resolve(__dirname, '../../../..');

function createMigratedDb(dir: string): Database.Database {
  const db = createBetterSqliteDatabase(path.join(dir, 'mock.db'));
  db.loadExtension(path.join(
    desktopRoot, 'native', 'sqlite-vec', `${process.platform}-${process.arch}`,
    process.platform === 'win32' ? 'vec0.dll' : 'vec0.dylib',
  ));
  runMigrationReplay(db, { drizzleDir: path.join(desktopRoot, 'drizzle') });
  return db;
}

describe.skipIf(!canReplayMigrations)('ui mock seed', () => {
  it('fills a migrated database once and keeps edits on the next start', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cindy-ui-mock-'));
    const sqlite = createMigratedDb(dir);
    try {
      const db = drizzle(sqlite, { schema });
      const projectRoot = path.join(dir, 'projects');
      const seed = () => seedUiMockData({
        db, projectRoot, now: Date.parse('2026-10-24T08:00:00Z'),
        dialogueDir: (id) => path.join(dir, 'dialogues', id),
      });

      expect(await seed()).toBe(UI_MOCK_TASKS.length);
      const tasks = sqlite.prepare(
        'SELECT id, working_dir AS workingDir, workspace_kind AS kind, status FROM sessions',
      ).all() as Array<{ id: string; workingDir: string; kind: string; status: string }>;
      expect(tasks).toHaveLength(UI_MOCK_TASKS.length);
      expect(tasks.find((task) => task.id === 'ui-mock-dialogue'))
        .toMatchObject({ kind: 'dialogue', workingDir: path.join(dir, 'dialogues', 'ui-mock-dialogue') });
      expect(tasks.find((task) => task.id === 'ui-mock-archived')?.status).toBe('archived');
      const tool = sqlite.prepare(
        "SELECT content, tool_use_id AS toolUseId FROM messages WHERE session_id = 'ui-mock-rich-answer' AND role = 'tool_use' LIMIT 1",
      ).get() as { content: string; toolUseId: string };
      expect(JSON.parse(tool.content)).toMatchObject({ toolName: 'Bash', toolUseId: tool.toolUseId });
      const readme = path.join(projectRoot, 'cindy-demo', 'README.md');
      expect(existsSync(readme)).toBe(true);

      // What a developer does while testing: rename a task, delete one, edit a file.
      sqlite.prepare("UPDATE sessions SET title = 'renamed' WHERE id = 'ui-mock-english'").run();
      sqlite.prepare("DELETE FROM sessions WHERE id = 'ui-mock-dialogue'").run();
      writeFileSync(readme, 'edited\n');

      // An interrupted first start (task written, messages not) must finish next time,
      // while a message deleted in the app (tombstone) must not come back.
      sqlite.prepare("DELETE FROM messages WHERE session_id = 'ui-mock-long-title'").run();
      sqlite.prepare("DELETE FROM messages WHERE session_id = 'ui-mock-archived'").run();
      sqlite.prepare(
        "INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES ('tomb', 'tomb', 'ui-mock-archived', 'message_tombstone', '{}', 1)",
      ).run();

      expect(await seed()).toBe(1);
      expect(sqlite.prepare("SELECT count(*) AS n FROM messages WHERE session_id = 'ui-mock-long-title'").get())
        .toEqual({ n: 2 });
      expect(sqlite.prepare("SELECT count(*) AS n FROM messages WHERE session_id = 'ui-mock-archived'").get())
        .toEqual({ n: 1 });
      expect(sqlite.prepare("SELECT title FROM sessions WHERE id = 'ui-mock-english'").get())
        .toEqual({ title: 'renamed' });
      expect(sqlite.prepare("SELECT count(*) AS n FROM messages WHERE session_id = 'ui-mock-dialogue'").get())
        .toEqual({ n: 2 });
      expect(readFileSync(readme, 'utf8')).toBe('edited\n');
    } finally {
      sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
