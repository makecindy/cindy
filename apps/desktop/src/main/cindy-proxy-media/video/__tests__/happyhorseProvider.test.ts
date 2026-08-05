/**
 * happyhorseProvider.test.ts
 * ---------------------------------------------------------------------------
 * Locks in the happyhorse (Aliyun DashScope) provider's translation between
 * the vendor-agnostic VideoProvider interface and the DashScope async API.
 * Mirrors seedanceProvider.test.ts so the two providers stay symmetric and
 * any divergence (e.g. resolution casing) is captured.
 */

import { describe, it, expect, vi } from 'vitest';
import { createHappyhorseProvider } from '../providers/happyhorse.js';

const BASE_URL = 'https://llm-proxy.example.test';

function makeProvider(fakeFetch: typeof fetch) {
  return createHappyhorseProvider({
    baseUrl: BASE_URL,
    getApiKey: () => 'test-key',
    fetchImplementation: fakeFetch,
  });
}

describe('happyhorse provider · capabilities', () => {
  const p = makeProvider(vi.fn() as unknown as typeof fetch);
  it('exposes a single LLM-facing alias `happyhorse`', () => {
    expect(p.capabilities.modelAliases.map((a) => a.alias)).toEqual([
      'happyhorse',
    ]);
  });
  it('declares maxImages=1 (no first+last frame transition support)', () => {
    expect(p.capabilities.maxImages).toBe(1);
  });
  it('declares supported durations / resolutions / ratios', () => {
    expect(p.capabilities.supportedDurations).toContain(5);
    expect(p.capabilities.supportedResolutions).toContain('720p');
    expect(p.capabilities.supportedResolutions).toContain('1080p');
    expect(p.capabilities.supportedRatios).toContain('16:9');
  });
});

