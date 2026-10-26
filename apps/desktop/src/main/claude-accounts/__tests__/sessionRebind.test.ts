/**
 * After an account switch, live local Claude Code subscription sessions are rebuilt at their
 * next turn boundary (resume the same session on the new account); nothing else is touched.
 *
 * 测试价值
 * - 生产入口与可观察结果：rebuildSessionsForAccountSwitch 对哪些活会话发起重建、各自结果
 *   (applied / deferred / failed)，以及单个失败不阻断其它会话。
 * - 规则依据：docs/dev-rules/claude-multi-account.md §4.5（env 在 spawn 时固定，切换后必须重建；
 *   远端会话的配置目录由远端管理，不动；非订阅来源不受账号影响）。
 * - 现有覆盖缺口：凭证切换的重建只由模型 / 来源变化触发，没有账号切换这一入口。
 * - 最小失败输入：一个订阅会话 + 一个 API key 会话 + 一个 SSH 远端会话 + 一个 Codex 会话。
 * - tier：unit（纯编排，宿主函数注入）。
 */
import { describe, expect, it, vi } from 'vitest';

import { rebuildSessionsForAccountSwitch, type LiveSessionInfo } from '../sessionRebind.js';

const sessions: LiveSessionInfo[] = [
  { id: 'sub-idle', agentKind: 'claude-code', remoteHostId: null, providerId: 'anthropic' },
  { id: 'sub-busy', agentKind: 'claude-code', remoteHostId: null, providerId: null },
  { id: 'api-key', agentKind: 'claude-code', remoteHostId: null, providerId: 'openrouter' },
  { id: 'remote', agentKind: 'claude-code', remoteHostId: 'devbox', providerId: 'anthropic' },
  { id: 'codex', agentKind: 'codex', remoteHostId: null, providerId: 'openai' },
];

describe('rebuildSessionsForAccountSwitch', () => {
  it('rebuilds only local Claude Code sessions on a subscription route', async () => {
    const rebuild = vi.fn(async (id: string): Promise<'applied' | 'deferred'> => (id === 'sub-busy' ? 'deferred' : 'applied'));
    const result = await rebuildSessionsForAccountSwitch({
      listLiveSessions: () => sessions,
      isSubscriptionRoute: (s) => s.providerId === 'anthropic' || s.providerId === null,
      rebuild,
    });
    expect(rebuild.mock.calls.map((c) => c[0])).toEqual(['sub-idle', 'sub-busy']);
    expect(result).toEqual({ applied: ['sub-idle'], deferred: ['sub-busy'], failed: [] });
  });

  it('keeps going when one rebuild fails and reports it', async () => {
    const warn = vi.fn();
    const rebuild = vi.fn(async (id: string) => {
      if (id === 'sub-idle') throw new Error('close failed');
      return 'applied' as const;
    });
    const result = await rebuildSessionsForAccountSwitch({
      listLiveSessions: () => sessions,
      isSubscriptionRoute: (s) => s.providerId === 'anthropic' || s.providerId === null,
      rebuild,
      log: { warn },
    });
    expect(result).toEqual({ applied: ['sub-busy'], deferred: [], failed: ['sub-idle'] });
    expect(warn).toHaveBeenCalledWith('claude account switch: session rebuild failed', {
      sessionId: 'sub-idle',
      error: 'close failed',
    });
  });
});
