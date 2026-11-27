import { Fragment, useEffect, useLayoutEffect, useReducer, useRef, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Button } from '@/components/ui/button';
import { HIDDEN_ANIMATION_ATTR } from '@/lib/hiddenAnimationGate';
import { isDownloadProgressActive } from '../../../../shared/downloadProgress';
import type { PluginMarketItem } from '../../../../shared/pluginMarket';
import { usePluginInstallProgressMap } from './pluginInstallProgress';

const ROTATION_DURATION = 6_000;
const PUSH_DURATION = 960;
const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';
const CLOSED = '[hidden], [aria-hidden="true"], [data-state="closed"]';

/** Kept in the existing catalog view memory across tab, search and detail visits. */
export type PluginRecommendationOrder = { ids: string[]; completed?: number };
export type PluginRecommendationDeck = { items: readonly PluginMarketItem[]; outgoingId?: string };

export function selectPluginRecommendationBatch(items: readonly PluginMarketItem[], ids: readonly string[]) {
  const byId = new Map(items.map(item => [item.pluginId, item]));
  const replacements = items.filter(item => !ids.includes(item.pluginId));
  return Array.from({ length: 3 }, (_, index) => byId.get(ids[index]!) ?? replacements.shift())
    .filter(item => item !== undefined);
}

function shuffleBatch(items: readonly PluginMarketItem[], currentIds: readonly string[]) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!];
  }
  const batch = shuffled.slice(0, 3);
  if (batch.every(item => currentIds.includes(item.pluginId))) batch[2] = shuffled[3]!;
  return batch.map(item => item.pluginId);
}

