/**
 * command-palette F2 / F5: `@` resource panel.
 *
 * Presentational popover that renders the filtered list of files, dirs,
 * and agents scanned from workingDir. All scanning / ranking logic lives
 * in `atResourceService.ts`; this component handles:
 *   - focus-row tracking (↑↓ / hover)
 *   - empty / loading / error states
 *   - root-query sections for addable resources and installed plugins
 *   - click-outside close
 *
 * Per F2 spec: 480px width and 44px row height. The root query uses compact
 * section labels to separate addable resources from installed plugins.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  File as FileIcon,
  Folder as FolderIcon,
  Globe2,
  History,
  Monitor,
  Paperclip,
  Plug,
  Sparkles,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';
import { GhostPluginIcon } from '@/features/plugin/GhostPluginIcon';
import {
  AT_FILE_PICKER_RESOURCE,
  filterAtResources,
  type AtResourceItem,
} from '@/lib/atResourceService';

const TOOLTIP_FALLBACK_H = 120;
const VIEWPORT_PAD = 8;
const SECTION_HEADER_H = 24;

type TooltipMeasure = {
  key: string | null;
  height: number;
};

function isPluginItem(item: AtResourceItem): boolean {
  return item.type === 'plugin-command' || item.type === 'plugin-resource';
}

export type AtPanelState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; items: AtResourceItem[]; truncated: boolean; searching?: boolean };

interface AtMentionPanelProps {
  /** Query — everything after `@` trigger up to the cursor. */
  query: string;
  /** Scan state managed by the host (ChatInput). */
  state: AtPanelState;
  focusedIndex: number;
  onFocusedIndexChange: (i: number) => void;
  onSelect: (item: AtResourceItem) => void;
  onClose: () => void;
  onRetry: () => void;
  /** Whether the local task can launch the native file picker. */
  filePickerEnabled?: boolean;
  /** Panel max-height in px. Defaults to 400 (chat view); NewMaker passes a smaller value so the popover doesn't cover the logo. */
  maxHeight?: number;
}

