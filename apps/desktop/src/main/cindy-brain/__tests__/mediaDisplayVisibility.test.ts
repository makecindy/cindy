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
      expect(isCatalogMediaModelVisible(provider.id, 'media')).toBe(visible);
    }
  });
  it('uses the catalog default only when the owner has no explicit override', () => {
    const provider = catalog();
    setModelVisibilityMirror({ [`claude-code:${provider.id}:media`]: false });
    expect(isCatalogMediaModelVisible(provider.id, 'media', true)).toBe(true);
    expect(isCatalogMediaModelVisible(provider.id, 'media', false)).toBe(false);
  });
  it('retains the legacy display route for media without a source runtime', () => {
    const provider = catalog();
    delete provider.imageModels![0]!.sourceAgent;
    setModelVisibilityMirror({ [`claude-code:${provider.id}:media`]: false, [`pi:${provider.id}:media`]: true });
    expect(isCatalogMediaModelVisible(provider.id, 'media', true)).toBe(false);
  });
  it('fails closed before preferences are ready and after an account boundary', () => {
    const provider = catalog();
    expect(isCatalogMediaModelVisible(provider.id, 'media', true)).toBe(false);
    setModelVisibilityMirror({ [`pi:${provider.id}:media`]: true });
    expect(isCatalogMediaModelVisible(provider.id, 'media', true)).toBe(true);
    clearModelVisibilityMirror();
    expect(isCatalogMediaModelVisible(provider.id, 'media', true)).toBe(false);
  });
});
