import { modernLocaleOf, type SupportedLocale } from '../shared/locale.js';
import { normalizeBingSourceUrl } from '../shared/bingWallpaper.js';
import {
  fetchSingleHopWithSsrFGuard,
  type GuardedFetchResult,
} from '@cindy/browser-control-runtime/ssrf-runtime';
import { parseOutboundProxyUrl } from '@cindy/anthropic-compat-proxy';
import { createPinnedProxyDispatcher } from './maker-host/outbound-fetch.js';
import { resolveDesktopOutboundProxy } from './maker-host/outbound-proxy-resolver.js';
import { prepareWallpaperImage } from './wallpaper-image.js';

/** Only public Bing homepage images; no user-selected URL, credentials or third-party proxy. */
export interface BingImageMetadata {
  imageKey: string;
  imageUrl: string;
  market: string;
  date: string;
  title: string;
  copyright: string;
  sourceUrl: string;
}

export class BingWallpaperRequestError extends Error {
  constructor(public readonly retryAfterMs = 0) {
    super('Bing wallpaper unavailable');
  }
}

export function bingWallpaperMarket(locale: SupportedLocale): string {
  const markets: Record<string, string> = {
    'zh-CN': 'zh-CN',
    'zh-TW': 'zh-TW',
    en: 'en-US',
    ja: 'ja-JP',
    ko: 'ko-KR',
    es: 'es-ES',
    fr: 'fr-FR',
    de: 'de-DE',
    'pt-PT': 'pt-PT',
    'pt-BR': 'pt-BR',
  };
  return markets[modernLocaleOf(locale)] ?? 'en-US';
}

export function parseBingImageMetadata(raw: unknown, market: string): BingImageMetadata {
  const item = (raw as { images?: unknown[] } | null)?.images?.[0];
  if (!item || typeof item !== 'object' || Array.isArray(item))
    throw new BingWallpaperRequestError();
  const image = item as Record<string, unknown>;
  if (
    image.wp === false ||
    typeof image.url !== 'string' ||
    image.url.length > 2048 ||
    !image.url.startsWith('/th?') ||
    typeof image.startdate !== 'string' ||
    !/^\d{8}$/.test(image.startdate)
  )
    throw new BingWallpaperRequestError();
  const date = image.startdate;
  const parsedDate = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6)));
  if (parsedDate.toISOString().slice(0, 10).replaceAll('-', '') !== date)
    throw new BingWallpaperRequestError();
  const url = new URL(image.url, 'https://www.bing.com');
  const id = url.searchParams.get('id');
  if (
    url.origin !== 'https://www.bing.com' ||
    url.username ||
    url.password ||
    url.pathname !== '/th' ||
    !id ||
    !/^OHR\.[A-Za-z0-9_.-]+\.jpg$/.test(id)
  )
    throw new BingWallpaperRequestError();
  return {
    imageKey: market + ':' + id,
    imageUrl: url.href,
    market,
    date,
    title: typeof image.title === 'string' ? image.title.slice(0, 512) : '',
    copyright: typeof image.copyright === 'string' ? image.copyright.slice(0, 1024) : '',
    sourceUrl: normalizeBingSourceUrl(image.copyrightlink),
  };
}

type Request = (
  url: string,
  init: RequestInit,
  beforeDispatch: () => void | Promise<void>,
) => Promise<Pick<GuardedFetchResult, 'response' | 'release'>>;

/** Fixed host-owned source, with only the IPv4 fake-IP range needed by proxy DNS.
 * RFC1918, loopback, link-local, metadata and IPv6 ULA remain blocked. Every connection
 * is pinned and HTTPS-verified; no redirect or arbitrary-host capability is exposed.
 */
export const requestBingWallpaper: Request = async (url, init, beforeDispatch) => {
  const target = new URL(url);
  if (
    target.origin !== 'https://www.bing.com' ||
    target.username ||
    target.password ||
    !['/HPImageArchive.aspx', '/th'].includes(target.pathname) ||
    init.redirect !== 'error'
  )
    throw new BingWallpaperRequestError();
  const signal = init.signal ?? undefined;
  return fetchSingleHopWithSsrFGuard({
    url,
    init,
    signal,
    requireHttps: true,
    policy: { hostnameAllowlist: ['www.bing.com'], allowRfc2544BenchmarkRange: true },
    dispatcherFactory: async ({ url: guardedUrl, pinned }) => {
      const raw = await resolveDesktopOutboundProxy(guardedUrl.origin + guardedUrl.pathname);
      signal?.throwIfAborted();
      const proxy = raw ? parseOutboundProxyUrl(raw) : null;
      return proxy
        ? createPinnedProxyDispatcher(proxy, guardedUrl, pinned.addresses, beforeDispatch, signal)
        : undefined;
    },
    beforeDispatch,
  });
};

async function fetchBytes(
  url: string,
  maxBytes: number,
  timeoutMs: number,
  signal: AbortSignal,
  request: Request,
): Promise<Buffer> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  const result = await request(
    url,
    { signal: combined, redirect: 'error', credentials: 'omit' },
    () => combined.throwIfAborted(),
  );
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const { response } = result;
    if (!response.ok) {
      const header = response.headers.get('retry-after');
      const seconds = header && /^\d+$/.test(header) ? Number(header) * 1000 : 0;
      const at = header && !seconds ? Date.parse(header) : NaN;
      throw new BingWallpaperRequestError(Math.max(0, seconds || at - Date.now() || 0));
    }
    if (Number(response.headers.get('content-length')) > maxBytes || !response.body)
      throw new BingWallpaperRequestError();
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      combined.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new BingWallpaperRequestError();
      chunks.push(value);
    }
    if (!size) throw new BingWallpaperRequestError();
    return Buffer.concat(chunks, size);
  } finally {
    if (reader) await reader.cancel().catch(() => undefined);
    else await result.response.body?.cancel().catch(() => undefined);
    reader?.releaseLock();
    await result.release();
  }
}

export async function fetchBingMetadata(
  market: string,
  signal: AbortSignal,
  request: Request = requestBingWallpaper,
): Promise<BingImageMetadata> {
  if (!/^[a-z]{2}-[A-Z]{2}$/.test(market)) throw new BingWallpaperRequestError();
  const bytes = await fetchBytes(
    'https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=' + market,
    128 * 1024,
    10_000,
    signal,
    request,
  );
  return parseBingImageMetadata(JSON.parse(bytes.toString('utf8')), market);
}

export async function fetchBingImage(
  image: BingImageMetadata,
  signal: AbortSignal,
  request: Request = requestBingWallpaper,
): Promise<Buffer> {
  // Revalidate even injected metadata before giving it privileged network access.
  const checked = parseBingImageMetadata(
    {
      images: [
        {
          url: new URL(image.imageUrl).pathname + new URL(image.imageUrl).search,
          startdate: image.date,
        },
      ],
    },
    image.market,
  );
  if (checked.imageUrl !== image.imageUrl) throw new BingWallpaperRequestError();
  const bytes = await fetchBytes(image.imageUrl, 20 * 1024 * 1024, 30_000, signal, request);
  signal.throwIfAborted();
  const prepared = await prepareWallpaperImage(bytes);
  if (prepared.byteLength > 20 * 1024 * 1024) throw new BingWallpaperRequestError();
  signal.throwIfAborted();
  return prepared;
}
