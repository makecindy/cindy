import { describe, expect, it, vi } from 'vitest';

import { createGatewayImageClient, GatewayImageError } from '../gatewayImageClient.js';

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
