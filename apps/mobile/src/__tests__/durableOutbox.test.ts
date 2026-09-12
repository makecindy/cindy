import { describe, expect, it, vi } from "vitest";
import { accountVaultKey } from '@cindy/auth-client';
import {
  createDurableOutbox,
  observeDurableOutboxSending,
  type DurableOutboxRecord,
  type OutboxStorage,
} from "../session/durableOutbox";
import {
  createDurableOutboxDelivery,
  type DeliveryProjection,
} from "../session/durableOutboxDelivery";
import type { QueuedRemoteMessage, RemoteMessage } from "../session/types";
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
    applyProjection: vi.fn(),
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

describe("durable mobile outbox ownership", () => {
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
    expect(deps.cleanup).toHaveBeenCalledWith(record, false);
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
    runner.wake();
    deps.projection.mockResolvedValue(projection("id-1", "accepted"));
    deps.history.mockResolvedValue(true);
    await runner.run();
    expect(store.getSnapshot()).toEqual([]);
    expect(deps.cleanup).toHaveBeenCalledOnce();
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
    expect(deps.cleanup).toHaveBeenCalledWith(cancelledRecord, true);
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
