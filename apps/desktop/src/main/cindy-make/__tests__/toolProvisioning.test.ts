import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { DownloadError } from '../../downloader/index.js';
import { makeToolCatalog } from '../toolCatalog.js';
import { installedMakeTool, installMakeTool } from '../toolInstaller.js';
import { selectMakeToolchainEnvironment } from '../toolchainEnvironment.js';
import { makeToolProcessEnvironment } from '../doctorEnvironment.js';

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
let temp: string;
let sequence = 0;
beforeAll(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'cindy-make-install-test-'));
});
afterAll(async () => {
  await rm(temp, { recursive: true, force: true });
});

describe('pinned platform tool catalog', () => {
  it.each([
    ['win32', 'x64', 5],
    ['darwin', 'x64', 4],
    ['darwin', 'arm64', 4],
    ['linux', 'x64', 4],
    ['linux', 'arm64', 4],
  ])('provides verified portable artifacts for %s/%s', (platform, arch, count) => {
    const artifacts = makeToolCatalog(String(platform), String(arch));
    expect(artifacts).toHaveLength(Number(count));
    expect(new Set(artifacts.map((a) => a.id)).size).toBe(count);
    for (const artifact of artifacts) {
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.host).toBe(`${platform}-${arch}`);
      expect(new URL(artifact.url).protocol).toBe('https:');
      expect(artifact.url).not.toContain('/latest/');
      expect(artifact.executable).not.toMatch(/\\|\.\./);
    }
  });
  it.each([
    ['win32', 'arm64'],
    ['freebsd', 'x64'],
    ['linux', 'ia32'],
  ])('has no guessed fallback for %s/%s', (platform, arch) => {
    expect(makeToolCatalog(platform, arch)).toEqual([]);
  });
});

describe('private, atomic tool installation', () => {
  const artifact = makeToolCatalog('win32', 'x64').find((a) => a.id === 'pnpm')!;
  const setup = () => ({
    root: path.join(temp, String(++sequence)),
    artifact,
    signal: new AbortController().signal,
    onProgress: vi.fn(),
    validate: vi.fn<(executable: string) => Promise<boolean>>(async () => true),
  });
  const downloader = vi.fn(async (options: { targetPath: string }) => {
    await writeFile(options.targetPath, 'test executable');
  });

  it('promotes only after verification, preserves publisher hashes, and discovers the completed install', async () => {
    const input = setup();
    input.validate.mockImplementation(async (executable) => {
      expect(await installedMakeTool(input.root, artifact)).toBeUndefined();
      expect(await readFile(executable, 'utf8')).toBe('test executable');
      return true;
    });
    const executable = await installMakeTool(input, { download: downloader });
    expect(downloader).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: artifact.url, sha256: artifact.sha256, signal: input.signal }),
    );
    expect(await installedMakeTool(input.root, artifact)).toBe(executable);
    expect(input.onProgress.mock.calls.map(([progress]) => progress.status)).toEqual([
      'downloading',
      'installing',
    ]);
    expect((await readdir(path.dirname(executable))).sort()).toEqual(['pnpm.exe']);
  });
  it('a checksum failure never extracts or runs downloaded contents', async () => {
    const input = setup();
    const extract = vi.fn();
    await expect(
      installMakeTool(input, {
        download: async () => {
          throw new DownloadError('CHECKSUM', 'mismatch');
        },
        extract,
      }),
    ).rejects.toThrow('mismatch');
    expect(extract).not.toHaveBeenCalled();
    expect(input.validate).not.toHaveBeenCalled();
    expect(await installedMakeTool(input.root, artifact)).toBeUndefined();
  });
  it('a failed repair leaves the previous working generation selected', async () => {
    const input = setup();
    const previous = await installMakeTool(input, { download: downloader });
    input.validate.mockResolvedValue(false);
    await expect(installMakeTool(input, { download: downloader })).rejects.toThrow('version check');
    expect(await installedMakeTool(input.root, artifact)).toBe(previous);
    expect(await readFile(previous, 'utf8')).toBe('test executable');
    const directory = path.dirname(path.dirname(previous));
    expect((await readdir(directory)).sort()).toEqual(
      [path.basename(path.dirname(previous)), 'current.json'].sort(),
    );
  });
  it.each(['download', 'validation'])(
    'cancels during %s without publishing a partial install; retry can succeed',
    async (phase) => {
      const input = setup();
      const controller = new AbortController();
      input.signal = controller.signal;
      if (phase === 'validation')
        input.validate.mockImplementation(async () => {
          controller.abort();
          return true;
        });
      await expect(
        installMakeTool(input, {
          download: async (options) => {
            await downloader(options);
            if (phase === 'download') controller.abort();
          },
        }),
      ).rejects.toBeDefined();
      expect(await installedMakeTool(input.root, artifact)).toBeUndefined();
      input.signal = new AbortController().signal;
      input.validate.mockResolvedValue(true);
      const retried = await installMakeTool(input, { download: downloader });
      expect(await installedMakeTool(input.root, artifact)).toBe(retried);
    },
  );
  it('ignores interrupted staging folders and rejects records that point outside the managed directory', async () => {
    const input = setup();
    const executable = await installMakeTool(input, { download: downloader });
    const parent = path.dirname(path.dirname(executable));
    await mkdir(path.join(parent, '.staging-interrupted'));
    expect(await installedMakeTool(input.root, artifact)).toBe(executable);
    await writeFile(
      path.join(parent, 'current.json'),
      JSON.stringify({ sha256: artifact.sha256, generation: '../../escape' }),
    );
    expect(await installedMakeTool(input.root, artifact)).toBeUndefined();
  });
});

