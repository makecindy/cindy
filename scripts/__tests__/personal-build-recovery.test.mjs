import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { RecoveryJournal, compatibility, durableWrite } from '../personal-build/recovery.mjs';
import { readHeartbeat, acquire, validateBootstrap } from '../personal-build/automatic.mjs';

// Script integration: the old launcher forgot its fallback at first ready and had no durable trial
// recovery. Real on-disk journal, separate terminating writer process, injected time (no sleeps).
// Smallest regression: a candidate reports ready once and exits before its probation completes.
const fixture = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 1000;
  const j = new RecoveryJournal(path.join(dir, 'journal.json'), { now: () => now, nonce: () => 'trial-generation' });
  const good = { id: 'good', directory: path.join(dir, 'good'), verified: true };
  const candidate = { id: 'candidate', directory: path.join(dir, 'candidate') };
  j.init(good);
  return { dir, j, good, candidate, clock: value => { now = value; } };
};
const evidence = { compatible: true, prepared: true, idle: true, stopped: true };

test('first ready does not promote; healthy observation commits only after probation', t => {
  const f = fixture(t); const s = f.j.begin(f.candidate, evidence);
  const h = { generation: s.generation, id: f.candidate.id, healthy: true, processAlive: true };
  assert.equal(f.j.observe(h, 100).good.id, 'good');
  f.clock(1099); assert.equal(f.j.observe(h, 100).phase, 'trial');
  f.clock(1100); assert.equal(f.j.observe(h, 100).good.id, 'candidate');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'known-good.json'))).id, 'candidate');
  assert.equal(f.j.read().previous.id, 'good');
});

test('probation failure restores old pointer, rejects retry, and recovery failure stops the loop', t => {
  const f = fixture(t), s = f.j.begin(f.candidate, evidence);
  const bad = f.j.observe({ generation: s.generation, id: 'candidate', healthy: false, processAlive: false }, 100);
  assert.equal(bad.selected.id, 'good'); assert.equal(bad.phase, 'recovering');
  assert.equal(f.j.finishRecovery(true).phase, 'stable');
  assert.throws(() => f.j.begin(f.candidate, evidence), /rejected/);
  f.j.begin({ ...f.candidate, id: 'other' }, evidence); f.j.reject('timeout');
  assert.equal(f.j.finishRecovery(false).phase, 'blocked');
  assert.throws(() => f.j.begin({ ...f.candidate, id: 'third' }, evidence), /recovery/);
});

