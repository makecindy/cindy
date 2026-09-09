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
import { isSelectableVendor } from '@/lib/agentVendors';
import type { Effort, PermissionMode } from '@/lib/userPreferences.types';
import { getDefaultModelForVendor } from '@/lib/modelDefinitions';
import { isKnownProductDefaultTupleIdentity } from '@/lib/newMakerDefaultTuple';
import type { OrcaWorkerPermissionMode } from '../../shared/orca-worker-permission-mode';
import { normalizeWorkingDirForStorage } from '../../shared/workingDir';
import { getManagedWorktreeBasePath } from '../../shared/managedWorktreePaths';

const STORAGE_KEY = 'xdt:newMakerDraft:v1';
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
 * 协同与工作区形态正交:项目和对话草稿都能开启;只有真正开始一次新草稿时才把
 * enabled 复位为 false,避免把上一次发送的协同选择静默带到下一次。
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
  /** 当前协同 Team 后续新 Worker 共用的默认权限。 */
  workerPermissionMode?: OrcaWorkerPermissionMode;
}

export interface CollabDraft {
  enabled: boolean;
  worker: 'cc' | 'codex' | 'pi';
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
   * 「新建会话默认启用 worktree」勾选记忆。vendor 无关的根级布尔(同 collab 先例),
   * 语义是「这台工作端上新建会话时 worktree 开关的默认状态」——桌面本机草稿与手机 /
   * 桌面控制端远程草稿读写同一份(读经 maker:get-new-maker-defaults 镜像,写经
   * maker:apply-new-maker-worktree-pref 写穿)。
   * 只在用户**显式**切换开关时写入;切项目、选分支、资格探测、重连等其它操作
   * 一律保持原值,避免环境因素抹掉用户偏好。
   * 直接复用 Cindy 现有 newMakerDraft 配置命名空间,不另建 worktree 专用配置。
   * 有效值由系统默认 + worktreePreferenceCustomized override 合成。
   */
  worktreeEnabled: boolean;
  /**
   * worktreeEnabled 是否来自用户显式选择。false 时持久化快照里的布尔只是一份
   * 旧系统默认缓存，加载时必须按当前系统默认重新合成，不能把默认永久固化。
   */
  worktreePreferenceCustomized: boolean;
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
  /** 单次草稿内用户明确授予的附加可读写目录；不跨重启。 */
  writableDirs: string[];
  /** 每个 vendor 的"上次使用配置"——切回该 vendor 时自动恢复。 */
  lastByVendor: Record<MakerVendor, VendorPrefs>;
  /**
   * 用户是否**显式**选过该 vendor 的模型（新建页 picker，或已有任务里换模）。
   * lastByVendor 整个快照随任意 draft 写入落盘,model 即使从没被用户碰过也会带上
   * sanitize 的种子默认值 —— 仅凭 lastByVendor 无法区分"真选过"和"默认回填"。
   * 调度任务默认模型的三级回退(getPersistedVendorModel 消费)只认这里标记过的
   * vendor,否则全新 / 没用过该 vendor 的用户会被对话侧 Opus 种子默认顶掉
   * 成本保守兜底。patchVendorPrefs 收到显式 model 时置 true;只改思考档 / Fast
   * 的会话回写走 patchVendorPrefsPreservingModelChoice：不得打标、不得清标，
   * 也不得在已打标后改写 lastByVendor.model / providerId / effort。
   */
  modelChosenByVendor: Partial<Record<MakerVendor, boolean>>;
  /**
   * 用户是否明确改过新任务的模型组合（Harness / 来源 / 模型 / 思考深度 / Fast）。
   * false 才允许连接态为新任务下放产品默认；目录热更与登录变化不得覆盖 true。
   */
  defaultTupleCustomized: boolean;
  /**
   * 自定义里是否包含 Harness / 来源 / 模型选择。与只调 effort / Fast 分开记，
   * 这样「恢复推荐」只能撤销调档意图，不会顺手清掉真正的路由选择。
   */
  defaultTupleSelectionCustomized: boolean;
}

/**
 * 种子默认偏好。模型 id **一律经 getDefaultModelForVendor 从目录推荐位取**,不在这里写死:
 * 这里曾写死 codex → 'gpt-5.4',与 modelDefinitions 里写死的 'gpt-5.5' 漂移成两个值,而两者
 * 在目录里都是默认隐藏的模型 —— 种子默认模型压根不在用户看到的清单里。
 */
