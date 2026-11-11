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
  credential?: { value: number };
  getAccessToken?: () => Promise<string>;
  onAuthRejected?: ReturnType<typeof vi.fn>;
  maxVideoDownloadBytes?: number;
}

function makeProvider(options: HarnessOptions) {
  const owner = options.owner ?? { value: 'owner-a', pending: false };
  const credential = options.credential ?? { value: 1 };
  return createXaiVideoProvider({
    hasOAuthLogin: () => true,
    getAccessToken: options.getAccessToken ?? (async () => 'oauth-token'),
    getCredentialGeneration: () => credential.value,
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
      getCredentialGeneration: () => 1,
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
      credentialGeneration: 1,
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
    const onAuthRejected = vi.fn(async () => 'refreshed');
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('discards a late submit response after the SuperGrok credential changes', async () => {
    const credential = { value: 1 };
    const fetchMock = vi.fn(async () => {
      credential.value = 2;
      return new Response(JSON.stringify({ request_id: 'late-submit' }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = makeProvider({ fetchImplementation: fetchMock, credential });

    await expect(
      provider.submit({ prompt: 'late submit' }, XAI_VIDEO_CATALOG_MODEL_ID),
    ).rejects.toThrow(/SuperGrok 凭证已切换/);
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

  it('follows one trusted download redirect and validates the final video bytes', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url) === 'https://vidgen.x.ai/tasks/redirect.mp4'
        ? new Response(null, { status: 302, headers: { Location: '/cdn/final.mp4' } })
        : new Response(MP4_BYTES, { status: 200, headers: { 'content-type': 'text/plain' } }),
    ) as unknown as typeof fetch;
    const provider = makeProvider({ fetchImplementation: fetchMock });
    const videoUrl =
      'xai-video://content/task?owner=owner-a&credential=1&source=https%3A%2F%2Fvidgen.x.ai%2Ftasks%2Fredirect.mp4';

    await expect(provider.download(videoUrl)).resolves.toEqual({
      buffer: MP4_BYTES,
      mimeType: 'video/mp4',
    });
    expect((fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ['https://vidgen.x.ai/tasks/redirect.mp4', { method: 'GET', redirect: 'manual' }],
      ['https://vidgen.x.ai/cdn/final.mp4', { method: 'GET', redirect: 'manual' }],
    ]);
  });

  it('rejects unsafe video redirects and keeps owner and credential generation current', async () => {
    const videoUrl =
      'xai-video://content/task?owner=owner-a&credential=1&source=https%3A%2F%2Fvidgen.x.ai%2Ftasks%2Fredirect.mp4';
    for (const location of [undefined, 'https://example.com/final.mp4']) {
      const fetchMock = vi.fn(async () =>
        new Response(null, {
          status: 302,
          ...(location ? { headers: { Location: location } } : {}),
        }),
      ) as unknown as typeof fetch;
      await expect(
        makeProvider({ fetchImplementation: fetchMock }).download(videoUrl),
      ).rejects.toThrow(location ? /不可信/ : /缺少 Location/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }

    const repeated = vi.fn(async () =>
      new Response(null, { status: 307, headers: { Location: 'https://cdn.x.ai/again.mp4' } }),
    ) as unknown as typeof fetch;
    await expect(
      makeProvider({ fetchImplementation: repeated }).download(videoUrl),
    ).rejects.toThrow(/下载失败\(HTTP 307\)/);
    expect(repeated).toHaveBeenCalledTimes(2);

    const owner = { value: 'owner-a', pending: false };
    const ownerSwitch = vi.fn(async () => {
      owner.value = 'owner-b';
      return new Response(null, { status: 302, headers: { Location: 'https://cdn.x.ai/final.mp4' } });
    }) as unknown as typeof fetch;
    await expect(
      makeProvider({ fetchImplementation: ownerSwitch, owner }).download(videoUrl),
    ).rejects.toThrow(/账号已切换/);

    owner.value = 'owner-a';
    const credential = { value: 1 };
    const credentialSwitch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('vidgen.x.ai')) {
        return new Response(null, { status: 302, headers: { Location: 'https://cdn.x.ai/final.mp4' } });
      }
      credential.value = 2;
      return new Response(MP4_BYTES, { status: 200 });
    }) as unknown as typeof fetch;
    await expect(
      makeProvider({ fetchImplementation: credentialSwitch, credential }).download(videoUrl),
    ).rejects.toThrow(/SuperGrok 凭证已切换/);
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

  it.each(['refreshed', 'superseded'] as const)(
    'retries one poll when auth recovery is %s without resubmitting the paid task',
    async (recovery) => {
      const tokens = ['account-a-old-token', 'account-a-old-token', 'account-a-fresh-token'];
      const getAccessToken = vi.fn(async () => tokens.shift()!);
      const badCredentialBody = JSON.stringify({
        code: 'unauthenticated:bad-credentials',
        error: 'The OAuth2 access token could not be validated.',
      });
      const responses = [
        new Response(JSON.stringify({ request_id: 'video-auth-recovery' }), { status: 200 }),
        new Response(badCredentialBody, { status: 403 }),
        new Response(JSON.stringify({ status: 'pending' }), { status: 200 }),
      ];
      const fetchMock = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
      const onAuthRejected = vi.fn(async () => recovery);
      const provider = makeProvider({
        fetchImplementation: fetchMock,
        getAccessToken,
        onAuthRejected,
      });
      const handle = await provider.submit({ prompt: 'recover poll' }, XAI_VIDEO_CATALOG_MODEL_ID);

      await expect(provider.poll(handle)).resolves.toMatchObject({ state: 'pending' });
      expect(onAuthRejected).toHaveBeenCalledTimes(1);
      expect(onAuthRejected).toHaveBeenCalledWith({
        status: 403,
        body: badCredentialBody,
        failedAccessToken: 'account-a-old-token',
      });
      const calls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(3);
      expect(calls.filter(([, init]) => (init as RequestInit).method === 'POST')).toHaveLength(1);
      expect(calls[1][0]).toBe('https://api.x.ai/v1/videos/video-auth-recovery');
      expect(calls[2][0]).toBe('https://api.x.ai/v1/videos/video-auth-recovery');
      expect((calls[1][1].headers as Record<string, string>).Authorization).toBe(
        'Bearer account-a-old-token',
      );
      expect((calls[2][1].headers as Record<string, string>).Authorization).toBe(
        'Bearer account-a-fresh-token',
      );
    },
  );

  it('does not retry a poll when credential recovery fails', async () => {
    const badCredentialBody = JSON.stringify({
      code: 'unauthenticated:bad-credentials',
      error: 'The OAuth2 access token could not be validated.',
    });
    const responses = [
      new Response(JSON.stringify({ request_id: 'video-auth-failed' }), { status: 200 }),
      new Response(badCredentialBody, { status: 401 }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
    const onAuthRejected = vi.fn(async () => 'unchanged');
    const provider = makeProvider({ fetchImplementation: fetchMock, onAuthRejected });
    const handle = await provider.submit({ prompt: 'failed recovery' }, XAI_VIDEO_CATALOG_MODEL_ID);

    await expect(provider.poll(handle)).rejects.toThrow(/HTTP 401/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onAuthRejected).toHaveBeenCalledTimes(1);
  });

  it('limits a recovered poll to one retry', async () => {
    const responses = [
      new Response(JSON.stringify({ request_id: 'video-auth-retry-limit' }), { status: 200 }),
      new Response(JSON.stringify({ code: 'unauthenticated:bad-credentials' }), { status: 403 }),
      new Response(JSON.stringify({ code: 'unauthenticated:bad-credentials' }), { status: 403 }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
    const onAuthRejected = vi.fn(async () => 'refreshed');
    const provider = makeProvider({ fetchImplementation: fetchMock, onAuthRejected });
    const handle = await provider.submit({ prompt: 'retry limit' }, XAI_VIDEO_CATALOG_MODEL_ID);

    await expect(provider.poll(handle)).rejects.toThrow(/HTTP 403/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onAuthRejected).toHaveBeenCalledTimes(1);
  });

  it('rejects recovery when logout changes the credential generation', async () => {
    const credential = { value: 1 };
    const responses = [
      new Response(JSON.stringify({ request_id: 'video-auth-generation' }), { status: 200 }),
      new Response(JSON.stringify({ code: 'unauthenticated:bad-credentials' }), { status: 403 }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
    const onAuthRejected = vi.fn(async () => {
      credential.value = 2;
      return 'logged_out';
    });
    const provider = makeProvider({ fetchImplementation: fetchMock, credential, onAuthRejected });
    const handle = await provider.submit(
      { prompt: 'generation changed' },
      XAI_VIDEO_CATALOG_MODEL_ID,
    );

    await expect(provider.poll(handle)).rejects.toThrow(/SuperGrok 凭证已切换/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects recovery when the owner changes', async () => {
    const owner = { value: 'owner-a', pending: false };
    const responses = [
      new Response(JSON.stringify({ request_id: 'video-auth-owner' }), { status: 200 }),
      new Response(JSON.stringify({ code: 'unauthenticated:bad-credentials' }), { status: 403 }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
    const onAuthRejected = vi.fn(async () => {
      owner.value = 'owner-b';
      return 'refreshed';
    });
    const provider = makeProvider({ fetchImplementation: fetchMock, owner, onAuthRejected });
    const handle = await provider.submit({ prompt: 'owner changed' }, XAI_VIDEO_CATALOG_MODEL_ID);

    await expect(provider.poll(handle)).rejects.toThrow(/账号已切换/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('discards a late retry response after the credential generation changes', async () => {
    const credential = { value: 1 };
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ request_id: 'video-auth-late-retry' }), {
          status: 200,
        });
      }
      if (calls === 2) {
        return new Response(JSON.stringify({ code: 'unauthenticated:bad-credentials' }), {
          status: 403,
        });
      }
      credential.value = 2;
      return new Response(JSON.stringify({ status: 'pending' }), { status: 200 });
    }) as unknown as typeof fetch;
    const onAuthRejected = vi.fn(async () => 'refreshed');
    const provider = makeProvider({ fetchImplementation: fetchMock, credential, onAuthRejected });
    const handle = await provider.submit({ prompt: 'late retry' }, XAI_VIDEO_CATALOG_MODEL_ID);

    await expect(provider.poll(handle)).rejects.toThrow(/SuperGrok 凭证已切换/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects an old task before reading a replacement SuperGrok credential', async () => {
    const credential = { value: 1 };
    const getAccessToken = vi.fn(async () => 'account-a-token');
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ request_id: 'video-credential' }), { status: 200 }),
    ) as unknown as typeof fetch;
    const provider = makeProvider({ fetchImplementation: fetchMock, credential, getAccessToken });
    const handle = await provider.submit(
      { prompt: 'credential test' },
      XAI_VIDEO_CATALOG_MODEL_ID,
    );
    credential.value = 2;

    await expect(provider.poll(handle)).rejects.toThrow(/SuperGrok 凭证已切换/);
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a poll when the credential changes while the token is being read', async () => {
    const credential = { value: 1 };
    let tokenReads = 0;
    const getAccessToken = vi.fn(async () => {
      tokenReads += 1;
      if (tokenReads === 2) credential.value = 2;
      return tokenReads === 1 ? 'account-a-token' : 'account-b-token';
    });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ request_id: 'video-token-race' }), { status: 200 }),
    ) as unknown as typeof fetch;
    const provider = makeProvider({ fetchImplementation: fetchMock, credential, getAccessToken });
    const handle = await provider.submit(
      { prompt: 'token race' },
      XAI_VIDEO_CATALOG_MODEL_ID,
    );

    await expect(provider.poll(handle)).rejects.toThrow(/SuperGrok 凭证已切换/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('discards a late poll response from the old credential generation', async () => {
    const credential = { value: 1 };
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ request_id: 'video-late-poll' }), { status: 200 });
      }
      credential.value = 2;
      return new Response(JSON.stringify({ status: 'pending' }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = makeProvider({ fetchImplementation: fetchMock, credential });
    const handle = await provider.submit(
      { prompt: 'late poll' },
      XAI_VIDEO_CATALOG_MODEL_ID,
    );

    await expect(provider.poll(handle)).rejects.toThrow(/SuperGrok 凭证已切换/);
  });

  it('rejects an old completed-task download after logout or reconnect', async () => {
    const credential = { value: 1 };
    const responses = [
      new Response(JSON.stringify({ request_id: 'video-old-download' }), { status: 200 }),
      new Response(
        JSON.stringify({
          status: 'done',
          video: { url: 'https://vidgen.x.ai/tasks/video-old-download.mp4' },
        }),
        { status: 200 },
      ),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
    const provider = makeProvider({ fetchImplementation: fetchMock, credential });
    const handle = await provider.submit(
      { prompt: 'old download' },
      XAI_VIDEO_CATALOG_MODEL_ID,
    );
    const done = await provider.poll(handle);
    if (done.state !== 'succeeded') throw new Error('expected succeeded');
    credential.value = 2;

    await expect(provider.download(done.videoUrl)).rejects.toThrow(/SuperGrok 凭证已切换/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
      'xai-video://content/task?owner=owner-a&credential=1&source=https%3A%2F%2Fvidgen.x.ai%2Ftask.mp4';

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

  it('does not run OAuth recovery for unauthenticated CDN downloads', async () => {
    const onAuthRejected = vi.fn(async () => 'refreshed');
    const fetchMock = vi.fn(
      async () => new Response('expired download', { status: 403 }),
    ) as unknown as typeof fetch;
    const provider = makeProvider({ fetchImplementation: fetchMock, onAuthRejected });
    const videoUrl =
      'xai-video://content/task?owner=owner-a&credential=1&source=https%3A%2F%2Fvidgen.x.ai%2Ftask.mp4';

    await expect(provider.download(videoUrl)).rejects.toThrow(/下载失败\(HTTP 403\)/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].headers,
    ).toBeUndefined();
    expect(onAuthRejected).not.toHaveBeenCalled();
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
      'xai-video://content/task?owner=owner-a&credential=1&source=https%3A%2F%2Fvidgen.x.ai%2Ftask.mp4';

    await expect(provider.download(videoUrl)).rejects.toThrow(/账号已切换/);
  });

  it('rejects when the credential changes during the download stream', async () => {
    const credential = { value: 1 };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        credential.value = 2;
        controller.enqueue(MP4_BYTES);
        controller.close();
      },
    });
    const fetchMock = vi.fn(async () =>
      new Response(body, { status: 200, headers: { 'content-type': 'video/mp4' } }),
    ) as unknown as typeof fetch;
    const provider = makeProvider({ fetchImplementation: fetchMock, credential });
    const videoUrl =
      'xai-video://content/task?owner=owner-a&credential=1&source=https%3A%2F%2Fvidgen.x.ai%2Ftask.mp4';

    await expect(provider.download(videoUrl)).rejects.toThrow(/SuperGrok 凭证已切换/);
  });

  it('rechecks the credential after download bytes are verified', async () => {
    const credential = { value: 1 };
    const responseBody = new Response(MP4_BYTES).body;
    const fetchMock = vi.fn(async () => {
      const response = {
        ok: true,
        status: 200,
        body: responseBody,
        headers: {
          get(name: string) {
            if (name.toLowerCase() === 'content-type') {
              credential.value = 2;
              return 'video/mp4';
            }
            return null;
          },
        },
      };
      return response as unknown as Response;
    }) as unknown as typeof fetch;
    const provider = makeProvider({ fetchImplementation: fetchMock, credential });
    const videoUrl =
      'xai-video://content/task?owner=owner-a&credential=1&source=https%3A%2F%2Fvidgen.x.ai%2Ftask.mp4';

    await expect(provider.download(videoUrl)).rejects.toThrow(/SuperGrok 凭证已切换/);
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
