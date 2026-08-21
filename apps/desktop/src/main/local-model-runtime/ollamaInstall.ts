import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import https from 'node:https';
import path from 'node:path';

import type { LocalRuntimeInstallProgress } from '../../shared/localModelRuntime.js';
import {
  isAllowedOllamaDownloadUrl,
  OLLAMA_GITHUB_API_LATEST,
  pickOfficialSidecarAsset,
  type OfficialOllamaAsset,
} from './ollamaRelease.js';
import { createPullSpeedTracker } from './pullProgress.js';
import { findOllamaBinary, ollamaRuntimeRoot, sidecarManifestPath } from './ollamaSidecar.js';

const TAR_BIN_DARWIN = '/usr/bin/tar';
const MAX_REDIRECTS = 5;
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
    const raw = JSON.parse(await readFile(sidecarManifestPath(userDataDir), 'utf8')) as SidecarManifest;
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
    onProgress?: (completed: number, total: number) => void;
    get?: typeof https.get;
  } = {},
): Promise<void> {
  if (!isAllowedOllamaDownloadUrl(asset.url)) {
    throw new Error('blocked unofficial ollama download url');
  }
  const get = opts.get ?? https.get;
  await mkdir(path.dirname(destPath), { recursive: true });
  const tmp = `${destPath}.tmp`;
  await rm(tmp, { force: true });
  const hash = createHash('sha256');
  let completed = 0;

  await new Promise<void>((resolve, reject) => {
    const follow = (url: string, hops: number) => {
      if (hops > MAX_REDIRECTS) {
        reject(new Error('too many redirects'));
        return;
      }
      if (!isAllowedOllamaDownloadUrl(url)) {
        reject(new Error('blocked unofficial ollama download url'));
        return;
      }
      const request = get(url, { headers: { 'User-Agent': 'Cindy-Desktop' } }, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          follow(new URL(response.headers.location, url).toString(), hops + 1);
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`ollama download failed (${status})`));
          return;
        }
        const total = Number(response.headers['content-length'] ?? asset.sizeBytes);
        const out = createWriteStream(tmp);
        const fail = (error: Error) => {
          response.destroy();
          out.destroy();
          reject(error);
        };
        opts.signal?.addEventListener('abort', () => fail(new Error('aborted')), { once: true });
        response.on('data', (chunk: Buffer) => {
          hash.update(chunk);
          completed += chunk.length;
          opts.onProgress?.(completed, total);
        });
        response.on('error', fail);
        out.on('error', fail);
        response.pipe(out);
        out.on('finish', () => resolve());
      });
      request.on('error', reject);
      opts.signal?.addEventListener('abort', () => request.destroy(new Error('aborted')), {
        once: true,
      });
    };
    follow(asset.url, 0);
  });

  const digest = hash.digest('hex');
  if (digest !== asset.sha256) {
    await rm(tmp, { force: true });
    throw new Error('ollama download checksum mismatch');
  }
  await rename(tmp, destPath);
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
  await runTar(
    tarBin,
    args,
    isWindows ? WINDOWS_EXTRACT_TIMEOUT_MS : EXTRACT_TIMEOUT_MS,
    signal,
  );
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
  emit({ phase: 'resolving', done: false });
  const resolve = opts.resolve ?? resolveOfficialSidecarAsset;
  const asset = await resolve(opts.fetchImpl, platform, arch, opts.signal);
  if (opts.signal?.aborted) throw new Error('aborted');
  const root = ollamaRuntimeRoot(userDataDir);
  const archivePath = path.join(root, 'downloads', asset.assetName);
  const destDir = path.join(root, `v${asset.version}`);
  try {
  emit({
    phase: 'downloading',
    version: asset.version,
    total: asset.sizeBytes,
    completed: 0,
    percent: 0,
    done: false,
  });
  const download = opts.download ?? downloadOfficialAsset;
  const speed = createPullSpeedTracker();
  const layers = new Map<string, { completed: number; total: number }>();
  await download(asset, archivePath, {
    signal: opts.signal,
    onProgress: (completed, total) => {
      layers.set('sidecar', { completed, total });
      const bytesPerSecond = speed.update(layers);
      emit({
        phase: 'downloading',
        version: asset.version,
        completed,
        total,
        percent: total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0,
        ...(bytesPerSecond && bytesPerSecond > 0 ? { bytesPerSecond } : {}),
        done: false,
      });
    },
  });
  emit({ phase: 'verifying', version: asset.version, percent: 100, done: false });
  if (opts.signal?.aborted) throw new Error('aborted');
  emit({ phase: 'extracting', version: asset.version, done: false });
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
