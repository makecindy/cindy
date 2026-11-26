import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';

import {
  download as downloadFile,
  cleanup as cleanupDownload,
  createDownloadProgressReporter,
  type DownloadOptions,
} from '../downloader/index.js';

import {
  downloadPhaseOfInstall,
  type LocalRuntimeInstallPhase,
  type LocalRuntimeInstallProgress,
} from '../../shared/localModelRuntime.js';
import {
  isAllowedOllamaDownloadUrl,
  OLLAMA_GITHUB_API_LATEST,
  pickOfficialSidecarAsset,
  type OfficialOllamaAsset,
} from './ollamaRelease.js';
import { findOllamaBinary, ollamaRuntimeRoot, sidecarManifestPath } from './ollamaSidecar.js';

const TAR_BIN_DARWIN = '/usr/bin/tar';
const EXTRACT_TIMEOUT_MS = 60_000;
const WINDOWS_EXTRACT_TIMEOUT_MS = 15 * 60_000;

export function windowsTarBin(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  return `${root}\\System32\\tar.exe`;
}

export interface SidecarManifest {
  version: string;
  binary: string;
  sha256: string;
}

export async function readSidecarManifest(userDataDir: string): Promise<SidecarManifest | null> {
  try {
    const raw = JSON.parse(
      await readFile(sidecarManifestPath(userDataDir), 'utf8'),
    ) as SidecarManifest;
    if (
      typeof raw.version !== 'string' ||
      typeof raw.binary !== 'string' ||
      typeof raw.sha256 !== 'string'
    ) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export async function resolveOfficialSidecarAsset(
  fetchImpl: typeof fetch = fetch,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
  signal?: AbortSignal,
): Promise<OfficialOllamaAsset> {
  if (signal?.aborted) throw new Error('aborted');
  const response = await fetchImpl(OLLAMA_GITHUB_API_LATEST, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Cindy-Desktop',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal,
  });
  if (!response.ok) {
    throw new Error(`ollama release lookup failed (${response.status})`);
  }
  const asset = pickOfficialSidecarAsset(await response.json(), platform, arch);
  if (!asset) throw new Error('official ollama sidecar asset missing');
  return asset;
}

export async function resolveOfficialDarwinAsset(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<OfficialOllamaAsset> {
  return resolveOfficialSidecarAsset(fetchImpl, 'darwin', process.arch, signal);
}

export async function downloadOfficialAsset(
  asset: OfficialOllamaAsset,
  destPath: string,
  opts: {
    signal?: AbortSignal;
    onProgress?: (completed: number, total: number, speedBps?: number) => void;
  } & Pick<DownloadOptions, 'onRetry' | 'onVerifying'> = {},
): Promise<void> {
  await downloadFile({
    url: asset.url,
    targetPath: destPath,
    sha256: asset.sha256,
    expectedSize: asset.sizeBytes,
    maxBytes: asset.sizeBytes,
    isUrlAllowed: isAllowedOllamaDownloadUrl,
    signal: opts.signal,
    onProgress: ({ loaded, total, speedBps }) =>
      opts.onProgress?.(loaded, total ?? asset.sizeBytes, speedBps),
    onRetry: opts.onRetry,
    onVerifying: opts.onVerifying,
  });
}

function runTar(
  tarBin: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(tarBin, args, { timeout: timeoutMs }, (error) => {
      if (error) reject(error);
      else resolve();
    });
    const abort = () => {
      child.kill();
      reject(new Error('aborted'));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function extractOfficialArchive(
  archivePath: string,
  destDir: string,
  platform: NodeJS.Platform = process.platform,
  signal?: AbortSignal,
): Promise<string> {
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });
  const isWindows = platform === 'win32';
  const tarBin = isWindows ? windowsTarBin() : TAR_BIN_DARWIN;
  const args = isWindows
    ? ['-xf', archivePath, '-C', destDir]
    : ['-xzf', archivePath, '-C', destDir];
  await runTar(tarBin, args, isWindows ? WINDOWS_EXTRACT_TIMEOUT_MS : EXTRACT_TIMEOUT_MS, signal);
  if (signal?.aborted) throw new Error('aborted');
  const binary = findOllamaBinary(destDir);
  if (!binary) throw new Error('extracted ollama binary missing');
  if (!isWindows) await chmod(binary, 0o755);
  return binary;
}

export async function extractDarwinArchive(archivePath: string, destDir: string): Promise<string> {
  return extractOfficialArchive(archivePath, destDir, 'darwin');
}

export async function installOfficialSidecar(
  userDataDir: string,
  opts: {
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    onProgress?: (progress: LocalRuntimeInstallProgress) => void;
    download?: typeof downloadOfficialAsset;
    extract?: typeof extractOfficialArchive;
    resolve?: typeof resolveOfficialSidecarAsset;
  } = {},
): Promise<{ version: string; binary: string }> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const emit = (progress: LocalRuntimeInstallProgress) => opts.onProgress?.(progress);
  // Byte-level updates (retries, speed, time left) go out as the standard `download` shape.
  let installPhase: LocalRuntimeInstallPhase = 'resolving';
  let version: string | undefined = undefined; // set once the release is resolved
  const reporter = createDownloadProgressReporter({
    initialPhase: downloadPhaseOfInstall(installPhase),
    emit: (download) => {
      if (opts.signal?.aborted) return;
      if (download.phase === 'downloading' || download.phase === 'retrying') {
        installPhase = 'downloading';
      } else if (download.phase === 'verifying') {
        installPhase = 'verifying';
      }
      emit({
        phase: installPhase,
        ...(version ? { version } : {}),
        ...(download.total !== null ? { total: download.total, completed: download.loaded } : {}),
        ...(download.percent !== null ? { percent: Math.round(download.percent) } : {}),
        ...(download.speedBps > 0 ? { bytesPerSecond: download.speedBps } : {}),
        done: false,
        download,
      });
    },
  });
  const step = (phase: LocalRuntimeInstallPhase) => {
    installPhase = phase;
    reporter.setPhase(downloadPhaseOfInstall(phase));
  };
  emit({ phase: 'resolving', done: false, download: reporter.snapshot() });
  const resolve = opts.resolve ?? resolveOfficialSidecarAsset;
  const asset = await resolve(opts.fetchImpl, platform, arch, opts.signal);
  if (opts.signal?.aborted) throw new Error('aborted');
  version = asset.version;
  const root = ollamaRuntimeRoot(userDataDir);
  const archivePath = path.join(root, 'downloads', asset.assetName);
  const destDir = path.join(root, `v${asset.version}`);
  try {
    installPhase = 'downloading';
    reporter.reset('downloading', asset.sizeBytes);
    const download = opts.download ?? downloadOfficialAsset;
    await download(asset, archivePath, {
      signal: opts.signal,
      onProgress: (completed, total, bytesPerSecond) =>
        reporter.setBytes(completed, total, bytesPerSecond ?? 0),
      onRetry: reporter.callbacks.onRetry,
      onVerifying: reporter.callbacks.onVerifying,
    });
    step('verifying');
    if (opts.signal?.aborted) throw new Error('aborted');
    step('extracting');
    const extract = opts.extract ?? extractOfficialArchive;
    const binary = await extract(archivePath, destDir, platform, opts.signal);
    if (opts.signal?.aborted) throw new Error('aborted');
    const manifest: SidecarManifest = {
      version: asset.version,
      binary,
      sha256: asset.sha256,
    };
    const manifestPath = sidecarManifestPath(userDataDir);
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(`${manifestPath}.tmp`, `${JSON.stringify(manifest)}\n`, 'utf8');
    await rename(`${manifestPath}.tmp`, manifestPath);
    await rm(archivePath, { force: true });
    return { version: asset.version, binary };
  } catch (error) {
    await cleanupDownload(archivePath);
    await rm(`${archivePath}.tmp`, { force: true });
    await rm(archivePath, { force: true });
    await rm(destDir, { recursive: true, force: true });
    throw error;
  }
}

export async function installOfficialDarwinSidecar(
  userDataDir: string,
  opts: Parameters<typeof installOfficialSidecar>[1] = {},
): Promise<{ version: string; binary: string }> {
  return installOfficialSidecar(userDataDir, { ...opts, platform: 'darwin' });
}
