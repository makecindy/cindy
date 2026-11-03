import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { claudeBehaviorFlagsForSpawn, claudeToolSearchMode } from '../claude-behavior-flags.js';
import { readUserToolSearchOverride } from '../claude-user-tool-search.js';
import { shouldCloseSessionForCredentialSwitch } from '../codex-credential-switch.js';

describe('claudeBehaviorFlagsForSpawn', () => {
  it('keeps Tool Search for retired independent Claude accounts; provider-oauth never keeps attribution', () => {
    const flags = claudeBehaviorFlagsForSpawn({ providerId: 'anthropic-work',
      nativeAuth: 'claude', credentialMode: 'provider-oauth', oauthConnected: () => true });
    expect(flags.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
    expect(flags.ENABLE_TOOL_SEARCH).toBe('auto');
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
      { credentialMode: 'oauth-bearer', providerId: 'anthropic', toolSearch: 'auto' },
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

  it('provider-oauth spawns always go through the proxy and disable attribution, subscription or not', () => {
    for (const oauthConnected of [true, false]) {
      const flags = claudeBehaviorFlagsForSpawn({
        credentialMode: 'provider-oauth',
        providerId: 'openrouter-custom',
        oauthConnected: () => oauthConnected,
      });
      expect(flags.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
      expect(flags.ENABLE_TOOL_SEARCH).toBe('false');
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

  // issue #7524:自定义供应商默认 'false'(#2929 防线),但用户在 settings.json / 宿主环境
  // 里显式写下的 ENABLE_TOOL_SEARCH 不能被静默覆盖;未显式配置时默认值不变。
  it('lets an explicit user ENABLE_TOOL_SEARCH override the fail-closed default', () => {
    const base = { credentialMode: 'provider-oauth', providerId: 'openrouter-custom', oauthConnected: () => false } as const;
    expect(claudeBehaviorFlagsForSpawn({ ...base, userToolSearch: () => 'true' }).ENABLE_TOOL_SEARCH).toBe('true');
    expect(claudeBehaviorFlagsForSpawn({ ...base, userToolSearch: () => undefined }).ENABLE_TOOL_SEARCH).toBe('false');
    expect(claudeBehaviorFlagsForSpawn(base).ENABLE_TOOL_SEARCH).toBe('false');
  });

  it('reads the user override from host env first, then ~/.claude/settings.json env; ignores junk', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-toolsearch-'));
    try {
      expect(readUserToolSearchOverride({}, home)).toBeUndefined();
      fs.mkdirSync(path.join(home, '.claude'));
      const write = (body: string) => fs.writeFileSync(path.join(home, '.claude', 'settings.json'), body);
      write(JSON.stringify({ env: { ENABLE_TOOL_SEARCH: ' TRUE ' } }));
      expect(readUserToolSearchOverride({}, home)).toBe('true');
      expect(readUserToolSearchOverride({ ENABLE_TOOL_SEARCH: 'auto:10' }, home)).toBe('auto:10');
      write(JSON.stringify({ env: { ENABLE_TOOL_SEARCH: 'banana' } }));
      expect(readUserToolSearchOverride({}, home)).toBeUndefined();
      // CLI 照常应用带 BOM / 注释 / 尾逗号的设置,这里也必须读到(否则显式 override 仍被覆盖)。
      write(`\uFEFF{\n  // keep tool search on\n  "env": { /* note */ "ENABLE_TOOL_SEARCH": "true", },\n}`);
      expect(readUserToolSearchOverride({}, home)).toBe('true');
      write('{ not json');
      expect(readUserToolSearchOverride({}, home)).toBeUndefined();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
