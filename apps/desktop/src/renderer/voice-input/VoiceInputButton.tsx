import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { Mic } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { VoiceInputState } from '@cindy/voice-input-core';

import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { ComposerRecordingBars, type RecordingSamplesRef } from './ComposerRecordingBars';
import { useVoiceProcessingIndicator } from './useVoiceProcessingIndicator';

export const VOICE_INPUT_LONG_PRESS_MS = 450;

function isPointInsideElement(
  element: HTMLElement | null,
  clientX: number,
  clientY: number,
  padding = 0,
): boolean {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return (
    clientX >= rect.left - padding &&
    clientX <= rect.right + padding &&
    clientY >= rect.top - padding &&
    clientY <= rect.bottom + padding
  );
}

export interface VoiceInputButtonProps {
  /** Real-time 16 kHz PCM sink driving the three level bars while listening. */
  samplesRef?: RecordingSamplesRef;
  state: VoiceInputState;
  disabled?: boolean;
  /** Formatted shortcut shown in the idle hover tooltip (e.g. "⌥Space"). */
  shortcutLabel?: string;
  /** When true, the idle listening hint prompts the user to speak. */
  emptyComposer?: boolean;
  /** True while microphone startup is still connecting before capture is ready. */
  starting?: boolean;
  onStart: () => boolean | Promise<boolean | void> | void;
  onStop: () => Promise<void> | void;
  onHoldChange?: (holding: boolean) => void;
  /** Optional drag-to-send target when a Send button sits beside this control. */
  onStopAndSend?: () => Promise<void> | void;
  sendTargetRef?: RefObject<HTMLElement | null>;
  canReleaseToSend?: boolean;
  releaseToSendActive?: boolean;
  onReleaseToSendChange?: (active: boolean) => void;
  /** Stop pointer/click propagation when nested inside clickable rows. */
  stopPropagation?: boolean;
  /** Optional custom accessible label override. */
  ariaLabel?: string;
  tipSide?: 'top' | 'right' | 'bottom' | 'left';
  testId?: string;
  className?: string;
}

/**
 * Canonical Desktop voice dictation button (DESIGN.md §14.4「Desktop composer send / stop」).
 *
 * Shared by the main task composer (ChatInput) and every other voice-enabled input
 * across the app so appearance, motion, live microphone level bars, recording timer,
 * delayed processing spinner, tooltips and hold-to-speak gestures stay 100% uniform.
 */
