import { describe, expect, it, vi } from "vitest";
import { formatRemoteError, isAutoRecoveringRemoteError } from '@/device-link/remoteStatus';
import { uploadMobileAttachmentFromFile } from '@/session/mobileAttachmentUpload';
import { accountVaultKey } from '@cindy/auth-client';
import { cancelledCreationDraft, outboxCreationRetryIdentity } from '../session/cancelledCreationDraft';
import { cindyMakeOutboxPolicy } from '../session/cindyMakeOutboxPolicy';
import {
  createDurableOutbox,
  isDurableOutboxUnsent,
  observeDurableOutboxSending,
  type DurableOutboxRecord,
  type OutboxStorage,
} from "../session/durableOutbox";
import {
  bindOutboxProjection,
  createDurableOutboxDelivery,
  type DeliveryProjection,
} from "../session/durableOutboxDelivery";
import type { QueuedRemoteMessage, RemoteMessage, RemoteSession } from "../session/types";
import { remoteSessionStore } from "../session/remoteSessionStore";
import { appendOptimisticUserMessage, projectOptimisticUserMessages, type OptimisticUserMessage } from '../session/optimisticUserMessages';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function disk(): OutboxStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getAllKeys: async () => [...data.keys()],
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => {
      data.set(k, v);
    },
    removeItem: async (k) => {
      data.delete(k);
    },
  };
}
function message(
  clientId = "id-1",
  sessionId = "session-a",
): DurableOutboxRecord {
  return {
    version: 1,
    accountId: "alice",
    deviceId: "mac-a",
    createdAt: 1,
    state: "queued",
    uploads: [],
    item: {
      clientId,
      sessionId,
      text: "keep this message",
      quotesEncoded: false,
      agentReferences: [],
      pastedTextRanges: [],
      slashCommandRanges: [],
      permissionModeAtSend: "plan",
      attachmentSlots: [],
      slotMeta: [],
      slotByLocalId: {},
      waitingIds: [],
      failedIds: [],
      enqueueError: null,
      phase: "uploading",
    },
  };
}

describe('cancelled worktree draft recovery across restarts', () => {
  it('retains one durable record and its attachments while successive retries rotate remote IDs', async () => {
    const storage = disk();
    let store = createDurableOutbox(storage);
    await store.activate('alice');
    const initial = message();
    initial.creation = {
      draft: { workingDir: '/repo/.cindy-worktrees/failed', firstMessage: initial.item.text } as NonNullable<DurableOutboxRecord['creation']>['draft'],
      originalWorkingDir: '/repo/subdir', deviceName: 'Mac', planModeArm: false, restorePermissionMode: null,
    };
    initial.uploads = [{ slot: 0, fileName: 'slot-0.png', name: 'image.png', kind: 'image', size: 12 }];
    await store.add(initial);
    const originalKey = [...storage.data.keys()][0];
    for (const newId of ['retry-1', 'retry-2']) {
      // Cold start, host cancellation ACK, persist, another cold start, then user resubmits.
      store = createDurableOutbox(storage);
      await store.activate('alice');
      let row = store.getSnapshot()[0];
      await store.update(row, cancelledCreationDraft(row));
      store = createDurableOutbox(storage);
      await store.activate('alice');
      row = store.getSnapshot()[0];
      expect(row.creation?.draft.workingDir).toBe('/repo/subdir');
      expect(row.suspended).toBe(true);
      const identity = outboxCreationRetryIdentity(row, () => newId);
      expect(identity.sessionId).toBe(newId);
      await store.update(row, { storageSessionId: identity.storageSessionId,
        item: { ...row.item, sessionId: identity.sessionId },
        creation: { ...row.creation!, cancelled: undefined }, suspended: false,
      });
      store = createDurableOutbox(storage);
      await store.activate('alice');
      expect(store.getSnapshot()).toHaveLength(1);
      expect(store.getSnapshot()[0]).toMatchObject({ item: { sessionId: newId, text: initial.item.text }, uploads: initial.uploads });
      expect([...storage.data.keys()]).toEqual([originalKey]);
    }
    await store.remove(store.getSnapshot()[0]);
    expect(storage.data.size).toBe(0);
  });

  it('preserves the cancelled draft after a failed resubmission write', async () => {
    const storage = disk();
    const store = createDurableOutbox(storage);
    await store.activate('alice');
    const initial = message();
    initial.creation = { draft: { workingDir: 'D:\\repo\\.cindy-worktrees\\failed' } as NonNullable<DurableOutboxRecord['creation']>['draft'],
      deviceName: 'PC', planModeArm: false, restorePermissionMode: null };
    const row = cancelledCreationDraft(initial);
    expect(row.creation?.draft.workingDir).toBe('D:\\repo');
    await store.add(row);
    storage.setItem = async () => { throw new Error('disk full'); };
    const identity = outboxCreationRetryIdentity(row, () => 'fresh');
    await expect(store.update(row, { storageSessionId: identity.storageSessionId,
      item: { ...row.item, sessionId: identity.sessionId } })).rejects.toThrow('disk full');
    const restarted = createDurableOutbox(storage);
    await restarted.activate('alice');
    expect(restarted.getSnapshot()[0]).toEqual(row);
  });
});
function projection(
  clientId = "id-1",
  state: "unknown" | "pending" | "accepted" | "removed" = "unknown",
): DeliveryProjection {
  return {
    pendingQueue: [],
    inputDeliveryVersion: 1,
    clearBoundaryMs: null,
    deliveryReceipts: [{ clientId, state }],
  } as unknown as DeliveryProjection;
}
async function setup(storage = disk()) {
  const store = createDurableOutbox(storage);
  await store.activate("alice");
  let active = true;
  const deps = {
    store,
    isCurrent: () => active,
    canRun: () => true,
    projection: vi.fn(async (r: DurableOutboxRecord) =>
      projection(r.item.clientId),
    ),
    session: vi.fn(async (r: DurableOutboxRecord): Promise<{ id: string; status: string } | null> =>
      ({ id: r.item.sessionId, status: "active" }),
    ),
    prepare: vi.fn(
      async (r: DurableOutboxRecord) =>
        ({
          clientId: r.item.clientId,
          text: r.item.text,
        }) as QueuedRemoteMessage,
    ),
    upload: vi.fn(async () => ({
      id: "file-1",
      name: "photo.png",
      path: "oss-ref",
      ext: "png",
      size: 123,
      category: "image" as const,
      mimeType: "image/png",
    })),
    enqueue: vi.fn(async (_r: DurableOutboxRecord) => projection()),
    cancel: vi.fn(async () => true),
    history: vi.fn(async () => false),
    bindProjection: () => () => {},
    cleanup: vi.fn(async () => {}),
    discardUploads: vi.fn(),
    retryable: () => true,
    describe: () => "offline",
    confirmationMessage: "check receipt",
    clearedMessage: "task cleared",
  };
  const runner = createDurableOutboxDelivery(deps);
  return {
    store,
    deps,
    runner,
    storage,
    deactivate: () => {
      active = false;
    },
  };
}

// Unit, PR 11841: a killed phone can have a submitted first input but no host task.
// Existing receipt tests start with the task present. Restart from the persisted record
// and distinguish a missing host task, a lost create ACK and a deletion tombstone.
it.each(['missing', 'existing', 'deleted'] as const)('resumes an interrupted dialogue after restart: %s', async state => {
  const { store, storage, deps } = await setup();
  const record = message();
  record.creation = {
    draft: { workspaceKind: 'dialogue' } as NonNullable<DurableOutboxRecord['creation']>['draft'],
    deviceName: 'PC', needsHostCreation: true, planModeArm: false, restorePermissionMode: null,
  };
  await store.add(record);
  const cold = createDurableOutbox(storage);
  await cold.activate('alice');
  const createMissingDialogue = vi.fn(async () => true);
  await createDurableOutboxDelivery({
    ...deps, store: cold, createMissingDialogue,
    session: async () => {
      if (state === 'missing') throw Object.assign(new Error('Session absent'), { code: 'NOT_FOUND' });
      return { id: record.item.sessionId, status: state === 'deleted' ? 'deleted' : 'active' };
    },
  }).run();
  expect(createMissingDialogue).toHaveBeenCalledTimes(state === 'missing' ? 1 : 0);
  if (state === 'deleted') {
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(cold.getSnapshot()).toEqual([]);
  } else {
    expect(deps.enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      item: record.item, creation: expect.not.objectContaining({ needsHostCreation: true }),
    }));
  }
});

