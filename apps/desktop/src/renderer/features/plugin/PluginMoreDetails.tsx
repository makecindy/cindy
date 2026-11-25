import { useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { isWindowHidden } from '@/lib/hiddenAnimationGate';
import type { PluginMarketItem, PluginMarketPage, PluginMarketQuery } from '../../../shared/pluginMarket';
import { GhostPluginIcon } from './GhostPluginIcon';
import { PluginDetailSection } from './PluginDetailRecord';
import { PluginPublisherBadge } from './PluginPublisherBadge';
import { PLUGIN_CATALOG_REFRESH_MS, readReusedMarketIcon, type MarketIconCache } from './lib/pluginBrowserCache';
import { marketItemMatchesInstalledGhost, pluginPresentationOrigin, publicPublisherFilter, simulatorMigrationCounterpart } from './lib/pluginMarketPresentation';
import { usePluginMarketIcon } from './lib/usePluginMarketIcon';

export interface PluginRelatedCatalog {
  // Only the owner's partition identity is used, independently of the list's loaded pages.
  cache: object;
  ownerKey: string;
  catalogKey: string;
  local?: true;
  loadPage: (query: PluginMarketQuery) => Promise<PluginMarketPage>;
  liveItems?: readonly PluginMarketItem[];
  installedGhosts?: readonly Parameters<typeof marketItemMatchesInstalledGhost>[1][];
  iconCache?: MarketIconCache;
  online?: boolean;
}

type RelatedDirectory = {
  items: Map<string, PluginMarketItem>;
  nextCursor: string | null;
  seenCursors: Set<string>;
  pages: number;
  updatedAt: number;
  readers: number;
  flight?: Promise<void>;
};
type RelatedCache = {
  directory?: RelatedDirectory;
  selections: Map<string, Array<PluginMarketItem | undefined>>;
};
const RELATED_PAGE_SIZE = 100;
const RELATED_PAGE_LIMIT = 5;
// A normal session stays below 500 detail views; opening more distinct plugins evicts the least recently visited selection, which is redrawn on return.
const RELATED_SELECTION_LIMIT = 500;
const relatedCaches = new WeakMap<object, RelatedCache>();
let localOwner: { key: string; cache: object } | undefined;

/** Keep the directory independent of the list, including when its locale changes. */
export function relatedPluginCatalogCache(ownerKey: string): object {
  if (localOwner?.key !== ownerKey) localOwner = { key: ownerKey, cache: {} };
  return localOwner.cache;
}

function canRecommend(item: PluginMarketItem) {
  return item.sourceType === 'server' && (item.scope === 'public' || item.scope === 'organization');
}

function getRelatedCache(key: object): RelatedCache {
  const existing = relatedCaches.get(key);
  if (existing) return existing;
  // Selections belong to this account's running session and survive directory refreshes.
  const cache: RelatedCache = { selections: new Map() };
  relatedCaches.set(key, cache);
  return cache;
}

function getDirectory(cache: RelatedCache): RelatedDirectory {
  const previous = cache.directory;
  if (previous && (previous.flight || previous.readers || Date.now() - previous.updatedAt < PLUGIN_CATALOG_REFRESH_MS)) return previous;
  cache.directory = {
    items: new Map(), nextCursor: null, seenCursors: new Set(),
    pages: 0, updatedAt: Date.now(), readers: 0,
  };
  return cache.directory;
}

function readDirectory(cache: RelatedCache, directory: RelatedDirectory, loadPage: PluginRelatedCatalog['loadPage']) {
  if (directory.flight) return directory.flight;
  const owner = getDataOwnerGeneration();
  // Draw uniformly from the complete directory when it fits in the budget.
  // For larger catalogs, only candidates in the first five pages participate.
  directory.flight = (async () => {
    while (directory.readers && directory.pages < RELATED_PAGE_LIMIT &&
      (directory.pages === 0 || directory.nextCursor !== null)) {
      if (!isDataOwnerGenerationCurrent(owner)) throw new Error('Catalog unavailable');
      const page = await loadPage({ scope: 'all', limit: RELATED_PAGE_SIZE, counts: false, cursor: directory.nextCursor });
      if (!isDataOwnerGenerationCurrent(owner) || page.unavailableReason) throw new Error('Catalog unavailable');
      if (page.nextCursor && directory.seenCursors.has(page.nextCursor)) {
        throw new Error('Catalog cursor did not advance');
      }
      for (const item of page.items.filter(canRecommend).slice(0, RELATED_PAGE_SIZE)) {
        directory.items.set(item.pluginId, item);
      }
      directory.pages++;
      directory.nextCursor = page.nextCursor;
      if (page.nextCursor) directory.seenCursors.add(page.nextCursor);
      directory.updatedAt = Date.now();
    }
  })().catch(error => {
    // A failed cursor chain starts over on the next visit. A paused chain keeps its cursor.
    if (cache.directory === directory) cache.directory = undefined;
    throw error;
  }).finally(() => {
    directory.flight = undefined;
  });
  return directory.flight;
}

/** Reuse a definitive refusal from the existing detail read, without a second request. */
export function removeUnavailableRelatedPlugin(cache: object, pluginId: string) {
  const related = relatedCaches.get(cache);
  if (!related) return;
  for (const slots of related.selections.values()) {
    const slot = slots.findIndex(item => item?.pluginId === pluginId);
    if (slot >= 0) slots[slot] = undefined;
  }
  const directory = related.directory;
  if (directory) {
    const remove = () => { directory.items.delete(pluginId); };
    remove();
    void directory.flight?.then(remove, remove);
  }
}

function selectRelatedPlugins(directory: RelatedDirectory, selections: RelatedCache['selections'], detailId: string,
  liveItems: PluginRelatedCatalog['liveItems'], installedGhosts: PluginRelatedCatalog['installedGhosts']) {
  const liveById = new Map(liveItems?.map(item => [item.pluginId, item]));
  const eligibleItem = (original: PluginMarketItem): PluginMarketItem | undefined => {
    const live = liveById.get(original.pluginId);
    const item = live ?? original;
    if (item.pluginId === detailId || !canRecommend(item)) return;
    const counterpart = simulatorMigrationCounterpart(item);
    if (installedGhosts?.some(ghost =>
      ghost.manifest.id === counterpart || marketItemMatchesInstalledGhost(item, ghost))) return;

    // The cached directory cannot report later uninstalls. Use its old
    // installed state only when neither the live catalog nor roster can replace it.
    if (item.installState === 'not-installed') return item;
    if (!live && installedGhosts !== undefined && item.installState !== 'conflict') {
      return { ...item, installState: 'not-installed' };
    }
  };
  const eligible = new Map<string, PluginMarketItem>();
  for (const original of directory.items.values()) {
    const item = eligibleItem(original);
    if (item) eligible.set(item.pluginId, item);
  }
  const previous = selections.get(detailId);
  const slots = Array.from({ length: 3 }, (_, slot) => {
    const item = previous?.[slot];
    if (!item) return;
    // A budget-limited refresh can move an eligible choice past page five.
    // Keep that choice until we have evidence it is unavailable or installed.
    return eligible.get(item.pluginId) ??
      (directory.nextCursor !== null && !directory.items.has(item.pluginId) ? eligibleItem(item) : undefined);
  });
  const remaining = [...eligible.values()].filter(item => !slots.some(slot => slot?.pluginId === item.pluginId));
  for (let slot = 0; slot < slots.length && remaining.length; slot++) {
    if (slots[slot] === undefined) {
      const picked = Math.floor(Math.random() * remaining.length);
      slots[slot] = remaining.splice(picked, 1)[0];
    }
  }
  selections.delete(detailId);
  selections.set(detailId, slots);
  if (selections.size > RELATED_SELECTION_LIMIT) {
    selections.delete(selections.keys().next().value!);
  }
  return slots.filter(item => item !== undefined);
}

export function PluginMoreDetails({ detailId, catalog, onSelect }: {
  detailId: string;
  catalog?: PluginRelatedCatalog;
  onSelect?: (item: PluginMarketItem) => void;
}) {
  if (!catalog?.local || !onSelect) return null;
  return <MorePlugins key={detailId} detailId={detailId} catalog={catalog} onSelect={onSelect} />;
}

function MorePlugins({ detailId, catalog, onSelect }: {
  detailId: string;
  catalog: PluginRelatedCatalog;
  onSelect: (item: PluginMarketItem) => void;
}) {
  const { t } = useTranslation();
  const { cache, loadPage, online, liveItems, installedGhosts, iconCache } = catalog;
  const visit = useRef<{ cache: object; directory: RelatedDirectory; failed: boolean }>(undefined);
  const [visible, setVisible] = useState<{ cache: object; items: PluginMarketItem[] }>();

  useEffect(() => {
    if (online === false) return;
    let windowHidden = isWindowHidden();
    let stopReading: (() => void) | undefined;
    const syncReader = () => {
      if (windowHidden || document.visibilityState === 'hidden') {
        if (stopReading) {
          stopReading();
          stopReading = undefined;
          visit.current = undefined;
        }
        return;
      }
      if (stopReading) return;
      const related = getRelatedCache(cache);
      if (visit.current?.cache !== cache) visit.current = { cache, directory: getDirectory(related), failed: false };
      const current = visit.current;
      if (current.failed) return;
      const { directory } = current;
      directory.readers++;
      let active = true;
      stopReading = () => {
        active = false;
        directory.readers--;
      };
      void readDirectory(related, directory, loadPage).then(() => {
        if (active) setVisible({ cache, items: selectRelatedPlugins(directory, related.selections, detailId, liveItems, installedGhosts) });
      }, () => { current.failed = true; });
    };
    syncReader();
    document.addEventListener('visibilitychange', syncReader);
    const offWindowHidden = window.electronAPI?.onWindowHiddenChange?.((hidden) => {
      windowHidden = hidden;
      syncReader();
    });
    return () => {
      stopReading?.();
      document.removeEventListener('visibilitychange', syncReader);
      offWindowHidden?.();
    };
  }, [cache, detailId, installedGhosts, liveItems, loadPage, online]);

  if (online === false || visible?.cache !== cache || !visible.items.length) return null;
  return (
    <PluginDetailSection
      title={t('settings.ghosts.detail.morePlugins')}
      titleEnd={<MorePluginsHint text={t('settings.ghosts.detail.morePluginsHint')} />}
    >
      <div className="plugin-detail-more-grid">
        {visible.items.map(item => (
          <MorePluginCard key={item.pluginId} item={iconCache ? readReusedMarketIcon(iconCache, item, true) : item} onSelect={onSelect} />
        ))}
      </div>
    </PluginDetailSection>
  );
}

function MorePluginsHint({ text }: { text: string }) {
  const [pinned, setPinned] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const leavingTrigger = useRef(false);

  useEffect(() => {
    if (!pinned) return;
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !triggerRef.current?.contains(event.target)) setPinned(false);
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    return () => document.removeEventListener('pointerdown', dismissOutside, true);
  }, [pinned]);

  return (
    <Tip
      text={text}
      forceOpen={pinned}
      resetHoverOnControlChange
      onOpenChange={() => { if (!leavingTrigger.current) setPinned(false); }}
    >
      <Button
        ref={triggerRef}
        variant="secondary"
        tone="quiet"
        size="sm"
        className="w-7 px-0"
        aria-label={text}
        aria-pressed={pinned}
        onPointerDown={(event) => {
          if (!pinned) return;
          // Keep the press from dismissing the tip before this button toggles it on click.
          event.preventDefault();
          event.stopPropagation();
        }}
        onPointerLeave={() => {
          if (!pinned) return;
          // Let Tip reset its hover tracking without dismissing the pinned content.
          leavingTrigger.current = true;
          queueMicrotask(() => { leavingTrigger.current = false; });
        }}
        onBlur={(event) => { if (pinned) event.preventDefault(); }}
        onClick={(event) => {
          event.preventDefault();
          setPinned(value => !value);
        }}
      >
        <Info size={15} strokeWidth={1.75} aria-hidden="true" />
      </Button>
    </Tip>
  );
}

