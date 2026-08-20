import { describe, expect, it } from 'vitest';

import { detectLocalConnectPresets } from '../localConnectDetect.js';

describe('detectLocalConnectPresets', () => {
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
});
