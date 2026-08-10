/**
 * imageCacheStore.ts (image-local-cache M1)
 * ---------------------------------------------------------------------------
 * Low-level CRUD utilities for the local image cache:
 *   userData/cc-agent/images/{sessionId}/{uuid-timestamp}.{ext}
 *   userData/cc-agent/images/{sessionId}/{uuid-timestamp}.{ext}.xdt-meta.json
 *
 * Used by:
 *   - IPC handlers (image-cache:from-path / from-buffer / read-base64 /
 *     cleanup-session / cleanup-files)
 *   - xdt-image:// protocol handler
 *   - agentManager.buildContentBlocks (F5 temporary base64 read)
 *   - startup orphan sweep for unsent draft images
 *
 * Security model: every URL→absPath resolution funnels through `resolveSafe`
 * which path-resolves against the cache root and rejects anything that escapes.
 *
 * ── Reserved hosts (non-session namespaces) ─────────────────────────────────
 * In addition to per-session URLs (`xdt-image://{sessionId}/{filename}`),
 * the resolver recognises a small set of reserved hosts that route to OTHER
 * cache directories under `userData/cc-agent/`. These are used by integrations
 * that maintain their own globally-cached media (not tied to chat sessions):
 *
 *   xdt-image://feishu-media-images/{token}.{ext}          → feishu-media/images/...
 *   xdt-image://feishu-media-files/{token}.{ext}           → feishu-media/files/...
 *   xdt-image://lizi-art-media-images/{fileId}.png         → lizi-art-media/images/...
 *   xdt-image://lizi-confluence-attachments/{attId}.{ext}  → lizi-confluence/attachments/...
 *   xdt-image://lizi-jira-attachments/{attId}.{ext}        → lizi-jira/attachments/...
 *
 * Reserved hosts are matched as exact hostnames before the resolver treats the
 * host as a session ID, so UUID session IDs (which also contain hyphens) remain
 * unambiguous unless they exactly equal a reserved host string.
 *
 * NOTE on FLAT layout: reserved hosts require a flat filename under the root
 * (the resolver rejects `/` and `\` in the URL path segment — see resolveSafe).
 * Hosts that previously stored files as `{id}/{name}` (early Confluence layout)
 * must migrate to `{id}.{ext}` directly under the root to be xdt-image://-renderable.
 */

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  attachmentExtension,
  isDangerousAttachmentName,
} from '../shared/attachmentSafety';

const SCHEME = 'xdt-image';
const META_SUFFIX = '.xdt-meta.json';

export type ImageCacheLifecycle = 'draft' | 'committed';

export interface ImageCacheMeta {
  version: 1;
  sessionId: string;
  filename: string;
  lifecycle: ImageCacheLifecycle;
  createdAt: number;
  updatedAt: number;
}

export interface SweepDraftImagesResult {
  scanned: number;
  removed: number;
  removedDanglingMeta: number;
  skippedReferenced: number;
  skippedFresh: number;
  skippedMissingMeta: number;
  errors: number;
}

/**
 * Reserved hostname → absolute base directory. The resolver checks this map
 * BEFORE treating the hostname as a session ID. Add new entries here when an
 * integration needs to expose its own cache namespace under xdt-image://.
 */
const RESERVED_HOSTS: Record<string, () => string> = {
  'feishu-media-images': () =>
    path.join(app.getPath('userData'), 'cc-agent', 'feishu-media', 'images'),
  'feishu-media-files': () =>
    path.join(app.getPath('userData'), 'cc-agent', 'feishu-media', 'files'),
  'lizi-art-media-images': () =>
    path.join(app.getPath('userData'), 'cc-agent', 'lizi-art-media', 'images'),
  'lizi-confluence-attachments': () =>
    path.join(app.getPath('userData'), 'cc-agent', 'lizi-confluence', 'attachments'),
  'lizi-jira-attachments': () =>
    path.join(app.getPath('userData'), 'cc-agent', 'lizi-jira', 'attachments'),
};

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
};

