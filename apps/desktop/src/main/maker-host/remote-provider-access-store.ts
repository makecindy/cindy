import { withAvailabilityPolicyLock, withAvailabilityPolicyMutation } from '../device-link/providerShareAvailabilityPolicy.js';
/**
 * 远程 Agent 的供应商级授权。每台电脑、每个 Cindy 账号各自保存一份。
 *
 * - 「允许被远程调用」(allowedProviders)：逐个供应商、默认关闭，用户在模型供应商页打开。打开的供应商，
 *   自己的其他电脑和分享出去的人都能用(11-10 之前的行为，原样保留)。
 * - 「让我的其他电脑用本机模型」(ownComputerModelUse)：「远程连接」里的开关，默认关闭、只由用户打开。
 *   打开后自己的其他电脑能用本机全部供应商；不影响分享出去的人。
 *
 * 2026-11-10 的版本曾把所有供应商默认对自己的电脑开放(defaultOpen / disabledProviders)。用户确认那是
 * 开了不该开的(2026-11-12)：这里不再读 defaultOpen，只因它而开放的供应商回到关闭；11-10 之前和之后用户
 * 自己打开的都在 allowedProviders 里，照旧。唯一的例外是 11-10 期间用户在默认开放的供应商上建了分享：
 * 那是用户自己要分享，拿到分享快照后补记为打开(keepSharedProvidersOpen)。两个旧字段原样保留在文件里、
 * 继续记录关闭，退回 11-10 的版本时也不会重新打开用户关掉的供应商。
 */
import { ownerScopedPath as ownerScopedUserDataPath } from '../ownerContext.js';
import { createOverrideSettingsFile } from './override-settings-file.js';
import { desktopMakerLogger } from './logger-adapter.js';

interface RemoteProviderAccessPrefs {
  allowedProviders: Record<string, true>;
  /** 11-10 版本留下的关闭记录；本版本只为兼容继续写，不再读。 */
  disabledProviders: Record<string, true>;
  /** 11-10 版本的「默认开放」迁移标记；本版本不再读。 */
  defaultOpen: boolean;
  /** 「远程连接」里的「让我的其他电脑用本机模型」，默认关闭。 */
  ownComputerModelUse: boolean;
  /** 已按分享快照处理过 11-10 默认开放期间建的分享。 */
  defaultOpenReverted: boolean;
}

const DEFAULTS: RemoteProviderAccessPrefs = {
  allowedProviders: {}, disabledProviders: {}, defaultOpen: false, ownComputerModelUse: false, defaultOpenReverted: false,
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
    ? raw as { allowedProviders?: unknown; disabledProviders?: unknown; defaultOpen?: unknown; ownComputerModelUse?: unknown; defaultOpenReverted?: unknown }
    : {};
  return {
    allowedProviders: providerSet(value.allowedProviders),
    disabledProviders: providerSet(value.disabledProviders),
    defaultOpen: value.defaultOpen === true,
    ownComputerModelUse: value.ownComputerModelUse === true,
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

/** 「允许被远程调用」：分享出去的人、供应商组，以及自己的其他电脑(逐个供应商打开的那部分)。 */
export function isRemoteProviderInvocationAllowed(providerId: string): boolean {
  store.invalidateIfChanged();
  return !!providerId && store.read().allowedProviders[providerId] === true;
}

/** 「远程连接」里的「让我的其他电脑用本机模型」。 */
export function isOwnComputerModelUseEnabled(): boolean {
  store.invalidateIfChanged();
  return store.read().ownComputerModelUse;
}

/** 自己的其他电脑能否用这个供应商：逐个打开过的，或「让我的其他电脑用本机模型」开着。 */
export function isRemoteProviderOpenToOwnComputers(providerId: string): boolean {
  return isRemoteProviderInvocationAllowed(providerId) || (!!providerId && isOwnComputerModelUseEnabled());
}

function notifyAll(): void {
  permissionGeneration++; permissionEpochs.clear();
  for (const listener of accessListeners) {
    try { listener('*'); } catch { log.warn('remote provider access listener failed'); }
  }
}

/**
 * 撤回 11-10 默认开放时的唯一补记：那段时间里，用户在「默认开放、没单独关过」的供应商上建了分享，
 * 说明用户要让分享出去的人用，补记为打开。`sharedProviderIds` 来自已拉到的完整分享快照。
 * 只对跑过 11-10 迁移的文件做一次；其余供应商一律不动。
 */
/**
 * 撤回 11-10 默认开放时要补记的供应商：分享了的供应商，加上分享出去的 OpenAI 账号池里从旧 Codex 连接
 * 导入的账号——受邀者用这个池时会逐个核对这些旧连接的「允许被远程调用」，只补 openai 本身会让分享失效。
 */
export function sharedProviderIdsForRevert(
  shares: readonly { providerId: string }[],
  /** 账号池读不了时返回 null：这时不能确定要补哪些旧连接，整次补记推迟到下次。 */
  readOpenAiLegacyAccounts: () => Readonly<Record<string, string>> | null,
): Set<string> | null {
  const ids = new Set(shares.map((share) => share.providerId));
  if (!ids.has('openai')) return ids;
  const legacy = readOpenAiLegacyAccounts();
  if (!legacy) return null;
  for (const legacyId of Object.keys(legacy)) ids.add(legacyId);
  return ids;
}

export async function keepSharedProvidersOpen(sharedProviderIds: ReadonlySet<string>): Promise<void> {
  store.invalidateIfChanged();
  const before = store.read();
  if (!before.defaultOpen || before.defaultOpenReverted) return;
  return withAvailabilityPolicyLock(async () => {
    store.invalidateIfChanged();
    const prefs = store.read();
    if (!prefs.defaultOpen || prefs.defaultOpenReverted) return;
    const allowedProviders = { ...prefs.allowedProviders };
    let kept = 0;
    for (const providerId of sharedProviderIds) {
      if (!providerId || allowedProviders[providerId] === true || prefs.disabledProviders[providerId] === true) continue;
      if (Object.keys(allowedProviders).length >= MAX_ENTRIES) break;
      allowedProviders[providerId] = true;
      kept++;
    }
    store.writePatch({ allowedProviders, defaultOpenReverted: true });
    if (kept > 0) notifyAll();
    log.info('default-open access reverted', { keptForShares: kept });
  });
}

export async function setOwnComputerModelUse(enabled: boolean): Promise<void> {
  return withAvailabilityPolicyLock(async () => {
    store.invalidateIfChanged();
    if (store.read().ownComputerModelUse === enabled) return;
    store.writePatch({ ownComputerModelUse: enabled });
    notifyAll();
    log.info('own computer model use updated', { enabled });
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