function MorePluginCard({ item, onSelect }: { item: PluginMarketItem; onSelect: (item: PluginMarketItem) => void }) {
  const { t } = useTranslation();
  const icon = usePluginMarketIcon(item, { deferUntilVisible: true });
  const origin = pluginPresentationOrigin(item);
  return (
    <button type="button" aria-label={item.name} onClick={() => onSelect(item)}
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4 text-start hover:bg-[var(--surface-hover-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
      <span className="size-10 [&>span]:size-full">
        <GhostPluginIcon iconId={item.ghostId} iconName={item.name} size="sm" iconDataUrl={icon.iconDataUrl}
          iconContainerRef={icon.containerRef} onIconLoad={icon.onIconLoad} onIconLoadError={() => icon.onIconLoadError()} />
      </span>
      <span className="min-w-0">
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          <span title={item.name} className="min-w-[1em] max-w-max flex-1 truncate text-14 font-medium leading-[1.429] text-[var(--text-primary)]">{item.name}</span>
          <PluginPublisherBadge origin={origin} kind={item.publisherKind}
            sourceLabel={origin === 'public' && publicPublisherFilter(item) === null ? t('mcpApps.source.market') : undefined} />
        </span>
        {item.description ? (
          <span className="mt-0.5 line-clamp-2 text-12 leading-[1.5] text-[var(--text-secondary)] [overflow-wrap:anywhere]">{item.description}</span>
        ) : null}
      </span>
    </button>
  );
}
