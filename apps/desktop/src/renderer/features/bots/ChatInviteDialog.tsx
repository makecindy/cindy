import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import type { ChatInvitePreview } from '../../../shared/botGroupChat';
import { refreshBotGroups } from './botGroupStore';
import { chatErrorKey } from './chatError';

const key = (name: string) => `bots.groupChat.server.${name}`;
const api = () => window.electronAPI.maker.chatServer;

/**
 * Without `groupId` this joins a group: either from a clicked invitation
 * (`initialLink`, previewed immediately, no paste field) or from a pasted link.
 * `malformedLink` reports a clicked link whose token could not be read.
 */
export function ChatInviteDialog({ groupId, initialLink = '', malformedLink = false, onClose, onJoined }: {
  groupId?: string; initialLink?: string; malformedLink?: boolean; onClose: () => void; onJoined?: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const fromLink = !groupId && (Boolean(initialLink) || malformedLink);
  const [link, setLink] = useState(initialLink);
  const [expiresAt, setExpiresAt] = useState<string | null | undefined>();
  const [reusable, setReusable] = useState<boolean | undefined>();
  const [revoked, setRevoked] = useState(false);
  const [revokeConfirm, setRevokeConfirm] = useState(false);
  const [revokeUnsupported, setRevokeUnsupported] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [preview, setPreview] = useState<ChatInvitePreview | null>(null);
  const [error, setError] = useState(() => malformedLink ? t(key('malformedInvite')) : '');
  // The server said this invitation cannot be used; asking it again will not help.
  const [unusable, setUnusable] = useState(malformedLink);
  const [busy, setBusy] = useState(fromLink && !malformedLink);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const operation = useRef(crypto.randomUUID());
  const revokeOperation = useRef(crypto.randomUUID());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // A clicked link already expresses the intent to look (once, on open); joining still
  // needs the explicit accept.
  useEffect(() => { if (fromLink && !malformedLink) void run(); }, []);
  const expiry = groupId ? expiresAt : preview?.expiresAt;
  const expired = typeof expiry === 'string' && Date.parse(expiry) <= now;
  useEffect(() => {
    if (groupId && link && expired) operation.current = crypto.randomUUID();
  }, [groupId, link, expired]);
  useEffect(() => {
    if (typeof expiry !== 'string' || !Number.isFinite(Date.parse(expiry))) return;
    const remaining = Date.parse(expiry) - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(remaining, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [expiry, now]);
  const validity = revoked ? t(key('revokedLink'))
    : expiry === null && (groupId ? reusable : preview?.reusable) === true ? t(key('reusableLink'))
    : expired ? t(key('expiredLink'))
    : typeof expiry === 'string' && Number.isFinite(Date.parse(expiry))
      ? t(key('singleUseUntil'), { date: new Date(expiry).toLocaleString(i18n.language) }) : '';
  const canRevoke = reusable !== undefined && typeof api().revokeInvite === 'function' && !revokeUnsupported;
  async function run(action: 'main' | 'revoke' | 'copy' = 'main') {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    const owner = getDataOwnerGeneration();
    const current = () => mounted.current && isDataOwnerGenerationCurrent(owner);
    // Reading an invitation is side-effect free; a result discarded for an older owner
    // generation is simply read again for the current one instead of leaving the dialog loading.
    const reading = action === 'main' && !groupId && !preview;
    try {
      if (action === 'copy') {
        if (expired || (typeof expiry === 'string' && Date.parse(expiry) <= Date.now()) || revoked || !link) return;
        await navigator.clipboard.writeText(link);
        if (current()) toast.success(t(key('copied')));
      } else if (action === 'revoke') {
        if (!groupId || !link || revoked || !canRevoke) return;
        const result = await api().revokeInvite({ groupId, link, clientId: revokeOperation.current });
        if (!current()) return;
        setRevokeConfirm(false);
        if (!result.ok) {
          if (result.errorCode === 'INVITE_REVOKE_UNSUPPORTED') setRevokeUnsupported(true);
          setError(t(chatErrorKey(result.errorCode))); return;
        }
        if (result.revoked !== true) { setError(t(key('requestFailed'))); return; }
        setRevoked(true); operation.current = crypto.randomUUID();
        toast.success(t(key('revokedLink')));
      } else if (groupId) {
        const result = await api().createInvite({ groupId, clientId: operation.current });
        if (!current()) return;
        if (!result.ok) { setError(t(chatErrorKey(result.errorCode))); return; }
        setLink(result.link);
        setExpiresAt(result.expiresAt); setReusable(result.reusable); setNow(Date.now());
        setRevoked(false); setRevokeUnsupported(false); revokeOperation.current = crypto.randomUUID();
      } else if (!preview) {
        const result = await api().previewInvite({ link });
        if (!current()) return;
        if (!result.ok) {
          setUnusable(chatErrorKey(result.errorCode) === key('invalidInvite'));
          setError(t(chatErrorKey(result.errorCode))); return;
        }
        // Already a member: the invitation's only remaining purpose is to open the group.
        if (result.joined) { onJoined?.(result.groupId); onClose(); return; }
        setPreview(result); setNow(Date.now());
      } else {
        if (expired || (typeof expiry === 'string' && Date.parse(expiry) <= Date.now())) return;
        const result = await api().acceptInvite({ link, clientId: operation.current });
        if (!current()) return;
        if (!result.ok) {
          if (['INVITATION_NOT_FOUND', 'INVITATION_UNAVAILABLE'].includes(result.errorCode)) { setPreview(null); setUnusable(fromLink); }
          setError(t(chatErrorKey(result.errorCode))); return;
        }
        refreshBotGroups(); onJoined?.(result.groupId); onClose();
      }
    } catch {
      if (current()) { setRevokeConfirm(false); setError(t(key(action === 'copy' ? 'copyFailed' : 'requestFailed'))); }
    }
    finally {
      busyRef.current = false;
      // Request results belong to their owner generation; transient UI cleanup
      // belongs to the mounted dialog, which can survive a same-owner update.
      if (mounted.current) {
        setBusy(false);
        if (action === 'revoke') setRevokeConfirm(false);
        if (reading && !isDataOwnerGenerationCurrent(owner)) void run();
      }
    }
  }
  const title = t(key(groupId ? 'invite' : 'join'));
  // Reading a clicked invitation changes nothing, so it never traps the user; accepting,
  // creating and revoking still hold the dialog until their result is known.
  const locked = () => busyRef.current && !(fromLink && !preview);
  return <Dialog.Root open onOpenChange={open => !open && !locked() && onClose()}>
    <Dialog.Portal><Dialog.Overlay className="modal-scrim fixed inset-0 z-[70]" />
      <Dialog.Content onPointerDownOutside={e => e.preventDefault()}
        // Portal events still bubble through the sidebar React tree. Keep its
        // blank-area menu from cancelling the input's native edit menu.
        onContextMenu={e => e.stopPropagation()}
        onEscapeKeyDown={e => { if (e.isComposing || e.keyCode === 229 || locked()) e.preventDefault(); }}
        className="modal-panel fixed inset-0 z-[71] m-auto flex h-fit max-h-[85vh] w-[min(460px,calc(100vw-32px))] flex-col gap-4 p-5 outline-none">
        <Dialog.Title className="text-18 font-medium text-[var(--confirm-title)]">{title}</Dialog.Title>
        <Dialog.Description className="text-13 leading-normal text-[var(--confirm-desc)]">{t(key(groupId ? 'inviteDescription' : fromLink ? 'linkDescription' : 'joinDescription'))}</Dialog.Description>
        {!fromLink && (!groupId || link) && <Input aria-label={t(key('inviteLink'))} value={link} readOnly={!!groupId} disabled={busy || revoked}
          placeholder={t(key('pasteLink'))} onChange={value => { setLink(value); setPreview(null); setError(''); operation.current = crypto.randomUUID(); }} />}
        {fromLink && !preview && !error && <p role="status" className="text-13 leading-normal text-[var(--text-secondary)]">{t(key('loadingInvite'))}</p>}
        {preview && <div className="space-y-1 rounded-lg bg-[var(--surface-elevated)] p-3">
          <p className="text-15 font-medium text-[var(--text-primary)]">{preview.name}</p>
          <p className="text-13 text-[var(--text-secondary)]">{t(key('invitedBy'), { name: preview.inviterName })}</p>
        </div>}
        {validity && <p role="status" className="text-13 leading-normal text-[var(--text-secondary)]">{validity}</p>}
        {groupId && link && !revoked && !expired && !canRevoke && <p className="text-13 leading-normal text-[var(--text-secondary)]">{t(key('revokeUnsupported'))}</p>}
        {error && <p role="alert" className="text-13 text-[var(--error-fg)]">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" palette="confirmation" size="lg" disabled={busy && !(fromLink && !preview)} onClick={onClose}>{t('bots.close')}</Button>
          {groupId && link && !revoked && !expired && <Button variant="secondary" palette="confirmation" size="lg" disabled={busy || !canRevoke} onClick={() => setRevokeConfirm(true)}>{t(key('revokeLink'))}</Button>}
          {groupId && link && !expired && !revoked
            ? <Button variant="cta" palette="confirmation" size="lg" loading={busy} onClick={() => void run('copy')}>{t(key('copyLink'))}</Button>
            : (!fromLink || preview || (error && !unusable)) && <Button variant="cta" palette="confirmation" size="lg" loading={busy} disabled={!groupId && (!link.trim() || expired)} onClick={() => void run()}>
                {t(key(groupId ? 'createLink' : preview ? 'accept' : fromLink ? 'retryInvite' : 'previewInvite'))}
              </Button>}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
    <ConfirmDialog open={revokeConfirm} cancelFirst presentation="standard"
      onOpenChange={open => { if (!busyRef.current) setRevokeConfirm(open); }}
      title={t(key('revokeLink'))} description={t(key('revokeDescription'))}
      confirmText={t(key('revokeLink'))} confirmVariant="destructive" loading={busy}
      onConfirm={() => void run('revoke')} />
  </Dialog.Root>;
}
