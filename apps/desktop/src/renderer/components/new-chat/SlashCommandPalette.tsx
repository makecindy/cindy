/**
 * command-palette F1: `/` slash-command palette.
 *
 * Stateless presentational popover — receives the current query string
 * (whatever the user typed after `/`) and the list of available commands
 * (merged builtin + user), renders the filtered list with a focused row,
 * and emits selection / close callbacks back to ChatInput.
 *
 * Design tokens come from globals.css `--cmd-palette-*` and match the
 * pen spec `hx8uF` (320px width, 400px max height, 36px row, 12px radius).
 * The description tooltip is portaled to `document.body` and positioned
 * with viewport coords (right of panel, flipped to left when no room) so
 * it survives ancestor `overflow-x-auto` clipping (doc-mode chat rail).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';
import {
  filterSlashCommands,
  type UnifiedCommand,
} from '@/lib/slashCommands';

const TOOLTIP_W = 280;
const TOOLTIP_GAP = 8;
const VIEWPORT_PAD = 8;
const TOOLTIP_FALLBACK_H = 120;

type TooltipMeasure = {
  key: string | null;
  height: number;
};

interface SlashCommandPaletteProps {
  /** Query string — everything after the `/` trigger up to the cursor. */
  query: string;
  /** Merged list of available commands (desktop + agent-builtin + agent-skill). */
  commands: UnifiedCommand[];
  /** Currently focused row index within the filtered list. */
  focusedIndex: number;
  onFocusedIndexChange: (i: number) => void;
  /** Called when the user picks a command (Enter / click). */
  onSelect: (command: UnifiedCommand) => void;
  /** Called when user presses Esc or clicks outside. ChatInput owns close. */
  onClose: () => void;
  /** Reports hover state for the portaled tooltip so ChatInput's blur guard treats it as part of the palette. */
  onTooltipHoverChange?: (hovered: boolean) => void;
  /** Panel max-height in px. Defaults to 400 (chat view); NewMaker passes a smaller value so the popover doesn't cover the logo. */
  maxHeight?: number;
}

/** 右侧小标签文案 —— skill 显示 source(user/skill), agent-builtin 显示 'agent-cmd'
 * (避免和"agent 本身"混淆), desktop 不打标签(内置默认)。 */
function metaLabel(cmd: UnifiedCommand): string | null {
  if (cmd.kind === 'agent-skill') return cmd.source; // 'user' | 'skill'
  if (cmd.kind === 'agent-builtin') return 'agent-cmd';
  return null; // 'desktop' 不显示标签 (内置默认)
}

