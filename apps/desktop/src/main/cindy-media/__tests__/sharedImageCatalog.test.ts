import { describe, expect, it, vi } from 'vitest';
import { configureSharedImageAccess, listSharedImageModels } from '../sharedImageCatalog.js';
import { BUILTIN_PROVIDERS } from '@cindy/model-providers';
import type { ProviderShareReceived } from '@cindy/device-link';

const mocks = vi.hoisted(() => ({
  catalog: vi.fn(),
  invoke: vi.fn(),
  share: { shareId: 's1', providerId: 'openai', status: 'active', hostOnline: true, owner: { displayName: 'Test' } },
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => 'owner', isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../remote-agent/controller/deviceCatalog.js', () => ({ readDeviceProviderCatalog: mocks.catalog }));

describe('shared OpenAI media catalog', () => {
  it('projects current text-to-image models under the share identity and ignores older hosts', async () => {
    const share = mocks.share as ProviderShareReceived;
    configureSharedImageAccess({ captureOwner: () => () => true, getReceivedShares: () => [share], findReceivedShare: () => share, invoke: mocks.invoke });
    expect(await listSharedImageModels('openai')).toEqual([]);
    expect(await listSharedImageModels('share:another')).toEqual([]);
    expect(mocks.catalog).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
    // #11678: the real built-in subscription has OAuth without a native adapter tag.
    const openai = BUILTIN_PROVIDERS.find(provider => provider.id === 'openai')!;
    mocks.catalog.mockResolvedValue({
      views: [{ ...openai, connected: true, imageModels: [
        { id: 'openai/gpt-image-2', name: 'GPT Image 2' },
        { id: 'openai/gpt-image-2.5-sunburst', name: 'Platform API model' },
        { id: 'openai/gpt-image-2', name: 'Disabled', disabled: true },
      ] }],
      stale: false,
    });
    const caps = { version: 1, maxRuns: 8, uploadChunkBytes: 512, maxPayloadBytes: 1024 };
    mocks.invoke.mockResolvedValueOnce({ ok: true, result: caps });
    expect(await listSharedImageModels()).toEqual([]);
    mocks.invoke.mockResolvedValueOnce({ ok: true, result: { ...caps, sharedImageGeneration: true } });
    expect(await listSharedImageModels()).toEqual([]); // 0.1.143 supports native accounts only.
    mocks.invoke.mockResolvedValueOnce({ ok: true, result: { ...caps, sharedImageGeneration: true, sharedBuiltinOpenAiImage: true } });
    expect(await listSharedImageModels()).toEqual([{
      id: 'openai/gpt-image-2', name: 'GPT Image 2 · Test', providerId: 'share:s1',
      mode: 'image_generation', imageProtocol: 'openai', modalities: { input: ['text'], output: ['image'] },
    }]);
    expect(mocks.catalog).toHaveBeenCalledWith(mocks.invoke, 'share:s1', { live: true });
  });

  it('excludes local-only image routes from independent subscription shares', async () => {
    const providerId = 'openai-sub-12345678';
    const share = { ...mocks.share, providerId } as ProviderShareReceived;
    configureSharedImageAccess({ captureOwner: () => () => true, getReceivedShares: () => [share], findReceivedShare: () => share, invoke: mocks.invoke });
    const openai = BUILTIN_PROVIDERS.find(provider => provider.id === 'openai')!;
    const id = `${providerId}/gpt-image-2`;
    mocks.catalog.mockResolvedValue({
      views: [{ ...openai, id: providerId, subscriptionPool: 'openai', connected: true,
        availableMediaModelIds: [id], imageModels: [{ id, name: 'GPT Image Gen' }] }],
      stale: false,
    });
    mocks.invoke.mockResolvedValueOnce({ ok: true, result: {
      version: 1, maxRuns: 8, uploadChunkBytes: 512, maxPayloadBytes: 1024,
      sharedImageGeneration: true, sharedBuiltinOpenAiImage: true,
    } });
    expect(await listSharedImageModels('share:s1')).toEqual([]);
  });
});
