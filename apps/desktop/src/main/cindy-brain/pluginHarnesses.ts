/**
 * pluginHarnesses — 插件提供的任务执行引擎注册表(Desktop main,docs/plans/acp-plugin-bridge.md)。
 *
 * 只列「已启用 + 整包批准有效 + 清单声明 + receipt `approvedHarnesses` 明确批准 + 协议已支持
 * (`acp`)」的引擎;名称按当前界面语言选好。可用状态只读插件经 `PUT /harnesses` 发布并落盘的
 * 元数据,从不调用插件;从未发布 = `unknown`。
 *
 * 接线(本模块不 import index.ts 与 maker-core,避免循环与反向依赖):
 * - `cindy-brain/index.ts` 的 `registerGhostIpc` 调用 `configurePluginHarnessRegistry(deps)`
 *   注入当前账号可见的已装插件、可用状态读取、界面语言与 broker 的 `spawnHarness`;
 * - 花名册变化(`broadcastGhostsChanged`,与 browserExtensionSlot 同一对账点)、界面语言切换、
 *   `PUT /harnesses` 内容变化后由 index.ts 调用 `reconcilePluginHarnesses()` 重算并通知;
 * - 引擎侧(第 3 步)只用 `getPluginHarnessRegistry()` 的 list / onChange / spawn。配置前
 *   list 为空、spawn 拒绝。
 *
 * `ghostId` 是插件实例键(`installedGhostStoragePart`,旧 root 安装即 manifest id),与 broker、
 * getGhost 同一身份,不会把同名的组织实例与 root 实例混为一谈;实例键不含 `:`,所以
 * `key = ${ghostId}:${harnessId}` 无歧义。
 */
import path from 'node:path';

import {
  GHOST_HARNESS_ACCOUNT_SECRET_MAX,
  ghostHarnessText,
  parseGhostHarnessAccountLoginResult,
  parseGhostHarnessAccountStatus,
  parseGhostHarnessUsage,
  storedGhostHarnessAvailability,
  type GhostHarnessAccountLoginResult,
  type GhostHarnessAccountMethod,
  type GhostHarnessAccountStatus,
  type GhostHarnessMode,
  type GhostHarnessModel,
  type GhostHarnessUsage,
} from '@cindy/plugin-protocol';
import { AgentStartupStoppedError } from '@cindy/maker-core';

import { approvedGhostHarnesses, type InstalledGhost } from '../../shared/ghost.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';
import {
  ADAPTIVE_QUOTA_TIERS,
  MANUAL_QUOTA_REFRESH_COOLDOWN_MS,
  nextExponentialBackoffMs,
  shouldAllowManualQuotaRefresh,
  shouldRefreshAdaptiveQuota,
  type AdaptiveQuotaRefreshTiming,
} from '../usage/adaptiveQuotaRefresh.js';
import type { NodeWorkerProcess } from './nodeRuntimeBroker.js';

/** Worker methods the Host calls for engine accounts (plugin-harnesses.md 引擎账号). */
export type PluginHarnessAccountMethod = 'accountStatus' | 'accountLogin' | 'accountLoginCancel';
/**
 * Browser sign-ins wait for the user: the call stays open while the worker keeps reporting progress
 * (the broker's silence window), at most 11 minutes in all; the plugin itself gives up earlier.
 */
export const PLUGIN_HARNESS_ACCOUNT_LOGIN_TIMING = { timeoutMs: 60_000, maxTotalMs: 11 * 60_000 } as const;
const ACCOUNT_STATUS_TIMING = { timeoutMs: 26_000 } as const;

/** How one engine process is started. */
export interface PluginHarnessSpawnOptions {
  /**
   * Run the agent on one of the accounts Cindy added: the entry gets
   * GHOST_HARNESS_ACCOUNT_DIR_ARG with this directory. Refused unless the plugin published account
   * methods for this engine and the directory is one Cindy created for it.
   */
  accountDir?: string;
  /**
   * The task's files and commands are on another computer: the entry is started with
   * GHOST_HARNESS_REMOTE_WORKSPACE_ARG and must leave file and command work to Cindy's tools.
   * Refused unless the plugin published `remoteWorkspace` for this engine.
   */
  remoteWorkspace?: boolean;
  /**
   * The task belongs to another Cindy account (provider sharing): the entry is started with
   * GHOST_HARNESS_GUEST_WORKSPACE_ARG alongside GHOST_HARNESS_REMOTE_WORKSPACE_ARG. Refused unless
   * the plugin published both `remoteWorkspace` and `guestWorkspace` for this engine.
   */
  guestWorkspace?: boolean;
}

