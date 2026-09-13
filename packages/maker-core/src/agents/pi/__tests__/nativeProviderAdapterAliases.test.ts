import { describe, expect, it } from 'vitest';
import { nativeProviderAdapterAliases, PI_NATIVE_PROVIDER_ADAPTER_SOURCE } from '../native-provider-adapter-source.js';

describe('nativeProviderAdapterAliases', () => {
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
    expect(PI_NATIVE_PROVIDER_ADAPTER_SOURCE).toContain("options.apiKey.trim()");
    expect(PI_NATIVE_PROVIDER_ADAPTER_SOURCE).toContain("options?.headers?.['cf-aig-authorization']");
  });
});
