import { useEffect, useState } from 'react';
import { ArrowLeft, AtSign } from 'lucide-react';
import type { ChatMaskOriginal } from '@cindy/maker-shared/botGroupChat';
import { useTranslation } from 'react-i18next';
import { ChromeIconButton } from '@/components/title-bar/ChromeIconButton';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Button } from '@/components/ui/button';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { MentionRow } from './BotGroupThreadHint';
import { maskIdentity, type GroupMaskMention } from './groupMaskPresentation';

interface Props {
  groupId: string;
  onLocate(entry: GroupMaskMention): boolean;
}

export function GroupMentionHistoryButton({ groupId, onLocate }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const title = t('bots.groupChat.mask.catchup.title');
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverAnchor asChild><span style={WINDOW_NO_DRAG_STYLE}>
      <ChromeIconButton aria-label={title} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        <AtSign size={15} aria-hidden />
      </ChromeIconButton>
    </span></PopoverAnchor>
    <PopoverContent align="end" aria-label={title} className="max-h-[min(420px,80vh)] w-[380px] max-w-[calc(100vw-32px)] overflow-y-auto p-2">
      {open && <HistoryPage groupId={groupId} onLocate={entry => { if (!onLocate(entry)) return false; setOpen(false); return true; }} />}
    </PopoverContent>
  </Popover>;
}

function HistoryPage({ groupId, onLocate }: Props) {
  const { t } = useTranslation();
  const [request, setRequest] = useState<{ before?: string }>({});
  const [originalId, setOriginalId] = useState<string>();
  const [entries, setEntries] = useState<GroupMaskMention[]>([]);
  const [next, setNext] = useState<string>();
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    const owner = getDataOwnerGeneration();
    let active = true;
    async function load() {
      setStatus('loading');
      try {
        const page = await window.electronAPI.maker.chatServer.mentions?.({ groupId, history: true, before: request.before });
        if (!active || !isDataOwnerGenerationCurrent(owner)) return;
        if (!page?.ok) throw new Error('MENTIONS_UNAVAILABLE');
        const rows = page.mentions.map(m => ({ ...m, reply: m.reply && { ...m.reply, companion: maskIdentity(m.reply.companion) } }));
        setEntries(previous => request.before ? [...previous, ...rows] : rows);
        setNext(page.hasMore ? page.mentions.at(-1)?.sequence : undefined);
        setStatus('ready');
      } catch {
        if (active && isDataOwnerGenerationCurrent(owner)) setStatus('error');
      }
    }
    void load();
    return () => { active = false; };
  }, [groupId, request]);
  if (originalId) return <OriginalMessage groupId={groupId} messageId={originalId} onBack={() => setOriginalId(undefined)} />;
  return <>
    <h3 className="px-2 py-1.5 text-13 font-medium">{t('bots.groupChat.mask.catchup.title')}</h3>
    {entries.map(entry => <MentionRow key={entry.messageId} entry={entry} unread={false}
      onLocate={() => { if (!onLocate(entry)) setOriginalId(entry.messageId); }} />)}
    {status === 'loading' && <Spinner />}
    {status === 'error' && <Button variant="secondary" onClick={() => setRequest({ ...request })}>{t('commonUi.retry')}</Button>}
    {status === 'ready' && !entries.length && <p className="px-2 py-3 text-13 text-[var(--text-secondary)]">{t('bots.groupChat.sidebar.empty')}</p>}
    {status === 'ready' && next && <Button variant="secondary" onClick={() => setRequest({ before: next })}>{t('bots.groupChat.timeline.loadEarlier')}</Button>}
  </>;
}

function OriginalMessage({ groupId, messageId, onBack }: { groupId: string; messageId: string; onBack(): void }) {
  const { t } = useTranslation();
  const [original, setOriginal] = useState<ChatMaskOriginal | null>();
  useEffect(() => {
    const owner = getDataOwnerGeneration();
    let active = true;
    const accept = (message: ChatMaskOriginal | null) => {
      if (active && isDataOwnerGenerationCurrent(owner)) setOriginal(message);
    };
    const request = window.electronAPI.maker.chatServer.mentions?.({ groupId, originalId: messageId });
    if (request) void request.then(response => accept(response.ok && response.original?.messageId === messageId ? response.original : null))
      .catch(() => accept(null));
    else accept(null);
    return () => { active = false; };
  }, [groupId, messageId]);
  return <div className="space-y-2 px-2 pb-2">
    <Button variant="secondary" tone="quiet" size="md" compact autoFocus onClick={onBack}>
      <ArrowLeft size={14} aria-hidden />{t('bots.groupChat.mask.catchup.title')}
    </Button>
    {original === undefined && <Spinner />}
    {original === null || original?.deleted
      ? <p role="status" className="text-13 text-[var(--text-secondary)]">{t(original?.deleted ? 'bots.groupChat.quote.deleted' : 'bots.groupChat.quote.unavailable')}</p>
      : original && <article className="space-y-1" data-mention-original={original.messageId}>
          <h4 className="break-words text-13 font-medium">{original.authorName}</h4>
          <p className="whitespace-pre-wrap break-words text-13 leading-normal text-[var(--text-primary)]">{original.text}</p>
        </article>}
  </div>;
}
