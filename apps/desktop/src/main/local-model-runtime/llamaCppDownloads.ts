import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  cleanup as cleanupDownload,
  createDownloader,
  DownloadError,
  type DownloadOptions,
  type ProgressEvent,
} from '../downloader/index.js';
import { createLogger } from '../logger.js';
import { outboundFetch } from '../maker-host/outbound-fetch.desktop.js';
import { validLlamaCppFile, validLlamaCppRepo, type LlamaCppFile } from '../../shared/llamaCpp.js';

const RELEASES = 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10';
const GITHUB_HOSTS = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);
const HF_HOSTS = new Set([
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'cdn-lfs-us-1.huggingface.co',
  'cdn-lfs-eu-1.huggingface.co',
  'cas-bridge.xethub.hf.co',
  'us.aws.cdn.hf.co',
  'eu.aws.cdn.hf.co',
]);

export interface DownloadAsset {
  url: string;
  sha256: string;
  size: number;
}
export interface LlamaCppRelease extends DownloadAsset {
  version: string;
  name: string;
}
export function llamaCppPlatform(platform: NodeJS.Platform, arch: string): string | null {
  if (!['arm64', 'x64'].includes(arch)) return null;
  if (platform === 'darwin') return `macos-${arch}.tar.gz`;
  if (platform === 'win32') return `win-cpu-${arch}.zip`;
  if (platform === 'linux') return `ubuntu-${arch}.tar.gz`;
  return null;
}

export function allowedDownloadUrl(value: string, source: 'github' | 'hf'): boolean {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
    if (!(source === 'github' ? GITHUB_HOSTS : HF_HOSTS).has(u.hostname)) return false;
    return (
      source !== 'github' ||
      u.hostname !== 'github.com' ||
      /^\/ggml-org\/llama\.cpp\/releases\/download\/(?:b\d+|v\d+\.\d+\.\d+)\/llama-[a-zA-Z0-9._-]+$/.test(
        u.pathname,
      )
    );
  } catch {
    return false;
  }
}

export function pickLlamaCppRelease(
  data: unknown,
  platform: NodeJS.Platform,
  arch: string,
): LlamaCppRelease {
  const suffix = llamaCppPlatform(platform, arch);
  if (!suffix || !Array.isArray(data)) throw new Error('UNSUPPORTED');
  for (const release of data) {
    if (release.draft || !/^(b\d+|v\d+\.\d+\.\d+)$/.test(release.tag_name ?? '')) continue;
    const name = `llama-${release.tag_name}-bin-${suffix}`;
    const asset = release.assets?.find((a: { name?: string }) => a.name === name);
    if (!asset || !allowedDownloadUrl(asset.browser_download_url, 'github')) continue;
    const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest ?? '');
    if (!digest || !Number.isSafeInteger(asset.size) || asset.size <= 0) continue;
    return {
      version: release.tag_name,
      name,
      url: asset.browser_download_url,
      sha256: digest[1]!.toLowerCase(),
      size: asset.size,
    };
  }
  throw new Error('RELEASE_UNAVAILABLE');
}

