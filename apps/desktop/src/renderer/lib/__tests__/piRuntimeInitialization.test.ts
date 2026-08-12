import { describe, expect, it } from 'vitest';

import { derivePiRuntimeFromClaudeRuntime } from '@/../shared/piRuntimeInitialization';

describe('derivePiRuntimeFromClaudeRuntime', () => {
  it('projects a plain Claude runtime to Pi without a request path', () => {
    const result = derivePiRuntimeFromClaudeRuntime({
      baseUrl: 'https://api.example/anthropic',
      modelsUrl: 'https://api.example/v1/models',
      headers: { 'x-provider': 'example' },
      models: [
        {
          id: 'model-a',
          name: 'Model A',
          contextWindow: 100_000,
          defaultEnabled: false,
          supportsImageInput: true,
          reasoning: true,
          reasoningEfforts: ['high'],
        },
      ],
    });

    expect(result).toEqual({
      baseUrl: 'https://api.example/anthropic',
      wireProtocol: 'anthropic-messages',
      models: [
        { id: 'model-a', name: 'Model A', contextWindow: 100_000, defaultEnabled: false },
      ],
      headers: { 'x-provider': 'example' },
      modelsUrl: 'https://api.example/v1/models',
    });
  });

  it('does not project a Claude runtime with a custom request path', () => {
    expect(
      derivePiRuntimeFromClaudeRuntime({
        baseUrl: 'https://api.example/anthropic',
        requestPath: '/tenant/acme/infer',
        models: [{ id: 'model-a', name: 'Model A' }],
      }),
    ).toBeNull();
  });

  it('does not override an incompatible explicit wire protocol', () => {
    expect(
      derivePiRuntimeFromClaudeRuntime({
        baseUrl: 'https://api.example/v1',
        wireProtocol: 'openai-chat',
        models: [{ id: 'model-a', name: 'Model A' }],
      }),
    ).toBeNull();
  });
});
