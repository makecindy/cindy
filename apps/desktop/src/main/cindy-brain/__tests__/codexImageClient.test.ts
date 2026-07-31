import { describe, expect, it, vi } from 'vitest';

import { createCodexImageChannel } from '../codexImageClient.js';

function sseResponse(events: unknown[], status = 200): Response {
  const body =
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

function makeChannel(
  fetchImplementation: typeof fetch,
  beforeDispatch?: (model: string) => void,
  onAuthFailure?: Parameters<typeof createCodexImageChannel>[0]['onAuthFailure'],
) {
  return createCodexImageChannel({
    hasOAuthLogin: () => true,
    getAuth: async () => ({ accessToken: 'oauth-token', accountId: 'account-id' }),
    fetchImplementation,
    beforeDispatch,
    onAuthFailure,
  });
}

describe('codexImageClient', () => {
  it('用 Codex OAuth hosted image_generation tool 生成 gpt-image-2', async () => {
    const doFetch = vi.fn<typeof fetch>(async () =>
      sseResponse([
        {
          type: 'response.output_item.done',
          item: { type: 'image_generation_call', result: 'aW1hZ2U=' },
        },
      ]),
    );
    const channel = makeChannel(doFetch);
    const result = await channel.generateImage({
      model: 'openai/gpt-image-2',
      prompt: '一只猫',
      aspectRatio: '3:2',
    });

    expect(result.data[0]?.b64_json).toBe('aW1hZ2U=');
    const [url, init] = doFetch.mock.calls[0]!;
    expect(String(url)).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect((init?.headers as Record<string, string>)['ChatGPT-Account-Id']).toBe('account-id');
    const body = JSON.parse(String(init?.body)) as {
      tools: Array<Record<string, unknown>>;
      tool_choice?: unknown;
    };
    expect(body.tools).toContainEqual(
      expect.objectContaining({
        type: 'image_generation',
        model: 'gpt-image-2',
        size: '1536x1024',
        quality: 'medium',
      }),
    );
    expect(body.tool_choice).toBeUndefined();
  });

  it('未指定画幅时保留 auto 语义;拒绝目录外模型', async () => {
    const doFetch = vi.fn<typeof fetch>(async () =>
      sseResponse([{ type: 'image_generation_call', result: 'aW1hZ2U=' }]),
    );
    const channel = makeChannel(doFetch);
    await channel.generateImage({ model: 'openai/gpt-image-2', prompt: 'p' });
    const body = JSON.parse(String(doFetch.mock.calls[0]?.[1]?.body)) as {
      tools: Array<Record<string, unknown>>;
    };
    expect(body.tools[0]).not.toHaveProperty('size');

    await expect(
      channel.generateImage({ model: 'openai/future-image', prompt: 'p' }),
    ).rejects.toThrow('不支持模型');
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it('保留流中最新 partial image;派发前重查可阻止出网', async () => {
    const doFetch = vi.fn<typeof fetch>(async () =>
      sseResponse([{ partial_image_b64: 'first' }, { partial_image_b64: 'final' }]),
    );
    const channel = makeChannel(doFetch);
    expect(
      (await channel.generateImage({ model: 'openai/gpt-image-2', prompt: 'p' })).data[0]?.b64_json,
    ).toBe('final');

    const blockedFetch = vi.fn<typeof fetch>();
    const blocked = makeChannel(blockedFetch, () => {
      throw new Error('模型已停用');
    });
    await expect(
      blocked.generateImage({ model: 'openai/gpt-image-2', prompt: 'p' }),
    ).rejects.toThrow('模型已停用');
    expect(blockedFetch).not.toHaveBeenCalled();
  });

  it('兼容 CRLF、无尾空行和坏帧,并释放 reader lock', async () => {
    const releaseLock = vi.spyOn(ReadableStreamDefaultReader.prototype, 'releaseLock');
    const body = [
      'data: {bad json}\r\n\r\n',
      `data: ${JSON.stringify({ partial_image_b64: 'crlf' })}\r\n\r\n`,
      `data: ${JSON.stringify({ type: 'image_generation_call', result: 'unterminated' })}`,
    ].join('');
    const channel = makeChannel(
      vi.fn<typeof fetch>(
        async () =>
          new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      ),
    );

    try {
      await expect(
        channel.generateImage({ model: 'openai/gpt-image-2', prompt: 'p' }),
      ).resolves.toMatchObject({ data: [{ b64_json: 'unterminated' }] });
      expect(releaseLock).toHaveBeenCalled();
    } finally {
      releaseLock.mockRestore();
    }
  });

  it('兼容单 CR 的 SSE 事件与行结束符', async () => {
    const body = [
      'data: {bad json}\r\r',
      `data: ${JSON.stringify({ partial_image_b64: 'cr-only' })}\r\r`,
      'data: [DONE]\r\r',
    ].join('');
    const channel = makeChannel(
      vi.fn<typeof fetch>(
        async () =>
          new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      ),
    );

    await expect(
      channel.generateImage({ model: 'openai/gpt-image-2', prompt: 'p' }),
    ).resolves.toMatchObject({ data: [{ b64_json: 'cr-only' }] });
  });

  it('把认证失败与本次 token 交给失效协调器,且不让协调器异常覆盖 HTTP 错误', async () => {
    const raw = '{"error":{"code":"token_invalidated"}}';
    const onAuthFailure = vi.fn(async () => {
      throw new Error('invalidation failed');
    });
    const channel = makeChannel(
      vi.fn<typeof fetch>(async () => new Response(raw, { status: 401 })),
      undefined,
      onAuthFailure,
    );

    await expect(
      channel.generateImage({ model: 'openai/gpt-image-2', prompt: 'p' }),
    ).rejects.toThrow('HTTP 401');
    expect(onAuthFailure).toHaveBeenCalledWith({
      status: 401,
      body: raw,
      failedAccessToken: 'oauth-token',
    });
  });

  it('登录态决定 ready;缺 token 与空图片响应明确失败', async () => {
    const unavailable = createCodexImageChannel({
      hasOAuthLogin: () => false,
      getAuth: async () => {
        throw new Error('OpenAI 订阅登录已失效,请重新登录');
      },
      fetchImplementation: vi.fn<typeof fetch>(),
    });
    expect(unavailable.ready()).toBe(false);
    await expect(
      unavailable.generateImage({ model: 'openai/gpt-image-2', prompt: 'p' }),
    ).rejects.toThrow('重新登录');

    const empty = makeChannel(
      vi.fn<typeof fetch>(async () => sseResponse([{ type: 'response.completed' }])),
    );
    await expect(empty.generateImage({ model: 'openai/gpt-image-2', prompt: 'p' })).rejects.toThrow(
      '没有图片',
    );
  });
});