test('terminated writer leaves a recoverable trial; corrupt main journal retains independent rescue receipt', t => {
  const f = fixture(t);
  const module = new URL('../personal-build/recovery.mjs', import.meta.url).href;
  const script = `import {RecoveryJournal} from ${JSON.stringify(module)}; const j=new RecoveryJournal(process.argv[1]); j.begin(JSON.parse(process.argv[2]),JSON.parse(process.argv[3])); process.exit(71);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, f.j.file, JSON.stringify(f.candidate), JSON.stringify(evidence)]);
  assert.equal(result.status, 71);
  const incompleteHealth = { ...f.j.read(), readyAt: 1000 };
  durableWrite(f.j.file, incompleteHealth); assert.throws(() => f.j.read(), /Invalid trial health/);
  durableWrite(f.j.file, { ...incompleteHealth, readyAt: null });
  assert.equal(f.j.recoverInterrupted().selected.id, 'good');
  fs.writeFileSync(f.j.file, '{corrupt'); assert.throws(() => f.j.read());
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'known-good.json'))).id, 'good');
});

test('unsafe switch evidence and stale health never promote a candidate', t => {
  const f = fixture(t);
  for (const key of Object.keys(evidence)) assert.throws(() => f.j.begin(f.candidate, { ...evidence, [key]: false }), /prepared/);
  f.j.begin(f.candidate, evidence);
  assert.throws(() => f.j.observe({ generation: 'old', id: 'candidate', healthy: true, processAlive: true }, 100), /Stale/);
  assert.equal(f.j.read().good.id, 'good');
  const baseline = { migrations: 'm', plugins: 'p', runtime: 'r', dataCode: 'd' };
  assert.equal(compatibility(baseline, baseline).compatible, true);
  for (const key of Object.keys(baseline)) assert.equal(compatibility(baseline, { ...baseline, [key]: 'changed' }).compatible, false);
});

test('host heartbeat must be fresh and belong to the exact process and launch', t => {
  const f = fixture(t), run = { dir: f.dir, generation: 'new' }, file = path.join(f.dir, 'heartbeat.json');
  const h = { protocol: 1, generation: 'new', pid: 42, at: 1000, ready: true, remoteReady: true, idle: true, busy: false };
  durableWrite(file, h); assert.equal(readHeartbeat(run, 42, { now: 1000 }).healthy, true);
  assert.equal(readHeartbeat(run, 43, { now: 1000 }), null);
  assert.equal(readHeartbeat(run, 42, { now: 12000 }), null);
  assert.equal(readHeartbeat(run, 42, { now: 999 }), null);
  durableWrite(file, { ...h, at: undefined }); assert.equal(readHeartbeat(run, 42, { now: 1000 }), null);
  durableWrite(file, { ...h, generation: 'old' }); assert.equal(readHeartbeat(run, 42, { now: 1000 }), null);
  durableWrite(file, { ...h, remoteReady: false }); assert.equal(readHeartbeat(run, 42, { now: 1000 }).healthy, false);
});


test('an observation gap cannot silently satisfy the healthy probation interval', t => {
  const f = fixture(t), s = f.j.begin(f.candidate, evidence);
  const h = { generation: s.generation, id: 'candidate', healthy: true, processAlive: true };
  f.j.observe(h, 20000); f.clock(22000);
  assert.equal(f.j.observe(h, 20000).phase, 'recovering');
  assert.equal(f.j.read().good.id, 'good');
});

test('reclaiming a terminated owner never steals a live lock; interrupted reclamation fails closed', t => {
  const f = fixture(t), lock = path.join(f.dir, 'supervisor.lock');
  const module = new URL('../personal-build/automatic.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {acquire} from ${JSON.stringify(module)}; acquire(process.argv[1]); process.exit(71);`, lock]);
  assert.equal(result.status, 71);
  const unlock = acquire(lock);
  assert.throws(() => acquire(lock), /Already running/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'))).pid, process.pid);
  unlock();
  fs.mkdirSync(lock + '.guard');
  assert.throws(() => acquire(lock), /EEXIST/);
  assert.equal(fs.existsSync(lock), false);
});

test('first health bootstrap preserves the observed baseline and rejects data, runtime and unrelated changes', () => {
  const baseline = { id: 'old', directory: '/old', head: 'old-head', verified: true, readyProof: { head: 'old-head' }, migrations: 'm', runtime: 'r', plugins: 'p', dataCode: 'old' };
  const candidate = { ...baseline, id: 'new', directory: '/new', monitorProtocol: 1, dataCode: 'new' };
  const report = { kind: 'personal-health-bootstrap', checked: true, smoke: { ready: true }, baseline, candidate };
  const files = ['apps/desktop/src/main/personalBuildMonitor.ts'];
  assert.equal(validateBootstrap(report, '/old', files), candidate);
  assert.throws(() => validateBootstrap(report, '/different', files), /baseline/);
  assert.throws(() => validateBootstrap({ ...report, smoke: { ready: false } }, '/old', files), /startup/);
  assert.throws(() => validateBootstrap(report, '/old', ['apps/desktop/src/main/localDb/index.ts']), /only add/);
  for (const key of ['migrations', 'runtime', 'plugins']) assert.throws(() => validateBootstrap({ ...report, candidate: { ...candidate, [key]: 'changed' } }, '/old', files), /cannot change/);
});
