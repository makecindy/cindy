/**
 * newMakerDraft —— "/cc-agent/new" 草稿状态 + vendor 偏好的 localStorage 持久化。
 *
 * 设计：
 *   - sidebar 顶部 "+ New Maker" 不再立即 createSession；改为 navigate('/cc-agent/new')
 *     并由 NewMakerDraftRoute 消费此 store 的状态。
 *   - vendor 当前选择 + 每个 vendor 上次的 model/effort/permissionMode 都存这里。
 *     Fast Mode 按模型记忆;workingDir 也存这里(初次为 null,Project 行内 + 会预填到此)。
 *   - 文本内容仍由 ChatInput 自己的 composerDraftStore 按 sessionId='new' 持久化,本 store 不掺和。
 *   - 附件不持久化(useAttachments 内存为主)。
 *   - localStorage key 带 v1 后缀便于将来 schema 升级时静默回退。
 *
 * 跨 app 重启行为(冒险者明确要求):
 *   - vendor / lastByVendor / fastModeByModel / workingDir → 保留
 *   - 文本(composerDraftStore) → 保留
 *   - 附件 → 丢失(产品决策)
 *   - extraDirs → 丢失(2026-07-25 用户定稿:引用目录是单次草稿的临时授权范围,
 *     不是偏好记忆;静默还原会让旧目录无感知地带进新会话)
 */

import { useSyncExternalStore } from 'react';

import type { MakerVendor } from '@/lib/ccAgent.types';
import type { Effort, PermissionMode } from '@/lib/userPreferences.types';
import { getDefaultModelForVendor } from '@/lib/modelDefinitions';
import { normalizeWorkingDirForStorage } from '../../shared/workingDir';
import { getManagedWorktreeBasePath } from '../../shared/managedWorktreePaths';

const STORAGE_KEY = 'xdt:newMakerDraft:v1';
const DEFAULT_CODEX_DRAFT_MODEL = 'gpt-5.4';
let activeDataOwnerId: string | null = null;

function storageKey(): string {
  return activeDataOwnerId ? `${STORAGE_KEY}:${encodeURIComponent(activeDataOwnerId)}` : STORAGE_KEY;
}

export interface VendorPrefs {
  model: string;
  effort: Effort;
  permissionMode: PermissionMode;
  /**
   * 计划模式一级开关(与 permissionMode 正交)。草稿开着时,发送建会话透传
   * planModeEnabled 落库 + createOpts.planMode 生效。老 localStorage 缺字段 → false。
   */
  planMode: boolean;
  /**
   * per-vendor 记忆的「来源(供应商)」显式选择。null = 跟随该 agent 原生默认路由。
   * 与 model/effort 同口径:切 vendor / 重启后由 ChatInput 的 initialProviderId seed 回填,
   * 发送建会话时透传给 createSession,使草稿选定的来源在新会话里生效(与会话内切来源一致)。
   */
  providerId?: string | null;
}

/**
 * 草稿阶段的协同(Lead+Worker)开关状态。
 *
 * 之前是 NewMakerDraftRoute 内部的 useState(纯内存),和 workingDir 的 localStorage
 * 持久化不一致——重启 / 切走再回 /cc-agent/new 都会丢。
 * 现在并入 draft store: 协同 + workdir 都从 newMakerDraft 这一个 store 读写,
 * 行为统一,重启也能恢复上次选择。
 *
 * 互斥约束(由 NewMakerDraftRoute 强制,不在 store 层校验):
 *   - workingDir == null 时 collab 入口被隐藏,enabled 应保持 false
 *   - collab.enabled = true 时 picker 隐藏"对话"入口,workingDir 不会变 null
 */
/**
 * 「开启协同」弹窗(CreateWorkerPopover)收集的 Worker 详细配置。
 * 草稿态没有 sessionId 无法立刻起 worker,故把富配置存进 draft,createSession 后透传给 enableOrca
 * (与会话内 requestEnableCollab 同口径)。老 draft / 未配置时为 undefined,createSession 回退默认。
 */