export interface PluginHarness {
  reportsUsage?: true;
  /**
   * The plugin reports this engine's account (`methods: []`) or lets Cindy add accounts (one or more
   * methods). Only with a JSON-RPC main worker, which answers the account calls.
   */
  accounts?: { methods: GhostHarnessAccountMethod[] };
  /** The plugin says this engine can serve a task whose files are on another computer. */
  remoteWorkspace?: true;
  /** The plugin says this engine isolates personal context/tools for shared users. */
  guestWorkspace?: true;
  /** `${ghostId}:${harnessId}`,任务记录里的稳定标识。 */
  key: string;
  ghostId: string;
  harnessId: string;
  /** 已按界面语言选好。 */
  name: string;
  description?: string;
  protocol: 'acp';
  availability: { state: 'available' | 'unavailable' | 'unknown'; reason?: string; message?: string; version?: string };
  /** The providing plugin's own icon (manifest `icon`, host-read data URL); absent = generic engine mark. */
  iconDataUrl?: string;
  /** Models the plugin lists for this engine (`PUT /harnesses`); absent = the plugin lists none. */
  models?: GhostHarnessModel[];
  /** The agent's own working modes the plugin lists (Cindy permission mode ids); absent = none. */
  modes?: GhostHarnessMode[];
  defaultMode?: GhostHarnessMode;
}

export const PLUGIN_USAGE_WORKER_FAILURE = Symbol('plugin usage worker failure');

export interface PluginHarnessRegistry {
  /** 已启用 + 已批准 + 已声明 + 协议已支持。 */
  list(): PluginHarness[];
  /** 列表内容变化时通知(内容不变不通知);返回取消订阅函数。 */
  onChange(listener: (list: PluginHarness[]) => void): () => void;
  /** 原样 stdio 启动引擎入口;不在 list 中或已发布不可用时拒绝。 */
  spawn(key: string, options?: PluginHarnessSpawnOptions): Promise<NodeWorkerProcess>;
}

export interface PluginHarnessRegistryDeps {
  /** 当前账号可见的已装插件(availableGhosts)。 */
  listGhosts(): InstalledGhost[];
  /** 当前会话可用(账号要求、owner 边界);花名册广播传入的全量列表据此过滤。 */
  isAvailable(ghostId: string): boolean;
  /** 读取 `PUT /harnesses` 落盘的原始内容;没有时返回空对象。 */
  readAvailability(ghostId: string): unknown;
  /** 当前界面语言(app-context 的 uiLocale)。 */
  uiLocale(): string;
  /** broker.spawnHarness:fork 前后按安装、批准与 owner 现查守门。 */
  spawn(ghostId: string, harnessId: string, options?: PluginHarnessSpawnOptions): Promise<NodeWorkerProcess>;
  /**
   * 请插件重新发布引擎状态(含模型列表):给插件逻辑页发 `{ type: 'harnesses-refresh-requested' }`。
   * 逻辑页不在线时返回 false。缺省 = 不支持刷新。
   */
  requestRefresh?(ghostId: string): boolean;
  /**
   * Call only the approved plugin's main worker, with a fixed method and harness id. `accountDir` is
   * sent only to engines that publish account methods (an older plugin would answer for its
   * original login instead).
   */
  readUsage?(ghostId: string, harnessId: string, accountDir?: string): Promise<unknown>;
  /** Fixed account methods of the approved plugin's main worker; params are built by the registry. */
  callAccount?(
    ghostId: string,
    method: PluginHarnessAccountMethod,
    params: Record<string, unknown>,
    timing: { timeoutMs: number; maxTotalMs?: number },
  ): Promise<unknown>;
  /**
   * The only directory under which Cindy creates this engine's account directories (owner-scoped).
   * Null while no account scope is active; spawning on an account then fails.
   */
  accountRoot?(ghostId: string, harnessId: string): string | null;
  /** Current owner scope key for isolating host-cached plugin usage across account switches. */
  ownerScopeKey?(): string;
  /** Clock injection (defaults to Date.now). */
  now?(): number;
  /** Override adaptive usage caching/throttling timing (tests). */
  usageTiming?: Partial<AdaptiveQuotaRefreshTiming>;
  log?: { warn(message: string, meta?: Record<string, unknown>): void };
}

export interface PluginHarnessUsageReadOptions {
  reportWorkerFailure?: boolean;
  /** Explicit user-initiated refresh: bypasses adaptive active/idle TTL after a short manual cooldown. */
  force?: boolean;
}

