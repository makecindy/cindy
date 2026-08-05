/**
 * gitContextPrVisuals — PR 状态的图标 / 颜色映射(session-git-pr-context)。
 * GitContextBadge(会话顶栏)与 SessionPrTooltip(sidebar hover tips)共用,
 * 保证两处状态视觉一致。颜色只用既有语义豁免 token(规则 16),图标形状
 * 区分四态(色弱友好)。
 */

import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-react';

import type { GitContextDirSource, PrStatusKind } from '@/lib/gitContext.types';

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
  const trusted = branchSource === 'telemetry' || branchSource === 'worktree';
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
