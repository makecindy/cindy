/**
 * newSessionWorktree.ts —— 新建会话页 worktree 开关与两步建会话的纯决策逻辑。
 * ---------------------------------------------------------------------------
 * 手机复刻桌面控制端远程流程(NewMakerDraftRoute):远程没有「改已建会话 workingDir」
 * 的通道,顺序必须反过来 —— 先同步等工作端 `worktree:create` 建好 worktree 拿路径,
 * 再以该路径 + 同一预生成 sessionId 走 createSession(两步共用 sessionId,工作端
 * close-session 时才能按 worktreeStore 绑定回收 worktree)。
 *
 * 本模块只做纯决策和可注入的小编排,不直接依赖 React 与 transport 实例,
 * 便于 vitest 直接覆盖;接线在 app/sessions/new.tsx。
 */
import type {
  MobileNewMakerDefaults,
  MobileWorktreeBranchPreferenceSnapshot,
  MobileWorktreeCreateResult,
  MobileWorktreeDetectCwdResult,
} from '@/device-link/mobileMakerTransport';
import { isTransientRemoteError } from '@/device-link/remoteRetry';

/** 资格不满足的原因(语义对齐桌面 newChat.worktree.{gitMissing,notGitRepo,alreadyInWorktree})。 */
export type NewSessionWorktreeIneligibleReason =
  | 'gitMissing'
  | 'notGitRepo'
  | 'alreadyInWorktree';

/**
 * worktree 开关的资格状态:
 *  - probing:探测中(目录/设备刚变化,结果未回)→ 开关禁用 + 「检测环境中…」;
 *  - recovering:瞬时断连/超时，页面会自动重试 → 开关禁用 + 恢复连接 caption;
 *  - eligible:可用,携带 create 所需的 baseRepo(repoRoot)与 sourceBranch(当前分支);
 *  - ineligible:环境不满足 → 开关禁用 + 原因 caption;
 *  - unsupported:老被控端缺安全 worktree 能力；OFF 时隐藏，旧 ON 镜像保留关闭入口;
 *  - detect-failed:探测失败(断连/超时等非通道原因)→ 开关禁用 + 失败 caption。
 */
export type NewSessionWorktreeEligibility =
  | { status: 'probing' }
  | { status: 'recovering' }
  | { status: 'eligible'; baseRepo: string; sourceBranch: string }
  | { status: 'ineligible'; reason: NewSessionWorktreeIneligibleReason }
  | { status: 'unsupported' }
  | { status: 'detect-failed' };

export interface NewSessionWorktreeBranchTarget {
  deviceId: string;
  workingDir: string;
}

export interface NewSessionWorktreeProbeTarget extends NewSessionWorktreeBranchTarget {
  /** 设备连接/在线存在变化时递增；同目录旧探测结果不能跨 generation 复用。 */
  probeGeneration: string;
}

/** 探测结果与发起时的设备/目录绑定，防切换目标后的首帧误用上一仓库结果。 */
export interface NewSessionWorktreeProbeSnapshot {
  target: NewSessionWorktreeProbeTarget;
  eligibility: NewSessionWorktreeEligibility;
  /** Raw host capability, independent from the current cwd's eligibility. */
  supportsRecoveryKeyDiscard?: boolean;
}

/** 用户显式选择的源分支只属于发起选择时的设备 + 工作目录，不得跨目标复用。 */
export interface NewSessionWorktreeBranchSelectionSnapshot {
  target: NewSessionWorktreeBranchTarget;
  sourceBranch: string;
}

/** list-branches 回包只有请求序号与设备/cwd 都仍是最新目标时才允许落 state。 */
export function shouldAcceptWorktreeBranchListResult(input: {
  requestSeq: number;
  latestSeq: number;
  requestTarget: NewSessionWorktreeBranchTarget;
  latestTarget: NewSessionWorktreeBranchTarget;
}): boolean {
  return input.requestSeq === input.latestSeq
    && input.requestTarget.deviceId === input.latestTarget.deviceId
    && input.requestTarget.workingDir.trim() === input.latestTarget.workingDir.trim();
}

/**
 * 只向当前选择与连接代次暴露同 target 的结果。React effect 要到 commit 后才会把 state
 * 重置为 probing；render 阶段先做这道同步 fence，用户切项目/设备或同目标重连后立即创建
 * 也不会拿旧资格。
 */
export function worktreeEligibilityForTarget(
  snapshot: NewSessionWorktreeProbeSnapshot | null,
  target: NewSessionWorktreeProbeTarget,
): NewSessionWorktreeEligibility {
  if (
    !snapshot
    || snapshot.target.deviceId !== target.deviceId
    || snapshot.target.workingDir.trim() !== target.workingDir.trim()
    || snapshot.target.probeGeneration !== target.probeGeneration
  ) {
    return { status: 'probing' };
  }
  return snapshot.eligibility;
}

