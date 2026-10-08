import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import {
  createQueueReorderAdapter,
  createSessionQueueControlService,
  type QueueReorderCoordinator,
} from '../sessionQueueControl.js';

function queued(clientId = 'queued-1'): AgentInputQueuedMessage {
  return {
    clientId,
    text: 'before',
    persistedContent: 'before',
    model: 'model',
    effort: 'medium',
    permissionMode: 'default',
    workingDir: '/repo',
    chatMessage: { clientId, role: 'user', content: 'before' },
    createOpts: {
      agentKind: 'pi',
      workingDir: '/repo',
      model: 'model',
      effort: 'medium',
      permissionMode: 'default',
    },
  };
}

const noReorder = {
  steerQueuedMessage: vi.fn(async () => ({ kind: 'gone' as const })),
  moveQueuedMessage: vi.fn(() => null),
};

describe('session queue control service', () => {
  it('shares authorization, content rebuild and atomic replace for update', async () => {
    const item = queued();
    const replaceQueuedMessage = vi.fn(() => true);
    const service = createSessionQueueControlService({
      getSnapshot: vi.fn(async () => ({ pendingQueue: [item], consumingClientIds: [] })),
      replaceQueuedMessage,
      removeQueuedMessage: vi.fn(() => true),
      ...noReorder,
    });

    await expect(
      service.update({
        sessionId: 'session-1',
        queuedMessageId: item.clientId,
        message: 'after',
        authorize: () => ({ ok: true }),
        rebuild: (entry, message) => ({
          ...entry,
          text: message,
          persistedContent: message,
          chatMessage: { ...entry.chatMessage, content: message },
        }),
      }),
    ).resolves.toEqual({ ok: true, queuedMessageId: item.clientId });
    expect(replaceQueuedMessage).toHaveBeenCalledWith(
      'session-1',
      item.clientId,
      expect.objectContaining({ text: 'after', persistedContent: 'after' }),
      item,
    );
  });

  it.each(['update', 'cancel'])('preserves a same-id replacement across authority await for %s', async action => {
    let item = queued();
    const replacement = queued(); replacement.text = 'new user message';
    const inputCoordinator = {
      hasQueuedItemWhere: (_id: string, predicate: (entry: AgentInputQueuedMessage) => boolean) => predicate(item),
      replaceQueuedMessage: vi.fn((_id, _clientId, next) => { item = next; return true; }),
      remove: vi.fn(),
    };
    const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');
    const start = source.indexOf('    removeQueuedMessage:', source.indexOf('  const orcaTeamService ='));
    const adapter = source.slice(start, source.indexOf('    mergeQueuedMessages:', start));
    const mutations = new Function('inputCoordinator', ts.transpileModule(`return ({${adapter}});`, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)(inputCoordinator);
    const service = createSessionQueueControlService({
      getSnapshot: async () => ({pendingQueue:[item], consumingClientIds:[]}), ...mutations, ...noReorder,
    });
    const params = {sessionId:'session',queuedMessageId:item.clientId,authorize:()=>({ok:true as const}),beforeMutation:async()=>{item=replacement;}};
    const result = action === 'cancel' ? await service.cancel(params) : await service.update({...params,message:'overwrite',rebuild:(entry,message)=>({...entry,text:message})});
    expect(result.ok).toBe(false);
    expect(item).toBe(replacement);
    expect(inputCoordinator.replaceQueuedMessage).not.toHaveBeenCalled();
    expect(inputCoordinator.remove).not.toHaveBeenCalled();
  });

  it('rejects consuming and unauthorized rows before mutation', async () => {
    const item = queued();
    const replaceQueuedMessage = vi.fn(() => true);
    const removeQueuedMessage = vi.fn(() => true);
    const consuming = createSessionQueueControlService({
      getSnapshot: vi.fn(async () => ({
        pendingQueue: [item],
        consumingClientIds: [item.clientId],
      })),
      replaceQueuedMessage,
      removeQueuedMessage,
      ...noReorder,
    });
    await expect(
      consuming.cancel({
        sessionId: 'session-1',
        queuedMessageId: item.clientId,
        authorize: () => ({ ok: true }),
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'MESSAGE_CONSUMING' });

    const unauthorized = createSessionQueueControlService({
      getSnapshot: vi.fn(async () => ({ pendingQueue: [item], consumingClientIds: [] })),
      replaceQueuedMessage,
      removeQueuedMessage,
      ...noReorder,
    });
    await expect(
      unauthorized.cancel({
        sessionId: 'session-1',
        queuedMessageId: item.clientId,
        authorize: () => ({ ok: false, message: 'not yours' }),
      }),
    ).resolves.toEqual({ ok: false, errorCode: 'NOT_AUTHORIZED', message: 'not yours' });
    expect(replaceQueuedMessage).not.toHaveBeenCalled();
    expect(removeQueuedMessage).not.toHaveBeenCalled();
  });

  it('reclassifies a replace/remove race as consuming when dispatch won', async () => {
    const item = queued();
    const getSnapshot = vi
      .fn()
      .mockResolvedValueOnce({ pendingQueue: [item], consumingClientIds: [] })
      .mockResolvedValueOnce({ pendingQueue: [], consumingClientIds: [item.clientId] });
    const service = createSessionQueueControlService({
      getSnapshot,
      replaceQueuedMessage: vi.fn(() => false),
      removeQueuedMessage: vi.fn(() => false),
      ...noReorder,
    });
    await expect(
      service.cancel({
        sessionId: 'session-1',
        queuedMessageId: item.clientId,
        authorize: () => ({ ok: true }),
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'MESSAGE_CONSUMING' });
  });

  it('steers and moves through the same locate/authorize/race boundary', async () => {
    const item = queued();
    const steerQueuedMessage = vi.fn(async () => ({ kind: 'queued' as const, reason: 'NO_ACTIVE_TURN' as const }));
    const moveQueuedMessage = vi.fn((): number | null | 'locked' => 2);
    const getSnapshot = vi.fn(async () => ({ pendingQueue: [item], consumingClientIds: [] as string[] }));
    const service = createSessionQueueControlService({
      getSnapshot,
      replaceQueuedMessage: vi.fn(),
      removeQueuedMessage: vi.fn(),
      steerQueuedMessage,
      moveQueuedMessage,
    });
    const params = { sessionId: 's', queuedMessageId: item.clientId, authorize: () => ({ ok: true as const }) };
    await expect(service.steer(params)).resolves.toEqual({
      ok: true, queuedMessageId: item.clientId, delivery: 'queued', reason: 'NO_ACTIVE_TURN',
    });
    await expect(service.move({ ...params, position: 5 }))
      .resolves.toEqual({ ok: true, queuedMessageId: item.clientId, position: 2 });

    moveQueuedMessage.mockReturnValueOnce(null);
    getSnapshot.mockResolvedValueOnce({ pendingQueue: [item], consumingClientIds: [] })
      .mockResolvedValueOnce({ pendingQueue: [], consumingClientIds: [item.clientId] });
    await expect(service.move({ ...params, position: 0 }))
      .resolves.toMatchObject({ ok: false, errorCode: 'MESSAGE_CONSUMING' });
    moveQueuedMessage.mockReturnValueOnce('locked');
    await expect(service.move({ ...params, position: 0 }))
      .resolves.toMatchObject({ ok: false, errorCode: 'MESSAGE_CONSUMING', message: expect.stringContaining('being edited') });

    await expect(service.steer({ ...params, authorize: () => ({ ok: false, message: 'no' }) }))
      .resolves.toMatchObject({ ok: false, errorCode: 'NOT_AUTHORIZED' });
    expect(steerQueuedMessage).toHaveBeenCalledOnce();
  });
});

describe('queue reorder adapter', () => {
  function setup(live: { running?: boolean; supported?: boolean; remote?: string | null } | null) {
    let queue = ['a', 'b', 'c', 'd'].map((id) => queued(id));
    let paused = false;
    const editLocks: string[] = [];
    const steering: string[] = [];
    const coordinator: QueueReorderCoordinator = {
      steerControlInput: vi.fn(async () => 'steered' as const),
      isQueuePaused: () => paused,
      getQueueControlSnapshot: () => ({ pendingQueue: queue }),
      getProjection: () => ({ queueEditLocks: editLocks, steeringQueueClientIds: steering }),
      move: vi.fn((_sessionId: string, clientId: string, targetIndex: number) => {
        // Mirrors AgentInputCoordinator.move: insert before original index targetIndex.
        const from = queue.findIndex((entry) => entry.clientId === clientId);
        const next = [...queue];
        const [entry] = next.splice(from, 1);
        let insert = Math.max(0, Math.min(targetIndex, queue.length));
        if (from < insert) insert -= 1;
        next.splice(insert, 0, entry!);
        queue = next;
      }),
    };
    const session = live && {
      isTurnRunning: () => live.running ?? true,
      getTurnGeneration: () => 3,
      capabilities: { sameTurnSteer: { supported: live.supported ?? true } },
      remoteHostId: live.remote ?? null,
    };
    const adapter = createQueueReorderAdapter({
      getLiveSession: () => session,
      hasSendToSessionLock: () => false,
      getCoordinator: () => coordinator,
    });
    return {
      adapter,
      coordinator,
      order: () => queue.map((entry) => entry.clientId),
      pause: () => { paused = true; },
      lockEdit: (clientId: string) => { editLocks.push(clientId); },
      startSteering: (clientId: string) => { steering.push(clientId); },
      drop: (clientId: string) => { queue = queue.filter((entry) => entry.clientId !== clientId); },
    };
  }

  it.each([
    [0, ['c', 'a', 'b', 'd'], 0],
    [1, ['a', 'c', 'b', 'd'], 1],
    [2, ['a', 'b', 'c', 'd'], 2],
    [3, ['a', 'b', 'd', 'c'], 3],
    [9, ['a', 'b', 'd', 'c'], 3],
  ])('moves a waiting row to final position %i', (position, expected, finalIndex) => {
    const h = setup({});
    expect(h.adapter.moveStoredControlMessage('s', 'c', position)).toBe(finalIndex);
    expect(h.order()).toEqual(expected);
    expect(h.adapter.moveStoredControlMessage('s', 'missing', 0)).toBeNull();
  });

  it('keeps a row the user is editing in place', () => {
    const h = setup({});
    h.lockEdit('c');
    expect(h.adapter.moveStoredControlMessage('s', 'c', 0)).toBe('locked');
    expect(h.order()).toEqual(['a', 'b', 'c', 'd']);
    expect(h.coordinator.move).not.toHaveBeenCalled();
  });

  it('reports a row that started steering as gone instead of claiming the move', () => {
    const h = setup({});
    h.startSteering('c');
    expect(h.adapter.moveStoredControlMessage('s', 'c', 0)).toBeNull();
    expect(h.coordinator.move).not.toHaveBeenCalled();
  });

  it('maps live capability and coordinator outcomes to steer receipts', async () => {
    expect(await setup(null).adapter.steerStoredControlMessage('s', 'a'))
      .toEqual({ kind: 'queued', reason: 'NO_ACTIVE_TURN' });
    expect(await setup({ supported: false }).adapter.steerStoredControlMessage('s', 'a'))
      .toEqual({ kind: 'queued', reason: 'STEER_UNSUPPORTED' });
    expect(await setup({ remote: 'ssh-host' }).adapter.steerStoredControlMessage('s', 'a'))
      .toEqual({ kind: 'queued', reason: 'STEER_UNSUPPORTED' });

    const steered = setup({});
    expect(await steered.adapter.steerStoredControlMessage('s', 'b')).toEqual({ kind: 'steered' });
    expect(steered.coordinator.steerControlInput).toHaveBeenCalledWith(
      's', { queuedClientId: 'b' }, expect.objectContaining({ turnGeneration: 3 }),
    );

    const busy = setup({});
    vi.mocked(busy.coordinator.steerControlInput).mockResolvedValueOnce('not-attempted');
    expect(await busy.adapter.steerStoredControlMessage('s', 'b'))
      .toEqual({ kind: 'queued', reason: 'INPUT_BOUNDARY_BUSY' });

    const uncertain = setup({});
    vi.mocked(uncertain.coordinator.steerControlInput).mockImplementationOnce(async () => {
      uncertain.pause();
      return 'queued';
    });
    expect(await uncertain.adapter.steerStoredControlMessage('s', 'b'))
      .toEqual({ kind: 'queued', reason: 'STEER_UNCERTAIN' });

    const gone = setup({});
    vi.mocked(gone.coordinator.steerControlInput).mockResolvedValueOnce('rejected');
    expect(await gone.adapter.steerStoredControlMessage('s', 'b')).toEqual({ kind: 'gone' });

    const raced = setup({});
    vi.mocked(raced.coordinator.steerControlInput).mockImplementationOnce(async () => {
      raced.drop('b');
      return 'not-attempted';
    });
    expect(await raced.adapter.steerStoredControlMessage('s', 'b')).toEqual({ kind: 'gone' });
  });
});
