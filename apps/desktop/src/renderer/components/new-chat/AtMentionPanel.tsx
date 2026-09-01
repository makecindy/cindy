/**
 * Unified composer suggestion panel (command-palette F2 / F5, `@` + `+`).
 *
 * 2026-08 unification (Codex Desktop pattern): this panel serves BOTH the
 * typed `@` trigger and the composer `+` button (synthetic activation — no
 * `@` char in the doc, typing still filters). It renders the union of:
 *   - action rows from the legacy `+` MorphPopover menu (attach files, new
 *     goal, plan mode, collaboration, add reference directory)
 *   - scanned resources (files / dirs / agents / tabs / windows / tasks)
 *   - installed plugins (unavailable ones stay visible but disabled)
 *   - the reference-directories management section (empty query only)
 *
 * All scanning / ranking / assembly lives in `atResourceService.ts` +
 * `composerSuggestion.ts`; ChatInput passes the final ordered `entries`.
 * This component handles:
 *   - focus-row tracking (↑↓ / hover; disabled rows are skipped by the host)
 *   - empty / loading / error states
 *   - root-query sections (Add / Plugins / Reference directories)
 *   - click-outside close (ignoring the `+` trigger button)
 *
 * Per F2 spec: 480px width and 44px row height. The 480px is owned by the
 * standalone `@` popover, or by MorphPopover's `panelWidth` when `embedded`.
 * Embedded content must be `w-full` — a second 480px inside the 1px-bordered
 * Morph shell overflows by 2px and flashes a 2s horizontal scrollbar.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ClipboardList,
  File as FileIcon,
  Folder as FolderIcon,
  FolderPlus,
  Globe2,
  History,
  Monitor,
  Paperclip,
  Plug,
  Sparkles,
  Target,
  UsersRound,
  X,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';
import { GhostPluginIcon } from '@/features/plugin/GhostPluginIcon';
import type { AtResourceItem } from '@/lib/atResourceService';
import {
  composerSuggestionEntryKey,
  type ComposerSuggestionAction,
  type ComposerSuggestionEntry,
} from '@/lib/composerSuggestion';
import { extraDirBasename } from './extraDirsActions';

const TOOLTIP_FALLBACK_H = 120;
const VIEWPORT_PAD = 8;

type TooltipMeasure = {
  key: string | null;
  height: number;
};

function isPluginItem(item: AtResourceItem): boolean {
  return item.type === 'plugin-command' || item.type === 'plugin-resource';
}

function isPluginEntry(entry: ComposerSuggestionEntry): boolean {
  return entry.kind === 'resource' && isPluginItem(entry.item);
}

function isAddDirEntry(entry: ComposerSuggestionEntry): boolean {
  return entry.kind === 'action'
    && (entry.action.id === 'add-extra-dir' || entry.action.id === 'add-writable-dir');
}

export type AtPanelState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; items: AtResourceItem[]; truncated: boolean; searching?: boolean };

interface ReferenceDirsSection {
  dirs: string[];
  onRemove: (path: string) => void;
}

interface AtMentionPanelProps {
  /** Query — text after the `@` trigger (typed) or the synthetic anchor (`+`). */
  query: string;
  /** Scan state managed by the host (ChatInput) — drives loading/error/hints. */
  state: AtPanelState;
  /** Final ordered entry list (actions + resources), assembled by the host. */
  entries: ComposerSuggestionEntry[];
  focusedIndex: number;
  onFocusedIndexChange: (i: number) => void;
  onSelect: (entry: ComposerSuggestionEntry) => void;
  onClose: () => void;
  onRetry: () => void;
  /** Reference-directories management rows (empty query only; `+`-menu parity). */
  referenceDirs?: ReferenceDirsSection | null;
  /** Explicit read-write directory grants (empty query only). */
  writableDirs?: ReferenceDirsSection | null;
  /** `+` 的 MorphPopover 内嵌形态；容器、阴影与 outside-click 由 MorphPopover 负责。 */
  embedded?: boolean;
  /** Panel max-height in px. Defaults to 400 (chat view); NewMaker passes a smaller value so the popover doesn't cover the logo. */
  maxHeight?: number;
}