describe('disabled Cindy Make outbox recovery', () => {
  it.each(['cindy-make', 'cindy-make-merge'])('cleans upgraded %s records before contacting a legacy host', async (source) => {
    const { store, storage, deps } = await setup();
    await store.add(message());
    const restarted = createDurableOutbox(storage);
    await restarted.activate('alice');
    const readSession = vi.fn(async () => ({ id: 'session-a', source }));
    const delivery = createDurableOutboxDelivery({ ...deps, store: restarted,
      sessionPolicy: (record) => cindyMakeOutboxPolicy(record, {
        knownSession: () => ({ id: 'session-a', source }), readSession, isCurrent: () => true,
      }),
    });
    await delivery.run();
    delivery.wake();
    await delivery.run();
    expect(readSession).not.toHaveBeenCalled();
    expect(deps.projection).not.toHaveBeenCalled();
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(deps.upload).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.cancel).not.toHaveBeenCalled();
    expect(deps.cleanup).toHaveBeenCalledWith(expect.objectContaining({ cleanupOutcome: 'cancelled' }), true);
    const coldStart = createDurableOutbox(storage);
    await coldStart.activate('alice');
    expect(coldStart.getSnapshot()).toEqual([]);
  });

  it.each(['cindy-make', 'cindy-make-merge'])('reads missing metadata before discarding a legacy %s task', async (source) => {
    const { store, deps } = await setup();
    await store.add(message());
    const readSession = vi.fn(async () => ({ id: 'session-a', source }));
    await createDurableOutboxDelivery({ ...deps,
      sessionPolicy: (record) => cindyMakeOutboxPolicy(record, {
        knownSession: () => undefined, readSession, isCurrent: () => true,
      }),
    }).run();
    expect(readSession).toHaveBeenCalledOnce();
    expect(deps.projection).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toEqual([]);
  });

  it.each(['offline', 'missing', 'mismatch'])('retains an unknown record on %s and resumes ordinary delivery after recovery', async (failure) => {
    const { store, storage, deps } = await setup();
    await store.add(message());
    const readSession = vi.fn<() => Promise<{ id: string; source?: string } | null>>()
      .mockResolvedValue({ id: 'session-a', source: 'cc' });
    if (failure === 'offline') readSession.mockRejectedValueOnce(new Error('offline'));
    else readSession.mockResolvedValueOnce(failure === 'missing' ? null : { id: 'another', source: 'cc' });
    const delivery = createDurableOutboxDelivery({ ...deps,
      sessionPolicy: (record) => cindyMakeOutboxPolicy(record, {
        knownSession: () => undefined, readSession, isCurrent: () => true,
      }),
    });
    await delivery.run();
    expect(store.getSnapshot()).toEqual([message()]);
    expect(deps.projection).not.toHaveBeenCalled();
    expect(deps.cleanup).not.toHaveBeenCalled();
    const coldStart = createDurableOutbox(storage);
    await coldStart.activate('alice');
    expect(coldStart.getSnapshot()).toEqual([message()]);
    delivery.wake();
    await delivery.run();
    expect(deps.enqueue).toHaveBeenCalledOnce();
  });

  it('does not delete uploads possibly owned by a legacy host or block another task', async () => {
    const { store, deps } = await setup();
    await store.add({ ...message(), state: 'confirming', enqueueStarted: true, sendAtMs: 1 });
    await store.add(message('id-2', 'ordinary'));
    await createDurableOutboxDelivery({ ...deps,
      sessionPolicy: (record) => cindyMakeOutboxPolicy(record, {
        knownSession: () => ({ id: record.item.sessionId, source: record.item.sessionId === 'ordinary' ? 'cc' : 'cindy-make' }),
        readSession: async () => null, isCurrent: () => true,
      }),
    }).run();
    expect(deps.cleanup).toHaveBeenCalledWith(expect.objectContaining({ cleanupOutcome: 'accepted' }), false);
    expect(deps.enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ item: expect.objectContaining({ sessionId: 'ordinary' }) }));
    expect(store.getSnapshot().every(record => record.item.sessionId === 'ordinary')).toBe(true);
  });

  it('keeps a disabled terminal record retryable after local cleanup fails', async () => {
    const { store, storage, deps } = await setup();
    await store.add(message());
    deps.cleanup.mockRejectedValueOnce(new Error('files unavailable'));
    const delivery = createDurableOutboxDelivery({ ...deps, sessionPolicy: async () => 'discard' });
    await delivery.run();
    const coldStart = createDurableOutbox(storage);
    await coldStart.activate('alice');
    expect(coldStart.getSnapshot()[0]).toMatchObject({ cleanupOutcome: 'cancelled' });
    await createDurableOutboxDelivery({ ...deps, store: coldStart, sessionPolicy: async () => 'discard' }).run();
    expect(coldStart.getSnapshot()).toEqual([]);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it('does not consume a record after the owner changes during metadata lookup', async () => {
    const { store, deps, deactivate } = await setup();
    await store.add(message());
    await createDurableOutboxDelivery({ ...deps,
      sessionPolicy: (record) => cindyMakeOutboxPolicy(record, {
        knownSession: () => undefined,
        readSession: async () => { deactivate(); return { id: 'session-a', source: 'cindy-make' }; },
        isCurrent: deps.isCurrent,
      }),
    }).run();
    expect(store.getSnapshot()).toEqual([message()]);
    expect(deps.cleanup).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
  });
});