export interface CollabWorkerConfig {
  role: string;
  model: string;
  effort?: Effort;
  fast?: boolean;
  /** 显式选定的模型来源;null/缺省 = 未显式(main 侧按默认路由解析)。 */
  providerId?: string | null;
  /** 首条派工任务。一次性,故意不跨重启持久化(sanitize 加载时丢弃,见下方解析)。 */
  initialTask?: string;
}

export interface CollabDraft {
  enabled: boolean;
  worker: 'cc' | 'codex';
  workerConfig?: CollabWorkerConfig;
}

export interface NewMakerDraft {
  /** 当前选中的 vendor。默认 'cc',用户切换后写回 + 持久化。 */
  vendor: MakerVendor;
  /** 选中的 workingDir;初次 null,Project 行内 + 会预填到此。 */
  workingDir: string | null;
  /** 远程项目所属 host。null = 本地项目或对话。 */
  remoteHostId: string | null;
  /**
   * device-link 跨设备远程控制:本草稿目标被控设备 deviceId(非 null = 这是"在远程设备
   * 项目里新建对话")。**故意不跨重启持久化**——deviceId 绑定的是一台可能离线的活动设备,
   * sanitize 从 localStorage 加载时一律置 null(见 sanitize),只在单次会话内有效。
   */
  deviceLinkDeviceId: string | null;
  /** device-link 目标设备友好名(草稿页横幅展示),与 deviceLinkDeviceId 同源。 */
  deviceLinkDeviceName: string | null;
  /** 协同模式开关 + Worker 类型(草稿期持久化,Send 时由 enableOrca 消费)。 */
  collab: CollabDraft;
  /**
   * New Maker 的 Fast Mode 记忆,按模型分开。
   * 缺省 false;实际是否可用还要由 UI 结合 capabilities 判定。
   */
  fastModeByModel: Record<string, boolean>;
  /**
   * 每个 modelId 上一次显式选过的 effort,跨 ChatInput 实例 / 跨 New Maker
   * 创建持久化。场景:在 Opus 4.7 选了 high → 切到 Haiku (强制落到 low) →
   * 发送 → + New Maker → 再切回 Opus 4.7,应该恢复 high 而不是停在 low。
   * (在此字段加入之前,ChatInput 内的 effortByModelRef 只在单个实例生命周期里有效,
   * 新 ChatInput 一 mount 这份记忆就丢了,导致每个 model 默认沿用 lastByVendor.effort,
   * 而那个 effort 又被切到无 effort 的 Haiku 时硬塞成了 low。)
   */
  effortByModel: Record<string, Effort>;
  /**
   * 草稿期间用户加的附加只读引用目录列表(绝对路径)。draft-wide,不分 vendor。
   * Claude 与 Codex session 都会透传，并支持会话中途覆盖。
   * 生命周期是"单次草稿":发送后清空(resetDraftWorkspaceAfterSend)、进入草稿页
   * 清空(NewMakerDraftRoute mount)、**不跨重启还原**(sanitize 一律置空)。
   */
  extraDirs: string[];
  /** 每个 vendor 的"上次使用配置"——切回该 vendor 时自动恢复。 */
  lastByVendor: Record<MakerVendor, VendorPrefs>;
  /**
   * 用户是否在 New Maker 界面**显式**选过该 vendor 的模型。
   * lastByVendor 整个快照随任意 draft 写入落盘,model 即使从没被用户碰过也会带上
   * sanitize 的种子默认值 —— 仅凭 lastByVendor 无法区分"真选过"和"默认回填"。
   * 调度任务默认模型的三级回退(getPersistedVendorModel 消费)只认这里标记过的
   * vendor,否则全新 / 没用过该 vendor 的用户会被对话侧 Opus 种子默认顶掉
   * 成本保守兜底。patchVendorPrefs 收到 New Maker 显式 model 时置 true;会话同步 model
   * 覆盖 lastByVendor 时清掉,避免把会话侧模型误当成 New Maker picker 选择。
   */
  modelChosenByVendor: Partial<Record<MakerVendor, boolean>>;
}

function defaultVendorPrefs(vendor: MakerVendor): VendorPrefs {
  if (vendor === 'codex') {
    return {
      model: DEFAULT_CODEX_DRAFT_MODEL,
      effort: 'high',
      permissionMode: 'auto',
      planMode: false,
      providerId: null,
    };
  }
  return {
    model: getDefaultModelForVendor('cc').id,
    effort: 'medium',
    // 三种 vendor 都保留 Auto-review 种子默认；已有用户落盘的
    // lastByVendor 记忆不受影响(sanitize 只在缺失 / 脏值时回落本默认)。
    permissionMode: 'auto',
    planMode: false,
    providerId: null,
  };
}