export function SlashCommandPalette({
  query,
  commands,
  focusedIndex,
  onFocusedIndexChange,
  onSelect,
  onClose,
  onTooltipHoverChange,
  maxHeight = 400,
}: SlashCommandPaletteProps) {
  const filtered = useMemo(() => filterSlashCommands(commands, query), [commands, query]);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  // Track panel scroll so the tooltip follows the focused row's visual position.
  const [panelScroll, setPanelScroll] = useState(0);
  const [tooltipMeasure, setTooltipMeasure] = useState<TooltipMeasure>({
    key: null,
    height: TOOLTIP_FALLBACK_H,
  });

  // Clamp focusedIndex to filtered length (query may have shrunk the list
  // below the current focus). This is the only piece of derived state we
  // own; everything else is driven by props.
  useEffect(() => {
    if (filtered.length === 0) return;
    if (focusedIndex < 0 || focusedIndex >= filtered.length) {
      onFocusedIndexChange(0);
    }
  }, [filtered.length, focusedIndex, onFocusedIndexChange]);

  // Dismiss on outside click — the hosting component (ChatInput) already
  // exposes the palette via its own state machine, but a mouse click
  // outside the panel should still close it.
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (!rootRef.current) return;
      const target = e.target as Node;
      if (rootRef.current.contains(target) || tooltipRef.current?.contains(target)) {
        return;
      }
      // Let ChatInput decide — it also owns the textarea so we don't
      // want to close if the click is on the textarea itself. ChatInput
      // subscribes to this via onClose and can short-circuit.
      onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  // Keep the focused row scrolled into view on arrow-key navigation.
  const focusedRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    focusedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [focusedIndex]);

  const focusedCmd = filtered[focusedIndex];
  const tooltipKey = focusedCmd
    ? `${focusedCmd.kind}:${focusedCmd.name}:${focusedCmd.description ?? ''}`
    : null;
  const tooltipHeight = tooltipMeasure.key === tooltipKey
    ? tooltipMeasure.height
    : TOOLTIP_FALLBACK_H;

  // Tooltip position is computed in viewport coords and rendered via portal so
  // it can escape ancestor `overflow-x-auto` (doc-mode rail clips the right
  // side of the panel otherwise — see WorkdirBrowseRoute chat-rail-compact).
  // Recomputed on focus / scroll / window resize so it tracks the focused row.
  const [tooltipPos, setTooltipPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    if (!focusedCmd) {
      setTooltipPos(null);
      return;
    }
    const compute = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const panelRect = panel.getBoundingClientRect();
      const rowRect = focusedRef.current?.getBoundingClientRect();
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      const bottomBoundary = Math.min(panelRect.bottom, viewportH - VIEWPORT_PAD);
      const tooltipMaxHeight = Math.max(1, Math.min(maxHeight, bottomBoundary - VIEWPORT_PAD));
      const measuredHeight = Math.min(tooltipHeight, tooltipMaxHeight);
      // Prefer right side; flip to left when there isn't TOOLTIP_W + padding.
      const rightLeft = panelRect.right + TOOLTIP_GAP;
      const fitsRight = rightLeft + TOOLTIP_W + VIEWPORT_PAD <= viewportW;
      const left = fitsRight
        ? rightLeft
        : Math.max(VIEWPORT_PAD, panelRect.left - TOOLTIP_GAP - TOOLTIP_W);
      // Vertically align with focused row; clamp so the tooltip never drops
      // below the palette panel bottom (or the viewport bottom, whichever is higher).
      const rawTop = (rowRect?.top ?? panelRect.top) - 6;
      const top = Math.max(VIEWPORT_PAD, Math.min(rawTop, bottomBoundary - measuredHeight));
      setTooltipPos({
        left: Math.round(left),
        top: Math.round(top),
        maxHeight: Math.round(tooltipMaxHeight),
      });
    };
    compute();
    const handle = () => compute();
    window.addEventListener('resize', handle);
    window.addEventListener('scroll', handle, true);
    return () => {
      window.removeEventListener('resize', handle);
      window.removeEventListener('scroll', handle, true);
    };
  }, [focusedCmd, focusedIndex, panelScroll, filtered.length, maxHeight, tooltipHeight]);

  const tooltipVisible = !!focusedCmd && !!tooltipPos;
  useEffect(() => {
    if (!tooltipVisible) onTooltipHoverChange?.(false);
  }, [tooltipVisible, onTooltipHoverChange]);

  useEffect(() => () => onTooltipHoverChange?.(false), [onTooltipHoverChange]);

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

  return (
    <div
      ref={rootRef}
      className={cn(
        'pointer-events-auto absolute left-0 bottom-full mb-2 z-50',
      )}
    >
      {/* Panel */}
      <div
        ref={panelRef}
        onScroll={(e) => setPanelScroll(e.currentTarget.scrollTop)}
        className={cn(
          'w-[320px] overflow-y-auto',
          'rounded-[12px] border p-[6px]',
          'bg-[var(--cmd-palette-bg)]',
          'border-[var(--cmd-palette-border)]',
          // mount-only 入场:面板锚在输入框上方,从左下角轻长出(DESIGN.md
          // §14.4 轻浮层原型);输入过滤只重渲不重挂,动画不会重放。
          'origin-bottom-left animate-float-in',
        )}
        style={{ boxShadow: 'var(--cmd-palette-shadow)', maxHeight }}
      >
        {filtered.length === 0 ? (
          <div
            className={cn(
              'flex items-center justify-center',
              'h-[40px] text-13',
              'text-[var(--cmd-palette-empty)]',
            )}
          >
            No matching commands
          </div>
        ) : (
          filtered.map((cmd, idx) => {
            const focused = idx === focusedIndex;
            return (
              <button
                key={cmd.name}
                ref={focused ? focusedRef : undefined}
                type="button"
                // `onMouseDown` instead of `onClick` so the textarea
                // keeps focus — click would fire after blur.
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(cmd);
                }}
                onMouseEnter={() => onFocusedIndexChange(idx)}
                className={cn(
                  'flex w-full items-center justify-between',
                  'h-[36px] px-[10px] rounded-[6px]',
                  'text-left text-14 font-medium',
                  'text-[var(--cmd-palette-item-text)]',
                  'outline-none transition-colors',
                  focused && 'bg-[var(--cmd-palette-item-hover)]',
                )}
              >
                <span className="truncate">{cmd.name}</span>
                {metaLabel(cmd) && (
                  <span className="shrink-0 text-12 font-normal text-[var(--cmd-palette-item-meta)]">
                    {metaLabel(cmd)}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>

      {/* Tooltip — portaled to body with viewport-coord positioning so it
           survives ancestor `overflow-x-auto` (doc-mode rail). Flips to the
           left of the panel when the right side has no room. */}
      {focusedCmd && tooltipPos && createPortal(
        <div
          ref={tooltipRef}
          onMouseEnter={() => onTooltipHoverChange?.(true)}
          onMouseLeave={() => onTooltipHoverChange?.(false)}
          onMouseDown={() => onTooltipHoverChange?.(true)}
          className={cn(
            'fixed z-[60] w-[280px] overflow-y-auto rounded-[12px] border p-[14px]',
            'bg-[var(--cmd-palette-bg)]',
            'border-[var(--cmd-palette-border)]',
          )}
          style={{
            boxShadow: 'var(--cmd-palette-shadow)',
            left: tooltipPos.left,
            top: tooltipPos.top,
            maxHeight: tooltipPos.maxHeight,
          }}
        >
          <div className="text-14 font-medium text-[var(--cmd-palette-item-text)]">
            {focusedCmd.name}
          </div>
          <div className="mt-[8px] text-13 leading-[1.5] text-[var(--cmd-palette-tooltip-body)]">
            {focusedCmd.description}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
