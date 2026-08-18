import { beforeEach, describe, expect, it, vi } from 'vitest';

const serverApiFetchMock = vi.hoisted(() => vi.fn());
const readModelDisableOverridesMock = vi.hoisted(() => vi.fn());

vi.mock('../../serverApiClient.js', () => ({
  serverApiFetch: serverApiFetchMock,
  ServerApiError: class ServerApiError extends Error {
    constructor(
      readonly code: string,
      readonly statusCode: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock('../../clientEndpointsService.js', () => ({
  getClientEndpoint: vi.fn(() => 'https://model-access.example.com'),
}));
vi.mock('../../maker-host/model-disable-store.js', () => ({
  readModelDisableOverrides: readModelDisableOverridesMock,
}));

import {
  fetchMediaInvocationGuide,
  listAvailableMediaModels,
  MediaGuideCompatibilityError,
} from '../mediaModels.js';

const payload = {
  schemaVersion: 4 as const,
  models: [
    {
      id: 'image-without-guide',
      name: 'Image Without Guide',
      mode: 'image_generation',
      currency: 'CNY' as const,
      agents: [],
      modalities: { input: ['text'], output: ['image'] },
    },
    {
      id: 'image-with-guide',
      name: 'Image With Guide',
      mode: 'image_generation',
      currency: 'CNY' as const,
      agents: [],
      modalities: { input: ['text', 'image'], output: ['image'] },
    },
    {
      id: 'video-without-guide',
      name: 'Video Without Guide',
      mode: 'video_generation',
      currency: 'CNY' as const,
      agents: [],
      modalities: { input: ['text', 'image'], output: ['video'] },
    },
    {
      id: 'guide-only-chat',
      name: 'Guide Only Chat',
      mode: 'chat',
      currency: 'CNY' as const,
      contextWindow: 200_000,
      agents: ['codex' as const],
      perAgent: {
        codex: { wireProtocol: 'openai-responses' as const },
      },
    },
  ],
};

describe('listAvailableMediaModels', () => {
  beforeEach(() => {
    serverApiFetchMock.mockReset().mockResolvedValue(payload);
    readModelDisableOverridesMock.mockReset().mockReturnValue({});
  });

  it('不带操作筛选时按 Gateway mode 返回图片/视频模型', async () => {
    await expect(listAvailableMediaModels()).resolves.toMatchObject([
      { id: 'image-without-guide' },
      { id: 'image-with-guide' },
      { id: 'video-without-guide' },
    ]);
  });

  it('带操作筛选时按 Gateway modalities 判断模型能力', async () => {
    await expect(listAvailableMediaModels('image.generate')).resolves.toMatchObject([
      { id: 'image-without-guide', modalities: { input: ['text'], output: ['image'] } },
      {
        id: 'image-with-guide',
        modalities: { input: ['text', 'image'], output: ['image'] },
      },
    ]);
    await expect(listAvailableMediaModels('image.edit')).resolves.toMatchObject([
      {
        id: 'image-with-guide',
        modalities: { input: ['text', 'image'], output: ['image'] },
      },
    ]);
  });

  it('叠加客户端现有 XD provider/model 停用准入', async () => {
    readModelDisableOverridesMock.mockReturnValueOnce({
      disabledModels: { 'xd:image-without-guide': true },
    });
    await expect(listAvailableMediaModels('image.generate')).resolves.toMatchObject([
      { id: 'image-with-guide' },
    ]);

    readModelDisableOverridesMock.mockReturnValueOnce({ disabledProviders: { xd: true } });
    await expect(listAvailableMediaModels()).resolves.toEqual([]);
  });

  it('拒绝旧版聊天目录，不把版本不匹配静默解释为空媒体列表', async () => {
    serverApiFetchMock.mockResolvedValueOnce({ ...payload, schemaVersion: 3 });

    await expect(listAvailableMediaModels()).rejects.toMatchObject({
      name: 'MediaModelCatalogError',
    });
  });

  it('只用 modelId 获取 Cindy Server Guide', async () => {
    serverApiFetchMock.mockResolvedValueOnce({
      modelId: 'image-with-guide',
      guide: {
        schemaVersion: 1,
        guideId: 'images-v1',
        revision: '2026-08-13.1',
        connection: { providerId: 'xd' },
        operations: [
          {
            capability: 'image.generate',
            request: {
              method: 'POST',
              path: '/images/generations',
              bodyEncoding: 'json',
              bodyModelPath: ['model'],
              timeoutMs: 1_000,
              maxRequestBytes: 1_024,
              maxResponseBytes: 1_024,
            },
            response: {
              mode: 'sync',
              media: [
                {
                  path: ['data', '*', 'url'],
                  encoding: 'url',
                  kind: 'image',
                  allowedUrlHosts: ['example.com'],
                },
              ],
            },
            instructions: '按协议组装请求。',
            exampleBody: { prompt: 'hello' },
            inputSchema: { type: 'object' },
            officialDocs: 'https://example.com/images-api',
          },
        ],
      },
    });

    await expect(fetchMediaInvocationGuide('image-with-guide')).resolves.toMatchObject({
      modelId: 'image-with-guide',
      guide: { guideId: 'images-v1', revision: '2026-08-13.1' },
    });
    expect(serverApiFetchMock).toHaveBeenLastCalledWith(
      '/api/model-access/invocation-guide?modelId=image-with-guide',
      expect.any(Object),
    );
  });

  it('把更高 Guide schemaVersion 分类为客户端需要升级', async () => {
    serverApiFetchMock.mockResolvedValueOnce({
      modelId: 'image-with-guide',
      guide: { schemaVersion: 2 },
    });

    await expect(fetchMediaInvocationGuide('image-with-guide')).rejects.toMatchObject({
      code: 'CLIENT_UPGRADE_REQUIRED',
    } satisfies Partial<MediaGuideCompatibilityError>);
  });
});
