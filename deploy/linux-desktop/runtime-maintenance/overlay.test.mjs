import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createMaintenanceGate, ingresses } from './gate.mjs';
import { createRequire } from 'node:module';
import { transformMaintenanceSource, cloudMaintenancePlugin, targets } from './overlay.mjs';
import { transformCloudActivitySource } from '../runtime-activity/overlay.mjs';
test('unrecognized/missing/duplicate ingress cannot silently pass a build',()=>{
  assert.equal(transformMaintenanceSource('x','unrelated.ts'),null);
  for(const t of targets) assert.throws(()=>transformMaintenanceSource('',t));
  assert.throws(()=>cloudMaintenancePlugin({sourceRoot:'/test'}).buildEnd(null),/Missing/);
});
const source=process.env.CINDY_ACTIVITY_TEST_SOURCE;
test('cloud build rejects omitted or mismatched deployment regions before packaging',()=>{
  const config = region => ({define:{'import.meta.env.VITE_CINDY_AUTH_REGION':JSON.stringify(region)}});
  assert.throws(()=>cloudMaintenancePlugin({sourceRoot:'/test'}).configResolved(config('global')),/explicitly/);
  const plugin=cloudMaintenancePlugin({sourceRoot:'/test',expectedRegion:'cn'});
  assert.throws(()=>plugin.configResolved(config('global')),/must match/);
  assert.throws(()=>plugin.configResolved({define:{}}),/must match/);
  plugin.configResolved(config('cn'));
  cloudMaintenancePlugin({sourceRoot:'/test',expectedRegion:'global'}).configResolved(config('global'));
});
test('every actual cloud ingress transforms and compiles without editing client sources',{skip:!source},()=>{
  const require=createRequire(path.join(source,'package.json')),esbuild=require('esbuild');
  const plugin=cloudMaintenancePlugin({sourceRoot:source});
  for(const target of targets){
    const file=path.join(source,target),original=fs.readFileSync(file,'utf8');
    const activity=transformCloudActivitySource(original,target)??original;
    const result=plugin.transform(activity,file).code;
    esbuild.transformSync(result,{loader:'ts',format:'cjs'});
    assert.equal(fs.readFileSync(file,'utf8'),original);
    assert.throws(()=>transformMaintenanceSource(result,target),/twice/);
    if(target.endsWith('agent-input-coordinator.ts')){
      // Control steering bypasses steer(); it must pass the same new-input gate.
      const body=result.slice(result.indexOf('async steerControlInput('));
      assert.match(body.slice(0,body.indexOf('{',body.indexOf(')'))+80),/cloudMaintenance\.run\('agent-input', async \(\) => \{/);
    }
  }
  plugin.buildEnd(null);
});

test('startup connects the gate to the explicit hooks, and only the core quit chain stays untouched',()=>{
  const bootstrap='apps/desktop/src/main/bootstrap-electron.ts';
  const marker='    const stopStatus = startInstanceStatus(';
  const out=transformMaintenanceSource(`function start() {\n${marker}x);\n}\n`,bootstrap);
  const wiring=out.slice(out.indexOf('function start()'));
  for(const call of ['connectCloudMaintenance(cloudMaintenance);','observeCloudQuitSteps(cloudMaintenanceQuit);','configureMaintenanceActivity(readMaintenanceActivity);'])
    assert.ok(wiring.indexOf(call)>=0&&wiring.indexOf(call)<wiring.indexOf(marker),call);
  assert.match(out,/from '\.\/instance-runtime\/maintenance\.js'/);
  assert.match(out,/from '\.\/lifecycle\.js'/);
  assert.throws(()=>transformMaintenanceSource('function start() {}',bootstrap),/activity integration changed/);
  // The quit chain reports its own steps; its log wording is not part of the build.
  assert.ok(!targets.includes('apps/desktop/src/main/lifecycle.ts'));
  assert.equal(transformMaintenanceSource("log.warn('anything');",'apps/desktop/src/main/lifecycle.ts'),null);
});

// Executes the actual overlaid scheduler with in-memory storage and a fake clock:
// startup must not skip a fire that became due while the instance was stopped.
test('sealed replacement preserves due schedules and executes each once after release', { skip: !source }, async () => {
  const require = createRequire(path.join(source, 'package.json')), esbuild = require('esbuild');
  const relative = 'packages/maker-scheduler/src/engine/scheduler.ts';
  const transformed = transformMaintenanceSource(fs.readFileSync(path.join(source, relative), 'utf8'), relative);
  const compiled = esbuild.buildSync({ stdin: { contents: transformed, loader: 'ts',
    resolveDir: path.dirname(path.join(source, relative)) }, bundle: true, platform: 'node', format: 'cjs',
    external: ['virtual:cindy-cloud-maintenance'], write: false }).outputFiles[0].text;
  let at = Date.parse('2030-01-01T03:00:00Z'), saved;
  const binding = { instanceId: 'i', deviceId: 'd', statefulSetUid: 's', pvcUid: 'p' };
  const options = { binding, ledgerFile: '/synthetic/ledger', now: () => at, coverage: ingresses,
    save: (_p, value) => { saved = structuredClone(value); }, load: () => {
      if (saved) return structuredClone(saved); throw Object.assign(new Error(), { code: 'ENOENT' }); } };
  let gate = createMaintenanceGate({ ...options, podUid: 'source', bootId: 'source' });
  const command = action => ({ version: 1, ...binding, operationId: 'op', epoch: 1,
    sequence: gate.receipt().sequence + 1, action, sourcePodUid: 'source', sourceBootId: 'source',
    targetDigest: `sha256:${'a'.repeat(64)}`, policyDigest: 'b'.repeat(64), windowEndAt: at + 3_600_000,
    expiresAt: at + 180_000, expectedReceiptDigest: gate.receipt().stateDigest });
  const prepare = command('prepare'); gate.accept(prepare);
  const sample = () => gate.observe({ atMs: at, active: 0, legacyQueued: 0, unknown: 0, nextWakeAtMs: at + 1 }, gate.revision());
  sample(); at += 10_000; sample();
  const seal = { ...command('seal'), windowEndAt: prepare.windowEndAt }; gate.accept(seal);
  const due = at + 1000; at += 60_000;
  gate = createMaintenanceGate({ ...options, podUid: 'candidate', bootId: 'candidate' });
  const base = { name: 'test', cronExpr: '* * * * *', timezone: 'UTC', prompt: 'test',
    recurring: true, status: 'active', createdAt: due - 60_000, nextFireAt: due };
  const rows = new Map([
    ['cron', { ...base, id: 'cron' }], ['interval', { ...base, id: 'interval', intervalMs: 60_000 }],
    ['once', { ...base, id: 'once', recurring: false }],
    ['manual', { ...base, id: 'manual', manual: true }],
    ['finished', { ...base, id: 'finished', recurring: false, lastFiredAt: due - 1000 }],
    ['invalid', { ...base, id: 'invalid', cronExpr: 'invalid' }],
  ]), runs = new Map(), fired = [];
  const storage = {
    listActive: async () => [...rows.values()].filter(r => r.status === 'active').map(r => ({ ...r })),
    get: async id => rows.has(id) ? { ...rows.get(id) } : null,
    update: async (id, patch) => { const r = { ...rows.get(id), ...patch }; rows.set(id, r); return { ...r }; },
    markRunningAsInterrupted: async () => [], hasRunningRuns: async () => false,
    claimDueFire: async (id, expected) => {
      if (rows.get(id)?.nextFireAt !== expected) return null;
      const r = { ...rows.get(id), nextFireAt: undefined }; rows.set(id, r); return { ...r };
    },
    insertRun: async run => { runs.set(run.id, { ...run }); return run; },
    updateRun: async (id, patch) => { const r = { ...runs.get(id), ...patch }; runs.set(id, r); return r; },
    listRuns: async id => [...runs.values()].filter(r => r.scheduleId === id),
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports,
    require: id => id === 'virtual:cindy-cloud-maintenance' ? { cloudMaintenance: gate } : require(id),
    setInterval: () => ({ unref() {} }), clearInterval() {}, AbortController, setTimeout, clearTimeout });
  let serial = 0;
  const scheduler = new module.exports.Scheduler({ storage, clock: { now: () => at }, generateId: () => `run-${++serial}`,
    runner: { fire: async schedule => { fired.push(schedule.id); return {}; } } });
  try {
    await scheduler.start();
    for (const id of ['cron', 'interval', 'once']) assert.equal(rows.get(id).nextFireAt, due);
    for (const id of ['manual', 'finished', 'invalid']) assert.equal(rows.get(id).nextFireAt, undefined);
    await scheduler.tick(); assert.deepEqual(fired, []);
    gate.accept({ ...command('release'), windowEndAt: prepare.windowEndAt });
    await scheduler.tick(); await scheduler.tick();
    assert.deepEqual(fired.sort(), ['cron', 'interval', 'once']);
    assert.equal(runs.size, 3);
    assert.equal(rows.get('once').status, 'expired');
    for (const id of ['cron', 'interval']) assert.ok(rows.get(id).nextFireAt > at);
  } finally { await scheduler.stop(); }
});
