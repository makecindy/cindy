import { describe, expect, it, vi } from 'vitest';
import {
  createPluginTaskService,
  type PluginTaskReceipt,
  type PluginTaskStore,
  type PluginTaskServiceDeps,
} from '../pluginTaskService.js';
import type { PluginTaskView } from '../../../shared/pluginTasks.js';

function fixture() {
  let seq = 0;
  let current = true;
  const rows = new Map<string, PluginTaskReceipt>();
  const tasks = new Map<string, PluginTaskView>();
  const copy = <T>(v: T): T => structuredClone(v);
  const store: PluginTaskStore = {
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
  const deps: PluginTaskServiceDeps = {
    store,
    assertAuthorized: () => {
      if (!current) throw new Error('Owner changed');
    },
    assertCurrent: () => {
      if (!current) throw new Error('Owner changed');
    },
    id: () => `id-${++seq}`,
    now: () => 1,
    resolveRoute: vi.fn(async (_, r) => r ?? route),
    createSession: vi.fn(async (_, taskId, title, resolvedConfig) => {
      tasks.set(taskId, { taskId, title, resolvedConfig, revision: 1, status: 'active' });
    }),
    readSession: async (id) => copy(tasks.get(id) ?? null),
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

describe('plugin ordinary task receipts', () => {
  it('binds isolated workspace intent to creation and idempotency', async () => {
    const f = fixture();
    const input = { requestKey: 'isolated', title: 'Test', isolatedWorkspace: true };
    const task = await f.service.create('p', input);
    expect(f.deps.createSession).toHaveBeenCalledWith('p', task.taskId, 'Test', f.route, true);
    await f.service.create('p', input);
    expect(f.deps.createSession).toHaveBeenCalledTimes(1);
    await expect(f.service.create('p', { ...input, isolatedWorkspace: false }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
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

it('freezes owned plan and retains settled labels',async()=>{const f=fixture(),task=await f.create();const plan={concurrency:2,items:[{label:'sample',workingDir:'/answer',route:f.route}]};await f.service.setTeamPlan('p',task.taskId,plan);await f.service.setTeamPlan('p',task.taskId,plan);await expect(f.service.setTeamPlan('other',task.taskId,plan)).rejects.toThrow('Task not found');await expect(f.service.setTeamPlan('p',task.taskId,{...plan,concurrency:3})).rejects.toThrow('immutable');await f.service.settleWorkerLabel('p',task.taskId,'sample');expect(JSON.parse(f.rows.get(task.taskId)!.payload).settledLabels).toEqual(['sample']);});


it('rechecks permissions when queued input reaches native dispatch', async () => {
 const f=fixture(), run=await f.send();
 f.tasks.get(run.taskId)!.permissionMode='bypassPermissions';
 await expect(f.service.accept(run.taskId,{clientId:run.inputMessageId},f.execution)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
 expect(JSON.parse(f.rows.get(run.runId)!.payload).status).toBe('queued');
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