function defaultVendorPrefs(vendor: MakerVendor): VendorPrefs {
  if (vendor === 'pi') {
    return {
      // pi 走 XD 网关(anthropic-messages 可达面),默认给网关中档模型;
      // 目录未含该 id 时由 ChatInput 的 vendor 回退逻辑纠正。
      model: 'claude-sonnet-5',
      effort: 'high',
      // 新 Pi 草稿默认走 Auto Review；完全访问只能由用户显式选择并持久化。
      permissionMode: 'auto',
      planMode: false,
      providerId: null,
    };
  }
  if (vendor === 'codex') {
    return {
      model: getDefaultModelForVendor('codex').id,
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

const DEFAULT_WORKTREE_ENABLED = false;

function makeDefault(): NewMakerDraft {
  return {
    vendor: 'cc',
    workingDir: null,
    remoteHostId: null,
    deviceLinkDeviceId: null,
    deviceLinkDeviceName: null,
    collab: defaultCollab(),
    worktreeEnabled: DEFAULT_WORKTREE_ENABLED,
    worktreePreferenceCustomized: false,
    fastModeByModel: {},
    effortByModel: {},
    extraDirs: [],
    writableDirs: [],
    lastByVendor: {
      cc: defaultVendorPrefs('cc'),
      pi: defaultVendorPrefs('pi'),
      orca: defaultVendorPrefs('orca'),
      codex: defaultVendorPrefs('codex'),
    },
    modelChosenByVendor: {},
    defaultTupleCustomized: false,
    defaultTupleSelectionCustomized: false,
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
  // 引擎白名单按 SELECTABLE_VENDORS(选择器同一张表的来源)校验 —— 新增引擎时这里零改动。
  // 曾经是逐个写死的三元(`r.vendor === 'codex' || r.vendor === 'pi' ? … : 'cc'`),
  // 每上线一个引擎都得手工补一次;漏补则用户选中新引擎、重启后被静默重置回 Claude。
  // F-COLLAB (2026-05): 'orca' 不在表内,历史 localStorage 残留会走同一条回退路径
  // 迁到 'cc'(它已被 ChatInput 底部的协同 toggle 取代),避免空白入口。
  const vendor: MakerVendor = isSelectableVendor(r.vendor) ? r.vendor : def.vendor;
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
  const writableDirs: string[] = [];
  // collab 校验: 老版本无此字段 → 默认 OFF + codex worker。
  const collabRaw = (r as { collab?: Partial<CollabDraft> }).collab;
  const collabWorker: CollabDraft['worker'] =
    collabRaw?.worker === 'cc' ? 'cc' : collabRaw?.worker === 'pi' ? 'pi' : 'codex';
  // remote 项目的协同 codex / cc draft 均放行:worker 创建已继承 remoteHostId
  // (在同一台远端主机 spawn,见 OrcaLeadSessionSnapshot.remoteHostId),两端
  // 远端 MCP 注入均已落地 (codex daemon config + cc per-query http 注入)。
  // 本地项目(remoteHostId==null)不受影响。
  const collabEnabled = collabRaw?.enabled === true;
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
      workerPermissionMode:
        wc.workerPermissionMode === 'bypassPermissions' ? 'bypassPermissions' : 'auto',
      // initialTask 是一次性任务,**故意不跨重启持久化**(同 deviceLinkDeviceId 先例):
      // 重启后 Send/New Goal 会静默把过期任务当 delegateTask 发出去,而收起态 pill
      // 无从看见/编辑(codex P2)。其余 Worker 配置(含 Team 默认权限)可耐久保留。
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
  for (const v of ['cc', 'orca', 'codex', 'pi'] as const) {
    if (modelChosenRaw[v] === true) modelChosenByVendor[v] = true;
  }
  // 老版本没有独立的组合标记：显式选过模型/来源/思考深度/Fast 都是足够强的
  // 用户意图证据。preserving 写回会保留完整 vendor 快照与空 marker,所以不能再用
  // 「只有 cc 单槽单字段」识别；cc 模型偏离当时同源的 seed 才是可保护的旧选择。
  // 反过来,仅 vendor=codex/pi 不能算用户选择:旧版会在 cc 不可用时由系统自动 fallback。
  const legacyCcPrefs = lastByVendorRaw.cc;
  // 已经随旧版完整草稿自然落盘过的 cc seed。它们不是用户选择，不能因为新版目录换了
  // seed 就反过来把系统快照认成自定义；这里只服务一次性迁移，不参与新会话默认决策。
  const legacyCcSeedModels = new Set([def.lastByVendor.cc.model, 'claude-sonnet-4-6']);
  const isKnownProductTuple = (slotVendor: MakerVendor, prefs: Partial<VendorPrefs>): boolean =>
    typeof prefs.providerId === 'string' &&
    prefs.providerId.length > 0 &&
    typeof prefs.model === 'string' &&
    prefs.model.length > 0 &&
    isKnownProductDefaultTupleIdentity({
      vendor: slotVendor,
      providerId: prefs.providerId,
      model: prefs.model,
    });
  const legacyCcModelCandidate =
    vendor === 'cc' &&
    legacyCcPrefs &&
    typeof legacyCcPrefs === 'object' &&
    typeof legacyCcPrefs.model === 'string' &&
    legacyCcPrefs.model.length > 0 &&
    !legacyCcSeedModels.has(legacyCcPrefs.model);
  const legacyCcModel =
    legacyCcModelCandidate &&
    (r.defaultTupleCustomized === undefined || !isKnownProductTuple('cc', legacyCcPrefs));
  const legacySourceSelection = (['cc', 'orca', 'codex', 'pi'] as const).some((slotVendor) => {
    const prefs = lastByVendorRaw[slotVendor];
    if (
      !prefs ||
      typeof prefs !== 'object' ||
      typeof prefs.providerId !== 'string' ||
      prefs.providerId.length === 0
    ) {
      return false;
    }
    // 老版本完全没有组合标记时，来源是唯一可用的显式证据；已有单一 boolean 的过渡
    // 版本则只排除产品策略能够自动写出的精确 tuple，保住“只换来源”的真实选择。
    return r.defaultTupleCustomized === undefined || !isKnownProductTuple(slotVendor, prefs);
  });
  const legacySelectionCustomized =
    Object.values(modelChosenByVendor).some(Boolean) || legacyCcModel || legacySourceSelection;
  const legacyTuningCustomized =
    Object.keys(effortByModel).length > 0 || Object.keys(fastModeByModel).length > 0;
  const defaultTupleSelectionCustomized =
    r.defaultTupleSelectionCustomized === true ||
    (r.defaultTupleSelectionCustomized === undefined &&
      r.defaultTupleCustomized !== false &&
      legacySelectionCustomized);
  const defaultTupleCustomized =
    r.defaultTupleCustomized === true ||
    defaultTupleSelectionCustomized ||
    (r.defaultTupleCustomized === undefined && legacyTuningCustomized);
  // 2026-07 已落盘但尚无显式标记的 true，只可能来自用户把当时默认 false 切到 true，
  // 可安全迁移为 override；旧 false 无法区分“默认快照”与“明确关闭”，按未自定义处理。
  const worktreePreferenceCustomized =
    (
      r.worktreePreferenceCustomized === true
      && typeof r.worktreeEnabled === 'boolean'
    )
    || (
      r.worktreePreferenceCustomized === undefined
      && r.worktreeEnabled === true
    );
  const worktreeEnabled = worktreePreferenceCustomized
    ? r.worktreeEnabled === true
    : DEFAULT_WORKTREE_ENABLED;
  return {
    vendor,
    workingDir,
    remoteHostId: workingDir == null ? null : remoteHostId,
    // device-link 目标**不跨重启恢复**:绑定的是活动设备,重启后可能已离线 → 一律置 null。
    deviceLinkDeviceId: null,
    deviceLinkDeviceName: null,
    collab,
    // worktree 勾选记忆:系统默认 + 显式 override 合成。注意历史残留的
    // wtEnabled/wtName/wtSourceBranch/wtBaseRepo 根字段(2026-07 前的短暂持久化实验)
    // 仍被忽略丢弃——本字段是新契约,不做旧值迁移(不猜测用户意图)。
    worktreeEnabled,
    worktreePreferenceCustomized,
    fastModeByModel,
    effortByModel,
    extraDirs,
    writableDirs,
    lastByVendor: {
      cc: sanitizeVendorPrefs(lastByVendorRaw.cc, 'cc'),
      pi: sanitizeVendorPrefs(lastByVendorRaw.pi, 'pi'),
      orca: sanitizeVendorPrefs(lastByVendorRaw.orca, 'orca'),
      codex: sanitizeVendorPrefs(lastByVendorRaw.codex, 'codex'),
    },
    modelChosenByVendor,
    defaultTupleCustomized,
    defaultTupleSelectionCustomized,
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
type StoredDraftRecord = Record<string, unknown>;

function parseStoredDraftRecord(raw: string | null): StoredDraftRecord | undefined {
  if (raw == null) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as StoredDraftRecord;
  } catch {
    return undefined;
  }
}

interface StoredWorktreePreference {
  worktreeEnabled: boolean;
  worktreePreferenceCustomized: boolean;
}

type StoredDefaultTuplePreference = Pick<
  NewMakerDraft,
  | 'vendor'
  | 'fastModeByModel'
  | 'effortByModel'
  | 'lastByVendor'
  | 'modelChosenByVendor'
  | 'defaultTupleCustomized'
  | 'defaultTupleSelectionCustomized'
>;

function defaultTuplePreferenceOf(draft: NewMakerDraft): StoredDefaultTuplePreference {
  return {
    vendor: draft.vendor,
    fastModeByModel: draft.fastModeByModel,
    effortByModel: draft.effortByModel,
    lastByVendor: draft.lastByVendor,
    modelChosenByVendor: draft.modelChosenByVendor,
    defaultTupleCustomized: draft.defaultTupleCustomized,
    defaultTupleSelectionCustomized: draft.defaultTupleSelectionCustomized,
  };
}

function parseStoredWorktreePreference(
  raw: string | null,
): StoredWorktreePreference | undefined {
  const parsed = parseStoredDraftRecord(raw);
  if (
    !parsed
    || (
      !('worktreeEnabled' in parsed)
      && !('worktreePreferenceCustomized' in parsed)
    )
  ) {
    return undefined;
  }
  const sanitized = sanitize(parsed);
  return {
    worktreeEnabled: sanitized.worktreeEnabled,
    worktreePreferenceCustomized: sanitized.worktreePreferenceCustomized,
  };
}

function parseStoredDefaultTuplePreference(
  raw: string | null,
): StoredDefaultTuplePreference | undefined {
  const parsed = parseStoredDraftRecord(raw);
  if (!parsed) return undefined;
  return defaultTuplePreferenceOf(sanitize(parsed));
}

function readStoredDraftRecord(): StoredDraftRecord | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return parseStoredDraftRecord(window.localStorage.getItem(storageKey()));
  } catch {
    return undefined;
  }
}

function readStoredWorktreePreference(): StoredWorktreePreference | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return parseStoredWorktreePreference(window.localStorage.getItem(storageKey()));
  } catch {
    return undefined;
  }
}

function readStoredDefaultTuplePreference(): StoredDefaultTuplePreference | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return parseStoredDefaultTuplePreference(window.localStorage.getItem(storageKey()));
  } catch {
    return undefined;
  }
}

