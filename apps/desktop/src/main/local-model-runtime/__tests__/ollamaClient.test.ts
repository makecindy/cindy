import { describe, expect, it, vi } from 'vitest';

import { fetchOllamaVersion, OllamaHttpError } from '../ollamaClient.js';

describe('fetchOllamaVersion', () => {
  it('accepts a version JSON body', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ version: '0.32.13' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(fetchOllamaVersion(fetchImpl)).resolves.toEqual({ version: '0.32.13' });
  });

  it('treats a non-Ollama HTTP body as a port conflict', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>not ollama</html>', { status: 200 }));
    await expect(fetchOllamaVersion(fetchImpl)).rejects.toMatchObject({
      kind: 'conflict',
    } satisfies Partial<OllamaHttpError>);
  });
});
