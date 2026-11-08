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
import { pluginTaskRouteAttempts, pluginTaskSelectionIsOpen } from '../pluginTaskDefaultRoute.js';

import { createSessionExecutionResolver } from '../sessionExecutionSelection';
import { createGhostProductionCallbacks } from '../../cindy-brain/__tests__/ghostProductionCallbacksFixture.js';
import { clampPluginTaskPermissionMode } from '../../cindy-brain/pluginTaskPrefsStore.js';
import { resolveRemotePluginTaskRoute } from '../pluginTaskModelRoute.js';
import { readDeviceProviderViews } from '../../remote-agent/controller/deviceCatalog.js';
import { setSessionRuntimeHarness } from '../sessionRuntimeHarnessSelection.js';
import { resolveSessionRuntimeAxes } from '../sessionRuntimeControl.js';
import { findCatalogModel } from '@cindy/model-providers';

const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');

// User regression: tasks must consume the exact source returned by pickModel. Existing
// local admission tests could accidentally validate a remote namesake against this host.
// Production remote parser + route resolver, no network/real account; tier: unit.
it.each(['other-computer', 'share:provider'])('admits %s only against its authorized live catalog and axes', async agentDeviceId => {
  const route: PluginTaskRoute = { agentKind: 'codex', providerId: 'same', model: 'model', effort: 'high', fastMode: false, agentDeviceId };
  const provider = { id: 'same', name: 'Provider', source: 'user', connected: true,
    remoteInvocationEnabled: true, agents: ['codex'], routing: { codex: {} },
    models: { codex: [{ id: 'model', efforts: ['high'], supportsFastMode: false }] } };
  let authorized = true;
  const invoke = vi.fn(async () => ({ ok: true, result: { providers: authorized ? [provider] : [] } }));
  const deps = { assertCurrent: vi.fn(), readProviders: (id: string) => readDeviceProviderViews(invoke, id) };
  expect(await resolveRemotePluginTaskRoute(route, deps)).toEqual(route);
  expect(invoke).toHaveBeenLastCalledWith(agentDeviceId, 'maker:provider:list', expect.any(Array));
  for (const changed of [{ providerId: 'other' }, { model: 'other' }, { effort: 'low' }, { fastMode: true }]) {
    await expect(resolveRemotePluginTaskRoute({ ...route, ...changed }, deps)).rejects.toMatchObject({ code: 'ROUTE_UNAVAILABLE' });
  }
  // The provider still exists, with the very same ID, after its remote grant is withdrawn.
  provider.remoteInvocationEnabled = false;
  await expect(resolveRemotePluginTaskRoute(route, deps)).rejects.toMatchObject({ code: 'ROUTE_UNAVAILABLE' });
  authorized = false;
  await expect(resolveRemotePluginTaskRoute(route, deps)).rejects.toMatchObject({ code: 'ROUTE_UNAVAILABLE' });
  deps.readProviders = async () => { throw Error('private endpoint and token'); };
  await expect(resolveRemotePluginTaskRoute(route, deps)).rejects.toMatchObject({ code: 'ROUTE_UNAVAILABLE' });
  await expect(resolveRemotePluginTaskRoute(route, deps)).rejects.not.toThrow('private endpoint');
  deps.readProviders = async () => { return []; };
  deps.assertCurrent.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new PluginTaskError('PERMISSION_DENIED', 'Owner changed'); });
  await expect(resolveRemotePluginTaskRoute(route, deps)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
});

