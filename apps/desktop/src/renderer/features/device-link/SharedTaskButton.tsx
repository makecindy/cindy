import { useCallback, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, Clock, FileText, Link2, Users, X, CircleStop } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  parseSharedTaskPeer, SHARED_TASK_HOST_CHANNEL,
  type SharedTaskCloseResult, type SharedTaskDetail, type SharedTaskHostCommand,
  type SharedTaskHostState, type SharedTaskOwnedItem,
} from '@cindy/device-link';
import type { Session } from '@/lib/ccAgent.types';
import { useAuth } from '@/contexts/AuthContext';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { JoinSharedTaskDialog } from './JoinSharedTaskDialog';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { toast } from '@/lib/toast';
import { resetRemoteDataOwnerPushFence } from '@/lib/remoteDataOwnerPushFence';
import { sharedTaskErrorKey } from './sharedTaskCompatibility';
import { remoteProjectsStore } from './remoteProjectsStore';

type SharedTaskTab = 'current' | 'owned';
type ConfirmState =
  | { kind: 'remove'; memberId: string; name: string; sharedTaskId: string }
  | { kind: 'leave' }
  | { kind: 'closeCurrent'; sharedTaskId: string }
  | { kind: 'closeAll'; targets: SharedTaskOwnedItem[] };

const tabButton = (active: boolean) => `rounded-full px-3 py-1 text-12 leading-5 transition-colors ${
  active ? 'bg-[var(--surface-chip)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover-soft)]'}`;