function defaultCollab(): CollabDraft {
  return { enabled: false, worker: 'codex' };
}

function makeDefault(): NewMakerDraft {
  return {
    vendor: 'cc',
    workingDir: null,
    remoteHostId: null,
    deviceLinkDeviceId: null,
    deviceLinkDeviceName: null,
    collab: defaultCollab(),
    fastModeByModel: {},
    effortByModel: {},
    extraDirs: [],
    lastByVendor: {
      cc: defaultVendorPrefs('cc'),
      orca: defaultVendorPrefs('orca'),
      codex: defaultVendorPrefs('codex'),
    },
    modelChosenByVendor: {},
  };
}

/**
 * New Maker 的默认工作目录表示"项目入口",不是某次会话的隔离运行目录。
 * Cindy 自己创建的 worktree 固定在 `<repo>/.cindy-worktrees/<name>` 下；品牌
 * 迁移前的 `<repo>/.xdt-worktrees/<name>` 也继续识别。如果历史 localStorage
 * 或未来调用方误把它写进 draft,这里折回项目根目录,避免再次新建 Maker 时
 * 默认落到 worktree 里并触发"已在 worktree 中"。
 *
 * 这里故意只处理 Cindy 自己托管的目录：New Maker 草稿默认值不应折叠用户
 * 手选的 `.worktrees` / `.claude/worktrees`。侧边栏会话分组需要识别更多
 * worktree 形态,两边的职责不同,不要合并成同一套规则。
 */
function normalizeDraftWorkingDir(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const normalized = normalizeWorkingDirForStorage(raw);
  if (normalized == null) return null;
  return getManagedWorktreeBasePath(normalized) ?? normalized;
}

