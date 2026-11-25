import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { MessagesSquare, UsersRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';
import { useTranslation } from 'react-i18next';
import { CCAgentSessionView } from '@/features/cc-agent/CCAgentSessionView';
import { useSidebarNavigate } from '@/features/cc-agent/sidebar/sidebarNavigation';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { useDocumentVisible, useWindowVisible } from '@/hooks/useWindowVisible';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { makerChatStore } from '@/lib/makerChatStore';
import { clearDraft, discardDraft } from '@/lib/composerDraftStore';
import { setStatus } from '@/lib/sessionService';
import { isSidebarWindow } from '@/lib/sidebarWindow';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import type { Session } from '@/lib/ccAgent.types';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { SidebarHostSessionProvider } from '../../lib/sidebarHostSession';
import { mergeSidebarWindowBack } from '../../lib/mergeSidebarWindowBack';
import { closeTab } from '../../store';
import type { TabKindBodyProps } from '../../types';
import {
  cancelPendingSideChat,
  getPendingSideChat,
  removePendingSideChat,
  setPendingSideChatQueuedSend,
  subscribePendingSideChat,
} from './pendingSideChat';
import { sideChatTaskRoute, type SideChatState } from './state';

export function SideChatTabBody({ state, ctx, active, shellVisible = true }: TabKindBodyProps<SideChatState>) {
  const { t } = useTranslation();
  const [returning, setReturning] = useState(false);
  const returnToMain = useCallback(async () => {
    setReturning(true);
    try { await mergeSidebarWindowBack(ctx.sessionId); }
    catch { toast.error(t('chat.sideChat.failed')); }
    finally { setReturning(false); }
  }, [ctx.sessionId, t]);
  useEffect(() => {
    if (!isSidebarWindow()) return;
    return ctx.setCloseInterceptor(async () => { await returnToMain(); return false; });
  }, [ctx, returnToMain]);
  if (isSidebarWindow()) return <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
    <p className="text-sm leading-5 text-muted-foreground">{t('chat.sideChat.mainWindowDescription')}</p>
    <Button disabled={returning} onClick={() => void returnToMain()}>{t('chat.sideChat.returnToMain')}</Button>
  </div>;
  return <AttachedSideChat state={state} ctx={ctx} active={active} shellVisible={shellVisible} />;
}

function AttachedSideChat({ state, ctx, active, shellVisible = true }: TabKindBodyProps<SideChatState>) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const navigate = useSidebarNavigate();
  const windowVisible = useWindowVisible(Boolean(active && shellVisible));
  const documentVisible = useDocumentVisible(Boolean(active && shellVisible));
  const viewVisible = Boolean(active && shellVisible && windowVisible);
  const chatRealtime = Boolean(active && shellVisible && documentVisible);
  const pending = useSyncExternalStore(
    subscribePendingSideChat,
    () => getPendingSideChat(ctx.tabId),
  );
  const childId = pending ? (pending.status === 'ready' ? pending.childSession?.id ?? null : null) : state.sessionId;
  const awaitingSessionCreation = pending?.status === 'creating';
  const creationFailed = pending?.status === 'failed';
  const closeChildId = childId ?? (creationFailed ? pending?.childSession?.id : undefined);
  const effectiveSessionId = childId ?? pending?.draftKey ?? null;
  const effectiveDraftKey = pending?.draftKey;
  const pendingChildSession = pending?.childSession?.id === childId ? pending.childSession : null;
  const pendingChildRef = useRef<Session | null>(null);
  pendingChildRef.current = pendingChildSession;
  const pendingDraftKeyRef = useRef<string | undefined>(undefined);
  pendingDraftKeyRef.current = pending?.draftKey;
  const retiredChildRef = useRef<string | null>(null);
  const linkedChildRef = useRef<string | null>(null);
  const pendingClose = useRef<Promise<boolean> | null>(null);
  const [linkedChild, setLinkedChild] = useState<string | null>(null);
  const [collaboration, setCollaboration] = useState<{ childId: string; role: Session['orcaRole'] } | null>(null);
  const [remoteSession, setRemoteSession] = useState<Session | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [unavailableChild, setUnavailableChild] = useState<string | null>(null);
  // Register before mounting the child: hidden branches are absent from the ordinary task list.
  const [registeredChild, setRegisteredChild] = useState<string | null>(null);
  const readChild = useCallback(async (id: string) => (state.deviceId
    ? await window.electronAPI.deviceLink.invoke(state.deviceId, 'local-db:sessions:get', [id])
    : await window.electronAPI.localDb.sessions.get(id)) as Session | null, [state.deviceId]);
  useEffect(() => {
    if (childId && state.deviceId) remoteProjectsStore.pinSessionOrigin(state.deviceId, childId);
    if (childId && state.deviceId && pendingChildSession) {
      setRemoteSession(previous => previous?.id === childId
        ? previous
        : { ...pendingChildSession, id: childId, deviceLinkDeviceId: state.deviceId! });
    }
    setRegisteredChild(childId);
  }, [childId, pendingChildSession, state.deviceId]);
  useEffect(() => {
    const deviceId = state.deviceId;
    if (!childId) return;
    const owner = getDataOwnerGeneration();
    let disposed = false;
    let unavailable = false;
    let bufferedPatch: Partial<Session> = {};
    const valid = () => !disposed && isDataOwnerGenerationCurrent(owner);
    const dismiss = (status: 'archived' | 'deleted' = 'deleted') => {
      if (!valid() || unavailable) return;
      unavailable = true;
      retiredChildRef.current = childId;
      // Unmount the composer immediately, even while tab persistence settles.
      setUnavailableChild(childId);
      makerChatStore.purgeSession(childId);
      if (status === 'deleted') {
        makerChatStore.closeSessionQuery(childId);
        discardDraft(childId);
        if (pendingDraftKeyRef.current && pendingDraftKeyRef.current !== childId) {
          discardDraft(pendingDraftKeyRef.current);
        }
      }
      removePendingSideChat(ctx.tabId);
      void closeTab(ctx.sessionId, ctx.tabId, { skipBeforeClose: true })
        .catch(() => { if (valid()) toast.error(t('chat.sideChat.closeFailed')); });
    };
    const updateCollaboration = (snapshot: Partial<Session>) => {
      if (snapshot.sideChatPromoted) {
        linkedChildRef.current = childId;
        setLinkedChild(childId);
      }
      if (snapshot.orcaRole !== undefined) setCollaboration({ childId, role: snapshot.orcaRole });
    };
    const applyPatch = (payload: { sessionId?: string; patch?: Partial<Session> } | null) => {
      if (!valid() || unavailable || payload?.sessionId !== childId || !payload.patch) return;
      bufferedPatch = { ...bufferedPatch, ...payload.patch };
      if (payload.patch.status === 'deleted' || (payload.patch.status === 'archived'
        && (bufferedPatch.sideChatPromoted || linkedChildRef.current === childId))) {
        dismiss(payload.patch.status); return;
      }
      updateCollaboration(payload.patch);
      if (deviceId) {
        setRemoteSession(previous => {
          const base = previous?.id === childId
            ? previous
            : pendingChildRef.current?.id === childId
              ? pendingChildRef.current
              : null;
          return base
            ? { ...base, ...payload.patch, id: childId, deviceLinkDeviceId: deviceId }
            : previous;
        });
      }
    };
    // Hidden tabs still need deletion notifications; subscribe before reading.
    const off = deviceId ? window.electronAPI.deviceLink.onRemotePush((push, stamp) => {
      if (push.deviceId !== deviceId || push.channel !== 'local-db:sessions:patched'
        || !isDeviceLinkRemotePushCurrent(push, stamp)) return;
      applyPatch(push.payload as { sessionId?: string; patch?: Partial<Session> } | null);
    }) : window.electronAPI.localDb.sessionsPush.onPatched((payload, stamp) => {
      if (isDataOwnerPushCurrent(stamp)) applyPatch(payload);
    });
    setLoadFailed(false);
    const read = async () => {
      if (!active) return;
      const value = await readChild(childId);
      if (!valid() || unavailable) return;
      if (!value) { dismiss(); return; }
      if (value.id !== childId || value.parentSessionId !== ctx.sessionId) {
        throw new Error('Side chat owner mismatch');
      }
      // An archived linked Lead may still be stopping its team. Keep the
      // original tab available for an explicit retry, including after reload.
      if (value.status === 'deleted' || (value.status === 'archived' && value.sideChatPromoted && value.orcaRole !== 'lead')) {
        dismiss(value.status); return;
      }
      if (value.source !== 'side-chat' && !value.sideChatPromoted) throw new Error('Side chat owner mismatch');
      const merged = { ...value, ...bufferedPatch };
      updateCollaboration(merged);
      if (!deviceId) return;
      const snapshot: Session = { ...merged, id: childId, deviceLinkDeviceId: deviceId };
      // The shared editor also reads metadata from the remote task store. Restore
      // hidden branches there before mounting it, without changing the main route.
      remoteProjectsStore.mergeDeviceSessions(deviceId,
        remoteProjectsStore.getDeviceName(deviceId) ?? '', [snapshot]);
      setRemoteSession(snapshot);
    };
    void read().catch(() => { if (valid() && !unavailable) setLoadFailed(true); });
    return () => { disposed = true; off(); };
  }, [active, childId, ctx.sessionId, ctx.tabId, readChild, retry, state.deviceId, t]);
  const close = useCallback(() => {
    const childId = closeChildId;
    if (!childId) {
      const currentPending = cancelPendingSideChat(ctx.tabId);
      if (currentPending) {
        if (currentPending.hasTransferredAttachments) clearDraft(currentPending.draftKey);
        else discardDraft(currentPending.draftKey);
        removePendingSideChat(ctx.tabId);
      }
      return Promise.resolve(true);
    }
    if (pendingClose.current) return pendingClose.current;
    const owner = getDataOwnerGeneration();
    const current = () => isDataOwnerGenerationCurrent(owner);
    const matches = (row: Session | null): row is Session => row?.id === childId
      && row.parentSessionId === ctx.sessionId && (row.source === 'side-chat' || row.sideChatPromoted === true);
    const archive = async (snapshot: Session) => {
      const confirmArchive = (showWorkers: boolean) => confirm({
        title: t('chat.sideChat.closeTitle'),
        description: t(showWorkers ? 'chat.sideChat.closeDescriptionRunning' : 'chat.sideChat.closeDescription'),
        confirmText: t('chat.sideChat.closeConfirm'),
      });
      const canCommit = () => current() && retiredChildRef.current !== childId;
      const warnsAboutWorkers = snapshot.orcaRole !== null;
      if (snapshot.status === 'archived' && !warnsAboutWorkers) return canCommit();
      if (!await confirmArchive(warnsAboutWorkers) || !canCommit()) return false;
      if (snapshot.status !== 'archived' && !warnsAboutWorkers) {
        const latest = await readChild(childId);
        if (!canCommit() || !matches(latest) || latest.status !== 'active') return false;
        if (latest.orcaRole !== null && (!await confirmArchive(true) || !canCommit())) return false;
      }
      if (state.deviceId) {
        await window.electronAPI.deviceLink.invoke(state.deviceId, 'local-db:sessions:patch-meta', [
          childId, { status: 'archived', archiveSideChatParentId: ctx.sessionId },
        ]);
      } else {
        await window.electronAPI.localDb.sessions.archiveLinkedSideChat(childId, ctx.sessionId);
      }
      if (current()) makerChatStore.purgeSession(childId);
      return current();
    };
    const request = (async () => {
      try {
        const latest = await readChild(childId);
        if (!current() || !matches(latest)) return false;
        if (latest.status === 'deleted') return true;
        if (latest.sideChatPromoted) return await archive(latest);
        try {
          await setStatus(childId, 'deleted', state.deviceId ? { kind: 'device-link', deviceId: state.deviceId } : { kind: 'local' },
            undefined, 'side-chat');
        } catch (error) {
          if (extractIpcError(error)?.code !== 'PRECONDITION_FAILED' || !current()) throw error;
          const linked = await readChild(childId);
          if (current() && matches(linked) && linked.sideChatPromoted && linked.status === 'active') return await archive(linked);
          throw error;
        }
        if (!current()) return false;
        makerChatStore.closeSessionQuery(childId);
        makerChatStore.purgeSession(childId);
        discardDraft(childId);
        if (pendingDraftKeyRef.current && pendingDraftKeyRef.current !== childId) {
          discardDraft(pendingDraftKeyRef.current);
        }
        removePendingSideChat(ctx.tabId);
        return true;
      } catch {
        if (current() && retiredChildRef.current !== childId) toast.error(t('chat.sideChat.closeFailed'));
        return false;
      }
    })();
    pendingClose.current = request;
    void request.then(() => { if (pendingClose.current === request) pendingClose.current = null; });
    return request;
  }, [closeChildId, confirm, ctx.sessionId, ctx.tabId, readChild, state.deviceId, t]);
  useEffect(() => ctx.setCloseInterceptor(close), [ctx, close]);
  const handlePendingSendStateChange = useCallback((queued: boolean) => {
    return setPendingSideChatQueuedSend(ctx.tabId, queued);
  }, [ctx.tabId]);
  const handlePendingDraftSettled = useCallback(() => {
    if (!state.sessionId) return;
    removePendingSideChat(ctx.tabId);
  }, [ctx.tabId, state.sessionId]);
  if (unavailableChild && unavailableChild === childId) return null;
  const role = collaboration?.childId === childId ? collaboration?.role : undefined;
  const collaborationActive = role === 'lead';
  const collaborationEnded = childId !== null && linkedChild === childId && role === null;
  const effectiveSnapshot = remoteSession?.id === childId
    ? remoteSession
    : pendingChildSession
      ? (state.deviceId ? { ...pendingChildSession, deviceLinkDeviceId: state.deviceId } : pendingChildSession)
      : !childId
        ? pending?.previewSession ?? null
        : null;
  const content = <SidebarHostSessionProvider sessionId={ctx.sessionId}>
    <div className="chat-rail-compact flex h-full min-h-0 flex-col">
      <div className="mx-4 flex items-center justify-between gap-2 border-b border-[var(--border-default)] py-3">
        <div className="text-13 leading-5 text-[var(--text-primary)]">
          <p>{t('chat.sideChat.context')}</p>
          {collaborationEnded && <p>{t('chat.sideChat.openFromTaskList')}</p>}
        </div>
        {childId && linkedChild === childId && (collaborationActive || collaborationEnded) && <Button size="sm" variant="secondary" tone="quiet" className="shrink-0"
          onClick={() => {
            const route = sideChatTaskRoute(childId, state.deviceId);
            if (collaborationActive) navigate(route, { state: { orcaWorkersReveal: { leadSessionId: childId } } });
            else navigate(route);
          }}>
          {collaborationActive
            ? <><UsersRound aria-hidden="true" size={14} />{t('chat.sideChat.viewCollaboration')}</>
            : <><MessagesSquare aria-hidden="true" size={14} />{t('chat.sideChat.openConversation')}</>}
        </Button>}
      </div>
      {creationFailed && <ErrorNotice
        className="mx-4 mt-3 shrink-0"
        message={pending?.errorMessage ?? t('chat.sideChat.failed')}
        actions={pending?.onRetry && <Button size="sm" compact onClick={() => pending.onRetry?.()}>{t('commonUi.retry')}</Button>}
      />}
      <div className="min-h-0 flex-1">
        {state.deviceId && !effectiveSnapshot && (loadFailed || remoteSession?.id !== childId) ? <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm leading-5 text-muted-foreground">{t(loadFailed ? 'chat.sideChat.failed' : 'chat.sideChat.opening')}</p>
          {loadFailed && <Button onClick={() => setRetry(value => value + 1)}>{t('commonUi.retry')}</Button>}
        </div> : effectiveSessionId && (!state.deviceId || registeredChild === childId || Boolean(effectiveSnapshot)) && <CCAgentSessionView
          key={ctx.tabId}
          sessionIdProp={effectiveSessionId}
          sessionSnapshotProp={effectiveSnapshot}
          draftKeyProp={effectiveDraftKey}
          awaitingSessionCreation={awaitingSessionCreation}
          creationFailed={creationFailed}
          onPendingSendStateChange={pending ? handlePendingSendStateChange : undefined}
          onPendingDraftSettled={pending && state.sessionId ? handlePendingDraftSettled : undefined}
          compact
          compactToolbar
          viewVisible={viewVisible}
          chatRealtime={chatRealtime}
          disableAutofocus={!viewVisible}
          focusComposerOnOpen={Boolean(pending && viewVisible)}
          navigationMode="sidebar-embedded"
          sidebarTargetSessionId={ctx.sessionId}
        />}
      </div>
    </div>
  </SidebarHostSessionProvider>;
  return content;
}
