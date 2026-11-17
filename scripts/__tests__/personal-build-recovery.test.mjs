import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { main } from '../personal-build.mjs';
import { RecoveryJournal, compatibility, durableWrite } from '../personal-build/recovery.mjs';
import { blockedAutomaticCandidate, launchSelected, trial, startTrial, readHeartbeat, acquire, validateBootstrap, validateManualUpgrade, restartWithSupervisorLock, waitForOwnedShutdown, fixedAppProcesses } from '../personal-build/automatic.mjs';

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

// Retention planner must preserve journal/candidate pointers even when old, and fail closed on
// incomplete evidence. Existing recovery tests do not cover cleanup recommendations. Temp FS tier.
test('retention inventory protects recovery versions and never deletes data', async t => {
  const {retentionPlan}=await import('../personal-build/retention.mjs');
  const f=fixture(t), state=path.join(f.dir,'state');
  fs.mkdirSync(path.join(state,'automatic'),{recursive:true});
  const good={id:'good',verified:true,directory:path.join(state,'v1','app')};
  new RecoveryJournal(path.join(state,'automatic/journal.json')).init(good);
  const c={name:'test',region:'global',app:{checkout:'/source'},runtime:{stateDir:state,clientDir:'/client',stagingDir:'/stage'}};
  for(let i=1;i<=5;i++)durableWrite(path.join(state,`v${i}`,'report.json'),{
    version:1,name:'test',region:'global',state:'checked',createdAt:`2026-01-0${i}T00:00:00Z`,directory:path.join(state,`v${i}`,'app')});
  durableWrite(path.join(state,'automatic/candidate.json'),{directory:path.join(state,'v2','app')});
  const plan=retentionPlan(c);
  assert.equal(plan.dryRun,true);assert.equal(plan.deletionSupported,false);
  assert.deepEqual(plan.entries.filter(e=>!e.keep).map(e=>path.basename(e.directory)),['v3']);
  assert.equal(fs.existsSync(path.join(state,'v3/report.json')),true);
  fs.writeFileSync(path.join(state,'automatic/journal.json'),'broken');
  assert.equal(retentionPlan(c).entries.every(e=>e.keep),true);
});

// Handoff integration: previously independent smoke and journal tests missed failures between quit,
// install and spawn. Exercise the production transaction + installer + trial with temporary bundles
// and injected process observations/time (no shared profile/port). This is not a real GUI acceptance.
test('full handoff retains its lock through install and probation, and distinguishes recovery from promotion', async t => {
  const {prepareRuntime} = await import('../personal-build/runtime-store.mjs');
  const {installFixedRuntime,verifyInstalledRuntime} = await import('../personal-build/fixed-install.mjs');
  for (const failure of ['none','before-spawn','after-spawn']) {
    const f = fixture(t), app = path.join(f.dir,'Applications','Personal.app');
    const installOptions = {isRunning:()=>!!live,verifySignature:()=>{}};
    const make = version => prepareRuntime({store:path.join(f.dir,'store'),inputs:{bundleId:'fixture',version},signingIdentity:'fixture',
      build:dir=>{fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'binary'),version);},verifySignature:()=>{}});
    const oldRuntime=make('old'), nextRuntime=make('next');
    let live=0, tick=1000, last;
    installFixedRuntime(oldRuntime,app,installOptions); live=42;
    const lock=path.join(f.dir,'supervisor.lock');
    const transaction = restartWithSupervisorLock(lock,42,{
      prepare:()=>verifyInstalledRuntime(oldRuntime,app,()=>{}),
      observe:()=>({pid:live || undefined,ready:!!live}),
      stop:async pid=>{
        let waited=0;
        await waitForOwnedShutdown(pid,{inspect:()=>({}),runnerActive:()=>false,isAlive:()=>waited<2,
          now:()=>waited,wait:async()=>{waited++;},timeoutMs:5});
        live=0;
      },
      activate:async onVerified=>{
        f.j.beginManual(f.candidate,{prepared:true,stopped:true,manualRequested:true,smokeVerified:true,profileVerified:true});
        try {
          await trial({runtime:{dataDir:path.join(f.dir,'isolated-data')},automatic:{requireRemote:true,probationSeconds:120}},f.j,f.candidate,{
            start:(_c,_r,{beforeSpawn})=>{
              assert.throws(()=>acquire(lock),/Already running/);
              installFixedRuntime(nextRuntime,app,installOptions);
              if(failure==='before-spawn')throw Error('injected before spawn');
              beforeSpawn(); live=43;
              return {dir:f.dir,generation:'fixture'};
            },
            waitReady:async()=>{if(failure==='after-spawn')throw Error('injected startup failure');return live;},
            readHeartbeat:()=>({healthy:true}),snapshot:()=>({pid:live,ready:!!live}),
            sleep:async ms=>{tick+=ms;f.clock(tick);assert.equal(f.j.read().good.id,'good');},
            stopLaunch:async()=>{live=0;},
          });
          onVerified({releaseId:f.j.read().good.id});
        } catch(error) {
          if(f.j.read().phase!=='recovering')throw error;
          await launchSelected({runtime:{dataDir:path.join(f.dir,'isolated-data')}}, f.j, {
            snapshot:()=>({pid:undefined}),hasLaunchRunner:()=>false,verifyRelease:()=>{},
            start:()=>{installFixedRuntime(oldRuntime,app,installOptions);live=44;return {};},
            waitReady:async()=>live,stopLaunch:async()=>{live=0;},
          });
          onVerified({releaseId:f.j.read().good.id,recovered:true});
        }
      },record:value=>{last=value;},
    });
    if(failure==='after-spawn') {
      await assert.rejects(transaction,/startup failure/);
      assert.equal(f.j.read().phase,'blocked');assert.equal(last.verified,false);
    } else {
      await transaction;
      assert.equal(f.j.read().phase,'stable');
      assert.equal(last.phase,failure==='none'?'verified':'recovered');
      assert.equal(last.verified,failure==='none');
      assert.equal(f.j.read().good.id,failure==='none'?'candidate':'good');
      verifyInstalledRuntime(failure==='none'?nextRuntime:oldRuntime,app,()=>{});
    }
    assert.equal(fs.existsSync(lock),false);
  }
});

