import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildUserProvider } from '@cindy/model-providers';
import { getActiveCatalog } from '../../maker-host/active-catalog.js';
import { clearModelVisibilityMirror, setModelVisibilityMirror } from '../../maker-host/model-visibility-mirror.js';
import { isCatalogMediaModelVisible } from '../mediaDisplayVisibility.js';

vi.mock('../../maker-host/active-catalog.js', () => ({ getActiveCatalog: vi.fn() }));
afterEach(() => { clearModelVisibilityMirror(); vi.clearAllMocks(); });

// #10147, unit: production visibility gate + real preference mirror. The channel
// tests only checked credentials; earlier visibility tests missed same-ID image/video
// routes with opposing switches and did not exercise the real owner preference mirror.
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
      expect(isCatalogMediaModelVisible(provider.id, 'media', undefined, undefined, kind)).toBe(visible);
    }
  });
  it('uses the catalog default only when the owner has no explicit override', () => {
    const provider = catalog();
    delete provider.models.pi![0]!.defaultEnabled;
    setModelVisibilityMirror({ [`claude-code:${provider.id}:media`]: false });
    expect(isCatalogMediaModelVisible(provider.id, 'media', true, undefined, 'image')).toBe(true);
    expect(isCatalogMediaModelVisible(provider.id, 'media', false, undefined, 'image')).toBe(false);
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
      expect(isCatalogMediaModelVisible(provider.id, 'media', true, undefined, 'image')).toBe(imageVisible);
      expect(isCatalogMediaModelVisible(provider.id, 'media', true, undefined, 'video')).toBe(!imageVisible);
    }
  });
  it('retains the legacy display route for media without a source runtime', () => {
    const provider = catalog();
    delete provider.imageModels![0]!.sourceAgent;
    delete provider.imageModels![0]!.sourceAgents;
    setModelVisibilityMirror({ [`claude-code:${provider.id}:media`]: false, [`pi:${provider.id}:media`]: true });
    expect(isCatalogMediaModelVisible(provider.id, 'media', true, undefined, 'image')).toBe(false);
  });
  it('fails closed before preferences are ready and after an account boundary', () => {
    const provider = catalog();
    expect(isCatalogMediaModelVisible(provider.id, 'media', true, undefined, 'image')).toBe(false);
    setModelVisibilityMirror({ [`pi:${provider.id}:media`]: true });
    expect(isCatalogMediaModelVisible(provider.id, 'media', true, undefined, 'image')).toBe(true);
    clearModelVisibilityMirror();
    expect(isCatalogMediaModelVisible(provider.id, 'media', true, undefined, 'image')).toBe(false);
  });
  it('checks an explicitly selected connection independently', () => {
    const provider = catalog();
    setModelVisibilityMirror({ [`pi:${provider.id}:media`]: false });
    expect(isCatalogMediaModelVisible(provider.id, 'media', true, 'claude-code', 'image')).toBe(true);
    expect(isCatalogMediaModelVisible(provider.id, 'media', true, 'pi', 'image')).toBe(false);
  });
  it('keeps another declared media route visible when the preferred runtime is hidden', () => {
    const provider = catalog();
    provider.imageModels![0]!.sourceAgents = ['pi', 'claude-code'];
    provider.models.pi![0]!.defaultEnabled = false;
    provider.models['claude-code']![0]!.mode = 'image_generation';
    provider.models['claude-code']![0]!.defaultEnabled = true;
    setModelVisibilityMirror({ [`pi:${provider.id}:media`]: false });
    expect(isCatalogMediaModelVisible(provider.id, 'media', undefined, undefined, 'image')).toBe(true);
    expect(isCatalogMediaModelVisible(provider.id, 'media', undefined, 'pi', 'image')).toBe(false);
  });
});
