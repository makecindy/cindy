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
  /** Failure evidence, not credentials; retained until useful work resumes on that account. */
  recoveries?: SubscriptionAccountRecoveries;
}
export interface SubscriptionAccountRecovery {
  epoch: string;
  failedAt: number;
  until: number;
  periodic: boolean;
}
export type SubscriptionAccountRecoveries = Record<string, Record<string, Record<string, SubscriptionAccountRecovery>>>;

const MEMBER_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,300}$/;
/** 防止损坏文件无限膨胀的存储边界，远高于实际用量。 */
const MAX_PROVIDERS = 1024;
function validRecoveryKey(provider: string, account: string, scope: string): boolean {
  return (provider === 'openai' || provider === 'anthropic') && MEMBER_KEY_PATTERN.test(account)
    && !Object.hasOwn(Object.prototype, account) && account !== 'prototype'
    && /^(claude|model):.{1,512}$/.test(scope);
}

function normalize(raw: unknown): CoolingFile {
  const source = (raw as Partial<CoolingFile> | null)?.cooling;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return { cooling: {} };
  const cooling: ProviderGroupPersistedCooling = {};
  for (const [providerId, members] of Object.entries(source)) {
    if (Object.keys(cooling).length >= MAX_PROVIDERS) break;
    if (!isProviderGroupProviderId(providerId) || !members || typeof members !== 'object' || Array.isArray(members)) continue;
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
  const recoveries: SubscriptionAccountRecoveries = {};
  const rawRecoveries = (raw as CoolingFile)?.recoveries;
  if (rawRecoveries && typeof rawRecoveries === 'object' && !Array.isArray(rawRecoveries)) {
    for (const provider of ['openai', 'anthropic']) {
      const accounts = rawRecoveries[provider];
      if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) continue;
      for (const [account, entries] of Object.entries(accounts).slice(0, PROVIDER_GROUP_STORAGE_MEMBER_CAP)) {
        if (!MEMBER_KEY_PATTERN.test(account) || !entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
        for (const [scope, entry] of Object.entries(entries).slice(0, PROVIDER_GROUP_COOLING_SCOPE_CAP)) {
          if (!validRecoveryKey(provider, account, scope) || !entry || typeof entry !== 'object'
            || typeof entry.epoch !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(entry.epoch)
            || !Number.isFinite(entry.failedAt) || entry.failedAt <= 0
            || !Number.isFinite(entry.until) || entry.until < entry.failedAt || typeof entry.periodic !== 'boolean') continue;
          ((recoveries[provider] ??= {})[account] ??= {})[scope] = {
            epoch: entry.epoch, failedAt: entry.failedAt, until: entry.until, periodic: entry.periodic,
          };
        }
      }
    }
  }
  return { cooling, ...(Object.keys(recoveries).length ? { recoveries } : {}) };
}

const log = desktopMakerLogger.child('provider-group');
function coolingFile(name: string, label: string) {
  return createOverrideSettingsFile<CoolingFile>({
    filePath: () => ownerScopedUserDataPath(name),
    scopeKey: activeOwnerScopeKey,
    defaults: { cooling: {} },
    normalize,
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

export function readProviderGroupCooling(): ProviderGroupPersistedCooling {
  store.invalidateIfChanged();
  return store.read().cooling;
}

export function readSubscriptionAccountCooling(): ProviderGroupPersistedCooling {
  accountStore.invalidateIfChanged();
  return accountStore.read().cooling;
}
export function readSubscriptionAccountRecoveries(): SubscriptionAccountRecoveries {
  accountStore.invalidateIfChanged();
  return accountStore.read().recoveries ?? {};
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
  return updateAccountFile(current => ({ ...current, cooling: edit(current.cooling) }));
}
function updateAccountFile(edit: (current: CoolingFile) => CoolingFile): Promise<void> {
  const owner = activeOwnerScopeKey();
  // Clear must follow all earlier writes, including background failure snapshots.
  accountWrites = accountWrites.then(async () => {
    if (owner !== activeOwnerScopeKey()) return;
    await accountStore.updateAtomic(current => {
      const next = normalize(edit(current.value));
      // updateAtomic merges a partial patch: explicitly clear an absent optional key.
      return { ...next, recoveries: next.recoveries };
    });
  }).catch((error: unknown) => {
    log.warn('subscription accounts: saving cooldowns failed', { error: error instanceof Error ? error.message : String(error) });
  });
  return accountWrites;
}
/** Serialized with cooling writes; an old acceptance cannot consume a newer failure. */
export function writeSubscriptionAccountRecovery(
  provider: string, account: string, scope: string, entry: SubscriptionAccountRecovery,
): Promise<void> {
  if (!validRecoveryKey(provider, account, scope)) return Promise.resolve();
  return updateAccountFile(current => {
    const recoveries = structuredClone(current.recoveries ?? {});
    const previous = recoveries[provider]?.[account]?.[scope];
    const weakerTie = previous?.failedAt === entry.failedAt && (
      (!previous.periodic && entry.periodic)
      || (previous.periodic === entry.periodic && previous.until > entry.until)
    );
    if (previous && (previous.failedAt > entry.failedAt || weakerTie)) return current;
    // A newer periodic error cannot prove an existing billing/auth failure recovered.
    const keepNonperiodic = previous && !previous.periodic && previous.until > Date.now();
    ((recoveries[provider] ??= {})[account] ??= {})[scope] = { ...entry,
      until: Math.max(previous?.until ?? 0, entry.until), periodic: entry.periodic && !keepNonperiodic };
    return { ...current, recoveries };
  });
}
export function consumeSubscriptionAccountRecovery(provider: string, account: string, scope: string, epoch: string): Promise<void> {
  if (!validRecoveryKey(provider, account, scope)) return Promise.resolve();
  return updateAccountFile(current => {
    const recoveries = structuredClone(current.recoveries ?? {});
    if (recoveries[provider]?.[account]?.[scope]?.epoch === epoch) delete recoveries[provider][account][scope];
    return { ...current, recoveries };
  });
}
/** Only fresh periodic recovery may shorten this exact model failure, never an account-wide/billing failure. */
export function clearRecoveredSubscriptionCooling(provider: string, account: string, scope: string, until: number, epoch: string): Promise<void> {
  if (!validRecoveryKey(provider, account, scope)) return Promise.resolve();
  return updateAccountFile(current => {
    const cooling = structuredClone(current.cooling);
    const scopes = cooling[provider]?.[account];
    const recovery = current.recoveries?.[provider]?.[account]?.[scope];
    if (recovery?.epoch === epoch && recovery.periodic && scopes && typeof scopes === 'object'
      && scopes[scope] === until) delete scopes[scope];
    return { ...current, cooling };
  });
}

/** A successful login or removal clears only this account, preserving other cooldowns. */
export function clearSubscriptionAccountCooling(providerId: string, accountId: string): Promise<void> {
  return updateAccountCooling(current => {
    const next = { ...current, [providerId]: { ...current[providerId] } };
    delete next[providerId][accountId];
    return next;
  });
}

export const __testing = { normalize, mergeCooling };
