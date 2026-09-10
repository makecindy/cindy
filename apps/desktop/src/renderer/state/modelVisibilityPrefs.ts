/**
 * modelVisibilityPrefs —— 按「(agent, 来源/provider, model) → 是否在模型选择器显示」的
 * **用户本地 override**,按 dataOwnerId 隔离后写入 localStorage,跨会话 / 跨重启在本机生效。
 *
 * 背景:
 *   每个来源(provider)在某个 agent 下可能提供很多模型(XD 网关 Claude Code 有 20 个),
 *   用户本地全列出来会很长。设置 → 模型供应商 展开来源后,用户可逐个开关哪些模型显示。
 *   显式开关与目录 defaultEnabled 分开：没拨过的跟当前下发默认，拨过的升级也不清。
 *   目录新增的默认开模型会显示出来；客户端不得把「没开关记录」做成全关。
 *
 * 为什么 key 必须带 agent:
 *   同一来源可同时服务多个 agent(XD = claude-code + codex),且两个 agent 下模型集不同、
 *   同名模型元数据也不同(gpt-5.5 cc=1M / codex=272k)。开关必须 per-agent 独立,否则
 *   在 Claude Code 下关掉 gpt-5.5 会连带影响 Codex。key = `${agent}:${providerId}:${modelId}`。
 *
 * 与系统默认值的关系（configuration-and-overrides.md 模型可见性例外）:
 *   - 原 key 只记显式 override(布尔)，独立 owner key 保存一次性的初始化清单。
 *   - 没拨过的路线跟随当前目录 defaultEnabled；手动开/关作为 override 跨升级保留。
 *   - 收藏、历史选择不能改变开关；恢复默认只授权点名路线跟随当前/未来目录。
 *   - 「全部开启 / 全部关闭」是显式批量动作 → 为当前 agent 该来源的每个模型写显式 override。
 *
 * 谁读谁写:
 *   - 写:ProvidersSection 的模型开关 / 批量按钮(setModelVisibility / setModelVisibilities)。
 *   - 读:ModelSelector 的右栏过滤(isModelEnabled);ProvidersSection 的计数与开关态。
 *
 * 持久化频率低(仅用户点开关触发)。同 owner 的所有窗口共用 Web Lock，在锁内重读并同步
 * 写 localStorage；调用方等待落盘结果后再报告成功，不做乐观整表覆盖或事后重放。
 * 另外维护一个递增 version + 订阅者集合,供 useSyncExternalStore 让消费组件在开关变更后
 * 实时重算(设置页与聊天页可能同时挂载:设置里改完、返回聊天,ModelSelector 不重挂也能刷新)。
 */

import { useSyncExternalStore } from 'react';

import { isModelVisible, type ProviderView } from '@cindy/model-providers';

import { hasAnyProviderModelOverride, hasProviderModelHistory } from './providerModelMemory';
import { hasAnyModelEngineOverride } from './modelEnginePrefs';
import { listModelFavorites } from './modelFavorites';

import type { AgentKind } from '@/hooks/useAgentCapabilities';
import { createLogger } from '@/lib/logger';

const log = createLogger('ModelVisibilityPrefs');

const LEGACY_STORAGE_KEY = 'xdt:modelVisibilityPrefs:v1';
const STORAGE_KEY_PREFIX = `${LEGACY_STORAGE_KEY}.owner`;
const INITIALIZATION_KEY_PREFIX = `${LEGACY_STORAGE_KEY}.initialization.owner`;
const DEFAULTS_MIGRATION_KEY_PREFIX = `${LEGACY_STORAGE_KEY}.defaults-migration.v1.owner`;
const MIGRATION_COMPLETE_KEY_PREFIX = `${LEGACY_STORAGE_KEY}.migration-complete.owner`;
const LOCAL_ADOPTION_KEY_PREFIX = `${LEGACY_STORAGE_KEY}.local-adoption.owner`;
const LOCAL_OWNER_ID = 'local-v1';

/** override 表:key=`${agent}:${providerId}:${modelId}` → 用户显式设定的可见性。 */
type VisibilityMap = Record<string, boolean>;

function keyOf(agent: AgentKind, providerId: string, modelId: string): string {
  return `${agent}:${providerId}:${modelId}`;
}

/**
 * 严格校验:只保留 value 为 boolean 的条目。老版本 / 手改 localStorage 损坏时静默回退空表。
 */
function sanitize(raw: unknown): VisibilityMap {
  if (!raw || typeof raw !== 'object') return {};
  const out: VisibilityMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k && typeof v === 'boolean') out[k] = v;
  }
  return out;
}

