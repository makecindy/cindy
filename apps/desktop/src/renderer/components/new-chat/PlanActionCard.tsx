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
 *   Feedback Row  — pencil icon + placeholder → becomes an inline editor.
 *                   Enter with text → onRespond(false, feedback). The ⏎ send
 *                   affordance only appears when there is text, and is a real
 *                   button (click submits).
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

import { cn } from '@/lib/utils';
import { ListComposerTextarea } from './ListComposerTextarea';

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
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleApprove = useCallback(() => {
    if (submitted) return;
    setSubmitted(true);
    onRespond(requestId, true);
  }, [requestId, onRespond, submitted]);

  const handleSubmitFeedback = useCallback(() => {
    if (submitted) return;
    const trimmed = feedback.trim();
    if (!trimmed) return;
    setSubmitted(true);
    onRespond(requestId, false, trimmed);
  }, [feedback, requestId, onRespond, submitted]);

  const handleCancel = useCallback(() => {
    if (submitted || !onCancel) return;
    setSubmitted(true);
    onCancel(requestId);
  }, [requestId, onCancel, submitted]);

  /**
   * Minor #8: auto-grow the textarea as the user types so long feedback isn't
   * clipped to a single line. Capped at ~6 rows to avoid eating the whole
   * viewport — beyond that the built-in overflow kicks in.
   */
  const handleFeedbackInput = useCallback((e: React.FormEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
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

  // Enable the feedback row by clicking it
  const handleFeedbackRowClick = useCallback(() => {
    if (submitted) return;
    setIsEditing(true);
    // Focus after the textarea mounts
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [submitted]);

  // Global Enter-to-approve / Escape-to-cancel (only when not in the feedback
  // editor — the editor owns both keys there).
  // Mirrors the AskUserQuestionPrompt global-keyboard pattern.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isEditing || submitted) return;
      // Avoid hijacking keys when any other input / textarea / button /
      // contenteditable on the page has focus — e.g. the search bar, toolbar
      // buttons, settings forms, etc.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'BUTTON' ||
        (target && (target as HTMLElement).isContentEditable)
      ) {
        return;
      }
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

  const hasFeedbackText = feedback.trim().length > 0;

  return (
    <div
      className={cn(
        'flex w-full max-w-[914px] flex-col overflow-hidden rounded-[12px] border',
        'border-[var(--plan-card-border)] bg-[var(--plan-card-bg)]',
      )}
    >
      {/* Approve Row */}
      <button
        type="button"
        onClick={handleApprove}
        disabled={submitted}
        className={cn(
          'flex w-full items-center gap-[10px] border-b px-[16px] py-[14px] text-left',
          'border-[var(--plan-action-row-divider)]',
          'transition-colors hover:bg-[var(--plan-action-row-hover-bg)]',
          submitted && 'cursor-not-allowed opacity-60 hover:bg-transparent',
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
        <div className="flex items-start gap-[10px] px-[16px] py-[14px]">
          <Pencil
            size={16}
            className="mt-[2px] shrink-0 text-[var(--plan-action-fb-icon)]"
          />
          <ListComposerTextarea
            ref={inputRef}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onInput={handleFeedbackInput}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleSubmitFeedback();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setIsEditing(false);
                setFeedback('');
              }
            }}
            onBlur={() => {
              // Keep editing state even on blur — users may click back in.
              // Only collapse when there is no content at all.
              if (!feedback) setIsEditing(false);
            }}
            placeholder={t('newChat.planReview.feedbackPlaceholder')}
            rows={1}
            disabled={submitted}
            className={cn(
              'flex-1 resize-none bg-transparent text-14 outline-none',
              'text-[var(--plan-action-fb-text)]',
              'placeholder:text-[var(--plan-action-fb-placeholder)]',
              // 22 ÷ 14:与 text-14 等比,随 UI 字号缩放(auto-grow 上限按计算值取)
              'leading-[1.571]',
              submitted && 'cursor-not-allowed opacity-60',
            )}
          />
          {/* 发送 ⏎:有文字才出现,且是真按钮(点击即发送)。textarea 的 onBlur 在
               mousedown 后、click 前触发会把空文本行折叠掉,但有文字时行保持展开,
               点击顺序安全。 */}
          {hasFeedbackText && (
            <button
              type="button"
              onClick={handleSubmitFeedback}
              disabled={submitted}
              aria-label={t('newChat.planReview.submitFeedbackAria')}
              className="ml-auto mt-[2px] shrink-0 rounded p-0 transition-opacity hover:opacity-75"
            >
              <CornerDownLeft
                size={16}
                className="translate-y-[0.5px] text-[var(--plan-action-approve-text)]"
              />
            </button>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={handleFeedbackRowClick}
          className={cn(
            'flex w-full items-center gap-[10px] px-[16px] py-[14px] text-left',
            'transition-colors hover:bg-[var(--plan-action-row-hover-bg)]',
          )}
        >
          <Pencil size={16} className="shrink-0 text-[var(--plan-action-fb-icon)]" />
          <span className="flex-1 text-14 font-normal text-[var(--plan-action-fb-placeholder)]">
            {t('newChat.planReview.feedbackPlaceholder')}
          </span>
        </button>
      )}

    </div>
  );
}
