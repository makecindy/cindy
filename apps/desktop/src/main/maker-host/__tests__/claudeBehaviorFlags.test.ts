import { describe, expect, it, vi } from 'vitest';

import { claudeBehaviorFlagsForSpawn, claudeToolSearchMode } from '../claude-behavior-flags.js';
import { shouldCloseSessionForCredentialSwitch } from '../codex-credential-switch.js';

describe('claudeBehaviorFlagsForSpawn', () => {
  it('provider-oauth never keeps attribution', () => {
    const flags = claudeBehaviorFlagsForSpawn({ providerId: 'anthropic-work',
      nativeAuth: 'claude', credentialMode: 'provider-oauth', oauthConnected: () => true });
    expect(flags.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
    expect(claudeToolSearchMode('grok-work', 'provider-oauth', 'xai')).toBe('false');
  });

  it('disables attribution for gateway-key spawns without touching the keychain', () => {
    // 显式 XD source / SSH remote 恒为 gateway-key:请求全走网关,无订阅直连路径。
    // oauthConnected 必须不被调用 —— spawn 热路径不为此分支付出钥匙串读取。
    const oauthConnected = vi.fn(() => true);
    const flags = claudeBehaviorFlagsForSpawn({ credentialMode: 'gateway-key', oauthConnected });

    expect(flags.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
    expect(oauthConnected).not.toHaveBeenCalled();
  });

  it('keeps the CLI attribution default for spawns that may use the local Claude Code login (issue #758)', () => {
    // oauth-bearer / 未显式指定:CLI 可能用本机登录直连 api.anthropic.com,归因块必须保留,
    // 否则分类器子请求被上游 429。
    const cases = [
      { credentialMode: 'oauth-bearer', providerId: 'anthropic' },
      { credentialMode: undefined, providerId: undefined },
    ] as const;
    for (const { credentialMode, providerId } of cases) {
      const flags = claudeBehaviorFlagsForSpawn({
        credentialMode,
        providerId,
        oauthConnected: () => true,
      });
      // 显式 '1' 而非缺席:local spawn 继承宿主 process.env,宿主 shell export 过
      // CLAUDE_CODE_ATTRIBUTION_HEADER=0 时,缺席的 key 压不住继承值(#758 复现)。
      expect(flags.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('1');
      expect(flags.CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS).toBe('1');
    }
  });

  it('provider-oauth spawns always go through the proxy and disable attribution, subscription or not', () => {
    for (const oauthConnected of [true, false]) {
      const flags = claudeBehaviorFlagsForSpawn({
        credentialMode: 'provider-oauth',
        providerId: 'openrouter-custom',
        oauthConnected: () => oauthConnected,
      });
      expect(flags.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
    }
  });

  // 默认值仍由 host 注入(issue #7524): 直接不注入会让未配置的网关用户掉进每轮全量
  // 工具定义的高 token 路径(remote-ssh/claude-env.ts 有同样的默认值)。
  it('keeps the source-aware Tool Search default when the user has no override', () => {
    const cases = [
      { credentialMode: 'gateway-key', providerId: 'xd', expected: 'auto' },
      { credentialMode: 'oauth-bearer', providerId: 'anthropic', expected: 'auto' },
      { credentialMode: 'provider-oauth', providerId: 'openrouter-custom', expected: 'false' },
    ] as const;
    for (const { credentialMode, providerId, expected } of cases) {
      const flags = claudeBehaviorFlagsForSpawn({
        credentialMode,
        providerId,
        oauthConnected: () => false,
      });
      expect(flags.ENABLE_TOOL_SEARCH).toBe(expected);
    }
  });

  // 用户在 ~/.claude/settings.json 显式配过时 host 让位 —— 进程 env 优先级高于该文件,
  // 注入即静默盖掉用户选择(约 86k tokens/会话的固定开销,报告人无从改起)。
  it('yields Tool Search to an explicit user settings override', () => {
    for (const credentialMode of ['gateway-key', 'oauth-bearer', 'provider-oauth'] as const) {
      const flags = claudeBehaviorFlagsForSpawn({
        credentialMode,
        providerId: 'xd',
        oauthConnected: () => false,
        toolSearchOverridden: true,
      });
      expect('ENABLE_TOOL_SEARCH' in flags).toBe(false);
    }
  });

  it('disables attribution when no Claude.ai subscription is connected', () => {
    // 未连订阅 = 不存在订阅直连路径,保留网关 body 缓存优化。
    const flags = claudeBehaviorFlagsForSpawn({ oauthConnected: () => false });
    expect(flags.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
  });

  it('returns a fresh object per call — env-builder Object.assign must not mutate shared state', () => {
    const a = claudeBehaviorFlagsForSpawn({ oauthConnected: () => false });
    a.CLAUDE_CODE_ATTRIBUTION_HEADER = 'mutated';
    expect(
      claudeBehaviorFlagsForSpawn({ oauthConnected: () => false }).CLAUDE_CODE_ATTRIBUTION_HEADER,
    ).toBe('0');
  });

  it('enables Tool Search only for known compatible upstreams', () => {
    expect(claudeToolSearchMode('xd', 'gateway-key')).toBe('auto');
    expect(claudeToolSearchMode('anthropic', 'oauth-bearer')).toBe('auto');
    expect(claudeToolSearchMode(null, 'gateway-key')).toBe('auto');
    expect(claudeToolSearchMode(null, 'oauth-bearer')).toBe('auto');

    expect(claudeToolSearchMode('openrouter-custom', 'provider-oauth')).toBe('false');
    expect(claudeToolSearchMode('xai', 'provider-oauth')).toBe('false');
    expect(claudeToolSearchMode(null, 'provider-oauth')).toBe('false');
  });

  it('recreates local Claude sessions when Tool Search support changes', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'claude-code',
      currentProviderId: 'xd',
      nextProviderId: 'openrouter-custom',
      currentModel: 'claude-sonnet-4-6',
      nextModel: 'x-ai/grok-4.6',
    })).toBe(true);

    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'claude-code',
      currentProviderId: 'openrouter-a',
      nextProviderId: 'openrouter-b',
      currentModel: 'x-ai/grok-4.6',
      nextModel: 'openai/gpt-5.4',
    })).toBe(false);
  });
});
