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
  const source = await fs.readFile(new URL('../openclawCronWorker.ts', import.meta.url), 'utf8');
  const module = path.join(root, format === 'cjs' ? 'worker.cjs' : 'worker.mjs');
  await fs.writeFile(module, transformSync(source, { loader: 'ts', format, platform: 'node', target: 'node22', logLevel: 'silent' }).code);
  const worker = new Worker(module, { workerData: { database, storeKey: 'store', agentId: 'main', defaultAgent: true, modulePath: createRequire(import.meta.url).resolve('better-sqlite3') } });
  try {
    const reply = await new Promise<unknown>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    expect(reply).toEqual({ ok: true, jobs: [{ id: 'mine', enabled: true, state: { lastRunAtMs: 123 } }] });
    expect(db.prepare('SELECT COUNT(*) AS count FROM cron_jobs').get()).toEqual({ count: 3 });
  } finally { await worker.terminate(); db.close(); }
});
