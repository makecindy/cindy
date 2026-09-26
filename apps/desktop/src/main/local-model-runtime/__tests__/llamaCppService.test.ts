import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import path from 'node:path';
const mocks = vi.hoisted(() => ({ download: vi.fn(), resolve: vi.fn(), spawn: vi.fn() }));
vi.mock('../../maker-host/model-context-limit-store.js', () => ({
  readModelContextLimits: () => ({}),
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: mocks.spawn,
}));
vi.mock('node:net', () => ({
  createServer: () => ({
    once() {},
    listen(_port: number, _host: string, cb: () => void) {
      cb();
    },
    close(cb: () => void) {
      cb();
    },
  }),
}));
vi.mock('../llamaCppDownloads.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../llamaCppDownloads.js')>()),
  downloadLlamaCppAsset: mocks.download,
  resolveHfRepository: mocks.resolve,
}));
import { createLlamaCppService, managedModelId } from '../llamaCppService.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'cindy-llamacpp-service-test-'));
  mocks.resolve.mockResolvedValue({
    revision: 'a'.repeat(40),
    files: [{ name: 'model.gguf', size: 4, sha256: 'a'.repeat(64) }],
  });
  mocks.download.mockImplementation(async (_asset, dest) => writeFile(dest, 'GGUF'));
});
afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe('managed llama.cpp model lifecycle', () => {
  it.each(['resume', 'cancel'] as const)(
    'settles a paused download through %s without publishing partial files',
    async (action) => {
      const service = createLlamaCppService(root);
      let began!: () => void;
      const started = new Promise<void>((resolve) => {
        began = resolve;
      });
      mocks.download.mockImplementationOnce(
        async (_asset, _dest, _source, signal: AbortSignal, progress) =>
          new Promise((_resolve, reject) => {
            progress(2);
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('paused', 'AbortError')),
              { once: true },
            );
            began();
          }),
      );
      const running = service.download({ repo: 'owner/repo', file: 'model.gguf' });
      const settled = running.then(
        () => 'complete',
        () => 'cancelled',
      );
      await started;
      service.pause();
      await vi.waitFor(async () =>
        expect((await service.snapshot()).operation).toMatchObject({ paused: true, completed: 2 }),
      );
      expect((await service.snapshot()).models).toEqual([]);
      if (action === 'resume') {
        service.resume();
        expect(await settled).toBe('complete');
        expect((await service.snapshot()).models).toHaveLength(1);
        expect(mocks.resolve).toHaveBeenCalledOnce();
      } else {
        service.cancel();
        expect(await settled).toBe('cancelled');
        expect((await service.snapshot()).models).toEqual([]);
      }
      expect((await service.snapshot()).operation).toBeUndefined();
    },
  );
  it('refreshes the router on next use after a download, never during the download', async () => {
    const runtime = path.join(root, 'llamacpp-runtime');
    await mkdir(runtime);
    await writeFile(path.join(runtime, 'server'), 'stub');
    await writeFile(
      path.join(runtime, 'current.json'),
      JSON.stringify({ binary: 'server', version: 'test' }),
    );
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      return Object.assign(child, {
        kill: vi.fn(() => {
          child.emit('exit');
          return true;
        }),
      });
    });
    let processing = false;
    let limits: Record<string, number> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        Response.json(
          url.endsWith('/v1/models')
            ? { data: [{ id: 'loaded', status: { value: 'loaded' } }] }
            : url.includes('/slots?')
              ? [{ is_processing: processing }]
              : { status: 'ok' },
        ),
      ),
    );
    const service = createLlamaCppService(root, () => limits);
    try {
      await service.start();
      await service.download({ repo: 'owner/repo', file: 'model.gguf' });
      await service.download({ repo: 'bartowski/Qwen3.8-Flash-Next-GGUF', file: 'model.gguf' });
      expect(mocks.spawn).toHaveBeenCalledOnce();
      await service.start();
      const ini = await readFile(path.join(runtime, 'models.ini'), 'utf8');
      expect(ini).toContain(
        `[${managedModelId('bartowski/Qwen3.8-Flash-Next-GGUF', 'model.gguf')}]\nctx-size = 262144`,
      );
      expect(ini).toContain(`[${managedModelId('owner/repo', 'model.gguf')}]\nctx-size = 32768`);
      expect(mocks.spawn.mock.calls[1]![1]).toContain('--models-preset');
      expect(mocks.spawn.mock.calls[1]![1]).not.toContain('--ctx-size');
      expect(mocks.spawn).toHaveBeenCalledTimes(2);
      await service.start();
      expect(mocks.spawn).toHaveBeenCalledTimes(2);
      const modelId = managedModelId('bartowski/Qwen3.8-Flash-Next-GGUF', 'model.gguf');
      limits = { [`pi:cindy-local-llamacpp:${modelId}`]: 1_000_000 };
      processing = true;
      await expect(service.start()).rejects.toThrow('BUSY');
      expect(mocks.spawn).toHaveBeenCalledTimes(2);
      expect(await readFile(path.join(runtime, 'models.ini'), 'utf8')).toBe(ini);
      processing = false;
      await Promise.all([service.start(), service.start()]);
      expect(mocks.spawn).toHaveBeenCalledTimes(3);
      const extended = await readFile(path.join(runtime, 'models.ini'), 'utf8');
      expect(extended).toContain(
        `[${modelId}]\nctx-size = 1000000\nrope-scaling = yarn\nrope-scale = 4\nyarn-orig-ctx = 262144`,
      );
      limits = {};
      await service.start();
      expect(await readFile(path.join(runtime, 'models.ini'), 'utf8')).toBe(ini);
    } finally {
      service.dispose();
    }
  });
  it('persists complete downloads across restarts without exposing partial files', async () => {
    const service = createLlamaCppService(root);
    await service.download({ repo: 'owner/repo', file: 'model.gguf' });
    expect((await createLlamaCppService(root).snapshot()).models).toEqual([
      {
        id: managedModelId('owner/repo', 'model.gguf'),
        repo: 'owner/repo',
        file: 'model.gguf',
        size: 4,
      },
    ]);
    await service.download({ repo: 'owner/repo', file: 'model.gguf' });
    expect(mocks.download).toHaveBeenCalledOnce();
  });
  it('cleans failed downloads and releases the operation for retry', async () => {
    const service = createLlamaCppService(root);
    mocks.download.mockRejectedValueOnce(new Error('DOWNLOAD_CHECKSUM'));
    await expect(service.download({ repo: 'owner/repo', file: 'model.gguf' })).rejects.toThrow(
      'DOWNLOAD_CHECKSUM',
    );
    expect((await service.snapshot()).operation).toBeUndefined();
    expect(await readdir(path.join(root, 'llamacpp-runtime'))).toEqual(['models']);
    expect((await service.snapshot()).models).toEqual([]);
    await service.download({ repo: 'owner/repo', file: 'model.gguf' });
    expect((await service.snapshot()).models).toHaveLength(1);
  });
  it('blocks overlapping writes and cancellation never publishes a model', async () => {
    const service = createLlamaCppService(root);
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    mocks.download.mockImplementation(
      async (_asset, _dest, _source, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('cancelled', 'AbortError')),
            { once: true },
          );
          began();
        }),
    );
    const running = service.download({ repo: 'owner/repo', file: 'model.gguf' });
    await started;
    expect((await service.snapshot()).operation?.model).toEqual({
      repo: 'owner/repo',
      file: 'model.gguf',
    });
    await expect(service.download({ repo: 'owner/other', file: 'model.gguf' })).rejects.toThrow(
      'BUSY',
    );
    service.cancel();
    await expect(running).rejects.toThrow('cancelled');
    expect((await service.snapshot()).models).toEqual([]);
    expect((await service.snapshot()).operation).toBeUndefined();
  });
});
