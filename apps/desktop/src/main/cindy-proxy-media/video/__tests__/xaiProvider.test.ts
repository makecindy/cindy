/**
 * xAI video provider contract: SuperGrok OAuth stays in Main, Cindy's normalized
 * video params map to the async xAI API, and account switches fail closed across
 * submit/poll/download.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createXaiVideoProvider,
  XAI_VIDEO_CATALOG_MODEL_ID,
} from '../providers/xai.js';

const MP4_BYTES = Buffer.from('00000010667479706d70343200000000', 'hex');

interface HarnessOptions {
  fetchImplementation: typeof fetch;
  owner?: { value: string; pending: boolean };
  onAuthRejected?: ReturnType<typeof vi.fn>;
  maxVideoDownloadBytes?: number;
}

function makeProvider(options: HarnessOptions) {
  const owner = options.owner ?? { value: 'owner-a', pending: false };
  return createXaiVideoProvider({
    hasOAuthLogin: () => true,
    getAccessToken: async () => 'oauth-token',
    getOwnerScopeKey: () => owner.value,
    isOwnerBoundaryPending: () => owner.pending,
    fetchImplementation: options.fetchImplementation,
    onAuthRejected: options.onAuthRejected,
    maxVideoDownloadBytes: options.maxVideoDownloadBytes,
  });
}

describe('xAI video provider · capabilities', () => {
  const provider = makeProvider({ fetchImplementation: vi.fn() as unknown as typeof fetch });

  it('exposes the catalog alias and the API-supported common value ranges', () => {
    expect(provider.capabilities.modelAliases.map((item) => item.alias)).toEqual([
      XAI_VIDEO_CATALOG_MODEL_ID,
    ]);
    expect(provider.capabilities.supportedDurations).toEqual(
      Array.from({ length: 15 }, (_, index) => index + 1),
    );
    expect(provider.capabilities.supportedResolutions).toEqual(['480p', '720p', '1080p']);
    expect(provider.capabilities.supportedRatios).toEqual([
      '16:9',
      '9:16',
      '1:1',
      '4:3',
      '3:4',
    ]);
    expect(provider.capabilities.maxImagesByRefMode).toEqual({ first_and_last_frame: 1 });
    expect(provider.capabilities.supportsAudio).toBe(false);
    expect(provider.capabilities.audioDefault).toBe(true);
  });

  it('accepts future catalog aliases without a model-name whitelist', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ request_id: 'future-task' }), { status: 200 }),
    ) as unknown as typeof fetch;
    const future = 'xai/future-video-model';
    const dynamicProvider = createXaiVideoProvider({
      modelAliases: [future],
      hasOAuthLogin: () => true,
      getAccessToken: async () => 'oauth-token',
      getOwnerScopeKey: () => 'owner-a',
      isOwnerBoundaryPending: () => false,
      fetchImplementation: fetchMock,
    });

    await expect(dynamicProvider.submit({ prompt: 'future' }, future)).resolves.toMatchObject({
      modelUsed: 'future-video-model',
    });
    const init = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string).model).toBe('future-video-model');
  });
});

describe('xAI video provider · submit', () => {
  it('maps text-to-video params without inventing unsupported fps/audio fields', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ request_id: 'video-1' }), { status: 200 }),
    ) as unknown as typeof fetch;
    const provider = makeProvider({ fetchImplementation: fetchMock });

    const handle = await provider.submit(
      {
        prompt: 'A paper dragon takes flight',
        duration: 8,
        resolution: '1080p',
        ratio: '9:16',
        fps: 24,
      },
      XAI_VIDEO_CATALOG_MODEL_ID,
    );

    expect(handle).toMatchObject({
      providerId: 'xai-video',
      taskId: 'video-1',
      modelUsed: 'grok-imagine-video',
      ownerScopeKey: 'owner-a',
    });
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.x.ai/v1/videos/generations');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer oauth-token');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: 'grok-imagine-video',
      prompt: 'A paper dragon takes flight',
      duration: 8,
      aspect_ratio: '9:16',
      resolution: '1080p',
    });
    expect(body).not.toHaveProperty('fps');
    expect(body).not.toHaveProperty('audio');
  });

  it('maps one reference image to xAI image-to-video', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ request_id: 'video-2' }), { status: 200 }),
    ) as unknown as typeof fetch;
    const provider = makeProvider({ fetchImplementation: fetchMock });

    await provider.submit(
      {
        prompt: 'Make the portrait blink',
        duration: 4,
        resolution: '720p',
        ratio: '1:1',
        ratioWasExplicit: true,
        fps: 24,
        images: ['data:image/png;base64,AAAA'],
      },
      XAI_VIDEO_CATALOG_MODEL_ID,
    );

    const init = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string).image).toEqual({
      url: 'data:image/png;base64,AAAA',
    });
    expect(JSON.parse(init.body as string).aspect_ratio).toBe('1:1');
  });

  it('keeps the source image ratio when the caller did not select one', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ request_id: 'video-native-ratio' }), { status: 200 }),
    ) as unknown as typeof fetch;
    const provider = makeProvider({ fetchImplementation: fetchMock });

    await provider.submit(
      {
        prompt: 'Animate without cropping',
        duration: 6,
        resolution: '720p',
        ratio: '16:9',
        ratioWasExplicit: false,
        fps: 24,
        images: ['data:image/png;base64,AAAA'],
      },
      XAI_VIDEO_CATALOG_MODEL_ID,
    );

    const init = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.image).toEqual({ url: 'data:image/png;base64,AAAA' });
    expect(body).not.toHaveProperty('aspect_ratio');
  });

  it('forwards 401/403 to the shared xAI auth invalidator', async () => {
    const onAuthRejected = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'expired' } }), { status: 401 }),
    ) as unknown as typeof fetch;
    const provider = makeProvider({ fetchImplementation: fetchMock, onAuthRejected });

    await expect(
      provider.submit({ prompt: 'test' }, XAI_VIDEO_CATALOG_MODEL_ID),
    ).rejects.toThrow(/HTTP 401.*expired/);
    expect(onAuthRejected).toHaveBeenCalledWith({
      status: 401,
      body: JSON.stringify({ error: { message: 'expired' } }),
      failedAccessToken: 'oauth-token',
    });
  });
});

describe('xAI video provider · poll and download', () => {
  it('polls the task and downloads content with the originating owner OAuth', async () => {
    const responses = [
      new Response(JSON.stringify({ request_id: 'video-3' }), { status: 200 }),
      new Response(JSON.stringify({ status: 'pending' }), { status: 200 }),
      new Response(
        JSON.stringify({
          status: 'done',
          video: {
            url: 'https://vidgen.x.ai/tasks/video-3.mp4',
            duration: 7,
            resolution: '720p',
            aspect_ratio: '16:9',
            fps: 24,
          },
        }),
        { status: 200 },
      ),
      new Response(MP4_BYTES, {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
    const provider = makeProvider({ fetchImplementation: fetchMock });
    const handle = await provider.submit(
      { prompt: 'waves', duration: 7, resolution: '720p', ratio: '16:9', fps: 24 },
      XAI_VIDEO_CATALOG_MODEL_ID,
    );

    await expect(provider.poll(handle)).resolves.toMatchObject({ state: 'pending' });
    const done = await provider.poll(handle);
    expect(done).toMatchObject({
      state: 'succeeded',
      meta: { durationSec: 7, resolution: '720p', ratio: '16:9', fps: 24 },
    });
    if (done.state !== 'succeeded') throw new Error('expected succeeded');
    const downloaded = await provider.download(done.videoUrl);
    expect(downloaded).toEqual({ buffer: MP4_BYTES, mimeType: 'video/mp4' });

    const calls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[1][0]).toBe('https://api.x.ai/v1/videos/video-3');
    expect(calls[2][0]).toBe('https://api.x.ai/v1/videos/video-3');
    expect(calls[3][0]).toBe('https://vidgen.x.ai/tasks/video-3.mp4');
    expect(calls[3][1]).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(calls[3][1].headers).toBeUndefined();
  });

  it('fails closed when the active account changes after submit', async () => {
    const owner = { value: 'owner-a', pending: false };
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ request_id: 'video-owner' }), { status: 200 }),
    ) as unknown as typeof fetch;
    const provider = makeProvider({ fetchImplementation: fetchMock, owner });
    const handle = await provider.submit(
      { prompt: 'owner test' },
      XAI_VIDEO_CATALOG_MODEL_ID,
    );
    owner.value = 'owner-b';

    await expect(provider.poll(handle)).rejects.toThrow(/账号已切换/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('trusts verified video bytes instead of the Content-Type header', async () => {
    const owner = { value: 'owner-a', pending: false };
    const validWithoutHeader = makeProvider({
      owner,
      fetchImplementation: vi.fn(
        async () => new Response(MP4_BYTES, { status: 200 }),
      ) as unknown as typeof fetch,
    });
    const videoUrl =
      'xai-video://content/task?owner=owner-a&source=https%3A%2F%2Fvidgen.x.ai%2Ftask.mp4';

    await expect(validWithoutHeader.download(videoUrl)).resolves.toEqual({
      buffer: MP4_BYTES,
      mimeType: 'video/mp4',
    });

    for (const contentType of [undefined, 'video/mp4', 'text/html']) {
      const invalid = makeProvider({
        owner,
        fetchImplementation: vi.fn(
          async () =>
            new Response(Buffer.from('<html>cdn error</html>'), {
              status: 200,
              ...(contentType ? { headers: { 'content-type': contentType } } : {}),
            }),
        ) as unknown as typeof fetch,
      });
      await expect(invalid.download(videoUrl)).rejects.toThrow(/不是受支持的视频/);
    }
  });

  it('rechecks the owner after the download body is complete', async () => {
    const owner = { value: 'owner-a', pending: false };
    const responseBody = new Response(MP4_BYTES).body;
    const fetchMock = vi.fn(async () => {
      const response = {
        ok: true,
        status: 200,
        body: responseBody,
        headers: {
          get(name: string) {
            if (name.toLowerCase() === 'content-type') {
              owner.value = 'owner-b';
              return 'video/mp4';
            }
            return null;
          },
        },
      };
      return response as unknown as Response;
    }) as unknown as typeof fetch;
    const provider = makeProvider({ fetchImplementation: fetchMock, owner });
    const videoUrl =
      'xai-video://content/task?owner=owner-a&source=https%3A%2F%2Fvidgen.x.ai%2Ftask.mp4';

    await expect(provider.download(videoUrl)).rejects.toThrow(/账号已切换/);
  });

  it('rejects oversized video content before materializing it', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/generations')) {
        return new Response(JSON.stringify({ request_id: 'video-big' }), { status: 200 });
      }
      if (url.endsWith('/video-big')) {
        return new Response(
          JSON.stringify({ status: 'done', video: { url: 'https://vidgen.x.ai/video-big.mp4' } }),
          { status: 200 },
        );
      }
      return new Response(Buffer.from('12345'), {
        status: 200,
        headers: { 'content-length': '5', 'content-type': 'video/mp4' },
      });
    }) as unknown as typeof fetch;
    const provider = makeProvider({ fetchImplementation: fetchMock, maxVideoDownloadBytes: 4 });
    const handle = await provider.submit({ prompt: 'big' }, XAI_VIDEO_CATALOG_MODEL_ID);
    const status = await provider.poll(handle);
    if (status.state !== 'succeeded') throw new Error('expected succeeded');

    await expect(provider.download(status.videoUrl)).rejects.toThrow(/超过大小上限/);
  });
});