/** 严格校验 + 缺字段补齐——schema 损坏(老版本 / 手改 localStorage)时静默回退默认。 */
function sanitize(raw: unknown): NewMakerDraft {
  const def = makeDefault();
  if (!raw || typeof raw !== 'object') return def;
  const r = raw as Partial<NewMakerDraft>;
  // F-COLLAB (2026-05): 'orca' vendor 已被 ChatInput 底部的 toggle 取代,
  // sanitize 时把历史 localStorage 残留的 'orca' 自动迁移到 'cc',避免空白入口。
  const vendor: MakerVendor =
    r.vendor === 'codex' ? 'codex' : 'cc';
  const workingDir = normalizeDraftWorkingDir(r.workingDir);
  const remoteHostId =
    typeof r.remoteHostId === 'string' && r.remoteHostId.trim().length > 0
      ? r.remoteHostId.trim()
      : null;
  const lastByVendorRaw = (r.lastByVendor ?? {}) as Partial<NewMakerDraft['lastByVendor']>;
  const fastModeByModelRaw =
    r.fastModeByModel && typeof r.fastModeByModel === 'object'
      ? (r.fastModeByModel as Record<string, unknown>)
      : {};
  const fastModeByModel = Object.fromEntries(
    Object.entries(fastModeByModelRaw)
      .filter(([modelId]) => modelId.length > 0)
      .map(([modelId, enabled]) => [modelId, enabled === true]),
  );
  // effortByModel: 接受任何 string 值 (Effort 枚举校验交给消费方按当前模型 capabilities 过滤)。
  // 老版本 localStorage 没有这个字段 → 空对象兜底。
  const effortByModelRaw =
    r.effortByModel && typeof r.effortByModel === 'object'
      ? (r.effortByModel as Record<string, unknown>)
      : {};
  const effortByModel = Object.fromEntries(
    Object.entries(effortByModelRaw)
      .filter(
        ([modelId, effort]) =>
          modelId.length > 0 && typeof effort === 'string' && effort.length > 0,
      )
      .map(([modelId, effort]) => [modelId, effort as Effort]),
  );
  // extraDirs **故意不跨重启持久化**(同 deviceLinkDeviceId 先例):引用目录是
  // 单次草稿的临时授权范围,静默还原会让用户无感知地把旧目录带进新会话。
  // NewMakerDraftRoute mount 时也会清空(同一决定的双保险)。
  const extraDirs: string[] = [];
  // collab 校验: 老版本无此字段 → 默认 OFF + codex worker。
  // 防御性互斥: workingDir==null 时 enabled 应该为 false (隐藏入口的兜底,
  // 防止历史脏数据让用户看到协同 ON 但 workdir 为空的不可达状态)。
  const collabRaw = (r as { collab?: Partial<CollabDraft> }).collab;
  const collabWorker: CollabDraft['worker'] =
    collabRaw?.worker === 'cc' ? 'cc' : 'codex';
  // remote 项目的协同 codex / cc draft 均放行:worker 创建已继承 remoteHostId
  // (在同一台远端主机 spawn,见 OrcaLeadSessionSnapshot.remoteHostId),两端
  // 远端 MCP 注入均已落地 (codex daemon config + cc per-query http 注入)。
  // 本地项目(remoteHostId==null)不受影响。
  const collabEnabled =
    collabRaw?.enabled === true && workingDir != null;
  // workerConfig 防御性解析:model 缺失/为空则整块丢弃(不存半截配置),createSession 回退默认。
  const workerConfig: CollabWorkerConfig | undefined = (() => {
    const wc = collabRaw?.workerConfig;
    if (!wc || typeof wc !== 'object') return undefined;
    const model = typeof wc.model === 'string' && wc.model.trim() ? wc.model : undefined;
    if (!model) return undefined;
    const role = typeof wc.role === 'string' && wc.role.trim() ? wc.role.trim() : 'developer';
    return {
      role,
      model,
      effort: typeof wc.effort === 'string' ? (wc.effort as Effort) : undefined,
      fast: typeof wc.fast === 'boolean' ? wc.fast : undefined,
      // 来源与模型是同一次选择的两个维度,随 model 一起耐久保留;与 role 同样 trim,
      // 空白串回落未显式 —— IPC 侧把非空 string 当显式来源,漏 trim 会把无效 id
      // 一路带到 PROVIDER_ROUTE_UNAVAILABLE(copilot review)。
      providerId:
        typeof wc.providerId === 'string' && wc.providerId.trim()
          ? wc.providerId.trim()
          : undefined,
      // initialTask 是一次性任务,**故意不跨重启持久化**(同 deviceLinkDeviceId 先例):
      // 重启后 Send/New Goal 会静默把过期任务当 delegateTask 发出去,而收起态 pill
      // 无从看见/编辑(codex P2)。耐久保留的只有 role/model/effort/fast/providerId。
    };
  })();
  const collab: CollabDraft = { enabled: collabEnabled, worker: collabWorker, workerConfig };
  const sanitizeVendorPrefs = (p: Partial<VendorPrefs> | undefined, v: MakerVendor): VendorPrefs => {
    const fallback = defaultVendorPrefs(v);
    if (!p || typeof p !== 'object') return fallback;
    // 计划模式独立成一级开关后, 历史草稿里 permissionMode='plan' 迁移为
    // planMode=true + 该 vendor 默认权限档(与 DB 迁移同语义)。
    const legacyPlanPermission = p.permissionMode === 'plan';
    return {
      model: typeof p.model === 'string' && p.model.length > 0 ? p.model : fallback.model,
      effort: typeof p.effort === 'string' ? (p.effort as Effort) : fallback.effort,
      permissionMode:
        typeof p.permissionMode === 'string' && !legacyPlanPermission
          ? (p.permissionMode as PermissionMode)
          : fallback.permissionMode,
      planMode: p.planMode === true || legacyPlanPermission,
      // providerId: 接受非空 string 或 null;脏数据 / 缺字段一律落 null(跟随默认路由)。
      providerId:
        typeof p.providerId === 'string' && p.providerId.length > 0 ? p.providerId : null,
    };
  };
  // modelChosenByVendor: 老版本 localStorage 没有这个字段 → 空对象兜底
  //（语义上等于"全部 vendor 都没显式选过",调度三级回退会落到成本保守兜底)。
  const modelChosenRaw =
    r.modelChosenByVendor && typeof r.modelChosenByVendor === 'object'
      ? (r.modelChosenByVendor as Record<string, unknown>)
      : {};
  const modelChosenByVendor: Partial<Record<MakerVendor, boolean>> = {};
  for (const v of ['cc', 'orca', 'codex'] as const) {
    if (modelChosenRaw[v] === true) modelChosenByVendor[v] = true;
  }
  return {
    vendor,
    workingDir,
    remoteHostId: workingDir == null ? null : remoteHostId,
    // device-link 目标**不跨重启恢复**:绑定的是活动设备,重启后可能已离线 → 一律置 null。
    deviceLinkDeviceId: null,
    deviceLinkDeviceName: null,
    collab,
    fastModeByModel,
    effortByModel,
    extraDirs,
    lastByVendor: {
      cc: sanitizeVendorPrefs(lastByVendorRaw.cc, 'cc'),
      orca: sanitizeVendorPrefs(lastByVendorRaw.orca, 'orca'),
      codex: sanitizeVendorPrefs(lastByVendorRaw.codex, 'codex'),
    },
    modelChosenByVendor,
  };
}

