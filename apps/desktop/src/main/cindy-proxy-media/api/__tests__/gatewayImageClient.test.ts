import { describe, expect, it, vi } from 'vitest';

import { createGatewayImageClient, GatewayImageError } from '../gatewayImageClient.js';

describe('bounded Images responses', () => {
  const request = (response: Response, maxResponseBytes: number) => createGatewayImageClient({
    getApiKey: () => 'invalid-test-key',
    proxy: { baseUrl: 'https://api.example.invalid', generatePath: '/images/generations', editPath: '/images/edits' },
    fetchImplementation: vi.fn(async () => response), maxResponseBytes,
  }).generateImage({ model: 'image', prompt: 'circle' });

  it.each([undefined, '1'])('cancels an oversized stream with content-length %s before buffering it', async (length) => {
    const cancel = vi.fn();
    let reads = 0;
    const stream = new ReadableStream({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(8)); }, cancel,
    }, { highWaterMark: 0 });
    await expect(request(new Response(stream, { headers: length ? { 'content-length': length } : {} }), 12)).rejects.toThrow(/response.*limit/);
    expect(reads).toBe(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it('rejects declared oversize without reading, and releases the body', async () => {
    const cancel = vi.fn();
    const pull = vi.fn();
    const stream = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
    await expect(request(new Response(stream, { headers: { 'content-length': '13' } }), 12)).rejects.toThrow(/response.*limit/);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it('accepts the exact byte limit and UTF-8 split across chunks', async () => {
    const bytes = Buffer.from(JSON.stringify({ data: [{ url: 'https://img.example.invalid/猫.png' }] }));
    const response = new Response(new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } }));
    expect(await request(response, bytes.length)).toMatchObject({ data: [{ url: 'https://img.example.invalid/猫.png' }] });
  });

  it('also bounds error responses without exposing their contents', async () => {
    const response = new Response(JSON.stringify({ error: { message: 'invalid-private-payload'.repeat(20) } }), { status: 500 });
    const error = await request(response, 32).catch(error => error);
    expect(error).toBeInstanceOf(GatewayImageError);
    expect(error.message).toContain('byte limit');
    expect(error.message).not.toContain('invalid-private-payload');
    expect(error.body).toBeUndefined();
  });
});

describe('gatewayImageClient error context', () => {
  it('保留 HTTP 状态、请求 model id、网关错误码和安全错误消息', async () => {
    const fetchImplementation = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: 'No available channel for model',
              code: 'model_not_found',
            },
          }),
          {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
    ) as unknown as typeof fetch;
    const client = createGatewayImageClient({
      getApiKey: () => 'test-key',
      proxy: {
        baseUrl: 'https://gateway.example.test',
        generatePath: '/v1/images/generations',
        editPath: '/v1/images/edits',
      },
      fetchImplementation,
    });

    const error = await client
      .generateImage({
        model: 'gpt-image-2',
        prompt: '一只猫',
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayImageError);
    expect(error).toMatchObject({
      status: 404,
      body: {
        error: {
          message: 'No available channel for model',
          code: 'model_not_found',
        },
      },
    });
    expect((error as Error).message).toContain('HTTP 404');
    expect((error as Error).message).toContain('model "gpt-image-2"');
    expect((error as Error).message).toContain('code "model_not_found"');
    expect((error as Error).message).toContain('No available channel for model');
    expect((error as Error).message).not.toContain('test-key');
  });
});

describe('gatewayImageClient 多来源通用化选项(2026-07)', () => {
  const okImageResponse = () =>
    new Response(JSON.stringify({ created: 1, data: [{ b64_json: 'aGk=' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  const proxy = {
    baseUrl: 'https://api.example.test',
    generatePath: '/v1/images/generations',
    editPath: '/v1/images/edits',
  };

  it('brandLabel 进错误话术;missingKeyMessage 替换缺凭证提示', async () => {
    const fetchImplementation = vi.fn(
      async () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 }),
    ) as unknown as typeof fetch;
    const client = createGatewayImageClient({
      getApiKey: () => 'k',
      proxy,
      fetchImplementation,
      brandLabel: 'OpenAI',
    });
    const err = await client.generateImage({ model: 'm', prompt: 'p' }).catch((e: unknown) => e);
    expect((err as Error).message).toContain('OpenAI image request failed');
    expect((err as Error).message).not.toContain('XD Gateway');

    const noKey = createGatewayImageClient({
      getApiKey: () => null,
      proxy,
      brandLabel: 'OpenAI',
      missingKeyMessage: '请先在设置里配置 OpenAI 图像 API key',
    });
    const keyErr = await noKey.generateImage({ model: 'm', prompt: 'p' }).catch((e: unknown) => e);
    expect((keyErr as Error).message).toBe('请先在设置里配置 OpenAI 图像 API key');
  });

  it('supportsEdit:false 时 editImage 人话明拒且不发请求', async () => {
    const fetchImplementation = vi.fn(async () => okImageResponse()) as unknown as typeof fetch;
    const client = createGatewayImageClient({
      getApiKey: () => 'k',
      proxy,
      fetchImplementation,
      brandLabel: 'xAI',
      supportsEdit: false,
    });
    const err = await client
      .editImage({ model: 'm', prompt: 'p', imagePaths: ['/tmp/x.png'] })
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain('不支持改图');
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('allowSizeQuality:false 时显式 size/quality 明拒不静默剥掉;缺省时连 size:auto 也不发', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => okImageResponse(),
    );
    const client = createGatewayImageClient({
      getApiKey: () => 'k',
      proxy,
      fetchImplementation: fetchMock as unknown as typeof fetch,
      allowSizeQuality: false,
    });
    const err = await client
      .generateImage({ model: 'm', prompt: 'p', size: '1024x1024' })
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain('不支持画幅/档位参数');
    expect(fetchMock).not.toHaveBeenCalled();

    await client.generateImage({ model: 'm', prompt: 'p' });
    const sent = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect('size' in sent).toBe(false);
  });

  it('缺省选项(xd 装配零参数变化):size 缺省仍发 auto,edit 仍可用', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => okImageResponse(),
    );
    const client = createGatewayImageClient({
      getApiKey: () => 'k',
      proxy,
      fetchImplementation: fetchMock as unknown as typeof fetch,
    });
    await client.generateImage({ model: 'gpt-image-2', prompt: 'p' });
    const sent = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(sent.size).toBe('auto');
  });
});
