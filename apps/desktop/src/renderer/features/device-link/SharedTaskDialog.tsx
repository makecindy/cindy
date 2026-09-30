import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, Check, Clock, FileText, Link2, Users, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  parseSharedTaskPeer, sharedTaskHostPeer, sharedTaskAccountName, SHARED_TASK_HOST_CHANNEL,
  type SharedTaskDetail, type SharedTaskHostCommand,
  type SharedTaskHostState, type SharedTaskListItem, type SharedTaskOwnedItem,
} from '@cindy/device-link';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/input';
import { useAuth } from '@/contexts/AuthContext';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { Session } from '@/lib/ccAgent.types';
import { toast } from '@/lib/toast';
import { bindSharedTaskPushOwner, resetRemoteDataOwnerPushFence } from '@/lib/remoteDataOwnerPushFence';
import { remoteProjectsStore, isRemoteDeviceMarkedDisconnected } from './remoteProjectsStore';
import { sharedTaskErrorKey } from './sharedTaskCompatibility';
import { closeOwnedSharedTask } from './closeOwnedSharedTask';

type Tab = 'join' | 'joined' | 'owned';
type Target = { sessionId: string; title: string; deviceId?: string; sharedTaskId?: string; guestId?: string; connect?: boolean };
type Confirmation =
  | { kind: 'close'; targets: SharedTaskOwnedItem[]; all: boolean }
  | { kind: 'leave'; item: SharedTaskListItem }
  | { kind: 'remove'; target: Target; sharedTaskId: string; memberId: string; name: string; title: string };
type Current = () => boolean;
type Origin = { element: HTMLElement | null; scroll: number; taskId?: string } | null;

function host(target: Target, command: SharedTaskHostCommand) {
  return target.deviceId
    ? window.electronAPI.deviceLink.invoke(target.deviceId, SHARED_TASK_HOST_CHANNEL, [command])
    : window.electronAPI.sharedTask.host(command);
}

