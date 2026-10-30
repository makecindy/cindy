import { createHash } from 'node:crypto';
import { probeBinaryVersion } from '../binary-version-probe.js';
import { extractMakeToolArchive } from '../../cindy-make/toolArchive.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPiBinaryUpdate, parsePiRelease, piBinaryUpdateDefaults, piBinaryUpdateFailureStage, renameWithTransientRetry, type PiBinaryUpdateDeps } from '../pi-self-update.js';

const electronFetch = vi.hoisted(() => vi.fn());
const readToken = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ net: { fetch: electronFetch } }));
vi.mock('../../git-context/ghCliTokenSource.js', () => ({ getSharedGhCliTokenSource: () => ({ readToken }) }));
beforeEach(() => { readToken.mockReset().mockResolvedValue(null); });

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); electronFetch.mockReset(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
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
describe('Pi release lookup authentication', () => {
  const url = 'https://api.github.com/repos/earendil-works/pi/releases/latest';
  const token = 'fixture-github-token';
  const headers = { Accept: 'application/vnd.github+json' };
  const success = () => new Response(JSON.stringify(release()), { status: 200 });

  it('prefers the shared GitHub login and prevents authenticated redirects', async () => {
    readToken.mockResolvedValue(token);
    electronFetch.mockResolvedValue(success());
    const signal = new AbortController().signal;
    await expect(piBinaryUpdateDefaults.fetchRelease(signal)).resolves.toEqual(release());
    expect(electronFetch).toHaveBeenCalledExactlyOnceWith(url, {
      signal, redirect: 'error', headers: { ...headers, Authorization: `Bearer ${token}` },
    });
  });

  it.each(['missing', 'unavailable'])('checks anonymously when the login is %s', async reason => {
    if (reason === 'unavailable') readToken.mockRejectedValue(new Error('credential source unavailable'));
    electronFetch.mockResolvedValue(success());
    const signal = new AbortController().signal;
    await expect(piBinaryUpdateDefaults.fetchRelease(signal)).resolves.toEqual(release());
    expect(electronFetch).toHaveBeenCalledExactlyOnceWith(url, { signal, redirect: 'error', headers });
  });

  it.each([401, 403])('retries a rejected login (%s) once without credentials', async status => {
    readToken.mockResolvedValue(token);
    const rejected = new Response('rejected login', { status });
    electronFetch.mockResolvedValueOnce(rejected).mockResolvedValueOnce(success());
    const signal = new AbortController().signal;
    await expect(piBinaryUpdateDefaults.fetchRelease(signal)).resolves.toEqual(release());
    expect(rejected.bodyUsed).toBe(true);
    expect(electronFetch).toHaveBeenCalledTimes(2);
    expect(electronFetch).toHaveBeenNthCalledWith(1, url, {
      signal, redirect: 'error', headers: { ...headers, Authorization: `Bearer ${token}` },
    });
    expect(electronFetch).toHaveBeenNthCalledWith(2, url, { signal, redirect: 'error', headers });
  });

  it.each([401, 403])('still retries anonymously when the rejected response (%s) stream has errored', async status => {
    readToken.mockResolvedValue(token);
    const body = new ReadableStream({ start(controller) { controller.error(new Error('network stream failed')); } });
    electronFetch.mockResolvedValueOnce(new Response(body, { status })).mockResolvedValueOnce(success());
    const signal = new AbortController().signal;
    await expect(piBinaryUpdateDefaults.fetchRelease(signal)).resolves.toEqual(release());
    expect(electronFetch).toHaveBeenCalledTimes(2);
    expect(electronFetch).toHaveBeenNthCalledWith(2, url, { signal, redirect: 'error', headers });
  });

  it('keeps caller cancellation authoritative when response cleanup also fails', async () => {
    readToken.mockResolvedValue(token);
    const controller = new AbortController();
    electronFetch.mockImplementationOnce(async () => {
      controller.abort();
      return new Response(new ReadableStream({ start(stream) { stream.error(new Error('network stream failed')); } }), { status: 401 });
    });
    await expect(piBinaryUpdateDefaults.fetchRelease(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(electronFetch).toHaveBeenCalledTimes(1);
  });

  it.each([null, token])('bounds retries when anonymous access is also rate limited (login=%s)', async login => {
    readToken.mockResolvedValue(login);
    electronFetch.mockImplementation(async () => new Response('rate limited', { status: 403 }));
    await expect(piBinaryUpdateDefaults.fetchRelease(new AbortController().signal)).rejects.toThrow('(403)');
    expect(electronFetch).toHaveBeenCalledTimes(login ? 2 : 1);
  });

  it('does not retry server failures or expose response bodies in the error', async () => {
    readToken.mockResolvedValue(token);
    electronFetch.mockResolvedValue(new Response('private response detail', { status: 503 }));
    await expect(piBinaryUpdateDefaults.fetchRelease(new AbortController().signal))
      .rejects.toThrow(/^Pi release lookup failed \(503\)$/);
    expect(electronFetch).toHaveBeenCalledTimes(1);
  });

  it('does not query credentials or the network after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(piBinaryUpdateDefaults.fetchRelease(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(readToken).not.toHaveBeenCalled();
    expect(electronFetch).not.toHaveBeenCalled();
  });

  it('preserves cancellation while reading credentials and before anonymous fallback', async () => {
    const controller = new AbortController();
    readToken.mockImplementationOnce(async () => { controller.abort(); return token; });
    await expect(piBinaryUpdateDefaults.fetchRelease(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(electronFetch).not.toHaveBeenCalled();

    const retry = new AbortController();
    readToken.mockResolvedValue(token);
    electronFetch.mockImplementationOnce(async () => {
      retry.abort();
      return new Response('invalid login', { status: 401 });
    });
    await expect(piBinaryUpdateDefaults.fetchRelease(retry.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(electronFetch).toHaveBeenCalledTimes(1);
  });
});
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
      signal: expect.any(AbortSignal), redirect: 'error', headers: { Accept: 'application/vnd.github+json' },
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
    const chmod = vi.spyOn(fs, 'chmod');
    const result = await installPiBinaryUpdate(root, current, false, deps, platform, 'arm64');
    expect(result.version).toBe('0.85.1');
    expect(path.basename(path.dirname(result.binaryPath))).toMatch(/^0\.85\.1-/);
    const extractionRoot = vi.mocked(deps.extract).mock.calls[0][1];
    if (platform !== 'win32') {
      expect(chmod).toHaveBeenCalledWith(path.join(extractionRoot, 'pi', 'pi'), 0o755);
      // The target asset is Unix, but only a Unix host can expose its executable mode bits.
      if (process.platform !== 'win32') expect((await fs.stat(result.binaryPath)).mode & 0o777).toBe(0o755);
    } else {
      expect(chmod).not.toHaveBeenCalled();
    }
    expect(await fs.readFile(current, 'utf8')).toBe('old-running-runtime');
    expect(await fs.readFile(path.join(path.dirname(result.binaryPath), 'README.md'), 'utf8')).toBe('assets');
    expect(await fs.readFile(path.join(path.dirname(result.binaryPath), '.verified'), 'utf8')).toBe('a'.repeat(64));
    expect(deps.probe).toHaveBeenCalledTimes(3);
    await expect(fs.stat(path.dirname(extractionRoot))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('retries a publish rename briefly blocked by Windows security software (#5204)', async () => {
    const { root, current, deps } = await fixture('win32');
    const rename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }))
      .mockImplementation(rename);
    const result = await installPiBinaryUpdate(root, current, false, deps, 'win32', 'arm64');
    expect(result.version).toBe('0.85.1');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(path.join(path.dirname(result.binaryPath), '.verified'), 'utf8')).toBe('a'.repeat(64));
    expect(await fs.readFile(current, 'utf8')).toBe('old-running-runtime');
  });
  it('fails a permanently denied publish at the publish stage without retrying off Windows', async () => {
    const { root, current, deps } = await fixture();
    const spy = vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
    const error = await installPiBinaryUpdate(root, current, false, deps, 'darwin', 'arm64').catch(error => error);
    expect(error).toMatchObject({ code: 'EPERM' });
    expect(piBinaryUpdateFailureStage(error)).toBe('publish');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(root)).toEqual(['0.84.4']);
    expect(await fs.readFile(current, 'utf8')).toBe('old-running-runtime');
  });
  it('bounds Windows rename retries to transient codes and the install signal', async () => {
    const signal = new AbortController().signal;
    const eperm = vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
    await expect(renameWithTransientRetry('a', 'b', { platform: 'win32', signal, delaysMs: [1, 1, 1] })).rejects.toMatchObject({ code: 'EPERM' });
    expect(eperm).toHaveBeenCalledTimes(4);
    eperm.mockReset().mockRejectedValue(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
    await expect(renameWithTransientRetry('a', 'b', { platform: 'win32', signal, delaysMs: [1, 1, 1] })).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(eperm).toHaveBeenCalledTimes(1);
    eperm.mockReset().mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
    const aborted = new AbortController(); aborted.abort();
    await expect(renameWithTransientRetry('a', 'b', { platform: 'win32', signal: aborted.signal, delaysMs: [60_000] })).rejects.toMatchObject({ name: 'AbortError' });
    expect(eperm).toHaveBeenCalledTimes(1);
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
  it('supports the current upstream Windows asset names', () => {
    const data = release('win32');
    data.assets[0].name = data.assets[0].name.replace('win32', 'windows');
    data.assets[0].browser_download_url = data.assets[0].browser_download_url.replace('win32', 'windows');
    expect(parsePiRelease(data, 'win32', 'arm64')).toMatchObject({ format: 'zip', executable: 'pi.exe' });
  });
  it('rejects prereleases and malformed asset collections', () => {
    expect(() => parsePiRelease({ ...release(), prerelease: true }, 'darwin', 'arm64')).toThrow('Invalid');
    expect(() => parsePiRelease({ ...release(), assets: {} }, 'darwin', 'arm64')).toThrow('verified asset');
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