function hasSameDefaultTuplePreference(
  left: StoredDefaultTuplePreference,
  right: StoredDefaultTuplePreference,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

type PreferenceSyncFallback = 'full-draft' | 'worktree-only' | null;
let preferenceSyncFallback: PreferenceSyncFallback = null;

/**
 * 显式 tuple 操作先采用跨窗口持久真相，再只施加自己的字段变更。
 * 这样既不会带着旧整表复活已恢复的 override，也不会吞掉本窗口刚发生的真实选模意图。
 */
function rebaseStoredDefaultTuplePreference(): void {
  const stored = readStoredDefaultTuplePreference();
  if (
    stored !== undefined &&
    !hasSameDefaultTuplePreference(stored, defaultTuplePreferenceOf(currentDraft))
  ) {
    currentDraft = { ...currentDraft, ...stored };
    // 等价于 storage event 已到达：即使后续显式操作因同值短路，订阅者也必须看到这次收敛。
    emit();
  }
}

/**
 * Persist a complete draft snapshot without letting another renderer's stale in-memory copy
 * overwrite workstation-wide worktree or user-customized default-tuple preferences.
 *
 * Electron windows do not share this module instance. A storage event normally refreshes the
 * other windows below, but that event is asynchronous; rebasing shared preferences at write
 * time also closes the race where a secondary/sidebar window mutates another draft field before
 * it has received the event.
 */
function scheduleWrite(
  options: {
    preserveStoredWorktreePreference?: boolean;
    preserveStoredDefaultTuplePreference?: boolean;
  } = {},
): void {
  if (typeof window === 'undefined') return;
  const storedWorktreePreference = options.preserveStoredWorktreePreference !== false
    ? readStoredWorktreePreference()
    : undefined;
  if (
    storedWorktreePreference !== undefined &&
    (
      storedWorktreePreference.worktreeEnabled !== currentDraft.worktreeEnabled
      || storedWorktreePreference.worktreePreferenceCustomized
        !== currentDraft.worktreePreferenceCustomized
    )
  ) {
    currentDraft = { ...currentDraft, ...storedWorktreePreference };
  }
  const storedDefaultTuplePreference =
    options.preserveStoredDefaultTuplePreference !== false
      ? readStoredDefaultTuplePreference()
      : undefined;
  // 无关字段写入必须无条件采用最新完整 tuple，方向不能只保护 false → true：恢复推荐刚把
  // true 清成 false 后，旧窗口的 workdir/collab 写入同样不能把旧 tuple/true 整体复活。
  // 显式 tuple 操作已在变更前调用 rebaseStoredDefaultTuplePreference，再通过 option 跳过此处。
  if (
    storedDefaultTuplePreference !== undefined &&
    !hasSameDefaultTuplePreference(
      storedDefaultTuplePreference,
      defaultTuplePreferenceOf(currentDraft),
    )
  ) {
    currentDraft = { ...currentDraft, ...storedDefaultTuplePreference };
  }
  try {
    window.localStorage.setItem(storageKey(), JSON.stringify(currentDraft));
    preferenceSyncFallback = null;
  } catch {
    // localStorage 满 / 私密窗口禁写——忽略,不影响内存状态。
    preferenceSyncFallback = 'full-draft';
  }
}

let currentDraft: NewMakerDraft = loadFromStorage();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

const removeStorageListener = (() => {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return null;
  const onStorage = (event: StorageEvent) => {
    if (event.key !== storageKey()) return;
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    // A queued storage event can arrive after this window has already written a newer value.
    // Re-read the shared storage truth first so the event payload itself cannot roll state back.
    const liveWorktreePreference = readStoredWorktreePreference();
    const nextWorktreePreference =
      liveWorktreePreference ??
      (
        event.newValue == null
          ? {
              worktreeEnabled: DEFAULT_WORKTREE_ENABLED,
              worktreePreferenceCustomized: false,
            }
          : parseStoredWorktreePreference(event.newValue)
      );
    const liveDefaultTuplePreference = readStoredDefaultTuplePreference();
    const nextDefaultTuplePreference =
      liveDefaultTuplePreference ??
      (
        event.newValue == null
          ? defaultTuplePreferenceOf(makeDefault())
          : parseStoredDefaultTuplePreference(event.newValue)
      );
    const worktreeChanged =
      nextWorktreePreference !== undefined
      && (
        nextWorktreePreference.worktreeEnabled !== currentDraft.worktreeEnabled
        || nextWorktreePreference.worktreePreferenceCustomized
          !== currentDraft.worktreePreferenceCustomized
      );
    const defaultTupleChanged =
      nextDefaultTuplePreference !== undefined
      && !hasSameDefaultTuplePreference(
        nextDefaultTuplePreference,
        defaultTuplePreferenceOf(currentDraft),
      );
    if (!worktreeChanged && !defaultTupleChanged) return;
    // 只有工作端级偏好跨窗口同步；deviceLinkDeviceId / extraDirs 等单窗口临时目标保持不动。
    currentDraft = {
      ...currentDraft,
      ...(worktreeChanged ? nextWorktreePreference : {}),
      ...(defaultTupleChanged ? nextDefaultTuplePreference : {}),
    };
    emit();
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
})();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    removeStorageListener?.();
  });
}

