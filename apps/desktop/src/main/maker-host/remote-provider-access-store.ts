import { withAvailabilityPolicyMutation } from '../device-link/providerShareAvailabilityPolicy.js';
/**
 * 远程 Agent 的供应商级授权。每台电脑、每个 Cindy 账号各自保存一份。
 *
 * - 「允许被远程调用」(allowedProviders)：逐个供应商、默认关闭，用户在模型供应商页打开。这是别的电脑
 *   能否用这个供应商的唯一开关(2026-11-18 用户裁决)：打开后自己账号下的其他电脑以信任模式完全可用，
 *   分享出去的人按各自分享使用。并进账号池的旧连接没有自己的开关，跟随所属账号池。
 *   曾经的「让我的其他电脑用本机模型」总开关(ownComputerModelUse)已删除，文件里残留的值不再读取。
 *
 * 2026-11-10 的版本曾把所有供应商默认对自己的电脑开放(defaultOpen / disabledProviders)。这里不读 defaultOpen，
 * 也不按旧的分享快照补记任何供应商(2026-11-18：旧配置一律不再处理)：只有用户自己打开过的才在 allowedProviders 里。
 * 两个旧字段原样保留在文件里、继续记录关闭，退回 11-10 的版本时也不会重新打开用户关掉的供应商。
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
let permissionGeneration = 0;
const permissionEpochs = new Map<string, number>();
const accessListeners = new Set<(providerId: string) => void>();
export function onRemoteProviderAccessChanged(listener: (providerId: string) => void): () => void {
  accessListeners.add(listener);
  return () => { accessListeners.delete(listener); };
}
/** Process-local fences: restarting also discards all retained group routing contexts. */
export function remoteProviderAccessEpoch(providerId: string): string {
  return `${permissionGeneration}:${permissionEpochs.get(remoteAccessProviderId(providerId)) ?? 0}`;
}
const log = desktopMakerLogger.child('remote-provider-access-store');

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

function normalize(raw: unknown): RemoteProviderAccessPrefs {
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

function bumpEpoch(providerId: string): void {
  if (!permissionEpochs.has(providerId) && permissionEpochs.size >= MAX_ENTRIES) {
    permissionGeneration++; permissionEpochs.clear();
  }
  permissionEpochs.set(providerId, (permissionEpochs.get(providerId) ?? 0) + 1);
}

const store = createOverrideSettingsFile<RemoteProviderAccessPrefs>({
  filePath: () => ownerScopedUserDataPath('remote-provider-access-prefs.json'),
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'remote-provider-access',
  maxBytes: 256 * 1024,
});

/** 「允许被远程调用」：自己的其他电脑、分享出去的人与供应商组共用这一个开关。 */
export function isRemoteProviderInvocationAllowed(providerId: string): boolean {
  if (!providerId) return false;
  store.invalidateIfChanged();
  return store.read().allowedProviders[remoteAccessProviderId(providerId)] === true;
}

export async function setRemoteProviderInvocationEnabled(providerId: string, enabled: boolean): Promise<void> {
  return withAvailabilityPolicyMutation(providerId, async () => {
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

export const __testing = { normalize };
