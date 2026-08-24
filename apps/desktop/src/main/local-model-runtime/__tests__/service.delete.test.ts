import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../managedOllamaProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../managedOllamaProvider.js')>();
  return {
    ...actual,
    removeManagedOllamaModel: vi.fn(async () => ({
      ok: true,
      created: false,
      provider: actual.buildEmptyManagedOllamaProvider(),
    })),
  };
});

import { createLocalModelService, PullBusyError } from '../service.js';
import { removeManagedOllamaModel } from '../managedOllamaProvider.js';

describe('deleteInstalled', () => {
  beforeEach(() => {
    vi.mocked(removeManagedOllamaModel).mockClear();
  });

  it('deletes the Ollama model and removes it from Cindy', async () => {
    const deleteModel = vi.fn(async () => undefined);
    const service = createLocalModelService({
      deleteModel,
      fetchImpl: async () => new Response(JSON.stringify({ models: [] })),
    });

    await expect(service.deleteInstalled('qwen3.8:27b-mxfp8')).resolves.toMatchObject({
      ok: true,
    });
    expect(deleteModel).toHaveBeenCalledWith('qwen3.8:27b-mxfp8');
    expect(removeManagedOllamaModel).toHaveBeenCalledWith('qwen3.8:27b-mxfp8', {
      stillActive: undefined,
    });
  });

  it('keeps the Cindy entry when Ollama delete fails', async () => {
    const deleteModel = vi.fn(async () => {
      throw new Error('ollama /api/delete failed (500)');
    });
    const service = createLocalModelService({
      deleteModel,
      fetchImpl: async () => new Response(JSON.stringify({ models: [] })),
    });

    await expect(service.deleteInstalled('qwen3.8:27b-mxfp8')).rejects.toThrow(
      'ollama /api/delete failed (500)',
    );
    expect(removeManagedOllamaModel).not.toHaveBeenCalled();
  });

  it('rejects while that model is still downloading', async () => {
    const deleteModel = vi.fn(async () => undefined);
    const streamPull = vi.fn((_name: string, _onEvent: unknown, signal?: AbortSignal) => {
      return new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    const service = createLocalModelService({
      deleteModel,
      streamPull,
      fetchImpl: async () => new Response(JSON.stringify({ models: [] })),
    });
    const pulling = service.pull('gpt-oss:20b');
    await expect(service.deleteInstalled('gpt-oss:20b')).rejects.toBeInstanceOf(PullBusyError);
    await expect(service.deleteInstalled('llama3.1:8b')).resolves.toMatchObject({ ok: true });
    expect(deleteModel).toHaveBeenCalledWith('llama3.1:8b');
    expect(deleteModel).not.toHaveBeenCalledWith('gpt-oss:20b');
    await expect(service.deleteInstalled('gpt-oss:20b')).rejects.toThrow(
      'cannot change this model while it is downloading',
    );
    await service.abortPull('pause', 'gpt-oss:20b');
    await pulling.catch(() => undefined);
  });

  it('rejects invalid names before calling Ollama', async () => {
    const deleteModel = vi.fn(async () => undefined);
    const service = createLocalModelService({
      deleteModel,
      fetchImpl: async () => new Response(JSON.stringify({ models: [] })),
    });

    await expect(service.deleteInstalled('../etc/passwd')).rejects.toThrow(
      'invalid ollama model name',
    );
    expect(deleteModel).not.toHaveBeenCalled();
    expect(removeManagedOllamaModel).not.toHaveBeenCalled();
  });

  it('deletes a Hugging Face URL after normalizing the name', async () => {
    const deleteModel = vi.fn(async () => undefined);
    const service = createLocalModelService({
      deleteModel,
      fetchImpl: async () => new Response(JSON.stringify({ models: [] })),
    });
    await expect(
      service.deleteInstalled('https://huggingface.co/unsloth/Qwen3.8-27B-GGUF'),
    ).resolves.toMatchObject({ ok: true });
    expect(deleteModel).toHaveBeenCalledWith('hf.co/unsloth/Qwen3.8-27B-GGUF');
    expect(removeManagedOllamaModel).toHaveBeenCalledWith('hf.co/unsloth/Qwen3.8-27B-GGUF', {
      stillActive: undefined,
    });
  });
});

