import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { mailMessageFields, type MailMessage, type MailMessageSummary } from '@cindy/maker-shared/mail-message';
import { mailPreviewImages } from '@cindy/maker-shared/ghost-card-form';
import { MAIL_PAPER_COLOR } from '@cindy/maker-shared/mail-text-edit';
import { GhostCardForm } from '@/components/chat/GhostCardForm';
import { MailHtmlPreview } from '@/components/chat/MailHtmlPreview';
import { useChatSessionFile } from '@/components/chat/ChatSessionFileContext';
import { UserMessageUrlLink } from '@/components/chat/UserMessageUrlLink';
import { findLinkifyMatches } from '@/components/chat/userMessageLinkify';
import { Button } from '@/components/ui/button';
import { MailParticipants, mailAvatarLimits } from './MailParticipant';

type Props = {
  mail: MailMessage;
  openMailbox: ReactNode;
  read: (url: string, opened?: boolean) => Promise<{ message: MailMessage | null | undefined }>;
  retry: () => void;
};

function MessageBody({ mail, avatarLimits }: { mail: MailMessage; avatarLimits: ReturnType<typeof mailAvatarLimits> }) {
  const { t } = useTranslation();
  const fields = mailMessageFields(mail, key => t(`mailReader.${key}`));
  const values = Object.fromEntries(fields.map(f => [f.name, f.value]));
  const { sessionId } = useChatSessionFile();
  const plainBody: ReactNode[] = [];
  if (!mail.bodyHtml) {
    let cursor = 0;
    for (const match of findLinkifyMatches(mail.bodyText).filter(match => match.kind === 'url')) {
      plainBody.push(mail.bodyText.slice(cursor, match.index), <UserMessageUrlLink key={match.index} url={match.text} sessionId={sessionId} />);
      cursor = match.index + match.length;
    }
    plainBody.push(mail.bodyText.slice(cursor));
  }
  return <>
    {mail.markReadFailed && <p role="status" className="mb-2 text-12 text-muted-foreground">{t('mailReader.markReadFailed')}</p>}
    <div className="mb-3 space-y-1 border-b border-border pb-3 text-12 text-muted-foreground">
      {fields.filter(f => f.kind === 'recipients' && f.value.trim()).map(f => <div key={f.name} className="flex gap-2">
        <span className="shrink-0 pt-0.5">{f.label}</span><MailParticipants value={f.value} photos={mail.participantPhotos} avatarLimit={avatarLimits[f.name as 'to' | 'cc' | 'bcc']} />
      </div>)}
    </div>
    {mail.bodyHtml ? <MailHtmlPreview value={mail.bodyHtml} images={mailPreviewImages(values)} reading />
      : <div className="whitespace-pre-wrap break-words p-1 text-14 leading-relaxed text-foreground">{plainBody}</div>}
    <GhostCardForm fields={fields.filter(f => f.kind === 'mail-attachments')} disabled={false} readOnly onChange={() => {}} />
  </>;
}

