import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import type { ChatInvitePreview } from '../../../shared/botGroupChat';
import { refreshBotGroups } from './botGroupStore';
import { chatErrorKey } from './chatError';

const key = (name: string) => `bots.groupChat.server.${name}`;
const api = () => window.electronAPI.maker.chatServer;

export function ChatInviteDialog({ groupId, initialLink = '', onClose, onJoined }: { groupId?: string; initialLink?: string; onClose: () => void; onJoined?: (id: string) => void }) {
  const { t } = useTranslation();
  const [link, setLink] = useState(initialLink);
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
      } else if (preview.joined) {
        onJoined?.(preview.groupId); onClose();
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
                {t(key(groupId ? 'createLink' : preview ? (preview.joined ? 'openGroup' : 'accept') : 'previewInvite'))}
              </Button>}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
