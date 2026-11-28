import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMaintenanceGate, digest, ingresses, readJson, atomicJson, shutdownEvidence, maintenanceActivitySample } from './gate.mjs';

function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-maintenance-gate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let at = 1_000_000;
  const binding = {instanceId:'instance-test',deviceId:'device-test',statefulSetUid:'set-test',pvcUid:'pvc-test'};
  const opts = {binding,podUid:'pod-source',bootId:'boot-source',ledgerFile:path.join(directory,'ledger.json'),now:()=>at,coverage:ingresses,...overrides};
  const gate = createMaintenanceGate(opts);
  const command = (action, patch = {}) => {
    const r = gate.receipt();
    return {version:1,...binding,operationId:'op-test',epoch:1,sequence:r.sequence+1,action,
      sourcePodUid:'pod-source',sourceBootId:'boot-source',targetDigest:`sha256:${'a'.repeat(64)}`,policyDigest:'b'.repeat(64),
      windowEndAt:5_000_000,expiresAt:at+900_000,expectedReceiptDigest:r.stateDigest,...patch};
  };
  const sample = (patch = {}) => gate.observe({atMs:at,active:0,legacyQueued:0,unknown:0,nextWakeAtMs:null,...patch},gate.revision());
  const quiet = () => {sample();at+=10000;sample();};
  return {gate,opts,command,sample,quiet,advance:n=>{at+=n;},now:()=>at};
}
test('prepare rejects new work explicitly while previously admitted async work finishes', async t => {
  const f=fixture(t);let complete;
  const active=f.gate.run('agent-input',()=>new Promise(r=>{complete=r;}));
  f.gate.accept(f.command('prepare'));
  assert.throws(()=>f.gate.run('agent-input',()=>assert.fail('started')),/CLOUD_MAINTENANCE_RETRY/);
  assert.equal(f.gate.receipt().counts.inFlight,1); complete();await active;
  assert.equal(f.gate.receipt().counts.inFlight,0);
  assert.equal(f.gate.run('agent-input',()=>42,true),42);
});
test('prepare does not suppress scheduled automatic triggers', t=>{
  const f=fixture(t);f.gate.accept(f.command('prepare'));
  assert.equal(f.gate.schedulerAllowed(),true);
  assert.equal(f.gate.run('scheduler',()=>42,true),42);
  assert.throws(()=>f.gate.run('scheduler',()=>42,false),/RETRY/);
});
test('seal synchronously excludes task and remote input races', t=>{
  const f=fixture(t);f.gate.accept(f.command('prepare'));f.quiet();
  f.gate.admit('remote-input',true);
  assert.throws(()=>f.gate.accept(f.command('seal')),/RETRY/);
  f.quiet();f.gate.accept(f.command('seal'));
  assert.equal(f.gate.schedulerAllowed(),false);
  for(const k of ingresses) assert.throws(()=>f.gate.run(k,()=>42,true),/RETRY/);
});
test('an activity change while async sampling invalidates that observation', t=>{
  const f=fixture(t);f.gate.accept(f.command('prepare'));f.quiet();const revision=f.gate.revision();
  f.gate.run('plugin-work',()=>undefined,true);
  f.gate.observe({atMs:f.now(),active:0,legacyQueued:0,unknown:0,nextWakeAtMs:null},revision);
  assert.equal(f.gate.receipt().counts.unknown,1);
  assert.throws(()=>f.gate.accept(f.command('seal')),/RETRY/);
});
test('seal waits for a scheduler DB scan that was already in flight',async t=>{
  const f=fixture(t);f.gate.accept(f.command('prepare'));f.quiet();let finish;
  const scan=f.gate.scan(()=>new Promise(r=>{finish=r;}));
  assert.throws(()=>f.gate.accept(f.command('seal')),/RETRY/);finish();await scan;
  f.sample();f.gate.accept(f.command('seal'));
  await f.gate.scan(()=>assert.fail('sealed scheduler scan ran'));
});
for(const reason of ['active','legacyQueued','unknown','stale','coverage']) test(`seal refuses ${reason}`,t=>{
  const f=fixture(t,reason==='coverage'?{coverage:ingresses.slice(1)}:{});f.gate.accept(f.command('prepare'));f.quiet();
  if(['active','legacyQueued','unknown'].includes(reason)) f.sample({[reason]:1});
  if(reason==='stale') f.advance(15001);
  assert.throws(()=>f.gate.accept(f.command('seal')),/RETRY/);
});
test('prepared timeout opens admission but never accepts a late seal',t=>{
  const f=fixture(t);f.gate.accept(f.command('prepare'));f.advance(900001);
  assert.equal(f.gate.receipt().phase,'cancelled');
  assert.doesNotThrow(()=>f.gate.admit('agent-input'));
  assert.throws(()=>f.gate.accept(f.command('seal')),/RETRY/);
});
test('sealed state survives expiry and a new process; release is bound to the new boot',t=>{
  const f=fixture(t);f.gate.accept(f.command('prepare'));f.quiet();f.gate.accept(f.command('seal'));f.advance(900001);
  assert.equal(f.gate.receipt().phase,'sealed');
  const next=createMaintenanceGate({...f.opts,podUid:'pod-next',bootId:'boot-next'});
  assert.equal(next.phase(),'sealed');assert.throws(()=>next.admit('agent-input'),/RETRY/);
  const release=f.command('release',{expectedReceiptDigest:next.receipt().stateDigest});
  assert.throws(()=>f.gate.accept(release),/RETRY/);
  next.accept(release);assert.equal(next.phase(),'released');assert.doesNotThrow(()=>next.admit('agent-input'));
});
test('lost ledger, corrupt ledger and wrong PVC never open an installed gate',t=>{
  const f=fixture(t);f.gate.accept(f.command('prepare'));f.quiet();f.gate.accept(f.command('seal'));
  const wrong=createMaintenanceGate({...f.opts,binding:{...f.opts.binding,pvcUid:'other'}});
  assert.equal(wrong.phase(),'recovery-hold');
  fs.writeFileSync(f.opts.ledgerFile,'{');const corrupt=createMaintenanceGate(f.opts);
  assert.equal(corrupt.phase(),'recovery-hold');
});
test('failed fsync/ledger write blocks admission and publishes unknown',t=>{
  const f=fixture(t,{save:()=>{throw new Error('disk full');}});
  assert.throws(()=>f.gate.accept(f.command('prepare')),/disk full/);
  assert.equal(f.gate.receipt().phase,'recovery-hold');assert.throws(()=>f.gate.admit('agent-input'),/RETRY/);
});
test('command retries are idempotent; stale epochs, changed bindings and skipped sequences fail',t=>{
  const f=fixture(t),cmd=f.command('prepare');f.gate.accept(cmd);const state=f.gate.receipt().stateDigest;
  f.gate.accept(cmd);assert.equal(f.gate.receipt().stateDigest,state);
  for(const patch of [{epoch:0},{sequence:9},{deviceId:'other'},{action:'execute'},{shell:'true'}])
    assert.throws(()=>f.gate.accept(f.command('cancel',patch)),/RETRY/);
  f.gate.accept(f.command('cancel'));assert.equal(f.gate.phase(),'cancelled');
  assert.throws(()=>f.gate.accept(cmd),/RETRY/);
});
test('async dispatch context cannot leak admission after its call completed',async t=>{
  const f=fixture(t);let later;
  f.gate.run('agent-input',()=>{later=()=>new Promise(resolve=>setImmediate(()=>{
    assert.throws(()=>f.gate.admit('agent-dispatch'),/RETRY/);resolve();
  }));});
  f.gate.accept(f.command('prepare'));await later();
});
test('ledger writes are private, atomic, and reject symlink reads',t=>{
  const f=fixture(t);atomicJson(f.opts.ledgerFile,{v:1});assert.deepEqual(readJson(f.opts.ledgerFile),{v:1});
  assert.equal(fs.statSync(f.opts.ledgerFile).mode&0o777,0o600);
  const link=f.opts.ledgerFile+'.link';fs.symlinkSync(f.opts.ledgerFile,link);assert.throws(()=>readJson(link));
  assert.equal(digest({b:2,a:1}),digest({a:1,b:2}));
});

