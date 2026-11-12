import { Agent, fetch as undiciFetch } from 'undici';
import { randomUUID } from 'node:crypto';
import { ghostPreviewUrlAllowed, type InstalledGhost } from '../../shared/ghost.js';
import type { PluginPageFetchResult } from '@cindy/device-link';

export type MobilePreviewReader = (
  url: string,
  assertCurrent: () => void,
) => Promise<{ status: number; mime: string; bytes: Uint8Array }>;
/** One approved preview origin, bounded immutable response chunks, no cookies or arbitrary URL proxy. */
export class MobilePluginPreview {
  private readonly responses = new Map<
    string,
    { id: string; status: number; mime: string; bytes: Uint8Array }
  >();
  private readonly pending = new Map<string, Promise<void>>();
  private totalBytes = 0;
  constructor(
    private readonly entry: string,
    private readonly read: MobilePreviewReader,
  ) {}
  async fetch(
    ghost: InstalledGhost,
    input: Record<string, unknown>,
    assertCurrent: () => void,
  ): Promise<PluginPageFetchResult> {
    assertCurrent();
    if (
      typeof input.url !== 'string' ||
      input.url.length > 4096 ||
      !Number.isSafeInteger(input.offset) ||
      (input.offset as number) < 0
    )
      throw new Error('INVALID_PREVIEW_REQUEST');
    const url = new URL(input.url),
      entry = new URL(this.entry);
    if (
      url.origin !== entry.origin ||
      url.username ||
      url.password ||
      url.hash ||
      !ghostPreviewUrlAllowed(ghost.manifest, url.href)
    )
      throw new Error('PREVIEW_ORIGIN_DENIED');
    const offset = input.offset as number;
    if (offset === 0 && input.revision === undefined && !this.responses.has(url.href)) {
      let work = this.pending.get(url.href);
      if (!work) {
        if (this.pending.size >= 4 || this.responses.size + this.pending.size >= 128)
          throw new Error('PREVIEW_BUSY');
        work = (async () => {
          const response = await this.read(url.href, assertCurrent);
          assertCurrent();
          if (
            response.bytes.byteLength > 8 * 1024 * 1024 ||
            this.totalBytes + response.bytes.byteLength > 64 * 1024 * 1024
          )
            throw new Error('PREVIEW_TOO_LARGE');
          this.responses.set(url.href, { ...response, id: randomUUID() });
          this.totalBytes += response.bytes.byteLength;
        })();
        this.pending.set(url.href, work);
      }
      try {
        await work;
      } finally {
        if (this.pending.get(url.href) === work) this.pending.delete(url.href);
      }
    }
    assertCurrent();
    const response = this.responses.get(url.href);
    if (
      !response ||
      (offset > 0 && input.revision !== response.id) ||
      (input.revision !== undefined && input.revision !== response.id) ||
      offset > response.bytes.byteLength
    )
      throw new Error('PREVIEW_CHANGED');
    const end = Math.min(offset + 48 * 1024, response.bytes.byteLength);
    return {
      mime: response.mime,
      status: response.status,
      base64: Buffer.from(response.bytes.subarray(offset, end)).toString('base64'),
      revision: response.id,
      ...(end < response.bytes.byteLength ? { nextOffset: end } : {}),
    };
  }
}

const directAgent = new Agent();
const directFetch: typeof fetch = (url, init) =>
  undiciFetch(String(url), { ...init, dispatcher: directAgent } as Parameters<
    typeof undiciFetch
  >[1]) as unknown as Promise<Response>;

/** Fetch redirects only within the same approved origin, and never inherit computer browser credentials. */
export async function readMobilePreview(
  url: string,
  assertCurrent: () => void,
  fetcher: typeof fetch = directFetch,
) {
  const origin = new URL(url).origin;
  for (let hop = 0; hop < 5; hop++) {
    assertCurrent();
    const response = await fetcher(url, {
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(30_000),
    });
    assertCurrent();
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      await response.body?.cancel();
      const next = new URL(response.headers.get('location')!, url);
      if (next.origin !== origin || next.username || next.password)
        throw new Error('PREVIEW_ORIGIN_DENIED');
      url = next.href;
      continue;
    }
    const reader = response.body?.getReader(),
      parts: Uint8Array[] = [];
    let size = 0;
    try {
      while (reader) {
        const part = await reader.read();
        assertCurrent();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 8 * 1024 * 1024) throw new Error('PREVIEW_TOO_LARGE');
        parts.push(part.value);
      }
    } finally {
      await reader?.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return {
      status: response.status,
      mime: response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream',
      bytes,
    };
  }
  throw new Error('PREVIEW_REDIRECT_LIMIT');
}
