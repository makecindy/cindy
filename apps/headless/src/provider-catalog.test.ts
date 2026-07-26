import { describe, expect, it } from 'vitest';
import { DEFAULT_HEADLESS_CONFIG, type HeadlessConfig } from './config.js';
import { HeadlessProviderCatalog } from './provider-catalog.js';

function configWithCustomProvider(): HeadlessConfig {
  return {
    ...DEFAULT_HEADLESS_CONFIG,
    defaults: { ...DEFAULT_HEADLESS_CONFIG.defaults },
    limits: { ...DEFAULT_HEADLESS_CONFIG.limits },
    providerProfiles: [{
      id: 'company-gateway',
      enabled: true,
      secretRef: 'company_gateway_key',
      custom: {
        id: 'company-gateway',
        name: 'Company Gateway',
        runtimes: {
          codex: {
            baseUrl: 'https://models.example.test/v1',
            models: [{ id: 'company-code-2', name: 'Company Code 2', contextWindow: 128_000 }],
          },
        },
      },
    }],
  };
}

describe('HeadlessProviderCatalog', () => {
  it('projects a non-secret, agent-filtered view of custom providers and models', () => {
    const catalog = new HeadlessProviderCatalog();
    const config = configWithCustomProvider();

    expect(catalog.listProviders(config, 'codex')).toContainEqual(expect.objectContaining({
      id: 'company-gateway', enabled: true, credentialConfigured: true, authMethod: 'apiKey',
    }));
    expect(catalog.listProviders(config, 'claude-code')).not.toContainEqual(expect.objectContaining({ id: 'company-gateway' }));
    expect(catalog.listModels(config, 'codex', 'company-gateway')).toEqual([
      expect.objectContaining({ providerId: 'company-gateway', id: 'company-code-2' }),
    ]);
  });

  it('rejects a model that a configured provider does not offer', () => {
    const catalog = new HeadlessProviderCatalog();
    expect(() => catalog.assertSelection(configWithCustomProvider(), 'codex', 'company-gateway', 'other-model'))
      .toThrow('not offered');
  });

  it('shows Cindy-account gateway models without requiring a Codex or Claude login', () => {
    const catalog = new HeadlessProviderCatalog();
    const config: HeadlessConfig = {
      ...DEFAULT_HEADLESS_CONFIG,
      defaults: {}, limits: { ...DEFAULT_HEADLESS_CONFIG.limits },
      account: { deviceId: 'linux-host', region: 'cn' },
      managedModels: [{ id: 'cindy-gpt', name: 'Cindy GPT', agents: ['codex', 'claude-code'] }],
    };
    expect(catalog.listProviders(config, 'codex')).toContainEqual(expect.objectContaining({
      id: 'xd', credentialConfigured: true,
    }));
    expect(catalog.listModels(config, 'codex', 'xd')).toEqual([
      expect.objectContaining({ id: 'cindy-gpt', providerId: 'xd' }),
    ]);
  });
});
