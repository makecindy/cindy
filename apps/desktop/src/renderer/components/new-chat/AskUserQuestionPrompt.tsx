import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
/**
 * AskUserQuestionPrompt
 * ---------------------------------------------------------------------------
 * Multi-step wizard that replaces ChatInput when the Agent asks questions.
 * Supports single-select (click to advance), multi-select (checkbox + Next),
 * Back navigation, Skip, and slide animation between steps.
 *
 *
 * Answer encoding (F7.5):
 *   - Single-select: label string (e.g. "Option A")
 *   - Multi-select: JSON array string (e.g. '["Option A","Option C"]')
 *   - Skip: empty string ""
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type TextareaHTMLAttributes,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Mic, Square } from 'lucide-react';
import { visibleAskOptions } from '@cindy/maker-shared';

import { InteractionPromptCardShell } from '@/components/interaction-portal';
import { ChatSessionFileProvider, useChatSessionFile, useChatSessionFileValue } from '@/components/chat/ChatSessionFileContext';
import { QuestionReferenceText } from '@/components/chat/MarkdownRenderer';
import { useOptionalConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Tip } from '@/components/ui/tooltip';
import { useAutoResize } from '@/hooks/useAutoResize';
import { getVoiceInputSettings } from '@/hooks/useVoiceInputSettings';
import { shouldCardShortcutYield } from '@/lib/editableKeyboardTarget';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { AskUserDraft, AskUserViewerState, PendingAskUser } from '@/lib/makerChatStore';
import { requestRendererMicrophonePermission } from '@/voice-input/startGuards';
import { formatVoiceInputShortcut, isVoiceInputShortcutMatch } from '@/voice-input/shortcut';
import { createComposerLongPressVoiceGesture } from '@/voice-input/composerLongPressGesture';
import { nextAskUserVoiceShortcutOrder, registerAskUserVoiceShortcutCard } from './askUserVoiceShortcutOwner';
import { useAskUserDictation } from './useAskUserDictation';
import { parseVoiceQuestionSelection, type VoiceQuestionBridge, type VoiceQuestionTarget } from './voiceQuestionSelection';

const ASK_USER_ANSWER_MAX_HEIGHT_PX = 148;

interface AutoGrowingAnswerTextareaProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value'
> {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  voice?: ReturnType<typeof useAskUserDictation>;
}

/**
 * Keeps AskUserQuestion answers readable in place while preserving the prompt
 * card's context. Six-ish lines stay visible; longer answers scroll internally
 * instead of growing over the question and option list.
 */
