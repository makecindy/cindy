import { describe, expect, it, vi } from 'vitest';

import {
  createXaiMediaDiscovery,
  mapXaiMediaModels,
  type XaiMediaDiscoverySnapshot,
} from '../model-discovery/xai-media.js';
import type { XaiBridgeAuthInvalidationResult } from '../xai-bridge-auth-invalidation.js';

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
  function harness(
    fetchImplementation: typeof fetch,
    onAuthRejectedImplementation?: () => Promise<XaiBridgeAuthInvalidationResult>,
  ) {
    const owner = { value: 'owner-a', pending: false, connected: true };
    const auth = { token: 'oauth-token', credentialGeneration: 0 };
    const applied: Array<XaiMediaDiscoverySnapshot | null> = [];
    const onAuthRejected = vi.fn(async (): Promise<XaiBridgeAuthInvalidationResult> =>
      onAuthRejectedImplementation ? await onAuthRejectedImplementation() : 'unchanged',
    );
    const discovery = createXaiMediaDiscovery({
      hasOAuthLogin: () => owner.connected,
      getAccessToken: async () => auth.token,
      getCredentialGeneration: () => auth.credentialGeneration,
      getOwnerScopeKey: () => owner.value,
      isOwnerBoundaryPending: () => owner.pending,
      fetchImplementation,
      applySnapshot: (snapshot) => applied.push(snapshot),
      onAuthRejected,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    return { discovery, owner, auth, applied, onAuthRejected };
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

  it('retries both image and video list GETs once with a refreshed token', async () => {
    const calls: Array<{ path: string; authorization: string | null }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const authorization = new Headers(init?.headers).get('authorization');
      calls.push({ path, authorization });
      if (authorization === 'Bearer oauth-token') {
        return new Response('expired', { status: 401 });
      }
      return new Response(
        path.endsWith('/image-generation-models')
          ? payload('recovered-image', ['text', 'image'], ['image'])
          : payload('recovered-video', ['text', 'image'], ['video']),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const h = harness(fetchMock, async () => {
      h.auth.token = 'refreshed-token';
      return 'refreshed';
    });

    await expect(h.discovery.refresh()).resolves.toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls).toEqual(
      expect.arrayContaining([
        { path: '/v1/image-generation-models', authorization: 'Bearer oauth-token' },
        { path: '/v1/video-generation-models', authorization: 'Bearer oauth-token' },
        { path: '/v1/image-generation-models', authorization: 'Bearer refreshed-token' },
        { path: '/v1/video-generation-models', authorization: 'Bearer refreshed-token' },
      ]),
    );
    expect(h.applied).toEqual([
      {
        imageModels: [{ id: 'xai/recovered-image', name: 'Recovered Image' }],
        videoModels: [{ id: 'xai/recovered-video', name: 'Recovered Video' }],
      },
    ]);
  });

  it('retries a safely superseded list GET with the replacement token', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization');
      if (
        String(url).endsWith('/image-generation-models') &&
        authorization === 'Bearer oauth-token'
      ) {
        return new Response('expired', { status: 403 });
      }
      return new Response(
        String(url).endsWith('/image-generation-models')
          ? payload('superseded-image', ['text', 'image'], ['image'])
          : payload('current-video', ['text', 'image'], ['video']),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const h = harness(fetchMock, async () => {
      h.auth.token = 'replacement-token';
      return 'superseded';
    });

    await expect(h.discovery.refresh()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(h.applied[0]?.imageModels?.[0]?.id).toBe('xai/superseded-image');
  });

  it('does not retry again when the recovered GET is still unauthorized', async () => {
    const fetchMock = vi.fn(
      async () => new Response('expired', { status: 401 }),
    ) as unknown as typeof fetch;
    const h = harness(fetchMock, async () => {
      h.auth.token = 'refreshed-token';
      return 'refreshed';
    });

    await expect(h.discovery.refresh()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(h.onAuthRejected).toHaveBeenCalledTimes(2);
    expect(h.applied).toEqual([]);
  });

  it('keeps the fallback and does not retry when auth recovery fails', async () => {
    const fetchMock = vi.fn(
      async () => new Response('expired', { status: 401 }),
    ) as unknown as typeof fetch;
    const h = harness(fetchMock, async () => {
      throw new Error('refresh unavailable');
    });

    await expect(h.discovery.refresh()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(h.onAuthRejected).toHaveBeenCalledTimes(2);
    expect(h.applied).toEqual([]);
  });

  it('does not retry or apply when auth recovery changes the credential generation', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/image-generation-models')
        ? new Response('expired', { status: 401 })
        : new Response(payload('late-video', ['text', 'image'], ['video']), { status: 200 }),
    ) as unknown as typeof fetch;
    const h = harness(fetchMock, async () => {
      h.owner.connected = false;
      h.auth.credentialGeneration += 1;
      return 'logged_out';
    });

    await expect(h.discovery.refresh()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(h.applied).toEqual([]);
  });

  it('does not retry or apply when auth recovery crosses the owner boundary', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/image-generation-models')
        ? new Response('expired', { status: 401 })
        : new Response(payload('late-video', ['text', 'image'], ['video']), { status: 200 }),
    ) as unknown as typeof fetch;
    const h = harness(fetchMock, async () => {
      h.owner.value = 'owner-b';
      h.auth.token = 'owner-b-token';
      return 'superseded';
    });

    await expect(h.discovery.refresh()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(h.applied).toEqual([]);
  });

  it('discards a retried response whose credential generation changes while streaming', async () => {
    let releaseBody!: () => void;
    let retryStarted!: () => void;
    const retryStartedPromise = new Promise<void>((resolve) => {
      retryStarted = resolve;
    });
    const releaseBodyPromise = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const isImage = String(url).endsWith('/image-generation-models');
      const authorization = new Headers(init?.headers).get('authorization');
      if (isImage && authorization === 'Bearer oauth-token') {
        return new Response('expired', { status: 401 });
      }
      if (isImage) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('{"models":['));
              retryStarted();
              void releaseBodyPromise.then(() => {
                controller.enqueue(
                  encoder.encode(
                    '{"id":"late-image","input_modalities":["text","image"],"output_modalities":["image"]}]}',
                  ),
                );
                controller.close();
              });
            },
          }),
          { status: 200 },
        );
      }
      return new Response(payload('current-video', ['text', 'image'], ['video']), { status: 200 });
    }) as unknown as typeof fetch;
    const h = harness(fetchMock, async () => {
      h.auth.token = 'refreshed-token';
      return 'refreshed';
    });

    const refresh = h.discovery.refresh();
    await retryStartedPromise;
    h.auth.credentialGeneration += 1;
    releaseBody();

    await expect(refresh).resolves.toBe(false);
    expect(h.applied).toEqual([]);
  });
});
