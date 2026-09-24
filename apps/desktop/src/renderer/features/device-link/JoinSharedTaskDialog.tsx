import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Check, Users, X } from 'lucide-react';
import { sharedTaskHostPeer, type SharedTaskDetail, type SharedTaskOwnedItem, type SharedTaskCloseResult, type SharedTaskListItem } from '@cindy/device-link';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input, Textarea } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useAuth } from '@/contexts/AuthContext';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { Session } from '@/lib/ccAgent.types';
import { toast } from '@/lib/toast';
import { remoteProjectsStore, isRemoteDeviceMarkedDisconnected } from './remoteProjectsStore';
import { bindSharedTaskPushOwner } from '@/lib/remoteDataOwnerPushFence';
import { sharedTaskErrorKey } from './sharedTaskCompatibility';
import { SharedTaskExitDialog, type SharedTaskExitTarget } from './SharedTaskExitDialog';

/** Invitation secrets remain in this form and the authenticated Main request only. */
export function JoinSharedTaskDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { dataOwnerId, isAuthenticated } = useAuth();
  const ownerGeneration = getDataOwnerGeneration().generation;
  const [invitation, setInvitation] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [request, setRequest] = useState<{ sharedTaskId: string; memberId: string; status: 'joined' } | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [joinedTitle, setJoinedTitle] = useState('');
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [owned, setOwned] = useState<SharedTaskOwnedItem[] | null>(null);
  const [ownedError, setOwnedError] = useState(false);
  const [tab, setTab] = useState<'join' | 'joined'>('join');
  const [joinedTasks, setJoinedTasks] = useState<SharedTaskListItem[] | null>(null);
  const [joinedError, setJoinedError] = useState(false);
  const [leaveTarget, setLeaveTarget] = useState<SharedTaskExitTarget | null>(null);
  const joinedRequest = useRef(0);
  const joinedLoading = useRef<number | null>(null);
  const [closeTargets, setCloseTargets] = useState<SharedTaskOwnedItem[] | null>(null);
  const keepSharing = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const epoch = useRef(0);
  const loadOwned = useCallback(async () => {
    const captured = epoch.current;
    const owner = getDataOwnerGeneration();
    setOwnedError(false);
    try {
      const items = await window.electronAPI.sharedTask.account({ action: 'owned' }) as SharedTaskOwnedItem[];
      if (captured === epoch.current && isDataOwnerGenerationCurrent(owner)) setOwned(items);
    } catch {
      if (captured === epoch.current && isDataOwnerGenerationCurrent(owner)) { setOwned(null); setOwnedError(true); }
    }
  }, []);
  const loadJoined = useCallback(async () => {
    const captured = epoch.current;
    if (joinedLoading.current === captured) return;
    joinedLoading.current = captured;
    const sequence = ++joinedRequest.current;
    const owner = getDataOwnerGeneration();
    const current = () => sequence === joinedRequest.current && captured === epoch.current && isDataOwnerGenerationCurrent(owner);
    try {
      const items = await window.electronAPI.sharedTask.account({ action: 'list' }) as SharedTaskListItem[];
      if (!Array.isArray(items)) throw new Error('Invalid shared task list');
      if (current()) { setJoinedTasks(items); setJoinedError(false); }
    } catch {
      if (current()) setJoinedError(true);
    } finally {
      if (sequence === joinedRequest.current) joinedLoading.current = null;
    }
  }, []);
  useEffect(() => {
    epoch.current++;
    setInvitation(''); setDisplayName(''); setRequest(null); setError(false);
    setJoinedTitle(''); setConfirmLeave(false);
    setOwned(null); setOwnedError(false); setCloseTargets(null);
    setTab('join'); setJoinedTasks(null); setJoinedError(false); setLeaveTarget(null);
    pending.current = false; setBusy(false);
    if (open && isAuthenticated) { void loadOwned(); void loadJoined(); }
    return () => { epoch.current++; };
  }, [dataOwnerId, ownerGeneration, open, isAuthenticated, loadOwned, loadJoined]);
  useEffect(() => {
    if (!open || !isAuthenticated || tab !== 'joined' || leaveTarget) return;
    const refresh = () => { if (!pending.current) void loadJoined(); };
    refresh();
    const timer = setInterval(refresh, 5_000);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer); window.removeEventListener('focus', refresh);
      joinedRequest.current++; joinedLoading.current = null;
    };
  }, [open, isAuthenticated, tab, leaveTarget, loadJoined]);
  useEffect(() => {
    if (closeTargets) keepSharing.current?.focus();
    else if (open && !request && tab === 'join') form.current?.querySelector('textarea')?.focus();
  }, [closeTargets, open, request, tab]);
  const run = async (work: (current: () => boolean) => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    const captured = epoch.current;
    const owner = getDataOwnerGeneration();
    const current = () => captured === epoch.current && isDataOwnerGenerationCurrent(owner);
    try { await work(current); }
    catch (error) { if (current()) toast.error(t(sharedTaskErrorKey(error))); }
    finally { if (captured === epoch.current) { pending.current = false; setBusy(false); } }
  };
  const join = () => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(invitation.trim()) || !displayName.trim()) {
      setError(true); form.current?.querySelector('textarea')?.focus(); return;
    }
    setError(false);
    void run(async (current) => {
      let result: NonNullable<typeof request>;
      try {
        result = await window.electronAPI.sharedTask.account({ action: 'join', invitation: invitation.trim(), displayName: displayName.trim() }) as NonNullable<typeof request>;
      } catch (error) {
        if (current()) toast.error(t(sharedTaskErrorKey(error, 'join')));
        return;
      }
      if (current()) { setInvitation(''); setRequest(result); }
      if (!current()) return;
      const detail = await window.electronAPI.sharedTask.account({ action: 'get', sharedTaskId: result.sharedTaskId }) as SharedTaskDetail;
      if (current()) setJoinedTitle(detail.title);
    });
  };
  const openTask = (sharedTaskId: string) => void run(async (current) => {
    const detail = await window.electronAPI.sharedTask.account({ action: 'get', sharedTaskId }) as SharedTaskDetail;
    if (!current()) return;
    const peer = sharedTaskHostPeer(detail.sharedTaskId, detail.hostDeviceId);
    const existing = remoteProjectsStore.getMergedRemoteSessions().find(session => session.id === detail.sessionId && session.deviceLinkDeviceId === peer);
    if (existing && !isRemoteDeviceMarkedDisconnected(peer)) {
      navigate('/cc-agent/' + encodeURIComponent(existing.id));
      onOpenChange(false);
      return;
    }
    bindSharedTaskPushOwner(peer, detail.ownerAccountId);
    await window.electronAPI.deviceLink.openLink(peer);
    if (!current()) return;
    const session = await window.electronAPI.deviceLink.invoke(peer, 'local-db:sessions:get', [detail.sessionId]) as Session;
    if (!current() || session?.id !== detail.sessionId) return;
    remoteProjectsStore.setDeviceSessions(peer, detail.title, [session]);
    navigate('/cc-agent/' + encodeURIComponent(session.id));
    onOpenChange(false);
  });
  const closeOwned = () => void run(async (current) => {
    if (!closeTargets || !current()) return;
    const failed: SharedTaskOwnedItem[] = [];
    let closed = 0;
    // Only close the tasks displayed in the confirmation, including on retry.
    for (const item of closeTargets) {
      if (!current()) return;
      try {
        const result = await window.electronAPI.sharedTask.account({ action: 'close', sharedTaskId: item.sharedTaskId }) as SharedTaskCloseResult;
        if (!current()) return;
        if (result.closed.includes(item.sharedTaskId)) closed++;
        else failed.push(item);
      } catch {
        if (!current()) return;
        failed.push(item);
      }
    }
    setOwned(failed);
    setCloseTargets(failed.length ? failed : null);
    window.dispatchEvent(new Event('cindy:shared-task-owned-changed'));
    if (closed) toast.success(t('sharedTask.closedToast', { count: closed }));
    if (failed.length) toast.error(t('sharedTask.closeFailedToast', { count: failed.length }));
    else void loadOwned();
  });
  return <Dialog.Root open={open} onOpenChange={(value) => { if (!pending.current) onOpenChange(value); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-[10001] max-h-[calc(100dvh-32px)] w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4 text-[var(--text-primary)]"
        onOpenAutoFocus={(event) => {
          const input = form.current?.querySelector('textarea');
          if (input) { event.preventDefault(); input.focus(); }
        }}
        onEscapeKeyDown={(event) => {
          if (pending.current || closeTargets) event.preventDefault();
          if (!pending.current && closeTargets) setCloseTargets(null);
        }}
        onInteractOutside={(event) => { if (pending.current || closeTargets) event.preventDefault(); }}>
        <div className="mb-4 flex items-center justify-between gap-2">
          <Dialog.Title className="text-18 font-medium">{t(closeTargets ? 'sharedTask.closeAllTitle' : request ? 'sharedTask.title' : tab === 'joined' ? 'sharedTask.joinedSection' : 'sharedTask.join')}</Dialog.Title>
          {closeTargets ? <Button variant="secondary" size="lg" className="w-9 border-transparent bg-transparent p-0" aria-label={t('sharedTask.closeAllCancel')} disabled={busy}
            onClick={() => setCloseTargets(null)}><X size={18} aria-hidden /></Button>
            : <Dialog.Close asChild>
              <Button variant="secondary" size="lg" className="w-9 border-transparent bg-transparent p-0" aria-label={t('sharedTask.dismiss')} disabled={busy}><X size={18} aria-hidden /></Button>
            </Dialog.Close>}
        </div>
        {isAuthenticated && !request && !closeTargets && <div className="-mx-4 mb-4 flex flex-wrap gap-1.5 border-b border-[var(--border-default)] px-4 pb-3">
          <Button variant="secondary" size="lg" aria-pressed={tab === 'join'} disabled={busy} className={`px-3 text-12 ${tab === 'join' ? 'bg-[var(--surface-chip)]' : 'border-transparent'}`} onClick={() => setTab('join')}>{t('sharedTask.joinTab')}</Button>
          <Button variant="secondary" size="lg" aria-pressed={tab === 'joined'} disabled={busy} className={`px-3 text-12 ${tab === 'joined' ? 'bg-[var(--surface-chip)]' : 'border-transparent'}`} onClick={() => setTab('joined')}>
            {t('sharedTask.joinedTab')}{joinedTasks !== null && <span className="ml-1 text-11 text-[var(--text-secondary)]">{joinedTasks.length}</span>}
          </Button>
        </div>}
        <Dialog.Description className={request ? 'sr-only' : 'mb-4 text-13 text-[var(--text-secondary)]'}>{t(closeTargets ? 'sharedTask.closeAllJoinBody' : request ? 'sharedTask.joinedBody' : tab === 'joined' ? 'sharedTask.joinedIntro' : 'sharedTask.joinIntro', { count: closeTargets?.length ?? 0 })}</Dialog.Description>
        {closeTargets && <div>
          <div className="max-h-56 overflow-y-auto rounded-xl border border-[var(--border-default)]">{closeTargets.map((item, index) => <div key={item.sharedTaskId} className={index ? 'border-t border-[var(--border-default)] p-3' : 'p-3'}>
            <p className="break-words text-13 font-medium">{item.title}</p>
            <p className="text-12 text-[var(--text-secondary)]">{t(item.local ? 'sharedTask.thisDevice' : 'sharedTask.otherDevice')}</p>
          </div>)}</div>
          <p className="mt-4 text-12 text-[var(--text-secondary)]">{t('sharedTask.closeAllScopeNote')}</p>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <Button ref={keepSharing} variant="secondary" size="lg" disabled={busy} onClick={() => setCloseTargets(null)}>{t('sharedTask.closeAllKeep')}</Button>
            <Button variant="primary" size="lg" loading={busy} onClick={closeOwned}
              className="h-auto min-h-9 max-w-full whitespace-normal border-transparent bg-[hsl(var(--destructive))] py-1.5 text-[var(--accent-pure-cta-fg)] enabled:hover:border-transparent enabled:active:border-transparent enabled:hover:bg-[hsl(var(--destructive))] enabled:active:bg-[hsl(var(--destructive))]">
              {t('sharedTask.closeAllJoinAction')}
            </Button>
          </div>
        </div>}
        <div hidden={!!closeTargets}>
        {!isAuthenticated ? <p className="text-13">{t('sharedTask.login')}</p>
          : request?.status === 'joined' ? <>
              <div className="px-1 py-6 text-center">
                <span className="mb-4 inline-flex size-11 items-center justify-center rounded-full border border-[var(--border-default)]"><Check size={18} aria-hidden /></span>
                <h3 className="break-words text-14 font-medium">{joinedTitle ? t('sharedTask.joinedTitle', { title: joinedTitle }) : t('sharedTask.joined')}</h3>
                <p className="mx-auto mb-5 mt-2 max-w-[280px] text-12 text-[var(--text-secondary)]">{t('sharedTask.joinedBody')}</p>
                <Button variant="cta" size="lg" loading={busy} onClick={() => openTask(request.sharedTaskId)}>{t('sharedTask.enterTask')}</Button>
              </div>
              <div className="border-t border-[var(--border-default)] pt-4"><Button variant="secondary" size="lg" className="w-full text-[var(--error-fg)]" disabled={busy} onClick={() => setConfirmLeave(true)}>{t('sharedTask.leave')}</Button></div>
            </>
          : <>
          {tab === 'joined' && <div>
            {joinedError && <div className="mb-4 flex items-center justify-between gap-3 text-13" role="status">
              <p>{t('sharedTask.joinedLoadFailed')}</p>
              <Button variant="secondary" disabled={busy} onClick={() => void loadJoined()}>{t('sharedTask.retryAction')}</Button>
            </div>}
            {joinedTasks === null ? !joinedError && <p role="status" className="text-13 text-[var(--text-secondary)]">{t('sharedTask.loadingOwned')}</p>
              : joinedTasks.length === 0 ? <div className="py-6 text-center">
                <p className="text-14 font-medium">{t('sharedTask.joinedEmptyTitle')}</p>
                <p className="mt-2 text-12 text-[var(--text-secondary)]">{t('sharedTask.joinedEmptyHint')}</p>
              </div>
              : <div className="overflow-hidden rounded-xl border border-[var(--border-default)]">{joinedTasks.map((item, index) => <div key={item.sharedTaskId}
                  className={`flex flex-wrap items-center gap-3 p-3 ${index ? 'border-t border-[var(--border-default)]' : ''}`}>
                <Users size={18} className="shrink-0" aria-hidden />
                <div className="min-w-0 flex-1"><p className="break-words text-13 font-medium">{item.title}</p><p className="text-12 text-[var(--text-secondary)]">{t('sharedTask.roleGuest')}</p></div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="lg" disabled={busy} className="px-3 text-12" onClick={() => openTask(item.sharedTaskId)}>{t('sharedTask.openTask')}</Button>
                  <Button variant="secondary" size="lg" disabled={busy} className="px-3 text-12 text-[var(--error-fg)]"
                    onClick={() => setLeaveTarget({ kind: 'leave', sharedTaskId: item.sharedTaskId, title: item.title, peer: sharedTaskHostPeer(item.sharedTaskId, item.hostDeviceId) })}>{t('sharedTask.leaveShort')}</Button>
                </div>
              </div>)}</div>}
          </div>}
          <div hidden={tab !== 'join'}>
            <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-[var(--border-default)] p-3">
              <div className="min-w-0"><p className="text-13">{t('sharedTask.ownedTitle')}</p>
                <p className="text-11 text-[var(--text-secondary)]" role="status">{t(ownedError ? 'sharedTask.ownedLoadFailed' : owned === null ? 'sharedTask.loadingOwned' : owned.length ? 'sharedTask.ownedActiveCount' : 'sharedTask.ownedNone', { count: owned?.length ?? 0 })}</p>
              </div>
              {ownedError ? <Button variant="secondary" disabled={busy} className="px-3 text-12" onClick={() => void loadOwned()}>{t('sharedTask.retryAction')}</Button>
                : <Button variant="secondary" className="px-3 text-12" disabled={busy || !owned?.length} onClick={() => setCloseTargets([...(owned ?? [])])}>{t('sharedTask.closeAllShort')}</Button>}
            </div>
            <form ref={form} className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (!closeTargets) join(); }}>
              {request && <p className="text-13" role="status">{t('sharedTask.notJoined')}</p>}
              <FormField label={t('sharedTask.invitation')} error={error ? t('sharedTask.invalid') : undefined}>
                {(props) => <Textarea {...props} rows={3} className="min-h-[82px]" surface="ivory" value={invitation} onChange={setInvitation} disabled={busy} placeholder={t('sharedTask.invitationPlaceholder')} autoComplete="off" />}
              </FormField>
              <FormField label={t('sharedTask.joinNickname')}>
                {(props) => <Input {...props} value={displayName} onChange={setDisplayName} disabled={busy} maxLength={32} placeholder={t('sharedTask.nicknamePlaceholder')} />}
              </FormField>
              <div className="flex items-start gap-2 rounded-lg bg-[var(--surface-chip)] p-3 text-12 text-[var(--text-secondary)]">
                <Users size={16} className="mt-0.5 shrink-0" />
                <p>{t('sharedTask.joinNotice')}</p>
              </div>
              <div className="flex justify-end pt-1"><Button type="submit" variant="cta" size="lg" loading={busy}>{t('sharedTask.join')}</Button></div>
            </form></div></>}
        </div>
        {leaveTarget && <SharedTaskExitDialog target={leaveTarget} onDismiss={() => setLeaveTarget(null)} onComplete={() => {
          joinedRequest.current++; joinedLoading.current = null;
          setJoinedTasks(items => items?.filter(item => item.sharedTaskId !== leaveTarget.sharedTaskId) ?? null);
          setLeaveTarget(null);
        }} />}
        <ConfirmDialog presentation="standard" cancelFirst open={confirmLeave} onOpenChange={(value) => { if (!pending.current) setConfirmLeave(value); }}
          title={t('sharedTask.leaveTitle')} description={t('sharedTask.leaveBody')} cancelText={t('sharedTask.leaveKeep')}
          confirmText={t('sharedTask.leave')} confirmVariant="destructive" loading={busy} zIndex={10002} maxWidth={440}
          onConfirm={() => void run(async (current) => {
            await window.electronAPI.sharedTask.account({ action: 'leave', sharedTaskId: request!.sharedTaskId });
            if (current()) { setRequest(null); setJoinedTitle(''); setConfirmLeave(false); }
          })} />
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
