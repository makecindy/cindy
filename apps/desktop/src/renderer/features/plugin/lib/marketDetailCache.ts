import type { PluginMarketDetail, PluginMarketItem } from '../../../../shared/pluginMarket';
import { extractIpcError } from '@/utils/ipcError';

const PREFETCH_TTL_MS = 30_000;
const MAX_ENTRIES = 50;

/** Catalog identity never carries detail permissions or README authority. */
export function marketItemSummary<T extends Partial<PluginMarketDetail>>(item: T): Omit<T, 'manifest' | 'readme'> {
  const summary = { ...item };
  delete summary.manifest;
  delete summary.readme;
  return summary;
}

/** Keep the already displayed bitmap while its signed URL is still usable. */
export function retainMarketDetailIcon(detail: PluginMarketDetail, previous?: PluginMarketItem): PluginMarketDetail {
  return previous?.icon && previous.icon.sha256 === detail.icon?.sha256 && Date.parse(previous.icon.expiresAt) > Date.now()
    ? { ...detail, icon: previous.icon } : detail;
}

function contentKey(detail: PluginMarketDetail | undefined): string {
  if (!detail) return '';
  return JSON.stringify({ ...detail,
    usageStatistics: detail.usageStatistics ? { ...detail.usageStatistics, asOf: undefined } : undefined,
    icon: detail.icon ? { mimeType: detail.icon.mimeType, sha256: detail.icon.sha256, sizeBytes: detail.icon.sizeBytes } : null,
  });
}

export function marketDetailAccessRejected(error: unknown): boolean {
  return ['NOT_FOUND', 'PERMISSION_DENIED', 'PRECONDITION_FAILED', 'GHOST_FILE_INVALID',
    'PLUGIN_NAMESPACE_CLIENT_REQUIRED', 'PLUGIN_ORGANIZATION_CONTEXT_UNAVAILABLE',
    'PLUGIN_NAMESPACE_CONFIG_REQUIRED', 'PLUGIN_LIST_CHANGED', 'UNSUPPORTED_CAPABILITY',
  ].includes(extractIpcError(error)?.code ?? '');
}

/** Renderer memory only. Every read still goes through Main's visibility gate. */
class MarketDetailCache {
  private entries = new Map<string, { value?: PluginMarketDetail; updatedAt: number; accept: () => boolean; pending?: Promise<PluginMarketDetail> }>();
  private prefetchPending: Promise<unknown> | null = null;

  peek(id: string): PluginMarketDetail | undefined {
    const entry = this.entries.get(id);
    if (entry) { this.entries.delete(id); this.entries.set(id, entry); }
    return entry?.value;
  }

  isFresh(id: string): boolean {
    const entry = this.entries.get(id);
    return Boolean(entry?.value && Date.now() - entry.updatedAt < PREFETCH_TTL_MS);
  }

  invalidate(id: string): void {
    this.entries.delete(id);
  }

  prefetch(id: string, load: () => Promise<PluginMarketDetail>, isCurrent: () => boolean): void {
    if (this.prefetchPending || this.isFresh(id)) return;
    const pending = this.load(id, load, 'prefetch', isCurrent).catch(() => undefined).finally(() => {
      if (this.prefetchPending === pending) this.prefetchPending = null;
    });
    this.prefetchPending = pending;
  }

  load(id: string, load: () => Promise<PluginMarketDetail>, mode: 'open' | 'prefetch' | 'refresh' | 'background' = 'open', accept: () => boolean = () => true): Promise<PluginMarketDetail> {
    const existing = this.entries.get(id);
    if (existing?.pending) {
      if (mode !== 'prefetch') existing.accept = accept;
      return existing.pending;
    }
    if ((mode === 'open' || mode === 'prefetch') && existing?.value && this.isFresh(id)) {
      return Promise.resolve(existing.value);
    }
    const entry = existing ?? { updatedAt: 0, accept };
    entry.accept = accept;
    this.entries.delete(id);
    this.entries.set(id, entry);
    // Eviction also bounds the amount of retained README/image metadata.
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    const pending = load().then(value => {
      if (!entry.accept()) {
        if (this.entries.get(id) === entry) this.entries.delete(id);
        return value;
      }
      if (mode === 'refresh' || contentKey(entry.value) !== contentKey(value)) entry.value = value;
      entry.updatedAt = Date.now();
      return entry.value!;
    }).catch(error => {
      if ((!entry.value || marketDetailAccessRejected(error)) && this.entries.get(id) === entry) this.entries.delete(id);
      throw error;
    }).finally(() => { entry.pending = undefined; });
    entry.pending = pending;
    return pending;
  }
}

let active: { scope: string; cache: MarketDetailCache } | undefined;

/**
 * Endpoints are fixed for a running app; switching the active endpoint realm
 * crosses the auth owner generation. A new process has no renderer memory.
 */
export function marketDetailCacheFor(scope: string): MarketDetailCache {
  if (active?.scope !== scope) active = { scope, cache: new MarketDetailCache() };
  return active.cache;
}
