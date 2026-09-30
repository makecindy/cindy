import { net } from 'electron';
import type { PiBinaryUpdateFailureStage } from '@cindy/maker-core';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { download } from '../downloader/index.js';
import { extractMakeToolArchive } from '../cindy-make/toolArchive.js';
import { isBinaryVersionNotOlder, probeBinaryVersion } from './binary-version-probe.js';
import { createLogger } from '../logger.js';
import { getSharedGhCliTokenSource } from '../git-context/ghCliTokenSource.js';

const log = createLogger('pi-self-update');

const failureStages = new WeakMap<object, PiBinaryUpdateFailureStage>();
export function piBinaryUpdateFailureStage(error: unknown): PiBinaryUpdateFailureStage | undefined {
  return error !== null && typeof error === 'object' ? failureStages.get(error) : undefined;
}

/** Preserve the first, most specific failure stage across the shared installer. */
export function piBinaryUpdateError(error: unknown, stage: PiBinaryUpdateFailureStage): Error {
  const failure = error instanceof Error ? error : new Error('Pi installation failed');
  if (!failureStages.has(failure)) failureStages.set(failure, stage);
  return failure;
}

export interface PiBinaryUpdateDeps {
  fetchRelease(signal: AbortSignal): Promise<unknown>;
  download: typeof download;
  extract: typeof extractMakeToolArchive;
  probe: typeof probeBinaryVersion;
}
export const piBinaryUpdateDefaults: PiBinaryUpdateDeps = {
  fetchRelease: async signal => {
    signal.throwIfAborted();
    // Reuse the host's GitHub login source; a missing/unavailable login must not
    // prevent checking this public release. Never pass the token to downloads.
    const token = await getSharedGhCliTokenSource().readToken().catch(() => null);
    signal.throwIfAborted();
    const url = 'https://api.github.com/repos/earendil-works/pi/releases/latest';
    // Match the Electron downloader's system-proxy/PAC-aware network stack.
    let response = await net.fetch(url, {
      signal, redirect: 'error',
      headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    // A revoked/restricted login must not make public releases less accessible.
    // Retry once without credentials, within the original caller's deadline.
    if (token && (response.status === 401 || response.status === 403)) {
      // Stream cleanup can fail independently of the release lookup.
      await response.body?.cancel().catch(() => undefined);
      signal.throwIfAborted();
      response = await net.fetch(url, {
        signal, redirect: 'error', headers: { Accept: 'application/vnd.github+json' },
      });
    }
    if (!response.ok) throw new Error(`Pi release lookup failed (${response.status})`);
    return response.json();
  },
  download, extract: extractMakeToolArchive, probe: probeBinaryVersion,
};

export function parsePiRelease(value: unknown, platform: string, arch: string) {
  const release = value as { draft?: unknown; prerelease?: unknown; tag_name?: unknown; assets?: Array<{ name?: unknown; digest?: unknown; browser_download_url?: unknown }> } | null;
  if (!release || release.draft === true || release.prerelease === true || typeof release.tag_name !== 'string' || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) throw new Error('Invalid Pi release version');
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error('Unsupported Pi host platform');
  const format = platform === 'win32' ? 'zip' as const : 'tar.gz' as const;
  // Recent upstream releases use windows; retain old win32 release compatibility.
  const names = platform === 'win32' ? [`pi-windows-${arch}.${format}`, `pi-win32-${arch}.${format}`] : [`pi-${platform}-${arch}.${format}`];
  const name = names.find(name => Array.isArray(release.assets) && release.assets.some(asset => asset?.name === name)) ?? names[0];
  const url = `https://github.com/earendil-works/pi/releases/download/${release.tag_name}/${name}`;
  const asset = Array.isArray(release.assets) ? release.assets.find(asset => asset?.name === name) : undefined;
  if (!asset || asset.browser_download_url !== url || typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw new Error('Pi release has no verified asset for this platform');
  return { version: release.tag_name.slice(1), url, sha256: asset.digest.slice(7), format,
    executable: platform === 'win32' ? 'pi.exe' : 'pi' };
}

/** The standalone upstream CLI cannot self-update. Install its official release
 * beside the running distribution, verify it, then let the caller publish it.
 * Never replace/delete a directory backing an active Pi process. */
export async function installPiBinaryUpdate(
  root: string, currentBinary: string, force: boolean,
  deps: PiBinaryUpdateDeps = piBinaryUpdateDefaults,
  platform = process.platform, arch = process.arch,
): Promise<{ binaryPath: string; version: string }> {
  let failureStage: PiBinaryUpdateFailureStage = 'release-lookup';
  try {
    const signal = AbortSignal.timeout(180_000);
    const metadata = await deps.fetchRelease(signal);
    failureStage = 'asset-validation';
    const release = parsePiRelease(metadata, platform, arch);
    failureStage = 'version-verification';
    const current = await deps.probe(currentBinary, signal);
    if (!force && current && isBinaryVersionNotOlder(current, release.version)) return { binaryPath: currentBinary, version: current };
    return await installPiBinaryRelease(root, release, deps, platform, signal);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error('Pi Host update failed');
    if (!failureStages.has(failure)) failureStages.set(failure, failureStage);
    throw failure;
  }
}

export type PiBinaryRelease = ReturnType<typeof parsePiRelease>;

/** Windows security software can briefly hold handles on a freshly extracted and
 * just-executed pi.exe, so the publish rename fails with a transient code (#5204). */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** Bounded (~9.75s) and still inside the install AbortSignal; aligned with #5026. */
export const PI_PUBLISH_RENAME_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000, 3000, 3000];

export async function renameWithTransientRetry(
  from: string, to: string, options: { platform: string; signal: AbortSignal; delaysMs?: readonly number[] },
): Promise<void> {
  // Elsewhere EPERM/EACCES are real permission failures; retrying only delays the error.
  const delays = options.platform === 'win32' ? options.delaysMs ?? PI_PUBLISH_RENAME_RETRY_DELAYS_MS : [];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      if (attempt > 0) log.info('Pi publish rename succeeded after transient retry', { attempts: attempt + 1 });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= delays.length || !code || !TRANSIENT_RENAME_CODES.has(code)) throw error;
      log.warn('Pi publish rename hit transient error; retrying', { code, attempt: attempt + 1, delayMs: delays[attempt] });
      await delay(delays[attempt], undefined, { signal: options.signal });
    }
  }
}

