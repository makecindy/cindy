import { PLUGIN_COLLECTION, REMOTE_RESOURCE_CHANGED_CHANNEL } from '@cindy/device-link';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { isGhostInstallApprovalToken } from '../../../shared/ghost';
import { projectPluginUiConsent, type PluginUiConsentSnapshot } from '../../../shared/pluginUiConsent';
import { boundedPluginResponse, invokePluginManagement, parsePluginManagementSnapshot,
  pluginManagementActions } from './remotePluginManagementClient';

type Listener = (snapshot: PluginUiConsentSnapshot) => void;
const entries = new Map<string, ReturnType<typeof createEntry>>();

function parseConsent(value: unknown): PluginUiConsentSnapshot {
  const data = value as PluginUiConsentSnapshot;
  if (!boundedPluginResponse(value) || data?.version !== 1
    || (data.uiCapabilityApproval !== undefined && data.uiCapabilityApproval !== true)
    || (data.item !== undefined && (!data.item || typeof data.item.instanceKey !== 'string'
      || !data.item.instanceKey || typeof data.item.name !== 'string'
      || !isGhostInstallApprovalToken(data.item.approvalToken)))) throw new Error('INVALID_RESPONSE');
  return data;
}

function createEntry(deviceId: string) {
  const owner = getDataOwnerGeneration();
  const listeners = new Set<Listener>();
  let snapshot: PluginUiConsentSnapshot | undefined;
  let actions: string[] | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  let loading = false;
  let dirty = false;
  let disposed = false;
  const current = () => !disposed && isDataOwnerGenerationCurrent(owner);
  const refresh = async () => {
    if (!current()) return;
    if (loading) { dirty = true; return; }
    if (timer) { clearTimeout(timer); timer = undefined; }
    loading = true;
    dirty = false;
    try {
      actions ??= await pluginManagementActions(deviceId);
      if (!current()) return;
      let next: PluginUiConsentSnapshot;
      if (actions.includes('management:ui-consent')) {
        next = parseConsent(await invokePluginManagement(deviceId, 'ui-consent'));
      } else if (actions.includes('management:snapshot')) {
        // Older Hosts retain their existing consent flow, but share one bounded read.
        const legacy = parsePluginManagementSnapshot(await invokePluginManagement(deviceId, 'snapshot'));
        next = projectPluginUiConsent(legacy.ghosts, legacy.uiCapabilityApproval === true);
      } else {
        // A Host can finish registering its resource providers after the first read.
        actions = undefined;
        next = { version: 1 };
      }
      if (!current()) return;
      snapshot = next;
      for (const listener of listeners) listener(next);
    } catch { /* A failed discovery never grants consent or removes the last good prompt. */ }
    finally {
      loading = false;
      if (dirty && current()) schedule();
    }
  };
  const schedule = () => {
    if (!current()) return;
    if (!listeners.size) { dirty = true; return; }
    if (loading) { dirty = true; return; }
    if (!timer) timer = setTimeout(() => { timer = undefined; void refresh(); }, 250);
  };
  const unlisten = window.electronAPI.deviceLink.onRemotePush((push, stamp) => {
    if (current() && push.deviceId === deviceId && push.channel === REMOTE_RESOURCE_CHANGED_CHANNEL
      && (push.payload as { collectionId?: unknown } | null)?.collectionId === PLUGIN_COLLECTION
      && isDeviceLinkRemotePushCurrent(push, stamp)) schedule();
  });
  return {
    owner, listeners, refresh,
    subscribe(listener: Listener) {
      if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = undefined; }
      listeners.add(listener);
      if (snapshot) listener(snapshot);
      if (!snapshot && !loading) void refresh();
      else if (dirty) schedule();
    },
    release(listener: Listener) {
      listeners.delete(listener);
      if (disposed || listeners.size || releaseTimer) return;
      // Route switches briefly unmount every composer. Keep the small projection and
      // invalidation listener, but do not fetch while no composer is using it.
      if (timer) { clearTimeout(timer); timer = undefined; dirty = true; }
      releaseTimer = setTimeout(() => invalidateRemotePluginUiConsent(deviceId), 30_000);
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (releaseTimer) clearTimeout(releaseTimer);
      unlisten();
      listeners.clear();
    },
  };
}

/** One subscription/read per controlled computer and renderer owner, shared by all composers. */
export function subscribeRemotePluginUiConsent(deviceId: string, listener: Listener): () => void {
  let entry = entries.get(deviceId);
  if (entry && !isDataOwnerGenerationCurrent(entry.owner)) {
    entry.dispose();
    entries.delete(deviceId);
    entry = undefined;
  }
  if (!entry) { entry = createEntry(deviceId); entries.set(deviceId, entry); }
  entry.subscribe(listener);
  return () => entry.release(listener);
}

/** Disconnects must not carry cached consent discovery into a new connection. */
export function invalidateRemotePluginUiConsent(deviceId: string): void {
  entries.get(deviceId)?.dispose();
  entries.delete(deviceId);
}

export async function refreshRemotePluginUiConsent(deviceId: string): Promise<void> {
  await entries.get(deviceId)?.refresh();
}
