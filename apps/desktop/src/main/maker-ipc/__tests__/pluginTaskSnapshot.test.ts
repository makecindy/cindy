import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, symlink, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import ts from 'typescript';
import { PluginTaskError, readPluginTaskPlanReceipt } from '../pluginTaskService.js';
import type { PluginTaskRoute } from '../../../shared/pluginTasks.js';
import { resolvePluginWorkerDirectory } from '../pluginWorkerDirectory.js';

import { createSessionExecutionResolver } from '../sessionExecutionSelection';

const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');
function compile(text: string, deps: Record<string, unknown>) {
  return new Function(...Object.keys(deps), ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText)(...Object.values(deps));
}
function handler(kind: string, next: string, deps: Record<string, unknown>) {
  const branch = source.slice(source.indexOf(`      case '${kind}':`), source.indexOf(`      case '${next}':`));
  return compile(`return async function(pluginId,request){switch(request.kind){${branch}}}`, deps);
}

it.each([
  {pending:'claude-code', target:'codex', harness:'codex'},
  {pending:undefined, target:'cc', harness:'claude-code'},
  {pending:undefined, target:'codex', harness:undefined},
])('routes an explicit model choice through the correct runtime controller: %j', async ({pending,target,harness}) => {
  const start = source.indexOf('      setModel: async (taskId, route, assertUnchanged) =>');
  const property = source.slice(start, source.indexOf('      assertTeamPlanUnstarted:',start)).trim().replace(/,$/, '');
  const set = vi.fn(async () => ({ok:true,status:'applied'}));
  const apply = compile(`return ({${property}}).setModel;`, {PluginTaskError,sessionControlService:{
    getSessionRuntime:async()=>({ok:true,runtime:{runtimeGeneration:7,effectiveProfile:{agentKind:'codex'},pendingMutation:pending ? {profile:{agentKind:pending}} : null}}),
    setSessionRuntime:set,
  }});
  const assertCurrent=vi.fn();
  await apply('task',{agentKind:target,providerId:'chosen',model:'chosen-model',effort:'medium',fastMode:false},assertCurrent);
  expect(assertCurrent).toHaveBeenCalledOnce();
  expect(set).toHaveBeenCalledWith({targetSessionId:'task',expectedGeneration:7,patch:{
    ...(harness ? {harness} : {}),providerId:'chosen',model:'chosen-model',effort:'medium',fastMode:false,
  }});
});

it.each(['auto', 'acceptEdits'])('exposes independent Plan Mode alongside stored %s permission', async permissionMode => {
  const start = source.indexOf('      readSession: async taskId =>');
  const property = source.slice(start, source.indexOf('      dispatch:', start)).trim().replace(/,$/, '');
  const row = {id:'task',source:'plugin',agentKind:'codex',status:'active',permissionMode,planModeEnabled:true};
  const query = {from:()=>query,where:()=>query,limit:async()=>[row]};
  const read = compile(`return ({${property}}).readSession;`, {assertCurrent:()=>{},snapshot:{client:{drizzle:{select:()=>query}}},sessions:{},eq:()=>true,pluginTaskConfigHash:createHash,readSessionRuntimeProfiles:async()=>null});
  const plan = await read('task');
  expect(plan).toMatchObject({permissionMode,planModeEnabled:true});
  row.planModeEnabled=false;
  const normal = await read('task');
  expect(normal).toMatchObject({permissionMode,planModeEnabled:false});
  expect(normal.revision).not.toBe(plan.revision);
});

it.each(['codex', 'claude-code'] as const)('keeps the accepted next-input route stable when a deferred %s switch settles', async agentKind => {
  const start = source.indexOf('      readSession: async taskId =>');
  const property = source.slice(start, source.indexOf('      dispatch:', start)).trim().replace(/,$/, '');
  const old = {agentKind:'codex',providerId:'old-provider',model:'old',effort:'medium',fastMode:false};
  const next = {agentKind,providerId:'selected-provider',model:'selected',effort:'high',fastMode:false};
  const row = {id:'task',source:'plugin',status:'active',permissionMode:'ask',planModeEnabled:false,...old};
  let pending = true;
  const query = {from:()=>query,where:()=>query,limit:async()=>[row]};
  const read = compile(`return ({${property}}).readSession;`, {
    assertCurrent:()=>{}, snapshot:{client:{drizzle:{select:()=>query}}}, sessions:{},eq:()=>true,pluginTaskConfigHash:createHash,
    readSessionRuntimeProfiles:async()=>({effective:pending ? old : next,pendingMutation:pending ? {profile:next} : null}),
  });
  const accepted = await read('task');
  expect(accepted.resolvedConfig).toEqual({...next,agentKind:agentKind==='claude-code'?'cc':agentKind});
  pending=false;
  Object.assign(row,next,{agentKind:agentKind==='claude-code'?'cc':agentKind});
  const applied = await read('task');
  expect(applied.resolvedConfig).toEqual(accepted.resolvedConfig);
  expect(applied.revision).toBe(accepted.revision);
});

