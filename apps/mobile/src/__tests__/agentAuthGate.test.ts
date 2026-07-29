import { beforeAll, describe, expect, it } from 'vitest';
import type { ProviderView } from '@cindy/model-providers/registry';
import { i18n } from '@/i18n';
import { agentAuthGateHint, agentAuthGateVerdict } from '@/session/agentAuthGate';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

function provider(patch: Partial<ProviderView> & Pick<ProviderView, 'id' | 'agents' | 'connected'>): ProviderView {
  return {
    name: patch.id,
    source: 'builtin',
    auth: { method: 'api-key' },
    routing: Object.fromEntries(
      patch.agents.map((agent) => [
        agent,
        { upstream: 'https://example.test', authStrategy: 'api-key-header' },
      ]),
    ),
    models: {},
    ...patch,
  } as ProviderView;
}

describe('agentAuthGateVerdict', () => {
  const base = { loading: false, error: null as string | null };

  it('returns unknown while loading, on fetch error, or with an empty catalog (fail-open)', () => {
    const providers = [provider({ id: 'xd', agents: ['claude-code'], connected: true })];
    expect(agentAuthGateVerdict({ ...base, providers, loading: true, agentKind: 'claude-code' })).toBe('unknown');
    expect(agentAuthGateVerdict({ ...base, providers, error: 'CHANNEL_NOT_ALLOWED', agentKind: 'claude-code' })).toBe('unknown');
    expect(agentAuthGateVerdict({ ...base, providers: [], agentKind: 'claude-code' })).toBe('unknown');
  });

  it('returns ready when the agent has a connected provider', () => {
    const providers = [
      provider({ id: 'xd', agents: ['claude-code', 'codex'], connected: true }),
      provider({ id: 'anthropic', agents: ['claude-code'], connected: false }),
    ];
    expect(agentAuthGateVerdict({ ...base, providers, agentKind: 'claude-code' })).toBe('ready');
    expect(agentAuthGateVerdict({ ...base, providers, agentKind: 'codex' })).toBe('ready');
  });

  it('returns unauthenticated when no provider for that agent is connected', () => {
    // openai 只服务 codex 且已连接;claude-code 一个已连接来源都没有(截图场景:no_key)。
    const providers = [
      provider({ id: 'xd', agents: ['claude-code', 'codex'], connected: false }),
      provider({ id: 'openai', agents: ['codex'], connected: true }),
    ];
    expect(agentAuthGateVerdict({ ...base, providers, agentKind: 'claude-code' })).toBe('unauthenticated');
    expect(agentAuthGateVerdict({ ...base, providers, agentKind: 'codex' })).toBe('ready');
  });
});

describe('agentAuthGateHint', () => {
  it('names the agent and guides to desktop provider settings', () => {
    expect(agentAuthGateHint('claude-code')).toContain('Claude');
    expect(agentAuthGateHint('claude-code')).toContain('设置 → 模型供应商');
    expect(agentAuthGateHint('codex')).toContain('Codex');
  });
});
