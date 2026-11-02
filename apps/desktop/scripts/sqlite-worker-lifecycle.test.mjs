import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const desktop = fileURLToPath(new URL('..', import.meta.url));
const moduleUrl = (name) => JSON.stringify(pathToFileURL(require.resolve(name)).href);

// Unit regression for the actual Vitest globalSetup/worker lifetime boundary.
// A fresh child is necessary: the enclosing worker cannot inspect its runner's
// native cache. Existing packaging fixtures never load a native addon.
// Minimum failure: no parent binding retained across a real memory-only worker.
// This asserts the preventive lifetime invariant, not deterministic SIGSEGV.
it('retains the real SQLite image in the configured runner across worker teardown', () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cindy-sqlite-lifecycle-')));
  try {
    const fixture = path.join(dir, 'memory.test.mjs');
    writeFileSync(fixture, [
      'import { expect, it } from ' + JSON.stringify(pathToFileURL(path.join(path.dirname(require.resolve('vitest/package.json')), 'dist/index.js')).href) + ';',
      "import { isMainThread } from 'node:worker_threads';",
      'import Database from ' + moduleUrl('better-sqlite3') + ';',
      "it('uses an actual isolated memory database', () => {",
      "const db = new Database(':memory:');",
      'try {',
      "const value = db.prepare('SELECT 7 AS value').get().value;",
      'expect(value).toBe(7);',
      "console.log('sqlite-worker:' + JSON.stringify({ isMainThread, execArgv: process.execArgv, value }));",
      '} finally { db.close(); }',
      '});',
    ].join('\n'));
    const driver = path.join(dir, 'driver.mjs');
    writeFileSync(driver, [
      "import { createRequire } from 'node:module';",
      "import { isMainThread } from 'node:worker_threads';",
      'import { startVitest } from ' + moduleUrl('vitest/node') + ';',
      'const require = createRequire(' + JSON.stringify(import.meta.url) + ');',
      "const binding = require.resolve('better-sqlite3/build/Release/better_sqlite3.node');",
      'let retainedBefore = false; let worker;',
      "const ctx = await startVitest('test', [], {",
      'root: ' + JSON.stringify(dir) + ', config: ' + JSON.stringify(path.join(desktop, 'vitest.config.ts')) + ',',
      'projects: [{ extends: true, root: ' + JSON.stringify(dir) + ", test: { include: ['memory.test.mjs'] } }], watch: false,",
      "pool: 'threads', maxWorkers: 1, minWorkers: 1,",
      "reporters: ['default', {",
      'onTestModuleStart() { retainedBefore = Boolean(require.cache[binding]); },',
      'onUserConsoleLog(log) { const line = log.content.trim();',
      "if (line.startsWith('sqlite-worker:')) worker = JSON.parse(line.slice('sqlite-worker:'.length)); },",
      '}], }).catch(error => { console.error(error); throw error; });',
      'try {',
      "console.log('sqlite-lifetime:' + JSON.stringify({ isMainThread, retainedBefore, retainedAfter: Boolean(require.cache[binding]), worker }));",
      '} finally { await ctx?.close(); }',
    ].join('\n'));
    const env = { ...process.env };
    delete env.CINDY_INPUT_HANDOFF_ROUTE;
    let output;
    try {
      output = execFileSync(process.execPath, [driver], {
        cwd: desktop, env, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new Error(JSON.stringify({ status: error.status, signal: error.signal, stderr: String(error.stderr), stdout: String(error.stdout) }));
    }
    const line = output.split('\n').find((entry) => entry.startsWith('sqlite-lifetime:'));
    expect(line).toBeDefined();
    const result = JSON.parse(line.slice('sqlite-lifetime:'.length));
    expect(result.isMainThread).toBe(true);
    expect(result.retainedBefore).toBe(true);
    expect(result.retainedAfter).toBe(true);
    expect(result.worker.isMainThread).toBe(false);
    expect(result.worker.value).toBe(7);
    expect(result.worker.execArgv.some((arg) => /^(--require|-r|--import)(=|$)/.test(arg))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
