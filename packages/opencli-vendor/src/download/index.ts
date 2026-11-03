/**
 * Download utilities: HTTP downloads, yt-dlp wrapper, format conversion.
 */

import { recipeFileExistsSync, statRecipeFileSync, closeRecipeFileSync, openRecipeOutputFileSync, recipeCopySource, recipeOutputPath, recipeTemporaryDirectory, resolveRecipePath } from '@jackwener/opencli/cindy/host';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { URL } from 'node:url';
import type { BrowserCookie } from '../types.js';
import { getErrorMessage } from '../errors.js';
import { fetchWithSsrFGuard } from '@cindy/browser-control-runtime/ssrf-runtime';
import { log } from '../logger.js';

export type { BrowserCookie } from '../types.js';

export interface DownloadOptions {
  cookies?: string;
  headers?: Record<string, string>;
  timeout?: number;
  onProgress?: (received: number, total: number) => void;
  maxRedirects?: number;
  maxBytes?: number;
  /** Include the final response MIME type in the result. */
  includeContentType?: boolean;
}

export interface HttpDownloadResult {
  success: boolean;
  size: number;
  error?: string;
  contentType?: string;
  finalUrl?: string;
}

export interface YtdlpOptions {
  cookies?: string;
  cookiesFile?: string;
  format?: string;
  extraArgs?: string[];
  onProgress?: (percent: number) => void;
}

