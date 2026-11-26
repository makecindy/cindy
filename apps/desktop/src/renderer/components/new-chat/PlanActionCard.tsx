/**
 * PlanActionCard
 * ---------------------------------------------------------------------------
 * FP-6: Bottom action card shown under the Plan Viewer Card during plan review.
 * Two rows packed into one card frame (914px, 12px radius, 1px Board border):
 *
 *   Approve Row   — brand-orange 20×20 check badge + label + ⏎ hint.
 *                   Click or Enter → onRespond(true).
 *                   ⏎ hint hides while the feedback editor is active (Enter
 *                   then belongs to the editor — two identical hints were
 *                   confusing, see issue #475 review feedback).
 *   Feedback Row  — pencil icon + placeholder + voice button → becomes an inline
 *                   editor. Enter with text → onRespond(false, feedback). A
 *                   full-width input contains the shared VoiceInputButton and
 *                   SendButton; send stays disabled until there is feedback or
 *                   dictation is active.
 *
 * Cancel(取消本次审阅)是次级动作,不与批准/反馈同级成行:可见入口收在
 * PlanViewerCard 工具条的 X;这里只保留全局 Esc 快捷键(onCancel)。
 *
 *   (same node across all 8 state frames; identical styling in both themes
 *   apart from the --plan-action-* tokens).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CornerDownLeft, Pencil } from 'lucide-react';

import { shouldCardShortcutYield } from '@/lib/editableKeyboardTarget';
import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';
import { FieldVoiceInputNotice } from '@/voice-input/FieldVoiceInputNotice';
import { useFieldVoiceInput } from '@/voice-input/useFieldVoiceInput';
import { VoiceInputButton } from '@/voice-input/VoiceInputButton';
import { SendButton } from './SendButton';
import { ListComposerTextarea } from './ListComposerTextarea';
import { sixAnswerRows, useAnswerComposerExpanded } from './useAnswerComposerExpanded';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PlanActionCardProps {
  requestId: string;
  onRespond: (requestId: string, approved: boolean, feedback?: string) => void;
  /**
   * 取消本次审阅(Esc 快捷键;可见入口在 PlanViewerCard 工具条的 X):
   * 关闭卡片并结束本轮计划循环 —— 不批准、不发修订 turn,下一条消息回到常规模式。
   */
  onCancel?: (requestId: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PlanActionCard({ requestId, onRespond, onCancel }: PlanActionCardProps) {
  const { t } = useTranslation();
  const [feedback, setFeedback] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  // Important #3: once the user triggers Approve or Feedback, freeze the card
  // so rapid double-clicks can't fire two IPC responses for the same requestId.
  const [submitted, setSubmitted] = useState(false);
  const [voiceSubmitting, setVoiceSubmitting] = useState(false);
  const [voiceReleaseToSendActive, setVoiceReleaseToSendActive] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sendButtonRef = useRef<HTMLButtonElement>(null);
  const feedbackRef = useRef(feedback);
  feedbackRef.current = feedback;
  const voiceSubmitRef = useRef(false);
  const pendingVoiceStartRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const voice = useFieldVoiceInput({
    draftKey: requestId,
    inputRef,
    value: feedback,
    onChange: (next) => {
      feedbackRef.current = next;
      setFeedback(next);
    },
    disabled: submitted,
    active: isEditing,
  });
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  const displayedFeedback = voice.displayText;
  const composerExpanded = useAnswerComposerExpanded(inputRef, displayedFeedback, sixAnswerRows);
  const voiceLocked = voice.isBusy || voiceSubmitting;

  useEffect(() => {
    if (!isEditing || !pendingVoiceStartRef.current) return;
    pendingVoiceStartRef.current = false;
    inputRef.current?.focus();
    voiceRef.current.start();
  }, [isEditing]);

  const handleApprove = useCallback(() => {
    if (submitted || voiceSubmitRef.current) return;
    if (voiceRef.current.isBusy) void voiceRef.current.cancel();
    setSubmitted(true);
    onRespond(requestId, true);
  }, [requestId, onRespond, submitted]);

  const handleSubmitFeedback = useCallback(async () => {
    if (submitted || voiceSubmitRef.current) return;
    if (voiceRef.current.isBusy) {
      voiceSubmitRef.current = true;
      setVoiceSubmitting(true);
      try {
        const finalText = await voiceRef.current.stop();
        if (!mountedRef.current) return;
        const trimmed = finalText.trim();
        if (!trimmed) return;
        setSubmitted(true);
        onRespond(requestId, false, trimmed);
      } finally {
        voiceSubmitRef.current = false;
        if (mountedRef.current) setVoiceSubmitting(false);
      }
      return;
    }
    const trimmed = feedbackRef.current.trim();
    if (!trimmed) return;
    setSubmitted(true);
    onRespond(requestId, false, trimmed);
  }, [requestId, onRespond, submitted]);

  const handleCancel = useCallback(() => {
    if (submitted || !onCancel || voiceSubmitRef.current) return;
    if (voiceRef.current.isBusy) void voiceRef.current.cancel();
    setSubmitted(true);
    onCancel(requestId);
  }, [requestId, onCancel, submitted]);

  /**
   * Minor #8: auto-grow the textarea as the user types so long feedback isn't
   * clipped to a single line. Capped at ~6 rows to avoid eating the whole
   * viewport — beyond that the built-in overflow kicks in.
   */
  const syncTextareaHeight = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    // 行高改成无单位比例后会随「外观 → UI 字号」缩放,6 行上限必须按实际计算值算:
    // 写死 6×22 会让放大字号时仍按 132px 截断,可见行数反而变少。取不到计算值
    // (如 jsdom 返回 'normal')时回落到默认字号下的 22px。
    const computedLineHeight = Number.parseFloat(window.getComputedStyle(el).lineHeight);
    const rowHeight =
      Number.isFinite(computedLineHeight) && computedLineHeight > 0 ? computedLineHeight : 22;
    const maxHeight = 6 * rowHeight;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, []);

  const handleFeedbackInput = useCallback(
    (e: React.FormEvent<HTMLTextAreaElement>) => {
      syncTextareaHeight(e.currentTarget);
    },
    [syncTextareaHeight],
  );

  // Voice draft/submitted text updates value programmatically without firing input.
  useEffect(() => {
    if (isEditing) syncTextareaHeight(inputRef.current);
  }, [displayedFeedback, isEditing, syncTextareaHeight]);

  // Enable the feedback row by clicking it
  const handleFeedbackRowClick = useCallback(() => {
    if (submitted || voiceSubmitRef.current) return;
    setIsEditing(true);
    // Focus after the textarea mounts
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [submitted]);

  const handleCollapsedVoiceStart = useCallback((): boolean => {
    if (submitted || voiceSubmitRef.current) return false;
    pendingVoiceStartRef.current = true;
    setIsEditing(true);
    return true;
  }, [submitted]);

  // Global Enter-to-approve / Escape-to-cancel (only when not in the feedback
  // editor — the editor owns both keys there).
  // Mirrors the AskUserQuestionPrompt global-keyboard pattern.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isEditing || submitted) return;
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      // Yield when the key already belongs to something else: typing in any
      // field, a menu item chosen with Enter, a menu or popover closed with
      // Escape, or a toolbar button elsewhere on the page.
      if (shouldCardShortcutYield(e, e.key === 'Escape' ? 'dismiss' : 'activate', cardRef.current)) return;
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        handleApprove();
      }
      if (e.key === 'Escape' && onCancel) {
        e.preventDefault();
        handleCancel();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isEditing, submitted, handleApprove, handleCancel, onCancel]);

  const hasFeedbackText = displayedFeedback.trim().length > 0;

  return (
    <div
      ref={cardRef}
      className={cn(
        'flex w-full max-w-[914px] flex-col overflow-hidden rounded-xl border',
        'border-[var(--plan-card-border)] bg-[var(--plan-card-bg)]',
      )}
    >
      {/* Approve Row */}
      <button
        type="button"
        onClick={handleApprove}
        disabled={submitted || voiceLocked}
        className={cn(
          'flex w-full items-center gap-2.5 border-b px-4 py-3.5 text-left',
          'border-[var(--plan-action-row-divider)]',
          'transition-colors hover:bg-[var(--plan-action-row-hover-bg)]',
          (submitted || voiceLocked) && 'cursor-not-allowed opacity-60 hover:bg-transparent',
        )}
      >
        {/* 20×20 circle with brand-orange fill + white check */}
        <span
          className="flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-full"
          style={{ backgroundColor: 'var(--plan-action-approve-icon-bg)' }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--plan-action-approve-icon-fg)"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </span>
        <span className="min-w-0 flex-1 text-14 font-normal text-[var(--plan-action-approve-text)]">
          {t('newChat.planReview.approve')}
        </span>
        {/* ⏎ 提示只在非编辑态显示 —— 编辑反馈时 Enter 归编辑器所有,同时避免与
             反馈行的发送 ⏎ 出现两个一模一样的回车图标 (issue #475 自测反馈)。
             ml-auto 兜底:即便某天 flex-1 被覆盖也能把 ↵ 推到最右;
             translate-y 补偿视觉重心。 */}
        {!isEditing && (
          <CornerDownLeft
            size={16}
            className="ml-auto shrink-0 translate-y-[0.5px] text-[var(--plan-action-approve-enter)]"
          />
        )}
      </button>

      {/* Feedback Row */}
      {isEditing ? (
        <div className="p-3">
          <div
            data-testid="interaction-answer-composer"
            className={cn(
              'flex w-full min-w-0 gap-2 rounded-lg border border-[var(--plan-card-border)] bg-[var(--chat-input-bg)] focus-within:border-[var(--chat-input-border-focus)]',
              composerExpanded ? 'flex-col p-3' : 'items-end py-2 pl-3 pr-2',
            )}
          >
            <ListComposerTextarea
              ref={inputRef}
              value={displayedFeedback}
              readOnly={voiceLocked}
              onChange={(e) => {
                feedbackRef.current = e.target.value;
                setFeedback(e.target.value);
              }}
              onInput={handleFeedbackInput}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void handleSubmitFeedback();
                }
                if (e.key === 'Escape') {
                  if (voiceRef.current.isBusy || voiceSubmitRef.current) return;
                  e.preventDefault();
                  setIsEditing(false);
                  setFeedback('');
                }
              }}
              onBlur={() => {
                // Keep editing state even on blur — users may click back in.
                // Only collapse when there is no content at all and dictation is idle.
                if (!feedbackRef.current && !voiceRef.current.isBusy) setIsEditing(false);
              }}
              placeholder={t('newChat.planReview.feedbackPlaceholder')}
              rows={1}
              disabled={submitted}
              className={cn(
                'min-h-[22px] min-w-0 resize-none bg-transparent text-14 outline-none',
                // One line beside the 30px actions; centred on them by the margin.
                composerExpanded ? 'w-full' : 'my-[3px] flex-1',
                'text-[var(--plan-action-fb-text)]',
                'placeholder:text-[var(--plan-action-fb-placeholder)]',
                // 22 ÷ 14:与 text-14 等比,随 UI 字号缩放(auto-grow 上限按计算值取)
                'leading-[1.571]',
                submitted && 'cursor-not-allowed opacity-60',
              )}
            />
            <div className={cn('flex items-center justify-end gap-2', composerExpanded ? 'w-full' : 'shrink-0')}>
              <VoiceInputButton
                {...voice.buttonProps}
                testId="plan-feedback-voice"
                sendTargetRef={sendButtonRef}
                canReleaseToSend={!submitted && !voiceSubmitting}
                releaseToSendActive={voiceReleaseToSendActive}
                onReleaseToSendChange={setVoiceReleaseToSendActive}
                onStopAndSend={handleSubmitFeedback}
              />
              <Tip
                text={
                  voiceReleaseToSendActive
                    ? t('newChat.chatInput.voiceInput.releaseToSend')
                    : t('newChat.planReview.submitFeedbackAria')
                }
              >
                <SendButton
                  ref={sendButtonRef}
                  highlighted={voiceReleaseToSendActive}
                  onClick={() => void handleSubmitFeedback()}
                  disabled={submitted || voiceSubmitting || (!voice.isBusy && !hasFeedbackText)}
                  ariaLabel={t('newChat.planReview.submitFeedbackAria')}
                />
              </Tip>
            </div>
          </div>
          <FieldVoiceInputNotice
            error={voice.lastError}
            speakerFiltered={voice.speakerFiltered}
            className="mt-2"
          />
        </div>
      ) : (
        <div className="flex w-full items-center gap-2 pr-3">
          <button
            type="button"
            disabled={submitted}
            onClick={handleFeedbackRowClick}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-2.5 px-4 py-3.5 text-left',
              'transition-colors hover:bg-[var(--plan-action-row-hover-bg)]',
              submitted && 'cursor-not-allowed opacity-60 hover:bg-transparent',
            )}
          >
            <Pencil size={16} className="shrink-0 text-[var(--plan-action-fb-icon)]" />
            <span className="flex-1 text-14 font-normal text-[var(--plan-action-fb-placeholder)]">
              {t('newChat.planReview.feedbackPlaceholder')}
            </span>
          </button>
          <VoiceInputButton
            testId="plan-feedback-voice"
            state="idle"
            disabled={submitted}
            shortcutLabel={voice.shortcutLabel}
            emptyComposer
            stopPropagation
            onStart={handleCollapsedVoiceStart}
            onStop={() => undefined}
          />
        </div>
      )}
    </div>
  );
}
