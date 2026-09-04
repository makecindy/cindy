/**
 * GitContextBadge — 会话顶栏的 git 上下文徽标(session-git-pr-context)。
 *
 * 组成:
 *   - 分支 chip:GitBranch 图标 + 分支名(detached 显示短 sha)。分支按信任度取:
 *     遥测/worktree/远端执行端推断出的真实工作目录 HEAD(可信)→ PR 源分支(head.ref,
 *     worktree 已删时兜底)→ working_dir HEAD(低信任,仅在无 PR 时最后兜底)。
 *     HEAD 变化(用户/agent 切分支)由 useSessionGitContext 实时推送刷新。
 *   - PR chip(最多 MAX_STATUS_QUERIES 条,lastSeenAt 最近优先):状态图标 + #号,
 *     点击在浏览器打开 PR;tooltip 显示标题与状态。
 *
 * PR 状态视觉:用 lucide 图标形状区分四态(色弱友好),颜色只用已注册 token:
 *   open   GitPullRequest        --diff-add-fg(语义绿,规则 16 豁免色)
 *   draft  GitPullRequestDraft   --text-tertiary
 *   merged GitMerge              --focus-ring(语义蓝;项目无紫 token,不为此新增)
 *   closed GitPullRequestClosed  --error-fg(语义红)
 *   未知(查询失败)               GitPullRequest + --text-tertiary,tooltip 给原因
 *
 * 本机 gh 缺失 / 未登录时(prGuidanceFor):点击把安装 / 登录提示词填进当前任务
 * 输入框交给 Agent;tooltip 写明点击后果。不复用 unresolved 的
 * `--status-bar-accent` 5px 角点(DESIGN.md 该点只表示未解决 review)。
 * SSH / device-link / review 只读任务不提供引导——点击无法兑现时仍打开 PR。
 */

