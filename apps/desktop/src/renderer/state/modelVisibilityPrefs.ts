/**
 * modelVisibilityPrefs —— 按「(agent, 来源/provider, model) → 是否在模型选择器显示」的
 * **用户本地 override**,按 dataOwnerId 隔离后写入 localStorage,跨会话 / 跨重启在本机生效。
 *
 * 背景:
 *   每个来源(provider)在某个 agent 下可能提供很多模型(XD 网关 Claude Code 有 20 个),
 *   用户本地全列出来会很长。设置 → 模型供应商 展开来源后,用户可逐个开关哪些模型显示。
 *   这里只存**用户显式改过的那些**(override),没改过的模型跟随目录里的系统默认值
 *   (CatalogModel.defaultEnabled,缺省 ⇒ 开)。
 *
 * 为什么 key 必须带 agent:
 *   同一来源可同时服务多个 agent(XD = claude-code + codex),且两个 agent 下模型集不同、
 *   同名模型元数据也不同(gpt-5.5 cc=1M / codex=272k)。开关必须 per-agent 独立,否则
 *   在 Claude Code 下关掉 gpt-5.5 会连带影响 Codex。key = `${agent}:${providerId}:${modelId}`。
 *
 * 与系统默认值的关系(对齐 CLAUDE.md 规则 20):
 *   - 本 store 只记 override(布尔),**不**快照系统默认值。
 *   - 未被 override 的模型永远跟随当前版本目录的 defaultEnabled —— 新增模型默认开,
 *     未自定义的用户随版本自然吃到。
 *   - 「全部开启 / 全部关闭」是显式批量动作 → 为当前 agent 该来源的每个模型写显式 override。
 *
 * 谁读谁写:
 *   - 写:ProvidersSection 的模型开关 / 批量按钮(setModelVisibility / setModelVisibilities)。
 *   - 读:ModelSelector 的右栏过滤(isModelEnabled);ProvidersSection 的计数与开关态。
 *
 * 持久化频率低(仅用户点开关触发),同步写 localStorage,不做 batch / debounce —— 与
 * providerModelMemory / newMakerDraft 取舍一致(避免热更新 relaunch 强退丢最近一次改动)。
 * 另外维护一个递增 version + 订阅者集合,供 useSyncExternalStore 让消费组件在开关变更后
 * 实时重算(设置页与聊天页可能同时挂载:设置里改完、返回聊天,ModelSelector 不重挂也能刷新)。
 */

import { useSyncExternalStore } from 'react';

import { isModelVisible } from '@cindy/model-providers';

import type { AgentKind } from '@/hooks/useAgentCapabilities';
import { createLogger } from '@/lib/logger';

const log = createLogger('ModelVisibilityPrefs');

const LEGACY_STORAGE_KEY = 'xdt:modelVisibilityPrefs:v1';
const STORAGE_KEY_PREFIX = `${LEGACY_STORAGE_KEY}.owner`;
const MIGRATION_COMPLETE_KEY_PREFIX = `${LEGACY_STORAGE_KEY}.migration-complete.owner`;

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
let activeOwnerId: string | null = null;
let activeOwnerGeneration = 0;
let activeOwnerReadyForWrites = false;
let activeOwnerMigrationPending = false;
let activeOwnerMode: 'signed-out' | 'local' | 'cloud' = 'signed-out';

function ownerStorageKey(ownerId: string): string {
  return `${STORAGE_KEY_PREFIX}.${encodeURIComponent(ownerId)}`;
}

function ownerMigrationCompleteKey(ownerId: string): string {
  return `${MIGRATION_COMPLETE_KEY_PREFIX}.${encodeURIComponent(ownerId)}`;
}

function readStoredMap(raw: string | null): VisibilityMap {
  if (!raw) return {};
  try {
    return sanitize(JSON.parse(raw));
  } catch {
    return {};
  }
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

    const legacy = readStoredMap(window.localStorage.getItem(LEGACY_STORAGE_KEY));
    const scoped = readStoredMap(window.localStorage.getItem(scopedKey));
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
    cache = null;
    load();
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
function mirrorToMain(map: VisibilityMap): void {
  try {
    const syncPromise = window.electronAPI?.maker?.syncModelVisibility?.(
      activeOwnerId,
      activeOwnerGeneration,
      map,
    );
    if (syncPromise) void syncPromise.catch(() => undefined);
  } catch {
    // ignore — 镜像失败不影响本地可见性逻辑
  }
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
  version += 1;
  // 每次开关变更后把最新快照重推 main,保持 IM /model 与应用内可见性一致。
  mirrorToMain(map);
  for (const l of listeners) l();
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
export function setModelVisibilityOwner(
  ownerId: string | null,
  ownerGeneration: number,
  mode: 'signed-out' | 'local' | 'cloud',
): void {
  if (
    activeOwnerId === ownerId
    && activeOwnerGeneration === ownerGeneration
    && activeOwnerMode === mode
  ) return;
  activeOwnerId = ownerId;
  activeOwnerGeneration = ownerGeneration;
  activeOwnerMode = mode;
  activeOwnerReadyForWrites = false;
  activeOwnerMigrationPending = false;
  cache = null;
  if (ownerId && mode !== 'signed-out') {
    const migration = migrateLegacyVisibility(ownerId, ownerGeneration);
    activeOwnerReadyForWrites = migration.readyForWrites;
    activeOwnerMigrationPending = migration.migrationPending;
  }
  load();
  version += 1;
  for (const listener of listeners) listener();
}

/**
 * 该 (agent, 来源, 模型) 当前是否应显示:用户 override 优先,否则跟随目录默认值。
 * model 至少需带 id + 可选 defaultEnabled(直接传 CatalogModel 即可)。
 * 决策走共享包 `isModelVisible`(与 main 侧 IM /model 同一套口径,见 @cindy/model-providers)。
 */
export function isModelEnabled(
  agent: AgentKind,
  providerId: string,
  model: { id: string; defaultEnabled?: boolean },
): boolean {
  return isModelVisible(load()[keyOf(agent, providerId, model.id)], model.defaultEnabled);
}

function setVisibilityTargets(
  providerId: string,
  targets: readonly { agent: AgentKind; modelId: string }[],
  enabled: boolean,
  context: VisibilityWriteContext,
): boolean {
  if (!providerId || targets.some(({ modelId }) => !modelId)) {
    log.warn('model visibility write rejected', { reason: 'invalid-target', ...context });
    return false;
  }
  if (targets.length === 0) return true;
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
  for (const { agent, modelId } of targets) {
    const k = keyOf(agent, providerId, modelId);
    if (next[k] !== enabled) {
      next[k] = enabled;
      changed = true;
    }
  }
  return changed ? persist(next, context) : true;
}

/** 写单个 (agent, 来源, 模型) 的可见性 override。同值短路,避免无意义落盘 / 通知。 */
export function setModelVisibility(
  agent: AgentKind,
  providerId: string,
  modelId: string,
  enabled: boolean,
): boolean {
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
): boolean {
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
): boolean {
  return setVisibilityTargets(providerId, targets, enabled, {
    operation: 'bulk',
    providerId,
    agentCount: new Set(targets.map(({ agent }) => agent)).size,
    modelCount: targets.length,
    enabled,
  });
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
  const currentScopedKey = activeOwnerId ? ownerStorageKey(activeOwnerId) : null;
  const currentMigrationKey = activeOwnerId ? ownerMigrationCompleteKey(activeOwnerId) : null;
  cache = null;
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
