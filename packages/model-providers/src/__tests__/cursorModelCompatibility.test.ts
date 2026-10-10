import { describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG } from '../catalog.js';
import { chatEligibleSourcesForModel, getModel, providerOffersModel, type ProviderView } from '../registry.js';
import type { CatalogModel } from '../types.js';

function cursorProvider(models: CatalogModel[] = []): ProviderView {
  return { ...BUNDLED_CATALOG.providers.find(provider => provider.id === 'cursor')!, connected: true,
    models: { cursor: models } };
}
const auto: CatalogModel = { id: 'default', name: 'Auto', contextWindow: 0,
  efforts: [], defaultEffort: null, newSessionDefault: ['cursor'] };

describe('saved Cursor default routes', () => {
  it('keeps an old task usable and labels it from the native default without advertising a duplicate choice', () => {
    const provider = cursorProvider([auto]);
    expect(getModel(provider, 'cursor-default', 'cursor')).toMatchObject({ id: 'cursor-default', name: 'Auto' });
    expect(chatEligibleSourcesForModel([provider], 'cursor-default', 'cursor')).toEqual([provider]);
    expect(providerOffersModel(provider, 'cursor-default', 'cursor')).toBe(false);
    expect(provider.models.cursor?.map(model => model.id)).toEqual(['default']);
  });
  it('requires a discovered native default and never supplies invented controls or aliases to other sources', () => {
    const provider = cursorProvider([{ ...auto, id: 'native-grok', name: 'Grok', efforts: ['high'], supportsFastMode: true }]);
    expect(getModel(provider, 'cursor-default', 'cursor')).toMatchObject({ name: 'Grok', efforts: [], defaultEffort: null, supportsFastMode: false });
    expect(getModel(cursorProvider(), 'cursor-default', 'cursor')).toBeUndefined();
    expect(getModel(cursorProvider([{ ...auto, newSessionDefault: undefined }]), 'cursor-default', 'cursor')).toBeUndefined();
    expect(getModel({ ...provider, id: 'other' }, 'cursor-default', 'cursor')).toBeUndefined();
    expect(getModel({ ...provider, source: 'user' }, 'cursor-default', 'cursor')).toBeUndefined();
  });
  it('preserves disconnected, suspended and disabled-model restrictions for the old route', () => {
    const provider = cursorProvider([auto]);
    for (const unavailable of [{ ...provider, connected: false }, { ...provider, suspended: true },
      cursorProvider([{ ...auto, disabled: true }])]) {
      expect(chatEligibleSourcesForModel([unavailable], 'cursor-default', 'cursor')).toEqual([]);
    }
  });
});
