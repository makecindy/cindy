import { createHash } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { extract } from 'tar';

// The stable channel used by Google's CLI install.ps1 and install.sh.
const MANIFEST_ROOT = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/';
const STORAGE_ROOT = 'https://storage.googleapis.com/antigravity-public/antigravity-cli/';
const MAX_BYTES = 512 * 1024 * 1024;
const platforms = {
  windows_amd64: { artifact: 'windows-x64/cli_windows_x64.exe', executable: 'agy.exe' },
  darwin_arm64: { artifact: 'darwin-arm/cli_mac_arm64.tar.gz', executable: 'antigravity' },
} as const;

type Platform = keyof typeof platforms;
type Release = { version: string; url: string; sha512: string };
type Fetch = (url: string, options: RequestInit) => Promise<Response>;

export function parseAntigravityRelease(value: unknown, platform: Platform): Release {
  if (!value || typeof value !== 'object') throw new Error('ANTIGRAVITY_INVALID_RELEASE');
  const { version, url, sha512 } = value as Record<string, unknown>;
  if (typeof version !== 'string' || !/^\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(version)
    || typeof url !== 'string' || typeof sha512 !== 'string' || !/^[a-f0-9]{128}$/i.test(sha512)) {
    throw new Error('ANTIGRAVITY_INVALID_RELEASE');
  }
  const prefix = STORAGE_ROOT + version + '-';
  const suffix = '/' + platforms[platform].artifact;
  if (!url.startsWith(prefix) || !url.endsWith(suffix)
    || !/^\d{1,32}$/.test(url.slice(prefix.length, -suffix.length))) {
    throw new Error('ANTIGRAVITY_INVALID_RELEASE');
  }
  return { version, url, sha512: sha512.toLowerCase() };
}

async function* responseChunks(response: Response, limit: number, signal: AbortSignal) {
  if (!response.ok || !response.body) throw new Error('ANTIGRAVITY_DOWNLOAD_FAILED');
  const reader = response.body.getReader();
  let size = 0;
  let finished = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) { finished = true; return; }
      size += value.byteLength;
      if (size > limit) throw new Error('ANTIGRAVITY_DOWNLOAD_TOO_LARGE');
      yield Buffer.from(value);
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function managedAntigravityPlatform(): Platform {
  if (process.platform === 'win32' && process.arch === 'x64') return 'windows_amd64';
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin_arm64';
  throw new Error('ANTIGRAVITY_UNAVAILABLE');
}

export async function fetchAntigravityRelease(fetcher: Fetch, platform: Platform, ownerSignal: AbortSignal): Promise<Release> {
  const signal = AbortSignal.any([ownerSignal, AbortSignal.timeout(30_000)]);
  const response = await fetcher(MANIFEST_ROOT + platform + '.json', { signal, redirect: 'error' });
  const chunks: Buffer[] = [];
  for await (const chunk of responseChunks(response, 32 * 1024, signal)) chunks.push(chunk);
  return parseAntigravityRelease(JSON.parse(Buffer.concat(chunks).toString('utf8')), platform);
}

/** Write only to a new, owner-private directory. The caller activates it after signature and ACP checks. */
export async function downloadAntigravityRelease(
  fetcher: Fetch, release: Release, platform: Platform, stage: string, ownerSignal: AbortSignal,
): Promise<string> {
  const validated = parseAntigravityRelease(release, platform);
  const signal = AbortSignal.any([ownerSignal, AbortSignal.timeout(5 * 60_000)]);
  const binary = path.join(stage, platforms[platform].executable);
  const payload = platform === 'windows_amd64' ? binary : path.join(stage, 'payload.tar.gz');
  const response = await fetcher(validated.url, { signal, redirect: 'error' });
  const hash = createHash('sha512');
  async function* hashedChunks() {
    for await (const chunk of responseChunks(response, MAX_BYTES, signal)) {
      hash.update(chunk);
      yield chunk;
    }
  }
  await pipeline(hashedChunks(), createWriteStream(payload, { flags: 'wx', mode: 0o700 }), { signal });
  if (hash.digest('hex') !== validated.sha512) throw new Error('ANTIGRAVITY_DOWNLOAD_CHECKSUM');
  if (platform === 'darwin_arm64') {
    await extract({
      cwd: stage, file: payload, strict: true, keep: true,
      filter: (name, entry) => name === 'antigravity' && 'type' in entry && entry.type === 'File' && entry.size <= MAX_BYTES,
    });
    await fs.unlink(payload);
    await fs.chmod(binary, 0o700);
  }
  ownerSignal.throwIfAborted();
  if (!(await fs.lstat(binary)).isFile()) throw new Error('ANTIGRAVITY_INVALID_PAYLOAD');
  return binary;
}
