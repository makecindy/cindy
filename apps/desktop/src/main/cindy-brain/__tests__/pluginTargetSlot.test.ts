import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => 'owner',
  getActiveDataOwnerPushStamp: () => ({ ownerGeneration: 1 }),
}));
import { PluginTargetSlot, type PluginTargetAdapter, type PluginTargetReceipt, type PluginTargetStore } from '../pluginTargetSlot.js';
import { createGhostProductionCallbacks } from './ghostProductionCallbacksFixture.js';

const loadPipe = createGhostProductionCallbacks<{
  send(event: { sender: { id: number; isDestroyed(): boolean } }, payload: unknown): Promise<unknown>;
}>({ callbacks: { send: ['ipcMain.handle', 'ghost-pipe:send'] } });

const receipts = new Map<string, PluginTargetReceipt>();
const key = (pluginId: string, requestKey: string) => JSON.stringify([pluginId, requestKey]);
const store: PluginTargetStore = {
  get: async (pluginId, requestKey) => structuredClone(receipts.get(key(pluginId, requestKey))),
  getById: async id => structuredClone([...receipts.values()].find(row => row.id === id)),
  reserve: async receipt => {
    const identity = key(receipt.pluginId, receipt.requestKey);
    if (receipts.has(identity)) return false;
    receipts.set(identity, structuredClone(receipt));
    return true;
  },
  cancel: async (pluginId, requestKey) => {
    const identity = key(pluginId, requestKey);
    const receipt: PluginTargetReceipt = { ...(receipts.get(identity) ?? {
      id: 'cancelled', pluginId, requestKey, hash: null,
    }), status: 'cancelled' };
    receipts.set(identity, receipt);
    return structuredClone(receipt);
  },
  accept: async (id, delivery) => {
    const receipt = [...receipts.values()].find(row => row.id === id)!;
    if (receipt.status !== 'cancelled') Object.assign(receipt, { status: 'accepted', delivery });
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('plugin target queries and delivery', () => {
  beforeEach(() => { receipts.clear(); });
  function fixture() {
    const slot = new PluginTargetSlot();
    const send = vi.fn<PluginTargetAdapter['send']>(async () => 'queue');
    const create = vi.fn<PluginTargetAdapter['create']>(async () => {});
    const withdraw = vi.fn<PluginTargetAdapter['withdraw']>(async () => {});
    const candidates = vi.fn<PluginTargetAdapter['candidates']>(async () => [
      { id: 'chosen', label: 'Chosen target', detail: '/workspace/example' },
    ]);
    const approvalRevision = vi.fn<PluginTargetAdapter['approvalRevision']>(() => 'approved-install');
    const assertCreatePermission = vi.fn();
    const assertProjectDispatch = vi.fn(async (_pluginId: string, _taskId: string) => {});
    slot.adapter = { store: () => store, approvalRevision, candidates, session: async () => 'chosen', send, create, withdraw, assertCreatePermission, assertProjectDispatch };
    const guard = vi.fn();
    const call = (payload: unknown, plugin = 'plugin') => slot.handle(plugin, payload, guard);
    const request = { kind: 'send', target: { kind: 'task', id: 'chosen' },
      requestKey: 'send', text: 'context' };
    return { slot, call, request, send, create, withdraw, candidates, guard, approvalRevision, assertCreatePermission, assertProjectDispatch };
  }
  // unit: a project is a new task, but task/bot sends must never change recipient
  // permissions. Prior tests did not cover a permission choice or its receipt.
  it('forwards project creation permission once and includes it in request identity', async () => {
    const f = fixture();
    const request = { ...f.request, target: { kind: 'project', id: 'chosen' }, permissionMode: 'bypassPermissions' };
    await f.call(request);
    await f.call(request);
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.create.mock.calls[0]?.[7]).toBe('bypassPermissions');
    expect(f.send).toHaveBeenCalledOnce();
    await expect(f.call({ ...request, permissionMode: 'auto' }))
      .rejects.toMatchObject({ code: 'REQUEST_KEY_CONFLICT' });
  });
  it('rejects permission changes for existing targets and unsupported modes before delivery', async () => {
    const f = fixture();
    for (const kind of ['task', 'bot']) {
      await expect(f.call({ ...f.request, target: { kind, id: 'chosen' }, permissionMode: 'ask' }))
        .rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    }
    for (const permissionMode of ['acceptEdits', 'plan', null, 1]) {
      await expect(f.call({ ...f.request, target: { kind: 'project', id: 'chosen' }, permissionMode }))
        .rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    }
    expect(f.create).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(receipts.size).toBe(0);
  });
  it('does not consume the target request key when the creation permission is denied', async () => {
    const f = fixture();
    f.assertCreatePermission.mockImplementationOnce(() => { throw Object.assign(new Error('Not authorized'), { code: 'PERMISSION_DENIED' }); });
    const request = { ...f.request, target: { kind: 'project', id: 'chosen' }, permissionMode: 'auto' };
    await expect(f.call(request)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(receipts.size).toBe(0);
    expect(f.create).not.toHaveBeenCalled();
    await expect(f.call(request)).resolves.toMatchObject({ accepted: true });
  });
  // Unit regression for #7615: project inputs have target receipts, not tasks.send
  // receipts. Both delivery and restored queue acceptance must use the current
  // plugin dispatch policy; existing task/bot recipients keep their own policy.
  it('rejects a project input when its permission is lowered after task creation', async () => {
    const f = fixture();
    f.assertProjectDispatch.mockImplementation(async () => {
      const code = f.create.mock.calls.length ? 'PERMISSION_DENIED' : 'TASK_NOT_FOUND';
      throw Object.assign(new Error(code), { code });
    });
    await expect(f.call({ ...f.request, target: { kind: 'project', id: 'chosen' }, permissionMode: 'bypassPermissions' }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled();
    expect([...receipts.values()][0]?.status).toBe('pending');
  });
  it.each(['live', 'restored'] as const)('rechecks project permission before accepting a %s queued input', async phase => {
    const f = fixture();
    await f.call({ ...f.request, target: { kind: 'project', id: 'chosen' }, permissionMode: 'bypassPermissions' });
    f.assertProjectDispatch.mockRejectedValue(Object.assign(new Error('Permission lowered'), { code: 'PERMISSION_DENIED' }));
    const [, taskId, clientId, , , validateTarget] = f.send.mock.calls[0]!;
    const restarted = new PluginTargetSlot();
    restarted.adapter = f.slot.adapter;
    await expect(phase === 'live' ? validateTarget() : restarted.assertQueuedDelivery(taskId, clientId))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(f.send).toHaveBeenCalledOnce();
  });
  it.each(['task', 'bot'] as const)('keeps the recipient permission policy for an existing %s', async kind => {
    const f = fixture();
    f.assertProjectDispatch.mockRejectedValue(Object.assign(new Error('Plugin permission denied'), { code: 'PERMISSION_DENIED' }));
    await expect(f.call({ ...f.request, target: { kind, id: 'chosen' } })).resolves.toMatchObject({ accepted: true });
    const [, taskId, clientId] = f.send.mock.calls[0]!;
    await expect(f.slot.assertQueuedDelivery(taskId, clientId)).resolves.toBeUndefined();
    expect(f.assertProjectDispatch).not.toHaveBeenCalled();
  });
  it.each(['approval', 'cancelled'] as const)('rechecks the receipt when %s changes during project policy validation', async change => {
    const f = fixture();
    await f.call({ ...f.request, target: { kind: 'project', id: 'chosen' }, permissionMode: 'bypassPermissions' });
    f.assertProjectDispatch.mockImplementationOnce(async () => {
      if (change === 'approval') f.approvalRevision.mockReturnValue('replacement-install');
      else await f.call({ kind: 'cancel', requestKey: f.request.requestKey });
    });
    const [, taskId, clientId] = f.send.mock.calls[0]!;
    await expect(f.slot.assertQueuedDelivery(taskId, clientId)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
  // unit: actual target delivery must bind context to its receipt. Omitting the
  // new parameter previously made changed context replay as the same message.
  it('delivers independent context once and rejects changed context on receipt replay', async () => {
    const f = fixture();
    const request = { ...f.request, text: 'Look here', context: 'Window contents' };
    await f.call(request);
    await f.call(request);
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.send.mock.calls[0]?.[3]).toBe('Look here');
    expect(f.send.mock.calls[0]?.[8]).toEqual({ context: 'Window contents' });
    await expect(f.call({ ...request, context: 'Another window' }))
      .rejects.toMatchObject({ code: 'REQUEST_KEY_CONFLICT' });
  });
  it('opts new project tasks into automatic naming and never renames existing targets', async () => {
    const f = fixture();
    const schedule = vi.fn();
    f.slot.adapter!.scheduleAutoTitle = schedule;
    const request = { ...f.request, target: { kind: 'project', id: 'chosen' }, autoTitle: true };
    await f.call(request);
    await f.call(request);
    expect(f.create.mock.calls[0]?.[6]).toBe(true);
    expect(schedule).toHaveBeenCalledOnce();
    for (const targetKind of ['task', 'bot']) {
      await expect(f.call({ ...request, requestKey: targetKind, target: { kind: targetKind, id: 'chosen' } }))
        .rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    }
  });
  // Unit regression: execute the real public IPC callback with the real target slot.
  // Slot-only tests miss the outer error mapping; an invalid parent must not look retryable.
  it.each([
    ['INVALID_INVOCATION', 'INVALID_INVOCATION'],
    ['TASK_BUSY', 'TASK_BUSY'],
    ['private adapter failure', 'HOST_NOT_READY'],
  ])('preserves the public target error boundary for %s', async (cause, expected) => {
    const f = fixture();
    f.slot.adapter!.prepareInvocation = () => { throw Object.assign(new Error(cause), { code: cause }); };
    const { send } = loadPipe({
      ghostIdForLogicWebContents: () => 'plugin',
      requireGhostAvailableForActiveSession: () => {},
      getActiveDataOwnerPushStamp: () => ({ dataOwnerId: 'owner', ownerGeneration: 1 }),
      findGhostForInstanceId: () => ({ manifest: { agent: { targets: true } } }),
      handlePluginTaskRequest: async () => ({ ok: true }),
      pluginTaskHandler: null,
      requestPluginTaskApproval: async () => true,
      pluginTargetAuthorizationRevision: f.approvalRevision,
      pluginTargetSlot: f.slot,
    });
    const result = await send({ sender: { id: 1, isDestroyed: () => false } }, {
      ...f.request, type: 'targets-request', invocationId: 'invalid-parent',
    });
    expect(result).toEqual({
      ok: false, error: { code: expected, message: expected, retryable: expected === 'TASK_BUSY' },
    });
    expect(f.send).not.toHaveBeenCalled();
    expect(receipts.size).toBe(0);
  });
  // Production entry: PluginTargetSlot.handle, called by the authorized logic-page pipe.
  // Contract: query/resolve without UI, explicit target delivery, durable deduplication and cancellation.
  // In-memory unit tier; storage and runner adapters are mocked, not the public entry.
  it('records accepted target input once and preserves the Host parent across receipt replay', async () => {
    const f = fixture();
    const accepted: string[] = [];
    f.slot.adapter!.prepareInvocation = (_pluginId, _id, parent) => parent ?? 'host-root';
    f.slot.adapter!.acceptInvocation = (_pluginId, id) => { accepted.push(id); };
    const request = { ...f.request, invocationId: 'tool-parent' };
    await f.call(request);
    await f.call(request);
    expect(accepted).toEqual(['tool-parent']);
    expect([...receipts.values()][0]?.invocationId).toBe('tool-parent');
    expect(f.send).toHaveBeenCalledOnce();
  });

  it.each(['project', 'task', 'bot'])('queries and resolves %s metadata without changing delivery state', async (kind) => {
    const f = fixture();
    const target = { kind, id: 'chosen' };
    const view = { ...target, label: 'Chosen target', detail: '/workspace/example' };
    expect(await f.call({ kind: 'list', targetKind: kind })).toEqual({ targets: [view] });
    expect(await f.call({ kind: 'resolve', target })).toEqual(view);
    expect(receipts.size).toBe(0);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('rejects a missing fixed target instead of selecting a substitute', async () => {
    const f = fixture();
    f.candidates.mockResolvedValue([{ id: 'other', label: 'Other target', detail: '' }]);
    await expect(f.call({ kind: 'resolve', target: f.request.target }))
      .rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
    await expect(f.call(f.request)).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
    expect(f.send).not.toHaveBeenCalled();
  });
  it.each([false, true, 'ultrafast'] as const)('creates in the specified project with fastMode %s', async (fastMode) => {
    const f = fixture();
    const route = { agentKind: 'codex', providerId: 'provider', model: 'model', effort: '', fastMode };
    const result = await f.call({ ...f.request, target: { kind: 'project', id: 'chosen' }, route, title: 'New task' });
    expect(result).toMatchObject({ accepted: true, delivery: 'queue' });
    expect(f.create).toHaveBeenCalledWith('plugin', 'chosen', expect.any(String), 'New task', route, expect.any(Function));
    expect(f.send.mock.calls[0]?.[1]).toBe(f.create.mock.calls[0]?.[2]);
  });
  it('carries screenshot bytes once and rejects a changed attachment on the same receipt', async () => {
    const f = fixture();
    const base64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
    const request = { ...f.request, attachments: [{ base64, name: 'window.png' }] };
    await Promise.all([f.call(request), f.call(structuredClone(request))]);
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.send.mock.calls[0]?.[7]?.[0]).toMatchObject({ mimeType: 'image/png', name: 'window.png' });
    await expect(f.call({ ...request, attachments: [{ base64, name: 'other.png' }] }))
      .rejects.toMatchObject({ code: 'REQUEST_KEY_CONFLICT' });
    expect(JSON.stringify([...receipts.values()])).not.toContain(base64);
    expect(JSON.stringify([...receipts.values()])).not.toContain('window.png');
  });
  it('rejects a forged media URL before creating or sending a target task', async () => {
    const f = fixture();
    await expect(f.call({ ...f.request, target: { kind: 'project', id: 'chosen' },
      attachments: [{ url: 'cindy-media://blobs/foreign.png' }] }))
      .rejects.toMatchObject({ code: 'INVALID_ATTACHMENTS' });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it.each([undefined, 'queue', 'steer'] as const)('preserves requested delivery %s and reports actual delivery', async (delivery) => {
    const f = fixture();
    const request = { ...f.request, delivery };
    expect(await f.call(request)).toMatchObject({ accepted: true, delivery: 'queue' });
    expect(f.send.mock.calls[0]?.[6]).toBe(delivery ?? 'queue');
    await expect(f.call({ ...request, delivery: delivery === 'steer' ? 'queue' : 'steer' }))
      .rejects.toMatchObject({ code: 'REQUEST_KEY_CONFLICT' });
    expect(f.send).toHaveBeenCalledOnce();
  });
  it('reports steering and deduplicates an explicit queue retry', async () => {
    const f = fixture();
    f.send.mockResolvedValueOnce('steer');
    expect(await f.call({ ...f.request, requestKey: 'steer', delivery: 'steer' }))
      .toMatchObject({ accepted: true, delivery: 'steer' });
    await f.call(f.request);
    expect(await f.call({ ...f.request, delivery: 'queue' })).toMatchObject({ delivery: 'queue' });
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it.each([
    { delivery: 'interrupt' },
    { target: { kind: 'project', id: 'chosen' }, delivery: 'steer' },
    { target: { kind: 'task', id: 'chosen' }, route: {} },
    { target: { kind: 'remote', id: 'chosen' } },
  ])('rejects invalid delivery parameters %j before mutation', async (invalid) => {
    const f = fixture();
    await expect(f.call({ ...f.request, ...invalid })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });
  it('replays a completed receipt after Host restart without redelivery and isolates plugin keys', async () => {
    const f = fixture();
    const result = await f.call(f.request);
    const restarted = new PluginTargetSlot();
    restarted.adapter = f.slot.adapter;
    expect(await restarted.handle('plugin', f.request, f.guard)).toEqual(result);
    expect(f.send).toHaveBeenCalledOnce();
    await f.call(f.request, 'another-plugin');
    expect(f.send).toHaveBeenCalledTimes(2);
    await expect(f.call({ ...f.request, text: 'different' })).rejects.toMatchObject({ code: 'REQUEST_KEY_CONFLICT' });
  });
  it('does not retry an interrupted project creation after Host restart', async () => {
    const f = fixture();
    f.create.mockRejectedValueOnce(new Error('interrupted'));
    const request = { ...f.request, target: { kind: 'project', id: 'chosen' } };
    await expect(f.call(request)).rejects.toThrow('interrupted');
    const restarted = new PluginTargetSlot();
    restarted.adapter = f.slot.adapter;
    await expect(restarted.handle('plugin', request, f.guard)).rejects.toMatchObject({ code: 'DELIVERY_UNCERTAIN' });
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('rejects late sends even when cancelled before send or Host restart', async () => {
    const f = fixture();
    await f.call({ kind: 'cancel', requestKey: f.request.requestKey });
    const restarted = new PluginTargetSlot();
    restarted.adapter = f.slot.adapter;
    await expect(restarted.handle('plugin', f.request, f.guard)).rejects.toMatchObject({ code: 'SUPERSEDED' });
    expect(f.send).not.toHaveBeenCalled();
  });
  it('cancels a send waiting for target discovery without creating or delivering', async () => {
    const f = fixture();
    const waiting = deferred<Array<{ id: string; label: string; detail: string }>>();
    f.candidates.mockReturnValueOnce(waiting.promise);
    const send = f.call(f.request);
    const rejected = expect(send).rejects.toMatchObject({ code: 'SUPERSEDED' });
    await f.call({ kind: 'cancel', requestKey: f.request.requestKey });
    waiting.resolve([{ id: 'chosen', label: 'Chosen target', detail: '' }]);
    await rejected;
    expect(f.send).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });
  it('withdraws only the input clientId reserved by this plugin request', async () => {
    const f = fixture();
    await f.call(f.request);
    const input = f.send.mock.calls[0]!;
    await f.call({ kind: 'cancel', requestKey: f.request.requestKey });
    expect(f.withdraw).toHaveBeenCalledWith(input[1], input[2], f.guard);
    await expect(f.call(f.request)).rejects.toMatchObject({ code: 'SUPERSEDED' });
  });
  it('keeps cancellation effective when the provider acknowledges after cancellation', async () => {
    const f = fixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    f.send.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return 'queue';
    });
    const send = f.call(f.request);
    const rejected = expect(send).rejects.toMatchObject({ code: 'SUPERSEDED' });
    await entered.promise;
    await f.call({ kind: 'cancel', requestKey: f.request.requestKey });
    release.resolve();
    await rejected;
    const restarted = new PluginTargetSlot();
    restarted.adapter = f.slot.adapter;
    await expect(restarted.handle('plugin', f.request, f.guard)).rejects.toMatchObject({ code: 'SUPERSEDED' });
    expect(f.send).toHaveBeenCalledOnce();
    const input = f.send.mock.calls[0]!;
    expect(f.withdraw.mock.calls.every(([taskId, clientId]) => taskId === input[1] && clientId === input[2])).toBe(true);
  });
  it('rechecks authorization after asynchronous discovery', async () => {
    const f = fixture();
    f.candidates.mockImplementationOnce(async () => {
      f.guard.mockImplementation(() => { throw Object.assign(new Error('revoked'), { code: 'PERMISSION_DENIED' }); });
      return [{ id: 'chosen', label: 'Chosen target', detail: '' }];
    });
    await expect(f.call(f.request)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(receipts.size).toBe(0);
  });
  it('rechecks the canonical companion session immediately before delivery', async () => {
    const f = fixture();
    f.slot.adapter!.session = vi.fn().mockResolvedValueOnce('old-session').mockResolvedValue('new-session');
    await expect(f.call({ ...f.request, target: { kind: 'bot', id: 'chosen' } }))
      .rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
    expect(f.send).not.toHaveBeenCalled();
  });
  // Production queue acceptance reuses this entry for live and restored snapshots.
  // Regression: callbacks in memory disappear on restart; a saved clientId must still
  // reject revocation/cancellation and canonical changes before the provider starts (unit).
  it.each(['disabled', 'new approval', 'cancelled', 'missing target', 'canonical changed'] as const)(
    'rejects restored queued delivery when %s', async change => {
      const f = fixture();
      await f.call(f.request);
      const [, taskId, clientId] = f.send.mock.calls[0]!;
      if (change === 'disabled') f.approvalRevision.mockReturnValue(null);
      if (change === 'new approval') f.approvalRevision.mockReturnValue('replacement-install');
      if (change === 'cancelled') await f.call({ kind: 'cancel', requestKey: f.request.requestKey });
      if (change === 'missing target') f.candidates.mockResolvedValue([]);
      if (change === 'canonical changed') f.slot.adapter!.session = async () => 'new-session';
      const restarted = new PluginTargetSlot();
      restarted.adapter = f.slot.adapter;
      await expect(restarted.assertQueuedDelivery(taskId, clientId)).rejects.toMatchObject({
        code: change === 'missing target' || change === 'canonical changed' ? 'TARGET_UNAVAILABLE' : 'PERMISSION_DENIED',
      });
    },
  );
  it('accepts an authorized restored receipt without needing its original logic page', async () => {
    const f = fixture();
    await f.call(f.request);
    const [, taskId, clientId] = f.send.mock.calls[0]!;
    const restarted = new PluginTargetSlot();
    restarted.adapter = f.slot.adapter;
    await expect(restarted.assertQueuedDelivery(taskId, clientId)).resolves.toBeUndefined();
    expect(f.send).toHaveBeenCalledOnce();
  });

});
