import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import path from 'node:path';
const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  resolve: vi.fn(),
  spawn: vi.fn(),
  rename: vi.fn(),
  killTree: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
}));
vi.mock('../../scheduler-host/proc-util.js', () => ({ killProcessTree: mocks.killTree }));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  rename: mocks.rename,
  readdir: mocks.readdir,
  readFile: mocks.readFile,
  stat: mocks.stat,
}));
vi.mock('../../reviewer/reviewOwnerLiveness.js', () => ({
  startReviewOwnerLiveness: async () => ({
    identity: { version: 1, port: 12345, token: 'test-owner' },
    close: async () => {},
  }),
  probeReviewOwnerLiveness: async () => 'alive',
}));
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
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  mocks.rename.mockImplementation(fs.rename);
  mocks.readdir.mockImplementation(fs.readdir);
  mocks.readFile.mockImplementation(fs.readFile);
  mocks.stat.mockImplementation(fs.stat);
  const proc = await vi.importActual<typeof import('../../scheduler-host/proc-util.js')>(
    '../../scheduler-host/proc-util.js',
  );
  mocks.killTree.mockImplementation(proc.killProcessTree);
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
  it.each(
    ['EACCES', 'EPERM', 'EIO'].flatMap((code) =>
      ['manifest', 'binary'].map((target) => ({ code, target })),
    ),
  )(
    'propagates $code from $target through status, startup and install, then recovers',
    async ({ code, target }) => {
      const runtime = path.join(root, 'llamacpp-runtime');
      await mkdir(runtime);
      const binary = path.join(runtime, 'server');
      await writeFile(binary, 'stub');
      await writeFile(
        path.join(runtime, 'current.json'),
        JSON.stringify({ binary: 'server', version: 'test' }),
      );
      const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      const error = Object.assign(new Error('runtime read failed'), { code });
      if (target === 'manifest')
        mocks.readFile.mockImplementation(async (file, ...args) => {
          if (String(file).endsWith('current.json')) throw error;
          return fs.readFile(file, ...args);
        });
      else
        mocks.stat.mockImplementation(async (file, ...args) => {
          if (String(file) === binary) throw error;
          return fs.stat(file, ...args);
        });
      const service = createLlamaCppService(root);
      await expect(service.snapshot()).rejects.toBe(error);
      await expect(service.start()).rejects.toBe(error);
      await expect(service.install()).rejects.toBe(error);
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(mocks.download).not.toHaveBeenCalled();
      mocks.readFile.mockImplementation(fs.readFile);
      mocks.stat.mockImplementation(fs.stat);
      expect(await service.snapshot()).toMatchObject({ installed: true, version: 'test' });
      await service.install();
      expect(mocks.download).not.toHaveBeenCalled();
    },
  );
  it.each([
    'null',
    '{',
    '{}',
    '{"binary":"missing","version":"test"}',
    '{"binary":"../outside","version":"test"}',
  ])('treats absent or invalid runtime manifest as not installed: %s', async (content) => {
    const service = createLlamaCppService(root);
    expect((await service.snapshot()).installed).toBe(false);
    await mkdir(path.join(root, 'llamacpp-runtime'));
    await writeFile(path.join(root, 'llamacpp-runtime', 'current.json'), content);
    expect((await service.snapshot()).installed).toBe(false);
  });
  it.each(['EACCES', 'EPERM', 'EIO'])(
    'rejects incomplete inventory on %s and recovers without losing models',
    async (code) => {
      const service = createLlamaCppService(root);
      expect((await service.snapshot()).models).toEqual([]);
      await service.download({ repo: 'owner/repo', file: 'model.gguf' });
      const expected = (await service.snapshot()).models;
      const error = Object.assign(new Error('scan failed'), { code });
      mocks.readdir.mockRejectedValueOnce(error);
      await expect(service.snapshot()).rejects.toBe(error);
      expect((await service.snapshot()).models).toEqual(expected);
      const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      mocks.readFile.mockImplementation(async (file, ...args) => {
        if (String(file).endsWith('model.json')) throw error;
        return fs.readFile(file, ...args);
      });
      await expect(service.snapshot()).rejects.toBe(error);
      mocks.readFile.mockImplementation(fs.readFile);
      expect((await service.snapshot()).models).toEqual(expected);
    },
  );
  it.each(['darwin', 'win32'])(
    'filters all casing variants from the spawned environment on %s',
    async (platform) => {
      const runtime = path.join(root, 'llamacpp-runtime');
      await mkdir(runtime);
      await writeFile(path.join(runtime, 'server'), 'stub');
      await writeFile(
        path.join(runtime, 'current.json'),
        JSON.stringify({ binary: 'server', version: 'test' }),
      );
      const forbidden = [
        'HF_TOKEN',
        'hf_token',
        'Hf_Token',
        'LLAMA_ARG_CTX_SIZE',
        'llama_arg_ctx_size',
        'Llama_Cache',
        'ENV',
        'env',
        'BASH_ENV',
        'Bash_Env',
      ];
      vi.stubGlobal(
        'process',
        new Proxy(process, {
          get(target, key) {
            if (key === 'platform') return platform;
            if (key === 'env')
              return {
                ...Object.fromEntries(forbidden.map((name) => [name, 'test-only'])),
                KEEP_TEST: 'retained',
              };
            return Reflect.get(target, key);
          },
        }),
      );
      const child = Object.assign(new EventEmitter(), {
        kill: vi.fn(() => {
          child.emit('exit');
          return true;
        }),
      });
      mocks.spawn.mockReturnValue(child);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ status: 'ok' })),
      );
      const service = createLlamaCppService(root);
      try {
        await service.start();
        const env = mocks.spawn.mock.calls[0]![2].env;
        for (const key of forbidden) expect(env).not.toHaveProperty(key);
        expect(env).toEqual({ KEEP_TEST: 'retained', LLAMA_CACHE: path.join(runtime, 'cache') });
      } finally {
        await service.dispose();
      }
    },
  );
  it.each([false, true])(
    'keeps removal exclusive through callback settlement (failure=%s)',
    async (fail) => {
      const service = createLlamaCppService(root);
      const other = createLlamaCppService(root);
      let entered!: () => void;
      const deleting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const removal = service
        .remove(async () => {
          entered();
          await gate;
          if (fail) throw new Error('delete failed');
        })
        .catch((error) => error);
      await deleting;
      try {
        await expect(service.start()).rejects.toThrow('BUSY');
        await expect(service.download({ repo: 'owner/repo', file: 'model.gguf' })).rejects.toThrow(
          'BUSY',
        );
        await expect(other.download({ repo: 'owner/repo', file: 'model.gguf' })).rejects.toThrow(
          'BUSY',
        );
      } finally {
        release();
      }
      const result = await removal;
      if (fail) expect(result.message).toBe('delete failed');
      else expect(result).toBeUndefined();
      await service.download({ repo: 'owner/repo', file: 'model.gguf' });
    },
  );
  it.each(['stop', 'dispose', 'remove'] as const)(
    'cancels startup and its duplicate while model scanning is pending during %s',
    async (action) => {
      const runtime = path.join(root, 'llamacpp-runtime');
      await mkdir(runtime);
      await writeFile(path.join(runtime, 'server'), 'stub');
      await writeFile(
        path.join(runtime, 'current.json'),
        JSON.stringify({ binary: 'server', version: 'test' }),
      );
      let entered!: () => void;
      const scanning = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const scan = new Promise<never[]>((resolve) => {
        release = () => resolve([]);
      });
      mocks.readdir.mockImplementationOnce(() => {
        entered();
        return scan;
      });
      const service = createLlamaCppService(root);
      const first = service.start().catch((error) => error);
      const second = service.start().catch((error) => error);
      await scanning;
      const deleted = vi.fn();
      let finished = false;
      const stopping = (action === 'remove' ? service.remove(deleted) : service[action]()).then(
        () => {
          finished = true;
        },
      );
      await Promise.resolve();
      expect(finished).toBe(false);
      expect(deleted).not.toHaveBeenCalled();
      await expect(service.start()).rejects.toThrow('BUSY');
      release();
      await stopping;
      expect((await first).name).toBe('AbortError');
      expect((await second).name).toBe('AbortError');
      expect(mocks.spawn).not.toHaveBeenCalled();
      if (action === 'remove') expect(deleted).toHaveBeenCalledOnce();
    },
  );
  it.each([
    ['stop', 'exit-first'],
    ['stop', 'tree-first'],
    ['dispose', 'exit-first'],
    ['dispose', 'tree-first'],
  ] as const)(
    'awaits both Windows router exit and tree termination during %s (%s)',
    async (action, order) => {
      const runtime = path.join(root, 'llamacpp-runtime');
      await mkdir(runtime);
      await writeFile(path.join(runtime, 'server'), 'stub');
      await writeFile(
        path.join(runtime, 'current.json'),
        JSON.stringify({ binary: 'server', version: 'test' }),
      );
      const child = Object.assign(new EventEmitter(), { pid: 1234, kill: vi.fn() });
      mocks.spawn.mockReturnValue(child);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ status: 'ok' })),
      );
      const service = createLlamaCppService(root);
      await service.start();
      vi.stubGlobal(
        'process',
        new Proxy(process, {
          get(target, key) {
            return key === 'platform' ? 'win32' : Reflect.get(target, key);
          },
        }),
      );
      let finishTree!: () => void;
      mocks.killTree.mockImplementation((_pid, target, finish) => {
        finishTree = finish;
        if (order === 'exit-first') target.emit('exit');
        else finish();
      });
      let stopped = false;
      const stopping = service[action]().then(() => {
        stopped = true;
      });
      await vi.waitFor(() => expect(mocks.killTree).toHaveBeenCalledOnce());
      expect(child.kill).not.toHaveBeenCalled();
      expect(stopped).toBe(false);
      if (order === 'exit-first') finishTree();
      else child.emit('exit');
      await stopping;
      expect(stopped).toBe(true);
      expect((await service.snapshot()).running).toBe(false);
    },
  );
  it.each(['EEXIST', 'ENOTEMPTY', 'EPERM'])(
    'accepts %s only when another model publication succeeded',
    async (code) => {
      const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      const service = createLlamaCppService(root);
      const error = Object.assign(new Error('publish failed'), { code });
      mocks.rename.mockRejectedValueOnce(error);
      await expect(service.download({ repo: 'owner/repo', file: 'model.gguf' })).rejects.toBe(
        error,
      );
      expect((await service.snapshot()).models).toEqual([]);
      mocks.rename.mockImplementationOnce(async (source, destination) => {
        await fs.rename(source, destination);
        throw error;
      });
      await service.download({ repo: 'owner/repo', file: 'model.gguf' });
      expect((await service.snapshot()).models).toHaveLength(1);
      expect(await readdir(path.join(root, 'llamacpp-runtime'))).toEqual(['models']);
    },
  );
  it('reuses the same profile owner and never stops it from a borrowing instance', async () => {
    const runtime = path.join(root, 'llamacpp-runtime');
    await mkdir(runtime);
    await writeFile(path.join(runtime, 'server'), 'stub');
    await writeFile(
      path.join(runtime, 'current.json'),
      JSON.stringify({ binary: 'server', version: 'test' }),
    );
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => {
        child.emit('exit');
        return true;
      }),
    });
    mocks.spawn.mockReturnValue(child);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ status: 'ok' })),
    );
    const owner = createLlamaCppService(root);
    const borrower = createLlamaCppService(root);
    await owner.start();
    await Promise.all([owner.start(), borrower.start()]);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect((await borrower.snapshot()).running).toBe(true);
    expect((await owner.snapshot()).canManageRuntime).toBe(true);
    expect((await borrower.snapshot()).canManageRuntime).toBe(false);
    await expect(borrower.start(true)).rejects.toThrow('BUSY');
    const remove = vi.fn();
    await expect(borrower.remove(remove)).rejects.toThrow('BUSY');
    expect(remove).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    await owner.download({ repo: 'owner/repo', file: 'model.gguf' });
    await expect(borrower.start()).rejects.toThrow('BUSY');
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
    await borrower.dispose();
    expect(child.kill).not.toHaveBeenCalled();
    await owner.dispose();
    expect(child.kill).toHaveBeenCalledWith(process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
  });
  it.each(['stop', 'dispose'] as const)(
    'waits for canceled download cleanup before %s resolves',
    async (action) => {
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const cleanupGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      mocks.download.mockImplementation(async (_asset, dest, _source, signal) => {
        await writeFile(dest, 'partial');
        entered();
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        await cleanupGate;
        signal.throwIfAborted();
      });
      const service = createLlamaCppService(root);
      const download = service.download({ repo: 'owner/repo', file: 'model.gguf' }).catch(() => {});
      await enteredPromise;
      let disposed = false;
      const disposing = service[action]().then(() => {
        disposed = true;
      });
      await Promise.resolve();
      expect(disposed).toBe(false);
      await expect(service.start()).rejects.toThrow('BUSY');
      release();
      await Promise.all([download, disposing]);
      if (action === 'dispose') await expect(service.start()).rejects.toThrow('BUSY');
      else {
        mocks.download.mockImplementation(async (_asset, dest) => writeFile(dest, 'GGUF'));
        await service.download({ repo: 'owner/repo', file: 'model.gguf' });
      }
      expect(await readdir(path.join(root, 'llamacpp-runtime'))).toEqual(['models']);
    },
  );
  it.each(['stop', 'dispose'] as const)(
    'forces and awaits a stuck POSIX owned process during %s',
    async (action) => {
      const runtime = path.join(root, 'llamacpp-runtime');
      await mkdir(runtime);
      await writeFile(path.join(runtime, 'server'), 'stub');
      await writeFile(
        path.join(runtime, 'current.json'),
        JSON.stringify({ binary: 'server', version: 'test' }),
      );
      const child = Object.assign(new EventEmitter(), {
        kill: vi.fn((signal: string) => {
          if (signal === 'SIGKILL') child.emit('exit');
          return true;
        }),
      });
      mocks.spawn.mockReturnValue(child);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ status: 'ok' })),
      );
      const service = createLlamaCppService(root);
      await service.start();
      vi.stubGlobal(
        'process',
        new Proxy(process, {
          get(target, key) {
            return key === 'platform' ? 'darwin' : Reflect.get(target, key);
          },
        }),
      );
      vi.useFakeTimers();
      try {
        const stopping = service[action]();
        await vi.advanceTimersByTimeAsync(0);
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        await vi.advanceTimersByTimeAsync(1500);
        await stopping;
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
        expect((await service.snapshot()).running).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it('preserves staging owned by other instances', async () => {
    const runtime = path.join(root, 'llamacpp-runtime');
    for (const name of ['install-abc123', 'model-download-def456', 'keep-user-files']) {
      await mkdir(path.join(runtime, name), { recursive: true });
      await writeFile(path.join(runtime, name, 'partial'), 'unverified');
    }
    await createLlamaCppService(root).download({ repo: 'owner/repo', file: 'model.gguf' });
    expect((await readdir(runtime)).sort()).toEqual([
      'install-abc123',
      'keep-user-files',
      'model-download-def456',
      'models',
    ]);
  });
  it('blocks another instance from deleting or downloading until the active transfer settles', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const bothDownloading = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.download.mockImplementation(async (_asset, dest) => {
      await writeFile(dest, 'GGUF');
      entered();
      await bothDownloading;
      expect(await readFile(dest, 'utf8')).toBe('GGUF');
    });
    const first = createLlamaCppService(root);
    const second = createLlamaCppService(root);
    const download = first.download({ repo: 'owner/repo', file: 'model.gguf' });
    await started;
    const remove = vi.fn();
    try {
      await expect(second.remove(remove)).rejects.toThrow('BUSY');
      await expect(second.download({ repo: 'owner/repo', file: 'model.gguf' })).rejects.toThrow(
        'BUSY',
      );
      expect(remove).not.toHaveBeenCalled();
    } finally {
      release();
      await download;
    }
    await second.remove(remove);
    expect(remove).toHaveBeenCalledOnce();
    expect((await first.snapshot()).models).toHaveLength(1);
    expect(await readdir(path.join(root, 'llamacpp-runtime'))).toEqual(['models']);
  });
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