/**
 * 读取当前目标真正应展示 / 创建所用的源分支：同目标的显式选择优先，否则回落
 * detect-cwd 的当前分支。target fence 与 eligibility fence 双保险，切设备或项目后的
 * 同步 render 绝不会把上一仓库的同名/异名分支带过去。
 */
export function worktreeSourceBranchForTarget(
  snapshot: NewSessionWorktreeBranchSelectionSnapshot | null,
  target: NewSessionWorktreeBranchTarget,
  eligibility: NewSessionWorktreeEligibility,
): string {
  if (
    snapshot
    && snapshot.target.deviceId === target.deviceId
    && snapshot.target.workingDir.trim() === target.workingDir.trim()
    && snapshot.sourceBranch.trim()
  ) {
    return snapshot.sourceBranch.trim();
  }
  return eligibility.status === 'eligible'
    ? eligibility.sourceBranch.trim() || 'HEAD'
    : 'HEAD';
}

/**
 * Host 的 repo-scoped branch preference 是创建时的权威值。只有形状完整、repo 与
 * 当前 target-fenced eligibility 一致的快照才可覆盖 detect-cwd 的当前分支；这样
 * GET(null)、重连清缓存或畸形回包都不会继续沿用组件里上一帧的 selection。
 */
export function worktreeSourceBranchFromPreference(
  snapshot: MobileWorktreeBranchPreferenceSnapshot | null,
  eligibility: NewSessionWorktreeEligibility,
): string {
  if (
    eligibility.status === 'eligible'
    && isValidWorktreeBranchPreferenceSnapshot(snapshot, eligibility.baseRepo)
  ) {
    return snapshot.sourceBranch.trim();
  }
  return eligibility.status === 'eligible'
    ? eligibility.sourceBranch.trim() || 'HEAD'
    : 'HEAD';
}

/** Runtime guard for untrusted Device Link responses. */
export function isValidWorktreeBranchPreferenceSnapshot(
  snapshot: unknown,
  expectedBaseRepo: string,
): snapshot is MobileWorktreeBranchPreferenceSnapshot {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const candidate = snapshot as Partial<MobileWorktreeBranchPreferenceSnapshot>;
  return typeof candidate.baseRepo === 'string'
    && candidate.baseRepo.trim() === expectedBaseRepo.trim()
    && typeof candidate.sourceBranch === 'string'
    && candidate.sourceBranch.trim().length > 0
    && typeof candidate.revision === 'number'
    && Number.isInteger(candidate.revision)
    && candidate.revision >= 0;
}

/**
 * Recovery 在任何破坏性 discard 前必须精确确认 session 未认领。transport 的
 * timeout/offline/未知错误原样抛给 recoverer，让它保留 ledger 并稍后重试；绝不能
 * 把“暂时查不到”降级成 false 后删除可能已被活跃 session 使用的 worktree。
 */
export async function isExactRemoteSessionClaimed(
  sessionId: string,
  getSession: (sessionId: string) => Promise<unknown>,
): Promise<boolean> {
  try {
    const session = await getSession(sessionId);
    if (
      !session
      || typeof session !== 'object'
      || Array.isArray(session)
      || (session as { id?: unknown }).id !== sessionId
    ) {
      throw new Error('Invalid remote session ownership response');
    }
    return true;
  } catch (error) {
    if (isExplicitRemoteNotFoundError(error)) return false;
    throw error;
  }
}

/**
 * Only an exact structured code, or the anchored Electron IPC error prefix,
 * proves absence. Incidental text containing NOT_FOUND remains unknown.
 */
export function isExplicitRemoteNotFoundError(error: unknown): boolean {
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim().toUpperCase() === 'NOT_FOUND') {
      return true;
    }
  }
  if (!(error instanceof Error)) return false;
  return /^(?:\[NOT_FOUND\]|Error invoking remote method(?: '[^']+')?: Error: \[NOT_FOUND\])(?:\s|$)/
    .test(error.message);
}

