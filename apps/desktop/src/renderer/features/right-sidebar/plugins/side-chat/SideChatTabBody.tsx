import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { makerChatStore } from '@/lib/makerChatStore';
import { discardDraft } from '@/lib/composerDraftStore';
import { setStatus } from '@/lib/sessionService';
import { isSidebarWindow } from '@/lib/sidebarWindow';
import { toast } from '@/lib/toast';
import type { Session } from '@/lib/ccAgent.types';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { SidebarHostSessionProvider } from '../../lib/sidebarHostSession';
import { mergeSidebarWindowBack } from '../../lib/mergeSidebarWindowBack';
import { closeTab } from '../../store';
import { requestRightSidebarVisibility } from '../../lib/sidebarCommands';
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

function AttachedSideChat({ state, ctx, active }: TabKindBodyProps<SideChatState>) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const navigate = useNavigate();
  const childId = state.sessionId;
  const [remoteSession, setRemoteSession] = useState<Session | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [unavailableChild, setUnavailableChild] = useState<string | null>(null);
  // Register before mounting the child: hidden branches are absent from the ordinary task list.
  const [registeredChild, setRegisteredChild] = useState<string | null>(null);
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
      // Unmount the composer immediately, even while tab persistence settles.
      setUnavailableChild(childId);
      makerChatStore.closeSessionQuery(childId);
      makerChatStore.purgeSession(childId);
      discardDraft(childId);
      void closeTab(ctx.sessionId, ctx.tabId, { skipBeforeClose: true })
        .catch(() => { if (valid()) toast.error(t('chat.sideChat.closeFailed')); });
    };
    const applyPatch = (payload: { sessionId?: string; patch?: Partial<Session> } | null) => {
      if (!valid() || unavailable || payload?.sessionId !== childId || !payload.patch) return;
      bufferedPatch = { ...bufferedPatch, ...payload.patch };
      if (payload.patch.status === 'deleted') { dismiss(); return; }
      if (deviceId) {
        setRemoteSession(previous => previous?.id === childId
          ? { ...previous, ...payload.patch, id: childId, source: 'side-chat', deviceLinkDeviceId: deviceId }
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
      if (!deviceId || !active) return;
      const value = await window.electronAPI.deviceLink.invoke(deviceId, 'local-db:sessions:get', [childId]) as Session;
      if (!valid() || unavailable) return;
      if (!value) { dismiss(); return; }
      if (value.id !== childId || value.source !== 'side-chat' || value.parentSessionId !== ctx.sessionId) {
        throw new Error('Side chat owner mismatch');
      }
      const snapshot: Session = { ...value, ...bufferedPatch, id: childId, source: 'side-chat', deviceLinkDeviceId: deviceId };
      if (snapshot.status === 'deleted') { dismiss(); return; }
      setRemoteSession(snapshot);
    };
    void read().catch(() => { if (valid() && !unavailable) setLoadFailed(true); });
    return () => { disposed = true; off(); };
  }, [active, childId, ctx.sessionId, ctx.tabId, retry, state.deviceId, t]);
  const close = useCallback(async () => {
    if (!childId || unavailableChild === childId) return true;
    if (!await confirm({
      title: t('chat.sideChat.closeTitle'), description: t('chat.sideChat.closeDescription'),
      confirmText: t('chat.sideChat.closeConfirm'),
    })) return false;
    try {
      await setStatus(childId, 'deleted', state.deviceId ? { kind: 'device-link', deviceId: state.deviceId } : { kind: 'local' });
      makerChatStore.closeSessionQuery(childId);
      makerChatStore.purgeSession(childId);
      discardDraft(childId);
      return true;
    } catch {
      toast.error(t('chat.sideChat.closeFailed'));
      return false;
    }
  }, [childId, confirm, state.deviceId, t, unavailableChild]);
  useEffect(() => ctx.setCloseInterceptor(close), [ctx, close]);
  if (unavailableChild && unavailableChild === childId) return null;
  const content = <SidebarHostSessionProvider sessionId={ctx.sessionId}>
    <div className="chat-rail-compact flex h-full min-h-0 flex-col">
      <p className="px-4 py-3 text-xs leading-5 text-muted-foreground">{t('chat.sideChat.context')}</p>
      <div className="min-h-0 flex-1">
        {state.deviceId && (loadFailed || remoteSession?.id !== childId) ? <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm leading-5 text-muted-foreground">{t(loadFailed ? 'chat.sideChat.failed' : 'chat.sideChat.opening')}</p>
          {loadFailed && <Button onClick={() => setRetry(value => value + 1)}>{t('commonUi.retry')}</Button>}
        </div> : childId && (!state.deviceId || registeredChild === childId) && <div className="flex h-full items-center justify-center px-6">
          <Button variant="secondary" onClick={() => {
            if (state.deviceId && remoteSession?.id === childId) {
              remoteProjectsStore.mergeDeviceSessions(state.deviceId,
                remoteProjectsStore.getDeviceName(state.deviceId) ?? '', [remoteSession]);
            }
            requestRightSidebarVisibility('close', { sessionId: childId, animate: false });
            navigate(sideChatTaskRoute(childId, state.deviceId));
          }}>
            {t('chat.sideChat.openPage')}
          </Button>
        </div>}
      </div>
    </div>
  </SidebarHostSessionProvider>;
  return content;
}
