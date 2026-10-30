import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { pluginTaskRouteAttempts, pluginTaskSelectionIsOpen } from '../pluginTaskDefaultRoute.js';
import { createSessionExecutionResolver } from '../sessionExecutionSelection.js';
import { Session } from '@cindy/maker-core';
import { fastModeToStorage } from '@cindy/maker-shared';
import { handlePluginTaskRequest } from '../../cindy-brain/taskSlot.js';
import { withParsedPluginMessageAttachments } from '../../cindy-media/pluginMessageAttachments.js';
import { PLUGIN_ATTACHMENT_MAX_BYTES } from '../../../shared/pluginAttachments.js';
import type { InstalledGhost } from '../../../shared/ghost.js';
import {
  createPluginTaskService,
  isPluginTaskPermissionAllowed,
  isTeamPlanLabelLocked,
  isTeamPlanLabelLockedByReceipt,
  PluginTaskError,
  assertPluginTaskResult,
  readPluginTaskPlanReceipt,
  type PluginTaskReceipt,
  type PluginTaskStore,
  type PluginTaskServiceDeps,
} from '../pluginTaskService.js';
import type { PluginTeamPlan, PluginTaskView } from '../../../shared/pluginTasks.js';
import { controlOwnedSessionExecution, isSameSessionExecution, withdrawOwnedSessionInputs } from '../sessionExecutionOwnership.js';
import { PLUGIN_TEAM_PLAN_MAX_JSON_CHARS, PLUGIN_TASK_RECEIPT_MAX_JSON_CHARS } from '../../../shared/pluginTasks.js';

it('locks only unsettled team-plan labels for worker rename', () => {
  const route = {} as never;
  const plan = {
    concurrency: 2,
    items: [
      { label: 'w0', workingDir: '/answer', route },
      { label: 'w1', workingDir: '/answer', route },
    ],
  } as unknown as PluginTeamPlan;
  expect(isTeamPlanLabelLocked(plan, [], ['w0'])).toBe(true);
  expect(isTeamPlanLabelLocked(plan, [], ['w1', null])).toBe(true);
  expect(isTeamPlanLabelLocked(plan, ['w0'], ['w0'])).toBe(false);
  expect(isTeamPlanLabelLocked(plan, ['w0'], ['w1'])).toBe(true);
  expect(isTeamPlanLabelLocked(plan, [], ['other'])).toBe(false);
  expect(isTeamPlanLabelLocked(undefined, [], ['w0'])).toBe(false);
});

it('releases the plan label lock only after the plugin is uninstalled', () => {
  const route = {} as never;
  const plan = {
    concurrency: 1,
    items: [{ label: 'w0', workingDir: '/answer', route }],
  } as unknown as PluginTeamPlan;
  const receipt = { payload: JSON.stringify({ teamPlan: plan }), operation: 'create' as const };
  expect(isTeamPlanLabelLockedByReceipt(receipt, true, ['w0'])).toBe(true);
  // 插件卸载（任务归属确实撤销）后，保留的收据不再锁定改名；
  // 停用 / 未批准仍传入 true（可恢复），继续锁定由上层保证。
  expect(isTeamPlanLabelLockedByReceipt(receipt, false, ['w0'])).toBe(false);
  expect(isTeamPlanLabelLockedByReceipt({ payload: receipt.payload, operation: 'send' }, true, ['w0'])).toBe(false);
  expect(isTeamPlanLabelLockedByReceipt(undefined, true, ['w0'])).toBe(false);
});

it('rejects oversized plans before saving and refuses oversized legacy receipts without truncation', async () => {
  const f=fixture(), task=await f.create();
  const before=structuredClone(f.rows.get(task.taskId)!);
  const plan={concurrency:2,items:Array.from({length:200},(_,i)=>({label:'w'+i,workingDir:'/answer',route:f.route,task:'x'.repeat(8000)}))};
  await expect(f.service.setTeamPlan('p',task.taskId,plan)).rejects.toMatchObject({code:'INVALID_REQUEST'});
  expect(f.rows.get(task.taskId)).toEqual(before);
  for (const payload of [' '.repeat(PLUGIN_TASK_RECEIPT_MAX_JSON_CHARS+1), JSON.stringify({teamPlan:{task:'x'.repeat(PLUGIN_TEAM_PLAN_MAX_JSON_CHARS)}})])
    expect(()=>readPluginTaskPlanReceipt(payload)).toThrow('size');
  f.rows.get(task.taskId)!.payload=JSON.stringify({teamPlan:plan});
  await expect(f.service.settleWorkerLabel('p',task.taskId,'w0')).rejects.toMatchObject({code:'INVALID_REQUEST'});
});

