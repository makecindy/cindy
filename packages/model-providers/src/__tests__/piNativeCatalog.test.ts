import { afterEach, expect, it, vi } from 'vitest';
import generated from '../../catalog/provider-models.json';
import { toCindyCatalog } from '../../../../tools/pi/catalog-format.mjs';

afterEach(() => {
  vi.doUnmock('../../catalog/provider-models.json');
  vi.resetModules();
});

it.each([
  { provider: 'xai', builtin: 'xai', prefix: '', previous: 'grok-4.8', future: 'grok-4.9', api: 'openai-completions' },
  { provider: 'openai-codex', builtin: 'openai', prefix: 'chatgpt/', previous: 'gpt-6-sol', future: 'gpt-7-sol', api: 'openai-codex-responses' },
])('initializes the offline catalog with sparse $provider models', async fixture => {
  const base = { provider: fixture.provider, api: fixture.api, baseUrl: 'https://source.example/v1' };
  const converted = toCindyCatalog({ [fixture.provider]: [
    { ...base, id: fixture.previous, contextWindow: 345000 },
    // A parallel route cannot supply this connection's fallback window.
    { ...base, id: fixture.previous.replace(/6|4\.8/, fixture.provider === 'xai' ? '4.8.1' : '6.9'),
      baseUrl: 'https://other.example/v1', contextWindow: 9000 },
    { ...base, id: fixture.future },
    { ...base, id: 'private-model' },
  ] }, 'fixture');
  vi.resetModules();
  vi.doMock('../../catalog/provider-models.json', () => ({ default: {
    ...generated, providers: { ...generated.providers, ...converted.providers },
  } }));
  const { BUILTIN_PROVIDERS } = await import('../builtin.js');
  const models = BUILTIN_PROVIDERS.find(provider => provider.id === fixture.builtin)!.models.pi!;
  const future = models.find(model => model.id === fixture.prefix + fixture.future)!;
  expect(future).toMatchObject({ contextWindow: 345000, contextWindowVerified: false });
  expect(future.discoveredMetadata).not.toHaveProperty('contextWindow');
  const unknown = models.find(model => model.id === fixture.prefix + 'private-model')!;
  expect(unknown.contextWindow).toBeGreaterThan(0);
  expect(unknown.contextWindowVerified).toBe(false);
  expect(unknown.discoveredMetadata).not.toHaveProperty('contextWindow');
  expect(models.find(model => model.id === fixture.prefix + fixture.previous))
    .toMatchObject({ contextWindow: 345000, contextWindowVerified: true });
});
