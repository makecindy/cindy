import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildUserProvider } from '@cindy/model-providers';
import { getActiveCatalog } from '../../maker-host/active-catalog.js';
import { clearModelVisibilityMirror, setModelVisibilityMirror } from '../../maker-host/model-visibility-mirror.js';
import { isCatalogMediaModelVisible } from '../mediaDisplayVisibility.js';

vi.mock('../../maker-host/active-catalog.js', () => ({ getActiveCatalog: vi.fn() }));
afterEach(() => { clearModelVisibilityMirror(); vi.clearAllMocks(); });

// #10147, unit: production visibility gate + real preference mirror. The channel
// tests only checked credentials, missing opposing display switches on two runtimes.
// This module has no existing test file; it needs neither database nor image bytes.
describe('media display visibility', () => {
  function catalog(kind: 'image' | 'video' = 'image') {
    const provider = buildUserProvider({ id: 'relay', name: 'Relay', auth: { method: 'apiKey' }, runtimes: {
      'claude-code': { baseUrl: 'https://chat.example.test', models: [{ id: 'media', name: 'Chat copy' }] },
      pi: { baseUrl: 'https://media.example.test/v1', imageApi: 'openai-images', videoApi: 'openai-videos',
        models: [{ id: 'media', name: 'Media', mode: kind === 'image' ? 'image_generation' : 'video_generation' }] },
    } });
    vi.mocked(getActiveCatalog).mockReturnValue({ providers: [provider] } as ReturnType<typeof getActiveCatalog>);
    return provider;
  }
  it.each(['image', 'video'] as const)('uses the actual %s owner when its switch opposes the first runtime', kind => {
    const provider = catalog(kind);
    for (const visible of [true, false]) {
      setModelVisibilityMirror({ [`claude-code:${provider.id}:media`]: !visible, [`pi:${provider.id}:media`]: visible });
      expect(isCatalogMediaModelVisible(provider.id, 'media', undefined, kind)).toBe(visible);
    }
  });
  it('uses the catalog default only when the owner has no explicit override', () => {
    const provider = catalog();
    setModelVisibilityMirror({ [`claude-code:${provider.id}:media`]: false });
    expect(isCatalogMediaModelVisible(provider.id, 'media', true, 'image')).toBe(true);
    expect(isCatalogMediaModelVisible(provider.id, 'media', false, 'image')).toBe(false);
  });
  it('keeps same-ID image and video display switches on their own runtimes', () => {
    // One explicit route per media kind is legal even when upstream IDs coincide.
    const provider = buildUserProvider({ id: 'relay', name: 'Relay', auth: { method: 'apiKey' }, runtimes: {
      'claude-code': { baseUrl: 'https://video.example.test/v1', videoApi: 'xai-videos',
        models: [{ id: 'media', name: 'Video', mode: 'video_generation' }] },
      pi: { baseUrl: 'https://image.example.test/v1', imageApi: 'openai-images',
        models: [{ id: 'media', name: 'Image', mode: 'image_generation' }] },
    } });
    vi.mocked(getActiveCatalog).mockReturnValue({ providers: [provider] } as ReturnType<typeof getActiveCatalog>);
    for (const imageVisible of [true, false]) {
      setModelVisibilityMirror({ [`claude-code:${provider.id}:media`]: !imageVisible, [`pi:${provider.id}:media`]: imageVisible });
      expect(isCatalogMediaModelVisible(provider.id, 'media', true, 'image')).toBe(imageVisible);
      expect(isCatalogMediaModelVisible(provider.id, 'media', true, 'video')).toBe(!imageVisible);
    }
  });
  it('retains the legacy display route for media without a source runtime', () => {
    const provider = catalog();
    delete provider.imageModels![0]!.sourceAgent;
    setModelVisibilityMirror({ [`claude-code:${provider.id}:media`]: false, [`pi:${provider.id}:media`]: true });
    expect(isCatalogMediaModelVisible(provider.id, 'media', true, 'image')).toBe(false);
  });
  it('fails closed before preferences are ready and after an account boundary', () => {
    const provider = catalog();
    expect(isCatalogMediaModelVisible(provider.id, 'media', true, 'image')).toBe(false);
    setModelVisibilityMirror({ [`pi:${provider.id}:media`]: true });
    expect(isCatalogMediaModelVisible(provider.id, 'media', true, 'image')).toBe(true);
    clearModelVisibilityMirror();
    expect(isCatalogMediaModelVisible(provider.id, 'media', true, 'image')).toBe(false);
  });
});