function loadFromStorage(): NewMakerDraft {
  if (typeof window === 'undefined') return makeDefault();
  try {
    const raw = window.localStorage.getItem(storageKey());
    if (!raw) return makeDefault();
    return sanitize(JSON.parse(raw));
  } catch {
    return makeDefault();
  }
}

// 同步写: prefs 写入频率极低 (用户点击 dropdown 才触发), 不需要 batch。
// 之前的 100ms debounce 在 release 的"热更新→relaunch"路径上会丢失最近一次
// 改动 (lifecycle 走 app.exit() 强退, 来不及 fire 这个 setTimeout), 直接同步
// 落盘最稳。
function scheduleWrite(snapshot: NewMakerDraft) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(), JSON.stringify(snapshot));
  } catch {
    // localStorage 满 / 私密窗口禁写——忽略,不影响内存状态。
  }
}

let currentDraft: NewMakerDraft = loadFromStorage();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function getDraft(): NewMakerDraft {
  return currentDraft;
}

/** Switch the persistent draft namespace together with the active data owner. */
export function setNewMakerDraftOwner(ownerId: string | null): void {
  const normalized = typeof ownerId === 'string' && ownerId.trim().length > 0 ? ownerId : null;
  if (activeDataOwnerId === normalized) return;
  activeDataOwnerId = normalized;
  currentDraft = loadFromStorage();
  emit();
}

export function patchDraft(patch: Partial<NewMakerDraft>): void {
  const normalizedPatch: Partial<NewMakerDraft> = { ...patch };
  if ('workingDir' in normalizedPatch) {
    normalizedPatch.workingDir = normalizeDraftWorkingDir(normalizedPatch.workingDir);
  }
  if ('remoteHostId' in normalizedPatch) {
    const remoteHostId = normalizedPatch.remoteHostId;
    normalizedPatch.remoteHostId =
      typeof remoteHostId === 'string' && remoteHostId.trim().length > 0
        ? remoteHostId.trim()
        : null;
  }
  const next: NewMakerDraft = { ...currentDraft, ...normalizedPatch };
  // 互斥兜底: 任何把 workingDir 改成 null 的路径,都把 collab 关掉。
  // UI 已经在 collab.enabled 时隐藏"对话"入口,正常路径走不到这里;
  // 这条只是防御性,避免外部调用者(将来的代码 / 测试)把 workingDir 清成 null
  // 后留下 collab.enabled=true 的不可达状态。
  if ('workingDir' in patch && next.workingDir == null && next.collab.enabled) {
    next.collab = { ...next.collab, enabled: false };
  }
  if ('workingDir' in patch && next.workingDir == null) {
    next.remoteHostId = null;
  } else if ('workingDir' in patch && !('remoteHostId' in patch)) {
    next.remoteHostId = null;
  }
  // 改 workingDir 但**没有显式带** deviceLink 字段 → 清除远程目标,避免把本地项目误当成
  // 远程设备项目。
  //
  // #807:原来这里还有一条「workingDir 变 null 就无条件清设备」的分支(即使同一个 patch
  // 显式提供了 deviceLinkDeviceId 也清)。那是「远程草稿必带项目目录」时代的不变量;设备
  // 提成一级维度后它直接把新流程打死 —— 选设备时传的正是
  // `{ deviceLinkDeviceId, workingDir: null }`,设备刚设上就被清成 null,选设备完全不生效。
  // 现在只保留「未显式带设备字段」这一条:显式指定设备的 patch 一律尊重,
  // 而 resetDraftWorkspaceAfterSend 之类不带设备字段的清空路径行为不变。
  if ('workingDir' in patch && !('deviceLinkDeviceId' in patch)) {
    next.deviceLinkDeviceId = null;
    next.deviceLinkDeviceName = null;
  }
  // device-link 草稿同样禁用协同(同 remoteHostId:worker 创建拿不到 deviceId)。
  if (next.deviceLinkDeviceId != null && next.collab.enabled) {
    next.collab = { ...next.collab, enabled: false };
  }
  // remote 项目 draft 的协同 codex / cc 均已接通(worker 创建已继承
  // remoteHostId,远端 MCP 注入两端落地),不再按 vendor 强制关闭。
  currentDraft = next;
  scheduleWrite(currentDraft);
  emit();
}