/** A bounded portable suffix; dangerous executable types are filtered separately. */
const SAFE_ATTACHMENT_EXT_RE = /^\.[a-z0-9][a-z0-9+_-]{0,23}$/;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function getCacheRoot(): string {
  return path.join(app.getPath('userData'), 'cc-agent', 'images');
}

export function getSessionDir(sessionId: string): string {
  return path.join(getCacheRoot(), sessionId);
}

function assertSafeSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('image-cache: sessionId required');
  }
  if (
    sessionId.includes('/') ||
    sessionId.includes('\\') ||
    sessionId.includes('..') ||
    sessionId.includes('\0') ||
    sessionId.includes(':')
  ) {
    throw new Error('image-cache: invalid sessionId');
  }
}

function assertSafeCacheFilename(filename: string): void {
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new Error('image-cache: filename required');
  }
  if (
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('..') ||
    filename.includes('\0') ||
    filename.includes(':')
  ) {
    throw new Error('image-cache: invalid filename');
  }
}

function inferExt(originalName?: string, mimeType?: string): string {
  // A dangerous display name always wins over MIME hints. Device-link refs are remote input;
  // a spoofed image MIME must not restore an executable extension or make it image-openable.
  if (originalName && isDangerousAttachmentName(originalName)) return '.bin';
  // Otherwise a trusted image mimeType wins over the name's extension: `writeBuffer` passes
  // the real content type, so a suggestedName like `clipboard.pdf` must not mislabel a PNG.
  if (mimeType && EXT_BY_MIME[mimeType]) return EXT_BY_MIME[mimeType];
  if (originalName) {
    const candidate = attachmentExtension(originalName);
    // Preserve every syntactically safe non-executable extension. A narrow format allowlist
    // previously changed valid files such as .zip/.blend/.psd into .bin on the receiving side.
    if (
      candidate &&
      SAFE_ATTACHMENT_EXT_RE.test(candidate) &&
      !isDangerousAttachmentName(originalName)
    ) {
      return candidate;
    }
  }
  return '.bin';
}

function buildFilename(ext: string): string {
  return `${randomUUID()}-${Date.now()}${ext}`;
}

function buildUrl(sessionId: string, filename: string): string {
  // Use a host (sessionId) + absolute path (filename) so it parses as a
  // standard URL: xdt-image://{sessionId}/{filename}
  return `${SCHEME}://${sessionId}/${filename}`;
}

function metaPathFor(absPath: string): string {
  return `${absPath}${META_SUFFIX}`;
}

function isMetaFilename(filename: string): boolean {
  return filename.endsWith(META_SUFFIX);
}

