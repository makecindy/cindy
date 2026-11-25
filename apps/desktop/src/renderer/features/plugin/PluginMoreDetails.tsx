import { useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { PluginMarketItem, PluginMarketPage, PluginMarketQuery } from '../../../shared/pluginMarket';
import { GhostPluginIcon } from './GhostPluginIcon';
import { PluginDetailSection } from './PluginDetailRecord';
import { PluginPublisherBadge } from './PluginPublisherBadge';
import { readReusedMarketIcon, type MarketIconCache } from './lib/pluginBrowserCache';
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
  selections: Map<string, Array<string | undefined>>;
};
const directories = new WeakMap<object, Promise<RelatedDirectory>>();
let localOwner: { key: string; cache: object } | undefined;

/** Keep the directory independent of the list, including when its locale changes. */
export function relatedPluginCatalogCache(ownerKey: string): object {
  if (localOwner?.key !== ownerKey) localOwner = { key: ownerKey, cache: {} };
  return localOwner.cache;
}

function canRecommend(item: PluginMarketItem) {
  return item.sourceType === 'server' && (item.scope === 'public' || item.scope === 'organization');
}

function readDirectory(cache: object, loadPage: PluginRelatedCatalog['loadPage']) {
  const owner = getDataOwnerGeneration();
  const request = (async (): Promise<RelatedDirectory> => {
    const items = new Map<string, PluginMarketItem>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: PluginMarketPage = await loadPage({ scope: 'all', limit: 100, counts: false, cursor });
      if (!isDataOwnerGenerationCurrent(owner) || page.unavailableReason) throw new Error('Catalog unavailable');
      for (const item of page.items) {
        if (canRecommend(item)) items.set(item.pluginId, item);
      }
      cursor = page.nextCursor;
      if (cursor) {
        if (seenCursors.has(cursor)) throw new Error('Catalog cursor did not advance');
        seenCursors.add(cursor);
      }
    } while (cursor);
    return { items, selections: new Map() };
  })().catch(error => {
    directories.delete(cache);
    throw error;
  });
  directories.set(cache, request);
  return request;
}

/** Reuse a definitive refusal from the existing detail read, without a second request. */
export function removeUnavailableRelatedPlugin(cache: object, pluginId: string) {
  void directories.get(cache)?.then(directory => directory.items.delete(pluginId), () => undefined);
}

function selectRelatedPlugins(directory: RelatedDirectory, detailId: string,
  liveItems: PluginRelatedCatalog['liveItems'], installedGhosts: PluginRelatedCatalog['installedGhosts']) {
  const liveById = new Map(liveItems?.map(item => [item.pluginId, item]));
  const eligible = new Map<string, PluginMarketItem>();
  for (const original of directory.items.values()) {
    const live = liveById.get(original.pluginId);
    const item = live ?? original;
    if (item.pluginId === detailId || !canRecommend(item)) continue;
    const counterpart = simulatorMigrationCounterpart(item);
    if (installedGhosts?.some(ghost =>
      ghost.manifest.id === counterpart || marketItemMatchesInstalledGhost(item, ghost))) continue;

    // The once-per-run directory cannot report later uninstalls. Use its old
    // installed state only when neither the live catalog nor roster can replace it.
    if (item.installState === 'not-installed') {
      eligible.set(item.pluginId, item);
    } else if (!live && installedGhosts !== undefined && item.installState !== 'conflict') {
      eligible.set(item.pluginId, { ...item, installState: 'not-installed' });
    }
  }
  const previous = directory.selections.get(detailId);
  const slots = Array.from({ length: 3 }, (_, slot) => {
    const id = previous?.[slot];
    return id !== undefined && eligible.has(id) ? id : undefined;
  });
  const remaining = [...eligible.keys()].filter(id => !slots.includes(id));
  for (let slot = 0; slot < slots.length && remaining.length; slot++) {
    if (slots[slot] === undefined) {
      const picked = Math.floor(Math.random() * remaining.length);
      slots[slot] = remaining.splice(picked, 1)[0];
    }
  }
  directory.selections.set(detailId, slots);
  return slots.flatMap(id => id === undefined ? [] : [eligible.get(id)!]);
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
  const visit = useRef<{ cache: object; request: Promise<RelatedDirectory> }>(undefined);
  const [visible, setVisible] = useState<{ cache: object; items: PluginMarketItem[] }>();

  useEffect(() => {
    if (online === false) return;
    // Keep a failed attempt attached to this visit. A later visit may start a new read.
    const request = visit.current?.cache === cache
      ? visit.current.request : directories.get(cache) ?? readDirectory(cache, loadPage);
    visit.current = { cache, request };
    let active = true;
    void request.then(directory => {
      if (active) setVisible({ cache, items: selectRelatedPlugins(directory, detailId, liveItems, installedGhosts) });
    }, () => undefined);
    return () => { active = false; };
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
