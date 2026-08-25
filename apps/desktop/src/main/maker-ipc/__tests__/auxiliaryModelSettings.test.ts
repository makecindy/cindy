import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

vi.mock('../../maker-host/active-catalog.js', () => ({
  getActiveCatalog: () => ({ providers: [] }),
}));

vi.mock('../../maker-host/model-disable-store.js', () => ({
  readModelDisableOverrides: () => ({ disabledModels: {}, disabledProviders: {} }),
}));

vi.mock('../../maker-host/provider-order-store.js', () => ({
  readProviderOrder: () => [],
}));

vi.mock('../../utility-model/auxiliary-model-settings-store.js', () => ({
  readAuxiliaryModelSettingsState: vi.fn(),
  writeAuxiliaryModelSettingsPatch: vi.fn(),
}));

vi.mock('../../utility-model/oneshotProviderUsability.js', () => ({
  hasOneshotProviderCredential: () => false,
}));

vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));

import {
  buildAuxiliaryModelOptions,
  parseAuxiliaryModelSettingsPatch,
} from '../auxiliary-model-settings.js';

const PIN = 'cat:openrouter:codex:openai/gpt-5-mini';

function catalog() {
  return {
    providers: [
      {
        id: 'openrouter',
        name: 'OpenRouter',
        source: 'user',
        agents: ['codex'],
        auth: { method: 'apiKey' },
        routing: {
          codex: {
            upstream: 'https://openrouter.example/v1',
            authStrategy: 'api-key-header',
            wireProtocol: 'openai-chat',
          },
        },
        models: {
          codex: [
            {
              id: 'openai/gpt-5-mini',
              name: 'GPT 5 mini',
              contextWindow: 100_000,
              group: 'custom:openrouter',
            },
          ],
        },
      },
    ],
  } as never;
}

describe('auxiliary model settings IPC helpers', () => {
  it('accepts only known canonical pins and null resets', () => {
    const allowed = new Set([PIN]);
    expect(parseAuxiliaryModelSettingsPatch({ sessionTitleModel: PIN }, allowed)).toEqual({
      sessionTitleModel: PIN,
    });
    expect(
      parseAuxiliaryModelSettingsPatch({ promptRecommendationModel: null }, allowed),
    ).toEqual({ promptRecommendationModel: null });

    expect(() =>
      parseAuxiliaryModelSettingsPatch({ sessionTitleModel: ` ${PIN}` }, allowed),
    ).toThrow(/canonical catalog model pin/);
    expect(() =>
      parseAuxiliaryModelSettingsPatch(
        { sessionTitleModel: 'cat:other:codex:model' },
        allowed,
      ),
    ).toThrow(/currently routable/);
    expect(() =>
      parseAuxiliaryModelSettingsPatch({ unexpected: PIN }, allowed),
    ).toThrow(/invalid keys/);
  });

  it('keeps a selected but credential-unavailable route visible and removable', () => {
    const options = buildAuxiliaryModelOptions({
      settings: { sessionTitleModel: PIN, promptRecommendationModel: null },
      catalog: catalog(),
      overrides: { disabledModels: {}, disabledProviders: {} },
      hasCredential: () => false,
    });

    expect(options).toEqual([
      expect.objectContaining({
        id: PIN,
        providerId: 'openrouter',
        modelId: 'openai/gpt-5-mini',
        available: false,
      }),
    ]);
  });

  it('does not expose a stale selection as available when it left the catalog', () => {
    const stalePin = 'cat:removed:claude-code:old-model';
    const options = buildAuxiliaryModelOptions({
      settings: { sessionTitleModel: stalePin, promptRecommendationModel: null },
      catalog: catalog(),
      overrides: { disabledModels: {}, disabledProviders: {} },
      hasCredential: () => true,
    });

    expect(options.find((option) => option.id === stalePin)).toMatchObject({
      available: false,
      providerId: 'removed',
      agentKind: 'claude-code',
      modelId: 'old-model',
    });
  });
});
