import { readFile } from 'node:fs/promises';
import { createUtilityFixture } from './utility.fixture.js';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { TerminalPluginModels } from '../plugins/models.js';
import type { InstalledGhost } from '@cindy/plugin-runtime/shared/ghost';
import { atomicPrivateWrite } from '../platform.js';
import type { AutoReviewRequest } from '@cindy/maker-core';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

// Integration: a saved terminal auxiliary chain must control actual dispatch,
// survive restart, and stop fallback when its owner/configuration changes.
// Real HTTP, model registry and encrypted vault; no model/runtime mocks.
const fixture = () => createUtilityFixture(cleanup);

it('uses the owner auxiliary fallback for Auto review and invalidates a changed model route',async()=>{
  const f=await fixture(),utility=f.create();
  await utility.update({models:[f.pin('second')]});f.answer('{"verdict":"allow"}');
  const request:AutoReviewRequest={sessionId:'task',agentKind:'pi',providerId:'fixture',model:'second',userIntent:'Inspect the project files.',action:{kind:'exec',command:'ls'},workspaceRoots:[f.root],platform:process.platform};
  expect(await utility.reviewPermission(request)).toEqual({verdict:'allow'});
  expect(f.requests).toEqual(['second']);
  expect(f.bodies[0].messages[0]).toMatchObject({role:'system'});
  expect(f.bodies[0].messages[1].content).toContain('Inspect the project files.');
  let enter!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  f.intercept(async()=>{enter();await gate;});
  const pending=utility.reviewPermission(request);
  await started;await utility.update({models:[f.pin('first')]});release();
  await expect(pending).rejects.toThrow('MODEL_CONFIGURATION_CHANGED');
  expect(f.requests).toEqual(['second','second']);
});

