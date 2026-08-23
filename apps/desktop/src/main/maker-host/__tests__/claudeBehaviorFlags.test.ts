import { describe, expect, it, vi } from 'vitest';

import { claudeBehaviorFlagsForSpawn, claudeToolSearchMode } from '../claude-behavior-flags.js';
import { shouldCloseSessionForCredentialSwitch } from '../codex-credential-switch.js';

describe('claudeBehaviorFlagsForSpawn', () => {
  it('disables attribution for gateway-key spawns without touching the keychain', () => {
    // 显式 XD source / SSH remote 恒为 gateway-key:请求全走网关,无订阅直连路径。
    // oauthConnected 必须不被调用 —— spawn 热路径不为此分支付出钥匙串读取。
    const oauthConnected = vi.fn(() => true);
    const flags = claudeBehaviorFlagsForSpawn({ credentialMode: 'gateway-key', oauthConnected });

    expect(flags.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
    expect(oauthConnected).not.toHaveBeenCalled();
  });

  it('keeps the CLI attribution default for subscription-connected non-gateway spawns (issue #758)', () => {
    // oauth-bearer / provider-oauth / 未显式指定:claude-* 请求(含分类器 scope-gate
    // 回落)可能直连 api.anthropic.com,归因块必须保留,否则分类器子请求被上游 429。
    const cases = [
      { credentialMode: 'oauth-bearer', providerId: 'anthropic', toolSearch: 'auto' },
      { credentialMode: 'provider-oauth', providerId: 'openrouter-custom', toolSearch: 'false' },
      { credentialMode: undefined, providerId: undefined, toolSearch: 'auto' },
    ] as const;
    for (const { credentialMode, providerId, toolSearch } of cases) {
      const flags = claudeBehaviorFlagsForSpawn({
        credentialMode,
        providerId,
        oauthConnected: () => true,
      });
      // 显式 '1' 而非缺席:local spawn 继承宿主 process.env,宿主 shell export 过
      // CLAUDE_CODE_ATTRIBUTION_HEADER=0 时,缺席的 key 压不住继承值(#758 复现)。
      expect(flags.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('1');
      expect(flags.CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS).toBe('1');
      expect(flags.ENABLE_TOOL_SEARCH).toBe(toolSearch);
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

  it('writes the custom-provider Tool Search override into the spawn flags', () => {
    const flags = claudeBehaviorFlagsForSpawn({
      credentialMode: 'provider-oauth',
      providerId: 'openrouter-custom',
      oauthConnected: () => false,
    });

    expect(flags.ENABLE_TOOL_SEARCH).toBe('false');
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