export interface ReconcilablePluginHarnessRegistry extends PluginHarnessRegistry {
  readUsage(key: string, accountDir?: string, options?: PluginHarnessUsageReadOptions): Promise<GhostHarnessUsage | null>;
  /** Records real task/turn activity for a plugin engine (optionally scoped to an account dir). */
  recordActivity(key: string, accountDir?: string): void;
  /** The plugin's view of one account (no `accountDir` = the agent's original login). */
  readAccountStatus(key: string, accountDir?: string): Promise<GhostHarnessAccountStatus | null>;
  /**
   * Runs the plugin's sign-in for an account directory Cindy created (undefined = the agent's
   * original login); resolves when it ends.
   */
  loginAccount(key: string, accountDir: string | undefined, methodId: string, secret?: string): Promise<GhostHarnessAccountLoginResult>;
  cancelAccountLogin(key: string, accountDir: string | undefined): Promise<void>;
  /** 重算列表;内容变化才通知。`ghosts` 缺省时现读 deps.listGhosts()。 */
  reconcile(ghosts?: InstalledGhost[]): void;
  /** 丢弃缓存(不通知);下一次 list 现算。 */
  invalidate(): void;
}

function projectHarnesses(deps: PluginHarnessRegistryDeps, ghosts: InstalledGhost[]): PluginHarness[] {
  const locale = deps.uiLocale();
  const result: PluginHarness[] = [];
  for (const ghost of ghosts) {
    const harnesses = approvedGhostHarnesses(ghost);
    if (harnesses.length === 0) continue;
    const ghostId = installedGhostStoragePart(ghost);
    if (!deps.isAvailable(ghostId)) continue;
    let published: ReturnType<typeof storedGhostHarnessAvailability> = [];
    try {
      published = storedGhostHarnessAvailability(deps.readAvailability(ghostId), harnesses.map((harness) => harness.id));
    } catch (error) {
      // 读不到发布记录只让状态回到 unknown,不让引擎从列表消失。
      deps.log?.warn('plugin harness availability unreadable', {
        ghostId, error: error instanceof Error ? error.message : String(error),
      });
    }
    for (const harness of harnesses) {
      const status = published.find((item) => item.id === harness.id);
      const text = ghostHarnessText(harness, locale);
      result.push({
        key: `${ghostId}:${harness.id}`,
        ghostId,
        harnessId: harness.id,
        name: text.name,
        ...(text.description !== undefined ? { description: text.description } : {}),
        protocol: 'acp',
        availability: status
          ? {
            state: status.available ? 'available' : 'unavailable',
            ...(status.reason !== undefined ? { reason: status.reason } : {}),
            ...(status.message !== undefined ? { message: status.message } : {}),
            ...(status.version !== undefined ? { version: status.version } : {}),
          }
          : { state: 'unknown' },
        ...(ghost.iconDataUrl ? { iconDataUrl: ghost.iconDataUrl } : {}),
        ...(status?.reportsUsage && ghost.manifest.node?.protocol === 'json-rpc-stdio' ? { reportsUsage: true } : {}),
        ...(status?.accounts && ghost.manifest.node?.protocol === 'json-rpc-stdio'
          ? { accounts: { methods: status.accounts.methods.map((method) => ({ ...method })) } }
          : {}),
        ...(status?.remoteWorkspace ? { remoteWorkspace: true } : {}),
        ...(status?.remoteWorkspace && status?.guestWorkspace ? { guestWorkspace: true } : {}),
        ...(status?.models ? { models: status.models.map((model) => ({ ...model, ...(model.efforts ? { efforts: [...model.efforts] } : {}) })) } : {}),
        ...(status?.modes ? { modes: [...status.modes] } : {}),
        ...(status?.defaultMode ? { defaultMode: status.defaultMode } : {}),
      });
    }
  }
  return result;
}

const MAX_USAGE_CACHE_ENTRIES = 128;

interface UsageCacheEntry {
  hasValue: boolean;
  value: GhostHarnessUsage | null;
  lastRefreshAt: number;
  lastAttemptAt: number;
  activitySeq: number;
  refreshedActivitySeq: number;
  backoffMs: number;
  backoffUntil: number;
  workerFailure: boolean;
}

type UsageFlightOutcome =
  | { kind: 'value'; value: GhostHarnessUsage | null }
  | { kind: 'worker-failure'; fallbackValue: GhostHarnessUsage | null };

interface UsageFlightRecord {
  generation: number;
  promise: Promise<UsageFlightOutcome>;
}

