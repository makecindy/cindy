import { REMOTE_DISPLAY_REUSE_MS } from '@/device-link/remoteResourceAvailability';
import { createPluginManagementClient, type PluginManagementInvoke } from './pluginManagementClient';
import { pluginNeedsUiApproval, type PluginManagementSnapshot } from './pluginManagementTypes';

export interface PluginPromptDisplay {
  capability: 'supported' | 'unsupported';
  snapshot: PluginManagementSnapshot | null;
}

/** Display hints only. Controllers still read fresh Host facts before every mutation.
 * The owner/connection-scoped provider invalidates on pushes and foreground changes. */
export function createPluginPromptReads(invoke: PluginManagementInvoke, isCurrent: () => boolean, subscriptionIdentity: (deviceId: string) => number | null = () => 0) {
  const reads = new Map<string, Promise<PluginPromptDisplay>>();
  const subscriptions = new Map<string, number | null>();
  const completedAt = new Map<string, number>();
  const invalidations = new Map<string, unknown>();
  return {
    invalidate(deviceId?: string, event?: unknown) {
      if (!deviceId) { reads.clear(); invalidations.clear(); completedAt.clear(); subscriptions.clear(); return; }
      if (event !== undefined && invalidations.get(deviceId) === event) return;
      invalidations.set(deviceId, event);
      reads.delete(deviceId); completedAt.delete(deviceId); subscriptions.delete(deviceId);
    },
    read(deviceId: string): Promise<PluginPromptDisplay> {
      if (!isCurrent()) return Promise.reject(new Error('PLUGIN_MANAGEMENT_STALE'));
      const existing = reads.get(deviceId);
      if (existing && (!completedAt.has(deviceId) || (subscriptions.get(deviceId) !== null
        && subscriptions.get(deviceId) === subscriptionIdentity(deviceId)
        && Date.now() - completedAt.get(deviceId)! < REMOTE_DISPLAY_REUSE_MS))) return existing;
      completedAt.delete(deviceId);
      const subscriptionAtStart = subscriptionIdentity(deviceId);
      const client = createPluginManagementClient({ invoke, deviceId,
        isCurrent: () => isCurrent() && reads.get(deviceId) === read });
      const read = Promise.resolve().then(async (): Promise<PluginPromptDisplay> => {
        const capability = await client.capability();
        const snapshot = capability === 'supported' ? await client.snapshot() : null;
        if (!isCurrent() || reads.get(deviceId) !== read) throw new Error('PLUGIN_MANAGEMENT_STALE');
        completedAt.set(deviceId, Date.now());
        subscriptions.set(deviceId, subscriptionAtStart === subscriptionIdentity(deviceId) ? subscriptionAtStart : null);
        // Do not retain market descriptions/icons or unrelated installed plugins for a chat hint.
        return { capability, snapshot: snapshot ? { ...snapshot,
          ghosts: snapshot.ghosts.filter(plugin => pluginNeedsUiApproval(plugin) && !plugin.uiPromptSuppressed),
          market: { items: [], unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] },
        } : null };
      });
      reads.set(deviceId, read);
      void read.catch(() => { if (reads.get(deviceId) === read) reads.delete(deviceId); });
      return read;
    },
  };
}