// 进程内缓存(惰性加载)。读多写少,避免每次读都 parse localStorage。
let cache: VisibilityMap | null = null;
/** Owner/legacy JSON 无法解析时 fail-closed：不能当成「从没拨过」去跟目录默认。 */
let mapCorrupt = false;
/** adopt-local 源损坏时保持 latch，不因目标 map 合法而提前清掉。 */
let adoptionSourceCorrupt = false;
let activeOwnerId: string | null = null;
let activeOwnerGeneration = 0;
let activeOwnerReadyForWrites = false;
let activeOwnerMigrationPending = false;
let activeOwnerMode: 'signed-out' | 'local' | 'cloud' = 'signed-out';
let mayInitializeDefaults = false;
interface InitializationState {
  /** Persisted before migration/override writes; scopes records completion independently. */
  eligibleForDefaults: boolean;
  defaults: VisibilityMap;
  scopes: string[];
  followCatalogKeys: string[];
}
let initialization: InitializationState | null = null;

function emptyInitialization(eligibleForDefaults = false): InitializationState {
  return { eligibleForDefaults, defaults: {}, scopes: [], followCatalogKeys: [] };
}

function initializationKey(ownerId: string): string {
  return `${INITIALIZATION_KEY_PREFIX}.${encodeURIComponent(ownerId)}`;
}
function readInitialization(ownerId: string): InitializationState | null {
  const raw = window.localStorage.getItem(initializationKey(ownerId));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    const strings = (value: unknown): string[] => Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string') : [];
    return { eligibleForDefaults: parsed?.eligibleForDefaults === true,
      defaults: sanitize(parsed?.defaults), scopes: strings(parsed?.scopes), followCatalogKeys: strings(parsed?.followCatalogKeys) };
  } catch {
    return emptyInitialization();
  }
}
function saveInitialization(next: InitializationState): boolean {
  if (!activeOwnerId) return false;
  try {
    window.localStorage.setItem(initializationKey(activeOwnerId), JSON.stringify(next));
    initialization = next;
    mayInitializeDefaults = next.eligibleForDefaults;
    return true;
  } catch (error) {
    log.warn('model visibility initialization write failed', error);
    return false;
  }
}

/** Called while both owner locks are held. Target choices win; the local source stays intact. */
function adoptLocalModelVisibility(ownerId: string): void {
  if (ownerId === LOCAL_OWNER_ID || activeOwnerMode !== 'cloud') return;
  const completed = `${LOCAL_ADOPTION_KEY_PREFIX}.${encodeURIComponent(ownerId)}`;
  if (window.localStorage.getItem(completed) === '1') return;
  const claim = window.electronAPI?.maker?.claimLegacyModelVisibilityOwner?.();
  if (claim?.dataOwnerId !== ownerId || claim.ownerGeneration !== activeOwnerGeneration
    || !claim.canWriteOwnerScoped) return;
  if (claim.profileOrigin === 'pending') throw new Error('Local profile adoption is not ready');
  if (claim.profileOrigin !== 'adopted-local') return;

  const source = readInitialization(LOCAL_OWNER_ID) ?? emptyInitialization();
  const target = readInitialization(ownerId);
  const targetPrefixes = (target?.scopes ?? []).flatMap((scope) => {
    try {
      const parsed: unknown = JSON.parse(scope);
      return Array.isArray(parsed) && parsed.length === 2 && parsed.every((part) => typeof part === 'string')
        ? [`${parsed[1]}:${parsed[0]}:`] : [];
    } catch { return []; }
  });
  const hasTargetScope = (key: string): boolean => targetPrefixes.some((prefix) => key.startsWith(prefix));
  const next: InitializationState = {
    eligibleForDefaults: source.eligibleForDefaults || target?.eligibleForDefaults === true,
    defaults: { ...Object.fromEntries(Object.entries(source.defaults).filter(([key]) => !hasTargetScope(key))), ...target?.defaults },
    scopes: [...new Set([...source.scopes, ...target?.scopes ?? []])],
    followCatalogKeys: [...new Set([...source.followCatalogKeys.filter((key) => !hasTargetScope(key)), ...target?.followCatalogKeys ?? []])],
  };
  const targetFollowCatalogKeys = new Set(target?.followCatalogKeys ?? []);
  const sourceParsed = parseStoredMap(window.localStorage.getItem(ownerStorageKey(LOCAL_OWNER_ID)));
  const targetParsed = parseStoredMap(window.localStorage.getItem(ownerStorageKey(ownerId)));
  if (sourceParsed.corrupt || targetParsed.corrupt) {
    // Don't copy an empty sanitization of a broken local map, and don't mark adoption
    // complete — the source can still be retried after it is repaired.
    mapCorrupt = true;
    adoptionSourceCorrupt = sourceParsed.corrupt;
    return;
  }
  adoptionSourceCorrupt = false;
  const overrides = {
    // Restore defaults is an explicit target choice even though it has no override.
    ...Object.fromEntries(Object.entries(sourceParsed.map).filter(([key]) => !targetFollowCatalogKeys.has(key))),
    ...targetParsed.map,
  };
  // A failed write leaves the handoff pending. Re-reading and merging under the locks
  // makes retry/restart safe without overwriting intervening target choices.
  window.localStorage.setItem(ownerStorageKey(ownerId), JSON.stringify(overrides));
  window.localStorage.setItem(initializationKey(ownerId), JSON.stringify(next));
  window.localStorage.setItem(ownerMigrationCompleteKey(ownerId), '1');
  window.localStorage.setItem(completed, '1');
}

