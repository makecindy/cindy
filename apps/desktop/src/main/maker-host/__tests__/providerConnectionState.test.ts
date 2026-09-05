import { describe, expect, it, vi } from 'vitest';
import { BUNDLED_CATALOG, type Provider } from '@cindy/model-providers';
import { hasCustomProviderCredential } from '../provider-connection-state.js';

function custom(): Provider {
  return {
    ...BUNDLED_CATALOG.providers[0]!,
    id: 'custom-api',
    source: 'user',
    agents: ['codex'],
    auth: { method: 'apiKey' },
    routing: { codex: { upstream: 'https://example.invalid/v1', authStrategy: 'api-key-header' } },
  };
}
describe('custom provider credential readiness', () => {
  it('configuration alone cannot make OpenRouter/OpenCode-style APIs connected', () => {
    expect(hasCustomProviderCredential(custom(), () => null)).toBe(false);
    expect(hasCustomProviderCredential(custom(), () => '  ')).toBe(false);
    expect(hasCustomProviderCredential(custom(), () => 'test-only-invalid-key')).toBe(true);
  });
  it('preserves legacy authorization headers without treating display metadata as a key', () => {
    const provider = custom();
    provider.routing.codex!.headerOverride = { 'HTTP-Referer': 'https://example.invalid' };
    expect(hasCustomProviderCredential(provider, () => null)).toBe(false);
    provider.routing.codex!.headerOverride.Authorization = 'Bearer test-only-invalid';
    expect(hasCustomProviderCredential(provider, () => null)).toBe(true);
    provider.routing.codex!.headerOverride.Authorization = '';
    expect(hasCustomProviderCredential(provider, () => null)).toBe(false);
  });
  it('does not read keys for disabled runtimes and keeps explicit no-auth routes usable', () => {
    const provider = custom();
    const read = vi.fn(() => 'test-only-invalid-key');
    provider.routing.codex!.disabled = true;
    expect(hasCustomProviderCredential(provider, read)).toBe(false);
    expect(read).not.toHaveBeenCalled();
    provider.routing.codex!.disabled = false;
    provider.routing.codex!.authStrategy = 'none';
    expect(hasCustomProviderCredential(provider, () => null)).toBe(true);
  });
});
