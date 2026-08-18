import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearSessionProvider,
  getSessionProvider,
  setSessionProvider,
} from '../../maker-host/session-provider-store.js';
import { applyRuntimeSetModelChange, type RuntimeSetModelMaker } from '../runtimeSetModel.js';

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

describe('applyRuntimeSetModelChange', () => {
  it('rolls back provider route when live setModel rejects', async () => {
    const sessionId = rememberSession('runtime-set-model-rollback');
    setSessionProvider(sessionId, 'xd');
    const setModel = vi.fn(async () => {
      throw new Error('transport rejected');
    });
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({
        agentKind: 'codex',
        remoteHostId: null,
        model: 'codex/gpt-5.5',
        setModel,
      }),
      listActiveSessions: () => [],
      closeSession: vi.fn(async () => {}),
    };

    await expect(
      applyRuntimeSetModelChange({
        maker,
        sessionId,
        model: 'codex/gpt-5.5',
        providerId: null,
      }),
    ).rejects.toThrow('transport rejected');

    expect(setModel).toHaveBeenCalledWith('codex/gpt-5.5', { providerId: null });
    expect(getSessionProvider(sessionId)).toBe('xd');
  });

  it('keeps a successful provider route change after live setModel succeeds', async () => {
    const sessionId = rememberSession('runtime-set-model-success');
    const setModel = vi.fn(async () => {});
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({
        agentKind: 'codex',
        remoteHostId: null,
        model: 'codex/gpt-5.5',
        setModel,
      }),
      listActiveSessions: () => [],
      closeSession: vi.fn(async () => {}),
    };

    await applyRuntimeSetModelChange({
      maker,
      sessionId,
      model: 'codex/gpt-5.5',
      providerId: 'xd',
    });

    expect(setModel).toHaveBeenCalledWith('codex/gpt-5.5', { providerId: 'xd' });
    expect(getSessionProvider(sessionId)).toBe('xd');
  });

  it('model-only 且未 hydrate 时不把 providerId:null 传进 runtime', async () => {
    const sessionId = rememberSession('runtime-set-model-unhydrated-model-only');
    const setModel = vi.fn(async () => {});
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({
        agentKind: 'claude-code',
        remoteHostId: null,
        model: 'grok-4.6',
        setModel,
      }),
      listActiveSessions: () => [],
      closeSession: vi.fn(async () => {}),
    };

    await applyRuntimeSetModelChange({
      maker,
      sessionId,
      model: 'grok-4.6',
    });

    expect(setModel).toHaveBeenCalledWith('grok-4.6', {});
    expect(getSessionProvider(sessionId)).toBeNull();
  });

  it('forwards the atomic effort to live setModel for preflight validation', async () => {
    const sessionId = rememberSession('runtime-set-model-effort-preflight');
    setSessionProvider(sessionId, 'native-a');
    const setModel = vi.fn(async () => {});
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({
        agentKind: 'pi',
        remoteHostId: null,
        model: 'local-model',
        setModel,
      }),
      listActiveSessions: () => [],
      closeSession: vi.fn(async () => {}),
    };

    await applyRuntimeSetModelChange({
      maker,
      sessionId,
      model: 'target-model',
      providerId: 'native-a',
      effort: 'high',
    });

    expect(setModel).toHaveBeenCalledWith('target-model', {
      providerId: 'native-a',
      effort: 'high',
    });
  });

  it('normalizes a whitespace provider before route and busy-session decisions', async () => {
    const sessionId = rememberSession('runtime-set-model-normalize-provider');
    const setModel = vi.fn(async () => {});
    const registerPendingCredentialSwitch = vi.fn();
    const clearPendingCredentialSwitch = vi.fn();
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({
        agentKind: 'codex',
        remoteHostId: null,
        model: 'gpt-5.4',
        setModel,
      }),
      listActiveSessions: () => [
        {
          id: sessionId,
          agentKind: 'codex',
          remoteHostId: null,
          isTurnRunning: () => true,
        },
      ],
      closeSession: vi.fn(async () => {}),
    };

    const result = await applyRuntimeSetModelChange({
      maker,
      sessionId,
      model: 'gpt-5.4',
      providerId: '   ',
      registerPendingCredentialSwitch,
      clearPendingCredentialSwitch,
    });

    expect(result).toEqual({ status: 'applied' });
    expect(registerPendingCredentialSwitch).not.toHaveBeenCalled();
    expect(clearPendingCredentialSwitch).toHaveBeenCalledWith(sessionId);
    expect(setModel).toHaveBeenCalledWith('gpt-5.4', { providerId: null });
    expect(getSessionProvider(sessionId)).toBeNull();
  });

  it('soft-closes local Codex sessions instead of reusing a host across credential families', async () => {
    const sessionId = rememberSession('runtime-set-model-close-codex');
    setSessionProvider(sessionId, 'openai');
    const setModel = vi.fn(async () => {});
    const closeSession = vi.fn(async () => {});
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({
        agentKind: 'codex',
        remoteHostId: null,
        model: 'gpt-5.4',
        setModel,
      }),
      listActiveSessions: () => [
        {
          id: sessionId,
          agentKind: 'codex',
          remoteHostId: null,
          isTurnRunning: () => false,
        },
      ],
      closeSession,
    };

    await applyRuntimeSetModelChange({
      maker,
      sessionId,
      model: 'codex/gpt-5.5',
      providerId: 'xd',
    });

    expect(closeSession).toHaveBeenCalledWith(sessionId);
    expect(setModel).not.toHaveBeenCalled();
    expect(getSessionProvider(sessionId)).toBe('xd');
  });

  it('soft-closes a local Codex session before switching into xAI provider OAuth routing', async () => {
    const sessionId = rememberSession('runtime-set-model-close-codex-xai');
    setSessionProvider(sessionId, 'xd');
    const setModel = vi.fn(async () => {});
    const closeSession = vi.fn(async () => {});
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({
        agentKind: 'codex',
        remoteHostId: null,
        model: 'gpt-5.4',
        setModel,
      }),
      listActiveSessions: () => [
        {
          id: sessionId,
          agentKind: 'codex',
          remoteHostId: null,
          isTurnRunning: () => false,
        },
      ],
      closeSession,
    };

    await applyRuntimeSetModelChange({
      maker,
      sessionId,
      model: 'xai/grok-4.3',
      providerId: 'xai',
    });

    expect(closeSession).toHaveBeenCalledWith(sessionId);
    expect(setModel).not.toHaveBeenCalled();
    expect(getSessionProvider(sessionId)).toBe('xai');
  });

  it('hot-reuses a proxy-active local Codex session when switching into xAI provider OAuth routing', async () => {
    const sessionId = rememberSession('runtime-set-model-hot-xai');
    setSessionProvider(sessionId, 'xd');
    const setModel = vi.fn(async () => {});
    const closeSession = vi.fn(async () => {});
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({
        agentKind: 'codex',
        remoteHostId: null,
        codexProxyActive: true,
        model: 'gpt-5.4',
        setModel,
      }),
      listActiveSessions: () => [
        {
          id: sessionId,
          agentKind: 'codex',
          remoteHostId: null,
          isTurnRunning: () => false,
        },
      ],
      closeSession,
    };

    await applyRuntimeSetModelChange({
      maker,
      sessionId,
      model: 'xai/grok-4.3',
      providerId: 'xai',
    });

    expect(closeSession).not.toHaveBeenCalled();
    expect(setModel).toHaveBeenCalledWith('xai/grok-4.3', { providerId: 'xai' });
    expect(getSessionProvider(sessionId)).toBe('xai');
  });

  it('defers a running proxy-active Codex provider switch until the turn boundary', async () => {
    const sessionId = rememberSession('runtime-set-model-oauth-to-xd-superset');
    setSessionProvider(sessionId, 'openai');
    const setModel = vi.fn(async () => {});
    const closeSession = vi.fn(async () => {});
    const registerPendingCredentialSwitch = vi.fn();
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({
        agentKind: 'codex', remoteHostId: null, codexProxyActive: true,
        model: 'gpt-5.4', setModel,
      }),
      listActiveSessions: () => [{
        id: sessionId, agentKind: 'codex', remoteHostId: null,
        isTurnRunning: () => true,
      }],
      closeSession,
    };

    const result = await applyRuntimeSetModelChange({
      maker,
      sessionId,
      model: 'codex/gpt-5.5',
      providerId: 'xd',
      registerPendingCredentialSwitch,
    });

    expect(result).toEqual({ status: 'deferred' });
    expect(registerPendingCredentialSwitch).toHaveBeenCalledWith(sessionId, {
      model: 'codex/gpt-5.5',
      providerId: 'xd',
    });
    expect(closeSession).not.toHaveBeenCalled();
    expect(setModel).not.toHaveBeenCalled();
    expect(getSessionProvider(sessionId)).toBe('openai');
  });

  it('closes an idle proxy-active Codex session when switching from subscription to XD (远端压缩身份边界)', async () => {
    // 订阅直连 thread 以 OpenAI 身份 provider 创建(远端压缩,thread 级冻结);
    // 切到网关路由必须关会话、下一次发送按新路由重建,不能热切。
    const sessionId = rememberSession('runtime-set-model-idle-oauth-to-xd-superset');
    setSessionProvider(sessionId, 'openai');
    const setModel = vi.fn(async () => {});
    const closeSession = vi.fn(async () => {});
    const registerPendingCredentialSwitch = vi.fn();
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({
        agentKind: 'codex', remoteHostId: null, codexProxyActive: true,
        model: 'gpt-5.4', setModel,
      }),
      listActiveSessions: () => [{
        id: sessionId, agentKind: 'codex', remoteHostId: null,
        isTurnRunning: () => false,
      }],
      closeSession,
    };

    const result = await applyRuntimeSetModelChange({
      maker,
      sessionId,
      model: 'codex/gpt-5.5',
      providerId: 'xd',
      registerPendingCredentialSwitch,
      codexAuthInjection: 'oauth-bearer',
    });

    expect(result).toEqual({ status: 'applied' });
    expect(registerPendingCredentialSwitch).not.toHaveBeenCalled();
    expect(closeSession).toHaveBeenCalledWith(sessionId);
    expect(setModel).not.toHaveBeenCalled();
    expect(getSessionProvider(sessionId)).toBe('xd');
  });

  it('defers a busy subscription-to-XD Codex switch to the turn boundary (远端压缩身份边界)', async () => {
    const sessionId = rememberSession('runtime-set-model-busy-superset-no-channel');
    setSessionProvider(sessionId, 'openai');
    const setModel = vi.fn(async () => {});
    const registerPendingCredentialSwitch = vi.fn();
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({
        agentKind: 'codex', remoteHostId: null, codexProxyActive: true,
        model: 'gpt-5.4', setModel,
      }),
      listActiveSessions: () => [{
        id: sessionId, agentKind: 'codex', remoteHostId: null,
        isTurnRunning: () => true,
      }],
      closeSession: vi.fn(async () => {}),
    };

    const result = await applyRuntimeSetModelChange({
      maker,
      sessionId,
      model: 'codex/gpt-5.5',
      providerId: 'xd',
      registerPendingCredentialSwitch,
      codexAuthInjection: 'oauth-bearer',
    });

    expect(result).toEqual({ status: 'deferred' });
    expect(registerPendingCredentialSwitch).toHaveBeenCalledWith(sessionId, {
      model: 'codex/gpt-5.5',
      providerId: 'xd',
    });
    expect(setModel).not.toHaveBeenCalled();
    expect(getSessionProvider(sessionId)).toBe('openai');
  });

  it('fails closed on a busy subscription-to-XD Codex switch without a pending channel', async () => {
    const sessionId = rememberSession('runtime-set-model-busy-boundary-no-channel');
    setSessionProvider(sessionId, 'openai');
    const setModel = vi.fn(async () => {});
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({
        agentKind: 'codex', remoteHostId: null, codexProxyActive: true,
        model: 'gpt-5.4', setModel,
      }),
      listActiveSessions: () => [{
        id: sessionId, agentKind: 'codex', remoteHostId: null,
        isTurnRunning: () => true,
      }],
      closeSession: vi.fn(async () => {}),
    };

    await expect(applyRuntimeSetModelChange({
      maker,
      sessionId,
      model: 'codex/gpt-5.5',
      providerId: 'xd',
      codexAuthInjection: 'oauth-bearer',
    })).rejects.toThrow(/busy/i);

    expect(setModel).not.toHaveBeenCalled();
    expect(getSessionProvider(sessionId)).toBe('openai');
  });

  it('keeps remote Codex provider switches outside the local turn-boundary gate', async () => {
    const sessionId = rememberSession('runtime-set-model-remote-provider-switch');
    setSessionProvider(sessionId, 'openai');
    const setModel = vi.fn(async () => {});
    const registerPendingCredentialSwitch = vi.fn();
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({
        agentKind: 'codex', remoteHostId: 'remote-1', codexProxyActive: false,
        model: 'gpt-5.4', setModel,
      }),
      listActiveSessions: () => [{
        id: sessionId, agentKind: 'codex', remoteHostId: 'remote-1',
        isTurnRunning: () => true,
      }],
      closeSession: vi.fn(async () => {}),
    };

    const result = await applyRuntimeSetModelChange({
      maker,
      sessionId,
      model: 'codex/gpt-5.5',
      providerId: 'xd',
      registerPendingCredentialSwitch,
    });

    expect(result).toEqual({ status: 'applied' });
    expect(registerPendingCredentialSwitch).not.toHaveBeenCalled();
    expect(setModel).toHaveBeenCalledWith('codex/gpt-5.5', { providerId: 'xd' });
    expect(getSessionProvider(sessionId)).toBe('xd');
  });

  it('hot-reuses a proxy-active env-key default-source Codex session when switching into xAI provider OAuth routing', async () => {
    const sessionId = rememberSession('runtime-set-model-hot-default-xai');
    const setModel = vi.fn(async () => {});
    const closeSession = vi.fn(async () => {});
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({
        agentKind: 'codex',
        remoteHostId: null,
        codexProxyActive: true,
        model: 'gpt-5.4',
        setModel,
      }),
      listActiveSessions: () => [
        {
          id: sessionId,
          agentKind: 'codex',
          remoteHostId: null,
          isTurnRunning: () => false,
        },
      ],
      closeSession,
    };

    expect(getSessionProvider(sessionId)).toBeNull();

    // env-key spawn:隐式来源解析为 gateway 家族,不涉及远端压缩身份,保持热切。
    await applyRuntimeSetModelChange({
      maker,
      sessionId,
      model: 'xai/grok-4.3',
      providerId: 'xai',
      codexAuthInjection: 'env-key',
    });

    expect(closeSession).not.toHaveBeenCalled();
    expect(setModel).toHaveBeenCalledWith('xai/grok-4.3', { providerId: 'xai' });
    expect(getSessionProvider(sessionId)).toBe('xai');
  });

  it('closes a proxy-active oauth default-source Codex session when switching into xAI provider OAuth routing', async () => {
    const sessionId = rememberSession('runtime-set-model-close-oauth-default-xai');
    const setModel = vi.fn(async () => {});
    const closeSession = vi.fn(async () => {});
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({
        agentKind: 'codex',
        remoteHostId: null,
        codexProxyActive: true,
        model: 'gpt-5.4',
        setModel,
      }),
      listActiveSessions: () => [
        {
          id: sessionId,
          agentKind: 'codex',
          remoteHostId: null,
          isTurnRunning: () => false,
        },
      ],
      closeSession,
    };

    // oauth spawn:隐式来源解析为订阅家族(thread 是 OpenAI 远端压缩身份)→ 关会话重建。
    await applyRuntimeSetModelChange({
      maker,
      sessionId,
      model: 'xai/grok-4.3',
      providerId: 'xai',
      codexAuthInjection: 'oauth-bearer',
    });

    expect(closeSession).toHaveBeenCalledWith(sessionId);
    expect(setModel).not.toHaveBeenCalled();
    expect(getSessionProvider(sessionId)).toBe('xai');
  });

  it('closes only the switching session; other local Codex sessions keep running', async () => {
    // 2026-07-04 语义:set-model 只关本会话。其它 codex 会话继续跑旧凭证形态,
    // 共享 host 的重启延迟到下一次发送的 getHost 仲裁(配合发送侧可见等待)。
    const sessionId = rememberSession('runtime-set-model-close-self-only');
    setSessionProvider(sessionId, 'openai');
    const closeSession = vi.fn(async () => {});
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({
        agentKind: 'codex',
        remoteHostId: null,
        model: 'gpt-5.4',
        setModel: vi.fn(async () => {}),
      }),
      listActiveSessions: () => [
        { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
        { id: 'other-idle-codex', agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
        { id: 'other-busy-codex', agentKind: 'codex', remoteHostId: null, isTurnRunning: () => true },
      ],
      closeSession,
    };

    const result = await applyRuntimeSetModelChange({
      maker,
      sessionId,
      model: 'codex/gpt-5.5',
      providerId: 'xd',
      registerPendingCredentialSwitch: vi.fn(),
    });

    expect(result).toEqual({ status: 'applied' });
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledWith(sessionId);
    expect(getSessionProvider(sessionId)).toBe('xd');
  });

  it('defers the credential switch when the session itself is running a turn', async () => {
    // 2026-07-04 实报根因:会话自己在跑时切来源被整体拒绝,选择被静默丢弃。
    // 新语义:登记 pending(turn 结束自动生效),route 暂不动、会话不关。
    const sessionId = rememberSession('runtime-set-model-defer');
    setSessionProvider(sessionId, 'openai');
    const closeSession = vi.fn(async () => {});
    const registerPendingCredentialSwitch = vi.fn();
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({
        agentKind: 'codex',
        remoteHostId: null,
        model: 'gpt-5.5',
        setModel: vi.fn(async () => {}),
      }),
      listActiveSessions: () => [
        { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => true },
      ],
      closeSession,
    };

    const result = await applyRuntimeSetModelChange({
      maker,
      sessionId,
      model: 'gpt-5.5',
      providerId: 'xd',
      registerPendingCredentialSwitch,
    });

    expect(result).toEqual({ status: 'deferred' });
    expect(registerPendingCredentialSwitch).toHaveBeenCalledWith(sessionId, {
      model: 'gpt-5.5',
      providerId: 'xd',
    });
    expect(closeSession).not.toHaveBeenCalled();
    // route 保持旧值:运行中的 turn 继续用原来源,pending 兑现时才写新值。
    expect(getSessionProvider(sessionId)).toBe('openai');
  });

  it('clears a stale pending switch when an explicit same-family provider lands without a switch', async () => {
    // deferred 登记后 renderer 回滚 / 用户改选回同族来源:显式 providerId 落在
    // 「无需切换」分支必须清 pending,否则被放弃的目标在 turn 结束时照样生效。
    const sessionId = rememberSession('runtime-set-model-clear-pending');
    setSessionProvider(sessionId, 'openai');
    const clearPendingCredentialSwitch = vi.fn();
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({
        agentKind: 'codex',
        remoteHostId: null,
        model: 'gpt-5.5',
        setModel: vi.fn(async () => {}),
      }),
      listActiveSessions: () => [
        { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => true },
      ],
      closeSession: vi.fn(async () => {}),
    };

    const result = await applyRuntimeSetModelChange({
      maker,
      sessionId,
      model: 'gpt-5.5',
      providerId: 'openai',
      registerPendingCredentialSwitch: vi.fn(),
      clearPendingCredentialSwitch,
    });

    expect(result).toEqual({ status: 'applied' });
    expect(clearPendingCredentialSwitch).toHaveBeenCalledWith(sessionId);
  });

  it('cancels a stale pending switch when a model-only change no longer crosses families', async () => {
    // review P1(2026-07-04 第二轮):折扣模型(codex/ 前缀)登记 pending 后,用户
    // 通过模型选择器切回普通模型 —— model-only 调用不带 providerId,必须以 pending
    // 的 providerId 为基准重评估;不再跨族 → 取消 pending。
    const sessionId = rememberSession('runtime-set-model-cancel-pending-model-only');
    setSessionProvider(sessionId, null);
    const clearPendingCredentialSwitch = vi.fn();
    const registerPendingCredentialSwitch = vi.fn();
    const setModel = vi.fn(async () => {});
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({
        agentKind: 'codex',
        remoteHostId: null,
        model: 'gpt-5.5',
        setModel,
      }),
      listActiveSessions: () => [
        { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => true },
      ],
      closeSession: vi.fn(async () => {}),
    };

    const result = await applyRuntimeSetModelChange({
      maker,
      sessionId,
      model: 'gpt-5.5',
      registerPendingCredentialSwitch,
      clearPendingCredentialSwitch,
      getPendingCredentialSwitch: () => ({ model: 'codex/gpt-5.5', providerId: null }),
    });

    expect(result).toEqual({ status: 'applied' });
    expect(clearPendingCredentialSwitch).toHaveBeenCalledWith(sessionId);
    expect(registerPendingCredentialSwitch).not.toHaveBeenCalled();
    expect(setModel).toHaveBeenCalledWith('gpt-5.5', { providerId: null });
  });

  it('updates the pending model and keeps its provider on a model-only change under a deferred source', async () => {
    // 用户先 deferred 选了 xd 来源,turn 未结束又换了个模型:pending 的来源意图必须
    // 保留,只把目标模型更新为最新选择(model-only 调用回落 store 旧值会把 xd 丢掉)。
    const sessionId = rememberSession('runtime-set-model-update-pending-model-only');
    setSessionProvider(sessionId, 'openai');
    const registerPendingCredentialSwitch = vi.fn();
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({
        agentKind: 'codex',
        remoteHostId: null,
        model: 'gpt-5.5',
        setModel: vi.fn(async () => {}),
      }),
      listActiveSessions: () => [
        { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => true },
      ],
      closeSession: vi.fn(async () => {}),
    };

    const result = await applyRuntimeSetModelChange({
      maker,
      sessionId,
      model: 'gpt-5.4',
      registerPendingCredentialSwitch,
      getPendingCredentialSwitch: () => ({ model: 'gpt-5.5', providerId: 'xd' }),
    });

    expect(result).toEqual({ status: 'deferred' });
    expect(registerPendingCredentialSwitch).toHaveBeenCalledWith(sessionId, {
      model: 'gpt-5.4',
      providerId: 'xd',
    });
    // route 保持旧值,等 pending 兑现。
    expect(getSessionProvider(sessionId)).toBe('openai');
  });

  it('clears a stale pending before closing the session on an idle explicit switch', async () => {
    // review P1(第三轮):close 会触发宿主 onSessionClosed,stale pending 若未先清,
    // 会被它以旧目标抢先 finalize 并广播,与本次显式选择打架。clear 必须先于 close。
    const sessionId = rememberSession('runtime-set-model-clear-before-close');
    setSessionProvider(sessionId, 'openai');
    const order: string[] = [];
    const clearPendingCredentialSwitch = vi.fn((_sid: string, opts?: { wake?: boolean }) => {
      order.push(opts?.wake === false ? 'clear-no-wake' : 'clear');
    });
    const wakeSessionInputQueue = vi.fn(() => { order.push('wake'); });
    const closeSession = vi.fn(async () => { order.push('close'); });
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({
        agentKind: 'codex',
        remoteHostId: null,
        model: 'gpt-5.5',
        setModel: vi.fn(async () => {}),
      }),
      listActiveSessions: () => [
        { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
      ],
      closeSession,
    };

    const result = await applyRuntimeSetModelChange({
      maker,
      sessionId,
      model: 'gpt-5.5',
      providerId: 'xd',
      registerPendingCredentialSwitch: vi.fn(),
      clearPendingCredentialSwitch,
      wakeSessionInputQueue,
    });

    expect(result).toEqual({ status: 'applied' });
    // clear 必须不带唤醒(否则 drain 趁 close 窗口把队首派发到旧会话),
    // 唤醒在 close + 写路由完成之后。
    expect(order).toEqual(['clear-no-wake', 'close', 'wake']);
    expect(getSessionProvider(sessionId)).toBe('xd');
  });

  it('falls back to the busy throw when no pending channel is injected', async () => {
    // 老调用方(未注入 registerPendingCredentialSwitch)保持旧 fail-closed 语义。
    const sessionId = rememberSession('runtime-set-model-defer-no-channel');
    setSessionProvider(sessionId, 'openai');
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({
        agentKind: 'codex',
        remoteHostId: null,
        model: 'gpt-5.5',
        setModel: vi.fn(async () => {}),
      }),
      listActiveSessions: () => [
        { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => true },
      ],
      closeSession: vi.fn(async () => {}),
    };

    await expect(
      applyRuntimeSetModelChange({
        maker,
        sessionId,
        model: 'gpt-5.5',
        providerId: 'xd',
      }),
    ).rejects.toThrow(/busy/);
    expect(getSessionProvider(sessionId)).toBe('openai');
  });
});