test('clean-shutdown evidence is issued only for an orderly, fault-free quit of a sealed operation', t => {
  const f = fixture(t);
  assert.equal(shutdownEvidence(f.gate.receipt(), { reason: 'signal:SIGTERM', faults: 0, now: 1 }), null);
  f.gate.accept(f.command('prepare')); f.quiet();
  assert.equal(shutdownEvidence(f.gate.receipt(), { reason: 'signal:SIGTERM', faults: 0, now: 1 }), null);
  f.gate.accept(f.command('seal'));
  const sealed = f.gate.receipt();
  const evidence = shutdownEvidence(sealed, { reason: 'signal:SIGTERM', faults: 0, now: 42 });
  assert.deepEqual(evidence, { version: 1, clean: true, instanceId: 'instance-test', deviceId: 'device-test', statefulSetUid: 'set-test',
    pvcUid: 'pvc-test', podUid: 'pod-source', bootId: 'boot-source', operationId: 'op-test', epoch: 1, sequence: sealed.sequence,
    commandDigest: sealed.commandDigest, reason: 'signal:SIGTERM', completedAtMs: 42 });
  assert.ok(shutdownEvidence(sealed, { reason: 'before-quit', faults: 0, now: 1 }));
  for (const reason of ['uncaughtException', 'signal:SIGINT', 'render-process-gone:crashed'])
    assert.equal(shutdownEvidence(sealed, { reason, faults: 0, now: 1 }), null);
  assert.equal(shutdownEvidence(sealed, { reason: 'signal:SIGTERM', faults: 1, now: 1 }), null);
  assert.equal(shutdownEvidence({ ...sealed, counts: { ...sealed.counts, inFlight: 1 } }, { reason: 'signal:SIGTERM', faults: 0, now: 1 }), null);
});

