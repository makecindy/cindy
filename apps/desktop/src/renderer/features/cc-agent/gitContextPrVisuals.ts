/**
 * gitContextPrVisuals — PR 状态的图标 / 颜色映射(session-git-pr-context)。
 * GitContextBadge(会话顶栏)与 SessionPrTooltip(sidebar hover tips)共用,
 * 保证两处状态视觉一致。颜色只用既有语义豁免 token(规则 16),图标形状
 * 区分四态(色弱友好)。
 */

import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-react';

import type { GitContextDirSource, PrStatusKind, PrStatusResult } from '@/lib/gitContext.types';

/**
 * 本机 gh 不可用时徽标承担的引导动作。tooltip 是非交互浮层放不了按钮,
 * 所以动作落在 chip 点击上:点击把对应提示词填进当前任务输入框(只填不发),
 * **不再**打开 PR——gh 问题解决之前一个 chip 只有一个动作。
 *   install = gh 未安装 → 让 Agent 安装并登录
 *   login   = gh 未登录 → 让 Agent 登录
 * 其它失败(no-token / not-found / fetch-failed)用户做不了什么,返回 null,
 * 点击仍是打开 PR。
 */
export type PrGuidanceAction = 'install' | 'login';

export type PrGuidanceSessionOpts = {
  /** Codex SSH:Agent 跑在远端机器。 */
  remoteHostId?: string | null;
  /** device-link:本 session 归属被控设备。与 remoteHostId 互不相干,必须同时钳。 */
  deviceLinkDeviceId?: string | null;
  /** review 等只读任务:ChatInput 永久 disabled,插入会被静默丢掉。 */
  readOnly?: boolean;
};

/**
 * 点击会独占 chip(不再打开 PR),所以只有动作能兑现才引导:
 *   1. 当前任务的 Agent 就在本机(非 SSH / 非 device-link)
 *   2. 输入框能收下提示词(非 review 只读)
 * 任一不成立 → 不引导,点击仍打开 PR。
 */
export function prGuidanceFor(
  status: PrStatusResult | undefined,
  opts?: PrGuidanceSessionOpts,
): PrGuidanceAction | null {
  if (opts?.remoteHostId || opts?.deviceLinkDeviceId || opts?.readOnly) return null;
  if (!status || status.ok) return null;
  if (status.reason === 'gh-missing') return 'install';
  if (status.reason === 'gh-not-logged-in') return 'login';
  return null;
}

/** 失败态 tooltip 的原因文案 key(ccAgent.gitContext.pr.*)。加载中(undefined)不给。 */
export function prFailureCopyKey(status: PrStatusResult | undefined): string | null {
  if (!status || status.ok) return null;
  switch (status.reason) {
    case 'gh-missing':
      return 'ccAgent.gitContext.pr.ghMissing';
    case 'gh-not-logged-in':
      return 'ccAgent.gitContext.pr.ghNotLoggedIn';
    case 'not-found':
      return 'ccAgent.gitContext.pr.notFound';
    case 'no-token':
    case 'fetch-failed':
      return 'ccAgent.gitContext.pr.statusUnknown';
  }
}

/**
 * 决定分支 chip 显示哪条分支。优先级:
 *   遥测 / worktree 目录分支(可信)→ PR head.ref → working_dir 分支(低信任兜底)。
 *
 * working_dir 兜底**仅在没有任何 PR 引用时**才用:一旦会话有 PR,宁可在 PR 分支
 * 加载出来前留空(返回 null),也不退回共享 checkout 分支冒充——否则 no-token /
 * 加载中 / fetch 失败时 prBranch 为 null 会穿透回 localBranch,把本功能要消灭的
 * "共享主 checkout 分支"重新显示出来(no-token 下会永久卡住;Codex review P2)。
 */
export function pickBranchLabel(opts: {
  /** 解析出的工作目录 HEAD 可读分支名(branch 名 / detached 短 sha)。 */
  localBranch: string | null;
  /** 最近一条 PR 的源分支(head.ref);未加载 / no-token / 失败时为 null。 */
  prBranch: string | null;
  branchSource: GitContextDirSource;
  /** 该会话是否有 PR 引用(决定低信任兜底是否让位)。 */
  hasPrRefs: boolean;
}): string | null {
  const { localBranch, prBranch, branchSource, hasPrRefs } = opts;
  const trusted =
    branchSource === 'telemetry' || branchSource === 'worktree' || branchSource === 'remote';
  if (trusted && localBranch) return localBranch;
  if (prBranch) return prBranch;
  if (branchSource === 'workingDir' && !hasPrRefs) return localBranch;
  return null;
}

export const PR_STATUS_ICON: Record<PrStatusKind, typeof GitPullRequest> = {
  open: GitPullRequest,
  draft: GitPullRequestDraft,
  merged: GitMerge,
  closed: GitPullRequestClosed,
};

export const PR_STATUS_COLOR: Record<PrStatusKind, string> = {
  open: 'var(--diff-add-fg)',
  draft: 'var(--text-tertiary)',
  merged: 'var(--focus-ring)',
  closed: 'var(--error-fg)',
};

/** 侧栏任务行 PR icon 所在表面:跟实际底色走,不跟主题名走。 */
export type PrIconSurface = 'light' | 'dark';

/** 从 `H S% L%` / `H S% L% / A` 取 L(0–100)。解析不了返回 null。 */
export function hslTripletLightness(raw: string): number | null {
  const parsed = raw.trim().match(/(-?[\d.]+)\s+(-?[\d.]+)%\s+(-?[\d.]+)%/);
  if (!parsed) return null;
  const lightness = Number(parsed[3]);
  return Number.isFinite(lightness) ? lightness : null;
}

/**
 * 侧栏 open 绿按表面取,不跟当前主题名走(2026-08-17 用户选 B):
 *   浅表面 → `--pr-open-on-light` `#2EA043`
 *   深表面 → `--pr-open-on-dark` `#3FB950`
 * 选中胶囊是否反相因主题而异(Cindy 反相,社区/导入主题多半不反相),
 * 所以优先用实际背景的 HSL L%;读不到时才退回 Cindy 反相假设。
 * 顶栏 GitContextBadge / hover tooltip 仍用 PR_STATUS_COLOR(主题 `--diff-add-fg`)。
 */
export function prIconSurface(opts: {
  themeIsDark: boolean;
  isActive: boolean;
  /** 实际行底 `--sidebar` / `--sidebar-item-active` 的 L%。 */
  backgroundLightness?: number | null;
}): PrIconSurface {
  if (opts.backgroundLightness != null && Number.isFinite(opts.backgroundLightness)) {
    return opts.backgroundLightness >= 50 ? 'light' : 'dark';
  }
  if (opts.isActive) return opts.themeIsDark ? 'light' : 'dark';
  return opts.themeIsDark ? 'dark' : 'light';
}

export function prStatusIconColor(kind: PrStatusKind | null, surface: PrIconSurface): string {
  if (kind === 'open') {
    return surface === 'light' ? 'var(--pr-open-on-light)' : 'var(--pr-open-on-dark)';
  }
  if (kind) return PR_STATUS_COLOR[kind];
  return 'var(--text-tertiary)';
}

/** open / draft 且有未解决 review thread 才打角点;merged / closed 当历史噪声。 */
export function shouldShowPrUnresolvedDot(
  kind: PrStatusKind | null,
  unresolvedCount: number | null | undefined,
): boolean {
  if (!unresolvedCount || unresolvedCount <= 0) return false;
  return kind === 'open' || kind === 'draft';
}
