/**
 * ThinkingCard
 * ---------------------------------------------------------------------------
 * Renders an Anthropic extended-thinking block inside the message stream.
 *
 * Visual contract (sourced from `.pen` reference frames `T9eNL` collapsed
 * and `9QkTY` expanded):
 *   - Header row: `gap:6 padding:[2,0]`, lucide sparkles 14×14 in
 *     `--msg-tool-card-chevron`, summary Inter 14 normal in same color,
 *     trailing chevron 14×14. No card chrome.
 *   - Body: `padding:[6,0,6,12]`, 2px left border `--agent-actions-rail`,
 *     paragraphs Inter 14 italic in `--thinking-body-text`.
 *
 * Variants:
 *   1. in_progress — model is currently emitting thinking_delta events
 *   2. final       — finished; "Thought for Xs" summary
 *   3. redacted    — server-side redacted reasoning, no plaintext
 *
 * v2 changes (2026-04-20 — F8 + F9):
 *   - **Default collapsed for every state**, including streaming. Streaming
 *     state still shows `✦ Thinking...` with animated dots + duration, but
 *     the body stays folded until the user clicks.
 *   - Persisted per-block via `useExpandedBlockMemory`. Storage key is
 *     `thinking:<startedAt>` so the block survives re-renders without
 *     needing a stable clientId from the parent.
 *   - Removed `isTurnActive` + `userInteractedRef` dual state machine —
 *     the persistent hook is the single source of truth.
 */

import { CHAT_CHEVRON_TRANSITION_CLASS, CHAT_FOCUS_CLASS } from './chatChrome';
import {
  ACTIVITY_ROW_RADIUS_CLASS,
  ACTIVITY_ROW_HOVER_SURFACE_CLASS,
  ACTIVITY_ROW_COLOR_TRANSITION_CLASS,
} from './activityRowChrome';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sparkles, ChevronRight, Lock } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Collapse } from '@/components/ui/collapse';
import { useExpandedBlockMemory } from '@/hooks/useExpandedBlockMemory';

import { ThinkingText } from './ThinkingText';

interface ThinkingCardProps {
  /** Thinking content with lightweight inline emphasis. Empty for redacted blocks. */
  content: string;
  /** True while the model is still streaming this block (delta still
   *  arriving). Drives the in-progress dots + duration ticker. */
  isStreaming?: boolean;
  /** Wall-clock ms when streaming started (for live elapsed counter). */
  startedAt?: number;
  /** Frozen duration in ms once the block is final. */
  durationMs?: number;
  /** True for server-redacted blocks (no plaintext available). Claude-only. */
  isRedacted?: boolean;
  /** True when the turn was aborted before reasoning completed. Codex-only.
   *  Claude 的 thinking 不会单独发 aborted 状态(turn_aborted 整体复位)。
   *  与 isRedacted 互斥 —— 同一 message 不会两个都为 true。 */
  aborted?: boolean;
  /** Stable per-block id for the persistence layer. Falls back to
   *  `startedAt` (ms timestamp), which is unique enough for one session. */
  blockKey?: string;
}

/**
 * Format ms as `Xs` for short durations, or `Xm Ys` for longer.
 * Exported for reuse by WorkGroupBlock (same display convention).
 */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(1, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/** Shared body wrapper — left-railed container mirroring AgentActionsBlock. */
function BodyRail({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'select-text mt-1 pl-3 py-1.5',
        'border-l-2 border-[var(--agent-actions-rail)]',
      )}
    >
      {children}
    </div>
  );
}