test('manual upgrade failure blocks code rollback, including interrupted trials and independent rescue', t => {
  const f = fixture(t);
  const proof = { prepared: true, stopped: true, manualRequested: true, smokeVerified: true, profileVerified: true };
  for (const key of Object.keys(proof)) assert.throws(() => f.j.beginManual(f.candidate, { ...proof, [key]: false }), /prepared/);
  f.j.beginManual(f.candidate, proof);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'known-good.json'))).rollbackSafe, false);
  const blocked = f.j.recoverInterrupted();
  assert.equal(blocked.phase, 'blocked'); assert.equal(blocked.failed.id, 'candidate');
  assert.equal(blocked.good.id, 'good');
  assert.throws(() => f.j.finishRecovery(true), /No recovery/);
});

test('manual promotion needs continuous health and restores a verified rescue receipt', t => {
  const f = fixture(t);
  const s = f.j.beginManual(f.candidate, { prepared: true, stopped: true, manualRequested: true, smokeVerified: true, profileVerified: true });
  const h = { generation: s.generation, id: 'candidate', healthy: true, processAlive: true };
  assert.equal(f.j.observe(h, 100).phase, 'trial'); f.clock(1100);
  assert.equal(f.j.observe(h, 100).good.id, 'candidate');
  const rescue = JSON.parse(fs.readFileSync(path.join(f.dir, 'known-good.json')));
  assert.equal(rescue.verified, true); assert.equal(rescue.rollbackSafe, undefined);
  f.j.begin({ id: 'third', directory: '/third' }, evidence);
  assert.equal(f.j.reject('automatic failure').phase, 'recovering');
});

test('manual reports bind checked startup to the exact baseline, candidate, profile and unchanged migrations', () => {
  const c = { automatic: { enabled: false }, runtime: { dataDir: '/profile' }, region: 'global' };
  const release = { id: 'new', monitorProtocol: 1, migrations: 'm' };
  const state = { phase: 'stable', good: { id: 'old', migrations: 'm' }, rejected: [] };
  const r = { kind: 'personal-manual-upgrade', checked: true, baseline: state.good, candidate: release,
    dataDir: '/profile', region: 'global', smoke: { ready: true, releaseId: 'new' },
    handoff: { ready: true, releaseId: 'new', baselineId: 'old' } };
  assert.equal(validateManualUpgrade(r, c, state, release), release);
  for (const change of [{ dataDir: '/other' }, { baseline: { id: 'wrong' } }, { candidate: { id: 'wrong' } },
    { checked: false }, { smoke: { ready: true, releaseId: 'wrong' } }])
    assert.throws(() => validateManualUpgrade({ ...r, ...change }, c, state, release));
  assert.throws(() => validateManualUpgrade(r, { ...c, automatic: { enabled: true } }, state, release));
  assert.throws(() => validateManualUpgrade(r, c, state, { ...release, migrations: 'changed' }));
  assert.throws(() => validateManualUpgrade(r, c, { ...state, rejected: [{ id: 'new' }] }, release));
});

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