export function VoiceInputButton({
  samplesRef,
  state,
  onHoldChange,
  emptyComposer = false,
  disabled = false,
  starting = false,
  shortcutLabel = '',
  onStart,
  onStop,
  onStopAndSend,
  sendTargetRef,
  canReleaseToSend = false,
  releaseToSendActive = false,
  onReleaseToSendChange,
  stopPropagation = false,
  ariaLabel,
  tipSide = 'top',
  testId,
  className,
}: VoiceInputButtonProps) {
  const { t } = useTranslation();
  const [longPressActive, setLongPressActive] = useState(false);
  useEffect(() => {
    onHoldChange?.(longPressActive);
    return () => onHoldChange?.(false);
  }, [longPressActive, onHoldChange]);

  const timerRef = useRef<number | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const lastPointerPointRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const longPressStartedRef = useRef(false);
  const pointerStartedRecordingRef = useRef(false);
  const suppressNextClickRef = useRef(false);
  const suppressClickTimerRef = useRef<number | null>(null);
  const releaseToSendActiveRef = useRef(false);

  const listening = state === 'listening';
  const refining = state === 'refining';
  const busy = state === 'submitting' || state === 'refining';
  const showProcessing = useVoiceProcessingIndicator(state);
  const stopping = busy && !showProcessing;
  const activeRecording = listening || longPressActive;
  const disabledOrBusy = disabled || busy;

  // ── 录音态宽度形变 + 计时 (DESIGN.md §14.4) ──
  // 仅录音中展开: 三根实时录音音量条 + tabular-nums 计时。
  // 分钟位数变化才重新量宽, 秒跳动不抖框。
  const [recSeconds, setRecSeconds] = useState(0);
  const pillLabelRef = useRef<HTMLSpanElement>(null);
  const [pillWidth, setPillWidth] = useState<number | null>(null);
  const expanded = activeRecording || stopping;
  const minuteDigits = String(Math.floor(recSeconds / 60)).length;

  useEffect(() => {
    if (!activeRecording) return;
    setRecSeconds(0);
    const id = window.setInterval(() => setRecSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [activeRecording]);

  useLayoutEffect(() => {
    if (!expanded) {
      setPillWidth(null);
      return;
    }
    // 28px 图标位 + 标签实测宽(含右 padding) + 2px 余量
    const measured = pillLabelRef.current?.scrollWidth ?? 0;
    setPillWidth(measured > 0 ? 28 + measured + 2 : null);
  }, [expanded, activeRecording, minuteDigits]);

  const recTimeText = `${Math.floor(recSeconds / 60)}:${String(recSeconds % 60).padStart(2, '0')}`;
  const pillTransition =
    'width var(--motion-base) var(--motion-ease-move), background-color var(--motion-fast) var(--motion-ease-out), color var(--motion-fast) var(--motion-ease-out), border-color var(--motion-fast) var(--motion-ease-out)';
  const iconLayer =
    'col-start-1 row-start-1 flex items-center justify-center transition-[opacity,transform] duration-[var(--motion-fast)] ease-[var(--motion-ease-out)] motion-reduce:transform-none';
  const iconShown = 'scale-100 opacity-100';
  const iconHidden = 'scale-[0.55] opacity-0';
  const showBars = (activeRecording || stopping) && !showProcessing;
  const showSpinner = showProcessing;

  let label = t('newChat.chatInput.voiceInput.start');
  if (longPressActive) {
    label = t('newChat.chatInput.voiceInput.releaseToStop');
  } else if (refining) {
    label = t('newChat.chatInput.voiceInput.refining');
  } else if (state === 'submitting') {
    label = t('voiceInputOverlay.status.submitting');
  } else if (activeRecording) {
    label = t('newChat.chatInput.voiceInput.stop');
  }
  const effectiveAriaLabel = ariaLabel ?? label;
  const hintLabel =
    emptyComposer && activeRecording
      ? t(
          longPressActive
            ? 'newChat.chatInput.voiceInput.speakRelease'
            : 'newChat.chatInput.voiceInput.speakPressAgain',
        )
      : label;
  const tooltipText =
    shortcutLabel && !activeRecording && !busy ? `${hintLabel} · ${shortcutLabel}` : hintLabel;
  const controlledTooltipOpen = busy
    ? showProcessing
    : longPressActive
      ? !releaseToSendActive
      : undefined;

  const clearLongPressTimer = useCallback(() => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const clearSuppressClickTimer = useCallback(() => {
    if (suppressClickTimerRef.current === null) return;
    window.clearTimeout(suppressClickTimerRef.current);
    suppressClickTimerRef.current = null;
  }, []);

  const clearSuppressNextClick = useCallback(() => {
    clearSuppressClickTimer();
    suppressNextClickRef.current = false;
  }, [clearSuppressClickTimer]);

  const armSuppressNextClick = useCallback(() => {
    clearSuppressClickTimer();
    suppressNextClickRef.current = true;
    suppressClickTimerRef.current = window.setTimeout(() => {
      suppressNextClickRef.current = false;
      suppressClickTimerRef.current = null;
    }, 250);
  }, [clearSuppressClickTimer]);

  const setReleaseToSendActive = useCallback(
    (active: boolean) => {
      if (releaseToSendActiveRef.current === active) return;
      releaseToSendActiveRef.current = active;
      onReleaseToSendChange?.(active);
    },
    [onReleaseToSendChange],
  );

  const canDragToSend = Boolean(canReleaseToSend && onStopAndSend && sendTargetRef);

  const updateReleaseToSendTarget = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      lastPointerPointRef.current = { clientX: event.clientX, clientY: event.clientY };
      if (!longPressStartedRef.current) return;
      setReleaseToSendActive(
        canDragToSend &&
          isPointInsideElement(sendTargetRef?.current ?? null, event.clientX, event.clientY, 10),
      );
    },
    [canDragToSend, sendTargetRef, setReleaseToSendActive],
  );

  useEffect(() => {
    if (!longPressActive) {
      setReleaseToSendActive(false);
      return;
    }
    const point = lastPointerPointRef.current;
    if (!point) return;
    setReleaseToSendActive(
      canDragToSend &&
        isPointInsideElement(sendTargetRef?.current ?? null, point.clientX, point.clientY, 10),
    );
  }, [canDragToSend, longPressActive, sendTargetRef, setReleaseToSendActive]);

  const finishLongPress = useCallback(
    (send: boolean, cancelStartedRecording = false) => {
      clearLongPressTimer();
      pointerIdRef.current = null;
      const longPressStarted = longPressStartedRef.current;
      longPressStartedRef.current = false;
      const pointerStartedRecording = pointerStartedRecordingRef.current;
      pointerStartedRecordingRef.current = false;
      if (pointerStartedRecording) {
        armSuppressNextClick();
      }
      if (!longPressStarted) {
        if (cancelStartedRecording && pointerStartedRecording) {
          void onStop();
        }
        return;
      }
      setLongPressActive(false);
      setReleaseToSendActive(false);
      void (send && onStopAndSend ? onStopAndSend() : onStop());
    },
    [armSuppressNextClick, clearLongPressTimer, onStop, onStopAndSend, setReleaseToSendActive],
  );

  useEffect(() => {
    return () => {
      clearLongPressTimer();
      clearSuppressNextClick();
      longPressStartedRef.current = false;
      pointerStartedRecordingRef.current = false;
      setReleaseToSendActive(false);
    };
  }, [clearLongPressTimer, clearSuppressNextClick, setReleaseToSendActive]);

  return (
    <Tip
      text={tooltipText}
      side={tipSide}
      controlledOpen={controlledTooltipOpen}
      resetHoverOnControlChange
      contentClassName="data-[state=closed]:hidden"
    >
      <button
        type="button"
        data-testid={testId}
        data-voice-input-button=""
        className={cn(
          'flex shrink-0 items-center rounded-full',
          // 语音按钮: 常驻外框 + 录音展开(三根音量条 + 计时)。全应用所有输入框共用同一规格。
          'h-[30px] justify-start overflow-hidden p-0',
          'bg-[var(--composer-pill-bg)] border border-[var(--border-default)] text-[var(--composer-pill-icon)]',
          'hover:bg-[var(--model-trigger-hover)]',
          (activeRecording || stopping) &&
            'bg-[var(--surface-chip)] text-[var(--text-primary)] hover:bg-[var(--surface-chip)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
          disabledOrBusy && 'cursor-not-allowed',
          // Busy (stopping / refining) keeps full strength so the transition and the
          // spinner stay readable; only a truly unavailable control dims.
          disabled && 'opacity-40',
          className,
        )}
        style={{ width: pillWidth ?? (expanded ? undefined : 30), minWidth: 30, transition: pillTransition }}
        disabled={disabledOrBusy}
        aria-label={effectiveAriaLabel}
        aria-pressed={activeRecording}
        aria-busy={starting || busy}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          if (stopPropagation) event.stopPropagation();
          // A fresh press is never the synthetic click from the previous hold.
          clearSuppressNextClick();
          event.preventDefault();
          event.currentTarget.blur();
          if (disabledOrBusy || listening) return;
          const started = onStart();
          if (started === false) return;
          pointerIdRef.current = event.pointerId;
          lastPointerPointRef.current = { clientX: event.clientX, clientY: event.clientY };
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // Synthetic pointer events in tests may not support pointer capture.
          }
          clearLongPressTimer();
          longPressStartedRef.current = false;
          pointerStartedRecordingRef.current = true;
          setReleaseToSendActive(false);
          timerRef.current = window.setTimeout(() => {
            timerRef.current = null;
            longPressStartedRef.current = true;
            setLongPressActive(true);
          }, VOICE_INPUT_LONG_PRESS_MS);
        }}
        onPointerMove={updateReleaseToSendTarget}
        onPointerUp={(event) => {
          if (pointerIdRef.current !== event.pointerId) return;
          updateReleaseToSendTarget(event);
          const shouldSend =
            canDragToSend &&
            isPointInsideElement(sendTargetRef?.current ?? null, event.clientX, event.clientY, 10);
          if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          finishLongPress(shouldSend);
        }}
        onPointerCancel={() => finishLongPress(false, true)}
        onClick={(event) => {
          if (stopPropagation) event.stopPropagation();
          if (suppressNextClickRef.current) {
            clearSuppressNextClick();
            return;
          }
          void (listening ? onStop() : onStart());
        }}
      >
        {/* 28px 图标位: idle 麦克风 / 录音音量条 / 停止后处理 spinner。三层常驻、交叉淡入。 */}
        <span className="grid h-[28px] w-[28px] shrink-0 place-items-center" aria-hidden>
          <span className={cn(iconLayer, !showBars && !showSpinner ? iconShown : iconHidden)}>
            <Mic size={15} />
          </span>
          <span className={cn(iconLayer, 'h-4 gap-0.5', showBars ? iconShown : iconHidden)}>
            <ComposerRecordingBars samplesRef={listening ? samplesRef : undefined} />
          </span>
          <span className={cn(iconLayer, showSpinner ? iconShown : iconHidden)}>
            <Spinner size={15} spinning={showSpinner} />
          </span>
        </span>
        {/* 录音计时(tabular-nums 等宽, 秒跳不抖框); 非录音态无标签, 按钮保持圆形 */}
        <span
          ref={pillLabelRef}
          className={cn(
            'whitespace-nowrap pr-3 text-12 tabular-nums',
            '-translate-x-1 opacity-0 transition-[opacity,transform] duration-[var(--motion-fast)] ease-[var(--motion-ease-out)]',
            expanded && 'translate-x-0 opacity-100',
            'motion-reduce:transition-none',
          )}
        >
          {activeRecording || stopping ? recTimeText : ''}
        </span>
      </button>
    </Tip>
  );
}