describe('happyhorse provider · submit body shape', () => {
  it('text-only: routes to happyhorse-1.0-t2v with prompt + parameters block', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return new Response(
        JSON.stringify({
          request_id: 'rid-1',
          output: { task_id: 'task-1', task_status: 'PENDING' },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const p = makeProvider(fetchMock);
    const handle = await p.submit(
      {
        prompt: '一只小猫在草地上跳',
        duration: 5,
        resolution: '720p',
        ratio: '16:9',
        fps: 24,
      },
      'happyhorse',
    );
    expect(handle.providerId).toBe('happyhorse');
    expect(handle.taskId).toBe('task-1');
    expect(handle.modelUsed).toBe('happyhorse-1.0-t2v');

    expect(calls[0].url).toBe(
      'https://llm-proxy.example.test/dashscope/api/v1/services/aigc/video-generation/video-synthesis',
    );
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-DashScope-Async']).toBe('enable');

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.model).toBe('happyhorse-1.0-t2v');
    expect(body.input).toEqual({ prompt: '一只小猫在草地上跳' });
    // resolution upper-cased; ratio mapped to size W*H at 720p
    expect(body.parameters).toEqual({
      resolution: '720P',
      duration: 5,
      size: '1280*720',
    });
  });

  it('image-to-video: 1 image → routes to happyhorse-1.0-i2v with input.media as array', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output: { task_id: 'task-2', task_status: 'PENDING' },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const p = makeProvider(fetchMock);
    const handle = await p.submit(
      {
        prompt: '让画面动起来',
        images: ['data:image/png;base64,AAAA'],
      },
      'happyhorse',
    );
    expect(handle.modelUsed).toBe('happyhorse-1.0-i2v');

    const init = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('happyhorse-1.0-i2v');
    // Aliyun expects MediaItem objects (not bare strings); type is
    // 'first_frame' for i2v.
    expect(body.input.media).toEqual([
      { type: 'first_frame', url: 'data:image/png;base64,AAAA' },
    ]);
  });

  it('vertical 9:16 maps size with shortSide as width', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ output: { task_id: 't', task_status: 'PENDING' } }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const p = makeProvider(fetchMock);
    await p.submit(
      { prompt: 'x', resolution: '1080p', ratio: '9:16' },
      'happyhorse',
    );
    const init = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.parameters.size).toBe('1080*1920');
    expect(body.parameters.resolution).toBe('1080P');
  });

  it('任何比例的像素量都不超过该档 16:9 基准(不偷偷升档)', async () => {
    // 回归:4:3 曾拿 longSide 当宽再推高(720p → 1280*960 = 基准的 1.33 倍),
    // 等于升档出片并计费。cindy 槽放开 ratio 后这条分支才可达。
    const cases: Array<{ resolution: string; ratio: string; size: string }> = [
      { resolution: '720p', ratio: '4:3', size: '960*720' },
      { resolution: '1080p', ratio: '4:3', size: '1440*1080' },
      { resolution: '480p', ratio: '4:3', size: '640*480' },
      { resolution: '720p', ratio: '3:4', size: '540*720' },
      { resolution: '720p', ratio: '1:1', size: '720*720' },
      { resolution: '720p', ratio: '16:9', size: '1280*720' },
      { resolution: '1080p', ratio: '9:16', size: '1080*1920' },
    ];
    const baseline: Record<string, number> = {
      '480p': 854 * 480,
      '720p': 1280 * 720,
      '1080p': 1920 * 1080,
    };
    for (const c of cases) {
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({ output: { task_id: 't', task_status: 'PENDING' } }),
          { status: 200 },
        ),
      ) as unknown as typeof fetch;
      const p = makeProvider(fetchMock);
      await p.submit({ prompt: 'x', resolution: c.resolution, ratio: c.ratio }, 'happyhorse');
      const init = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.parameters.size, `${c.resolution} ${c.ratio}`).toBe(c.size);
      const [w, h] = (body.parameters.size as string).split('*').map(Number);
      expect(w * h, `${c.resolution} ${c.ratio} 像素量`).toBeLessThanOrEqual(baseline[c.resolution]);
    }
  });

  it('rejects unknown alias before sending', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('{}', { status: 200 }),
    ) as unknown as typeof fetch;
    const p = makeProvider(fetchMock);
    await expect(
      p.submit({ prompt: 'x' }, 'seedance-fast'),
    ).rejects.toThrow(/unknown alias/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('happyhorse provider · poll status translation', () => {
  it('translates PENDING → state:pending', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ output: { task_id: 't', task_status: 'PENDING' } }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const p = makeProvider(fetchMock);
    const status = await p.poll({
      providerId: 'happyhorse',
      taskId: 't',
      modelUsed: 'happyhorse-1.0-t2v',
      submittedAt: 0,
    });
    expect(status.state).toBe('pending');
  });

  it('translates RUNNING → state:running', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ output: { task_id: 't', task_status: 'RUNNING' } }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const p = makeProvider(fetchMock);
    const status = await p.poll({
      providerId: 'happyhorse',
      taskId: 't',
      modelUsed: 'happyhorse-1.0-t2v',
      submittedAt: 0,
    });
    expect(status.state).toBe('running');
  });

  it('translates SUCCEEDED with output.video_url + usage → state:succeeded with meta', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output: {
            task_id: 't',
            task_status: 'SUCCEEDED',
            video_url: 'https://oss.example/v.mp4',
          },
          usage: { duration: 5, SR: 720, ratio: '16:9' },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const p = makeProvider(fetchMock);
    const status = await p.poll({
      providerId: 'happyhorse',
      taskId: 't',
      modelUsed: 'happyhorse-1.0-t2v',
      submittedAt: 0,
    });
    expect(status.state).toBe('succeeded');
    if (status.state === 'succeeded') {
      expect(status.videoUrl).toBe('https://oss.example/v.mp4');
      expect(status.meta).toMatchObject({
        durationSec: 5,
        resolution: '720p', // SR=720 → '720p'
        ratio: '16:9',
      });
    }
  });

  it('SUCCEEDED but missing video_url → state:failed', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output: { task_id: 't', task_status: 'SUCCEEDED' },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const p = makeProvider(fetchMock);
    const status = await p.poll({
      providerId: 'happyhorse',
      taskId: 't',
      modelUsed: 'happyhorse-1.0-t2v',
      submittedAt: 0,
    });
    expect(status.state).toBe('failed');
  });

  it('FAILED → state:failed with message', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output: {
            task_id: 't',
            task_status: 'FAILED',
            message: 'inappropriate prompt',
          },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const p = makeProvider(fetchMock);
    const status = await p.poll({
      providerId: 'happyhorse',
      taskId: 't',
      modelUsed: 'happyhorse-1.0-t2v',
      submittedAt: 0,
    });
    expect(status.state).toBe('failed');
    if (status.state === 'failed') {
      expect(status.error).toContain('inappropriate prompt');
    }
  });

  it('unknown task_status → defaults to running (forward-compat)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output: { task_id: 't', task_status: 'CANCELED' as never },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const p = makeProvider(fetchMock);
    const status = await p.poll({
      providerId: 'happyhorse',
      taskId: 't',
      modelUsed: 'happyhorse-1.0-t2v',
      submittedAt: 0,
    });
    expect(status.state).toBe('running');
  });
});

describe('happyhorse provider · co-existence with seedance via registry', () => {
  it('does not collide with seedance aliases', async () => {
    const { VideoProviderRegistry } = await import('../registry.js');
    const { createSeedanceProvider } = await import(
      '../providers/seedance.js'
    );
    const r = new VideoProviderRegistry();
    r.register(
      createSeedanceProvider({
        baseUrl: 'https://x',
        getApiKey: () => 'k',
        fetchImplementation: vi.fn() as unknown as typeof fetch,
      }),
    );
    r.register(makeProvider(vi.fn() as unknown as typeof fetch));
    const all = r.collectAllAliases().map((a) => a.alias);
    // First alias must remain seedance-fast (LLM default)
    expect(all[0]).toBe('seedance-fast');
    expect(all).toContain('happyhorse');
    expect(r.resolveByAlias('happyhorse').provider.id).toBe('happyhorse');
    expect(r.resolveByAlias('seedance-fast').provider.id).toBe('seedance');
  });
});
