import {
  DEFAULT_ORCA_WORKER_PERMISSION_MODE,
  resolveOrcaWorkerPermissionMode,
  type OrcaWorkerPermissionMode,
} from '../../shared/orca-worker-permission-mode.js';

/**
 * newMakerDefaultsCache —— renderer "New Maker" 面板用户当前选择的 main 端缓存。
 *
 * Source of truth 仍是 renderer 的 newMakerDraft / workerCreationPrefs (localStorage)；
 * renderer 启动时全量 push 一次，此后每次偏好变化都增量 push，main 端只保存内存镜像。
 *
 * 用途: collab mode spawn worker 时 (enableOrcaInternal / orca-bridge.create_worker)
 * 不再用 hardcode 默认值,优先读这份缓存 —— worker 实际启动参数 = "用户在 New Maker
 * 面板里该 vendor 当前的选择";旧 renderer 未推 providerId 时,创建服务才回退 Lead 来源。
 *
 * Vendor 名称差异: renderer 用 'cc' / 'codex' / 'pi'; worker spawn 路径用
 * 'claude-code' / 'codex' / 'pi'。getWorkerDefaultsFromNewMaker 内部做映射。
 */
type VendorKey = 'cc' | 'codex' | 'pi';

interface VendorPrefsSnapshot {
  model?: string;
  effort?: string;
  /**
   * 该 vendor 当前草稿的权限档 / 来源(供应商)。device-link 远程草稿镜像需要完整
   * 镜像；collab worker 不消费这里的会话权限，但必须携带来源，避免模型与凭证路由脱钩。
   * 老版本 renderer 不推这两项 → undefined,消费方按自己的兜底处理。
   */
  permissionMode?: string;
  providerId?: string | null;
}

export interface NewMakerDraftSnapshot {
  lastByVendor: Partial<Record<VendorKey, VendorPrefsSnapshot>>;
  /** 每个 vendor 是否由用户在 New Maker picker 明确选过模型；旧 renderer 缺省不提供。 */
  modelChosenByVendor?: Partial<Record<VendorKey, boolean>>;
  fastModeByModel: Record<string, boolean>;
  effortByModel: Record<string, string>;
  /**
   * 「新建会话默认启用 worktree」勾选记忆(vendor 无关的草稿根字段)。
   * 手机 / 桌面控制端远程新建时用它播种 worktree 开关。老版本 renderer 不推 → undefined,
   * 消费方按 false 兜底。
   */
  worktreeEnabled?: boolean;
}

let cache: NewMakerDraftSnapshot | null = null;

export interface WorkerCreationPrefsSnapshot {
  workerPermissionMode: OrcaWorkerPermissionMode;
}

let workerCreationPrefsCache: WorkerCreationPrefsSnapshot | null = null;

/**
 * providerModelMemory 全量快照镜像(renderer 经 SYNC_PROVIDER_MODEL_MEMORY 推)。
 * 形状 = providerModelMemory.snapshotForSeed():`${agent}:*` 是模型级全局预设,
 * `${agent}:${providerId}` 是旧 v2 兼容副本。
 * device-link 草稿列表行的真实读源(非选中行),控制端据此完整镜像被控端草稿模型列表。
 */
export type ProviderModelMemorySnapshot = Record<
  string,
  { effortByModel: Record<string, string>; fastByModel: Record<string, boolean> }
>;
let providerMemoryCache: ProviderModelMemorySnapshot | null = null;

/** Renderer push handler 调; 整体替换缓存 (而不是合并), 跟 source of truth 对齐。 */
export function setNewMakerDraftCache(snapshot: NewMakerDraftSnapshot): void {
  cache = snapshot;
}

/** Renderer localStorage workerCreationPrefs 的 main 端内存镜像。 */
export function setWorkerCreationPrefsCache(snapshot: WorkerCreationPrefsSnapshot): void {
  workerCreationPrefsCache = {
    workerPermissionMode: resolveOrcaWorkerPermissionMode(snapshot.workerPermissionMode),
  };
}

/** 缓存未就绪时使用产品默认 Full access。 */
export function getWorkerPermissionModeFromCreationPrefs(): OrcaWorkerPermissionMode {
  return workerCreationPrefsCache?.workerPermissionMode ?? DEFAULT_ORCA_WORKER_PERMISSION_MODE;
}

/** Renderer push handler 调; 整体替换 providerModelMemory 镜像。 */
export function setProviderModelMemoryCache(snapshot: ProviderModelMemorySnapshot): void {
  providerMemoryCache = snapshot;
}

export interface WorkerDefaultsFromNewMaker {
  model?: string;
  effort?: string;
  fastMode?: boolean;
  providerId?: string | null;
}

/**
 * 根据 worker agent kind 取该 vendor 在 New Maker 面板里的当前选择。
 * 缓存未就绪 / 该 vendor 没有偏好 → 返回空对象, 调用方按自己的兜底规则处理。
 */
export function getWorkerDefaultsFromNewMaker(
  workerAgent: 'claude-code' | 'codex' | 'pi',
): WorkerDefaultsFromNewMaker {
  if (!cache) return {};
  const vendor: VendorKey = workerAgent === 'claude-code' ? 'cc' : workerAgent === 'pi' ? 'pi' : 'codex';
  const prefs = cache.lastByVendor[vendor];
  if (!prefs?.model) return {};
  const model = prefs.model;
  // effortByModel 是跨 vendor 的"按模型记忆", 优先用; 没有就退回 vendor prefs 上次记录的 effort。
  const effort = cache.effortByModel[model] ?? prefs.effort;
  // fastModeByModel 缺省按 false 兜底 (用户没显式开过就是关)。
  const fastMode = cache.fastModeByModel[model] === true;
  return { model, effort, fastMode, providerId: prefs.providerId };
}