/** Both entry points share one window. Confirmations replace its content, not its identity. */
export function SharedTaskDialog({ open, onOpenChange, session, returnFocus, initialInvitation, presentation = 'dialog' }: {
  open: boolean; onOpenChange(open: boolean): void; session?: Session; returnFocus?(): void; initialInvitation?: string; presentation?: 'dialog' | 'settings' | 'join';
}) {
  const embedded = presentation === 'settings';
  const admissionOnly = presentation === 'join';
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { dataOwnerId, isAuthenticated, user } = useAuth();
  const invitationOwner = useRef(getDataOwnerGeneration());
  const autoAttempted = useRef<string | null>(null);
  const ownerGeneration = getDataOwnerGeneration().generation;
  const initialTarget = useMemo<Target | null>(() => {
    if (!session) return null;
    const peer = session.deviceLinkDeviceId && parseSharedTaskPeer(session.deviceLinkDeviceId);
    return { sessionId: session.id, title: session.title || '', deviceId: session.deviceLinkDeviceId,
      guestId: peer && peer.role === 'host' ? peer.sharedTaskId : undefined };
  }, [session?.id, session?.title, session?.deviceLinkDeviceId]);
  const [tab, setTab] = useState<Tab>('join');
  const [target, setTarget] = useState<Target | null>(initialTarget);
  const [state, setState] = useState<SharedTaskHostState | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [owned, setOwned] = useState<SharedTaskOwnedItem[] | null>(null);
  const [joined, setJoined] = useState<SharedTaskListItem[] | null>(null);
  const [listErrors, setListErrors] = useState({ owned: false, joined: false });
  const [invitation, setInvitation] = useState('');
  const [errors, setErrors] = useState<{ invitation?: string }>({});
  const [success, setSuccess] = useState<{ sharedTaskId: string; title: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const epoch = useRef(0);
  const targetEpoch = useRef(0);
  const detailRequest = useRef<{ target: Target; epoch: number; sequence: number } | null>(null);
  const pending = useRef(false);
  const lists = useRef({ owned: { sequence: 0, loading: false }, joined: { sequence: 0, loading: false } });
  const codeInput = useRef<HTMLTextAreaElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const confirmationOrigin = useRef<Origin>(null);
  const detailOrigin = useRef<Origin>(null);

  const loadList = useCallback(async (kind: 'owned' | 'joined') => {
    const slot = lists.current[kind];
    if (slot.loading) return;
    slot.loading = true;
    const sequence = ++slot.sequence;
    const captured = epoch.current;
    const owner = getDataOwnerGeneration();
    const current = () => captured === epoch.current && sequence === slot.sequence && isDataOwnerGenerationCurrent(owner);
    try {
      const items = await window.electronAPI.sharedTask.account({ action: kind === 'owned' ? 'owned' : 'list' });
      if (!Array.isArray(items)) throw new Error('Invalid shared task list');
      if (!current()) return;
      if (kind === 'owned') setOwned(items as SharedTaskOwnedItem[]);
      else setJoined(items as SharedTaskListItem[]);
      setListErrors(previous => ({ ...previous, [kind]: false }));
    } catch {
      if (current()) setListErrors(previous => ({ ...previous, [kind]: true }));
    } finally { if (sequence === slot.sequence) slot.loading = false; }
  }, []);
  const invalidateLists = () => {
    for (const slot of Object.values(lists.current)) { slot.sequence++; slot.loading = false; }
  };
  const loadDetail = useCallback(async (item: Target, connect = false) => {
    const captured = epoch.current;
    if (detailRequest.current?.target === item && detailRequest.current.epoch === captured
        && detailRequest.current.sequence === targetEpoch.current) return;
    const sequence = ++targetEpoch.current;
    detailRequest.current = { target: item, epoch: captured, sequence };
    const owner = getDataOwnerGeneration();
    const current = () => captured === epoch.current && sequence === targetEpoch.current && isDataOwnerGenerationCurrent(owner);
    try {
      if (connect && item.deviceId && !item.guestId) {
        await window.electronAPI.deviceLink.openLink(item.deviceId);
        if (!current()) return;
      }
      const result = item.guestId
        ? { available: true, detail: await window.electronAPI.sharedTask.account({ action: 'get', sharedTaskId: item.guestId }) as SharedTaskDetail }
        : await host(item, { action: 'state', sessionId: item.sessionId }) as SharedTaskHostState;
      if (!current()) return;
      // A list item can expire/reopen while inspected. Do not silently manage its replacement.
      if (result.detail && (result.detail.sessionId !== item.sessionId
          || (item.sharedTaskId && result.detail.sharedTaskId !== item.sharedTaskId))) {
        setState(null); setDetailError('sharedTask.unavailable'); return;
      }
      setState(result); setDetailError(null);
    } catch (error) {
      if (current()) { setState(null); setDetailError(sharedTaskErrorKey(error)); }
    } finally { if (detailRequest.current?.sequence === sequence) detailRequest.current = null; }
  }, []);

  useEffect(() => {
    epoch.current++; targetEpoch.current++; invalidateLists();
    setTab(embedded ? 'owned' : 'join'); setManualOpen(false); setTarget(initialTarget); setState(null); setDetailError(null);
    setOwned(null); setJoined(null); setListErrors({ owned: false, joined: false });
    setInvitation(isDataOwnerGenerationCurrent(invitationOwner.current) ? initialInvitation ?? '' : '');
    setErrors({}); setSuccess(null); setConfirm(null);
    pending.current = false; setBusy(false);
    if (open && isAuthenticated) { void loadList('owned'); void loadList('joined'); }
    return () => { epoch.current++; targetEpoch.current++; invalidateLists(); };
  }, [open, dataOwnerId, ownerGeneration, isAuthenticated, initialTarget, initialInvitation, loadList, embedded]);
  useEffect(() => {
    setState(null); setDetailError(null);
    if (open && target && isAuthenticated) void loadDetail(target, target.connect);
    return () => { targetEpoch.current++; };
  }, [open, target, dataOwnerId, ownerGeneration, isAuthenticated, loadDetail]);
  useEffect(() => {
    if (!open || !isAuthenticated || confirm) return;
    const refresh = () => {
      if (pending.current) return;
      if (target) void loadDetail(target);
      else if (tab !== 'join') void loadList(tab);
    };
    const timer = setInterval(refresh, 5_000);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [open, isAuthenticated, target, tab, confirm, loadList, loadDetail]);
  useEffect(() => { if (confirm) { panel.current?.scrollTo?.(0, 0); keep.current?.focus(); } }, [confirm]);

  const run = async (work: (current: Current) => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    const captured = epoch.current;
    const owner = getDataOwnerGeneration();
    const current = () => captured === epoch.current && isDataOwnerGenerationCurrent(owner);
    try { await work(current); }
    catch (error) { if (current()) toast.error(t(sharedTaskErrorKey(error))); }
    finally { if (captured === epoch.current) { pending.current = false; setBusy(false); } }
  };
  const switchTab = (next: Tab) => {
    if (pending.current) return;
    if (embedded && next === 'join') { setManualOpen(true); setInvitation(''); setErrors({}); return; }
    setManualOpen(false);
    setTarget(null); setSuccess(null); setTab(next);
    if (next !== 'join') void loadList(next);
  };
  const ask = (next: Confirmation) => {
    confirmationOrigin.current = { element: document.activeElement as HTMLElement, scroll: panel.current?.scrollTop ?? 0 };
    setConfirm(next);
  };
  const restore = (origin: Origin) => requestAnimationFrame(() => {
    if (origin?.element?.isConnected) origin.element.focus({ preventScroll: true });
    else {
      const matching = [...(panel.current?.querySelectorAll<HTMLButtonElement>('[data-task-id]') ?? [])]
        .find(button => button.dataset.taskId === origin?.taskId);
      (matching ?? panel.current?.querySelector<HTMLButtonElement>('button'))?.focus({ preventScroll: true });
    }
    if (panel.current) panel.current.scrollTop = origin?.scroll ?? 0;
  });
  const cancel = () => { if (!pending.current) { setConfirm(null); restore(confirmationOrigin.current); } };
  const back = () => {
    if (pending.current) return;
    setTarget(null); setTab(target?.guestId ? 'joined' : 'owned');
    void loadList(target?.guestId ? 'joined' : 'owned');
    restore(detailOrigin.current);
  };
  const manage = (item: SharedTaskOwnedItem) => {
    detailOrigin.current = { element: document.activeElement as HTMLElement, scroll: panel.current?.scrollTop ?? 0, taskId: item.sharedTaskId };
    setTarget({ sessionId: item.sessionId, title: item.title, sharedTaskId: item.sharedTaskId,
      deviceId: item.local ? undefined : item.hostDeviceId, connect: !item.local });
  };
  const changed = () => window.dispatchEvent(new Event('cindy:shared-task-owned-changed'));
  const detail = state?.detail?.status === 'active' ? state.detail : null;
  const deviceName = (item: { local: boolean; hostDeviceId: string }) => item.local
    ? t('sharedTask.thisDevice') : remoteProjectsStore.getDeviceName(item.hostDeviceId) || t('sharedTask.otherDevice');
  const confirmAction = () => void run(async current => {
    const snapshot = confirm;
    if (!snapshot || !current()) return;
    invalidateLists(); targetEpoch.current++;
    if (snapshot.kind === 'close') {
      const failed: SharedTaskOwnedItem[] = [];
      const closed: string[] = [];
      for (const item of snapshot.targets) {
        if (!current()) return;
        try {
          const succeeded = await closeOwnedSharedTask(item.sharedTaskId, item.local ? undefined : item.hostDeviceId, current);
          if (!current()) return;
          if (succeeded) closed.push(item.sharedTaskId);
          else failed.push(item);
        } catch { if (!current()) return; failed.push(item); }
      }
      setOwned(items => items?.filter(item => !closed.includes(item.sharedTaskId)) ?? null);
      setConfirm(failed.length ? { ...snapshot, targets: failed } : null);
      if (closed.length) { changed(); toast.success(t('sharedTask.closedToast', { count: closed.length })); }
      if (failed.length) toast.error(t('sharedTask.closeFailedToast', { count: failed.length }));
      else { setTarget(null); setTab('owned'); void loadList('owned'); }
    } else if (snapshot.kind === 'remove') {
      await host(snapshot.target, { action: 'remove', sharedTaskId: snapshot.sharedTaskId, memberId: snapshot.memberId });
      if (!current()) return;
      setConfirm(null); await loadDetail(snapshot.target); restore(confirmationOrigin.current);
    } else {
      await window.electronAPI.sharedTask.account({ action: 'leave', sharedTaskId: snapshot.item.sharedTaskId });
      if (!current()) return;
      const peer = sharedTaskHostPeer(snapshot.item.sharedTaskId, snapshot.item.hostDeviceId);
      resetRemoteDataOwnerPushFence(peer);
      void window.electronAPI.deviceLink.closeLink(peer).catch(() => undefined);
      remoteProjectsStore.removeDevice(peer);
      changed(); setConfirm(null); setSuccess(null); setTarget(null); setTab('joined');
      setJoined(items => items?.filter(item => item.sharedTaskId !== snapshot.item.sharedTaskId) ?? null);
      void loadList('joined');
    }
  });
  const join = (enter = false) => {
    const next = { invitation: !invitation.trim() || invitation.length > 8192 ? 'sharedTask.invalidInvitation' : undefined };
    setErrors(next);
    if (next.invitation) { codeInput.current?.focus(); return; }
    void run(async current => {
      try {
        const result = await window.electronAPI.sharedTask.account({ action: 'join', invitation: invitation.trim(), displayName: sharedTaskAccountName(user?.name) }) as { sharedTaskId: string };
        if (!current()) return;
        setInvitation(''); setSuccess({ sharedTaskId: result.sharedTaskId, title: '' });
        invalidateLists(); void loadList('joined');
        const joinedDetail = await window.electronAPI.sharedTask.account({ action: 'get', sharedTaskId: result.sharedTaskId }) as SharedTaskDetail;
        if (current()) setSuccess({ sharedTaskId: result.sharedTaskId, title: joinedDetail.title });
        if (enter && current()) await enterTask(result.sharedTaskId, current);
      } catch (error) { if (current()) toast.error(t(sharedTaskErrorKey(error, 'join'))); }
    });
  };
  const enterTask = async (sharedTaskId: string, current: Current) => {
    const item = await window.electronAPI.sharedTask.account({ action: 'get', sharedTaskId }) as SharedTaskDetail;
    if (!current()) return;
    const peer = sharedTaskHostPeer(item.sharedTaskId, item.hostDeviceId);
    const existing = remoteProjectsStore.getMergedRemoteSessions().find(s => s.id === item.sessionId && s.deviceLinkDeviceId === peer);
    if (existing && !isRemoteDeviceMarkedDisconnected(peer)) {
      navigate('/cc-agent/' + encodeURIComponent(item.sessionId)); onOpenChange(false); return;
    }
    bindSharedTaskPushOwner(peer, item.ownerAccountId);
    await window.electronAPI.deviceLink.openLink(peer);
    if (!current()) return;
    const remoteSession = await window.electronAPI.deviceLink.invoke(peer, 'local-db:sessions:get', [item.sessionId]) as Session;
    if (!current() || remoteSession?.id !== item.sessionId) return;
    remoteProjectsStore.setDeviceSessions(peer, item.title, [remoteSession]);
    navigate('/cc-agent/' + encodeURIComponent(item.sessionId)); onOpenChange(false);
  };
  const openTask = (sharedTaskId: string) => void run(current => enterTask(sharedTaskId, current));
  const openOwnedTask = (item: SharedTaskOwnedItem) => void run(async current => {
    if (!item.local) {
      await window.electronAPI.deviceLink.openLink(item.hostDeviceId);
      if (!current()) return;
      const readIsCurrent = remoteProjectsStore.captureSessionRead(item.hostDeviceId, item.sessionId);
      const remoteSession = await window.electronAPI.deviceLink.invoke(item.hostDeviceId, 'local-db:sessions:get', [item.sessionId]) as Session | null;
      if (!current()) return;
      if (!readIsCurrent() || remoteSession?.id !== item.sessionId) throw new Error('Remote session is unavailable');
      remoteProjectsStore.mergeDeviceSessions(item.hostDeviceId, deviceName(item), [readIsCurrent.mergeActivity(remoteSession)]);
      remoteProjectsStore.pinSessionOrigin(item.hostDeviceId, item.sessionId);
    }
    if (current()) { navigate('/cc-agent/' + encodeURIComponent(item.sessionId)); onOpenChange(false); }
  });
  useEffect(() => {
    if (!open || !isAuthenticated || !initialInvitation || invitation !== initialInvitation
        || autoAttempted.current === initialInvitation || !isDataOwnerGenerationCurrent(invitationOwner.current)) return;
    autoAttempted.current = initialInvitation;
    join(true);
  }, [open, isAuthenticated, initialInvitation, invitation, ownerGeneration]);
  const invite = () => void run(async current => {
    if (!detail || !target) return;
    const result = await host(target, { action: 'invite', sharedTaskId: detail.sharedTaskId }) as { invitation: string; invitationLink?: string };
    if (!current()) return;
    const content = result.invitationLink
      ? t('sharedTask.invitationMessage', { title: detail.title || target.title, link: result.invitationLink })
      : result.invitation;
    try { await navigator.clipboard.writeText(content); }
    catch { if (current()) toast.error(t('sharedTask.invitationCopyFailed')); return; }
    if (current()) toast.success(t('sharedTask.invitationCopied'));
  });
  const closeCurrent = () => {
    if (detail && target) ask({ kind: 'close', all: false, targets: [{ ...detail, local: !target.deviceId }] });
  };
  const notice = (text: string, clock = false) => <div className="flex items-start gap-2 text-12 leading-relaxed text-[var(--text-secondary)]">
    {clock ? <Clock size={16} className="mt-0.5 shrink-0" aria-hidden /> : <Users size={16} className="mt-0.5 shrink-0" aria-hidden />}<p>{text}</p>
  </div>;
  const empty = (title: string, body: string) => <div className="px-1 py-6 text-center"><Users size={24} aria-hidden className="mx-auto mb-4 text-[var(--text-secondary)]" />
    <h3 className="text-14 font-medium">{t(title)}</h3><p className="mt-2 text-12 text-[var(--text-secondary)]">{t(body)}</p></div>;
  const confirmTitle = confirm?.kind === 'remove' ? t('sharedTask.removeNamedTitle', { name: confirm.name })
    : t(confirm?.kind === 'leave' ? 'sharedTask.leaveTitle' : confirm?.kind === 'close' && confirm.all ? 'sharedTask.closeAllTitle' : 'sharedTask.cancelTitle');
  const confirmBody = confirm?.kind === 'remove' ? 'sharedTask.removeBody' : confirm?.kind === 'leave' ? 'sharedTask.leaveBody'
    : confirm?.kind === 'close' && confirm.all ? 'sharedTask.closeAllBody' : 'sharedTask.closeOneBody';
  const keepKey = confirm?.kind === 'remove' ? 'sharedTask.removeKeep' : confirm?.kind === 'leave' ? 'sharedTask.leaveKeep' : 'sharedTask.closeAllKeep';
  const actionKey = confirm?.kind === 'remove' ? 'sharedTask.remove' : confirm?.kind === 'leave' ? 'sharedTask.leaveShort'
    : confirm?.kind === 'close' && confirm.all ? 'sharedTask.closeAllAction' : 'sharedTask.cancelSharing';

  const hostView = target && <>
    {detailError ? <div className="py-6 text-center"><p className="mb-4 text-13 text-[var(--text-secondary)]">{t(detailError)}</p>
      <Button variant="secondary" onClick={() => void loadDetail(target, true)}>{t('sharedTask.retryAction')}</Button></div>
      : !state ? <p role="status" className="text-13 text-[var(--text-secondary)]">{t('sharedTask.loadingOwned')}</p>
      : !state.available ? <p className="text-13">{t('sharedTask.upgrade')}</p>
      : !detail && (target.guestId || target.sharedTaskId) ? <>{empty('sharedTask.ended', 'sharedTask.accessEndedBody')}
        {target.guestId && <Button variant="secondary" onClick={() => switchTab('join')}>{t('sharedTask.rejoin')}</Button>}</>
      : !detail ? <>
        <p className="mb-4 text-13 text-[var(--text-secondary)]">{t('sharedTask.startIntro')}</p>
        <div className="mb-5 flex items-center gap-3 rounded-xl border border-[var(--border-default)] p-3"><FileText size={18} aria-hidden />
          <div className="min-w-0"><h3 className="break-words text-14 font-medium">{target.title || t('sharedTask.title')}</h3>
            <p className="text-12 text-[var(--text-secondary)]">{t(target.deviceId ? 'sharedTask.runsOnHostDevice' : 'sharedTask.runsOnThisDevice')}</p></div></div>
        {notice(t('sharedTask.inviteNotice'))}<p className="mt-3 text-12 text-[var(--text-secondary)]">{t('sharedTask.offlineAutoClose')}</p>
        <Button variant="cta" size="lg" className="mt-6 w-full" loading={busy} onClick={() => void run(async current => {
          await host(target, { action: 'open', sessionId: target.sessionId }); if (!current()) return;
          changed(); await loadDetail(target); invalidateLists(); void loadList('owned');
        })}>{t('sharedTask.open')}</Button>
      </> : target.guestId ? <>
        {empty('sharedTask.joined', 'sharedTask.joinedBody')}<p className="mb-4 break-words text-14 font-medium">{detail.title}</p>
        <Button variant="secondary" className="w-full text-[var(--error-fg)]" onClick={() => ask({ kind: 'leave', item: detail })}>{t('sharedTask.leaveShort')}</Button>
      </> : <>
        <h3 className="break-words text-14 font-medium">{detail.title || target.title}</h3>
        <p className="mt-1 text-12 text-[var(--text-secondary)]">{deviceName({ local: !target.deviceId, hostDeviceId: detail.hostDeviceId })} · {t('sharedTask.sharingBadge')}</p>
        <div className="my-5 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border-default)] p-4"><Link2 size={18} className="shrink-0" aria-hidden />
          <div className="min-w-0 flex-1 text-12"><p className="font-medium">{t('sharedTask.inviteBoxTitle')}</p><p className="mt-1 text-[var(--text-secondary)]">{t('sharedTask.inviteBoxHint')}</p></div>
          <Button variant="cta" size="lg" disabled={busy} onClick={invite}>{t('sharedTask.invite')}</Button></div>
        <p className="mb-2 text-12 text-[var(--text-secondary)]">{t('sharedTask.membersWithLimit', { count: detail.guests.length + 1 })}</p>
        <div className="flex min-h-12 items-center gap-3 py-2"><span className="inline-flex size-8 items-center justify-center rounded-full border border-[var(--border-default)] text-12">{t('sharedTask.me')}</span>
          <div className="grow text-13 font-medium">{t('sharedTask.me')}</div><span className="text-12 text-[var(--text-secondary)]">{t('sharedTask.roleHost')}</span></div>
        {detail.guests.map(member => {
          const name = detail.memberLabels.find(label => label.memberId === member.memberId)?.displayName ?? member.accountId;
          return <div key={member.memberId} className="flex min-h-12 items-center gap-3 py-2"><span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-[var(--border-default)] text-12" aria-hidden>{Array.from(name)[0]}</span>
            <div className="min-w-0 flex-1"><p className="break-words text-13 font-medium">{name}</p><p className="text-11 text-[var(--text-secondary)]">{t('sharedTask.roleGuest')}</p></div>
            <Button variant="secondary" tone="danger" disabled={busy} className="px-3 text-12" onClick={() => ask({ kind: 'remove', target: { ...target }, sharedTaskId: detail.sharedTaskId, memberId: member.memberId, name, title: detail.title })}>{t('sharedTask.removeShort')}</Button></div>;
        })}
        <div className="mt-4 border-t border-[var(--border-default)] pt-4">{notice(t(target.deviceId ? 'sharedTask.remoteHostOfflineNote' : 'sharedTask.hostOfflineNote'), true)}</div>
        <div className="mt-6 flex justify-center border-t border-[var(--border-default)] pt-5"><Button variant="secondary" size="lg" disabled={busy} className="w-full text-[var(--error-fg)]" onClick={closeCurrent}>{t('sharedTask.cancelSharing')}</Button></div>
      </>}
  </>;
  const listView = (kind: 'owned' | 'joined') => {
    const items = kind === 'owned' ? owned : joined;
    return <>
      {!embedded && <p className="mb-5 text-13 text-[var(--text-secondary)]">{t(kind === 'owned' ? 'sharedTask.ownedManageIntro' : 'sharedTask.joinedManageIntro')}</p>}
      {listErrors[kind] && <div className="mb-4 flex items-center justify-between gap-3 text-13" role="status"><p>{t(kind === 'owned' ? 'sharedTask.ownedLoadFailed' : 'sharedTask.joinedLoadFailed')}</p><Button variant="secondary" onClick={() => void loadList(kind)}>{t('sharedTask.retryAction')}</Button></div>}
      {items === null ? !listErrors[kind] && <p role="status" className="text-13 text-[var(--text-secondary)]">{t('sharedTask.loadingOwned')}</p>
        : !items.length ? <>{empty(kind === 'owned' ? 'sharedTask.ownedEmptyTitle' : 'sharedTask.joinedEmptyTitle', kind === 'owned' ? 'sharedTask.ownedEmptyHint' : 'sharedTask.joinedEmptyHint')}
          {kind === 'joined' && !embedded && <div className="text-center"><Button variant="secondary" onClick={() => switchTab('join')}>{t('sharedTask.joinTab')}</Button></div>}</>
        : <div className="overflow-hidden rounded-xl border border-[var(--border-default)]">{items.map((item, index) => <div key={item.sharedTaskId} className={`flex flex-wrap items-center gap-3 p-3 ${index ? 'border-t border-[var(--border-default)]' : ''}`}>
          <Users size={18} aria-hidden className="shrink-0" /><div className="min-w-0 flex-1">
            {kind === 'owned' ? <Button variant="secondary" tone="quiet" disabled={busy} className="h-auto min-h-9 max-w-full justify-start whitespace-normal break-words px-2 text-left text-13" onClick={() => openOwnedTask(item as SharedTaskOwnedItem)}>{item.title}</Button>
              : <Button variant="secondary" tone="quiet" disabled={busy} className="h-auto min-h-9 max-w-full justify-start whitespace-normal break-words px-2 text-left text-13 text-[var(--text-primary)]" onClick={() => openTask(item.sharedTaskId)}>{item.title}</Button>}
            <p className="text-12 text-[var(--text-secondary)]">{kind === 'owned' ? deviceName(item as SharedTaskOwnedItem)
              : t(isRemoteDeviceMarkedDisconnected(sharedTaskHostPeer(item.sharedTaskId, item.hostDeviceId)) ? 'sharedTask.reconnecting' : 'sharedTask.roleGuest')}</p></div>
          <Button variant="secondary" tone={kind === 'joined' ? 'quiet' : 'default'} disabled={busy} data-task-id={item.sharedTaskId} className="px-3 text-12"
            onClick={() => kind === 'owned' ? manage(item as SharedTaskOwnedItem) : ask({ kind: 'leave', item })}>{t(kind === 'owned' ? 'sharedTask.manage' : 'sharedTask.leaveShort')}</Button>
        </div>)}</div>}
      {embedded && !!items?.length && <p className="mt-3 text-13 text-[var(--text-secondary)]">{t(kind === 'owned' ? 'sharedTask.ownedManageIntro' : 'sharedTask.joinedManageIntro')}</p>}
      {kind === 'owned' && !!owned?.length && <div className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t border-[var(--border-default)] pt-5">
        {embedded && <div><h3 className="text-14 font-medium">{t('sharedTask.closeAllLabel')}</h3><p className="mt-1 text-12 text-[var(--text-secondary)]">{t('sharedTask.closeAllDescription')}</p></div>}
        <Button variant="secondary" size="lg" disabled={busy} className={`${embedded ? '' : 'w-full '}text-[var(--error-fg)]`} onClick={() => ask({ kind: 'close', all: true, targets: owned.map(item => ({ ...item })) })}>{t(embedded ? 'sharedTask.closeAllLabel' : 'sharedTask.closeAll', { count: owned.length })}</Button>
        {!embedded && <p className="w-full text-center text-11 text-[var(--text-secondary)]">{t('sharedTask.recordsKept')}</p>}</div>}
    </>;
  };
  const joinForm = (<form ref={node => { codeInput.current = node?.querySelector('textarea') ?? null; }} onSubmit={event => { event.preventDefault(); join(embedded || admissionOnly); }} className="space-y-3">
        <FormField label={t('sharedTask.invitation')} required reserveFeedback error={errors.invitation && t(errors.invitation)}>{props => <Textarea {...props} rows={3} maxLength={8192} value={invitation} onChange={value => { setInvitation(value); setErrors(previous => ({ ...previous, invitation: undefined })); }} disabled={busy} surface="ivory" autoComplete="off" spellCheck={false} placeholder={t('sharedTask.invitationPlaceholder')} />}</FormField>
        {notice(t('sharedTask.joinNotice'))}<div className="flex justify-end pt-3"><Button type="submit" variant="cta" size="lg" loading={busy}>{t('sharedTask.join')}</Button></div>
      </form>);
  const tabKeys: Tab[] = embedded ? ['owned', 'joined'] : ['join', 'joined', 'owned'];
  const hub = <>
    <div role="tablist" aria-label={t('sharedTask.title')} className={`flex flex-wrap border-b border-[var(--border-default)] ${embedded ? 'mb-6 gap-7' : 'mb-5 gap-1 pb-4'}`}>
      {tabKeys.map((key, index, keys) => {
        const props = {
          id: `shared-task-tab-${key}`, role: 'tab', 'aria-selected': tab === key,
          'aria-controls': `shared-task-panel-${key}`, tabIndex: tab === key ? 0 : -1,
          disabled: busy, onClick: () => switchTab(key),
          onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault(); const next = keys[event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length];
            switchTab(next); document.getElementById(`shared-task-tab-${next}`)?.focus();
          },
        };
        const label = <>{t(key === 'join' ? 'sharedTask.joinTab' : key === 'joined' ? 'sharedTask.joinedTab' : 'sharedTask.tabOwned')}
          {key !== 'join' && (key === 'owned' ? owned : joined) !== null && <span className="ml-2 text-11 text-[var(--text-secondary)]">{(key === 'owned' ? owned : joined)?.length}</span>}</>;
        return embedded ? <button key={key} {...props} type="button"
          className={`relative min-h-11 min-w-0 pb-3 text-13 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)] disabled:opacity-50 ${tab === key ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>
          {label}{tab === key && <span aria-hidden className="absolute -bottom-px inset-x-0 h-0.5 bg-[var(--text-primary)]" />}
        </button> : <Button key={key} {...props} variant={tab === key ? 'primary' : 'secondary'} tone={tab === key ? 'default' : 'quiet'} size="lg" className="min-w-0 flex-1 px-2 text-13">{label}</Button>;
      })}
    </div>
    {!embedded && <div hidden={tab !== 'join'} role="tabpanel" id="shared-task-panel-join" aria-labelledby="shared-task-tab-join">
      <p className="mb-5 text-13 text-[var(--text-secondary)]">{t('sharedTask.joinIntro')}</p>
      {joinForm}
    </div>}
    <div hidden={tab !== 'joined'} role="tabpanel" id="shared-task-panel-joined" aria-labelledby="shared-task-tab-joined">{tab === 'joined' && listView('joined')}</div>
    <div hidden={tab !== 'owned'} role="tabpanel" id="shared-task-panel-owned" aria-labelledby="shared-task-tab-owned">{tab === 'owned' && listView('owned')}</div>
  </>;
  const dismiss = () => {
    if (pending.current) return;
    if (confirm) cancel();
    else if (embedded) { setTarget(null); setManualOpen(false); setSuccess(null); }
    else onOpenChange(false);
  };
  return <>{embedded && <section>
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div><h2 className="text-20 font-medium">{t('sharedTask.title')}</h2><p className="mt-2 text-13 text-[var(--text-secondary)]">{t('sharedTask.managementIntro')}</p></div>
      <Button variant="secondary" size="lg" disabled={!isAuthenticated || busy} onClick={() => switchTab('join')}>{t('sharedTask.join')}</Button>
    </div>
    {isAuthenticated ? hub : <p className="text-13">{t('sharedTask.login')}</p>}
  </section>}<Dialog.Root open={open && (!embedded || !!target || !!confirm || manualOpen || !!success)} onOpenChange={value => { if (!value) dismiss(); }}><Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]" />
    <Dialog.Content ref={panel} aria-describedby={undefined} className="fixed left-1/2 top-1/2 z-[10001] max-h-[calc(100dvh-32px)] w-[min(460px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 text-[var(--text-primary)]"
      onOpenAutoFocus={event => { if (!target && !confirm) { event.preventDefault(); codeInput.current?.focus(); } }}
      onCloseAutoFocus={returnFocus ? event => { event.preventDefault(); returnFocus(); } : undefined}
      onEscapeKeyDown={event => { if (pending.current || confirm || target) { event.preventDefault(); if (confirm) cancel(); else if (target) back(); } }}
      onInteractOutside={event => event.preventDefault()}>
      <div className="mb-5 flex items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-2">
        {target && !confirm && <Button variant="secondary" tone="quiet" size="lg" className="w-9 shrink-0 p-0" aria-label={t('sharedTask.back')} disabled={busy} onClick={back}><ArrowLeft size={18} aria-hidden /></Button>}
        <Dialog.Title className="text-18 font-medium">{confirm ? confirmTitle : t(target ? 'sharedTask.manageSharing' : success ? 'sharedTask.joined' : embedded || admissionOnly ? 'sharedTask.join' : 'sharedTask.title')}</Dialog.Title></div>
        <Button variant="secondary" tone="quiet" size="lg" className="w-9 shrink-0 p-0" disabled={busy} aria-label={t(confirm ? 'sharedTask.cancelOperation' : 'sharedTask.dismiss')} onClick={dismiss}><X size={18} aria-hidden /></Button>
      </div>
      {confirm && <div><p className="text-13 leading-relaxed text-[var(--text-secondary)]">{t(confirmBody)}</p>
        <div className="my-5 overflow-hidden rounded-xl border border-[var(--border-default)]">{confirm.kind === 'close' ? confirm.targets.map((item, index) => <div key={item.sharedTaskId} className={`p-3 ${index ? 'border-t border-[var(--border-default)]' : ''}`}><p className="break-words text-13 font-medium">{item.title}</p><p className="text-12 text-[var(--text-secondary)]">{deviceName(item)}</p></div>)
          : <p className="break-words p-3 text-13 font-medium">{confirm.kind === 'leave' ? confirm.item.title : confirm.title}</p>}</div>
        <p className="text-12 text-[var(--text-secondary)]">{t(confirm.kind === 'close' ? 'sharedTask.closeAllScopeNote' : 'sharedTask.othersUnaffected')}</p>
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3"><Button ref={keep} variant="secondary" size="lg" disabled={busy} onClick={cancel}>{t(keepKey)}</Button>
          <Button variant="primary" tone="danger-solid" size="lg" loading={busy} onClick={confirmAction} className="h-auto min-h-9 max-w-full whitespace-normal py-1.5">{t(actionKey, { count: confirm.kind === 'close' ? confirm.targets.length : 1 })}</Button></div>
      </div>}
      <div hidden={!!confirm}>{!isAuthenticated ? <p className="text-13">{t('sharedTask.login')}</p> : target ? hostView : success ? <div className="py-6 text-center">
        <span className="mb-4 inline-flex size-11 items-center justify-center rounded-full border border-[var(--border-default)]"><Check size={18} aria-hidden /></span>
        <h3 className="break-words text-14 font-medium">{success.title ? t('sharedTask.joinedTitle', { title: success.title }) : t('sharedTask.joined')}</h3><p className="mb-5 mt-2 text-12 text-[var(--text-secondary)]">{t('sharedTask.joinedBody')}</p>
        <Button variant="cta" size="lg" loading={busy} onClick={() => openTask(success.sharedTaskId)}>{t('sharedTask.enterTask')}</Button>{!admissionOnly && <div className="mt-3"><Button variant="secondary" tone="quiet" disabled={busy} onClick={() => switchTab('joined')}>{t('sharedTask.viewJoined')}</Button></div>}
      </div> : embedded || admissionOnly ? <><p className="mb-5 text-13 text-[var(--text-secondary)]">{t('sharedTask.joinIntro')}</p>{joinForm}</> : hub}</div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root></>;
}
