import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, ThumbsDown } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { TAB_LABEL_KEY } from '@/lib/tabLabels';
import { askHelp, markMessageFeedbackSubmitted, useHelpThread } from '@/lib/helpThreadStore';
import { createLogger } from '@/lib/logger';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import type { HelpFeedbackDraftInput, HelpLocale, HelpMessage } from '@/../shared/helpTypes';
import { resolveSystemLocale } from '@/../shared/locale';

const log = createLogger('HelpThreadView');

function localeFromI18n(lang: string): HelpLocale {
  return resolveSystemLocale(lang);
}

/**
 * Truncate the question for use in the prefilled feedback-draft title so it
 * stays scannable in any future issue queue. The localized title shell
 * (e.g. "文档缺失:" / "doc gap:") comes from i18n key
 * `settings.help.qnaFeedbackTitleDefault` via t({question}).
 */
function shortenForTitle(question: string): string {
  const trimmed = question.trim().replace(/\s+/g, ' ');
  const cap = 80;
  return trimmed.length > cap ? `${trimmed.slice(0, cap)}…` : trimmed;
}

export function HelpThreadView() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { messages, pending } = useHelpThread();
  const [value, setValue] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const canSend = value.trim().length > 0 && !pending;
  const locale = localeFromI18n(i18n.language);

  // Keep the newest message in view (data-then-render: store is hydrated on
  // module load, so opening the panel renders the full thread already scrolled).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  const send = () => {
    if (!canSend) return;
    const next = value;
    setValue('');
    void askHelp(next, locale);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--settings-bg)]">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <div className="text-14 font-medium leading-[1.4] text-[var(--settings-section-title)]">
              {t('settings.help.threadEmptyTitle')}
            </div>
            <div className="text-13 leading-[1.6] text-[var(--settings-section-sublabel)]">
              {t('settings.help.threadEmptyHint')}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3.5">
            {messages.map((message, index) => {
              const prior = index > 0 ? messages[index - 1] : undefined;
              const priorUserQuestion = prior && prior.role === 'user' ? prior.content : '';
              // Stable id-based key avoids React reusing the same form
              // instance across messages when the array shifts (e.g.
              // truncation dropping older turns shifts every subsequent
              // index by one, which with an index key would carry feedback
              // edit state into the wrong message).
              return (
                <HelpMessageRow
                  key={message.id ?? `idx-${index}`}
                  message={message}
                  priorUserQuestion={priorUserQuestion}
                  locale={locale}
                  onOpenTab={(tab) => navigate(`/settings?tab=${tab}`)}
                />
              );
            })}
            {pending && <PendingBubble label={t('settings.help.qnaPending')} />}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-[var(--settings-theme-card-border)] px-4 py-3">
        <div className="flex items-center gap-2">
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing && canSend) {
                event.preventDefault();
                send();
              }
            }}
            disabled={pending}
            placeholder={t('settings.help.qnaPlaceholder')}
            className="min-w-0 flex-1 rounded-full border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] px-4 py-2 text-13 text-[var(--settings-section-title)] outline-none placeholder:text-[var(--text-tertiary)] disabled:opacity-60"
          />
          <button
            type="button"
            disabled={!canSend}
            onClick={send}
            className={cn(
              'shrink-0 rounded-full px-4 py-2 text-12 font-medium transition-colors',
              canSend
                ? 'bg-[var(--settings-menu-bg-selected)] text-[var(--settings-menu-text-selected)]'
                : 'bg-[var(--surface-chip)] text-[var(--settings-section-sublabel)] opacity-60',
            )}
          >
            {t('settings.help.qnaSend')}
          </button>
        </div>
      </div>
    </div>
  );
}

