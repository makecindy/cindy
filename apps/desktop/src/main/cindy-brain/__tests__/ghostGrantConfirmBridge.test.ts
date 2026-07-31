/**
 * GhostGrantConfirmBridge 单测 —— broadcast payload 形状、resolve 命中/未命中、
 * 非法 decision 兜底、超时、按会话清理(镜像 issueConfirmBridge.test 的口径)。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GhostGrantConfirmBridge, type GhostGrantConfirmPayload } from '../ghostGrantConfirmBridge';
import { MAKER_PUSH } from '../../maker-ipc/channels';

const PAYLOAD: GhostGrantConfirmPayload = {
  ghostId: 'xd-mivo',
  ghostName: 'XD Mivo',
  lane: 'attachments',
  items: [
    {
      name: 'first-frame.png',
      absPath: 'C:\\Users\\me\\Desktop\\proj\\first-frame.png',
      size: 2048,
      mimeType: 'image/png',
    },
  ],
};

function lastRequestId(broadcast: ReturnType<typeof vi.fn>): string {
  const call = broadcast.mock.calls.findLast(
    ([channel]) => channel === MAKER_PUSH.INTERACTION_REQUEST,
  );
  if (!call) throw new Error('no INTERACTION_REQUEST broadcast');
  return (call[1] as { request: { requestId: string } }).request.requestId;
}

describe('GhostGrantConfirmBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('request → broadcast kind=ghost_grant_confirm 的 INTERACTION_REQUEST payload', () => {
    const broadcast = vi.fn();
    const bridge = new GhostGrantConfirmBridge({ broadcast });
    void bridge.request('sess-1', PAYLOAD);
    expect(broadcast).toHaveBeenCalledTimes(1);
    const [channel, payload] = broadcast.mock.calls[0];
    expect(channel).toBe(MAKER_PUSH.INTERACTION_REQUEST);
    expect(payload).toMatchObject({
      sessionId: 'sess-1',
      request: {
        kind: 'ghost_grant_confirm',
        ghostId: 'xd-mivo',
        ghostName: 'XD Mivo',
        lane: 'attachments',
        items: PAYLOAD.items,
      },
    });
    expect((payload as { request: { requestId: string } }).request.requestId).toBeTruthy();
    expect(bridge.pendingSnapshots('other-session')).toEqual([]);
    expect(bridge.pendingSnapshots('sess-1')).toEqual([
      { sessionId: 'sess-1', request: (payload as { request: unknown }).request },
    ]);
  });

  it('resolve 允许 → promise settle 为 confirmed:true,并广播 DISMISSED(allow)', async () => {
    const broadcast = vi.fn();
    const bridge = new GhostGrantConfirmBridge({ broadcast });
    const promise = bridge.request('sess-1', PAYLOAD);
    const requestId = lastRequestId(broadcast);
    expect(bridge.resolve(requestId, { confirmed: true })).toBe(true);
    await expect(promise).resolves.toEqual({ confirmed: true, allowDirs: false });
    const dismissed = broadcast.mock.calls.findLast(
      ([channel]) => channel === MAKER_PUSH.INTERACTION_DISMISSED,
    );
    expect(dismissed?.[1]).toMatchObject({ requestId, resolvedAs: 'allow' });
  });

  it('resolve 允许且勾选目录授权 → decision 带 allowDirs:true', async () => {
    const broadcast = vi.fn();
    const bridge = new GhostGrantConfirmBridge({ broadcast });
    const promise = bridge.request('sess-1', PAYLOAD);
    expect(bridge.resolve(lastRequestId(broadcast), { confirmed: true, allowDirs: true })).toBe(
      true,
    );
    await expect(promise).resolves.toEqual({ confirmed: true, allowDirs: true });
  });

  it('resolve 拒绝 → confirmed:false reason=cancelled', async () => {
    const broadcast = vi.fn();
    const bridge = new GhostGrantConfirmBridge({ broadcast });
    const promise = bridge.request('sess-1', PAYLOAD);
    expect(bridge.resolve(lastRequestId(broadcast), { confirmed: false })).toBe(true);
    await expect(promise).resolves.toEqual({ confirmed: false, reason: 'cancelled' });
  });

  it('非法 decision shape → 按取消兜底,不挂起', async () => {
    const broadcast = vi.fn();
    const warn = vi.fn();
    const bridge = new GhostGrantConfirmBridge({ broadcast, logger: { warn } });
    const promise = bridge.request('sess-1', PAYLOAD);
    expect(bridge.resolve(lastRequestId(broadcast), { bogus: 1 })).toBe(true);
    await expect(promise).resolves.toEqual({ confirmed: false, reason: 'cancelled' });
    expect(warn).toHaveBeenCalled();
  });

  it('requestId 不属于本桥 → resolve 返回 false 且不动 pending', () => {
    const broadcast = vi.fn();
    const bridge = new GhostGrantConfirmBridge({ broadcast });
    void bridge.request('sess-1', PAYLOAD);
    expect(bridge.resolve('nope', { confirmed: true })).toBe(false);
  });

  it('超时 → confirmed:false reason=timeout', async () => {
    const broadcast = vi.fn();
    const bridge = new GhostGrantConfirmBridge({ broadcast, timeoutMs: 1000 });
    const promise = bridge.request('sess-1', PAYLOAD);
    vi.advanceTimersByTime(1001);
    await expect(promise).resolves.toEqual({ confirmed: false, reason: 'timeout' });
    expect(bridge.pendingSnapshots()).toEqual([]);
  });

  it('cleanupForSession 只清本会话的 pending', async () => {
    const broadcast = vi.fn();
    const bridge = new GhostGrantConfirmBridge({ broadcast });
    const p1 = bridge.request('sess-1', PAYLOAD);
    const p2 = bridge.request('sess-2', PAYLOAD);
    bridge.cleanupForSession('sess-1', 'session_closed');
    await expect(p1).resolves.toEqual({ confirmed: false, reason: 'session_closed' });
    expect(bridge.pendingSnapshots('sess-1')).toEqual([]);
    expect(bridge.pendingSnapshots('sess-2')).toHaveLength(1);
    // sess-2 仍挂起:resolve 它以免测试悬挂。
    const requestId2 = lastRequestId(broadcast);
    expect(bridge.resolve(requestId2, { confirmed: true })).toBe(true);
    await expect(p2).resolves.toEqual({ confirmed: true, allowDirs: false });
  });
});
