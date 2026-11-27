import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';

import { getTextPreviewHost } from '@/components/find-in-page/findInPageOwnership';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { getVoiceInputSettings, useVoiceInputSettings } from '@/hooks/useVoiceInputSettings';
import {
  createComposerLongPressVoiceGesture,
  isComposerLongPressVoiceReady,
} from './composerLongPressGesture';
import type { RecordingSamplesRef } from './ComposerRecordingBars';
import { isVoiceInputEventScopeActive } from './eventScope';
import {
  formatVoiceInputShortcut,
  isVoiceInputShortcutMatch,
  isVoiceInputShortcutRelease,
  type VoiceInputShortcut,
} from './shortcut';
import { playVoiceInputEndCue, playVoiceInputStartCue, prepareVoiceInputCues } from './startCue';
import { useVoiceInput, type VoiceInputTextTarget } from './useVoiceInput';
import { useVoiceMicrophonePermissionPrompt } from './useVoiceMicrophonePermissionPrompt';
import { VOICE_INPUT_LONG_PRESS_MS, type VoiceInputButtonProps } from './VoiceInputButton';

/** Minimal imperative surface shared by `<textarea>`, `<input>`, and rich textarea wrappers. */
export type FieldVoiceInputElement = {
  selectionStart: number | null;
  selectionEnd: number | null;
  setSelectionRange: (start: number, end: number) => void;
  focus: () => void;
  readOnly?: boolean;
};

export type FieldVoiceEdit = {
  start: number;
  end: number;
  caret: number;
};

export interface UseFieldVoiceInputOptions<T extends FieldVoiceInputElement = HTMLTextAreaElement> {
  /** Identifies the logical draft; changing it while dictating cancels the stale run. */
  draftKey?: string;
  /** Change when the underlying input DOM node remounts for the same logical draft (e.g. expand/collapse). */
  inputElementKey?: string | number | boolean;
  inputRef: RefObject<T | null>;
  /** Resolve the underlying DOM node when `inputRef.current` is an imperative handle. */
  getDomElement?: (input: T | null) => HTMLElement | null;
  value: string;
  onChange: (value: string, edit: FieldVoiceEdit) => void;
  disabled?: boolean;
  /** Pass `open` / `isEditing` for conditionally-mounted inputs so listeners bind on mount. */
  active?: boolean;
  maxLength?: number;
  onTooLong?: () => void;
  /** Runs when microphone / shortcut capture is accepted before ASR text arrives. */
  onStart?: () => void;
  /** Subscribe to the global & DOM voice shortcut while focused or active (default true). */
  enableShortcut?: boolean;
  /** Support press-and-hold dictation inside the field (default true). */
  enableLongPress?: boolean;
  /** Keep focus in the input when starting from the voice button (default true). */
  focusOnButtonStart?: boolean;
}

// Single active non-composer voice owner across the renderer window: prevents
// two mounted fields (e.g. group + thread, or background + modal) from
// starting simultaneously or racing on global shortcut / Escape events.
let activeFieldVoiceOwner: symbol | null = null;
const SHORTCUT_DEDUPE_MS = 250;

function defaultGetDomElement(input: FieldVoiceInputElement | null): HTMLElement | null {
  return input instanceof HTMLElement ? input : null;
}

function getVoiceInputBridge() {
  try {
    return typeof window !== 'undefined' ? (window.electronAPI?.voiceInput ?? null) : null;
  } catch {
    return null;
  }
}

