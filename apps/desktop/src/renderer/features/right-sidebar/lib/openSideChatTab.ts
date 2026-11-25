import { makerApiForSticky } from '@/lib/makerTransport';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { sessionsStore } from '@/lib/sessionsStore';
import {
  appendQuoteToDraft,
  clearDraft,
  draftHasContent,
  flushDraft,
  getDraft,
  saveDraft,
} from '@/lib/composerDraftStore';
import type { AttachedFile } from '@/lib/fileTypes';
import { textToTiptapDoc } from '@/components/chat/useForkAtMessage';
import { setStatus } from '@/lib/sessionService';
import { toast } from '@/lib/toast';
import i18n from '@/i18n';
import { extractIpcError } from '@/utils/ipcError';
import { createLogger } from '@/lib/logger';
import { createCoalescedRefresh } from '@/lib/coalescedRefresh';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { isSharedTaskPeer, remoteAgentErrorCode } from '@cindy/device-link';
import { isPluginEngineKind } from '../../../../shared/pluginEngines';
import type { Session } from '@/lib/ccAgent.types';
import { readSessionBatch } from '@/lib/sessionBatchRead';
import { standardSessionRoute } from '@/lib/orcaSessionIdentity';
import type { NavigateFunction } from 'react-router-dom';
import { addTab, closeTab, ensureHydrated, getBucket, patchTabState, setActiveTab, subscribe } from '../store';
import { mergeSidebarWindowBack } from './mergeSidebarWindowBack';
import { requestRightSidebarVisibility } from './sidebarCommands';
import type { TabGroupId } from '../tabGroups';
import { hydrateSideChatState } from '../plugins/side-chat/state';
import {
  buildPreviewSideChatSession,
  cancelPendingSideChat,
  createPendingSideChatDraftKey,
  failPendingSideChat,
  getPendingSideChat,
  hasInFlightSideChatForParent,
  isChildClaimedByPendingSideChat,
  markPendingSideChatRetrying,
  registerPendingSideChat,
  removePendingSideChat,
  resolvePendingSideChat,
} from '../plugins/side-chat/pendingSideChat';

export interface SideChatTabPlacement {
  groupId?: TabGroupId;
  onOptimisticAdd?: (tabId: string) => void;
}

const log = createLogger('side-chat');
const restoring = new Map<string, { revision: number; schedule: ReturnType<typeof createCoalescedRefresh<void>> }>();
/** Parents whose branch restore arrived while an optimistic creation was in flight. */
const deferredRestores = new Set<string>();

function resolveLocalParentSession(sessionId: string, deviceId: string | null): Session | null {
  if (deviceId) {
    const remote = remoteProjectsStore.getDeviceSessions?.(deviceId)?.find(row => row.id === sessionId);
    if (remote) return remote;
  }
  return sessionsStore.findById?.(sessionId) ?? null;
}

function formatSideChatOpenError(error: unknown): string {
  const code = extractIpcError(error)?.code;
  const remoteCode = remoteAgentErrorCode(error instanceof Error ? error.message : String(error));
  log.warn('open failed', { code, remoteCode });
  const key = code === 'NO_PRIOR_ASSISTANT' ? 'notReady'
    : code === 'UNSUPPORTED_CAPABILITY' ? 'unsupported'
    : code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED' ? 'updateHost' : 'failed';
  return key === 'failed' && remoteCode
    ? i18n.t(`chat.remoteError.${remoteCode}`, { defaultValue: i18n.t('chat.sideChat.failed') })
    : i18n.t(`chat.sideChat.${key}`);
}

async function deleteOrphanSideChat(
  childId: string,
  deviceId: string | null,
  owner: DataOwnerGeneration,
): Promise<void> {
  if (!isDataOwnerGenerationCurrent(owner)) return;
  await setStatus(childId, 'deleted', deviceId ? { kind: 'device-link', deviceId } : { kind: 'local' }, undefined, 'side-chat')
    .catch(err => log.warn('orphan side chat cleanup failed', { childId, err }));
  if (deviceId && isDataOwnerGenerationCurrent(owner)) {
    remoteProjectsStore.applyPatch(deviceId, childId, { status: 'deleted' });
  }
}

function flushDeferredRestore(parentSessionId: string, owner: DataOwnerGeneration): void {
  if (!deferredRestores.has(parentSessionId)) return;
  if (!isDataOwnerGenerationCurrent(owner) || hasInFlightSideChatForParent(parentSessionId)) return;
  deferredRestores.delete(parentSessionId);
  void restoreSideChatTabs(parentSessionId).catch(error => {
    if (isDataOwnerGenerationCurrent(owner)) {
      log.warn('deferred side chat recovery unavailable', { code: extractIpcError(error)?.code });
    }
  });
}