function parseSessionImageUrl(url: string): { sessionId: string; filename: string } | null {
  if (typeof url !== 'string' || !url.startsWith(`${SCHEME}://`)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  let host: string;
  let filename: string;
  try {
    host = decodeURIComponent(parsed.hostname);
    if (RESERVED_HOSTS[host]) return null;
    const pathnameRaw = parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname;
    filename = decodeURIComponent(pathnameRaw);
  } catch {
    return null;
  }

  try {
    assertSafeSessionId(host);
    assertSafeCacheFilename(filename);
  } catch {
    return null;
  }

  return { sessionId: host, filename };
}

function keyFor(sessionId: string, filename: string): string {
  return `${sessionId}\0${filename}`;
}

function absPathForSessionImage(sessionId: string, filename: string): string {
  return path.join(getSessionDir(sessionId), filename);
}

function buildMeta(params: {
  sessionId: string;
  filename: string;
  lifecycle: ImageCacheLifecycle;
  now: number;
  existing?: ImageCacheMeta | null;
}): ImageCacheMeta {
  return {
    version: 1,
    sessionId: params.sessionId,
    filename: params.filename,
    lifecycle: params.lifecycle,
    createdAt: params.existing?.createdAt ?? params.now,
    updatedAt: params.now,
  };
}

function isImageCacheMeta(value: unknown): value is ImageCacheMeta {
  if (!value || typeof value !== 'object') return false;
  const meta = value as Partial<ImageCacheMeta>;
  return (
    meta.version === 1 &&
    typeof meta.sessionId === 'string' &&
    typeof meta.filename === 'string' &&
    (meta.lifecycle === 'draft' || meta.lifecycle === 'committed') &&
    typeof meta.createdAt === 'number' &&
    Number.isFinite(meta.createdAt) &&
    typeof meta.updatedAt === 'number' &&
    Number.isFinite(meta.updatedAt)
  );
}

async function readMeta(absPath: string): Promise<ImageCacheMeta | null> {
  try {
    const raw = await fs.readFile(metaPathFor(absPath), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return isImageCacheMeta(parsed) ? parsed : null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return null;
    return null;
  }
}

async function writeMeta(absPath: string, meta: ImageCacheMeta): Promise<void> {
  await fs.writeFile(metaPathFor(absPath), `${JSON.stringify(meta)}\n`, 'utf8');
}

async function writeImageMeta(params: {
  absPath: string;
  sessionId: string;
  filename: string;
  lifecycle: ImageCacheLifecycle;
}): Promise<void> {
  const now = Date.now();
  const existing = await readMeta(params.absPath);
  await writeMeta(params.absPath, buildMeta({ ...params, now, existing }));
}

// ---------------------------------------------------------------------------
// Write APIs
// ---------------------------------------------------------------------------

export async function copyFromPath(params: {
  sessionId: string;
  sourcePath: string;
  originalName: string;
  lifecycle?: ImageCacheLifecycle;
}): Promise<{ url: string; filename: string }> {
  const { sessionId, sourcePath, originalName, lifecycle = 'committed' } = params;
  assertSafeSessionId(sessionId);
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
    throw new Error('image-cache: sourcePath required');
  }
  const sessionDir = getSessionDir(sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  const ext = inferExt(originalName);
  const filename = buildFilename(ext);
  const dest = path.join(sessionDir, filename);
  await fs.copyFile(sourcePath, dest);
  await writeImageMeta({ absPath: dest, sessionId, filename, lifecycle });
  return { url: buildUrl(sessionId, filename), filename };
}

export async function writeBuffer(params: {
  sessionId: string;
  buffer: Uint8Array;
  mimeType: string;
  suggestedName?: string;
  lifecycle?: ImageCacheLifecycle;
}): Promise<{ url: string; filename: string }> {
  const { sessionId, buffer, mimeType, suggestedName, lifecycle = 'committed' } = params;
  assertSafeSessionId(sessionId);
  if (!buffer || buffer.byteLength === 0) {
    throw new Error('image-cache: empty buffer');
  }
  const sessionDir = getSessionDir(sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  const ext = inferExt(suggestedName, mimeType);
  const filename = buildFilename(ext);
  const dest = path.join(sessionDir, filename);
  await fs.writeFile(dest, Buffer.from(buffer));
  await writeImageMeta({ absPath: dest, sessionId, filename, lifecycle });
  return { url: buildUrl(sessionId, filename), filename };
}

export async function writeBufferStable(params: {
  sessionId: string;
  buffer: Uint8Array;
  mimeType: string;
  filename: string;
  lifecycle?: ImageCacheLifecycle;
}): Promise<{ url: string; filename: string }> {
  const { sessionId, buffer, mimeType, filename, lifecycle = 'committed' } = params;
  assertSafeSessionId(sessionId);
  assertSafeCacheFilename(filename);
  if (!buffer || buffer.byteLength === 0) {
    throw new Error('image-cache: empty buffer');
  }
  const ext = path.extname(filename).toLowerCase();
  if (!MIME_BY_EXT[ext] || MIME_BY_EXT[ext] !== mimeType) {
    throw new Error('image-cache: filename extension does not match mimeType');
  }
  const sessionDir = getSessionDir(sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  const dest = path.join(sessionDir, filename);
  try {
    await fs.writeFile(dest, Buffer.from(buffer), { flag: 'wx' });
  } catch (err) {
    if (!err || typeof err !== 'object' || (err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
  }
  await writeImageMeta({ absPath: dest, sessionId, filename, lifecycle });
  return { url: buildUrl(sessionId, filename), filename };
}

export function toSessionImageCacheKey(url: string): string | null {
  const parsed = parseSessionImageUrl(url);
  return parsed ? keyFor(parsed.sessionId, parsed.filename) : null;
}

export function collectSessionImageUrls(value: unknown): string[] {
  const urls = new Set<string>();
  const visit = (item: unknown): void => {
    if (typeof item === 'string') {
      const matches = item.match(/\bxdt-image:\/\/[^\s"'<>()[\]{}]+/g);
      if (matches) {
        for (const match of matches) {
          if (toSessionImageCacheKey(match)) urls.add(match);
        }
      }
      const trimmed = item.trim();
      if (
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))
      ) {
        try {
          visit(JSON.parse(trimmed) as unknown);
        } catch {
          // Plain text that only looks like JSON; regex collection above is enough.
        }
      }
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (item && typeof item === 'object') {
      for (const child of Object.values(item as Record<string, unknown>)) {
        visit(child);
      }
    }
  };
  visit(value);
  return [...urls];
}

export async function markFilesCommitted(urls: Iterable<string>): Promise<{
  marked: number;
  skipped: number;
  errors: number;
}> {
  let marked = 0;
  let skipped = 0;
  let errors = 0;
  const seen = new Set<string>();

  for (const url of urls) {
    const parsed = parseSessionImageUrl(url);
    if (!parsed) {
      skipped += 1;
      continue;
    }
    const key = keyFor(parsed.sessionId, parsed.filename);
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      const absPath = absPathForSessionImage(parsed.sessionId, parsed.filename);
      await fs.access(absPath);
      await writeImageMeta({
        absPath,
        sessionId: parsed.sessionId,
        filename: parsed.filename,
        lifecycle: 'committed',
      });
      marked += 1;
    } catch {
      errors += 1;
    }
  }

  return { marked, skipped, errors };
}

export async function sweepDraftImages(params: {
  referencedUrls?: Iterable<string>;
  createdBeforeMs: number;
}): Promise<SweepDraftImagesResult> {
  const result: SweepDraftImagesResult = {
    scanned: 0,
    removed: 0,
    removedDanglingMeta: 0,
    skippedReferenced: 0,
    skippedFresh: 0,
    skippedMissingMeta: 0,
    errors: 0,
  };
  const referencedKeys = new Set<string>();
  for (const url of params.referencedUrls ?? []) {
    const key = toSessionImageCacheKey(url);
    if (key) referencedKeys.add(key);
  }

  let sessionDirs: Array<import('node:fs').Dirent>;
  try {
    sessionDirs = await fs.readdir(getCacheRoot(), { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return result;
    throw err;
  }

  for (const sessionDir of sessionDirs) {
    if (!sessionDir.isDirectory()) continue;
    const sessionId = sessionDir.name;
    try {
      assertSafeSessionId(sessionId);
    } catch {
      continue;
    }

    const dir = getSessionDir(sessionId);
    let entries: Array<import('node:fs').Dirent>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      result.errors += 1;
      continue;
    }

    const fileNames = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (isMetaFilename(entry.name)) {
        const imageName = entry.name.slice(0, -META_SUFFIX.length);
        if (!fileNames.has(imageName)) {
          try {
            await fs.rm(path.join(dir, entry.name), { force: true });
            result.removedDanglingMeta += 1;
          } catch {
            result.errors += 1;
          }
        }
        continue;
      }

      result.scanned += 1;
      const filename = entry.name;
      const absPath = path.join(dir, filename);
      const meta = await readMeta(absPath);
      if (!meta) {
        result.skippedMissingMeta += 1;
        continue;
      }
      if (meta.lifecycle !== 'draft') continue;

      if (referencedKeys.has(keyFor(sessionId, filename))) {
        result.skippedReferenced += 1;
        continue;
      }

      const createdAt = Number.isFinite(meta.createdAt) ? meta.createdAt : 0;
      if (createdAt >= params.createdBeforeMs) {
        result.skippedFresh += 1;
        continue;
      }

      try {
        await fs.rm(absPath, { force: true });
        await fs.rm(metaPathFor(absPath), { force: true });
        result.removed += 1;
      } catch {
        result.errors += 1;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Read / resolve APIs
// ---------------------------------------------------------------------------

export function resolveSafe(url: string): { absPath: string; mimeType: string } {
  if (typeof url !== 'string' || !url.startsWith(`${SCHEME}://`)) {
    throw new Error('xdt-image: invalid url');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('xdt-image: malformed url');
  }
  let host: string;
  let filename: string;
  try {
    host = decodeURIComponent(parsed.hostname);
    // pathname is e.g. "/abc-123.png" → strip leading slash
    const pathnameRaw = parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname;
    filename = decodeURIComponent(pathnameRaw);
  } catch {
    throw new Error('xdt-image: malformed url');
  }

  if (
    !host ||
    !filename ||
    host.includes('..') ||
    host.includes('\0') ||
    filename.includes('..') ||
    filename.includes('\0') ||
    filename.includes('/') ||
    filename.includes('\\')
  ) {
    throw new Error('xdt-image: path out of bounds');
  }

  // ── Reserved-host fast path ───────────────────────────────────────────────
  // Routes like xdt-image://feishu-media-images/{filename} bypass the
  // session-id rules and resolve under their own integration cache root.
  const reservedDirFn = RESERVED_HOSTS[host];
  if (reservedDirFn) {
    const baseDir = path.resolve(reservedDirFn());
    const absPath = path.resolve(baseDir, filename);
    if (!absPath.startsWith(baseDir + path.sep)) {
      throw new Error('xdt-image: path out of bounds');
    }
    const ext = path.extname(filename).toLowerCase();
    const mimeType = MIME_BY_EXT[ext] ?? 'application/octet-stream';
    return { absPath, mimeType };
  }

  // ── Session-id path (existing behaviour) ──────────────────────────────────
  const sessionId = host;
  try {
    assertSafeSessionId(sessionId);
  } catch {
    throw new Error('xdt-image: path out of bounds');
  }

  const cacheRoot = path.resolve(getCacheRoot());
  const absPath = path.resolve(getSessionDir(sessionId), filename);
  // path.sep guards prefix matching: prevents `/cache_evil` matching `/cache`.
  // Since sessionId + filename are validated to contain no path separators,
  // absPath is always two levels deeper than cacheRoot — equality check would
  // be unreachable, so we only check the prefix.
  if (!absPath.startsWith(cacheRoot + path.sep)) {
    throw new Error('xdt-image: path out of bounds');
  }

  const ext = path.extname(filename).toLowerCase();
  const mimeType = MIME_BY_EXT[ext] ?? 'application/octet-stream';
  return { absPath, mimeType };
}

/**
 * resolveSessionImageLenient — 宽容版会话图片解析,仅供 ghost 附件过户等
 * "AI 递地址"的低频场景;`xdt-image://` 协议 handler 等安全敏感路径继续用
 * 严格的 `resolveSafe`。
 *
 * 模型对同一张会话图片可能只握有三种写法之一(实测两个会话都把规范地址
 * 拼错过),三种写法都无歧义地指向缓存内同一文件,这里统一归一化,不再
 * 指望模型拼对格式:
 *   1. 规范地址 `xdt-image://<sessionId>/<filename>`(含保留 host)→ resolveSafe;
 *   2. 本地绝对路径(用户消息里 @ 出来的 `cc-agent/images/<sessionId>/<file>`)
 *      → 必须落在缓存根内、恰好 <sessionId>/<filename> 两级,否则拒;
 *   3. 丢了会话段的 `xdt-image://<filename>` → 文件名为 uuid-timestamp 全局
 *      唯一,同步扫一层会话目录定位宿主(过户低频,扫描量 = 会话目录数)。
 * 归一化不放宽任何边界:成功结果永远指向 session 图片缓存根之内的文件。
 */
export function resolveSessionImageLenient(input: string): { absPath: string; mimeType: string } {
  let strictErr: unknown;
  try {
    return resolveSafe(input);
  } catch (err) {
    strictErr = err;
  }
  if (typeof input !== 'string' || input.includes('\0')) throw strictErr;

  const cacheRoot = path.resolve(getCacheRoot());
  const mimeFor = (name: string): string =>
    MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'application/octet-stream';

  // ── 2. 缓存根内的本地绝对路径 ─────────────────────────────────────────────
  if (path.isAbsolute(input)) {
    const absPath = path.resolve(input);
    const rel = path.relative(cacheRoot, absPath);
    const parts = rel === '' ? [] : rel.split(path.sep);
    if (
      !rel.startsWith('..') &&
      !path.isAbsolute(rel) &&
      parts.length === 2 &&
      parts[0] !== '' &&
      parts[1] !== '' &&
      !parts[1].endsWith(META_SUFFIX)
    ) {
      return { absPath, mimeType: mimeFor(absPath) };
    }
    throw strictErr;
  }

  // ── 3. 丢了会话段的 xdt-image://<filename> ────────────────────────────────
  // 不走 URL 解析(hostname 会被小写化),直接对原文匹配"单段文件名 + 扩展名";
  // 字符类排除了路径分隔符,拼接后不可能逃出会话目录。
  const droppedSession = input.match(/^xdt-image:\/\/([^/\\?#]+\.[A-Za-z0-9]+)$/);
  if (droppedSession) {
    const filename = droppedSession[1];
    let sessionDirs: string[] = [];
    try {
      sessionDirs = readdirSync(cacheRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      // 缓存根不存在 → 按未命中处理
    }
    for (const dir of sessionDirs) {
      const candidate = path.join(cacheRoot, dir, filename);
      if (existsSync(candidate)) {
        return { absPath: candidate, mimeType: mimeFor(filename) };
      }
    }
  }

  throw strictErr;
}

export async function readFile(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const { absPath, mimeType } = resolveSafe(url);
  const buffer = await fs.readFile(absPath);
  return { buffer, mimeType };
}

export async function readAsBase64(url: string): Promise<{ base64: string; mimeType: string }> {
  const { absPath, mimeType } = resolveSafe(url);
  const buffer = await fs.readFile(absPath);
  return { base64: buffer.toString('base64'), mimeType };
}

// ---------------------------------------------------------------------------
// Delete APIs
// ---------------------------------------------------------------------------

export async function removeFile(url: string): Promise<void> {
  let absPath: string;
  try {
    absPath = resolveSafe(url).absPath;
  } catch {
    return; // invalid url → nothing to delete
  }
  // `force: true` already silently ignores ENOENT — no extra catch needed for
  // missing files. Remove the sidecar too; otherwise a direct-send rejection
  // would leave an unreferenced committed cache entry behind.
  await fs.rm(absPath, { force: true });
  await fs.rm(metaPathFor(absPath), { force: true });
}

export async function removeSession(sessionId: string): Promise<void> {
  assertSafeSessionId(sessionId);
  try {
    await fs.rm(getSessionDir(sessionId), { recursive: true, force: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return;
    throw err;
  }
}
