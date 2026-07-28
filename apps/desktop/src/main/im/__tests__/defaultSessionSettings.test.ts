import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCapabilities: vi.fn(),
  listProviders: vi.fn(),
  readImDefaultSettings: vi.fn(),
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../logger', () => ({ createLogger: () => mocks.logger }));
vi.mock('../../maker-host', () => ({
  getMaker: () => ({ getCapabilities: mocks.getCapabilities }),
}));
vi.mock('../../maker-host/createDesktopProviderService', () => ({
  getDesktopProviderService: () => ({ listProviders: mocks.listProviders }),
}));
vi.mock('../defaultSettingsStore', () => ({
  readImDefaultSettings: mocks.readImDefaultSettings,
}));

import { resolveImSessionDefaults } from '../defaultSessionSettings';
import type { ImOrchestratorConfig } from '../shared/types';

const config: ImOrchestratorConfig = {
  agentKind: 'claude-code',
  defaultModel: 'claude-opus-4-8',
  defaultPermissionMode: 'auto',
  effortOverrides: { 'claude-opus-4-8': 'xhigh' },
};

const claudeModels = [
  {
    id: 'claude-opus-4-8',
    displayName: 'Opus 4.8',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
  },
  {
    id: 'claude-sonnet-4-6',
    displayName: 'Sonnet 4.6',
    contextWindow: 200_000,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
];

const codexModels = [
  {
    id: 'codex/gpt-5.5',
    displayName: 'GPT 5.5',
    contextWindow: 256_000,
    efforts: ['minimal', 'low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
];

const openAiCodexModels = [
  {
    id: 'gpt-5.5',
    displayName: 'GPT 5.5',
    contextWindow: 256_000,
    efforts: ['minimal', 'low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
];

const providers = [
  {
    id: 'xd',
    name: 'XD',
    source: 'builtin',
    connected: true,
    agents: ['claude-code', 'codex'],
    models: {
      'claude-code': claudeModels,
      codex: codexModels,
    },
    routing: {
      'claude-code': { upstream: 'https://xd.example', authStrategy: 'gateway-key' },
      codex: { upstream: 'https://xd.example', authStrategy: 'gateway-key' },
    },
  },
  {
    id: 'openai',
    name: 'OpenAI',
    source: 'builtin',
    connected: true,
    agents: ['codex'],
    models: {
      'claude-code': [],
      codex: openAiCodexModels,
    },
    routing: {
      codex: { upstream: 'https://api.openai.com', authStrategy: 'oauth-passthrough' },
    },
  },
];

const customCodexModel = {
  id: 'custom-gpt',
  displayName: 'Custom GPT',
  contextWindow: 128_000,
  efforts: ['low', 'high'],
  defaultEffort: 'low',
};

describe('resolveImSessionDefaults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCapabilities.mockImplementation((agentKind: string) => ({
      availableModels: agentKind === 'codex' ? codexModels : claudeModels,
    }));
    mocks.listProviders.mockResolvedValue(providers);
  });

  it('resolves the system IM default to Claude Opus 4.8 xhigh', async () => {
    mocks.readImDefaultSettings.mockReturnValue({
      agentKind: 'claude-code',
      agents: {
        'claude-code': {
          providerId: null,
          model: 'claude-opus-4-8',
          effort: 'xhigh',
        },
        codex: {
          providerId: null,
          model: 'codex/gpt-5.5',
          effort: 'high',
        },
      },
    });

    await expect(resolveImSessionDefaults(config)).resolves.toMatchObject({
      agentKind: 'claude-code',
      model: 'claude-opus-4-8',
      effort: 'xhigh',
      providerId: null,
      permissionMode: 'auto',
      fastMode: false,
    });
  });

  it('reads defaults from the requested channel scope', async () => {
    mocks.readImDefaultSettings.mockReturnValue({
      agentKind: 'claude-code',
      agents: {
        'claude-code': {
          providerId: null,
          model: 'claude-opus-4-8',
          effort: 'xhigh',
        },
        codex: {
          providerId: null,
          model: 'codex/gpt-5.5',
          effort: 'high',
        },
      },
    });

    await resolveImSessionDefaults(config, null, 'discord');

    expect(mocks.readImDefaultSettings).toHaveBeenCalledWith('discord');
  });

  it('keeps a valid Codex default with its selected provider', async () => {
    mocks.readImDefaultSettings.mockReturnValue({
      agentKind: 'codex',
      agents: {
        'claude-code': {
          providerId: null,
          model: 'claude-opus-4-8',
          effort: 'xhigh',
        },
        codex: {
          providerId: 'openai',
          model: 'gpt-5.5',
          effort: 'high',
        },
      },
    });

    await expect(resolveImSessionDefaults(config)).resolves.toMatchObject({
      agentKind: 'codex',
      model: 'gpt-5.5',
      effort: 'high',
      providerId: 'openai',
      permissionMode: 'auto',
    });
  });

  it('drops a stale provider override instead of routing a new IM session to it', async () => {
    mocks.readImDefaultSettings.mockReturnValue({
      agentKind: 'codex',
      agents: {
        'claude-code': {
          providerId: null,
          model: 'claude-opus-4-8',
          effort: 'xhigh',
        },
        codex: {
          providerId: 'xd',
          model: 'gpt-5.5',
          effort: 'high',
        },
      },
    });

    await expect(resolveImSessionDefaults(config)).resolves.toMatchObject({
      agentKind: 'codex',
      model: 'gpt-5.5',
      effort: 'high',
      providerId: null,
    });
  });

  it('falls back to the first model for the selected agent when the saved model is unavailable', async () => {
    mocks.readImDefaultSettings.mockReturnValue({
      agentKind: 'codex',
      agents: {
        'claude-code': {
          providerId: null,
          model: 'claude-opus-4-8',
          effort: 'xhigh',
        },
        codex: {
          providerId: null,
          model: 'missing-model',
          effort: 'xhigh',
        },
      },
    });

    await expect(resolveImSessionDefaults(config)).resolves.toMatchObject({
      agentKind: 'codex',
      model: 'codex/gpt-5.5',
      effort: 'high',
      providerId: null,
    });
  });

  it('uses the selected agent model slot without overwriting the other agent default', async () => {
    mocks.readImDefaultSettings.mockReturnValue({
      agentKind: 'codex',
      agents: {
        'claude-code': {
          providerId: null,
          model: 'claude-opus-4-8',
          effort: 'xhigh',
        },
        codex: {
          providerId: null,
          model: 'codex/gpt-5.5',
          effort: 'high',
        },
      },
    });

    await expect(resolveImSessionDefaults(config)).resolves.toMatchObject({
      agentKind: 'codex',
      model: 'codex/gpt-5.5',
      effort: 'high',
      providerId: null,
    });
  });

  it('uses the live provider catalog for models added after Maker was constructed', async () => {
    mocks.listProviders.mockResolvedValue([
      ...providers,
      {
        id: 'custom',
        name: 'Custom',
        source: 'user',
        connected: true,
        agents: ['codex'],
        models: {
          'claude-code': [],
          codex: [customCodexModel],
        },
        routing: {
          codex: { upstream: 'https://custom.example/v1', authStrategy: 'api-key-header' },
        },
      },
    ]);
    mocks.readImDefaultSettings.mockReturnValue({
      agentKind: 'codex',
      agents: {
        'claude-code': {
          providerId: null,
          model: 'claude-opus-4-8',
          effort: 'xhigh',
        },
        codex: {
          providerId: 'custom',
          model: 'custom-gpt',
          effort: 'high',
        },
      },
    });

    await expect(resolveImSessionDefaults(config)).resolves.toMatchObject({
      agentKind: 'codex',
      model: 'custom-gpt',
      effort: 'high',
      providerId: 'custom',
    });
  });

  it('falls back from Codex budget default when the XD gateway source is disconnected', async () => {
    mocks.listProviders.mockResolvedValue([{ ...providers[0], connected: false }, providers[1]]);
    mocks.readImDefaultSettings.mockReturnValue({
      agentKind: 'codex',
      agents: {
        'claude-code': {
          providerId: null,
          model: 'claude-opus-4-8',
          effort: 'xhigh',
        },
        codex: {
          providerId: null,
          model: 'codex/gpt-5.5',
          effort: 'high',
        },
      },
    });

    await expect(resolveImSessionDefaults(config)).resolves.toMatchObject({
      agentKind: 'codex',
      model: 'gpt-5.5',
      effort: 'high',
      providerId: null,
    });
  });
});
