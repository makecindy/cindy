/**
 * AskUserQuestionBubble
 * ---------------------------------------------------------------------------
 * Surfaces answered AskUserQuestion calls back into the chat stream as Q/A
 * pairs, so the original prompt and the user's answer remain visible together
 * after the agent moves on.
 *
 * Only the *answered* state reaches the stream: pending questions live in the
 * bottom input overlay, and expired/unanswered ones have no selection worth
 * showing. Those states are filtered out in MessageStream.buildRenderItems —
 * we also guard defensively here.
 *
 * Answer shapes covered:
 *   - single-select option       → plain label string
 *   - single-select custom input → plain typed string
 *   - multi-select               → JSON array string (multiple items)
 * Multiple selected items render as separate lines under the same A row.
 * Skipped/empty answers render a muted localized placeholder.
 *
 * Design reference: AskUserQuestion answered card — compact Q/A prefix style.
 */

import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { ChatMessage } from '@/lib/makerChatStore';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AskUserQuestionBubbleProps {
  message: ChatMessage;
}

interface QuestionAnswerPair {
  question: string;
  answerItems: string[];
  skipped: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Decode one stored answer into its individual selected items. Multi-select is
 * persisted as a JSON array string (selected labels + optional custom text) →
 * one item each. Everything else (single label / custom text) is a single
 * plain-string item. Empty/whitespace entries are dropped.
 */
function parseAnswerItems(answer: string): string[] {
  const trimmed = answer.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map((it) => String(it).trim()).filter((s) => s !== '');
    }
  } catch {
    // Not JSON — a plain label / custom string.
  }
  return [trimmed];
}

function buildQuestionAnswerPairs(message: ChatMessage): QuestionAnswerPair[] {
  const {
    askUserQuestions: questions,
    askUserAnswers: answersMap,
    askUserReply: legacyReply,
  } = message;

  if (questions && questions.length > 0) {
    return questions.map((q) => {
      const rawAnswer = answersMap?.[q.question] ?? '';
      const answerItems = parseAnswerItems(rawAnswer);
      return {
        question: q.question,
        answerItems,
        skipped: answerItems.length === 0,
      };
    });
  }

  if (legacyReply == null) return [];

  const answerItems = parseAnswerItems(legacyReply);
  return [
    {
      question: message.content.trim(),
      answerItems,
      skipped: answerItems.length === 0,
    },
  ];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AskUserQuestionBubble({ message }: AskUserQuestionBubbleProps) {
  const { t } = useTranslation();
  const { askUserStatus: status } = message;

  // Defensive: only the answered state is meant to surface in the stream.
  if (status !== 'answered') return null;

  const pairs = buildQuestionAnswerPairs(message);

  if (pairs.length === 0) return null;

  return (
    <div
      data-session-search-body=""
      className={cn(
        'flex w-full min-w-0 flex-col gap-[8px]',
        'rounded-[12px] border border-[var(--border-default)]',
        'bg-[var(--surface-elevated)] p-[14px_16px]',
        'select-text',
      )}
    >
      {pairs.map((pair, index) => (
        <div
          key={index}
          className={cn(
            'flex min-w-0 flex-col gap-[8px]',
            index > 0 && 'border-t border-[var(--border-default)] pt-[8px]',
          )}
        >
          {pair.question && (
            <div className="flex min-w-0 items-start gap-[8px]">
              <span
                data-session-search-ignore=""
                className="mt-[2px] w-[14px] shrink-0 select-none text-11 font-medium leading-[1.4] text-[var(--text-tertiary)]"
              >
                Q
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap text-13 font-normal leading-[1.45] text-[var(--text-secondary)] [overflow-wrap:anywhere]">
                {pair.question}
              </span>
            </div>
          )}

          <div className="flex min-w-0 items-start gap-[8px]">
            <span
              data-session-search-ignore=""
              className="mt-[1px] w-[14px] shrink-0 select-none text-12 font-medium leading-[1.4] text-[var(--text-primary)]"
            >
              ✓
            </span>
            {pair.skipped ? (
              <span className="min-w-0 flex-1 whitespace-pre-wrap text-13 font-medium italic leading-[1.45] text-[var(--text-tertiary)] [overflow-wrap:anywhere]">
                {t('chat.askUserQuestion.skippedAnswer')}
              </span>
            ) : (
              <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
                {pair.answerItems.map((item, itemIndex) => (
                  <span
                    key={itemIndex}
                    className="whitespace-pre-wrap text-13 font-medium leading-[1.45] text-[var(--text-primary)] [overflow-wrap:anywhere]"
                  >
                    {item}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
