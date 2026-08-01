import { describe, expect, it } from 'vitest';

import { resolveCodexCompatibilityWireProtocol } from '../codexCompatibility.js';
import type { CatalogModel, Provider, ProviderWireProtocol } from '../types.js';

function provider(wireProtocol?: ProviderWireProtocol): Provider {
  return {
    id: 'fixture',
    name: 'Fixture',
    source: 'user',
    agents: ['codex'],
    auth: { method: 'none' },
    routing: {
      codex: {
        upstream: 'https://example.test',
        authStrategy: 'none',
        ...(wireProtocol ? { wireProtocol } : {}),
      },
    },
    models: { codex: [] },
  };
}

const model: Pick<CatalogModel, 'codexCompatibilityWireProtocol'> = {};

describe('resolveCodexCompatibilityWireProtocol', () => {
  it.each([
    ['openai-chat', 'openai-chat'],
    ['anthropic-messages', 'anthropic-messages'],
    ['openai-responses', null],
    [undefined, null],
  ] as const)('把 Provider 级 %s 解析为 %s', (wireProtocol, expected) => {
    expect(resolveCodexCompatibilityWireProtocol(provider(wireProtocol), 'codex', model)).toBe(
      expected,
    );
  });

  it('模型级协议覆盖 Provider 的原生 Responses 路由', () => {
    expect(
      resolveCodexCompatibilityWireProtocol(provider('openai-responses'), 'codex', {
        codexCompatibilityWireProtocol: 'anthropic-messages',
      }),
    ).toBe('anthropic-messages');
  });

  it('非 Codex agent 不显示兼容模式', () => {
    expect(
      resolveCodexCompatibilityWireProtocol(provider('anthropic-messages'), 'claude-code', model),
    ).toBeNull();
  });
});
