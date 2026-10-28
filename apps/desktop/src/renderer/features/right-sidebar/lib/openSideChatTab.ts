import { makerApiForSticky } from '@/lib/makerTransport';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { appendQuoteToDraft, saveDraft, clearDraft } from '@/lib/composerDraftStore';
import type { AttachedFile } from '@/lib/fileTypes';
import { textToTiptapDoc } from '@/components/chat/useForkAtMessage';
import { setStatus } from '@/lib/sessionService';
import { toast } from '@/lib/toast';
import i18n from '@/i18n';
import { extractIpcError } from '@/utils/ipcError';
import { createLogger } from '@/lib/logger';
import { createCoalescedRefresh } from '@/lib/coalescedRefresh';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { isSharedTaskPeer, remoteAgentErrorCode } from '@cindy/device-link';
import type { Session } from '@/lib/ccAgent.types';
import { addTab, closeTab, ensureHydrated, getBucket, setActiveTab, subscribe } from '../store';
import { mergeSidebarWindowBack } from './mergeSidebarWindowBack';
import { requestRightSidebarVisibility } from './sidebarCommands';
import { setTabGroup, type TabGroupId } from '../tabGroups';

export interface SideChatTabPlacement {
  groupId?: TabGroupId;
  onOptimisticAdd?: (tabId: string) => void;
}

const log = createLogger('side-chat');
const restoring = new Map<string, { revision: number; schedule: ReturnType<typeof createCoalescedRefresh<void>> }>();

export function canOpenSideChat(session: Session | null | undefined): boolean {
  return Boolean(session
    && session.status === 'active'
    && !['side-chat', 'bot', 'review'].includes(session.source ?? '')
    && !isSharedTaskPeer(session.deviceLinkDeviceId ?? ''));
}

/** Reconcile the host's branches on both the execution computer and its controllers. */
export function restoreSideChatTabs(sessionId: string, isActive: () => boolean = () => true): Promise<void> {
  const deviceId = getStickySessionDeviceId(sessionId) ?? null;
  const owner = getDataOwnerGeneration();
  const key = JSON.stringify([owner.dataOwnerId, owner.generation, deviceId, sessionId]);
  let entry = restoring.get(key);
  if (!entry) {
    entry = { revision: 0, schedule: createCoalescedRefresh<void>() };
    restoring.set(key, entry);
  }
  const current = entry;
  const revision = ++current.revision;
  const valid = () => isActive() && isDataOwnerGenerationCurrent(owner)
    && current.revision === revision && (getStickySessionDeviceId(sessionId) ?? null) === deviceId;
  return current.schedule(async () => {
    if (!valid()) return;
    // The detached window owns the tab bucket until its handoff completes. Its
    // temporary empty main-window projection must not create duplicate tabs.
    if ((await window.electronAPI.rightSidebarWindow?.getState())?.detached) return;
    await ensureHydrated(sessionId);
    if (!valid()) return;
    // Do not remove tabs created while an older list query was in flight.
    const previousTabs = getBucket(sessionId).tabs.filter(tab => tab.kind === 'side-chat');
    const children = await makerApiForSticky(sessionId).listSideChats(sessionId);
    if ((await window.electronAPI.rightSidebarWindow?.getState())?.detached) return;
    if (!valid()) return;
    const childIds = new Set(children.map(child => child.id));
    for (const tab of previousTabs) {
      if (!valid()) return;
      const childId = (tab.state as { sessionId?: string } | null)?.sessionId;
      if (childId && !childIds.has(childId)) {
        // The host already removed this branch. Do not ask to delete it again.
        await closeTab(sessionId, tab.id, { skipBeforeClose: true });
      }
    }
    for (const child of children) {
      if (!valid()) return;
      if (getBucket(sessionId).tabs.some(tab => tab.kind === 'side-chat'
        && (tab.state as { sessionId?: string } | null)?.sessionId === child.id)) continue;
      if (deviceId) remoteProjectsStore.pinSessionOrigin(deviceId, child.id);
      await addTab(sessionId, 'side-chat', { sessionId: child.id, deviceId }, { activate: false });
    }
  }).finally(() => {
    if (restoring.get(key) === current && current.revision === revision) restoring.delete(key);
  });
}