// Regression: an external handover quit the old app before discovering a live supervisor lock.
// Existing journal tests start after shutdown and cannot catch this ordering/race. Script integration:
// use real filesystem locks/receipts, injected process operations, no live Cindy profile or waits.
test('manual restart keeps the old app alive on lock contention and failed preflight', async t => {
  const f = fixture(t), lock = path.join(f.dir, 'supervisor.lock');
  const phases = [], calls = [];
  const operations = {
    prepare: () => { calls.push('prepare'); throw Error('candidate changed'); },
    observe: () => { calls.push('observe'); return { pid: 42, ready: true }; },
    stop: () => calls.push('stop'), activate: () => calls.push('activate'),
    record: value => phases.push(value),
  };
  const unlock = acquire(lock);
  try {
    await assert.rejects(restartWithSupervisorLock(lock, 42, operations), /Already running/);
    assert.deepEqual(calls, []);
    assert.equal(phases.at(-1).phase, 'blocked-before-stop');
    assert.equal(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'))).pid, process.pid);
  } finally { unlock(); }
  await assert.rejects(restartWithSupervisorLock(lock, 42, operations), /candidate changed/);
  assert.deepEqual(calls, ['prepare']); assert.equal(fs.existsSync(lock), false);
  for (const observed of [{ unknown: true }, { pid: 43, ready: true }, { pid: 42, ready: false }]) {
    calls.length = 0;
    await assert.rejects(restartWithSupervisorLock(lock, 42, { ...operations,
      prepare: () => {}, observe: () => observed }), /Confirmed instance changed/);
    assert.deepEqual(calls, []); assert.equal(phases.at(-1).phase, 'blocked-before-stop');
  }
});

test('manual restart retains exclusive control through shutdown, promotion and supervision', async t => {
  const f = fixture(t), lock = path.join(f.dir, 'supervisor.lock'), receipt = path.join(f.dir, 'handoff.json');
  let live = true, promoted;
  const compete = () => assert.throws(() => acquire(lock), /Already running/);
  const result = await restartWithSupervisorLock(lock, 42, {
    prepare: compete,
    observe: () => ({ pid: live ? 42 : undefined, ready: live }),
    stop: pid => { assert.equal(pid, 42); compete(); live = false; },
    activate: onVerified => {
      compete(); assert.equal(live, false);
      assert.equal(JSON.parse(fs.readFileSync(receipt)).phase, 'starting');
      onVerified(); compete(); promoted = JSON.parse(fs.readFileSync(receipt));
      return 'normal quit';
    },
    record: value => durableWrite(receipt, value),
  });
  assert.equal(result, 'normal quit'); assert.equal(promoted.phase, 'verified');
  assert.equal(promoted.verified, true); assert.equal(fs.existsSync(lock), false);
});

test('uncertain shutdown never launches a candidate; launch failures retain their actual stage', async t => {
  const f = fixture(t), lock = path.join(f.dir, 'supervisor.lock');
  for (const failure of ['stop-error', 'still-running', 'unknown', 'launch-error']) {
    let stopped = false, started = false, last;
    await assert.rejects(restartWithSupervisorLock(lock, 42, {
      prepare: () => {},
      observe: () => !stopped ? { pid: 42, ready: true } : failure === 'unknown'
        ? { unknown: true } : { pid: failure === 'still-running' ? 42 : undefined },
      stop: () => { if (failure === 'stop-error') throw Error('normal exit timed out'); stopped = true; },
      activate: () => { started = true; throw Error('startup failed'); },
      record: value => { last = value; },
    }));
    assert.equal(started, failure === 'launch-error');
    assert.equal(last.phase, started ? 'activation-failed' : 'shutdown-unconfirmed');
    assert.equal(last.verified, false); assert.equal(fs.existsSync(lock), false);
  }
});

test('interrupted handover leaves its phase and only a terminated owner can be reclaimed', t => {
  const f = fixture(t), lock = path.join(f.dir, 'supervisor.lock'), receipt = path.join(f.dir, 'handoff.json');
  const module = new URL('../personal-build/automatic.mjs', import.meta.url).href;
  const script = `import fs from 'node:fs'; import {restartWithSupervisorLock} from ${JSON.stringify(module)};
    await restartWithSupervisorLock(process.argv[1], 42, {
      prepare: () => {}, observe: () => ({pid:42,ready:true}),
      stop: () => process.exit(71), activate: () => process.exit(72),
      record: value => fs.writeFileSync(process.argv[2], JSON.stringify(value))
    });`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, lock, receipt]);
  assert.equal(result.status, 71);
  assert.equal(JSON.parse(fs.readFileSync(receipt)).phase, 'stopping');
  const unlock = acquire(lock); unlock();
});

