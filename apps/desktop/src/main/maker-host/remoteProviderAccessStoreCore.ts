/**
 * Electron-free core for 远程 Agent 的供应商级授权 (remote-provider-access-prefs.json).
 *
 * 每台电脑、每个 Cindy 账号各自保存一份。「允许被远程调用」(allowedProviders) 是逐个供应商、
 * 默认关闭的开关，由 Desktop (remote-provider-access-store.ts) 与 Node Host 共用。
 */
import { ownerScopedPath as ownerScopedUserDataPath } from '../ownerContext.js';
import { createOverrideSettingsFile } from './override-settings-file.js';
import { desktopMakerLogger } from './logger-adapter.js';
import { remoteAccessProviderId } from './mergedProviderPool.js';

interface RemoteProviderAccessPrefs {
  allowedProviders: Record<string, true>;
  /** 11-10 版本留下的关闭记录；本版本只为兼容继续写，不再读。 */
  disabledProviders: Record<string, true>;
  /** 11-10 版本的「默认开放」迁移标记；本版本不再读。 */
  defaultOpen: boolean;
  /** 旧版本按分享快照补记过的标记；本版本不再读写其含义，只原样保留。 */
  defaultOpenReverted: boolean;
}

const DEFAULTS: RemoteProviderAccessPrefs = {
  allowedProviders: {}, disabledProviders: {}, defaultOpen: false, defaultOpenReverted: false,
};
const MAX_ENTRIES = 4096;

function providerSet(source: unknown): Record<string, true> {
  const out: Record<string, true> = {};
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const [providerId, enabled] of Object.entries(source as Record<string, unknown>)) {
      if (enabled !== true || !providerId) continue;
      if (Object.keys(out).length >= MAX_ENTRIES) break;
      out[providerId] = true;
    }
  }
  return out;
}

export function normalizeRemoteProviderAccessPrefs(raw: unknown): RemoteProviderAccessPrefs {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as { allowedProviders?: unknown; disabledProviders?: unknown; defaultOpen?: unknown; defaultOpenReverted?: unknown }
    : {};
  return {
    allowedProviders: providerSet(value.allowedProviders),
    disabledProviders: providerSet(value.disabledProviders),
    defaultOpen: value.defaultOpen === true,
    defaultOpenReverted: value.defaultOpenReverted === true,
  };
}

export interface RemoteProviderAccessStorePorts {
  withAvailabilityPolicyMutation<T>(providerId: string, work: () => Promise<T>): Promise<T>;
}

export function createRemoteProviderAccessStore(ports: RemoteProviderAccessStorePorts) {
  let permissionGeneration = 0;
  const permissionEpochs = new Map<string, number>();
  const accessListeners = new Set<(providerId: string) => void>();
  const log = desktopMakerLogger.child('remote-provider-access-store');

  function bumpEpoch(providerId: string): void {
    if (!permissionEpochs.has(providerId) && permissionEpochs.size >= MAX_ENTRIES) {
      permissionGeneration++;
      permissionEpochs.clear();
    }
    permissionEpochs.set(providerId, (permissionEpochs.get(providerId) ?? 0) + 1);
  }

  const store = createOverrideSettingsFile<RemoteProviderAccessPrefs>({
    filePath: () => ownerScopedUserDataPath('remote-provider-access-prefs.json'),
    defaults: DEFAULTS,
    normalize: normalizeRemoteProviderAccessPrefs,
    log,
    label: 'remote-provider-access',
    maxBytes: 256 * 1024,
  });

  function onRemoteProviderAccessChanged(listener: (providerId: string) => void): () => void {
    accessListeners.add(listener);
    return () => { accessListeners.delete(listener); };
  }

  /** Process-local fences: restarting also discards all retained group routing contexts. */
  function remoteProviderAccessEpoch(providerId: string): string {
    return `${permissionGeneration}:${permissionEpochs.get(remoteAccessProviderId(providerId)) ?? 0}`;
  }

  /** 「允许被远程调用」：自己的其他电脑、分享出去的人与供应商组共用这一个开关。 */
  function isRemoteProviderInvocationAllowed(providerId: string): boolean {
    if (!providerId) return false;
    store.invalidateIfChanged(60_000);
    return store.read().allowedProviders[remoteAccessProviderId(providerId)] === true;
  }

  async function setRemoteProviderInvocationEnabled(providerId: string, enabled: boolean): Promise<void> {
    return ports.withAvailabilityPolicyMutation(providerId, async () => {
      if (!providerId) return;
      store.invalidateIfChanged();
      const prefs = store.read();
      const allowedProviders = { ...prefs.allowedProviders };
      const disabledProviders = { ...prefs.disabledProviders };
      if (enabled) {
        if (allowedProviders[providerId] === true && disabledProviders[providerId] !== true) return;
        if (Object.keys(allowedProviders).length >= MAX_ENTRIES) {
          throw new Error('remote provider access limit reached');
        }
        allowedProviders[providerId] = true;
        delete disabledProviders[providerId];
      } else {
        // 关闭也记进 disabledProviders：退回 11-10 的版本时，它按这份记录保持关闭。
        if (!(providerId in allowedProviders) && disabledProviders[providerId] === true) return;
        if (disabledProviders[providerId] !== true && Object.keys(disabledProviders).length >= MAX_ENTRIES) {
          throw new Error('remote provider access limit reached');
        }
        delete allowedProviders[providerId];
        disabledProviders[providerId] = true;
      }
      store.writePatch({ allowedProviders, disabledProviders });
      bumpEpoch(providerId);
      for (const listener of accessListeners) {
        try { listener(providerId); } catch { log.warn('remote provider access listener failed'); }
      }
      log.info('remote provider access updated', { providerId, enabled });
    });
  }

  return {
    onRemoteProviderAccessChanged,
    remoteProviderAccessEpoch,
    isRemoteProviderInvocationAllowed,
    setRemoteProviderInvocationEnabled,
    __testing: { normalize: normalizeRemoteProviderAccessPrefs },
  };
}