it('uses the saved order, preserves it after restart and restores automatic defaults', async () => {
  const f = await fixture();
  let utility = f.create();
  await utility.update({ models: [f.pin('first'), f.pin('second')] });
  expect(await utility.request('A short auxiliary request')).toMatchObject({
    ok: true,
    text: 'UTILITY_OK',
    model: 'second',
  });
  expect(f.requests).toEqual(['first', 'second']);
  expect(JSON.stringify(await utility.state())).not.toMatch(
    /fixture-secret|private-header/,
  );
  expect(
    await readFile(path.join(f.root, 'auxiliary-model-settings.json'), 'utf8'),
  ).not.toContain('fixture-secret');
  await utility.close();
  utility = f.create();
  expect((await utility.state()).models).toEqual([
    f.pin('first'),
    f.pin('second'),
  ]);
  await utility.update({ models: [f.pin('first')] });
  expect(await utility.request('No implicit fallback')).toMatchObject({
    ok: false,
  });
  expect(f.requests).toEqual(['first', 'second', 'first']);
  const reset = await utility.update({ models: [] });
  expect(reset).toMatchObject({
    models: [],
    isCustomized: false,
    effective: { source: 'auto' },
  });
  await expect(
    readFile(path.join(f.root, 'auxiliary-model-settings.json')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not dispatch the next candidate after configuration or owner revocation', async () => {
  const f = await fixture(),
    utility = f.create();
  await utility.update({ models: [f.pin('first'), f.pin('second')] });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.intercept(async () => {
    entered();
    await gate;
  });
  const request = utility.request('A request with a revocable route');
  await started;
  await utility.update({ models: [f.pin('second')] });
  release();
  expect(await request).toMatchObject({ ok: false });
  expect(f.requests).toEqual(['first']);
  f.revoke();
  await expect(
    utility.request('Do not send for a replaced owner'),
  ).rejects.toThrow('OWNER_CHANGED');
  expect(f.requests).toEqual(['first']);
});

// Integration: plugin quick answers previously reached UNSUPPORTED_CAPABILITY
// in the terminal host. Exercise the production handler with real settings,
// encrypted model credentials and HTTP; exact pins must never fall back.
it('dispatches plugin quick answers with migrated preferences and exact model selection', async () => {
  const f = await fixture(), utility = f.create();
  await utility.update({ models: [f.pin('first'), f.pin('second')] });
  const ghost: InstalledGhost = { manifest: { schemaVersion: 3, id: 'utility-plugin', name: 'Utility plugin', version: '1.0.0', kind: 'chip', entry: 'main.js', cindy: { text: ['oneshot'] } }, dir: f.root, enabled: true, approval: { state: 'approved', revision: 'receipt-a' } };
  const plugins = new TerminalPluginModels({root:f.root,models:f.models,utility,installed:id=>id===ghost.manifest.id?ghost:null,guard(){},changed(){}});
  cleanup.push(()=>plugins.close());
  const request={type:'cindy-request',kind:'oneshot_text',prompt:'A plugin quick answer'};
  expect(await plugins.receive(ghost.manifest.id,request)).toMatchObject({ok:true,text:'UTILITY_OK'});
  expect(f.requests).toEqual(['first','second']);
  await atomicPrivateWrite(path.join(f.root,'ghost-errand-prefs.json'),JSON.stringify({errand:{[ghost.manifest.id]:{permissionMode:'ask',workingDir:f.root}},sessions:{[`${ghost.manifest.id}#existing`]:'existing-task'}}));
  await atomicPrivateWrite(path.join(f.root,'ghost-cindy-prefs.json'),JSON.stringify({overrides:{[ghost.manifest.id]:{'text.oneshot':f.pin('first')}},inflightLimits:{[ghost.manifest.id]:1}}));
  expect((await plugins.state(ghost.manifest.id)).selected).toBe(f.pin('first'));
  expect(await plugins.receive(ghost.manifest.id,request)).toMatchObject({ok:false,errorCode:'INTERNAL'});
  expect(f.requests).toEqual(['first','second','first']);
  await plugins.setModel(ghost.manifest.id,f.pin('second'));
  expect(await plugins.receive(ghost.manifest.id,request)).toMatchObject({ok:true});
  await plugins.setModel(ghost.manifest.id,null);
  expect(await plugins.config(ghost.manifest.id)).toEqual({permissionMode:'ask',workingDir:f.root});
  const saved=JSON.parse(await readFile(path.join(f.root,'ghost-errand-prefs.json'),'utf8'));
  expect(saved.sessions).toEqual({[`${ghost.manifest.id}#existing`]:'existing-task'});
  expect(JSON.parse(await readFile(path.join(f.root,'ghost-cindy-prefs.json'),'utf8'))).toEqual({inflightLimits:{[ghost.manifest.id]:1}});
  ghost.manifest.cindy!.oneshotModel='second';
  expect(await plugins.receive(ghost.manifest.id,request)).toMatchObject({ok:true});
  expect(f.requests).toEqual(['first','second','first','second','second']);
  ghost.enabled=false;
  expect(await plugins.receive(ghost.manifest.id,request)).toMatchObject({ok:false,errorCode:'PERMISSION_DENIED'});
  expect(f.requests).toHaveLength(5);
});

it('revokes a plugin fallback on package replacement and aborts in-flight model requests on shutdown',async()=>{
  const f=await fixture(),utility=f.create();
  await utility.update({models:[f.pin('first'),f.pin('second')]});
  const ghost:InstalledGhost={manifest:{schemaVersion:3,id:'revocable-plugin',name:'Revocable plugin',version:'1.0.0',kind:'chip',entry:'main.js',cindy:{text:['oneshot']}},dir:f.root,enabled:true,approval:{state:'approved',revision:'receipt-a'}};
  const plugins=new TerminalPluginModels({root:f.root,models:f.models,utility,installed:()=>ghost,guard(){},changed(){}});
  cleanup.push(()=>plugins.close());
  const request={type:'cindy-request',kind:'oneshot_text',prompt:'A revocable plugin quick answer'};
  f.intercept(async()=>{ghost.approval={state:'approved',revision:'receipt-b'};});
  expect(await plugins.receive(ghost.manifest.id,request)).toMatchObject({ok:false});
  expect(f.requests).toEqual(['first']);
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  f.intercept(async()=>{entered();await gate;});
  const pending=plugins.receive(ghost.manifest.id,request);
  await started;
  try{await plugins.close();expect(await pending).toMatchObject({ok:false});}finally{release();}
  expect(f.requests).toEqual(['first','first']);
});
