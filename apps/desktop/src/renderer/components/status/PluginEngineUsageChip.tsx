import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GhostHarnessUsage } from '@cindy/plugin-protocol';
import {
  clampPluginQuotaPercent,
  effectivePluginWindowMinutes,
  formatPluginQuotaPercent,
  selectPluginWindowsForModel,
  type PluginQuotaModelRef,
} from '@cindy/maker-shared/plugin-engine-quota';
import { quotaLevelFromRemaining, type QuotaLevel } from '@cindy/maker-shared/quota-level';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { readPluginEngineUsage } from '@/hooks/pluginEngineUsage';
import { formatCompactTimeUntilReset } from '@/lib/compactQuotaCountdown';
import { handOffTabFromCard } from '@/lib/focusTraversal';
import {
  registerStatusBarCard,
  STATUS_CARD_HOVER_CLOSE_GRACE_MS,
  STATUS_CARD_HOVER_OPEN_DELAY_MS,
  type StatusBarCardHandle,
} from '@/lib/statusBarCards';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { QUOTA_TEXT_COLOR_CLASSES } from './QuotaBar';
import { QuotaHoverCard } from './QuotaHoverCard';
import { QuotaResetConfetti } from './QuotaResetConfetti';
import { quotaFullCelebrations } from './quotaFullCelebrations';
import {
  computeCountdownTickDelayMs,
  RESET_PENDING_MAX_MS,
  useQuotaResetRollup,
  type ChipWindowSlot,
} from './quotaResetRollup';
import {
  formatPluginWindowFallbackLabel,
  pluginEngineUsageAccount,
  pluginEngineUsageBalances,
} from './pluginEngineUsageAccount';

const REMAINING_PLACEHOLDER = '__REMAINING__';

interface PluginChipWindowSegment extends ChipWindowSlot {
  label: string;
  resetPending: boolean;
  level: QuotaLevel;
}

function isResetPending(resetsAtMs: number | null, nowMs: number): boolean {
  return (
    typeof resetsAtMs === 'number' &&
    resetsAtMs <= nowMs &&
    nowMs - resetsAtMs < RESET_PENDING_MAX_MS
  );
}

function interpolateRemaining(text: string, remaining: React.ReactNode): React.ReactNode {
  const index = text.indexOf(REMAINING_PLACEHOLDER);
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      {remaining}
      {text.slice(index + REMAINING_PLACEHOLDER.length)}
    </>
  );
}

function renderSegmentedLabel(segments: React.ReactNode[]): React.ReactNode {
  return segments.map((seg, i) => (
    <React.Fragment key={i}>
      {i > 0 && (
        <span aria-hidden="true" className="mx-2 inline-block h-3 w-px bg-current opacity-30" />
      )}
      <span className="tabular-nums">{seg}</span>
    </React.Fragment>
  ));
}

/**
 * Task status-bar quota chip for plugin engines, visually and behaviorally aligned with
 * `TodaySpendChip` (compact countdown + "剩余 XX%", vertical dividers, per-percent alert tint,
 * minute/second boundary ticks, reset-pending ellipsis, reset rollup/confetti, and shared
 * status-bar hover card exclusivity).
 *
 * Mounted only for the visible task. Its React key includes the account device and engine.
 */
