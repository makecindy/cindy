import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultProbeOpenAiModels, detectLocalConnectPresets } from '../localConnectDetect.js';

describe('detectLocalConnectPresets', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('treats LM Studio as present when the official app exists', async () => {
    await expect(
      detectLocalConnectPresets({
        platform: 'darwin',
        appExists: (filePath) => filePath === '/Applications/LM Studio.app',
        probe: async () => false,
      }),
    ).resolves.toEqual(['lmstudio']);
  });

  it('includes a local server only when its OpenAI models endpoint answers', async () => {
    await expect(
      detectLocalConnectPresets({
        platform: 'linux',
        appExists: () => false,
        probe: async (url) => url.includes(':8080'),
      }),
    ).resolves.toEqual(['llamacpp']);
    await expect(
      detectLocalConnectPresets({
        platform: 'linux',
        appExists: () => false,
        probe: async (url) => url.includes(':4000'),
      }),
    ).resolves.toEqual(['litellm']);
  });

  it('returns nothing when no local runtime is installed or listening', async () => {
    await expect(
      detectLocalConnectPresets({
        platform: 'darwin',
        appExists: () => false,
        probe: async () => false,
      }),
    ).resolves.toEqual([]);
  });

  it('does not treat an outbound redirect as a local runtime', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'x' }] }), {
        status: 302,
        headers: { location: 'https://evil.example/v1/models' },
      }),
    );
    vi.stubGlobal('fetch', fetchImpl);
    await expect(defaultProbeOpenAiModels('http://127.0.0.1:8080/v1/models')).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:8080/v1/models',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });
});
