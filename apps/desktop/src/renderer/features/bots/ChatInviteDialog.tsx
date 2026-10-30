import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { BotGroupMemberView, ChatInvitePreview } from '../../../shared/botGroupChat';
import { BotAvatar } from './BotAvatar';
import { refreshBotGroups } from './botGroupStore';
import { chatErrorKey } from './chatError';

const key = (name: string) => `bots.groupChat.server.${name}`;
const api = () => window.electronAPI.maker.chatServer;

/**
 * Without `groupId` this joins a group: either from a clicked invitation
 * (`initialLink`, previewed immediately, no paste field) or from a pasted link.
 * `malformedLink` reports a clicked link whose token could not be read.
 */
export function ChatInviteDialog({ groupId, initialLink = '', malformedLink = false, created = false, members = [], onClose, onJoined }: {
  groupId?: string; initialLink?: string; malformedLink?: boolean; created?: boolean; onClose: () => void; onJoined?: (id: string, configureMask?: boolean) => void;
  members?: readonly BotGroupMemberView[];
}) {
  const { t, i18n } = useTranslation();
  const [configureMask, setConfigureMask] = useState(false);
  const [maskSupported, setMaskSupported] = useState(false);
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
  const [busy, setBusy] = useState(!!groupId || (fromLink && !malformedLink));
  const [copied, setCopied] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const operation = useRef(crypto.randomUUID());
  const revokeOperation = useRef(crypto.randomUUID());
  const contentRef = useRef<HTMLDivElement>(null);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (groupId && link && document.activeElement === contentRef.current) copyButtonRef.current?.focus();
  }, [groupId, link]);
  // Generate outgoing links on open; received invitations still require acceptance.
  useEffect(() => { if ((fromLink && !malformedLink) || groupId) void run(); }, []);
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
    : !groupId && expiry === null && preview?.reusable === true ? t(key('reusableLink'))
    : expired ? t(key('expiredLink'))
    : typeof expiry === 'string' && Number.isFinite(Date.parse(expiry))
      ? t(key('singleUseUntil'), { date: new Date(expiry).toLocaleString(i18n.language) }) : '';
  const canRevoke = reusable !== undefined && typeof api().revokeInvite === 'function' && !revokeUnsupported;
  async function run(action: 'main' | 'revoke' | 'copy' = 'main') {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    const owner = getDataOwnerGeneration();
    const current = () => mounted.current && isDataOwnerGenerationCurrent(owner);
    // Only read-only previews may retry after an owner-generation update.
    const reading = action === 'main' && !groupId && !preview;
    try {
      if (action === 'copy') {
        setCopied(false);
        if (expired || (typeof expiry === 'string' && Date.parse(expiry) <= Date.now()) || revoked || !link) return;
        await navigator.clipboard.writeText(link);
        if (current()) setCopied(true);
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
        setCopied(false);
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
        const status = await api().status().catch(() => undefined);
        if (!current()) return;
        setMaskSupported(status?.personalMask === true);
        setPreview(result); setNow(Date.now());
      } else {
        if (expired || (typeof expiry === 'string' && Date.parse(expiry) <= Date.now())) return;
        const result = await api().acceptInvite({ link, clientId: operation.current });
        if (!current()) return;
        if (!result.ok) {
          if (['INVITATION_NOT_FOUND', 'INVITATION_UNAVAILABLE'].includes(result.errorCode)) { setPreview(null); setUnusable(fromLink); }
          setError(t(chatErrorKey(result.errorCode))); return;
        }
        refreshBotGroups();
        if (configureMask && maskSupported) onJoined?.(result.groupId, true); else onJoined?.(result.groupId);
        onClose();
      }
    } catch {
      if (current()) { setRevokeConfirm(false); setError(t(key(action === 'copy' ? 'copyFailed' : 'requestFailed'))); }
    }
    finally {
      busyRef.current = false;
      // Clear transient UI even when the request's owner generation changed.
      if (mounted.current) {
        setBusy(false);
        if (action === 'revoke') setRevokeConfirm(false);
        if (reading && !isDataOwnerGenerationCurrent(owner)) void run();
      }
    }
  }
  const title = t(key(groupId ? created ? 'groupCreated' : 'invite' : 'join'));
  const creator = members.find(member => member.isSelf);
  // Allow dismissal during link generation, but not acceptance or revocation.
  const locked = () => busyRef.current && (revokeConfirm || (!groupId && !(fromLink && !preview)));
  return <Dialog.Root open onOpenChange={open => !open && !locked() && onClose()}>
    <Dialog.Portal><Dialog.Overlay className="modal-scrim fixed inset-0 z-[70]" />
      <Dialog.Content ref={contentRef} onPointerDownOutside={e => e.preventDefault()}
        onOpenAutoFocus={e => { if (groupId) { e.preventDefault(); contentRef.current?.focus(); } }}
        onEscapeKeyDown={e => { if (e.isComposing || e.keyCode === 229 || locked()) e.preventDefault(); }}
        className={cn('modal-panel fixed inset-0 z-[71] m-auto flex h-fit max-h-[85vh] flex-col outline-none',
          groupId && created ? 'w-[min(420px,calc(100vw-32px))]' : 'w-[min(460px,calc(100vw-32px))]',
          groupId ? 'gap-5 p-6' : 'gap-4 p-5')}>
        {groupId ? <div className="flex flex-col items-center gap-3 pt-1 text-center">
          <div aria-hidden className="flex items-center">
            {creator && <span className="flex rounded-full border-2 border-[var(--confirm-bg)]">
              <BotAvatar bot={creator} size="md" />
            </span>}
            {/* Opaque backing beneath the theme's translucent chip fill. */}
            <span className={cn('relative flex h-11 w-11 rounded-full border-2 border-[var(--confirm-bg)] bg-[var(--confirm-bg)] text-[var(--text-secondary)]', creator && '-ml-3')}>
              <span className="flex h-full w-full items-center justify-center rounded-full border border-dashed border-[var(--text-tertiary)] bg-[var(--surface-chip)]">
                <Plus size={20} strokeWidth={1.6} />
              </span>
            </span>
          </div>
          <div className="flex flex-col gap-2">
            <Dialog.Title className="text-20 font-medium text-[var(--confirm-title)]">{title}</Dialog.Title>
            <Dialog.Description className="text-13 leading-normal text-[var(--text-secondary)]">{t(key('inviteFriends'))}</Dialog.Description>
          </div>
        </div> : <>
          <Dialog.Title className="text-18 font-medium text-[var(--confirm-title)]">{title}</Dialog.Title>
          <Dialog.Description className="text-13 leading-normal text-[var(--confirm-desc)]">{t(key(fromLink ? 'linkDescription' : 'joinDescription'))}</Dialog.Description>
        </>}
        {groupId && busy && !link && <p role="status" className="text-13 text-[var(--text-secondary)]">{t(key('generatingLink'))}</p>}
        {!fromLink && (!groupId || link) && <Input aria-label={t(key('inviteLink'))} value={link} readOnly={!!groupId} disabled={busy || revoked}
          size={groupId ? 'md' : 'lg'} inputClassName={groupId ? 'text-12 text-[var(--text-secondary)]' : undefined}
          placeholder={t(key('pasteLink'))} onChange={value => { setLink(value); setPreview(null); setError(''); operation.current = crypto.randomUUID(); }} />}
        {!groupId && preview && maskSupported && <label className="flex min-h-10 items-center justify-between gap-4 text-13">
          <span>{t('bots.groupChat.mask.joinSetup')}</span><Switch checked={configureMask} disabled={busy} onCheckedChange={setConfigureMask} aria-label={t('bots.groupChat.mask.joinSetup')} />
        </label>}
        {fromLink && !preview && !error && <p role="status" className="text-13 leading-normal text-[var(--text-secondary)]">{t(key('loadingInvite'))}</p>}
        {preview && <div className="space-y-1 rounded-lg bg-[var(--surface-elevated)] p-3">
          <p className="text-15 font-medium text-[var(--text-primary)]">{preview.name}</p>
          <p className="text-13 text-[var(--text-secondary)]">{t(key('invitedBy'), { name: preview.inviterName })}</p>
        </div>}
        {validity && <p role="status" className="text-13 leading-normal text-[var(--text-secondary)]">{validity}</p>}
        {!created && groupId && link && !revoked && !expired && !canRevoke && <p className="text-13 leading-normal text-[var(--text-secondary)]">{t(key('revokeUnsupported'))}</p>}
        {error && <p role="alert" className="text-13 text-[var(--error-fg)]">{error}</p>}
        <div className={cn('flex flex-wrap justify-end gap-2', groupId && 'pt-1')}>
          <Button variant="secondary" palette="confirmation" size="lg" compact={!!groupId && !created} disabled={locked()} onClick={onClose}>{t('bots.close')}</Button>
          {!created && groupId && link && !revoked && !expired && <Button variant="secondary" palette="confirmation" size="lg" compact disabled={busy || !canRevoke} onClick={() => setRevokeConfirm(true)}>{t(key('revokeLink'))}</Button>}
          {groupId && link && !expired && !revoked
            ? <Button ref={copyButtonRef} variant="cta" palette="confirmation" size="lg" compact={!created} loading={busy} onClick={() => void run('copy')}>{t(key(copied ? 'copied' : 'copyLink'))}</Button>
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