/** 单字段写入 collab(便捷 setter,语义比 patchDraft({ collab: ... }) 更直接)。 */
export function patchCollab(patch: Partial<CollabDraft>): void {
  patchDraft({ collab: { ...currentDraft.collab, ...patch } });
}

/**
 * 切 vendor 的便捷入口:
 *   1. 把当前 vendor 的 (model/effort/permissionMode) 落进 lastByVendor[currentVendor]
 *   2. 切到新 vendor
 * NewMakerDraftRoute 的 VendorSegmentedSwitcher 切换时调本函数;切回某 vendor 时 ChatInput 通过 lastByVendor[vendor] 取上次值。
 */
export function switchVendor(next: MakerVendor, currentPrefs: VendorPrefs): void {
  if (currentDraft.vendor === next) return;
  const prev = currentDraft.vendor;
  currentDraft = {
    ...currentDraft,
    vendor: next,
    lastByVendor: {
      ...currentDraft.lastByVendor,
      [prev]: currentPrefs,
    },
  };
  scheduleWrite(currentDraft);
  emit();
}

/**
 * 显式指定 vendor 的 pref 写入入口。读模块级 currentDraft (而非调用方 closure
 * 捕获的 draft), 避免连续调用之间相互覆盖 —— ChatInput 切 model 时会同步连发
 * onModelDidChange + onEffortDidChange, closure 模式下第二次调用拿到的是第一次
 * 未生效前的 lastByVendor, 会把 model 改动覆盖掉。
 */
function patchVendorPrefsInternal(
  vendor: MakerVendor,
  patch: Partial<VendorPrefs>,
  opts: { markModelChoice: boolean },
): void {
  const modelChosen = { ...currentDraft.modelChosenByVendor };
  if (typeof patch.model === 'string' && patch.model.length > 0) {
    if (opts.markModelChoice) {
      // New Maker 显式 model 选择 → 打标记(见 modelChosenByVendor 注释)。
      modelChosen[vendor] = true;
    } else if (
      currentDraft.modelChosenByVendor[vendor] &&
      currentDraft.lastByVendor[vendor].model === patch.model
    ) {
      // 会话同步的是同一个 model:保留原 New Maker picker 选择语义。
      modelChosen[vendor] = true;
    } else {
      // 会话同步 model 会覆盖 lastByVendor[vendor].model。若 model 发生变化,旧标记已不能继续代表
      // "New Maker picker 选过这个 model",否则 scheduler 会把会话侧模型误当成显式选择。
      delete modelChosen[vendor];
    }
  }
  currentDraft = {
    ...currentDraft,
    modelChosenByVendor: modelChosen,
    lastByVendor: {
      ...currentDraft.lastByVendor,
      [vendor]: { ...currentDraft.lastByVendor[vendor], ...patch },
    },
  };
  scheduleWrite(currentDraft);
  emit();
}

export function patchVendorPrefs(vendor: MakerVendor, patch: Partial<VendorPrefs>): void {
  patchVendorPrefsInternal(vendor, patch, { markModelChoice: true });
}

