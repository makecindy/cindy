import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearSessionProvider,
  getSessionProvider,
  setSessionProvider,
} from '../../maker-host/session-provider-store.js';
import {
  PendingCredentialSwitchService,
  type PendingCredentialSwitchDeps,
} from '../pendingCredentialSwitch.js';

const touchedSessions = new Set<string>();

afterEach(() => {
  for (const sessionId of touchedSessions) {
    clearSessionProvider(sessionId);
  }
  touchedSessions.clear();
});

function rememberSession(sessionId: string): string {
  touchedSessions.add(sessionId);
  return sessionId;
}

interface HarnessSession {
  id: string;
  agentKind: 'claude-code' | 'codex';
  remoteHostId?: string | null;
  isTurnRunning?: () => boolean;
}

function createHarness(
  sessions: HarnessSession[],
  opts?: { retryDelayMs?: number; resolveRoute?: PendingCredentialSwitchDeps['resolveRoute'] },
) {
  const closeSession = vi.fn(async (_sessionId: string) => {});
  const broadcastApplied = vi.fn<NonNullable<PendingCredentialSwitchDeps['broadcastApplied']>>();
  const onApplied = vi.fn<NonNullable<PendingCredentialSwitchDeps['onApplied']>>();
  const persistRoute = vi.fn<NonNullable<PendingCredentialSwitchDeps['persistRoute']>>(
    async () => {},
  );
  const service = new PendingCredentialSwitchService({
    maker: {
      listActiveSessions: () => sessions,
      closeSession,
    },
    broadcastApplied,
    onApplied,
    persistRoute,
    ...(opts?.resolveRoute ? { resolveRoute: opts.resolveRoute } : {}),
    ...(opts?.retryDelayMs !== undefined ? { retryDelayMs: opts.retryDelayMs } : {}),
  });
  return { service, closeSession, broadcastApplied, onApplied, persistRoute, sessions };
}

