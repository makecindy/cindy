import { afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { transformSync } from 'esbuild';
let root: string | undefined;
afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });
it.each(['esm', 'cjs'] as const)('reads committed WAL jobs for exactly the selected agent through the real readonly worker (%s)', async format => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-sqlite-test-'));
  const database = path.join(root, 'state.sqlite');
  const db = new Database(database);
  db.pragma('journal_mode = WAL'); db.pragma('wal_autocheckpoint = 0');
  db.exec('CREATE TABLE cron_jobs (store_key TEXT, agent_id TEXT, owner_agent_id TEXT, sort_order INTEGER, job_json TEXT, state_json TEXT)');
  const insert = db.prepare('INSERT INTO cron_jobs VALUES (?,?,?,?,?,?)');
  insert.run('store', 'main', null, 1, JSON.stringify({ id: 'mine', enabled: true }), JSON.stringify({ lastRunAtMs: 123 }));
  insert.run('store', 'other', null, 2, JSON.stringify({ id: 'other' }), '{}');
  insert.run('other-store', 'main', null, 3, JSON.stringify({ id: 'other-store' }), '{}');
  const extra = Array.from({ length: 1100 }, (_, index) => ({ id: `extra-${index}` }));
  db.transaction(() => { for (const [index, job] of extra.entries()) insert.run('store', 'main', null, index + 4, JSON.stringify(job), '{}'); })();
  const source = await fs.readFile(new URL('../openclawCronWorker.ts', import.meta.url), 'utf8');
  const module = path.join(root, format === 'cjs' ? 'worker.cjs' : 'worker.mjs');
  await fs.writeFile(module, transformSync(source, { loader: 'ts', format, platform: 'node', target: 'node22', logLevel: 'silent' }).code);
  const worker = new Worker(module, { workerData: { database, storeKey: 'store', agentId: 'main', defaultAgent: true, modulePath: createRequire(import.meta.url).resolve('better-sqlite3') } });
  try {
    const reply = await new Promise<unknown>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    expect(reply).toEqual({ ok: true, jobs: [{ id: 'mine', enabled: true, state: { lastRunAtMs: 123 } }, ...extra.map(job => ({ ...job, state: {} }))] });
    expect(db.prepare('SELECT COUNT(*) AS count FROM cron_jobs').get()).toEqual({ count: 1103 });
  } finally { await worker.terminate(); db.close(); }
});

it.each(['tiny', 'utf8'] as const)('stops the worker iterator before retaining an unbounded %s row set', async scenario => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-sqlite-limit-'));
  const database = path.join(root, 'iterator-count.json');
  const fakeDatabase = path.join(root, 'database.cjs');
  await fs.writeFile(fakeDatabase, `
    const fs = require('node:fs');
    module.exports = class {
      constructor(file) { this.file = file; this.read = 0; this.closed = false; }
      prepare() {
        const db = this;
        return { *iterate() {
          try { for (let i = 0; i < 2000000; i++) {
            db.read++;
            yield { job_json: ${scenario === 'tiny' ? "'{}'" : "JSON.stringify({ note: '漢'.repeat(500000) })"}, state_json: '{}' };
          } } finally { db.closed = true; }
        } };
      }
      close() { fs.writeFileSync(this.file, JSON.stringify({ read: this.read, closed: this.closed })); }
    };
  `);
  const source = await fs.readFile(new URL('../openclawCronWorker.ts', import.meta.url), 'utf8');
  const module = path.join(root, 'worker.cjs');
  await fs.writeFile(module, transformSync(source, { loader: 'ts', format: 'cjs', platform: 'node', target: 'node22', logLevel: 'silent' }).code);
  const worker = new Worker(module, { workerData: { database, storeKey: 'store', agentId: 'main', defaultAgent: true, modulePath: fakeDatabase } });
  try {
    const exit = new Promise<void>((resolve, reject) => { worker.once('exit', code => code ? reject(new Error(`worker exit ${code}`)) : resolve()); worker.once('error', reject); });
    const reply = await new Promise<unknown>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    await exit;
    expect(reply).toEqual({ ok: false, code: 'SOURCE_DATABASE_TOO_LARGE' });
    const counts = JSON.parse(await fs.readFile(database, 'utf8'));
    expect(counts.closed).toBe(true);
    expect(counts.read).toBeGreaterThan(1);
    expect(counts.read).toBeLessThan(scenario === 'tiny' ? 65_000 : 13);
  } finally { await worker.terminate(); }
});

it.each([false, true])('passes the host native binding into the database constructor (driver fails: %s)', async fails => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-sqlite-binding-'));
  const nativeBinding = path.join(root, 'electron-native.node');
  const databaseModule = path.join(root, 'driver.cjs');
  await fs.writeFile(databaseModule, `module.exports = class {
    constructor(file, options) {
      if (options.nativeBinding !== ${JSON.stringify(nativeBinding)} || !options.readonly || !options.fileMustExist) throw new Error('wrong binding');
      ${fails ? "throw Object.assign(new Error('private source path'), { code: 'ERR_DLOPEN_FAILED' });" : ''}
    }
    prepare() { return { *iterate() { yield { job_json: '{"id":"selected-binding"}', state_json: '{}' }; } }; }
    close() {}
  };`);
  const source = await fs.readFile(new URL('../openclawCronWorker.ts', import.meta.url), 'utf8');
  const module = path.join(root, 'worker.cjs');
  await fs.writeFile(module, transformSync(source, { loader: 'ts', format: 'cjs', platform: 'node', target: 'node22', logLevel: 'silent' }).code);
  const worker = new Worker(module, { workerData: { database: 'source', storeKey: 'store', agentId: 'main', defaultAgent: true, modulePath: databaseModule, nativeBinding } });
  try {
    const reply = await new Promise<unknown>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    expect(reply).toEqual(fails ? { ok: false, code: 'SOURCE_DATABASE_DRIVER_UNAVAILABLE' } : { ok: true, jobs: [{ id: 'selected-binding', state: {} }] });
    expect(JSON.stringify(reply)).not.toContain('private source path');
  } finally { await worker.terminate(); }
});
