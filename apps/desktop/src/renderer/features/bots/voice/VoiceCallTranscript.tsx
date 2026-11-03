import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUpRight, ChevronDown, ListTodo, Phone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { VoiceCallRecord } from '@cindy/maker-core';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { formatSessionDuration } from '@/lib/sessionDurationFormat';
import { formatBotMessageGroupTime } from '../botConversationTimeline';
import { hasVoiceCallContent } from './voiceCallPresentation';
export { visibleVoiceCallMessages } from './voiceCallPresentation';
import './voiceConversation.css';

/** Only the open live transcript ticks; historical cards never start a timer. */
export function VoiceCallDuration({
  record,
  live = false,
}: {
  record: VoiceCallRecord;
  live?: boolean;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live || record.endedAt !== undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live, record.callId, record.endedAt]);
  const seconds = Math.max(0, Math.floor(((record.endedAt ?? now) - record.startedAt) / 1000));
  return (
    <span className="text-11 font-normal tabular-nums text-[var(--text-secondary)]">
      {!live && record.endedAt === undefined
        ? t('bots.voiceMode.callSaved')
        : seconds >= 3600
          ? formatSessionDuration(seconds * 1000, t)
          : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}
    </span>
  );
}

export function VoiceCallTranscript({
  record,
  live = false,
  unsent = '',
  questionDraft = '',
  transcript = '',
  onOpenTask,
}: {
  record?: VoiceCallRecord;
  live?: boolean;
  unsent?: string;
  questionDraft?: string;
  transcript?: string;
  onOpenTask?(clientId: string): void;
}) {
  const { t } = useTranslation();
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  useEffect(() => {
    if (live && follow.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [record, live, unsent, questionDraft, transcript]);
  const lastUser = record?.turns.findLast((turn) => turn.role === 'user');
  // An admitted turn that later failed is already in the saved transcript.
  // Keep its retry action without appending the same original a second time.
  const drafts = [
    {
      key: 'unsent',
      text: lastUser?.failed && lastUser.text === unsent ? '' : unsent,
      label: 'unsent',
    },
    { key: 'question', text: questionDraft, label: 'questionDraft' },
    { key: 'listening', text: transcript, label: 'liveDraft' },
  ].filter((draft) => draft.text);
  return (
    <div className="voice-call-transcript-container">
      <div
        data-voice-call-transcript
        ref={scroll}
        className="voice-call-transcript select-text text-13 leading-relaxed"
        aria-label={t('bots.voiceMode.callRecord')}
        onScroll={(event) => {
          const node = event.currentTarget;
          follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
          if (live) setAwayFromLatest(!follow.current);
        }}
      >
        {live && !record?.turns.length && !drafts.length && (
          <p className="text-[var(--text-tertiary)]">{t('bots.voiceMode.transcriptEmpty')}</p>
        )}
        {record?.turns.map((turn) => {
          const handoff = record.handoffs.find((item) => item.inputId === turn.id);
          return (
            <div key={turn.id} className="voice-call-turn" data-role={turn.role}>
              <p className="sr-only">
                {t(turn.role === 'user' ? 'bots.voiceMode.you' : 'bots.voiceMode.companion')}
              </p>
              <p className="voice-call-turn-body whitespace-pre-wrap text-[var(--text-primary)]">
                {turn.text}
              </p>
              {turn.failed && !handoff && (
                <p className="mt-1 text-12 text-[var(--text-secondary)]">
                  {t('bots.voiceMode.callSendFailed')}
                </p>
              )}
              {handoff && (
                <div className="mt-2 text-12 text-[var(--text-secondary)]">
                  {onOpenTask && (handoff.state === 'accepted' || handoff.state === 'completed') ? (
                    <Button
                      variant="secondary"
                      size="md"
                      compact
                      className="voice-call-task-link"
                      aria-label={t('bots.voiceMode.viewTaskProgress')}
                      onClick={() => onOpenTask(handoff.id)}
                    >
                      <ListTodo size={14} aria-hidden="true" />
                      <span className="min-w-0 whitespace-normal text-left text-12 font-normal">
                        {t('bots.voiceMode.viewTaskProgress')}
                        <span className="ml-2 text-11 text-[var(--text-secondary)]">
                          {t(`bots.voiceMode.handoff.${handoff.state}`)}
                        </span>
                      </span>
                      <ArrowUpRight size={14} aria-hidden="true" />
                    </Button>
                  ) : (
                    <p>{t(`bots.voiceMode.handoff.${handoff.state}`)}</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {drafts.map((draft) => (
          <div
            key={draft.key}
            className="voice-call-turn"
            data-role="user"
            data-voice-call-draft={draft.key}
          >
            <p className="mb-1 text-11 text-[var(--text-tertiary)]">
              <span className="sr-only">{t('bots.voiceMode.you')} · </span>
              {t(`bots.voiceMode.${draft.label}`)}
            </p>
            <p className="voice-call-turn-body whitespace-pre-wrap text-[var(--text-secondary)]">
              {draft.text}
            </p>
          </div>
        ))}
      </div>
      {live && awayFromLatest && (
        <Button
          variant="secondary"
          size="md"
          compact
          className="voice-call-jump"
          onClick={() => {
            if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
            follow.current = true;
            setAwayFromLatest(false);
          }}
        >
          <ArrowDown size={14} aria-hidden="true" />
          {t('chat.jumpToBottom')}
        </Button>
      )}
    </div>
  );
}

/** A single durable timeline entry; expansion never starts capture or inference. */
export function VoiceCallCard({ record }: { record: VoiceCallRecord }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const transcriptId = `voice-history-${record.callId}`;
  if (!hasVoiceCallContent(record)) return null;
  return (
    <div
      data-voice-call-card
      className="voice-call-card rounded-xl border border-[var(--border-default)] bg-[var(--surface)]"
    >
      <Button
        variant="secondary"
        tone="quiet"
        size="md"
        className="voice-call-card-heading justify-start gap-2"
        aria-expanded={open}
        aria-controls={open ? transcriptId : undefined}
        onClick={() => setOpen(!open)}
      >
        <Phone size={15} aria-hidden="true" />
        <span className="text-13 text-[var(--text-primary)]">
          {t('bots.voiceMode.callHistoryTitle')}
        </span>
        <VoiceCallDuration record={record} />
        <time
          className="ml-auto text-11 font-normal text-[var(--text-secondary)]"
          dateTime={new Date(record.startedAt).toISOString()}
        >
          {formatBotMessageGroupTime(record.startedAt, i18n.resolvedLanguage ?? i18n.language)}
        </time>
        <ChevronDown
          size={15}
          aria-hidden="true"
          className={`transition-transform duration-[var(--motion-fast)] motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
        />
      </Button>
      <Collapse open={open} inert={!open}>
        <div id={transcriptId} className="voice-call-card-body">
          <VoiceCallTranscript record={record} />
        </div>
      </Collapse>
    </div>
  );
}

/** The stored input remains verbatim and user-role for provenance/turn ownership.
 * This entry only makes its call origin explicit; it never claims acceptance. */
export function VoiceCallTaskEntry({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <div
      data-voice-call-task
      className="mx-auto w-full max-w-[580px] rounded-xl border border-[var(--border-default)] bg-[var(--surface)] px-4 py-3"
    >
      <p className="mb-2 flex items-center gap-2 text-12 text-[var(--text-secondary)]">
        <ListTodo size={15} aria-hidden="true" />
        {t('bots.voiceMode.taskFromCall')}
      </p>
      <p className="whitespace-pre-wrap break-words text-13 leading-relaxed text-[var(--text-primary)]">
        {text}
      </p>
    </div>
  );
}