describe('PendingCredentialSwitchService', () => {
  it('keeps the pending switch while the session is still running', async () => {
    const sessionId = rememberSession('pending-switch-still-busy');
    setSessionProvider(sessionId, 'openai');
    const h = createHarness([
      { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => true },
    ]);

    h.service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    await h.service.onTurnSettled(sessionId);

    expect(h.service.has(sessionId)).toBe(true);
    expect(h.closeSession).not.toHaveBeenCalled();
    expect(h.broadcastApplied).not.toHaveBeenCalled();
    expect(getSessionProvider(sessionId)).toBe('openai');
  });

  it('applies the switch at turn end: closes the session, writes the route, notifies', async () => {
    const sessionId = rememberSession('pending-switch-apply');
    setSessionProvider(sessionId, 'openai');
    const h = createHarness([
      { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
    ]);

    h.service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    await h.service.onTurnSettled(sessionId);

    expect(h.service.has(sessionId)).toBe(false);
    expect(h.closeSession).toHaveBeenCalledWith(sessionId);
    expect(getSessionProvider(sessionId)).toBe('xd');
    expect(h.broadcastApplied).toHaveBeenCalledWith({
      sessionId,
      model: 'gpt-5.5',
      providerId: 'xd',
    });
    expect(h.onApplied).toHaveBeenCalledWith(sessionId);
  });

  it('re-registration overwrites the previous pending target (last click wins)', async () => {
    const sessionId = rememberSession('pending-switch-overwrite');
    setSessionProvider(sessionId, 'openai');
    const h = createHarness([
      { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
    ]);

    h.service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    h.service.register(sessionId, { model: 'gpt-5.5', providerId: 'openai' });
    await h.service.onTurnSettled(sessionId);

    expect(getSessionProvider(sessionId)).toBe('openai');
    expect(h.broadcastApplied).toHaveBeenCalledWith({
      sessionId,
      model: 'gpt-5.5',
      providerId: 'openai',
    });
  });

  it('applies the route directly when the session was closed by another path', () => {
    const sessionId = rememberSession('pending-switch-closed');
    setSessionProvider(sessionId, 'openai');
    const h = createHarness([]);

    h.service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    h.service.onSessionClosed(sessionId);

    expect(h.service.has(sessionId)).toBe(false);
    expect(getSessionProvider(sessionId)).toBe('xd');
    expect(h.broadcastApplied).toHaveBeenCalledTimes(1);
    expect(h.onApplied).toHaveBeenCalledWith(sessionId);
  });

  it('still applies the route when closing the session fails hard', async () => {
    // close 失败不能让用户的选择静默蒸发:route 照写,下一次发送由 getHost 仲裁兜底。
    const sessionId = rememberSession('pending-switch-close-failed');
    setSessionProvider(sessionId, 'openai');
    const h = createHarness([
      { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
    ]);
    h.closeSession.mockRejectedValueOnce(new Error('close blew up'));

    h.service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    await h.service.onTurnSettled(sessionId);

    expect(h.service.has(sessionId)).toBe(false);
    expect(getSessionProvider(sessionId)).toBe('xd');
    expect(h.broadcastApplied).toHaveBeenCalledTimes(1);
  });

  it('applies the latest registration when the user re-selects during the async close (last click wins)', async () => {
    // review P1(2026-07-04):await closeSession 期间用户又切了一次来源,收口必须用
    // 当前登记而非进入函数时捕获的 stale target,否则后选被先选覆盖。
    const sessionId = rememberSession('pending-switch-reselect-during-close');
    setSessionProvider(sessionId, 'openai');
    const h = createHarness([
      { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
    ]);
    const service = h.service;
    h.closeSession.mockImplementationOnce(async () => {
      service.register(sessionId, { model: 'gpt-5.4', providerId: 'openai' });
    });

    service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    await service.onTurnSettled(sessionId);

    expect(getSessionProvider(sessionId)).toBe('openai');
    expect(h.broadcastApplied).toHaveBeenCalledTimes(1);
    expect(h.broadcastApplied).toHaveBeenCalledWith({
      sessionId,
      model: 'gpt-5.4',
      providerId: 'openai',
    });
  });

  it('respects a clear() issued during the async close and applies nothing', async () => {
    const sessionId = rememberSession('pending-switch-clear-during-close');
    setSessionProvider(sessionId, 'openai');
    const h = createHarness([
      { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
    ]);
    const service = h.service;
    h.closeSession.mockImplementationOnce(async () => {
      service.clear(sessionId);
    });

    service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    await service.onTurnSettled(sessionId);

    expect(getSessionProvider(sessionId)).toBe('openai');
    expect(h.broadcastApplied).not.toHaveBeenCalled();
    expect(h.onApplied).not.toHaveBeenCalled();
  });

  it('does not double-apply when its own close triggers the session-closed hook', async () => {
    // onTurnSettled 的 apply 内部 closeSession 会触发宿主的 closed 事件接线,
    // 该事件反过来调 onSessionClosed —— 完成权必须归 turn-settled 路径,只广播一次。
    const sessionId = rememberSession('pending-switch-reentrant-close');
    setSessionProvider(sessionId, 'openai');
    const h = createHarness([
      { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
    ]);
    const service = h.service;
    h.closeSession.mockImplementationOnce(async () => {
      // 模拟 register.ts 的 closed 状态钩子在 close 过程中同步回调。
      service.onSessionClosed(sessionId);
    });

    service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    await service.onTurnSettled(sessionId);

    expect(getSessionProvider(sessionId)).toBe('xd');
    expect(h.broadcastApplied).toHaveBeenCalledTimes(1);
    expect(h.onApplied).toHaveBeenCalledTimes(1);
  });

  it('self-heals via the retry timer when the turn ends without a done/error event', async () => {
    // stop/interrupt/SDK crash 可能只发 status idle、不发 done/error:事件接线两条
    // 路径都不触发,pending 门会把队列冻死 —— 自愈定时器必须兜住。
    const sessionId = rememberSession('pending-switch-self-heal');
    setSessionProvider(sessionId, 'openai');
    let running = true;
    const h = createHarness(
      [{ id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => running }],
      { retryDelayMs: 10 },
    );

    h.service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    // 第一轮定时器触发时仍在跑 → 保留 pending 并续期。
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(h.service.has(sessionId)).toBe(true);

    // turn 静默死亡(无 done/error 事件),tracker 归 idle。
    running = false;
    await vi.waitFor(() => {
      expect(h.service.has(sessionId)).toBe(false);
    }, { timeout: 1000, interval: 10 });
    expect(getSessionProvider(sessionId)).toBe('xd');
    expect(h.onApplied).toHaveBeenCalledWith(sessionId);
    expect(h.broadcastApplied).toHaveBeenCalledTimes(1);
  });

  it('keeps the queue wake even when the applied broadcast throws', async () => {
    // broadcast 只是 UI 提示;它抛错(如目标窗口已销毁)不允许连带吞掉队列唤醒。
    const sessionId = rememberSession('pending-switch-broadcast-throw');
    setSessionProvider(sessionId, 'openai');
    const h = createHarness([
      { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
    ]);
    h.broadcastApplied.mockImplementationOnce(() => {
      throw new Error('window destroyed');
    });

    h.service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    await expect(h.service.onTurnSettled(sessionId)).resolves.toBeUndefined();

    expect(getSessionProvider(sessionId)).toBe('xd');
    expect(h.onApplied).toHaveBeenCalledWith(sessionId);
  });

  it('is a no-op for sessions without a pending switch', async () => {
    const h = createHarness([]);
    await h.service.onTurnSettled('never-registered');
    h.service.onSessionClosed('never-registered');
    expect(h.broadcastApplied).not.toHaveBeenCalled();
    expect(h.onApplied).not.toHaveBeenCalled();
  });

  describe('收口前的停用重裁决(PR #744 review 第七轮起,宽松降级形态)', () => {
    it('显式来源在等待期间被停用 ⇒ 按裁决改道到替代来源并回写 DB', async () => {
      const sessionId = rememberSession('pending-switch-revalidate-reroute');
      setSessionProvider(sessionId, 'openai');
      const resolveRoute = vi.fn(async (_a: string, model: string, _pid: string | null) => ({
        model,
        providerId: 'anthropic',
        degraded: true,
      }));
      const h = createHarness(
        [{ id: sessionId, agentKind: 'claude-code', remoteHostId: null, isTurnRunning: () => false }],
        { resolveRoute },
      );

      h.service.register(sessionId, {
        model: 'claude-opus-5',
        providerId: 'xd',
        agentKind: 'claude-code',
      });
      await h.service.onTurnSettled(sessionId);

      expect(h.service.has(sessionId)).toBe(false);
      expect(getSessionProvider(sessionId)).toBe('anthropic');
      expect(h.persistRoute).toHaveBeenCalledWith(sessionId, {
        providerId: 'anthropic',
        model: 'claude-opus-5',
      });
      expect(h.broadcastApplied).toHaveBeenCalledWith({
        sessionId,
        model: 'claude-opus-5',
        providerId: 'anthropic',
      });
      expect(h.onApplied).toHaveBeenCalledWith(sessionId);
    });

    it('目标模型全部拷贝被停用 ⇒ 连模型一起换到启用兜底并回写(store + DB + 广播)', async () => {
      // renderer 已把停用模型预写进 DB:只清来源不够 —— 下一次懒 resume 会经停用的
      // 隐式来源重建(resume 免裁决,PR #744 review 第十四轮)。
      const sessionId = rememberSession('pending-switch-revalidate-model-swap');
      setSessionProvider(sessionId, 'openai');
      const resolveRoute = vi.fn(async () => ({
        model: 'claude-haiku-4-5',
        providerId: 'anthropic',
        degraded: true,
        effort: 'low',
      }));
      const h = createHarness(
        [{ id: sessionId, agentKind: 'claude-code', remoteHostId: null, isTurnRunning: () => false }],
        { resolveRoute },
      );

      h.service.register(sessionId, {
        model: 'claude-opus-5',
        providerId: 'xd',
        agentKind: 'claude-code',
      });
      await h.service.onTurnSettled(sessionId);

      expect(h.service.has(sessionId)).toBe(false);
      expect(getSessionProvider(sessionId)).toBe('anthropic');
      expect(h.persistRoute).toHaveBeenCalledWith(sessionId, {
        providerId: 'anthropic',
        model: 'claude-haiku-4-5',
        effort: 'low',
      });
      expect(h.broadcastApplied).toHaveBeenCalledWith({
        sessionId,
        model: 'claude-haiku-4-5',
        providerId: 'anthropic',
      });
      expect(h.onApplied).toHaveBeenCalledWith(sessionId);
    });

    it('目标全停且无启用兜底 ⇒ 回滚到切换前路由(register 捕获的 previousRoute)', async () => {
      const sessionId = rememberSession('pending-switch-rollback-previous');
      setSessionProvider(sessionId, 'openai');
      const resolveRoute = vi.fn(async () => ({
        model: undefined,
        providerId: null,
        degraded: true,
      }));
      const h = createHarness(
        [{ id: sessionId, agentKind: 'claude-code', remoteHostId: null, isTurnRunning: () => false }],
        { resolveRoute },
      );

      h.service.register(sessionId, {
        model: 'claude-opus-5',
        providerId: 'xd',
        agentKind: 'claude-code',
        // 回滚成套:renderer 已把目标 model/effort/fast 落盘,只回滚 model 会让旧
        // 模型配上目标档位被上游拒(第十八轮)。
        previousRoute: {
          model: 'claude-sonnet-4-6',
          providerId: 'openai',
          effort: 'high',
          fastMode: false,
        },
      });
      await h.service.onTurnSettled(sessionId);

      expect(getSessionProvider(sessionId)).toBe('openai');
      expect(h.persistRoute).toHaveBeenCalledWith(sessionId, {
        providerId: 'openai',
        model: 'claude-sonnet-4-6',
        effort: 'high',
        fastMode: false,
      });
      expect(h.broadcastApplied).toHaveBeenCalledWith({
        sessionId,
        model: 'claude-sonnet-4-6',
        providerId: 'openai',
      });
    });

    it('回写失败 ⇒ fail-closed:保留登记(队列门不解除)、不广播、留给自愈重试', async () => {
      const sessionId = rememberSession('pending-switch-persist-fail');
      setSessionProvider(sessionId, 'openai');
      const resolveRoute = vi.fn(async (_a: string, model: string) => ({
        model,
        providerId: 'anthropic',
        degraded: true,
      }));
      const h = createHarness(
        [{ id: sessionId, agentKind: 'claude-code', remoteHostId: null, isTurnRunning: () => false }],
        { resolveRoute, retryDelayMs: 60_000 },
      );
      h.persistRoute.mockRejectedValueOnce(new Error('disk on fire'));

      h.service.register(sessionId, {
        model: 'claude-opus-5',
        providerId: 'xd',
        agentKind: 'claude-code',
      });
      await h.service.onTurnSettled(sessionId);

      // DB 还躺着 renderer 预写的停用目标:此刻唤醒队列 = 排队消息按停用路由懒 resume。
      expect(h.service.has(sessionId)).toBe(true);
      expect(h.onApplied).not.toHaveBeenCalled();
      expect(h.broadcastApplied).not.toHaveBeenCalled();
    });

    it('目录里一个启用对话模型都没有 ⇒ 只清显式来源(store null + DB 回写 null)', async () => {
      const sessionId = rememberSession('pending-switch-revalidate-all-dead');
      setSessionProvider(sessionId, 'openai');
      const resolveRoute = vi.fn(async () => ({
        model: undefined,
        providerId: null,
        degraded: true,
      }));
      const h = createHarness(
        [{ id: sessionId, agentKind: 'claude-code', remoteHostId: null, isTurnRunning: () => false }],
        { resolveRoute },
      );

      h.service.register(sessionId, {
        model: 'claude-opus-5',
        providerId: 'xd',
        agentKind: 'claude-code',
      });
      await h.service.onTurnSettled(sessionId);

      expect(getSessionProvider(sessionId)).toBeNull();
      expect(h.persistRoute).toHaveBeenCalledWith(sessionId, {
        providerId: null,
        model: 'claude-opus-5',
      });
      expect(h.onApplied).toHaveBeenCalledWith(sessionId);
    });

    it('复核异常 ⇒ fail-closed:route 不写、保留登记(队列门不解除)、留给自愈重试', async () => {
      // DB 里躺着 renderer 预写的目标路由(可能恰在等待期间被停用),异常时收口唤醒
      // 会让排队消息按未经复核的路由懒 resume(PR #744 review 第二十轮)。
      const sessionId = rememberSession('pending-switch-revalidate-throw');
      setSessionProvider(sessionId, 'openai');
      const resolveRoute = vi.fn(async () => {
        throw new Error('catalog exploded');
      });
      const h = createHarness(
        [{ id: sessionId, agentKind: 'claude-code', remoteHostId: null, isTurnRunning: () => false }],
        { resolveRoute, retryDelayMs: 60_000 },
      );

      h.service.register(sessionId, {
        model: 'claude-opus-5',
        providerId: 'xd',
        agentKind: 'claude-code',
      });
      await h.service.onTurnSettled(sessionId);

      expect(h.service.has(sessionId)).toBe(true);
      expect(getSessionProvider(sessionId)).toBe('openai');
      expect(h.persistRoute).not.toHaveBeenCalled();
      expect(h.onApplied).not.toHaveBeenCalled();
      expect(h.broadcastApplied).not.toHaveBeenCalled();
    });

    it('裁决通过 ⇒ 原样应用;register 未带 agentKind ⇒ 双 agent 保守,不采纳跨 agent 结果', async () => {
      const sessionId = rememberSession('pending-switch-revalidate-pass');
      setSessionProvider(sessionId, 'openai');
      const resolveRoute = vi.fn(
        async (_a: string, model: string, providerId: string | null) => ({
          model,
          providerId,
          degraded: false,
        }),
      );
      const h = createHarness(
        [{ id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false }],
        { resolveRoute },
      );

      h.service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd', agentKind: 'codex' });
      await h.service.onTurnSettled(sessionId);
      expect(getSessionProvider(sessionId)).toBe('xd');
      // R23:裁决接线存在时收口恒写幂等回正(吸收旧 finalizer 迟到写竞态),
      // 路由未改也回写 (providerId, model) —— 对 renderer 已写值的幂等重写。
      expect(h.persistRoute).toHaveBeenCalledWith(sessionId, {
        providerId: 'xd',
        model: 'gpt-5.5',
      });
      expect(resolveRoute).toHaveBeenCalledWith('codex', 'gpt-5.5', 'xd', {
        desiredFastMode: false,
      });

      // agentKind 缺席:任一 agent 的裁决要求改动(此处 codex 判 reroute)即清空显式
      // 来源,绝不把按别的 agent 解析出的来源钉给真实会话(第十二、十三轮)。
      const sessionId2 = rememberSession('pending-switch-no-agentkind');
      setSessionProvider(sessionId2, 'openai');
      const resolveRoute2 = vi.fn(async (agent: string, model: string, providerId: string | null) =>
        agent === 'codex'
          ? { model, providerId: 'anthropic', degraded: true }
          : { model, providerId, degraded: false },
      );
      const h2 = createHarness(
        [{ id: sessionId2, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false }],
        { resolveRoute: resolveRoute2 },
      );
      h2.service.register(sessionId2, { model: 'gpt-5.5', providerId: 'xd' });
      await h2.service.onTurnSettled(sessionId2);
      expect(h2.service.has(sessionId2)).toBe(false);
      expect(getSessionProvider(sessionId2)).toBeNull();
      expect(resolveRoute2).toHaveBeenCalledWith('claude-code', 'gpt-5.5', 'xd');
      expect(resolveRoute2).toHaveBeenCalledWith('codex', 'gpt-5.5', 'xd');
    });
  });
});
