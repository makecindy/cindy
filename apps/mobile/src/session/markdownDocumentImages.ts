/**
 * markdownDocumentImages — pure resolution, bounded fetch scheduling, and
 * ImageLightbox gallery construction for images embedded inside Markdown files
 * previewed on Mobile.
 *
 * Kept free of React / React Native / Expo runtime imports so every path edge
 * case, security boundary (UNC / SSH workdir), concurrency limit, and memory
 * budget is directly unit-testable in Node Vitest.
 */
import {
  classifyChatPathLinkTarget,
  isUncPathOutsideWorkdir,
  pathDisplayName,
  resolveChatAbsPath,
  toWorkdirRel,
} from '@/session/chatPathCandidate';
import { remoteFileMediaUrl, type RemoteMediaSshContext } from '@/session/fileBrowserGallery';
import {
  bytesForDataUriChars,
  dataUriCharsForBytes,
  htmlBaseDirOf,
} from '@/session/htmlLocalResources';
import type { MobileMessageGalleryImage } from '@/session/messageGallery';
import {
  collectMobileMarkdownImages,
  isMobileMarkdownImageDirectUrl,
  mobileMarkdownImageTitle,
} from '@/session/messageMarkdown';
import { buildMediaPayload } from '@/session/messagePayload';

/** Maximum number of distinct remote images fetched per Markdown document. */
export const MARKDOWN_DOC_IMAGE_LIMIT = 40;
/** Per-image byte limit when falling back from inline thumbnails to OSS download. */
export const MARKDOWN_DOC_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** Total character budget for inlined `data:` URIs inside the Markdown WebView. */
export const MARKDOWN_DOC_IMAGE_TOTAL_MAX_CHARS = 12 * 1024 * 1024;

const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};

const WIN_DRIVE_RE = /^([A-Za-z]:)([\\/])/;

export interface MarkdownDocumentImageEntry {
  /** 0-based document order index matching `data-xdt-img-index` in rendered HTML. */
  index: number;
  /** Raw URL as parsed from Markdown (used as key for WebView DOM hydration). */
  rawUrl: string;
  alt: string;
  title: string;
  kind: 'direct' | 'remote' | 'unresolvable';
  /** Canonical loadable URL (`https://...` for direct, `xdt-file://` / `xdt-image://` / `cindy-media://` for remote). */
  fetchUrl: string | null;
  fileName: string;
  mimeType: string;
}

export type MarkdownImageResolution =
  | { status: 'ready'; uri: string }
  /**
   * Inline WebView thumbnail could not be loaded (e.g. >40th image, over inline
   * data-URI budget, oversize fallback, or transient error), while the image
   * still has a valid `fetchUrl` in the gallery and remains tappable to open
   * full-resolution `ImageLightbox` on demand.
   */
  | { status: 'deferred' }
  /** Path or scheme is unresolvable / blocked by security boundary; not clickable. */
  | { status: 'error' };

export interface ResolveMarkdownDocumentImageOptions {
  ssh?: RemoteMediaSshContext | null;
  versionMs?: number;
}