/** Adopt the latest owner state only after all storage reads succeed. */
function readOwnerState(ownerId: string): void {
  const nextInitialization = readInitialization(ownerId);
  const raw = window.localStorage.getItem(ownerStorageKey(ownerId));
  let newProfile = false;
  if (!nextInitialization) {
    const claim = window.electronAPI?.maker?.claimLegacyModelVisibilityOwner?.();
    if (claim?.dataOwnerId === ownerId && claim.ownerGeneration === activeOwnerGeneration) {
      // Auth can precede DB creation. Do not consume eligibility by writing migration
      // artifacts until Main has classified this profile. Old Main versions fail closed.
      if (claim.profileOrigin === 'pending') throw new Error('Model defaults profile is not ready');
      newProfile = claim.profileOrigin === 'new';
    }
  }
  const eligible = nextInitialization?.eligibleForDefaults ?? (newProfile && raw === null
    && window.localStorage.getItem(ownerMigrationCompleteKey(ownerId)) === null
    && window.localStorage.getItem(`${DEFAULTS_MIGRATION_KEY_PREFIX}.${encodeURIComponent(ownerId)}`) === null
    && !hasAnyProviderModelOverride() && !hasProviderModelHistory()
    && !hasAnyModelEngineOverride() && listModelFavorites().length === 0);
  initialization = nextInitialization;
  mayInitializeDefaults = eligible;
  cache = readStoredMap(raw);
}

/**
 * Serialize the complete read/modify/write, including migration and explicit overrides.
 * Unlike replayable favorites, a frozen first catalog must never be optimistically lost
 * and then reconstructed from a newer catalog. No persistence happens outside this lock.
 * Chromium supplies Web Locks; older single-window hosts/test environments run inline.
 */
async function withOwnerLock(
  ownerId: string | null,
  ownerGeneration: number,
  operation: () => boolean,
): Promise<boolean> {
  if (!ownerId) return false;
  const run = (): boolean => {
    if (ownerId !== activeOwnerId || ownerGeneration !== activeOwnerGeneration
      || activeOwnerMode === 'signed-out') return false;
    const snapshot = (): string => JSON.stringify([
      cache, initialization, mayInitializeDefaults, activeOwnerReadyForWrites, activeOwnerMigrationPending, mapCorrupt, adoptionSourceCorrupt,
    ]);
    const before = snapshot();
    try {
      adoptLocalModelVisibility(ownerId);
      readOwnerState(ownerId);
      return operation();
    } catch (error) {
      activeOwnerReadyForWrites = false;
      activeOwnerMigrationPending = true;
      throw error;
    } finally {
      if (snapshot() !== before) {
        mirrorToMain(cache ?? {});
        version += 1;
        for (const listener of listeners) listener();
      }
    }
  };
  try {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    return locks?.request ? await locks.request(initializationKey(ownerId), () => {
      // Cloud operations may read local-v1 only during the one-time adoption. The
      // local writer never acquires a cloud lock, so this order cannot form a cycle.
      const needsLocalLock = activeOwnerMode === 'cloud' && ownerId !== LOCAL_OWNER_ID
        && window.localStorage.getItem(`${LOCAL_ADOPTION_KEY_PREFIX}.${encodeURIComponent(ownerId)}`) !== '1';
      return needsLocalLock ? locks.request(initializationKey(LOCAL_OWNER_ID), run) : run();
    }) : run();
  } catch (error) {
    log.warn('model visibility update failed', error);
    return false;
  }
}
function effectiveMap(map: VisibilityMap): VisibilityMap {
  return { ...map };
}


