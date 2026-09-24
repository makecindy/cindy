import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Clock, FileText, Link2, Users, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  parseSharedTaskPeer, sharedTaskHostPeer, SHARED_TASK_HOST_CHANNEL,
  type SharedTaskCloseResult, type SharedTaskDetail, type SharedTaskHostCommand,
  type SharedTaskHostState, type SharedTaskListItem, type SharedTaskOwnedItem,
} from '@cindy/device-link';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/contexts/AuthContext';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { Session } from '@/lib/ccAgent.types';
import { toast } from '@/lib/toast';
import { bindSharedTaskPushOwner, resetRemoteDataOwnerPushFence } from '@/lib/remoteDataOwnerPushFence';
import { remoteProjectsStore, isRemoteDeviceMarkedDisconnected } from './remoteProjectsStore';
import { sharedTaskErrorKey } from './sharedTaskCompatibility';

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
export function SharedTaskDialog({ open, onOpenChange, session, returnFocus }: {
  open: boolean; onOpenChange(open: boolean): void; session?: Session; returnFocus?(): void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { dataOwnerId, isAuthenticated } = useAuth();
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
  const [nickname, setNickname] = useState('');
  const [errors, setErrors] = useState<{ invitation?: string; nickname?: string }>({});
  const [success, setSuccess] = useState<{ sharedTaskId: string; title: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const targetEpoch = useRef(0);
  const detailRequest = useRef<{ target: Target; epoch: number; sequence: number } | null>(null);
  const pending = useRef(false);
  const lists = useRef({ owned: { sequence: 0, loading: false }, joined: { sequence: 0, loading: false } });
  const codeInput = useRef<HTMLInputElement>(null);
  const nicknameInput = useRef<HTMLInputElement>(null);
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
    setTab('join'); setTarget(initialTarget); setState(null); setDetailError(null);
    setOwned(null); setJoined(null); setListErrors({ owned: false, joined: false });
    setInvitation(''); setNickname(''); setErrors({}); setSuccess(null); setConfirm(null);
    pending.current = false; setBusy(false);
    if (open && isAuthenticated) { void loadList('owned'); void loadList('joined'); }
    return () => { epoch.current++; targetEpoch.current++; invalidateLists(); };
  }, [open, dataOwnerId, ownerGeneration, isAuthenticated, initialTarget, loadList]);
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
          const result = await window.electronAPI.sharedTask.account({ action: 'close', sharedTaskId: item.sharedTaskId }) as SharedTaskCloseResult;
          if (!current()) return;
          if (result.closed.includes(item.sharedTaskId)) closed.push(item.sharedTaskId);
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
  const join = () => {
    const next = { invitation: !/^[A-Za-z0-9_-]{43}$/.test(invitation.trim()) ? 'sharedTask.invalidInvitation' : undefined,
      nickname: !nickname.trim() ? 'sharedTask.missingNickname' : undefined };
    setErrors(next);
    if (next.invitation || next.nickname) { (next.invitation ? codeInput : nicknameInput).current?.focus(); return; }
    void run(async current => {
      try {
        const result = await window.electronAPI.sharedTask.account({ action: 'join', invitation: invitation.trim(), displayName: nickname.trim() }) as { sharedTaskId: string };
        if (!current()) return;
        setInvitation(''); setSuccess({ sharedTaskId: result.sharedTaskId, title: '' });
        invalidateLists(); void loadList('joined');
        const joinedDetail = await window.electronAPI.sharedTask.account({ action: 'get', sharedTaskId: result.sharedTaskId }) as SharedTaskDetail;
        if (current()) setSuccess({ sharedTaskId: result.sharedTaskId, title: joinedDetail.title });
      } catch (error) { if (current()) toast.error(t(sharedTaskErrorKey(error, 'join'))); }
    });
  };
  const openTask = (sharedTaskId: string) => void run(async current => {
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
  });
  const invite = () => void run(async current => {
    if (!detail || !target) return;
    const result = await host(target, { action: 'invite', sharedTaskId: detail.sharedTaskId }) as { invitation: string };
    if (!current()) return;
    try { await navigator.clipboard.writeText(result.invitation); }
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
      <p className="mb-5 text-13 text-[var(--text-secondary)]">{t(kind === 'owned' ? 'sharedTask.ownedManageIntro' : 'sharedTask.joinedManageIntro')}</p>
      {listErrors[kind] && <div className="mb-4 flex items-center justify-between gap-3 text-13" role="status"><p>{t(kind === 'owned' ? 'sharedTask.ownedLoadFailed' : 'sharedTask.joinedLoadFailed')}</p><Button variant="secondary" onClick={() => void loadList(kind)}>{t('sharedTask.retryAction')}</Button></div>}
      {items === null ? !listErrors[kind] && <p role="status" className="text-13 text-[var(--text-secondary)]">{t('sharedTask.loadingOwned')}</p>
        : !items.length ? <>{empty(kind === 'owned' ? 'sharedTask.ownedEmptyTitle' : 'sharedTask.joinedEmptyTitle', kind === 'owned' ? 'sharedTask.ownedEmptyHint' : 'sharedTask.joinedEmptyHint')}
          {kind === 'joined' && <div className="text-center"><Button variant="secondary" onClick={() => switchTab('join')}>{t('sharedTask.joinTab')}</Button></div>}</>
        : <div className="overflow-hidden rounded-xl border border-[var(--border-default)]">{items.map((item, index) => <div key={item.sharedTaskId} className={`flex flex-wrap items-center gap-3 p-3 ${index ? 'border-t border-[var(--border-default)]' : ''}`}>
          <Users size={18} aria-hidden className="shrink-0" /><div className="min-w-0 flex-1">
            {kind === 'owned' ? <h3 className="break-words text-13 font-medium">{item.title}</h3>
              : <Button variant="secondary" tone="quiet" disabled={busy} className="h-auto min-h-9 max-w-full justify-start whitespace-normal break-words px-2 text-left text-13 text-[var(--text-primary)]" onClick={() => openTask(item.sharedTaskId)}>{item.title}</Button>}
            <p className="text-12 text-[var(--text-secondary)]">{kind === 'owned' ? deviceName(item as SharedTaskOwnedItem)
              : t(isRemoteDeviceMarkedDisconnected(sharedTaskHostPeer(item.sharedTaskId, item.hostDeviceId)) ? 'sharedTask.reconnecting' : 'sharedTask.roleGuest')}</p></div>
          <Button variant="secondary" tone={kind === 'joined' ? 'quiet' : 'default'} disabled={busy} data-task-id={item.sharedTaskId} className="px-3 text-12"
            onClick={() => kind === 'owned' ? manage(item as SharedTaskOwnedItem) : ask({ kind: 'leave', item })}>{t(kind === 'owned' ? 'sharedTask.manage' : 'sharedTask.leaveShort')}</Button>
        </div>)}</div>}
      {kind === 'owned' && !!owned?.length && <div className="mt-6 border-t border-[var(--border-default)] pt-5"><Button variant="secondary" size="lg" disabled={busy} className="w-full text-[var(--error-fg)]" onClick={() => ask({ kind: 'close', all: true, targets: owned.map(item => ({ ...item })) })}>{t('sharedTask.closeAll', { count: owned.length })}</Button>
        <p className="mt-2 text-center text-11 text-[var(--text-secondary)]">{t('sharedTask.recordsKept')}</p></div>}
    </>;
  };
  const hub = <>
    <div role="tablist" aria-label={t('sharedTask.title')} className="mb-5 flex flex-wrap gap-1 border-b border-[var(--border-default)] pb-4">
      {(['join', 'joined', 'owned'] as const).map((key, index, keys) => <Button key={key} id={`shared-task-tab-${key}`} role="tab" aria-selected={tab === key} aria-controls={`shared-task-panel-${key}`} tabIndex={tab === key ? 0 : -1}
        variant={tab === key ? 'primary' : 'secondary'} tone={tab === key ? 'default' : 'quiet'} size="lg" disabled={busy} className="min-w-0 flex-1 px-2 text-12" onClick={() => switchTab(key)}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault(); const next = keys[event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3];
          switchTab(next); document.getElementById(`shared-task-tab-${next}`)?.focus();
        }}>{t(key === 'join' ? 'sharedTask.joinTab' : key === 'joined' ? 'sharedTask.joinedTab' : 'sharedTask.tabOwned')}
        {key !== 'join' && (key === 'owned' ? owned : joined) !== null && <span className="ml-1 text-11 text-[var(--text-secondary)]">{(key === 'owned' ? owned : joined)?.length}</span>}</Button>)}
    </div>
    <div hidden={tab !== 'join'} role="tabpanel" id="shared-task-panel-join" aria-labelledby="shared-task-tab-join">
      <p className="mb-5 text-13 text-[var(--text-secondary)]">{t('sharedTask.joinIntro')}</p>
      <form onSubmit={event => { event.preventDefault(); join(); }} className="space-y-3">
        <FormField label={t('sharedTask.invitation')} required reserveFeedback error={errors.invitation && t(errors.invitation)}>{props => <Input {...props} inputRef={codeInput} value={invitation} onChange={value => { setInvitation(value); setErrors(previous => ({ ...previous, invitation: undefined })); }} disabled={busy} surface="ivory" autoComplete="off" spellCheck={false} placeholder={t('sharedTask.invitationPlaceholder')} />}</FormField>
        <FormField label={t('sharedTask.joinNickname')} required reserveFeedback error={errors.nickname && t(errors.nickname)}>{props => <Input {...props} inputRef={nicknameInput} value={nickname} onChange={value => { setNickname(value); setErrors(previous => ({ ...previous, nickname: undefined })); }} maxLength={32} disabled={busy} surface="ivory" autoComplete="off" placeholder={t('sharedTask.nicknamePlaceholder')} />}</FormField>
        {notice(t('sharedTask.joinNotice'))}<div className="flex justify-end pt-3"><Button type="submit" variant="cta" size="lg" loading={busy}>{t('sharedTask.join')}</Button></div>
      </form>
    </div>
    <div hidden={tab !== 'joined'} role="tabpanel" id="shared-task-panel-joined" aria-labelledby="shared-task-tab-joined">{tab === 'joined' && listView('joined')}</div>
    <div hidden={tab !== 'owned'} role="tabpanel" id="shared-task-panel-owned" aria-labelledby="shared-task-tab-owned">{tab === 'owned' && listView('owned')}</div>
  </>;
  return <Dialog.Root open={open} onOpenChange={value => { if (!pending.current) { if (confirm) cancel(); else onOpenChange(value); } }}><Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]" />
    <Dialog.Content ref={panel} aria-describedby={undefined} className="fixed left-1/2 top-1/2 z-[10001] max-h-[calc(100dvh-32px)] w-[min(460px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 text-[var(--text-primary)]"
      onOpenAutoFocus={event => { if (!initialTarget) { event.preventDefault(); codeInput.current?.focus(); } }}
      onCloseAutoFocus={returnFocus ? event => { event.preventDefault(); returnFocus(); } : undefined}
      onEscapeKeyDown={event => { if (pending.current || confirm || target) { event.preventDefault(); if (confirm) cancel(); else if (target) back(); } }}
      onInteractOutside={event => { if (pending.current || confirm) event.preventDefault(); }}>
      <div className="mb-5 flex items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-2">
        {target && !confirm && <Button variant="secondary" tone="quiet" size="lg" className="w-9 shrink-0 p-0" aria-label={t('sharedTask.back')} disabled={busy} onClick={back}><ArrowLeft size={18} aria-hidden /></Button>}
        <Dialog.Title className="text-18 font-medium">{confirm ? confirmTitle : t(target ? 'sharedTask.manageSharing' : success ? 'sharedTask.joined' : 'sharedTask.title')}</Dialog.Title></div>
        <Button variant="secondary" tone="quiet" size="lg" className="w-9 shrink-0 p-0" disabled={busy} aria-label={t(confirm ? 'sharedTask.cancelOperation' : 'sharedTask.dismiss')} onClick={() => confirm ? cancel() : onOpenChange(false)}><X size={18} aria-hidden /></Button>
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
        <Button variant="cta" size="lg" loading={busy} onClick={() => openTask(success.sharedTaskId)}>{t('sharedTask.enterTask')}</Button><div className="mt-3"><Button variant="secondary" tone="quiet" disabled={busy} onClick={() => switchTab('joined')}>{t('sharedTask.viewJoined')}</Button></div>
      </div> : hub}</div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
