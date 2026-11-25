import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { transformCloudActivitySource, cloudTaskActivityPlugin, targets } from './overlay.mjs';

test('unrelated source is unchanged; missing and duplicate integration points fail', () => {
  assert.equal(transformCloudActivitySource('native unchanged','other.ts'),null);
  for(const target of targets) assert.throws(()=>transformCloudActivitySource('',target));
  assert.throws(()=>transformCloudActivitySource('/* cloud-task-activity */',targets[0]),/twice/);
});
test('cloud plugin requires explicit source and all four integration points', () => {
  assert.throws(()=>cloudTaskActivityPlugin({sourceRoot:'relative'}));
  const plugin=cloudTaskActivityPlugin({sourceRoot:'/neutral/source'});
  assert.equal(plugin.resolveId('electron'),null);
  assert.match(plugin.load(plugin.resolveId('virtual:cindy-cloud-task-activity')),/startCloudStatus/);
  assert.throws(()=>plugin.buildEnd(null),/every source/);
});

const source=process.env.CINDY_ACTIVITY_TEST_SOURCE;
test('actual cloud transforms compile, preserve native source and IPC authorization', {skip:!source}, () => {
  const require=createRequire(path.join(source,'package.json'));
  const esbuild=require('esbuild');
  const ts=require('typescript');
  const plugin=cloudTaskActivityPlugin({sourceRoot:source});
  for(const target of targets) {
    const filename=path.join(source,target); const original=fs.readFileSync(filename,'utf8');
    const transformed=plugin.transform(original,filename).code;
    esbuild.transformSync(transformed,{loader:'ts',format:'cjs'});
    assert.equal(fs.readFileSync(filename,'utf8'),original);
    assert.throws(()=>transformCloudActivitySource(transformed,target),/twice/);
    if(target.endsWith('/status.ts')) {
      const originalBuilder=original.slice(original.indexOf('export function buildInstanceStatus'),original.indexOf('export function startInstanceStatus'));
      assert.ok(transformed.includes(originalBuilder));
      const appended='\nexport const futureExport = 42;\n';
      assert.ok(transformCloudActivitySource(original+appended,target).endsWith(appended));
    }
    if(target.endsWith('/agent-input-coordinator.ts')) {
      const ast=ts.createSourceFile('input.ts',transformed,ts.ScriptTarget.Latest,true);
      const cls=ast.statements.find(n=>ts.isClassDeclaration(n) && n.name?.text==='AgentInputCoordinator');
      const method=cls.members.find(n=>n.name?.getText(ast)==='readCloudInputCounts');
      const code=esbuild.transformSync('class Probe {'+method.getText(ast)+'}\nglobalThis.Probe=Probe;',{loader:'ts'}).code;
      const context={}; vm.runInNewContext(code,context); const probe=new context.Probe();
      Object.assign(probe,{states:new Map(),queueRestorePromises:new Map(),pendingAutoResumeRecoveries:new Map(),steerRequestLineages:new Map()});
      assert.deepEqual({...probe.readCloudInputCounts()},{active:0,queued:0,interactions:0,settling:0});
      const sensitive={toJSON(){throw new Error('must not serialize user content');}};
      probe.states.set('private-session',{activeTurn:{item:sensitive},pendingQueue:[sensitive],pendingCompacts:[],
        directSteeringItems:[sensitive],queueInteractionLocks:['private-card'],queueAbortPending:false,drainScheduled:true,
        autoResumePending:null,pendingExternalTerminalDone:false});
      probe.queueRestorePromises.set('restoring',Promise.resolve());
      probe.steerRequestLineages.set('private-session',new Map([['request',{unsettledTokens:new Set([Symbol()])}]]));
      assert.deepEqual({...probe.readCloudInputCounts()},{active:1,queued:2,interactions:1,settling:3});
      // A queue held after restart (no running turn) is not counted; its compacts and steering still are.
      const held={activeTurn:null,pendingQueue:[sensitive,sensitive],pendingCompacts:[],directSteeringItems:[],queueInteractionLocks:[],
        queueAbortPending:false,drainScheduled:false,autoResumePending:null,pendingExternalTerminalDone:false,queuePausedByRestore:true};
      probe.states=new Map([['held-session',held]]);probe.queueRestorePromises=new Map();probe.steerRequestLineages=new Map();
      assert.deepEqual({...probe.readCloudInputCounts()},{active:0,queued:0,interactions:0,settling:0});
      probe.states.set('held-session',{...held,activeTurn:{item:sensitive}});
      assert.deepEqual({...probe.readCloudInputCounts()},{active:1,queued:2,interactions:0,settling:0});
      probe.states.set('held-session',{...held,queuePausedByRestore:false});
      assert.deepEqual({...probe.readCloudInputCounts()},{active:0,queued:2,interactions:0,settling:0});
    }
  }
  plugin.buildEnd(null);
  const ipc=fs.readFileSync(path.join(source,'apps/desktop/src/main/relaunchBusyActivityIpc.ts'),'utf8');
  assert.match(ipc,/assertTrustedAppRendererEvent\(event\)/);
  assert.equal(transformCloudActivitySource(ipc,'apps/desktop/src/main/relaunchBusyActivityIpc.ts'),null);
});
