/**
 * newSessionWorktree.ts —— 新建会话页 worktree 开关与两步建会话的纯决策逻辑。
 * ---------------------------------------------------------------------------
 * 手机复刻桌面控制端远程流程(NewMakerDraftRoute):远程没有「改已建会话 workingDir」
 * 的通道,顺序必须反过来 —— 先同步等工作端 `worktree:create` 建好 worktree 拿路径,
 * 再以该路径 + 同一预生成 sessionId 走 createSession(两步共用 sessionId,工作端
 * close-session 时才能按 worktreeStore 绑定回收 worktree)。
 *
 * 本模块只做纯函数(资格判定 / 播种归并 / create 入参组装 / 错误展示),不碰 React
 * 与 transport 实例,便于 vitest 直接覆盖;接线在 app/sessions/new.tsx。
 */
import type {
  MobileNewMakerDefaults,
  MobileWorktreeDetectCwdResult,
} from '@/device-link/mobileMakerTransport';

/** 资格不满足的原因(语义对齐桌面 newChat.worktree.{gitMissing,notGitRepo,alreadyInWorktree})。 */
export type NewSessionWorktreeIneligibleReason =
  | 'gitMissing'
  | 'notGitRepo'
  | 'alreadyInWorktree';

/**
 * worktree 开关的资格状态:
 *  - probing:探测中(目录/设备刚变化,结果未回)→ 开关禁用 + 「检测环境中…」;
 *  - eligible:可用,携带 create 所需的 baseRepo(repoRoot)与 sourceBranch(当前分支);
 *  - ineligible:环境不满足 → 开关禁用 + 原因 caption;
 *  - unsupported:老被控端无 worktree 通道(CHANNEL_NOT_ALLOWED)→ 整行隐藏;
 *  - detect-failed:探测失败(断连/超时等非通道原因)→ 开关禁用 + 失败 caption。
 */
export type NewSessionWorktreeEligibility =
  | { status: 'probing' }
  | { status: 'eligible'; baseRepo: string; sourceBranch: string }
  | { status: 'ineligible'; reason: NewSessionWorktreeIneligibleReason }
  | { status: 'unsupported' }
  | { status: 'detect-failed' };

export interface NewSessionWorktreeProbeTarget {
  deviceId: string;
  workingDir: string;
}

/** 探测结果与发起时的设备/目录绑定，防切换目标后的首帧误用上一仓库结果。 */
export interface NewSessionWorktreeProbeSnapshot {
  target: NewSessionWorktreeProbeTarget;
  eligibility: NewSessionWorktreeEligibility;
}

/**
 * 只向当前选择暴露同 target 的结果。React effect 要到 commit 后才会把 state 重置为
 * probing；render 阶段先做这道同步 fence，用户切项目/设备后立即创建也不会拿旧 baseRepo。
 */
export function worktreeEligibilityForTarget(
  snapshot: NewSessionWorktreeProbeSnapshot | null,
  target: NewSessionWorktreeProbeTarget,
): NewSessionWorktreeEligibility {
  if (
    !snapshot
    || snapshot.target.deviceId !== target.deviceId
    || snapshot.target.workingDir.trim() !== target.workingDir.trim()
  ) {
    return { status: 'probing' };
  }
  return snapshot.eligibility;
}

/**
 * 把工作端 detect-cwd 回包归并为资格状态。判定顺序对齐桌面 WorktreeChipsRow:
 * gitInstalled → isGitRepo → isInsideWorktree 逐项短路。
 * baseRepo 取 repoRoot(工作端 git rev-parse --show-toplevel),缺失回落 workingDir;
 * sourceBranch 取当前分支(手机没有分支选择 UI,等价于桌面分支 chip 回填 current),
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
  if (!result.gitInstalled) return { status: 'ineligible', reason: 'gitMissing' };
  if (!result.isGitRepo) return { status: 'ineligible', reason: 'notGitRepo' };
  if (result.isInsideWorktree) return { status: 'ineligible', reason: 'alreadyInWorktree' };
  if (result.supportsRecoveryKeyDiscard !== true) return { status: 'unsupported' };
  return {
    status: 'eligible',
    baseRepo: result.repoRoot?.trim() || workingDir,
    sourceBranch: result.currentBranch?.trim() || 'HEAD',
  };
}

/**
 * detect-cwd 抛错的归并:老被控端 CHANNEL_NOT_ALLOWED → unsupported(整行隐藏,
 * 「worktree 不可用」降级);其余(断连/超时)→ detect-failed(行保留、开关禁用)。
 *
 * 真实 wire 形状:被控端 dispatch 回 { code:'CHANNEL_NOT_ALLOWED', message:"channel
 * 'worktree:detect-cwd' not allowed remotely" },移动端 unwrapInvoke 抛
 * DeviceLinkError(code, message)——code 只在 .code 字段,message 里**不含**该字面量,
 * 所以必须先读结构化 code(对齐 sessionReferences 既有惯例),message 匹配只作
 * 字符串错误的兜底;同时容忍 relay 包装的 DEVICE_LINK_CHANNEL_NOT_ALLOWED 变体。
 */
export function worktreeEligibilityFromError(error: unknown): NewSessionWorktreeEligibility {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
  const text = `${typeof code === 'string' ? code : ''} ${message}`;
  if (text.includes('CHANNEL_NOT_ALLOWED')) return { status: 'unsupported' };
  return { status: 'detect-failed' };
}

/** 播种归并:工作端 get-new-maker-defaults 的 worktreeEnabled,缺字段/形状异常一律按未勾选。 */
export function seedWorktreeEnabled(
  defaults: MobileNewMakerDefaults | null | undefined,
): boolean {
  return defaults?.worktreeEnabled === true;
}

/** 开关行是否显示:project 模式 + 已选 workingDir,且通道未被判定为不可用。 */
export function shouldShowWorktreeToggle(input: {
  workspaceKind: 'project' | 'dialogue';
  workingDir: string;
  eligibility: NewSessionWorktreeEligibility;
}): boolean {
  return input.workspaceKind === 'project'
    && input.workingDir.trim().length > 0
    && input.eligibility.status !== 'unsupported';
}

/** 资格未通过时的 caption 文案 key(session.json);eligible/unsupported 无 caption。 */
export function worktreeEligibilityCaptionKey(
  eligibility: NewSessionWorktreeEligibility,
): string | null {
  switch (eligibility.status) {
    case 'probing':
      return 'session.new.worktreeDetecting';
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
    default:
      return null;
  }
}

/** suggest-name 失败时的兜底名(对齐桌面 `auto-` + 时间戳 base36 后 6 位;过工作端 [a-z0-9-] 白名单)。 */
export function fallbackWorktreeName(now = Date.now()): string {
  return `auto-${now.toString(36).slice(-6)}`;
}

/** 归一工作端 suggest-name 回包:非空字符串取 trim,其余走兜底名。 */
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

/** 组装 worktree:create 入参(第一步;第二步 createSession 复用同 sessionId + meta.path)。 */
export function buildWorktreeCreateRequest(input: {
  sessionId: string;
  eligibility: Extract<NewSessionWorktreeEligibility, { status: 'eligible' }>;
  suggestedName: string | null | undefined;
  recoveryKey: string;
  now?: number;
}): WorktreeCreateRequest {
  return {
    sessionId: input.sessionId,
    baseRepo: input.eligibility.baseRepo,
    name: normalizeSuggestedWorktreeName(input.suggestedName, input.now),
    sourceBranch: input.eligibility.sourceBranch,
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