it.each([false,true])('production Auto context checks uninstall after its projection await (worker=%s)', async worker => {
  for (const revoked of [false,true]) {
    const f=fixture(),task=await f.create();
    const session={...f.route,source:'plugin',workingDir:'/answer',permissionMode:'auto',status:'active'};
    const results=[[session],worker?[{leadId:task.taskId,label:'w',teamId:'team',teamStatus:'active'}]:[],[session]];
    const query={from:()=>query,where:()=>query,innerJoin:()=>query,limit:async()=>results.shift()};
    const epoch={client:{drizzle:{select:()=>query},queryOne:async()=>({unchanged:1}),tx:async()=>{if(revoked)await f.service.withUninstall('p',async()=>{});return {};}}};
    let load!:(id:string)=>Promise<unknown>;
    const deps={setAutoReviewContextResolver:(callback:typeof load)=>{load=callback;},createPluginTaskReviewResolver:(callback:typeof load)=>callback,
      getCurrentDbClientSnapshot:()=>epoch,sessions:{},orcaWorkers:{},orcaTeams:{},eq:()=>true,fastModeToStorage,
      createPluginTaskStore:()=>f.deps.store,drainPersistQueue:async()=>{},loadPluginTargetReview:async()=>null,
      pluginTaskServiceForCurrentOwner:()=>f.service,getPluginTaskDefaults:()=>({permissionMode:'auto'}),
      readPluginTaskPlanReceipt,isPluginTaskPermissionAllowed,pluginTaskAuthorizationRevision:()=> 'new-install',isPluginTaskAuthorized:()=>true};
    const source=readFileSync(new URL('../register.ts',import.meta.url),'utf8');
    const start=source.indexOf('  setAutoReviewContextResolver(createPluginTaskReviewResolver(async sessionId => {');
    const block=source.slice(start,source.indexOf('\n  }));',start)+7);
    const js=ts.transpileModule(block,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
    new Function(...Object.keys(deps),js)(...Object.values(deps));
    if(revoked)await expect(load(worker?'worker':task.taskId)).rejects.toMatchObject({code:'TASK_NOT_FOUND'});
    else await expect(load(worker?'worker':task.taskId)).resolves.toMatchObject({authorized:true,pluginId:'p'});
  }
});

function fixture() {
  let seq = 0;
  let current = true;
  const rows = new Map<string, PluginTaskReceipt>();
  const tasks = new Map<string, PluginTaskView>();
  const copy = <T>(v: T): T => structuredClone(v);
  const store: PluginTaskStore = {
    relocatePlugin: async (from, to) => {
      if (from === to) return;
      for (const row of rows.values()) if (row.pluginId === from) {
        row.pluginId = to;
        row.revision++;
      }
    },
    revokePlugin: async pluginId => {
      for (const row of rows.values()) if (row.pluginId === pluginId && row.operation === 'create') {
        row.payload = JSON.stringify({...JSON.parse(row.payload),ownershipRevoked:true});
        row.revision++;
      }
    },
    get: async (id) => copy(rows.get(id)),
    find: async (p, op, t, k) =>
      copy(
        [...rows.values()].find(
          (r) => r.pluginId === p && r.operation === op && r.targetId === t && r.requestKey === k,
        ),
      ),
    list: async (p, op, t, after, limit) =>
      copy(
        [...rows.values()]
          .filter(
            (r) =>
              r.pluginId === p &&
              r.operation === op &&
              (t === null || r.targetId === t) &&
              r.id > after,
          )
          .slice(0, limit),
      ),
    forSession: async (t) =>
      copy([...rows.values()].filter((r) => r.operation === 'send' && r.targetId === t)),
    insert: async (r) => {
      expect(rows.has(r.id)).toBe(false);
      rows.set(r.id, copy(r));
    },
    discardUncreated: vi.fn(async r => {
      const current = rows.get(r.id);
      if (current && current.pluginId === r.pluginId && current.operation === 'create'
        && current.revision === r.revision && !tasks.has(r.id)) rows.delete(r.id);
    }),
    save: async (r) => {
      expect(rows.get(r.id)?.revision).toBe(r.revision);
      rows.set(r.id, copy({ ...r, revision: r.revision + 1 }));
    },
  };
  const route = {
    agentKind: 'codex' as const,
    providerId: 'mine',
    model: 'model',
    effort: 'high',
    fastMode: false,
  };
  const execution = { instanceId: 'native', generation: 1 };
  const live = { instanceId: execution.instanceId, stablePlanModeState: { enabled: false, generation: 0 } };
  const deps: PluginTaskServiceDeps = {
    store,
    readPermissionMode: () => 'auto',
    readModelPreference: () => route,
    assertAuthorized: () => {
      if (!current) throw new Error('Owner changed');
    },
    assertCurrent: () => {
      if (!current) throw new Error('Owner changed');
    },
    id: () => `id-${++seq}`,
    now: () => 1,
    resolveRoute: vi.fn(async (_, r) => r ?? route),
    createSession: vi.fn(async (_, taskId, title, resolvedConfig, _isolated, _requested, onPersistenceStarted) => {
      onPersistenceStarted();
      tasks.set(taskId, { taskId, title, resolvedConfig, revision: 1, status: 'active', permissionMode: 'plan' });
    }),
    readSession: async (id) => copy(tasks.get(id) ?? null),
    readLiveSession: () => live,
    dispatch: vi.fn(async () => ({ ok: true })),
    inspect: vi.fn(async () => ({ execution: null, pending: [] })),
    cancel: vi.fn(async () => 'cancelled' as const),
  };
  const service = createPluginTaskService(deps);
  const create = () => service.create('p', { requestKey: 'create', title: 'Test' });
  const send = async () => {
    const task = await create();
    return service.send('p', {
      taskId: task.taskId,
      requestKey: 'send',
      expectedRevision: task.revision,
      text: 'hello',
    });
  };
  return {
    service,
    deps,
    rows,
    tasks,
    route,
    execution,
    create,
    send,
    switchOwner: () => {
      current = false;
    },
  };
}

// Exercise the production Main creator with an in-memory persistence boundary;
// service-only mocks cannot catch a permission choice being dropped by register.
const permissionCreatorSource = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');
const permissionCreatorStart = permissionCreatorSource.indexOf('      createSession: async (pluginId, taskId, title, route,');
const permissionCreatorCode = ts.transpileModule('return (' + permissionCreatorSource.slice(
  permissionCreatorStart + '      createSession: '.length,
  permissionCreatorSource.indexOf('\n      },', permissionCreatorStart) + 8,
) + ');', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function useProductionPermissionCreator(f: ReturnType<typeof fixture>, configured: { permissionMode: string }, useDefaults = true) {
  const snapshot = {};
  const persist = vi.fn(async (options: { sessionId: string; title: string; permissionMode: string;
    onPersistenceStarted(): void; shouldContinue(): boolean }) => {
    if (!options.shouldContinue()) throw new PluginTaskError('PERMISSION_DENIED', 'Configuration changed');
    options.onPersistenceStarted();
    f.tasks.set(options.sessionId, { taskId: options.sessionId, title: options.title, status: 'active',
      resolvedConfig: f.route, revision: 1, permissionMode: options.permissionMode });
  });
  const deps = { assertPlugin: () => {}, getPluginTaskDefaults: () => useDefaults ? ({ ...configured }) : undefined,
    resolveRoute: (...args: Parameters<typeof f.deps.resolveRoute>) => f.deps.resolveRoute(...args),
    PluginTaskError, isPluginTaskPermissionAllowed, createPluginTaskSession: persist,
    clampPluginTaskPermissionMode: (mode: unknown) => mode ?? 'ask', snapshot,
    getCurrentDbClientSnapshot: () => snapshot, isPluginTaskAuthorized: () => true,
  };
  f.deps.readPermissionMode = () => useDefaults ? configured.permissionMode : undefined;
  f.deps.createSession = new Function(...Object.keys(deps), permissionCreatorCode)(...Object.values(deps));
  return persist;
}

// unit: new per-create permissions must reach ordinary Session persistence while
// remaining within the user policy. Previous cases only exercised the default.
it('persists the chosen creation permission without changing defaults or duplicate requests', async () => {
  const f = fixture(), configured = { permissionMode: 'bypassPermissions' };
  const persist = useProductionPermissionCreator(f, configured);
  for (const permissionMode of ['ask', 'auto', 'bypassPermissions'] as const) {
    const request = { requestKey: permissionMode, title: 'Work', permissionMode };
    const task = await f.service.create('p', request);
    expect(task.permissionMode).toBe(permissionMode);
    expect(await f.service.create('p', request)).toEqual(task);
    await expect(f.service.create('p', { ...request, permissionMode: permissionMode === 'ask' ? 'auto' : 'ask' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  }
  expect((await f.create()).permissionMode).toBe('bypassPermissions');
  expect(await f.create()).toMatchObject({ permissionMode: 'bypassPermissions' });
  expect(persist).toHaveBeenCalledTimes(4);
  expect(configured).toEqual({ permissionMode: 'bypassPermissions' });
});

// unit: a hidden card cannot cap explicit creation, sending or queued acceptance.
// Enabled-card cases below retain their original ceiling and revocation behavior.
it.each(['auto', 'bypassPermissions'] as const)('uses the hidden plugin configuration through %s creation and queued acceptance', async permissionMode => {
  const f = fixture(), configured = { permissionMode: 'ask' };
  useProductionPermissionCreator(f, configured, false);
  const task = await f.service.create('p', { requestKey: 'independent', title: 'Work', permissionMode });
  configured.permissionMode = 'plan';
  const run = await f.service.send('p', { taskId: task.taskId, expectedRevision: task.revision, requestKey: 'input', text: 'Continue' });
  await f.service.accept(task.taskId, { clientId: run.inputMessageId }, f.execution);
  f.deps.inspect = async () => ({ execution: f.execution, pending: [] });
  expect((await f.service.getRun('p', run.runId)).status).toBe('running');
  expect((await f.service.get('p', task.taskId)).permissionMode).toBe(permissionMode);
  expect(configured.permissionMode).toBe('plan');
});

// unit: full access must work through ordinary send/accept, but a revoked user
// ceiling must block the queued input before execution. No full-access path existed before.
it('delivers an authorized full-access task and rechecks the ceiling before acceptance', async () => {
  const f = fixture(), configured = { permissionMode: 'bypassPermissions' };
  useProductionPermissionCreator(f, configured);
  const task = await f.service.create('p', { requestKey: 'full', title: 'Work', permissionMode: 'bypassPermissions' });
  const run = await f.service.send('p', { taskId: task.taskId, expectedRevision: task.revision,
    requestKey: 'send', text: 'Continue' });
  expect(f.deps.dispatch).toHaveBeenCalledOnce();
  configured.permissionMode = 'auto';
  await expect(f.service.accept(task.taskId, { clientId: run.inputMessageId }, f.execution))
    .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  await expect(f.service.create('p', { requestKey: 'denied', title: 'Work', permissionMode: 'bypassPermissions' }))
    .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
});

it('rejects an unauthorized creation permission before reserving a task', async () => {
  const f = fixture(), configured = { permissionMode: 'ask' };
  const persist = useProductionPermissionCreator(f, configured);
  const request = { requestKey: 'new', title: 'Work', permissionMode: 'auto' as const };
  await expect(f.service.create('p', request)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  expect(persist).not.toHaveBeenCalled();
  expect(f.rows.size).toBe(0);
  configured.permissionMode = 'auto';
  expect((await f.service.create('p', request)).permissionMode).toBe('auto');
});

it.each(['route', 'persistence'] as const)('rechecks creation permission after %s preparation', async phase => {
  const f = fixture(), configured = { permissionMode: 'auto' };
  const persist = useProductionPermissionCreator(f, configured);
  if (phase === 'route') f.deps.resolveRoute = async () => { configured.permissionMode = 'ask'; return f.route; };
  else persist.mockImplementationOnce(async options => {
    configured.permissionMode = 'ask';
    options.onPersistenceStarted();
  });
  await expect(f.service.create('p', { requestKey: 'new', title: 'Work', permissionMode: 'auto' }))
    .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  expect(f.tasks.size).toBe(0);
  expect(f.rows.size).toBe(0);
});

// 通用统计：保护真实 send 接受边界，不将空任务、拒绝或同键重放计为新调用。
// unit: new-title intent lives in the existing create receipt; context must reach
// dispatch and participate in deduplication rather than becoming visible prose.
it('persists automatic naming intent and dispatches separate context without duplicating title requests', async () => {
  const f = fixture();
  const schedule = vi.fn();
  f.deps.scheduleAutoTitle = schedule;
  const task = await f.service.create('p', { requestKey: 'new', autoTitle: true });
  expect(JSON.parse(f.rows.get(task.taskId)!.payload)).toMatchObject({ autoTitle: true });
  const request = { taskId: task.taskId, expectedRevision: task.revision, requestKey: 'send', text: 'Look here', context: 'Window contents' };
  await f.service.send('p', request);
  await f.service.send('p', request);
  expect(f.deps.dispatch).toHaveBeenCalledOnce();
  expect(vi.mocked(f.deps.dispatch).mock.calls[0]?.[5]).toBe('Window contents');
  expect(schedule).toHaveBeenCalledOnce();
  await expect(f.service.send('p', { ...request, context: 'Another window' }))
    .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});

// unit: a failed naming-metadata read must not leave an unsent receipt that
// suppresses the retry. Inject the store failure after host bookkeeping starts.
it('retries after a failed naming-metadata read without leaving an unsent receipt', async () => {
  const f = fixture(), task = await f.create();
  const get = f.deps.store.get;
  let failRead = false;
  f.deps.prepareInvocation = () => { failRead = true; return 'invocation'; };
  f.deps.store.get = async id => {
    if (failRead) { failRead = false; throw new Error('Store read failed'); }
    return get(id);
  };
  const request = { taskId: task.taskId, expectedRevision: task.revision, requestKey: 'send', text: 'Look here' };
  await expect(f.service.send('p', request)).rejects.toThrow('Store read failed');
  expect([...f.rows.values()].filter(row => row.operation === 'send')).toHaveLength(0);
  f.deps.prepareInvocation = () => 'invocation';
  await f.service.send('p', request);
  expect(f.deps.dispatch).toHaveBeenCalledOnce();
});

// unit；现有任务测试检查任务状态，未检查宿主统计观察者收到哪些事实。
it('records one accepted input after create and does not count receipt replay or rejected dispatch', async () => {
  const f = fixture();
  const accepted: string[] = [];
  f.deps.prepareInvocation = (_pluginId, id) => id;
  f.deps.acceptInvocation = (_pluginId, id) => { accepted.push(id); };
  const task = await f.create();
  expect(accepted).toEqual([]);
  const request = { taskId: task.taskId, requestKey: 'first-input', expectedRevision: task.revision, text: 'hello' };
  const run = await f.service.send('p', request);
  await f.service.send('p', request);
  expect(accepted).toEqual([run.runId]);
  vi.mocked(f.deps.dispatch).mockResolvedValueOnce({ ok: false });
  await f.service.send('p', { ...request, requestKey: 'rejected-input' });
  expect(accepted).toEqual([run.runId]);
});

// Targets create in a selected project through the same service, not directly through
// session persistence. Without its create receipt, helper tools and uninstall lose ownership.
// Minimal regression: a Host-supplied task ID + project, then get and uninstall (unit).
it('retains task ownership and uninstall revocation for Host-selected project creation', async () => {
  const f = fixture();
  const context = { taskId: 'target-project-task', workingDir: '/selected-project', assertCurrent: vi.fn() };
  const task = await f.service.create('p', { requestKey: 'target-create', title: 'Selected project' }, context);
  expect(task.taskId).toBe(context.taskId);
  expect(await f.service.get('p', context.taskId)).toMatchObject({ taskId: context.taskId });
  expect(f.rows.get(context.taskId)).toMatchObject({ operation: 'create', pluginId: 'p' });
  expect(vi.mocked(f.deps.createSession).mock.calls[0]?.[9]).toBe(context);
  await f.service.withUninstall('p', async () => {});
  await expect(f.service.get('p', context.taskId)).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
});
it('rechecks Host target context after route resolution before persisting a task', async () => {
  const f = fixture();
  let current = true;
  vi.mocked(f.deps.resolveRoute).mockImplementationOnce(async () => { current = false; return f.route; });
  await expect(f.service.create('p', { requestKey: 'target-create', title: 'Selected project' }, {
    taskId: 'target-project-task', workingDir: '/selected-project',
    assertCurrent: () => { if (!current) throw new PluginTaskError('PERMISSION_DENIED', 'Target changed'); },
  })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  expect(f.tasks.size).toBe(0);
  expect(f.rows.size).toBe(0);
});

it('includes message images in owned-task replay identity without persisting screenshot bytes', async () => {
  const f = fixture(), task = await f.create();
  const base64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
  const request = { taskId: task.taskId, requestKey: 'image', expectedRevision: task.revision,
    text: 'context', attachments: [{ base64, name: 'window.png' }] };
  await f.service.send('p', request);
  await f.service.send('p', structuredClone(request));
  expect(f.deps.dispatch).toHaveBeenCalledOnce();
  expect(vi.mocked(f.deps.dispatch).mock.calls[0]?.[4]?.[0]).toMatchObject({ mimeType: 'image/png' });
  expect(JSON.stringify([...f.rows.values()])).not.toContain(base64);
  await expect(f.service.send('p', { ...request, attachments: [{ base64, name: 'other.png' }] }))
    .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});

// Exercise the public pipe with the real service, including its error sanitization.
it.each(['INVALID_ATTACHMENTS', 'TASK_BUSY'] as const)('preserves %s across the public task boundary', async code => {
  const f = fixture(), task = await f.create();
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const pending: Promise<unknown>[] = [];
  try {
    if (code === 'TASK_BUSY') {
      const large = Buffer.alloc(PLUGIN_ATTACHMENT_MAX_BYTES);
      png.copy(large);
      const attachments = [{ base64: large.toString('base64') }];
      pending.push(withParsedPluginMessageAttachments(attachments, () => held));
      pending.push(withParsedPluginMessageAttachments(attachments, () => held));
    }
    const ghost = { enabled: true, taskCapabilityApproved: true, approval: { state: 'approved' },
      manifest: { agent: { tasks: true } } } as InstalledGhost;
    const result = await handlePluginTaskRequest('p', {
      type: 'tasks-request', kind: 'send', taskId: task.taskId, requestKey: 'attachment-error',
      expectedRevision: task.revision, text: 'context',
      attachments: [{ base64: (code === 'TASK_BUSY' ? png : Buffer.from('not an image')).toString('base64') }],
    }, {
      getGhost: () => ghost, isCurrent: () => true,
      handler: (pluginId, request) => {
        if (request.kind !== 'send') throw new Error('Unexpected operation');
        return f.service.send(pluginId, request);
      },
    });
    expect(result).toMatchObject({ ok: false, error: { code, retryable: code === 'TASK_BUSY' } });
    expect(f.deps.dispatch).not.toHaveBeenCalled();
    expect([...f.rows.values()].some(row => row.operation === 'send')).toBe(false);
  } finally {
    release();
    await Promise.all(pending);
  }
});

describe('plugin dispatch uses live Plan execution authority', () => {
  it.each(['send', 'accept'] as const)('%s rejects consumed Pi intent while execution is active, unknown or switching', async entry => {
    const f = fixture(), task = await f.create();
    Object.assign(f.tasks.get(task.taskId)!, { permissionMode: 'auto', planModeEnabled: false });
    let executionPlan: boolean | null = false;
    let releaseEvents!: () => void, releaseSwitch!: () => void;
    const eventsClosed = new Promise<void>(resolve => { releaseEvents = resolve; });
    const switching = new Promise<void>(resolve => { releaseSwitch = resolve; });
    const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
    const session = new Session({ id: task.taskId, sessionInstanceId: f.execution.instanceId,
      agentKind: 'pi', workDir: '/answer', permissionMode: 'auto', logger,
      capabilities: { planMode: { supported: true } } as never,
      handle: { id: 'pi', agentKind: 'pi', model: 'test',
        async *events() { await eventsClosed; }, async close() { releaseEvents(); }, setInteractionResolver() {},
        getPlanMode: () => false, getExecutionPlanMode: () => executionPlan,
        setPlanMode: async () => { await switching; },
      } as never,
    });
    f.deps.readLiveSession = () => session;
    const request = { taskId: task.taskId, expectedRevision: task.revision, requestKey: 'live-plan', text: 'continue' };
    const queued = entry === 'accept' ? await f.service.send('p', request) : undefined;
    vi.mocked(f.deps.dispatch).mockClear();
    const invoke = () => entry === 'send' ? f.service.send('p', request)
      : f.service.accept(task.taskId, { clientId: queued!.inputMessageId }, f.execution);
    try {
      for (const value of [true, null]) {
        executionPlan = value;
        expect(session.getPlanMode()).toBe(false);
        await expect(invoke()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      }
      executionPlan = false;
      const pending = session.setPlanMode(true);
      expect(session.stablePlanModeState).toBeNull();
      await expect(invoke()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(f.deps.dispatch).not.toHaveBeenCalled();
      releaseSwitch();
      await pending;
      // Native/Host recovery to a stable non-plan state restores the same API.
      if (entry === 'send') await expect(invoke()).resolves.toMatchObject({ status: 'queued' });
      else await expect(invoke()).resolves.toBeUndefined();
    } finally {
      releaseSwitch();
      await session.close();
    }
  });

  it.each(['send', 'accept'] as const)('%s rechecks the same live session after async route and receipt work', async entry => {
    for (const point of ['route', 'receipt', 'instance', 'generation']) {
      const f = fixture(), task = await f.create();
      Object.assign(f.tasks.get(task.taskId)!, { permissionMode: 'auto', planModeEnabled: false });
      let live = { instanceId: f.execution.instanceId, stablePlanModeState: { enabled: false, generation: 0 } };
      f.deps.readLiveSession = () => live;
      const request = { taskId: task.taskId, expectedRevision: task.revision, requestKey: 'async-plan', text: 'continue' };
      const queued = entry === 'accept' ? await f.service.send('p', request) : undefined;
      vi.mocked(f.deps.dispatch).mockClear();
      const change = () => {
        if (point === 'instance') live = { ...live };
        else if (point === 'generation') live.stablePlanModeState.generation++;
        else live.stablePlanModeState.enabled = true;
      };
      if (point === 'receipt') {
        const method = entry === 'send' ? 'insert' : 'save';
        const original = f.deps.store[method];
        f.deps.store[method] = async row => { await original(row); change(); };
      } else f.deps.resolveRoute = async () => { change(); return f.route; };
      const result = entry === 'send' ? f.service.send('p', request)
        : f.service.accept(task.taskId, { clientId: queued!.inputMessageId }, f.execution);
      if (entry === 'send' && point === 'receipt') await expect(result).resolves.toMatchObject({ status: 'failed' });
      else await expect(result).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(f.deps.dispatch).not.toHaveBeenCalled();
    }
  });

  it('allows cold tasks to queue but requires the accepting live instance', async () => {
    const f = fixture();
    f.deps.readLiveSession = () => undefined;
    const run = await f.send();
    await expect(f.service.accept(run.taskId, { clientId: run.inputMessageId }, f.execution))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    f.deps.readLiveSession = () => ({ instanceId: 'replacement', stablePlanModeState: { enabled: false, generation: 0 } });
    await expect(f.service.accept(run.taskId, { clientId: run.inputMessageId }, f.execution))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const live = { instanceId: f.execution.instanceId, stablePlanModeState: { enabled: false, generation: 0 } };
    f.deps.readLiveSession = () => live;
    await expect(f.service.accept(run.taskId, { clientId: run.inputMessageId }, f.execution)).resolves.toBeUndefined();
  });
});

it('serializes source archival behind creation and keeps old tasks inaccessible to the replacement', async () => {
  const fixtureState = fixture();
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  fixtureState.deps.resolveRoute = async () => { started(); await gate; return fixtureState.route; };
  const move = vi.spyOn(fixtureState.deps.store, 'relocatePlugin');
  const creating = fixtureState.create();
  await entered;
  const archiving = fixtureState.service.relocatePlugin('p', 'archive');
  expect(move).not.toHaveBeenCalled();
  finish();
  const task = await creating;
  await archiving;
  expect(move).toHaveBeenCalledWith('p', 'archive');
  expect((await fixtureState.service.list('p')).items).toEqual([]);
  await expect(fixtureState.service.get('p', task.taskId)).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
  expect(fixtureState.tasks.has(task.taskId)).toBe(true);
  const replacement = await fixtureState.create();
  expect(replacement.taskId).not.toBe(task.taskId);
});

it.each(['completed','failed','cancelled','interrupted'] as const)('prefers a newly persisted %s terminal over stale inspection for getRun and listRuns', async status => {
  for (const kind of ['getRun','listRuns'] as const) {
    const f=fixture(),run=await f.send();
    await f.service.accept(run.taskId,{clientId:run.inputMessageId},f.execution);
    f.deps.inspect=async()=>{
      await f.service.settle(run.taskId,f.execution,status,'output');
      return {execution:null,pending:[]};
    };
    const result=kind==='getRun'?await f.service.getRun('p',run.runId):(await f.service.listRuns('p',run.taskId)).items[0];
    expect(result).toMatchObject({status,outputMessageId:'output'});
    expect(result).not.toHaveProperty('error');
  }
});

it.each(['restore','restart'] as const)('the production cancel adapter rechecks revoked ownership after %s waits', async point => {
  const f=fixture(),run=await f.send();
  let release!:()=>void,entered!:()=>void,restores=0;
  const barrier=new Promise<void>(resolve=>{release=resolve;});
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const pause=async()=>{entered();await barrier;};
  const remove=vi.fn(),stop=vi.fn(async()=>({ok:true,status:'stopping'}));
  const snapshot={};
  const deps={assertPlugin:()=>{},assertCurrent:()=>{},snapshot,
    getCurrentDbClientSnapshot:()=>snapshot,isPluginTaskAuthorized:()=>true,
    pluginTaskServiceForCurrentOwner:()=>f.service,PluginTaskError,
    inputCoordinator:{ensureQueueRestored:async()=>{if(++restores===2&&point==='restore')await pause();},
      isQueueRestored:()=>true,getQueueControlSnapshot:()=>({pendingQueue:[{clientId:run.inputMessageId}]}),remove},
    withdrawOwnedSessionInputs,controlOwnedSessionExecution,isSameSessionExecution,
    awaitAgentInputQueueSnapshotPersistence:async()=>{},
    withSessionRestartLock:async(_id:string,operation:()=>Promise<void>)=>{if(point==='restart')await pause();await operation();},
    readExecution:()=>f.execution,resetAutomaticRecoveryForExplicitStop:vi.fn(),contextOverflowRolloverHolder:null,
    sessionControlService:{stopSessionTurn:stop}};
  const source=readFileSync(new URL('../register.ts',import.meta.url),'utf8');
  const start=source.indexOf('      cancel: async (pluginId, taskId, inputClientIds, execution) => {');
  const block=source.slice(start+'      cancel: '.length,source.indexOf('\n      },',start)+8);
  const js=ts.transpileModule('return ('+block+');',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const cancel=new Function(...Object.keys(deps),js)(...Object.values(deps));
  const operation=cancel('p',run.taskId,[run.inputMessageId],f.execution);
  const result=expect(operation).rejects.toMatchObject({code:'TASK_NOT_FOUND'});
  await started;await f.service.withUninstall('p',async()=>{});release();await result;
  if(point==='restore')expect(remove).not.toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();
});

describe('plugin ordinary task receipts', () => {
  it.each(['same service', 'restart', 'concurrent'] as const)('retries a conclusively uncreated task with the original key after %s', async mode => {
    const f = fixture();
    const create = vi.mocked(f.deps.createSession);
    create.mockRejectedValueOnce(new Error('Directory unavailable'));
    await expect(f.create()).rejects.toThrow('Directory unavailable');
    const service = mode === 'restart' ? createPluginTaskService(f.deps) : f.service;
    const request = { requestKey: 'create', title: 'Test' };
    const calls = mode === 'concurrent' ? 2 : 1;
    const tasks = await Promise.all(Array.from({ length: calls }, () => service.create('p', request)));
    expect(new Set(tasks.map(task => task.taskId)).size).toBe(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(f.tasks.size).toBe(1);
    expect(f.rows.size).toBe(1);
    await expect(service.create('p', { ...request, title: 'Changed' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it.each(['insert error', 'persisted', 'deleted after insert'] as const)('retains the request key after persistence started: %s', async phase => {
    const f = fixture();
    const create = f.deps.createSession;
    f.deps.createSession = vi.fn(async (...args: Parameters<PluginTaskServiceDeps['createSession']>) => {
      args[6]();
      if (phase !== 'insert error') await create(...args);
      if (phase === 'deleted after insert') f.tasks.delete(args[1]);
      throw new Error('Creation response failed');
    });
    await expect(f.create()).rejects.toThrow('Creation response failed');
    expect(f.rows.size).toBe(1);
    expect(f.deps.store.discardUncreated).not.toHaveBeenCalled();
    if (phase === 'persisted') await expect(f.create()).resolves.toMatchObject({ taskId: 'id-1' });
    else await expect(f.create()).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    expect(f.deps.createSession).toHaveBeenCalledOnce();
  });
  it('retains the receipt when rollback fails and does not silently retry creation', async () => {
    const f = fixture();
    vi.mocked(f.deps.createSession).mockRejectedValueOnce(new Error('Directory unavailable'));
    vi.mocked(f.deps.store.discardUncreated).mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(f.create()).rejects.toThrow('Storage unavailable');
    await expect(f.create()).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    expect(f.rows.size).toBe(1);
    expect(f.deps.createSession).toHaveBeenCalledOnce();
  });
  it('rolls back an unstarted creation through its captured store after an account switch', async () => {
    const f = fixture();
    const insert = f.deps.store.insert;
    f.deps.store.insert = async row => { await insert(row); f.switchOwner(); };
    await expect(f.create()).rejects.toThrow('Owner changed');
    expect(f.rows.size).toBe(0);
    expect(f.deps.createSession).not.toHaveBeenCalled();
  });
  it('never releases an already revoked creation key on a preparation failure', async () => {
    const f = fixture();
    vi.mocked(f.deps.createSession).mockImplementationOnce(async () => {
      await f.deps.store.revokePlugin('p');
      throw new Error('Plugin unavailable');
    });
    await expect(f.create()).rejects.toThrow('Plugin unavailable');
    expect(f.rows.size).toBe(1);
    await expect(createPluginTaskService(f.deps).create('p', { requestKey: 'create', title: 'Test' }))
      .rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    expect(f.deps.createSession).toHaveBeenCalledOnce();
  });
  it('does not recreate a deleted task or an old ambiguous orphan receipt', async () => {
    const f = fixture();
    const task = await f.create();
    f.tasks.delete(task.taskId);
    await expect(createPluginTaskService(f.deps).create('p', { requestKey: 'create', title: 'Test' }))
      .rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    expect(f.deps.store.discardUncreated).not.toHaveBeenCalled();
    expect(f.deps.createSession).toHaveBeenCalledOnce();
  });
  it('retains user tasks and receipts but denies every old task capability after reinstall and restart', async () => {
    const f = fixture(); const task = await f.create(); const run = await f.send();
    const before = structuredClone([...f.tasks]);
    const remove = vi.fn(async () => {});
    await f.service.withUninstall('p',remove);
    expect(remove).toHaveBeenCalledOnce();
    expect([...f.tasks]).toEqual(before);
    expect(f.rows.has(task.taskId)).toBe(true);
    expect(f.rows.has(run.runId)).toBe(true);
    // The new installation remains authorized under the same plugin ID.
    const restarted = createPluginTaskService(f.deps);
    for (const service of [f.service,restarted]) {
      expect((await service.list('p')).items).toEqual([]);
      const denied = [
        () => service.get('p',task.taskId),
        () => service.create('p',{requestKey:'create',title:'Test'}),
        () => service.send('p',{taskId:task.taskId,requestKey:'new',expectedRevision:1,text:'hello'}),
        () => service.getRun('p',run.runId), () => service.listRuns('p',task.taskId),
        () => service.cancel('p',run.runId),
        () => service.accept(task.taskId,{clientId:run.inputMessageId},f.execution),
        () => service.assertDispatch('p',task.taskId),
      ];
      for (const operation of denied) await expect(operation()).rejects.toMatchObject({code:'TASK_NOT_FOUND'});
    }
    const fresh = await restarted.create('p',{requestKey:'new-install',title:'Test'});
    expect(fresh.taskId).not.toBe(task.taskId);
    expect(f.tasks.size).toBe(2);
    expect(f.deps.cancel).not.toHaveBeenCalled();
  });
  it('serializes uninstall after an admitted create and retains normal-update ownership', async () => {
    const f = fixture(); let release!:()=>void, entered!:()=>void;
    const barrier=new Promise<void>(resolve=>{release=resolve;});
    const started=new Promise<void>(resolve=>{entered=resolve;});
    f.deps.resolveRoute=async()=>{entered();await barrier;return f.route;};
    const create=f.create(); await started;
    let removed=false;
    const uninstall=f.service.withUninstall('p',async()=>{removed=true;});
    await Promise.resolve();expect(removed).toBe(false);
    release();const task=await create;await uninstall;
    await expect(f.service.get('p',task.taskId)).rejects.toMatchObject({code:'TASK_NOT_FOUND'});
    const other=fixture();const original=await other.create();
    expect(await createPluginTaskService(other.deps).create('p',{requestKey:'create',title:'Test'})).toEqual(original);
  });
  it.each(['getRun','listRuns'] as const)('rechecks ownership after delayed %s observation', async kind => {
    const f=fixture();const run=await f.send();let release!:()=>void,entered!:()=>void;
    const barrier=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{entered=resolve;});
    f.deps.inspect=async()=>{entered();await barrier;return {execution:null,pending:[]};};
    const operation=kind==='getRun'?f.service.getRun('p',run.runId):f.service.listRuns('p',run.taskId);
    const result=expect(operation).rejects.toMatchObject({code:'TASK_NOT_FOUND'});
    await started;await f.service.withUninstall('p',async()=>{});release();await result;
  });
  it('does not remove the package if durable revocation fails and keeps revocation on removal failure', async () => {
    const f=fixture();const task=await f.create();const remove=vi.fn(async()=>{});
    const revoke=f.deps.store.revokePlugin;
    f.deps.store.revokePlugin=async()=>{throw Error('storage unavailable');};
    await expect(f.service.withUninstall('p',remove)).rejects.toThrow('storage unavailable');
    expect(remove).not.toHaveBeenCalled();
    f.deps.store.revokePlugin=revoke;
    await expect(f.service.withUninstall('p',async()=>{throw Error('package removal failed');})).rejects.toThrow('package removal failed');
    await expect(f.service.get('p',task.taskId)).rejects.toMatchObject({code:'TASK_NOT_FOUND'});
  });
  it('binds isolated workspace intent to creation and idempotency', async () => {
    const f = fixture();
    const input = { requestKey: 'isolated', title: 'Test', isolatedWorkspace: true };
    const task = await f.service.create('p', input);
    expect(f.deps.createSession).toHaveBeenCalledWith('p', task.taskId, 'Test', f.route, true, undefined, expect.any(Function), undefined);
    await f.service.create('p', input);
    expect(f.deps.createSession).toHaveBeenCalledTimes(1);
    await expect(f.service.create('p', { ...input, isolatedWorkspace: false }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('binds the originating call to creation without re-resolving it on receipt replay', async () => {
    const f = fixture();
    const input = { requestKey: 'call-source', title: 'Test', callId: 'active-call' };
    const task = await f.service.create('p', input);
    expect(f.deps.resolveRoute).toHaveBeenCalledWith('p', undefined, 'active-call');
    expect(f.deps.createSession).toHaveBeenCalledWith('p', task.taskId, 'Test', f.route, undefined, undefined, expect.any(Function), 'active-call');
    vi.mocked(f.deps.resolveRoute).mockRejectedValue(new Error('call ended'));
    expect((await f.service.create('p', input)).taskId).toBe(task.taskId);
    await expect(f.service.create('p', { ...input, callId: 'other-call' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('creates once under concurrent retries and rejects conflicting keys', async () => {
    const f = fixture();
    const [a, b] = await Promise.all([f.create(), f.create()]);
    expect(a.taskId).toBe(b.taskId);
    expect(f.deps.createSession).toHaveBeenCalledTimes(1);
    await expect(
      f.service.create('p', { requestKey: 'create', title: 'Different' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('never exposes another plugin task or run', async () => {
    const f = fixture();
    const run = await f.send();
    await expect(f.service.get('other', run.taskId)).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
    await expect(f.service.getRun('other', run.runId)).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
    expect((await f.service.list('other')).items).toEqual([]);
  });
  it('persists input identity before dispatch and does not replay after restart', async () => {
    const f = fixture();
    f.deps.dispatch = vi.fn(async (_, __, clientId) => {
      expect([...f.rows.values()].some((r) => r.payload.includes(clientId))).toBe(true);
      throw new Error('Response lost');
    });
    const run = await f.send();
    expect(run.status).toBe('reconciling');
    const restarted = createPluginTaskService(f.deps);
    const retry = await restarted.send('p', {
      taskId: run.taskId,
      requestKey: 'send',
      expectedRevision: 1,
      text: 'hello',
    });
    expect(retry.runId).toBe(run.runId);
    expect(f.deps.dispatch).toHaveBeenCalledTimes(1);
  });
  it('rejects stale revision and archived tasks without dispatch', async () => {
    const f = fixture();
    const task = await f.create();
    await expect(
      f.service.send('p', {
        taskId: task.taskId,
        requestKey: 's',
        expectedRevision: 2,
        text: 'hi',
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    f.tasks.get(task.taskId)!.status = 'archived';
    await expect(
      f.service.send('p', {
        taskId: task.taskId,
        requestKey: 's',
        expectedRevision: 1,
        text: 'hi',
      }),
    ).rejects.toMatchObject({ code: 'TASK_BUSY' });
    expect(f.deps.dispatch).not.toHaveBeenCalled();
  });
  it('binds native acceptance and fences late terminals from old runtime/generation', async () => {
    const f = fixture();
    const run = await f.send();
    await f.service.accept(run.taskId, { clientId: run.inputMessageId }, f.execution);
    await f.service.settle(run.taskId, { ...f.execution, instanceId: 'old' }, 'completed', 'wrong');
    expect(JSON.parse(f.rows.get(run.runId)!.payload).status).toBe('running');
    await f.service.settle(run.taskId, f.execution, 'completed', 'output');
    await f.service.settle(run.taskId, f.execution, 'failed');
    expect(await f.service.getRun('p', run.runId)).toMatchObject({
      status: 'completed',
      outputMessageId: 'output',
    });
  });
  it('transfers only native recovery aliases to the new execution', async () => {
    const f = fixture();
    const run = await f.send();
    await f.service.accept(run.taskId, { clientId: run.inputMessageId }, f.execution);
    await f.service.accept(
      run.taskId,
      { clientId: 'retry', retrySourceClientId: run.inputMessageId },
      { ...f.execution, generation: 2 },
    );
    await f.service.settle(run.taskId, f.execution, 'failed');
    expect(JSON.parse(f.rows.get(run.runId)!.payload).execution.generation).toBe(2);
  });
  it('cancellation before acceptance prevents a queued input from starting', async () => {
    const f = fixture();
    const run = await f.send();
    expect((await f.service.cancel('p', run.runId)).status).toBe('cancelled');
    await expect(
      f.service.accept(run.taskId, { clientId: run.inputMessageId }, f.execution),
    ).rejects.toMatchObject({ code: 'REQUEST_EXPIRED' });
  });
  it.each(['completed', 'failed', 'cancelled', 'interrupted'] as const)(
    'keeps native %s during a running cancellation', async status => {
      const f = fixture();
      const run = await f.send();
      await f.service.accept(run.taskId, { clientId: run.inputMessageId }, f.execution);
      f.deps.cancel = vi.fn(async () => {
        await f.service.settle(run.taskId, f.execution, status);
        return 'stopping' as const;
      });
      expect((await f.service.cancel('p', run.runId)).status).toBe(status);
      await f.service.settle(run.taskId, f.execution, 'failed');
      expect((await f.service.getRun('p', run.runId)).status).toBe(status);
    },
  );
  it.each(['cancelled', 'interrupted'] as const)(
    'settles a stopping run as %s and ignores stale or duplicate terminals', async status => {
      const f = fixture();
      const run = await f.send();
      await f.service.accept(run.taskId, { clientId: run.inputMessageId }, f.execution);
      f.deps.cancel = vi.fn(async () => 'stopping' as const);
      expect((await f.service.cancel('p', run.runId)).status).toBe('stopping');
      await f.service.settle(run.taskId, { ...f.execution, generation: f.execution.generation + 1 }, status);
      expect(JSON.parse(f.rows.get(run.runId)!.payload).status).toBe('stopping');
      await f.service.settle(run.taskId, f.execution, status);
      await f.service.settle(run.taskId, f.execution, 'failed');
      expect((await f.service.getRun('p', run.runId)).status).toBe(status);
    },
  );
  it('does not convert a completed output into cancellation', async () => {
    const f = fixture();
    const run = await f.send();
    await f.service.accept(run.taskId, { clientId: run.inputMessageId }, f.execution);
    await f.service.settle(run.taskId, f.execution, 'completed');
    expect((await f.service.cancel('p', run.runId)).status).toBe('completed');
    expect(f.deps.cancel).not.toHaveBeenCalled();
  });
  it('revalidates exact configuration at vendor boundary', async () => {
    const f = fixture();
    const run = await f.send();
    f.tasks.get(run.taskId)!.resolvedConfig.model = 'other';
    await expect(
      f.service.accept(run.taskId, { clientId: run.inputMessageId }, f.execution),
    ).rejects.toMatchObject({ code: 'ROUTE_UNAVAILABLE' });
  });
  it('account switch blocks subsequent work', async () => {
    const f = fixture();
    await f.create();
    f.switchOwner();
    await expect(f.service.list('p')).rejects.toThrow('Owner changed');
  });
  it('rejects queued input when the task was archived before vendor acceptance', async () => {
    const f = fixture();
    const run = await f.send();
    f.tasks.get(run.taskId)!.status = 'archived';
    await expect(f.service.accept(run.taskId, { clientId: run.inputMessageId }, f.execution))
      .rejects.toMatchObject({ code: 'TASK_BUSY' });
    expect(JSON.parse(f.rows.get(run.runId)!.payload).execution).toBeUndefined();
  });
  it('does not recreate a deleted task on request replay', async () => {
    const f = fixture();
    const task = await f.create();
    f.tasks.delete(task.taskId);
    await expect(f.create()).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    expect(f.deps.createSession).toHaveBeenCalledTimes(1);
  });
  it('allows coordinator acceptance and synchronous terminal inside dispatch without a lock cycle', async () => {
    const f = fixture();
    f.deps.dispatch = vi.fn(async (_, taskId, clientId) => {
      await f.service.accept(taskId, { clientId }, f.execution);
      await f.service.settle(taskId, f.execution, 'completed', 'answer');
      return { ok: true };
    });
    expect(await f.send()).toMatchObject({ status: 'completed', outputMessageId: 'answer' });
  });
  it('does not hold the receipt lock while native stop delivers its terminal', async () => {
    const f = fixture();
    const run = await f.send();
    await f.service.accept(run.taskId, { clientId: run.inputMessageId }, f.execution);
    f.deps.cancel = vi.fn(async () => {
      await f.service.settle(run.taskId, f.execution, 'completed', 'finished-before-stop');
      return 'stopping' as const;
    });
    expect(await f.service.cancel('p', run.runId)).toMatchObject({
      status: 'completed',
      outputMessageId: 'finished-before-stop',
    });
  });
  it('does not block a user retry after the plugin run ended', async () => {
    const f = fixture();
    const run = await f.send();
    await f.service.accept(run.taskId, { clientId: run.inputMessageId }, f.execution);
    await f.service.settle(run.taskId, f.execution, 'failed');
    await expect(
      f.service.accept(
        run.taskId,
        { clientId: 'user-retry', retrySourceClientId: run.inputMessageId },
        { ...f.execution, generation: 2 },
      ),
    ).resolves.toBeUndefined();
    expect(await f.service.getRun('p', run.runId)).toMatchObject({ status: 'failed' });
  });
  it('keeps multi-hop recovery aliases but never adopts an unrelated user input', async () => {
    const f = fixture();
    const run = await f.send();
    await f.service.accept(
      run.taskId,
      { clientId: 'retry1', retrySourceClientId: run.inputMessageId },
      f.execution,
    );
    await f.service.accept(
      run.taskId,
      { clientId: 'retry2', retrySourceClientId: 'retry1' },
      { ...f.execution, generation: 2 },
    );
    await f.service.accept(run.taskId, { clientId: 'user-new' }, { ...f.execution, generation: 3 });
    await f.service.discard(run.taskId, { clientId: 'retry1' }, 'cancelled');
    const receipt = JSON.parse(f.rows.get(run.runId)!.payload);
    expect(receipt.status).toBe('running');
    expect(receipt.execution.generation).toBe(2);
    expect(receipt.inputClientIds).toEqual(['retry1', 'retry2']);
  });
});

it('permission elevation blocks new sends but preserves inspection of existing work',async()=>{
 const f=fixture();const task=await f.create();const run=await f.send();
 f.tasks.set(task.taskId,{...f.tasks.get(task.taskId)!,permissionMode:'bypassPermissions'});
 expect((await f.service.get('p',task.taskId)).taskId).toBe(task.taskId);
 expect((await f.service.getRun('p',run.runId)).runId).toBe(run.runId);
 await expect(f.service.send('p',{taskId:task.taskId,expectedRevision:task.revision,requestKey:'new-send',text:'new'})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
});

it('replays create and frozen plans across key-order changes and a service restart', async () => {
  const f = fixture();
  const request = { requestKey: 'ordered', title: 'Test', route: f.route };
  const task = await f.service.create('p', request);
  const route = { fastMode: false, effort: 'high', model: 'model', providerId: 'mine', agentKind: 'codex' as const };
  const restarted = createPluginTaskService(f.deps);
  await expect(restarted.create('p', { ...request, route })).resolves.toEqual(task);
  expect(f.deps.createSession).toHaveBeenCalledOnce();
  const plan = { concurrency: 2, items: [{ label: 'sample', workingDir: '/answer', route: f.route }] };
  await restarted.setTeamPlan('p', task.taskId, plan);
  await expect(restarted.setTeamPlan('p', task.taskId, {
    items: [{ route, workingDir: '/answer', label: 'sample' }], concurrency: 2,
  })).resolves.toEqual({ ok: true });
  await expect(restarted.create('p', { ...request, route: { ...route, model: 'changed' } })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(restarted.setTeamPlan('p', task.taskId, { ...plan, concurrency: 3 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});
it('preserves exact retries of pre-canonical development receipts', async () => {
  const f = fixture();
  const request = { requestKey: 'legacy', title: 'Test', route: f.route };
  const task = await f.service.create('p', request);
  f.rows.get(task.taskId)!.fingerprint = createHash('sha256').update(JSON.stringify([request.title, request.route])).digest('hex');
  await expect(createPluginTaskService(f.deps).create('p', request)).resolves.toEqual(task);
  await expect(f.service.create('p', { ...request, route: { ...f.route, model: 'changed' } })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});
it('freezes owned plan and retains settled labels',async()=>{const f=fixture(),task=await f.create();const plan={concurrency:2,items:[{label:'sample',workingDir:'/answer',route:f.route}]};await f.service.setTeamPlan('p',task.taskId,plan);await f.service.setTeamPlan('p',task.taskId,plan);await expect(f.service.setTeamPlan('other',task.taskId,plan)).rejects.toThrow('Task not found');await expect(f.service.setTeamPlan('p',task.taskId,{...plan,concurrency:3})).rejects.toThrow('immutable');await f.service.settleWorkerLabel('p',task.taskId,'sample');expect(JSON.parse(f.rows.get(task.taskId)!.payload).settledLabels).toEqual(['sample']);});


it('rechecks permissions when queued input reaches native dispatch', async () => {
 const f=fixture(), run=await f.send();
 f.tasks.get(run.taskId)!.permissionMode='bypassPermissions';
 await expect(f.service.accept(run.taskId,{clientId:run.inputMessageId},f.execution)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
 expect(JSON.parse(f.rows.get(run.runId)!.payload).status).toBe('queued');
});

it('registers plans only before input and preserves identical retries after dispatch', async () => {
  const f = fixture(), task = await f.create();
  const plan = {concurrency: 2, items: [{label: 'sample', workingDir: '/answer', route: f.route}]};
  f.deps.assertTeamPlanUnstarted = vi.fn(async () => { throw new Error('Worker reservation exists'); });
  await expect(f.service.setTeamPlan('p', task.taskId, plan)).rejects.toThrow('reservation');
  f.deps.assertTeamPlanUnstarted = vi.fn(async () => undefined);
  await f.service.setTeamPlan('p', task.taskId, plan);
  await f.send();
  await expect(f.service.setTeamPlan('p', task.taskId, plan)).resolves.toEqual({ok: true});
  const late = fixture(), run = await late.send();
  await expect(late.service.setTeamPlan('p', run.taskId, plan)).rejects.toMatchObject({code: 'TASK_BUSY'});
});

it('drains terminal receipt writes before the owner database closes', async () => {
  const f = fixture(), run = await f.send();
  await f.service.accept(run.taskId, {clientId: run.inputMessageId}, f.execution);
  const save = f.deps.store.save;
  let unblock!: () => void;
  const barrier = new Promise<void>(resolve => { unblock = resolve; });
  f.deps.store.save = async row => { await barrier; await save(row); };
  const terminal = f.service.settle(run.taskId, f.execution, 'completed', 'answer');
  let drained = false;
  const drain = f.service.drain().then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false);
  unblock();
  await Promise.all([terminal, drain]);
  f.switchOwner();
  expect(JSON.parse(f.rows.get(run.runId)!.payload)).toMatchObject({status: 'completed', outputMessageId: 'answer'});
});

it.each(['send', 'cancel'] as const)('drain waits for the full %s operation including native callbacks', async kind => {
 const f = fixture(); const task = await f.create();
 const old = kind === 'cancel' ? await f.send() : null;
 let release!: () => void;
 const barrier = new Promise<void>(resolve => { release = resolve; });
 let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
 f.deps.dispatch = async (_p, taskId, inputMessageId) => {
  entered(); await barrier;
  await f.service.accept(taskId, {clientId: inputMessageId}, f.execution);
  return {ok: false};
 };
 f.deps.cancel = async () => { entered(); await barrier; return 'cancelled'; };
 const operation = kind === 'send'
  ? f.service.send('p', {taskId:task.taskId, requestKey:'new', expectedRevision:task.revision, text:'hello'})
  : f.service.cancel('p', old!.runId);
 await started;
 let drained = false; const drain = f.service.drain().then(() => { drained = true; });
 await new Promise(resolve => setTimeout(resolve, 0)); expect(drained).toBe(false);
 release(); const [run] = await Promise.all([operation, drain]);
 f.switchOwner();
 expect(JSON.parse(f.rows.get(run.runId)!.payload).status).toBe(kind === 'send' ? 'running' : 'cancelled');
});
it.each(['validation', 'archive', 'settlement', 'alreadyArchived', 'failure'] as const)('drains the real releaseWorker branch through %s', async phase => {
 const f = fixture();
 let release!: () => void, entered!: () => void;
 const barrier = new Promise<void>(resolve => { release = resolve; });
 const started = new Promise<void>(resolve => { entered = resolve; });
 const pause = async () => { entered(); await barrier; };
 const service = {...f.service,
  get: vi.fn(async () => { if (phase === 'validation') await pause(); return {taskId:'lead'}; }),
  settleWorkerLabel: vi.fn(async () => {
   if (phase === 'settlement' || phase === 'alreadyArchived') await pause();
   // Native completion enqueues work on the real receipt tail. Holding that
   // tail across archive would deadlock this callback.
   await f.create();
  }),
 };
 const archiveWorker = vi.fn(async ({beforeArchive}: {beforeArchive: () => Promise<void>}) => {
  await beforeArchive();
  if (phase === 'archive' || phase === 'failure') await pause();
  if (phase === 'failure') throw new Error('archive failed');
  await f.create();
  return {ok:true};
 });
 const record = {id:'worker',sessionId:'child',label:'one',status:phase === 'alreadyArchived' ? 'archived' : 'done'};
 const query = {from:()=>query,innerJoin:()=>query,where:()=>query,limit:async()=>[record]};
 const epoch = {client:{drizzle:{select:()=>query}}};
 const deps = {service, getCurrentDbClientSnapshot:()=>epoch,PluginTaskError,assertPluginTaskResult,readPluginTaskPlanReceipt,
  orcaWorkers:{},orcaTeams:{},sessions:{},eq:()=>true,and:()=>true,
  createPluginTaskStore:()=>({get:async()=>({payload:JSON.stringify({teamPlan:{items:[{label:'one'}]}})})}),
  readPluginWorkerCompletion:async()=>({row:record,completedAt:1}),orcaTeamService:{archiveWorker}};
 const source = readFileSync(new URL('../register.ts',import.meta.url),'utf8');
 const branch = source.slice(source.indexOf("      case 'releaseWorker': {"),source.indexOf("      case 'getTeam': {"));
 const js = ts.transpileModule(`return async function(pluginId, request) { switch(request.kind) { ${branch} } }`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const run = new Function(...Object.keys(deps),js)(...Object.values(deps));
 const operation = run('p',{kind:'releaseWorker',taskId:'lead',workerId:'worker',completedAt:1});
 const result = phase === 'failure' ? expect(operation).rejects.toThrow('archive failed') : expect(operation).resolves.toMatchObject({ok:true});
 await started;
 let drained = false;
 const drain = f.service.drain().then(()=>{drained=true;});
 await new Promise(resolve=>setTimeout(resolve,0));
 expect(drained).toBe(false);
 release(); await Promise.all([result,drain]);
 expect(service.settleWorkerLabel).toHaveBeenCalledTimes(phase === 'failure' ? 0 : 1);
 expect(archiveWorker).toHaveBeenCalledTimes(phase === 'alreadyArchived' ? 0 : 1);
 await f.service.drain();
 f.switchOwner();
});

it.each([false, true])('team start drain excludes confirmation and includes native completion (failure=%s)', async fails => {
 const f = fixture();
 let confirm!: () => void, finish!: () => void, entered!: () => void;
 const dialog = new Promise<void>(resolve=>{confirm=resolve;});
 const native = new Promise<void>(resolve=>{finish=resolve;});
 const started = new Promise<void>(resolve=>{entered=resolve;});
 const source = readFileSync(new URL('../register.ts',import.meta.url),'utf8');
 const helper = source.slice(source.indexOf('  const startOrcaTeamForCaller ='),source.indexOf('  const pluginPermissionRequests ='));
 const deps = {assertLeadCollabProjectEnabled:async()=>{},getWorkerPermissionModeFromCreationPrefs:()=> 'auto',
  t:(key:string)=>key,orcaWorkerPermissionConfirmBridge:{request:()=>dialog},
  startOrcaTeamWithPermissionGate:async (params:unknown, handlers:{startTeam:(params:unknown)=>Promise<unknown>})=>{await dialog;return handlers.startTeam(params);},
  orcaLifecycleService:{startTeam:async()=>{entered();await native;await f.create();if(fails)throw new Error('failed');return {ok:true};}}};
 const js = ts.transpileModule(`${helper}\nreturn startOrcaTeamForCaller;`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const run = new Function(...Object.keys(deps),js)(...Object.values(deps));
 const operation = run('lead',undefined,async()=>{},f.service.completeOperation);
 await f.service.drain(); // An unanswered dialog must not block logout.
 confirm();await started;
 let drained=false;const drain=f.service.drain().then(()=>{drained=true;});
 await new Promise(resolve=>setTimeout(resolve,0));expect(drained).toBe(false);
 finish();expect(await operation).toMatchObject({ok:!fails});await drain;
});

it('a rejected operation does not poison subsequent drain', async () => {
 const f = fixture(), run = await f.send();
 f.deps.cancel = async () => { throw new Error('native stop failed'); };
 await expect(f.service.cancel('p', run.runId)).rejects.toThrow('native stop failed');
 await f.service.drain();
 f.deps.cancel = async () => 'cancelled';
 await expect(f.service.cancel('p', run.runId)).resolves.toMatchObject({status:'cancelled'});
 await f.service.drain();
});



describe('current plugin dispatch authority', () => {
  it.each(['before', 'route', 'insert'])('blocks independent Plan Mode before dispatch at %s', async point => {
    const f=fixture(), task=await f.create();
    const enable=()=>Object.assign(f.tasks.get(task.taskId)!,{permissionMode:'auto',planModeEnabled:true});
    if(point==='before') enable();
    if(point==='route') f.deps.resolveRoute=async()=>{enable();return f.route;};
    if(point==='insert') {const insert=f.deps.store.insert;f.deps.store.insert=async row=>{await insert(row);enable();};}
    const send=f.service.send('p',{taskId:task.taskId,expectedRevision:task.revision,requestKey:'plan',text:'input'});
    if(point==='insert') await expect(send).resolves.toMatchObject({status:'failed'});
    else await expect(send).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    expect(f.deps.dispatch).not.toHaveBeenCalled();
  });
  it.each(['before', 'route', 'save'])('blocks queued acceptance after Plan Mode at %s but keeps inspection/cancel', async point => {
    const f=fixture(), run=await f.send();
    const enable=()=>Object.assign(f.tasks.get(run.taskId)!,{permissionMode:'acceptEdits',planModeEnabled:true});
    if(point==='before') enable();
    if(point==='route') f.deps.resolveRoute=async()=>{enable();return f.route;};
    if(point==='save') {const save=f.deps.store.save;f.deps.store.save=async row=>{await save(row);enable();};}
    await expect(f.service.accept(run.taskId,{clientId:run.inputMessageId},f.execution)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    await expect(f.service.get('p',run.taskId)).resolves.toMatchObject({planModeEnabled:true});
    await expect(f.service.cancel('p',run.runId)).resolves.toMatchObject({status:'cancelled'});
  });
  it.each(['plan', 'ask', 'acceptEdits', 'auto', 'bypassPermissions'])('allows only authority within %s configuration', configured => {
    const modes = ['plan', 'ask', 'acceptEdits', 'auto', 'bypassPermissions'];
    for (const mode of [...modes, 'unknown', undefined]) {
      expect(isPluginTaskPermissionAllowed(mode, configured)).toBe(modes.includes(mode!) && modes.indexOf(mode!) <= modes.indexOf(configured));
    }
    expect(isPluginTaskPermissionAllowed('auto', undefined)).toBe(false);
  });
  it.each(['before', 'route', 'insert'])('blocks a new dispatch after revocation at %s', async point => {
    const f = fixture(), task = await f.create();
    f.tasks.get(task.taskId)!.permissionMode = 'auto';
    let mode = 'auto'; f.deps.readPermissionMode = () => mode;
    if (point === 'before') mode = 'plan';
    if (point === 'route') f.deps.resolveRoute = async () => { mode = 'plan'; return f.route; };
    if (point === 'insert') {
      const insert = f.deps.store.insert;
      f.deps.store.insert = async row => { await insert(row); mode = 'plan'; };
    }
    const attempt = f.service.send('p', {taskId:task.taskId,expectedRevision:task.revision,requestKey:'new',text:'input'});
    if (point === 'insert') await expect(attempt).resolves.toMatchObject({status:'failed'});
    else await expect(attempt).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    expect(f.deps.dispatch).not.toHaveBeenCalled();
  });
  it.each(['before', 'route', 'save'])('blocks queued acceptance after revocation at %s and keeps cancel available', async point => {
    const f = fixture(), run = await f.send();
    f.tasks.get(run.taskId)!.permissionMode = 'auto';
    let mode = 'auto'; f.deps.readPermissionMode = () => mode;
    if (point === 'before') mode = 'plan';
    if (point === 'route') f.deps.resolveRoute = async () => { mode = 'plan'; return f.route; };
    if (point === 'save') {
      const save = f.deps.store.save;
      f.deps.store.save = async row => { await save(row); mode = 'plan'; };
    }
    await expect(f.service.accept(run.taskId,{clientId:run.inputMessageId},f.execution)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    // Same-key retries observe the existing receipt; they never reopen dispatch.
    const calls = vi.mocked(f.deps.dispatch).mock.calls.length;
    await f.send(); expect(f.deps.dispatch).toHaveBeenCalledTimes(calls);
    await expect(f.service.cancel('p',run.runId)).resolves.toMatchObject({status:'cancelled'});
  });

  it.each(['plan', 'permission', 'archive', 'read failure'] as const)(
    'persists a known pre-dispatch failure after %s without reopening the request key', async change => {
      const f = fixture(), task = await f.create();
      f.tasks.get(task.taskId)!.permissionMode = 'auto';
      const insert = f.deps.store.insert;
      const readSession = f.deps.readSession;
      f.deps.store.insert = async row => {
        await insert(row);
        if (change === 'plan') f.tasks.get(task.taskId)!.planModeEnabled = true;
        if (change === 'permission') f.deps.readPermissionMode = () => 'plan';
        if (change === 'archive') f.tasks.get(task.taskId)!.status = 'archived';
        if (change === 'read failure') f.deps.readSession = vi.fn()
          .mockRejectedValueOnce(new Error('Read unavailable')).mockImplementation(readSession);
      };
      const request = { taskId: task.taskId, expectedRevision: task.revision, requestKey: 'known', text: 'input' };
      const run = await f.service.send('p', request);
      expect(run).toMatchObject({ status: 'failed', error: 'Input was not accepted by the host.' });
      expect(await f.service.getRun('p', run.runId)).toEqual(run);
      expect((await f.service.listRuns('p', task.taskId)).items).toEqual([run]);
      expect(f.deps.inspect).not.toHaveBeenCalled();
      const restarted = createPluginTaskService(f.deps);
      expect(await restarted.send('p', request)).toEqual(run);
      expect(f.deps.dispatch).not.toHaveBeenCalled();
      // Restored authority permits an explicit new request, never replay of the old input.
      f.deps.store.insert = insert;
      Object.assign(f.tasks.get(task.taskId)!, { planModeEnabled: false, status: 'active' });
      f.deps.readPermissionMode = () => 'auto';
      expect(await restarted.send('p', request)).toEqual(run);
      expect(await restarted.send('p', { ...request, requestKey: 'new' })).toMatchObject({ status: 'queued' });
      expect(f.deps.dispatch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['approval', 'ownership', 'deleted', 'account', 'save'] as const)(
    'keeps the request receipt and rejects when %s prevents failure settlement', async change => {
      const f = fixture(), task = await f.create();
      const insert = f.deps.store.insert;
      f.deps.store.insert = async row => {
        await insert(row);
        f.tasks.get(task.taskId)!.planModeEnabled = true;
        if (change === 'approval') f.deps.assertAuthorized = () => { throw new Error('Approval revoked'); };
        if (change === 'ownership') await f.deps.store.revokePlugin('p');
        if (change === 'deleted') f.tasks.get(task.taskId)!.status = 'deleted';
        if (change === 'account') f.switchOwner();
        if (change === 'save') f.deps.store.save = async () => { throw new Error('Write unavailable'); };
      };
      await expect(f.service.send('p', {
        taskId: task.taskId, expectedRevision: task.revision, requestKey: 'blocked', text: 'input',
      })).rejects.toThrow();
      expect(f.deps.dispatch).not.toHaveBeenCalled();
      const receipts = [...f.rows.values()].filter(row => row.operation === 'send');
      expect(receipts).toHaveLength(1);
      expect(JSON.parse(receipts[0].payload).status).toBe('queued');
      expect(f.deps.store.discardUncreated).not.toHaveBeenCalled();
    },
  );

  it.each(['reject', 'throw'] as const)('preserves native progress over a late dispatch %s', async response => {
    for (const status of ['running', 'stopping', 'completed', 'cancelled'] as const) {
      const f = fixture();
      f.deps.dispatch = vi.fn(async (_plugin, taskId, clientId) => {
        await f.service.accept(taskId, { clientId }, f.execution);
        if (status === 'stopping' || status === 'cancelled') {
          f.deps.cancel = async () => status;
          await f.service.cancel('p', [...f.rows.values()].find(row => row.operation === 'send')!.id);
        }
        if (status === 'completed') await f.service.settle(taskId, f.execution, 'completed', 'answer');
        if (response === 'throw') throw new Error('Late response lost');
        return { ok: false };
      });
      expect(await f.send()).toMatchObject({ status });
    }
  });

  it('settles an explicit host rejection as failed', async () => {
    const f = fixture();
    f.deps.dispatch = vi.fn(async () => ({ ok: false }));
    const run = await f.send();
    expect(run.status).toBe('failed');
    expect(await f.service.getRun('p', run.runId)).toEqual(run);
    expect(await f.send()).toEqual(run);
    expect(f.deps.dispatch).toHaveBeenCalledTimes(1);
  });
});

it('changes only the owned task model through the ordinary runtime adapter', async () => {
  const f = fixture();
  const task = await f.create();
  const route = task.resolvedConfig;
  const next = { ...route, model: 'next-model' };
  f.deps.setModel = vi.fn<NonNullable<PluginTaskServiceDeps['setModel']>>(async (id, selected, assertCurrent) => {
    await assertCurrent();
    const stored = f.tasks.get(id)!;
    f.tasks.set(id, { ...stored, revision: stored.revision + 1, resolvedConfig: selected });
    return { status: 'applied' };
  });
  const changed = await f.service.setModel('p', { taskId: task.taskId, expectedRevision: task.revision, route: next });
  expect(changed.task).toMatchObject({ taskId: task.taskId, permissionMode: task.permissionMode, resolvedConfig: next });
  expect(f.tasks.size).toBe(1);
  await expect(f.service.setModel('other', { taskId: task.taskId, expectedRevision: 2, route: next })).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
  await expect(f.service.setModel('p', { taskId: task.taskId, expectedRevision: 1, route: next })).rejects.toMatchObject({ code: 'STALE_REVISION' });
  expect(f.deps.setModel).toHaveBeenCalledOnce();
});

it('does not apply a model after the task changes while route admission is pending', async () => {
  const f = fixture();
  const task = await f.create();
  const route = task.resolvedConfig;
  f.deps.resolveRoute = async () => { f.tasks.get(task.taskId)!.revision++; return route; };
  f.deps.setModel = vi.fn();
  await expect(f.service.setModel('p', { taskId: task.taskId, expectedRevision: task.revision, route })).rejects.toMatchObject({ code: 'STALE_REVISION' });
  expect(f.deps.setModel).not.toHaveBeenCalled();
});

it('rechecks plugin defaults for the same task on every request without resetting unchanged tasks', async () => {
  const f = fixture();
  let preference = { ...f.route, model: 'grok' };
  f.deps.readModelPreference = () => preference;
  f.deps.resolveRoute = vi.fn(async (_plugin, requested) => requested ?? { ...preference });
  // First install: creation already respects the saved preference.
  let task = await f.create();
  expect(task.resolvedConfig.model).toBe('grok');
  f.deps.setModel = vi.fn(async (id, route, assertCurrent) => {
    await assertCurrent();
    const stored = f.tasks.get(id)!;
    f.tasks.set(id, { ...stored, revision: stored.revision + 1, resolvedConfig: route });
    return { status: 'applied' };
  });
  const sync = async () => {
    const result = await f.service.setModel('p', {taskId: task.taskId, expectedRevision: task.revision, route: 'plugin-default'});
    task = result.task;
    return result.status;
  };
  expect(await sync()).toBe('unchanged');
  expect(f.deps.setModel).not.toHaveBeenCalled();
  for (const model of ['astra', 'grok']) {
    preference = {...preference, model};
    expect(await sync()).toBe('applied');
    const run = await f.service.send('p', {taskId:task.taskId, expectedRevision:task.revision, requestKey:model, text:'translate'});
    expect(run.acceptedConfig.model).toBe(model);
  }
  expect(f.tasks.size).toBe(1);
  expect(f.deps.setModel).toHaveBeenCalledTimes(2);
  expect(await sync()).toBe('unchanged');
  preference = {...preference, effort:'low', fastMode:true, providerId:'other-source'};
  expect(await sync()).toBe('applied');
  expect(task.resolvedConfig).toEqual(preference);
  f.deps.resolveRoute = async () => {throw new PluginTaskError('ROUTE_UNAVAILABLE', 'Unavailable selection');};
  await expect(sync()).rejects.toMatchObject({code:'ROUTE_UNAVAILABLE'});
  expect(f.deps.setModel).toHaveBeenCalledTimes(3);
});

it.each([
  { model: 'new-model' }, { providerId: 'new-provider' },
  { agentKind: 'pi' as const }, { effort: 'low' }, { fastMode: true },
])('rejects preferences changed during async route admission: %j', async patch => {
  const f = fixture(), task = await f.create();
  const preference = { ...f.route };
  f.deps.readModelPreference = () => preference;
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  f.deps.resolveRoute = async () => { const captured = { ...preference }; entered(); await gate; return captured; };
  f.deps.setModel = vi.fn(async (id, route, assertCurrent) => {
    await assertCurrent();
    const stored = f.tasks.get(id)!;
    f.tasks.set(id, { ...stored, revision: stored.revision + 1, resolvedConfig: route });
    return { status: 'applied' };
  });
  const request = { taskId: task.taskId, expectedRevision: task.revision, route: 'plugin-default' as const };
  const pending = f.service.setModel('p', request);
  await started;
  Object.assign(preference, patch);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'STALE_REVISION' });
  finish(); await rejected;
  expect(f.deps.setModel).not.toHaveBeenCalled();
  expect((await f.service.get('p', task.taskId)).revision).toBe(task.revision);
  // No stale input was accepted; retry resolves and applies the newly saved choice.
  f.deps.resolveRoute = async () => ({ ...preference });
  const next = await f.service.setModel('p', request);
  expect(next.task.resolvedConfig).toEqual(preference);
});

it('rechecks saved preferences at the runtime mutation boundary', async () => {
  const f = fixture(), task = await f.create();
  let preference = { ...f.route, model: 'chosen' };
  f.deps.readModelPreference = () => preference;
  f.deps.resolveRoute = async () => ({ ...preference });
  const apply = vi.fn();
  f.deps.setModel = async (_id, _route, assertCurrent) => {
    preference = { ...preference, model: 'newer' };
    await assertCurrent(); apply(); return { status: 'applied' };
  };
  await expect(f.service.setModel('p', { taskId: task.taskId, expectedRevision: task.revision, route: 'plugin-default' }))
    .rejects.toMatchObject({ code: 'STALE_REVISION' });
  expect(apply).not.toHaveBeenCalled();
});

it('an open plugin selection without a source session follows the auxiliary chain at low effort', async () => {
  // Rule: a plugin's own persistent task must not borrow the new-task composer
  // model; the settings copy says it follows the system auxiliary model. It runs
  // on Pi when the provider offers the model there (2026-10-28). tier: unit.
  const f = fixture();
  const selected = { harness: 'codex' as const, model: 'next', providerId: f.route.providerId, effort: 'high' as const, fastMode: false };
  const resolver = createSessionExecutionResolver({
    captureOwner: () => () => {}, readCaller: async () => { throw Error('unexpected caller'); },
    readDefault: () => ({ agentKind: selected.harness, model: selected.model, providerId: selected.providerId, effort: selected.effort, fastMode: selected.fastMode }),
    availableAgents: () => ['codex', 'pi'],
    availableModels: () => [{ id: 'next', efforts: ['high'] }, { id: 'cheap', efforts: ['low', 'high'] }, { id: 'nolow', efforts: ['high'] }, { id: 'onpi', efforts: ['medium', 'high'] }],
    hasCindyAiApiKey: () => true,
    readProviderRouting: async () => ({ availability: { 'claude-code': [],
      pi: [{ id: f.route.providerId, name: 'provider', models: ['onpi'] }],
      codex: [{ id: f.route.providerId, name: 'provider', models: ['next', 'cheap', 'nolow', 'onpi'] }] },
      resolveDefaultProviderIdForModel: () => f.route.providerId }),
  });
  const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');
  const resolveStart = source.indexOf('    const resolveRoute = async');
  const resolve = source.slice(resolveStart, source.indexOf('    const readExecution', resolveStart));
  const run = (candidates: Array<{ agentKind: 'codex'; providerId: string; model: string }>, config = {}, sourceSessionId?: string) => {
    const deps = { getPluginTaskDefaults: () => config, getSelectedNewMakerRoute: () => selected,
      activeOwnerScopeKey: () => 'owner', assertPlugin: () => {}, getPluginTaskSourceSessionId: () => sourceSessionId,
      resolveSessionExecution: resolver, PluginTaskError, routeUnavailable: () => { throw Error('unavailable'); },
      getEffectiveAuxiliaryModelRefs: () => ['chain'], getEffectiveAuxiliaryModelChainSnapshot: () => 'chain',
      auxiliaryChainSessionCandidates: () => candidates, pluginTaskRouteAttempts, pluginTaskSelectionIsOpen };
    const js = ts.transpileModule(`${resolve}\nreturn resolveRoute;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return new Function(...Object.keys(deps), js)(...Object.values(deps))('p') as Promise<{ model: string; effort: string }>;
  };
  // First usable candidate wins, at low effort; a model Pi does not offer stays on the chain's harness.
  await expect(run([{ agentKind: 'codex', providerId: f.route.providerId, model: 'missing' }, { agentKind: 'codex', providerId: f.route.providerId, model: 'cheap' }]))
    .resolves.toMatchObject({ model: 'cheap', effort: 'low', agentKind: 'codex' });
  // A model the provider offers on Pi runs on Pi, at its lightest level.
  await expect(run([{ agentKind: 'codex', providerId: f.route.providerId, model: 'onpi' }]))
    .resolves.toMatchObject({ model: 'onpi', effort: 'medium', agentKind: 'pi' });
  // A chain head without a light effort level yields to the next candidate that has one.
  await expect(run([{ agentKind: 'codex', providerId: f.route.providerId, model: 'nolow' }, { agentKind: 'codex', providerId: f.route.providerId, model: 'cheap' }]))
    .resolves.toMatchObject({ model: 'cheap', effort: 'low' });
  // Only when no candidate offers a light level does a model route at its default effort.
  await expect(run([{ agentKind: 'codex', providerId: f.route.providerId, model: 'nolow' }])).resolves.toMatchObject({ model: 'nolow' });
  // No usable candidate: the new-task selection remains the last resort.
  await expect(run([{ agentKind: 'codex', providerId: f.route.providerId, model: 'missing' }])).resolves.toMatchObject({ model: 'next', effort: 'high' });
  // An explicit plugin model never consults the chain.
  await expect(run([{ agentKind: 'codex', providerId: f.route.providerId, model: 'cheap' }], { model: 'next' })).resolves.toMatchObject({ model: 'next' });
});

it('archives only its own idle task through the host writer and treats archived tasks as done', async () => {
  // Rule: plugins rotate per-video tasks and archive the previous one; a working task is never cut off. tier: unit.
  const f = fixture(), task = await f.create();
  f.deps.archive = vi.fn(async (taskId: string, assertAllowed: () => void) => {
    assertAllowed();
    f.tasks.set(taskId, { ...f.tasks.get(taskId)!, status: 'archived' });
  });
  (f.deps.inspect as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ execution: f.execution, pending: [] });
  await expect(f.service.archive('p', { taskId: task.taskId })).rejects.toMatchObject({ code: 'TASK_BUSY' });
  expect(f.deps.archive).not.toHaveBeenCalled();
  expect((await f.service.archive('p', { taskId: task.taskId })).status).toBe('archived');
  expect((await f.service.archive('p', { taskId: task.taskId })).status).toBe('archived');
  expect(f.deps.archive).toHaveBeenCalledTimes(1);
  await expect(f.service.archive('other', { taskId: task.taskId })).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
  await expect(f.service.send('p', { taskId: task.taskId, requestKey: 'late', expectedRevision: task.revision, text: 'x' })).rejects.toMatchObject({ code: 'TASK_BUSY' });
  const bare = fixture(), plain = await bare.create();
  await expect(bare.service.archive('p', { taskId: plain.taskId })).rejects.toMatchObject({ code: 'HOST_NOT_READY' });
});

// Review 2026-10-29 (Greptile P1): the idle check ran before the archive waited for the session
// write lock, so input sent in between was archived out from under the user. tier: unit.
it('does not archive a task that became busy while the archive waited for the session lock', async () => {
  const f = fixture(), task = await f.create();
  let busy = false;
  f.deps.isBusy = () => busy;
  f.deps.archive = vi.fn(async (taskId: string, assertAllowed: () => void) => {
    busy = true; // the user sends input while the write waits for the lock
    assertAllowed();
    f.tasks.set(taskId, { ...f.tasks.get(taskId)!, status: 'archived' });
  });
  await expect(f.service.archive('p', { taskId: task.taskId })).rejects.toMatchObject({ code: 'TASK_BUSY' });
  expect(f.tasks.get(task.taskId)!.status).toBe('active');
});

it.each([
  ['provider', 'reset'], ['provider', 'partial'],
  ['mutation', 'reset'], ['mutation', 'partial'],
  ['provider', 'explicit'],
] as const)('checks inherited defaults through production adapters during %s (%s)', async (phase, mode) => {
  const f = fixture(), task = await f.create();
  const config = mode === 'explicit' ? { ...f.route, model: 'next' }
    : mode === 'partial' ? { effort: 'high' } : {};
  const selected = { harness: 'codex' as const, model: 'next', providerId: f.route.providerId,
    effort: 'high' as const, fastMode: false };
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let waited = false;
  const wait = async (point: string) => {
    if (phase === point && !waited) { waited = true; entered(); await gate; }
  };
  const resolver = createSessionExecutionResolver({
    captureOwner: () => () => {}, readCaller: async () => { throw Error('unexpected caller'); },
    readDefault: () => ({ agentKind: selected.harness, model: selected.model,
      providerId: selected.providerId, effort: selected.effort, fastMode: selected.fastMode }),
    availableAgents: () => ['codex'],
    availableModels: () => ['model', 'next', 'latest'].map(id => ({ id, efforts: ['high'] })),
    hasCindyAiApiKey: () => true,
    readProviderRouting: async () => {
      await wait('provider');
      return { availability: { 'claude-code': [], pi: [],
        codex: [{ id: f.route.providerId, name: 'provider', models: ['model', 'next', 'latest'] }] },
        resolveDefaultProviderIdForModel: () => f.route.providerId };
    },
  });
  const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');
  const preferenceStart = source.indexOf('      readModelPreference:');
  const preference = source.slice(preferenceStart, source.indexOf('      readPermissionMode:', preferenceStart));
  const resolveStart = source.indexOf('    const resolveRoute = async');
  const resolve = source.slice(resolveStart, source.indexOf('    const readExecution', resolveStart));
  const deps = { getPluginTaskDefaults: () => config, getSelectedNewMakerRoute: () => selected,
    activeOwnerScopeKey: () => 'owner', assertPlugin: () => {}, getPluginTaskSourceSessionId: () => undefined,
    resolveSessionExecution: resolver, PluginTaskError, routeUnavailable: () => { throw Error('unavailable'); },
    // No auxiliary chain configured in this scenario: the new-task selection stays the inherited default.
    getEffectiveAuxiliaryModelRefs: () => [], getEffectiveAuxiliaryModelChainSnapshot: () => '',
    auxiliaryChainSessionCandidates: () => [], pluginTaskRouteAttempts, pluginTaskSelectionIsOpen };
  const js = ts.transpileModule(`${resolve}\nreturn {${preference} resolveRoute};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const adapter = new Function(...Object.keys(deps), js)(...Object.values(deps));
  f.deps.readModelPreference = adapter.readModelPreference;
  f.deps.resolveRoute = adapter.resolveRoute;
  const write = vi.fn();
  f.deps.setModel = async (id, route, assertCurrent) => {
    await wait('mutation');
    await assertCurrent();
    write(route);
    f.tasks.set(id, { ...f.tasks.get(id)!, revision: task.revision + 1, resolvedConfig: route });
    return { status: 'applied' };
  };
  const request = { taskId: task.taskId, expectedRevision: task.revision, route: 'plugin-default' as const };
  const result = f.service.setModel('p', request);
  const assertion = mode === 'explicit'
    ? expect(result).resolves.toMatchObject({ status: 'applied', task: { resolvedConfig: { model: 'next' } } })
    : expect(result).rejects.toMatchObject({ code: 'STALE_REVISION' });
  await started;
  selected.model = 'latest';
  finish();
  await assertion;
  if (mode !== 'explicit') {
    expect(write).not.toHaveBeenCalled();
    expect((await f.service.get('p', task.taskId)).revision).toBe(task.revision);
    const retry = await f.service.setModel('p', request);
    expect(retry.task.resolvedConfig.model).toBe('latest');
    expect(write).toHaveBeenCalledOnce();
  }
});

it('does not reject explicit routes when unrelated plugin preferences change', async () => {
  const f = fixture(), task = await f.create();
  f.deps.readModelPreference = () => { throw Error('Explicit route must not read preferences'); };
  f.deps.setModel = vi.fn(async (_id, _route, assertCurrent) => { await assertCurrent(); return { status: 'applied' }; });
  await expect(f.service.setModel('p', { taskId: task.taskId, expectedRevision: task.revision, route: f.route }))
    .resolves.toMatchObject({ status: 'applied' });
});

it('keeps taskless plans immutable instead of retroactively granting scope', async () => {
 const f=fixture(),task=await f.create();
 const old={concurrency:2,items:[{label:'sample',workingDir:'/answer',route:f.route}]};
 await f.service.setTeamPlan('p',task.taskId,old);
 const scoped={...old,task:'Coordinate',items:[{...old.items[0]!,task:'Run tests'}]};
 await expect(f.service.setTeamPlan('p',task.taskId,scoped)).rejects.toThrow('immutable');
 await f.send();
 await expect(f.service.setTeamPlan('p',task.taskId,scoped)).rejects.toThrow('immutable');
 await f.service.setTeamPlan('p',task.taskId,old);
 expect(JSON.parse(f.rows.get(task.taskId)!.payload).teamPlan).toEqual(old);
});

it.each(['sent', 'running', 'queued', 'workers'])('rejects late initial plan registration after %s', async state => {
 const f=fixture(),task=await f.create();
 if(state==='sent') await f.send();
 if(state==='running') vi.mocked(f.deps.inspect).mockResolvedValue({execution:f.execution,pending:[]});
 if(state==='queued') vi.mocked(f.deps.inspect).mockResolvedValue({execution:null,pending:[{clientId:'queued'}]});
 if(state==='workers') f.deps.assertTeamPlanUnstarted=async()=>{throw new Error('Workers already exist');};
 await expect(f.service.setTeamPlan('p',task.taskId,{concurrency:1,task:'Coordinate',items:[]})).rejects.toThrow();
 expect(JSON.parse(f.rows.get(task.taskId)!.payload).teamPlan).toBeUndefined();
});

it('registers a complete scope once and permits only identical replays', async () => {
 const f=fixture(),task=await f.create();
 const plan={concurrency:2,task:'Coordinate',items:[{label:'sample',workingDir:'/answer',route:f.route,task:'Run tests'}]};
 await f.service.setTeamPlan('p',task.taskId,plan);
 await f.service.setTeamPlan('p',task.taskId,plan);
 await expect(f.service.setTeamPlan('p',task.taskId,{...plan,task:'Publish'})).rejects.toThrow('immutable');
 await expect(f.service.setTeamPlan('p',task.taskId,{...plan,items:[{...plan.items[0]!,task:'Publish'}]})).rejects.toThrow('immutable');
});

describe('background tasks', () => {
  const declaredFixture = () => {
    const f = fixture();
    let declared = true;
    f.deps.assertHiddenTasksAllowed = () => {
      if (!declared) throw new PluginTaskError('PERMISSION_DENIED', 'Background tasks require agent.hiddenTasks');
    };
    f.deps.createSession = vi.fn(async (_p, taskId, title, resolvedConfig, _isolated, _requested, onPersistenceStarted, _callId, hidden) => {
      onPersistenceStarted();
      f.tasks.set(taskId, { taskId, title, resolvedConfig, revision: 1, status: 'active', permissionMode: 'plan', hidden: hidden === true });
    });
    f.deps.setHidden = vi.fn(async (taskId: string, hidden: boolean, assertAllowed: () => void) => {
      assertAllowed();
      f.tasks.set(taskId, { ...f.tasks.get(taskId)!, hidden });
    });
    return { ...f, undeclare: () => { declared = false; } };
  };

  it('creates a hidden task in the same creation call and reports hidden in get/list snapshots', async () => {
    const f = declaredFixture();
    const task = await f.service.create('p', { requestKey: 'bg', title: 'Background', hidden: true });
    expect(task.hidden).toBe(true);
    expect(f.deps.createSession).toHaveBeenCalledWith('p', task.taskId, 'Background', f.route, undefined, undefined, expect.any(Function), undefined, true);
    expect((await f.service.get('p', task.taskId)).hidden).toBe(true);
    expect((await f.service.list('p')).items.map(item => item.hidden)).toEqual([true]);
    // Exact replay reads the same task; the hidden flag is part of the request fingerprint.
    expect((await f.service.create('p', { requestKey: 'bg', title: 'Background', hidden: true })).taskId).toBe(task.taskId);
    await expect(f.service.create('p', { requestKey: 'bg', title: 'Background' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('keeps visible creation unchanged: hidden=false snapshot and the legacy fingerprint', async () => {
    const f = declaredFixture();
    const task = await f.service.create('p', { requestKey: 'plain', title: 'Plain', hidden: false });
    expect(task.hidden).toBe(false);
    expect((await f.service.create('p', { requestKey: 'plain', title: 'Plain' })).taskId).toBe(task.taskId);
    // Views without the field (older readers) are normalized to a boolean.
    const legacy = fixture();
    expect((await legacy.create()).hidden).toBe(false);
  });

  it('switches only its own task, rechecks the declaration and skips no-op writes', async () => {
    const f = declaredFixture();
    const task = await f.service.create('p', { requestKey: 'own', title: 'Own' });
    expect((await f.service.setHidden('p', { taskId: task.taskId, hidden: true })).hidden).toBe(true);
    expect((await f.service.setHidden('p', { taskId: task.taskId, hidden: true })).hidden).toBe(true);
    expect(f.deps.setHidden).toHaveBeenCalledTimes(1);
    expect((await f.service.setHidden('p', { taskId: task.taskId, hidden: false })).hidden).toBe(false);
    await expect(f.service.setHidden('other', { taskId: task.taskId, hidden: true })).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    await expect(f.service.setHidden('p', { taskId: 'missing', hidden: true })).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    f.undeclare();
    await expect(f.service.setHidden('p', { taskId: task.taskId, hidden: true })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(f.service.create('p', { requestKey: 'later', title: 'Later', hidden: true })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(f.deps.setHidden).toHaveBeenCalledTimes(2);
  });

  it('denies background tasks when the host has no declaration check wired', async () => {
    const f = fixture();
    await expect(f.service.create('p', { requestKey: 'bg', title: 'Background', hidden: true })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(f.deps.createSession).not.toHaveBeenCalled();
  });

  it('reveals background tasks before revoking ownership on uninstall, and aborts when reveal fails', async () => {
    const f = declaredFixture();
    const order: string[] = [];
    f.deps.revealPluginTasks = vi.fn(async () => { order.push('reveal'); });
    const revoke = vi.spyOn(f.deps.store, 'revokePlugin').mockImplementation(async () => { order.push('revoke'); });
    await f.service.withUninstall('p', async () => { order.push('remove'); });
    expect(order).toEqual(['reveal', 'revoke', 'remove']);
    f.deps.revealPluginTasks = vi.fn(async () => { throw new Error('db'); });
    const remove = vi.fn(async () => {});
    await expect(f.service.withUninstall('p', remove)).rejects.toThrow('db');
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  });
});