function usageCacheKey(key: string, accountDir?: string): string {
  return `${key}\0${accountDir ? path.resolve(accountDir) : ''}`;
}

function harnessUsageResetTimesMs(usage: GhostHarnessUsage | null | undefined): number[] {
  if (!usage?.windows?.length) return [];
  const out: number[] = [];
  for (const window of usage.windows) {
    if (typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt) && window.resetsAt > 0) {
      out.push(window.resetsAt);
    }
  }
  return out;
}

/** 生产与测试共用的注册表实现;生产单例见 getPluginHarnessRegistry。 */
export function createPluginHarnessRegistry(deps: PluginHarnessRegistryDeps): ReconcilablePluginHarnessRegistry {
  const listeners = new Set<(list: PluginHarness[]) => void>();
  let current: PluginHarness[] | null = null;
  // 基线是空列表:首次重算就有引擎时,先订阅的引擎侧也能收到通知。
  let fingerprint = '[]';
  const nowFn = () => (deps.now ? deps.now() : Date.now());
  const timing: AdaptiveQuotaRefreshTiming = {
    ...ADAPTIVE_QUOTA_TIERS.pluginHarness,
    ...deps.usageTiming,
  };
  const manualCooldownMs = Math.min(MANUAL_QUOTA_REFRESH_COOLDOWN_MS, timing.activeThrottleMs);
  const usageCache = new Map<string, UsageCacheEntry>();
  const usageInFlight = new Map<string, UsageFlightRecord>();
  const usageGenerations = new Map<string, number>();
  let usageOwnerScope = deps.ownerScopeKey?.() ?? '';

  const bumpUsageGeneration = (cacheKey: string): void => {
    const next = (usageGenerations.get(cacheKey) ?? 0) + 1;
    usageGenerations.delete(cacheKey);
    usageGenerations.set(cacheKey, next);
    if (usageGenerations.size > MAX_USAGE_CACHE_ENTRIES) {
      const oldest = usageGenerations.keys().next().value;
      if (oldest !== undefined) usageGenerations.delete(oldest);
    }
  };
  const invalidateUsageCacheKey = (cacheKey: string): void => {
    bumpUsageGeneration(cacheKey);
    usageCache.delete(cacheKey);
    usageInFlight.delete(cacheKey);
  };
  const syncUsageOwnerScope = (): string => {
    const scope = deps.ownerScopeKey?.() ?? '';
    if (scope !== usageOwnerScope) {
      usageOwnerScope = scope;
      for (const cacheKey of new Set([...usageCache.keys(), ...usageInFlight.keys()])) {
        bumpUsageGeneration(cacheKey);
      }
      usageCache.clear();
      usageInFlight.clear();
    }
    return scope;
  };
  const getOrCreateUsageEntry = (cacheKey: string): UsageCacheEntry => {
    const existing = usageCache.get(cacheKey);
    if (existing) {
      usageCache.delete(cacheKey);
      usageCache.set(cacheKey, existing);
      return existing;
    }
    const created: UsageCacheEntry = {
      hasValue: false,
      value: null,
      lastRefreshAt: 0,
      lastAttemptAt: 0,
      activitySeq: 0,
      refreshedActivitySeq: 0,
      backoffMs: 0,
      backoffUntil: 0,
      workerFailure: false,
    };
    usageCache.set(cacheKey, created);
    if (usageCache.size > MAX_USAGE_CACHE_ENTRIES) {
      const oldest = usageCache.keys().next().value;
      if (oldest !== undefined) usageCache.delete(oldest);
    }
    return created;
  };
  const evictUsageByEngineKey = (key: string): void => {
    const prefix = `${key}\0`;
    for (const cacheKey of new Set([...usageCache.keys(), ...usageInFlight.keys()])) {
      if (cacheKey.startsWith(prefix)) invalidateUsageCacheKey(cacheKey);
    }
  };
  const compute = (ghosts?: InstalledGhost[]): PluginHarness[] => projectHarnesses(deps, ghosts ?? deps.listGhosts());
  const snapshot = (list: PluginHarness[]) => list.map((item) => ({ ...item, availability: { ...item.availability } }));
  const reconcile = (ghosts?: InstalledGhost[]): PluginHarness[] => {
    const previous = current;
    const next = compute(ghosts);
    if (previous) {
      const nextByKey = new Map(next.map((item) => [item.key, item]));
      for (const prev of previous) {
        const after = nextByKey.get(prev.key);
        if (
          !after
          || after.reportsUsage !== prev.reportsUsage
          || after.availability.state !== prev.availability.state
          || after.availability.version !== prev.availability.version
        ) {
          evictUsageByEngineKey(prev.key);
        }
      }
    }
    const nextFingerprint = JSON.stringify(next);
    const changed = nextFingerprint !== fingerprint;
    current = next;
    fingerprint = nextFingerprint;
    if (!changed) return next;
    for (const listener of [...listeners]) {
      try {
        listener(snapshot(next));
      } catch (error) {
        deps.log?.warn('plugin harness listener failed', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    return next;
  };
  /** Re-projects one plugin now: revocation and newly published state count at every call. */
  const findLive = (key: string, accept: (harness: PluginHarness) => boolean): PluginHarness | undefined => {
    const separator = key.lastIndexOf(':');
    if (separator < 1 || key.length > 256) return undefined;
    const ghostId = key.slice(0, separator);
    const ghost = deps.listGhosts().find((item) => installedGhostStoragePart(item) === ghostId);
    const harness = ghost && projectHarnesses(deps, [ghost]).find((item) => item.key === key);
    return harness && accept(harness) ? harness : undefined;
  };
  /** A direct child of the engine's own account root, for an engine that keeps accounts apart. */
  const isAccountDir = (harness: PluginHarness, dir: string): boolean => {
    if (!harness.accounts?.methods.length || !path.isAbsolute(dir)) return false;
    const root = deps.accountRoot?.(harness.ghostId, harness.harnessId);
    if (!root) return false;
    const relative = path.relative(path.resolve(root), path.resolve(dir));
    return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative) && !relative.includes(path.sep)
      && /^[A-Za-z0-9_-]{1,80}$/.test(relative);
  };
  return {
    list() {
      return snapshot(current ?? reconcile());
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    recordActivity(key, accountDir) {
      if (!key) return;
      syncUsageOwnerScope();
      const entry = getOrCreateUsageEntry(usageCacheKey(key, accountDir));
      entry.activitySeq += 1;
    },
    async readUsage(key, accountDir, options) {
      const read = deps.readUsage;
      if (!read) return null;
      const scope = syncUsageOwnerScope();
      const find = () => findLive(key, (item) => !!item.reportsUsage
        && (accountDir === undefined || (!!item.accounts?.methods.length && isAccountDir(item, accountDir))));
      const harness = find();
      const cacheKey = usageCacheKey(key, accountDir);
      if (!harness) {
        invalidateUsageCacheKey(cacheKey);
        return null;
      }

      const currentGen = usageGenerations.get(cacheKey) ?? 0;
      const existingFlight = usageInFlight.get(cacheKey);
      if (existingFlight && existingFlight.generation === currentGen) {
        const outcome = await existingFlight.promise;
        if ((deps.ownerScopeKey?.() ?? '') !== scope || (usageGenerations.get(cacheKey) ?? 0) !== existingFlight.generation || !find()) {
          return null;
        }
        if (outcome.kind === 'worker-failure') {
          if (options?.reportWorkerFailure) throw new Error('Plugin usage worker unavailable');
          return outcome.fallbackValue;
        }
        return outcome.value;
      }

      const entry = usageCache.get(cacheKey);
      const now = nowFn();
      const shouldRefresh = options?.force === true
        ? shouldAllowManualQuotaRefresh({ now, lastAttemptAt: entry?.lastAttemptAt ?? 0, cooldownMs: manualCooldownMs })
        : shouldRefreshAdaptiveQuota({
            now,
            lastRefreshAt: entry?.lastRefreshAt ?? 0,
            hasActivitySinceRefresh: (entry?.activitySeq ?? 0) > (entry?.refreshedActivitySeq ?? 0),
            resetsAtMs: harnessUsageResetTimesMs(entry?.value),
            backoffUntil: entry?.backoffUntil,
            timing,
          });
      if (!shouldRefresh && entry) {
        if (entry.workerFailure && options?.reportWorkerFailure) {
          throw new Error('Plugin usage worker unavailable');
        }
        return entry.value;
      }

      const target = getOrCreateUsageEntry(cacheKey);
      const attemptSeq = target.activitySeq;
      const startGen = usageGenerations.get(cacheKey) ?? 0;
      const flight: Promise<UsageFlightOutcome> = (async () => {
        const raw = await (accountDir === undefined
          ? read(harness.ghostId, harness.harnessId)
          : read(harness.ghostId, harness.harnessId, accountDir));
        const settledAt = nowFn();
        if ((deps.ownerScopeKey?.() ?? '') !== scope || (usageGenerations.get(cacheKey) ?? 0) !== startGen || !find()) {
          if ((usageGenerations.get(cacheKey) ?? 0) === startGen) usageCache.delete(cacheKey);
          return { kind: 'value', value: null };
        }
        if (raw === PLUGIN_USAGE_WORKER_FAILURE) {
          target.lastAttemptAt = settledAt;
          target.workerFailure = true;
          target.backoffMs = nextExponentialBackoffMs(target.backoffMs, timing);
          target.backoffUntil = settledAt + target.backoffMs;
          if (target.backoffMs === 0) target.lastRefreshAt = settledAt;
          return { kind: 'worker-failure', fallbackValue: target.value };
        }
        const parsed = parseGhostHarnessUsage(raw) ?? null;
        target.hasValue = true;
        target.value = parsed;
        target.workerFailure = false;
        target.lastRefreshAt = settledAt;
        target.lastAttemptAt = settledAt;
        target.refreshedActivitySeq = Math.max(target.refreshedActivitySeq, attemptSeq);
        target.backoffMs = 0;
        target.backoffUntil = 0;
        return { kind: 'value', value: parsed };
      })();
      const flightRecord: UsageFlightRecord = { generation: startGen, promise: flight };
      usageInFlight.set(cacheKey, flightRecord);
      try {
        const outcome = await flight;
        if ((deps.ownerScopeKey?.() ?? '') !== scope || (usageGenerations.get(cacheKey) ?? 0) !== startGen || !find()) {
          return null;
        }
        if (outcome.kind === 'worker-failure') {
          if (options?.reportWorkerFailure) throw new Error('Plugin usage worker unavailable');
          return outcome.fallbackValue;
        }
        return outcome.value;
      } catch (err) {
        if (err instanceof Error && err.message === 'Plugin usage worker unavailable') throw err;
        const failedAt = nowFn();
        if ((deps.ownerScopeKey?.() ?? '') === scope && (usageGenerations.get(cacheKey) ?? 0) === startGen) {
          target.lastAttemptAt = failedAt;
          target.workerFailure = true;
          target.backoffMs = nextExponentialBackoffMs(target.backoffMs, timing);
          target.backoffUntil = failedAt + target.backoffMs;
          if (target.backoffMs === 0) target.lastRefreshAt = failedAt;
        }
        throw err;
      } finally {
        if (usageInFlight.get(cacheKey) === flightRecord) usageInFlight.delete(cacheKey);
      }
    },
    async readAccountStatus(key, accountDir) {
      const call = deps.callAccount;
      if (!call) return null;
      const find = () => findLive(key, (item) => !!item.accounts
        && (accountDir === undefined || (!!item.accounts.methods.length && isAccountDir(item, accountDir))));
      const harness = find();
      if (!harness) return null;
      const raw = await call(harness.ghostId, 'accountStatus', {
        harnessId: harness.harnessId, ...(accountDir !== undefined ? { accountDir } : {}),
      }, ACCOUNT_STATUS_TIMING);
      return find() ? parseGhostHarnessAccountStatus(raw) : null;
    },
    async loginAccount(key, accountDir, methodId, secret) {
      const call = deps.callAccount;
      const harness = call && findLive(key, (item) => !!item.accounts?.methods.length
        && (accountDir === undefined || isAccountDir(item, accountDir)));
      const method = harness?.accounts?.methods.find((item) => item.id === methodId);
      if (!call || !harness || !method) return { ok: false, error: 'unsupported' };
      // A secret goes only to a method that asks for one, and only as typed (never stored or logged).
      if ((method.kind === 'secret') !== (typeof secret === 'string')
        || (secret !== undefined && (!secret.trim() || secret.length > GHOST_HARNESS_ACCOUNT_SECRET_MAX))) {
        return { ok: false, error: 'invalid-secret' };
      }
      const cacheKey = usageCacheKey(key, accountDir);
      invalidateUsageCacheKey(cacheKey);
      const raw = await call(harness.ghostId, 'accountLogin', {
        harnessId: harness.harnessId, ...(accountDir !== undefined ? { accountDir } : {}), methodId,
        ...(secret !== undefined ? { secret } : {}),
      }, PLUGIN_HARNESS_ACCOUNT_LOGIN_TIMING);
      invalidateUsageCacheKey(cacheKey);
      return parseGhostHarnessAccountLoginResult(raw);
    },
    async cancelAccountLogin(key, accountDir) {
      const call = deps.callAccount;
      const harness = call && findLive(key, (item) => !!item.accounts?.methods.length
        && (accountDir === undefined || isAccountDir(item, accountDir)));
      if (!call || !harness) return;
      await call(harness.ghostId, 'accountLoginCancel', {
        harnessId: harness.harnessId, ...(accountDir !== undefined ? { accountDir } : {}),
      }, ACCOUNT_STATUS_TIMING);
    },
    async spawn(key, options) {
      // 现算而不是读缓存:停用、撤权或刚发布的不可用状态都必须在启动这一刻生效。
      let harness: PluginHarness;
      try {
        const current = compute().find((item) => item.key === key);
        if (!current) throw new Error(`Task engine ${key} is not available: the plugin is not enabled, approved or declaring it`);
        if (current.availability.state === 'unavailable') {
          throw new Error(`Task engine ${current.name} is unavailable${current.availability.message ? `: ${current.availability.message}` : ''}`);
        }
        // An account directory is only for engines whose plugin keeps each account apart. Starting
        // one that does not would silently run the task on the original login instead.
        if (options?.accountDir !== undefined && !isAccountDir(current, options.accountDir)) {
          throw new Error(`Task engine ${current.name} cannot run on this account`);
        }
        // 插件没有声明能把文件与命令交给 Cindy 时,它的工具只会作用在本机:项目不在这里,不能启动。
        if ((options?.remoteWorkspace || options?.guestWorkspace) && !current.remoteWorkspace) {
          throw new Error(`Task engine ${current.name} cannot run a task whose files are on another computer`);
        }
        if (options?.guestWorkspace && !current.guestWorkspace) {
          throw new Error(`Task engine ${current.name} cannot be shared with other accounts`);
        }
        harness = current;
      } catch (error) {
        throw new AgentStartupStoppedError(error);
      }
      const spawnOptions: PluginHarnessSpawnOptions = {
        ...(options?.remoteWorkspace || options?.guestWorkspace ? { remoteWorkspace: true } : {}),
        ...(options?.guestWorkspace ? { guestWorkspace: true } : {}),
        ...(options?.accountDir !== undefined ? { accountDir: options.accountDir } : {}),
      };
      return Object.keys(spawnOptions).length
        ? deps.spawn(harness.ghostId, harness.harnessId, spawnOptions)
        : deps.spawn(harness.ghostId, harness.harnessId);
    },
    reconcile(ghosts) {
      reconcile(ghosts);
    },
    invalidate() {
      current = null;
      for (const cacheKey of new Set([...usageCache.keys(), ...usageInFlight.keys()])) {
        bumpUsageGeneration(cacheKey);
      }
      usageCache.clear();
      usageInFlight.clear();
    },
  };
}

const UNCONFIGURED: PluginHarnessRegistryDeps = {
  listGhosts: () => [],
  isAvailable: () => false,
  readAvailability: () => ({}),
  uiLocale: () => 'en',
  spawn: async () => { throw new Error('Plugin task engines are not ready'); },
};

let registryDeps: PluginHarnessRegistryDeps = UNCONFIGURED;
const registry = createPluginHarnessRegistry({
  listGhosts: () => registryDeps.listGhosts(),
  isAvailable: (ghostId) => registryDeps.isAvailable(ghostId),
  readAvailability: (ghostId) => registryDeps.readAvailability(ghostId),
  uiLocale: () => registryDeps.uiLocale(),
  spawn: (ghostId, harnessId, options) => (options ? registryDeps.spawn(ghostId, harnessId, options) : registryDeps.spawn(ghostId, harnessId)),
  readUsage: async (ghostId, harnessId, accountDir) => (accountDir === undefined
    ? registryDeps.readUsage?.(ghostId, harnessId)
    : registryDeps.readUsage?.(ghostId, harnessId, accountDir)),
  callAccount: async (ghostId, method, params, timing) => registryDeps.callAccount?.(ghostId, method, params, timing),
  accountRoot: (ghostId, harnessId) => registryDeps.accountRoot?.(ghostId, harnessId) ?? null,
  ownerScopeKey: () => registryDeps.ownerScopeKey?.() ?? '',
  now: () => (registryDeps.now ? registryDeps.now() : Date.now()),
  log: { warn: (message, meta) => registryDeps.log?.warn(message, meta) },
});

/**
 * index.ts 在 registerGhostIpc 中注入一次;之后由 reconcilePluginHarnesses 驱动重算。
 * 注入时不立即读花名册(插件管理器可能尚未就绪),下一次 list 或花名册广播再算。
 */
export function configurePluginHarnessRegistry(deps: PluginHarnessRegistryDeps): void {
  registryDeps = deps;
  registry.invalidate();
}

/** 花名册广播、语言切换与可用状态发布后调用;内容不变时不通知。 */
export function reconcilePluginHarnesses(ghosts?: InstalledGhost[]): void {
  registry.reconcile(ghosts);
}

export function readPluginHarnessUsage(
  key: string,
  accountDir?: string,
  options?: PluginHarnessUsageReadOptions,
): Promise<GhostHarnessUsage | null> {
  return registry.readUsage(key, accountDir, options);
}

export function recordPluginHarnessActivity(key: string, accountDir?: string): void {
  registry.recordActivity(key, accountDir);
}

/** 引擎任务会话中判断「回合是否在跑」所需的最小面(ACP 会话的 `isTurnRunning`)。 */
export interface PluginEngineTurnProbe {
  isTurnRunning?(): boolean;
}

/** 每个插件实例(`ghostId`)名下尚未关闭的引擎任务会话,仅存于宿主内存。 */
const liveEngineSessions = new Map<string, Set<PluginEngineTurnProbe>>();

/**
 * 登记一个引擎任务会话,返回幂等的注销函数(会话 close 时调用)。后台自动更新据此判断
 * 插件引擎上是否有回合正在运行,避免更新时停掉插件进程打断这些任务。
 */
export function trackPluginEngineSession(ghostId: string, session: PluginEngineTurnProbe): () => void {
  const sessions = liveEngineSessions.get(ghostId) ?? new Set<PluginEngineTurnProbe>();
  sessions.add(session);
  liveEngineSessions.set(ghostId, sessions);
  return () => {
    const current = liveEngineSessions.get(ghostId);
    if (!current) return;
    current.delete(session);
    if (current.size === 0) liveEngineSessions.delete(ghostId);
  };
}

/**
 * 该插件实例的引擎上是否有任务回合正在运行。只看回合:任务空闲时引擎进程会保留一段时间,
 * 停掉它不丢工作(下一条消息会重新接上),不能因此无限期推迟插件更新。
 */
export function hasRunningPluginEngineTurn(ghostId: string): boolean {
  for (const session of liveEngineSessions.get(ghostId) ?? []) {
    try {
      if (session.isTurnRunning?.() === true) return true;
    } catch {
      // 已失效的会话不算在跑。
    }
  }
  return false;
}

export function resetPluginEngineSessionsForTests(): void {
  liveEngineSessions.clear();
}

export function readPluginHarnessAccountStatus(key: string, accountDir?: string): Promise<GhostHarnessAccountStatus | null> {
  return registry.readAccountStatus(key, accountDir);
}

export function loginPluginHarnessAccount(
  key: string, accountDir: string | undefined, methodId: string, secret?: string,
): Promise<GhostHarnessAccountLoginResult> {
  return registry.loginAccount(key, accountDir, methodId, secret);
}

export function cancelPluginHarnessAccountLogin(key: string, accountDir: string | undefined): Promise<void> {
  return registry.cancelAccountLogin(key, accountDir);
}

export function getPluginHarnessRegistry(): PluginHarnessRegistry {
  return registry;
}

/** 与普通供应商模型自动刷新同一节奏：同一个插件 10 分钟内只请求一次。 */
export const PLUGIN_HARNESS_REFRESH_COOLDOWN_MS = 10 * 60 * 1000;
const lastRefreshRequestAt = new Map<string, number>();

/**
 * 打开模型选择器时调用(普通供应商在同一时机自动刷新模型列表)：请每个提供引擎的插件重新发布
 * 引擎状态与模型列表。插件怎么取模型由插件自己决定；结果经 `PUT /harnesses` 回来，照常对账。
 * 只发给当前列出引擎的插件；冷却内与逻辑页不在线时不发(不在线的下次再试)。
 */
export function requestPluginHarnessRefresh(now = Date.now(), targetGhostId?: string): void {
  const send = registryDeps.requestRefresh;
  if (!send) return;
  const harnesses = registry.list();
  const ghostIds = new Set(
    (targetGhostId ? harnesses.filter((harness) => harness.ghostId === targetGhostId) : harnesses)
      .map((harness) => harness.ghostId),
  );
  for (const ghostId of ghostIds) {
    const last = lastRefreshRequestAt.get(ghostId);
    if (last !== undefined && now - last < PLUGIN_HARNESS_REFRESH_COOLDOWN_MS) continue;
    if (send(ghostId)) lastRefreshRequestAt.set(ghostId, now);
  }
}

/** Test seam: forget refresh cooldowns. */
export function resetPluginHarnessRefreshForTests(): void {
  lastRefreshRequestAt.clear();
}
