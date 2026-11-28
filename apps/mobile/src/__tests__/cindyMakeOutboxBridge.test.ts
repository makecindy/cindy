import { describe, expect, it, vi } from 'vitest';
import type { DurableOutboxRecord } from '@/session/durableOutbox';
import {
  canConnectOutboxPeer,
  clearOutboxSessionHandoffs,
  createOutboxSessionAccess,
  peekOutboxSessionClearBoundary,
  seedOutboxSessionHandoff,
  takeOutboxSessionHandoff,
} from '@/session/mobileOutboxSessionAdapter';
import type { RemoteSession } from '@/session/types';
import { sharedTaskHostPeer } from '@cindy/device-link';

import {
  beginOutboxBackgroundSend, endOutboxBackgroundSend, hasOutboxBackgroundSend, isPendingDeliveryAfterLeaving, isPendingPlainText,
  subscribeOutboxLeftInBackground, syncOutboxLeftInBackground,
} from '@/session/outboxBackgroundSend';

const requestWork = async () => ({ budgetMs: 8_000, end: () => {} });

function harness(sessions: Array<{ id: string; source?: string; deviceLinkDeviceId: string }>) {
  const record = { deviceId: 'desktop', state: 'queued', uploads: [],
    item: { sessionId: 'session', clientId: 'client', text: '/tmp/report.txt', slashCommandRanges: [], attachmentSlots: [] } } as unknown as DurableOutboxRecord;
  const invoke = vi.fn(async (_device: string, _channel: string, _args: unknown[] | undefined, options: { preSend(): void }): Promise<{ id: string; source: string; workingDir?: string }> => {
    options.preSend(); return { id: 'session', source: 'cc', workingDir: '/repo' };
  });
  const connections = new Map<string, string>();
  const latest = { current: { link: { status: 'online', getPresenceAvailability: () => true, invoke,
    getConnectionState: (deviceId: string): { status: string } => ({ status: connections.get(deviceId) ?? latest.current.link.status }),
  } } };
  const owner = { current: true, records: [record], creationHeld: false, foreground: true };
  const hasCreationTask = vi.fn(() => false);
  const callbacks = createOutboxSessionAccess({
    getSessions: () => sessions,
    getRecords: () => owner.records,
    guard: () => { if (!owner.current) throw new Error('OUTBOX_OWNER_CHANGED'); },
    isCurrent: () => owner.current,
    isForeground: () => owner.foreground,
    canContinueInBackground: hasOutboxBackgroundSend,
    canConnect: (deviceId) => canConnectOutboxPeer(latest.current.link, deviceId),
    isCreationHeld: () => owner.creationHeld,
    hasCreationTask,
    needsReconciliation: () => true,
    invoke: (deviceId, channel, args, options) => latest.current.link.invoke(deviceId, channel, args, options),
    readSession: record => callbacks.invokeOwned(record)(record.deviceId, 'local-db:sessions:get', [record.item.sessionId]),
  });
  return { record, callbacks, invoke, latest, owner, hasCreationTask, connections };
}