/** Subscribe before the initial read so a branch created during it is not missed. */
export function watchSideChatTabs(sessionId: string): () => void {
  const deviceId = getStickySessionDeviceId(sessionId) ?? null;
  const owner = getDataOwnerGeneration();
  let disposed = false;
  const valid = () => !disposed && isDataOwnerGenerationCurrent(owner);
  const refresh = () => {
    if (!valid()) return;
    void restoreSideChatTabs(sessionId, valid).catch(error => {
      if (valid()) log.warn('side chat recovery unavailable', { code: extractIpcError(error)?.code });
    });
  };
  const changed = (patch?: Partial<Session>) => {
    // Usage/title/streaming changes cannot affect branch membership.
    if (!patch || patch.status !== undefined || patch.parentSessionId !== undefined || patch.source !== undefined) refresh();
  };
  const off = deviceId
    ? [window.electronAPI.deviceLink.onRemotePush((push, stamp) => {
      if (push.deviceId !== deviceId || !isDeviceLinkRemotePushCurrent(push, stamp)) return;
      if (push.channel === 'local-db:sessions:created') changed();
      if (push.channel === 'local-db:sessions:patched') {
        const payload = push.payload as { patch?: Partial<Session> } | null;
        if (payload?.patch) changed(payload.patch);
      }
    })]
    : [
      window.electronAPI.localDb.sessionsPush.onCreated((_payload, stamp) => {
        if (isDataOwnerPushCurrent(stamp)) changed();
      }),
      window.electronAPI.localDb.sessionsPush.onPatched(({ patch }, stamp) => {
        if (isDataOwnerPushCurrent(stamp)) changed(patch);
      }),
    ];
  // Invalidate in-flight reads when MainLayout clears the handoff bucket, then
  // reconcile after its persisted tabs / in-memory snapshot arrive. Recovery
  // waits for hydration; ordinary tab edits must not trigger another read.
  let hydrated = getBucket(sessionId).hydrated;
  off.push(subscribe(changedSessionId => {
    if (changedSessionId !== sessionId || !valid()) return;
    const next = getBucket(sessionId).hydrated;
    if (hydrated === next) return;
    hydrated = next;
    refresh();
  }));
  refresh();
  return () => { disposed = true; off.forEach(unsubscribe => unsubscribe()); };
}

/** Open an independent follow-up on the parent's execution host. */
export async function openSideChatTab(
  sessionId: string,
  options: { prompt?: string; attachments?: AttachedFile[]; quote?: string; placement?: SideChatTabPlacement; assertSubmissionCurrent?: () => void } = {},
): Promise<boolean> {
  try {
    if ((await window.electronAPI.rightSidebarWindow?.getState())?.detached) {
      await mergeSidebarWindowBack(sessionId);
    }
    await ensureHydrated(sessionId);
    const deviceId = getStickySessionDeviceId(sessionId) ?? null;
    const child = await makerApiForSticky(sessionId).createSideChat(sessionId);
    if (deviceId) {
      remoteProjectsStore.pinSessionOrigin(deviceId, child.id);
      remoteProjectsStore.mergeDeviceSessions(deviceId, remoteProjectsStore.getDeviceName(deviceId) ?? '', [child]);
    }
    try {
      options.assertSubmissionCurrent?.();
      if (options.prompt || options.attachments?.length) saveDraft(child.id, {
        text: options.prompt ? textToTiptapDoc(options.prompt) : null,
        attachments: options.attachments ?? [],
      });
      if (options.quote) appendQuoteToDraft(child.id, { text: options.quote });
      // The creation broadcast may already have restored this tab.
      const existing = getBucket(sessionId).tabs.find(tab => tab.kind === 'side-chat'
        && (tab.state as { sessionId?: string } | null)?.sessionId === child.id);
      if (existing) {
        if (options.placement?.groupId) setTabGroup(existing.id, options.placement.groupId);
        options.placement?.onOptimisticAdd?.(existing.id);
        await setActiveTab(sessionId, existing.id);
      } else {
        await addTab(sessionId, 'side-chat', { sessionId: child.id, deviceId }, options.placement);
      }
      try {
        options.assertSubmissionCurrent?.();
      } catch (error) {
        const tab = getBucket(sessionId).tabs.find(item => item.kind === 'side-chat'
          && (item.state as { sessionId?: string } | null)?.sessionId === child.id);
        if (tab) await closeTab(sessionId, tab.id, { skipBeforeClose: true });
        throw error;
      }
    } catch (error) {
      // A failed tab write must not leave an unreachable branch running or listed.
      await setStatus(child.id, 'deleted', deviceId ? { kind: 'device-link', deviceId } : { kind: 'local' });
      if (deviceId) remoteProjectsStore.applyPatch(deviceId, child.id, { status: 'deleted' });
      // These files still belong to the parent's rejected send; do not recycle them.
      clearDraft(child.id);
      throw error;
    }
    // Menus in other groups or popout windows already own their visible host.
    if (!options.placement?.onOptimisticAdd && (!options.placement?.groupId || options.placement.groupId === 'right')) {
      requestRightSidebarVisibility('open', { sessionId, userInitiated: true });
    }
    return true;
  } catch (error) {
    const code = extractIpcError(error)?.code;
    const remoteCode = remoteAgentErrorCode(error instanceof Error ? error.message : String(error));
    log.warn('open failed', { code, remoteCode });
    const key = code === 'NO_PRIOR_ASSISTANT' ? 'notReady'
      : code === 'UNSUPPORTED_CAPABILITY' ? 'unsupported'
      : code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED' ? 'updateHost' : 'failed';
    toast.error(key === 'failed' && remoteCode
      ? i18n.t(`chat.remoteError.${remoteCode}`, { defaultValue: i18n.t('chat.sideChat.failed') })
      : i18n.t(`chat.sideChat.${key}`));
    return false;
  }
}