export function getDraft(): NewMakerDraft {
  return currentDraft;
}

/**
 * App 向 main 镜像偏好时读取的共享快照。
 *
 * 每个 Electron 窗口都有独立 currentDraft；跨窗口事件触发 emit 后，直接读本窗口内存会把
 * 旧 model / workingDir 等字段覆盖进 main 缓存。localStorage 是这些持久偏好的跨窗口真相，
 * 因此同步时优先读并 sanitize 它；完整草稿落盘失败才回退整份内存，单字段 worktree 写失败
 * 只覆盖该布尔，避免失败路径重新带回其它旧字段。
 */
export function getDraftForPreferenceSync(): NewMakerDraft {
  const stored = readStoredDraftRecord();
  if (!stored || preferenceSyncFallback === 'full-draft') return currentDraft;
  const persistedDraft = sanitize(stored);
  return preferenceSyncFallback === 'worktree-only'
    ? {
        ...persistedDraft,
        worktreeEnabled: currentDraft.worktreeEnabled,
        worktreePreferenceCustomized: currentDraft.worktreePreferenceCustomized,
      }
    : persistedDraft;
}

/** Switch the persistent draft namespace together with the active data owner. */
export function setNewMakerDraftOwner(ownerId: string | null): void {
  const normalized = typeof ownerId === 'string' && ownerId.trim().length > 0 ? ownerId : null;
  if (activeDataOwnerId === normalized) return;
  activeDataOwnerId = normalized;
  currentDraft = loadFromStorage();
  preferenceSyncFallback = null;
  emit();
}