it.each(['other-computer', 'share:provider'])('forwards %s from the production task creator into ordinary Session storage', async agentDeviceId => {
  const creatorSource = readFileSync(new URL('../../localDb/ipc/pluginWorkspaceSessions.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('creator.ts', creatorSource, ts.ScriptTarget.Latest, true);
  const declaration = tree.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'createPluginTaskSession')!;
  const openSession = vi.fn(async ({ body }: { body: object }) => ({ row: body }));
  const create = compile(`return (${declaration.getText(tree).replace(/^export\s+/, '')});`, {
    openSession, normalizeWorkingDirForStorage: (value: string) => value, log: { info: vi.fn() },
  });
  await create({ ghostId: 'p', sessionId: 'task', title: 'Remote', agentKind: 'codex', providerId: 'same', model: 'model',
    agentDeviceId, permissionMode: 'ask' });
  expect(openSession).toHaveBeenCalledWith(expect.objectContaining({
    source: 'plugin', body: expect.objectContaining({ agentDeviceId, providerId: 'same', permissionMode: 'ask' }),
  }));
});
function compile(text: string, deps: Record<string, unknown>) {
  deps = { readProviderGroupBinding: () => null, providerGroupService: null, ...deps };
  return new Function(...Object.keys(deps), ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText)(...Object.values(deps));
}
function handler(kind: string, next: string, deps: Record<string, unknown>) {
  const branch = source.slice(source.indexOf(`      case '${kind}':`), source.indexOf(`      case '${next}':`));
  return compile(`return async function(pluginId,request){switch(request.kind){${branch}}}`, deps);
}

// Unlike the existing helper fixture, this runs register's actual runtime adapter.
// A remote-only model and an unavailable local catalog must still stage the exact source.
it.each(['other-computer', 'share:provider'])('uses the %s catalog in the production runtime controller', async agentDeviceId => {
  const start = source.indexOf('    setSessionRuntime: async ({ targetSessionId, expectedGeneration, patch, beforeMutation }) =>');
  const property = source.slice(start, source.indexOf('    assertExternalInputAllowed:', start)).trim().replace(/,$/, '');
  const remote = vi.fn(async () => [{ id: 'remote-only', name: 'Remote', source: 'user', connected: true,
    agents: ['codex'], routing: { codex: {} }, models: { codex: [{ id: 'model', efforts: ['high'] }] } }]);
  const local = vi.fn(() => { throw Error('Local catalog must not be used'); });
  let pending: Record<string, unknown> | undefined;
  const stage = vi.fn(async (_deps: unknown, selection: {
    targetAgentKind: string; model: string; providerId: string; effort: string; fastMode: boolean; agentDeviceId: string;
  }) => {
    pending = { runtimeSource: 'agent', targetAgentKind: selection.targetAgentKind, model: selection.model,
      providerId: selection.providerId, effort: selection.effort, fastMode: selection.fastMode,
      targetAgentDeviceId: selection.agentDeviceId };
    return { deferred: true };
  });
  const run = compile(`return ({${property}}).setSessionRuntime;`, {
    setSessionRuntimeHarness, withSendToSessionLock: async (_id: string, work: () => Promise<unknown>) => work(),
    captureSessionRuntimeControlOwnerEpoch: () => 'owner', getSessionRuntimeControlSnapshot: () => ({ generation: 4 }),
    agentSwitchPending: { revision: () => 0, get: () => pending },
    readSessionRuntimeProfiles: async () => ({ effective: { agentKind: 'codex', model: 'old', effort: null, fastMode: false } }),
    readUsableAgentDeviceProviders: remote, getDesktopProviderService: local, assertModelRouteUsable: local,
    findCatalogModel, resolveSessionRuntimeAxes, performSessionAgentSwitch: stage, agentSwitchDeps: {},
    throwIpcError: (code: string, message: string) => { throw Object.assign(new Error(message), { code }); },
  });
  const request = { targetSessionId: 'task', expectedGeneration: 4,
    patch: { harness: 'codex', agentDeviceId, model: 'model', providerId: 'remote-only', effort: 'high', fastMode: false } };
  expect(await run(request)).toMatchObject({ ok: true, pendingMutation: { profile: { agentDeviceId, model: 'model' } } });
  expect(remote).toHaveBeenCalledWith(agentDeviceId, 'codex', 'model', 'remote-only');
  expect(stage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ agentDeviceId, providerId: 'remote-only' }));
  expect(local).not.toHaveBeenCalled();
  remote.mockResolvedValueOnce([]);
  expect(await run(request)).toMatchObject({ ok: false, errorCode: 'ROUTE_UNAVAILABLE' });
  expect(stage).toHaveBeenCalledTimes(1);
});