function ownerStorageKey(ownerId: string): string {
  return `${STORAGE_KEY_PREFIX}.${encodeURIComponent(ownerId)}`;
}

function ownerMigrationCompleteKey(ownerId: string): string {
  return `${MIGRATION_COMPLETE_KEY_PREFIX}.${encodeURIComponent(ownerId)}`;
}

function parseStoredMap(raw: string | null): { map: VisibilityMap; corrupt: boolean } {
  if (raw === null || raw === '') return { map: {}, corrupt: false };
  try {
    return { map: sanitize(JSON.parse(raw)), corrupt: false };
  } catch {
    return { map: {}, corrupt: true };
  }
}

function readStoredMap(raw: string | null): VisibilityMap {
  const parsed = parseStoredMap(raw);
  if (parsed.corrupt) mapCorrupt = true;
  else if (raw !== null && raw !== '' && !adoptionSourceCorrupt) mapCorrupt = false;
  return parsed.map;
}

/**
 * 把旧版唯一全局 key 的快照交给 Main 已原子认领的 owner。旧 key 故意保留给并发运行的
 * 旧版本；新版本只认 owner-scoped key，所以其它账号不会再次导入这份数据。
 */
interface MigrationState {
  readyForWrites: boolean;
  migrationPending: boolean;
}

const BLOCKED_MIGRATION: MigrationState = {
  readyForWrites: false,
  migrationPending: true,
};

function migrateLegacyVisibility(ownerId: string, ownerGeneration: number): MigrationState {
  if (typeof window === 'undefined') return BLOCKED_MIGRATION;
  try {
    const scopedKey = ownerStorageKey(ownerId);
    const migrationCompleteKey = ownerMigrationCompleteKey(ownerId);
    if (window.localStorage.getItem(migrationCompleteKey) === '1') {
      return { readyForWrites: true, migrationPending: false };
    }

    // Main 用模型可见性专属 marker 把旧 key 原子归属给升级时的当前稳定 local/cloud owner；
    // canInitialize 还保证此刻没有另一个共享 userData 的旧进程在并发改写迁移输入。
    const claim = window.electronAPI?.maker?.claimLegacyModelVisibilityOwner?.();
    if (
      claim?.dataOwnerId !== ownerId
      || claim.ownerGeneration !== ownerGeneration
      || claim.canWriteOwnerScoped !== true
    ) {
      return BLOCKED_MIGRATION;
    }
    // Preserve first-run eligibility before writing any migration artifacts or allowing
    // manual overrides. An empty scopes list is pending; each nonempty catalog records
    // its own completion later. Failed persistence leaves migration retryable.
    const stored = readInitialization(ownerId);
    if (stored) {
      initialization = stored;
      mayInitializeDefaults = stored.eligibleForDefaults;
    }
    if (claim.claimedByOtherOwner !== true && claim.claimed === true
      && window.localStorage.getItem(LEGACY_STORAGE_KEY) !== null) mayInitializeDefaults = false;
    if ((!stored && mayInitializeDefaults) || (stored?.eligibleForDefaults && !mayInitializeDefaults)) {
      if (!saveInitialization(stored
        ? { ...stored, eligibleForDefaults: false }
        : emptyInitialization(true))) return BLOCKED_MIGRATION;
    }
    if (claim.claimedByOtherOwner === true) {
      // 旧快照永久属于另一账号；写入本 owner 的完成标记，后续无需依赖全局 marker 继续读写。
      window.localStorage.setItem(migrationCompleteKey, '1');
      return {
        readyForWrites: window.localStorage.getItem(migrationCompleteKey) === '1',
        migrationPending: false,
      };
    }
    if (claim.claimed !== true) {
      // A missing/blocked legacy marker only defers importing the pre-account snapshot. The
      // stable current owner can still write its isolated key; a later import merges scoped
      // values last, so these new settings win without mutating the legacy input.
      return { readyForWrites: true, migrationPending: true };
    }
    if (claim.canInitialize !== true) {
      // 归属已经明确时，新设置可以安全写进 owner namespace；只把旧全局快照的导入推迟到独占时。
      return { readyForWrites: true, migrationPending: true };
    }

    const legacyParsed = parseStoredMap(window.localStorage.getItem(LEGACY_STORAGE_KEY));
    const scopedParsed = parseStoredMap(window.localStorage.getItem(scopedKey));
    if (scopedParsed.corrupt) {
      mapCorrupt = true;
      return BLOCKED_MIGRATION;
    }
    if (legacyParsed.corrupt) {
      // Don't import a broken snapshot as empty, and don't mark complete just because
      // the scoped key already has incremental writes from the deferred-import window.
      mapCorrupt = true;
      return { readyForWrites: true, migrationPending: true };
    }
    const legacy = legacyParsed.map;
    const scoped = scopedParsed.map;
    // 非独占期间可能已经有新设置；完成迁移时由新设置覆盖同槽旧值，其余历史值仍被保留。
    window.localStorage.setItem(scopedKey, JSON.stringify({ ...legacy, ...scoped }));
    // 快照先落盘再标完成；任一步失败都会在下次写入/登录时幂等重试。
    window.localStorage.setItem(migrationCompleteKey, '1');
    return {
      readyForWrites: window.localStorage.getItem(migrationCompleteKey) === '1',
      migrationPending: false,
    };
  } catch {
    // localStorage / 同步 owner 仲裁不可用时 fail closed：不读取未归属的旧数据。
    return BLOCKED_MIGRATION;
  }
}

