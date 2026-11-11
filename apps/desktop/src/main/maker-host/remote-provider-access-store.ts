import { withAvailabilityPolicyLock, withAvailabilityPolicyMutation } from '../device-link/providerShareAvailabilityPolicy.js';
/**
 * 远程 Agent 的供应商级授权。
 *
 * 每台电脑、每个 Cindy 账号各自保存一份。默认对自己账号的其他电脑开放（2026-11-10 用户裁决：
 * 「控制本机」开着时其他电脑就能借用本机的模型，用户可以手动关掉）：迁移完成后，没有关闭记录即开放。
 * 迁移前（旧文件）缺席仍表示未开放；迁移时，本机已有分享、却没开放的供应商记为关闭——那是用户
 * 为暂停分享特意关掉的，不能因默认开放而让分享出去的人恢复使用。
 * 这份设置只决定同账号另一台电脑能否使用本机该供应商的登录与额度，
 * 不改变本机选择器里的模型可见性，也不把凭证或路由细节写进 device-link。
 */
import { ownerScopedPath as ownerScopedUserDataPath } from '../ownerContext.js';
import { createOverrideSettingsFile } from './override-settings-file.js';
import { desktopMakerLogger } from './logger-adapter.js';

interface RemoteProviderAccessPrefs {
  allowedProviders: Record<string, true>;
  /** 用户关掉的供应商（默认开放之后才有意义）。 */
  disabledProviders: Record<string, true>;
  /** 已完成默认开放的迁移。 */
  defaultOpen: boolean;
}

const DEFAULTS: RemoteProviderAccessPrefs = { allowedProviders: {}, disabledProviders: {}, defaultOpen: false };
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
  return `${permissionGeneration}:${permissionEpochs.get(providerId) ?? 0}`;
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
    ? raw as { allowedProviders?: unknown; disabledProviders?: unknown; defaultOpen?: unknown }
    : {};
  return {
    allowedProviders: providerSet(value.allowedProviders),
    disabledProviders: providerSet(value.disabledProviders),
    defaultOpen: value.defaultOpen === true,
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

export function isRemoteProviderInvocationAllowed(providerId: string): boolean {
  store.invalidateIfChanged();
  const prefs = store.read();
  if (prefs.allowedProviders[providerId] === true) return true;
  return prefs.defaultOpen && !!providerId && prefs.disabledProviders[providerId] !== true;
}

/**
 * 一次性改为默认开放。`sharedProviderIds` 是本机已有分享的供应商（来自已拉到的、完整的分享快照）：
 * 其中还没开放的记为关闭。重复调用无副作用。
 */
export async function migrateRemoteProviderAccessDefault(sharedProviderIds: ReadonlySet<string>): Promise<void> {
  store.invalidateIfChanged();
  if (store.read().defaultOpen) return;
  // 只开放、不收回任何东西(为暂停分享关掉的仍记为关闭)，不需要先停用分享的待机可用。
  return withAvailabilityPolicyLock(async () => {
    store.invalidateIfChanged();
    const prefs = store.read();
    if (prefs.defaultOpen) return;
    const disabledProviders = { ...prefs.disabledProviders };
    for (const providerId of sharedProviderIds) {
      if (prefs.allowedProviders[providerId] !== true && providerId) disabledProviders[providerId] = true;
    }
    store.writePatch({ disabledProviders, defaultOpen: true });
    permissionGeneration++; permissionEpochs.clear();
    for (const listener of accessListeners) {
      try { listener('*'); } catch { log.warn('remote provider access listener failed'); }
    }
    log.info('remote provider access now open by default', { keptClosed: Object.keys(disabledProviders).length });
  });
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
    // 关闭一律留下记录，才分得清「没设置过」与「关掉了」；默认开放迁移之前关掉的，迁移后也保持关闭。
    if (!(providerId in allowedProviders) && (!prefs.defaultOpen || disabledProviders[providerId] === true)) return;
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
