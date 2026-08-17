/**
 * vision-channel 单元测试。
 *
 * 覆盖：resolveVisionBackendEndpoint（api-key / none / gateway-key / 不支持 OAuth 抛错）、
 * extractChatContent（string / array / 空）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { Provider } from '@cindy/model-providers';

import {
  describeImageWithProvider,
  extractChatContent,
  MAX_DESCRIPTION_CHARS,
  resolveVisionBackendEndpoint,
  VisionBackendError,
  type VisionChannelDeps,
} from '../vision-channel.js';

function fakeProvider(overrides: Partial<Provider>): Provider {
  return {
    id: 'user-x',
    name: 'User X',
    source: 'user',
    agents: ['claude-code', 'codex', 'pi'],
    auth: { method: 'apiKey' },
    routing: {
      'claude-code': {
        wireProtocol: 'openai-chat',
        upstream: 'https://api.example.com/v1',
        authStrategy: 'api-key-header',
      },
    },
    models: {
      'claude-code': [
        {
          id: 'vision-x',
          name: 'Vision X',
          contextWindow: 200000,
          efforts: ['low'],
          defaultEffort: null,
        },
      ],
    },
    ...overrides,
  };
}

function deps(overrides: Partial<VisionChannelDeps> = {}): VisionChannelDeps {
  return {
    getProviderById: () => fakeProvider({}),
    readCustomProviderKey: () => 'sk-test',
    readGatewayKey: () => 'gk-test',
    ...overrides,
  };
}

describe('resolveVisionBackendEndpoint', () => {
  it('resolves api-key-header backend with bearer authorization', () => {
    const ep = resolveVisionBackendEndpoint('user-x', 'vision-x', deps());
    expect(ep.upstream).toBe('https://api.example.com/v1');
    expect(ep.requestPath).toBe('/chat/completions');
    expect(ep.model).toBe('vision-x');
    expect(ep.authorization).toBe('Bearer sk-test');
  });

  it('resolves none-auth backend with null authorization', () => {
    const d = deps();
    d.getProviderById = () =>
      fakeProvider({
        routing: {
          'claude-code': {
            wireProtocol: 'openai-chat',
            upstream: 'https://ollama.local',
            authStrategy: 'none',
          },
        },
      });
    const ep = resolveVisionBackendEndpoint('user-x', 'vision-x', d);
    expect(ep.authorization).toBeNull();
  });

  it('resolves gateway-key backend with dynamic endpoint + gateway bearer', () => {
    const d = deps({ resolveGatewayEndpoint: () => 'https://tenant.gateway.xd/' });
    d.getProviderById = () =>
      fakeProvider({
        routing: {
          'claude-code': {
            wireProtocol: 'openai-chat',
            upstream: 'https://xd-gateway.invalid', // builtin 占位，真实入口走动态端点
            authStrategy: 'gateway-key',
          },
        },
      });
    const ep = resolveVisionBackendEndpoint('user-x', 'vision-x', d);
    // 动态租户端点覆盖占位 upstream（去尾斜杠）。
    expect(ep.upstream).toBe('https://tenant.gateway.xd');
    expect(ep.authorization).toBe('Bearer gk-test');
  });

  it('throws unavailable for gateway-key when no dynamic endpoint resolves', () => {
    const d = deps({ resolveGatewayEndpoint: () => null }); // 未登录 / 无 server 标记
    d.getProviderById = () =>
      fakeProvider({
        routing: {
          'claude-code': {
            wireProtocol: 'openai-chat',
            upstream: 'https://xd-gateway.invalid',
            authStrategy: 'gateway-key',
          },
        },
      });
    // 占位 upstream 不能被当作真实后端：无动态端点 → 判不可用。
    expect(() => resolveVisionBackendEndpoint('user-x', 'vision-x', d)).toThrow(/unavailable/);
  });

  it('throws unsupported-auth for oauth strategies', () => {
    const d = deps();
    d.getProviderById = () =>
      fakeProvider({
        routing: {
          'claude-code': {
            wireProtocol: 'openai-chat',
            upstream: 'https://api.example.com/v1',
            authStrategy: 'provider-oauth-header',
          },
        },
      });
    expect(() => resolveVisionBackendEndpoint('user-x', 'vision-x', d)).toThrow(VisionBackendError);
  });

  it('throws not-found when provider missing', () => {
    const d = deps({ getProviderById: () => null });
    expect(() => resolveVisionBackendEndpoint('nope', 'vision-x', d)).toThrow(/provider not found/);
  });
});

describe('extractChatContent', () => {
  it('extracts string content', () => {
    expect(extractChatContent({ choices: [{ message: { content: 'hello' } }] })).toBe('hello');
  });

  it('extracts array content parts', () => {
    expect(
      extractChatContent({
        choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }],
      }),
    ).toBe('ab');
  });

  it('returns null for empty', () => {
    expect(extractChatContent({ choices: [] })).toBeNull();
    expect(extractChatContent({})).toBeNull();
    expect(extractChatContent({ choices: [{ message: { content: '' } }] })).toBeNull();
  });
});

describe('describeImageWithProvider', () => {
  it('sends OpenAI chat request with image_url + auth, returns description', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'a red button' } }] }),
    } as unknown as Response);
    const d = deps({ fetch: fetchMock as unknown as typeof globalThis.fetch });
    const text = await describeImageWithProvider('user-x', 'vision-x', { imageUrl: 'https://x/y.png', prompt: 'what is this?' }, d);
    expect(text).toBe('a red button');
    // 请求发到 provider upstream + /chat/completions，带 auth 头 + image_url。
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(init.headers.authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('vision-x');
    expect(body.messages[0].content[1].image_url.url).toBe('https://x/y.png');
  });

  it('propagates HTTP error as VisionBackendError', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    } as unknown as Response);
    const d = deps({ fetch: fetchMock as unknown as typeof globalThis.fetch });
    await expect(
      describeImageWithProvider('user-x', 'vision-x', { imageUrl: 'data:image/png;base64,QUJD' }, d),
    ).rejects.toMatchObject({ code: 'http' });
  });

  it('throws empty on empty description', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '' } }] }),
    } as unknown as Response);
    const d = deps({ fetch: fetchMock as unknown as typeof globalThis.fetch });
    await expect(
      describeImageWithProvider('user-x', 'vision-x', { imageUrl: 'https://x/y.png' }, d),
    ).rejects.toMatchObject({ code: 'empty' });
  });

  it('throws unsupported-auth for oauth strategy without calling fetch', async () => {
    const fetchMock = vi.fn();
    const d = deps({ fetch: fetchMock as unknown as typeof globalThis.fetch });
    d.getProviderById = () =>
      fakeProvider({
        routing: {
          'claude-code': {
            wireProtocol: 'openai-chat',
            upstream: 'https://api.example.com/v1',
            authStrategy: 'provider-oauth-header',
          },
        },
      });
    await expect(
      describeImageWithProvider('user-x', 'vision-x', { imageUrl: 'https://x/y.png' }, d),
    ).rejects.toMatchObject({ code: 'unsupported-auth' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes caller abort signal to fetch via AbortSignal.any', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    } as unknown as Response);
    const d = deps({ fetch: fetchMock as unknown as typeof globalThis.fetch });
    const controller = new AbortController();
    await describeImageWithProvider('user-x', 'vision-x', { imageUrl: 'https://x/y.png', signal: controller.signal }, d);
    // fetch 收到的 signal 是组合 signal：abort caller 后它应变为 aborted。
    const init = fetchMock.mock.calls[0]?.[1] as { signal?: AbortSignal };
    expect(init?.signal).toBeTruthy();
    controller.abort();
    expect(init?.signal?.aborted).toBe(true);
  });

  it('fails fast when caller signal already aborted (no fetch)', async () => {
    const fetchMock = vi.fn();
    const d = deps({ fetch: fetchMock as unknown as typeof globalThis.fetch });
    const controller = new AbortController();
    controller.abort();
    await expect(
      describeImageWithProvider('user-x', 'vision-x', { imageUrl: 'https://x/y.png', signal: controller.signal }, d),
    ).rejects.toMatchObject({ code: 'abort' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('truncates over-long descriptions at MAX_DESCRIPTION_CHARS', async () => {
    const long = 'x'.repeat(MAX_DESCRIPTION_CHARS + 1000);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: long } }] }),
    } as unknown as Response);
    const d = deps({ fetch: fetchMock as unknown as typeof globalThis.fetch });
    const text = await describeImageWithProvider('user-x', 'vision-x', { imageUrl: 'https://x/y.png' }, d);
    expect(text.endsWith('[truncated]')).toBe(true);
    expect(text.length).toBeLessThan(MAX_DESCRIPTION_CHARS + 100);
  });

  it('maps fetch timeout to timeout code (AbortSignal.timeout fires)', async () => {
    // fetch 收到组合 signal（timeout + caller），timeout 触发时 signal abort → fetch reject。
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const d = deps({ fetch: fetchMock as unknown as typeof globalThis.fetch, timeoutMs: 30 });
    await expect(
      describeImageWithProvider('user-x', 'vision-x', { imageUrl: 'https://x/y.png' }, d),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('maps runtime caller abort to abort code', async () => {
    // fetch 挂起，调用方中途 abort → 组合 signal 触发 → abort。
    const controller = new AbortController();
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
    );
    const d = deps({ fetch: fetchMock as unknown as typeof globalThis.fetch });
    const p = describeImageWithProvider('user-x', 'vision-x', { imageUrl: 'https://x/y.png', signal: controller.signal }, d);
    setTimeout(() => controller.abort(), 10);
    await expect(p).rejects.toMatchObject({ code: 'abort' });
  });

  it('maps network failure to network code', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const d = deps({ fetch: fetchMock as unknown as typeof globalThis.fetch });
    await expect(
      describeImageWithProvider('user-x', 'vision-x', { imageUrl: 'https://x/y.png' }, d),
    ).rejects.toMatchObject({ code: 'network' });
  });

  it('sends local imagePath as data URL after magic-byte validation', async () => {
    // 写一个真实 PNG 魔数文件（sniffImageMime 要求 ≥12 字节）。
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vb-img-'));
    const imgPath = path.join(dir, 'test.png');
    writeFileSync(
      imgPath,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
    );
    try {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      } as unknown as Response);
      const d = deps({ fetch: fetchMock as unknown as typeof globalThis.fetch });
      await describeImageWithProvider('user-x', 'vision-x', { imagePath: imgPath }, d);
      const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
      const url = body.messages[0].content[1].image_url.url as string;
      expect(url.startsWith('data:image/png;base64,')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects non-image magic bytes without calling fetch', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vb-img-'));
    const imgPath = path.join(dir, 'fake.png');
    writeFileSync(imgPath, Buffer.from([0x50, 0x4b, 0x03, 0x04])); // ZIP 魔数
    try {
      const fetchMock = vi.fn();
      const d = deps({ fetch: fetchMock as unknown as typeof globalThis.fetch });
      const err = await describeImageWithProvider('user-x', 'vision-x', { imagePath: imgPath }, d).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ code: 'unsupported-image' });
      // P1-1：错误 message 脱敏，不含本地路径/文件名（日志可能被上传/外发）。
      expect(err).not.toMatchObject({ message: expect.stringContaining('fake.png') });
      expect(err).not.toMatchObject({ message: expect.stringContaining(imgPath) });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects oversized local images without leaking the path', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vb-img-'));
    const imgPath = path.join(dir, 'big.png');
    // 真实超大文件：toDataUrl 在 size 检查（stat 后）就拦截，不会到 magic-byte。
    writeFileSync(imgPath, Buffer.alloc(15 * 1024 * 1024 + 1));
    try {
      const fetchMock = vi.fn();
      const d = deps({ fetch: fetchMock as unknown as typeof globalThis.fetch });
      const err = await describeImageWithProvider('user-x', 'vision-x', { imagePath: imgPath }, d).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ code: 'unsupported-image' });
      // P1-1：too-large message 不含路径/文件名。
      expect(err).not.toMatchObject({ message: expect.stringContaining('big.png') });
      expect(err).not.toMatchObject({ message: expect.stringContaining(imgPath) });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends anthropic-messages request with image block when routing is anthropic', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'a blue sky' }] }),
    } as unknown as Response);
    const d = deps({ fetch: fetchMock as unknown as typeof globalThis.fetch });
    d.getProviderById = () =>
      fakeProvider({
        routing: {
          'claude-code': {
            wireProtocol: 'anthropic-messages',
            upstream: 'https://api.example.com',
            authStrategy: 'api-key-header',
          },
        },
      });
    const text = await describeImageWithProvider('user-x', 'vision-x', { imageUrl: 'data:image/png;base64,QUJD', prompt: 'what?' }, d);
    expect(text).toBe('a blue sky');
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    // anthropic-messages 缺省路径 /v1/messages + image block（data URL 转 base64 source）。
    expect(url).toBe('https://api.example.com/v1/messages');
    const body = JSON.parse(init.body);
    expect(body.messages[0].content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
    });
  });

  it('sends openai-responses request with input_image when routing is responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'a chart' }] }] }),
    } as unknown as Response);
    const d = deps({ fetch: fetchMock as unknown as typeof globalThis.fetch });
    d.getProviderById = () =>
      fakeProvider({
        routing: {
          codex: {
            wireProtocol: 'openai-responses',
            upstream: 'https://gateway.example.com/v1',
            authStrategy: 'api-key-header',
          },
        },
        agents: ['codex'],
        models: { codex: [] },
      });
    const text = await describeImageWithProvider('user-x', 'vision-x', { imageUrl: 'https://x/y.png', prompt: 'describe' }, d);
    expect(text).toBe('a chart');
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    // responses 缺省路径 /responses + input_image。
    expect(url).toBe('https://gateway.example.com/v1/responses');
    const body = JSON.parse(init.body);
    expect(body.input[0].content[1]).toEqual({ type: 'input_image', image_url: 'https://x/y.png' });
  });

  it('routes codex-prefixed model to codex face regardless of agent order', () => {
    const d = deps();
    d.getProviderById = () =>
      fakeProvider({
        agents: ['claude-code', 'codex'],
        routing: {
          'claude-code': {
            wireProtocol: 'anthropic-messages',
            upstream: 'https://cc.example.com',
            authStrategy: 'api-key-header',
          },
          codex: {
            wireProtocol: 'openai-responses',
            upstream: 'https://codex.example.com/v1',
            authStrategy: 'api-key-header',
          },
        },
        models: { 'claude-code': [], codex: [] },
      });
    // codex/ 前缀 → codex 面（即使 claude-code 在 agents 前面）。
    const ep = resolveVisionBackendEndpoint('user-x', 'codex/vision-model', d);
    expect(ep.upstream).toBe('https://codex.example.com/v1');
    expect(ep.wireProtocol).toBe('openai-responses');
    expect(ep.requestPath).toBe('/responses');
  });
});