describe("durable mobile outbox ownership", () => {
  it.each([
    Object.assign(new Error('Message 不存在'), { code: 'NOT_FOUND' }),
    new Error('[NOT_FOUND] Message 不存在'),
  ])('waits for host receipts when pending history is missing (%s)', async (error) => {
    const { store, deps, runner } = await setup();
    await store.add({ ...message(), state: 'host-owned', retrySafe: true, error: '[NOT_FOUND] Message 不存在' });
    deps.projection.mockResolvedValue(projection('id-1', 'pending'));
    deps.history.mockRejectedValue(error);
    await runner.run();
    expect(store.getSnapshot()[0]).toMatchObject({ state: 'host-owned' });
    expect(store.getSnapshot()[0].error).toBeUndefined();
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.cleanup).not.toHaveBeenCalled();

    // Withdrawal can overtake the history lookup. Only the next host receipt
    // proves removal; missing history alone must never delete or resend the row.
    deps.projection.mockResolvedValue(projection('id-1', 'removed'));
    runner.wake();
    await runner.run();
    expect(store.getSnapshot()).toEqual([]);
    expect(deps.history).toHaveBeenCalledOnce();
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.cleanup).toHaveBeenCalledOnce();
  });

  it('keeps a legacy send uncertain when its history is not found', async () => {
    const { store, deps, runner } = await setup();
    await store.add({ ...message(), state: 'confirming', prepared: { clientId: 'id-1' } as QueuedRemoteMessage });
    deps.projection.mockResolvedValue({ ...projection(), inputDeliveryVersion: undefined });
    deps.history.mockRejectedValue(new Error('[NOT_FOUND] Message 不存在'));
    await runner.run();
    expect(store.getSnapshot()[0]).toMatchObject({ state: 'failed', error: 'check receipt' });
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.cleanup).not.toHaveBeenCalled();
  });

  it('settles cleared legacy records without a saved boundary from the host receipt', async () => {
    const { store, deps, runner } = await setup();
    await store.add({ ...message(), state: 'host-owned', retrySafe: true });
    deps.projection.mockResolvedValue({ ...projection('id-1', 'removed'), clearBoundaryMs: 123 });
    await runner.run();
    runner.wake();
    await runner.run();
    expect(store.getSnapshot()).toEqual([]);
    expect(deps.projection).toHaveBeenCalledOnce();
    expect(deps.history).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.cleanup).toHaveBeenCalledWith(expect.anything(), false);
  });

  it('still reports other history lookup failures', async () => {
    const { store, deps, runner } = await setup();
    await store.add({ ...message(), state: 'host-owned', retrySafe: true });
    deps.projection.mockResolvedValue(projection('id-1', 'pending'));
    deps.history.mockRejectedValue(new Error('permission denied'));
    await runner.run();
    expect(store.getSnapshot()[0].error).toBe('offline');
    expect(deps.cleanup).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    [false, false, undefined, true],
    [true, false, 1, true],
    [true, true, 1, false],
    [true, undefined, 1, false],
    [false, true, 1, false],
    [false, undefined, 1, false],
    [false, undefined, undefined, true],
  ] as const)('offline disposal respects prepared=%s enqueueStarted=%s sendAtMs=%s', async (prepared, enqueueStarted, sendAtMs, unsent) => {
    const { store, storage } = await setup();
    const record = { ...message(), prepared: prepared ? { clientId: 'id-1' } as QueuedRemoteMessage : undefined, enqueueStarted, sendAtMs };
    expect(isDurableOutboxUnsent(record)).toBe(unsent);
    await store.add(record);
    await store.update(store.getSnapshot()[0]!, isDurableOutboxUnsent(record)
      ? { state: 'host-owned', cleanupOutcome: 'cancelled', cancelRequested: true }
      : { state: 'confirming', cancelRequested: true });
    // Cold restart, with the same offline gate used by the bridge.
    const { deps, store: restarted } = await setup(storage);
    deps.projection.mockRejectedValue(new Error('offline'));
    await createDurableOutboxDelivery({ ...deps, canRun: (r) => r.cleanupOutcome !== undefined }).run();
    expect(deps.projection).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(restarted.getSnapshot()).toHaveLength(unsent ? 0 : 1);
    expect(deps.cleanup).toHaveBeenCalledTimes(unsent ? 1 : 0);
  });

  it.each([false, true, undefined])('deleted prepared task respects enqueueStarted=%s', async (enqueueStarted) => {
    const { store, runner, deps } = await setup();
    await store.add({ ...message(), prepared: { clientId: 'id-1' } as QueuedRemoteMessage, enqueueStarted });
    deps.projection.mockRejectedValue(Object.assign(new Error('not found'), { code: 'NOT_FOUND' }));
    deps.session.mockResolvedValue({ id: 'session-a', status: 'deleted' });
    await runner.run();
    expect(deps.cleanup).toHaveBeenCalledWith(expect.anything(), enqueueStarted === false);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });
  it('recovers draft handoff before delivery and retains the proof when reconciliation fails', async () => {
    const storage = disk();
    const seed = createDurableOutbox(storage);
    await seed.activate('alice');
    const record = { ...message(), draftHandoff: {
      before: { version: 1 as const, nodes: [{ type: 'text' as const, text: 'sent' }] },
      after: { version: 1 as const, nodes: [] },
    } };
    await seed.add(record);
    const recover = vi.fn(async () => {});
    recover.mockRejectedValueOnce(new Error('draft storage busy'));
    const restarted = createDurableOutbox(storage, recover);
    await restarted.activate('alice');
    await expect(restarted.reconcileDrafts()).rejects.toThrow('draft storage busy');
    expect(restarted.getSnapshot()[0]?.draftHandoff).toEqual(record.draftHandoff);
    await restarted.reconcileDrafts();
    const again = createDurableOutbox(storage, recover);
    await again.activate('alice');
    await again.reconcileDrafts();
    expect(recover).toHaveBeenCalledTimes(2);
    expect(again.getSnapshot()[0]?.draftHandoff).toBeUndefined();
  });
  it('does not send before draft reconciliation succeeds or block a different task on its failure', async () => {
    const { deps, storage } = await setup();
    const recover = vi.fn(async () => { throw new Error('draft busy'); });
    const store = createDurableOutbox(storage, recover);
    await store.activate('alice');
    await store.add({ ...message(), draftHandoff: {
      before: { version: 1, nodes: [{ type: 'text', text: 'sent' }] },
      after: { version: 1, nodes: [] },
    } });
    await store.add(message('other', 'session-b'));
    const runner = createDurableOutboxDelivery({ ...deps, store });
    await runner.run();
    expect(deps.enqueue).toHaveBeenCalledOnce();
    expect(deps.enqueue.mock.calls[0]?.[0].item.clientId).toBe('other');
    expect(store.getSnapshot().find((r) => r.item.clientId === 'id-1')?.draftHandoff).toBeDefined();
  });
  // Unit, #11841: restart from the actual ledger on either side of a follow-up send.
  // A rejected write tests error recovery but does not reproduce losing the process before its receipt.
  it.each(['writing-send-marker', 'awaiting-receipt'] as const)('recovers a follow-up interrupted while %s', async phase => {
    const first = await setup();
    const id = 'follow-up';
    await first.store.add(message(id));
    const reached = deferred<void>();
    const resume = deferred<void>();
    const delivered: string[] = [];
    if (phase === 'writing-send-marker') {
      const write = first.storage.setItem;
      first.storage.setItem = async (key, value) => {
        if (JSON.parse(value).state === 'sending') {
          reached.resolve();
          await resume.promise;
          throw new Error('process stopped before the send marker was committed');
        }
        await write(key, value);
      };
    }
    first.deps.enqueue.mockImplementation(async r => {
      delivered.push(r.item.clientId);
      reached.resolve();
      await resume.promise;
      return projection(id, 'accepted');
    });
    const attempt = first.runner.run();
    await reached.promise;
    first.runner.stop();
    resume.resolve();
    await attempt;
    const recovered = await setup(first.storage);
    const [row] = recovered.store.getSnapshot();
    expect(isDurableOutboxUnsent(row!)).toBe(phase === 'writing-send-marker');
    if (phase === 'writing-send-marker') {
      // As in the offline cancel action, settle the unsent row locally and restart.
      await recovered.store.update(row!, { state: 'host-owned', cleanupOutcome: 'cancelled', cancelRequested: true });
    } else {
      recovered.deps.projection.mockImplementation(async r =>
        projection(r.item.clientId, delivered.includes(r.item.clientId) ? 'accepted' : 'unknown'));
    }
    await recovered.runner.run();
    if (phase === 'awaiting-receipt') {
      // Only the host receipt is available on this first reconnect.
      expect(recovered.store.getSnapshot()[0]).toMatchObject({ state: 'host-owned', item: { clientId: id } });
      recovered.deps.history.mockResolvedValue(true);
      recovered.runner.wake();
      await recovered.runner.run();
    }
    expect(delivered).toEqual(phase === 'writing-send-marker' ? [] : [id]);
    expect(recovered.deps.enqueue).not.toHaveBeenCalled();
    expect(recovered.store.getSnapshot()).toEqual([]);
    expect(recovered.deps.cleanup).toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ clientId: id }) }), phase === 'writing-send-marker');
  });
  it('keeps preparation explicitly unsent if the sending write fails before a crash', async () => {
    const { store, runner, deps, storage } = await setup();
    await store.add(message());
    const write = storage.setItem;
    vi.spyOn(storage, 'setItem').mockImplementation(async (key, value) => {
      if (JSON.parse(value).state === 'sending') throw new Error('disk busy');
      await write(key, value);
    });
    await runner.run();
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(store.getSnapshot()[0]).toMatchObject({ enqueueStarted: false, prepared: { clientId: 'id-1' } });
    const recovered = await setup(storage);
    recovered.deps.projection.mockRejectedValue(Object.assign(new Error('missing'), { code: 'NOT_FOUND' }));
    recovered.deps.session.mockResolvedValue({ id: 'session-a', status: 'deleted' });
    await recovered.runner.run();
    expect(recovered.deps.cleanup).toHaveBeenCalledWith(expect.anything(), true);
  });
  it.each([false, true])('cleans a positively deleted task even when cancellation is %s', async (cancelRequested) => {
    const { store, runner, deps } = await setup();
    await store.add({ ...message(), cancelRequested, state: 'confirming',
      prepared: { clientId: 'id-1' } as QueuedRemoteMessage });
    deps.projection.mockRejectedValue(new Error('[NOT_FOUND] Session session-a not found'));
    deps.session.mockResolvedValue({ id: 'session-a', status: 'deleted' });
    await runner.run();
    expect(deps.cleanup).toHaveBeenCalledWith(expect.objectContaining({ cleanupOutcome: 'accepted' }), false);
    expect(store.getSnapshot()).toEqual([]);
    expect(deps.cancel).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
  });
  it.each(['active', 'absent', 'wrong-id', 'unavailable', 'hidden', 'timeout'] as const)(
    'retains an uncreated first message when deletion evidence is %s', async (evidence) => {
      const { store, runner, deps, storage } = await setup();
      await store.add({ ...message(), creation: { draft: {} } as DurableOutboxRecord['creation'] });
      deps.projection.mockRejectedValue(evidence === 'timeout'
        ? new Error('timed out: NOT_FOUND is not authoritative')
        : Object.assign(new Error('not found'), { code: 'NOT_FOUND' }));
      if (evidence === 'absent') deps.session.mockResolvedValue(null);
      if (evidence === 'wrong-id') deps.session.mockResolvedValue({ id: 'session-b', status: 'deleted' });
      if (evidence === 'unavailable') deps.session.mockRejectedValue(new Error('offline'));
      if (evidence === 'hidden') deps.session.mockRejectedValue(new Error('[NOT_FOUND] Session does not exist'));
      await runner.run();
      expect(storage.data.size).toBe(1);
      expect(store.getSnapshot()[0]?.cleanupOutcome).toBeUndefined();
      expect(deps.cleanup).not.toHaveBeenCalled();
      expect(deps.enqueue).not.toHaveBeenCalled();
      if (evidence === 'timeout') expect(deps.session).not.toHaveBeenCalled();
    },
  );
  it.each(['files', 'ledger'] as const)('resumes deleted-task cleanup after %s failure without remote evidence', async (failure) => {
    const { store, runner, deps, storage } = await setup();
    await store.add(message());
    deps.projection.mockRejectedValue(new Error('[NOT_FOUND] Session session-a not found'));
    deps.session.mockResolvedValue({ id: 'session-a', status: 'deleted' });
    if (failure === 'files') deps.cleanup.mockRejectedValueOnce(new Error('busy'));
    else vi.spyOn(storage, 'removeItem').mockRejectedValueOnce(new Error('busy'));
    await runner.run();
    expect(store.getSnapshot()[0]?.cleanupOutcome).toBe('cancelled');
    runner.stop();
    const recovered = await setup(storage);
    await recovered.runner.run();
    expect(recovered.store.getSnapshot()).toEqual([]);
    expect(recovered.deps.cleanup).toHaveBeenCalledWith(expect.objectContaining({ cleanupOutcome: 'cancelled' }), true);
    expect(recovered.deps.projection).not.toHaveBeenCalled();
    expect(recovered.deps.session).not.toHaveBeenCalled();
    expect(recovered.deps.enqueue).not.toHaveBeenCalled();
  });
  it('ignores a deletion probe completed after an account switch', async () => {
    const { store, runner, deps, storage, deactivate } = await setup();
    await store.add(message());
    deps.projection.mockRejectedValue(new Error('[NOT_FOUND] Session session-a not found'));
    deps.session.mockImplementationOnce(async () => {
      deactivate();
      return { id: 'session-a', status: 'deleted' };
    });
    await runner.run();
    expect(storage.data.size).toBe(1);
    expect(deps.cleanup).not.toHaveBeenCalled();
  });
  it.each(['keys', 'item'] as const)('retries failed %s loading through ready and add without losing persisted work', async (failure) => {
    const storage = disk();
    const seed = createDurableOutbox(storage);
    await seed.activate('alice');
    await seed.add(message());
    const readKeys = vi.spyOn(storage, 'getAllKeys');
    const readItem = vi.spyOn(storage, 'getItem');
    if (failure === 'keys') readKeys.mockRejectedValueOnce(new Error('busy'));
    if (failure === 'item') readItem.mockRejectedValueOnce(new Error('busy'));
    const store = createDurableOutbox(storage);
    await expect(store.activate('alice')).rejects.toThrow();
    expect(store.getSnapshot()).toEqual([]);
    const loading = store.ready();
    expect(store.activate('alice')).toBe(loading);
    await Promise.all([loading, store.add({ ...message('id-2'), createdAt: 2 })]);
    expect(store.getSnapshot().map((r) => r.item.clientId)).toEqual(['id-1', 'id-2']);
    expect(readKeys).toHaveBeenCalledTimes(2);
  });
  it('keeps a corrupt outbox row on disk without blocking the rest of the ledger', async () => {
    const storage = disk();
    const key = 'cindy.mobile.outbox.v1.alice/mac-a/session-a/id-1';
    storage.data.set(key, '{broken');
    const store = createDurableOutbox(storage);
    await store.activate('alice');
    await store.add(message('id-2'));
    await store.ready();
    expect(storage.data.get(key)).toBe('{broken');
    expect(store.getSnapshot().map((r) => r.item.clientId)).toEqual(['id-2']);
  });

  it('skips a JSON null ledger row instead of failing activation', async () => {
    const storage = disk();
    const key = 'cindy.mobile.outbox.v1.alice/mac-a/session-a/id-1';
    storage.data.set(key, 'null');
    const store = createDurableOutbox(storage);
    await store.activate('alice');
    await store.add(message('id-2'));
    expect(storage.data.get(key)).toBe('null');
    expect(store.getSnapshot().map((r) => r.item.clientId)).toEqual(['id-2']);
  });
  it('does not let an old activation failure invalidate the new account loading', async () => {
    const storage = disk();
    const pending = deferred<readonly string[]>();
    const keys = vi.spyOn(storage, 'getAllKeys').mockImplementationOnce(() => pending.promise);
    vi.spyOn(storage, 'getItem').mockRejectedValueOnce(new Error('old account read failed'));
    const store = createDurableOutbox(storage);
    const old = store.activate('alice');
    const rejected = expect(old).rejects.toThrow('old account read failed');
    const next = store.activate('bob');
    pending.resolve(['cindy.mobile.outbox.v1.alice/mac-a/session-a/id-1']);
    await rejected;
    await next;
    await store.ready();
    expect(store.getAccountId()).toBe('bob');
    expect(keys).toHaveBeenCalledTimes(2);
  });
  it('reconfirms a cancellation tombstone after its first response is lost', async () => {
    const { store, runner, deps } = await setup();
    await store.add({ ...message(), state: 'confirming', cancelRequested: true,
      prepared: { clientId: 'id-1' } as QueuedRemoteMessage });
    deps.cancel.mockRejectedValueOnce(new Error('response lost'));
    await runner.run();
    expect(store.getSnapshot()[0]?.cancelRequested).toBe(true);
    expect(deps.cleanup).not.toHaveBeenCalled();
    deps.projection.mockResolvedValue(projection('id-1', 'removed'));
    runner.wake();
    await runner.run();
    expect(deps.cancel).toHaveBeenCalledTimes(2);
    expect(deps.cleanup).toHaveBeenCalledWith(expect.objectContaining({ cleanupOutcome: 'cancelled' }), true);
    expect(store.getSnapshot()).toEqual([]);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });
  it('does not claim cancelled uploads when a removed receipt is followed by cancel=false', async () => {
    const { store, runner, deps } = await setup();
    await store.add({ ...message(), state: 'confirming', cancelRequested: true,
      prepared: { clientId: 'id-1' } as QueuedRemoteMessage });
    deps.projection.mockResolvedValue(projection('id-1', 'removed'));
    deps.cancel.mockResolvedValue(false);
    await runner.run();
    runner.wake();
    await runner.run();
    expect(deps.cleanup).toHaveBeenCalledWith(expect.objectContaining({ cleanupOutcome: 'accepted' }), false);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });
  it.each([
    ['accepted', 'files'], ['accepted', 'ledger'],
    ['cancelled', 'files'], ['cancelled', 'ledger'],
  ] as const)('recovers %s cleanup after %s deletion fails without consulting the host or resending', async (outcome, failure) => {
    const { store, runner, deps, storage } = await setup();
    await store.add({ ...message(), state: 'confirming', cancelRequested: outcome === 'cancelled',
      prepared: { clientId: 'id-1' } as QueuedRemoteMessage });
    deps.projection.mockResolvedValue(projection('id-1', 'removed'));
    if (failure === 'files') deps.cleanup.mockRejectedValueOnce(new Error('filesystem busy'));
    else vi.spyOn(storage, 'removeItem').mockRejectedValueOnce(new Error('storage busy'));
    await runner.run();
    expect(store.getSnapshot()[0]).toMatchObject({ state: 'host-owned', cleanupOutcome: outcome });
    runner.stop();
    const recovered = await setup(storage);
    expect(recovered.store.getSnapshot()[0]?.cleanupOutcome).toBe(outcome);
    recovered.deps.projection.mockRejectedValue(new Error('host offline'));
    await recovered.runner.run();
    expect(recovered.deps.cleanup).toHaveBeenCalledWith(expect.objectContaining({ cleanupOutcome: outcome }), outcome === 'cancelled');
    expect(recovered.store.getSnapshot()).toEqual([]);
    expect(recovered.deps.projection).not.toHaveBeenCalled();
    expect(recovered.deps.upload).not.toHaveBeenCalled();
    expect(recovered.deps.enqueue).not.toHaveBeenCalled();
    expect(recovered.deps.cancel).not.toHaveBeenCalled();
  });
  it('does not delete bytes when persisting completion fails', async () => {
    const { store, runner, deps, storage } = await setup();
    await store.add(message());
    deps.projection.mockResolvedValue(projection('id-1', 'removed'));
    vi.spyOn(storage, 'setItem').mockRejectedValueOnce(new Error('disk full'));
    await runner.run();
    expect(deps.cleanup).not.toHaveBeenCalled();
    expect(store.getSnapshot()[0]?.cleanupOutcome).toBeUndefined();
    expect(storage.data.size).toBe(1);
  });
  it('keeps completion after an account switch during cleanup and never blocks the next message', async () => {
    const { store, runner, deps, storage, deactivate } = await setup();
    await store.add({ ...message(), state: 'host-owned', cleanupOutcome: 'cancelled' });
    await store.add({ ...message('id-2'), createdAt: 2 });
    deps.cleanup.mockImplementationOnce(async () => { deactivate(); });
    await runner.run();
    expect(storage.data.size).toBe(2);
    runner.stop();
    const recovered = await setup(storage);
    recovered.deps.cleanup.mockRejectedValue(new Error('still busy'));
    await recovered.runner.run();
    expect(recovered.deps.enqueue).toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ clientId: 'id-2' }) }));
    expect(recovered.store.getSnapshot().find((r) => r.item.clientId === 'id-1')?.cleanupOutcome).toBe('cancelled');
  });
  it('isolates identical membership IDs across realms without claiming unqualified draft data', async () => {
    const storage = disk();
    const store = createDurableOutbox(storage);
    await store.activate('alice');
    await store.add(message());
    const oldData = [...storage.data.entries()][0]!;
    const globalKey = accountVaultKey('global', 'alice');
    const cnKey = accountVaultKey('cn', 'alice');
    await store.activate(globalKey);
    expect(store.getSnapshot()).toEqual([]);
    await store.add({ ...message(), accountId: globalKey });
    const oldRecord = store.getSnapshot()[0]!;
    const sending = vi.fn();
    const unsubscribe = observeDurableOutboxSending(store, 'mac-a', 'session-a', sending, vi.fn(), cnKey);
    await store.activate(cnKey);
    expect(store.getSnapshot()).toEqual([]);
    await expect(store.update(oldRecord, { state: 'sending' })).rejects.toThrow('OUTBOX_OWNER_CHANGED');
    await store.add({ ...message(), accountId: cnKey });
    await store.update(store.getSnapshot()[0]!, { state: 'sending', prepared: { clientId: 'id-1' } as QueuedRemoteMessage });
    expect(sending).toHaveBeenCalledOnce();
    expect(sending.mock.calls[0]?.[0].accountId).toBe(cnKey);
    await store.activate(globalKey);
    expect(store.getSnapshot()[0]?.accountId).toBe(globalKey);
    expect(store.getSnapshot()[0]?.state).toBe('queued');
    expect(storage.data.get(oldData[0])).toBe(oldData[1]);
    unsubscribe();
  });
  it.each(['unknown', 'pending'] as const)('settles legacy %s cancellation as confirmation required without deleting or resending', async (state) => {
    const { store, runner, deps } = await setup();
    await store.add({ ...message(), state: 'confirming', cancelRequested: true,
      prepared: { clientId: 'id-1' } as QueuedRemoteMessage });
    deps.projection.mockResolvedValue({ ...projection('id-1', state), inputDeliveryVersion: undefined });
    await runner.run();
    expect(store.getSnapshot()[0]).toMatchObject({ state: 'failed', cancelRequested: true, error: 'check receipt' });
    expect(deps.cancel).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.cleanup).not.toHaveBeenCalled();
  });
  it.each(['removed', 'history'] as const)('does not authorize remote attachment deletion from %s evidence', async (evidence) => {
    const { store, runner, deps } = await setup();
    await store.add({ ...message(), state: 'confirming', cancelRequested: true,
      prepared: { clientId: 'id-1' } as QueuedRemoteMessage });
    const record = store.getSnapshot()[0]!;
    deps.projection.mockResolvedValue({ ...projection('id-1', evidence === 'removed' ? 'removed' : 'unknown'), inputDeliveryVersion: undefined });
    deps.history.mockResolvedValue(true);
    await runner.run();
    expect(store.getSnapshot()).toEqual([]);
    expect(deps.cleanup).toHaveBeenCalledWith(expect.objectContaining({ ...record, state: 'host-owned', cleanupOutcome: 'accepted' }), false);
    expect(deps.cancel).not.toHaveBeenCalled();
  });
  it('reserves a visible user slot synchronously before an immediate assistant reply', async () => {
    const { store, deps, runner } = await setup();
    let source: RemoteMessage[] = [];
    let slots: readonly OptimisticUserMessage[] = [];
    const reserved = vi.fn((r: DurableOutboxRecord) => {
      slots = appendOptimisticUserMessage(slots, source, r.prepared!, r.item.sessionId);
    });
    const settled = vi.fn();
    const off = observeDurableOutboxSending(store, 'mac-a', 'session-a', reserved, settled);
    deps.prepare.mockImplementation(async (r) => ({ clientId: r.item.clientId, text: r.item.text,
      persistedContent: r.item.text, model: 'test', effort: 'medium', permissionMode: 'ask', workingDir: '/test',
      createOpts: { agentKind: 'codex', model: 'test', workingDir: '/test' },
      chatMessage: { clientId: r.item.clientId, role: 'user', content: r.item.text, createdAt: '2026-09-12T00:00:00Z' },
    }));
    deps.enqueue.mockImplementation(async () => {
      expect(reserved).toHaveBeenCalledTimes(1);
      source = [{ clientId: 'reply', role: 'assistant' } as RemoteMessage];
      return projection();
    });
    await store.add(message());
    await runner.run();
    expect(projectOptimisticUserMessages(source, slots).map((r) => r.clientId)).toEqual(['id-1', 'reply']);
    expect(settled).toHaveBeenCalledWith('id-1');
    // A retry and a newly mounted page cannot infer another historical boundary.
    const current = store.getSnapshot()[0]!;
    const retry = await store.update(current, { state: 'queued' });
    await store.update(retry, { state: 'sending' });
    expect(reserved).toHaveBeenCalledTimes(1);
    off();
    const hydrated = vi.fn();
    const offHydrated = observeDurableOutboxSending(store, 'mac-a', 'session-a', hydrated, () => {});
    const retryAgain = await store.update(store.getSnapshot()[0]!, { state: 'queued' });
    await store.update(retryAgain, { state: 'sending' });
    await store.add({ ...message('other', 'other-session'), state: 'sending', prepared: retryAgain.prepared });
    expect(hydrated).not.toHaveBeenCalled();
    offHydrated();
  });
  it("publishes only after persistence and restores original IDs, attachment slots and permission after restart", async () => {
    const storage = disk();
    const store = createDurableOutbox(storage);
    await store.activate("alice");
    const gate = deferred<void>();
    const write = storage.setItem;
    storage.setItem = async (k, v) => {
      await gate.promise;
      await write(k, v);
    };
    const record = message();
    record.uploads = [
      {
        slot: 0,
        fileName: "slot-0.png",
        size: 123,
        name: "photo.png",
        kind: "image",
      },
    ];
    record.item.attachmentSlots = [null];
    const adding = store.add(record);
    await Promise.resolve();
    expect(store.getSnapshot()).toEqual([]);
    gate.resolve();
    await adding;
    const restarted = createDurableOutbox(storage);
    await restarted.activate("alice");
    expect(restarted.getSnapshot()).toEqual([record]);
    await restarted.activate("bob");
    expect(restarted.getSnapshot()).toEqual([]);
    await restarted.activate("alice");
    expect(restarted.getSnapshot()[0]?.item.clientId).toBe("id-1");
  });
  it("does not accept a message when disk is full", async () => {
    const storage = disk();
    storage.setItem = async () => {
      throw new Error("disk full");
    };
    const { store, runner, deps } = await setup(storage);
    await expect(store.add(message())).rejects.toThrow("disk full");
    await runner.run();
    expect(store.getSnapshot()).toEqual([]);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });
  it("does not resurrect a removed record through a late upload update", async () => {
    const { store } = await setup();
    const record = message();
    await store.add(record);
    await store.remove(record);
    await expect(store.update(record, { state: "sending" })).rejects.toThrow(
      "OUTBOX_STALE_WRITE",
    );
    expect(store.getSnapshot()).toEqual([]);
  });
  it("keeps a committed old-account write safe when logout races disk completion", async () => {
    const storage = disk();
    const { store } = await setup(storage);
    const entered = deferred<void>();
    const finish = deferred<void>();
    const write = storage.setItem;
    storage.setItem = async (k, v) => {
      entered.resolve();
      await finish.promise;
      await write(k, v);
    };
    const saving = store.add(message());
    await entered.promise;
    const switching = store.activate("bob");
    finish.resolve();
    await expect(saving).resolves.toBeUndefined();
    await switching;
    expect(store.getSnapshot()).toEqual([]);
    await store.activate("alice");
    expect(store.getSnapshot()).toHaveLength(1);
  });
  it("isolates dotted and slash-containing owner/device/session keys", async () => {
    const storage = disk();
    const { store } = await setup(storage);
    await store.add({ ...message("c", "b.c"), deviceId: "a" });
    await store.add({ ...message("c", "c"), deviceId: "a.b" });
    expect(storage.data.size).toBe(2);
  });
});

