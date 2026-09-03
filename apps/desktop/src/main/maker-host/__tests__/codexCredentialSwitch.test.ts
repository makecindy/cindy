import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isCodexThreadModelProviderIdentityMismatch,
  piProxyProviderIdentity,
  prepareLocalSessionCredentialModeSwitch,
  prepareLocalCodexCredentialModeSwitch,
  shouldCloseSessionForCredentialSwitch,
  type PrepareLocalCodexCredentialModeSwitchInput,
} from '../codex-credential-switch.js';
import { rehydrateCloseSuppression } from '../rehydrateCloseSuppression.js';

afterEach(() => {
  rehydrateCloseSuppression.resetForTest();
});

describe('shouldCloseSessionForCredentialSwitch codex mode', () => {
  it('closes local Codex sessions when switching between XD key and OpenAI OAuth', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: 'xd',
      nextProviderId: 'openai',
      currentModel: 'codex/gpt-5.5',
      nextModel: 'gpt-5.4',
    })).toBe(true);
  });

  it('closes a proxy-active OAuth Codex session when switching to XD gateway routing (远端压缩身份边界)', () => {
    // 订阅直连 thread 以 OpenAI 身份 provider 创建(远端压缩),身份 thread 级冻结;
    // 切到网关路由必须关会话重建,否则远端压缩请求会打到不支持它的上游(硬失败)。
    // host 仍复用(方案 A 的 host 级放宽不变),只是本会话关闭重建。
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: 'openai',
      nextProviderId: 'xd',
      currentModel: 'gpt-5.4',
      nextModel: 'codex/gpt-5.5',
      currentCodexProxyActive: true,
    })).toBe(true);
  });

  it('keeps a proxy-active gateway Codex session for pure gateway model changes', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: 'xd',
      nextProviderId: 'xd',
      currentModel: 'codex/gpt-5.5',
      nextModel: 'codex/gpt-5.4',
      currentCodexProxyActive: true,
    })).toBe(false);
  });

  it('keeps a matching Cindy Codex remote-compaction thread for Cindy codex model changes', () => {
    const input = {
      agentKind: 'codex',
      currentProviderId: 'xd',
      nextProviderId: 'xd',
      currentModel: 'codex/gpt-5.5',
      nextModel: 'codex/gpt-5.6-sol',
      currentCodexProxyActive: true,
      currentCodexThreadModelProviderId: 'cindy_codex',
    } as const;
    expect(isCodexThreadModelProviderIdentityMismatch(input)).toBe(false);
    expect(shouldCloseSessionForCredentialSwitch(input)).toBe(false);
  });

  it('keeps a local-compaction Cindy Codex thread when its independent subagent is incompatible', () => {
    const input = {
      agentKind: 'codex',
      currentProviderId: 'xd',
      nextProviderId: 'xd',
      currentModel: 'codex/gpt-5.5',
      nextModel: 'codex/gpt-5.6-sol',
      currentCodexProxyActive: true,
      currentCodexThreadModelProviderId: 'cindy_gateway',
      currentCodexCindyRemoteCompactionCompatible: false,
    } as const;
    expect(isCodexThreadModelProviderIdentityMismatch(input)).toBe(false);
    expect(shouldCloseSessionForCredentialSwitch(input)).toBe(false);
  });

  it('keeps a proxy-active OAuth Codex session for oauth-family model changes', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: 'openai',
      nextProviderId: 'openai',
      currentModel: 'gpt-5.4',
      nextModel: 'gpt-5.5',
      currentCodexProxyActive: true,
    })).toBe(false);
    // 隐式来源两侧,注入形态解析同为 oauth 家族 → 不跨边界,保持热切。
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: null,
      nextProviderId: null,
      currentModel: 'gpt-5.4',
      nextModel: 'gpt-5.5',
      currentCodexProxyActive: true,
      codexAuthInjection: 'oauth-bearer',
    })).toBe(false);
  });

  it('closes when the live thread is still OpenAI even if the provider store already says DeepSeek', () => {
    // 现场回归:provider store 已被选择器提前写成新来源,仅比较 current/next 会误判为
    // 同一家族；thread/start 的实际响应仍是 cindy_openai,必须以它为准重建。
    const input = {
      agentKind: 'codex',
      currentProviderId: 'deepseek',
      nextProviderId: 'deepseek',
      currentModel: 'deepseek/deepseek-v4-pro',
      nextModel: 'deepseek/deepseek-v4-pro',
      currentCodexProxyActive: true,
      currentCodexThreadModelProviderId: 'cindy_openai',
    } as const;
    expect(isCodexThreadModelProviderIdentityMismatch(input)).toBe(true);
    expect(shouldCloseSessionForCredentialSwitch(input)).toBe(true);
  });

  it('keeps a matching gateway thread when the provider store already says DeepSeek', () => {
    const input = {
      agentKind: 'codex',
      currentProviderId: 'deepseek',
      nextProviderId: 'deepseek',
      currentModel: 'deepseek/deepseek-v4-pro',
      nextModel: 'deepseek/deepseek-v4-pro',
      currentCodexProxyActive: true,
      currentCodexThreadModelProviderId: 'cindy_gateway',
    } as const;
    expect(isCodexThreadModelProviderIdentityMismatch(input)).toBe(false);
    expect(shouldCloseSessionForCredentialSwitch(input)).toBe(false);
  });

  it('still closes a gateway Codex session when switching to OAuth on a proxy-active host', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: 'xd',
      nextProviderId: 'openai',
      currentModel: 'codex/gpt-5.5',
      nextModel: 'gpt-5.4',
      currentCodexProxyActive: true,
    })).toBe(true);
  });

  it('closes when the default codex model host switches to a custom fallback provider', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: null,
      nextProviderId: 'openrouter',
      currentModel: 'codex/gpt-5.5',
      nextModel: 'meta/llama-4',
    })).toBe(true);
  });

  it('keeps the session when provider route changes but credential mode stays gateway key', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: 'xd',
      nextProviderId: null,
      currentModel: 'codex/gpt-5.5',
      nextModel: 'codex/gpt-5.5',
    })).toBe(false);
  });

  it('closes existing Codex sessions when switching into xAI provider OAuth without a proxy-active host', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: 'xd',
      nextProviderId: 'xai',
      currentModel: 'gpt-5.4',
      nextModel: 'xai/grok-4.3',
    })).toBe(true);
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: 'openai',
      nextProviderId: 'xai',
      currentModel: 'gpt-5.4',
      nextModel: 'xai/grok-4.3',
    })).toBe(true);
  });

  it('keeps gateway-family Codex sessions when switching into xAI provider OAuth on a proxy-active host', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: 'xd',
      nextProviderId: 'xai',
      currentModel: 'gpt-5.4',
      nextModel: 'xai/grok-4.3',
      currentCodexProxyActive: true,
    })).toBe(false);
    // 隐式来源 + env-key spawn:解析为 gateway 家族,不涉及远端压缩身份,保持热切。
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: null,
      nextProviderId: 'xai',
      currentModel: 'gpt-5.4',
      nextModel: 'xai/grok-4.3',
      currentCodexProxyActive: true,
      codexAuthInjection: 'env-key',
    })).toBe(false);
  });

  it('closes oauth-family Codex sessions when switching into xAI provider OAuth on a proxy-active host (远端压缩身份边界)', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: 'openai',
      nextProviderId: 'xai',
      currentModel: 'gpt-5.4',
      nextModel: 'xai/grok-4.3',
      currentCodexProxyActive: true,
    })).toBe(true);
    // 隐式来源 + oauth spawn:解析为订阅家族(thread 是 OpenAI 身份)→ 必须关会话重建。
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: null,
      nextProviderId: 'xai',
      currentModel: 'gpt-5.4',
      nextModel: 'xai/grok-4.3',
      currentCodexProxyActive: true,
      codexAuthInjection: 'oauth-bearer',
    })).toBe(true);
    // 隐式来源且未提供注入形态:无法证明不跨边界 → 保守关闭。
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: null,
      nextProviderId: null,
      currentModel: 'gpt-5.4',
      nextModel: 'xai/grok-4.3',
      currentCodexProxyActive: true,
    })).toBe(true);
  });

  it('closes when switching from xAI provider OAuth host back to gateway/OpenAI credentials', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: 'xai',
      nextProviderId: 'xd',
      currentModel: 'xai/grok-4.3',
      nextModel: 'gpt-5.4',
    })).toBe(true);
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: 'xai',
      nextProviderId: 'openai',
      currentModel: 'xai/grok-4.3',
      nextModel: 'gpt-5.4',
    })).toBe(true);
  });

  it('does not close remote Codex sessions', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      remoteHostId: 'remote-1',
      currentProviderId: 'xd',
      nextProviderId: 'openai',
      currentModel: 'codex/gpt-5.5',
      nextModel: 'gpt-5.4',
    })).toBe(false);
  });
});