function safeDecodeOnce(value: string): string {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripQueryAndHash(value: string): string {
  const hashIdx = value.indexOf('#');
  const beforeHash = hashIdx >= 0 ? value.slice(0, hashIdx) : value;
  const queryIdx = beforeHash.indexOf('?');
  return queryIdx >= 0 ? beforeHash.slice(0, queryIdx) : beforeHash;
}

function imageMimeForPath(fsPath: string): string | null {
  const dot = fsPath.lastIndexOf('.');
  if (dot < 0) return null;
  const lastSep = Math.max(fsPath.lastIndexOf('/'), fsPath.lastIndexOf('\\'));
  if (dot < lastSep) return null;
  return IMAGE_MIME_BY_EXT[fsPath.slice(dot).toLowerCase()] ?? null;
}

/**
 * Collapse `.` and `..` segments in a resolved absolute path while keeping
 * separator style intact. Allows `docs/guide.md` to reference `../img/a.png`
 * cleanly before checking SSH workdir containment.
 */
export function normalizeAbsPathSegments(absPath: string): string {
  if (!/(?:^|[\\/])\.\.?(?:[\\/]|$)/.test(absPath)) return absPath;
  if (absPath.startsWith('\\\\')) return absPath;
  const winDrive = WIN_DRIVE_RE.exec(absPath);
  const sep = winDrive ? winDrive[2] : '/';
  const prefix = winDrive ? `${winDrive[1]}${sep}` : absPath.startsWith('/') ? '/' : '';
  if (!prefix) return absPath;
  const rest = absPath.slice(prefix.length);
  const parts = rest.split(/[\\/]/);
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return `${prefix}${stack.join(sep)}`;
}

function extractXdtFilePath(url: string): string | null {
  try {
    if (/^xdt-file:\/\/\//i.test(url)) {
      const raw = safeDecodeOnce(url.slice('xdt-file://'.length).split(/[?#]/, 1)[0]);
      return /^\/[A-Za-z]:[\\/]/.test(raw) ? raw.slice(1) : raw;
    }
    const parsed = new URL(url);
    return parsed.searchParams.get('path');
  } catch {
    return null;
  }
}

export function resolveMarkdownDocumentImageTarget(
  rawUrl: string,
  docAbsPath: string,
  options: ResolveMarkdownDocumentImageOptions = {},
): Pick<MarkdownDocumentImageEntry, 'kind' | 'fetchUrl' | 'fileName' | 'mimeType'> {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { kind: 'unresolvable', fetchUrl: null, fileName: 'image.png', mimeType: 'image/png' };
  }

  if (isMobileMarkdownImageDirectUrl(trimmed)) {
    const cleanPath = stripQueryAndHash(trimmed);
    const fileName = pathDisplayName(cleanPath) || 'image.png';
    return {
      kind: 'direct',
      fetchUrl: trimmed,
      fileName,
      mimeType: imageMimeForPath(cleanPath) ?? 'image/png',
    };
  }

  if (trimmed.startsWith('xdt-image://') || trimmed.startsWith('cindy-media://')) {
    if (options.ssh) {
      return { kind: 'unresolvable', fetchUrl: null, fileName: 'image.png', mimeType: 'image/png' };
    }
    const cleanPath = stripQueryAndHash(trimmed);
    const fileName = pathDisplayName(cleanPath) || 'image.png';
    return {
      kind: 'remote',
      fetchUrl: trimmed,
      fileName,
      mimeType: imageMimeForPath(cleanPath) ?? 'image/png',
    };
  }

  const baseDir = docAbsPath ? htmlBaseDirOf(docAbsPath) : '';
  let absPath: string | null = null;

  if (/^xdt-file:\/\//i.test(trimmed)) {
    absPath = extractXdtFilePath(trimmed);
  } else {
    if (!classifyChatPathLinkTarget(trimmed)) {
      return { kind: 'unresolvable', fetchUrl: null, fileName: 'image.png', mimeType: 'image/png' };
    }
    if (trimmed.startsWith('file://')) {
      absPath = resolveChatAbsPath(stripQueryAndHash(trimmed), baseDir || '/');
    } else {
      const stripped = safeDecodeOnce(stripQueryAndHash(trimmed));
      const isAbsolute = stripped.startsWith('/') || WIN_DRIVE_RE.test(stripped) || stripped.startsWith('\\\\');
      if (!isAbsolute && !baseDir) {
        return { kind: 'unresolvable', fetchUrl: null, fileName: 'image.png', mimeType: 'image/png' };
      }
      absPath = resolveChatAbsPath(stripped, baseDir);
    }
  }

  if (!absPath) {
    return { kind: 'unresolvable', fetchUrl: null, fileName: 'image.png', mimeType: 'image/png' };
  }

  const normalizedAbs = normalizeAbsPathSegments(absPath);
  const mimeType = imageMimeForPath(normalizedAbs);
  if (!mimeType) {
    return { kind: 'unresolvable', fetchUrl: null, fileName: pathDisplayName(normalizedAbs) || 'image', mimeType: 'application/octet-stream' };
  }

  const securityBoundary = options.ssh?.workdir ?? baseDir;
  if (securityBoundary && isUncPathOutsideWorkdir(securityBoundary, normalizedAbs)) {
    return { kind: 'unresolvable', fetchUrl: null, fileName: pathDisplayName(normalizedAbs) || 'image.png', mimeType };
  }
  if (options.ssh && toWorkdirRel(options.ssh.workdir, normalizedAbs) === null) {
    return { kind: 'unresolvable', fetchUrl: null, fileName: pathDisplayName(normalizedAbs) || 'image.png', mimeType };
  }

  return {
    kind: 'remote',
    fetchUrl: remoteFileMediaUrl(normalizedAbs, options.versionMs, options.ssh),
    fileName: pathDisplayName(normalizedAbs) || 'image.png',
    mimeType,
  };
}

/**
 * Extract all images in a Markdown document in exact rendered order (matching
 * `selectableMarkdownHtml`'s `data-xdt-img-index`).
 */
export function collectMarkdownDocumentImages(
  markdown: string,
  docAbsPath: string,
  options: ResolveMarkdownDocumentImageOptions = {},
): MarkdownDocumentImageEntry[] {
  return collectMobileMarkdownImages(markdown, { allowLocalHtmlImages: true }).map((inline, index) => {
    const resolved = resolveMarkdownDocumentImageTarget(inline.url, docAbsPath, options);
    return {
      index,
      rawUrl: inline.url,
      alt: inline.alt,
      title: mobileMarkdownImageTitle(resolved.fileName || inline.url, inline.alt),
      ...resolved,
    };
  });
}

export interface MarkdownDocumentImageFetchTarget {
  rawUrl: string;
  fetchUrl: string;
  mimeType: string;
  refCount: number;
}

/** Deduplicate fetchable remote images by `rawUrl` while capping total count. */
export function planMarkdownDocumentImageFetches(
  entries: readonly MarkdownDocumentImageEntry[],
  limit = MARKDOWN_DOC_IMAGE_LIMIT,
): {
  targets: MarkdownDocumentImageFetchTarget[];
  overLimitRawUrls: string[];
} {
  const byRawUrl = new Map<string, MarkdownDocumentImageFetchTarget>();
  const targets: MarkdownDocumentImageFetchTarget[] = [];
  const overLimit = new Set<string>();

  for (const entry of entries) {
    if (entry.kind !== 'remote' || !entry.fetchUrl) continue;
    const existing = byRawUrl.get(entry.rawUrl);
    if (existing) {
      existing.refCount += 1;
      continue;
    }
    if (targets.length >= limit) {
      overLimit.add(entry.rawUrl);
      continue;
    }
    const target: MarkdownDocumentImageFetchTarget = {
      rawUrl: entry.rawUrl,
      fetchUrl: entry.fetchUrl,
      mimeType: entry.mimeType,
      refCount: 1,
    };
    byRawUrl.set(entry.rawUrl, target);
    targets.push(target);
  }

  return { targets, overLimitRawUrls: [...overLimit] };
}

/**
 * Attach a host-enforced `maxBytes` constraint to `xdt-file://` preview URLs
 * so remote hosts reject oversize fallback uploads / SSH transfers before
 * spending bandwidth. Non-`xdt-file://` URLs pass through unchanged.
 */
export function appendRemoteMediaMaxBytes(fetchUrl: string, maxBytes: number): string {
  if (!fetchUrl.startsWith('xdt-file://') || !Number.isFinite(maxBytes) || maxBytes <= 0) {
    return fetchUrl;
  }
  const capped = Math.floor(maxBytes);
  if (/(?:[?&])maxBytes=/.test(fetchUrl)) {
    return fetchUrl.replace(/([?&])maxBytes=[^&#]*/, `$1maxBytes=${capped}`);
  }
  const hashIdx = fetchUrl.indexOf('#');
  const base = hashIdx >= 0 ? fetchUrl.slice(0, hashIdx) : fetchUrl;
  const hash = hashIdx >= 0 ? fetchUrl.slice(hashIdx) : '';
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}maxBytes=${capped}${hash}`;
}

/**
 * Fetch Markdown document images with bounded concurrency and cumulative
 * data-URI memory budget, notifying `onResult` incrementally as each image
 * settles so the WebView can hydrate images progressively without reloading.
 */
export async function fetchMarkdownDocumentImages(
  targets: readonly MarkdownDocumentImageFetchTarget[],
  fetchOne: (
    target: MarkdownDocumentImageFetchTarget,
    limits: { maxBytes: number },
  ) => Promise<string | null>,
  options: {
    concurrency?: number;
    totalBudgetChars?: number;
    perImageMaxBytes?: number;
    isCancelled?: () => boolean;
    onResult?: (rawUrl: string, resolution: MarkdownImageResolution) => void;
  } = {},
): Promise<Map<string, MarkdownImageResolution>> {
  const results = new Map<string, MarkdownImageResolution>();
  if (targets.length === 0) return results;

  const concurrency = Math.max(1, options.concurrency ?? 3);
  const totalBudget = options.totalBudgetChars ?? MARKDOWN_DOC_IMAGE_TOTAL_MAX_CHARS;
  const perImageMaxBytes = options.perImageMaxBytes ?? MARKDOWN_DOC_IMAGE_MAX_BYTES;
  const isCancelled = options.isCancelled ?? (() => false);

  let cursor = 0;
  let usedChars = 0;

  const record = (rawUrl: string, resolution: MarkdownImageResolution) => {
    results.set(rawUrl, resolution);
    if (!isCancelled()) options.onResult?.(rawUrl, resolution);
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (isCancelled()) return;
      const idx = cursor;
      cursor += 1;
      if (idx >= targets.length) return;
      const target = targets[idx];
      const remainingChars = totalBudget - usedChars;
      const maxBytes = Math.min(perImageMaxBytes, bytesForDataUriChars(remainingChars));
      if (maxBytes <= 0) {
        record(target.rawUrl, { status: 'deferred' });
        continue;
      }
      try {
        const uri = await fetchOne(target, { maxBytes });
        if (isCancelled()) return;
        if (uri && uri.startsWith('data:image/') && usedChars + uri.length <= totalBudget) {
          usedChars += uri.length;
          record(target.rawUrl, { status: 'ready', uri });
        } else if (uri && uri.startsWith('data:image/') && usedChars + dataUriCharsForBytes(0) <= totalBudget) {
          // Over budget: keep slot tappable to open full-res ImageLightbox on demand.
          record(target.rawUrl, { status: 'deferred' });
        } else {
          record(target.rawUrl, { status: 'deferred' });
        }
      } catch {
        if (!isCancelled()) record(target.rawUrl, { status: 'deferred' });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return results;
}

/** Build the Mobile `ImageLightbox` gallery list for a Markdown document. */
export function buildMarkdownDocumentGallery(
  entries: readonly MarkdownDocumentImageEntry[],
  resolvedImages: ReadonlyMap<string, MarkdownImageResolution>,
): {
  images: MobileMessageGalleryImage[];
  keyForEntryIndex(index: number): { key: string; url: string } | null;
} {
  const images: MobileMessageGalleryImage[] = [];
  const byIndex = new Map<number, { key: string; url: string }>();

  for (const entry of entries) {
    if ((entry.kind !== 'direct' && entry.kind !== 'remote') || !entry.fetchUrl) continue;
    const key = `md-doc-img:${entry.index}`;
    const resolved = resolvedImages.get(entry.rawUrl);
    const previewUri = resolved?.status === 'ready' ? resolved.uri : undefined;
    const payload = buildMediaPayload(
      {
        kind: 'image',
        url: entry.fetchUrl,
        title: entry.title,
        previewable: entry.kind === 'direct',
        mimeType: entry.mimeType,
      },
      entry.title,
    );
    if (payload.kind !== 'media') continue;
    images.push({
      key,
      title: entry.title,
      url: entry.fetchUrl,
      payload,
      ...(previewUri ? { previewUri } : {}),
    });
    byIndex.set(entry.index, { key, url: entry.fetchUrl });
  }

  return {
    images,
    keyForEntryIndex: (index: number) => byIndex.get(index) ?? null,
  };
}