function logCleanupFailure(target: 'staging' | 'unpublished-destination') {
  // Target label and code only: the path carries the user's profile directory.
  return (error: unknown): void => log.warn('Pi install cleanup failed; leftover directory', {
    target, code: (error as NodeJS.ErrnoException)?.code ?? 'unknown',
  });
}

/** Both Cindy release and upstream installs publish immutable, version-named directories. */
export async function installPiBinaryRelease(
  root: string, release: PiBinaryRelease,
  deps: Pick<PiBinaryUpdateDeps, 'download' | 'extract' | 'probe'> = piBinaryUpdateDefaults,
  platform = process.platform, signal: AbortSignal = AbortSignal.timeout(180_000),
  onPhase?: (phase: 'download' | 'verify' | 'activate') => void,
): Promise<{ binaryPath: string; version: string }> {
  let failureStage: PiBinaryUpdateFailureStage = 'prepare';
  try {
    failureStage = 'prepare';
    await fs.mkdir(root, { recursive: true });
    const stage = await fs.mkdtemp(path.join(path.dirname(root), '.pi-update-'));
    const destination = path.join(root, `${release.version}-${randomUUID()}`);
    let published = false;
    try {
      const archive = path.join(stage, `release.${release.format}`);
      const unpacked = path.join(stage, 'unpacked');
      await fs.mkdir(unpacked);
      failureStage = 'download';
      onPhase?.('download');
      await deps.download({ url: release.url, sha256: release.sha256, targetPath: archive, signal });
      failureStage = 'extract';
      await deps.extract(archive, unpacked, release, signal);
      const nested = path.join(unpacked, 'pi', release.executable);
      const distribution = await fs.stat(nested).then(s => s.isFile()).catch(() => false)
        ? path.join(unpacked, 'pi') : unpacked;
      const binary = path.join(distribution, release.executable);
      if (platform !== 'win32') await fs.chmod(binary, 0o755);
      failureStage = 'version-verification';
      onPhase?.('verify');
      if (await deps.probe(binary, signal) !== release.version) throw new Error('Downloaded Pi version verification failed');
      failureStage = 'publish';
      onPhase?.('activate');
      await renameWithTransientRetry(distribution, destination, { platform, signal });
      const finalBinary = path.join(destination, release.executable);
      failureStage = 'version-verification';
      onPhase?.('verify');
      if (await deps.probe(finalBinary, signal) !== release.version) throw new Error('Installed Pi version verification failed');
      failureStage = 'publish';
      onPhase?.('activate');
      await fs.writeFile(path.join(destination, '.verified'), release.sha256, { mode: 0o600 });
      signal.throwIfAborted();
      published = true;
      return { binaryPath: finalBinary, version: release.version };
    } finally {
      await fs.rm(stage, { recursive: true, force: true }).catch(logCleanupFailure('staging'));
      if (!published) await fs.rm(destination, { recursive: true, force: true }).catch(logCleanupFailure('unpublished-destination'));
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error('Pi installation failed');
    if (!failureStages.has(failure)) failureStages.set(failure, failureStage);
    throw failure;
  }
}