/**
 * 把工作端 detect-cwd 回包归并为资格状态。远程恢复能力先于目录资格：缺少
 * recoveryKey discard 的旧端无论目录如何都不能进入远程两步创建；新版端再按
 * gitInstalled → isGitRepo → isInsideWorktree 逐项短路。
 * baseRepo 取 repoRoot(工作端 git rev-parse --show-toplevel),缺失回落 workingDir;
 * sourceBranch 先取当前分支，作为移动端分支选择器尚未显式选择时的默认值；
 * detached HEAD 时 currentBranch 缺失，必须回落 'HEAD' 才能从当前 commit 派生；
 * 不能猜 main（仓库未必有 main，也不能静默偏离当前 checkout）。
 *
 * recoveryKey discard 能力也是资格的一部分：旧 Desktop 可能接受 recoveryKey
 * 字段却不持久化，create 回包丢失后无法恢复。新端通过 detect-cwd 显式返回 true；
 * 旧端省略该字段时必须在任何 worktree:create 副作用前 fail closed。
 */
export function resolveWorktreeEligibility(
  result: MobileWorktreeDetectCwdResult,
  workingDir: string,
): NewSessionWorktreeEligibility {
  if (result.supportsRecoveryKeyDiscard !== true) return { status: 'unsupported' };
  if (!result.gitInstalled) return { status: 'ineligible', reason: 'gitMissing' };
  if (!result.isGitRepo) return { status: 'ineligible', reason: 'notGitRepo' };
  if (result.isInsideWorktree) return { status: 'ineligible', reason: 'alreadyInWorktree' };
  return {
    status: 'eligible',
    baseRepo: result.repoRoot?.trim() || workingDir,
    sourceBranch: result.currentBranch?.trim() || 'HEAD',
  };
}

/**
 * detect-cwd 抛错的归并:老被控端 CHANNEL_NOT_ALLOWED → unsupported；断连/超时
 * → recovering(页面自动重试);其余未知错误
 * → detect-failed(行保留、开关禁用)。
 *
 * 真实 wire 形状:被控端 dispatch 回 { code:'CHANNEL_NOT_ALLOWED', message:"channel
 * 'worktree:detect-cwd' not allowed remotely" },移动端 unwrapInvoke 抛
 * DeviceLinkError(code, message)——code 只在 .code 字段,message 里**不含**该字面量,
 * 所以必须先读结构化 code(对齐 sessionReferences 既有惯例),message 匹配只作
 * 字符串错误的兜底;同时容忍 relay 包装的 DEVICE_LINK_CHANNEL_NOT_ALLOWED 变体。
 */
export function worktreeEligibilityFromError(error: unknown): NewSessionWorktreeEligibility {
  if (isWorktreeChannelNotAllowedError(error)) return { status: 'unsupported' };
  // DEVICE_UNRESPONSIVE 是本机熔断器为了阻止原地重试风暴而产出的快速失败，
  // 对页面生命周期仍是可恢复状态：Context 的代表性探测会自动关熔断，本页定时
  // 重探即可，不能把它固化成“目录环境错误”。
  if (remoteErrorText(error).includes('DEVICE_UNRESPONSIVE')) return { status: 'recovering' };
  if (isTransientRemoteError(error)) return { status: 'recovering' };
  return { status: 'detect-failed' };
}

/**
 * 读取工作端 get-new-maker-defaults 的明确偏好。缺字段/形状异常返回 null，
 * 由控制端保留当前镜像；全新设备的镜像自身默认未勾选。
 */
export function seedWorktreeEnabled(
  defaults: MobileNewMakerDefaults | null | undefined,
): boolean | null {
  return typeof defaults?.worktreeEnabled === 'boolean'
    ? defaults.worktreeEnabled
    : null;
}

export type WorktreePreferenceSeedClassification =
  | { status: 'ready'; enabled: boolean }
  | { status: 'missing' }
  | { status: 'invalid' };

/**
 * A populated current host exposes an explicit boolean. An absent field is
 * ambiguous: it can be an old host or a current host whose renderer-backed
 * defaults cache has not arrived yet. Callers combine `missing` with the
 * independently probed recovery capability; malformed values remain invalid.
 */
export function classifyWorktreePreferenceSeed(
  defaults: unknown,
): WorktreePreferenceSeedClassification {
  if (defaults === null || defaults === undefined) return { status: 'invalid' };
  if (typeof defaults !== 'object') return { status: 'invalid' };
  if (!Object.prototype.hasOwnProperty.call(defaults, 'worktreeEnabled')) {
    return { status: 'missing' };
  }
  const enabled = (defaults as { worktreeEnabled?: unknown }).worktreeEnabled;
  return typeof enabled === 'boolean'
    ? { status: 'ready', enabled }
    : { status: 'invalid' };
}

/**
 * 手机只是远程控制器。invoke 成功只证明 Desktop main 已接受并广播，renderer
 * 仍需落真实草稿并经 push/GET 回声确认；因此成功路径绝不自行改手机镜像。
 * 唯一例外是老端明确没有偏好 channel，且用户显式关闭阻塞创建的旧 ON 镜像。
 */
