import { describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';

import { buildModelWindowRecoveryToast } from '../components/new-chat/modelWindowErrorToast';

function provider(id: string, source: ProviderView['source']): ProviderView {
  return {
    id,
    name: id === 'custom' ? 'My Provider' : 'OpenAI',
    source,
    agents: ['codex'],
    auth: { method: source === 'user' ? 'apiKey' : 'oauth' },
    routing: {},
    models: {
      codex: [
        {
          id: 'gpt/target model',
          name: 'Target Model',
          contextWindow: 0,
          efforts: [],
          defaultEffort: null,
        },
      ],
    },
    connected: true,
  } as ProviderView;
}

const unknownWindowError = new Error(
  "Error invoking remote method 'maker:set-model': Error: [MODEL_WINDOW_TARGET_CONTEXT_UNKNOWN] missing",
);

describe('model-window recovery toast', () => {
  it('directs a custom provider to the exact editable model', () => {
    const t = vi.fn((key: string, values?: Record<string, string>) =>
      values ? `${key}:${values.provider}:${values.model}` : key,
    );
    const result = buildModelWindowRecoveryToast({
      error: unknownWindowError,
      providerId: 'custom',
      modelId: 'gpt/target model',
      agent: 'codex',
      providers: [provider('custom', 'user')],
      t,
    });

    expect(result).toEqual({
      message: 'newChat.chatInput.modelWindowUnknown.custom:My Provider:Target Model',
      actionLabel: 'newChat.chatInput.modelWindowUnknown.openSettings',
      settingsPath: '/settings?tab=providers&connect=custom&model=gpt%2Ftarget+model&agent=codex',
    });
  });

  it('uses refresh/reconnect guidance for a built-in provider', () => {
    const t = vi.fn((key: string, values?: Record<string, string>) =>
      values ? `${key}:${values.provider}:${values.model}` : key,
    );
    const result = buildModelWindowRecoveryToast({
      error: unknownWindowError,
      providerId: 'openai',
      modelId: 'gpt/target model',
      agent: 'codex',
      providers: [provider('openai', 'builtin')],
      t,
    });

    expect(result?.message).toBe(
      'newChat.chatInput.modelWindowUnknown.builtin:OpenAI:Target Model',
    );
    expect(result?.settingsPath).toContain('connect=openai');
  });

  it('does not add a settings action for unrelated failures', () => {
    expect(
      buildModelWindowRecoveryToast({
        error: new Error('[INTERNAL] failed'),
        providerId: 'openai',
        modelId: 'gpt/target model',
        agent: 'codex',
        providers: [provider('openai', 'builtin')],
        t: (key) => key,
      }),
    ).toBeNull();
  });
});
