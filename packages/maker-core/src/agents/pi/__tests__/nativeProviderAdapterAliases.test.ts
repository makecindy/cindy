import { describe, expect, it } from 'vitest';
import { nativeProviderAdapterAliases, PI_NATIVE_PROVIDER_ADAPTER_SOURCE } from '../native-provider-adapter-source.js';

describe('nativeProviderAdapterAliases', () => {
  // Unit, sharing §12: native wire IDs differ from grant IDs. The generated
  // adapter must query the catalog identity rather than deny/bypass a bare alias.
  it.each([
    { source: 'openai', model: 'chatgpt/gpt', wire: 'gpt', grant: 'chatgpt/gpt' },
    { source: 'xai', model: 'xai/grok', wire: 'grok', grant: 'grok' },
  ])('maps $source native model aliases to the original grant', ({ source, model, wire, grant }) => {
    expect(nativeProviderAdapterAliases([{ id: 'runtime', sourceProviderId: source, name: 'Native',
      models: [{ id: model, wireId: wire }, { id: 'denied' }], modelIdAliases: { [grant]: model },
    }], [grant])).toEqual([{ id: 'runtime', name: 'Native', provider: 'runtime', models: [
      { id: model, grant }, { id: wire, grant },
    ] }]);
  });
  it('registers proxy-authenticated adapters without requiring an API key env', () => {
    expect(nativeProviderAdapterAliases([
      { id: 'copilot-oauth', name: 'Copilot', adapterProvider: 'github-copilot' },
      { id: 'generic', name: 'Generic' },
      { id: 'cloudflare', name: 'Cloudflare', adapterProvider: 'cloudflare-ai-gateway', apiKeyEnvVar: 'CINDY_PI_KEY_CF' },
    ])).toEqual([
      { id: 'copilot-oauth', name: 'Copilot', provider: 'github-copilot' },
      { id: 'cloudflare', name: 'Cloudflare', provider: 'cloudflare-ai-gateway', keyEnv: 'CINDY_PI_KEY_CF' },
    ]);
  });

  it('does not replace a saved Cloudflare header with an empty API key', () => {
    expect(PI_NATIVE_PROVIDER_ADAPTER_SOURCE).toContain('pi-native-keyless');
    expect(PI_NATIVE_PROVIDER_ADAPTER_SOURCE).toContain("options?.headers?.['cf-aig-authorization']");
  });

  it('enables cached transport only for host-authenticated Codex subscription providers', () => {
    expect(nativeProviderAdapterAliases([
      { id: 'openai-codex', name: 'ChatGPT', headers: { 'x-cindy-pi-provider-id': 'openai' }, models: [{ id: 'gpt', api: 'openai-codex-responses' }] },
      { id: 'openai-codex-account', name: 'Other account', headers: { 'x-cindy-pi-provider-id': 'account' }, api: 'openai-codex-responses' },
      { id: 'byom', name: 'BYOM', models: [{ id: 'gpt', api: 'openai-codex-responses' }] },
      { id: 'xai', name: 'Grok', headers: { 'x-cindy-pi-provider-id': 'xai' }, models: [{ id: 'grok', api: 'openai-responses' }] },
    ])).toEqual([
      { id: 'openai-codex', name: 'ChatGPT', provider: 'openai-codex', cachedCodex: true },
      { id: 'openai-codex-account', name: 'Other account', provider: 'openai-codex-account', cachedCodex: true },
    ]);
  });

  it('retains per-model HTTP checks for hosted and shared-provider tasks', () => {
    const providers = [{ id: 'openai-codex', name: 'ChatGPT', api: 'openai-codex-responses',
      headers: { 'x-cindy-pi-provider-id': 'openai' }, models: [{ id: 'gpt' }] }];
    expect(nativeProviderAdapterAliases(providers, undefined, true)[0]).not.toHaveProperty('cachedCodex');
    expect(nativeProviderAdapterAliases(providers, ['gpt'])[0]).not.toHaveProperty('cachedCodex');
  });
});