// Actual CLI dispatch/output contract: even with a checked-report argument, occupied ownership
// produces a durable no-stop receipt, and repeating that command cannot overwrite the first result.
test('manual-restart CLI records lock refusal and refuses reuse of an attempt receipt', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t), configFile = path.join(f.dir, 'config.json'), out = path.join(f.dir, 'attempt.json');
  const stateDir = path.join(f.dir, 'state'), lock = path.join(stateDir, 'automatic/supervisor.lock');
  durableWrite(configFile, { version: 1, name: 'fixture', region: 'global',
    app: { checkout: f.dir, repository: 'example/app' }, automatic: { enabled: false },
    runtime: { mode: 'isolated', clientDir: './client', stagingDir: './stage', stateDir, dataDir: './data' } });
  const unlock = acquire(lock), tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  try {
    const args = ['manual-restart', '--config', configFile, '--report', path.join(f.dir, 'manual.json'),
      '--expected-pid', '42', '--out', out];
    await assert.rejects(main(args), /Already running/);
    const receipt = fs.readFileSync(out, 'utf8');
    assert.equal(JSON.parse(receipt).phase, 'blocked-before-stop');
    await assert.rejects(main(args), /EEXIST/);
    assert.equal(fs.readFileSync(out, 'utf8'), receipt);
  } finally {
    if (tty) Object.defineProperty(process.stdin, 'isTTY', tty); else delete process.stdin.isTTY;
    unlock();
  }
});

// Regression: will-quit removes identity metadata before the original main PID is gone.
// Integration seam used by stopOwned; virtual clock makes the real timeout/order observable.
test('shutdown waits for the original PID even after instance metadata disappears', async () => {
  let tick = 0;
  await waitForOwnedShutdown(42, { inspect: () => ({}), runnerActive: () => tick < 3,
    isAlive: pid => { assert.equal(pid, 42); return tick < 2; },
    now: () => tick, wait: async () => { tick++; }, timeoutMs: 5 });
  assert.equal(tick, 3);
  tick = 0;
  await assert.rejects(waitForOwnedShutdown(42, { inspect: () => ({}), runnerActive: () => false,
    isAlive: () => true, now: () => tick, wait: async () => { tick++; }, timeoutMs: 3 }), /PID 42 did not exit normally/);
  await assert.rejects(waitForOwnedShutdown(42, { inspect: () => ({unknown:true}),
    runnerActive: () => false, isAlive: () => false }), /Process state unknown/);
});

// The fixed signed app is a macOS bundle; its ownership check only runs on darwin with POSIX paths.
test('fixed app ownership matches executable paths, not mentions or nested helper apps', { skip: process.platform !== 'darwin' && 'macOS-only fixed app runtime' }, () => {
  const app = '/Users/fixture/Applications/Cindy Personal.app', exe = app + '/Contents/MacOS/Electron';
  assert.deepEqual(fixedAppProcesses(` 42 ${exe}\n43 /bin/zsh\n44 /usr/bin/grep\n45 ${exe}-other\n46 ${app}/Contents/PlugIns/Widget.appex/Contents/MacOS/Widget\n`, app), [42]);
  assert.deepEqual(fixedAppProcesses(`43 /bin/zsh -c echo ${exe}\n44 /usr/bin/grep ${exe}\n`, app), []);
});

// A live pre-spawn failure proves no candidate code ran. Missing readiness does not.
test('only a failure before attempting spawn permits manual recovery', t => {
  for (const attempted of [false, true]) {
    const f = fixture(t);
    f.j.beginManual(f.candidate, {prepared:true, stopped:true, manualRequested:true, smokeVerified:true, profileVerified:true});
    assert.throws(() => startTrial(f.j, beforeSpawn => {
      if (attempted) beforeSpawn();
      throw Error('injected launch failure');
    }), /injected/);
    if (attempted) {
      assert.equal(f.j.read().phase,'trial');
      assert.equal(f.j.recoverInterrupted().phase,'blocked');
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'known-good.json'))).rollbackSafe,false);
    } else {
      assert.equal(f.j.read().phase,'recovering');
      assert.equal(f.j.read().recoveryReason,'candidate-not-launched');
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'known-good.json'))).rollbackSafe,undefined);
      assert.equal(f.j.finishRecovery(true).phase,'stable');
    }
  }
});