describe('piProxyProviderIdentity', () => {
  it('collapses Cindy gateway aliases to the headerless proxy identity', () => {
    expect(piProxyProviderIdentity(null)).toBeNull();
    expect(piProxyProviderIdentity(undefined)).toBeNull();
    expect(piProxyProviderIdentity('xd')).toBeNull();
    expect(piProxyProviderIdentity('cindy')).toBeNull();
    expect(piProxyProviderIdentity('  xd  ')).toBeNull();
  });

  it('pins native subscription and BYOM sources', () => {
    expect(piProxyProviderIdentity('xai')).toBe('xai');
    expect(piProxyProviderIdentity('openai')).toBe('openai');
    expect(piProxyProviderIdentity('anthropic')).toBe('anthropic');
    expect(piProxyProviderIdentity('litellm-custom')).toBe('litellm-custom');
  });
});

describe('shouldCloseSessionForCredentialSwitch pi proxy identity', () => {
  it('closes idle Pi when crossing xAI and OpenAI even though both are provider-oauth', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'pi',
      currentProviderId: 'xai',
      nextProviderId: 'openai',
      currentModel: 'grok-4.6',
      nextModel: 'gpt-5.6-sol',
    })).toBe(true);
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'pi',
      currentProviderId: 'openai',
      nextProviderId: 'xai',
      currentModel: 'gpt-5.6-sol',
      nextModel: 'grok-4.6',
    })).toBe(true);
  });

  it('closes idle Pi when crossing native xAI and Cindy AI gateway', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'pi',
      currentProviderId: 'xai',
      nextProviderId: 'xd',
      currentModel: 'grok-4.6',
      nextModel: 'gpt-5.6-sol',
    })).toBe(true);
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'pi',
      currentProviderId: 'xd',
      nextProviderId: 'xai',
      currentModel: 'gpt-5.6-sol',
      nextModel: 'grok-4.6',
    })).toBe(true);
  });

  it('keeps a live Pi process for same-family model changes', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'pi',
      currentProviderId: 'xai',
      nextProviderId: 'xai',
      currentModel: 'grok-4.6',
      nextModel: 'grok-4.5',
    })).toBe(false);
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'pi',
      currentProviderId: 'openai',
      nextProviderId: 'openai',
      currentModel: 'gpt-5.6-sol',
      nextModel: 'gpt-5.4',
    })).toBe(false);
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'pi',
      currentProviderId: 'xd',
      nextProviderId: 'cindy',
      currentModel: 'gpt-5.6-sol',
      nextModel: 'gpt-5.4',
    })).toBe(false);
  });

  it('does not close remote Pi sessions for proxy-identity switches', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'pi',
      remoteHostId: 'remote-1',
      currentProviderId: 'xai',
      nextProviderId: 'openai',
      currentModel: 'grok-4.6',
      nextModel: 'gpt-5.6-sol',
    })).toBe(false);
  });
});

