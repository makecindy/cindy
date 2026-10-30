/** Real worker + native SQLite regression. Existing core tests bypass worker startup;
 * they cannot catch a dropped nativeBinding between Main and the worker constructor. */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { LibrarySqlService } from '../librarySqlService.js';

const moduleRequire = createRequire(import.meta.url);
const modulePath = moduleRequire.resolve('better-sqlite3');
const bindingPath = moduleRequire.resolve('better-sqlite3/build/Release/better_sqlite3.node');
let dir: string;
let workerPath: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cindy-library-native-'));
  workerPath = path.join(dir, 'libraryDbWorker.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../libraryDbWorker.ts', import.meta.url))],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
  });
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

it('uses the host-selected native binding in a real worker and preserves the default Node path', async () => {
  for (const nativeBinding of [bindingPath, undefined]) {
    const service = new LibrarySqlService({
      workerScriptPath: () => workerPath,
      betterSqliteModulePath: () => modulePath,
      betterSqliteNativeBinding: () => nativeBinding,
    });
    try {
      const db = path.join(dir, nativeBinding ? 'explicit.sqlite' : 'default.sqlite');
      expect(await service.open(db)).toMatchObject({ ok: true });
      expect(await service.exec(db, 'CREATE TABLE example (value TEXT)')).toMatchObject({
        ok: true,
      });
      expect(await service.exec(db, 'INSERT INTO example VALUES (?)', ['saved'])).toMatchObject({
        ok: true,
      });
      expect(await service.exec(db, 'SELECT value FROM example')).toMatchObject({
        ok: true,
        rows: [{ value: 'saved' }],
      });
    } finally {
      await service.dispose();
    }
  }
});

it('does not silently use the root addon when the host-selected binding cannot load', async () => {
  const service = new LibrarySqlService({
    workerScriptPath: () => workerPath,
    betterSqliteModulePath: () => modulePath,
    betterSqliteNativeBinding: () => path.join(dir, 'missing-electron-binding.node'),
  });
  try {
    expect(await service.open(path.join(dir, 'unavailable.sqlite'))).toMatchObject({
      ok: false,
      code: 'DB_ERROR',
    });
  } finally {
    await service.dispose();
  }
});