function settlePendingSideChatCreation(
  sessionId: string,
  tabId: string,
  draftKey: string,
  deviceId: string | null,
  owner: DataOwnerGeneration,
  creationPromise: Promise<Session>,
): void {
  void creationPromise.then(
    async (child) => {
      if (!isDataOwnerGenerationCurrent(owner)) return;
      const pending = getPendingSideChat(tabId);
      const tabStillOpen = getBucket(sessionId).tabs.some(tab => tab.id === tabId);
      if (!pending || pending.status === 'cancelled' || !tabStillOpen) {
        removePendingSideChat(tabId);
        await deleteOrphanSideChat(child.id, deviceId, owner);
        flushDeferredRestore(sessionId, owner);
        return;
      }
      if (deviceId) {
        remoteProjectsStore.pinSessionOrigin(deviceId, child.id);
        remoteProjectsStore.mergeDeviceSessions(deviceId, remoteProjectsStore.getDeviceName(deviceId) ?? '', [child]);
      }
      // If a creation broadcast restored a separate tab before we bound this one,
      // remove the duplicate and keep the tab the user is already typing in.
      const duplicate = getBucket(sessionId).tabs.find(tab => tab.id !== tabId && tab.kind === 'side-chat'
        && (tab.state as { sessionId?: string } | null)?.sessionId === child.id);
      if (duplicate) {
        await closeTab(sessionId, duplicate.id, { skipBeforeClose: true }).catch(() => undefined);
      }
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (getPendingSideChat(tabId)?.status === 'cancelled'
        || !getBucket(sessionId).tabs.some(tab => tab.id === tabId)) {
        removePendingSideChat(tabId);
        await deleteOrphanSideChat(child.id, deviceId, owner);
        flushDeferredRestore(sessionId, owner);
        return;
      }
      resolvePendingSideChat(tabId, child);
      try {
        await patchTabState(sessionId, tabId, () => ({ sessionId: child.id, deviceId }));
      } catch (error) {
        log.warn('side chat tab bind failed', { sessionId, tabId, childId: child.id, error });
        const message = formatSideChatOpenError(error);
        // The child is already a usable side-chat session. Keep it attached to
        // the pending record so the user can retry only the tab-state bind
        // without losing a draft or deleting the branch they may have used.
        failPendingSideChat(tabId, message);
        if (isDataOwnerGenerationCurrent(owner)) toast.error(message);
      } finally {
        flushDeferredRestore(sessionId, owner);
      }
    },
    async (error) => {
      if (!isDataOwnerGenerationCurrent(owner)) return;
      const pending = getPendingSideChat(tabId);
      const tabStillOpen = getBucket(sessionId).tabs.some(tab => tab.id === tabId);
      if (!pending || pending.status === 'cancelled' || !tabStillOpen) {
        removePendingSideChat(tabId);
        flushDeferredRestore(sessionId, owner);
        return;
      }
      const message = formatSideChatOpenError(error);
      toast.error(message);
      flushDraft(draftKey);
      const hasUserContent = draftHasContent(getDraft(draftKey)) || pending.hasQueuedSend;
      if (hasUserContent) {
        failPendingSideChat(tabId, message);
      } else {
        clearDraft(draftKey);
        removePendingSideChat(tabId);
        await closeTab(sessionId, tabId, { skipBeforeClose: true }).catch(() => undefined);
      }
      flushDeferredRestore(sessionId, owner);
    },
  );
}

/** Retry a failed optimistic side-chat creation in place without losing the user's draft. */
export function retryPendingSideChatCreation(parentSessionId: string, tabId: string): boolean {
  const pending = getPendingSideChat(tabId);
  if (!pending || pending.parentSessionId !== parentSessionId || pending.status !== 'failed') return false;
  const owner = getDataOwnerGeneration();
  markPendingSideChatRetrying(tabId);
  if (pending.childSession) {
    const child = pending.childSession;
    void patchTabState(parentSessionId, tabId, () => ({
      sessionId: child.id,
      deviceId: pending.deviceId,
    })).then(() => {
      if (!isDataOwnerGenerationCurrent(owner)) return;
      resolvePendingSideChat(tabId, child);
    }).catch(error => {
      if (!isDataOwnerGenerationCurrent(owner)) return;
      failPendingSideChat(tabId, formatSideChatOpenError(error));
    });
    return true;
  }
  const creationPromise = makerApiForSticky(parentSessionId).createSideChat(parentSessionId);
  settlePendingSideChatCreation(parentSessionId, tabId, pending.draftKey, pending.deviceId, owner, creationPromise);
  return true;
}

export type SideChatUnavailableKey =
  | 'chat.sideChat.sharedTaskUnavailable'
  | 'chat.sideChat.mainTaskOnly'
  | 'chat.sideChat.archivedTask'
  | 'chat.sideChat.failed';

