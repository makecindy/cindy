/**
 * geminiImageClient.test.ts — Gemini generateContent 图像通道的纯函数单测(fetch mock)。
 * 锁住:目录 id → upstream id 剥前缀、aspectRatio 直传、inlineData 响应适配、
 * 安全拦截/key 无效的人话话术、ready 语义、beforeDispatch 派发前重查。
 */

import { describe, expect, it, vi } from 'vitest';

import { createGeminiImageChannel } from '../geminiImageClient';

const okBody = () =>
  JSON.stringify({
    candidates: [
      { content: { parts: [{ text: 'here you go' }, { inlineData: { mimeType: 'image/png', data: 'aGk=' } }] } },
    ],
  });

function fetchMock(status = 200, body = okBody()) {
  return vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
    new Response(body, { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

describe('geminiImageClient', () => {
  it('剥 gemini/ 前缀拼 upstream 端点;x-goog-api-key 鉴权;inlineData 适配成统一响应形状', async () => {
    const doFetch = fetchMock();
    const channel = createGeminiImageChannel({
      getApiKey: () => 'test-key',
      fetchImplementation: doFetch as unknown as typeof fetch,
    });
    const res = await channel.generateImage({ model: 'gemini/gemini-3-pro-image', prompt: '一只猫' });
    expect(res.data[0].b64_json).toBe('aGk=');
    expect(res.output_format).toBe('png');
    const [url, init] = doFetch.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent',
    );
    expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key');
  });

  it('aspectRatio 直传 generationConfig.imageConfig;不传时载荷里没有该键', async () => {
    const doFetch = fetchMock();
    const channel = createGeminiImageChannel({
      getApiKey: () => 'k',
      fetchImplementation: doFetch as unknown as typeof fetch,
    });
    await channel.generateImage({ model: 'gemini/gemini-3-pro-image', prompt: 'p', aspectRatio: '2:3' });
    const withRatio = JSON.parse(String(doFetch.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(withRatio.generationConfig).toEqual({ responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '2:3' } });
    await channel.generateImage({ model: 'gemini/gemini-3-pro-image', prompt: 'p' });
    const without = JSON.parse(String(doFetch.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(without.generationConfig).toEqual({ responseModalities: ['TEXT', 'IMAGE'] });
  });

  it('ready = key 已配置;null 或空白串均视为未配置(不出网)', async () => {
    const doFetch = fetchMock();
    for (const key of [null, '', '   ']) {
      const channel = createGeminiImageChannel({
        getApiKey: () => key,
        fetchImplementation: doFetch as unknown as typeof fetch,
      });
      expect(channel.ready()).toBe(false);
      const err = await channel
        .generateImage({ model: 'gemini/gemini-3-pro-image', prompt: 'p' })
        .catch((e: unknown) => e);
      expect((err as Error).message).toContain('Gemini API key 未配置');
      expect(doFetch).not.toHaveBeenCalled();
    }
  });

  it('安全拦截(promptFeedback.blockReason)与 key 无效(400)都是人话报错', async () => {
    const blocked = createGeminiImageChannel({
      getApiKey: () => 'k',
      fetchImplementation: fetchMock(200, JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })) as unknown as typeof fetch,
    });
    const blockedErr = await blocked
      .generateImage({ model: 'gemini/gemini-3-pro-image', prompt: 'p' })
      .catch((e: unknown) => e);
    expect((blockedErr as Error).message).toContain('安全策略');

    const badKey = createGeminiImageChannel({
      getApiKey: () => 'k',
      fetchImplementation: fetchMock(400, JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.' } })) as unknown as typeof fetch,
    });
    const keyErr = await badKey
      .generateImage({ model: 'gemini/gemini-3-pro-image', prompt: 'p' })
      .catch((e: unknown) => e);
    expect((keyErr as Error).message).toContain('Gemini API key 无效');
  });

  it('beforeDispatch 抛错即取消付费提交,不出网(停用轴派发前重查)', async () => {
    const doFetch = fetchMock();
    const channel = createGeminiImageChannel({
      getApiKey: () => 'k',
      fetchImplementation: doFetch as unknown as typeof fetch,
      beforeDispatch: () => {
        throw new Error('图像模型已在设置中停用,本次生成已取消');
      },
    });
    const err = await channel
      .generateImage({ model: 'gemini/gemini-3-pro-image', prompt: 'p' })
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain('已在设置中停用');
    expect(doFetch).not.toHaveBeenCalled();
  });
});
