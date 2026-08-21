import { describe, expect, it, vi } from 'vitest';

import { createLocalModelService } from '../service.js';
import type { PausedPullRecord } from '../pausedPullStore.js';

function memoryPausedStore(initial: PausedPullRecord[] = []) {
  const items = new Map(initial.map((item) => [item.name, item]));
  return {
    read: async (name?: string) => (name ? items.get(name) ?? null : [...items.values()][0] ?? null),
    readSync: (name?: string) => (name ? items.get(name) ?? null : [...items.values()][0] ?? null),
    readAll: async () => [...items.values()],
    readAllSync: () => [...items.values()],
    write: async (
      progress: { name: string; completed?: number; total?: number; percent?: number },
      digests: readonly string[],
    ) => {
      items.set(progress.name, {
        name: progress.name,
        completed: progress.completed,
        total: progress.total,
        percent: progress.percent,
        digests: [...digests],
        updatedAt: 1,
      });
    },
    remove: async (name: string) => {
      const record = items.get(name) ?? null;
      items.delete(name);
      return record;
    },
    clear: async () => {
      items.clear();
    },
  };
}

function hangingPull(signal?: AbortSignal) {
  return new Promise<void>((_resolve, reject) => {
    const fail = () => reject(new Error('aborted'));
    if (signal?.aborted) {
      fail();
      return;
    }
    signal?.addEventListener('abort', fail, { once: true });
  });
}

