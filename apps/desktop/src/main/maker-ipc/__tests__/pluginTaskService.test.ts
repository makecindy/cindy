import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import {
  createPluginTaskService,
  isPluginTaskPermissionAllowed,
  PluginTaskError,
  assertPluginTaskResult,
  type PluginTaskReceipt,
  type PluginTaskStore,
  type PluginTaskServiceDeps,
} from '../pluginTaskService.js';
import type { PluginTaskView } from '../../../shared/pluginTasks.js';
import { controlOwnedSessionExecution, isSameSessionExecution, withdrawOwnedSessionInputs } from '../sessionExecutionOwnership.js';

function fixture() {
  let seq = 0;
  let current = true;
  const rows = new Map<string, PluginTaskReceipt>();
  const tasks = new Map<string, PluginTaskView>();
  const copy = <T>(v: T): T => structuredClone(v);
  const store: PluginTaskStore = {
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
  const deps: PluginTaskServiceDeps = {
    store,
    readPermissionMode: () => 'auto',
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
    expect(f.deps.createSession).toHaveBeenCalledWith('p', task.taskId, 'Test', f.route, true, undefined, expect.any(Function));
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
 const deps = {service, getCurrentDbClientSnapshot:()=>epoch,PluginTaskError,assertPluginTaskResult,
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
  it.each(['plan', 'acceptEdits', 'auto'])('allows only authority within %s configuration', configured => {
    const modes = ['plan', 'acceptEdits', 'auto'];
    for (const mode of [...modes, 'bypassPermissions', 'unknown', undefined]) {
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