/**
 * 按字段更新工作端级 worktree 偏好。
 *
 * main 会把远程写穿广播给所有 renderer。这里必须从共享 localStorage 的最新对象合并目标
 * 字段，而不能让每个窗口用各自完整 currentDraft 回写；否则最后响应的旧窗口会回滚其它偏好。
 * 当前窗口内存也只更新该字段，保留 device-link / extraDirs 等窗口内临时草稿。
 */
export function setWorktreePreference(enabled: boolean): void {
  const worktreeEnabled = enabled === true;
  const worktreePreferenceCustomized = true;
  if (typeof window !== 'undefined') {
    const stored = readStoredDraftRecord();
    const base = stored ?? currentDraft;
    if (
      stored?.worktreeEnabled !== worktreeEnabled
      || stored?.worktreePreferenceCustomized !== worktreePreferenceCustomized
    ) {
      try {
        window.localStorage.setItem(
          storageKey(),
          JSON.stringify({
            ...base,
            worktreeEnabled,
            worktreePreferenceCustomized,
          }),
        );
        preferenceSyncFallback = null;
      } catch {
        // 单字段落盘失败时仅让 main 从本窗口内存取 worktree 布尔；其它偏好继续使用共享
        // 持久快照，避免旧窗口借失败兜底重新带回整份旧草稿。
        preferenceSyncFallback = 'worktree-only';
      }
    } else {
      preferenceSyncFallback = null;
    }
  }
  currentDraft = {
    ...currentDraft,
    worktreeEnabled,
    worktreePreferenceCustomized,
  };
  emit();
}

