/**
 * IssueConfirmBridge 单测 —— broadcast payload 形状、resolve 命中/未命中、
 * 非法 decision 兜底、超时、按会话清理。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IssueConfirmBridge } from '../issueConfirmBridge';
import { MAKER_PUSH } from '../../maker-ipc/channels';

const DRAFT = { title: '标题标题标题', body: '正文'.repeat(20), type: 'bug' as const };
const ENV = {
  appVersion: '0.0.112',
  platform: 'darwin',
  arch: 'arm64',
  osVersion: '25.5.0',
  region: 'cn' as const,
};
const IDENTITY = { kind: 'github-user', login: 'octocat' } as const;

function lastRequestId(broadcast: ReturnType<typeof vi.fn>): string {
  const call = broadcast.mock.calls.findLast(
    ([channel]) => channel === MAKER_PUSH.INTERACTION_REQUEST,
  );
  if (!call) throw new Error('no INTERACTION_REQUEST broadcast');
  return (call[1] as { request: { requestId: string } }).request.requestId;
}

describe('IssueConfirmBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('request → broadcast kind=issue_confirm 的 INTERACTION_REQUEST payload', () => {
    const broadcast = vi.fn();
    const bridge = new IssueConfirmBridge({ broadcast });
    void bridge.request('sess-1', DRAFT, ENV, IDENTITY);
    expect(broadcast).toHaveBeenCalledTimes(1);
    const [channel, payload] = broadcast.mock.calls[0];
    expect(channel).toBe(MAKER_PUSH.INTERACTION_REQUEST);
    expect(payload).toMatchObject({
      sessionId: 'sess-1',
      request: {
        kind: 'issue_confirm',
        draft: DRAFT,
        env: ENV,
        submissionIdentity: IDENTITY,
      },
    });
    expect((payload as { request: { requestId: string } }).request.requestId).toBeTruthy();
  });

  it('resolve 确认 decision → promise settle 为 confirmed,值取卡片当前版', async () => {
    const broadcast = vi.fn();
    const bridge = new IssueConfirmBridge({ broadcast });
    const promise = bridge.request('sess-1', DRAFT, ENV, IDENTITY);
    const requestId = lastRequestId(broadcast);
    const hit = bridge.resolve(requestId, {
      confirmed: true,
      title: '  用户改过的标题  ',
      body: '用户改过的正文',
      type: 'feature',
      uiLanguage: 'ja',
    });
    expect(hit).toBe(true);
    await expect(promise).resolves.toEqual({
      confirmed: true,
      title: '用户改过的标题',
      body: '用户改过的正文',
      type: 'feature',
      uiLanguage: 'ja',
    });
    // 多窗口同会话:resolve 后必须广播 DISMISSED 让其它窗口收掉僵尸卡片。
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.INTERACTION_DISMISSED, {
      sessionId: 'sess-1',
      requestId,
      reason: 'resolved',
      resolvedAs: 'allow',
    });
  });

  it('平台代发把建议署名传给卡片，并要求响应带有效公开署名', async () => {
    const broadcast = vi.fn();
    const warn = vi.fn();
    const bridge = new IssueConfirmBridge({ broadcast, logger: { warn } });
    const platformIdentity = { kind: 'platform', login: 'cindy-issue' } as const;
    const promise = bridge.request('sess-1', DRAFT, ENV, platformIdentity, '当前昵称');
    const requestId = lastRequestId(broadcast);
    expect(broadcast).toHaveBeenCalledWith(
      MAKER_PUSH.INTERACTION_REQUEST,
      expect.objectContaining({
        request: expect.objectContaining({
          submissionIdentity: platformIdentity,
          suggestedPublicName: '当前昵称',
        }),
      }),
    );

    expect(
      bridge.resolve(requestId, {
        confirmed: true,
        title: DRAFT.title,
        body: DRAFT.body,
        type: DRAFT.type,
        publicName: '  匿名  ',
      }),
    ).toBe(true);
    await expect(promise).resolves.toMatchObject({
      confirmed: true,
      publicName: '匿名',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('平台代发缺少署名或携带换行时按取消兜底', async () => {
    for (const publicName of [undefined, '', '第一行\n第二行']) {
      const broadcast = vi.fn();
      const warn = vi.fn();
      const bridge = new IssueConfirmBridge({ broadcast, logger: { warn } });
      const promise = bridge.request(
        'sess-1',
        DRAFT,
        ENV,
        { kind: 'platform', login: 'cindy-issue' },
        '当前昵称',
      );
      const requestId = lastRequestId(broadcast);
      expect(
        bridge.resolve(requestId, {
          confirmed: true,
          title: DRAFT.title,
          body: DRAFT.body,
          type: DRAFT.type,
          publicName,
        }),
      ).toBe(true);
      await expect(promise).resolves.toEqual({ confirmed: false, reason: 'cancelled' });
      expect(warn).toHaveBeenCalled();
    }
  });

  it('resolve 取消 decision → cancelled;未知 requestId → 返 false', async () => {
    const broadcast = vi.fn();
    const bridge = new IssueConfirmBridge({ broadcast });
    const promise = bridge.request('sess-1', DRAFT, ENV, IDENTITY);
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
    // 已 settle 后重复 resolve 不再命中,也不再重复广播
    const dismissedCount = broadcast.mock.calls.filter(
      ([c]) => c === MAKER_PUSH.INTERACTION_DISMISSED,
    ).length;
    expect(bridge.resolve(requestId, { confirmed: false })).toBe(false);
    expect(
      broadcast.mock.calls.filter(([c]) => c === MAKER_PUSH.INTERACTION_DISMISSED).length,
    ).toBe(dismissedCount);
  });

  it('非法 decision shape → 按 cancelled 兜底,不挂起', async () => {
    const broadcast = vi.fn();
    const warn = vi.fn();
    const bridge = new IssueConfirmBridge({ broadcast, logger: { warn } });
    const promise = bridge.request('sess-1', DRAFT, ENV, IDENTITY);
    const requestId = lastRequestId(broadcast);
    expect(bridge.resolve(requestId, { confirmed: true, title: '' })).toBe(true);
    await expect(promise).resolves.toEqual({ confirmed: false, reason: 'cancelled' });
    expect(warn).toHaveBeenCalled();
  });

  it('超时 → timeout decision + 广播 INTERACTION_DISMISSED', async () => {
    const broadcast = vi.fn();
    const bridge = new IssueConfirmBridge({ broadcast, timeoutMs: 1000 });
    const promise = bridge.request('sess-1', DRAFT, ENV, IDENTITY);
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
    const bridge = new IssueConfirmBridge({ broadcast });
    const p1 = bridge.request('sess-1', DRAFT, ENV, IDENTITY);
    const p2 = bridge.request('sess-2', DRAFT, ENV, IDENTITY);
    bridge.cleanupForSession('sess-1', 'session_aborted');
    await expect(p1).resolves.toEqual({ confirmed: false, reason: 'session_aborted' });
    const dismissed = broadcast.mock.calls.filter(
      ([channel]) => channel === MAKER_PUSH.INTERACTION_DISMISSED,
    );
    expect(dismissed).toHaveLength(1);
    expect(dismissed[0][1]).toMatchObject({ sessionId: 'sess-1', reason: 'session_aborted' });
    // sess-2 仍 pending,resolve 仍可命中
    const req2 = (broadcast.mock.calls[1][1] as { request: { requestId: string } }).request
      .requestId;
    expect(bridge.resolve(req2, { confirmed: false })).toBe(true);
    await expect(p2).resolves.toEqual({ confirmed: false, reason: 'cancelled' });
  });
});