// Remote output is persisted on the task computer. Read the production history
// branch and recheck ownership after the async read, as with local tasks. Tier: unit.
it('reads remote output from its own task history and withholds it after plugin revocation', async () => {
  const epoch = {};
  let authorized = true;
  let revokeOnRead = false;
  const get = vi.fn(async () => {
    if (!authorized) throw new PluginTaskError('TASK_NOT_FOUND', 'Task not found');
    return { resolvedConfig: { agentDeviceId: 'share:provider' } };
  });
  const read = vi.fn(async () => {
    if (revokeOnRead) authorized = false;
    return { items: [{ id: 'db-id', clientId: 'remote-output', role: 'assistant', content: 'Remote answer', createdAt: 100 }], nextCursor: null };
  });
  const run = handler('readMessages', 'getRun', { service: { get }, getCurrentDbClientSnapshot: () => epoch,
    drainPersistQueue: async () => {}, getMessagesForHistory: read, PluginTaskError });
  expect(await run('p', { kind: 'readMessages', taskId: 'own-remote-task' })).toEqual({
    items: [{ id: 'remote-output', role: 'assistant', content: 'Remote answer', createdAt: 100 }], nextCursor: null,
  });
  expect(read).toHaveBeenCalledWith(expect.objectContaining({ sessionIds: ['own-remote-task'] }));
  revokeOnRead = true;
  await expect(run('p', { kind: 'readMessages', taskId: 'own-remote-task' })).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
});

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
  expect(set).toHaveBeenCalledWith({targetSessionId:'task',expectedGeneration:7,beforeMutation:assertCurrent,patch:{
    ...(harness ? {harness} : {}),providerId:'chosen',model:'chosen-model',effort:'medium',fastMode:false,
  }});
});

it.each([
  { current: undefined, target: 'other-computer' },
  { current: 'other-computer', target: 'share:provider' },
  { current: 'share:provider', target: undefined },
  { current: 'share:provider', target: 'share:provider' },
])('stages the complete source change $current → $target without touching the active turn', async ({ current, target }) => {
  const start = source.indexOf('      setModel: async (taskId, route, assertUnchanged) =>');
  const property = source.slice(start, source.indexOf('      assertTeamPlanUnstarted:', start)).trim().replace(/,$/, '');
  const set = vi.fn(async () => ({ ok: true, status: 'deferred' }));
  const apply = compile(`return ({${property}}).setModel;`, { PluginTaskError, sessionControlService: {
    getSessionRuntime: async () => ({ ok: true, runtime: { runtimeGeneration: 7,
      effectiveProfile: { agentKind: 'codex', agentDeviceId: current }, pendingMutation: null } }),
    setSessionRuntime: set,
  } });
  const guard = vi.fn();
  await apply('task', { agentKind: 'codex', providerId: 'same', model: 'model', effort: '', fastMode: false,
    ...(target ? { agentDeviceId: target } : {}) }, guard);
  expect(set).toHaveBeenCalledWith(expect.objectContaining({ beforeMutation: guard,
    patch: { harness: 'codex', providerId: 'same', model: 'model', effort: null, fastMode: false, agentDeviceId: target ?? null } }));
});

