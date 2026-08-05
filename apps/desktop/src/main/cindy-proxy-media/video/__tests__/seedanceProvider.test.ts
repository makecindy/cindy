/**
 * seedanceProvider.test.ts
 * ---------------------------------------------------------------------------
 * Locks in the seedance provider's translation between the vendor-agnostic
 * VideoProvider interface and the concrete XD Gateway / volcengine ARK calls.
 *
 * What we DON'T test:
 *   - The polling loop (lives in mcpServer.ts handler, not the provider).
 *   - Auth header beyond "is the bearer present".
 */

import { describe, it, expect, vi } from 'vitest';
import { createSeedanceProvider } from '../providers/seedance.js';

const BASE_URL = 'https://llm-proxy.example.test';

function makeProvider(fakeFetch: typeof fetch) {
  return createSeedanceProvider({
    baseUrl: BASE_URL,
    getApiKey: () => 'test-key',
    fetchImplementation: fakeFetch,
  });
}

describe('seedance provider · capabilities', () => {
  const p = makeProvider(vi.fn() as unknown as typeof fetch);
  it('exposes seedance-fast as the first alias (default)', () => {
    expect(p.capabilities.modelAliases[0].alias).toBe('seedance-fast');
  });
  it('exposes seedance-pro as the quality tier', () => {
    expect(p.capabilities.modelAliases.some((a) => a.alias === 'seedance-pro')).toBe(
      true,
    );
  });
  it('declares maxImages=2 for first+last frame transition', () => {
    expect(p.capabilities.maxImages).toBe(2);
  });
});

describe('seedance provider · submit body shape', () => {
  it('text-only: builds content with one text node and embeds the prompt-flag suffix', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return new Response(JSON.stringify({ id: 'cgt-FAKE-1' }), { status: 200 });
    }) as unknown as typeof fetch;

    const p = makeProvider(fetchMock);
    const handle = await p.submit(
      {
        prompt: '一只小猫在草地上跳',
        duration: 6,
        resolution: '1080p',
        ratio: '9:16',
        fps: 24,
      },
      'seedance-fast',
    );
    expect(handle.providerId).toBe('seedance');
    expect(handle.taskId).toBe('cgt-FAKE-1');
    expect(handle.modelUsed).toBe('doubao-seedance-2-0-fast-260128');

    // URL is properly joined off the base + default submit path
    expect(calls[0].url).toBe(
      'https://llm-proxy.example.test/volcengine/api/v3/contents/generations/tasks',
    );
    // Bearer auth header present
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    expect(headers['Content-Type']).toBe('application/json');

    // Body shape
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.model).toBe('doubao-seedance-2-0-fast-260128');
    expect(body.content).toEqual([
      {
        type: 'text',
        text: '一只小猫在草地上跳 --duration 6 --resolution 1080p --ratio 9:16 --fps 24',
      },
    ]);
  });

  it('image-to-video: appends image_url with role:first_frame', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'cgt-FAKE-2' }), { status: 200 }),
    ) as unknown as typeof fetch;
    const p = makeProvider(fetchMock);
    await p.submit(
      {
        prompt: '让画面动起来',
        images: ['data:image/png;base64,AAAA'],
      },
      'seedance-fast',
    );
    const init = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.content).toHaveLength(2);
    expect(body.content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAAA' },
      role: 'first_frame',
    });
  });

  it('first+last frame transition: two images get distinct roles', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'cgt-FAKE-3' }), { status: 200 }),
    ) as unknown as typeof fetch;
    const p = makeProvider(fetchMock);
    await p.submit(
      {
        prompt: '从 A 过渡到 B',
        images: [
          'data:image/png;base64,FIRST',
          'data:image/png;base64,LAST',
        ],
      },
      'seedance-pro',
    );
    const init = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('doubao-seedance-2-0-260128');
    expect(body.content).toHaveLength(3);
    expect(body.content[1].role).toBe('first_frame');
    expect(body.content[2].role).toBe('last_frame');
  });

  it('rejects unknown alias before sending', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('{}', { status: 200 }),
    ) as unknown as typeof fetch;
    const p = makeProvider(fetchMock);
    await expect(
      p.submit({ prompt: 'x' }, 'sora-1.0'),
    ).rejects.toThrow(/unknown alias/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('seedance provider · poll status translation', () => {
  it('translates running → state:running', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: 'cgt-X', status: 'running' }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const p = makeProvider(fetchMock);
    const status = await p.poll({
      providerId: 'seedance',
      taskId: 'cgt-X',
      modelUsed: 'doubao-seedance-2-0-fast-260128',
      submittedAt: 0,
    });
    expect(status.state).toBe('running');
  });

  it('translates queued → state:pending', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: 'cgt-X', status: 'queued' }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const p = makeProvider(fetchMock);
    const status = await p.poll({
      providerId: 'seedance',
      taskId: 'cgt-X',
      modelUsed: 'm',
      submittedAt: 0,
    });
    expect(status.state).toBe('pending');
  });

  it('translates succeeded with content.video_url → state:succeeded + meta', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: 'cgt-X',
          status: 'succeeded',
          content: { video_url: 'https://tos.example/v.mp4' },
          duration: 6,
          resolution: '720p',
          ratio: '16:9',
          framespersecond: 24,
          usage: { total_tokens: 1234 },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const p = makeProvider(fetchMock);
    const status = await p.poll({
      providerId: 'seedance',
      taskId: 'cgt-X',
      modelUsed: 'm',
      submittedAt: 0,
    });
    expect(status.state).toBe('succeeded');
    if (status.state === 'succeeded') {
      expect(status.videoUrl).toBe('https://tos.example/v.mp4');
      expect(status.meta).toMatchObject({
        durationSec: 6,
        resolution: '720p',
        ratio: '16:9',
        fps: 24,
      });
    }
  });

  it('succeeded but missing video_url → state:failed (treats as bad backend response)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: 'cgt-X', status: 'succeeded', content: {} }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const p = makeProvider(fetchMock);
    const status = await p.poll({
      providerId: 'seedance',
      taskId: 'cgt-X',
      modelUsed: 'm',
      submittedAt: 0,
    });
    expect(status.state).toBe('failed');
  });

  it('failed → state:failed with error message', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: 'cgt-X',
          status: 'failed',
          error: { message: 'invalid prompt' },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const p = makeProvider(fetchMock);
    const status = await p.poll({
      providerId: 'seedance',
      taskId: 'cgt-X',
      modelUsed: 'm',
      submittedAt: 0,
    });
    expect(status.state).toBe('failed');
    if (status.state === 'failed') {
      expect(status.error).toContain('invalid prompt');
    }
  });
});
