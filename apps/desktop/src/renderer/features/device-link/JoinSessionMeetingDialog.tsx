import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { meetingHostPeer, type SessionMeetingDetail } from '@cindy/device-link';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/contexts/AuthContext';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { Session } from '@/lib/ccAgent.types';
import { toast } from '@/lib/toast';
import { remoteProjectsStore } from './remoteProjectsStore';
import { bindSharedTaskPushOwner } from '@/lib/remoteDataOwnerPushFence';
import { sessionMeetingErrorKey } from './sessionMeetingCompatibility';

/** Invitation secrets remain in this form and the authenticated Main request only. */
export function JoinSessionMeetingDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { dataOwnerId, isAuthenticated } = useAuth();
  const ownerGeneration = getDataOwnerGeneration().generation;
  const [invitation, setInvitation] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [request, setRequest] = useState<{ meetingId: string; memberId: string; status: 'joined' } | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current++;
    setInvitation(''); setDisplayName(''); setRequest(null); setError(false);
    pending.current = false; setBusy(false);
    return () => { epoch.current++; };
  }, [dataOwnerId, ownerGeneration]);
  const run = async (work: (current: () => boolean) => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    const captured = epoch.current;
    const owner = getDataOwnerGeneration();
    const current = () => captured === epoch.current && isDataOwnerGenerationCurrent(owner);
    try { await work(current); }
    catch (error) { if (current()) toast.error(t(sessionMeetingErrorKey(error))); }
    finally { if (captured === epoch.current) { pending.current = false; setBusy(false); } }
  };
  const join = () => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(invitation.trim()) || !displayName.trim()) {
      setError(true); input.current?.focus(); return;
    }
    setError(false);
    void run(async (current) => {
      const result = await window.electronAPI.sessionMeeting.account({ action: 'join', invitation: invitation.trim(), displayName: displayName.trim() }) as NonNullable<typeof request>;
      if (current()) { setInvitation(''); setRequest(result); }
    });
  };
  const openTask = () => void run(async (current) => {
    const detail = await window.electronAPI.sessionMeeting.account({ action: 'get', meetingId: request!.meetingId }) as SessionMeetingDetail;
    if (!current()) return;
    const peer = meetingHostPeer(detail.meetingId);
    bindSharedTaskPushOwner(peer, detail.ownerAccountId);
    await window.electronAPI.deviceLink.openLink(peer);
    if (!current()) return;
    const session = await window.electronAPI.deviceLink.invoke(peer, 'local-db:sessions:get', [detail.sessionId]) as Session;
    if (!current() || session?.id !== detail.sessionId) return;
    remoteProjectsStore.setDeviceSessions(peer, detail.title, [session]);
    navigate('/cc-agent/' + encodeURIComponent(session.id));
    onOpenChange(false);
  });
  return <Dialog.Root open={open} onOpenChange={(value) => { if (!pending.current) onOpenChange(value); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-[10001] w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 space-y-4 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4 text-[var(--text-primary)]"
        onOpenAutoFocus={(event) => { event.preventDefault(); input.current?.focus(); }}
        onEscapeKeyDown={(event) => { if (pending.current) event.preventDefault(); }}
        onInteractOutside={(event) => { if (pending.current) event.preventDefault(); }}>
        <Dialog.Title className="text-15 font-medium">{t('sessionMeeting.join')}</Dialog.Title>
        <Dialog.Description className="text-13 text-[var(--text-secondary)]">{t('sessionMeeting.joinHint')}</Dialog.Description>
        {!isAuthenticated ? <p className="text-13">{t('sessionMeeting.login')}</p> : request?.status === 'joined' ? <Button loading={busy} onClick={openTask}>{t('sessionMeeting.openTask')}</Button> : <>
            {request && <p className="text-13" role="status">{t('sessionMeeting.notJoined')}</p>}
            <FormField label={t('sessionMeeting.invitation')} error={error ? t('sessionMeeting.invalid') : undefined} reserveFeedback>
              {(props) => <Input {...props} inputRef={input} value={invitation} onChange={setInvitation} disabled={busy} autoComplete="off" />}
            </FormField>
            <FormField label={t('sessionMeeting.nickname')}>
              {(props) => <Input {...props} value={displayName} onChange={setDisplayName} disabled={busy} maxLength={128} />}
            </FormField>
            <Button loading={busy} onClick={join}>{t('sessionMeeting.requestJoin')}</Button>
          </>}
        <div className="flex justify-end"><Button variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>{t('sessionMeeting.dismiss')}</Button></div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