/**
 * device-link 远程草稿镜像用:取某 vendor 在 New Maker 草稿里的**当前完整选择**
 * (model/effort/fast/permission/source)+ **整张 per-model 记忆表**。与
 * getWorkerDefaultsFromNewMaker 的区别:
 *   - 多回 permissionMode + providerId + modelChosenByUser(全量镜像)。
 *   - effort 取「当前激活档」—— 被控端 trigger 显示的就是 lastByVendor.effort,故优先它,
 *     缺省再退 effortByModel(切换记忆);worker 那条因语义不同优先 effortByModel,这里不一样。
 *   - 多回 effortByModel + fastModeByModel(整表):控制端在远程草稿里**切到列表里其它模型**时,
 *     按目标模型查这两张表还原被控端为该模型记的 effort/fast,而非沿用上一个模型 / capabilities 默认。
 *     两表跨 vendor 共享、按 model id 区分,控制端只会用自己 capabilities 里存在的 model id 去查,
 *     故整表透传无需按 vendor 过滤。
 * 缓存未就绪 / 该 vendor 没草稿 model → 返回空对象,控制端按 capabilities 默认兜底。
 */
export interface RemoteNewMakerDefaults {
  model?: string;
  /** false = 明确未选过，可应用目录新任务默认；undefined = 旧端未知，保守保留原模型。 */
  modelChosenByUser?: boolean;
  effort?: string;
  fastMode?: boolean;
  permissionMode?: string;
  providerId?: string | null;
  /** 每个模型各自记忆的 effort / fast(切模型还原用)。旧版被控端不回 → 控制端拿到 undefined。 */
  effortByModel?: Record<string, string>;
  fastModeByModel?: Record<string, boolean>;
  /**
   * providerModelMemory 全量快照;`${agent}:*` 是模型级全局预设,来源槽保留旧 v2 兼容副本。
   * device-link 草稿列表行(非选中模型)的真实权威读源:控制端据此镜像被控端每个模型的
   * effort/fast。跨 agent 隔离(key 带 agent 前缀);旧版被控端不回 → undefined → 回落默认。
   */
  providerModelMemory?: Record<
    string,
    { effortByModel: Record<string, string>; fastByModel: Record<string, boolean> }
  >;
  /**
   * 「新建会话默认启用 worktree」勾选记忆(vendor 无关)。控制端 / 手机远程新建草稿据此
   * 播种 worktree 开关默认态。旧版被控端不回 → undefined → 控制端按未勾选兜底。
   */
  worktreeEnabled?: boolean;
}

export function getRemoteNewMakerDefaults(
  agentKind: 'claude-code' | 'codex' | 'pi',
): RemoteNewMakerDefaults {
  const vendor: VendorKey =
    agentKind === 'claude-code' ? 'cc' : agentKind === 'pi' ? 'pi' : 'codex';
  // providerModelMemory(草稿列表行真实读源)与「该 vendor 是否选过模型」无关:即便 cache 未就绪 /
  // 该 vendor 无选中模型(lastByVendor 空),只要被控端有模型级预设就要全量回给控制端,
  // 否则 req1「完整镜像被控端草稿模型列表」在这条边界上回落 capabilities 默认。故在所有早返回里都带上它。
  // worktreeEnabled(vendor 无关根字段)同理:该 vendor 尚无草稿 model 的早返回也必须携带,
  // 否则空草稿的工作端上,手机/控制端永远读不到勾选态。
  const providerModelMemory = providerMemoryCache ?? undefined;
  const modelChosenByUser = cache?.modelChosenByVendor?.[vendor];
  const base: RemoteNewMakerDefaults = {
    ...(providerModelMemory ? { providerModelMemory } : {}),
    ...(cache ? { worktreeEnabled: cache.worktreeEnabled === true } : {}),
    ...(typeof modelChosenByUser === 'boolean' ? { modelChosenByUser } : {}),
  };
  if (!cache) return base;
  const prefs = cache.lastByVendor[vendor];
  if (!prefs?.model) return base;
  const model = prefs.model;
  return {
    model,
    effort: prefs.effort ?? cache.effortByModel[model],
    fastMode: cache.fastModeByModel[model] === true,
    permissionMode: prefs.permissionMode,
    providerId: prefs.providerId ?? null,
    effortByModel: cache.effortByModel,
    fastModeByModel: cache.fastModeByModel,
    ...base,
  };
}

/** device-link push payload：一次广播携带所有可建草稿的 vendor，避免增量 push 丢槽。 */
export function getRemoteNewMakerDefaultsByVendor(): {
  claudeCode: RemoteNewMakerDefaults;
  codex: RemoteNewMakerDefaults;
  pi: RemoteNewMakerDefaults;
} {
  return {
    claudeCode: getRemoteNewMakerDefaults('claude-code'),
    codex: getRemoteNewMakerDefaults('codex'),
    pi: getRemoteNewMakerDefaults('pi'),
  };
}
