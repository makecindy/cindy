/**
 * ossPublicUpload.test.ts — OSS 预签名直传单元测试(规则 14:注入内存 fetch)。
 * 覆盖:presign → PUT 的请求组装(Bearer / headers 原样携带)、各阶段失败的
 * 结果映射(未登录 / presign 非 2xx / 响应畸形 / PUT 非 2xx / 网络异常)。
 */

import { describe, it, expect, vi } from 'vitest';

import { uploadPublicAsset, type PublicUploadDeps } from '../ossPublicUpload';

const PRESIGN_OK = {
  putUrl: 'https://bucket.oss.example.invalid/cindy/public/avatar/u1/x.png?sig=1',
  publicUrl: 'https://cdn.example.invalid/cindy/public/avatar/u1/x.png',
  key: 'cindy/public/avatar/u1/x.png',
  headers: { 'Content-Type': 'image/png' },
  expiresAt: '2026-07-17T12:15:00.000Z',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeDeps(fetchImpl: PublicUploadDeps['fetchImpl']): PublicUploadDeps {
  return {
    fetchImpl,
    getBaseUrl: () => 'https://oss.example.invalid',
    getToken: () => 'token-1',
  };
}

const BODY = new Uint8Array([1, 2, 3]);

describe('uploadPublicAsset', () => {
  it.each(['presign', 'put'] as const)('logs the original %s failure without leaking signed URLs', async (stage) => {
    const onError = vi.fn();
    const deps = makeDeps(async (url) => {
      if (stage === 'put' && url.endsWith('/api/oss/presign-put')) return jsonResponse(200, PRESIGN_OK);
      throw new Error(`socket closed: ${url}`);
    });
    const result = await uploadPublicAsset({ ...deps, onError }, { scene: 'avatar', contentType: 'image/png', body: BODY });
    expect(result).toEqual({ ok: false, stage, status: 0 });
    expect(onError).toHaveBeenCalledExactlyOnceWith(stage, expect.stringContaining('socket closed'));
    const logged = JSON.stringify(onError.mock.calls);
    expect(logged).toContain(stage === 'put' ? 'https://bucket.oss.example.invalid' : 'https://oss.example.invalid');
    expect(logged).not.toContain('/cindy/public/avatar/u1/x.png');
    expect(logged).not.toContain('?sig=1');
  });

  it('does not log response excerpts when presign returns malformed JSON', async () => {
    const onError = vi.fn();
    const result = await uploadPublicAsset({
      ...makeDeps(async () => new Response('private display name')), onError,
    }, { scene: 'avatar', contentType: 'image/png', body: BODY });
    expect(result).toEqual({ ok: false, stage: 'presign', status: 0 });
    expect(onError).toHaveBeenCalledExactlyOnceWith('presign', 'SyntaxError');
  });

  it('成功链路:presign 带 Bearer/scene/size,PUT 原样携带返回 headers', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/api/oss/presign-put')) return jsonResponse(200, PRESIGN_OK);
      return new Response(null, { status: 200 });
    });
    const result = await uploadPublicAsset(makeDeps(fetchImpl), {
      scene: 'avatar',
      contentType: 'image/png',
      body: BODY,
    });
    expect(result).toEqual({ ok: true, publicUrl: PRESIGN_OK.publicUrl, key: PRESIGN_OK.key });

    expect(calls[0].url).toBe('https://oss.example.invalid/api/oss/presign-put');
    expect(calls[0].init?.method).toBe('POST');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer token-1');
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      scene: 'avatar',
      contentType: 'image/png',
      size: 3,
    });

    expect(calls[1].url).toBe(PRESIGN_OK.putUrl);
    expect(calls[1].init?.method).toBe('PUT');
    expect(calls[1].init?.headers).toEqual({ 'Content-Type': 'image/png' });
  });

  it('未登录 → presign 阶段 NOT_AUTHENTICATED,零网络请求', async () => {
    const fetchImpl = vi.fn();
    const deps = { ...makeDeps(fetchImpl), getToken: () => null };
    const result = await uploadPublicAsset(deps, {
      scene: 'avatar',
      contentType: 'image/png',
      body: BODY,
    });
    expect(result).toEqual({ ok: false, stage: 'presign', status: 0, code: 'NOT_AUTHENTICATED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('presign 非 2xx → 透传 status 与错误体 code,不发 PUT', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(429, { error: { code: 'RATE_LIMITED', message: 'slow down' } }),
    );
    const result = await uploadPublicAsset(makeDeps(fetchImpl), {
      scene: 'avatar',
      contentType: 'image/png',
      body: BODY,
    });
    expect(result).toEqual({ ok: false, stage: 'presign', status: 429, code: 'RATE_LIMITED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('presign 响应畸形(缺 putUrl)→ MALFORMED_RESPONSE', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { publicUrl: 'https://x', key: 'k' }));
    const result = await uploadPublicAsset(makeDeps(fetchImpl), {
      scene: 'avatar',
      contentType: 'image/png',
      body: BODY,
    });
    expect(result).toEqual({
      ok: false,
      stage: 'presign',
      status: 200,
      code: 'MALFORMED_RESPONSE',
    });
  });

  it('PUT 非 2xx → put 阶段失败(带 status)', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/api/oss/presign-put')
        ? jsonResponse(200, PRESIGN_OK)
        : new Response('denied', { status: 403 }),
    );
    const result = await uploadPublicAsset(makeDeps(fetchImpl), {
      scene: 'avatar',
      contentType: 'image/png',
      body: BODY,
    });
    expect(result).toEqual({ ok: false, stage: 'put', status: 403 });
  });

  it('网络异常:presign 抛错 → status 0;PUT 抛错 → put/status 0', async () => {
    const presignThrow = vi.fn(async () => {
      throw new Error('offline');
    });
    await expect(
      uploadPublicAsset(makeDeps(presignThrow), {
        scene: 'avatar',
        contentType: 'image/png',
        body: BODY,
      }),
    ).resolves.toEqual({ ok: false, stage: 'presign', status: 0 });

    const putThrow = vi.fn(async (url: string) => {
      if (url.endsWith('/api/oss/presign-put')) return jsonResponse(200, PRESIGN_OK);
      throw new Error('reset');
    });
    await expect(
      uploadPublicAsset(makeDeps(putThrow), {
        scene: 'avatar',
        contentType: 'image/png',
        body: BODY,
      }),
    ).resolves.toEqual({ ok: false, stage: 'put', status: 0 });
  });
});