describe('Cindy Make outbox bridge guards', () => {
  // Unit: leaving during a composer send used to block the final enqueue gate.
  // A fresh message alone may continue until its acknowledgement or deadline.
  it('continues only the tapped message in background and releases the connection on receipt or timeout', async () => {
    vi.useFakeTimers();
    try {
      const { record, callbacks, owner } = harness([]);
      const release = vi.fn();
      // #11930: a typed path must reach the same handoff as ordinary text.
      expect(isPendingPlainText(record)).toBe(true);
      expect(isPendingPlainText({ ...record, item: {
        ...record.item, text: '/review', slashCommandRanges: [{ start: 0, end: 7 }],
      } })).toBe(false);
      beginOutboxBackgroundSend(record, () => release, requestWork);
      await Promise.resolve();
      owner.foreground = false;
      expect(callbacks.canRun(record)).toBe(true);
      expect(callbacks.canRun({ ...record, accountId: 'other' })).toBe(false);
      expect(callbacks.canRun({ ...record, cancelRequested: true })).toBe(false);
      endOutboxBackgroundSend(record);
      expect(release).toHaveBeenCalledTimes(1);
      expect(callbacks.canRun(record)).toBe(false);
      beginOutboxBackgroundSend(record, () => release, requestWork);
      await vi.advanceTimersByTimeAsync(8_001);
      expect(release).toHaveBeenCalledTimes(2);
      expect(callbacks.canRun(record)).toBe(false);
      owner.foreground = true;
      expect(callbacks.canRun(record)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  // Unit, #11930: foreground sends already show progress and connection waits,
  // so marking every pending text flashed "pending delivery" on ordinary sends.
  // Only text left behind in background, including one saved just after Home,
  // keeps that status until it settles; settled rows are forgotten.
  it('shows pending delivery only for text still on the way after leaving the app', () => {
    const { record } = harness([]);
    const savedAfterHome = { ...record, item: { ...record.item, clientId: 'after-home' } } as DurableOutboxRecord;
    const changed = vi.fn();
    const off = subscribeOutboxLeftInBackground(changed);
    try {
      syncOutboxLeftInBackground([record], false);
      expect(isPendingDeliveryAfterLeaving(record)).toBe(false);
      syncOutboxLeftInBackground([record], true);
      syncOutboxLeftInBackground([record, savedAfterHome], true);
      syncOutboxLeftInBackground([record, savedAfterHome], false);
      expect([record, savedAfterHome].map(isPendingDeliveryAfterLeaving)).toEqual([true, true]);
      expect(isPendingDeliveryAfterLeaving({ ...record, state: 'host-owned' })).toBe(false);
      expect(changed).toHaveBeenCalledTimes(2);
      syncOutboxLeftInBackground([savedAfterHome], false);
      syncOutboxLeftInBackground([record, savedAfterHome], false);
      expect([record, savedAfterHome].map(isPendingDeliveryAfterLeaving)).toEqual([false, true]);
    } finally {
      off();
      syncOutboxLeftInBackground([], false);
    }
  });
  // PR #8182: an unrelated same-account relay outage must not stall a queued
  // shared-task send. Exercise the production delivery policy, not source text.
  it('admits a shared record on its official connection while the primary relay is offline', () => {
    const { record, callbacks, latest, owner, connections } = harness([]);
    const shared = { ...record, deviceId: sharedTaskHostPeer('shared', 'desktop') };
    owner.records.push(shared);
    latest.current.link.status = 'offline';
    connections.set(shared.deviceId, 'online');
    expect(callbacks.canRun(record)).toBe(false);
    expect(callbacks.canRun(shared)).toBe(true);
    connections.set(shared.deviceId, 'stopped');
    expect(callbacks.canRun(shared)).toBe(false);
  });

  // mobile-development: follow-ups wait for creation ownership, while policy and
  // preparation reuse the same authoritative row. Replaces old bridge literals.
  it('waits for both draft handoff and task creation before allowing delivery', () => {
    const { record, callbacks, owner, hasCreationTask } = harness([]);
    owner.creationHeld = true;
    expect(callbacks.canRun(record)).toBe(false);
    expect(hasCreationTask).not.toHaveBeenCalled();
    owner.creationHeld = false;
    hasCreationTask.mockReturnValue(true);
    expect(callbacks.canRun(record)).toBe(false);
    hasCreationTask.mockReturnValue(false);
    expect(callbacks.canRun(record)).toBe(true);
  });

  it('holds early side chat sends while the host is forking and releases the same queue on acknowledgement', () => {
    const row = { id: 'session', source: 'side-chat', deviceLinkDeviceId: 'desktop', pendingLocalCreation: true };
    const { record, callbacks } = harness([row]);
    expect(callbacks.canRun(record)).toBe(false);
    row.pendingLocalCreation = false;
    expect(callbacks.canRun(record)).toBe(true);
  });

  it('shares the authoritative task row between preparation and delivery policy', async () => {
    const { record, callbacks, invoke } = harness([]);
    const row = callbacks.readSessionOnce(record);
    await expect(callbacks.sessionPolicy(record)).resolves.toBe('deliver');
    await expect(row).resolves.toMatchObject({ id: 'session', workingDir: '/repo' });
    expect(callbacks.readSessionOnce(record)).toBe(row);
    expect(invoke).toHaveBeenCalledOnce();
  });

  // Unit: extracting the bridge must retain both ownership barriers around a
  // delayed RPC. Source-visibility tests alone do not cover removal/account changes.
  it('does not send a record removed while the transport was waiting', async () => {
    const { record, callbacks, invoke, owner } = harness([]);
    const sent = vi.fn();
    invoke.mockImplementationOnce(async (_device, _channel, _args, options) => {
      owner.records = [];
      options.preSend();
      sent();
      return { id: 'session', source: 'cc' };
    });
    await expect(callbacks.invokeOwned(record)('desktop', 'maker:input:enqueue', ['session']))
      .rejects.toThrow('OUTBOX_STALE_WRITE');
    expect(sent).not.toHaveBeenCalled();
  });

  it('rejects a late reply after the account owner changes', async () => {
    const { record, callbacks, invoke, owner } = harness([]);
    invoke.mockImplementationOnce(async (_device, _channel, _args, options) => {
      options.preSend();
      owner.current = false;
      return { id: 'session', source: 'cc' };
    });
    await expect(callbacks.invokeOwned(record)('desktop', 'local-db:sessions:get', ['session']))
      .rejects.toThrow('OUTBOX_OWNER_CHANGED');
  });

  it.each(['cindy-make', 'cindy-make-merge'])('selects a suspended hidden %s record for local cleanup even offline', async source => {
    const { record, callbacks, invoke, latest } = harness([{ id: 'session', source, deviceLinkDeviceId: 'desktop' }]);
    record.suspended = true;
    latest.current.link.status = 'offline';
    expect(callbacks.hidden(record)).toBe(true);
    expect(callbacks.canRun(record)).toBe(true);
    await expect(callbacks.sessionPolicy(record)).resolves.toBe('discard');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not confuse the same session ID on another computer with a hidden task', async () => {
    const { record, callbacks, invoke } = harness([{ id: 'session', source: 'cindy-make', deviceLinkDeviceId: 'other-desktop' }]);
    expect(callbacks.hidden(record)).toBe(false);
    await expect(callbacks.sessionPolicy(record)).resolves.toBe('deliver');
    expect(invoke).toHaveBeenCalledWith('desktop', 'local-db:sessions:get', ['session'], expect.anything());
  });

  it.each(['cindy-make', 'cindy-make-merge'])('checks raw metadata again before enqueue when %s arrives late', async source => {
    const sessions = [{ id: 'session', source: 'cc', deviceLinkDeviceId: 'desktop' }];
    const { record, callbacks, invoke } = harness(sessions);
    await expect(callbacks.sessionPolicy(record)).resolves.toBe('deliver');
    const sent = vi.fn();
    invoke.mockImplementationOnce(async (_device, _channel, _args, options) => {
      sessions[0].source = source;
      options.preSend();
      sent();
      return { id: 'session', source };
    });
    await expect(callbacks.invokeOwned(record)('desktop', 'maker:input:enqueue', ['session'])).rejects.toThrow('OUTBOX_SESSION_DISABLED');
    expect(sent).not.toHaveBeenCalled();
    await expect(callbacks.sessionPolicy(record)).resolves.toBe('discard');
  });

  it('keeps ordinary offline records suspended instead of deleting or delivering them', () => {
    const { record, callbacks, latest, hasCreationTask } = harness([{ id: 'session', source: 'cc', deviceLinkDeviceId: 'desktop' }]);
    latest.current.link.status = 'offline';
    expect(callbacks.hidden(record)).toBe(false);
    expect(callbacks.canRun(record)).toBe(false);
    // Creation lookup can scan the ledger; offline records must short-circuit it.
    expect(hasCreationTask).not.toHaveBeenCalled();
    latest.current.link.status = 'online';
    record.suspended = true;
    expect(callbacks.canRun(record)).toBe(false);
  });

  // 测试价值
  // - 生产入口与可观察结果：经 seedOutboxSessionHandoff + peekOutboxSessionClearBoundary +
  //   createOutboxSessionAccess.readSessionOnce 验证新建交接复用权威会话行、省去重复 getSession 与
  //   get-projection，且连接换代 / 超时 / 二次消费时安全回退远端读取。
  // - Bug／规则依据：手机新建首条消息优化（避免新建完成后重复 local-db:sessions:get 与多余 get-projection）。
  // - 现有覆盖缺口：原有用例仅覆盖同一次尝试内的 sessionReads 复用，未覆盖跨新建交接的消费与失效边界。
  // - 最小失败输入：同一 connectionEpoch 下交接一条 clearedAt=null 的新会话；再测换代、超 TTL、已消费与带 clearedAt。
  // - tier：unit（内存态，毫秒级）。
  it('reuses a fresh creation handoff session once on the same connection epoch and falls back when stale', async () => {
    clearOutboxSessionHandoffs();
    try {
      const record = {
        accountId: 'acct-1',
        deviceId: 'desktop',
        state: 'queued',
        uploads: [],
        item: { sessionId: 'session', clientId: 'client', text: 'hello', slashCommandRanges: [], attachmentSlots: [] },
      } as unknown as DurableOutboxRecord;
      const handedOffSession = {
        id: 'session',
        title: '',
        workingDir: '/repo',
        agentKind: 'claude-code',
        permissionMode: 'ask',
        status: 'idle',
        source: null,
        clearedAt: null,
        createdAt: '2026-11-28T00:00:00.000Z',
        updatedAt: '2026-11-28T00:00:00.000Z',
      } as unknown as RemoteSession;
      let currentEpoch = 7;
      const invoke = vi.fn(async (_device: string, _channel: string, _args: unknown[] | undefined, options: { preSend(): void }) => {
        options.preSend();
        return { ...handedOffSession, workingDir: '/repo-fresh' };
      });
      const owner = { current: true, records: [record] };
      const callbacks = createOutboxSessionAccess({
        getSessions: () => [],
        getRecords: () => owner.records,
        guard: () => { if (!owner.current) throw new Error('OUTBOX_OWNER_CHANGED'); },
        isCurrent: () => owner.current,
        isForeground: () => true,
        canConnect: () => true,
        isCreationHeld: () => false,
        hasCreationTask: () => false,
        needsReconciliation: () => true,
        invoke,
        readSession: r => callbacks.invokeOwned(r)(r.deviceId, 'local-db:sessions:get', [r.item.sessionId]),
        takeSeededSession: r => takeOutboxSessionHandoff({
          accountKey: 'acct-1',
          deviceId: r.deviceId,
          sessionId: r.item.sessionId,
          clientId: r.item.clientId,
          connectionEpoch: currentEpoch,
        }, 1_000),
      });

      seedOutboxSessionHandoff({
        accountKey: 'acct-1',
        deviceId: 'desktop',
        sessionId: 'session',
        clientId: 'client',
        connectionEpoch: 7,
        session: handedOffSession,
      }, 1_000);
      expect(peekOutboxSessionClearBoundary({
        accountKey: 'acct-1', deviceId: 'desktop', sessionId: 'session', clientId: 'client', connectionEpoch: 7,
      }, 1_000)).toBeNull();

      // Same connection epoch: consumes seeded session without RPC.
      const row = await callbacks.readSessionOnce(record);
      expect(row).toEqual(handedOffSession);
      expect(invoke).not.toHaveBeenCalled();

      // Already consumed once: a second handoff lookup misses.
      expect(takeOutboxSessionHandoff({
        accountKey: 'acct-1', deviceId: 'desktop', sessionId: 'session', clientId: 'client', connectionEpoch: 7,
      }, 1_000)).toBeUndefined();

      // Reconnect (epoch change), expiry, and non-null clearedAt must not leak stale state.
      seedOutboxSessionHandoff({
        accountKey: 'acct-1', deviceId: 'desktop', sessionId: 'session', clientId: 'client', connectionEpoch: 7,
        session: handedOffSession,
      }, 1_000);
      currentEpoch = 8;
      expect(peekOutboxSessionClearBoundary({
        accountKey: 'acct-1', deviceId: 'desktop', sessionId: 'session', clientId: 'client', connectionEpoch: 8,
      }, 1_000)).toBeUndefined();

      seedOutboxSessionHandoff({
        accountKey: 'acct-1', deviceId: 'desktop', sessionId: 'session', clientId: 'client', connectionEpoch: 8,
        session: { ...handedOffSession, clearedAt: '2026-11-28T00:01:00.000Z' },
      }, 1_000);
      expect(peekOutboxSessionClearBoundary({
        accountKey: 'acct-1', deviceId: 'desktop', sessionId: 'session', clientId: 'client', connectionEpoch: 8,
      }, 1_000)).toBeUndefined();
      expect(takeOutboxSessionHandoff({
        accountKey: 'acct-1', deviceId: 'desktop', sessionId: 'session', clientId: 'client', connectionEpoch: 8,
      }, 20_000)).toBeUndefined();
    } finally {
      clearOutboxSessionHandoffs();
    }
  });
});
