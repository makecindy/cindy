import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
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
  writeFile: vi.fn(),
  ownerProof: vi.fn(),
  probeOwner: vi.fn(),
  release: vi.fn(),
}));
vi.mock('../../scheduler-host/proc-util.js', () => ({ killProcessTree: mocks.killTree }));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  rename: mocks.rename,
  readdir: mocks.readdir,
  readFile: mocks.readFile,
  stat: mocks.stat,
  writeFile: mocks.writeFile,
}));
vi.mock('../../reviewer/reviewOwnerLiveness.js', () => ({
  startReviewOwnerLiveness: mocks.ownerProof,
  probeReviewOwnerLiveness: mocks.probeOwner,
}));
vi.mock('../../maker-host/model-context-limit-store.js', () => ({
  readModelContextLimits: () => ({}),
}));
vi.mock('../managedLlamaCppProvider.js', () => ({
  assertManagedLlamaCppProvider: vi.fn(),
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
  resolveLlamaCppRelease: mocks.release,
}));
import { LlamaCppResumeReadError } from '../llamaCppDownloads.js';
import { createLlamaCppService, managedModelId } from '../llamaCppService.js';

let root: string;
beforeEach(async () => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  mocks.rename.mockImplementation(fs.rename);
  mocks.readdir.mockImplementation(fs.readdir);
  mocks.readFile.mockImplementation(fs.readFile);
  mocks.stat.mockImplementation(fs.stat);
  mocks.writeFile.mockImplementation(fs.writeFile);
  mocks.probeOwner.mockResolvedValue('alive');
  mocks.ownerProof.mockImplementation(async () => ({
    identity: { version: 1, port: 12345, token: 'test-owner' },
    close: vi.fn(async () => { mocks.probeOwner.mockResolvedValue('ended'); }),
  }));
  // Service tests use fake children; taskkill outcomes are covered by procUtilRetry.
  mocks.killTree.mockImplementation((_pid, child, finish) => {
    child.kill('SIGKILL');
    finish?.(true);
  });
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
  it.each(['install', 'download', 'configure'] as const)(
    'revalidates %s under the configuration lock after deletion and cancellation',
    async (action) => {
      let present = true;
      const remover = createLlamaCppService(root);
      const validate = vi.fn(async () => {
        if (!present) throw new Error('LOCAL_LLAMACPP_NOT_READY');
      });
      const stale = createLlamaCppService(root, () => ({}), validate);
      const configure = vi.fn(async () => {});
      const run = () => action === 'download'
        ? stale.download({ repo: 'owner/model', file: 'model.gguf' })
        : action === 'install' ? stale.install() : stale.configure(configure);
      await remover.remove(async () => { present = false; });
      await expect(run()).rejects.toThrow('LOCAL_LLAMACPP_NOT_READY');
      expect(mocks.release).not.toHaveBeenCalled();
      expect(mocks.resolve).not.toHaveBeenCalled();
      expect(mocks.download).not.toHaveBeenCalled();
      expect(configure).not.toHaveBeenCalled();
      expect(await readdir(path.join(root, 'llamacpp-runtime'))).toEqual([]);

      // A re-add is allowed without a tombstone. While validating, another
      // instance cannot delete; cancellation must still stop the pending write.
      present = true;
      validate.mockImplementationOnce(async () => {
        await expect(remover.remove(async () => { present = false; })).rejects.toThrow('BUSY');
        stale.cancel();
      });
      await expect(run()).rejects.toThrow();
      expect(present).toBe(true);
      expect(mocks.release).not.toHaveBeenCalled();
      expect(mocks.resolve).not.toHaveBeenCalled();
      expect(configure).not.toHaveBeenCalled();
      // Stop at release lookup rather than unpacking a real runtime.
      if (action === 'install') {
        mocks.release.mockRejectedValueOnce(new Error('RELEASE_LOOKUP_REACHED'));
        await expect(run()).rejects.toThrow('RELEASE_LOOKUP_REACHED');
      } else await run();
      expect(validate).toHaveBeenCalledTimes(3);
      await stale.dispose();
    },
  );
  it.each(
    ['write', 'rename', 'success'].flatMap((stage) =>
      ['absent', 'invalid-json', 'missing-binary'].map((previous) => ({ stage, previous })),
    ),
  )(
    'cleans only unpublished installation after $stage with $previous manifest',
    async ({ stage, previous }) => {
      const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      const source = path.join(root, 'archive-source');
      await mkdir(source);
      await writeFile(
        path.join(source, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'),
        'stub',
      );
      mocks.release.mockResolvedValue({ name: 'runtime.tar', version: 'test', size: 10 });
      mocks.download.mockImplementation(async (_asset, dest) => {
        execFileSync(process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar', [
          '-cf',
          dest,
          '-C',
          source,
          '.',
        ]);
      });
      const error = Object.assign(new Error('manifest publication failed'), { code: 'ENOSPC' });
      mocks.writeFile.mockImplementation(async (file, data, options) => {
        if (stage === 'write' && String(file).endsWith('current.json')) throw error;
        return fs.writeFile(file, data, options);
      });
      mocks.rename.mockImplementation(async (from, to) => {
        if (stage === 'rename' && String(to).endsWith('current.json')) throw error;
        if (String(to).endsWith('current.json')) {
          const exists = await fs.stat(to).then(
            () => true,
            () => false,
          );
          if (exists)
            throw Object.assign(new Error('cannot overwrite'), {
              code: previous === 'invalid-json' ? 'EPERM' : 'EEXIST',
            });
        }
        return fs.rename(from, to);
      });
      const runtime = path.join(root, 'llamacpp-runtime');
      await mkdir(runtime);
      await mkdir(path.join(runtime, 'unrelated-installation'));
      if (previous !== 'absent')
        await fs.writeFile(
          path.join(runtime, 'current.json'),
          previous === 'invalid-json'
            ? '{'
            : JSON.stringify({ binary: 'missing-server', version: 'old' }),
        );
      const service = createLlamaCppService(root);
      if (stage === 'success') {
        await service.install();
        expect((await service.snapshot()).installed).toBe(true);
        expect((await readdir(runtime)).some((name) => name.startsWith('test-install-'))).toBe(
          true,
        );
      } else {
        await expect(service.install()).rejects.toBe(error);
        expect((await readdir(runtime)).sort()).toEqual(
          stage === 'write' && previous !== 'absent'
            ? ['current.json', 'unrelated-installation']
            : ['unrelated-installation'],
        );
      }
      expect((await readdir(runtime)).some((name) => name.startsWith('install-'))).toBe(false);
    },
  );
  it.each(['missing', 'ended', 'unknown', 'corrupt'])(
    'checks configuration ownership before any mutation: %s',
    async (state) => {
      const runtime = path.join(root, 'llamacpp-runtime');
      await mkdir(runtime);
      if (state !== 'missing')
        await writeFile(
          path.join(runtime, 'server-owner.json'),
          state === 'corrupt'
            ? '{'
            : JSON.stringify({ identity: { version: 1, port: 12345, token: 'test' } }),
        );
      mocks.probeOwner.mockResolvedValue(state);
      const service = createLlamaCppService(root);
      const write = vi.fn().mockResolvedValue(undefined);
      const allowed = state === 'missing' || state === 'ended';
      expect((await service.snapshot()).canConfigure).toBe(allowed);
      if (allowed) {
        await service.configure(write);
        expect(write).toHaveBeenCalledOnce();
      } else {
        await expect(service.configure(write)).rejects.toThrow('RUNTIME_OWNED_ELSEWHERE');
        await expect(service.download({ repo: 'owner/model', file: 'model.gguf' })).rejects.toThrow(
          'RUNTIME_OWNED_ELSEWHERE',
        );
        expect(write).not.toHaveBeenCalled();
        expect(mocks.resolve).not.toHaveBeenCalled();
      }
    },
  );
  it.each([
    'EACCES', 'ENOSPC', 'EPERM', 'EEXIST',
    'cancel-proof', 'exit-proof', 'cancel-write', 'exit-write',
  ])(
    'closes unpublished owner proof without retrying after %s',
    async (failure) => {
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
      const fetchHealth = vi.fn(async () => Response.json({ status: 'ok' }));
      vi.stubGlobal('fetch', fetchHealth);
      const service = createLlamaCppService(root);
      const ownerFile = path.join(runtime, 'server-owner.json');
      const previous = JSON.stringify({
        identity: { version: 1, port: 12344, token: 'old-owner' }, preset: '',
      });
      await writeFile(ownerFile, previous);
      mocks.probeOwner.mockResolvedValue('ended');
      let release!: () => void;
      let closing!: () => void;
      const entered = new Promise<void>((resolve) => {
        closing = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const close = vi.fn(async () => {
        mocks.probeOwner.mockResolvedValue('ended');
        closing();
        await gate;
      });
      const fail = () => {
        if (failure.startsWith('cancel')) service.cancel();
        else if (failure.startsWith('exit')) child.emit('exit');
      };
      mocks.ownerProof.mockImplementation(async () => {
        if (failure.endsWith('proof')) fail();
        return { identity: { version: 1, port: 12345, token: 'test-owner' }, close };
      });
      const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      const ioError = Object.assign(new Error('publication failed'), { code: failure });
      mocks.writeFile.mockImplementation(async (file, data, options) => {
        if (String(file).includes('server-owner.json.') && String(file).endsWith('.tmp')) {
          if (failure === 'EACCES' || failure === 'ENOSPC') {
            await fs.writeFile(file, '{', options);
            throw ioError;
          }
          fail();
        }
        return fs.writeFile(file, data, options);
      });
      mocks.rename.mockImplementation(async (from, to) => {
        if (String(to) === ownerFile && ['EPERM', 'EEXIST'].includes(failure)) throw ioError;
        return fs.rename(from, to);
      });
      let settled = false;
      const starting = service
        .start()
        .catch((error) => error)
        .finally(() => {
          settled = true;
        });
      try {
        await entered;
        expect(settled).toBe(false);
        expect((await service.snapshot()).running).toBe(false);
      } finally {
        release();
      }
      const error = await starting;
      expect(error).toBeInstanceOf(Error);
      if (['EACCES', 'ENOSPC', 'EPERM', 'EEXIST'].includes(failure)) expect(error).toBe(ioError);
      expect(await readFile(ownerFile, 'utf8')).toBe(previous);
      expect((await readdir(runtime)).filter((name) => name.startsWith('server-owner.json.'))).toEqual([]);
      expect(mocks.ownerProof).toHaveBeenCalledOnce();
      expect(fetchHealth).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect((await service.snapshot()).running).toBe(false);
      await service.dispose();
      expect(close).toHaveBeenCalledOnce();
    },
  );
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
  it.each([
    null,
    {},
    [],
    { id: 5 },
    { id: 'wrong' },
    { repo: null },
    { repo: '' },
    { repo: '../repo' },
    { file: 7 },
    { file: '' },
    { file: '../model.gguf' },
    { size: '4' },
    { size: 0 },
    { size: -1 },
    { size: 1.5 },
    { size: Number.MAX_SAFE_INTEGER + 1 },
  ])('skips structurally damaged records while retaining healthy models: %j', async (damage) => {
    const service = createLlamaCppService(root);
    await service.download({ repo: 'owner/good', file: 'model.gguf' });
    const good = (await service.snapshot()).models;
    const bad = {
      id: managedModelId('owner/bad', 'model.gguf'),
      repo: 'owner/bad',
      file: 'model.gguf',
      size: 4,
    };
    const folder = path.join(root, 'llamacpp-runtime', 'models', bad.id);
    await mkdir(folder);
    const record =
      damage === null || Array.isArray(damage) || Object.keys(damage).length === 0
        ? damage
        : { ...bad, ...damage };
    await writeFile(path.join(folder, 'model.json'), JSON.stringify(record));
    expect((await service.snapshot()).models).toEqual(good);
    await writeFile(path.join(folder, 'model.json'), JSON.stringify(bad));
    expect((await service.snapshot()).models.map((model) => model.id).sort()).toEqual(
      [good[0]!.id, bad.id].sort(),
    );
  });
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
  it.each([false, true])(
    'revalidates a queued start after another instance deletes the connection (reload=%s)',
    async (reload) => {
      const runtime = path.join(root, 'llamacpp-runtime');
      await mkdir(runtime);
      await writeFile(path.join(runtime, 'server'), 'stub');
      await writeFile(
        path.join(runtime, 'current.json'),
        JSON.stringify({ binary: 'server', version: 'test' }),
      );
      let present = true;
      const validate = vi.fn(async () => {
        if (!present) throw new Error('LOCAL_LLAMACPP_NOT_READY');
      });
      const starter = createLlamaCppService(root, () => ({}), validate);
      const remover = createLlamaCppService(root);
      let entered!: () => void;
      const deleting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const removal = remover.remove(async () => {
        entered();
        await gate;
        present = false;
      });
      await deleting;
      let checked!: () => void;
      const checking = new Promise<void>((resolve) => {
        checked = resolve;
      });
      const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      mocks.readFile.mockImplementationOnce(async (file, options) => {
        try {
          return await fs.readFile(file, options);
        } finally {
          checked();
        }
      });
      const pending = starter.start(reload).catch((error) => error);
      await checking;
      expect(validate).not.toHaveBeenCalled();
      release();
      await removal;
      expect((await pending).message).toBe('LOCAL_LLAMACPP_NOT_READY');
      expect(validate).toHaveBeenCalledOnce();
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(mocks.ownerProof).not.toHaveBeenCalled();
      // A later explicit re-add permits normal startup without a tombstone.
      present = true;
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
      await starter.start(reload);
      expect(mocks.spawn).toHaveBeenCalledOnce();
      await starter.dispose();
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
      const proof = await mocks.ownerProof.mock.results.at(-1)!.value;
      let finishProof!: () => void;
      const proofClosed = new Promise<void>((resolve) => { finishProof = resolve; });
      proof.close.mockImplementation(async () => {
        await proofClosed;
        mocks.probeOwner.mockResolvedValue('ended');
      });
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
        finishTree = () => finish(true);
        if (order === 'exit-first') target.emit('exit');
        else finish(true);
      });
      let stopped = false;
      const stopping = service[action]().then(() => {
        stopped = true;
      });
      await vi.waitFor(() => expect(mocks.killTree).toHaveBeenCalledOnce());
      expect(child.kill).not.toHaveBeenCalled();
      expect(stopped).toBe(false);
      expect(proof.close).not.toHaveBeenCalled();
      if (order === 'exit-first') finishTree();
      else child.emit('exit');
      await Promise.resolve();
      expect(stopped).toBe(false);
      finishProof();
      await stopping;
      expect(stopped).toBe(true);
      expect(proof.close).toHaveBeenCalledOnce();
      expect((await service.snapshot()).running).toBe(false);
    },
  );
  it.each(['exit-first', 'tree-first', 'both-late', 'tree-failed'] as const)(
    'retains the owner proof after STOP_TIMEOUT until both Windows confirmations (%s)',
    async (order) => {
      const runtime = path.join(root, 'llamacpp-runtime');
      await mkdir(runtime);
      await writeFile(path.join(runtime, 'server'), 'stub');
      await writeFile(path.join(runtime, 'current.json'), JSON.stringify({ binary: 'server', version: 'test' }));
      const child = Object.assign(new EventEmitter(), { pid: 1234, kill: vi.fn() });
      mocks.spawn.mockReturnValue(child);
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'ok' })));
      const service = createLlamaCppService(root);
      await service.start();
      const proof = await mocks.ownerProof.mock.results.at(-1)!.value;
      vi.stubGlobal('process', new Proxy(process, {
        get(target, key) { return key === 'platform' ? 'win32' : Reflect.get(target, key); },
      }));
      let finishTree!: () => void;
      mocks.killTree.mockImplementation((_pid, _target, finish) => { finishTree = () => finish(order !== 'tree-failed'); });
      vi.useFakeTimers();
      try {
        const stopped = service.stop().catch((error: Error) => error.message);
        await vi.advanceTimersByTimeAsync(0);
        if (order === 'exit-first') child.emit('exit');
        if (order === 'tree-failed') { child.emit('exit'); finishTree(); }
        if (order === 'tree-first') finishTree();
        await vi.advanceTimersByTimeAsync(4000);
        expect(await stopped).toBe('STOP_TIMEOUT');
        expect(proof.close).not.toHaveBeenCalled();
        vi.useRealTimers();
        const other = createLlamaCppService(root);
        const deleted = vi.fn();
        await expect(other.configure(async () => {})).rejects.toThrow('RUNTIME_OWNED_ELSEWHERE');
        await expect(other.remove(deleted)).rejects.toThrow('BUSY');
        expect(deleted).not.toHaveBeenCalled();
        if (order === 'tree-failed') {
          await expect(service.remove(deleted)).rejects.toThrow('BUSY');
          expect(proof.close).not.toHaveBeenCalled();
          return;
        }
        if (order !== 'exit-first') child.emit('exit');
        if (order === 'both-late') expect(proof.close).not.toHaveBeenCalled();
        if (order !== 'tree-first') finishTree();
        expect(proof.close).toHaveBeenCalledOnce();
        await other.remove(deleted);
        expect(deleted).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
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
  it('refreshes external runtime status without acquiring ownership or caching a borrow', async () => {
    const runtime = path.join(root, 'llamacpp-runtime');
    await mkdir(runtime);
    const service = createLlamaCppService(root);
    const fetchHealth = vi.fn(async () => Response.json({ status: 'ok' }));
    vi.stubGlobal('fetch', fetchHealth);
    expect(await service.snapshot()).toMatchObject({ running: false, canConfigure: true });
    await writeFile(path.join(runtime, 'server-owner.json'), JSON.stringify({
      identity: { version: 1, port: 12345, token: 'external' },
    }));
    expect(await service.snapshot()).toMatchObject({ running: true, canConfigure: false, canManageRuntime: false });
    fetchHealth.mockResolvedValueOnce(new Response('', { status: 503 }));
    expect(await service.snapshot()).toMatchObject({ running: false, canConfigure: false });
    fetchHealth.mockRejectedValueOnce(new Error('connection refused'));
    expect(await service.snapshot()).toMatchObject({ running: false, canConfigure: false });
    mocks.probeOwner.mockResolvedValue('unknown');
    expect(await service.snapshot()).toMatchObject({ running: false, canConfigure: false });
    mocks.probeOwner.mockResolvedValue('ended');
    expect(await service.snapshot()).toMatchObject({ running: false, canConfigure: true });
    mocks.probeOwner.mockResolvedValue('alive');
    expect(await service.snapshot()).toMatchObject({ running: true, canConfigure: false });
    await rm(path.join(runtime, 'server-owner.json'));
    expect(await service.snapshot()).toMatchObject({ running: false, canConfigure: true });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it.each([false, true].flatMap((reload) =>
    ['unknown', 'unknown-under-lock', 'corrupt', 'invalid-identity', 'read-error'].map((state) => ({ reload, state })),
  ))('refuses takeover on $state with reload=$reload', async ({ reload, state }) => {
    const runtime = path.join(root, 'llamacpp-runtime');
    await mkdir(runtime);
    const ownerPath = path.join(runtime, 'server-owner.json');
    const record = state === 'corrupt' ? '{' : JSON.stringify({
      identity: { version: 1, port: state === 'invalid-identity' ? 0 : 12345, token: 'external' },
      preset: '',
    });
    await writeFile(ownerPath, record);
    mocks.probeOwner.mockResolvedValue('unknown');
    if (state === 'unknown-under-lock') mocks.probeOwner.mockResolvedValueOnce('ended');
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    if (state === 'read-error') mocks.readFile.mockImplementation(async (file, ...args) => {
      if (file === ownerPath) throw Object.assign(new Error('read failed'), { code: 'EACCES' });
      return fs.readFile(file, ...args);
    });
    const service = createLlamaCppService(root);
    await expect(service.start(reload)).rejects.toThrow('BUSY');
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.ownerProof).not.toHaveBeenCalled();
    expect(await fs.readFile(ownerPath, 'utf8')).toBe(record);
    if (state === 'unknown-under-lock') expect(mocks.probeOwner).toHaveBeenCalledTimes(2);
    mocks.readFile.mockImplementation(fs.readFile);
    await writeFile(ownerPath, JSON.stringify({ identity: { version: 1, port: 12345, token: 'external' } }));
    mocks.probeOwner.mockResolvedValue('ended');
    // Conclusive owner exit permits startup to proceed to installation validation.
    await expect(service.start(reload)).rejects.toThrow('NOT_INSTALLED');
    await service.dispose();
  });
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
    expect((await borrower.snapshot()).running).toBe(true);
    await Promise.all([owner.start(), borrower.start()]);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect((await borrower.snapshot()).running).toBe(true);
    expect((await owner.snapshot()).canManageRuntime).toBe(true);
    expect((await borrower.snapshot()).canManageRuntime).toBe(false);
    expect((await borrower.snapshot()).canConfigure).toBe(false);
    expect((await owner.snapshot()).canConfigure).toBe(true);
    const writeContext = vi.fn().mockResolvedValue(undefined);
    await expect(borrower.configure(writeContext)).rejects.toThrow('RUNTIME_OWNED_ELSEWHERE');
    await expect(borrower.install()).rejects.toThrow('RUNTIME_OWNED_ELSEWHERE');
    await expect(borrower.download({ repo: 'owner/new', file: 'model.gguf' })).rejects.toThrow(
      'RUNTIME_OWNED_ELSEWHERE',
    );
    expect(writeContext).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
    await owner.configure(writeContext);
    expect(writeContext).toHaveBeenCalledOnce();
    await expect(borrower.start(true)).rejects.toThrow('BUSY');
    const remove = vi.fn();
    await expect(borrower.remove(remove)).rejects.toThrow('BUSY');
    expect(remove).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    await owner.download({ repo: 'owner/repo', file: 'model.gguf' });
    await borrower.start();
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
    mocks.probeOwner.mockResolvedValue('ended');
    expect(await borrower.snapshot()).toMatchObject({ running: false, canConfigure: true });
    await borrower.dispose();
    expect(child.kill).not.toHaveBeenCalled();
    await owner.dispose();
    expect(child.kill).toHaveBeenCalledWith(process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
  });
  it.each([
    ['owner', false],
    ['borrower', false],
    ['owner', true],
    ['borrower', true],
  ] as const)(
    'keeps serving with pending configuration during a download from %s (cancel=%s)',
    async (who, cancel) => {
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
      const health = vi.fn(async () => Response.json({ status: 'ok' }));
      vi.stubGlobal('fetch', health);
      const limits: Record<string, number> = {};
      const owner = createLlamaCppService(root, () => limits);
      await owner.download({ repo: 'bartowski/Qwen3.8-Flash-Next-GGUF', file: 'model.gguf' });
      await owner.start();
      const service = who === 'owner' ? owner : createLlamaCppService(root, () => limits);
      let entered!: () => void;
      const downloading = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      mocks.download.mockImplementationOnce(async (_asset, dest) => {
        entered();
        await gate;
        await writeFile(dest, 'GGUF');
      });
      const transfer = owner
        .download({ repo: 'new/model', file: 'model.gguf' })
        .catch((error) => error);
      await downloading;
      try {
        await service.start();
        expect((await owner.snapshot()).operation?.kind).toBe('download');
        expect(mocks.spawn).toHaveBeenCalledOnce();
        expect(child.kill).not.toHaveBeenCalled();
        await expect(service.start(true)).rejects.toThrow('BUSY');
        const id = (await owner.snapshot()).models[0]!.id;
        limits[`pi:cindy-local-llamacpp:${id}`] = 1_000_000;
        await service.start();
        delete limits[`pi:cindy-local-llamacpp:${id}`];
        if (who === 'borrower') {
          health.mockResolvedValueOnce(new Response('', { status: 503 }));
          await expect(service.start()).rejects.toThrow('BUSY');
        }
        if (cancel && who === 'borrower') {
          let checked!: () => void;
          const checking = new Promise<void>((resolve) => {
            checked = resolve;
          });
          let finish!: () => void;
          health.mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                finish = () => resolve(Response.json({ status: 'ok' }));
                checked();
              }),
          );
          const pending = service.start().catch((error) => error);
          await checking;
          service.cancel();
          finish();
          expect((await pending).name).toBe('AbortError');
          expect(mocks.spawn).toHaveBeenCalledOnce();
          expect(child.kill).not.toHaveBeenCalled();
        }
        if (cancel && who === 'owner') owner.cancel();
      } finally {
        release();
        const result = await transfer;
        if (cancel && who === 'owner') expect(result.name).toBe('AbortError');
        else expect(result).toBeUndefined();
      }
      // Publishing a model does not prevent continued use of the current service.
      await service.start();
      expect(mocks.spawn).toHaveBeenCalledOnce();
      expect(child.kill).not.toHaveBeenCalled();
      await owner.dispose();
      if (who === 'borrower') await service.dispose();
    },
  );
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
    'keeps unreadable prefix staged until explicit %s',
    async (action) => {
      const service = createLlamaCppService(root);
      let prefix = '';
      mocks.download.mockImplementationOnce(async (_asset, dest) => {
        prefix = `${dest}.partial`;
        await writeFile(prefix, 'saved bytes');
        throw new LlamaCppResumeReadError(Object.assign(new Error('EIO'), { code: 'EIO' }));
      });
      const running = service.download({ repo: 'owner/repo', file: 'model.gguf' });
      const settled = running.then(
        () => 'complete',
        () => 'cancelled',
      );
      await vi.waitFor(async () => expect((await service.snapshot()).operation?.paused).toBe(true));
      expect(await readFile(prefix, 'utf8')).toBe('saved bytes');
      expect(mocks.download).toHaveBeenCalledTimes(1);
      if (action === 'resume') {
        service.resume();
        expect(await settled).toBe('complete');
      } else {
        service.cancel();
        expect(await settled).toBe('cancelled');
      }
      expect(
        (await readdir(path.join(root, 'llamacpp-runtime'))).some((name) =>
          name.startsWith('model-download-'),
        ),
      ).toBe(false);
    },
  );
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
  it('applies model and context changes only on explicit restart or a stopped service start', async () => {
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
      const initial = await readFile(path.join(runtime, 'models.ini'), 'utf8');
      await service.download({ repo: 'owner/repo', file: 'model.gguf' });
      await service.download({ repo: 'bartowski/Qwen3.8-Flash-Next-GGUF', file: 'model.gguf' });
      expect(mocks.spawn).toHaveBeenCalledOnce();
      await service.start();
      expect(mocks.spawn).toHaveBeenCalledOnce();
      expect(mocks.spawn.mock.results[0]!.value.kill).not.toHaveBeenCalled();
      expect(await readFile(path.join(runtime, 'models.ini'), 'utf8')).toBe(initial);
      await service.start(true);
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
      await service.start();
      expect(mocks.spawn).toHaveBeenCalledTimes(2);
      expect(await readFile(path.join(runtime, 'models.ini'), 'utf8')).toBe(ini);
      processing = false;
      await Promise.all([service.start(), service.start()]);
      expect(mocks.spawn).toHaveBeenCalledTimes(2);
      expect(mocks.spawn.mock.results[1]!.value.kill).not.toHaveBeenCalled();
      expect(await readFile(path.join(runtime, 'models.ini'), 'utf8')).toBe(ini);
      expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).endsWith('/health'))).toBe(
        true,
      );
      await service.start(true);
      expect(mocks.spawn).toHaveBeenCalledTimes(3);
      const extended = await readFile(path.join(runtime, 'models.ini'), 'utf8');
      expect(extended).toContain(
        `[${modelId}]\nctx-size = 1000000\nrope-scaling = yarn\nrope-scale = 4\nyarn-orig-ctx = 262144`,
      );
      limits = {};
      await service.start();
      expect(await readFile(path.join(runtime, 'models.ini'), 'utf8')).toBe(extended);
      expect(mocks.spawn).toHaveBeenCalledTimes(3);
      await service.stop();
      await service.start();
      expect(mocks.spawn).toHaveBeenCalledTimes(4);
      expect(await readFile(path.join(runtime, 'models.ini'), 'utf8')).toBe(ini);
    } finally {
      await service.dispose();
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