// Plugin task routes must distinguish local and remote namesakes on both deferred and
// effective snapshots. Existing snapshot tests changed the model but never its location.
// Production entry: readSession callback; minimum input: one plugin row and a staged move. Tier: unit.
it.each(['other-computer', 'share:provider'])('keeps source %s in task configuration and revision across deferred relocation', async agentDeviceId => {
  const start = source.indexOf('      readSession: async taskId =>');
  const property = source.slice(start, source.indexOf('      scheduleAutoTitle:', start)).trim().replace(/,$/, '');
  const local = { agentKind: 'codex', providerId: 'provider', model: 'model', effort: 'high', fastMode: false };
  const remote = { ...local, agentDeviceId };
  const row = { id: 'task', source: 'plugin', status: 'active', permissionMode: 'ask', ...local };
  const query = { from: () => query, where: () => query, limit: async () => [row] };
  let profile = { effective: local, pendingMutation: null as { profile: typeof remote } | null };
  const read = compile(`return ({${property}}).readSession;`, {
    assertCurrent: () => {}, snapshot: { client: { drizzle: { select: () => query } } },
    sessions: {}, eq: () => true, pluginTaskConfigHash: createHash, readSessionRuntimeProfiles: async () => profile,
  });
  const before = await read('task');
  profile.pendingMutation = { profile: remote };
  const pending = await read('task');
  expect(pending.resolvedConfig).toEqual(remote);
  expect(pending.revision).not.toBe(before.revision);
  profile = { effective: remote, pendingMutation: null };
  const applied = await read('task');
  expect(applied.resolvedConfig).toEqual(remote);
  expect(applied.revision).toBe(pending.revision);
});

// Ordinary provider-group assignment can choose a member before vendor acceptance.
// The selected group remains the logical source only with Host-verified membership.
it('keeps a verified remote provider group as the source while rejecting an unrelated executor', async () => {
  const start = source.indexOf('      readSession: async taskId =>');
  const property = source.slice(start, source.indexOf('      scheduleAutoTitle:', start)).trim().replace(/,$/, '');
  const configuration = { agentKind: 'codex', model: 'model', providerId: 'member-account', effort: 'high', fastMode: false, agentDeviceId: 'executor' };
  const row = { id: 'task', source: 'plugin', status: 'active', ...configuration };
  const query = { from: () => query, where: () => query, limit: async () => [row] };
  let group: { groupDeviceId: string; providerId: string } | null = { groupDeviceId: 'group-computer', providerId: 'group-account' };
  let pending = true;
  let unavailable = false;
  const read = compile(`return ({${property}}).readSession;`, {
    assertCurrent: () => {}, snapshot: { client: { drizzle: { select: () => query } } },
    sessions: {}, eq: () => true, pluginTaskConfigHash: createHash,
    readSessionRuntimeProfiles: async () => ({ effective: configuration, pendingMutation: pending
      ? { profile: { ...configuration, providerId: group!.providerId, agentDeviceId: group!.groupDeviceId } } : null }),
    readProviderGroupBinding: () => ({}), providerGroupService: { sessionGroup: async () => {
      if (unavailable) throw Error('Group computer is offline');
      return group;
    } },
  });
  // PR #9155 P2: the same logical route was hashed in a different property order
  // after group assignment. The existing test only read an already bound task.
  const staged = await read('task');
  pending = false;
  const bound = await read('task');
  expect(bound.resolvedConfig).toEqual({ ...configuration, agentDeviceId: 'group-computer', providerId: 'group-account' });
  expect(bound.revision).toBe(staged.revision);
  group = null;
  const unbound = await read('task');
  expect(unbound.resolvedConfig).toEqual(configuration);
  expect(unbound.revision).not.toBe(bound.revision);
  unavailable = true;
  expect((await read('task')).resolvedConfig).toEqual(configuration);
});

it.each(['codex', 'cc'])('rechecks preferences after runtime admission waits for %s', async agentKind => {
  const start = source.indexOf('      setModel: async (taskId, route, assertUnchanged) =>');
  const property = source.slice(start, source.indexOf('      assertTeamPlanUnstarted:', start)).trim().replace(/,$/, '');
  let selectedModel = 'selected';
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const admission = new Promise<void>(resolve => { release = resolve; });
  const write = vi.fn();
  const apply = compile(`return ({${property}}).setModel;`, { PluginTaskError, sessionControlService: {
    getSessionRuntime: async () => ({ ok: true, runtime: {
      runtimeGeneration: 7, effectiveProfile: { agentKind: 'codex' },
    } }),
    setSessionRuntime: async ({ beforeMutation, patch }: {
      beforeMutation?: () => Promise<void>; patch: { model: string };
    }) => {
      entered();
      await admission;
      await beforeMutation?.();
      write(patch.model);
      return { ok: true, status: 'applied' };
    },
  } });
  const assertCurrent = async () => {
    if (selectedModel !== 'selected') throw new PluginTaskError('STALE_REVISION', 'preferences changed');
  };
  const result = apply('task', {
    agentKind, model: 'selected', providerId: 'provider', effort: 'medium', fastMode: false,
  }, assertCurrent);
  const rejected = expect(result).rejects.toMatchObject({ code: 'STALE_REVISION' });
  await waiting;
  selectedModel = 'new-selection';
  release();
  await rejected;
  expect(write).not.toHaveBeenCalled();
});

