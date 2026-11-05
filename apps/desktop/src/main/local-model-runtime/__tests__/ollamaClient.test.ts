import { describe, expect, it, vi } from 'vitest';

import { fetchOllamaShow, fetchOllamaVersion, OllamaHttpError } from '../ollamaClient.js';

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

describe('fetchOllamaShow context windows', () => {
  it('uses parameters.num_ctx as the working window and keeps GGUF context as the maximum', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      parameters: 'num_ctx 32768\ntemperature 0.2',
      model_info: { 'general.context_length': 1_048_576 },
    }), { status: 200 }));
    await expect(fetchOllamaShow(fetchImpl, 'qwen3:latest')).resolves.toMatchObject({
      contextLength: 32_768,
      contextLengthMax: 1_048_576,
    });
  });

  it('falls back to the conservative Ollama default when num_ctx is absent', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      model_info: { 'general.context_length': 1_048_576 },
    }), { status: 200 }));
    await expect(fetchOllamaShow(fetchImpl, 'llama3:latest')).resolves.toMatchObject({
      contextLength: 4_096,
      contextLengthMax: 1_048_576,
    });
  });
});