function ensureActiveOwnerReadyForWrites(): boolean {
  if (!activeOwnerId) return false;
  if (activeOwnerReadyForWrites && !activeOwnerMigrationPending) return true;
  if (activeOwnerMode === 'signed-out') return false;
  const migration = migrateLegacyVisibility(activeOwnerId, activeOwnerGeneration);
  activeOwnerReadyForWrites = migration.readyForWrites;
  activeOwnerMigrationPending = migration.migrationPending;
  if (!activeOwnerReadyForWrites) return false;
  if (!activeOwnerMigrationPending) {
    // A deferred migration may have imported the legacy map after this owner was first loaded.
    cache = readStoredMap(window.localStorage.getItem(ownerStorageKey(activeOwnerId)));
  }
  return true;
}

function load(): VisibilityMap {
  if (cache !== null) return cache;
  if (typeof window === 'undefined' || !activeOwnerId) {
    cache = {};
  } else {
    try {
      cache = readStoredMap(window.localStorage.getItem(ownerStorageKey(activeOwnerId)));
    } catch {
      cache = {};
    }
  }
  // 首次加载后把整张快照镜像给 main —— 让 IM /model 在 main 侧拿到用户的可见性 override
  // (override 真源仍是本地 localStorage,main 只缓存副本)。覆盖「用户从不打开模型选择器、
  // 但用 IM /model」的场景:任意 isModelEnabled 读取都会触发本次首推。
  mirrorToMain(cache);
  return cache;
}

/**
 * 单向把整张 override 快照推给 main(fire-and-forget)。main 缓存后供 IM `/model` 派生模型
 * 列表时复用同一套可见性过滤,保证 IM 与应用内列表逐模型一致。失败静默(非 electron / preload
 * 未就绪 / 测试环境),不影响本地读写。
 */
let mirrorRevision = 0;
let mirrorRetryTimer: ReturnType<typeof setTimeout> | undefined;

function mirrorToMain(map: VisibilityMap): void {
  const revision = ++mirrorRevision;
  clearTimeout(mirrorRetryTimer);
  const ownerId = activeOwnerId;
  const generation = activeOwnerGeneration;
  const pending = !!ownerId && (activeOwnerMigrationPending
    || (mayInitializeDefaults && !initialization?.scopes.length));
  const policy = ownerId ? {
    followCatalogKeys: initialization?.followCatalogKeys ?? [],
    ...(pending ? { pending: true as const } : {}),
    ...(mapCorrupt ? { fallback: false as const } : {}),
  } : undefined;
  const snapshot = effectiveMap(map);
  const send = (attempt: number): void => {
    if (revision !== mirrorRevision || ownerId !== activeOwnerId || generation !== activeOwnerGeneration) return;
    const retry = (): void => {
      if (revision === mirrorRevision && attempt < 3) {
        mirrorRetryTimer = setTimeout(() => send(attempt + 1), 250 * (2 ** attempt));
      }
    };
    try {
      const result = window.electronAPI?.maker?.syncModelVisibility?.(
        ownerId, generation, snapshot, ...(policy ? [policy] : []),
      );
      if (result) void result.catch(retry);
    } catch { retry(); }
  };
  send(0);
}

// ── 订阅 / 版本(供 useSyncExternalStore)──────────────────────────────────
let version = 0;
const listeners = new Set<() => void>();

interface VisibilityWriteContext {
  operation: 'single' | 'bulk';
  agent?: AgentKind;
  agentCount?: number;
  providerId: string;
  enabled: boolean;
  modelId?: string;
  modelCount?: number;
}