/** Owner controls use the same task host locally and through own-device control. */
export function SharedTaskButton({ session, dialogControl }: {
  session: Session;
  dialogControl?: { onDismiss: () => void; returnFocus: () => void };
}) {
  const { t } = useTranslation();
  const { dataOwnerId } = useAuth();
  const ownerGeneration = getDataOwnerGeneration().generation;
  const peer = session.deviceLinkDeviceId ? parseSharedTaskPeer(session.deviceLinkDeviceId) : null;
  const guestSharedTaskId = peer?.role === 'host' ? peer.sharedTaskId : undefined;
  const [open, setOpen] = useState(Boolean(dialogControl));
  const [tab, setTab] = useState<SharedTaskTab>('current');
  const [state, setState] = useState<SharedTaskHostState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [owned, setOwned] = useState<SharedTaskOwnedItem[] | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [busy, setBusy] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  useEffect(() => {
    // Rejoining hands off to a second dialog; keep the menu-owned flow mounted until both close.
    if (!open && !joinOpen && dialogControl) {
      dialogControl.onDismiss();
      dialogControl.returnFocus();
    }
  }, [open, joinOpen, dialogControl]);
  const pending = useRef(false);
  const epoch = useRef(0);
  const host = useCallback((command: SharedTaskHostCommand) => session.deviceLinkDeviceId
    ? window.electronAPI.deviceLink.invoke(session.deviceLinkDeviceId, SHARED_TASK_HOST_CHANNEL, [command])
    : window.electronAPI.sharedTask.host(command), [session.deviceLinkDeviceId]);
  const load = useCallback(async (captured: number) => {
    const owner = getDataOwnerGeneration();
    try {
      const result: SharedTaskHostState = guestSharedTaskId
        ? { available: true, detail: await window.electronAPI.sharedTask.account({ action: 'get', sharedTaskId: guestSharedTaskId }) as SharedTaskDetail }
        : await host({ action: 'state', sessionId: session.id }) as SharedTaskHostState;
      if (captured === epoch.current && isDataOwnerGenerationCurrent(owner)) {
        setState(result);
        setLoadError(null);
      }
    } catch (error) {
      if (captured === epoch.current && isDataOwnerGenerationCurrent(owner)) {
        const key = sharedTaskErrorKey(error);
        if (key === 'sharedTask.upgrade') {
          setState({ available: false, detail: null });
          setLoadError(null);
        } else {
          setState(null);
          setLoadError(key);
        }
      }
    }
  }, [guestSharedTaskId, host, session.id]);
  const loadOwned = useCallback(async (captured: number) => {
    const owner = getDataOwnerGeneration();
    try {
      const items = await window.electronAPI.sharedTask.account({ action: 'owned' }) as SharedTaskOwnedItem[];
      if (captured === epoch.current && isDataOwnerGenerationCurrent(owner)) setOwned(Array.isArray(items) ? items : []);
    } catch (error) {
      if (captured === epoch.current && isDataOwnerGenerationCurrent(owner)
          && sharedTaskErrorKey(error) === 'sharedTask.upgrade') setOwned([]);
    }
  }, []);
  const tabRef = useRef<SharedTaskTab>('current');
  useEffect(() => {
    const captured = ++epoch.current;
    setState(null); setLoadError(null); setOwned(null); setConfirm(null); setTab('current');
    tabRef.current = 'current';
    pending.current = false; setBusy(false);
    void load(captured);
    if (!open) return () => { epoch.current++; };
    void loadOwned(captured);
    const timer = setInterval(() => {
      if (pending.current) return;
      void load(captured);
      if (tabRef.current === 'owned') void loadOwned(captured);
    }, 5_000);
    return () => { epoch.current++; clearInterval(timer); };
  }, [dataOwnerId, ownerGeneration, load, loadOwned, open]);
  const switchTab = (next: SharedTaskTab) => {
    tabRef.current = next; setTab(next); setConfirm(null);
    if (next === 'owned') void loadOwned(epoch.current);
  };
  const run = async (work: () => Promise<unknown>, reload = true) => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    const captured = epoch.current;
    const owner = getDataOwnerGeneration();
    const current = () => captured === epoch.current && isDataOwnerGenerationCurrent(owner);
    try { await work(); if (reload && current()) {
      window.dispatchEvent(new Event('cindy:shared-task-owned-changed'));
      await load(captured); void loadOwned(captured);
    } }
    catch (error) { if (current()) toast.error(t(sharedTaskErrorKey(error))); }
    finally { if (captured === epoch.current) { pending.current = false; setBusy(false); } }
  };
  const detail = state?.detail?.status === 'active' ? state.detail : null;
  const invite = () => run(async () => {
    const captured = epoch.current;
    const owner = getDataOwnerGeneration();
    const result = await host({ action: 'invite', sharedTaskId: detail!.sharedTaskId }) as { invitation: string };
    if (captured !== epoch.current || !isDataOwnerGenerationCurrent(owner)) return;
    try {
      await navigator.clipboard.writeText(result.invitation);
    } catch {
      // The invitation already exists. A local clipboard failure is not a shared-state failure.
      if (captured === epoch.current && isDataOwnerGenerationCurrent(owner)) toast.error(t('sharedTask.invitationCopyFailed'));
      return;
    }
    if (captured === epoch.current && isDataOwnerGenerationCurrent(owner)) toast.success(t('sharedTask.invitationCopied'));
  });
  const closeAll = (targets: SharedTaskOwnedItem[]) => run(async () => {
    const captured = epoch.current;
    const owner = getDataOwnerGeneration();
    const current = () => captured === epoch.current && isDataOwnerGenerationCurrent(owner);
    const failed: SharedTaskOwnedItem[] = [];
    let closed = 0;
    for (const item of targets) {
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
    setConfirm(failed.length ? { kind: 'closeAll', targets: failed } : null);
    if (closed) toast.success(t('sharedTask.closedToast', { count: closed }));
    if (failed.length) toast.error(t('sharedTask.closeFailedToast', { count: failed.length }));
  });
  const memberName = (memberId: string, fallback: string) =>
    detail?.memberLabels.find((label) => label.memberId === memberId)?.displayName ?? fallback;
  const confirmCopy = (state: ConfirmState): { title: string; body: string; keep: string; action: string; danger?: boolean; run(): void } => {
    switch (state.kind) {
      case 'remove':
        return { title: t('sharedTask.removeNamedTitle', { name: state.name }), body: t('sharedTask.removeBody'), keep: t('sharedTask.removeKeep'), action: t('sharedTask.remove'),
          run: () => void run(async () => { await host({ action: 'remove', sharedTaskId: state.sharedTaskId, memberId: state.memberId }); setConfirm(null); }) };
      case 'leave':
        return { title: t('sharedTask.leaveTitle'), body: t('sharedTask.leaveBody'), keep: t('sharedTask.leaveKeep'), action: t('sharedTask.leave'),
          run: () => void run(async () => {
            await window.electronAPI.sharedTask.account({ action: 'leave', sharedTaskId: guestSharedTaskId! });
            const peerId = session.deviceLinkDeviceId;
            if (peerId) {
              remoteProjectsStore.removeDevice(peerId);
              resetRemoteDataOwnerPushFence(peerId);
              await window.electronAPI.deviceLink.closeLink(peerId).catch(() => undefined);
            }
            window.dispatchEvent(new Event('cindy:shared-task-owned-changed'));
            setConfirm(null); setOpen(false);
          }, false) };
      case 'closeCurrent':
        return { title: t('sharedTask.closeOneTitle'), body: t('sharedTask.closeOneBody'), keep: t('sharedTask.closeAllKeep'), action: t('sharedTask.close'),
          run: () => void run(async () => { await host({ action: 'close', sharedTaskId: state.sharedTaskId }); setConfirm(null); toast.success(t('sharedTask.closedToast', { count: 1 })); }) };
      case 'closeAll':
        return { title: t('sharedTask.closeAllTitle'), body: t('sharedTask.closeAllBody'), keep: t('sharedTask.closeAllKeep'),
          action: t('sharedTask.closeAllAction', { count: state.targets.length }), danger: true,
          run: () => void closeAll(state.targets) };
    }
  };
  const emptyIcon = (icon: React.ReactNode) => <span className="mb-4 inline-flex size-11 items-center justify-center rounded-full border border-[var(--border-default)]">{icon}</span>;
  const noticeClass = 'my-4 flex items-start gap-2 rounded-lg bg-[var(--surface-chip)] p-3 text-12 text-[var(--text-secondary)]';
  const avatarClass = 'inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--surface-chip)] text-11';
  const currentTab = loadError ? <div className="px-1 py-6 text-center">
      <p className="mb-4 text-[var(--text-secondary)]">{t(loadError)}</p>
      <Button variant="secondary" size="lg" onClick={() => void load(epoch.current)}>{t('sharedTask.retryAction')}</Button>
    </div>
    : !state ? <p className="text-[var(--text-secondary)]">{t('sharedTask.sharing')}</p>
    : !state.available ? <p className="text-[var(--text-secondary)]">{t('sharedTask.upgrade')}</p>
    : !detail && !guestSharedTaskId ? <>
      <p className="mb-4 text-[var(--text-secondary)]">{t('sharedTask.startIntro')}</p>
      <div className="my-2.5 flex items-center gap-2.5 rounded-lg border border-[var(--border-default)] p-3">
        <FileText size={18} className="shrink-0" aria-hidden />
        <div className="min-w-0">
          <div className="break-words text-13 font-medium">{session.title || t('sharedTask.title')}</div>
          <div className="text-11 text-[var(--text-secondary)]">{t(session.deviceLinkDeviceId ? 'sharedTask.runsOnHostDevice' : 'sharedTask.runsOnThisDevice')}</div>
        </div>
      </div>
      <div className={noticeClass}><Users size={16} className="mt-0.5 shrink-0" aria-hidden /><p>{t('sharedTask.inviteNotice')}</p></div>
      <p className="text-12 text-[var(--text-secondary)]">{t('sharedTask.offlineAutoClose')}</p>
      <div className="mt-5"><Button variant="cta" size="lg" className="w-full" loading={busy} onClick={() => void run(() => host({ action: 'open', sessionId: session.id }))}>{t('sharedTask.open')}</Button></div>
    </>
    : detail && guestSharedTaskId ? <>
      <div className="px-1 py-6 text-center">
        {emptyIcon(<Check size={18} aria-hidden />)}
        <h3 className="break-words text-14 font-medium">{t('sharedTask.joinedTitle', { title: detail.title })}</h3>
        <p className="mx-auto mb-5 mt-2 max-w-[280px] text-12 text-[var(--text-secondary)]">{t('sharedTask.joinedBody')}</p>
      </div>
      <div className="border-t border-[var(--border-default)] pt-4"><Button variant="secondary" size="lg" disabled={busy} className="w-full text-[var(--error-fg)]"
        onClick={() => setConfirm({ kind: 'leave' })}>{t('sharedTask.leave')}</Button></div>
    </>
    : detail ? <>
      <div className="mb-2 break-words text-12 text-[var(--text-secondary)]">{detail.title || session.title}</div>
      <div className="my-4 flex items-center gap-3 rounded-lg border border-[var(--border-default)] p-3">
        <Link2 size={18} className="shrink-0" aria-hidden />
        <div className="min-w-0 flex-1 text-12 text-[var(--text-secondary)]">
          <p>{t('sharedTask.inviteBoxTitle')}</p><p>{t('sharedTask.inviteBoxHint')}</p>
        </div>
        <Button variant="cta" size="lg" disabled={busy} className="px-4" onClick={() => void invite()}>{t('sharedTask.invite')}</Button>
      </div>
      <div className="mb-1 mt-4 text-12 text-[var(--text-secondary)]">{t('sharedTask.membersWithLimit', { count: detail.guests.length + 1 })}</div>
      <div className="flex min-h-12 items-center gap-2.5 py-2.5">
        <span className={avatarClass} aria-hidden>{t('sharedTask.me')}</span>
        <div className="min-w-0 flex-1"><div className="text-13 font-medium">{t('sharedTask.me')}</div><div className="text-11 text-[var(--text-secondary)]">{t(session.deviceLinkDeviceId ? 'sharedTask.hostDevice' : 'sharedTask.thisDevice')}</div></div>
        <span className="text-12 text-[var(--text-secondary)]">{t('sharedTask.roleHost')}</span>
      </div>
      {detail.guests.map((member) => {
        const name = memberName(member.memberId, member.accountId);
        return <div key={member.memberId} className="flex min-h-12 items-center gap-2.5 py-2.5">
          <span className={avatarClass} aria-hidden>{Array.from(name)[0]}</span>
          <div className="min-w-0 flex-1"><div className="break-words text-13 font-medium">{name}</div><div className="text-11 text-[var(--text-secondary)]">{t('sharedTask.roleGuest')}</div></div>
          <Button variant="secondary" disabled={busy} className="shrink-0 px-3 text-12 text-[var(--error-fg)]"
            onClick={() => setConfirm({ kind: 'remove', memberId: member.memberId, name, sharedTaskId: detail.sharedTaskId })}>{t('sharedTask.removeShort')}</Button>
        </div>;
      })}
      <div className={noticeClass}><Clock size={16} className="mt-0.5 shrink-0" aria-hidden /><p>{t(session.deviceLinkDeviceId ? 'sharedTask.remoteHostOfflineNote' : 'sharedTask.hostOfflineNote')}</p></div>
      <div className="mt-5 flex justify-center"><Button variant="secondary" size="lg" disabled={busy} className="w-full px-4 text-[var(--error-fg)]"
        onClick={() => setConfirm({ kind: 'closeCurrent', sharedTaskId: detail.sharedTaskId })}>{t('sharedTask.closeCurrent')}</Button></div>
    </>
    : <div className="px-1 py-6 text-center">
      {emptyIcon(<CircleStop size={18} aria-hidden />)}
      <h3 className="text-14 font-medium">{t('sharedTask.hostOfflineTitle')}</h3>
      <p className="mx-auto mb-5 mt-2 max-w-[280px] text-12 text-[var(--text-secondary)]">{t('sharedTask.hostOfflineBody')}</p>
      <Button variant="cta" size="lg" onClick={() => { setOpen(false); setJoinOpen(true); }}>{t('sharedTask.rejoin')}</Button>
    </div>;
  const ownedTab = owned === null ? <p className="text-[var(--text-secondary)]">{t('sharedTask.sharing')}</p>
    : owned.length === 0 ? <div className="px-1 py-6 text-center">
      {emptyIcon(<Check size={18} aria-hidden />)}
      <h3 className="text-14 font-medium">{t('sharedTask.ownedEmptyTitle')}</h3>
      <p className="mx-auto mb-5 mt-2 max-w-[280px] text-12 text-[var(--text-secondary)]">{t('sharedTask.ownedEmptyHint')}</p>
      {!guestSharedTaskId && <Button variant="secondary" size="lg" onClick={() => switchTab('current')}>{t('sharedTask.shareCurrent')}</Button>}
    </div>
    : <>
      <p className="mb-4 text-[var(--text-secondary)]">{t('sharedTask.ownedIntro', { count: owned.length })}</p>
      <div className="my-4 overflow-hidden rounded-xl border border-[var(--border-default)]">
        {owned.map((item, index) => <div key={item.sharedTaskId} className={index
          ? 'flex items-center gap-2.5 border-t border-[var(--border-default)] p-3'
          : 'flex items-center gap-2.5 p-3'}>
          <Users size={18} className="shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="truncate text-13 font-medium">{item.title}</div>
            <div className="text-12 text-[var(--text-secondary)]">{item.local ? t('sharedTask.thisDevice') : t('sharedTask.otherDevice')}
              {item.sharedTaskId === detail?.sharedTaskId && <> · {t('sharedTask.guestCount', { count: detail.guests.length })}</>}
            </div>
          </div>
          {item.sessionId === session.id && item.hostDeviceId === detail?.hostDeviceId
            ? <Button variant="secondary" disabled={busy} className="px-3 text-12" onClick={() => switchTab('current')}>{t('sharedTask.manage')}</Button>
            : <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-11 text-[var(--text-secondary)]">{t('sharedTask.sharingBadge')}</span>}
        </div>)}
      </div>
      <div className="mt-4 border-t border-[var(--border-default)] pt-4 text-12 text-[var(--text-secondary)]">{t('sharedTask.closeAllNote')}</div>
      <div className="mt-5 flex justify-center"><Button variant="secondary" size="lg" disabled={busy} className="w-full gap-2 text-[var(--error-fg)]"
        onClick={() => setConfirm({ kind: 'closeAll', targets: owned.map((item) => ({ ...item })) })}><CircleStop size={18} aria-hidden />{t('sharedTask.closeAll', { count: owned.length })}</Button></div>
    </>;
  const confirmation = confirm ? confirmCopy(confirm) : null;
  return <>
    <Dialog.Root open={open} onOpenChange={(next) => { if (!pending.current) { setOpen(next); if (!next) setConfirm(null); } }}>
      {!dialogControl && <Dialog.Trigger asChild>
        <Button variant="secondary" size="lg" style={WINDOW_NO_DRAG_STYLE} className="ml-2 w-9 bg-transparent p-0" aria-label={t('sharedTask.title')} title={t('sharedTask.title')}>
          <Users size={18} aria-hidden />
        </Button>
      </Dialog.Trigger>}
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[10001] max-h-[calc(100dvh-32px)] w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4 text-[var(--text-primary)]"
          aria-describedby={undefined}
          onCloseAutoFocus={dialogControl ? (event) => { event.preventDefault(); if (!joinOpen) dialogControl.returnFocus(); } : undefined}
          onEscapeKeyDown={(event) => { if (pending.current || confirm) event.preventDefault(); }}
          onInteractOutside={(event) => { if (pending.current || confirm) event.preventDefault(); }}>
          <div className="mb-4 flex items-center justify-between gap-2">
            <Dialog.Title className="text-18 font-medium">{t(guestSharedTaskId && state && !detail ? 'sharedTask.ended' : tab === 'owned' ? 'sharedTask.ownedTitle' : 'sharedTask.title')}</Dialog.Title>
            <Dialog.Close asChild><Button variant="secondary" size="lg" className="w-9 border-transparent bg-transparent p-0" aria-label={t('sharedTask.dismiss')} disabled={busy}><X size={18} aria-hidden /></Button></Dialog.Close>
          </div>
          {!guestSharedTaskId && <div className="-mx-4 mb-4 flex gap-1.5 border-b border-[var(--border-default)] px-4 pb-3">
            <Button variant="secondary" size="lg" className={tabButton(tab === 'current') + ' border-transparent'} aria-pressed={tab === 'current'} disabled={busy} onClick={() => switchTab('current')}>{t('sharedTask.tabCurrent')}</Button>
            <Button variant="secondary" size="lg" className={tabButton(tab === 'owned') + ' border-transparent'} aria-pressed={tab === 'owned'} disabled={busy} onClick={() => switchTab('owned')}>
              {t('sharedTask.tabOwned')}{owned !== null && <span className="ml-1 rounded-full bg-[var(--surface-chip)] px-1.5 text-11 text-[var(--text-secondary)]">{owned.length}</span>}
            </Button>
          </div>}
          <div className="text-13">{tab === 'current' ? currentTab : ownedTab}</div>
          <ConfirmDialog presentation="standard" cancelFirst open={!!confirmation} onOpenChange={(next) => { if (!next && !pending.current) setConfirm(null); }}
            title={confirmation?.title ?? ''} description={confirmation?.body} cancelText={confirmation?.keep} confirmText={confirmation?.action}
            confirmVariant="destructive" descriptionClassName="text-13" loading={busy} zIndex={10002} maxWidth={440} onConfirm={confirmation?.run}
            content={confirm?.kind === 'closeAll' ? <>
              <div className="space-y-2 rounded-lg bg-[var(--surface-chip)] p-3 text-12">
                {confirm.targets.map((item) => <div key={item.sharedTaskId} className="break-words">{item.title} <span className="text-[var(--text-secondary)]">· {item.local ? t('sharedTask.thisDevice') : t('sharedTask.otherDevice')}</span></div>)}
              </div><p className="mt-4 text-12 text-[var(--text-secondary)]">{t('sharedTask.closeAllScopeNote')}</p>
            </> : undefined} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    {joinOpen && <JoinSharedTaskDialog open={joinOpen} onOpenChange={setJoinOpen} />}
  </>;
}