describe("app-owned delivery and reconciliation", () => {
  // #4841 (unit): unlike the generic retry fixtures, use the Mobile API error
  // from a DNS failure during attachment presign and see whether the same item can send.
  it('keeps an unsent item queued when Android DNS blocks attachment presign', async () => {
    const { store, deps } = await setup();
    const offline = new Error('fetch failed: java.net.UnknownHostException: Unable to resolve host "relay.example.invalid": No address associated with hostname');
    const fetch = vi.fn()
      .mockRejectedValueOnce(offline)
      .mockRejectedValueOnce(offline)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        putUrl: 'https://upload.example.invalid/object', key: 'object', expiresAt: '2099-01-01T00:00:00Z',
      })));
    vi.stubGlobal('fetch', fetch);
    vi.useFakeTimers();
    const uploadFile = vi.fn().mockResolvedValue({ status: 200 });
    const runner = createDurableOutboxDelivery({
      ...deps,
      upload: (_record, candidate) => uploadMobileAttachmentFromFile(candidate, 'file:///unit.txt', {
        token: null, deps: { uploadFile, readFileChunk: async () => 'eA==' },
      }),
      retryable: isAutoRecoveringRemoteError,
      describe: formatRemoteError,
    });
    try {
      const record = message();
      await store.add({ ...record, item: { ...record.item, attachmentSlots: [null] },
        uploads: [{ slot: 0, kind: 'file', fileName: 'unit.txt', name: 'unit.txt', size: 1 }] });
      const attempt = runner.run();
      await vi.advanceTimersByTimeAsync(1_000);
      await attempt;
      expect(store.getSnapshot()[0]).toMatchObject({ state: 'queued' });
      expect(deps.enqueue).not.toHaveBeenCalled();
      expect(uploadFile).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(2);
      runner.wake();
      await runner.run();
      expect(uploadFile).toHaveBeenCalledOnce();
      expect(deps.enqueue).toHaveBeenCalledOnce();
      expect(deps.enqueue.mock.calls[0]?.[0].item.clientId).toBe('id-1');
    } finally {
      runner.stop();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it.each(['legacy', 'legacy-prepared'] as const)('keeps %s enqueue success uncertain across restart until history confirms it', async (host) => {
    const first = await setup();
    const legacy = { pendingQueue: [] } as unknown as DeliveryProjection;
    if (host === 'legacy') first.deps.projection.mockResolvedValue(legacy);
    first.deps.enqueue.mockResolvedValue(legacy);
    await first.store.add(host === 'legacy' ? message() : { ...message(), retrySafe: false,
      prepared: { clientId: 'id-1' } as QueuedRemoteMessage });
    await first.runner.run();
    expect(first.store.getSnapshot()[0]).toMatchObject({ state: 'confirming', error: 'check receipt' });
    first.runner.stop();
    const second = await setup(first.storage);
    second.deps.projection.mockResolvedValue(legacy);
    await second.runner.run();
    expect(second.store.getSnapshot()[0]).toMatchObject({ state: 'failed', error: 'check receipt' });
    expect(second.deps.enqueue).not.toHaveBeenCalled();
    expect(second.deps.cleanup).not.toHaveBeenCalled();
    second.deps.history.mockResolvedValue(true);
    second.runner.wake();
    await second.runner.run();
    expect(second.store.getSnapshot()).toEqual([]);
    expect(second.deps.cleanup).toHaveBeenCalledOnce();
  });
  it.each(['sending', 'host-owned'] as const)('never promotes legacy pending or restored %s to durable ownership', async (state) => {
    const { store, deps, runner } = await setup();
    await store.add({ ...message(), state, retrySafe: false, clearBoundaryMs: null,
      prepared: { clientId: 'id-1' } as QueuedRemoteMessage });
    await store.add({ ...message('id-2'), createdAt: 2 });
    deps.projection.mockResolvedValue({ pendingQueue: [{ clientId: 'id-1' }], clearBoundaryMs: null } as unknown as DeliveryProjection);
    await runner.run();
    expect(store.getSnapshot()[0]).toMatchObject({ state: 'confirming', error: 'check receipt' });
    deps.projection.mockResolvedValue({ pendingQueue: [], clearBoundaryMs: 123 } as unknown as DeliveryProjection);
    runner.wake();
    await runner.run();
    expect(store.getSnapshot()[0]).toMatchObject({ state: 'failed', error: 'task cleared' });
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.cleanup).not.toHaveBeenCalled();
  });
  it.each([true, false])("persists creation Plan=%s on the input before enqueue", async (planModeArm) => {
    const { store, runner, deps } = await setup();
    const record = message();
    record.creation = {
      draft: { agentKind: 'claude-code', workspaceKind: 'project', workingDir: '/repo',
        model: 'test', providerId: null, effort: 'medium', permissionMode: 'ask',
        fastMode: false, firstMessage: record.item.text },
      deviceName: 'Mac', planModeArm, restorePermissionMode: null,
    };
    await store.add(record);
    await runner.run();
    expect(deps.enqueue.mock.calls[0]?.[0].prepared?.createOpts.planMode).toBe(planModeArm);
    expect(store.getSnapshot()[0]?.prepared?.createOpts.planMode).toBe(planModeArm);
  });
  it("sends without a page and keeps display ownership until history confirms the message", async () => {
    const { store, runner, deps } = await setup();
    await store.add(message());
    await runner.run();
    expect(deps.enqueue).toHaveBeenCalledTimes(1);
    expect(deps.enqueue.mock.calls[0]?.[0].prepared?.clientId).toBe("id-1");
    expect(store.getSnapshot()[0]?.state).toBe("host-owned");
    expect(store.getSnapshot()[0]?.clearBoundaryMs).toBeNull();
    expect(deps.enqueue.mock.calls[0]?.[0].clearBoundaryMs).toBeNull();
    runner.wake();
    deps.projection.mockResolvedValue(projection("id-1", "accepted"));
    deps.history.mockResolvedValue(true);
    await runner.run();
    expect(store.getSnapshot()).toEqual([]);
    expect(deps.cleanup).toHaveBeenCalledOnce();
  });
  it.each([true, false])('retains a confirmed send across restart until history is cached (durable host=%s)', async (durable) => {
    const first = await setup();
    await first.store.add({ ...message(), state: durable ? 'host-owned' : 'confirming',
      retrySafe: durable, prepared: { clientId: 'id-1' } as QueuedRemoteMessage });
    first.deps.history.mockResolvedValue(true);
    first.deps.projection.mockResolvedValue(durable ? projection('id-1', 'accepted')
      : { pendingQueue: [] } as unknown as DeliveryProjection);
    const cacheHistory = vi.fn(async () => false);
    await createDurableOutboxDelivery({ ...first.deps, cacheHistory }).run();
    expect(first.deps.cleanup).not.toHaveBeenCalled();
    expect(first.store.getSnapshot()[0]?.cleanupOutcome).toBeUndefined();
    expect(first.store.getSnapshot()[0]?.historyConfirmed).toBe(true);
    const restarted = await setup(first.storage);
    expect(restarted.store.getSnapshot()[0]?.item.text).toBe('keep this message');
    restarted.deps.history.mockResolvedValue(true);
    restarted.deps.projection.mockResolvedValue(durable ? projection('id-1', 'accepted')
      : { pendingQueue: [] } as unknown as DeliveryProjection);
    const saved = deferred<boolean>();
    const cacheRestoredHistory = vi.fn(() => saved.promise);
    const run = createDurableOutboxDelivery({ ...restarted.deps, cacheHistory: cacheRestoredHistory }).run();
    await vi.waitFor(() => expect(cacheRestoredHistory).toHaveBeenCalled());
    expect(restarted.store.getSnapshot()[0]?.cleanupOutcome).toBeUndefined();
    saved.resolve(true);
    await run;
    expect(restarted.store.getSnapshot()).toEqual([]);
    expect(restarted.deps.enqueue).not.toHaveBeenCalled();
    expect(restarted.deps.cleanup).toHaveBeenCalledOnce();
  });
  // Unit regression: a recovered host-owned record plus confirmed local history
  // must retire its pending bubble even when projection/history RPCs are unavailable.
  // Existing restart cases returned those RPCs before checking the local cache.
  it('releases an already cached host-owned send before contacting the host', async () => {
    const { store, deps } = await setup();
    await store.add({ ...message(), state: 'host-owned', retrySafe: true });
    deps.projection.mockRejectedValue(new Error('offline'));
    await createDurableOutboxDelivery({ ...deps, cacheHistory: async () => true }).run();
    expect(store.getSnapshot()).toEqual([]);
    expect(deps.cleanup).toHaveBeenCalledOnce();
    expect(deps.projection).not.toHaveBeenCalled();
    expect(deps.history).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
  });
  it.each(['unconfirmed', 'cancelling'] as const)('does not bypass remote reconciliation for a %s send', async (kind) => {
    const { store, deps } = await setup();
    await store.add({ ...message(), state: kind === 'cancelling' ? 'host-owned' : 'confirming',
      retrySafe: true, cancelRequested: kind === 'cancelling' });
    deps.projection.mockRejectedValue(new Error('offline'));
    const cacheHistory = vi.fn(async () => true);
    await createDurableOutboxDelivery({ ...deps, cacheHistory }).run();
    expect(store.getSnapshot()).toHaveLength(1);
    expect(cacheHistory).not.toHaveBeenCalled();
    expect(deps.cleanup).not.toHaveBeenCalled();
    expect(deps.projection).toHaveBeenCalledOnce();
  });
  it('does not block later legacy sends while the first confirmed row awaits caching', async () => {
    const { store, deps } = await setup();
    await store.add({ ...message(), state: 'host-owned', historyConfirmed: true, retrySafe: false,
      prepared: { clientId: 'id-1' } as QueuedRemoteMessage });
    await store.add(message('id-2'));
    deps.projection.mockResolvedValue({ pendingQueue: [] } as unknown as DeliveryProjection);
    deps.history.mockResolvedValue(true);
    await createDurableOutboxDelivery({ ...deps, cacheHistory: async () => false }).run();
    expect(deps.enqueue.mock.calls.map(([record]) => record.item.clientId)).toEqual(['id-2']);
    expect(store.getSnapshot().find(record => record.item.clientId === 'id-1')?.historyConfirmed).toBe(true);
  });
  it('does not release a send if its owner changes while history is being cached', async () => {
    const { store, deps, deactivate } = await setup();
    await store.add({ ...message(), state: 'host-owned', retrySafe: true });
    deps.history.mockResolvedValue(true);
    await createDurableOutboxDelivery({ ...deps, cacheHistory: async () => { deactivate(); return true; } }).run();
    expect(store.getSnapshot()[0]?.cleanupOutcome).toBeUndefined();
    expect(deps.cleanup).not.toHaveBeenCalled();
  });
  it("restarts after a lost receipt, finds durable host ownership, and never enqueues twice", async () => {
    const first = await setup();
    await first.store.add(message());
    first.deps.enqueue.mockRejectedValue(new Error("response lost"));
    await first.runner.run();
    expect(first.store.getSnapshot()[0]?.state).toBe("confirming");
    const second = await setup(first.storage);
    second.deps.projection.mockResolvedValue(projection("id-1", "pending"));
    await second.runner.run();
    expect(second.deps.enqueue).not.toHaveBeenCalled();
    expect(second.store.getSnapshot()[0]?.state).toBe("host-owned");
  });
  it("retries an uncertain new-host write with exactly the persisted payload and clientId", async () => {
    const first = await setup();
    await first.store.add(message());
    first.deps.enqueue.mockRejectedValue(new Error("response lost"));
    await first.runner.run();
    const sent = first.deps.enqueue.mock.calls[0]?.[0];
    const second = await setup(first.storage);
    await second.runner.run();
    const retried = second.deps.enqueue.mock.calls[0]?.[0];
    expect(retried?.prepared).toEqual(sent?.prepared);
    expect(retried?.sendAtMs).toBe(sent?.sendAtMs);
    expect(second.deps.prepare).not.toHaveBeenCalled();
  });
  it("holds uncertain writes on legacy hosts, including after restart", async () => {
    const first = await setup();
    await first.store.add(message());
    first.deps.projection.mockResolvedValue({
      pendingQueue: [],
    } as unknown as DeliveryProjection);
    first.deps.enqueue.mockRejectedValue(new Error("response lost"));
    await first.runner.run();
    const second = await setup(first.storage);
    second.deps.projection.mockResolvedValue({
      pendingQueue: [],
    } as unknown as DeliveryProjection);
    await second.runner.run();
    expect(second.deps.enqueue).not.toHaveBeenCalled();
    expect(second.store.getSnapshot()[0]?.error).toBe("check receipt");
  });
  it("does not replay a message after the desktop clear boundary changes", async () => {
    const { store, runner, deps } = await setup();
    await store.add({ ...message(), clearBoundaryMs: null });
    deps.projection.mockResolvedValue({
      ...projection(),
      clearBoundaryMs: 123,
    });
    await runner.run();
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(store.getSnapshot()[0]?.error).toBe("task cleared");
  });
  it("seals a cancellation before discarding an uncertain message", async () => {
    const { store, runner, deps } = await setup();
    await store.add({
      ...message(),
      state: "confirming",
      prepared: { clientId: "id-1" } as QueuedRemoteMessage,
      cancelRequested: true,
    });
    const gate = deferred<void>();
    deps.cancel.mockImplementation(async () => {
      await gate.promise;
      return true;
    });
    const running = runner.run();
    await vi.waitFor(() => expect(deps.cancel).toHaveBeenCalledOnce());
    expect(store.getSnapshot()).toHaveLength(1);
    expect(deps.cleanup).not.toHaveBeenCalled();
    const cancelledRecord = store.getSnapshot()[0]!;
    gate.resolve();
    await running;
    expect(store.getSnapshot()).toHaveLength(0);
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.cleanup).toHaveBeenCalledWith(expect.objectContaining({ ...cancelledRecord, state: 'host-owned', cleanupOutcome: 'cancelled' }), true);
  });
  it("keeps FIFO within a task while other computers can continue", async () => {
    const { store, runner, deps } = await setup();
    await store.add({ ...message("first"), state: "failed" });
    await store.add({ ...message("second"), createdAt: 2 });
    await store.add({
      ...message("other", "session-b"),
      deviceId: "mac-b",
      createdAt: 3,
    });
    await runner.run();
    expect(deps.enqueue.mock.calls.map(([r]) => r.item.clientId)).toEqual([
      "other",
    ]);
  });
  it("does not enqueue after the account changes during preparation", async () => {
    const { store, runner, deps, deactivate } = await setup();
    await store.add(message());
    const gate = deferred<QueuedRemoteMessage>();
    deps.prepare.mockImplementation(() => gate.promise);
    const running = runner.run();
    await vi.waitFor(() => expect(deps.prepare).toHaveBeenCalledOnce());
    deactivate();
    gate.resolve({ clientId: "id-1" } as QueuedRemoteMessage);
    await running;
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(store.getSnapshot()[0]?.state).toBe("queued");
  });
  it("cleans up host-owned messages after a clear instead of polling invisible history forever", async () => {
    const { store, runner, deps } = await setup();
    await store.add({
      ...message(),
      state: "host-owned",
      clearBoundaryMs: null,
    });
    deps.projection.mockResolvedValue({
      ...projection("id-1", "accepted"),
      clearBoundaryMs: 123,
    });
    await runner.run();
    expect(store.getSnapshot()).toHaveLength(0);
    expect(deps.history).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
  });
  it("keeps a too-late cancellation under host ownership instead of claiming it cancelled dispatch", async () => {
    const { store, runner, deps } = await setup();
    await store.add({
      ...message(),
      prepared: { clientId: "id-1" } as QueuedRemoteMessage,
      state: "confirming",
      cancelRequested: true,
    });
    deps.cancel.mockResolvedValue(false);
    await runner.run();
    expect(store.getSnapshot()[0]?.state).toBe("host-owned");
    expect(store.getSnapshot()[0]?.cancelRequested).toBe(false);
    expect(deps.cleanup).not.toHaveBeenCalled();
  });
  it("reuploads expired attachment references from the durable file without changing clientId", async () => {
    const { store, deps } = await setup();
    const record = message();
    record.uploads = [
      {
        slot: 0,
        fileName: "slot-0.png",
        size: 123,
        name: "photo.png",
        kind: "image",
      },
    ];
    record.item.attachmentSlots = [
      {
        id: "old",
        name: "photo.png",
        path: "expired",
        ext: "png",
        size: 123,
        category: "image",
        mimeType: "image/png",
      },
    ];
    await store.add(record);
    const runner = createDurableOutboxDelivery({
      ...deps,
      mediaFailed: () => true,
    });
    deps.enqueue.mockRejectedValueOnce(
      new Error("DEVICE_LINK_MEDIA_TRANSFER_FAILED"),
    );
    await runner.run();
    runner.wake();
    await runner.run();
    expect(deps.upload).toHaveBeenCalledOnce();
    expect(deps.discardUploads).toHaveBeenCalledWith(expect.objectContaining({ refreshUploads: false }), [record.item.attachmentSlots[0]]);
    expect(deps.discardUploads.mock.invocationCallOrder[0]).toBeLessThan(deps.upload.mock.invocationCallOrder[0]!);
    expect(deps.enqueue.mock.calls.map(([r]) => r.prepared?.clientId)).toEqual([
      "id-1",
      "id-1",
    ]);
    expect(store.getSnapshot()[0]?.item.attachmentSlots[0]?.id).toBe("file-1");
  });
  it.each(['disk-failure', 'late-upload', 'success'] as const)('settles upload ownership after %s', async (outcome) => {
    const { store, deps, storage, runner } = await setup();
    await store.add({ ...message(), uploads: [{ slot: 0, fileName: 'file.png', name: 'file.png', kind: 'image', size: 1 }],
      item: { ...message().item, attachmentSlots: [null] } });
    const attachment = await deps.upload();
    deps.upload.mockClear();
    deps.upload.mockImplementationOnce(async () => {
      if (outcome === 'late-upload') runner.stop();
      return attachment;
    });
    if (outcome === 'disk-failure') vi.spyOn(storage, 'setItem').mockRejectedValueOnce(new Error('disk full'));
    await runner.run();
    if (outcome === 'success') {
      expect(deps.discardUploads).not.toHaveBeenCalled();
      expect(deps.enqueue).toHaveBeenCalledOnce();
    } else {
      expect(deps.discardUploads).toHaveBeenCalledWith(expect.anything(), [attachment]);
      expect(deps.enqueue).not.toHaveBeenCalled();
      expect(store.getSnapshot()[0]?.item.attachmentSlots).toEqual([null]);
    }
  });
  it('retains superseded references when replacing the ledger fails, then only discards upload-backed slots', async () => {
    const { store, deps, storage, runner } = await setup();
    const old = await deps.upload();
    const unchanged = { ...old, id: 'not-replaced', path: 'other' };
    await store.add({ ...message(), refreshUploads: true, prepared: { clientId: 'id-1' } as QueuedRemoteMessage,
      uploads: [{ slot: 0, fileName: 'file.png', name: 'file.png', kind: 'image', size: 1 }],
      item: { ...message().item, attachmentSlots: [old, unchanged] } });
    deps.upload.mockClear();
    const write = vi.spyOn(storage, 'setItem').mockRejectedValueOnce(new Error('disk full'));
    await runner.run();
    expect(deps.discardUploads).not.toHaveBeenCalled();
    expect(deps.upload).not.toHaveBeenCalled();
    expect(store.getSnapshot()[0]?.item.attachmentSlots).toEqual([old, unchanged]);
    write.mockRestore();
    runner.wake();
    await runner.run();
    expect(deps.discardUploads).toHaveBeenCalledWith(expect.anything(), [old]);
    expect(store.getSnapshot()[0]?.item.attachmentSlots[1]).toEqual(unchanged);
  });
  it('records the slot whose upload failed, even when uploads run out of slot order, and clears it once that slot lands', async () => {
    const { store, deps, runner } = await setup();
    const uploads = [
      { slot: 1, fileName: 'b.png', name: 'b.png', kind: 'image' as const, size: 1 },
      { slot: 0, fileName: 'a.png', name: 'a.png', kind: 'image' as const, size: 1 },
    ];
    await store.add({ ...message(), uploads, item: { ...message().item, attachmentSlots: [null, null] } });
    const retryable = vi.fn(() => false);
    const failing = createDurableOutboxDelivery({ ...deps, retryable });
    deps.upload.mockRejectedValueOnce(new Error('upload failed'));
    await failing.run();
    expect(store.getSnapshot()[0]).toMatchObject({ state: 'failed', failedUploadSlot: 1 });
    expect(deps.enqueue).not.toHaveBeenCalled();
    await store.update(store.getSnapshot()[0]!, { state: 'queued', error: undefined });
    await runner.run();
    expect(store.getSnapshot()[0]?.failedUploadSlot).toBeUndefined();
  });
  it("persists the first creation message as the FIFO barrier across restart", async () => {
    const first = await setup();
    await first.store.add({ ...message("first"), suspended: true });
    await first.store.add({ ...message("follow-up"), createdAt: 2 });
    const second = await setup(first.storage);
    const runner = createDurableOutboxDelivery({
      ...second.deps,
      canRun: (r) => !r.suspended,
    });
    await runner.run();
    expect(second.deps.enqueue).not.toHaveBeenCalled();
    const head = second.store.getSnapshot()[0]!;
    await second.store.update(head, { suspended: false });
    await runner.run();
    runner.wake();
    await runner.run();
    expect(
      second.deps.enqueue.mock.calls.map(([r]) => r.item.clientId),
    ).toEqual(["first", "follow-up"]);
  });
});

