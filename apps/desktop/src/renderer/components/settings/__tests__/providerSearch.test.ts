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
