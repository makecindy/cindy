import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Tip } from '@/components/ui/tooltip';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { ShareSelectionBar } from '@/components/chat/ShareSelectionBar';
import { ShareMessageCheckbox } from '@/components/chat/ShareMessageCheckbox';
import { shareSelectionStore, useShareSelectionActive } from '@/components/chat/shareSelectionStore';
import { SHARE_SESSION_ATTR, SHARE_MESSAGE_ATTR } from '@/lib/shareConversationImage';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import type { BotGroupDetail, BotGroupMention, BotGroupMessageView } from '../../../shared/botGroupChat';
import { resolveBotGroupMentions } from './botGroupMentions';
import { refreshBotGroups } from './botGroupStore';
import { BotAvatar } from './BotAvatar';
import { ChatMessageActions, chatErrorKey } from './ChatServerControls';
const key = (name: string) => `bots.groupChat.server.${name}`;
const api = () => window.electronAPI.maker.chatServer;

function ThreadMessage({ group, message, shareScope, sharing, onChanged }: { group: BotGroupDetail; message: BotGroupMessageView; shareScope: string; sharing: boolean; onChanged: () => void }) {
  const member = group.members.find(m => m.botId === message.authorBotId);
  return <article {...{ [SHARE_SESSION_ATTR]: shareScope, [SHARE_MESSAGE_ATTR]: message.id }}
    className={`relative flex min-w-0 gap-2.5 ${sharing ? 'ml-10' : ''}`}>
    {sharing && <ShareMessageCheckbox clientId={message.id} />}
    <BotAvatar bot={{ name: message.authorName, avatar: member?.avatar ?? null, avatarUrl: member?.avatarUrl, avatarColor: member?.avatarColor ?? null }} size="sm" />
    <div className="min-w-0 flex-1 space-y-1">
      <p className="text-13 font-medium leading-7 text-[var(--text-primary)]">{message.authorName}</p>
      <div className="break-words text-14 leading-relaxed text-[var(--text-primary)]">
        <MarkdownRenderer workingDir="" content={message.content} allowPrivilegedLinks={false} />
      </div>
      <ChatMessageActions groupId={group.id} shareScope={shareScope} message={message} align="left" onChanged={onChanged} />
    </div>
  </article>;
}

export function ChatThreadPanel({ group, rootId, onClose }: { group: BotGroupDetail; rootId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const titleId = useId();
  const shareScope = `bot-group:${group.id}:thread:${rootId}`;
  const sharing = useShareSelectionActive(shareScope);
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    shareSelectionStore.exitIfNotSession(shareScope);
    return () => { if (shareSelectionStore.isActive(shareScope)) shareSelectionStore.exit(); };
  }, [shareScope]);
  const [root, setRoot] = useState<BotGroupMessageView | null>(null);
  const [replies, setReplies] = useState<BotGroupMessageView[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const attempt = useRef<{ text: string; id: string; mentions: BotGroupMention } | null>(null);
  const sending = useRef(false);
  const load = useCallback(async (before?: number) => {
    const version = ++request.current, owner = getDataOwnerGeneration();
    const current = () => version === request.current && isDataOwnerGenerationCurrent(owner);
    try {
      const result = await api().thread({ groupId: group.id, rootId, before });
      if (!current()) return;
      if (!result.ok) { setError(t(chatErrorKey(result.errorCode))); return; }
      setRoot(result.root); setError('');
      setReplies(previous => {
        const merged = new Map(previous.map(m => [m.id, m]));
        for (const message of result.replies) merged.set(message.id, message);
        return [...merged.values()].sort((a, b) => a.sequence - b.sequence);
      });
      if (before || replies.length === 0) setHasMore(result.hasMore);
    } catch { if (current()) setError(t(key('requestFailed'))); }
  }, [group.id, rootId, t, replies.length]);
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => {
    void loadRef.current();
    const stop = window.electronAPI.maker.onBotGroupChanged((event, stamp) => {
      if (isDataOwnerPushCurrent(stamp) && event.groupId === group.id) void loadRef.current();
    });
    return () => { request.current++; stop(); };
  }, [group.id, rootId]);
  async function send() {
    if (group.archived || sending.current || !text.trim()) return;
    sending.current = true; setBusy(true); setError('');
    const owner = getDataOwnerGeneration();
    if (!attempt.current || attempt.current.text !== text) attempt.current = {
      text, id: crypto.randomUUID(),
      mentions: resolveBotGroupMentions(text, { members: group.members, allLabels: [t('bots.groupChat.mention.all'), '所有人', 'all', 'everyone'] }),
    };
    try {
      const result = await api().reply({ groupId: group.id, rootId, text: attempt.current.text, clientId: attempt.current.id,
        mentions: attempt.current.mentions });
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (!result.ok) { setError(t(chatErrorKey(result.errorCode))); return; }
      setText(''); attempt.current = null; void loadRef.current(); refreshBotGroups();
    } catch { if (isDataOwnerGenerationCurrent(owner)) setError(t(key('requestFailed'))); }
    finally { sending.current = false; setBusy(false); }
  }
  return <aside aria-labelledby={titleId}
        className="flex h-full min-w-0 w-1/2 max-w-md shrink-0 flex-col border-l border-[var(--border-default)] bg-[var(--surface)]">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border-default)] px-5">
          <h2 id={titleId} className="text-15 font-medium text-[var(--text-primary)]">{t(key('replies'))}</h2>
          <Tip text={t('bots.close')}>
            <Button autoFocus={group.archived} variant="secondary" tone="quiet" size="md"
              className="w-8 rounded-none px-0 [&::before]:rounded-full"
              aria-label={t('bots.close')} onClick={onClose}><X size={17} aria-hidden /></Button>
          </Tip>
        </header>
        <div ref={contentRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {root && <ThreadMessage shareScope={shareScope} sharing={sharing} group={group} message={root} onChanged={() => void loadRef.current()} />}
          <div className="border-t border-[var(--border-default)] pt-3 text-12 text-[var(--text-tertiary)]">{t(key('replies'))}</div>
          {hasMore && <Button variant="secondary" size="sm" onClick={() => void loadRef.current(replies[0]?.sequence)}>{t('bots.groupChat.timeline.loadEarlier')}</Button>}
          {replies.map(message => <ThreadMessage key={message.id} shareScope={shareScope} sharing={sharing} group={group} message={message} onChanged={() => void loadRef.current()} />)}
        </div>
        {sharing ? <ShareSelectionBar sessionId={shareScope} barWidth="100%"
          getContentWidth={() => contentRef.current?.querySelector('article')?.getBoundingClientRect().width ?? 400} /> : <div className="space-y-3 border-t border-[var(--border-default)] p-4">
          {error && <p role="alert" className="text-13 text-[var(--error-fg)]">{error}</p>}
          <Textarea autoFocus={!group.archived} aria-label={t(key('replyPlaceholder'))} placeholder={t(key('replyPlaceholder'))} value={text} onChange={value => {
            setText(value);
            if (attempt.current?.text !== value) attempt.current = null;
          }}
            rows={3} maxLength={8000} disabled={busy || group.archived} onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void send(); }
            }} />
          <div className="flex justify-end"><Button variant="cta" size="sm" loading={busy} disabled={group.archived || !text.trim()} onClick={() => void send()}>{t(key('sendReply'))}</Button></div>
        </div>}
  </aside>;
}