function MessageRow({ summary, initial, selected, initiallyExpanded, accountId, read }: {
  summary: MailMessageSummary; initial?: MailMessage; selected: boolean; initiallyExpanded: boolean; accountId: string; read: Props['read'];
}) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [message, setMessage] = useState(initial);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (!expanded || (message && !opened)) return;
    let active = true;
    setFailed(false);
    void read(summary.url, opened).then(result => {
      if (!active) return;
      if (!result.message || result.message.accountId !== accountId || result.message.messageId !== summary.messageId) {
        setFailed(true); return;
      }
      setMessage(result.message);
      setOpened(false);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [expanded, message, opened, attempt, read, summary.url, summary.messageId, accountId]);
  const dateText = message?.date || summary.date;
  const date = new Date(dateText);
  const validDate = !Number.isNaN(date.getTime());
  const formatted = validDate ? new Intl.DateTimeFormat(i18n?.language, { dateStyle: 'medium', timeStyle: 'short' }).format(date) : dateText;
  const from = message?.from || summary.from;
  const avatarLimits = mailAvatarLimits({ from, to: message?.to || '', cc: message?.cc || '', bcc: message?.bcc || '' });
  return <section className="my-3 overflow-hidden rounded-xl border border-border bg-[var(--mail-paper)] dark:bg-[var(--surface)]"
    style={{ '--mail-paper': MAIL_PAPER_COLOR } as CSSProperties} data-mail-message-id={summary.messageId}>
    <button type="button" aria-expanded={expanded} aria-label={t(expanded ? 'mailReader.collapseMessage' : 'mailReader.expandMessage', { from })}
      onClick={() => { if (!expanded) setOpened(true); setExpanded(v => !v); }} className="flex min-h-11 w-full items-start gap-2 rounded-lg px-3 py-3 text-left hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
      {expanded ? <ChevronDown className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="min-w-0 text-13 font-medium text-foreground"><MailParticipants value={from || t('mailReader.title')} photos={message?.participantPhotos} compact={false} avatarLimit={avatarLimits.from} /></span>
          <span className="flex items-center gap-2 text-12 text-muted-foreground">
            {selected && <span>{t('mailReader.currentMessage')}</span>}
            {dateText && <time dateTime={validDate ? date.toISOString() : undefined} title={dateText}>{formatted}</time>}
          </span>
        </span>
        {!expanded && <span className="mt-0.5 block truncate text-12 text-muted-foreground">{summary.snippet || summary.subject}</span>}
      </span>
    </button>
    {expanded && <div className="px-3 pb-3 pt-1">
      {message ? <MessageBody mail={message} avatarLimits={avatarLimits} /> : <div className="py-3 text-13 text-muted-foreground" role="status">
        {t(failed ? 'mailReader.failed' : 'mailReader.loading')}
        {failed && <Button className="ml-2" variant="secondary" size="sm" onClick={() => setAttempt(n => n + 1)}>{t('mailReader.retry')}</Button>}
      </div>}
    </div>}
  </section>;
}

/** One chronological reader, no provider-specific UI or eagerly fetched hidden bodies. */
export function MailConversationView({ mail, openMailbox, read, retry }: Props) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const messages = mail.conversation?.messages ?? [{ messageId: mail.messageId, url: '', from: mail.from, date: mail.date, subject: mail.subject, snippet: mail.bodyText.slice(0, 200) }];
  const selectedIndex = messages.findIndex(m => m.messageId === mail.messageId);
  useLayoutEffect(() => {
    const parent = container.current;
    const selected = parent?.querySelector<HTMLElement>('[data-current-mail]');
    if (!parent || !selected || !content.current) return;
    let position = parent.scrollTop;
    let observer: ResizeObserver | undefined;
    const align = () => {
      // Keep the initial selection in view as neighboring bodies finish loading.
      // Once scrolling moves away from our last position, leave control to the user.
      if (parent.scrollTop !== position) { observer?.disconnect(); return; }
      parent.scrollTop += selected.getBoundingClientRect().top - parent.getBoundingClientRect().top;
      position = parent.scrollTop;
    };
    if (typeof ResizeObserver !== 'undefined') observer = new ResizeObserver(align);
    const onScroll = () => { if (parent.scrollTop !== position) observer?.disconnect(); };
    align();
    observer?.observe(content.current);
    parent.addEventListener('scroll', onScroll, { passive: true });
    return () => { observer?.disconnect(); parent.removeEventListener('scroll', onScroll); };
  }, [mail.messageId]);
  const rows: ReactNode[] = [];
  for (let i = 0; i < messages.length;) {
    const visible = (index: number) => messages.length <= 6 || index === 0 || index >= messages.length - 2 ||
      Math.abs(index - selectedIndex) <= 2 || revealed.has(messages[index].messageId);
    if (!visible(i)) {
      const start = i;
      while (i < messages.length && !visible(i)) i++;
      const hidden = messages.slice(start, i);
      rows.push(<div key={`gap-${hidden[0].messageId}`} className="flex items-center gap-3 py-2">
        <span className="h-px flex-1 bg-border" />
        <Button variant="secondary" size="sm" onClick={() => setRevealed(old => new Set([...old, ...hidden.map(m => m.messageId)]))}>
          {t('mailReader.showMessages', { count: hidden.length })}
        </Button><span className="h-px flex-1 bg-border" />
      </div>);
    } else {
      const index = i++;
      const summary = messages[index];
      const selected = summary.messageId === mail.messageId;
      rows.push(<div key={summary.messageId} {...(selected ? { 'data-current-mail': true } : {})}>
        <MessageRow summary={summary} initial={selected ? mail : undefined} selected={selected}
          initiallyExpanded={messages.length <= 6 || Math.abs(index - selectedIndex) <= 2} accountId={mail.accountId} read={read} />
      </div>);
    }
  }
  return <div className="flex h-full min-h-0 flex-col">
    <header className="flex shrink-0 items-start justify-between gap-2 border-b border-border px-4 py-3">
      <div className="min-w-0">
        <h1 className="break-words pt-0.5 text-16 font-medium leading-snug text-foreground">{mail.subject || t('mailReader.title')}</h1>
        {messages.length > 1 && <p className="mt-1 text-12 text-muted-foreground">{t('mailReader.messageCount', { count: messages.length })}</p>}
      </div>{openMailbox}
    </header>
    <div ref={container} className="relative min-h-0 flex-1 overflow-auto px-4 pb-4">
      <div ref={content}>
        {mail.conversationUnavailable && <div role="status" className="py-2 text-12 text-muted-foreground">
          {t('mailReader.conversationFailed')} <Button tone="quiet" compact size="sm" onClick={retry}>{t('mailReader.retry')}</Button>
        </div>}
        {rows}
      </div>
    </div>
  </div>;
}