describe('compatible local tool reuse and scoped environment', () => {
  it.each([
    ['win32', path.win32, 'C:\\existing\\bin', 'C:\\managed\\node\\node.exe'],
    ['linux', path.posix, '/existing/bin', '/managed/node/bin/node'],
  ])(
    'prepends selected tools and keeps the parent PATH intact on %s',
    (platform, paths, existing, executable) => {
      const base = {
        PATH: existing,
        ...(platform === 'win32' ? { Path: 'C:\\ignored' } : {}),
        KEEP: 'value',
      };
      const snapshot = { ...base };
      const env = makeToolProcessEnvironment({ node: executable }, base, platform, existing);
      expect(env.PATH?.split(paths.delimiter)[0]).toBe(paths.dirname(executable));
      expect(env.PATH).toContain(existing);
      if (platform === 'win32') expect(env).not.toHaveProperty('Path');
      expect(env.KEEP).toBe('value');
      expect(base).toEqual(snapshot);
    },
  );
  it.each([
    ['v24.1.0', 'system'],
    ['v20.0.0', 'managed'],
    ['', 'managed'],
  ])(
    'prefers a compatible global Node and falls back to managed Node for %s',
    async (systemVersion, source) => {
      const system = path.join(temp, 'system', 'node');
      const cached = path.join(temp, 'managed', 'node');
      const probed: string[] = [];
      const env = selectMakeToolchainEnvironment(
        (tools) => ({
          platform: 'linux',
          arch: 'x64',
          storage: vi.fn(),
          native: vi.fn(),
          probe: async () => {
            const file = tools.node ?? system;
            probed.push(file);
            return {
              status: 'ok',
              path: file,
              stdout: file === cached ? 'v22.23.2' : systemVersion,
            };
          },
        }),
        { node: cached },
        (paths) => ({ SELECTED_NODE: paths.node }),
      );
      const result = await env.probe('node', ['--version'], new AbortController().signal);
      expect(result.source).toBe(source);
      expect(probed).toEqual(source === 'system' ? [system] : [system, cached]);
      expect(env.processEnvironment().SELECTED_NODE).toBe(source === 'system' ? system : cached);
    },
  );
});
