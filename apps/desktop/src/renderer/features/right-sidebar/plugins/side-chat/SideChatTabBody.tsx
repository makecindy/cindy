import { useCallback, useEffect, useRef, useState } from 'react';
import { UsersRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from 'react-i18next';
import { CCAgentSessionView } from '@/features/cc-agent/CCAgentSessionView';
import { useSidebarNavigate } from '@/features/cc-agent/sidebar/sidebarNavigation';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { useDocumentVisible, useWindowVisible } from '@/hooks/useWindowVisible';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { makerChatStore } from '@/lib/makerChatStore';
import { discardDraft } from '@/lib/composerDraftStore';
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
  const childId = state.sessionId;
  const retiredChildRef = useRef<string | null>(null);
  const linkedChildRef = useRef<string | null>(null);
  const readChildRef = useRef<string | null>(null);
  const [linkedChild, setLinkedChild] = useState<string | null>(null);
  const [collaborationChild, setCollaborationChild] = useState<string | null>(null);
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
    setRegisteredChild(childId);
  }, [childId, state.deviceId]);
  useEffect(() => {
    const deviceId = state.deviceId;
    if (!childId) return;
    const owner = getDataOwnerGeneration();
    let disposed = false;
    let unavailable = false;
    let bufferedPatch: Partial<Session> = {};
    const valid = () => !disposed && isDataOwnerGenerationCurrent(owner);
    const dismiss = () => {
      if (!valid() || unavailable) return;
      unavailable = true;
      retiredChildRef.current = childId;
      // Unmount the composer immediately, even while tab persistence settles.
      setUnavailableChild(childId);
      makerChatStore.closeSessionQuery(childId);
      makerChatStore.purgeSession(childId);
      discardDraft(childId);
      void closeTab(ctx.sessionId, ctx.tabId, { skipBeforeClose: true })
        .catch(() => { if (valid()) toast.error(t('chat.sideChat.closeFailed')); });
    };
    const updateCollaboration = (snapshot: Partial<Session>) => {
      if (snapshot.sideChatPromoted) {
        linkedChildRef.current = childId;
        setLinkedChild(childId);
      }
      if (snapshot.orcaRole !== undefined) setCollaborationChild(snapshot.orcaRole === 'lead' ? childId : null);
    };
    const applyPatch = (payload: { sessionId?: string; patch?: Partial<Session> } | null) => {
      if (!valid() || unavailable || payload?.sessionId !== childId || !payload.patch) return;
      bufferedPatch = { ...bufferedPatch, ...payload.patch };
      if (payload.patch.status === 'deleted') { dismiss(); return; }
      updateCollaboration(bufferedPatch);
      if (deviceId) {
        setRemoteSession(previous => previous?.id === childId
          ? { ...previous, ...payload.patch, id: childId, deviceLinkDeviceId: deviceId }
          : previous);
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
      if (value.status === 'deleted') { dismiss(); return; }
      if (value.source !== 'side-chat' && !value.sideChatPromoted) throw new Error('Side chat owner mismatch');
      readChildRef.current = childId;
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
  const close = useCallback(async () => {
    if (!childId) return true;
    if (retiredChildRef.current === childId) return false;
    if (linkedChildRef.current === childId) return true;
    const owner = getDataOwnerGeneration();
    if (readChildRef.current !== childId) {
      const latest = await readChild(childId).catch(() => null);
      if (retiredChildRef.current === childId || !isDataOwnerGenerationCurrent(owner)) return false;
      if (linkedChildRef.current === childId || (latest?.id === childId
        && latest.parentSessionId === ctx.sessionId && latest.sideChatPromoted)) return true;
    }
    if (!await confirm({
      title: t('chat.sideChat.closeTitle'), description: t('chat.sideChat.closeDescription'),
      confirmText: t('chat.sideChat.closeConfirm'),
    })) return false;
    if (retiredChildRef.current === childId || !isDataOwnerGenerationCurrent(owner)) return false;
    if (linkedChildRef.current === childId) return true;
    try {
      await setStatus(childId, 'deleted', state.deviceId ? { kind: 'device-link', deviceId: state.deviceId } : { kind: 'local' },
        undefined, 'side-chat');
      makerChatStore.closeSessionQuery(childId);
      makerChatStore.purgeSession(childId);
      discardDraft(childId);
      return true;
    } catch (error) {
      if (extractIpcError(error)?.code === 'PRECONDITION_FAILED' && isDataOwnerGenerationCurrent(owner)) {
        // The host won a race with an older confirmation. Verify the same branch;
        // the failed conditional delete is never retried.
        const latest = await readChild(childId).catch(() => null);
        if (isDataOwnerGenerationCurrent(owner) && latest?.id === childId
          && latest.parentSessionId === ctx.sessionId && latest.sideChatPromoted && latest.status !== 'deleted') return true;
      }
      if (retiredChildRef.current !== childId) toast.error(t('chat.sideChat.closeFailed'));
      return false;
    }
  }, [childId, confirm, ctx.sessionId, readChild, state.deviceId, t]);
  useEffect(() => ctx.setCloseInterceptor(close), [ctx, close]);
  if (unavailableChild && unavailableChild === childId) return null;
  const content = <SidebarHostSessionProvider sessionId={ctx.sessionId}>
    <div className="chat-rail-compact flex h-full min-h-0 flex-col">
      <div className="mx-4 flex items-center justify-between gap-2 border-b border-[var(--border-default)] py-3">
        <p className="text-13 leading-5 text-[var(--text-primary)]">{t('chat.sideChat.context')}</p>
        {childId && linkedChild === childId && collaborationChild === childId && <Button size="sm" variant="secondary" tone="quiet" className="shrink-0"
          onClick={() => navigate(sideChatTaskRoute(childId, state.deviceId), {
            state: { orcaWorkersReveal: { leadSessionId: childId } },
          })}>
          <UsersRound aria-hidden="true" size={14} />{t('chat.sideChat.viewCollaboration')}
        </Button>}
      </div>
      <div className="min-h-0 flex-1">
        {state.deviceId && (loadFailed || remoteSession?.id !== childId) ? <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm leading-5 text-muted-foreground">{t(loadFailed ? 'chat.sideChat.failed' : 'chat.sideChat.opening')}</p>
          {loadFailed && <Button onClick={() => setRetry(value => value + 1)}>{t('commonUi.retry')}</Button>}
        </div> : childId && (!state.deviceId || registeredChild === childId) && <CCAgentSessionView
          key={childId}
          sessionIdProp={childId}
          sessionSnapshotProp={remoteSession}
          compact
          compactToolbar
          viewVisible={viewVisible}
          chatRealtime={chatRealtime}
          disableAutofocus={!viewVisible}
          navigationMode="sidebar-embedded"
          sidebarTargetSessionId={ctx.sessionId}
        />}
      </div>
    </div>
  </SidebarHostSessionProvider>;
  return content;
}