function persist(map: VisibilityMap, context: VisibilityWriteContext): boolean {
  if (typeof window === 'undefined' || !activeOwnerId) {
    log.warn('model visibility write rejected', {
      reason: 'owner-unavailable',
      ...context,
      ownerGeneration: activeOwnerGeneration,
      mode: activeOwnerMode,
    });
    return false;
  }
  try {
    window.localStorage.setItem(ownerStorageKey(activeOwnerId), JSON.stringify(map));
  } catch (error) {
    log.warn('model visibility write failed', {
      reason: 'storage-write-failed',
      ...context,
      ownerGeneration: activeOwnerGeneration,
      mode: activeOwnerMode,
    }, error);
    return false;
  }
  // 先确认落盘成功，再更新受控开关状态，避免界面显示成功但重启后设置丢失。
  cache = map;
  if (!adoptionSourceCorrupt) mapCorrupt = false;
  return true;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getVersion(): number {
  return version;
}

/** Select the owner namespace used by this renderer's model visibility overrides. */
export async function setModelVisibilityOwner(
  ownerId: string | null,
  ownerGeneration: number,
  mode: 'signed-out' | 'local' | 'cloud',
): Promise<void> {
  if (
    activeOwnerId === ownerId
    && activeOwnerGeneration === ownerGeneration
    && activeOwnerMode === mode
  ) return;
  activeOwnerId = ownerId;
  activeOwnerGeneration = ownerGeneration;
  activeOwnerMode = mode;
  activeOwnerReadyForWrites = false;
  activeOwnerMigrationPending = !!ownerId && mode !== 'signed-out';
  cache = null;
  mapCorrupt = false;
  adoptionSourceCorrupt = false;
  initialization = null;
  mayInitializeDefaults = false;
  if (ownerId && mode !== 'signed-out') {
    try {
      readOwnerState(ownerId);
    } catch { /* Storage unavailable: never infer permission to initialize an existing profile. */ }
  }
  mirrorToMain(cache ?? {});
  version += 1;
  for (const listener of listeners) listener();
  await withOwnerLock(ownerId, ownerGeneration, ensureActiveOwnerReadyForWrites);
}

/**
 * Record first-seen provider/agent catalogs for restore-default and alias mapping.
 * Visibility itself is override ?? current catalog defaultEnabled; this snapshot no longer
 * hides models the catalog says should be on. History/favorites never write an on switch.
 */
export async function migrateModelVisibilityDefaults(
  ownerId: string | null,
  ownerGeneration: number,
  providers: readonly ProviderView[],
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  // Signed-out catalogs have no owner preferences to initialize.
  if (!ownerId) return true;
  return withOwnerLock(ownerId, ownerGeneration, () => {
    if (!isCurrent() || !ensureActiveOwnerReadyForWrites() || activeOwnerMigrationPending) return false;
    try {
      const stored = readInitialization(ownerId);
      // Re-read other windows' completed scopes and overrides before adding anything.
      const state = stored ?? initialization ?? emptyInitialization();
      const next: InitializationState = { ...state, defaults: { ...state.defaults }, scopes: [...state.scopes], followCatalogKeys: [...state.followCatalogKeys] };
      const map = readStoredMap(window.localStorage.getItem(ownerStorageKey(ownerId)));
      const aliases = { ...map };
      for (const provider of providers) {
        for (const agent of provider.agents) {
          const models = provider.models[agent] ?? [];
          if (!models.length) continue;
          const scope = JSON.stringify([provider.id, agent]);
          const initializeScope = state.eligibleForDefaults && !next.scopes.includes(scope);
          for (const model of models) {
            const key = keyOf(agent, provider.id, model.id);
            if (initializeScope) next.defaults[key] = model.defaultEnabled !== false;
            // Only a declared same-engine bridge alias may carry an actual old switch.
            // Never propagate another engine's choice or infer an on switch from favorites.
            if (Object.hasOwn(map, key) || next.followCatalogKeys.includes(key)) continue;
            for (const prefix of provider.routing[agent]?.modelPrefixes ?? []) {
              if (!model.id.startsWith(prefix)) continue;
              const oldKey = keyOf(agent, provider.id, model.id.slice(prefix.length));
              if (Object.hasOwn(map, oldKey)) aliases[key] = map[oldKey]!;
              break;
            }
          }
          if (!next.scopes.includes(scope)) next.scopes.push(scope);
        }
      }
      if (Object.keys(aliases).length !== Object.keys(map).length
        && !persist(aliases, { operation: 'bulk', providerId: '*', enabled: true })) return false;
      if (JSON.stringify(state) === JSON.stringify(next) && stored !== null) {
        initialization = stored;
        return true;
      }
      if (!saveInitialization(next)) return false;
      cache = aliases;
      return true;
    } catch (error) {
      log.warn('model visibility initialization deferred', error);
      return false;
    }
  });
}

/**
 * 该 (agent, 来源, 模型) 当前是否应显示:显式开关优先，否则跟随当前目录 defaultEnabled。
 * 偏好 JSON 无法解析、或旧开关尚未迁入 owner namespace 时 fail-closed（不当成从没拨过）。
 * model 至少需带 id + 可选 defaultEnabled(直接传 CatalogModel 即可)。
 */
export function isModelEnabled(
  agent: AgentKind,
  providerId: string,
  model: { id: string; defaultEnabled?: boolean },
): boolean {
  const key = keyOf(agent, providerId, model.id);
  const override = load()[key];
  if (override !== undefined) return override;
  // Restore defaults 记在独立 initialization 里：偏好 map 损坏时仍跟随目录。
  if (initialization?.followCatalogKeys.includes(key)) {
    return isModelVisible(undefined, model.defaultEnabled);
  }
  if (mapCorrupt) return false;
  // 旧全局开关还在等独占导入：不能用目录默认把用户关过的模型暂时打开。
  if (activeOwnerMigrationPending && !mayInitializeDefaults) return false;
  return isModelVisible(undefined, model.defaultEnabled);
}

async function setVisibilityTargets(
  providerId: string,
  targets: readonly { agent: AgentKind; modelId: string }[],
  enabled: boolean,
  context: VisibilityWriteContext,
): Promise<boolean> {
  if (!providerId || targets.some(({ modelId }) => !modelId)) {
    log.warn('model visibility write rejected', { reason: 'invalid-target', ...context });
    return false;
  }
  if (targets.length === 0) return true;
  return withOwnerLock(activeOwnerId, activeOwnerGeneration, () => {
    if (!ensureActiveOwnerReadyForWrites()) {
      log.warn('model visibility write rejected', {
        reason: 'owner-write-not-ready',
        ...context,
        ownerGeneration: activeOwnerGeneration,
        mode: activeOwnerMode,
        migrationPending: activeOwnerMigrationPending,
      });
      return false;
    }
    const map = load();
    let changed = false;
    const next = { ...map };
    const keys: string[] = [];
    for (const { agent, modelId } of targets) {
      const k = keyOf(agent, providerId, modelId);
      keys.push(k);
      if (next[k] !== enabled) {
        next[k] = enabled;
        changed = true;
      }
    }
    const state = initialization ?? emptyInitialization();
    const follows = new Set(state.followCatalogKeys);
    let followChanged = false;
    for (const key of keys) {
      if (follows.delete(key)) followChanged = true;
    }
    if (followChanged && !saveInitialization({ ...state, followCatalogKeys: [...follows] })) return false;
    if (!changed) return true;
    return persist(next, context);
  });
}

/** 写单个 (agent, 来源, 模型) 的可见性 override。同值短路,避免无意义落盘 / 通知。 */
export function setModelVisibility(
  agent: AgentKind,
  providerId: string,
  modelId: string,
  enabled: boolean,
): Promise<boolean> {
  const context: VisibilityWriteContext = {
    operation: 'single',
    agent,
    providerId,
    modelId,
    enabled,
  };
  return setVisibilityTargets(providerId, [{ agent, modelId }], enabled, context);
}

/**
 * 批量写某 (agent, 来源) 下一组模型的可见性 override(「全部开启 / 全部关闭」用)。
 * 写显式 override(而非清除)——保证即便某模型目录默认是关,「全部开启」后它也显示。
 * 单次落盘 + 单次通知。无变化则短路。
 */
export function setManyVisibility(
  agent: AgentKind,
  providerId: string,
  modelIds: readonly string[],
  enabled: boolean,
): Promise<boolean> {
  const context: VisibilityWriteContext = {
    operation: 'bulk',
    agent,
    providerId,
    modelCount: modelIds.length,
    enabled,
  };
  return setVisibilityTargets(
    providerId,
    modelIds.map((modelId) => ({ agent, modelId })),
    enabled,
    context,
  );
}

/**
 * 跨 agent 原子写一组模型可见性。统一列表的一次用户操作必须只落盘一次，避免前一
 * agent 成功、后一 agent 失败后界面进入部分提交状态，导致重试方向反转。
 */
export function setModelVisibilities(
  providerId: string,
  targets: readonly { agent: AgentKind; modelId: string }[],
  enabled: boolean,
): Promise<boolean> {
  return setVisibilityTargets(providerId, targets, enabled, {
    operation: 'bulk',
    providerId,
    agentCount: new Set(targets.map(({ agent }) => agent)).size,
    modelCount: targets.length,
    enabled,
  });
}

/** Remove explicit choices so subsequent local/online defaults apply again. */
export async function resetModelVisibilities(
  providerId: string,
  targets: readonly { agent: AgentKind; modelId: string }[],
): Promise<boolean> {
  return withOwnerLock(activeOwnerId, activeOwnerGeneration, () => {
    if (!ensureActiveOwnerReadyForWrites()) return false;
    const map = load();
    const next = { ...map };
    if (targets.length === 0) return true;
    let state: InitializationState;
    try {
      state = readInitialization(activeOwnerId!) ?? initialization ?? emptyInitialization();
    } catch (error) {
      log.warn('model visibility reset read failed', error);
      return false;
    }
    const follows = new Set(state.followCatalogKeys);
    for (const target of targets) {
      const key = keyOf(target.agent, providerId, target.modelId);
      delete next[key];
      follows.add(key);
    }
    // Write permission to follow defaults first; the old explicit value keeps winning until
    // its removal succeeds. A failed override write can be retried without losing the choice.
    if (!saveInitialization({ ...state, followCatalogKeys: [...follows] })) return false;
    return persist(next, { operation: 'bulk', providerId, enabled: false, modelCount: targets.length });
  });
}

// Other windows publish only durable state. Re-read under the same owner lock instead of
// trusting event.newValue, which may already be stale when the event is delivered.
const removeStorageListener = (() => {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  const watchesPendingAdoptionSource = (key: string): boolean => {
    if (activeOwnerMode !== 'cloud' || !activeOwnerId || activeOwnerId === LOCAL_OWNER_ID) return false;
    if (window.localStorage.getItem(`${LOCAL_ADOPTION_KEY_PREFIX}.${encodeURIComponent(activeOwnerId)}`) === '1') {
      return false;
    }
    return key === initializationKey(LOCAL_OWNER_ID) || key === ownerStorageKey(LOCAL_OWNER_ID);
  };
  const onStorage = (event: StorageEvent): void => {
    if (!activeOwnerId || (event.storageArea && event.storageArea !== window.localStorage)) return;
    if (event.key !== null && event.key !== initializationKey(activeOwnerId)
      && event.key !== ownerStorageKey(activeOwnerId)
      && event.key !== ownerMigrationCompleteKey(activeOwnerId)
      && !watchesPendingAdoptionSource(event.key)) return;
    const ownerId = activeOwnerId;
    void withOwnerLock(ownerId, activeOwnerGeneration, () => {
      if (window.localStorage.getItem(ownerMigrationCompleteKey(ownerId)) === '1') {
        activeOwnerReadyForWrites = true;
        activeOwnerMigrationPending = false;
      }
      return true;
    });
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
})();

if (import.meta.hot) import.meta.hot.dispose(() => removeStorageListener?.());

export function isModelVisibilityCustomized(agent: AgentKind, providerId: string, modelId: string): boolean {
  return Object.hasOwn(load(), keyOf(agent, providerId, modelId));
}

/**
 * useSyncExternalStore 包装 —— 返回递增 version。组件把它作为 useMemo 依赖,
 * 开关变更后自动重算(计数 / 过滤后的模型列表)。
 */
export function useModelVisibilityVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

/** 测试用 —— 重置缓存 + 清 localStorage(其它代码不应调用)。 */
export function __resetForTest(): void {
  mirrorRevision += 1;
  clearTimeout(mirrorRetryTimer);
  const currentScopedKey = activeOwnerId ? ownerStorageKey(activeOwnerId) : null;
  const currentMigrationKey = activeOwnerId ? ownerMigrationCompleteKey(activeOwnerId) : null;
  if (activeOwnerId) window.localStorage.removeItem(initializationKey(activeOwnerId));
  cache = null;
  mapCorrupt = false;
  adoptionSourceCorrupt = false;
  initialization = null;
  mayInitializeDefaults = false;
  activeOwnerId = null;
  activeOwnerGeneration = 0;
  activeOwnerReadyForWrites = false;
  activeOwnerMigrationPending = false;
  activeOwnerMode = 'signed-out';
  version = 0;
  listeners.clear();
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      if (currentScopedKey) window.localStorage.removeItem(currentScopedKey);
      if (currentMigrationKey) window.localStorage.removeItem(currentMigrationKey);
    } catch {
      // ignore
    }
  }
}

export const __STORAGE_KEY = LEGACY_STORAGE_KEY;
