import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { BrowserControlResult } from '@cindy/browser-control-runtime';
import type { ResolvedBrowserScreenshot } from '@cindy/mcps';

import { readBoundedFileNoFollow } from '../utils/readBoundedFile.js';

const MAX_BROWSER_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface BrowserScreenshotResolverOptions {
  runtimeDir: string | undefined;
}

function sniffScreenshotMime(buffer: Buffer): ResolvedBrowserScreenshot['mimeType'] | null {
  if (buffer.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
    return 'image/png';
  }
  if (buffer.byteLength >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  return null;
}

function decodeStrictBase64(value: string): Buffer | null {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    value.length > Math.ceil(MAX_BROWSER_SCREENSHOT_BYTES / 3) * 4 + 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    return null;
  }
  const buffer = Buffer.from(value, 'base64');
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_BROWSER_SCREENSHOT_BYTES) return null;
  return buffer.toString('base64') === value ? buffer : null;
}

function isLexicallyWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
}

async function readExternalScreenshot(
  filePath: string,
  runtimeDir: string | undefined,
): Promise<Buffer> {
  if (!runtimeDir || !path.isAbsolute(filePath)) {
    throw new Error('Browser screenshot file is unavailable');
  }
  const mediaRoot = path.resolve(runtimeDir, 'media', 'browser');
  const candidate = path.resolve(filePath);
  if (!isLexicallyWithinRoot(candidate, mediaRoot)) {
    throw new Error('Browser screenshot file is unavailable');
  }
  try {
    const realRoot = await fs.realpath(mediaRoot);
    const buffer = await readBoundedFileNoFollow(candidate, MAX_BROWSER_SCREENSHOT_BYTES, {
      containWithin: realRoot,
    });
    if (!buffer || buffer.byteLength === 0) {
      throw new Error('Browser screenshot file is unavailable');
    }
    return buffer;
  } catch {
    throw new Error('Browser screenshot file is unavailable');
  }
}

/** Resolve both browser backends into verified bytes without exposing file reads to the MCP package. */
export async function resolveBrowserScreenshot(
  result: BrowserControlResult,
  options: BrowserScreenshotResolverOptions,
): Promise<ResolvedBrowserScreenshot> {
  const payload = result.data;
  if (!result.ok || result.action !== 'screenshot' || !payload || typeof payload !== 'object') {
    throw new Error('Browser screenshot payload is invalid');
  }
  const record = payload as Record<string, unknown>;
  let buffer: Buffer;
  if (typeof record.data === 'string') {
    const decoded = decodeStrictBase64(record.data);
    if (!decoded) throw new Error('Browser screenshot payload is invalid');
    buffer = decoded;
  } else if (typeof record.path === 'string') {
    buffer = await readExternalScreenshot(record.path, options.runtimeDir);
  } else {
    throw new Error('Browser screenshot payload is invalid');
  }

  const mimeType = sniffScreenshotMime(buffer);
  if (!mimeType) throw new Error('Browser screenshot payload is invalid');
  if (typeof record.mimeType === 'string' && record.mimeType !== mimeType) {
    throw new Error('Browser screenshot MIME does not match its bytes');
  }
  return { buffer, mimeType };
}
