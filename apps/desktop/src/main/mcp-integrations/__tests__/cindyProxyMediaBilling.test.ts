import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CindyProxyMediaServiceOptions } from '../../cindy-proxy-media/types.js';

const mocks = vi.hoisted(() => ({
  createService: vi.fn(),
  prepareBilling: vi.fn(),
  recordBilling: vi.fn(),
  finishBilling: vi.fn(),
  fetch: vi.fn(),
  serviceOptions: null as CindyProxyMediaServiceOptions | null,
}));
vi.mock('../../model-access/effectiveEndpoint.js', () => ({
  effectiveXdGatewayBaseUrl: () => 'https://gateway.example.invalid',
}));
vi.mock('../../cindy-proxy-media/service.js', () => ({
  createCindyProxyMediaService: mocks.createService,
}));
vi.mock('../../cindy-media/generatedMedia.js', () => ({
  createBlobImageStorage: () => ({}),
  createBlobVideoStorage: () => ({}),
}));
vi.mock('../../imageCacheStore.js', () => ({ resolveSafe: vi.fn() }));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  getProviderSecretStore: () => ({ get: () => 'test-key' }),
}));
vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: () => ({ canUseCindyGateway: true }),
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../../usage/gatewayMediaBilling.js', () => ({
  prepareGatewayMediaBilling: mocks.prepareBilling,
}));

import { getCindyProxyMediaService, getCindyVideoProviderRegistry, withCindyMediaBillingSession } from '../cindyProxyMedia.js';

describe('legacy Gateway media billing wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createService.mockImplementation((options: CindyProxyMediaServiceOptions) => {
      mocks.serviceOptions = options;
      return { backend: {} };
    });
    mocks.prepareBilling.mockResolvedValue(Object.assign(mocks.recordBilling, { finish: mocks.finishBilling }));
    mocks.recordBilling.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', mocks.fetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('wraps JSON and multipart image creation without consuming the response body', async () => {
    getCindyProxyMediaService();
    const opts = mocks.createService.mock.calls[0][0] as CindyProxyMediaServiceOptions;
    const doFetch = opts.imageApi.fetchImplementation!;
    for (const body of [JSON.stringify({ model: 'image-json' }), new FormData()]) {
      if (body instanceof FormData) body.set('model', 'image-multipart');
      const res = Response.json({ data: [] });
      mocks.fetch.mockResolvedValueOnce(res);
      expect(
        await doFetch('https://gateway.example.invalid/v1/images/generations', {
          method: 'POST',
          body,
        }),
      ).toBe(res);
      expect(res.bodyUsed).toBe(false);
    }
    expect(mocks.prepareBilling.mock.calls.map(([input]) => input.model)).toEqual([
      'image-json',
      'image-multipart',
    ]);
    expect(mocks.recordBilling).toHaveBeenCalledTimes(2);
  });

  it('records video create but skips polls and downloads even if they contain billing headers', async () => {
    const { provider } = getCindyVideoProviderRegistry().resolveByAlias('seedance-fast');
    mocks.fetch.mockResolvedValueOnce(Response.json({ id: 'paid-task' }));
    const handle = await withCindyMediaBillingSession('video-task', () => provider.submit({ prompt: 'cat' }, 'seedance-fast'));
    expect(mocks.prepareBilling).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'video-task' }));
    expect(mocks.recordBilling).toHaveBeenCalledOnce();
    const headers = { 'X-Nova-AIGateway-Billing': Buffer.from('{"cost":1}').toString('base64url') };
    mocks.fetch.mockResolvedValueOnce(Response.json({ status: 'running' }, { headers }));
    await provider.poll(handle);
    mocks.fetch.mockResolvedValueOnce(new Response('video-bytes', { headers }));
    await provider.download('https://cdn.example.invalid/video.mp4');
    expect(mocks.prepareBilling).toHaveBeenCalledOnce();
    expect(mocks.recordBilling).toHaveBeenCalledOnce();
  });

  it('isolates concurrent Host task contexts and leaves background requests unassociated', async () => {
    getCindyProxyMediaService();
    // The service is a singleton; reuse its installed fetch adapter.
    const doFetch = mocks.serviceOptions!.imageApi.fetchImplementation!;
    mocks.fetch.mockImplementation(async () => Response.json({ data: [] }));
    const create = () => doFetch('https://gateway.example.invalid/v1/images/generations', {
      method: 'POST', body: JSON.stringify({ model: 'image' }),
    });
    const releases: Array<() => void> = [];
    mocks.recordBilling.mockImplementation(() => new Promise<void>(resolve => { releases.push(resolve); }));
    // Vitest shares mock import callstacks. Settle each import before the next starts,
    // while keeping all three accounting operations in flight together.
    const first = withCindyMediaBillingSession('task-a', async () => { await Promise.resolve(); return create(); });
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const second = withCindyMediaBillingSession('task-b', create);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    const background = create();
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    releases.forEach(release => release());
    await Promise.all([first, second, background]);
    expect(mocks.prepareBilling.mock.calls.map(([input]) => input.sessionId).sort()).toEqual([
      'task-a', 'task-b', undefined,
    ]);
  });

  it('releases its accounting database when fetch fails', async () => {
    const { provider } = getCindyVideoProviderRegistry().resolveByAlias('seedance-fast');
    mocks.fetch.mockRejectedValueOnce(new Error('connection reset'));
    await expect(provider.submit({ prompt: 'cat' }, 'seedance-fast')).rejects.toThrow('connection reset');
    expect(mocks.recordBilling).not.toHaveBeenCalled();
    expect(mocks.finishBilling).toHaveBeenCalledOnce();
  });
});