it.each(['auto', 'acceptEdits'])('exposes independent Plan Mode alongside stored %s permission', async permissionMode => {
  const start = source.indexOf('      readSession: async taskId =>');
  const property = source.slice(start, source.indexOf('      scheduleAutoTitle:', start)).trim().replace(/,$/, '');
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
  const property = source.slice(start, source.indexOf('      scheduleAutoTitle:', start)).trim().replace(/,$/, '');
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
    getPluginTaskDefaults: () => ({ workingDir: '/root' }), isPluginTaskAuthorized: () => true,
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
      getPluginTaskDefaults: () => ({ workingDir: root }), isPluginTaskAuthorized: () => true,
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
      getPluginTaskDefaults: () => ({ ...cfg }), getPluginTaskSourceSessionId: () => undefined,
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
      // These configurations name a complete route, so the auxiliary-chain default never applies.
      pluginTaskSelectionIsOpen, pluginTaskRouteAttempts,
      getEffectiveAuxiliaryModelRefs: () => [], getEffectiveAuxiliaryModelChainSnapshot: () => '',
      auxiliaryChainSessionCandidates: () => [],
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

// unit: exercise the production defaults reader and creator together. Hidden
// legacy values must neither supply creation fields nor invalidate an await.
const loadTaskDefaults = createGhostProductionCallbacks<{
  getPluginTaskDefaults(id: string): Record<string, unknown>;
}>({ functions: ['getPluginTaskDefaults'] });
it.each([undefined, 'auto'] as const)('creates independently of hidden defaults with permission %s', async permissionMode => {
  const start = source.indexOf('      createSession: async');
  const property = source.slice(start, source.indexOf('      readSession:', start)).trim().replace(/,$/, '');
  const epoch = {};
  const stored = { model: 'old', permissionMode: 'bypassPermissions', workingDir: '/old' };
  const read = vi.fn(() => stored);
  const defaults = loadTaskDefaults({ readPluginTaskConfig: read,
    findGhostForInstanceId: () => ({ manifest: { showTaskPreferences: false } }) });
  const route: PluginTaskRoute = { agentKind: 'codex', providerId: 'mine', model: 'current', effort: 'high', fastMode: false };
  let approved = true;
  const create = vi.fn(async ({ shouldContinue }: { shouldContinue(): boolean }) => {
    stored.model = 'changed'; stored.permissionMode = 'ask'; stored.workingDir = '/changed';
    expect(shouldContinue()).toBe(true);
    approved = false;
    expect(shouldContinue()).toBe(false);
  });
  const directory = vi.fn();
  const run = compile(`return ({${property}}).createSession;`, {
    ...defaults, PluginTaskError, snapshot: epoch, assertPlugin: vi.fn(),
    resolveRoute: async () => route, resolvePluginWorkerDirectory: directory,
    createPluginTaskSession: create, clampPluginTaskPermissionMode,
    getCurrentDbClientSnapshot: () => epoch, isPluginTaskAuthorized: () => approved,
    notifyGhostSessionEvent: vi.fn(), broadcastSessionCreated: vi.fn(),
  });
  await run('plugin', 'task', 'title', route, false, undefined, undefined, undefined, false, undefined, permissionMode);
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ ...route, permissionMode: permissionMode ?? 'ask' }));
  expect(create.mock.calls[0]![0]).not.toHaveProperty('workingDir');
  expect(directory).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
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
    getPluginTaskDefaults: () => ({ model: 'different-default', permissionMode: 'plan' }),
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
