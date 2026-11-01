/**
 * GitContextBadge — 会话顶栏的 git 上下文徽标(session-git-pr-context)。
 *
 * 组成:
 *   - 分支 chip:GitBranch 图标 + 分支名(detached 显示短 sha)。分支按信任度取:
 *     遥测/worktree/远端执行端推断出的真实工作目录 HEAD(可信)→ PR 源分支(head.ref,
 *     worktree 已删时兜底)→ working_dir HEAD(低信任,仅在无 PR 时最后兜底)。
 *     HEAD 变化(用户/agent 切分支)由 useSessionGitContext 实时推送刷新。
 *   - PR chip(最多 MAX_STATUS_QUERIES 条，固定与手动优先级在前):
 *     整组悬停显示 PR 信息，点击打开 PR；悬停面板右上角齿轮进入关联管理(共享访客除外)。
 *
 * PR 状态视觉:用 lucide 图标形状区分四态(色弱友好),颜色只用已注册 token:
 *   open   GitPullRequest        --diff-add-fg(语义绿,规则 16 豁免色)
 *   draft  GitPullRequestDraft   --text-tertiary
 *   merged GitMerge              --focus-ring(语义蓝;项目无紫 token,不为此新增)
 *   closed GitPullRequestClosed  --error-fg(语义红)
 *   未知(查询失败)               GitPullRequest + --text-tertiary,汇总面板给原因
 *
 * 本机 gh 缺失 / 未登录时(prGuidanceFor):点击打开内置安装和设备码登录界面。
 * 授权成功立即刷新状态。不复用 unresolved 的
 * `--status-bar-accent` 5px 角点(DESIGN.md 该点只表示未解决 review)。
 * SSH / device-link / review 只读任务不提供引导——点击无法兑现时仍打开 PR。
 */

import {
  GitBranch,
  GitPullRequest,
  MessageSquare,
  Check,
  CircleX,
  Clock,
  CircleHelp,
  CircleMinus,
  Settings,
} from 'lucide-react';
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/tooltip';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { sessionPrUrl } from '@cindy/maker-shared';
import { isSharedTaskPeer } from '@cindy/device-link';
import { SessionPrManager } from './SessionPrManager';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { ChromeIconButton } from '@/components/title-bar/ChromeIconButton';
import type { Session } from '@/lib/ccAgent.types';
import type { PrStatusKind, PrStatusResult, SessionPrRef } from '@/lib/gitContext.types';
import { useSessionGitContext } from '@/hooks/useSessionGitContext';
import { GithubSetupDialog } from './GithubSetupDialog';
import { prStatusKey, MAX_STATUS_QUERIES } from '@/lib/prStatus';
import {
  PR_STATUS_COLOR,
  PR_STATUS_ICON,
  pickBranchLabel,
  prFailureCopyKey,
  prGuidanceFor,
} from './gitContextPrVisuals';

const PR_SUMMARY_OPEN_DELAY_MS = 300;
const PR_SUMMARY_CLOSE_DELAY_MS = 300;
type PrSummary = string | null;

export function GitContextBadge({ session }: { session: Session }) {
  // A task switch discards transient panels and their pending close timers.
  return <GitContextBadgeContent key={session.id} session={session} />;
}