export async function applyWorktreePreferenceOnHost(input: {
  enabled: boolean;
  apply: (enabled: boolean) => Promise<void>;
  mirror: (enabled: boolean) => void;
  /**
   * 老工作端连偏好 channel 都没有时，允许用户显式关闭手机保留的旧 ON 镜像。
   * 仅 CHANNEL_NOT_ALLOWED + OFF 生效；瞬时失败仍保留 ON 并继续 fail closed。
   */
  allowUnsupportedDisableFallback?: boolean;
}): Promise<'accepted' | 'compatibility-mirrored'> {
  try {
    await input.apply(input.enabled);
    return 'accepted';
  } catch (error) {
    if (
      input.enabled
      || input.allowUnsupportedDisableFallback !== true
      || !isWorktreeChannelNotAllowedError(error)
    ) throw error;
  }
  input.mirror(input.enabled);
  return 'compatibility-mirrored';
}

function remoteErrorText(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
  return `${typeof code === 'string' ? code : ''} ${message}`;
}

/**
 * Compatibility fallback is allowed only for the explicit channel-not-allowed
 * boundary. Unknown, transient, or timeout errors must not be treated as a
 * successful preference read/write.
 */
export function isWorktreeChannelNotAllowedError(error: unknown): boolean {
  return remoteErrorText(error).includes('CHANNEL_NOT_ALLOWED');
}

/**
 * 开关行是否显示:正常情况下是 project + workingDir + 通道可用；若老端不支持但
 * 镜像仍为 ON，保留已勾选的关闭入口，不能把用户锁在 fail-closed 状态。
 *
 * 2026-08-07 用户裁决(对齐桌面 WorktreeChipsRow):勾选记忆只对具备资格的目录
 * 生效——探测**成功**且确认不合格(ineligible:非 git / 无 git / 已在 worktree 内)
 * 时开关行隐藏、创建按普通会话放行,记忆保留;probing / detect-failed 不算确认,
 * 维持显示 + fail closed,一次断连不能把用户要求的隔离静默降级。
 */
export function shouldShowWorktreeToggle(input: {
  workspaceKind: 'project' | 'dialogue';
  workingDir: string;
  eligibility: NewSessionWorktreeEligibility;
  enabled: boolean;
}): boolean {
  return input.workspaceKind === 'project'
    && input.workingDir.trim().length > 0
    && input.eligibility.status !== 'ineligible'
    && (input.eligibility.status !== 'unsupported' || input.enabled);
}

/**
 * checkbox 正在写工作端时不能按旧镜像创建；已勾选且当前目标**探测未定**时,
 * 也不能静默退化为普通目录会话。unsupported + ON 仍 fail closed，但保留显式关闭
 * 入口，不能绕过 worktree:create 落到 base repo，也不能把用户永久锁住。
 *
 * ineligible(探测成功、确认不合格)放行(2026-08-07 裁决):勾选记忆只对合格
 * 目录生效,确认非 git 等三种资格缺失时按普通会话创建,开关行同步隐藏
 * (shouldShowWorktreeToggle)。probing / recovering / detect-failed 仍拦截——
 * 「确认不是 git」和「探测不出来」不是一回事。
 */
export function shouldBlockNewSessionCreateForWorktree(input: {
  /** 当前草稿是否真的会使用 worktree：仅 project + 已选目录。 */
  applicable: boolean;
  enabled: boolean;
  eligibility: NewSessionWorktreeEligibility;
  preferenceSaving: boolean;
}): boolean {
  // 对话工作区 / 尚未选目录时 worktree 控件本就隐藏，工作端记忆不能反向卡住
  // 普通会话创建；切回具体项目后再按该项目资格决定是否阻止。
  if (!input.applicable) return false;
  // ineligible 目标不创建 worktree,preference 写入在途也不该卡住普通会话
  // 创建(2026-08-07 裁决);仅 eligible/probing/detect-failed/unsupported 需要等。
  if (input.eligibility.status === 'ineligible') return false;
  if (input.preferenceSaving) return true;
  return input.enabled
    && input.eligibility.status !== 'eligible';
}