it('persists companion identity across restart and refuses a changed resource before starting enqueue', async () => {
  const { store, storage, deps } = await setup();
  const resourceRef = { collectionId: 'teammates', kind: 'bot', id: 'writer' };
  await store.add({ ...message(), resourceRef });
  const restarted = createDurableOutbox(storage); await restarted.activate('alice');
  expect(restarted.getSnapshot()[0].resourceRef).toEqual(resourceRef);
  const validateResource = vi.fn(async () => { throw new Error('ACCESS_REVOKED'); });
  const guarded = createDurableOutboxDelivery({ ...deps, store: restarted, validateResource, retryable: () => false });
  await guarded.run();
  expect(validateResource).toHaveBeenCalledTimes(1); expect(deps.enqueue).not.toHaveBeenCalled();
  expect(restarted.getSnapshot()[0]).toMatchObject({ state: 'failed', enqueueStarted: false, resourceRef });
  expect(restarted.getSnapshot()[0].item.clientId).toBe('id-1');
});

it('does not drop the resource gate when its persisted identity is corrupt', async () => {
  const storage = disk();
  const store = createDurableOutbox(storage); await store.activate('alice');
  await store.add(message());
  const [key, raw] = [...storage.data.entries()][0];
  storage.data.set(key, JSON.stringify({ ...JSON.parse(raw), resourceRef: null }));
  const restarted = createDurableOutbox(storage); await restarted.activate('alice');
  expect(restarted.getSnapshot()).toEqual([]);
  expect(storage.data.has(key)).toBe(true);
});