// Cooperative ownership: the old supervisor releases only its own lock; it never requests app quit.
// A stale token/generation cannot release a newer owner. Actual on-disk lock, injected scheduling.
test('supervisor handoff binds owner and app generation and releases without stopping the app', async t=>{
 const {publishSupervisorControl,shouldYieldSupervisor,requestSupervisorRelease}=await import('../personal-build/supervisor-handoff.mjs');
 const f=fixture(t),lock=path.join(f.dir,'supervisor.lock'),unlock=acquire(lock);
 const identity={appPid:42,generation:'app-generation',releaseId:'good'};
 publishSupervisorControl(lock,identity);
 assert.equal(shouldYieldSupervisor(lock,identity,1000),false);
 let tick=1000;
 const result=await requestSupervisorRelease(lock,42,{now:()=>tick,wait:async()=>{
   assert.equal(shouldYieldSupervisor(lock,{...identity,generation:'stale'},tick),false);
   assert.equal(shouldYieldSupervisor(lock,{...identity,appPid:43},tick),false);
   assert.equal(shouldYieldSupervisor(lock,identity,tick),true);
   unlock();tick+=250;
 }});
 assert.equal(result.released,true);
 const nextUnlock=acquire(lock);
 try {
   publishSupervisorControl(lock,{...identity,appPid:43});
   await assert.rejects(requestSupervisorRelease(lock,42),/identity changed/);
 }finally{nextUnlock();}
});

// Script integration: the in-process handoff test cannot catch mismatched process ownership.
// Two real processes exchange the production on-disk request; no app, TTY or user state is touched.
test('supervisor handoff releases a different process lock while its owner stays alive', {timeout:5000}, async t => {
  const { requestSupervisorRelease } = await import('../personal-build/supervisor-handoff.mjs');
  const f = fixture(t), lock = path.join(f.dir, 'supervisor.lock');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const {acquire} = await import(process.argv[2]);
    const {publishSupervisorControl,shouldYieldSupervisor} = await import(process.argv[3]);
    const lock=process.argv[1], identity={appPid:42,generation:'test-generation',releaseId:'good'};
    const unlock=acquire(lock); publishSupervisorControl(lock,identity);
    process.on('message', message => {
      if(message==='finish') { process.disconnect(); return; }
      const yieldNow=shouldYieldSupervisor(lock,identity);
      if(yieldNow) unlock();
      process.send({yielded:yieldNow});
    });
    process.send({ready:true});
  `, lock, new URL('../personal-build/lock.mjs', import.meta.url).href,
  new URL('../personal-build/supervisor-handoff.mjs', import.meta.url).href],
  { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  t.after(async () => { if(child.exitCode===null && child.signalCode===null) child.kill(); await exited; });
  const [ready] = await once(child, 'message');
  assert.equal(ready.ready, true);
  assert.throws(() => acquire(lock), /Already running/);
  const exchange = async () => {
    const reply = once(child, 'message'); child.send('inspect'); return (await reply)[0];
  };
  const result = await requestSupervisorRelease(lock, 42, { wait: exchange });
  assert.equal(result.supervisorPid, child.pid);
  assert.equal(result.released, true);
  assert.equal(child.exitCode, null); // Yielding supervision must not end the terminal's owner.
  const nextUnlock = acquire(lock);
  try { assert.deepEqual(await exchange(), {yielded:false}); }
  finally { nextUnlock(); }
  child.send('finish');
  const [code] = await exited;
  assert.equal(code, 0);
});

test('pre-spawn failure can be checked and retried, and recovered supervision failure stays distinct',async t=>{
 const f=fixture(t),proof={prepared:true,stopped:true,manualRequested:true,smokeVerified:true,profileVerified:true};
 f.j.beginManual(f.candidate,proof);f.j.rejectBeforeLaunch('TTY unavailable');f.j.finishRecovery(true);
 assert.equal(f.j.read().rejected.length,0);
  assert.equal(blockedAutomaticCandidate(f.j.read(),f.candidate.id),true);
  assert.equal(blockedAutomaticCandidate(f.j.read(),'different-checked-candidate'),false);
 f.j.beginManual(f.candidate,proof); // same candidate bytes, fresh explicit acceptance
 let receipt;
 await assert.rejects(restartWithSupervisorLock(path.join(f.dir,'lock'),42,{
   prepare:()=>{},observe:()=>({pid:receipt?.phase==='stopping'?undefined:42,ready:true}),stop:()=>{},
   activate:verified=>{verified({recovered:true,releaseId:'good'});throw Error('supervisor I/O failed');},
   record:r=>{receipt=r;},
 }),/supervisor I\/O failed/);
 assert.equal(receipt.phase,'supervision-failed');assert.equal(receipt.recovered,true);assert.equal(receipt.verified,false);
});
