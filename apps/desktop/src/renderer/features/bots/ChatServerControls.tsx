import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { UserPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MessageActionBar } from '@/components/chat/MessageActionBar';
import { shareSelectionStore } from '@/components/chat/shareSelectionStore';
import { SHARE_EXCLUDE_ATTR } from '@/lib/shareConversationImage';
import { Tip } from '@/components/ui/tooltip';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { toast } from '@/lib/toast';
import type { BotGroupMessageView, ChatInvitePreview } from '../../../shared/botGroupChat';
import { refreshBotGroups } from './botGroupStore';

const key = (name: string) => `bots.groupChat.server.${name}`;
const api = () => window.electronAPI.maker.chatServer;
const emojiChoices = ['👍', '❤️', '😂', '🎉', '👀', '🙏', '✅', '🤔', '🔥', '👏', '🚀', '💯'];
const iconClass = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-50';
export function chatErrorKey(code: string) {
  if (['INVITATION_NOT_FOUND', 'INVITATION_UNAVAILABLE', 'INVALID_INPUT'].includes(code)) return key('invalidInvite');
  if (code === 'LAST_OWNER') return key('settings.lastOwner');
  if (code === 'REVISION_CONFLICT') return key('settings.conflict');
  if (['FORBIDDEN', 'ROLE_REQUIRED', 'OWNER_REQUIRED', 'ACTOR_NOT_OWNED', 'IDENTITY_DOMAIN_MISMATCH'].includes(code)) return key('notAllowed');
  if (['AUTH_REQUIRED', 'OWNER_CHANGED', 'INVALID_TOKEN', 'TOKEN_EXPIRED'].includes(code)) return key('loginRequired');
  return key('requestFailed');
}

