import { describe, expect, it, vi } from 'vitest';

import {
  createXaiMediaDiscovery,
  mapXaiMediaModels,
  type XaiMediaDiscoverySnapshot,
} from '../model-discovery/xai-media.js';

function payload(id: string, input: string[], output: string[]): string {
  return JSON.stringify({
    models: [
      {
        id,
        aliases: [],
        input_modalities: input,
        output_modalities: output,
      },
    ],
  });
}

describe('mapXaiMediaModels', () => {
  it('classifies by modalities instead of model-name patterns', () => {
    expect(
      mapXaiMediaModels(
        JSON.parse(payload('anything-the-api-adds-next', ['text', 'image'], ['video'])),
        'video',
        ['text', 'image'],
      ),
    ).toEqual([{ id: 'xai/anything-the-api-adds-next', name: 'Anything The Api Adds Next' }]);
  });

  it('hides models whose modalities cannot satisfy the current common adapter', () => {
    expect(
      mapXaiMediaModels(JSON.parse(payload('image-only-video', ['image'], ['video'])), 'video', [
        'text',
        'image',
      ]),
    ).toEqual([]);
  });
});

describe('xAI media discovery lifecycle', () => {
  function harness(fetchImplementation: typeof fetch) {
    const owner = { value: 'owner-a', pending: false, connected: true };
    const applied: Array<XaiMediaDiscoverySnapshot | null> = [];
    const onAuthRejected = vi.fn(async () => undefined);
    const discovery = createXaiMediaDiscovery({
      hasOAuthLogin: () => owner.connected,
      getAccessToken: async () => 'oauth-token',
      getOwnerScopeKey: () => owner.value,
      isOwnerBoundaryPending: () => owner.pending,
      fetchImplementation,
      applySnapshot: (snapshot) => applied.push(snapshot),
      onAuthRejected,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    return { discovery, owner, applied, onAuthRejected };
  }

  it('atomically applies image and video snapshots from the typed endpoints', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      return new Response(
        href.endsWith('/image-generation-models')
          ? payload('future-image', ['text', 'image'], ['image'])
          : payload('future-video', ['text', 'image'], ['video']),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const h = harness(fetchMock);

    await expect(h.discovery.refresh()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(h.applied).toEqual([
      {
        imageModels: [{ id: 'xai/future-image', name: 'Future Image' }],
        videoModels: [{ id: 'xai/future-video', name: 'Future Video' }],
      },
    ]);
  });

  it('updates the successful kind while preserving the failed kind in active catalog', async () => {
    let failVideo = false;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/video-generation-models') && failVideo) {
        return new Response('{"error":"temporary"}', { status: 503 });
      }
      return new Response(
        href.endsWith('/image-generation-models')
          ? payload('future-image', ['text', 'image'], ['image'])
          : payload('future-video', ['text', 'image'], ['video']),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const h = harness(fetchMock);
    await expect(h.discovery.refresh()).resolves.toBe(true);
    failVideo = true;
    await expect(h.discovery.refresh()).resolves.toBe(true);
    expect(h.applied).toHaveLength(2);
    expect(h.applied[1]).toEqual({
      imageModels: [{ id: 'xai/future-image', name: 'Future Image' }],
    });
  });

  it('does not let image discovery failure block a new video model', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/image-generation-models')) {
        return new Response('{"error":"image unavailable"}', { status: 503 });
      }
      return new Response(payload('future-video', ['text', 'image'], ['video']), { status: 200 });
    }) as unknown as typeof fetch;
    const h = harness(fetchMock);

    await expect(h.discovery.refresh()).resolves.toBe(true);
    expect(h.applied).toEqual([
      { videoModels: [{ id: 'xai/future-video', name: 'Future Video' }] },
    ]);
  });

  it('treats a valid empty list as an authoritative successful snapshot', async () => {
    const fetchMock = vi.fn(
      async () => new Response('{"models":[]}', { status: 200 }),
    ) as unknown as typeof fetch;
    const h = harness(fetchMock);

    await expect(h.discovery.refresh()).resolves.toBe(true);
    expect(h.applied).toEqual([{ imageModels: [], videoModels: [] }]);
  });

  it('does not replace the fallback when both endpoint payloads are malformed', async () => {
    const fetchMock = vi.fn(
      async () => new Response('{"data":[]}', { status: 200 }),
    ) as unknown as typeof fetch;
    const h = harness(fetchMock);

    await expect(h.discovery.refresh()).resolves.toBe(false);
    expect(h.applied).toEqual([]);
  });

  it('rejects oversized model-list responses before reading the body', async () => {
    const cancel = vi.fn(async () => undefined);
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-length': String(512 * 1024 + 1) }),
          body: { cancel },
        }) as unknown as Response,
    ) as unknown as typeof fetch;
    const h = harness(fetchMock);

    await expect(h.discovery.refresh()).resolves.toBe(false);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(h.applied).toEqual([]);
  });

  it('clears on auth boundary and discards the old account late result', async () => {
    let resolveImage!: (response: Response) => void;
    let resolveVideo!: (response: Response) => void;
    const image = new Promise<Response>((resolve) => {
      resolveImage = resolve;
    });
    const video = new Promise<Response>((resolve) => {
      resolveVideo = resolve;
    });
    const fetchMock = vi.fn((url: string | URL | Request) =>
      String(url).endsWith('/image-generation-models') ? image : video,
    ) as unknown as typeof fetch;
    const h = harness(fetchMock);

    const refresh = h.discovery.refresh();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    h.owner.value = 'owner-b';
    h.discovery.clear();
    resolveImage(new Response(payload('old-image', ['text', 'image'], ['image']), { status: 200 }));
    resolveVideo(new Response(payload('old-video', ['text', 'image'], ['video']), { status: 200 }));

    await expect(refresh).resolves.toBe(false);
    expect(h.applied).toEqual([null]);
  });

  it('forwards 401 to the shared xAI invalidator without clearing the fallback itself', async () => {
    const fetchMock = vi.fn(
      async () => new Response('expired', { status: 401 }),
    ) as unknown as typeof fetch;
    const h = harness(fetchMock);

    await expect(h.discovery.refresh()).resolves.toBe(false);
    expect(h.onAuthRejected).toHaveBeenCalledWith({
      status: 401,
      body: 'expired',
      failedAccessToken: 'oauth-token',
    });
    expect(h.applied).toEqual([]);
  });
});
