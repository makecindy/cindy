import { beforeEach, describe, expect, it, vi } from 'vitest';

const serverApiFetchMock = vi.hoisted(() => vi.fn());
const readModelDisableOverridesMock = vi.hoisted(() => vi.fn());
const listProviderMediaModelsMock = vi.hoisted(() => vi.fn());

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
vi.mock('../../cindy-media/providerMediaRuntime.js', () => ({
  listProviderMediaModels: listProviderMediaModelsMock,
}));

import {
  fetchMediaInvocationGuide,
  isMediaModelExecutable,
  isMediaModelExecutableForGuide,
  listAvailableMediaModels,
  listExecutableMediaModels,
  MediaGuideCompatibilityError,
  resetExecutableMediaModelCache,
} from '../mediaModels.js';

const payload = {
  schemaVersion: 5 as const,
  accountTier: 'free' as const,
  models: [
    {
      id: 'image-without-guide',
      name: 'Image Without Guide',
      mode: 'image_generation',
      availability: 'available' as const,
      currency: 'CNY' as const,
      agents: [],
      modalities: { input: ['text'], output: ['image'] },
    },
    {
      id: 'image-with-guide',
      name: 'Image With Guide',
      mode: 'image_generation',
      availability: 'available' as const,
      currency: 'CNY' as const,
      agents: [],
      modalities: { input: ['text', 'image'], output: ['image'] },
    },
    {
      id: 'video-without-guide',
      name: 'Video Without Guide',
      mode: 'video_generation',
      availability: 'available' as const,
      currency: 'CNY' as const,
      agents: [],
      modalities: { input: ['text', 'image'], output: ['video'] },
    },
    {
      id: 'guide-only-chat',
      name: 'Guide Only Chat',
      mode: 'chat',
      availability: 'available' as const,
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
    resetExecutableMediaModelCache();
    serverApiFetchMock.mockReset().mockResolvedValue(payload);
    readModelDisableOverridesMock.mockReset().mockReturnValue({});
    listProviderMediaModelsMock.mockReset().mockReturnValue([]);
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

  it('同名媒体模型按 providerId 保留为两个可选来源', async () => {
    listProviderMediaModelsMock.mockReturnValue([
      {
        id: 'image-with-guide',
        name: 'Provider Image',
        providerId: 'openai',
        mode: 'image_generation',
        modalities: { input: ['text', 'image'], output: ['image'] },
      },
    ]);

    const models = await listAvailableMediaModels('image.generate');

    expect(models.filter((model) => model.id === 'image-with-guide')).toMatchObject([
      { id: 'image-with-guide', providerId: 'xd' },
      { id: 'image-with-guide', providerId: 'openai' },
    ]);
  });

  it('xAI provider 图片模型在媒体目录中保留来源身份', async () => {
    listProviderMediaModelsMock.mockReturnValue([
      {
        id: 'xai/grok-imagine-image',
        name: 'Grok Imagine Image',
        providerId: 'xai',
        mode: 'image_generation',
        modalities: { input: ['text', 'image'], output: ['image'] },
      },
    ]);

    await expect(listAvailableMediaModels('image.edit')).resolves.toContainEqual(
      expect.objectContaining({ id: 'xai/grok-imagine-image', providerId: 'xai' }),
    );
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

  it('v5 目录不会把需要付费的媒体模型暴露为可用模型', async () => {
    serverApiFetchMock.mockResolvedValueOnce({
      ...payload,
      models: [
        payload.models[1],
        {
          ...payload.models[0],
          id: 'paid-image',
          availability: 'requires_payment',
        },
      ],
    });

    await expect(listAvailableMediaModels('image.generate')).resolves.toMatchObject([
      { id: 'image-with-guide', availability: 'available' },
    ]);
    expect(serverApiFetchMock).toHaveBeenCalledWith(
      '/api/model-access/models?schemaVersion=5',
      expect.any(Object),
    );
  });

  it('namespaced modelId 唯一时继承旧裸 ID 的停用项', async () => {
    serverApiFetchMock.mockResolvedValueOnce({
      ...payload,
      models: [{ ...payload.models[1], id: 'openai/image-with-guide' }],
    });
    readModelDisableOverridesMock.mockReturnValueOnce({
      disabledModels: { 'xd:image-with-guide': true },
    });

    await expect(listAvailableMediaModels('image.generate')).resolves.toEqual([]);
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

  it('只在 Guide 查询边界移除 modelId namespace', async () => {
    serverApiFetchMock.mockResolvedValueOnce({
      modelId: 'gpt-image-2',
      guide: {
        schemaVersion: 1,
        guideId: 'openai-images-v1',
        revision: '2026-08-20.1',
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

    await expect(fetchMediaInvocationGuide('openai/gpt-image-2')).resolves.toMatchObject({
      modelId: 'gpt-image-2',
      guide: { guideId: 'openai-images-v1' },
    });
    expect(serverApiFetchMock).toHaveBeenLastCalledWith(
      '/api/model-access/invocation-guide?modelId=gpt-image-2',
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

  it('批量预检缓存 modelId 对应的协议 Guide', async () => {
    const modelId = 'openai/image-with-guide';
    const paidModelId = 'openai/paid-image';
    const guide = {
      schemaVersion: 1 as const,
      guideId: 'openai-images-v1',
      revision: '2026-08-20.1',
      connection: { providerId: 'xd' },
      operations: [
        {
          capability: 'image.generate' as const,
          request: {
            method: 'POST' as const,
            path: '/images/generations',
            bodyEncoding: 'json' as const,
            bodyModelPath: ['model'],
            timeoutMs: 1_000,
            maxRequestBytes: 1_024,
            maxResponseBytes: 1_024,
          },
          response: {
            mode: 'sync' as const,
            media: [
              {
                path: ['data', '*', 'url'],
                encoding: 'url' as const,
                kind: 'image' as const,
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
    };
    serverApiFetchMock.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/model-access/models')) {
        return {
          ...payload,
          models: [
            { ...payload.models[1], id: modelId },
            {
              ...payload.models[1],
              id: paidModelId,
              availability: 'requires_payment',
            },
          ],
        };
      }
      if (path === '/api/model-access/invocation-guides') {
        return {
          guides: [
            { modelId, guide },
            { modelId: paidModelId, guide: { ...guide, guideId: 'paid-images-v1' } },
          ],
        };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    await expect(
      listExecutableMediaModels(['image.generate'], { forceRefresh: true }),
    ).resolves.toMatchObject({ models: [{ id: modelId }] });
    expect(
      isMediaModelExecutableForGuide(modelId, 'openai-images-v1', 'image.generate'),
    ).toBe(true);
    expect(
      isMediaModelExecutableForGuide(modelId, 'other-images-v1', 'image.generate'),
    ).toBe(false);
    expect(isMediaModelExecutable(paidModelId, 'image.generate')).toBe(false);
  });
});