export function patchDraft(patch: Partial<NewMakerDraft>): void {
  const normalizedPatch: Partial<NewMakerDraft> = { ...patch };
  // worktree 偏好只能经 setWorktreePreference 写入。把这条约束放在 store 边界，
  // 避免项目切换、草稿恢复或未来的通用 patch 调用方绕过「仅 checkbox 修改」契约。
  delete normalizedPatch.worktreeEnabled;
  delete normalizedPatch.worktreePreferenceCustomized;
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
  // 换目标设备(含本机 ↔ 被控设备、被控设备 A ↔ B)→ 丢掉 Worker 富配置,只留
  // enabled + worker。model / providerId / effort / fast 都是**设备作用域**的:被控端
  // 装的模型目录、连的供应商都是它自己那一套,原样透传过去会撞被控端 main 的精确
  // preflight(INVALID_PARAMS / PROVIDER_ROUTE_UNAVAILABLE),协同静默降级成单会话 ——
  // 正是 issue #1170 抱怨的「入口能点但走不完」。清掉后由被控端按自己的默认值起
  // Worker,与草稿里模型 pill 换设备重新校准的既有行为一致。
  //
  // 放在 store 层而不是 applyDraftTarget:换设备有四条路径(设备 pill、设备域浏览器、
  // 工作区 picker、所选设备失效后的自动回落),挂在这里全部自动覆盖,新增第五条也不用
  // 再对齐一格(与 NewMakerDraftRoute.applyDraftTarget 的「按什么变了而不是走了哪条
  // 路径」同一思路)。
  if (currentDraft.deviceLinkDeviceId !== next.deviceLinkDeviceId && next.collab.workerConfig) {
    next.collab = { ...next.collab, workerConfig: undefined };
  }
  // 协同与项目/对话形态正交,切 workingDir 不再改 enabled。device-link 与 SSH 的 Worker
  // 创建和团队读写都在对应执行端完成;Worker 子会话不能嵌套协同,由会话侧入口判定兜住。
  currentDraft = next;
  scheduleWrite({ preserveStoredWorktreePreference: true });
  emit();
}

/**
 * 把草稿的「这次要跑在哪」复位成干净的本机对话态。
 *
 * workingDir=null 经 patchDraft 级联清掉 remoteHostId / deviceLink*;extraDirs 与
 * collab.enabled 是本次草稿的一次性选择,这里显式清掉。vendor / lastByVendor /
 * fastModeByModel 等模型偏好保持不变(那是「我常用哪个」的记忆,与「这次跑在哪」正交)。
 *
 * **任何「另起一段干净对话」的入口都必须走这里,不要各自手写字段清单。**
 * extraDirs 是单次草稿的**目录读取授权**,漏掉它会让新会话悄悄继承对无关本地目录的
 * 访问权(#1103 review 实例:两个预填入口都手写了清单,把级联已经处理的三个字段
 * 抄了一遍,却都漏了真正需要清的这一个)。新增工作区字段时只改这一处。
 */
export function resetDraftWorkspaceTargets(): void {
  patchDraft({
    workingDir: null,
    extraDirs: [],
    writableDirs: [],
    collab: { ...currentDraft.collab, enabled: false },
  });
}

/** 单字段写入 collab(便捷 setter,语义比 patchDraft({ collab: ... }) 更直接)。 */
export function patchCollab(patch: Partial<CollabDraft>): void {
  patchDraft({ collab: { ...currentDraft.collab, ...patch } });
}

/**
 * 切 vendor 的便捷入口:
 *   1. 保留当前 vendor 已同步进草稿的 (model/effort/permissionMode)
 *   2. 切到新 vendor
 * NewMakerDraftRoute 的 VendorSegmentedSwitcher 切换时调本函数;切回某 vendor 时 ChatInput 通过 lastByVendor[vendor] 取上次值。
 */