export function ThinkingCard({
  content,
  isStreaming,
  startedAt,
  durationMs,
  isRedacted,
  aborted,
  blockKey,
}: ThinkingCardProps) {
  // Live elapsed counter while streaming. Re-renders every 500ms.
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!isStreaming || !startedAt) return;
    setElapsedMs(Date.now() - startedAt);
    const id = setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 500);
    return () => clearInterval(id);
  }, [isStreaming, startedAt]);

  // Persisted expand state. Stable key prefers the explicit blockKey, falls
  // back to startedAt timestamp. Redacted blocks never expand so they don't
  // need this — but consuming the hook unconditionally keeps the order of
  // hook calls stable across renders.
  const persistedKey = useMemo(() => {
    if (blockKey) return `thinking:${blockKey}`;
    if (startedAt) return `thinking:${startedAt}`;
    return 'thinking:unknown';
  }, [blockKey, startedAt]);
  const { expanded, setExpanded } = useExpandedBlockMemory(persistedKey);

  const onToggle = useCallback(() => {
    setExpanded((v) => !v);
  }, [setExpanded]);

  // ── Redacted variant ─────────────────────────────────────────────────
  if (isRedacted) {
    return (
      <div className="flex w-full justify-start">
        <div className="w-full">
          {/* select-none:另两个变体的 header 是 <button> 天然禁选,redacted 分支
              是纯 div,需显式对齐,避免状态短语可被划选 */}
          <div className="flex select-none items-center gap-1.5 px-2 py-0.5">
            <span className="inline-flex h-[1lh] items-center shrink-0">
              <Sparkles
                size={14}
                className="text-[var(--msg-tool-card-chevron)]"
              />
            </span>
            <span className="text-14 italic text-[var(--msg-tool-card-chevron)] opacity-90 translate-y-[1px]">
              Thinking hidden
            </span>
            <div className="flex-1" />
            <Lock
              size={14}
              className="shrink-0 text-[var(--msg-tool-card-chevron)] opacity-75"
            />
          </div>
        </div>
      </div>
    );
  }

  // ── In-progress variant ──────────────────────────────────────────────
  // Default collapsed (F8). Header shows sparkles + "Thinking" + animated
  // dots + live duration. Body only renders when the user expands.
  if (isStreaming) {
    return (
      <div className="flex w-full justify-start">
        <div className="w-full">
          <button
            type="button"
            onClick={onToggle}
            className={cn(
              'flex w-full items-center gap-1.5 px-2 py-0.5',
              'select-none cursor-pointer',
              ACTIVITY_ROW_RADIUS_CLASS,
              ACTIVITY_ROW_HOVER_SURFACE_CLASS,
              ACTIVITY_ROW_COLOR_TRANSITION_CLASS,
              CHAT_FOCUS_CLASS,
              'text-left',
            )}
            aria-expanded={expanded}
          >
            <span className="inline-flex h-[1lh] items-center shrink-0">
              <Sparkles
                size={14}
                className="text-[var(--msg-tool-card-chevron)]"
              />
            </span>
            <span className="text-14 text-[var(--msg-tool-card-chevron)] translate-y-[1px]">
              Thinking
            </span>
            <div className="flex items-center gap-[3px] translate-y-[2px]">
              <span className="thinking-dot thinking-dot-1" />
              <span className="thinking-dot thinking-dot-2" />
              <span className="thinking-dot thinking-dot-3" />
            </div>
            <div className="flex-1" />
            <span className="font-mono text-12 text-[var(--msg-tool-card-chevron)]">
              {formatDuration(elapsedMs)}
            </span>
            <ChevronRight
              size={14}
              className={cn(
                'shrink-0 text-[var(--msg-tool-card-chevron)]',
                CHAT_CHEVRON_TRANSITION_CLASS,
                expanded && 'rotate-90',
              )}
            />
          </button>

          <Collapse open={expanded}>
            <BodyRail>
              {content ? (
                <p className="whitespace-pre-wrap italic text-14 leading-[1.6] text-[var(--thinking-body-text)]">
                  <ThinkingText content={content} />
                </p>
              ) : (
                <p className="italic text-14 leading-[1.6] text-[var(--thinking-body-text)] opacity-70">
                  (no thinking content captured yet)
                </p>
              )}
            </BodyRail>
          </Collapse>
        </div>
      </div>
    );
  }

  // ── Final / aborted variant ───────────────────────────────────────────
  // aborted 是 Codex 专属(turn_aborted 时 reasoning 提前结束),Claude 不传。
  const summary = aborted
    ? `Thought for ${formatDuration(durationMs ?? 0)} (aborted)`
    : `Thought for ${formatDuration(durationMs ?? 0)}`;
  return (
    <div className="flex w-full justify-start">
      <div className="w-full">
        <button
          type="button"
          onClick={onToggle}
          className={cn(
            'flex w-full items-center gap-1.5 px-2 py-0.5',
            'select-none cursor-pointer',
            ACTIVITY_ROW_RADIUS_CLASS,
            ACTIVITY_ROW_HOVER_SURFACE_CLASS,
            ACTIVITY_ROW_COLOR_TRANSITION_CLASS,
            CHAT_FOCUS_CLASS,
            'text-left',
          )}
          aria-expanded={expanded}
        >
          <span className="inline-flex h-[1lh] items-center shrink-0">
            <Sparkles
              size={14}
              className="text-[var(--msg-tool-card-chevron)]"
            />
          </span>
          <span className="text-14 text-[var(--msg-tool-card-chevron)] translate-y-[1px]">
            {summary}
          </span>
          <div className="flex-1" />
          <ChevronRight
            size={14}
            className={cn(
              'shrink-0 text-[var(--msg-tool-card-chevron)]',
              CHAT_CHEVRON_TRANSITION_CLASS,
              expanded && 'rotate-90',
            )}
          />
        </button>

        <Collapse open={expanded}>
          <BodyRail>
            {content ? (
              <p className="whitespace-pre-wrap italic text-14 leading-[1.6] text-[var(--thinking-body-text)]">
                <ThinkingText content={content} />
              </p>
            ) : (
              <p className="italic text-14 leading-[1.6] text-[var(--thinking-body-text)] opacity-70">
                (no thinking content captured)
              </p>
            )}
          </BodyRail>
        </Collapse>
      </div>
    </div>
  );
}