describe('shouldCloseSessionForCredentialSwitch', () => {
  it('closes local Claude sessions when switching from XD key to Anthropic OAuth', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'claude-code',
      currentProviderId: 'xd',
      nextProviderId: 'anthropic',
      currentModel: 'claude-sonnet-4-6',
      nextModel: 'claude-opus-4-8',
    })).toBe(true);
  });

  it('does not close remote Claude sessions for provider switches', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'claude-code',
      remoteHostId: 'remote-1',
      currentProviderId: 'xd',
      nextProviderId: 'anthropic',
      currentModel: 'claude-sonnet-4-6',
      nextModel: 'claude-opus-4-8',
    })).toBe(false);
  });
});

describe('prepareLocalSessionCredentialModeSwitch', () => {
  it('soft-closes only the target local session', async () => {
    const sideEffect = vi.fn(async () => undefined);
    const closeSession = vi.fn(async (sessionId: string) => {
      await rehydrateCloseSuppression.runOnCloseSideEffects(sessionId, sideEffect);
    });
    const maker: PrepareLocalCodexCredentialModeSwitchInput['maker'] = {
      listActiveSessions: () => [
        {
          id: 'target-claude',
          agentKind: 'claude-code',
          remoteHostId: null,
          isTurnRunning: () => false,
        },
        {
          id: 'other-codex',
          agentKind: 'codex',
          remoteHostId: null,
          isTurnRunning: () => false,
        },
      ],
      closeSession,
    };

    const result = await prepareLocalSessionCredentialModeSwitch({
      maker,
      sessionId: 'target-claude',
    });

    expect(result).toEqual({ closedSessionIds: ['target-claude'] });
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledWith('target-claude');
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it('fails closed instead of closing the target session when it is busy', async () => {
    const closeSession = vi.fn(async () => undefined);
    const maker: PrepareLocalCodexCredentialModeSwitchInput['maker'] = {
      listActiveSessions: () => [
        {
          id: 'busy-claude',
          agentKind: 'claude-code',
          remoteHostId: null,
          isTurnRunning: () => true,
        },
      ],
      closeSession,
    };

    await expect(prepareLocalSessionCredentialModeSwitch({
      maker,
      sessionId: 'busy-claude',
    })).rejects.toThrow(/busy-claude/);
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('does not close the target session when the switch is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const closeSession = vi.fn(async () => undefined);
    const maker: PrepareLocalCodexCredentialModeSwitchInput['maker'] = {
      listActiveSessions: () => [{
        id: 'aborted-claude',
        agentKind: 'claude-code',
        remoteHostId: null,
        isTurnRunning: () => false,
      }],
      closeSession,
    };

    await expect(prepareLocalSessionCredentialModeSwitch({
      maker,
      sessionId: 'aborted-claude',
      signal: controller.signal,
    })).rejects.toThrow(/aborted/);
    expect(closeSession).not.toHaveBeenCalled();
  });
});

describe('prepareLocalCodexCredentialModeSwitch', () => {
  it('soft-closes idle local Codex sessions without running rehydrate side-effects', async () => {
    const sideEffect = vi.fn(async () => undefined);
    const closeSession = vi.fn(async (sessionId: string) => {
      await rehydrateCloseSuppression.runOnCloseSideEffects(sessionId, sideEffect);
    });
    const maker: PrepareLocalCodexCredentialModeSwitchInput['maker'] = {
      listActiveSessions: () => [
        {
          id: 'local-codex-1',
          agentKind: 'codex',
          remoteHostId: null,
          isTurnRunning: () => false,
        },
        {
          id: 'remote-codex-1',
          agentKind: 'codex',
          remoteHostId: 'remote-1',
          isTurnRunning: () => false,
        },
        {
          id: 'local-claude-1',
          agentKind: 'claude-code',
          remoteHostId: null,
          isTurnRunning: () => false,
        },
      ],
      closeSession,
    };

    const result = await prepareLocalCodexCredentialModeSwitch({ maker });

    expect(result).toEqual({ closedSessionIds: ['local-codex-1'] });
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledWith('local-codex-1');
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it('fails closed instead of closing sessions when any local Codex session is busy', async () => {
    const closeSession = vi.fn(async () => undefined);
    const maker: PrepareLocalCodexCredentialModeSwitchInput['maker'] = {
      listActiveSessions: () => [
        {
          id: 'busy-codex-1',
          agentKind: 'codex',
          remoteHostId: null,
          isTurnRunning: () => false,
        },
      ],
      closeSession,
    };

    await expect(prepareLocalCodexCredentialModeSwitch({
      maker,
      isSessionInTurn: (sessionId) => sessionId === 'busy-codex-1',
    })).rejects.toThrow(/busy-codex-1/);
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('does not close local Codex sessions when the switch is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const closeSession = vi.fn(async () => undefined);
    const maker: PrepareLocalCodexCredentialModeSwitchInput['maker'] = {
      listActiveSessions: () => [{
        id: 'aborted-codex',
        agentKind: 'codex',
        remoteHostId: null,
        isTurnRunning: () => false,
      }],
      closeSession,
    };

    await expect(prepareLocalCodexCredentialModeSwitch({
      maker,
      signal: controller.signal,
    })).rejects.toThrow(/aborted/);
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('includes the switch direction in the busy error message when modes are provided', async () => {
    const maker: PrepareLocalCodexCredentialModeSwitchInput['maker'] = {
      listActiveSessions: () => [
        {
          id: 'busy-codex-1',
          agentKind: 'codex',
          remoteHostId: null,
          isTurnRunning: () => true,
        },
      ],
      closeSession: vi.fn(async () => undefined),
    };

    // 方向是日志里唯一的"为什么要切"现场证据(2026-07-03 排队假死排查因缺它多绕一轮)。
    await expect(prepareLocalCodexCredentialModeSwitch({
      maker,
      fromMode: 'oauth-bearer',
      toMode: 'gateway-key',
    })).rejects.toThrow(/\(oauth-bearer -> gateway-key\).*busy-codex-1/);
  });

  it('shows the effective mode with the registered raw value when they differ', async () => {
    const maker: PrepareLocalCodexCredentialModeSwitchInput['maker'] = {
      listActiveSessions: () => [
        {
          id: 'busy-codex-1',
          agentKind: 'codex',
          remoteHostId: null,
          isTurnRunning: () => true,
        },
      ],
      closeSession: vi.fn(async () => undefined),
    };

    // 隐式来源 host 的原始登记值是 undefined(显示成 fallback),归一化生效形态才说明
    // 实际钥匙(2026-07-04 实排:"fallback -> gateway-key" 还得 ps 看进程参数确认)。
    await expect(prepareLocalCodexCredentialModeSwitch({
      maker,
      fromModeEffective: 'oauth-bearer',
      toMode: 'gateway-key',
    })).rejects.toThrow(/\(oauth-bearer\(registered: fallback\) -> gateway-key\).*busy-codex-1/);
  });
});