const ACTION_ICONS: Record<ComposerSuggestionAction['id'], typeof Paperclip> = {
  'attach-files': Paperclip,
  'new-goal': Target,
  'plan-mode': ClipboardList,
  collaboration: UsersRound,
  'add-extra-dir': FolderPlus,
  'add-writable-dir': FolderPlus,
};

export function AtMentionPanel({
  query,
  state,
  entries,
  focusedIndex,
  onFocusedIndexChange,
  onSelect,
  onClose,
  onRetry,
  referenceDirs = null,
  writableDirs = null,
  embedded = false,
  maxHeight = 400,
}: AtMentionPanelProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [panelScroll, setPanelScroll] = useState(0);
  const [tooltipMeasure, setTooltipMeasure] = useState<TooltipMeasure>({
    key: null,
    height: TOOLTIP_FALLBACK_H,
  });
  const [tooltipPos, setTooltipPos] = useState<{ top: number; maxHeight: number } | null>(null);

  const isEmptyRootQuery = !query.trim();
  // Empty-query buckets (assembly order in composerSuggestion.ts guarantees
  // add → plugins → add-extra-dir, so bucketing preserves entry indices).
  const indexed = entries.map((entry, index) => ({ entry, index }));
  const addEntries = isEmptyRootQuery
    ? indexed.filter(({ entry }) => !isPluginEntry(entry) && !isAddDirEntry(entry))
    : [];
  const pluginEntries = isEmptyRootQuery ? indexed.filter(({ entry }) => isPluginEntry(entry)) : [];
  const addDirEntry = isEmptyRootQuery
    ? indexed.find(({ entry }) => entry.kind === 'action' && entry.action.id === 'add-extra-dir')
    : undefined;
  const addWritableDirEntry = isEmptyRootQuery
    ? indexed.find(({ entry }) => entry.kind === 'action' && entry.action.id === 'add-writable-dir')
    : undefined;
  const addSectionVisible = isEmptyRootQuery && addEntries.length > 0;
  const pluginSectionVisible = isEmptyRootQuery && pluginEntries.length > 0;
  const referenceDirsVisible = isEmptyRootQuery && (!!referenceDirs || !!addDirEntry);
  const writableDirsVisible = isEmptyRootQuery && (!!writableDirs || !!addWritableDirEntry);

  useEffect(() => {
    if (entries.length === 0) return;
    if (focusedIndex < 0 || focusedIndex >= entries.length) {
      onFocusedIndexChange(0);
    }
  }, [entries.length, focusedIndex, onFocusedIndexChange]);

  useEffect(() => {
    focusedRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [focusedIndex]);

  useEffect(() => {
    if (embedded) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (!rootRef.current) return;
      const target = e.target as Node;
      if (rootRef.current.contains(target)) return;
      // The `+` trigger toggles the panel itself — let its own click handler
      // decide, otherwise mousedown-close + click-toggle would reopen it.
      if (
        target instanceof Element &&
        target.closest('[data-composer-suggestion-trigger]')
      ) {
        return;
      }
      onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [embedded, onClose]);

  const focusedEntry = entries[focusedIndex];
  const focusedItem = focusedEntry?.kind === 'resource' ? focusedEntry.item : undefined;
  const showTooltip = !embedded && !!focusedItem?.description;
  const tooltipKey = showTooltip && focusedItem
    ? `${focusedItem.type}:${focusedItem.relPath}:${focusedItem.name}:${focusedItem.description ?? ''}`
    : null;
  const tooltipHeight = tooltipMeasure.key === tooltipKey
    ? tooltipMeasure.height
    : TOOLTIP_FALLBACK_H;

  useLayoutEffect(() => {
    if (!showTooltip) {
      setTooltipPos(null);
      return;
    }
    const panel = panelRef.current;
    const root = rootRef.current;
    const focusedEl = focusedRef.current;
    if (!panel || !root || !focusedEl) return;
    const panelRect = panel.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const bottomBoundary = Math.min(panelRect.bottom, window.innerHeight - VIEWPORT_PAD);
    const maxTooltipHeight = Math.max(1, Math.min(maxHeight, bottomBoundary - VIEWPORT_PAD));
    const measuredHeight = Math.min(tooltipHeight, maxTooltipHeight);
    // Anchor the flyout to the focused row's actual on-screen position — the
    // section layout varies (Add / Plugins / Reference dirs headers), so
    // arithmetic row offsets are no longer reliable.
    const rawTop = focusedEl.getBoundingClientRect().top - rootRect.top;
    const minTop = VIEWPORT_PAD - rootRect.top;
    const bottomBoundaryInRoot = bottomBoundary - rootRect.top;
    const top = Math.max(minTop, Math.min(rawTop, bottomBoundaryInRoot - measuredHeight));
    setTooltipPos({
      top: Math.round(top),
      maxHeight: Math.round(maxTooltipHeight),
    });
  }, [showTooltip, focusedIndex, focusedItem, panelScroll, maxHeight, tooltipHeight]);

  const tooltipVisible = showTooltip && !!tooltipPos;
  useLayoutEffect(() => {
    if (!tooltipVisible || !tooltipKey) return;
    const tooltip = tooltipRef.current;
    if (!tooltip) return;
    const update = () => {
      const next = Math.max(1, Math.round(tooltip.getBoundingClientRect().height));
      setTooltipMeasure((prev) => (
        prev.key === tooltipKey && prev.height === next
          ? prev
          : { key: tooltipKey, height: next }
      ));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(tooltip);
    return () => observer.disconnect();
  }, [tooltipVisible, tooltipKey]);

  const renderSectionHeader = (label: string) => (
    <div
      className={cn(
        'flex h-[24px] items-center px-[10px]',
        'text-12 font-medium text-[var(--cmd-palette-item-meta)]',
      )}
    >
      {label}
    </div>
  );

  const renderActionRow = (action: ComposerSuggestionAction, idx: number) => {
    const focused = idx === focusedIndex;
    const Icon = ACTION_ICONS[action.id];
    const isCheckbox = action.checked !== undefined;
    // Collaboration keeps its Thinking-Orange enabled state from the legacy
    // `+` menu (id-driven presentation; the data model stays lean).
    const emphasized = action.id === 'collaboration' && action.checked === true;
    const row = (
      <button
        key={`action:${action.id}`}
        ref={focused ? focusedRef : undefined}
        type="button"
        role={isCheckbox ? 'menuitemcheckbox' : undefined}
        aria-checked={isCheckbox ? action.checked : undefined}
        aria-disabled={action.disabled ? true : undefined}
        disabled={action.disabled}
        aria-label={
          action.disabledReason ? `${action.label}: ${action.disabledReason}` : undefined
        }
        onMouseDown={(e) => {
          e.preventDefault();
        }}
        onClick={() => {
          if (action.disabled) return;
          onSelect({ kind: 'action', action });
        }}
        onMouseEnter={() => {
          if (!action.disabled) onFocusedIndexChange(idx);
        }}
        className={cn(
          'flex w-full items-center gap-2',
          'rounded-[8px] px-3 py-2',
          'text-left outline-none transition-colors',
          focused && 'bg-[var(--model-item-hover)]',
          'hover:bg-[var(--model-item-hover)]',
          emphasized && 'bg-[var(--model-item-hover)]',
          action.disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        <Icon
          size={14}
          className={cn(
            'shrink-0',
            emphasized ? 'text-[var(--warning-accent)]' : 'text-[var(--model-item-text)]',
          )}
        />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-13',
            emphasized ? 'text-[var(--warning-accent)]' : 'text-[var(--model-item-text)]',
          )}
        >
          {action.label}
        </span>
        {isCheckbox && action.checked && (
          <Check size={13} className="ml-auto shrink-0 text-[var(--model-item-check)]" />
        )}
      </button>
    );
    if (action.disabled && action.disabledReason) {
      return (
        <Tip key={`action:${action.id}`} text={action.disabledReason} side="right">
          <span className="block">{row}</span>
        </Tip>
      );
    }
    return row;
  };

  const renderResourceRow = (
    entry: Extract<ComposerSuggestionEntry, { kind: 'resource' }>,
    idx: number,
  ) => {
    const item = entry.item;
    const focused = idx === focusedIndex;
    const disabled = entry.disabled === true;
    let meta: string;
    if (item.type === 'file-picker') {
      meta = '';
    } else if (item.type === 'agent') {
      meta = 'Agent';
    } else if (item.type === 'browser-tab') {
      meta = t('newChat.atMention.browserTab');
    } else if (item.type === 'desktop-window') {
      meta = item.description || t('newChat.atMention.desktopWindow');
    } else if (item.type === 'session') {
      meta = t('newChat.atMention.task');
    } else if (item.type === 'plugin-command') {
      // Plugin rows follow the compact icon + name presentation used by the
      // installed-plugin menu; the command remains an internal selection key.
      meta = '';
    } else if (item.type === 'plugin-resource') {
      meta = item.sourceLabel || t('newChat.atMention.pluginResource');
    } else {
      const lastSlash = item.relPath.lastIndexOf('/');
      meta = lastSlash >= 0 ? item.relPath.slice(0, lastSlash) : '';
    }
    const displayName = item.type === 'file-picker'
      ? t('newChat.atMention.filesAndFolders')
      : item.type === 'dir'
        ? `${item.name}/`
        : item.name;
    const Icon = item.type === 'file-picker'
      ? Paperclip
      : item.type === 'agent'
      ? Sparkles
      : item.type === 'dir'
        ? FolderIcon
        : item.type === 'browser-tab'
          ? Globe2
          : item.type === 'desktop-window'
            ? Monitor
            : item.type === 'session'
              ? History
              : item.type === 'plugin-command' || item.type === 'plugin-resource'
                ? Plug
              : FileIcon;

    return (
      <button
        key={composerSuggestionEntryKey(entry)}
        ref={focused ? focusedRef : undefined}
        type="button"
        disabled={disabled}
        aria-disabled={disabled ? true : undefined}
        onMouseDown={(e) => {
          e.preventDefault();
        }}
        onClick={() => {
          if (disabled) return;
          onSelect(entry);
        }}
        onMouseEnter={() => {
          if (!disabled) onFocusedIndexChange(idx);
        }}
        className={cn(
          'flex w-full items-center gap-2',
          'h-[44px] px-[10px] rounded-[6px]',
          'text-left outline-none transition-colors',
          focused && 'bg-[var(--cmd-palette-item-hover)]',
          disabled && 'cursor-not-allowed opacity-45',
        )}
      >
        {isPluginItem(item) ? (
          <GhostPluginIcon
            iconDataUrl={item.iconDataUrl}
            iconId={item.pluginId ?? item.relPath}
            iconName={item.type === 'plugin-resource' ? (item.sourceLabel ?? item.name) : item.name}
            size="menu"
          />
        ) : (
          <Icon size={16} className="shrink-0 text-[var(--cmd-palette-item-icon)]" />
        )}
        <span
          className={cn(
            'min-w-0 truncate text-14 font-medium',
            'text-[var(--cmd-palette-item-text)]',
          )}
        >
          {displayName}
        </span>
        {disabled && entry.disabledReason ? (
          <span
            className={cn(
              'shrink-0 text-12 truncate max-w-[240px]',
              'text-[var(--cmd-palette-item-meta)]',
              'ml-auto',
            )}
          >
            {entry.disabledReason}
          </span>
        ) : meta ? (
          <Tip text={meta} mono>
            <span
              className={cn(
                'shrink-0 text-12 truncate max-w-[240px]',
                'text-[var(--cmd-palette-item-meta)]',
                'ml-auto',
              )}
            >
              {meta}
            </span>
          </Tip>
        ) : null}
      </button>
    );
  };

  const renderEntryRow = ({ entry, index }: { entry: ComposerSuggestionEntry; index: number }) =>
    entry.kind === 'action'
      ? renderActionRow(entry.action, index)
      : renderResourceRow(entry, index);

  const showLoadingSkeleton = state.kind === 'loading' && entries.length === 0;
  const showErrorState = state.kind === 'error' && entries.length === 0;
  const showEmptyState = !showLoadingSkeleton && !showErrorState && entries.length === 0;

  return (
    <div
      ref={rootRef}
      className={cn(
        'pointer-events-auto',
        embedded ? 'relative' : 'absolute left-0 bottom-full mb-2 z-50',
      )}
    >
      <div
        ref={panelRef}
        onScroll={(e) => setPanelScroll(e.currentTarget.scrollTop)}
        className={cn(
          // embedded: fill the Morph shell. A nested w-[480px] is 2px wider
          // than the border-box panel and paints a horizontal scrollbar thumb
          // for ~2s via the global .is-scrolling auto-hide.
          embedded ? 'w-full min-w-0' : 'w-[480px]',
          'overflow-x-hidden overflow-y-auto',
          'p-[6px]',
          !embedded && [
            'rounded-[12px] border',
            'bg-[var(--cmd-palette-bg)]',
            'border-[var(--cmd-palette-border)]',
          ],
        )}
        style={{ boxShadow: embedded ? undefined : 'var(--cmd-palette-shadow)', maxHeight }}
      >
        {showLoadingSkeleton && (
          <div className="space-y-[4px] p-[4px]">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-[44px] rounded-[6px] bg-[var(--cmd-palette-item-hover)] opacity-40 animate-pulse"
              />
            ))}
          </div>
        )}
        {showErrorState && (
          <div className="flex flex-col items-center justify-center py-[16px] gap-[10px]">
            <div className="text-13 text-[var(--destructive)]">
              {t('newChat.atMention.scanFailed')}
            </div>
            <div className="text-12 text-[var(--cmd-palette-item-meta)] px-[12px] text-center">
              {state.kind === 'error' ? state.message : ''}
            </div>
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
              }}
              onClick={() => {
                onRetry();
              }}
              className={cn(
                'h-[28px] px-[12px] rounded-full text-12 font-medium',
                'bg-[var(--cmd-palette-item-hover)] text-[var(--cmd-palette-item-text)]',
              )}
            >
              {t('newChat.atMention.retry')}
            </button>
          </div>
        )}
        {showEmptyState && (
          <div
            className={cn(
              'flex items-center justify-center',
              'select-none h-[40px] text-13',
              'text-[var(--cmd-palette-empty)]',
            )}
          >
            {state.kind === 'ready' && state.searching
              ? t('newChat.atMention.searching')
              : isEmptyRootQuery
                ? t('newChat.atMention.typeToSearchFiles')
                : t('newChat.atMention.noMatch')}
          </div>
        )}
        {entries.length > 0 && (
          <>
            {isEmptyRootQuery ? (
              <>
                {addSectionVisible && renderSectionHeader(t('newChat.atMention.add'))}
                {addEntries.map(renderEntryRow)}
                {pluginSectionVisible && renderSectionHeader(t('extraDirs.pluginsTitle'))}
                {pluginEntries.map(renderEntryRow)}
                {referenceDirsVisible && (
                  <>
                    {renderSectionHeader(t('extraDirs.sectionTitle'))}
                    {referenceDirs && referenceDirs.dirs.length > 0 && (
                      <div role="list" aria-label={t('extraDirs.sectionTitle')}>
                        {referenceDirs.dirs.map((p) => (
                          <div
                            key={p}
                            className={cn(
                              'group flex h-[44px] items-center gap-2 rounded-[6px] px-[10px]',
                              'hover:bg-[var(--cmd-palette-item-hover)]',
                            )}
                          >
                            <FolderPlus
                              size={16}
                              className="shrink-0 text-[var(--cmd-palette-item-icon)] opacity-60"
                            />
                            <Tip text={p} mono side="top">
                              <span className="min-w-0 flex-1 truncate text-left text-14 text-[var(--cmd-palette-item-text)]">
                                {extraDirBasename(p)}
                              </span>
                            </Tip>
                            <button
                              type="button"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => referenceDirs.onRemove(p)}
                              className={cn(
                                'rounded-full p-1 opacity-0 transition-opacity',
                                'hover:bg-[var(--cmd-palette-item-hover)]',
                                'group-hover:opacity-70 hover:!opacity-100',
                                'focus-visible:opacity-100 focus-visible:outline-none',
                                'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                              )}
                              aria-label={t('extraDirs.remove', { name: extraDirBasename(p) })}
                            >
                              <X size={12} className="text-[var(--cmd-palette-item-text)]" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    {referenceDirs && referenceDirs.dirs.length === 0 && (
                      <div className="px-[10px] py-[8px] text-12 text-[var(--cmd-palette-item-meta)]">
                        {t('extraDirs.empty')}
                      </div>
                    )}
                    {addDirEntry && renderEntryRow(addDirEntry)}
                  </>
                )}
                {writableDirsVisible && (
                  <>
                    {renderSectionHeader(t('extraDirs.writableSectionTitle'))}
                    {writableDirs && writableDirs.dirs.length > 0 && (
                      <div role="list" aria-label={t('extraDirs.writableSectionTitle')}>
                        {writableDirs.dirs.map((p) => (
                          <div
                            key={p}
                            className={cn(
                              'group flex h-[44px] items-center gap-2 rounded-[6px] px-[10px]',
                              'hover:bg-[var(--cmd-palette-item-hover)]',
                            )}
                          >
                            <FolderPlus
                              size={16}
                              className="shrink-0 text-[var(--cmd-palette-item-icon)] opacity-60"
                            />
                            <Tip text={p} mono side="top">
                              <span className="min-w-0 flex-1 truncate text-left text-14 text-[var(--cmd-palette-item-text)]">
                                {extraDirBasename(p)}
                              </span>
                            </Tip>
                            <button
                              type="button"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => writableDirs.onRemove(p)}
                              className={cn(
                                'rounded-full p-1 opacity-0 transition-opacity',
                                'hover:bg-[var(--cmd-palette-item-hover)]',
                                'group-hover:opacity-70 hover:!opacity-100',
                                'focus-visible:opacity-100 focus-visible:outline-none',
                                'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                              )}
                              aria-label={t('extraDirs.remove', { name: extraDirBasename(p) })}
                            >
                              <X size={12} className="text-[var(--cmd-palette-item-text)]" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    {writableDirs && writableDirs.dirs.length === 0 && (
                      <div className="px-[10px] py-[8px] text-12 text-[var(--cmd-palette-item-meta)]">
                        {t('extraDirs.writableEmpty')}
                      </div>
                    )}
                    {addWritableDirEntry && renderEntryRow(addWritableDirEntry)}
                  </>
                )}
              </>
            ) : (
              indexed.map(renderEntryRow)
            )}
            {isEmptyRootQuery && (
              <div
                className={cn(
                  'select-none px-[10px] py-[8px] text-12',
                  'text-[var(--cmd-palette-item-meta)]',
                )}
              >
                {t('newChat.atMention.typeToSearchFiles')}
              </div>
            )}
            {!isEmptyRootQuery && state.kind === 'ready' && state.truncated && (
              <div
                className={cn(
                  'select-none px-[10px] py-[8px] text-12',
                  'text-[var(--cmd-palette-item-meta)]',
                )}
              >
                {t('newChat.atMention.keepTyping')}
              </div>
            )}
            {state.kind === 'error' && (
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                }}
                onClick={() => {
                  onRetry();
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-[10px] py-[8px] rounded-[6px] text-left',
                  'text-12 text-[var(--destructive)]',
                  'transition-colors hover:bg-[var(--cmd-palette-item-hover)]',
                )}
              >
                {t('newChat.atMention.scanFailed')} · {t('newChat.atMention.retry')}
              </button>
            )}
          </>
        )}
      </div>

      {/* Agent tooltip — same pattern as SlashCommandPalette tooltip.
           Only shown for resource entries that have a description. */}
      {showTooltip && tooltipPos && focusedItem && (
        <div
          ref={tooltipRef}
          className={cn(
            'w-[280px] overflow-y-auto rounded-[12px] border p-[14px]',
            'bg-[var(--cmd-palette-bg)]',
            'border-[var(--cmd-palette-border)]',
            'absolute left-[488px]',  // 480 panel + 8 gap
          )}
          style={{
            boxShadow: 'var(--cmd-palette-shadow)',
            top: tooltipPos.top,
            maxHeight: tooltipPos.maxHeight,
          }}
        >
          <div className="text-14 font-medium text-[var(--cmd-palette-item-text)]">
            {focusedItem.name}
          </div>
          <div className="mt-[8px] text-13 leading-[1.5] text-[var(--cmd-palette-tooltip-body)]">
            {focusedItem.description}
          </div>
        </div>
      )}
    </div>
  );
}
