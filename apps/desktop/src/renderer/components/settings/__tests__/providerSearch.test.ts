import { describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG, presetDisplayName, type ProviderView } from '@cindy/model-providers';
import { matchProviderChoices, providerSearchChoices } from '../providerSearch';

const presets = BUNDLED_CATALOG.presets ?? [];
describe('provider name search', () => {
  it('covers every bundled preset and its localized names without a fixed result limit', () => {
    expect(presets.length).toBeGreaterThan(10);
    for (const locale of ['zh-CN', 'zh-TW', 'en']) {
      const choices = providerSearchChoices([], presets, locale, 'Ollama');
      for (const p of presets) {
        for (const name of [p.name, p.nameEn, p.nameZhTW, presetDisplayName(p, locale)].filter(Boolean)) {
          expect(matchProviderChoices(choices, ` ${name!.toUpperCase()} `).map(r => r.key)).toContain(`preset:${p.id}`);
        }
      }
    }
  });
  it('matches names only and preserves distinct targets for identical names', () => {
    const duplicate = { ...presets[0], id: 'another-route' };
    const choices = providerSearchChoices([], [presets[0], duplicate], 'en', 'Ollama');
    expect(matchProviderChoices(choices, presets[0].name).map(r => r.target)).toEqual([
      { kind: 'preset', presetId: presets[0].id }, { kind: 'preset', presetId: duplicate.id },
    ]);
    expect(matchProviderChoices(choices, '  ')).toEqual([]);
    expect(matchProviderChoices(choices, 'my unknown gateway')).toEqual([]);
    expect(matchProviderChoices(choices, 'metaApiKey')).toEqual([]);
  });
  it('uses builtin eligibility and the dedicated Ollama action', () => {
    const providers = [{ id: 'anthropic', name: 'Claude', source: 'builtin', auth: { method: 'oauth' }, connected: true },
      { id: 'xd', name: 'Cindy AI', source: 'builtin', auth: { method: 'oauth' } }] as ProviderView[];
    const choices = providerSearchChoices(providers, [], 'en', 'Ollama');
    expect(choices.map(r => r.target)).toEqual([{ kind: 'builtin', providerId: 'anthropic' }, { kind: 'ollama' }, { kind: 'llamacpp' }]);
  });
});

it('keeps managed llama.cpp separate from the existing-service preset', () => {
  const preset = { id: 'llamacpp', name: 'llama.cpp', runtimes: {} };
  const choices = providerSearchChoices([], [preset], 'en', 'Ollama');
  expect(matchProviderChoices(choices, 'llama.cpp').map(r => r.target)).toEqual([
    { kind: 'preset', presetId: 'llamacpp' }, { kind: 'llamacpp' },
  ]);
});

// #8065 r4430752294: the public search result pairs each managed setup action
// with its existing install/run description, distinct from server-only presets.
it.each([
  ['llamacpp', 'llamacpp.subtitle'],
  ['ollama', 'local.subtitle'],
])('describes managed %s separately from the editable server preset', (id, metaKey) => {
  const choices = providerSearchChoices([], [{ id, name: id, runtimes: {} }], 'en', 'Ollama');
  const managed = choices.find(choice => choice.target.kind === id)!;
  expect(managed.metaKey).toBe(metaKey);
  expect(choices.find(choice => choice.key === `preset:${id}`)!.metaKey).not.toBe(managed.metaKey);
});

// #8065 r4431159002: search must retain the wizard's subscription/local-service
// summaries; a generic API-key label hides the Token Plan credential distinction.
it.each([
  ['xiaomi-mimo-token-plan-cn', 'models.subscriptionProduct', { product: 'MiMo Token Plan' }],
  ['xiaomi-token-plan-ams', 'models.subscriptionProduct', { product: 'MiMo Token Plan' }],
  ['xiaomi-token-plan-sgp', 'models.subscriptionProduct', { product: 'MiMo Token Plan' }],
  ['lmstudio', 'wizard.metaLocalConnect', undefined],
  ['llamacpp', 'wizard.metaNoAuth', undefined],
  ['vllm', 'wizard.metaNoAuth', undefined],
  ['litellm', 'wizard.metaNoAuth', undefined],
  ['deepseek', 'wizard.metaApiKey', undefined],
  ['github-copilot', 'wizard.metaLoginOrApi', undefined],
])('preserves the existing preset summary for %s', (id, metaKey, metaValues) => {
  const preset = presets.find(p => p.id === id)!;
  expect(preset).toBeDefined();
  const result = providerSearchChoices([], [preset], 'en', 'Ollama').find(p => p.key === `preset:${id}`)!;
  expect(result.metaKey).toBe(metaKey);
  expect(result.metaValues).toEqual(metaValues);
});

// #8065 r4431221445: OAuth-only builtins must not advertise an API-key route.
it.each([
  ['anthropic', true, 'wizard.metaOAuthOrApi'],
  ['openai', true, 'wizard.metaOAuthOrApi'],
  ['xai', true, 'wizard.metaOAuthOrApi'],
  ['oauth-only', false, 'wizard.metaOAuth'],
])('matches the wizard builtin auth summary for %s', (id, hasOfficialApi, expected) => {
  const provider = { id, name: id, source: 'builtin', connected: false,
    auth: { method: 'oauth', oauth: { flow: 'device-code' } } } as unknown as ProviderView;
  const official = hasOfficialApi ? { [id]: { id, name: id, runtimes: {} } } : {};
  const choice = providerSearchChoices([provider], [], 'en', 'Ollama', 'llama.cpp', official).find(p => p.key === `builtin:${id}`)!;
  expect(choice.metaKey).toBe(expected);
});
