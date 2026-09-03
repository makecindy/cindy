import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

vi.mock('../../maker-host/active-catalog.js', () => ({
  getActiveCatalog: () => ({ providers: [] }),
  isXdGatewayPaymentRequiredRoute: () => false,
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

vi.mock('../../utility-model/oneShotCandidates.js', () => ({
  isUtilityRouteDisabled: () => false,
  isUtilityRoutePaymentRequired: () => false,
}));

vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));

import {
  buildAuxiliaryModelOptions,
  parseAuxiliaryModelSettingsPatch,
} from '../auxiliary-model-settings.js';

const PIN = 'cat:openrouter:codex:openai/gpt-5-mini';
const PROFILE = 'codex-gpt-5.4-mini';

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

function builtinCodexCatalog() {
  return {
    providers: [
      {
        id: 'openai',
        name: 'OpenAI',
        source: 'builtin',
        agents: ['codex'],
        auth: { method: 'oauth' },
        routing: {
          codex: {
            upstream: 'https://openai.example/v1',
            authStrategy: 'oauth-passthrough',
          },
        },
        models: { codex: [] },
      },
    ],
  } as never;
}

describe('auxiliary model settings IPC helpers', () => {
  it('accepts a unique models list and empty automatic reset', () => {
    const allowed = new Set([PIN]);
    expect(parseAuxiliaryModelSettingsPatch({ models: [PIN] }, allowed)).toEqual({
      models: [PIN],
    });
    expect(parseAuxiliaryModelSettingsPatch({ models: [] }, allowed)).toEqual({
      models: [],
    });
    expect(parseAuxiliaryModelSettingsPatch({ models: [PROFILE] }, allowed)).toEqual({
      models: [PROFILE],
    });
  });

  it('keeps a persisted catalog pin removable even when it left the live allowlist', () => {
    expect(
      parseAuxiliaryModelSettingsPatch({ models: [PIN] }, new Set(), new Set([PIN])),
    ).toEqual({ models: [PIN] });
  });

  it('rejects unknown keys, padded refs, and unroutable catalog pins', () => {
    const allowed = new Set([PIN]);
    expect(() =>
      parseAuxiliaryModelSettingsPatch({ sessionTitleModel: PIN }, allowed),
    ).toThrow(/invalid keys/);
    expect(() =>
      parseAuxiliaryModelSettingsPatch({ models: [` ${PIN}`] }, allowed),
    ).toThrow(/unique list of at most 3/);
    expect(() =>
      parseAuxiliaryModelSettingsPatch({ models: ['cat:other:codex:model'] }, allowed),
    ).toThrow(/not currently routable/);
  });

  it('keeps a selected but credential-unavailable route visible and removable', () => {
    const options = buildAuxiliaryModelOptions({
      settings: { models: [PIN] },
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

  it('marks a migrated utility profile available when its direct route is usable', () => {
    const options = buildAuxiliaryModelOptions({
      settings: { models: [PROFILE] },
      catalog: builtinCodexCatalog(),
      overrides: { disabledModels: {}, disabledProviders: {} },
      hasCredential: () => true,
    });

    expect(options).toEqual([
      expect.objectContaining({
        id: PROFILE,
        providerId: 'openai',
        available: true,
      }),
    ]);
  });

  it('does not expose a stale selection as available when it left the catalog', () => {
    const stalePin = 'cat:removed:claude-code:old-model';
    const options = buildAuxiliaryModelOptions({
      settings: { models: [stalePin] },
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
