import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const HASH_RE = /^[0-9a-f]{64}$/;
const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};
const EXT_TO_MIME = Object.fromEntries(Object.entries(MIME_TO_EXT).map(([mime, ext]) => [ext, mime]));

export type HeadlessMediaAccess = {
  deviceLinkApiBase(): string | null;
  getAccessToken(): Promise<string | null>;
  fetch?: typeof fetch;
};

export type HeadlessMediaFetchResult = {
  ossKey: string;
  mimeType: string;
  size: number;
};

/**
 * Linux equivalent of Cindy Desktop's content-addressed chat media store.
 * A cindy-media URL is stable chat history data; only the actual bytes stay
 * on this host and are supplied to a linked device on demand.
 */
export class HeadlessMediaService {
  private readonly uploadCache = new Map<string, { ossKey: string; mimeType: string; size: number; expiresAt: number }>();

  constructor(
    private readonly rootDir: string,
    private readonly access?: HeadlessMediaAccess,
  ) {}

  async ingestBytes(bytes: Buffer, mimeType: string): Promise<{ url: string; absPath: string; mimeType: string; size: number }> {
    const ext = extensionForMime(mimeType);
    if (!ext) throw new Error(`unsupported image mime type: ${mimeType || '(missing)'}`);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`image must be between 1 byte and ${MAX_IMAGE_BYTES / 1024 / 1024} MiB`);
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    const dir = path.join(this.rootDir, hash.slice(0, 2));
    const absPath = path.join(dir, `${hash}${ext}`);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
    try {
      await fs.access(absPath);
    } catch {
      const temp = path.join(dir, `.tmp-${hash}-${process.pid}-${Date.now().toString(36)}`);
      await fs.writeFile(temp, bytes, { mode: 0o600, flag: 'wx' });
      try {
        await fs.link(temp, absPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') await fs.rename(temp, absPath);
      } finally {
        await fs.rm(temp, { force: true }).catch(() => undefined);
      }
    }
    await fs.chmod(absPath, 0o600);
    return { url: mediaUrl(hash, ext), absPath, mimeType, size: bytes.byteLength };
  }

  async ingestFile(source: string, mimeType?: string): Promise<{ url: string; absPath: string; mimeType: string; size: number }> {
    const guessed = mimeType?.trim() || mimeForExtension(path.extname(source).toLowerCase());
    if (!guessed) throw new Error('only PNG, JPEG, GIF, and WebP images can be stored as chat media');
    const bytes = await fs.readFile(source);
    return this.ingestBytes(bytes, guessed);
  }

  resolve(url: string): { absPath: string; mimeType: string } {
    const parsed = parseMediaUrl(url);
    if (!parsed) throw new Error('invalid cindy-media URL');
    const root = path.resolve(this.rootDir);
    const absPath = path.resolve(root, parsed.hash.slice(0, 2), `${parsed.hash}${parsed.ext}`);
    if (!absPath.startsWith(`${root}${path.sep}`)) throw new Error('media path escapes blob root');
    return { absPath, mimeType: EXT_TO_MIME[parsed.ext]! };
  }

  async fetchForRemote(arg: unknown): Promise<HeadlessMediaFetchResult> {
    const request = arg && typeof arg === 'object' ? arg as { url?: unknown; skipCache?: unknown } : {};
    if (typeof request.url !== 'string' || !request.url) throw new Error('media:fetch requires url');
    const { absPath, mimeType } = this.resolve(request.url);
    const stat = await fs.stat(absPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) throw new Error('media file is unavailable');
    const cached = this.uploadCache.get(request.url);
    if (request.skipCache !== true && cached && cached.expiresAt > Date.now()) {
      return { ossKey: cached.ossKey, mimeType: cached.mimeType, size: cached.size };
    }
    const access = this.access;
    const baseUrl = access?.deviceLinkApiBase();
    const token = access ? await access.getAccessToken() : null;
    if (!access || !baseUrl || !token) throw new Error('Device Link media requires a signed-in Cindy account');
    const fetchImpl = access.fetch ?? fetch;
    const presign = await fetchImpl(`${trimTrailingSlash(baseUrl)}/api/device-link/media/presign-put`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ size: stat.size, contentType: mimeType, ext: path.extname(absPath).slice(1) }),
    });
    if (!presign.ok) throw new Error(`Device Link media authorization failed (${presign.status})`);
    const result = await presign.json() as { putUrl?: unknown; key?: unknown };
    if (typeof result.putUrl !== 'string' || typeof result.key !== 'string' || !result.putUrl || !result.key) {
      throw new Error('Device Link media upload response is invalid');
    }
    const bytes = await fs.readFile(absPath);
    const uploaded = await fetchImpl(result.putUrl, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType, 'x-oss-object-acl': 'private' },
      body: bytes,
    });
    if (!uploaded.ok) throw new Error(`Device Link media upload failed (${uploaded.status})`);
    const output = { ossKey: result.key, mimeType, size: stat.size };
    this.uploadCache.set(request.url, { ...output, expiresAt: Date.now() + 30 * 60 * 1000 });
    return output;
  }

  async prune(visibleContents: readonly unknown[]): Promise<void> {
    const referenced = new Set<string>();
    for (const content of visibleContents) collectMediaUrls(content, referenced);
    const root = path.resolve(this.rootDir);
    const buckets = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    await Promise.all(buckets.filter((entry) => entry.isDirectory()).map(async (bucket) => {
      const dir = path.join(root, bucket.name);
      const files = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      await Promise.all(files.filter((entry) => entry.isFile() && !entry.name.startsWith('.tmp-')).map(async (entry) => {
        const url = mediaUrl(entry.name.slice(0, 64), path.extname(entry.name).toLowerCase());
        if (isHeadlessMediaUrl(url) && !referenced.has(url)) await fs.rm(path.join(dir, entry.name), { force: true });
      }));
    }));
  }
}

export function isHeadlessMediaUrl(value: string): boolean { return parseMediaUrl(value) !== null; }

function extensionForMime(mimeType: string): string | null { return MIME_TO_EXT[mimeType.toLowerCase()] ?? null; }
function mimeForExtension(ext: string): string | null { return EXT_TO_MIME[ext] ?? null; }
function mediaUrl(hash: string, ext: string): string { return `cindy-media://blobs/${hash}${ext}`; }
function parseMediaUrl(value: string): { hash: string; ext: string } | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'cindy-media:' || parsed.hostname !== 'blobs') return null;
    const filename = parsed.pathname.replace(/^\//, '');
    const ext = path.extname(filename).toLowerCase();
    const hash = filename.slice(0, -ext.length);
    return HASH_RE.test(hash) && Boolean(EXT_TO_MIME[ext]) ? { hash, ext } : null;
  } catch { return null; }
}
function collectMediaUrls(value: unknown, output: Set<string>): void {
  if (typeof value === 'string') {
    const matches = value.match(/cindy-media:\/\/blobs\/[0-9a-f]{64}\.(?:png|jpg|gif|webp)/g) ?? [];
    for (const match of matches) output.add(match);
  } else if (Array.isArray(value)) {
    for (const item of value) collectMediaUrls(item, output);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectMediaUrls(item, output);
  }
}
function trimTrailingSlash(value: string): string { return value.replace(/\/+$/, ''); }