function HelpMessageRow({
  message,
  priorUserQuestion,
  locale,
  onOpenTab,
}: {
  message: HelpMessage;
  priorUserQuestion: string;
  locale: HelpLocale;
  onOpenTab: (tab: string) => void;
}) {
  const { t } = useTranslation();

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-xl bg-[var(--surface-chip)] px-3.5 py-2.5 text-13 leading-[1.6] text-[var(--settings-section-title)]">
          {message.content}
        </div>
      </div>
    );
  }

  // Empty assistant content is the persisted representation of a no-answer turn.
  const isNoAnswer = message.content.trim().length === 0;
  const action = message.action;
  // The feedback affordance only makes sense when there's a paired user
  // question to put on the draft — guard against a stray assistant-first row.
  const canReport = priorUserQuestion.trim().length > 0;

  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] px-3.5 py-3">
        {isNoAnswer ? (
          <div className="whitespace-pre-wrap break-words text-13 leading-[1.6] text-[var(--settings-section-title)]">
            {t('settings.help.qnaNoAnswer')}
          </div>
        ) : (
          // Help-assistant answers may contain markdown (bold / lists / code spans).
          // Reuse the chat-side renderer so **bold** etc. actually render, instead of
          // showing as literal text. workingDir="" because help replies don't carry
          // session paths; relative-link normalization is a no-op for typical answers.
          <div className="help-md-bubble text-13 leading-[1.6] text-[var(--settings-section-title)]">
            <MarkdownRenderer content={message.content} workingDir="" />
          </div>
        )}
        {action?.kind === 'settings-tab' && (
          <button
            type="button"
            onClick={() => onOpenTab(action.tab)}
            className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-[var(--settings-theme-card-border)] px-3 py-1.5 text-12 font-medium text-[var(--settings-section-title)] transition-colors hover:bg-[var(--settings-menu-bg-hover)]"
          >
            <ArrowUpRight size={12} />
            {t('settings.help.qnaOpenTab', {
              tab:
                action.tab === 'api-keys' || action.tab === 'connections'
                  ? t('sidebar.tabs.plugins')
                  : TAB_LABEL_KEY[action.tab]
                    ? t(TAB_LABEL_KEY[action.tab])
                    : action.tab,
            })}
          </button>
        )}
        {!isNoAnswer && (
          <div className="mt-2 text-11 leading-[1.5] text-[var(--settings-section-sublabel)] opacity-60">
            {t('settings.help.qnaAiDisclaimer')}
          </div>
        )}
        {canReport && message.id && (
          <FeedbackSection
            messageId={message.id}
            question={priorUserQuestion}
            answer={message.content}
            locale={locale}
            existingDraftId={message.feedbackDraftId}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Feedback affordance for an assistant message. Three states, all rendered in
 * the same inline slot (no modal / portal):
 *   - `idle`     : a 👎 "report this answer" button.
 *   - `editing`  : an inline form (title + body + save / cancel).
 *   - `recorded` : a "feedback recorded" chip, terminal state.
 * Once a message has `feedbackDraftId` it stays in `recorded` forever — Phase 1
 * doesn't let users re-flag the same message (the draft lives in main's JSON;
 * the user can edit / submit it later when the GitHub path lands).
 */
function FeedbackSection(props: {
  messageId: string;
  question: string;
  answer: string;
  locale: HelpLocale;
  existingDraftId?: string;
}) {
  const { messageId, question, answer, locale, existingDraftId } = props;
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (existingDraftId) {
    return (
      <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-[var(--surface-chip)] px-2.5 py-1 text-11 text-[var(--settings-section-sublabel)]">
        {t('settings.help.qnaFeedbackRecorded', {
          defaultValue: '✓ Feedback recorded',
        })}
      </div>
    );
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          // Prefill from i18n so the user sees a draft in their own language.
          // The body template's `{{answer}}` slot gets the actual answer text,
          // or a localized placeholder when the assistant returned no-answer.
          const answerForTemplate =
            answer.trim().length > 0
              ? answer
              : t('settings.help.qnaFeedbackNoAnswerPlaceholder', {
                  defaultValue: "(no answer — assistant said it didn't know)",
                });
          setTitle(
            t('settings.help.qnaFeedbackTitleDefault', {
              question: shortenForTitle(question),
              defaultValue: 'doc gap: {{question}}',
            }),
          );
          setBody(
            t('settings.help.qnaFeedbackBodyTemplate', {
              question,
              answer: answerForTemplate,
              locale,
              createdAt: new Date().toISOString(),
              defaultValue:
                '## Question\n{{question}}\n\n## Assistant answer\n{{answer}}\n\n## What I expected / what is wrong\n(add your notes here)\n\n---\nlocale: {{locale}}\nrecorded at: {{createdAt}}',
            }),
          );
          setErrorMsg(null);
          setEditing(true);
        }}
        className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-[var(--settings-theme-card-border)] px-2.5 py-1 text-11 text-[var(--settings-section-sublabel)] transition-colors hover:bg-[var(--settings-menu-bg-hover)] hover:text-[var(--settings-section-title)]"
      >
        <ThumbsDown size={11} />
        {t('settings.help.qnaFeedbackButton', {
          defaultValue: 'Report this answer',
        })}
      </button>
    );
  }

  const canSubmit = title.trim().length > 0 && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setErrorMsg(null);
    const input: HelpFeedbackDraftInput = {
      question,
      answer,
      title: title.trim(),
      body,
      locale,
    };
    try {
      const draft = await window.electronAPI.maker.helpFeedbackCreate(input);
      markMessageFeedbackSubmitted(messageId, draft.id);
      // editing → false is implicit: the row re-renders into the recorded state
      // because the store update flows back through useHelpThread → existingDraftId.
    } catch (err) {
      log.warn('helpFeedbackCreate failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      setErrorMsg(
        t('settings.help.qnaFeedbackErrorToast', {
          defaultValue: 'Failed to save draft — please retry.',
        }),
      );
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-md border border-[var(--settings-theme-card-border)] bg-[var(--surface-chip)] p-2.5">
      <div className="flex flex-col gap-1">
        <label className="text-11 font-medium text-[var(--settings-section-sublabel)]">
          {t('settings.help.qnaFeedbackTitleLabel', { defaultValue: 'Title' })}
        </label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={submitting}
          className="w-full rounded border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] px-2 py-1 text-12 text-[var(--settings-section-title)] outline-none disabled:opacity-60"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-11 font-medium text-[var(--settings-section-sublabel)]">
          {t('settings.help.qnaFeedbackBodyLabel', {
            defaultValue: 'Details (optional)',
          })}
        </label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={submitting}
          rows={8}
          className="w-full resize-y rounded border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] px-2 py-1.5 font-mono text-11 leading-[1.5] text-[var(--settings-section-title)] outline-none disabled:opacity-60"
        />
      </div>
      {errorMsg && <div className="text-11 text-[var(--error-fg)]">{errorMsg}</div>}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setErrorMsg(null);
          }}
          disabled={submitting}
          className="rounded-full px-3 py-1 text-12 text-[var(--settings-section-sublabel)] transition-colors hover:bg-[var(--settings-menu-bg-hover)] disabled:opacity-60"
        >
          {t('settings.help.qnaFeedbackCancel', { defaultValue: 'Cancel' })}
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          className={cn(
            'rounded-full px-3 py-1 text-12 font-medium transition-colors',
            canSubmit
              ? 'bg-[var(--settings-menu-bg-selected)] text-[var(--settings-menu-text-selected)]'
              : 'bg-[var(--surface-chip)] text-[var(--settings-section-sublabel)] opacity-60',
          )}
        >
          {submitting ? (
            <span className="inline-flex items-center gap-1.5">
              <Spinner size={11} />
              {t('settings.help.qnaFeedbackSubmit', { defaultValue: 'Save draft' })}
            </span>
          ) : (
            t('settings.help.qnaFeedbackSubmit', { defaultValue: 'Save draft' })
          )}
        </button>
      </div>
    </div>
  );
}

function PendingBubble({ label }: { label: string }) {
  return (
    <div className="flex justify-start">
      <div className="inline-flex items-center gap-2 rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] px-3.5 py-2.5 text-13 text-[var(--settings-section-sublabel)]">
        <Spinner size={14} />
        {label}
      </div>
    </div>
  );
}