function GitContextBadgeContent({ session }: { session: Session }) {
  const [summary, setSummary] = useState<PrSummary>(null);
  // Owned here, not by a chip: removing the PR it was opened from must not close it.
  const [managerOpen, setManagerOpen] = useState(false);
  const badgeRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const { head, branchSource, prRefs, prStatuses } = useSessionGitContext(session);
  useEffect(() => {
    setSummary((current) =>
      current && !prRefs.slice(0, MAX_STATUS_QUERIES).some((ref) => ref.id === current)
        ? null
        : current,
    );
  }, [prRefs]);

  // 工作目录 HEAD 的可读分支名(branch 名 / detached 短 sha)。
  const localBranch =
    head?.kind === 'branch'
      ? head.branch
      : head?.kind === 'detached'
        ? `${t('ccAgent.gitContext.detached')} ${head.shortSha}`
        : null;
  // 首条 PR(固定、手动顺序优先，其次最近提及)的源分支(head.ref);worktree 已删时兜底分支。
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
    <div
      ref={badgeRef}
      className="ml-1.5 flex min-w-0 shrink items-center gap-1"
      style={WINDOW_NO_DRAG_STYLE}
    >
      {managerOpen && (
        <SessionPrManager
          session={session}
          anchorRef={badgeRef}
          returnFocus={() =>
            badgeRef.current?.querySelector<HTMLElement>('[data-pr-chip]')?.focus()
          }
          onClose={() => setManagerOpen(false)}
        />
      )}
      {branchLabel && (
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <span
              className={cn(
                'max-[1100px]:hidden inline-flex min-w-0 max-w-44 items-center gap-1 rounded-full px-1.5 py-0.5',
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

      {prRefs.slice(0, MAX_STATUS_QUERIES).map((ref, index) => (
        <PrChip
          key={ref.id}
          className={
            index === 0
              ? 'max-[520px]:hidden'
              : index === 1
                ? 'max-[700px]:hidden'
                : 'max-[1000px]:hidden'
          }
          session={session}
          prRef={ref}
          managerOpen={managerOpen}
          onManage={() => setManagerOpen(true)}
          status={prStatuses.get(prStatusKey(ref))}
          summary={summary}
          setSummary={setSummary}
        />
      ))}
    </div>
  );
}

function PrChip({
  className,
  session,
  prRef,
  managerOpen,
  onManage,
  status,
  summary,
  setSummary,
}: {
  className?: string;
  session: Session;
  prRef: SessionPrRef;
  managerOpen: boolean;
  onManage: () => void;
  status: PrStatusResult | undefined;
  summary: PrSummary;
  setSummary: Dispatch<SetStateAction<PrSummary>>;
}) {
  const { t } = useTranslation();
  const [setupOpen, setSetupOpen] = useState(false);
  const { remoteHostId, deviceLinkDeviceId } = session;
  const readOnly = session.source === 'review';
  // The shared-task host rejects association reads from guests.
  const canManage = !isSharedTaskPeer(deviceLinkDeviceId ?? '');
  const summaryOpen = summary === prRef.id;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressHover = useRef(false);
  const triggerHovered = useRef(false);
  const pointerFocus = useRef(false);
  const keyboardPreview = useRef(false);

  const cancelOpen = () => {
    if (openTimer.current !== null) clearTimeout(openTimer.current);
    openTimer.current = null;
  };
  const cancelClose = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  useEffect(
    () => () => {
      cancelOpen();
      cancelClose();
    },
    [],
  );
  useEffect(() => {
    if (!summaryOpen) cancelClose();
  }, [summaryOpen]);

  const closeSummary = () => {
    cancelOpen();
    cancelClose();
    suppressHover.current = triggerHovered.current;
    setSummary((current) => (current === prRef.id ? null : current));
  };
  const scheduleClose = () => {
    cancelOpen();
    cancelClose();
    if (keyboardPreview.current) return;
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setSummary((current) => (current === prRef.id ? null : current));
    }, PR_SUMMARY_CLOSE_DELAY_MS);
  };

  const kind: PrStatusKind | null = status?.ok ? status.status : null;
  const Icon = kind ? PR_STATUS_ICON[kind] : GitPullRequest;
  const color = kind ? PR_STATUS_COLOR[kind] : 'var(--text-tertiary)';
  const guidance = prGuidanceFor(status, { remoteHostId, deviceLinkDeviceId, readOnly });
  const failureCopyKey = prFailureCopyKey(status);

  const statusLine = kind
    ? t(`ccAgent.gitContext.pr.status.${kind}`)
    : failureCopyKey
      ? t(failureCopyKey)
      : t('ccAgent.gitContext.pr.statusNotFetched');
  // Installation and login are host-owned and independent of the task composer.
  const ariaLabel = guidance
    ? t(`ccAgent.gitContext.pr.guidance.${guidance}.aria`, { number: prRef.prNumber })
    : t('ccAgent.gitContext.pr.openAria', { number: prRef.prNumber });

  const handleClick = () => {
    closeSummary();
    if (guidance) {
      setSetupOpen(true);
      return;
    }
    void window.electronAPI.openExternal(sessionPrUrl(prRef));
  };

  // Unknown counts stay distinct from a confirmed zero.
  const unresolved = status?.ok ? status.unresolvedCount : null;
  const checks = status?.ok ? (status.checks ?? null) : null;
  // One check signal in the header; the panel retains every category.
  const CheckIcon = !checks
    ? CircleHelp
    : checks.failed > 0
      ? CircleX
      : checks.pending > 0
        ? Clock
        : checks.total > 0 && checks.passed + checks.skipped === checks.total
          ? Check
          : CircleMinus;
  const checkCount = checks ? checks.failed || checks.pending : 0;
  const checkDetails = checks
    ? [
        { icon: CircleX, count: checks.failed, label: 'failed' },
        { icon: Clock, count: checks.pending, label: 'pending' },
        { icon: Check, count: checks.passed, label: 'passed' },
        { icon: CircleMinus, count: checks.skipped, label: 'skippedLabel' },
      ].filter(({ count }) => count > 0)
    : [];

  return (
    <div className={cn('inline-flex shrink-0 items-center', className)}>
      {setupOpen && (
        <GithubSetupDialog
          initialAction={guidance ?? 'login'}
          onClose={() => setSetupOpen(false)}
        />
      )}
      <Popover
        open={summaryOpen}
        onOpenChange={(open) => {
          if (!open) closeSummary();
        }}
      >
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            aria-label={ariaLabel}
            data-pr-guidance={guidance ?? undefined}
            data-pr-chip=""
            style={WINDOW_NO_DRAG_STYLE}
            onPointerEnter={(event) => {
              if (event.pointerType !== 'mouse') return;
              triggerHovered.current = true;
              cancelClose();
              cancelOpen();
              if (suppressHover.current || managerOpen) return;
              if (summary !== null) {
                setSummary(prRef.id);
              } else {
                openTimer.current = setTimeout(() => {
                  openTimer.current = null;
                  setSummary(prRef.id);
                }, PR_SUMMARY_OPEN_DELAY_MS);
              }
            }}
            onPointerLeave={(event) => {
              if (event.pointerType !== 'mouse') return;
              triggerHovered.current = false;
              suppressHover.current = false;
              scheduleClose();
            }}
            onPointerDown={() => {
              pointerFocus.current = true;
              keyboardPreview.current = false;
            }}
            onFocus={(event) => {
              if (!pointerFocus.current && event.currentTarget.matches(':focus-visible')) {
                keyboardPreview.current = true;
                cancelOpen();
                cancelClose();
                setSummary(prRef.id);
              }
            }}
            onBlur={(event) => {
              pointerFocus.current = false;
              // Moving into the panel (to reach the settings gear) keeps it open.
              if (panelRef.current?.contains(event.relatedTarget as Node | null)) return;
              if (keyboardPreview.current) {
                keyboardPreview.current = false;
                closeSummary();
              }
            }}
            onKeyDown={(event) => {
              pointerFocus.current = false;
              if (event.key === 'Escape') {
                event.stopPropagation();
                closeSummary();
              }
              // The panel is portaled, so Tab cannot reach it on its own.
              if (event.key === 'Tab' && !event.shiftKey && keyboardPreview.current) {
                const gear = panelRef.current?.querySelector<HTMLElement>('[data-pr-manage]');
                if (gear) {
                  event.preventDefault();
                  gear.focus();
                }
              }
            }}
            onClick={(event) => {
              // This is a navigation button; Radix must not toggle the preview.
              event.preventDefault();
              handleClick();
            }}
            className="group/pr-action inline-flex h-7 min-w-6 items-center justify-center text-xs text-[var(--cmd-palette-item-meta)] hover:text-foreground focus-visible:outline-none"
          >
            <span
              className={cn(
                'inline-flex min-h-5 items-center justify-center gap-1 rounded-md px-1.5 py-0.5 transition-colors group-hover/pr-action:bg-titlebar-button-hover group-focus-visible/pr-action:ring-2 group-focus-visible/pr-action:ring-[var(--focus-ring)]',
                summaryOpen && 'bg-titlebar-button-hover',
              )}
            >
              <Icon size={12} strokeWidth={1.5} className="shrink-0" style={{ color }} />
              <span>#{prRef.prNumber}</span>
              {unresolved !== null && unresolved > 0 && (
                <span
                  className="inline-flex items-center gap-0.5 text-10 font-medium leading-none text-[var(--status-bar-accent)]"
                  aria-label={t('ccAgent.gitContext.pr.unresolved', { count: unresolved })}
                >
                  <MessageSquare size={9} strokeWidth={2} className="shrink-0" aria-hidden="true" />
                  {unresolved > 99 ? '99+' : unresolved}
                </span>
              )}
              {/* Checks no longer gate a merged PR; the panel keeps the details. */}
              {kind !== 'merged' && (
                <span
                  className={cn(
                    'inline-flex items-center gap-0.5 text-10 font-medium leading-none',
                    checks && checks.failed > 0 && 'text-[var(--error-fg)]',
                  )}
                >
                  <CheckIcon
                    size={9}
                    strokeWidth={2}
                    aria-hidden="true"
                    className={cn(
                      'shrink-0',
                      CheckIcon === Check && 'text-[var(--status-success)]',
                    )}
                  />
                  {checkCount > 0 && checkCount}
                </span>
              )}
            </span>
          </button>
        </PopoverTrigger>
        {summaryOpen && (
          <PopoverContent
            ref={panelRef}
            onBlur={(event) => {
              const next = event.relatedTarget as Node | null;
              if (next && (panelRef.current?.contains(next) || triggerRef.current?.contains(next)))
                return;
              if (keyboardPreview.current) {
                keyboardPreview.current = false;
                closeSummary();
              }
            }}
            onPointerEnter={(event) => {
              if (event.pointerType === 'mouse') cancelClose();
            }}
            onPointerLeave={(event) => {
              if (event.pointerType === 'mouse') scheduleClose();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                closeSummary();
                triggerRef.current?.focus();
              } else if (event.key === 'Tab' && event.shiftKey) {
                event.preventDefault();
                triggerRef.current?.focus();
              }
            }}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onInteractOutside={(event) => {
              if (event.target instanceof Node && triggerRef.current?.contains(event.target)) {
                event.preventDefault();
              }
            }}
            side="bottom"
            align="start"
            collisionPadding={8}
            className={cn('w-[320px] max-w-[calc(100vw-16px)] p-4', className)}
            aria-label={t('ccAgent.gitContext.pr.summaryAria', { number: prRef.prNumber })}
          >
            <div className="flex items-start gap-2">
              <a
                href={sessionPrUrl(prRef)}
                onClick={(event) => {
                  event.preventDefault();
                  void window.electronAPI.openExternal(sessionPrUrl(prRef));
                }}
                className="group block min-w-0 flex-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              >
                <span className="flex items-center gap-1 text-12 text-[var(--text-secondary)]">
                  <Icon size={12} strokeWidth={1.5} className="shrink-0" style={{ color }} />
                  <span className="min-w-0 break-words group-hover:underline">
                    {prRef.owner}/{prRef.repo} #{prRef.prNumber}
                    {status?.ok && <> · {statusLine}</>}
                  </span>
                </span>
                {status?.ok && status.title.trim() && (
                  <span className="mt-1 block break-words text-14 font-medium leading-snug text-[var(--text-primary)] group-hover:underline">
                    {status.title}
                  </span>
                )}
              </a>
              {canManage && (
                <ChromeIconButton
                  aria-label={t('ccAgent.gitContext.pr.manage.title')}
                  data-pr-manage=""
                  className="-mr-2 -mt-1.5 shrink-0"
                  onClick={() => {
                    closeSummary();
                    onManage();
                  }}
                >
                  <Settings size={14} />
                </ChromeIconButton>
              )}
            </div>
            {!status?.ok && (
              <div className="mt-3 space-y-2 text-13 text-[var(--text-secondary)]">
                <div>{statusLine}</div>
                {guidance && (
                  <button
                    type="button"
                    onClick={() => {
                      closeSummary();
                      setSetupOpen(true);
                    }}
                    className="block text-left font-medium text-[var(--text-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                  >
                    {t(`ccAgent.gitContext.pr.guidance.${guidance}.hint`)}
                  </button>
                )}
              </div>
            )}
            {((unresolved !== null && unresolved > 0) || checks !== null) && (
              <div className="mt-3 space-y-3 border-t border-[var(--border-default)] pt-3 text-13">
                {unresolved !== null && unresolved > 0 && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[var(--text-primary)]">
                      {t('ccAgent.gitContext.pr.unresolvedLabel')}
                    </span>
                    <span className="font-medium tabular-nums text-[var(--status-bar-accent)]">
                      {unresolved}
                    </span>
                  </div>
                )}
                {checks !== null && (
                  <div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[var(--text-primary)]">
                        {t('ccAgent.gitContext.pr.checks')}
                      </span>
                      <span className="tabular-nums text-[var(--text-secondary)]">
                        {t('ccAgent.gitContext.pr.checksTotal', { count: checks.total })}
                      </span>
                    </div>
                    {checkDetails.length > 0 && (
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-12 text-[var(--text-secondary)]">
                        {checkDetails.map(({ icon: DetailIcon, count, label }) => (
                          <span
                            key={label}
                            className={cn(
                              'inline-flex items-center gap-1 whitespace-nowrap',
                              label === 'failed' && 'text-[var(--error-fg)]',
                            )}
                          >
                            <DetailIcon
                              size={12}
                              aria-hidden="true"
                              className={
                                label === 'passed' ? 'text-[var(--status-success)]' : undefined
                              }
                            />
                            <span className="font-medium tabular-nums">{count}</span>
                            <span>{t(`ccAgent.gitContext.pr.${label}`)}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </PopoverContent>
        )}
      </Popover>
    </div>
  );
}
