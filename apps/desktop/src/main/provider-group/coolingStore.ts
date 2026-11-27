/**
 * 组内电脑撞到用量上限后的冷却(docs/product-rules/provider-groups.md §5)：按账号存在本机
 * (`provider-group-cooling.json`)，重启后照样避开，不会一启动又先去试撞了上限的那台。
 * 只存还没到期的；其余失败(连不上、起不来等)只在本次运行内记。
 */
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { isProviderGroupProviderId, PROVIDER_GROUP_STORAGE_MEMBER_CAP } from '../../shared/providerGroup.js';
import { currentCooling, PROVIDER_GROUP_COOLING_SCOPE_CAP, type ProviderGroupCooling, type ProviderGroupPersistedCooling } from './cooling.js';

interface CoolingFile {
  cooling: ProviderGroupPersistedCooling;
}

const MEMBER_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,300}$/;
/** 防止损坏文件无限膨胀的存储边界，远高于实际用量。 */
const MAX_PROVIDERS = 1024;

function normalize(raw: unknown, validProvider: (providerId: string) => boolean = isProviderGroupProviderId): CoolingFile {
  const source = (raw as Partial<CoolingFile> | null)?.cooling;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return { cooling: {} };
  const cooling: ProviderGroupPersistedCooling = {};
  for (const [providerId, members] of Object.entries(source)) {
    if (Object.keys(cooling).length >= MAX_PROVIDERS) break;
    if (!validProvider(providerId) || !members || typeof members !== 'object' || Array.isArray(members)) continue;
    const entries: Record<string, ProviderGroupCooling> = {};
    for (const [memberKey, until] of Object.entries(members as Record<string, unknown>)) {
      if (Object.keys(entries).length >= PROVIDER_GROUP_STORAGE_MEMBER_CAP) break;
      if (!MEMBER_KEY_PATTERN.test(memberKey)) continue;
      if (typeof until === 'number' && Number.isFinite(until) && until > 0) {
        entries[memberKey] = until;
      } else if (until && typeof until === 'object' && !Array.isArray(until)) {
        const scopes = Object.fromEntries(Object.entries(until).filter(([scope, end]) =>
          (scope === '' || /^(claude|model):.{1,512}$/.test(scope))
          && typeof end === 'number' && Number.isFinite(end) && end > 0,
        ).sort(([a], [b]) => Number(b === '') - Number(a === '')).slice(0, PROVIDER_GROUP_COOLING_SCOPE_CAP));
        if (Object.keys(scopes).length) entries[memberKey] = scopes;
      }
    }
    if (Object.keys(entries).length > 0) cooling[providerId] = entries;
  }
  return { cooling };
}

const log = desktopMakerLogger.child('provider-group');
function coolingFile(name: string, label: string, validProvider?: (providerId: string) => boolean) {
  return createOverrideSettingsFile<CoolingFile>({
    filePath: () => ownerScopedUserDataPath(name),
    scopeKey: activeOwnerScopeKey,
    defaults: { cooling: {} },
    normalize: (raw) => normalize(raw, validProvider),
    log,
    label,
    // 每个成员由单条冷却扩展到多个模型范围，读写预算同比扩展；仍保留整文件上限。
    maxBytes: 1024 * 1024 * PROVIDER_GROUP_COOLING_SCOPE_CAP,
  });
}
const store = coolingFile('provider-group-cooling.json', 'provider-group-cooling');
/**
 * 供应商内订阅账号的冷却(subscription-account-pools.md)：与组内电脑同一格式与合并规则，
 * 按 provider → 账号 id 存在本机，重启后照样避开刚撞上限、登录失效或过载的账号。
 */
const accountStore = coolingFile('subscription-account-cooling.json', 'subscription-account-cooling');
/**
 * 插件引擎账号的冷却(subscription-account-pools.md 插件引擎的账号)：同一格式与合并规则，按引擎键
 * (`<插件实例>:<引擎 id>`)→ 账号 id 另存一份。旧版客户端写内置账号冷却时会丢掉它不认识的键，所以不混存。
 */
const PLUGIN_ENGINE_KEY = /^[A-Za-z0-9._-]{1,200}:[a-z][a-z0-9-]{0,31}$/;
const pluginEngineAccountStore = coolingFile(
  'plugin-engine-account-cooling.json', 'plugin-engine-account-cooling', (key) => PLUGIN_ENGINE_KEY.test(key));

export function readProviderGroupCooling(): ProviderGroupPersistedCooling {
  store.invalidateIfChanged();
  return store.read().cooling;
}

export function readSubscriptionAccountCooling(): ProviderGroupPersistedCooling {
  accountStore.invalidateIfChanged();
  return accountStore.read().cooling;
}

