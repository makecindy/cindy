import { describe, expect, it } from 'vitest';

import {
  canReuseCodexHostForCredentialMode,
  canReuseHostForCredentialMode,
  isCindyProviderCodexRemoteCompactionRoute,
  resolveAgentCredentialMode,
  resolveEffectiveCredentialModeFromAuthSource,
} from './credential-mode.js';

describe('isCindyProviderCodexRemoteCompactionRoute', () => {
  it.each([null, undefined, 'xd'])('accepts Cindy codex models for provider %s', (providerId) => {
    expect(isCindyProviderCodexRemoteCompactionRoute({
      providerId,
      model: 'codex/gpt-5.6-sol',
    })).toBe(true);
  });

  it.each([
    { providerId: 'xd', model: 'gpt-5.6-sol' },
    { providerId: 'openai', model: 'codex/gpt-5.6-sol' },
    { providerId: 'xai', model: 'codex/gpt-5.6-sol' },
    { providerId: 'xd', model: 'codex/' },
  ])('rejects non-Cindy-Codex route $providerId/$model', (input) => {
    expect(isCindyProviderCodexRemoteCompactionRoute(input)).toBe(false);
  });
});

describe('resolveAgentCredentialMode', () => {
  it('uses built-in provider ids as the authoritative credential source', () => {
    expect(resolveAgentCredentialMode({
      agentKind: 'codex',
      providerId: 'xd',
      model: 'codex/gpt-5.5',
    })).toBe('gateway-key');
    expect(resolveAgentCredentialMode({
      agentKind: 'codex',
      providerId: 'openai',
      model: 'gpt-5.4',
    })).toBe('oauth-bearer');
    expect(resolveAgentCredentialMode({
      agentKind: 'codex',
      providerId: 'xai',
      model: 'xai/grok-4.3',
    })).toBe('provider-oauth');
    expect(resolveAgentCredentialMode({
      agentKind: 'claude-code',
      providerId: 'anthropic',
      model: 'claude-sonnet-4.5',
    })).toBe('oauth-bearer');
    expect(resolveAgentCredentialMode({
      agentKind: 'claude-code',
      providerId: 'openai',
      model: 'chatgpt/gpt-5.5',
    })).toBe('provider-oauth');
    expect(resolveAgentCredentialMode({
      agentKind: 'claude-code',
      providerId: 'xai',
      model: 'xai/grok-4.5',
    })).toBe('provider-oauth');
  });

  it('uses host-injected auth for explicit third-party providers on either runtime', () => {
    expect(resolveAgentCredentialMode({
      agentKind: 'claude-code',
      providerId: 'custom-anthropic-compatible',
      model: 'custom-model',
    })).toBe('provider-oauth');
    expect(resolveAgentCredentialMode({
      agentKind: 'codex',
      providerId: 'custom-openai-compatible',
      model: 'codex/gpt-5.6-luna',
    })).toBe('provider-oauth');
  });

  it('infers credential mode from uniquely-owned model prefixes when provider id is absent', () => {
    expect(resolveAgentCredentialMode({
      agentKind: 'codex',
      model: 'codex/gpt-5.5',
    })).toBe('gateway-key');
    expect(resolveAgentCredentialMode({
      agentKind: 'codex',
      model: 'xai/grok-4.3',
    })).toBe('provider-oauth');
    expect(resolveAgentCredentialMode({
      agentKind: 'claude-code',
      model: 'chatgpt/gpt-5.5',
    })).toBe('provider-oauth');
    expect(resolveAgentCredentialMode({
      agentKind: 'claude-code',
      model: 'xai/grok-4.5',
    })).toBe('provider-oauth');
  });
});

describe('canReuseCodexHostForCredentialMode', () => {
  it('allows gateway-key sessions to reuse the oauth superset host (方案 A)', () => {
    expect(canReuseCodexHostForCredentialMode('oauth-bearer', 'gateway-key')).toBe(true);
  });

  it('keeps every other pairing on the generic rules', () => {
    expect(canReuseCodexHostForCredentialMode('gateway-key', 'oauth-bearer')).toBe(false);
    expect(canReuseCodexHostForCredentialMode('gateway-key', 'gateway-key')).toBe(true);
    expect(canReuseCodexHostForCredentialMode('oauth-bearer', 'oauth-bearer')).toBe(true);
    expect(canReuseCodexHostForCredentialMode('oauth-bearer', 'provider-oauth')).toBe(true);
    expect(canReuseCodexHostForCredentialMode('provider-oauth', 'gateway-key')).toBe(false);
    expect(canReuseCodexHostForCredentialMode(undefined, 'gateway-key')).toBe(false);
    expect(canReuseCodexHostForCredentialMode('oauth-bearer', undefined)).toBe(false);
  });
});

describe('resolveEffectiveCredentialModeFromAuthSource', () => {
  it('keeps explicit requests untouched', () => {
    expect(resolveEffectiveCredentialModeFromAuthSource('gateway-key', 'oauth')).toBe('gateway-key');
    expect(resolveEffectiveCredentialModeFromAuthSource('oauth-bearer', 'api-key')).toBe('oauth-bearer');
  });

  it('maps implicit requests to the fallback auth family', () => {
    expect(resolveEffectiveCredentialModeFromAuthSource(undefined, 'oauth')).toBe('oauth-bearer');
    expect(resolveEffectiveCredentialModeFromAuthSource(undefined, 'api-key')).toBe('gateway-key');
    expect(resolveEffectiveCredentialModeFromAuthSource(undefined, undefined)).toBeUndefined();
  });
});

describe('canReuseHostForCredentialMode', () => {
  it('reuses the host when the normalized families match', () => {
    // 2026-07-03 排队假死回归:providerId=null 的会话曾以 undefined 参战、被严格相等
    // 判成异族触发重启。修复方式是入参先过 resolveEffectiveCredentialModeFromAuthSource
    // 归一化 —— 同族(如 null 会话 fallback=api-key vs 显式 xd)在这里相等、直接复用。
    expect(canReuseHostForCredentialMode('gateway-key', 'gateway-key')).toBe(true);
    expect(canReuseHostForCredentialMode('oauth-bearer', 'oauth-bearer')).toBe(true);
    expect(canReuseHostForCredentialMode('gateway-key', 'provider-oauth')).toBe(true);
    expect(canReuseHostForCredentialMode('oauth-bearer', 'provider-oauth')).toBe(true);
    expect(canReuseHostForCredentialMode('provider-oauth', 'provider-oauth')).toBe(true);
    expect(canReuseHostForCredentialMode(undefined, undefined)).toBe(true);
  });

  it('keeps the conservative restart semantics for unresolvable or cross-family requests', () => {
    // 解析不出形态(未登录 / 无 authSource)时不给绿灯:意图不明的会话不得挂到
    // 显式凭证进程上(owner 安全不变量)。
    expect(canReuseHostForCredentialMode('gateway-key', undefined)).toBe(false);
    expect(canReuseHostForCredentialMode(undefined, 'gateway-key')).toBe(false);
    expect(canReuseHostForCredentialMode('gateway-key', 'oauth-bearer')).toBe(false);
    expect(canReuseHostForCredentialMode('oauth-bearer', 'gateway-key')).toBe(false);
    expect(canReuseHostForCredentialMode('provider-oauth', 'gateway-key')).toBe(false);
    expect(canReuseHostForCredentialMode('provider-oauth', 'oauth-bearer')).toBe(false);
  });
});