export function PluginEngineUsageChip({
  engineKey,
  name,
  deviceId,
  running,
  sessionId,
  hosted = false,
  modelId,
  modelName,
}: {
  engineKey: string;
  name?: string;
  deviceId: string | null;
  running: boolean;
  /** Original task id. A borrowed engine namespaces it by the calling computer. */
  sessionId?: string;
  hosted?: boolean;
  /** Active (or next-message) model id, used to pick the matching quota window group. */
  modelId?: string | null;
  /** Display name of `modelId`, used when the plugin did not attach `models[]` to windows. */
  modelName?: string | null;
}) {
  const { t, i18n } = useTranslation();
  const [usage, setUsage] = useState<GhostHarnessUsage | null>(null);
  const [now, setNow] = useState(Date.now);
  const refresh = useRef<() => void>(() => {});

  useEffect(() => {
    const owner = getDataOwnerGeneration();
    let active = true;
    let pending = false;
    let nextRead = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      if (!active || document.hidden || pending || !isDataOwnerGenerationCurrent(owner)) return;
      clearTimeout(timer);
      const delay = nextRead - Date.now();
      if (delay > 0) {
        timer = setTimeout(check, delay);
        return;
      }
      pending = true;
      const read = readPluginEngineUsage(owner, deviceId, engineKey, sessionId, hosted);
      const snapshot = await read.result;
      nextRead = read.freshUntil;
      pending = false;
      if (!active || !isDataOwnerGenerationCurrent(owner)) return;
      setNow(Date.now());
      setUsage(snapshot);
      // One read after the nearest reset. An already elapsed window waits for a new user event.
      const resets =
        snapshot?.windows?.flatMap((row) =>
          row.resetsAt && row.resetsAt > Date.now() ? [row.resetsAt] : [],
        ) ?? [];
      if (resets.length) {
        timer = setTimeout(
          check,
          Math.min(2_147_483_647, Math.max(nextRead, Math.min(...resets)) - Date.now() + 1),
        );
      }
    };
    refresh.current = check;
    void check();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      active = false;
      clearTimeout(timer);
      refresh.current = () => {};
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [engineKey, deviceId, sessionId, hosted]);

  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) refresh.current();
    wasRunning.current = running;
  }, [running]);

  const modelRef = useMemo<PluginQuotaModelRef | null>(
    () => (modelId || modelName ? { id: modelId ?? null, displayName: modelName ?? null } : null),
    [modelId, modelName],
  );

  // Align with TodaySpendChip: select this model's applicable windows in shortest-to-longest order
  // (e.g. 5h | weekly), retaining windows inside the reset-pending grace period.
  const chipWindows = useMemo<PluginChipWindowSegment[]>(() => {
    if (!usage?.windows?.length) return [];
    const selected = selectPluginWindowsForModel(usage.windows, modelRef, now, {
      strictModelMatch: false,
      includeExpired: true,
    });
    const activeOrPending = selected.windows.filter((row) => {
      if (row.resetsAt === undefined || !Number.isFinite(row.resetsAt)) return true;
      return row.resetsAt > now || isResetPending(row.resetsAt, now);
    });
    return activeOrPending.slice(0, 3).map((row) => {
      const minutes = effectivePluginWindowMinutes(row);
      const resetsAtMs =
        typeof row.resetsAt === 'number' && Number.isFinite(row.resetsAt) && row.resetsAt > 0
          ? row.resetsAt
          : null;
      const countdown = formatCompactTimeUntilReset(
        resetsAtMs !== null ? resetsAtMs / 1000 : null,
        now,
        t,
        minutes,
      );
      const remainingPercent = clampPluginQuotaPercent(row.remainingPercent);
      return {
        key: JSON.stringify([engineKey, row.label, minutes ?? 'na']),
        label: countdown ?? formatPluginWindowFallbackLabel(row, t),
        remainingPercent,
        resetsAtMs,
        resetPending: isResetPending(resetsAtMs, now),
        level: quotaLevelFromRemaining(remainingPercent),
      };
    });
  }, [usage, modelRef, now, engineKey, t]);

  const windowSlotA = chipWindows[0] ?? null;
  const windowSlotB = chipWindows[1] ?? null;
  const windowSlotC = chipWindows[2] ?? null;
  const rollupA = useQuotaResetRollup(windowSlotA);
  const rollupB = useQuotaResetRollup(windowSlotB);
  const rollupC = useQuotaResetRollup(windowSlotC);

  // Popover state & status-bar exclusivity, matching TodaySpendChip verbatim.
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverPortalHost, setPopoverPortalHost] = useState<HTMLDivElement | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const pointerInsideRef = useRef(false);
  const focusInsideRef = useRef(false);
  const openSourceRef = useRef<'hover' | 'focus' | null>(null);
  const focusTakenRef = useRef(false);
  const restoringFocusRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const statusCardHandleRef = useRef<StatusBarCardHandle | null>(null);

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current === null) return;
    window.clearTimeout(openTimerRef.current);
    openTimerRef.current = null;
  }, []);
  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);
  const keepOpen = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
  }, [clearCloseTimer, clearOpenTimer]);
  const restoreFocus = useCallback(() => {
    const shouldRestore = focusTakenRef.current;
    focusTakenRef.current = false;
    openSourceRef.current = null;
    if (!shouldRestore) return;
    const activeElement = document.activeElement;
    const focusStillOwned =
      triggerRef.current === activeElement || contentRef.current?.contains(activeElement) === true;
    const focusLostOrDetached =
      activeElement === null || activeElement === document.body || !activeElement.isConnected;
    if (!focusStillOwned && !focusLostOrDetached) return;
    restoringFocusRef.current = true;
    triggerRef.current?.focus({ preventScroll: true });
    restoringFocusRef.current = false;
  }, []);
  const openImmediately = useCallback(() => {
    keepOpen();
    openSourceRef.current = 'focus';
    setNow(Date.now());
    setPopoverOpen(true);
    refresh.current();
  }, [keepOpen]);
  const closeImmediately = useCallback(() => {
    keepOpen();
    setPopoverOpen(false);
    restoreFocus();
  }, [keepOpen, restoreFocus]);
  const scheduleOpen = useCallback(() => {
    clearCloseTimer();
    clearOpenTimer();
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      openSourceRef.current = 'hover';
      setNow(Date.now());
      setPopoverOpen(true);
      refresh.current();
    }, STATUS_CARD_HOVER_OPEN_DELAY_MS);
  }, [clearCloseTimer, clearOpenTimer]);
  const scheduleClose = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setPopoverOpen(false);
      restoreFocus();
    }, STATUS_CARD_HOVER_CLOSE_GRACE_MS);
  }, [clearCloseTimer, clearOpenTimer, restoreFocus]);

  useEffect(() => {
    const handle = registerStatusBarCard('quota', () => {
      keepOpen();
      setPopoverOpen(false);
      restoreFocus();
    });
    statusCardHandleRef.current = handle;
    return () => {
      statusCardHandleRef.current = null;
      handle.unregister();
    };
  }, [keepOpen, restoreFocus]);
  useEffect(() => {
    if (!popoverOpen) {
      statusCardHandleRef.current?.release();
      return;
    }
    statusCardHandleRef.current?.request();
  }, [popoverOpen]);

  const contextIdentity = JSON.stringify([sessionId ?? null, engineKey, deviceId ?? null, modelId ?? null]);
  const prevContextRef = useRef(contextIdentity);
  useLayoutEffect(() => {
    if (prevContextRef.current === contextIdentity) return;
    prevContextRef.current = contextIdentity;
    pointerInsideRef.current = false;
    focusInsideRef.current = false;
    closeImmediately();
  }, [closeImmediately, contextIdentity]);

  useEffect(
    () => () => {
      clearOpenTimer();
      clearCloseTimer();
    },
    [clearCloseTimer, clearOpenTimer],
  );

  // Minute / final-minute second tick cadence aligned with TodaySpendChip.
  const resetsAtSignature = chipWindows.map((window) => window.resetsAtMs ?? 'na').join(',');
  const chipResetsAtMsList = useMemo(
    () =>
      resetsAtSignature === ''
        ? []
        : resetsAtSignature.split(',').map((value) => (value === 'na' ? null : Number(value))),
    [resetsAtSignature],
  );
  useEffect(() => {
    if (chipResetsAtMsList.length === 0 && !popoverOpen) return undefined;
    const delay = computeCountdownTickDelayMs(chipResetsAtMsList, Date.now());
    const timer = window.setTimeout(() => {
      if (!document.hidden) setNow(Date.now());
    }, delay);
    return () => window.clearTimeout(timer);
  }, [chipResetsAtMsList, popoverOpen, now]);

  // Nudge refresh while any window is inside the reset-pending window.
  const hasPendingResetWindow = chipWindows.some((window) => window.resetPending);
  useEffect(() => {
    if (!hasPendingResetWindow) return;
    refresh.current();
  }, [hasPendingResetWindow, now]);

  // Confetti burst on full recovery, matching TodaySpendChip.
  const chipRef = useRef<HTMLDivElement | null>(null);
  const segmentElsRef = useRef<Record<string, HTMLSpanElement | null>>({});
  const celebrationProvider = JSON.stringify([deviceId ?? 'local', engineKey]);
  const [confettiBurst, setConfettiBurst] = useState<{ nonce: number; anchor: HTMLElement } | null>(
    null,
  );
  useEffect(() => {
    if (!chipRef.current || chipWindows.length === 0) return;
    const key = quotaFullCelebrations.observe(
      celebrationProvider,
      chipWindows,
      usage?.updatedAt ?? null,
    );
    if (
      key === null ||
      (typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    ) {
      return;
    }
    const anchor = segmentElsRef.current[key] ?? chipRef.current;
    setConfettiBurst((prev) => ({ nonce: (prev?.nonce ?? 0) + 1, anchor }));
  });

  if (!usage) return null;

  const balances = pluginEngineUsageBalances(usage, i18n.language, t);
  const windowSegments: React.ReactNode[] = chipWindows.map((window, index) => {
    if (window.resetPending) {
      return (
        <React.Fragment key={window.key}>
          {t('todaySpend.resetPendingSegment', { label: window.label, defaultValue: '{{label}}' })}
          <span className="motion-safe:animate-pulse">…</span>
        </React.Fragment>
      );
    }
    const rollup = index === 0 ? rollupA : index === 1 ? rollupB : rollupC;
    const text = t('todaySpend.claude.windowSegment', {
      label: window.label,
      remaining: REMAINING_PLACEHOLDER,
      defaultValue: '{{label}} {{remaining}}',
    });
    const remaining = formatPluginQuotaPercent(rollup?.percent ?? window.remainingPercent);
    return (
      <span
        key={window.key}
        ref={(el) => {
          segmentElsRef.current[window.key] = el;
        }}
      >
        {interpolateRemaining(
          text,
          window.level !== 'normal' ? (
            <span className={QUOTA_TEXT_COLOR_CLASSES[window.level]}>{remaining}</span>
          ) : (
            remaining
          ),
        )}
      </span>
    );
  });

  const balanceSegments: React.ReactNode[] =
    windowSegments.length === 0 && balances.length > 0
      ? [
          <span
            key="balance"
            className={
              usage.balances?.[0] && Number(usage.balances[0].amount) <= 0
                ? QUOTA_TEXT_COLOR_CLASSES.crit
                : undefined
            }
          >
            {balances[0]}
          </span>,
        ]
      : [];
  const chipSegments =
    windowSegments.length > 0
      ? windowSegments
      : balanceSegments.length > 0
        ? balanceSegments
        : [t('quotaCard.resetPending')];

  const title = name || t('quotaCard.usageTitle');
  const account = pluginEngineUsageAccount(usage, {
    title,
    now,
    language: i18n.language,
    t,
    model: modelRef,
  });

  const buttonClass = cn(
    'inline-flex h-5 shrink-0 items-center',
    'text-12 font-medium leading-none tabular-nums',
    'text-[var(--msg-tool-card-chevron)] hover:text-foreground',
    'border-0 bg-transparent p-0 m-0',
    'transition-colors',
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] rounded-full',
  );

  return (
    <div ref={chipRef} className="inline-flex h-5 shrink-0 items-center gap-3">
      <Popover
        open={popoverOpen}
        onOpenChange={(open) => {
          if (!open) closeImmediately();
        }}
        modal={false}
      >
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            onClick={(event) => {
              event.preventDefault();
              openImmediately();
            }}
            onMouseEnter={() => {
              pointerInsideRef.current = true;
              scheduleOpen();
            }}
            onMouseLeave={() => {
              pointerInsideRef.current = false;
              if (!focusInsideRef.current) scheduleClose();
            }}
            onFocus={() => {
              if (restoringFocusRef.current) return;
              focusInsideRef.current = true;
              openImmediately();
            }}
            onBlur={() => {
              focusInsideRef.current = false;
              scheduleClose();
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              closeImmediately();
            }}
            className={buttonClass}
            aria-label={t('quotaCard.usageTitle')}
            data-testid="task-usage-trigger"
          >
            {renderSegmentedLabel(chipSegments)}
          </button>
        </PopoverTrigger>
        <div ref={setPopoverPortalHost} className="contents" />
        <PopoverContent
          ref={contentRef}
          portalContainer={popoverPortalHost}
          onKeyDownCapture={(event) => {
            if (event.key !== 'Tab') return;
            const cardRoot = event.currentTarget;
            if (!(cardRoot instanceof HTMLElement)) return;
            if (handOffTabFromCard(cardRoot, event)) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (openSourceRef.current !== 'focus') return;
            const focusTarget = contentRef.current?.querySelector<HTMLElement>('[role=region]');
            focusTarget?.focus({ preventScroll: true });
            focusTakenRef.current = Boolean(focusTarget && document.activeElement === focusTarget);
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocus();
          }}
          onEscapeKeyDown={closeImmediately}
          onMouseEnter={() => {
            pointerInsideRef.current = true;
            keepOpen();
          }}
          onMouseLeave={() => {
            pointerInsideRef.current = false;
            if (!focusInsideRef.current) scheduleClose();
          }}
          onFocusCapture={() => {
            focusInsideRef.current = true;
            focusTakenRef.current = true;
            keepOpen();
          }}
          onBlurCapture={(event) => {
            const nextTarget = event.relatedTarget;
            if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
            if (restoringFocusRef.current) return;
            focusInsideRef.current = false;
            focusTakenRef.current = false;
            openSourceRef.current = null;
            scheduleClose();
          }}
          className="w-auto max-w-[calc(100vw-16px)] border-0 bg-transparent p-0 shadow-none"
        >
          <QuotaHoverCard account={account} nowMs={now} />
        </PopoverContent>
      </Popover>
      {confettiBurst && (
        <QuotaResetConfetti
          key={confettiBurst.nonce}
          anchor={confettiBurst.anchor}
          onDone={() => setConfettiBurst(null)}
        />
      )}
    </div>
  );
}