export function ChatMessageActions({ groupId, shareScope, message, align = message.isSelf ? 'right' : 'left', onReply, onChanged }: {
  groupId?: string; shareScope: string; message: BotGroupMessageView; align?: 'left' | 'right'; onReply?: () => void; onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [picker, setPicker] = useState(false);
  async function react(emoji: string, present: boolean) {
    if (!groupId || busyRef.current) return;
    busyRef.current = true; setBusy(true); setPicker(false);
    const owner = getDataOwnerGeneration();
    try {
      const result = await api().react({ groupId, messageId: message.id, emoji, present });
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (!result.ok) toast.error(t(chatErrorKey(result.errorCode)));
      else onChanged();
    } catch { if (isDataOwnerGenerationCurrent(owner)) toast.error(t(key('requestFailed'))); }
    finally { busyRef.current = false; setBusy(false); }
  }
  return (
    <div {...{ [SHARE_EXCLUDE_ATTR]: '' }} className="mt-1 flex flex-col gap-1">
      {!!message.reactions?.length && <div className={`flex flex-wrap items-center gap-1 ${align === 'right' ? 'justify-end' : ''}`}>
        {message.reactions.map(reaction => (
          <Button key={reaction.emoji} variant={reaction.me ? 'primary' : 'secondary'} size="sm" compact
            disabled={busy || !groupId} aria-pressed={reaction.me}
            aria-label={t(key('reactionCount'), { emoji: reaction.emoji, count: reaction.count })}
            onClick={() => void react(reaction.emoji, !reaction.me)}>
            <span>{reaction.emoji}</span><span>{reaction.count}</span>
          </Button>
        ))}
      </div>}
      <MessageActionBar copyText={message.content} createdAt={message.createdAt ? new Date(message.createdAt).toISOString() : undefined}
        align={align} hovered simplifiedBotConversation
        onShareAsImage={() => shareSelectionStore.enter(shareScope, message.id)}
        replyAction={onReply ? { onClick: onReply, count: message.replyCount,
          label: message.replyCount ? t(key('replyCount'), { count: message.replyCount }) : t(key('reply')) } : undefined}
        reactionAction={groupId ? { label: t(key('addReaction')), open: picker, onOpenChange: setPicker, disabled: busy,
          content: <div className="grid grid-cols-6 gap-1">{emojiChoices.map(emoji =>
            <button type="button" key={emoji} className={iconClass} aria-label={emoji}
              onClick={() => void react(emoji, !message.reactions?.some(r => r.emoji === emoji && r.me))}>{emoji}</button>)}</div>,
        } : undefined} />
    </div>
  );
}

function InviteDialog({ groupId, onClose, onJoined }: { groupId?: string; onClose: () => void; onJoined?: (id: string) => void }) {
  const { t } = useTranslation();
  const [link, setLink] = useState('');
  const [preview, setPreview] = useState<ChatInvitePreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const operation = useRef(crypto.randomUUID());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function run() {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    const owner = getDataOwnerGeneration();
    const current = () => mounted.current && isDataOwnerGenerationCurrent(owner);
    try {
      if (groupId) {
        const result = await api().createInvite({ groupId, clientId: operation.current });
        if (!current()) return;
        if (!result.ok) { setError(t(chatErrorKey(result.errorCode))); return; }
        setLink(result.link);
      } else if (!preview) {
        const result = await api().previewInvite({ link });
        if (!current()) return;
        if (!result.ok) { setError(t(chatErrorKey(result.errorCode))); return; }
        setPreview(result);
      } else {
        const result = await api().acceptInvite({ link, clientId: operation.current });
        if (!current()) return;
        if (!result.ok) { setError(t(chatErrorKey(result.errorCode))); return; }
        refreshBotGroups(); onJoined?.(result.groupId); onClose();
      }
    } catch { if (current()) setError(t(key('requestFailed'))); }
    finally { busyRef.current = false; if (current()) setBusy(false); }
  }
  const title = t(key(groupId ? 'invite' : 'join'));
  return <Dialog.Root open onOpenChange={open => !busyRef.current && !open && onClose()}>
    <Dialog.Portal><Dialog.Overlay className="modal-scrim fixed inset-0 z-[70]" />
      <Dialog.Content onPointerDownOutside={e => e.preventDefault()}
        onEscapeKeyDown={e => { if (e.isComposing || e.keyCode === 229 || busyRef.current) e.preventDefault(); }}
        className="modal-panel fixed inset-0 z-[71] m-auto flex h-fit max-h-[85vh] w-[min(460px,calc(100vw-32px))] flex-col gap-4 p-5 outline-none">
        <Dialog.Title className="text-18 font-medium text-[var(--confirm-title)]">{title}</Dialog.Title>
        <Dialog.Description className="text-13 leading-normal text-[var(--confirm-desc)]">{t(key(groupId ? 'inviteDescription' : 'joinDescription'))}</Dialog.Description>
        {(!groupId || link) && <Input aria-label={t(key('inviteLink'))} value={link} readOnly={!!groupId} disabled={busy}
          placeholder={t(key('pasteLink'))} onChange={value => { setLink(value); setPreview(null); setError(''); operation.current = crypto.randomUUID(); }} />}
        {preview && <div className="space-y-1 rounded-lg bg-[var(--surface-elevated)] p-3">
          <p className="text-15 font-medium text-[var(--text-primary)]">{preview.name}</p>
          <p className="text-13 text-[var(--text-secondary)]">{t(key('invitedBy'), { name: preview.inviterName })}</p>
        </div>}
        {error && <p role="alert" className="text-13 text-[var(--error-fg)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" palette="confirmation" size="lg" disabled={busy} onClick={onClose}>{t('bots.close')}</Button>
          {groupId && link
            ? <Button variant="cta" palette="confirmation" size="lg" onClick={() => {
                void navigator.clipboard.writeText(link).then(() => toast.success(t(key('copied')))).catch(() => setError(t(key('copyFailed'))));
              }}>{t(key('copyLink'))}</Button>
            : <Button variant="cta" palette="confirmation" size="lg" loading={busy} disabled={!groupId && !link.trim()} onClick={() => void run()}>
                {t(key(groupId ? 'createLink' : preview ? 'accept' : 'previewInvite'))}
              </Button>}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function InviteControl({ groupId, onJoined }: { groupId?: string; onJoined?: (id: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const title = t(key(groupId ? 'invite' : 'join'));
  return <>
    <Tip text={title}><button type="button" className={iconClass} style={WINDOW_NO_DRAG_STYLE} aria-label={title} onClick={() => setOpen(true)}><UserPlus size={16} /></button></Tip>
    {open && <InviteDialog groupId={groupId} onClose={() => setOpen(false)} onJoined={onJoined} />}
  </>;
}
export const ChatInviteButton = InviteControl;
export function ChatJoinButton({ onJoined }: { onJoined: (id: string) => void }) {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let disposed = false;
    const read = () => { void window.electronAPI?.maker?.chatServer?.status().then(status => { if (!disposed) setEnabled(status.enabled); }).catch(() => undefined); };
    read(); const timer = setInterval(read, 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  return enabled ? <InviteControl onJoined={onJoined} /> : null;
}
