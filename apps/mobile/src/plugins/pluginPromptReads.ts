import { REMOTE_DISPLAY_REUSE_MS } from '@/device-link/remoteResourceAvailability';
import { createPluginManagementClient, type PluginManagementInvoke } from './pluginManagementClient';
import { parsePluginUiConsent, pluginNeedsUiApproval, type PluginManagementSnapshot, type PluginUiConsentSnapshot } from './pluginManagementTypes';

export interface PluginPromptDisplay {
  capability: 'supported' | 'unsupported';
  snapshot: PluginManagementSnapshot | null;
  uiConsent?: PluginUiConsentSnapshot;
}

/** Display hints only. Controllers still read fresh Host facts before every mutation.
 * The owner/connection-scoped provider invalidates on pushes and foreground changes. */
export function createPluginPromptReads(invoke: PluginManagementInvoke, isCurrent: () => boolean, subscriptionIdentity: (deviceId: string) => number | null = () => 0) {
  const reads = new Map<string, Promise<PluginPromptDisplay>>();
  const loading = new Map<string, boolean>();
  const dirty = new Map<string, boolean>();
  const subscriptions = new Map<string, number | null>();
  const completedAt = new Map<string, number>();
  const invalidations = new Map<string, unknown>();
  return {
    invalidate(deviceId?: string, event?: unknown) {
      if (!deviceId) { for (const id of reads.keys()) dirty.set(id, true); reads.clear(); loading.clear(); invalidations.clear(); completedAt.clear(); subscriptions.clear(); return; }
      if (event !== undefined && invalidations.get(deviceId) === event) return;
      invalidations.set(deviceId, event);
      dirty.set(deviceId, true); completedAt.delete(deviceId); subscriptions.delete(deviceId);
      if (!loading.get(deviceId)) reads.delete(deviceId);
    },
    read(deviceId: string): Promise<PluginPromptDisplay> {
      if (!isCurrent()) return Promise.reject(new Error('PLUGIN_MANAGEMENT_STALE'));
      const existing = reads.get(deviceId);
      if (existing && loading.get(deviceId)) return existing;
      if (existing && !dirty.get(deviceId) && completedAt.has(deviceId) && (subscriptions.get(deviceId) !== null
        && subscriptions.get(deviceId) === subscriptionIdentity(deviceId)
        && Date.now() - completedAt.get(deviceId)! < REMOTE_DISPLAY_REUSE_MS)) return existing;
      const waitForBurst = dirty.get(deviceId) === true;
      dirty.delete(deviceId);
      completedAt.delete(deviceId);
      const subscriptionAtStart = subscriptionIdentity(deviceId);
      const client = createPluginManagementClient({ invoke, deviceId,
        isCurrent: () => isCurrent() && reads.get(deviceId) === read });
      const read = Promise.resolve().then(async (): Promise<PluginPromptDisplay> => {
        try {
          if (waitForBurst) await new Promise(resolve => setTimeout(resolve, 250));
          let result!: PluginPromptDisplay;
          for (;;) {
            if (!isCurrent() || reads.get(deviceId) !== read) throw new Error('PLUGIN_MANAGEMENT_STALE');
            // Notifications received during the debounce window are covered by this read.
            dirty.delete(deviceId);
            try {
              const capabilities = await client.capabilities();
              const capability = capabilities.snapshot || capabilities.uiConsent ? 'supported' : 'unsupported';
              const uiConsent = capabilities.uiConsent ? parsePluginUiConsent(await client.uiConsent()) : undefined;
              const snapshot = !uiConsent && capability === 'supported' ? await client.snapshot() : null;
              if (!isCurrent() || reads.get(deviceId) !== read) throw new Error('PLUGIN_MANAGEMENT_STALE');
              subscriptions.set(deviceId, subscriptionAtStart === subscriptionIdentity(deviceId) ? subscriptionAtStart : null);
              result = { capability, ...(uiConsent ? { uiConsent } : {}), snapshot: snapshot ? { ...snapshot,
                ghosts: snapshot.ghosts.filter(plugin => pluginNeedsUiApproval(plugin) && !plugin.uiPromptSuppressed),
                market: { items: [], unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] },
              } : null };
            } catch (error) {
              if (!client.isCurrent()) throw error;
              const refreshQueued = dirty.get(deviceId) === true;
              dirty.set(deviceId, true);
              // A queued notification earns one follow-up; failure alone never retries.
              if (!refreshQueued) throw error;
            }
            if (!dirty.get(deviceId)) break;
            dirty.delete(deviceId);
            await new Promise(resolve => setTimeout(resolve, 250));
          }
          completedAt.set(deviceId, Date.now());
          return result;
        } finally { if (reads.get(deviceId) === read) loading.delete(deviceId); }
      });
      loading.set(deviceId, true);
      reads.set(deviceId, read);
      void read.catch(() => { if (reads.get(deviceId) === read) reads.delete(deviceId); });
      return read;
    },
  };
}
