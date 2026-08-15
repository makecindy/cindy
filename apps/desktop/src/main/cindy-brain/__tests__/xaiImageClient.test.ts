import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createXaiImageChannel } from '../xaiImageClient.js';

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => fs.rm(path, { force: true })));
});

function channel(fetchImplementation: typeof fetch, overrides: Record<string, unknown> = {}) {
  return createXaiImageChannel({
    hasOAuthLogin: () => true,
    getAccessToken: async () => 'grok-oauth-token',
    getCredentialGeneration: () => 1,
    getOwnerScopeKey: () => 'cloud:owner-a:1',
    isOwnerBoundaryPending: () => false,
    fetchImplementation,
    ...overrides,
  });
}

describe('xaiImageClient', () => {
  it('复用 SuperGrok OAuth 调 Imagine generation 并保留原生画幅', async () => {
    const doFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ b64_json: 'aW1hZ2U=', mime_type: 'image/jpeg' }],
          }),
          { status: 200 },
        ),
    );
    const result = await channel(doFetch).generateImage({
      model: 'xai/grok-imagine-image',
      prompt: '一只猫',
      aspectRatio: '3:2',
    });

    expect(result).toEqual({ data: [{ b64_json: 'aW1hZ2U=' }], output_format: 'jpeg' });
    const [url, init] = doFetch.mock.calls[0]!;
    expect(String(url)).toBe('https://api.x.ai/v1/images/generations');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer grok-oauth-token');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'grok-imagine-image',
      prompt: '一只猫',
      aspect_ratio: '3:2',
      resolution: '1k',
      response_format: 'b64_json',
    });
  });

  it('直接转发类型发现得到的未来图片模型，不依赖型号名白名单', async () => {
    const doFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }), { status: 200 }),
    );

    await channel(doFetch).generateImage({
      model: 'xai/future-image-model',
      prompt: 'future',
    });

    const body = JSON.parse(String(doFetch.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe('future-image-model');
  });

  it('改图把最多三张本地图片编码为 xAI JSON image fields', async () => {
    const paths = await Promise.all(
      [0, 1].map(async (index) => {
        const imagePath = path.join(
          os.tmpdir(),
          `cindy-xai-image-test-${process.pid}-${index}.png`,
        );
        tempPaths.push(imagePath);
        await fs.writeFile(imagePath, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
        return imagePath;
      }),
    );
    const doFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ b64_json: 'aW1hZ2U=' }],
          }),
          { status: 200 },
        ),
    );
    await channel(doFetch).editImage({
      model: 'xai/grok-imagine-image-quality',
      prompt: '合成一张图',
      imagePaths: paths,
      aspectRatio: '2:3',
    });

    const [url, init] = doFetch.mock.calls[0]!;
    expect(String(url)).toBe('https://api.x.ai/v1/images/edits');
    const body = JSON.parse(String(init?.body)) as { images: Array<{ type: string; url: string }> };
    expect(body.images).toHaveLength(2);
    expect(body.images.every((image) => image.type === 'image_url')).toBe(true);
    expect(body.images.every((image) => image.url.startsWith('data:image/png;base64,'))).toBe(true);
  });

  it('短效 URL 响应会立刻有界下载成字节;非 xAI URL 被拒绝', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const doFetch = vi.fn<typeof fetch>(async (input) =>
      String(input).includes('/images/generations')
        ? new Response(JSON.stringify({ data: [{ url: 'https://imgen.x.ai/output.png' }] }), {
            status: 200,
          })
        : new Response(png, { status: 200 }),
    );
    const result = await channel(doFetch).generateImage({
      model: 'xai/grok-imagine-image',
      prompt: 'p',
    });
    expect(result.data[0]?.b64_json).toBe(png.toString('base64'));
    expect(doFetch).toHaveBeenCalledTimes(2);
    expect(doFetch.mock.calls[1]?.[1]).toMatchObject({ redirect: 'manual' });

    const declaredOversize = vi.fn<typeof fetch>(async (input) =>
      String(input).includes('/images/generations')
        ? new Response(JSON.stringify({ data: [{ url: 'https://imgen.x.ai/output.png' }] }), {
            status: 200,
          })
        : new Response(png, { status: 200, headers: { 'Content-Length': '17' } }),
    );
    await expect(
      channel(declaredOversize, { maxImageDownloadBytes: 16 }).generateImage({
        model: 'xai/grok-imagine-image',
        prompt: 'p',
      }),
    ).rejects.toThrow('超过大小上限');

    const cancel = vi.fn();
    const streamedOversize = vi.fn<typeof fetch>(async (input) =>
      String(input).includes('/images/generations')
        ? new Response(JSON.stringify({ data: [{ url: 'https://imgen.x.ai/output.png' }] }), {
            status: 200,
          })
        : new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(png.subarray(0, 8));
              controller.enqueue(png.subarray(8));
            },
            cancel,
          }), { status: 200 }),
    );
    await expect(
      channel(streamedOversize, { maxImageDownloadBytes: 15 }).generateImage({
        model: 'xai/grok-imagine-image',
        prompt: 'p',
      }),
    ).rejects.toThrow('超过大小上限');
    expect(cancel).toHaveBeenCalled();

    const untrusted = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ url: 'https://example.com/output.png' }],
          }),
          { status: 200 },
        ),
    );
    await expect(
      channel(untrusted).generateImage({ model: 'xai/grok-imagine-image', prompt: 'p' }),
    ).rejects.toThrow('不可信');

    const malformed = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ url: 'not a URL' }],
          }),
          { status: 200 },
        ),
    );
    await expect(
      channel(malformed).generateImage({ model: 'xai/grok-imagine-image', prompt: 'p' }),
    ).rejects.toThrow('不可信');

    const redirected = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/images/generations')) {
        return new Response(JSON.stringify({ data: [{ url: 'https://imgen.x.ai/output.png' }] }), {
          status: 200,
        });
      }
      if (url === 'https://imgen.x.ai/output.png') {
        return new Response(null, { status: 302, headers: { Location: '/cdn/output.png' } });
      }
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    });
    await expect(
      channel(redirected).generateImage({ model: 'xai/grok-imagine-image', prompt: 'p' }),
    ).resolves.toEqual({
      data: [{ b64_json: png.toString('base64') }],
      output_format: 'png',
    });
    expect(redirected.mock.calls.slice(1)).toEqual([
      ['https://imgen.x.ai/output.png', { redirect: 'manual' }],
      ['https://imgen.x.ai/cdn/output.png', { redirect: 'manual' }],
    ]);

    const untrustedRedirect = vi.fn<typeof fetch>(async (input) =>
      String(input).includes('/images/generations')
        ? new Response(JSON.stringify({ data: [{ url: 'https://imgen.x.ai/output.png' }] }), {
            status: 200,
          })
        : new Response(null, {
            status: 302,
            headers: { Location: 'https://example.com/output.png' },
          }),
    );
    await expect(
      channel(untrustedRedirect).generateImage({ model: 'xai/grok-imagine-image', prompt: 'p' }),
    ).rejects.toThrow('不可信');
  });

  it('图片重定向保持账号与凭证代际，并拒绝缺失 Location、第二跳和伪图片', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    let ownerScope = 'cloud:owner-a:1';
    let credentialGeneration = 1;
    const generationSwitch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/images/generations')) {
        return new Response(JSON.stringify({ data: [{ url: 'https://imgen.x.ai/output.png' }] }), {
          status: 200,
        });
      }
      if (url.endsWith('/output.png')) {
        return new Response(null, {
          status: 307,
          headers: { Location: 'https://cdn.x.ai/final.png' },
        });
      }
      credentialGeneration = 2;
      return new Response(png, { status: 200 });
    });
    await expect(
      channel(generationSwitch, {
        getOwnerScopeKey: () => ownerScope,
        getCredentialGeneration: () => credentialGeneration,
      }).generateImage({ model: 'xai/grok-imagine-image', prompt: 'p' }),
    ).rejects.toThrow('SuperGrok 凭证已切换');

    credentialGeneration = 1;
    const ownerSwitch = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes('/images/generations')) {
        return new Response(JSON.stringify({ data: [{ url: 'https://imgen.x.ai/output.png' }] }), {
          status: 200,
        });
      }
      ownerScope = 'cloud:owner-b:2';
      return new Response(null, { status: 302, headers: { Location: 'https://cdn.x.ai/final.png' } });
    });
    await expect(
      channel(ownerSwitch, { getOwnerScopeKey: () => ownerScope }).generateImage({
        model: 'xai/grok-imagine-image',
        prompt: 'p',
      }),
    ).rejects.toThrow('账号已切换');

    ownerScope = 'cloud:owner-a:1';
    for (const location of [undefined, 'https://cdn.x.ai/final.png']) {
      let downloadCalls = 0;
      const badRedirect = vi.fn<typeof fetch>(async (input) => {
        if (String(input).includes('/images/generations')) {
          return new Response(JSON.stringify({ data: [{ url: 'https://imgen.x.ai/output.png' }] }), {
            status: 200,
          });
        }
        downloadCalls += 1;
        return new Response(null, {
          status: 302,
          ...(location ? { headers: { Location: location } } : {}),
        });
      });
      await expect(
        channel(badRedirect).generateImage({ model: 'xai/grok-imagine-image', prompt: 'p' }),
      ).rejects.toThrow(location ? 'HTTP 302' : '缺少 Location');
      expect(downloadCalls).toBe(location ? 2 : 1);
    }

    const fakeImage = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/images/generations')) {
        return new Response(JSON.stringify({ data: [{ url: 'https://imgen.x.ai/output.png' }] }), {
          status: 200,
        });
      }
      if (url.endsWith('/output.png')) {
        return new Response(null, { status: 302, headers: { Location: 'https://cdn.x.ai/final.png' } });
      }
      return new Response(Buffer.from('<html>error</html>'), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    });
    await expect(
      channel(fakeImage).generateImage({ model: 'xai/grok-imagine-image', prompt: 'p' }),
    ).rejects.toThrow('不是有效图片');
  });

  it('账号作用域在准备请求或等待响应期间改变时 fail closed', async () => {
    let ownerScope = 'cloud:owner-a:1';
    const beforeFetch = vi.fn<typeof fetch>();
    const switchesDuringTokenRead = channel(beforeFetch, {
      getOwnerScopeKey: () => ownerScope,
      getAccessToken: async () => {
        ownerScope = 'cloud:owner-b:2';
        return 'owner-a-token';
      },
    });

    await expect(
      switchesDuringTokenRead.generateImage({ model: 'xai/grok-imagine-image', prompt: 'p' }),
    ).rejects.toThrow('账号已切换');
    expect(beforeFetch).not.toHaveBeenCalled();

    ownerScope = 'cloud:owner-a:3';
    const responseFetch = vi.fn<typeof fetch>(async () => {
      ownerScope = 'cloud:owner-b:4';
      return new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }), { status: 200 });
    });
    await expect(
      channel(responseFetch, { getOwnerScopeKey: () => ownerScope }).generateImage({
        model: 'xai/grok-imagine-image',
        prompt: 'p',
      }),
    ).rejects.toThrow('账号已切换');
    expect(responseFetch).toHaveBeenCalledTimes(1);
  });

  it('响应返回途中 Ghost durable owner 变为 mismatch 时中止且不返回结果', async () => {
    // 另一实例改写全局 durable Ghost projection owner:进程内 boundaryDepth 与
    // owner scope key 都不变,但 Ghost 专属边界(isOwnerBoundaryPending 已含
    // durable owner 检查)在响应返回途中变 pending,必须中止且不返回结果。
    let boundaryPending = false;
    const doFetch = vi.fn<typeof fetch>(async () => {
      boundaryPending = true;
      return new Response(
        JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=', mime_type: 'image/jpeg' }] }),
        { status: 200 },
      );
    });
    const ch = channel(doFetch, { isOwnerBoundaryPending: () => boundaryPending });
    await expect(
      ch.generateImage({ model: 'xai/grok-imagine-image', prompt: 'p' }),
    ).rejects.toThrow('账号已切换');
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it('登录态决定 ready;派发拦截、源图上限与 OAuth 拒绝均在出网边界处理', async () => {
    const doFetch = vi.fn<typeof fetch>();
    const unavailable = channel(doFetch, { hasOAuthLogin: () => false });
    expect(unavailable.ready()).toBe(false);

    const getAccessToken = vi.fn(async () => 'grok-oauth-token');
    const blocked = channel(doFetch, {
      getAccessToken,
      beforeDispatch: () => {
        throw new Error('模型已停用');
      },
    });
    await expect(
      blocked.generateImage({ model: 'xai/grok-imagine-image', prompt: 'p' }),
    ).rejects.toThrow('模型已停用');
    expect(doFetch).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();

    const boundaryBlocked = channel(doFetch, {
      getAccessToken,
      isOwnerBoundaryPending: () => true,
    });
    await expect(
      boundaryBlocked.generateImage({ model: 'xai/grok-imagine-image', prompt: 'p' }),
    ).rejects.toThrow('账号正在切换');
    expect(getAccessToken).not.toHaveBeenCalled();

    await expect(
      channel(doFetch).editImage({
        model: 'xai/grok-imagine-image',
        prompt: 'p',
        imagePaths: ['1', '2', '3', '4'],
      }),
    ).rejects.toThrow('最多支持 3 张');
    expect(doFetch).not.toHaveBeenCalled();

    const onAuthRejected = vi.fn(async () => 'refreshed');
    const rejectedFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            code: 'unauthenticated:bad-credentials',
            error: { message: 'rejected' },
          }),
          { status: 403 },
        ),
    );
    await expect(
      channel(rejectedFetch, { onAuthRejected }).generateImage({
        model: 'xai/grok-imagine-image',
        prompt: 'p',
      }),
    ).rejects.toThrow('HTTP 403');
    expect(onAuthRejected).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 403,
        failedAccessToken: 'grok-oauth-token',
      }),
    );
  });
});