export async function resolveLlamaCppRelease(signal: AbortSignal): Promise<LlamaCppRelease> {
  const res = await outboundFetch(RELEASES, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    redirect: 'error',
    headers: { 'User-Agent': 'Cindy-Desktop', Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error('RELEASE_UNAVAILABLE');
  return pickLlamaCppRelease(await res.json(), process.platform, process.arch);
}

/** Existing prefix could not be read; the owner must retain its paused download. */
export class LlamaCppResumeReadError extends Error {
  constructor(cause: unknown) {
    super('DOWNLOAD_RESUME_READ_FAILED', { cause });
  }
}

// Own queue: a multi-GB model must never hold up app updates or other installs.
const transfer = createDownloader();
const log = createLogger('llamacpp-download');

/** Keep the error names the service and its callers already handle. */
function downloadFailure(error: unknown): unknown {
  if (!(error instanceof DownloadError)) return error;
  const name =
    error.code === 'URL_POLICY'
      ? 'DOWNLOAD_BLOCKED'
      : error.code === 'CHECKSUM'
        ? 'DOWNLOAD_CHECKSUM'
        : error.code === 'SIZE'
          ? 'DOWNLOAD_SIZE'
          : error.code === 'TIMEOUT'
            ? 'DOWNLOAD_TIMEOUT'
            : 'DOWNLOAD_FAILED';
  return new Error(name, { cause: error });
}

export type LlamaCppTransferEvents = Pick<DownloadOptions, 'onRetry' | 'onVerifying' | 'retry'>;

/**
 * Verified transfer through the shared downloader (verified-downloads.md): size, SHA-256,
 * per-hop host allow-list, retries with resume, slow-link reconnects. Bytes stay in
 * `${destination}.part` until verified; nothing partial becomes an installed asset.
 *
 * `resume`: a pause (signal reason `DOWNLOAD_PAUSED`) keeps the prefix and its resume
 * record so the next call continues; any other failure or cancellation removes them.
 */
export async function downloadLlamaCppAsset(
  asset: DownloadAsset,
  destination: string,
  source: 'github' | 'hf',
  signal: AbortSignal,
  progress: (bytes: number, event?: ProgressEvent) => void,
  resume = false,
  events: LlamaCppTransferEvents = {},
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  let savedPrefix = false;
  if (resume) {
    try {
      savedPrefix = (await stat(`${destination}.part`)).isFile();
    } catch (error) {
      // An unreadable saved prefix waits for an explicit resume; it is never discarded.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new LlamaCppResumeReadError(error);
    }
  }
  let keep = false;
  try {
    await transfer({
      url: asset.url,
      targetPath: destination,
      sha256: asset.sha256,
      expectedSize: asset.size,
      maxBytes: asset.size,
      isUrlAllowed: (url) => allowedDownloadUrl(url, source),
      // Same network stack as before (env proxy + Chromium/system PAC), one checked hop at a time.
      request: async (url, init) => ({
        response: await outboundFetch(url, { ...init, redirect: 'manual' }),
      }),
      resume,
      signal,
      logger: log,
      timeout: { connectMs: 30_000 },
      onProgress: (event) => progress(event.loaded, event),
      ...events,
    });
  } catch (error) {
    if (signal.aborted) {
      keep = resume && signal.reason === 'DOWNLOAD_PAUSED';
      throw new DOMException('Download aborted', 'AbortError');
    }
    // A prefix that cannot be read back pauses so the bytes survive; a full disk still fails
    // and frees the partial file, as before the shared downloader.
    const diskFull = ['ENOSPC', 'EDQUOT'].includes(
      (error instanceof DownloadError &&
        (error.cause as NodeJS.ErrnoException | undefined)?.code) ||
        '',
    );
    if (savedPrefix && error instanceof DownloadError && error.code === 'DISK' && !diskFull) {
      keep = true;
      throw new LlamaCppResumeReadError(error);
    }
    throw downloadFailure(error);
  } finally {
    if (!keep) await cleanupDownload(destination).catch(() => {});
  }
}

interface HfFile extends LlamaCppFile {
  sha256: string;
}
export interface HfRepository {
  revision: string;
  files: HfFile[];
}
export async function resolveHfRepository(
  repo: string,
  signal: AbortSignal,
): Promise<HfRepository> {
  if (!validLlamaCppRepo(repo)) throw new Error('INVALID_MODEL');
  let url = `https://huggingface.co/api/models/${repo}?blobs=true`;
  let response: Response | undefined;
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  for (let hop = 0; hop < 5; hop++) {
    const parsed = new URL(url);
    if (
      parsed.origin !== 'https://huggingface.co' ||
      parsed.username ||
      parsed.password ||
      !validLlamaCppRepo(parsed.pathname.replace(/^\/api\/models\//, '')) ||
      !parsed.pathname.startsWith('/api/models/')
    )
      throw new Error('DOWNLOAD_BLOCKED');
    const next = await outboundFetch(url, { signal: timeout, redirect: 'manual' });
    if (next.status >= 300 && next.status < 400) {
      const location = next.headers.get('location');
      await next.body?.cancel();
      if (!location) throw new Error('MODEL_NOT_FOUND');
      url = new URL(location, url).href;
    } else {
      response = next;
      break;
    }
  }
  if (!response?.ok) throw new Error('MODEL_NOT_FOUND');
  const data = (await response.json()) as {
    sha?: string;
    siblings?: { rfilename: string; lfs?: { size: number; sha256: string } }[];
  };
  if (!/^[a-f0-9]{40}$/.test(data.sha ?? '') || !Array.isArray(data.siblings))
    throw new Error('MODEL_NOT_FOUND');
  const files = data.siblings
    .filter(
      (f) =>
        validLlamaCppFile(f.rfilename) &&
        f.lfs &&
        /^[a-f0-9]{64}$/.test(f.lfs.sha256) &&
        Number.isSafeInteger(f.lfs.size) &&
        f.lfs.size > 0,
    )
    .map((f) => ({ name: f.rfilename, size: f.lfs!.size, sha256: f.lfs!.sha256 }));
  return { revision: data.sha!, files };
}

export function selectGgufShards(files: HfFile[], name: string): HfFile[] {
  if (!validLlamaCppFile(name)) throw new Error('INVALID_MODEL');
  const selected = files.find((f) => f.name === name);
  if (!selected) throw new Error('MODEL_NOT_FOUND');
  const split = /^(.*)-\d{5}-of-(\d{5})\.gguf$/.exec(name);
  if (!split) return [selected];
  const count = Number(split[2]);
  if (count < 1 || count > 256) throw new Error('INVALID_MODEL');
  return Array.from({ length: count }, (_, i) => {
    const shard = files.find(
      (f) => f.name === `${split[1]}-${String(i + 1).padStart(5, '0')}-of-${split[2]}.gguf`,
    );
    if (!shard) throw new Error('MODEL_INCOMPLETE');
    return shard;
  });
}

export function hfDownloadUrl(repo: string, revision: string, file: string): string {
  return `https://huggingface.co/${repo}/resolve/${revision}/${file.split('/').map(encodeURIComponent).join('/')}`;
}