// A persisted, unstarted schedule must not reset quiet forever.
test('pending schedules do not block seal, including overdue and near-future wakes', t => {
  for (const offset of [-1, 0, 30_000, 1_199_999]) {
    const f = fixture(t); f.gate.accept(f.command('prepare'));
    const wake = f.now() + offset;
    f.sample({ nextWakeAtMs: wake }); f.advance(10_000); f.sample({ nextWakeAtMs: wake });
    f.gate.accept(f.command('seal')); f.sample({ nextWakeAtMs: wake });
    assert.equal(f.gate.receipt().phase, 'sealed');
    assert.equal(f.gate.receipt().nextWakeAtMs, wake);
    assert.equal(f.gate.receipt().scheduleAdmission, 'running-only');
  }
});
test('a scheduled task starting after quiet still prevents seal until it finishes', async t => {
  const f = fixture(t); f.gate.accept(f.command('prepare')); f.quiet();
  let finish;
  const run = f.gate.run('scheduler', () => new Promise(resolve => { finish = resolve; }), true);
  assert.throws(() => f.gate.accept(f.command('seal')), /RETRY/);
  finish(); await run; f.quiet();
  f.gate.accept(f.command('seal'));
  assert.equal(f.gate.receipt().phase, 'sealed');
});

test('maintenance separates a pending wake from real scheduler, session and input activity', () => {
  const observation = { isCurrent: () => true, cloudActivity: { observedAtMs: 1000 },
    inputCounts: { queued: 0 }, idle: { blockers: ['idle-grace', 'scheduler-next-wake'], nextWakeAtMs: 1001 } };
  assert.deepEqual(maintenanceActivitySample(observation),
    { atMs: 1000, active: 0, legacyQueued: 0, unknown: 0, nextWakeAtMs: 1001 });
  // Busy/unknown categories are retained, including scheduler work already queued.
  for (const blocker of ['scheduler-running', 'scheduler-in-flight', 'scheduler-waiting', 'session-busy', 'remote-input']) {
    assert.equal(maintenanceActivitySample({ ...observation,
      idle: { ...observation.idle, blockers: [...observation.idle.blockers, blocker] } }).active, 1);
  }
  assert.equal(maintenanceActivitySample({ ...observation, inputCounts: { queued: 1 } }).legacyQueued, 1);
  assert.equal(maintenanceActivitySample({ ...observation, isCurrent: () => false }).unknown, 1);
  assert.equal(maintenanceActivitySample({ ...observation,
    idle: { blockers: ['scheduler-unknown'] } }).unknown, 1);
  assert.deepEqual(observation.idle.blockers, ['idle-grace', 'scheduler-next-wake']);
});
