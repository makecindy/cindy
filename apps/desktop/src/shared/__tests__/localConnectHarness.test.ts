import { describe, expect, it } from 'vitest';

import type { CustomProviderConfig } from '@cindy/model-providers';

import { migrateLocalConnectProvider } from '../localConnectHarness.js';
import {
  LLAMACPP_OPENAI_BASE_URL,
  LMSTUDIO_ANTHROPIC_BASE_URL,
  LMSTUDIO_OPENAI_BASE_URL,
  MANAGED_LMSTUDIO_PROVIDER_ID,
  VLLM_OPENAI_BASE_URL,
} from '../localModelRuntime.js';

function piOnly(id: string, baseUrl: string): CustomProviderConfig {
  return {
    id,
    name: id,
    auth: { method: 'none' },
    runtimes: {
      pi: {
        baseUrl,
        wireProtocol: 'openai-chat',
        models: [{ id: 'local-model', name: 'Local Model', contextWindow: 8192 }],
      },
    },
  };
}

describe('migrateLocalConnectProvider', () => {
  it('adds Claude Code and Codex Chat to a legacy LM Studio row', () => {
    const next = migrateLocalConnectProvider(piOnly(MANAGED_LMSTUDIO_PROVIDER_ID, LMSTUDIO_OPENAI_BASE_URL));
    expect(next?.runtimes['claude-code']).toMatchObject({
      baseUrl: LMSTUDIO_ANTHROPIC_BASE_URL,
      wireProtocol: 'anthropic-messages',
      models: [{ id: 'local-model', name: 'Local Model', contextWindow: 8192 }],
    });
    expect(next?.runtimes.codex).toMatchObject({
      baseUrl: LMSTUDIO_OPENAI_BASE_URL,
      wireProtocol: 'openai-chat',
      models: [{ id: 'local-model' }],
    });
  });

  it('adds Codex Chat to llama.cpp and vLLM preset ids, but not Claude Code', () => {
    for (const [id, baseUrl] of [
      ['llamacpp', LLAMACPP_OPENAI_BASE_URL],
      ['vllm', VLLM_OPENAI_BASE_URL],
    ] as const) {
      const next = migrateLocalConnectProvider(piOnly(id, baseUrl));
      expect(next?.runtimes['claude-code']).toBeUndefined();
      expect(next?.runtimes.codex).toMatchObject({
        baseUrl,
        wireProtocol: 'openai-chat',
      });
    }
  });

  it('does not infer a preset from a matching loopback URL alone', () => {
    expect(
      migrateLocalConnectProvider(piOnly('user-local', LLAMACPP_OPENAI_BASE_URL)),
    ).toBeNull();
    expect(migrateLocalConnectProvider(piOnly('user-local', VLLM_OPENAI_BASE_URL))).toBeNull();
  });

  it('rewrites a stored Codex Responses runtime to the Chat bridge', () => {
    const next = migrateLocalConnectProvider({
      ...piOnly(MANAGED_LMSTUDIO_PROVIDER_ID, LMSTUDIO_OPENAI_BASE_URL),
      runtimes: {
        pi: {
          baseUrl: LMSTUDIO_OPENAI_BASE_URL,
          wireProtocol: 'openai-chat',
          models: [],
        },
        'claude-code': {
          baseUrl: LMSTUDIO_ANTHROPIC_BASE_URL,
          wireProtocol: 'anthropic-messages',
          models: [],
        },
        codex: {
          baseUrl: LMSTUDIO_OPENAI_BASE_URL,
          wireProtocol: 'openai-responses',
          models: [],
        },
      },
    });
    expect(next?.runtimes.codex?.wireProtocol).toBe('openai-chat');
  });

  it('leaves customized or unrelated providers alone', () => {
    expect(
      migrateLocalConnectProvider({
        ...piOnly(MANAGED_LMSTUDIO_PROVIDER_ID, LMSTUDIO_OPENAI_BASE_URL),
        auth: { method: 'apiKey' },
      }),
    ).toBeNull();
    expect(
      migrateLocalConnectProvider(piOnly('my-proxy', 'http://127.0.0.1:9999/v1')),
    ).toBeNull();
    expect(
      migrateLocalConnectProvider({
        ...piOnly(MANAGED_LMSTUDIO_PROVIDER_ID, LMSTUDIO_OPENAI_BASE_URL),
        runtimes: {
          pi: {
            baseUrl: LMSTUDIO_OPENAI_BASE_URL,
            wireProtocol: 'openai-chat',
            headers: { Authorization: 'x' },
            models: [],
          },
        },
      }),
    ).toBeNull();
  });
});