it('freezes the directory returned by admission without mutating the caller plan', async () => {
  const epoch = {};
  const save = vi.fn();
  const plan = { concurrency: 1, items: [{ label: 'sample', workingDir: '/root/link', route: {} }] };
  const run = handler('setTeamPlan', 'releaseWorker', {
    PluginTaskError, withSendToSessionLock: async (_: string, fn: () => unknown) => fn(),
    getCurrentDbClientSnapshot: () => epoch,
    service: { get: async () => ({ revision: 1, workingDir: '/root' }), setTeamPlan: save },
    readPluginTaskConfig: () => ({ workingDir: '/root' }), isPluginTaskAuthorized: () => true,
    isGhostPickedDir: () => false, resolvePluginWorkerDirectory: async () => '/root/original',
  });
  await run('plugin', { kind: 'setTeamPlan', taskId: 'task', plan });
  expect(save).toHaveBeenCalledWith('plugin', 'task', {
    ...plan, items: [{ ...plan.items[0], workingDir: '/root/original' }],
  });
  expect(plan.items[0].workingDir).toBe('/root/link');
});

it('retargeting a real symlink cannot change the stored plan directory', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'plugin-plan-target-')));
  try {
    const original = path.join(root, 'original'), other = path.join(root, 'other'), link = path.join(root, 'link');
    await mkdir(original); await mkdir(other); await symlink(original, link, 'junction');
    const epoch = {}, save = vi.fn();
    const plan = { concurrency: 1, items: [{ label: 'sample', workingDir: link, route: {} }] };
    const run = handler('setTeamPlan', 'releaseWorker', {
      PluginTaskError, withSendToSessionLock: async (_: string, fn: () => unknown) => fn(),
      getCurrentDbClientSnapshot: () => epoch,
      service: { get: async () => ({ revision: 1, workingDir: root }), setTeamPlan: save },
      readPluginTaskConfig: () => ({ workingDir: root }), isPluginTaskAuthorized: () => true,
      isGhostPickedDir: () => false, resolvePluginWorkerDirectory,
    });
    await run('plugin', { kind: 'setTeamPlan', taskId: 'task', plan });
    const stored = save.mock.calls[0][2].items[0].workingDir;
    await unlink(link); await symlink(other, link, 'junction');
    const resolve = (requested: string) => resolvePluginWorkerDirectory({ requested, leadDirectory: root, isPickedDirectory: () => false, assertCurrent: () => {} });
    expect(await resolve(stored)).toBe(original);
    expect(await resolve(link)).toBe(other);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(['provider', 'receipt', 'directory', 'creator'])('keeps default-route configuration current through %s awaits', async phase => {
  const resolveStart = source.indexOf('    const resolveRoute = async');
  const resolveSource = source.slice(resolveStart, source.indexOf('    const readExecution', resolveStart));
  const createStart = source.indexOf('      createSession: async');
  const createSource = source.slice(createStart, source.indexOf('      readSession:', createStart)).trim().replace(/,$/, '');
  for (const field of ['agentKind', 'model', 'providerId', 'effort', 'fastMode'] as const) {
    const epoch = {};
    const initial: PluginTaskRoute = { agentKind: 'codex', model: 'model', providerId: 'one', effort: 'high', fastMode: false };
    const cfg = { ...initial, workingDir: '/root', permissionMode: 'plan' };
    const change = () => {
      if (field === 'agentKind') cfg.agentKind = 'pi';
      if (field === 'model') cfg.model = 'other';
      if (field === 'providerId') cfg.providerId = 'two';
      if (field === 'effort') cfg.effort = 'low';
      if (field === 'fastMode') cfg.fastMode = true;
    };
    let lookups = 0;
    const create = vi.fn(async ({ shouldContinue }: { shouldContinue: () => boolean }) => {
      if (phase === 'creator') change();
      if (!shouldContinue()) throw new PluginTaskError('PERMISSION_DENIED', 'changed');
    });
    const api = compile(`${resolveSource}\nreturn {resolveRoute, create: ({${createSource}}).createSession};`, {
      PluginTaskError, snapshot: epoch, assertPlugin: vi.fn(),
      readPluginTaskConfig: () => ({ ...cfg }), getPluginTaskSourceSessionId: () => undefined,
      resolveSessionExecution: createSessionExecutionResolver({
        captureOwner: () => () => {}, readCaller: async () => { throw Error('unexpected caller'); }, readDefault: () => undefined,
        availableAgents: () => ['claude-code', 'codex', 'pi'],
        availableModels: () => ['model', 'other'].map(id => ({ id, efforts: ['high', 'low'], supportsFastMode: true })),
        hasCindyAiApiKey: () => true,
        readProviderRouting: async () => {
          if (++lookups === 1 && phase === 'provider') change();
          const providers = ['one','two'].map(id => ({ id, name: id, models: ['model','other'] }));
          return { availability: { 'claude-code': providers, codex: providers, pi: providers }, resolveDefaultProviderIdForModel: () => 'one' };
        },
      }),
      routeUnavailable: () => { throw Error('unavailable'); },
      resolvePluginWorkerDirectory: async () => { if (phase === 'directory') change(); return '/root'; },
      createPluginTaskSession: create, clampPluginTaskPermissionMode: (value: string) => value,
      getCurrentDbClientSnapshot: () => epoch, isPluginTaskAuthorized: () => true,
      notifyGhostSessionEvent: vi.fn(), broadcastSessionCreated: vi.fn(),
    });
    const route = await api.resolveRoute('plugin');
    if (phase === 'receipt') change();
    await expect(api.create('plugin', 'task', 'title', route, false)).rejects.toThrow();
    if (phase !== 'creator') expect(create).not.toHaveBeenCalled();
  }
});

it('forwards the explicit route when revalidating creation', async () => {
  const start = source.indexOf('      createSession: async');
  const property = source.slice(start, source.indexOf('      readSession:', start)).trim().replace(/,$/, '');
  const epoch = {};
  const route: PluginTaskRoute = { agentKind: 'codex', providerId: 'mine', model: 'explicit', effort: 'high', fastMode: false };
  const resolveRoute = vi.fn(async () => route);
  const create = vi.fn();
  const run = compile(`return ({${property}}).createSession;`, {
    PluginTaskError, snapshot: epoch, assertPlugin: vi.fn(),
    readPluginTaskConfig: () => ({ model: 'different-default', permissionMode: 'plan' }),
    resolveRoute, createPluginTaskSession: create, clampPluginTaskPermissionMode: (x: string) => x,
    getCurrentDbClientSnapshot: () => epoch, isPluginTaskAuthorized: () => true,
    notifyGhostSessionEvent: vi.fn(), broadcastSessionCreated: vi.fn(),
  });
  await run('plugin', 'task', 'title', route, true, route);
  expect(resolveRoute).toHaveBeenCalledWith('plugin', route, undefined);
  expect(create).toHaveBeenCalledOnce();
});

it.each(['pending', 'empty', 'incomplete', 'error'])('restores Lead input before reporting team state: %s', async state => {
  let restored = false;
  let pending: string[] = [];
  const query = { from: () => query, where: () => query, limit: async () => [{ totalTokenUsage: 0 }] };
  const epoch = { client: { drizzle: { select: () => query } } };
  const workspace = vi.fn(async () => ({ ok: true, workers: [] }));
  const run = handler('getTeam', 'create', {
    PluginTaskError, readPluginTaskPlanReceipt, getCurrentDbClientSnapshot: () => epoch, service: { get: async () => ({}) },
    getOrcaWorkspaceInfoReadOnly: workspace, createOrcaDiagnosticsDeps: () => ({}),
    maker: { getSession: () => undefined }, sessions: {}, eq: vi.fn(),
    createPluginTaskStore: () => ({ get: async () => ({ payload: '{}' }) }),
    readCollaborationSettings: () => ({ workerHardLimit: 4 }),
    inputCoordinator: {
      ensureQueueRestored: async () => {
        if (state === 'error') throw Error('queue unavailable');
        restored = state !== 'incomplete'; pending = state === 'pending' ? ['old input'] : [];
      },
      isQueueRestored: () => restored,
      getQueueControlSnapshot: () => ({ pendingQueue: pending }),
    },
  });
  const result = run('plugin', { kind: 'getTeam', taskId: 'task' });
  if (state === 'incomplete' || state === 'error') await expect(result).rejects.toThrow();
  else expect((await result).leadWorking).toBe(state === 'pending');
});
