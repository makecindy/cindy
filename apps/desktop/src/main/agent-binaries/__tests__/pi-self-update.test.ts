import { createHash } from 'node:crypto';
import { probeBinaryVersion } from '../binary-version-probe.js';
import { extractMakeToolArchive } from '../../cindy-make/toolArchive.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPiBinaryUpdate, parsePiRelease, piBinaryUpdateFailureStage, type PiBinaryUpdateDeps } from '../pi-self-update.js';

const electronFetch = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ net: { fetch: electronFetch } }));

const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); electronFetch.mockReset(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
function release(platform = 'darwin') {
  const name = `pi-${platform}-arm64.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
  return { tag_name: 'v0.85.1', assets: [{ name, digest: 'sha256:' + 'a'.repeat(64), browser_download_url: `https://github.com/earendil-works/pi/releases/download/v0.85.1/${name}` }] };
}
async function fixture(platform: 'darwin' | 'win32' = 'darwin') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-self-update-')); roots.push(root);
  const current = path.join(root, '0.84.4', platform === 'win32' ? 'pi.exe' : 'pi');
  await fs.mkdir(path.dirname(current)); await fs.writeFile(current, 'old-running-runtime');
  const deps: PiBinaryUpdateDeps = {
    fetchRelease: vi.fn(async () => release(platform)),
    download: vi.fn(async () => ({})) as never,
    extract: vi.fn(async (_archive, directory) => {
      const target = platform === 'win32' ? directory : path.join(directory, 'pi');
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, platform === 'win32' ? 'pi.exe' : 'pi'), 'new-runtime');
      await fs.writeFile(path.join(target, 'README.md'), 'assets');
    }),
    probe: vi.fn(async binary => binary === current ? '0.84.4' : '0.85.1'),
  };
  return { root, current, deps };
}
describe('Pi standalone core update', () => {
  it.each([200, 503])('uses Electron release lookup with the existing timeout and status handling (%s)', async status => {
    const { root, current } = await fixture();
    const nodeFetch = vi.fn(() => { throw new Error('Node direct fetch must not be used'); });
    vi.stubGlobal('fetch', nodeFetch);
    const json = vi.fn(async () => ({ tag_name: 'v0.85.1', assets: [] }));
    electronFetch.mockResolvedValue({ ok: status === 200, status, json });
    // Exercise the production defaults, stopping before download/version probes.
    const error = await installPiBinaryUpdate(root, current, false, undefined, 'darwin', 'arm64').catch(error => error);
    expect(electronFetch).toHaveBeenCalledWith('https://api.github.com/repos/earendil-works/pi/releases/latest', {
      signal: expect.any(AbortSignal), headers: { Accept: 'application/vnd.github+json' },
    });
    expect(nodeFetch).not.toHaveBeenCalled();
    expect(piBinaryUpdateFailureStage(error)).toBe(status === 200 ? 'asset-validation' : 'release-lookup');
    expect(error.message).toContain(status === 200 ? 'verified asset' : '(503)');
    expect(json).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
    expect(await fs.readFile(current, 'utf8')).toBe('old-running-runtime');
    expect(await fs.readdir(root)).toEqual(['0.84.4']);
  });

  it.each(['release-lookup', 'asset-validation', 'download', 'extract', 'version-verification'] as const)('records the %s failure phase without changing the old installation', async stage => {
    const { root, current, deps } = await fixture();
    const fail = async () => { throw new Error('sensitive raw failure'); };
    if (stage === 'release-lookup') deps.fetchRelease = fail;
    if (stage === 'asset-validation') deps.fetchRelease = async () => ({ tag_name: 'v0.85.1', assets: [] });
    if (stage === 'download') deps.download = fail;
    if (stage === 'extract') deps.extract = fail;
    if (stage === 'version-verification') deps.probe = async binary => binary === current ? '0.84.4' : fail();
    const error = await installPiBinaryUpdate(root, current, false, deps, 'darwin', 'arm64').catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(piBinaryUpdateFailureStage(error)).toBe(stage);
    expect(await fs.readFile(current, 'utf8')).toBe('old-running-runtime');
    expect(await fs.readdir(root)).toEqual(['0.84.4']);
  });

  it.each(['darwin', 'win32'] as const)('publishes a fully probed %s distribution without touching the running one', async platform => {
    const { root, current, deps } = await fixture(platform);
    const result = await installPiBinaryUpdate(root, current, false, deps, platform, 'arm64');
    expect(result.version).toBe('0.85.1');
    expect(await fs.readFile(current, 'utf8')).toBe('old-running-runtime');
    expect(await fs.readFile(path.join(path.dirname(result.binaryPath), 'README.md'), 'utf8')).toBe('assets');
    expect(await fs.readFile(path.join(path.dirname(result.binaryPath), '.verified'), 'utf8')).toBe('a'.repeat(64));
    expect(deps.probe).toHaveBeenCalledTimes(3);
    const extractionRoot = vi.mocked(deps.extract).mock.calls[0][1];
    await expect(fs.stat(path.dirname(extractionRoot))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('leaves the old installation usable when version verification fails', async () => {
    const { root, current, deps } = await fixture();
    deps.probe = vi.fn(async () => '0.84.4');
    await expect(installPiBinaryUpdate(root, current, false, deps, 'darwin', 'arm64')).rejects.toThrow('verification failed');
    expect(await fs.readdir(root)).toEqual(['0.84.4']);
    expect(await fs.readFile(current, 'utf8')).toBe('old-running-runtime');
  });
  it('retains a newer runtime unless force was requested', async () => {
    const { root, current, deps } = await fixture();
    deps.probe = vi.fn(async () => '0.86.0');
    expect(await installPiBinaryUpdate(root, current, false, deps, 'darwin', 'arm64')).toEqual({ binaryPath: current, version: '0.86.0' });
    expect(deps.download).not.toHaveBeenCalled();
  });
  it('rejects missing digests and changed asset hosts before downloading', () => {
    const data = release(); data.assets[0].digest = '';
    expect(() => parsePiRelease(data, 'darwin', 'arm64')).toThrow('verified asset');
    data.assets[0].digest = 'sha256:' + 'a'.repeat(64); data.assets[0].browser_download_url = 'https://example.test/pi';
    expect(() => parsePiRelease(data, 'darwin', 'arm64')).toThrow('verified asset');
  });
});

// Explicit public-network smoke; never runs in the default unit gate.
it.skipIf(process.env.CINDY_PI_BINARY_UPDATE_SMOKE !== '1')('verifies an official Pi distribution in an isolated temporary root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-binary-public-smoke-')); roots.push(root);
  const result = await installPiBinaryUpdate(root, path.join(root, 'no-existing-install'), false, {
    fetchRelease: async signal => (await fetch('https://api.github.com/repos/earendil-works/pi/releases/latest', { signal })).json(),
    // Unit runners have no Electron net.request. Use real Node fetch + SHA-256
    // here; production continues to use the existing Electron downloader.
    download: async options => {
      const response = await fetch(options.url, { signal: options.signal });
      if (!response.ok) throw new Error('Public artifact download failed');
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(options.sha256);
      await fs.writeFile(options.targetPath, bytes);
      return { path: options.targetPath, size: bytes.length } as never;
    },
    extract: extractMakeToolArchive, probe: probeBinaryVersion,
  });
  expect(result.binaryPath.startsWith(root + path.sep)).toBe(true);
  expect(await fs.readFile(path.join(path.dirname(result.binaryPath), '.verified'), 'utf8')).toMatch(/^[a-f0-9]{64}$/);
}, 200_000);
