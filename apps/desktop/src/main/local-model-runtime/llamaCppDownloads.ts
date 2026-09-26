import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
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
  const res = await fetch(RELEASES, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    redirect: 'error',
    headers: { 'User-Agent': 'Cindy-Desktop', Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error('RELEASE_UNAVAILABLE');
  return pickLlamaCppRelease(await res.json(), process.platform, process.arch);
}

/** Stream to a staging file; no unverified or partial bytes become an installed asset. */
export async function downloadLlamaCppAsset(
  asset: DownloadAsset,
  destination: string,
  source: 'github' | 'hf',
  signal: AbortSignal,
  progress: (bytes: number) => void,
  resume = false,
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.partial`;
  const stalled = new AbortController();
  const parentSignal = signal;
  signal = AbortSignal.any([parentSignal, stalled.signal]);
  let idleTimer = setTimeout(() => stalled.abort(new Error('DOWNLOAD_TIMEOUT')), 120_000);
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stalled.abort(new Error('DOWNLOAD_TIMEOUT')), 120_000);
  };
  try {
    let offset = resume
      ? await stat(partial).then(
          (s) => s.size,
          () => 0,
        )
      : 0;
    if (offset > asset.size) {
      await rm(partial, { force: true });
      offset = 0;
    }
    const hash = createHash('sha256');
    if (offset) {
      for await (const chunk of createReadStream(partial)) {
        signal.throwIfAborted();
        resetIdle();
        hash.update(chunk);
      }
      progress(offset);
    }
    if (offset === asset.size) {
      if (hash.digest('hex') !== asset.sha256) throw new Error('DOWNLOAD_CHECKSUM');
      signal.throwIfAborted();
      await rename(partial, destination);
      return;
    }
    let url = asset.url;
    let response: Response | undefined;
    for (let hop = 0; hop < 6; hop++) {
      signal.throwIfAborted();
      if (!allowedDownloadUrl(url, source)) throw new Error('DOWNLOAD_BLOCKED');
      const next = await fetch(url, {
        signal,
        redirect: 'manual',
        headers: offset ? { Range: `bytes=${offset}-` } : undefined,
      });
      if (next.status >= 300 && next.status < 400) {
        const location = next.headers.get('location');
        await next.body?.cancel();
        if (!location) throw new Error('DOWNLOAD_FAILED');
        url = new URL(location, url).href;
      } else {
        response = next;
        break;
      }
    }
    if (!response?.ok || !response.body) throw new Error('DOWNLOAD_FAILED');
    // A server may ignore Range. Replace, never append a complete response to a prefix.
    let activeHash = hash;
    if (offset && response.status === 200) {
      offset = 0;
      activeHash = createHash('sha256');
    }
    if (
      response.status === 206 &&
      response.headers.get('content-range') !== `bytes ${offset}-${asset.size - 1}/${asset.size}`
    ) {
      await response.body.cancel();
      throw new Error('DOWNLOAD_FAILED');
    }
    let completed = offset;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        resetIdle();
        completed += chunk.length;
        if (completed > asset.size) {
          callback(new Error('DOWNLOAD_SIZE'));
          return;
        }
        activeHash.update(chunk);
        progress(completed);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      meter,
      createWriteStream(partial, { flags: offset ? 'a' : resume ? 'w' : 'wx' }),
      { signal },
    );
    if (completed !== asset.size || activeHash.digest('hex') !== asset.sha256)
      throw new Error('DOWNLOAD_CHECKSUM');
    signal.throwIfAborted();
    await rename(partial, destination);
  } finally {
    clearTimeout(idleTimer);
    if (parentSignal.reason !== 'DOWNLOAD_PAUSED') await rm(partial, { force: true });
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
    const next = await fetch(url, { signal: timeout, redirect: 'manual' });
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
