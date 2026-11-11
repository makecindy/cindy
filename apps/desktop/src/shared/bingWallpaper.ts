/** Host-owned daily image metadata. URLs never come from a renderer settings patch. */
export interface BingWallpaperImage {
  url: string;
  imageKey: string;
  market: string;
  date: string;
  title: string;
  copyright: string;
  sourceUrl: string;
}

export type BingWallpaperStatus = 'idle' | 'loading' | 'ready' | 'stale' | 'failed';

export interface BingWallpaperSnapshot {
  image: BingWallpaperImage | null;
  status: BingWallpaperStatus;
}

/** Keep external attribution links on Bing; never pass arbitrary schemes to the shell. */
export function normalizeBingSourceUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) return '';
  try {
    const url = new URL(value);
    return url.origin === 'https://www.bing.com' && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

export function normalizeBingWallpaperImage(value: unknown): BingWallpaperImage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const image = value as Record<string, unknown>;
  if (
    typeof image.url !== 'string' ||
    !/^cindy-media:\/\/client-wallpaper\/[0-9a-f]{64}\.webp$/.test(image.url) ||
    typeof image.imageKey !== 'string' ||
    !image.imageKey ||
    image.imageKey.length > 2048 ||
    typeof image.market !== 'string' ||
    !/^[a-z]{2}-[A-Z]{2}$/.test(image.market) ||
    typeof image.date !== 'string' ||
    !/^\d{8}$/.test(image.date)
  )
    return null;
  return {
    url: image.url,
    imageKey: image.imageKey,
    market: image.market,
    date: image.date,
    title: typeof image.title === 'string' ? image.title.slice(0, 512) : '',
    copyright: typeof image.copyright === 'string' ? image.copyright.slice(0, 1024) : '',
    sourceUrl: normalizeBingSourceUrl(image.sourceUrl),
  };
}

export function normalizeBingWallpaperSnapshot(value: unknown): BingWallpaperSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const snapshot = value as Record<string, unknown>;
  const status = snapshot.status;
  if (
    status !== 'idle' &&
    status !== 'loading' &&
    status !== 'ready' &&
    status !== 'stale' &&
    status !== 'failed'
  )
    return undefined;
  return { image: normalizeBingWallpaperImage(snapshot.image), status };
}