/**
 * Why this task cannot open a side chat, as an i18n key; null when it can.
 * `deviceId` is the caller's resolved origin; the list snapshot may not carry it yet.
 */
export function sideChatUnavailableKey(
  session: Session | null | undefined,
  deviceId?: string | null,
): SideChatUnavailableKey | null {
  // The host never lets shared-task guests create or list branches (#9136).
  if (isSharedTaskPeer(deviceId ?? '') || isSharedTaskPeer(session?.deviceLinkDeviceId ?? '')) {
    return 'chat.sideChat.sharedTaskUnavailable';
  }
  if (!session) return 'chat.sideChat.failed';
  if (['side-chat', 'bot', 'review'].includes(session.source ?? '')) return 'chat.sideChat.mainTaskOnly';
  if (session.status === 'archived') return 'chat.sideChat.archivedTask';
  return session.status === 'active' ? null : 'chat.sideChat.failed';
}

export function canOpenSideChat(session: Session | null | undefined): boolean {
  return sideChatUnavailableKey(session) === null;
}

/** Reconcile the host's branches on both the execution computer and its controllers. */
export function restoreSideChatTabs(sessionId: string, isActive: () => boolean = () => true): Promise<void> {
  const deviceId = getStickySessionDeviceId(sessionId) ?? null;
  // Shared-task guests own no branches; the host rejects their list reads. Check
  // on every read: a watcher may start before the guest origin resolves.
  if (isSharedTaskPeer(deviceId ?? '')) return Promise.resolve();
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
    const orphanedPendingTabs: string[] = [];
    const unlisted = previousTabs.flatMap(tab => {
      const childId = (tab.state as { sessionId?: string } | null)?.sessionId;
      if (!childId) {
        if (!getPendingSideChat(tab.id)) orphanedPendingTabs.push(tab.id);
        return [];
      }
      return !childIds.has(childId) ? [{ tabId: tab.id, childId }] : [];
    });
    for (const tabId of orphanedPendingTabs) {
      if (!valid()) return;
      await closeTab(sessionId, tabId, { skipBeforeClose: true });
    }
    // Linked tasks are absent from the recovery list. Check existing unmatched
    // tabs for terminal status before dropping the stored label.
    const details = new Map((await readSessionBatch(unlisted.map(tab => tab.childId), deviceId ?? undefined))
      .map(result => [result.sessionId, result]));
    for (const { tabId, childId } of unlisted) {
      if (!valid()) return;
      const result = details.get(childId);
      if (result?.value?.status === 'deleted'
        || (result?.value?.status === 'archived' && result.value.sideChatPromoted && result.value.orcaRole !== 'lead')
        || result?.errorCode === 'NOT_FOUND') {
        await closeTab(sessionId, tabId, { skipBeforeClose: true });
      }
    }
    if (hasInFlightSideChatForParent(sessionId)) {
      // Wait for the optimistic tab on this parent to claim its new child before
      // adding unknown children from the host list, preventing duplicate tabs.
      deferredRestores.add(sessionId);
      return;
    }
    for (const child of children) {
      if (!valid()) return;
      if (isChildClaimedByPendingSideChat(sessionId, child.id)) continue;
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
    if (!patch || patch.status !== undefined || (patch.sideChatPromoted !== true
      && (patch.parentSessionId !== undefined || patch.source !== undefined))) refresh();
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

export function findLinkedSideChatTab(parentId: string, childId: string, deviceId: string | null) {
  return getBucket(parentId).tabs.find(tab => {
    if (tab.kind !== 'side-chat') return false;
    const state = hydrateSideChatState(tab.state);
    return state.sessionId === childId && state.deviceId === deviceId;
  });
}

/** Return to the original parent's existing tab, or reopen that same task there. */
export async function reopenLinkedSideChat(
  parentId: string, childId: string, deviceId: string | null, navigate: NavigateFunction,
): Promise<void> {
  if (deviceId && isSharedTaskPeer(deviceId)) throw new Error('Side chat parent unavailable');
  const owner = getDataOwnerGeneration();
  const [parent, child] = await readSessionBatch([parentId, childId], deviceId ?? undefined);
  if (!isDataOwnerGenerationCurrent(owner)) return;
  if (parent?.value?.id !== parentId || parent.value.status === 'deleted' || parent.value.hiddenAt) {
    throw new Error('Side chat parent unavailable');
  }
  if (child?.value?.id !== childId || child.value.parentSessionId !== parentId
    || child.value.status !== 'active' || !child.value.sideChatPromoted) {
    throw new Error('Linked follow-up is no longer active');
  }
  if ((await window.electronAPI.rightSidebarWindow?.getState())?.detached) {
    if (!isDataOwnerGenerationCurrent(owner)) return;
    await mergeSidebarWindowBack(parentId);
  }
  if (!isDataOwnerGenerationCurrent(owner)) return;
  if (deviceId) {
    remoteProjectsStore.pinSessionOrigin(deviceId, parentId);
    remoteProjectsStore.pinSessionOrigin(deviceId, childId);
  }
  await ensureHydrated(parentId);
  if (!isDataOwnerGenerationCurrent(owner)) return;
  const existing = findLinkedSideChatTab(parentId, childId, deviceId);
  if (existing) await setActiveTab(parentId, existing.id);
  else await addTab(parentId, 'side-chat', { sessionId: childId, deviceId });
  if (!isDataOwnerGenerationCurrent(owner)) return;
  requestRightSidebarVisibility('open', { sessionId: parentId, userInitiated: false });
  navigate(standardSessionRoute(parentId, deviceId));
}

/** Open an independent follow-up immediately while forking on the parent's execution host. */
export async function openSideChatTab(
  sessionId: string,
  options: { prompt?: string; attachments?: AttachedFile[]; quote?: string; placement?: SideChatTabPlacement } = {},
): Promise<boolean> {
  const deviceId = getStickySessionDeviceId(sessionId) ?? null;
  // Shared-task guests cannot create branches on the host (#9136). Answer
  // locally instead of sending a request the host will deny.
  if (isSharedTaskPeer(deviceId ?? '')) {
    toast.info(i18n.t('chat.sideChat.sharedTaskUnavailable'));
    return false;
  }
  const parentSession = resolveLocalParentSession(sessionId, deviceId);
  if (parentSession) {
    const unavailableKey = sideChatUnavailableKey(parentSession, deviceId);
    if (unavailableKey) {
      toast.info(i18n.t(unavailableKey));
      return false;
    }
    if (isPluginEngineKind(parentSession.agentKind)) {
      toast.error(i18n.t('chat.sideChat.failed'));
      return false;
    }
    if (parentSession.remoteHostId) {
      toast.error(i18n.t('chat.sideChat.unsupported'));
      return false;
    }
  }
  const owner = getDataOwnerGeneration();
  const draftKey = createPendingSideChatDraftKey();
  const hasTransferredAttachments = Boolean(options.attachments?.length);
  let registeredTabId: string | null = null;
  let creationPromise: Promise<Session> | null = null;
  try {
    if ((await window.electronAPI.rightSidebarWindow?.getState())?.detached) {
      if (!isDataOwnerGenerationCurrent(owner)) return false;
      await mergeSidebarWindowBack(sessionId);
    }
    if (!isDataOwnerGenerationCurrent(owner)) return false;
    await ensureHydrated(sessionId);
    if (!isDataOwnerGenerationCurrent(owner)) return false;
    const previewSession = buildPreviewSideChatSession(sessionId, parentSession, draftKey, deviceId);
    if (options.prompt || options.attachments?.length) {
      saveDraft(draftKey, {
        text: options.prompt ? textToTiptapDoc(options.prompt) : null,
        attachments: options.attachments ?? [],
      });
    }
    if (options.quote) appendQuoteToDraft(draftKey, { text: options.quote });
    // Start the fork in parallel with adding the optimistic tab so the user can
    // start typing immediately without waiting for the host fork to complete.
    creationPromise = makerApiForSticky(sessionId).createSideChat(sessionId);
    const registerForTab = (tabId: string) => {
      registeredTabId = tabId;
      registerPendingSideChat({
        tabId,
        draftKey,
        parentSessionId: sessionId,
        deviceId,
        previewSession,
        status: 'creating',
        childSession: null,
        hasTransferredAttachments,
        onRetry: () => {
          retryPendingSideChatCreation(sessionId, tabId);
        },
      });
    };
    const tab = await addTab(sessionId, 'side-chat', { sessionId: null, deviceId }, {
      ...options.placement,
      onOptimisticAdd: (tabId) => {
        registerForTab(tabId);
        options.placement?.onOptimisticAdd?.(tabId);
      },
    });
    if (!registeredTabId) registerForTab(tab.id);
    // Menus in other groups or popout windows already own their visible host.
    if (!options.placement?.onOptimisticAdd && (!options.placement?.groupId || options.placement.groupId === 'right')) {
      requestRightSidebarVisibility('open', { sessionId, userInitiated: true });
    }
    settlePendingSideChatCreation(sessionId, tab.id, draftKey, deviceId, owner, creationPromise);
    return true;
  } catch (error) {
    if (registeredTabId) {
      cancelPendingSideChat(registeredTabId);
      removePendingSideChat(registeredTabId);
    }
    // These files still belong to the parent's rejected send; do not recycle them.
    clearDraft(draftKey);
    if (creationPromise) {
      void creationPromise.then(
        child => deleteOrphanSideChat(child.id, deviceId, owner),
        () => undefined,
      );
    }
    toast.error(formatSideChatOpenError(error));
    return false;
  }
}