export function useFieldVoiceInput<T extends FieldVoiceInputElement = HTMLTextAreaElement>({
  draftKey = 'default',
  inputElementKey,
  inputRef,
  getDomElement = defaultGetDomElement,
  value,
  onChange,
  disabled = false,
  active = true,
  maxLength = -1,
  onTooLong,
  onStart,
  enableShortcut = true,
  enableLongPress = true,
  focusOnButtonStart = true,
}: UseFieldVoiceInputOptions<T>) {
  const { settings } = useVoiceInputSettings();
  const handlePermissionRequired = useVoiceMicrophonePermissionPrompt();
  const identity = useRef(Symbol('field-voice-input')).current;
  const mounted = useRef(false);
  const effectiveDisabled = disabled || !active;
  const current = useRef({
    draftKey,
    value,
    onChange,
    disabled: effectiveDisabled,
    maxLength,
    onTooLong,
    onStart,
    getDomElement,
    focusOnButtonStart,
  });
  current.current = {
    draftKey,
    value,
    onChange,
    disabled: effectiveDisabled,
    maxLength,
    onTooLong,
    onStart,
    getDomElement,
    focusOnButtonStart,
  };

  const owner = useRef<ReturnType<typeof getDataOwnerGeneration> | null>(null);
  const startedDraft = useRef<string | null>(null);
  const runGeneration = useRef(0);
  const expectedText = useRef('');
  const caret = useRef<number | null>(null);
  const tooLongNotified = useRef(false);
  const recordingSamplesRef = useRef<RecordingSamplesRef['current']>(null);
  const [holding, setHolding] = useState(false);

  const canApply = useCallback(
    () =>
      mounted.current &&
      !current.current.disabled &&
      startedDraft.current === current.current.draftKey &&
      owner.current !== null &&
      isDataOwnerGenerationCurrent(owner.current) &&
      current.current.value === expectedText.current,
    [],
  );

  // Runs before useVoiceInput's cleanup so late ASR/focus callbacks never write
  // into a stale field after a modal closes or draft switches.
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      runGeneration.current += 1;
      if (activeFieldVoiceOwner === identity) activeFieldVoiceOwner = null;
    };
  }, [identity]);

  useEffect(() => {
    if (active && settings.playInteractionSound) {
      prepareVoiceInputCues();
    }
  }, [active, settings.playInteractionSound]);

  const target = useMemo<VoiceInputTextTarget>(
    () => ({
      getText: () => current.current.value,
      getSelection: () => {
        const input = inputRef.current;
        const length = current.current.value.length;
        return {
          from: input?.selectionStart ?? length,
          to: input?.selectionEnd ?? length,
        };
      },
      replace: (range, inserted) => {
        if (
          !canApply() ||
          range.from < 0 ||
          range.to > current.current.value.length ||
          range.to < range.from
        ) {
          return null;
        }
        const nextValue =
          current.current.value.slice(0, range.from) +
          inserted +
          current.current.value.slice(range.to);
        if (current.current.maxLength >= 0 && nextValue.length > current.current.maxLength) {
          if (!tooLongNotified.current) {
            tooLongNotified.current = true;
            current.current.onTooLong?.();
          }
          return null;
        }
        expectedText.current = nextValue;
        current.current.value = nextValue;
        caret.current = range.from + inserted.length;
        current.current.onChange(nextValue, {
          start: range.from,
          end: range.to,
          caret: caret.current,
        });
        return { start: range.from, end: caret.current };
      },
      focus: () => {
        if (!canApply()) return;
        const input = inputRef.current;
        const domEl = current.current.getDomElement(input);
        if (!input || !domEl || document.activeElement !== domEl) return;
        if (caret.current !== null) input.setSelectionRange(caret.current, caret.current);
      },
    }),
    [canApply, inputRef],
  );

  const voiceOptions = useMemo(
    () => ({
      textTarget: target,
      shouldApplyToEditor: canApply,
      onSamples: (pcm: ArrayBuffer) => recordingSamplesRef.current?.(pcm),
      onMicrophonePermissionRequired: handlePermissionRequired,
    }),
    [canApply, handlePermissionRequired, target],
  );

  const voice = useVoiceInput(null, effectiveDisabled, undefined, voiceOptions);
  const latest = useRef({ voice, settings });
  latest.current = { voice, settings };

  const start = useCallback((): boolean => {
    if (
      current.current.disabled ||
      !mounted.current ||
      (activeFieldVoiceOwner !== null && activeFieldVoiceOwner !== identity)
    ) {
      return false;
    }
    owner.current = getDataOwnerGeneration();
    startedDraft.current = current.current.draftKey;
    expectedText.current = current.current.value;
    caret.current = null;
    const { voice: input, settings: config } = latest.current;
    const claimed = input.start({
      startedAt: performance.now(),
      onStartFeedback: () => {
        if (config.playInteractionSound) return playVoiceInputStartCue();
      },
    });
    if (claimed) {
      runGeneration.current += 1;
      activeFieldVoiceOwner = identity;
      tooLongNotified.current = false;
      current.current.onStart?.();
    }
    return claimed;
  }, [identity]);

  const startFromButton = useCallback((): boolean => {
    if (current.current.focusOnButtonStart) {
      const input = inputRef.current;
      const domEl = current.current.getDomElement(input);
      if (input && domEl && document.activeElement !== domEl) {
        input.focus();
      }
    }
    return start();
  }, [inputRef, start]);

  const cancel = useCallback(async (): Promise<void> => {
    runGeneration.current += 1;
    await latest.current.voice.cancel();
  }, []);

  /**
   * Finalize active dictation for submit-while-recording flows.
   * Returns `null` if stop/transcription failed, was cancelled, or the draft/owner
   * changed while waiting so callers abort submission instead of sending stale text.
   */
  const stop = useCallback(async (): Promise<string | null> => {
    const startDraftKey = current.current.draftKey;
    const startOwner = owner.current ?? getDataOwnerGeneration();
    const startRunGen = runGeneration.current;
    let failed = false;
    try {
      await latest.current.voice.stop({
        waitForRefinement: true,
        onReadyForEndCue: () => {
          if (latest.current.settings.playInteractionSound) playVoiceInputEndCue();
        },
      });
    } catch {
      failed = true;
    }
    if (
      failed ||
      !mounted.current ||
      current.current.disabled ||
      runGeneration.current !== startRunGen ||
      current.current.draftKey !== startDraftKey ||
      !isDataOwnerGenerationCurrent(startOwner) ||
      latest.current.voice.getState() === 'error'
    ) {
      return null;
    }
    return current.current.value;
  }, []);

  const stopPlain = useCallback(async (): Promise<void> => {
    await stop();
  }, [stop]);

  useEffect(() => {
    if (!voice.isBusy && activeFieldVoiceOwner === identity) {
      activeFieldVoiceOwner = null;
    }
  }, [identity, voice.isBusy]);

  useEffect(() => {
    if (voice.isBusy && !canApply()) {
      void cancel();
    }
  }, [canApply, cancel, draftKey, effectiveDisabled, value, voice.isBusy]);

  // ── Keyboard shortcut + Escape cancel ──
  useEffect(() => {
    if (!enableShortcut || effectiveDisabled) return;
    let startedOnPress = false;
    let suppressRelease = false;
    let localHandledAt = -Infinity;
    let nativeHandledAt = -Infinity;
    let press: { shortcut: VoiceInputShortcut; long: boolean; timer: number } | null = null;

    const clearPress = () => {
      if (press) window.clearTimeout(press.timer);
      press = null;
    };
    const beginPress = () => {
      const shortcut = latest.current.settings.shortcut;
      if (!shortcut) return;
      const pending = { shortcut, long: false, timer: 0 };
      pending.timer = window.setTimeout(() => {
        pending.long = true;
      }, VOICE_INPUT_LONG_PRESS_MS);
      press = pending;
    };
    const getInputDom = () => current.current.getDomElement(inputRef.current);
    const isInputFocused = () => {
      const dom = getInputDom();
      return Boolean(dom && document.activeElement === dom);
    };
    const canHandle = () =>
      !current.current.disabled &&
      (activeFieldVoiceOwner === null || activeFieldVoiceOwner === identity) &&
      (isVoiceInputEventScopeActive(latest.current.voice.getState()) || isInputFocused());

    const finishPress = () => {
      const held = press?.long;
      clearPress();
      if (held) void stop();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      // Escape cancels active dictation even if focus moved to the toolbar,
      // yielding only to foreground overlays that do not contain this field.
      if (
        event.key === 'Escape' &&
        activeFieldVoiceOwner === identity &&
        isVoiceInputEventScopeActive(latest.current.voice.getState())
      ) {
        const dom = getInputDom();
        const foreignOverlay =
          event.target instanceof Element
            ? event.target.closest('[role="alertdialog"], [data-morph-side]')
            : null;
        if (
          event.defaultPrevented ||
          event.repeat ||
          event.isComposing ||
          event.keyCode === 229 ||
          getTextPreviewHost() ||
          document.querySelector('[data-mermaid-lightbox-overlay]') ||
          (foreignOverlay && !(dom && foreignOverlay.contains(dom)))
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        clearPress();
        void cancel();
        return;
      }

      if (
        !canHandle() ||
        event.repeat ||
        event.isComposing ||
        !isVoiceInputShortcutMatch(event, latest.current.settings.shortcut)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (press || performance.now() - nativeHandledAt < SHORTCUT_DEDUPE_MS) return;
      localHandledAt = performance.now();
      const state = latest.current.voice.getState();
      if (state === 'listening') void stop();
      else if (state !== 'submitting' && state !== 'refining' && start()) beginPress();
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (!press || !isVoiceInputShortcutRelease(event, press.shortcut)) return;
      event.preventDefault();
      event.stopPropagation();
      finishPress();
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('blur', finishPress);

    const unsubscribe = getVoiceInputBridge()?.onGlobalShortcutTrigger?.((payload) => {
      if (
        current.current.disabled ||
        (activeFieldVoiceOwner !== null && activeFieldVoiceOwner !== identity)
      ) {
        return;
      }
      const state = latest.current.voice.getState();
      if (!isVoiceInputEventScopeActive(state) && !isInputFocused()) return;
      if (payload?.id) getVoiceInputBridge()?.claimGlobalShortcutTrigger?.(payload.id);
      const phase = payload?.phase;
      if (!phase) {
        if (press || performance.now() - localHandledAt < SHORTCUT_DEDUPE_MS) return;
        nativeHandledAt = performance.now();
        if (state === 'listening') void stop();
        else if (state !== 'submitting' && state !== 'refining' && start()) beginPress();
        return;
      }
      if (phase === 'end' || phase === 'tap') {
        if (suppressRelease) {
          suppressRelease = false;
          return;
        }
        if (phase === 'tap' && startedOnPress) {
          startedOnPress = false;
          return;
        }
        startedOnPress = false;
        if (state === 'listening') void stop();
        return;
      }
      if (state === 'submitting' || state === 'refining') return;
      if (state === 'listening') {
        suppressRelease = phase === 'start';
        startedOnPress = false;
        void stop();
      } else {
        startedOnPress = phase === 'start' && start();
        if (phase !== 'start') start();
      }
    });

    return () => {
      clearPress();
      unsubscribe?.();
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('blur', finishPress);
    };
  }, [cancel, draftKey, effectiveDisabled, enableShortcut, identity, inputRef, start, stop]);

  // ── Press-and-hold inside the input field ("按住说话") ──
  useEffect(() => {
    if (!enableLongPress || effectiveDisabled) return;
    const field = current.current.getDomElement(inputRef.current);
    if (!field) return;

    let pointerId: number | null = null;
    const gesture = createComposerLongPressVoiceGesture({
      getState: () => latest.current.voice.getState(),
      prepare: () => latest.current.voice.prepare(),
      start: () => start(),
      stop: async () => {
        await stop();
      },
      onHoldStart: () => {
        setHolding(true);
        if (pointerId !== null) {
          try {
            field.setPointerCapture(pointerId);
          } catch {
            // Pointer may have left the window.
          }
        }
      },
      onHoldEnd: () => {
        setHolding(false);
        if (pointerId !== null && field.hasPointerCapture?.(pointerId)) {
          try {
            field.releasePointerCapture(pointerId);
          } catch {
            // Capture already released.
          }
        }
        pointerId = null;
      },
    });

    const press = (event: PointerEvent) => {
      if (
        current.current.disabled ||
        (field as HTMLTextAreaElement).readOnly ||
        event.button !== 0 ||
        event.detail > 1 ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      if (event.pointerType && event.pointerType !== 'mouse') return;
      if (getVoiceInputSettings().composerLongPressEnabled === false || !isComposerLongPressVoiceReady()) {
        return;
      }
      pointerId = event.pointerId;
      gesture.press({ x: event.clientX, y: event.clientY });
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      if (gesture.isHolding()) {
        event.preventDefault();
        return;
      }
      gesture.move({ x: event.clientX, y: event.clientY });
    };
    const release = () => {
      gesture.release();
      pointerId = null;
    };
    const dragStart = (event: DragEvent) => {
      if (gesture.isHolding()) event.preventDefault();
      else release();
    };

    field.addEventListener('pointerdown', press);
    field.addEventListener('dragstart', dragStart);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    window.addEventListener('blur', release);

    return () => {
      field.removeEventListener('pointerdown', press);
      field.removeEventListener('dragstart', dragStart);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      window.removeEventListener('blur', release);
      gesture.dispose();
    };
  }, [active, draftKey, effectiveDisabled, enableLongPress, inputElementKey, inputRef, start, stop]);

  const range = voice.draftRange;
  const ownsDraft = useCallback(() => activeFieldVoiceOwner === identity, [identity]);
  const displayText =
    voice.isBusy && range && voice.draftText && canApply()
      ? value.slice(0, range.from) + voice.draftText + value.slice(range.to)
      : value;
  const shortcutLabel = formatVoiceInputShortcut(settings.shortcut);

  const buttonProps: VoiceInputButtonProps = {
    samplesRef: recordingSamplesRef,
    state: voice.state,
    disabled: effectiveDisabled,
    shortcutLabel,
    emptyComposer: !displayText.trim(),
    onStart: startFromButton,
    onStop: stopPlain,
    onHoldChange: setHolding,
  };

  return {
    ...voice,
    cancel,
    samplesRef: recordingSamplesRef,
    start,
    startFromButton,
    stop,
    stopPlain,
    ownsDraft,
    displayText,
    shortcutLabel,
    holding,
    buttonProps,
  };
}
