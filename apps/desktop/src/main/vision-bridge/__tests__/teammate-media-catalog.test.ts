import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listTeammateMediaModels, validateTeammateMediaModels } from '../teammate-media-catalog.js';

const state = vi.hoisted(() => ({ owner: 'owner', boundary: false, visible: true,
  providers: vi.fn(), media: vi.fn(), route: vi.fn(), caps: vi.fn() }));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({ getDesktopProviderService: () => ({ listProviders: state.providers }) }));
vi.mock('../../maker-host/model-visibility-mirror.js', () => ({ getModelVisibilityOverride: () => state.visible }));
vi.mock('../../maker-host/provider-route.js', () => ({ resolveVisionBackendRoute: state.route }));
vi.mock('../../model-access/effectiveEndpoint.js', () => ({ effectiveXdGatewayBaseUrl: () => 'https://example.invalid' }));
vi.mock('../../model-access/mediaModels.js', () => ({ listAvailableMediaModels: state.media }));
vi.mock('../../appCapabilities.js', () => ({ getAppCapabilities: state.caps }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => state.owner, isAppSessionBoundaryPending: () => state.boundary }));

// Feature admission contract: catalog discovery/validation must retain account identity and
// reject wrong media types/unavailable providers. No prior per-teammate catalog exists.
// Unit tier; the production public entries consume synthetic provider-service responses only.
beforeEach(() => {
  state.owner = 'owner'; state.boundary = false; state.visible = true;
  state.caps.mockReset().mockReturnValue({ canUseCindyGateway: false });
  state.providers.mockReset().mockResolvedValue([
    { id: 'vision-a', name: 'Vision A', connected: true, models: { pi: [{ id: 'vision', name: 'Read', supportsImageInput: true }, { id: 'text', supportsImageInput: false }, { id: 'imagegen', mode: 'image_generation', supportsImageInput: true }] } },
    { id: 'vision-b', name: 'Disconnected', connected: false, models: { pi: [{ id: 'vision', supportsImageInput: true }] } },
  ]);
  state.route.mockReset().mockReturnValue({});
  state.media.mockReset().mockResolvedValue([
    { id: 'same-id', name: 'Image', providerId: 'images-a', mode: 'image_generation' },
    { id: 'same-id', name: 'Image', providerId: 'images-b', mode: 'image_generation' },
    { id: 'movie', name: 'Video', providerId: 'movies', mode: 'video_generation' },
  ]);
});

describe('teammate media catalog and admission', () => {
  it('reuses connected visible executable vision routes and retains both same-ID generation accounts', async () => {
    const catalog = await listTeammateMediaModels();
    expect(catalog.vision.map(({ providerId, modelId }) => ({ providerId, modelId }))).toEqual([{ providerId: 'vision-a', modelId: 'vision' }]);
    expect(catalog.image.map(model => model.providerId)).toEqual(['images-a', 'images-b']);
    state.visible = false;
    expect((await listTeammateMediaModels()).vision).toEqual([]);
    state.visible = true; state.route.mockReturnValue(null);
    expect((await listTeammateMediaModels()).vision).toEqual([]);
  });
  it('accepts complete selections and reset, rejecting wrong capabilities or invented same-ID accounts', async () => {
    const value = { vision: { primary: { providerId: 'vision-a', modelId: 'vision' }, fallback: null }, image: { providerId: 'images-b', modelId: 'same-id' } };
    expect(await validateTeammateMediaModels(value)).toEqual(value);
    expect(await validateTeammateMediaModels(null)).toBeNull();
    await expect(validateTeammateMediaModels({ video: value.image })).rejects.toThrow();
    await expect(validateTeammateMediaModels({ image: { ...value.image, providerId: 'different' } })).rejects.toThrow();
  });
  it('preserves unchanged unavailable categories when changing another choice', async () => {
    const previous = { image: { providerId: 'removed-account', modelId: 'old-image' } };
    const next = { ...previous, video: { providerId: 'movies', modelId: 'movie' } };
    expect(await validateTeammateMediaModels(next, previous)).toEqual(next);
  });
  it('keeps vision settings usable during media catalog failure and labels the unavailable categories', async () => {
    state.media.mockRejectedValue(new Error('catalog offline'));
    const result = await listTeammateMediaModels();
    expect(result.vision).toHaveLength(1);
    expect(result.unavailable).toEqual(['image', 'video']);
    await expect(validateTeammateMediaModels({ image: { providerId: 'images-a', modelId: 'same-id' } })).rejects.toThrow();
  });
  it('rejects a catalog result when the account changes while it loads', async () => {
    state.media.mockImplementation(async () => { state.owner = 'other'; return []; });
    await expect(listTeammateMediaModels()).rejects.toThrow('Account changed');
  });
});

// Ordinary provider/account discovery failures are independent of the current-owner fence.
it('degrades provider discovery while keeping generation choices and reset available', async () => {
  state.providers.mockRejectedValue(new Error('provider account lookup offline'));
  const result = await listTeammateMediaModels();
  expect(result.vision).toEqual([]);
  expect(result.image).toHaveLength(2);
  expect(result.unavailable).toEqual(['vision']);
  const previous = { vision: { primary: { providerId: 'stale', modelId: 'read' }, fallback: null }, image: { providerId: 'images-a', modelId: 'same-id' } };
  expect(await validateTeammateMediaModels({ image: previous.image }, previous)).toEqual({ image: previous.image });
  state.caps.mockImplementation(() => { throw new Error('account capability lookup offline'); });
  expect((await listTeammateMediaModels()).unavailable).toEqual(['vision', 'image', 'video']);
  state.providers.mockImplementation(async () => { state.owner = 'other'; throw new Error('offline'); });
  await expect(listTeammateMediaModels()).rejects.toThrow('Account changed');
});
