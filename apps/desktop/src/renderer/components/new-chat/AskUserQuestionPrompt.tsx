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

import { useCallback, useEffect, useRef, useState } from 'react';

import { InteractionPromptCardShell } from '@/components/interaction-portal';
import { cn } from '@/lib/utils';
import type { AskUserDraft, AskUserViewerState, PendingAskUser } from '@/lib/makerChatStore';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AskUserQuestionPromptProps {
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
  pending,
  onAnswer,
  viewerState,
  onViewerStateChange,
  draft,
  onDraftChange,
}: AskUserQuestionPromptProps) {
  const { requestId, questions } = pending;
  const totalQuestions = questions.length;

  // ── Wizard state ──
  // F-AUQ-DRAFT: lazy-init from the per-session store so a remount caused by
  // session-switch (parent unmounts us when its other-session pendingAskUser
  // is null) restores the user's progress instead of resetting to step 1.
  // We only trust `draft` when its requestId matches the current pending
  // batch — a stale draft from a previous question batch must be ignored.
  // Note: `requestId` is captured in the lazy initializer closure on first
  // render; subsequent prop updates do NOT re-run the initializer (that is
  // useState's documented behavior). For a brand-new question batch the
  // store has already cleared `askUserDraft` to null on the
  // `ask_user_question` reducer path, so the lazy init falls through to
  // defaults — no stale leak across batches.
  const [currentIndex, setCurrentIndex] = useState<number>(() =>
    draft && draft.requestId === requestId ? draft.currentIndex : 0,
  );
  // answers[questionText] = reply string
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    draft && draft.requestId === requestId ? draft.answers : {},
  );
  // Multi-select: set of selected labels for current question
  const [selectedLabels, setSelectedLabels] = useState<Set<string>>(new Set());
  // Custom input
  const [customInput, setCustomInput] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Animation state ──
  const [slideDirection, setSlideDirection] = useState<'left' | 'right' | null>(null);
  const [isAnimating, setIsAnimating] = useState(false);
  // Snapshot of button-bar JSX taken before animation starts.
  // During animation, render this snapshot so buttons don't flash.
  const buttonsSnapshotRef = useRef<React.ReactNode>(null);

  const currentQ = questions[currentIndex];
  const isMultiSelect = currentQ?.multiSelect === true;
  const isLastQuestion = currentIndex === totalQuestions - 1;
  const options = currentQ?.options ?? [];
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
      const opts = q.options ?? [];

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
  useEffect(() => {
    const result = computeSelectionForIndex(currentIndex, answers);
    setSelectedLabels(result.labels);
    setCustomInput(result.custom);
    setShowCustomInput(result.showCustom);
  }, [currentIndex, computeSelectionForIndex, answers]);

  // ── F-AUQ-DRAFT: write wizard progress back to the per-session store on
  // every change so a session-switch unmount doesn't lose it. The store has
  // an equality short-circuit (same requestId + currentIndex + answers
  // identity) so the first effect run after a hydrating mount is a no-op
  // (we initialized from the very same draft object). Derived state
  // (selectedLabels / customInput / showCustomInput) is intentionally NOT
  // persisted — `computeSelectionForIndex` rebuilds it from `answers` on
  // mount via the effect above, so persisting it would create a second
  // source of truth that could drift. ──
  useEffect(() => {
    onDraftChange({ requestId, currentIndex, answers });
  }, [requestId, currentIndex, answers, onDraftChange]);

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
      isMultiSelect || (existingAnswer !== undefined && !isMultiSelect) || isLastQuestion;
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
            <span className="flex items-center gap-[6px]">
              <span>&#8592;</span>
              <span>Back</span>
            </span>
          </div>
        )}
        <div className={skipClass}>Skip</div>
        {showNext && <div className={nextClass}>{isLastQuestion ? 'Submit' : 'Next'}</div>}
      </>
    );
  }, [currentIndex, isMultiSelect, isLastQuestion, existingAnswer, selectedLabels, customInput]);

  // ── Advance to next question or submit all ──
  const advance = useCallback(
    (answer: string) => {
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
      advance(label);
    },
    [advance],
  );

  // ── Multi-select: toggle checkbox ──
  const handleToggle = useCallback((label: string) => {
    setSelectedLabels((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }, []);

  // ── Multi-select: Next button → encode as JSON array string ──
  const handleNext = useCallback(() => {
    if (selectedLabels.size === 0 && !customInput.trim()) return;
    // Maintain UI visual order: filter options by selected state, then append custom text
    const parts: string[] = options.filter((o) => selectedLabels.has(o.label)).map((o) => o.label);
    if (customInput.trim()) {
      // Custom text is an additional selected item
      parts.push(customInput.trim());
    }
    advance(JSON.stringify(parts));
  }, [selectedLabels, customInput, advance]);

  // ── Back ──
  const handleBack = useCallback(() => {
    if (currentIndex === 0) return;
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
    advance('');
  }, [advance]);

  // ── Custom input toggle ──
  const handleCustomOptionClick = useCallback(() => {
    setShowCustomInput(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  // ── Custom input submit (single-select mode) ──
  const handleCustomSubmit = useCallback(() => {
    const trimmed = customInput.trim();
    if (!trimmed) return;
    if (isMultiSelect) {
      // In multi-select, custom text is part of the selection — click Next to submit
      return;
    }
    advance(trimmed);
    setCustomInput('');
    setShowCustomInput(false);
  }, [customInput, isMultiSelect, advance]);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // F-AUQ-MIN-5: minimized 时数字键 1-N / 回车 / N+1 全部透传，
      // 避免"无视觉反馈地选中选项"。Escape 仍保留——满足 F-AUQ-MIN-5 的取消语义。
      if (viewerState === 'minimized' && e.key !== 'Escape') return;

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
    <div className="flex gap-[10px]">
      {isAnimating ? (
        buttonsSnapshotRef.current
      ) : (
        <>
          {currentIndex > 0 && (
            <button
              type="button"
              onClick={handleBack}
              className={cn(
                'rounded-[9999px] px-[20px] py-[8px] text-13 font-medium',
                'border border-[var(--confirm-btn-secondary-border)] bg-transparent text-[var(--confirm-btn-secondary-text)] transition-colors hover:bg-[var(--confirm-btn-secondary-hover)]',
              )}
            >
              <span className="flex items-center gap-[6px]">
                <span>&#8592;</span>
                <span>Back</span>
              </span>
            </button>
          )}

          <button
            type="button"
            onClick={handleSkip}
            className={cn(
              'rounded-[9999px] px-[20px] py-[8px] text-13 font-medium',
              'border border-[var(--confirm-btn-secondary-border)] bg-transparent text-[var(--confirm-btn-secondary-text)] transition-colors hover:bg-[var(--confirm-btn-secondary-hover)]',
            )}
          >
            Skip
          </button>

          {(isMultiSelect ||
            (existingAnswer !== undefined && !isMultiSelect) ||
            isLastQuestion) && (
            <button
              type="button"
              onClick={() => {
                if (isMultiSelect) {
                  handleNext();
                } else {
                  advance(existingAnswer ?? '');
                }
              }}
              disabled={
                isMultiSelect
                  ? selectedLabels.size === 0 && !customInput.trim()
                  : existingAnswer === undefined
              }
              className={cn(
                'rounded-[9999px] px-[20px] py-[8px] text-13 font-medium',
                (
                  isMultiSelect
                    ? selectedLabels.size === 0 && !customInput.trim()
                    : existingAnswer === undefined
                )
                  ? 'cursor-not-allowed border border-[var(--border-default)] bg-transparent text-[var(--text-disabled-tertiary)] opacity-50'
                  : 'border border-[var(--confirm-btn-secondary-border)] bg-transparent text-[var(--confirm-btn-secondary-text)] transition-colors hover:bg-[var(--confirm-btn-secondary-hover)]',
              )}
            >
              {isLastQuestion ? 'Submit' : 'Next'}
            </button>
          )}
        </>
      )}
    </div>
  );

  // ── Render ──
  return (
    <InteractionPromptCardShell
      viewerState={viewerState}
      onViewerStateChange={onViewerStateChange}
      minimizedTitle="Question pending"
      minimizedMeta={totalQuestions > 1 ? `${currentIndex + 1} / ${totalQuestions}` : undefined}
      restoreAriaLabel="Restore question prompt"
      minimizeAriaLabel="Minimize question prompt"
      minimizeDisabled={isAnimating}
      headerLeading={
        currentQ?.header ? (
          <span className="inline-block rounded-[6px] bg-[var(--ask-header-chip-bg)] px-[8px] py-[2px] text-[12px] font-medium text-[var(--ask-badge-text)]">
            {currentQ.header}
          </span>
        ) : null
      }
      footer={footerActions}
    >
      {/* Content area — participates in slide animation */}
      <div
        className={cn(
          'flex flex-col gap-[16px] transition-all duration-200 ease-in-out',
          slideClass,
        )}
      >
        {/* Question Row (header chip moved to top header bar above) */}
        <div className="flex flex-col gap-[8px]">
          <div className="flex items-center justify-between">
            <span className="text-15 font-medium text-[var(--ask-header-text)]">
              {currentQ?.question}
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
                  <div className="ml-3 flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-[8px] bg-[var(--ask-badge-bg)] text-[13px] font-medium text-[var(--ask-badge-text)]">
                    {idx + 1}
                  </div>
                </button>
              </div>
            ))}

            {/* "Type something else..." row */}
            <div className="h-px bg-[var(--ask-option-divider)]" />
            {showCustomInput ? (
              <div className="flex items-center gap-2 px-[16px] py-[14px]">
                {isMultiSelect && (
                  <div
                    className={cn(
                      'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px]',
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
                <input
                  ref={inputRef}
                  type="text"
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing && !isMultiSelect) {
                      e.preventDefault();
                      handleCustomSubmit();
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setShowCustomInput(false);
                      setCustomInput('');
                    }
                  }}
                  placeholder="Type your answer..."
                  className={cn(
                    'flex-1 bg-transparent text-14 font-normal outline-none',
                    'text-[var(--ask-input-text)] placeholder:text-[var(--ask-input-placeholder)]',
                    'select-text',
                  )}
                />
                {!isMultiSelect && (
                  <button
                    type="button"
                    onClick={handleCustomSubmit}
                    disabled={!customInput.trim()}
                    className={cn(
                      'shrink-0 rounded-[9999px] px-[16px] py-[6px]',
                      'text-13 font-medium',
                      customInput.trim()
                        ? 'bg-[var(--ask-send-bg)] text-[var(--ask-send-text)]'
                        : 'bg-[var(--ask-send-disabled-bg)] text-[var(--ask-send-disabled-text)]',
                    )}
                  >
                    Send
                  </button>
                )}
              </div>
            ) : (
              <button
                type="button"
                className={cn(
                  'flex w-full items-center justify-between px-[16px] py-[14px] text-left',
                  'transition-colors hover:bg-[var(--ask-option-hover)]',
                )}
                onClick={handleCustomOptionClick}
              >
                <div className="flex items-center gap-3">
                  {isMultiSelect && (
                    <div className="h-[18px] w-[18px] shrink-0 rounded-[4px] border-[1.5px] border-[var(--ask-checkbox-border)]" />
                  )}
                  <span className="text-14 italic text-[var(--ask-option-custom)]">
                    Type something else...
                  </span>
                </div>
                <div className="ml-3 flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-[8px] bg-[var(--ask-badge-bg)] text-[13px] font-medium text-[var(--ask-badge-text)]">
                  {options.length + 1}
                </div>
              </button>
            )}
          </div>
        )}

        {/* Free-text input when no options */}
        {options.length === 0 && (
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (customInput.trim()) advance(customInput.trim());
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  handleSkip();
                }
              }}
              placeholder="Type your answer..."
              autoFocus
              className={cn(
                'h-10 flex-1 rounded-[12px] border px-3 text-14 outline-none',
                'border-[var(--ask-input-border)] bg-[var(--ask-input-bg)] text-[var(--ask-input-text)]',
                'placeholder:text-[var(--ask-input-placeholder)]',
              )}
            />
            <button
              type="button"
              onClick={() => customInput.trim() && advance(customInput.trim())}
              disabled={!customInput.trim()}
              className={cn(
                'rounded-[9999px] px-4 text-14 font-medium transition-colors',
                customInput.trim()
                  ? 'bg-[var(--ask-send-bg)] text-[var(--ask-send-text)]'
                  : 'bg-[var(--ask-send-disabled-bg)] text-[var(--ask-send-disabled-text)]',
              )}
            >
              Send
            </button>
          </div>
        )}
      </div>
    </InteractionPromptCardShell>
  );
}