function AutoGrowingAnswerTextarea({
  textareaRef,
  value,
  className,
  voice,
  ...props
}: AutoGrowingAnswerTextareaProps) {
  useAutoResize(textareaRef, value, ASK_USER_ANSWER_MAX_HEIGHT_PX);
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  useEffect(() => {
    const field = textareaRef.current;
    if (!field) return;
    let pointerId: number | null = null;
    const gesture = createComposerLongPressVoiceGesture({
      getState: () => voiceRef.current?.state ?? 'idle',
      start: () => voiceRef.current?.start() ?? false,
      stop: async () => { await voiceRef.current?.stop(); },
      onHoldStart: () => {
        if (pointerId !== null) {
          try { field.setPointerCapture(pointerId); } catch { /* The pointer may have left the window. */ }
        }
      },
      onHoldEnd: () => {
        if (pointerId !== null && field.hasPointerCapture?.(pointerId)) field.releasePointerCapture(pointerId);
        pointerId = null;
      },
    });
    const press = (event: PointerEvent) => {
      if (!voiceRef.current || field.readOnly || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (event.pointerType && event.pointerType !== 'mouse') return;
      if (getVoiceInputSettings().composerLongPressEnabled === false) return;
      pointerId = event.pointerId;
      gesture.press({ x: event.clientX, y: event.clientY });
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId === pointerId) gesture.move({ x: event.clientX, y: event.clientY });
    };
    const release = () => { gesture.release(); pointerId = null; };
    const dragStart = (event: DragEvent) => {
      // Native text dragging can swallow pointermove/up. Keep ordinary drags,
      // but cancel their pending hold; an active hold must retain its release.
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
  }, [textareaRef]);

  return (
    <textarea
      {...props}
      ref={textareaRef}
      rows={1}
      value={value}
      className={cn('resize-none', className)}
    />
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AskUserQuestionPromptProps {
  voiceBridge?: VoiceQuestionBridge;
  /**
   * The card belongs to an Orca lead. When no card holds focus, the voice
   * shortcut goes to a lead card before a worker card that appeared later.
   */
  voiceShortcutPreferred?: boolean;
  /**
   * The host view is actually on screen. A card can stay mounted inside a
   * collapsed or hidden panel with a CSS box, so geometry alone cannot tell.
   */
  hostVisible?: boolean;
  sessionId?: string;
  workingDir?: string;
  remoteHostId?: string | null;
  pending: PendingAskUser;
  onAnswer: (requestId: string, answers: Record<string, string>) => void;
  /**
   * F-AUQ-MIN-1: 'expanded' (default) renders the full Prompt card with the
   * Minimize button in its header. 'minimized' renders the 880×44 collapsed
   * bar in the same ChatInput slot — see the early return below. The component
   * intentionally stays mounted across both states so wizard state
   * (currentIndex / answers / selectedLabels / customInput) is preserved
   * verbatim across folds (F-AUQ-MIN-4).
   */
  viewerState: AskUserViewerState;
  /** F-AUQ-MIN-2/4: emit a viewer-state change (Minimize / Restore button). */
  onViewerStateChange: (next: AskUserViewerState) => void;
  /**
   * F-AUQ-DRAFT: Persisted in-progress wizard state from the per-session
   * store. Hydrated on mount when `draft.requestId === pending.requestId`.
   * Why we need this even though wizard state already lives in useState:
   * this component sits inside a `pendingAskUser ? <Prompt> : ...` branch in
   * the parent (CCAgentSessionView). Switching to another session — where
   * pendingAskUser is null — unmounts the component and wipes its useState.
   * Switching back would otherwise re-mount at currentIndex=0 with no
   * answers, forcing the user to redo every step they had already completed.
   */
  draft: AskUserDraft | null;
  /** F-AUQ-DRAFT: emit a draft update on every wizard state change. */
  onDraftChange: (next: AskUserDraft | null) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AskUserQuestionPrompt({
  sessionId,
  workingDir,
  remoteHostId,
  ...props
}: AskUserQuestionPromptProps) {
  const inheritedFileContext = useChatSessionFile();
  const ownFileContext = useChatSessionFileValue(sessionId, workingDir ?? '', remoteHostId);
  const fileContext = workingDir === undefined && inheritedFileContext.sessionId === sessionId
    ? inheritedFileContext : ownFileContext;
  // Match the store's content comparison, including option order and metadata.
  // Fixed field order avoids treating JSON property order as a new question;
  // absent and empty options are equivalent, as in the reducer.
  const questionsIdentity = props.pending.questions.map((question) => [
    question.question,
    question.header,
    question.multiSelect,
    (question.options ?? []).map((option) => [option.label, option.description]),
  ]);
  const formKey = JSON.stringify([sessionId, props.pending.requestId, questionsIdentity]);
  // Repeated snapshots keep this form mounted. A changed session, request or
  // question starts from its own draft (cleared by the store on content changes).
  return <ChatSessionFileProvider value={fileContext}>
    <AskUserQuestionForm key={formKey} {...props} />
  </ChatSessionFileProvider>;
}

function AskUserQuestionForm({
  pending,
  onAnswer,
  viewerState,
  onViewerStateChange,
  draft,
  onDraftChange,
  voiceBridge,
  voiceShortcutPreferred = false,
  hostVisible = true,
}: AskUserQuestionPromptProps) {
  const { t } = useTranslation();
  const { requestId, questions } = pending;
  const totalQuestions = questions.length;
  const [referencePreviewOpen, setReferencePreviewOpen] = useState(false);
  const [voiceFeedback, setVoiceFeedback] = useState<'hint' | 'confirm' | 'ambiguous' | 'unknown' | 'cancelled'>('hint');
  const voiceRevision = useRef(0);

  // ── Wizard state ──
  // F-AUQ-DRAFT: lazy-init from the per-session store so a remount caused by
  // session-switch (parent unmounts us when its other-session pendingAskUser
  // is null) restores the user's progress instead of resetting to step 1.
  // We only trust `draft` when its requestId matches the current pending
  // batch — a stale draft from a previous question batch must be ignored.
  // Note: `requestId` is captured in the lazy initializer closure on first
  // render; subsequent prop updates do NOT re-run the initializer (that is
  // useState's documented behavior). The public wrapper remounts this form
  // when the session, request or question content changes. For a new or changed
  // question batch the store clears `askUserDraft`, so the form starts fresh.
  const [currentIndex, setCurrentIndex] = useState<number>(() =>
    draft && draft.requestId === requestId ? draft.currentIndex : 0,
  );
  // answers[questionText] = reply string
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    draft && draft.requestId === requestId ? draft.answers : {},
  );
  // Multi-select: set of selected labels for current question
  const [selectedLabels, setSelectedLabels] = useState<Set<string>>(() => new Set(draft?.selectedLabels ?? []));
  // Custom input
  const [customInput, setCustomInput] = useState(draft?.customInput ?? '');
  const [showCustomInput, setShowCustomInput] = useState(draft?.showCustomInput ?? false);
  const startedRef = useRef(draft?.started === true);
  const draftRef = useRef<AskUserDraft>({ requestId, currentIndex, answers });
  draftRef.current = { requestId, currentIndex, answers, customInput, showCustomInput,
    selectedLabels: [...selectedLabels], started: startedRef.current };
  const markStarted = useCallback(() => {
    startedRef.current = true;
    onDraftChange({ ...draftRef.current, started: true });
  }, [onDraftChange]);
  const cardRef = useRef<HTMLElement | null>(null);
  const setCardNode = useCallback((node: HTMLElement | null) => {
    cardRef.current = node;
  }, []);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const answerTextRef = useRef(customInput);
  answerTextRef.current = customInput;
  const confirmDialog = useOptionalConfirmDialog();
  const handleVoicePermissionRequired = useCallback(async () => {
    if (!confirmDialog) {
      toast.error(t('newChat.chatInput.voiceInput.permissionDialog.description'));
      return;
    }
    const confirmed = await confirmDialog.confirm({
      title: t('newChat.chatInput.voiceInput.permissionDialog.title'),
      description: t('newChat.chatInput.voiceInput.permissionDialog.description'),
      confirmText: t('newChat.chatInput.voiceInput.permissionDialog.confirm'),
      cancelText: t('newChat.chatInput.voiceInput.permissionDialog.cancel'),
      autoFocusConfirm: true,
    });
    if (!confirmed) return;
    const result = await requestRendererMicrophonePermission();
    if (result.ok) return;
    const settingsResult = await window.electronAPI.voiceInput.openMicrophoneSettings();
    if (!settingsResult.ok) toast.error(settingsResult.error);
  }, [confirmDialog, t]);
  const setAnswerText = useCallback((value: string) => {
    answerTextRef.current = value;
    markStarted();
    setCustomInput(value);
  }, [markStarted]);
  const dictation = useAskUserDictation({
    getText: () => answerTextRef.current,
    setText: setAnswerText,
    getSelection: () => {
      const el = inputRef.current;
      const length = answerTextRef.current.length;
      if (!el) return { start: length, end: length };
      return {
        start: el.selectionStart ?? length,
        end: el.selectionEnd ?? length,
      };
    },
    focus: () => inputRef.current?.focus(),
  }, {
    onPermissionRequired: handleVoicePermissionRequired,
  });
  const dictationRef = useRef(dictation);
  dictationRef.current = dictation;
  const [voiceSubmitting, setVoiceSubmitting] = useState(false);
  const voiceSubmitRef = useRef(false);
  const voiceLocked = dictation.isBusy || voiceSubmitting;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const voiceSubmitLabel = t(dictation.state === 'refining'
    ? 'voiceInputOverlay.status.refining' : 'voiceInputOverlay.status.submitting');
  const pendingVoiceStartRef = useRef(false);
  const voiceShortcutAtRef = useRef(0);
  // A shortcut press emits `start` then, on release, `tap`. The flag lives in a
  // ref because opening the free-text row re-creates the effect that owns the
  // listener — an effect-local flag would be lost and the tap would stop the
  // recording the same press just started.
  const voiceShortcutStartedPressRef = useRef(false);
  // This form remounts for every new session, request or question set, so the
  // mount order is the order in which cards appeared.
  const [voiceShortcutOrder] = useState(nextAskUserVoiceShortcutOrder);
  const answerValue = dictation.liveText ?? customInput;
  const voiceShortcutLabel = formatVoiceInputShortcut(getVoiceInputSettings().shortcut);
  const voiceProcessing = dictation.state === 'submitting' || dictation.state === 'refining';
  const voiceButtonLabel = voiceProcessing ? voiceSubmitLabel : dictation.isBusy
    ? t('newChat.chatInput.voiceInput.stop')
    : voiceShortcutLabel
      ? `${t('newChat.chatInput.voiceInput.start')} · ${voiceShortcutLabel}`
      : t('newChat.chatInput.voiceInput.start');

  // ── Animation state ──
  const [slideDirection, setSlideDirection] = useState<'left' | 'right' | null>(null);
  const [isAnimating, setIsAnimating] = useState(false);
  // Snapshot of button-bar JSX taken before animation starts.
  // During animation, render this snapshot so buttons don't flash.
  const buttonsSnapshotRef = useRef<React.ReactNode>(null);

  const currentQ = questions[currentIndex];
  const isMultiSelect = currentQ?.multiSelect === true;
  const isLastQuestion = currentIndex === totalQuestions - 1;
  const options = visibleAskOptions(currentQ?.options);
  const pageIndicator = totalQuestions > 1 ? `${currentIndex + 1}/${totalQuestions}` : undefined;

  // Check if this question was already answered (revisiting via Back)
  const existingAnswer = currentQ ? answers[currentQ.question] : undefined;

  // ── Helper: compute selectedLabels for a given question index ──
  // Used both by useEffect (current question) and by advance/handleBack
  // to pre-set state before the index changes, preventing flash.
  const computeSelectionForIndex = useCallback(
    (idx: number, answersSnapshot: Record<string, string>) => {
      const q = questions[idx];
      if (!q) return { labels: new Set<string>(), custom: '', showCustom: false };

      const ans = answersSnapshot[q.question];
      const isMulti = q.multiSelect === true;
      const opts = visibleAskOptions(q.options);

      if (isMulti && ans) {
        try {
          const parsed = JSON.parse(ans);
          if (Array.isArray(parsed)) {
            const optionLabels = new Set(opts.map((o) => o.label));
            const customItem = (parsed as string[]).find((l) => !optionLabels.has(l));
            return {
              labels: new Set(parsed as string[]),
              custom: customItem ?? '',
              showCustom: !!customItem,
            };
          }
        } catch {
          // Not JSON
        }
        return { labels: new Set<string>(), custom: '', showCustom: false };
      } else if (!isMulti && ans) {
        const optionLabels = new Set(opts.map((o) => o.label));
        if (!optionLabels.has(ans) && ans !== '') {
          return { labels: new Set<string>(), custom: ans, showCustom: true };
        }
        return { labels: new Set<string>(), custom: '', showCustom: false };
      }
      return { labels: new Set<string>(), custom: '', showCustom: false };
    },
    [questions],
  );

  // ── Restore multi-select state when navigating back ──
  const restoredIndexRef = useRef(currentIndex);
  useEffect(() => {
    if (draft?.customInput !== undefined && restoredIndexRef.current === currentIndex) return;
    restoredIndexRef.current = currentIndex;
    const result = computeSelectionForIndex(currentIndex, answers);
    setSelectedLabels(result.labels);
    setCustomInput(result.custom);
    setShowCustomInput(result.showCustom);
  }, [currentIndex, computeSelectionForIndex, answers]);

  // Save the unfinished field as well as completed answers across unmounts.
  useEffect(() => {
    onDraftChange(draftRef.current);
  }, [requestId, currentIndex, answers, customInput, selectedLabels, showCustomInput, onDraftChange]);

  // ── Snapshot current buttons before animation starts ──
  const snapshotButtons = useCallback(() => {
    // Capture a static copy of the current button bar's DOM via a frozen JSX snapshot.
    // This uses the current values at call time, not reactive state.
    const btnClass = 'rounded-[9999px] px-[20px] py-[8px] text-13 font-medium pointer-events-none';
    const skipClass = cn(
      btnClass,
      'border border-[var(--confirm-btn-secondary-border)] bg-transparent text-[var(--confirm-btn-secondary-text)]',
    );
    const showNext =
      isMultiSelect || (!isLastQuestion && existingAnswer !== undefined && !isMultiSelect);
    const nextDisabled = isMultiSelect
      ? selectedLabels.size === 0 && !customInput.trim()
      : existingAnswer === undefined;
    const nextClass = cn(
      btnClass,
      nextDisabled
        ? 'cursor-not-allowed border border-[var(--border-default)] bg-transparent text-[var(--text-disabled-tertiary)] opacity-50'
        : 'border border-[var(--confirm-btn-secondary-border)] bg-transparent text-[var(--confirm-btn-secondary-text)]',
    );

    buttonsSnapshotRef.current = (
      <>
        {currentIndex > 0 && (
          <div className={skipClass}>
            <span className="flex items-center gap-1.5">
              <span>&#8592;</span>
              <span>{t('chat.askUserQuestion.back')}</span>
            </span>
          </div>
        )}
        <div className={skipClass}>{t('chat.askUserQuestion.skip')}</div>
        {showNext && (
          <div className={nextClass}>
            {isLastQuestion ? t(pending.resumeOnSubmit ? 'chat.askUserQuestion.sendAndContinue' : 'chat.askUserQuestion.submit') : t('chat.askUserQuestion.next')}
          </div>
        )}
      </>
    );
  }, [currentIndex, isMultiSelect, isLastQuestion, existingAnswer, selectedLabels, customInput, pending.resumeOnSubmit, t]);

  // ── Advance to next question or submit all ──
  const advance = useCallback(
    (answer: string) => {
      // Invalidate ASR captured before a manual/voice answer immediately, including
      // the animation interval and the host's asynchronous submission receipt.
      ++voiceRevision.current;
      setVoiceFeedback('hint');
      const updated = { ...answers, [currentQ.question]: answer };
      setAnswers(updated);

      if (currentIndex === totalQuestions - 1) {
        // Last question — submit all answers
        onAnswer(requestId, updated);
      } else {
        // Freeze buttons before animation
        snapshotButtons();
        setSlideDirection('left');
        setIsAnimating(true);
        setTimeout(() => {
          const nextIdx = currentIndex + 1;
          const nextState = computeSelectionForIndex(nextIdx, updated);
          setSelectedLabels(nextState.labels);
          setCustomInput(nextState.custom);
          setShowCustomInput(nextState.showCustom);
          setCurrentIndex(nextIdx);
          requestAnimationFrame(() => {
            setIsAnimating(false);
            setSlideDirection(null);
          });
        }, 200);
      }
    },
    [
      answers,
      currentIndex,
      currentQ,
      totalQuestions,
      requestId,
      onAnswer,
      computeSelectionForIndex,
      snapshotButtons,
    ],
  );

  // ── Single-select: click option -> advance ──
  const handleSingleSelect = useCallback(
    (label: string) => {
      if (voiceSubmitRef.current) return;
      markStarted();
      advance(label);
    },
    [advance, markStarted],
  );

  // ── Multi-select: toggle checkbox ──
  const handleToggle = useCallback((label: string) => {
    if (voiceSubmitRef.current) return;
    markStarted();
    setSelectedLabels((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }, [markStarted]);

  // ── Multi-select: Next button → encode as JSON array string ──
  const submitWithDictation = useCallback(async (encode: (text: string) => string | null) => {
    if (voiceSubmitRef.current || isAnimating) return;
    if (!dictationRef.current.isBusy) {
      const answer = encode(answerTextRef.current);
      if (answer !== null) advance(answer);
      return;
    }
    voiceSubmitRef.current = true;
    setVoiceSubmitting(true);
    try {
      const ok = await dictationRef.current.stop();
      if (!ok || !mountedRef.current) return;
      const answer = encode(answerTextRef.current);
      if (answer !== null) advance(answer);
    } finally {
      voiceSubmitRef.current = false;
      if (mountedRef.current) setVoiceSubmitting(false);
    }
  }, [advance, isAnimating]);

  const handleNext = useCallback(() => {
    void submitWithDictation((text) => {
      if (selectedLabels.size === 0 && !text.trim()) return null;
      // Keep option order, followed by the finalized free-text answer.
      const parts = options.filter((o) => selectedLabels.has(o.label)).map((o) => o.label);
      if (text.trim()) parts.push(text.trim());
      return JSON.stringify(parts);
    });
  }, [options, selectedLabels, submitWithDictation]);

  // ── Back ──
  const handleBack = useCallback(() => {
    if (voiceSubmitRef.current || currentIndex === 0) return;
    ++voiceRevision.current;
    setVoiceFeedback('hint');
    snapshotButtons();
    setSlideDirection('right');
    setIsAnimating(true);
    setTimeout(() => {
      const prevIdx = currentIndex - 1;
      const prevState = computeSelectionForIndex(prevIdx, answers);
      setSelectedLabels(prevState.labels);
      setCustomInput(prevState.custom);
      setShowCustomInput(prevState.showCustom);
      setCurrentIndex(prevIdx);
      requestAnimationFrame(() => {
        setIsAnimating(false);
        setSlideDirection(null);
      });
    }, 200);
  }, [currentIndex, answers, computeSelectionForIndex, snapshotButtons]);

  // ── Skip ──
  const handleSkip = useCallback(() => {
    if (voiceSubmitRef.current) return;
    advance('');
  }, [advance]);

  // ── Custom input toggle ──
  const handleCustomOptionClick = useCallback(() => {
    if (voiceSubmitRef.current) return;
    setShowCustomInput(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const beginVoiceInput = useCallback(() => {
    if (voiceBridge) return;
    if (voiceSubmitRef.current) return;
    const session = dictationRef.current;
    if (session.isBusy) {
      void session.stop();
      return;
    }
    if (options.length > 0 && !showCustomInput) {
      pendingVoiceStartRef.current = true;
      setShowCustomInput(true);
      return;
    }
    inputRef.current?.focus();
    session.start();
  }, [options.length, showCustomInput, voiceBridge]);

  useEffect(() => {
    if (voiceBridge || !showCustomInput || !pendingVoiceStartRef.current) return;
    pendingVoiceStartRef.current = false;
    inputRef.current?.focus();
    dictationRef.current.start();
  }, [showCustomInput, voiceBridge]);

  // Companion voice mode owns microphone capture and question ASR while open.
  useEffect(() => {
    if (!voiceBridge) return;
    pendingVoiceStartRef.current = false;
    if (dictationRef.current.isBusy) void dictationRef.current.stop();
  }, [voiceBridge]);

  useEffect(() => {
    if (voiceBridge) return;
    // Every card hears each press; the owner check lets exactly one act. A
    // minimized card hides its microphone, so it may only stop a running take.
    const shortcutCard = registerAskUserVoiceShortcutCard(voiceShortcutOrder, {
      preferred: voiceShortcutPreferred,
      getElement: () => cardRef.current,
      isBusy: () => dictationRef.current.isBusy || pendingVoiceStartRef.current,
      canStart: () => viewerState !== 'minimized' && hostVisible,
    });
    const claim = (phase?: 'start' | 'tap' | 'end') => {
      const now = performance.now();
      if (now - voiceShortcutAtRef.current < 250) return;
      voiceShortcutAtRef.current = now;
      const session = dictationRef.current;
      if (session.state === 'submitting' || session.state === 'refining') return;
      // `tap` closes a quick press, `end` closes a held one; no phase means the
      // local keyboard handler (a plain modifier combo) pressed the shortcut.
      if (phase === 'tap') {
        // The tap of the press that just started dictation must not stop it.
        if (voiceShortcutStartedPressRef.current) {
          voiceShortcutStartedPressRef.current = false;
          return;
        }
        if (session.isBusy) void session.stop();
        return;
      }
      if (phase === 'end') {
        voiceShortcutStartedPressRef.current = false;
        if (session.isBusy) void session.stop();
        return;
      }
      voiceShortcutStartedPressRef.current = !session.isBusy;
      beginVoiceInput();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing) return;
      if (event.key === 'Escape' && dictationRef.current.isBusy && shortcutCard.owns(event.target)) {
        event.preventDefault();
        event.stopPropagation();
        pendingVoiceStartRef.current = false;
        void dictationRef.current.cancel();
        return;
      }
      const shortcut = getVoiceInputSettings().shortcut;
      if (!isVoiceInputShortcutMatch(event, shortcut)) return;
      // No defaultPrevented check: an unfocused sibling composer swallows every
      // matching press to keep it out of other inputs, so that flag says nothing
      // about who should act. Ownership alone decides.
      if (!shortcutCard.owns(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      claim();
    };
    window.addEventListener('keydown', onKeyDown, true);
    const unsubscribe = window.electronAPI?.voiceInput?.onGlobalShortcutTrigger?.((payload) => {
      // Leaving a press unclaimed lets the composer or the global overlay take it.
      if (!shortcutCard.owns(document.activeElement)) return;
      if (payload?.id) window.electronAPI.voiceInput.claimGlobalShortcutTrigger(payload.id);
      claim(payload?.phase);
    });
    return () => {
      shortcutCard.dispose();
      window.removeEventListener('keydown', onKeyDown, true);
      unsubscribe?.();
    };
  }, [beginVoiceInput, hostVisible, viewerState, voiceBridge, voiceShortcutOrder, voiceShortcutPreferred]);

  // ── Custom input submit (single-select mode) ──
  const handleCustomSubmit = useCallback(() => {
    if (isMultiSelect) {
      // In multi-select, custom text is part of the selection — click Next to submit
      return;
    }
    void submitWithDictation((text) => text.trim() || null);
    // advance restores the next page when navigating. On the final page keep
    // this field retryable until the host confirms and removes the card.
  }, [isMultiSelect, submitWithDictation]);

  // ── Direct free-text answer when no option rows render ──
  // Multi-select keeps the documented JSON-array encoding (`["text"]`), otherwise
  // the answer cannot be parsed back when the user returns to edit this question.
  const submitDirectAnswer = useCallback(() => {
    void submitWithDictation((text) => {
      const trimmed = text.trim();
      return trimmed ? (isMultiSelect ? JSON.stringify([trimmed]) : trimmed) : null;
    });
  }, [isMultiSelect, submitWithDictation]);

  const voiceHandler = useRef<(text: string) => void>(() => {});
  const voiceTarget = useMemo<VoiceQuestionTarget>(() => {
    const revision = voiceRevision.current;
    const target: VoiceQuestionTarget = { receive: (text) => {
      if (voiceBridge?.current === target && revision === voiceRevision.current) voiceHandler.current(text);
    } };
    return target;
  }, [voiceBridge, currentIndex, voiceRevision.current, selectedLabels, customInput, showCustomInput, voiceFeedback]);
  useLayoutEffect(() => {
    voiceHandler.current = (text) => {
      if (isAnimating || referencePreviewOpen || !currentQ || dictationRef.current.isBusy || voiceSubmitRef.current) return;
      onViewerStateChange('expanded');
      const result = parseVoiceQuestionSelection(text, options.map((option) => option.label));
      if (result.kind === 'cancel') {
        markStarted();
        setSelectedLabels(new Set());
        setCustomInput('');
        setShowCustomInput(false);
        setVoiceFeedback('cancelled');
      } else if (result.kind === 'confirm') {
        if (voiceFeedback !== 'confirm') {
          setVoiceFeedback('unknown');
          return;
        }
        if (isMultiSelect) handleNext();
        else if (!options.length) submitDirectAnswer();
      } else if (result.kind === 'select') {
        if (!isMultiSelect && result.indices.length === 1) {
          handleSingleSelect(options[result.indices[0]].label);
        } else if (isMultiSelect) {
          markStarted();
          setSelectedLabels((previous) => new Set([...previous, ...result.indices.map((index) => options[index].label)]));
          // Consecutive spoken choices add to the visible draft. Explicit cancel
          // clears it; manual checkboxes still allow removing individual choices.
          setVoiceFeedback('confirm');
        } else {
          setVoiceFeedback('ambiguous');
        }
      } else if (!options.length && result.kind === 'unknown') {
        // Free text is previewed in the same draft and explicitly confirmed.
        markStarted();
        setCustomInput(text.trim());
        setVoiceFeedback('confirm');
      } else {
        setVoiceFeedback(result.kind);
      }
    };
  });
  useLayoutEffect(() => {
    if (!voiceBridge || isAnimating || referencePreviewOpen || voiceLocked) return;
    voiceBridge.current = voiceTarget;
    return () => {
      if (voiceBridge.current === voiceTarget) voiceBridge.current = null;
    };
  }, [voiceBridge, voiceTarget, isAnimating, referencePreviewOpen, voiceLocked]);

  const voiceNotice = voiceBridge ? (
    <div className="flex flex-wrap items-center gap-2 text-13 leading-5 text-[var(--text-secondary)]">
      <p role="status" className="min-w-0 flex-1">
        {t(`chat.askUserQuestion.voice.${voiceFeedback === 'hint' && !options.length ? 'freeTextHint' : voiceFeedback}`)}
      </p>
    </div>
  ) : null;

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // File previews can keep focus on their question link. Their keys must
      // never select or skip an answer, including during the closing fade.
      if (referencePreviewOpen) return;
      // F-AUQ-MIN-5: minimized 时数字键 1-N / 回车 / N+1 全部透传，
      // 避免"无视觉反馈地选中选项"。Escape 仍保留——满足 F-AUQ-MIN-5 的取消语义。
      if (viewerState === 'minimized' && e.key !== 'Escape') return;
      // Numbers typed into the sidebar search, a terminal or a rename field,
      // and Escape that closed a menu, belong to that place — not to this
      // question. The answer inputs handle their own keys.
      if (shouldCardShortcutYield(e, e.key === 'Escape' ? 'dismiss' : 'character', cardRef.current)) return;

      // Dictation owns the answer field until it stops: switching questions
      // would write the rest of the transcript into a different answer.
      if (dictationRef.current.isBusy || voiceSubmitRef.current) return;

      // If custom input is focused in single-select mode, handle Escape only
      if (showCustomInput && !isMultiSelect) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setShowCustomInput(false);
          setCustomInput('');
        }
        return;
      }

      // If custom input is focused in multi-select mode, let text input handle events
      if (showCustomInput && isMultiSelect) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setShowCustomInput(false);
          setCustomInput('');
        }
        return;
      }

      // Number keys 1-N select/toggle options
      if (options.length > 0) {
        const num = parseInt(e.key, 10);
        if (num >= 1 && num <= options.length) {
          e.preventDefault();
          if (isMultiSelect) {
            handleToggle(options[num - 1].label);
          } else {
            handleSingleSelect(options[num - 1].label);
          }
          return;
        }
        // N+1 for custom input
        if (num === options.length + 1) {
          e.preventDefault();
          handleCustomOptionClick();
          return;
        }
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        handleSkip();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    referencePreviewOpen,
    viewerState,
    options,
    showCustomInput,
    isMultiSelect,
    handleSingleSelect,
    handleToggle,
    handleCustomOptionClick,
    handleSkip,
  ]);

  // ── Animation classes ──
  const slideClass = isAnimating
    ? slideDirection === 'left'
      ? 'translate-x-[-20px] opacity-0'
      : 'translate-x-[20px] opacity-0'
    : 'translate-x-0 opacity-100';

  const footerActions = (
    <div className="flex gap-2.5">
      {pending.delivery === 'async' && startedRef.current && (
        <Button variant="secondary" palette="confirmation" size="lg" compact
          type="button" disabled={voiceLocked} onClick={() => { if (!voiceSubmitRef.current) onAnswer(requestId, {}); }}>
          {t('chat.askUserQuestion.close')}
        </Button>
      )}
      {isAnimating ? (
        buttonsSnapshotRef.current
      ) : (
        <>
          {currentIndex > 0 && (
            <Button
              variant="secondary"
              palette="confirmation"
              size="lg"
              compact
              type="button"
              disabled={voiceLocked}
              onClick={handleBack}
            >
              <span className="flex items-center gap-1.5">
                <span>&#8592;</span>
                <span>{t('chat.askUserQuestion.back')}</span>
              </span>
            </Button>
          )}

          <Button
            variant="secondary"
            palette="confirmation"
            size="lg"
            compact
            type="button"
            disabled={voiceLocked}
            onClick={handleSkip}
          >
            {t('chat.askUserQuestion.skip')}
          </Button>

          {(isMultiSelect ||
            (!isLastQuestion && existingAnswer !== undefined && !isMultiSelect)) && (
            <Button
              variant="secondary"
              palette="confirmation"
              size="lg"
              compact
              type="button"
              loading={voiceSubmitting}
              onClick={() => {
                if (voiceSubmitRef.current) return;
                if (isMultiSelect) {
                  handleNext();
                } else {
                  advance(existingAnswer ?? '');
                }
              }}
              disabled={
                voiceSubmitting ||
                (isMultiSelect
                  ? !dictation.isBusy && selectedLabels.size === 0 && !customInput.trim()
                  : dictation.isBusy || existingAnswer === undefined)
              }
            >
              {isLastQuestion ? t(pending.resumeOnSubmit ? 'chat.askUserQuestion.sendAndContinue' : 'chat.askUserQuestion.submit') : t('chat.askUserQuestion.next')}
            </Button>
          )}
        </>
      )}
    </div>
  );

  // ── Free-text entry (pinned, always visible) ──
  // The model's own "other" option is filtered out of the option list and this
  // host entry stands in for it. It lives outside the card's scroll region so a
  // long option list can never push the user's only free-text escape out of
  // view (DESIGN.md §4: permanent entries pin below the scroll region).
  const customAnswerEntry =
    options.length > 0 ? (
      <div className="overflow-hidden rounded-[12px] border border-[var(--ask-option-border)] bg-[var(--ask-option-list-bg)]">
        {showCustomInput ? (
          <div className="flex items-start gap-2 px-[16px] py-[14px]">
            {isMultiSelect && (
              <div
                className={cn(
                  'mt-[2px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px]',
                  customInput.trim()
                    ? 'bg-[var(--ask-checkbox-checked-bg)]'
                    : 'border-[1.5px] border-[var(--ask-checkbox-border)]',
                )}
              >
                {customInput.trim() && (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--ask-checkbox-checked-icon)"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </div>
            )}
            <AutoGrowingAnswerTextarea
              textareaRef={inputRef}
              voice={voiceBridge ? undefined : dictation}
              value={answerValue}
              readOnly={voiceLocked}
              onCompositionStart={markStarted}
              onChange={(e) => { markStarted(); setAnswerText(e.target.value); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (isMultiSelect) handleNext();
                  else handleCustomSubmit();
                }
                if (e.key === 'Escape') {
                  // Closing the row mid-dictation would leave the rest of the
                  // transcript writing into a hidden field.
                  if (voiceSubmitRef.current || dictation.isBusy) return;
                  e.preventDefault();
                  setShowCustomInput(false);
                  setAnswerText('');
                }
              }}
              placeholder={t('chat.askUserQuestion.answerPlaceholder')}
              className={cn(
                'min-h-[22px] min-w-0 flex-1 bg-transparent text-14 font-normal leading-[1.571] outline-none',
                'text-[var(--ask-input-text)] placeholder:text-[var(--ask-input-placeholder)]',
                'select-text',
              )}
            />
            {/* Voice and submit stay in one bottom-pinned cluster: as the answer
                grows, both keep the same center line instead of the mic drifting
                up to the top of the box. */}
            <div className="flex shrink-0 items-center gap-2 self-end">
              {!voiceBridge && (<AskUserVoiceButton
                size="md"
                label={voiceButtonLabel}
                busy={dictation.isBusy}
                processing={voiceProcessing || (dictation.isBusy && !dictation.captureReady)}
                disabled={voiceSubmitting || voiceProcessing}
                onClick={beginVoiceInput}
              />)}
              {!isMultiSelect && (
                <Tip text={voiceSubmitting ? voiceSubmitLabel : isLastQuestion ? null : t('chat.askUserQuestion.next')}>
                  <button
                    type="button"
                    onClick={handleCustomSubmit}
                    disabled={voiceSubmitting || (!dictation.isBusy && !customInput.trim())}
                    aria-busy={voiceSubmitting}
                    data-testid={isLastQuestion ? undefined : 'ask-user-custom-next'}
                    aria-label={isLastQuestion ? undefined : t('chat.askUserQuestion.next')}
                    className={cn(
                      'relative shrink-0 rounded-[9999px] text-13 font-medium',
                      isLastQuestion
                        ? 'px-[16px] py-[6px]'
                        : 'flex h-8 w-8 items-center justify-center',
                      customInput.trim() || dictation.isBusy
                        ? 'bg-[var(--ask-send-bg)] text-[var(--ask-send-text)]'
                        : 'bg-[var(--ask-send-disabled-bg)] text-[var(--ask-send-disabled-text)]',
                    )}
                  >
                    <span className={cn('inline-flex items-center justify-center', voiceSubmitting && 'opacity-0')}>
                      {isLastQuestion ? (
                        t(pending.resumeOnSubmit ? 'chat.askUserQuestion.sendAndContinue' : 'chat.askUserQuestion.submit')
                      ) : (
                        <ArrowRight size={15} strokeWidth={2} aria-hidden="true" />
                      )}
                    </span>
                    {voiceSubmitting && (
                      <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
                        <Spinner size={14} />
                      </span>
                    )}
                  </button>
                </Tip>
              )}
            </div>
          </div>
        ) : (
          // The number badge stays last so it lines up with the option badges
          // above; the microphone sits just before it, the same order as the
          // expanded answer row (mic, then send).
          <div className="flex items-center gap-2 px-[16px] py-[8px]">
            <button
              type="button"
              className={cn(
                'flex min-w-0 flex-1 items-center gap-3 py-[6px] text-left',
                'transition-colors hover:bg-[var(--ask-option-hover)]',
              )}
              disabled={voiceLocked}
              onClick={handleCustomOptionClick}
            >
              {isMultiSelect && (
                <div className="h-[18px] w-[18px] shrink-0 rounded-[4px] border-[1.5px] border-[var(--ask-checkbox-border)]" />
              )}
              <span className="text-14 italic text-[var(--ask-option-custom)]">
                {t('chat.askUserQuestion.customAnswer')}
              </span>
              {/* The visible badge moved out of the button; keep its number in the
                  button for screen readers, as the option rows do. */}
              <span className="sr-only">{options.length + 1}</span>
            </button>
            {!voiceBridge && (<AskUserVoiceButton label={voiceButtonLabel} busy={dictation.isBusy} processing={voiceProcessing || (dictation.isBusy && !dictation.captureReady)} disabled={voiceSubmitting || voiceProcessing} onClick={beginVoiceInput} />)}
            {/* Pointer shortcut only: the row button above already carries the
                action and its number for keyboard and screen-reader users. */}
            <div
              aria-hidden="true"
              data-testid="ask-user-custom-badge"
              onClick={handleCustomOptionClick}
              className="flex h-[28px] w-[28px] shrink-0 cursor-pointer items-center justify-center rounded-[8px] bg-[var(--ask-badge-bg)] text-13 font-medium text-[var(--ask-badge-text)]"
            >
              {options.length + 1}
            </div>

          </div>
        )}
      </div>
    ) : null;

  // ── Render ──
  return (
    <InteractionPromptCardShell
      rootRef={setCardNode}
      viewerState={viewerState}
      onViewerStateChange={onViewerStateChange}
      minimizedTitle={t('chat.askUserQuestion.pendingTitle')}
      minimizedMeta={totalQuestions > 1 ? `${currentIndex + 1} / ${totalQuestions}` : undefined}
      restoreAriaLabel={t('chat.askUserQuestion.restoreAriaLabel')}
      minimizeAriaLabel={t('chat.askUserQuestion.minimizeAriaLabel')}
      minimizeDisabled={isAnimating}
      pinnedContent={voiceBridge ? <div className="flex flex-col gap-3">{voiceNotice}{customAnswerEntry}</div> : customAnswerEntry}
      headerLeading={
        currentQ?.header ? (
          <Tip text={currentQ.header}>
            <span
              tabIndex={0}
              className="mr-3 inline-block min-w-0 truncate rounded-[6px] bg-[var(--ask-header-chip-bg)] px-[8px] py-[2px] text-12 font-medium text-[var(--ask-badge-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              {currentQ.header}
            </span>
          </Tip>
        ) : null
      }
      footer={footerActions}
    >
      {/* Content area — participates in slide animation */}
      <div
        className={cn(
          'flex flex-col gap-4 transition-[opacity,transform] duration-[var(--motion-base)] ease-[var(--motion-ease-move)]',
          slideClass,
        )}
      >
        {/* Question Row (header chip moved to top header bar above) */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="min-w-0 break-words whitespace-pre-wrap text-15 font-medium text-[var(--ask-header-text)]">
              <QuestionReferenceText text={currentQ?.question ?? ''} onPreviewOpenChange={setReferencePreviewOpen} />
            </span>
            {pageIndicator && (
              <span className="ml-4 shrink-0 text-13 text-[var(--ask-page-text)]">
                {pageIndicator}
              </span>
            )}
          </div>
        </div>

        {/* Options Container */}
        {options.length > 0 && (
          <div className="overflow-hidden rounded-[12px] border border-[var(--ask-option-border)] bg-[var(--ask-option-list-bg)]">
            {options.map((opt, idx) => (
              <div key={opt.label}>
                {idx > 0 && <div className="h-px bg-[var(--ask-option-divider)]" />}
                <button
                  type="button"
                  disabled={voiceLocked}
                  className={cn(
                    'flex w-full items-center justify-between px-[16px] py-[14px] text-left',
                    'transition-colors hover:bg-[var(--ask-option-hover)]',
                    // Highlight selected option when revisiting single-select via Back
                    !isMultiSelect &&
                      existingAnswer === opt.label &&
                      'bg-[var(--ask-option-hover)]',
                  )}
                  onClick={() =>
                    isMultiSelect ? handleToggle(opt.label) : handleSingleSelect(opt.label)
                  }
                >
                  <div className="flex items-center gap-3">
                    {/* Checkbox for multi-select */}
                    {isMultiSelect && (
                      <div
                        className={cn(
                          'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px]',
                          selectedLabels.has(opt.label)
                            ? 'bg-[var(--ask-checkbox-checked-bg)]'
                            : 'border-[1.5px] border-[var(--ask-checkbox-border)]',
                        )}
                      >
                        {selectedLabels.has(opt.label) && (
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="var(--ask-checkbox-checked-icon)"
                            strokeWidth="3"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-14 font-medium text-[var(--ask-option-label)]">
                        {opt.label}
                      </div>
                      {opt.description && (
                        <div className="mt-1 text-13 text-[var(--ask-option-desc)]">
                          {opt.description}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="ml-3 flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-[8px] bg-[var(--ask-badge-bg)] text-13 font-medium text-[var(--ask-badge-text)]">
                    {idx + 1}
                  </div>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Free-text input when no options */}
        {options.length === 0 && (
          <div className="flex items-end gap-2">
            <AutoGrowingAnswerTextarea
              textareaRef={inputRef}
              voice={voiceBridge ? undefined : dictation}
              value={answerValue}
              readOnly={voiceLocked}
              onCompositionStart={markStarted}
              onChange={(e) => { markStarted(); setAnswerText(e.target.value); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submitDirectAnswer();
                }
                if (e.key === 'Escape') {
                  if (voiceSubmitRef.current || dictation.isBusy) return;
                  e.preventDefault();
                  handleSkip();
                }
              }}
              placeholder={t('chat.askUserQuestion.answerPlaceholder')}
              autoFocus
              className={cn(
                'min-h-10 min-w-0 flex-1 rounded-[8px] border px-3 py-[8px] text-14 leading-[1.571] outline-none',
                'border-[var(--ask-input-border)] bg-[var(--ask-input-bg)] text-[var(--ask-input-text)]',
                'placeholder:text-[var(--ask-input-placeholder)]',
              )}
            />
            <div className="flex shrink-0 items-center gap-2">
              {!voiceBridge && (<AskUserVoiceButton
                size="md"
                label={voiceButtonLabel}
                busy={dictation.isBusy}
                processing={voiceProcessing || (dictation.isBusy && !dictation.captureReady)}
                disabled={voiceSubmitting || voiceProcessing}
                onClick={beginVoiceInput}
              />)}
              <Tip text={voiceSubmitting ? voiceSubmitLabel : isLastQuestion ? null : t('chat.askUserQuestion.next')}>
                <button
                  type="button"
                  onClick={submitDirectAnswer}
                  disabled={voiceSubmitting || (!dictation.isBusy && !customInput.trim())}
                  aria-busy={voiceSubmitting}
                  data-testid={isLastQuestion ? undefined : 'ask-user-custom-next'}
                  aria-label={isLastQuestion ? undefined : t('chat.askUserQuestion.next')}
                  className={cn(
                    'relative h-10 rounded-[9999px] text-14 font-medium transition-colors',
                    isLastQuestion ? 'px-4' : 'flex w-10 items-center justify-center',
                    customInput.trim() || dictation.isBusy
                      ? 'bg-[var(--ask-send-bg)] text-[var(--ask-send-text)]'
                      : 'bg-[var(--ask-send-disabled-bg)] text-[var(--ask-send-disabled-text)]',
                  )}
                >
                  <span className={cn('inline-flex items-center justify-center', voiceSubmitting && 'opacity-0')}>
                    {isLastQuestion ? (
                      t(pending.resumeOnSubmit ? 'chat.askUserQuestion.sendAndContinue' : 'chat.askUserQuestion.submit')
                    ) : (
                      <ArrowRight size={17} strokeWidth={2} aria-hidden="true" />
                    )}
                  </span>
                  {voiceSubmitting && (
                    <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
                      <Spinner size={14} />
                    </span>
                  )}
                </button>
              </Tip>
            </div>
          </div>
        )}
      </div>
    </InteractionPromptCardShell>
  );
}

function AskUserVoiceButton({
  label,
  busy,
  processing = false,
  onClick,
  size = 'sm',
  disabled = false,
}: {
  label: string;
  busy: boolean;
  processing?: boolean;
  disabled?: boolean;
  onClick: () => void;
  /**
   * md matches the answer row's send button (32px) so the two share one center
   * line; the collapsed free-text row keeps sm to match its 28px option badge.
   */
  size?: 'sm' | 'md';
}) {
  return (
    <button
      type="button"
      data-testid="ask-user-voice"
      aria-label={label}
      aria-pressed={busy}
      aria-busy={processing}
      disabled={disabled}
      onMouseDown={(event) => {
        // Keep the caret in the answer field so dictation replaces the selection
        // the user was editing, instead of jumping after the button takes focus.
        event.preventDefault();
      }}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full',
        size === 'md' ? 'h-8 w-8' : 'h-7 w-7',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        busy
          ? 'bg-[var(--ask-send-bg)] text-[var(--ask-send-text)]'
          : 'bg-[var(--ask-badge-bg)] text-[var(--ask-badge-text)]',
      )}
    >
      {processing ? <Spinner size={15} /> : busy ? <Square size={13} fill="currentColor" aria-hidden="true" /> : <Mic size={15} strokeWidth={2} aria-hidden="true" />}
    </button>
  );
}