describe('local model pull state machine', () => {
  it('joins the same model and starts a second name in parallel', async () => {
    const streamPull = vi.fn((_name: string, _onEvent: unknown, signal?: AbortSignal) => hangingPull(signal));
    const service = createLocalModelService({
      streamPull,
      pausedPullStore: memoryPausedStore(),
      fetchImpl: async () => new Response(JSON.stringify({ models: [] })),
    });
    const first = service.pull('gpt-oss:20b');
    const joined = service.pull('gpt-oss:20b');
    const second = service.pull('llama3.1:8b');
    await vi.waitFor(() => {
      expect(streamPull).toHaveBeenCalledTimes(2);
    });
    expect(service.activePulls().map((item) => item.name).sort()).toEqual([
      'gpt-oss:20b',
      'llama3.1:8b',
    ]);
    expect(streamPull.mock.calls.filter((call) => call[0] === 'gpt-oss:20b')).toHaveLength(1);
    await service.abortPull('pause', 'gpt-oss:20b');
    await service.abortPull('pause', 'llama3.1:8b');
    const settled = await Promise.allSettled([first, joined, second]);
    expect(settled[0]?.status).toBe(settled[1]?.status);
  });

  it('does not re-download an untagged name already installed as :latest', async () => {
    const streamPull = vi.fn(async () => {
      throw new Error('should not pull');
    });
    const service = createLocalModelService({
      streamPull,
      fetchImpl: async (url) => {
        if (String(url).includes('/api/tags')) {
          return new Response(JSON.stringify({ models: [{ name: 'glm-4.7-flash:latest' }] }));
        }
        return new Response(JSON.stringify({ models: [] }));
      },
    });
    await service.pull('glm-4.7-flash').catch(() => undefined);
    expect(streamPull).not.toHaveBeenCalled();
  });

  it('joins an untagged pull with its :latest alias', async () => {
    const streamPull = vi.fn((_name: string, _onEvent: unknown, signal?: AbortSignal) => hangingPull(signal));
    const service = createLocalModelService({
      streamPull,
      pausedPullStore: memoryPausedStore(),
      fetchImpl: async () => new Response(JSON.stringify({ models: [] })),
    });
    const first = service.pull('glm-4.7-flash');
    const joined = service.pull('glm-4.7-flash:latest');
    await vi.waitFor(() => {
      expect(streamPull).toHaveBeenCalledTimes(1);
    });
    expect(service.activePulls().map((item) => item.name)).toEqual(['glm-4.7-flash']);
    await service.abortPull('pause', 'glm-4.7-flash:latest');
    const settled = await Promise.allSettled([first, joined]);
    expect(settled[0]?.status).toBe(settled[1]?.status);
  });

  it('does not re-download a model already present in local Ollama', async () => {
    const streamPull = vi.fn(async () => {
      throw new Error('should not pull');
    });
    const service = createLocalModelService({
      streamPull,
      fetchImpl: async (url) => {
        if (String(url).includes('/api/tags')) {
          return new Response(JSON.stringify({ models: [{ name: 'qwen3.8:27b-mxfp8' }] }));
        }
        return new Response(JSON.stringify({ models: [] }));
      },
    });
    await service.pull('qwen3.8:27b-mxfp8').catch(() => undefined);
    expect(streamPull).not.toHaveBeenCalled();
  });

  it('pause aborts the in-flight pull without starting another', async () => {
    let abortSeen = false;
    const streamPull = vi.fn((_name: string, _onEvent: unknown, signal?: AbortSignal) => {
      return new Promise<void>((_resolve, reject) => {
        const fail = () => {
          abortSeen = true;
          reject(new Error('aborted'));
        };
        if (signal?.aborted) {
          fail();
          return;
        }
        signal?.addEventListener('abort', fail, { once: true });
      });
    });
    const service = createLocalModelService({
      streamPull,
      pausedPullStore: memoryPausedStore(),
      fetchImpl: async () => new Response(JSON.stringify({ models: [] })),
    });
    const pulling = service.pull('gpt-oss:20b');
    await service.abortPull('pause', 'gpt-oss:20b');
    await pulling.catch(() => undefined);
    expect(abortSeen).toBe(true);
  });

  it('cancel deletes the local Ollama model and pause does not', async () => {
    const deleteModel = vi.fn(async () => undefined);
    const purgeCancelledPull = vi.fn(async () => undefined);
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
      streamPull,
      deleteModel,
      purgeCancelledPull,
      waitForCancelledBlobs: async () => undefined,
      pausedPullStore: memoryPausedStore(),
      fetchImpl: async () => new Response(JSON.stringify({ models: [] })),
    });
    const pulling = service.pull('gpt-oss:20b');
    await service.abortPull('cancel', 'gpt-oss:20b');
    await pulling.catch(() => undefined);
    expect(deleteModel).toHaveBeenCalledWith('gpt-oss:20b');
    expect(purgeCancelledPull).toHaveBeenCalledWith({
      name: 'gpt-oss:20b',
      digests: [],
      deleteAllIncomplete: false,
      pruneUnreferenced: false,
      deleteManifest: true,
      keepDigests: [],
    });
  });

  it('does not delete an untagged pull that Ollama already lists as :latest', async () => {
    const deleteModel = vi.fn(async () => undefined);
    const purgeCancelledPull = vi.fn(async () => undefined);
    const streamPull = vi.fn((_name: string, _onEvent: unknown, signal?: AbortSignal) => hangingPull(signal));
    let installed: Array<{ name: string }> = [];
    const service = createLocalModelService({
      streamPull,
      deleteModel,
      purgeCancelledPull,
      waitForCancelledBlobs: async () => undefined,
      pausedPullStore: memoryPausedStore(),
      fetchImpl: async (url) => {
        if (String(url).includes('/api/tags')) {
          return new Response(JSON.stringify({ models: installed }));
        }
        return new Response(JSON.stringify({ models: [] }));
      },
    });
    const pulling = service.pull('glm-4.7-flash');
    await vi.waitFor(() => {
      expect(streamPull).toHaveBeenCalled();
    });
    installed = [{ name: 'glm-4.7-flash:latest' }];
    await service.abortPull('cancel', 'glm-4.7-flash');
    await pulling.catch(() => undefined);
    expect(deleteModel).not.toHaveBeenCalled();
    expect(purgeCancelledPull).toHaveBeenCalledWith({
      name: 'glm-4.7-flash',
      digests: [],
      deleteAllIncomplete: false,
      pruneUnreferenced: false,
      deleteManifest: false,
      keepDigests: [],
    });
  });

  it('remembers a paused pull so a new service can resume or discard it', async () => {
    const pausedPullStore = memoryPausedStore();
    const streamPull = vi.fn((_name: string, _onEvent: unknown, signal?: AbortSignal) => hangingPull(signal));
    const first = createLocalModelService({
      streamPull,
      pausedPullStore,
      fetchImpl: async () => new Response(JSON.stringify({ models: [] })),
    });
    const pulling = first.pull('gpt-oss:20b');
    await first.abortPull('pause', 'gpt-oss:20b');
    await pulling.catch(() => undefined);

    const deleteModel = vi.fn(async () => undefined);
    const purgeCancelledPull = vi.fn(async () => undefined);
    const second = createLocalModelService({
      pausedPullStore,
      deleteModel,
      purgeCancelledPull,
      waitForCancelledBlobs: async () => undefined,
      fetchImpl: async () => new Response(JSON.stringify({ models: [] })),
    });
    expect(second.activePull()?.phase).toBe('paused');
    expect(second.activePull()?.name).toBe('gpt-oss:20b');
    await second.discardPaused('gpt-oss:20b');
    expect(second.activePull()).toBeNull();
    expect(deleteModel).toHaveBeenCalledWith('gpt-oss:20b');
    expect(purgeCancelledPull).toHaveBeenCalledWith({
      name: 'gpt-oss:20b',
      digests: [],
      deleteAllIncomplete: false,
      pruneUnreferenced: false,
      deleteManifest: true,
      keepDigests: [],
    });
  });

  it('keeps an in-flight pull after the process restarts', async () => {
    const pausedPullStore = memoryPausedStore();
    const first = createLocalModelService({
      streamPull: vi.fn((_name: string, _onEvent: unknown, signal?: AbortSignal) => hangingPull(signal)),
      pausedPullStore,
      fetchImpl: async () => new Response(JSON.stringify({ models: [] })),
    });
    const pulling = first.pull('qwen3.8:27b-mxfp8');
    void pulling.catch(() => undefined);
    await vi.waitFor(async () => {
      expect(await pausedPullStore.read('qwen3.8:27b-mxfp8')).not.toBeNull();
    });

    const second = createLocalModelService({
      pausedPullStore,
      fetchImpl: async () => new Response(JSON.stringify({ models: [] })),
    });
    expect(second.activePull()?.name).toBe('qwen3.8:27b-mxfp8');
    expect(second.activePull()?.phase).toBe('paused');
    await first.abortPull('cancel', 'qwen3.8:27b-mxfp8');
    await pulling.catch(() => undefined);
  });

  it('cancel purges layer blobs seen after the stream started', async () => {
    const deleteModel = vi.fn(async () => undefined);
    const purgeCancelledPull = vi.fn(async () => undefined);
    const streamPull = vi.fn(
      (
        _name: string,
        onEvent: (event: { status: string; digest?: string; completed?: number; total?: number }) => void,
        signal?: AbortSignal,
      ) => {
        onEvent({ status: 'downloading', digest: 'sha256:ccc', completed: 1, total: 10 });
        return new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error('aborted'));
            return;
          }
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    );
    const service = createLocalModelService({
      streamPull,
      deleteModel,
      purgeCancelledPull,
      waitForCancelledBlobs: async () => undefined,
      pausedPullStore: memoryPausedStore(),
      fetchImpl: async () => new Response(JSON.stringify({ models: [] })),
    });
    const pulling = service.pull('qwen3.8:27b-mxfp8');
    await vi.waitFor(() => {
      expect(streamPull).toHaveBeenCalled();
    });
    await service.abortPull('cancel', 'qwen3.8:27b-mxfp8');
    await pulling.catch(() => undefined);
    expect(purgeCancelledPull).toHaveBeenCalledWith({
      name: 'qwen3.8:27b-mxfp8',
      digests: ['sha256:ccc'],
      deleteAllIncomplete: false,
      pruneUnreferenced: false,
      deleteManifest: true,
      keepDigests: [],
    });
  });

  it('cancelling one download does not purge another in-flight pull', async () => {
    const purgeCancelledPull = vi.fn(async () => undefined);
    const streamPull = vi.fn(
      (
        _name: string,
        onEvent: (event: { status: string; digest?: string; completed?: number; total?: number }) => void,
        signal?: AbortSignal,
      ) => {
        onEvent({ status: 'downloading', digest: 'sha256:shared', completed: 1, total: 10 });
        return new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error('aborted'));
            return;
          }
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    );
    const service = createLocalModelService({
      streamPull,
      purgeCancelledPull,
      waitForCancelledBlobs: async () => undefined,
      pausedPullStore: memoryPausedStore(),
      fetchImpl: async () => new Response(JSON.stringify({ models: [] })),
    });
    const first = service.pull('gpt-oss:20b');
    const second = service.pull('llama3.1:8b');
    await vi.waitFor(() => {
      expect(streamPull).toHaveBeenCalledTimes(2);
    });
    await service.abortPull('cancel', 'gpt-oss:20b');
    await first.catch(() => undefined);
    expect(purgeCancelledPull).toHaveBeenCalledWith({
      name: 'gpt-oss:20b',
      digests: ['sha256:shared'],
      deleteAllIncomplete: false,
      pruneUnreferenced: false,
      deleteManifest: true,
      keepDigests: ['sha256:shared'],
    });
    expect(service.activePulls().map((item) => item.name)).toEqual(['llama3.1:8b']);
    await service.abortPull('cancel', 'llama3.1:8b');
    await second.catch(() => undefined);
  });

  it('does not delete a model that is already installed when discarding a pause', async () => {
    const deleteModel = vi.fn(async () => undefined);
    const purgeCancelledPull = vi.fn(async () => undefined);
    const pausedPullStore = memoryPausedStore();
    const first = createLocalModelService({
      streamPull: vi.fn((_name: string, _onEvent: unknown, signal?: AbortSignal) => hangingPull(signal)),
      pausedPullStore,
      fetchImpl: async () => new Response(JSON.stringify({ models: [] })),
    });
    const pulling = first.pull('gpt-oss:20b');
    await first.abortPull('pause', 'gpt-oss:20b');
    await pulling.catch(() => undefined);

    const second = createLocalModelService({
      pausedPullStore,
      deleteModel,
      purgeCancelledPull,
      waitForCancelledBlobs: async () => undefined,
      fetchImpl: async () => new Response(JSON.stringify({ models: [{ name: 'gpt-oss:20b' }] })),
    });
    await second.discardPaused('gpt-oss:20b');
    expect(deleteModel).not.toHaveBeenCalled();
    expect(purgeCancelledPull).toHaveBeenCalledWith({
      name: 'gpt-oss:20b',
      digests: [],
      deleteAllIncomplete: false,
      pruneUnreferenced: false,
      deleteManifest: false,
      keepDigests: [],
    });
  });

  it('does not resurrect a completed pull after flushing pending progress', async () => {
    vi.useFakeTimers();
    const pausedPullStore = memoryPausedStore();
    const streamPull = vi.fn(
      (
        _name: string,
        onEvent: (event: { status: string; digest?: string; completed?: number; total?: number }) => void,
      ) => {
        onEvent({ status: 'downloading', digest: 'sha256:abc', completed: 1, total: 10 });
        return Promise.resolve();
      },
    );
    const service = createLocalModelService({
      streamPull,
      pausedPullStore,
      fetchImpl: async () => new Response(JSON.stringify({ models: [] })),
    });
    try {
      await service.pull('gpt-oss:20b').catch(() => undefined);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await pausedPullStore.read('gpt-oss:20b')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