export function switchVendor(next: MakerVendor): void {
  rebaseStoredDefaultTuplePreference();
  if (currentDraft.vendor === next) return;
  currentDraft = {
    ...currentDraft,
    vendor: next,
  };
  scheduleWrite({ preserveStoredDefaultTuplePreference: false });
  emit();
}

/**
 * 当前草稿 Harness 不可用时按系统顺序回退。
 *
 * 必须在调用瞬间读取模块级 currentDraft:产品默认 effect 可能刚把 cc 改成 Pi,若这里继续
 * 使用 React 上一轮 closure 的 cc/currentPrefs,会把 xAI→Pi 又覆盖成 Codex。系统回退不标记
 * defaultTupleCustomized,因为它不是用户选择。
 */
export function fallbackUnavailableVendor(availableVendors: ReadonlySet<MakerVendor>): boolean {
  rebaseStoredDefaultTuplePreference();
  const currentVendor = currentDraft.vendor;
  if (availableVendors.has(currentVendor)) return false;
  const fallback = (['cc', 'codex', 'pi'] as const).find((vendor) =>
    availableVendors.has(vendor),
  );
  if (!fallback) return false;
  switchVendor(fallback);
  return true;
}

export interface SuggestedDefaultTuple {
  vendor: Extract<MakerVendor, 'cc' | 'codex' | 'pi'>;
  providerId: string;
  model: string;
  effort?: Effort | null;
}

/** 原子应用产品默认；只改未自定义草稿，不把默认伪装成用户显式选模。 */
export function applySuggestedDefaultTuple(tuple: SuggestedDefaultTuple): boolean {
  rebaseStoredDefaultTuplePreference();
  if (currentDraft.defaultTupleCustomized) return false;
  const previous = currentDraft.lastByVendor[tuple.vendor];
  const nextPrefs: VendorPrefs = {
    ...previous,
    model: tuple.model,
    providerId: tuple.providerId,
    ...(tuple.effort ? { effort: tuple.effort } : {}),
  };
  if (
    currentDraft.vendor === tuple.vendor &&
    previous.model === nextPrefs.model &&
    previous.providerId === nextPrefs.providerId &&
    previous.effort === nextPrefs.effort
  ) {
    return false;
  }
  currentDraft = {
    ...currentDraft,
    vendor: tuple.vendor,
    lastByVendor: { ...currentDraft.lastByVendor, [tuple.vendor]: nextPrefs },
  };
  scheduleWrite({ preserveStoredDefaultTuplePreference: false });
  emit();
  return true;
}

/** 用户开始调整默认组合后立刻封住后续自动下放。 */
export function markDefaultTupleCustomized(selectionCustomized = true): void {
  rebaseStoredDefaultTuplePreference();
  if (
    currentDraft.defaultTupleCustomized &&
    (!selectionCustomized || currentDraft.defaultTupleSelectionCustomized)
  ) {
    return;
  }
  currentDraft = {
    ...currentDraft,
    defaultTupleCustomized: true,
    defaultTupleSelectionCustomized:
      currentDraft.defaultTupleSelectionCustomized || selectionCustomized,
  };
  scheduleWrite({ preserveStoredDefaultTuplePreference: false });
  emit();
}

/**
 * 「恢复推荐」删除当前模型的旧草稿调档，并在所有 override 都已清空时撤销组合封锁。
 *
 * providerModelMemory / modelEnginePrefs 是独立 store，由调用方先删当前项、再把同步重读后的
 * 汇总结果传进来。草稿内仍需在同一次写入里删除 legacy effort / Fast 键；否则 marker 虽清，
 * 重启后残留记忆仍会把旧档顶回来。任一模型选择、其它模型调档或外部 override 仍存在时，
 * defaultTupleCustomized 必须继续保护用户意图。
 */
