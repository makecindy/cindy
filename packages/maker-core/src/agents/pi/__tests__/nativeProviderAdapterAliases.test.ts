import { describe, expect, it } from 'vitest';
import { nativeProviderAdapterAliases } from '../native-provider-adapter-source.js';

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
});