import { GitBranch, GitPullRequest, MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/tooltip';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import type { Session } from '@/lib/ccAgent.types';
import type { PrStatusKind, PrStatusResult, SessionPrRef } from '@/lib/gitContext.types';
import { useSessionGitContext } from '@/hooks/useSessionGitContext';
import { hasPromptInsertSubscriber, insertPromptIntoComposer } from '@/lib/composerActionsBus';
import { prStatusKey, MAX_STATUS_QUERIES } from '@/lib/prStatus';
import {
  PR_STATUS_COLOR,
  PR_STATUS_ICON,
  pickBranchLabel,
  prFailureCopyKey,
  prGuidanceFor,
} from './gitContextPrVisuals';

export function GitContextBadge({ session }: { session: Session }) {
  const { t } = useTranslation();
  const { head, branchSource, prRefs, prStatuses } = useSessionGitContext(session);

  if (!head && prRefs.length === 0) return null;

  // 工作目录 HEAD 的可读分支名(branch 名 / detached 短 sha)。
  const localBranch =
    head?.kind === 'branch'
      ? head.branch
      : head?.kind === 'detached'
        ? `${t('ccAgent.gitContext.detached')} ${head.shortSha}`
        : null;
  // 最近一条 PR(lastSeenAt 降序)的源分支(head.ref);worktree 已删时兜底分支。
  const mostRecentPr = prRefs[0];
  const mostRecentPrStatus = mostRecentPr ? prStatuses.get(prStatusKey(mostRecentPr)) : undefined;
  const prBranch = mostRecentPrStatus?.ok ? mostRecentPrStatus.branch : null;
  // 优先级:遥测/worktree 真实目录分支(可信)→ PR 源分支 → working_dir 兜底
  //(仅在无 PR 引用时;有 PR 则宁可留空也不退回共享分支冒充)。
  const branchLabel = pickBranchLabel({
    localBranch,
    prBranch,
    branchSource,
    hasPrRefs: prRefs.length > 0,
  });

  return (
    <div className="ml-1.5 flex min-w-0 shrink items-center gap-1">
      {branchLabel && (
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <span
              className={cn(
                'inline-flex min-w-0 max-w-44 items-center gap-1 rounded-md px-1.5 py-0.5',
                'text-xs text-[var(--cmd-palette-item-meta)]',
              )}
              aria-label={t('ccAgent.gitContext.branchAria', { branch: branchLabel })}
            >
              <GitBranch size={12} strokeWidth={1.5} className="shrink-0" />
              <span className="truncate">{branchLabel}</span>
            </span>
          </Tooltip.Trigger>
          <Tooltip.Content side="bottom" variant="mono">
            {t('ccAgent.gitContext.branchTooltip', { branch: branchLabel })}
          </Tooltip.Content>
        </Tooltip.Root>
      )}

      {prRefs.slice(0, MAX_STATUS_QUERIES).map((ref) => (
        <PrChip
          key={ref.id}
          sessionId={session.id}
          remoteHostId={session.remoteHostId}
          deviceLinkDeviceId={session.deviceLinkDeviceId}
          readOnly={session.source === 'review'}
          prRef={ref}
          status={prStatuses.get(prStatusKey(ref))}
        />
      ))}
    </div>
  );
}

function PrChip({
  sessionId,
  remoteHostId,
  deviceLinkDeviceId,
  readOnly,
  prRef,
  status,
}: {
  sessionId: string;
  remoteHostId?: string | null;
  deviceLinkDeviceId?: string | null;
  readOnly?: boolean;
  prRef: SessionPrRef;
  status: PrStatusResult | undefined;
}) {
  const { t } = useTranslation();

  const kind: PrStatusKind | null = status?.ok ? status.status : null;
  const Icon = kind ? PR_STATUS_ICON[kind] : GitPullRequest;
  const color = kind ? PR_STATUS_COLOR[kind] : 'var(--text-tertiary)';
  const guidance = prGuidanceFor(status, { remoteHostId, deviceLinkDeviceId, readOnly });
  const failureCopyKey = prFailureCopyKey(status);

  const statusLine = kind
    ? t(`ccAgent.gitContext.pr.status.${kind}`)
    : failureCopyKey
      ? t(failureCopyKey)
      : t('ccAgent.gitContext.pr.statusUnknown');
  // 引导只在 Composer 真正写入后独占点击;没人接住(确认卡/接管/准备 worktree 等
  // 把 ChatInput 卸掉)必须退回打开 PR,不能空点。
  const actionLine = guidance
    ? t(`ccAgent.gitContext.pr.guidance.${guidance}.hint`)
    : t('ccAgent.gitContext.pr.clickToOpen');
  const ariaLabel = guidance
    ? t(`ccAgent.gitContext.pr.guidance.${guidance}.aria`, { number: prRef.prNumber })
    : t('ccAgent.gitContext.pr.openAria', { number: prRef.prNumber });

  const handleClick = () => {
    if (guidance) {
      const accepted = insertPromptIntoComposer({
        targetSessionId: sessionId,
        text: t(`ccAgent.gitContext.pr.guidance.${guidance}.prompt`),
      });
      if (accepted) return;
      // Composer 挂着但拒绝写入(发送中 / 语音占用):保持已广告的引导动作,不改打开 PR。
      if (hasPromptInsertSubscriber(sessionId)) return;
    }
    void window.electronAPI.openExternal(prRef.url);
  };

  // 未解决 review thread 数:>0 才显示;GraphQL 拿不到(null)时整个信号隐藏。
  const unresolved = status?.ok && status.unresolvedCount ? status.unresolvedCount : 0;

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          onClick={handleClick}
          aria-label={ariaLabel}
          data-pr-guidance={guidance ?? undefined}
          style={WINDOW_NO_DRAG_STYLE}
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5',
            'text-xs text-[var(--cmd-palette-item-meta)]',
            'hover:bg-titlebar-button-hover hover:text-foreground',
            'transition-colors focus-visible:outline-none',
          )}
        >
          <Icon size={12} strokeWidth={1.5} className="shrink-0" style={{ color }} />
          <span>#{prRef.prNumber}</span>
          {unresolved > 0 && (
            <span
              className="inline-flex items-center gap-0.5 text-10 font-medium leading-none"
              style={{ color: 'var(--status-bar-accent)' }}
              aria-label={t('ccAgent.gitContext.pr.unresolved', { count: unresolved })}
            >
              <MessageSquare size={9} strokeWidth={2} className="shrink-0" />
              {unresolved > 99 ? '99+' : unresolved}
            </span>
          )}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Content side="bottom" variant="mono">
        <div className="flex max-w-72 flex-col gap-0.5">
          <span className="truncate">
            {prRef.owner}/{prRef.repo}#{prRef.prNumber}
            {status?.ok ? ` · ${status.title}` : ''}
          </span>
          <span>{statusLine}</span>
          {unresolved > 0 && (
            <span>{t('ccAgent.gitContext.pr.unresolved', { count: unresolved })}</span>
          )}
          {/* tooltip 两模式都是深底白字(--tooltip-text),次级信息用透明度而不是页面级 token。 */}
          <span className="opacity-70">{actionLine}</span>
        </div>
      </Tooltip.Content>
    </Tooltip.Root>
  );
}
