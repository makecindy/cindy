import { describe, expect, it } from 'vitest';
import { buildCodexProxySpawnArgs, codexProxyAuthEnv } from './codex-proxy.js';

describe('Codex headless proxy spawn configuration', () => {
  it('uses a placeholder env key for provider-routed sessions and never serializes the credential', () => {
    expect(buildCodexProxySpawnArgs('http://127.0.0.1:51337', 'provider-oauth')).toEqual(expect.arrayContaining([
      'model_provider="cindy_headless"',
      'model_providers.cindy_headless.base_url="http://127.0.0.1:51337"',
      'model_providers.cindy_headless.env_key="CINDY_CODEX_PROXY_KEY"',
    ]));
    expect(codexProxyAuthEnv()).toEqual({ CINDY_CODEX_PROXY_KEY: 'cindy-headless-codex-proxy-placeholder' });
  });
});