/** The loaded cards and placeholders use the exact same grid and row height. */
export function PluginRecommendationSlots({ loading, items, order, active, busy, trackInstallProgress = false, shuffle, renderItem }: {
  loading: boolean;
  items: readonly PluginMarketItem[];
  order: PluginRecommendationOrder;
  active: boolean;
  busy: boolean;
  trackInstallProgress?: boolean;
  shuffle?: { title: string; label: string; candidates: readonly PluginMarketItem[]; onChange(ids: string[]): void };
  renderItem(item: PluginMarketItem, featured: boolean, deck: PluginRecommendationDeck): ReactNode;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLSpanElement>(null);
  const fixedWidth = useRef<number | null>(null);
  const outgoingIds = useRef<string[] | null>(null);
  const [, renderRotation] = useReducer(revision => revision + 1, 0);
  const slots = selectPluginRecommendationBatch(items, order.ids);
  const ready = active && !loading && slots.length === 3;
  const progress = usePluginInstallProgressMap();
  const blocked = busy || (trackInstallProgress && slots.some(item => {
    const phase = progress.get(item.pluginId)?.download.phase;
    return phase !== undefined && isDownloadProgressActive(phase);
  }));
  const blockedRef = useRef(blocked);
  const shuffleRef = useRef(shuffle);
  const synchronizeRef = useRef<((reset?: boolean) => void) | null>(null);
  const canShuffle = active && !loading && !blocked && !outgoingIds.current && (shuffle?.candidates.length ?? 0) > 3;

  useLayoutEffect(() => {
    shuffleRef.current = shuffle;
    blockedRef.current = blocked || !ready;
    if (!loading && slots.length === 3) {
      const ids = slots.map(item => item.pluginId);
      if (ids.some(id => !order.ids.includes(id))) order.completed = 0;
      order.ids = ids;
    }
    synchronizeRef.current?.();
  });

  useEffect(() => {
    const grid = gridRef.current;
    const track = progressRef.current;
    const clip = track?.parentElement;
    if (!grid || !track?.animate || !clip || !ready ||
      typeof IntersectionObserver === 'undefined' || typeof ResizeObserver === 'undefined') return;
    const region = grid.closest<HTMLElement>('.plugin-catalog-recommendations') ?? grid;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let inViewport = false;
    let hovered = region.matches(':hover');
    let focused = region.contains(document.activeElement);
    let clock: Animation | null = null;
    let preparing = false;
    let push: { ids: string[]; animations: Animation[] } | null = null;
    let disposed = false;
    const decoded = new WeakMap<HTMLImageElement, { source: string; ready: Promise<void> }>();
    const singleColumn = () => getComputedStyle(grid).getPropertyValue('--plugin-recommendation-columns').trim() === '1';
    const allowed = () => !disposed && !blockedRef.current && inViewport &&
      !document.hidden && !document.documentElement.hasAttribute(HIDDEN_ANIMATION_ATTR) &&
      !hovered && !focused && !reduceMotion?.matches && !singleColumn() &&
      !Array.from(document.querySelectorAll(OVERLAY)).some(overlay => !overlay.closest(CLOSED));

    function prepareIcons() {
      return Array.from(grid!.querySelectorAll<HTMLImageElement>('.plugin-recommendation-face img'), image => {
        const source = image.currentSrc || image.src;
        const existing = decoded.get(image);
        if (existing?.source === source) return existing.ready;
        const ready = image.decode?.().catch(() => undefined) ?? Promise.resolve();
        decoded.set(image, { source, ready });
        return ready;
      });
    }

    function clearPush() {
      const current = push;
      push = null;
      outgoingIds.current = null;
      current?.animations.forEach(animation => animation.cancel());
      clip!.hidden = !clock;
    }

    function cancelClock() {
      if (clock) {
        clock.onfinish = null;
        clock.cancel();
        clock = null;
      }
      clip!.hidden = true;
    }

    function synchronize() {
      if (disposed) return;
      if (reduceMotion?.matches || singleColumn()) {
        cancelClock();
        if (push) { clearPush(); renderRotation(); }
        return;
      }
      const pushedIds = push?.ids;
      if (pushedIds && order.ids.some((id, index) => id !== pushedIds[index])) {
        if (clock) { clock.currentTime = 0; clock.pause(); }
        clearPush();
        renderRotation();
      }
      void prepareIcons();
      if (!clock) {
        clock = track!.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], {
          duration: ROTATION_DURATION, easing: 'linear', fill: 'both',
        });
        clock.onfinish = synchronize;
        clip!.hidden = false;
      }
      if (!allowed()) {
        if (clock.playState === 'running') clock.pause();
      } else if (!push && (order.completed ?? 0) >= 3 && (shuffleRef.current?.candidates.length ?? 0) > 3) {
        const next = shuffleRef.current!;
        const ids = shuffleBatch(next.candidates, order.ids);
        order.completed = 0;
        order.ids = ids;
        clock.currentTime = 0;
        next.onChange(ids);
      } else if (clock.playState === 'finished' ||
        (typeof clock.currentTime === 'number' && clock.currentTime >= ROTATION_DURATION)) {
        begin();
      } else if (clock.playState === 'paused') {
        clock.play();
      }
    }

    function begin() {
      if (!allowed() || preparing || push) return;
      const finishedClock = clock;
      preparing = true;
      void Promise.all(prepareIcons()).then(() => {
        preparing = false;
        if (!allowed() || !clock || clock !== finishedClock) return;
        const [large, upper, lower] = order.ids;
        const current = { ids: [upper!, lower!, large!], animations: [] as Animation[] };
        push = current;
        clip!.hidden = true;
        if (fixedWidth.current === null) {
          const box = grid!.getBoundingClientRect();
          if (box.height > 0) {
            fixedWidth.current = box.width;
            grid!.style.blockSize = `${box.height}px`;
          }
        }
        flushSync(() => {
          outgoingIds.current = order.ids;
          order.ids = current.ids;
          renderRotation();
        });
        const easing = getComputedStyle(grid!).getPropertyValue('--motion-ease-move').trim() || 'ease-in-out';
        for (const [index, card] of Array.from(grid!.querySelectorAll<HTMLElement>('.plugin-recommendation-card')).entries()) {
          const distance = index === 0 ? 100 : -100;
          const translate = (offset: number) => index === 2 ? `translateY(${offset}%)` : `translateX(${offset}%)`;
          for (const layer of card.querySelectorAll<HTMLElement>('[data-recommendation-layer]')) {
            const outgoing = layer.dataset.recommendationLayer === 'outgoing';
            const from = outgoing ? 0 : -distance;
            const to = outgoing ? distance : 0;
            current.animations.push(layer.animate(
              [{ transform: translate(from) }, { transform: translate(to) }],
              { duration: PUSH_DURATION, easing, fill: 'both' },
            ));
          }
        }
        const startTime = document.timeline?.currentTime;
        if (startTime != null) current.animations.forEach(animation => { animation.startTime = startTime; });
        void Promise.all(current.animations.map(animation => animation.finished.catch(() => undefined))).then(() => {
          if (push !== current) return;
          order.completed = Math.min(3, (order.completed ?? 0) + 1);
          if (clock) { clock.currentTime = 0; clock.pause(); }
          flushSync(() => {
            outgoingIds.current = null;
            renderRotation();
          });
          clearPush();
          synchronize();
        });
      });
    }

    const intersection = new IntersectionObserver(([entry]) => {
      inViewport = Boolean(entry?.isIntersecting);
      synchronize();
    });
    intersection.observe(region);
    const resize = new ResizeObserver(() => {
      if (fixedWidth.current !== null && (singleColumn() || grid.getBoundingClientRect().width !== fixedWidth.current)) {
        fixedWidth.current = null;
        grid.style.blockSize = '';
      }
      synchronize();
    });
    resize.observe(grid);
    const overlayIn = (node: Node) => node instanceof Element && (node.matches(OVERLAY) || !!node.querySelector(OVERLAY));
    const overlays = new MutationObserver(records => {
      if (records.some(record => record.type === 'attributes'
        ? record.attributeName === HIDDEN_ANIMATION_ATTR || overlayIn(record.target)
        : Array.from(record.addedNodes).some(overlayIn) || Array.from(record.removedNodes).some(overlayIn))) {
        synchronize();
      }
    });
    overlays.observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['data-state', 'aria-hidden', 'hidden'],
    });
    overlays.observe(document.documentElement, { attributes: true, attributeFilter: [HIDDEN_ANIMATION_ATTR] });

    const enter = () => { hovered = true; synchronize(); };
    const leave = () => { hovered = false; synchronize(); };
    const focusIn = () => { focused = true; synchronize(); };
    const focusOut = (event: FocusEvent) => {
      focused = event.relatedTarget instanceof Node && region.contains(event.relatedTarget);
      synchronize();
    };
    region.addEventListener('pointerenter', enter);
    region.addEventListener('pointerleave', leave);
    region.addEventListener('focusin', focusIn);
    region.addEventListener('focusout', focusOut);
    document.addEventListener('visibilitychange', synchronize);
    reduceMotion?.addEventListener('change', synchronize);
    synchronizeRef.current = reset => {
      if (reset && clock) { clock.currentTime = 0; clock.pause(); }
      synchronize();
    };
    synchronize();

    return () => {
      disposed = true;
      synchronizeRef.current = null;
      cancelClock();
      clearPush();
      intersection.disconnect();
      resize.disconnect();
      overlays.disconnect();
      region.removeEventListener('pointerenter', enter);
      region.removeEventListener('pointerleave', leave);
      region.removeEventListener('focusin', focusIn);
      region.removeEventListener('focusout', focusOut);
      document.removeEventListener('visibilitychange', synchronize);
      reduceMotion?.removeEventListener('change', synchronize);
    };
  }, [ready, order]);

  return <>
    {shuffle ? <div className="mb-4 flex items-center justify-between gap-3">
      <h2 className="text-16 font-medium text-[var(--text-primary)]">{shuffle.title}</h2>
      <Button variant="secondary" size="sm" compact disabled={!canShuffle} onClick={event => {
        if (!canShuffle) return;
        const ids = shuffleBatch(shuffle.candidates, slots.map(item => item.pluginId));
        order.completed = 0;
        order.ids = ids;
        shuffle.onChange(ids);
        synchronizeRef.current?.(true);
        // A pointer click must not leave the rotation paused after hover ends.
        if (event.detail > 0) event.currentTarget.blur();
      }}>{shuffle.label}</Button>
    </div> : null}
    <div ref={gridRef} className="plugin-recommendation-slots">
    {loading ? Array.from({ length: 3 }, (_, index) => <div key={index} aria-hidden="true" data-recommendation-placeholder
      className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]" />)
      : slots.map((item, index) => (
        <Fragment key={index}>
          {renderItem(item, index === 0, { items, outgoingId: outgoingIds.current?.[index] })}
        </Fragment>
      ))}
    {ready ? <div className="plugin-recommendation-progress" hidden aria-hidden="true">
      <span ref={progressRef} className="plugin-recommendation-progress-line" />
    </div> : null}
    </div>
  </>;
}
