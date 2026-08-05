/**
 * RenameSessionsConfirmBridge 单测 —— broadcast payload 形状、resolve 命中/未命中、
 * 非法 decision 兜底、超时、按会话清理。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAKER_PUSH } from '../../maker-ipc/channels';
import { RenameSessionsConfirmBridge } from '../renameSessionsConfirmBridge';

const CHANGES = [
  {
    sessionId: 'session-1',
    currentTitle: 'Old title',
    newTitle: 'New title',
    workingDir: '/repo',
    updatedAt: '2026-06-23T00:00:00.000Z',
  },
];

function lastRequestId(broadcast: ReturnType<typeof vi.fn>): string {
  const call = broadcast.mock.calls.findLast(
    ([channel]) => channel === MAKER_PUSH.INTERACTION_REQUEST,
  );
  if (!call) throw new Error('no INTERACTION_REQUEST broadcast');
  return (call[1] as { request: { requestId: string } }).request.requestId;
}

describe('RenameSessionsConfirmBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('request → broadcast kind=rename_sessions_confirm 的 INTERACTION_REQUEST payload', () => {
    const broadcast = vi.fn();
    const bridge = new RenameSessionsConfirmBridge({ broadcast });
    void bridge.request('sess-1', CHANGES);
    expect(broadcast).toHaveBeenCalledTimes(1);
    const [channel, payload] = broadcast.mock.calls[0];
    expect(channel).toBe(MAKER_PUSH.INTERACTION_REQUEST);
    expect(payload).toMatchObject({
      sessionId: 'sess-1',
      request: { kind: 'rename_sessions_confirm', changes: CHANGES },
    });
    expect((payload as { request: { requestId: string } }).request.requestId).toBeTruthy();
  });

  it('resolve 确认 decision → promise settle 为 confirmed', async () => {
    const broadcast = vi.fn();
    const bridge = new RenameSessionsConfirmBridge({ broadcast });
    const promise = bridge.request('sess-1', CHANGES);
    const requestId = lastRequestId(broadcast);
    expect(bridge.resolve(requestId, { confirmed: true })).toBe(true);
    await expect(promise).resolves.toEqual({ confirmed: true });
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.INTERACTION_DISMISSED, {
      sessionId: 'sess-1',
      requestId,
      reason: 'resolved',
      resolvedAs: 'allow',
    });
  });

  it('resolve 取消 decision → cancelled;未知 requestId → 返 false', async () => {
    const broadcast = vi.fn();
    const bridge = new RenameSessionsConfirmBridge({ broadcast });
    const promise = bridge.request('sess-1', CHANGES);
    const requestId = lastRequestId(broadcast);
    expect(bridge.resolve('nope', { confirmed: false })).toBe(false);
    expect(bridge.resolve(requestId, { confirmed: false })).toBe(true);
    await expect(promise).resolves.toEqual({ confirmed: false, reason: 'cancelled' });
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.INTERACTION_DISMISSED, {
      sessionId: 'sess-1',
      requestId,
      reason: 'resolved',
      resolvedAs: 'deny',
    });
  });

  it('非法 decision shape → 按 cancelled 兜底,不挂起', async () => {
    const broadcast = vi.fn();
    const warn = vi.fn();
    const bridge = new RenameSessionsConfirmBridge({ broadcast, logger: { warn } });
    const promise = bridge.request('sess-1', CHANGES);
    const requestId = lastRequestId(broadcast);
    expect(bridge.resolve(requestId, { confirmed: 'yes' })).toBe(true);
    await expect(promise).resolves.toEqual({ confirmed: false, reason: 'cancelled' });
    expect(warn).toHaveBeenCalled();
  });

  it('超时 → timeout decision + 广播 INTERACTION_DISMISSED', async () => {
    const broadcast = vi.fn();
    const bridge = new RenameSessionsConfirmBridge({ broadcast, timeoutMs: 1000 });
    const promise = bridge.request('sess-1', CHANGES);
    const requestId = lastRequestId(broadcast);
    vi.advanceTimersByTime(1001);
    await expect(promise).resolves.toEqual({ confirmed: false, reason: 'timeout' });
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.INTERACTION_DISMISSED, {
      sessionId: 'sess-1',
      requestId,
      reason: 'timeout',
      resolvedAs: 'deny',
    });
  });

  it('cleanupForSession 只清目标会话的 pending,并广播收卡', async () => {
    const broadcast = vi.fn();
    const bridge = new RenameSessionsConfirmBridge({ broadcast });
    const p1 = bridge.request('sess-1', CHANGES);
    const p2 = bridge.request('sess-2', CHANGES);
    bridge.cleanupForSession('sess-1', 'session_aborted');
    await expect(p1).resolves.toEqual({ confirmed: false, reason: 'session_aborted' });
    const dismissed = broadcast.mock.calls.filter(
      ([channel]) => channel === MAKER_PUSH.INTERACTION_DISMISSED,
    );
    expect(dismissed).toHaveLength(1);
    expect(dismissed[0][1]).toMatchObject({ sessionId: 'sess-1', reason: 'session_aborted' });

    const req2 = (broadcast.mock.calls[1][1] as { request: { requestId: string } }).request
      .requestId;
    expect(bridge.resolve(req2, { confirmed: false })).toBe(true);
    await expect(p2).resolves.toEqual({ confirmed: false, reason: 'cancelled' });
  });
});