export function AtMentionPanel({
  query,
  state,
  focusedIndex,
  onFocusedIndexChange,
  onSelect,
  onClose,
  onRetry,
  filePickerEnabled = false,
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

  const filtered = useMemo(() => {
    if (state.kind !== 'ready') return [];
    const items = filePickerEnabled
      ? [AT_FILE_PICKER_RESOURCE, ...state.items]
      : state.items;
    return filterAtResources(items, query);
  }, [state, query, filePickerEnabled]);
  const isEmptyRootQuery = !query.trim();
  const indexedFiltered = useMemo(
    () => filtered.map((item, index) => ({ item, index })),
    [filtered],
  );
  const addItems = isEmptyRootQuery
    ? indexedFiltered.filter(({ item }) => !isPluginItem(item))
    : [];
  const pluginItems = isEmptyRootQuery
    ? indexedFiltered.filter(({ item }) => isPluginItem(item))
    : [];
  const addSectionVisible = isEmptyRootQuery && addItems.length > 0;
  const pluginSectionVisible = isEmptyRootQuery && pluginItems.length > 0;

  useEffect(() => {
    if (filtered.length === 0) return;
    if (focusedIndex < 0 || focusedIndex >= filtered.length) {
      onFocusedIndexChange(0);
    }
  }, [filtered.length, focusedIndex, onFocusedIndexChange]);

  useEffect(() => {
    focusedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [focusedIndex]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const focusedItem = filtered[focusedIndex];
  const showTooltip = !!focusedItem?.description;
  const tooltipKey = showTooltip
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
    if (!panel || !root) return;
    const panelRect = panel.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const bottomBoundary = Math.min(panelRect.bottom, window.innerHeight - VIEWPORT_PAD);
    const maxTooltipHeight = Math.max(1, Math.min(maxHeight, bottomBoundary - VIEWPORT_PAD));
    const measuredHeight = Math.min(tooltipHeight, maxTooltipHeight);
    const focusedIsPlugin = isEmptyRootQuery && !!focusedItem && isPluginItem(focusedItem);
    const sectionOffset = isEmptyRootQuery
      ? SECTION_HEADER_H + (focusedIsPlugin && addSectionVisible ? SECTION_HEADER_H : 0)
      : 0;
    const rawTop = 6 + sectionOffset + focusedIndex * 44 - panelScroll;
    const minTop = VIEWPORT_PAD - rootRect.top;
    const bottomBoundaryInRoot = bottomBoundary - rootRect.top;
    const top = Math.max(minTop, Math.min(rawTop, bottomBoundaryInRoot - measuredHeight));
    setTooltipPos({
      top: Math.round(top),
      maxHeight: Math.round(maxTooltipHeight),
    });
  }, [
    showTooltip,
    focusedIndex,
    focusedItem,
    panelScroll,
    maxHeight,
    tooltipHeight,
    isEmptyRootQuery,
    addSectionVisible,
  ]);

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

  const renderItemRow = (item: AtResourceItem, idx: number) => {
    const focused = idx === focusedIndex;
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
        key={`${item.type}:${item.relPath}`}
        ref={focused ? focusedRef : undefined}
        type="button"
        onMouseDown={(e) => {
          e.preventDefault();
          onSelect(item);
        }}
        onMouseEnter={() => onFocusedIndexChange(idx)}
        className={cn(
          'flex w-full items-center gap-2',
          'h-[44px] px-[10px] rounded-[6px]',
          'text-left outline-none transition-colors',
          focused && 'bg-[var(--cmd-palette-item-hover)]',
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
            'min-w-0 truncate text-[14px] font-medium',
            'text-[var(--cmd-palette-item-text)]',
          )}
        >
          {displayName}
        </span>
        {meta && (
          <Tip text={meta} mono>
            <span
              className={cn(
                'shrink-0 text-[12px] truncate max-w-[240px]',
                'text-[var(--cmd-palette-item-meta)]',
                'ml-auto',
              )}
            >
              {meta}
            </span>
          </Tip>
        )}
      </button>
    );
  };

  return (
    <div
      ref={rootRef}
      className={cn('pointer-events-auto absolute left-0 bottom-full mb-2 z-50')}
    >
      <div
        ref={panelRef}
        onScroll={(e) => setPanelScroll(e.currentTarget.scrollTop)}
        className={cn(
          'w-[480px] overflow-y-auto',
          'rounded-[12px] border p-[6px]',
          'bg-[var(--cmd-palette-bg)]',
          'border-[var(--cmd-palette-border)]',
        )}
        style={{ boxShadow: 'var(--cmd-palette-shadow)', maxHeight }}
      >
        {state.kind === 'loading' && (
          <div className="space-y-[4px] p-[4px]">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-[44px] rounded-[6px] bg-[var(--cmd-palette-item-hover)] opacity-40 animate-pulse"
              />
            ))}
          </div>
        )}
        {state.kind === 'error' && (
          <div className="flex flex-col items-center justify-center py-[16px] gap-[10px]">
            <div className="text-[13px] text-[var(--destructive)]">
              {t('newChat.atMention.scanFailed')}
            </div>
            <div className="text-[12px] text-[var(--cmd-palette-item-meta)] px-[12px] text-center">
              {state.message}
            </div>
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onRetry();
              }}
              className={cn(
                'h-[28px] px-[12px] rounded-full text-[12px] font-medium',
                'bg-[var(--cmd-palette-item-hover)] text-[var(--cmd-palette-item-text)]',
              )}
            >
              {t('newChat.atMention.retry')}
            </button>
          </div>
        )}
        {state.kind === 'ready' && filtered.length === 0 && (
          <div
            className={cn(
              'flex items-center justify-center',
              'select-none h-[40px] text-[13px]',
              'text-[var(--cmd-palette-empty)]',
            )}
          >
            {state.searching
              ? t('newChat.atMention.searching')
              : isEmptyRootQuery
                ? t('newChat.atMention.typeToSearchFiles')
                : t('newChat.atMention.noMatch')}
          </div>
        )}
        {state.kind === 'ready' && filtered.length > 0 && (
          <>
            {isEmptyRootQuery ? (
              <>
                {addSectionVisible && (
                  <div
                    className={cn(
                      'flex h-[24px] items-center px-[10px]',
                      'text-[12px] font-medium text-[var(--cmd-palette-item-meta)]',
                    )}
                  >
                    {t('newChat.atMention.add')}
                  </div>
                )}
                {addItems.map(({ item, index }) => renderItemRow(item, index))}
                {pluginSectionVisible && (
                  <div
                    className={cn(
                      'flex h-[24px] items-center px-[10px]',
                      'text-[12px] font-medium text-[var(--cmd-palette-item-meta)]',
                    )}
                  >
                    {t('newChat.atMention.plugins')}
                  </div>
                )}
                {pluginItems.map(({ item, index }) => renderItemRow(item, index))}
              </>
            ) : (
              filtered.map((item, idx) => renderItemRow(item, idx))
            )}
            {isEmptyRootQuery && (
              <div
                className={cn(
                  'select-none px-[10px] py-[8px] text-[12px]',
                  'text-[var(--cmd-palette-item-meta)]',
                )}
              >
                {t('newChat.atMention.typeToSearchFiles')}
              </div>
            )}
            {!isEmptyRootQuery && state.truncated && (
              <div
                className={cn(
                  'select-none px-[10px] py-[8px] text-[12px]',
                  'text-[var(--cmd-palette-item-meta)]',
                )}
              >
                {t('newChat.atMention.keepTyping')}
              </div>
            )}
          </>
        )}
      </div>

      {/* Agent tooltip — same pattern as SlashCommandPalette tooltip.
           Only shown for agent items that have a description. */}
      {showTooltip && tooltipPos && (
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
          <div className="text-[14px] font-medium text-[var(--cmd-palette-item-text)]">
            {focusedItem.name}
          </div>
          <div className="mt-[8px] text-[13px] leading-[1.5] text-[var(--cmd-palette-tooltip-body)]">
            {focusedItem.description}
          </div>
        </div>
      )}
    </div>
  );
}