/**
 * 已创建会话把最近一次成功应用的模型偏好同步回 New Maker 草稿默认时使用。
 * 这会更新 lastByVendor 供下一次新建聊天复用,但不把 modelChosenByVendor 打成
 * "用户在 New Maker 显式选过模型",避免影响 scheduler 的成本保守默认模型兜底。
 */
export function patchVendorPrefsPreservingModelChoice(
  vendor: MakerVendor,
  patch: Partial<VendorPrefs>,
): void {
  patchVendorPrefsInternal(vendor, patch, { markModelChoice: false });
}

/** 单字段写入当前 vendor 的某个 pref(用户在 ChatInput 改 model 等时同步落地)。 */
export function patchCurrentVendorPrefs(patch: Partial<VendorPrefs>): void {
  patchVendorPrefs(currentDraft.vendor, patch);
}

export function getEffortForModel(modelId: string | null | undefined): Effort | undefined {
  if (!modelId) return undefined;
  return currentDraft.effortByModel[modelId];
}

export function setEffortForModel(modelId: string, effort: Effort): void {
  if (!modelId) return;
  // 同值短路,避免无意义的 emit / write。
  if (currentDraft.effortByModel[modelId] === effort) return;
  currentDraft = {
    ...currentDraft,
    effortByModel: {
      ...currentDraft.effortByModel,
      [modelId]: effort,
    },
  };
  scheduleWrite(currentDraft);
  emit();
}

export function getFastModeForModel(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  return currentDraft.fastModeByModel[modelId] === true;
}

export function setFastModeForModel(modelId: string, enabled: boolean): void {
  if (!modelId) return;
  currentDraft = {
    ...currentDraft,
    fastModeByModel: {
      ...currentDraft.fastModeByModel,
      [modelId]: enabled,
    },
  };
  scheduleWrite(currentDraft);
  emit();
}

export function clearDraft(): void {
  currentDraft = makeDefault();
  scheduleWrite(currentDraft);
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function subscribeDraft(listener: () => void): () => void {
  return subscribe(listener);
}

/** React hook —— useSyncExternalStore 保证多组件订阅一致 + StrictMode 双 render 安全。 */
export function useNewMakerDraft(): NewMakerDraft {
  return useSyncExternalStore(subscribe, getDraft, getDraft);
}

/** 当前 vendor 的有效 prefs(读出来的快照)。 */
export function getCurrentVendorPrefs(): VendorPrefs {
  return currentDraft.lastByVendor[currentDraft.vendor];
}

/**
 * 读用户在 New Maker 界面**显式选择过**的 vendor model。
 *
 * 与 getDraft().lastByVendor[v].model 的区别:后者永远非空 —— sanitize 会用
 * getDefaultModelForVendor 兜底填充,且 lastByVendor 整个快照随任意 draft 写入
 * 落盘,即使用户从没碰过该 vendor 的模型,持久化里也躺着种子默认值。
 * 所以这里要求 modelChosenByVendor[vendor] === true(只在 patchVendorPrefs
 * 收到显式 model 时打的标)才返回,否则一律 ''。
 * 调度任务的默认模型三级回退(useScheduleForm getScheduleDefaultModel)依赖这个
 * 区分:没显式选过的用户应落到调度自己的成本保守兜底(Sonnet),而不是被
 * 对话侧的 Opus 默认顶掉。读 raw localStorage 而非 getDraft(),解析失败 → ''。
 */
export function getPersistedVendorModel(vendor: MakerVendor): string {
  if (typeof window === 'undefined') return '';
  try {
    const raw = window.localStorage.getItem(storageKey());
    if (!raw) return '';
    const parsed = JSON.parse(raw) as Partial<NewMakerDraft> | null;
    if (parsed?.modelChosenByVendor?.[vendor] !== true) return '';
    const model = parsed?.lastByVendor?.[vendor]?.model;
    return typeof model === 'string' ? model : '';
  } catch {
    return '';
  }
}

/** 测试用 —— 重置 store + 清 localStorage(其它代码不应调用)。 */
export function __resetForTest(): void {
  currentDraft = makeDefault();
  activeDataOwnerId = null;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  emit();
}

export const __STORAGE_KEY = STORAGE_KEY;