/**
 * 在锁内和所在文件当前内容合并(按 provider + 成员取较晚的结束时间)，不直接用调用方
 * 快照覆盖：连续冷却两台电脑时，早开始、后步拿到文件锁的写入不应该把已落地的那一台挤丢
 * (greptile-apps P1, PR #5792 review)。合并时移除到期记录，避免旧成员永久占满存储边界。
 */
function mergeCooling(
  current: ProviderGroupPersistedCooling,
  next: ProviderGroupPersistedCooling,
  now = Date.now(),
): ProviderGroupPersistedCooling {
  const merged: ProviderGroupPersistedCooling = {};
  for (const providerId of new Set([...Object.keys(current), ...Object.keys(next)])) {
    const a = current[providerId] ?? {};
    const b = next[providerId] ?? {};
    const entries: Record<string, ProviderGroupCooling> = {};
    for (const memberKey of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const incoming = b[memberKey];
      // 加载时已截短的旧记录优先，不能因排队拿锁而用 now 再截短一次并延长。
      const migrated = typeof a[memberKey] === 'number' && typeof incoming === 'object' && incoming[''] !== undefined;
      const scopes = migrated ? {} : currentCooling(a[memberKey], now);
      for (const [scope, until] of Object.entries(currentCooling(b[memberKey], now))) {
        scopes[scope] = Math.max(scopes[scope] ?? 0, until);
      }
      if (Object.keys(scopes).length) entries[memberKey] = scopes;
    }
    if (Object.keys(entries).length > 0) merged[providerId] = entries;
  }
  return merged;
}

/** 合并写入；返回实际落盘完成信号，后台调用仍可忽略，失败只记日志。 */
export function writeProviderGroupCooling(cooling: ProviderGroupPersistedCooling): Promise<void> {
  return store.updateAtomic((current) => normalize({ cooling: mergeCooling(current.value.cooling, cooling) })).then(() => undefined).catch((error: unknown) => {
    log.warn('provider group: saving cooldowns failed', { error: error instanceof Error ? error.message : String(error) });
  });
}

/** 账号冷却的合并写入；失败只记日志，内存里的冷却照常生效。 */
export function writeSubscriptionAccountCooling(cooling: ProviderGroupPersistedCooling): Promise<void> {
  return updateAccountCooling(current => mergeCooling(current, cooling));
}

let accountWrites: Promise<void> = Promise.resolve();
function updateAccountCooling(edit: (current: ProviderGroupPersistedCooling) => ProviderGroupPersistedCooling): Promise<void> {
  const owner = activeOwnerScopeKey();
  // Clear must follow all earlier writes, including background failure snapshots.
  accountWrites = accountWrites.then(async () => {
    if (owner !== activeOwnerScopeKey()) return;
    await accountStore.updateAtomic(current => normalize({ cooling: edit(current.value.cooling) }));
  }).catch((error: unknown) => {
    log.warn('subscription accounts: saving cooldowns failed', { error: error instanceof Error ? error.message : String(error) });
  });
  return accountWrites;
}

/** A successful login or removal clears only this account, preserving other cooldowns. */
export function clearSubscriptionAccountCooling(providerId: string, accountId: string): Promise<void> {
  return updateAccountCooling(current => {
    const next = { ...current, [providerId]: { ...current[providerId] } };
    delete next[providerId][accountId];
    return next;
  });
}

export function readPluginEngineAccountCooling(): ProviderGroupPersistedCooling {
  pluginEngineAccountStore.invalidateIfChanged();
  return pluginEngineAccountStore.read().cooling;
}

let pluginEngineWrites: Promise<void> = Promise.resolve();
function updatePluginEngineCooling(edit: (current: ProviderGroupPersistedCooling) => ProviderGroupPersistedCooling): Promise<void> {
  const owner = activeOwnerScopeKey();
  pluginEngineWrites = pluginEngineWrites.then(async () => {
    if (owner !== activeOwnerScopeKey()) return;
    await pluginEngineAccountStore.updateAtomic(current =>
      normalize({ cooling: edit(current.value.cooling) }, (key) => PLUGIN_ENGINE_KEY.test(key)));
  }).catch((error: unknown) => {
    log.warn('plugin engine accounts: saving cooldowns failed', { error: error instanceof Error ? error.message : String(error) });
  });
  return pluginEngineWrites;
}

/** 插件引擎账号冷却的合并写入；失败只记日志，内存里的冷却照常生效。 */
export function writePluginEngineAccountCooling(cooling: ProviderGroupPersistedCooling): Promise<void> {
  return updatePluginEngineCooling(current => mergeCooling(current, cooling));
}

/** 重新登录成功或移除账号时只清这个账号。 */
export function clearPluginEngineAccountCooling(engineKey: string, accountId: string): Promise<void> {
  return updatePluginEngineCooling(current => {
    const next = { ...current, [engineKey]: { ...current[engineKey] } };
    delete next[engineKey][accountId];
    return next;
  });
}

export const __testing = { normalize, mergeCooling };
