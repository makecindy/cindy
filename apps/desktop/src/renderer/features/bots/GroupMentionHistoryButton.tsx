import { useEffect, useState } from 'react';
import { AtSign } from 'lucide-react';
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
  onLocate(entry: GroupMaskMention): void;
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
      <h3 className="px-2 py-1.5 text-13 font-medium">{title}</h3>
      {open && <HistoryPage groupId={groupId} onSelect={entry => { setOpen(false); onLocate(entry); }} />}
    </PopoverContent>
  </Popover>;
}

function HistoryPage({ groupId, onSelect }: { groupId: string; onSelect(entry: GroupMaskMention): void }) {
  const { t } = useTranslation();
  const [request, setRequest] = useState<{ before?: string }>({});
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
  return <>
    {entries.map(entry => <MentionRow key={entry.messageId} entry={entry} unread={false} onLocate={() => onSelect(entry)} />)}
    {status === 'loading' && <Spinner />}
    {status === 'error' && <Button variant="secondary" onClick={() => setRequest({ ...request })}>{t('commonUi.retry')}</Button>}
    {status === 'ready' && !entries.length && <p className="px-2 py-3 text-13 text-[var(--text-secondary)]">{t('bots.groupChat.sidebar.empty')}</p>}
    {status === 'ready' && next && <Button variant="secondary" onClick={() => setRequest({ before: next })}>{t('bots.groupChat.timeline.loadEarlier')}</Button>}
  </>;
}