/** Check if yt-dlp is available in PATH. */
export function checkYtdlp(): boolean {
  try {
    execFileSync(os.platform() === 'win32' ? 'where' : 'which', ['yt-dlp'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Domains that host video content and can be downloaded via yt-dlp. */
const VIDEO_PLATFORM_DOMAINS = [
  'youtube.com', 'youtu.be', 'bilibili.com', 'twitter.com',
  'x.com', 'tiktok.com', 'vimeo.com', 'twitch.tv',
];

/**
 * Whether a URL's host is a known video platform.
 *
 * Matches on the parsed hostname with a domain boundary (exact host or a
 * subdomain) rather than a raw substring of the whole URL. A plain
 * `url.includes('x.com')` wrongly classifies `netflix.com`, `max.com`, etc.
 * (and any URL whose path merely contains a token like `youtu.be`) as a
 * video platform, routing ordinary files to yt-dlp and mislabelling content
 * types. Mirrors the host-boundary check used in execution.ts.
 */
function isVideoPlatformUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return VIDEO_PLATFORM_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.bmp', '.avif']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.avi', '.mov', '.mkv', '.flv', '.m3u8', '.ts']);
const DOC_EXTENSIONS = new Set(['.html', '.htm', '.json', '.xml', '.txt', '.md', '.markdown']);

/**
 * Detect content type from URL and optional headers.
 */
export function detectContentType(url: string, contentType?: string): 'image' | 'video' | 'document' | 'binary' {
  if (contentType) {
    if (contentType.startsWith('image/')) return 'image';
    if (contentType.startsWith('video/')) return 'video';
    if (contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('xml')) return 'document';
  }

  const ext = path.extname(new URL(url).pathname).toLowerCase();

  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (isVideoPlatformUrl(url)) return 'video';
  if (DOC_EXTENSIONS.has(ext)) return 'document';
  return 'binary';
}

/**
 * Check if URL requires yt-dlp for download.
 */
export function requiresYtdlp(url: string): boolean {
  return isVideoPlatformUrl(url);
}

/**
 * HTTP download with progress callback.
 */
export async function httpDownload(
  url: string,
  destPath: string,
  options: DownloadOptions = {},
  redirectCount = 0,
): Promise<HttpDownloadResult> {
  const {
    cookies, headers = {}, timeout = 30000, onProgress, maxRedirects = 10, maxBytes = Infinity, includeContentType = false,
  } = options;

  const requestHeaders: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    ...headers,
  };

  if (cookies) {
    requestHeaders['Cookie'] = cookies;
  }

  const tempPath = `${destPath}.tmp`;

  const cleanupTempFile = async () => {
    try {
      await fs.promises.rm(recipeOutputPath(tempPath), { force: true });
    } catch {
      // Ignore cleanup errors so the original failure is preserved.
    }
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response: Response | undefined;
  let release: (() => Promise<void>) | undefined;
  try {
    // The shared guard owns DNS/IP checks, address pinning and every redirect.
    const guarded = await fetchWithSsrFGuard({
      url, init: { headers: requestHeaders }, signal: controller.signal,
      maxRedirects: Math.max(0, maxRedirects - redirectCount),
    });
    response = guarded.response;
    release = guarded.release;

    if (response.status !== 200) {
      return { success: false, size: 0, error: `HTTP ${response.status}` };
    }

    if (!response.body) {
      return { success: false, size: 0, error: 'Empty response body' };
    }

    const totalSize = parseInt(response.headers.get('content-length') || '0', 10);
    if (totalSize > maxBytes) throw new Error('Download byte limit exceeded');
    let received = 0;
    const progressStream = new Transform({
      transform(chunk, _encoding, callback) {
        try {
          if (received + chunk.length > maxBytes) throw new Error('Download byte limit exceeded');
          received += chunk.length;
          onProgress?.(received, totalSize);
          callback(null, chunk);
        } catch (error) {
          controller.abort();
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });

    try {
      await fs.promises.mkdir(recipeOutputPath(path.dirname(destPath)), { recursive: true });
      await pipeline(
        Readable.fromWeb(response.body as unknown as WebReadableStream),
        progressStream,
        fs.createWriteStream(recipeOutputPath(tempPath)),
      );
      await fs.promises.rename(recipeOutputPath(tempPath), recipeOutputPath(destPath));
      const contentType = includeContentType
        ? response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
        : undefined;
      return {
        success: true,
        size: received,
        ...(includeContentType && { finalUrl: guarded.finalUrl }),
        ...(contentType && { contentType }),
      };
    } catch (err) {
      await cleanupTempFile();
      return { success: false, size: 0, error: getErrorMessage(err) };
    }
  } catch (err) {
    await cleanupTempFile();
    return { success: false, size: 0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
    await response?.body?.cancel().catch(() => undefined);
    await release?.();
  }
}

export function resolveRedirectUrl(currentUrl: string, location: string): string {
  return new URL(location, currentUrl).toString();
}

function stripCookieHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return headers;
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'cookie'),
  );
}

/**
 * Export cookies to Netscape format for yt-dlp.
 */
export function exportCookiesToNetscape(
  cookies: BrowserCookie[],
  filePath: string,
): void {
  const lines = [
    '# Netscape HTTP Cookie File',
    '# https://curl.se/docs/http-cookies.html',
    '# This is a generated file!  Do not edit.',
    '',
  ];

  for (const cookie of cookies) {
    const domain = cookie.domain.startsWith('.') ? cookie.domain : `.${cookie.domain}`;
    const includeSubdomains = 'TRUE';
    const cookiePath = cookie.path || '/';
    const secure = cookie.secure ? 'TRUE' : 'FALSE';
    const expiry = typeof cookie.expirationDate === 'number' && cookie.expirationDate > 0
      ? Math.floor(cookie.expirationDate)
      : Math.floor(Date.now() / 1000) + 86400 * 365; // fallback: 1 year from now
    const safeName = cookie.name.replace(/[\t\n\r]/g, '');
    const safeValue = cookie.value.replace(/[\t\n\r]/g, '');
    lines.push(`${domain}\t${includeSubdomains}\t${cookiePath}\t${secure}\t${expiry}\t${safeName}\t${safeValue}`);
  }

  fs.mkdirSync(recipeOutputPath(path.dirname(filePath)), { recursive: true });
  // 0o600: file holds live session cookies, must be owner-only. fchmod before
  // writing also tightens a pre-existing broad file before new secrets land.
  let fd: number | undefined;
  try {
    fd = openRecipeOutputFileSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
    fs.fchmodSync(recipeOutputPath(fd), 0o600);
    fs.writeFileSync(recipeOutputPath(fd), lines.join('\n'), 'utf8');
  } finally {
    if (fd !== undefined) {
      closeRecipeFileSync(fd);
    }
  }
}

export function formatCookieHeader(cookies: BrowserCookie[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

/**
 * Download video using yt-dlp.
 */
export async function ytdlpDownload(
  url: string,
  destPath: string,
  options: YtdlpOptions = {},
): Promise<{ success: boolean; size: number; error?: string }> {
  destPath = recipeOutputPath(destPath);
  const { cookiesFile: rawCookiesFile, format = 'best', extraArgs = [], onProgress } = options;
  const cookiesFile = rawCookiesFile ? recipeCopySource(rawCookiesFile) : undefined;

  if (!checkYtdlp()) {
    return { success: false, size: 0, error: 'yt-dlp not installed. Install with: pip install yt-dlp' };
  }

  return new Promise((resolve) => {
    const dir = path.dirname(destPath);
    fs.mkdirSync(recipeOutputPath(dir), { recursive: true });

    // Build yt-dlp arguments
    const args = [
      '--ignore-config',
      url,
      '-o', destPath,
      '-f', format,
      '--no-playlist',
      '--progress',
    ];

    // Only the invoking browser's scoped cookie file; never the system Chrome profile.
    if (cookiesFile) args.push('--cookies', cookiesFile);

    args.push(...extraArgs);

    const proc = spawn('yt-dlp', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let lastPercent = 0;
    let errorOutput = '';

    proc.stderr.on('data', (data: Buffer) => {
      const line = data.toString();
      errorOutput += line;

      // Parse progress from yt-dlp output
      const match = line.match(/(\d+\.?\d*)%/);
      if (match && onProgress) {
        const percent = parseFloat(match[1]);
        if (percent > lastPercent) {
          lastPercent = percent;
          onProgress(percent);
        }
      }
    });

    proc.stdout.on('data', (data: Buffer) => {
      const line = data.toString();
      const match = line.match(/(\d+\.?\d*)%/);
      if (match && onProgress) {
        const percent = parseFloat(match[1]);
        if (percent > lastPercent) {
          lastPercent = percent;
          onProgress(percent);
        }
      }
    });

    proc.on('close', (code) => {
      if (code === 0 && recipeFileExistsSync(destPath)) {
        const stats = statRecipeFileSync(destPath);
        resolve({ success: true, size: stats.size });
      } else {
        // Check for common yt-dlp output patterns
        const patterns = fs.readdirSync(recipeOutputPath(dir)).filter(f => f.startsWith(path.basename(destPath, path.extname(destPath))));
        if (patterns.length > 0) {
          const actualFile = path.join(dir, patterns[0]);
          const stats = statRecipeFileSync(actualFile);
          resolve({ success: true, size: stats.size });
        } else {
          resolve({ success: false, size: 0, error: errorOutput.slice(0, 200) || `Exit code ${code}` });
        }
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, size: 0, error: err.message });
    });
  });
}

/**
 * Save document content to file.
 */
export async function saveDocument(
  content: string,
  destPath: string,
  format: 'json' | 'markdown' | 'html' | 'text' = 'markdown',
  metadata?: Record<string, unknown>,
): Promise<{ success: boolean; size: number; error?: string }> {
  try {
    const dir = path.dirname(destPath);
    fs.mkdirSync(recipeOutputPath(dir), { recursive: true });

    let output: string;

    if (format === 'json') {
      output = JSON.stringify({ ...metadata, content }, null, 2);
    } else if (format === 'markdown') {
      // Add frontmatter if metadata exists
      const frontmatter = metadata ? `---\n${Object.entries(metadata).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n\n` : '';
      output = frontmatter + content;
    } else {
      output = content;
    }

    fs.writeFileSync(recipeOutputPath(destPath), output, 'utf-8');
    return { success: true, size: Buffer.byteLength(output, 'utf-8') };
  } catch (err) {
    return { success: false, size: 0, error: getErrorMessage(err) };
  }
}

/**
 * Sanitize filename by removing invalid characters.
 */
export function sanitizeFilename(name: string, maxLength: number = 200): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') // Remove invalid chars
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .replace(/_+/g, '_') // Collapse multiple underscores
    .replace(/^_|_$/g, '') // Trim underscores
    .slice(0, maxLength);
}

/**
 * Generate filename from URL if not provided.
 */
export function generateFilename(url: string, index: number, extension?: string): string {
  try {
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname;
    const basename = path.basename(pathname);

    if (basename && basename !== '/' && basename.includes('.')) {
      return sanitizeFilename(basename);
    }

    // Generate from hostname and index
    const ext = extension || detectExtension(url);
    const hostname = parsedUrl.hostname.replace(/^www\./, '');
    return sanitizeFilename(`${hostname}_${index + 1}${ext}`);
  } catch {
    const ext = extension || '.bin';
    return `download_${index + 1}${ext}`;
  }
}

/**
 * Detect file extension from URL.
 */
function detectExtension(url: string): string {
  const type = detectContentType(url);
  switch (type) {
    case 'image': return '.jpg';
    case 'video': return '.mp4';
    case 'document': return '.md';
    default: return '.bin';
  }
}

/**
 * Get temp directory for cookie files.
 */
export function getTempDir(): string {
  return path.join(recipeTemporaryDirectory(), 'opencli-download');
}
