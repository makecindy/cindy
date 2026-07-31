import { describe, expect, it, vi } from 'vitest';

import { createCodexImageChannel } from '../codexImageClient.js';

function sseResponse(events: unknown[], status = 200): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

function makeChannel(fetchImplementation: typeof fetch, beforeDispatch?: (model: string) => void) {
  return createCodexImageChannel({
    hasOAuthLogin: () => true,
    getAccessToken: async () => 'oauth-token',
    getAccountId: async () => 'account-id',
    fetchImplementation,
    beforeDispatch,
  });
}

describe('codexImageClient', () => {
  it('用 Codex OAuth hosted image_generation tool 生成 gpt-image-2', async () => {
    const doFetch = vi.fn<typeof fetch>(async () =>
      sseResponse([{ type: 'response.output_item.done', item: { type: 'image_generation_call', result: 'aW1hZ2U=' } }]),
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
    expect(body.tools).toContainEqual(expect.objectContaining({
      type: 'image_generation',
      model: 'gpt-image-2',
      size: '1536x1024',
      quality: 'medium',
    }));
    expect(body.tool_choice).toBeUndefined();
  });

  it('保留流中最新 partial image;派发前重查可阻止出网', async () => {
    const doFetch = vi.fn<typeof fetch>(async () =>
      sseResponse([{ partial_image_b64: 'first' }, { partial_image_b64: 'final' }]),
    );
    const channel = makeChannel(doFetch);
    expect((await channel.generateImage({ model: 'openai/gpt-image-2', prompt: 'p' })).data[0]?.b64_json)
      .toBe('final');

    const blockedFetch = vi.fn<typeof fetch>();
    const blocked = makeChannel(blockedFetch, () => { throw new Error('模型已停用'); });
    await expect(blocked.generateImage({ model: 'openai/gpt-image-2', prompt: 'p' }))
      .rejects.toThrow('模型已停用');
    expect(blockedFetch).not.toHaveBeenCalled();
  });

  it('登录态决定 ready;缺 token 与空图片响应明确失败', async () => {
    const unavailable = createCodexImageChannel({
      hasOAuthLogin: () => false,
      getAccessToken: async () => null,
      getAccountId: async () => null,
      fetchImplementation: vi.fn<typeof fetch>(),
    });
    expect(unavailable.ready()).toBe(false);
    await expect(unavailable.generateImage({ model: 'openai/gpt-image-2', prompt: 'p' }))
      .rejects.toThrow('重新登录');

    const empty = makeChannel(vi.fn<typeof fetch>(async () => sseResponse([{ type: 'response.completed' }])));
    await expect(empty.generateImage({ model: 'openai/gpt-image-2', prompt: 'p' }))
      .rejects.toThrow('没有图片');
  });
});