export function clearDefaultTupleTuningCustomization(args: {
  modelId: string;
  hasExternalOverrides: boolean;
}): void {
  rebaseStoredDefaultTuplePreference();
  const nextEffortByModel = { ...currentDraft.effortByModel };
  const nextFastModeByModel = { ...currentDraft.fastModeByModel };
  const hadEffortOverride = args.modelId in nextEffortByModel;
  const hadFastOverride = args.modelId in nextFastModeByModel;
  delete nextEffortByModel[args.modelId];
  delete nextFastModeByModel[args.modelId];

  const hasSelectionOverride =
    currentDraft.defaultTupleSelectionCustomized ||
    Object.values(currentDraft.modelChosenByVendor).some(Boolean);
  const hasRemainingDraftTuning =
    Object.keys(nextEffortByModel).length > 0 || Object.keys(nextFastModeByModel).length > 0;
  const shouldUnlock =
    currentDraft.defaultTupleCustomized &&
    !hasSelectionOverride &&
    !hasRemainingDraftTuning &&
    !args.hasExternalOverrides;
  if (!hadEffortOverride && !hadFastOverride && !shouldUnlock) return;

  currentDraft = {
    ...currentDraft,
    effortByModel: nextEffortByModel,
    fastModeByModel: nextFastModeByModel,
    ...(shouldUnlock ? { defaultTupleCustomized: false } : {}),
  };
  scheduleWrite({ preserveStoredDefaultTuplePreference: false });
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
  rebaseStoredDefaultTuplePreference();
  const marksSelection = opts.markModelChoice && ('model' in patch || 'providerId' in patch);
  const marksDefaultTuple = marksSelection || (opts.markModelChoice && 'effort' in patch);
  const modelChosen = { ...currentDraft.modelChosenByVendor };
  const nextPatch = { ...patch };
  if (typeof nextPatch.model === 'string' && nextPatch.model.length > 0) {
    if (opts.markModelChoice) {
      // 新建页 picker 或已有任务换模 → 打标记,下次新建跟随这次选择,不再回落区域默认。
      modelChosen[vendor] = true;
    }
    // markModelChoice=false 仍可写回当前活动模型(远程草稿 / 旧控制端 wire
    // 会带 modelId),但不得打标,也不得清掉已有标记。
  }
  if (!opts.markModelChoice && modelChosen[vendor] === true) {
    const savedModel = currentDraft.lastByVendor[vendor].model;
    const incomingModel =
      typeof nextPatch.model === 'string' && nextPatch.model.length > 0
        ? nextPatch.model
        : savedModel;
    // 已显式选过时,不得替换那次选择的模型或来源。没带 model 视为仍在已保存
    // 模型上改档;带了不同 model 则丢掉这次 effort,避免 A/B 错配。
    delete nextPatch.model;
    delete nextPatch.providerId;
    if (incomingModel !== savedModel) {
      delete nextPatch.effort;
    }
  }
  currentDraft = {
    ...currentDraft,
    defaultTupleCustomized: currentDraft.defaultTupleCustomized || marksDefaultTuple,
    defaultTupleSelectionCustomized:
      currentDraft.defaultTupleSelectionCustomized || marksSelection,
    modelChosenByVendor: modelChosen,
    lastByVendor: {
      ...currentDraft.lastByVendor,
      [vendor]: { ...currentDraft.lastByVendor[vendor], ...nextPatch },
    },
  };
  scheduleWrite({ preserveStoredDefaultTuplePreference: false });
  emit();
}

export function patchVendorPrefs(vendor: MakerVendor, patch: Partial<VendorPrefs>): void {
  patchVendorPrefsInternal(vendor, patch, { markModelChoice: true });
}

/**
 * 已创建任务把思考档、以及 wire 上的当前活动模型同步回新建草稿时使用。
 * 未打标时可以更新 lastByVendor.model / providerId / effort,方便远程草稿 /
 * 旧控制端把活动值写回,但不把这次当成显式选模。已打标后不得替换那次选择的
 * 模型、来源或思考档;只有活动模型与已保存模型一致时才更新 effort。
 * 本机已有任务里换模型应走 patchVendorPrefs。
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
  rebaseStoredDefaultTuplePreference();
  // 同值短路,避免无意义的 emit / write。
  if (currentDraft.effortByModel[modelId] === effort) return;
  currentDraft = {
    ...currentDraft,
    effortByModel: {
      ...currentDraft.effortByModel,
      [modelId]: effort,
    },
  };
  scheduleWrite({ preserveStoredDefaultTuplePreference: false });
  emit();
}

export function getFastModeForModel(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  return currentDraft.fastModeByModel[modelId] === true;
}

export function setFastModeForModel(modelId: string, enabled: boolean): void {
  if (!modelId) return;
  rebaseStoredDefaultTuplePreference();
  currentDraft = {
    ...currentDraft,
    fastModeByModel: {
      ...currentDraft.fastModeByModel,
      [modelId]: enabled,
    },
  };
  scheduleWrite({ preserveStoredDefaultTuplePreference: false });
  emit();
}

export function clearDraft(): void {
  currentDraft = makeDefault();
  scheduleWrite({
    preserveStoredWorktreePreference: false,
    preserveStoredDefaultTuplePreference: false,
  });
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
 * 所以这里要求 modelChosenByVendor[vendor] === true(新建页 picker 或已有
 * 任务换模经 patchVendorPrefs 打的标)才返回,否则一律 ''。
 * 调度任务的默认模型三级回退(useScheduleForm getScheduleDefaultModel)依赖这个
 * 区分:没显式选过的用户应落到调度自己的成本保守兜底(Sonnet),而不是被
 * 对话侧的 Opus 种子默认顶掉。读 raw localStorage 而非 getDraft(),解析失败 → ''。
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