it('cancels an enqueue if its page-independent resource check spans an account or foreground change', async () => {
  const { store, deps, deactivate } = await setup();
  await store.add({ ...message(), resourceRef: { collectionId: 'teammates', kind: 'bot', id: 'writer' } });
  const check = deferred<void>();
  const validateResource = vi.fn(() => check.promise);
  const guarded = createDurableOutboxDelivery({ ...deps, validateResource });
  const run = guarded.run();
  for (let n = 0; n < 40 && !validateResource.mock.calls.length; n++) await Promise.resolve();
  expect(validateResource).toHaveBeenCalledTimes(1);
  deactivate(); check.resolve(); await run;
  expect(deps.enqueue).not.toHaveBeenCalled(); expect(store.getSnapshot()[0].enqueueStarted).toBe(false);
});

describe('known projection first send', () => {
  const known = (): DeliveryProjection =>
    ({ pendingQueue: [], inputDeliveryVersion: 1, clearBoundaryMs: 5 }) as unknown as DeliveryProjection;

  it('makes the enqueue the only round trip for a never-sent message', async () => {
    const { store, deps } = await setup();
    await store.add(message());
    // Unit: a plain first send commits its prepared payload and send marker together.
    const update = vi.spyOn(store, 'update');
    const events: string[] = [];
    await createDurableOutboxDelivery({
      ...deps, knownProjection: known,
      trace: event => events.push(event),
      onHandedOff: record => events.push(record.state),
    }).run();
    expect(events.slice(-2)).toEqual(['send accepted', 'host-owned']);
    expect(update.mock.calls.find(([, patch]) => patch.prepared)?.[1]).toMatchObject({
      state: 'sending', enqueueStarted: true,
    });
    expect(deps.projection).not.toHaveBeenCalled();
    expect(deps.enqueue).toHaveBeenCalledOnce();
    expect(store.getSnapshot()[0]).toMatchObject({
      state: 'host-owned', clearBoundaryMs: 5, retrySafe: true, prepared: { durableDelivery: true },
    });
  });

  it('reads the live boundary when a newly composed message is ahead of the cache', async () => {
    const { store, deps } = await setup();
    await store.add({ ...message(), clearBoundaryMs: 9 });
    deps.projection.mockResolvedValue({ ...projection(), clearBoundaryMs: 9 });

    await createDurableOutboxDelivery({ ...deps, knownProjection: known }).run();

    expect(deps.projection).toHaveBeenCalledOnce();
    expect(deps.enqueue).toHaveBeenCalledOnce();
    expect(deps.enqueue.mock.calls[0]?.[0].clearBoundaryMs).toBe(9);
    expect(store.getSnapshot()[0]).toMatchObject({ state: 'host-owned' });
  });

  it('preserves the send boundary when the desktop clears before enqueue', async () => {
    const { store, deps } = await setup();
    await store.add({ ...message(), clearBoundaryMs: 5 });
    const cleared = new Error('REMOTE_OPTIMISTIC_INPUT_CLEARED: expectedClearBoundaryMs=5; currentClearBoundaryMs=9');
    deps.enqueue.mockRejectedValueOnce(cleared);
    deps.projection.mockResolvedValue({ ...projection(), clearBoundaryMs: 9 });

    const settled = deferred<DurableOutboxRecord>();
    const unsubscribe = store.subscribe(() => {
      const record = store.getSnapshot()[0];
      if (record?.state === 'failed' || record?.state === 'host-owned') settled.resolve(record);
    });
    try {
      await createDurableOutboxDelivery({
        ...deps, knownProjection: known, staleClearBoundary: (error) => error === cleared,
      }).run();

      expect(await settled.promise).toMatchObject({
        state: 'failed', clearBoundaryMs: 5, enqueueStarted: false, error: deps.clearedMessage,
      });
      expect(deps.projection).toHaveBeenCalledOnce();
      expect(deps.enqueue).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });

  it('asks the host once after it refuses a stale known clear boundary', async () => {
    const { store, deps } = await setup();
    await store.add(message());
    const cleared = new Error('REMOTE_OPTIMISTIC_INPUT_CLEARED: expectedClearBoundaryMs=5; currentClearBoundaryMs=9');
    deps.enqueue.mockRejectedValueOnce(cleared);
    deps.projection.mockResolvedValue({ ...projection('id-1'), clearBoundaryMs: 9 } as DeliveryProjection);
    const knownProjection = vi.fn(known);
    await createDurableOutboxDelivery({
      ...deps, knownProjection, staleClearBoundary: (error) => error === cleared,
    }).run();
    await vi.waitFor(() => expect(deps.enqueue).toHaveBeenCalledTimes(2));
    expect(knownProjection).toHaveBeenCalledOnce();
    expect(deps.projection).toHaveBeenCalledOnce();
    expect(deps.enqueue.mock.calls[1]?.[0]).toMatchObject({ clearBoundaryMs: 9, enqueueStarted: true });
    await vi.waitFor(() => expect(store.getSnapshot()[0]).toMatchObject({ state: 'host-owned' }));
  });
});

// Unit: the first-send path previously waited for the projection before reading
// the session. Hold the projection reply to verify the reads overlap, while the
// existing ownership and clear-boundary checks still gate the actual enqueue.
it.each([false, true])('overlaps first-send reads and respects owner loss (owner lost: %s)', async (ownerLost) => {
  const { store, deps, deactivate } = await setup();
  await store.add(message());
  const pendingProjection = deferred<DeliveryProjection>();
  deps.projection.mockReturnValueOnce(pendingProjection.promise);
  const session = { id: 'session', workingDir: '/dialogue' } as RemoteSession;
  const read = vi.fn(async () => session);
  const run = createDurableOutboxDelivery({ ...deps, readSessionForPreparation: read }).run();
  for (let n = 0; n < 40 && !deps.projection.mock.calls.length; n++) await Promise.resolve();
  try {
    expect(deps.projection).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
    expect(deps.enqueue).not.toHaveBeenCalled();
  } finally {
    if (ownerLost) deactivate();
    pendingProjection.resolve({ ...projection('id-1'), clearBoundaryMs: 9 });
    await run;
  }
  if (ownerLost) {
    expect(deps.enqueue).not.toHaveBeenCalled();
  } else {
    expect(deps.prepare).toHaveBeenCalledWith(expect.anything(), session);
    expect(deps.enqueue).toHaveBeenCalledWith(expect.objectContaining({ clearBoundaryMs: 9, enqueueStarted: true }));
  }
});

describe('outbox projection authority', () => {
  const bindProjection = (record: DurableOutboxRecord) =>
    bindOutboxProjection(remoteSessionStore, record.item.sessionId, () => 0);

  it('applies the enqueue response after the preflight projection advances authority', async () => {
    const { store, deps } = await setup();
    await store.add(message());
    remoteSessionStore.clear();
    try {
      deps.enqueue.mockResolvedValue({ ...projection(), queuePaused: true });
      await createDurableOutboxDelivery({ ...deps, bindProjection }).run();

      expect(remoteSessionStore.getInputProjection('session-a').queuePaused).toBe(true);
      expect(store.getSnapshot()[0]).toMatchObject({ state: 'host-owned' });
    } finally {
      remoteSessionStore.clear();
    }
  });

  it('keeps host acceptance but discards the previous connection snapshot after reconnect', async () => {
    const { store, deps } = await setup();
    await store.add(message());
    remoteSessionStore.clear();
    const appliedEpochs: number[] = [];
    let epoch = 0;
    deps.enqueue.mockImplementation(async () => {
      epoch = 1;
      return { ...projection(), queuePaused: true };
    });
    try {
      await createDurableOutboxDelivery({
        ...deps,
        bindProjection(record) {
          const apply = bindOutboxProjection(remoteSessionStore, record.item.sessionId, () => epoch);
          return (snapshot) => {
            const appliedEpoch = apply(snapshot);
            if (appliedEpoch !== undefined) appliedEpochs.push(appliedEpoch);
          };
        },
      }).run();

      expect(appliedEpochs).toEqual([0]);
      expect(remoteSessionStore.getInputProjection('session-a').queuePaused).toBe(false);
      expect(store.getSnapshot()[0]).toMatchObject({ state: 'host-owned' });
    } finally {
      remoteSessionStore.clear();
    }
  });

  it('discards a late reconciliation after a newer push and a concurrent read for the same task', async () => {
    const { store, deps } = await setup();
    await store.add({ ...message('old'), state: 'host-owned', retrySafe: true });
    await store.add(message('new'));
    remoteSessionStore.clear();
    const oldStarted = deferred<void>();
    const newStarted = deferred<void>();
    const oldProjection = deferred<DeliveryProjection>();
    const newProjection = deferred<DeliveryProjection>();
    const oldReconciled = deferred<void>();
    const allowNewProjection = deferred<void>();
    deps.projection.mockImplementation((record) => {
      if (record.item.clientId === 'old') {
        oldStarted.resolve();
        return oldProjection.promise;
      }
      newStarted.resolve();
      return newProjection.promise;
    });
    deps.history.mockImplementation(async () => {
      oldReconciled.resolve();
      return false;
    });
    const delivery = createDurableOutboxDelivery({
      ...deps,
      bindProjection,
      sessionPolicy: async (record) => {
        if (record.item.clientId === 'new') await allowNewProjection.promise;
        return 'deliver';
      },
    });
    const run = delivery.run();
    try {
      await oldStarted.promise;
      remoteSessionStore.setInputProjection('session-a', projection());
      allowNewProjection.resolve();
      await newStarted.promise;
      oldProjection.resolve({ ...projection('old', 'pending'), queuePaused: true });
      await oldReconciled.promise;

      expect(remoteSessionStore.getInputProjection('session-a').queuePaused).toBe(false);
    } finally {
      allowNewProjection.resolve();
      oldProjection.resolve(projection('old', 'pending'));
      newProjection.resolve(projection('new'));
      await run;
      remoteSessionStore.clear();
    }
  });
});

it('starts a newly added message while another task is still being delivered', async () => {
  const { store, deps, runner } = await setup();
  await store.add(message('slow', 'session-a'));
  const slow = deferred<DeliveryProjection>();
  deps.enqueue.mockImplementationOnce(() => slow.promise);
  const first = runner.run();
  await vi.waitFor(() => expect(deps.enqueue).toHaveBeenCalledOnce());
  await store.add(message('fresh', 'session-b'));
  await runner.run();
  expect(deps.enqueue.mock.calls.map(([r]) => r.item.clientId)).toEqual(['slow', 'fresh']);
  slow.resolve(projection('slow'));
  await first;
});

it('frees each delivery slot as soon as that delivery settles, not when its whole batch does', async () => {
  const { store, deps, runner } = await setup();
  await store.add(message('slow', 'session-a'));
  await store.add(message('fast', 'session-b'));
  const slow = deferred<DeliveryProjection>();
  deps.enqueue.mockImplementation((r: DurableOutboxRecord) =>
    r.item.clientId === 'slow' ? slow.promise : Promise.resolve(projection(r.item.clientId)));
  const batch = runner.run();
  await vi.waitFor(() => expect(store.getSnapshot().find((r) => r.item.clientId === 'fast')?.state).toBe('host-owned'));
  await store.add(message('third', 'session-c'));
  await runner.run();
  await vi.waitFor(() =>
    expect(deps.enqueue.mock.calls.map(([r]) => r.item.clientId)).toContain('third'));
  slow.resolve(projection('slow'));
  await batch;
});