/** 资格未通过时的 caption 文案 key(session.json);eligible 无 caption。 */
export function worktreeEligibilityCaptionKey(
  eligibility: NewSessionWorktreeEligibility,
): string | null {
  switch (eligibility.status) {
    case 'probing':
      return 'session.new.worktreeDetecting';
    case 'recovering':
      return 'session.new.worktreeRecovering';
    case 'ineligible':
      switch (eligibility.reason) {
        case 'gitMissing':
          return 'session.new.worktreeGitMissing';
        case 'notGitRepo':
          return 'session.new.worktreeNotGitRepo';
        case 'alreadyInWorktree':
          return 'session.new.worktreeAlreadyInWorktree';
      }
      return null;
    case 'detect-failed':
      return 'session.new.worktreeDetectFailed';
    case 'unsupported':
      return 'session.new.worktreeUnsupported';
    default:
      return null;
  }
}

/** suggest-name 失败时的兼容兜底名；旧 Desktop host 仍要求 create 的 name 非空且合法。 */
export function fallbackWorktreeName(now = Date.now()): string {
  return `auto-${now.toString(36).slice(-6)}`;
}

/** 归一工作端 suggest-name 回包:非空字符串取 trim,其余走兼容 auto-* 兜底。 */
export function normalizeSuggestedWorktreeName(value: unknown, now?: number): string {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return fallbackWorktreeName(now);
}

export interface WorktreeCreateRequest {
  sessionId: string;
  baseRepo: string;
  name: string;
  sourceBranch: string;
  recoveryKey: string;
}

/**
 * Device Link responses are untrusted. Only a complete, request-matching
 * result may authorize forgetting the recovery reservation or consuming a
 * managed path. Any malformed shape remains cleanup-pending.
 */
export function parseWorktreeCreateResult(
  value: unknown,
  request: Pick<
    WorktreeCreateRequest,
    'sessionId' | 'baseRepo' | 'sourceBranch' | 'recoveryKey'
  >,
): MobileWorktreeCreateResult | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as {
    ok?: unknown;
    meta?: Record<string, unknown>;
    error?: Record<string, unknown>;
  };
  if (candidate.ok === false) {
    if (candidate.meta !== undefined) return null;
    const error = candidate.error;
    if (
      !error
      || typeof error.kind !== 'string'
      || !error.kind.trim()
      || typeof error.message !== 'string'
      || !error.message.trim()
    ) return null;
    if (error.hint !== undefined && typeof error.hint !== 'string') return null;
    if (error.rawStderr !== undefined && typeof error.rawStderr !== 'string') return null;
    return value as MobileWorktreeCreateResult;
  }
  if (candidate.ok !== true || !candidate.meta || candidate.error !== undefined) return null;
  const meta = candidate.meta;
  for (const field of ['sessionId', 'name', 'path', 'baseRepo', 'branch', 'sourceBranch', 'createdAt']) {
    if (typeof meta[field] !== 'string' || !(meta[field] as string).trim()) return null;
  }
  if ((meta.sessionId as string) !== request.sessionId) return null;
  if ((meta.baseRepo as string).trim() !== request.baseRepo.trim()) return null;
  if ((meta.sourceBranch as string).trim() !== request.sourceBranch.trim()) return null;
  // This parser is only used by the remote two-step flow, whose eligibility
  // already requires recovery-key support. A missing key therefore cannot be
  // treated as a compatible success: without the exact echo we cannot prove
  // which persisted reservation owns this managed directory.
  if (typeof meta.recoveryKey !== 'string' || meta.recoveryKey !== request.recoveryKey) return null;
  return value as MobileWorktreeCreateResult;
}

/** 组装 worktree:create 入参(第一步;第二步 createSession 复用同 sessionId + meta.path)。 */
export function buildWorktreeCreateRequest(input: {
  sessionId: string;
  eligibility: Extract<NewSessionWorktreeEligibility, { status: 'eligible' }>;
  /** 当前目标的显式源分支；省略时兼容旧调用方，回落 detect-cwd 当前分支。 */
  sourceBranch?: string | null;
  suggestedName: string | null | undefined;
  recoveryKey: string;
  /** 仅供测试固定 fallback；不进入 wire request。 */
  now?: number;
}): WorktreeCreateRequest {
  return {
    sessionId: input.sessionId,
    baseRepo: input.eligibility.baseRepo,
    name: normalizeSuggestedWorktreeName(input.suggestedName, input.now),
    sourceBranch: input.sourceBranch?.trim() || input.eligibility.sourceBranch,
    recoveryKey: input.recoveryKey,
  };
}

/**
 * worktree:create 业务失败({ok:false})的展示文案:message 是工作端生成的可直接
 * 展示文案,hint 另起一行补充(与桌面 showWorktreeError 的 message+hint 结构对齐)。
 */
export function formatWorktreeCreateFailure(error: { message: string; hint?: string }): string {
  const message = error.message.trim();
  const hint = error.hint?.trim();
  return hint ? `${message}\n${hint}` : message;
}
