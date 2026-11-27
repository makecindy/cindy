/**
 * PrSummaryPopoverContent — 会话顶栏 PR 徽标（GitContextBadge）与聊天消息
 * PR/MR 链接悬停浮窗（PrLinkHoverPopover）共用的 PR/MR 详情浮窗主体与配套弹窗。
 *
 * 视觉与交互保持单一事实源：
 *   - 头部：状态图标 + owner/repo #N(或 !N) + 状态文案 + 标题（可点外开）+ 复制链接 + 可选设置/管理入口
 *   - 未获取到状态 / 失败：错误原因 + 本机非只读任务下的 GitHub 安装/登录引导
 *   - 详情区：合并冲突、未解决 review 讨论数、Checks 总览与分项
 *   - 插件卡片跟进区：会话内若存在该 PR/MR 的活跃跟进卡片，直接投影其快捷控制条与设置弹窗
 */

import {
  Check,
  CircleMinus,
  CircleX,
  Clock,
  Copy,
  GitPullRequest,
  Settings,
  X,
} from 'lucide-react';
import { lazy, Suspense, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import {
  parseSessionPrUrl,
  prNumberLabel,
  sessionPrUrl,
  type PrIdentity,
} from '@cindy/maker-shared';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { ChromeIconButton } from '@/components/title-bar/ChromeIconButton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { PrStatusKind, PrStatusResult } from '@/lib/gitContext.types';
import type { useSessionPrCard } from '@/cindy-brain/useSessionPrCard';
import { GithubSetupDialog } from './GithubSetupDialog';

export type SessionPrCard = NonNullable<ReturnType<typeof useSessionPrCard>>;
import {
  PR_STATUS_ICON,
  prFailureCopyKey,
  prGuidanceFor,
  prStatusColor,
  type PrGuidanceAction,
} from './gitContextPrVisuals';

const GhostCardPreview = lazy(() =>
  import('@/components/chat/GhostToolCard').then((m) => ({ default: m.GhostCardPreview })),
);

export const PR_SUMMARY_OPEN_DELAY_MS = 300;
export const PR_SUMMARY_CLOSE_DELAY_MS = 300;

export const PR_SUMMARY_POPOVER_CLASS =
  'max-w-[calc(100vw-16px)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto p-4 w-[360px]';

/**
 * 识别聊天链接中的 GitHub PR 与 GitLab MR 地址，归一化 `www.github.com` 后复用到
 * `parseSessionPrUrl`（与右键“添加到任务”和卡片键保持同一口径）。
 */
export function parsePrLinkUrl(href: string): (PrIdentity & { url: string }) | null {
  if (!href) return null;
  return parseSessionPrUrl(href.replace(/^https:\/\/www\.github\.com\//i, 'https://github.com/'));
}

export interface PrSummaryPopoverContentProps {
  prRef: PrIdentity;
  status: PrStatusResult | undefined;
  sessionId?: string;
  remoteHostId?: string | null;
  deviceLinkDeviceId?: string | null;
  readOnly?: boolean;
  canManage?: boolean;
  prCard?: SessionPrCard | null;
  /** 仅会话顶栏传入：进入 PR 关联管理。聊天正文链接不传。 */
  onManage?: () => void;
  onClose: () => void;
  onReturnFocus?: () => void;
  onOpenSetup: (action: PrGuidanceAction) => void;
  onOpenSettings: () => void;
  onCardHoldChange?: (kind: 'pointer' | 'focus' | 'menu', active: boolean) => void;
}

export function PrSummaryPopoverContent({
  prRef,
  status,
  sessionId,
  remoteHostId,
  deviceLinkDeviceId,
  readOnly,
  canManage = false,
  prCard = null,
  onManage,
  onClose,
  onReturnFocus,
  onOpenSetup,
  onOpenSettings,
  onCardHoldChange,
}: PrSummaryPopoverContentProps) {
  const { t } = useTranslation();
  const cardSettingsButton = useRef<HTMLButtonElement | null>(null);

  const kind: PrStatusKind | null = status?.ok ? status.status : null;
  const conflicts =
    status?.ok && status.conflicts === true && (kind === 'open' || kind === 'draft');
  const Icon = kind ? PR_STATUS_ICON[kind] : GitPullRequest;
  const color = prStatusColor(kind, status?.ok ? status.conflicts : null);
  const guidance = prGuidanceFor(status, { remoteHostId, deviceLinkDeviceId, readOnly });
  const failureCopyKey = prFailureCopyKey(status, { remoteHostId, deviceLinkDeviceId, readOnly });

  const statusLine = kind
    ? t(`ccAgent.gitContext.pr.status.${kind}`)
    : failureCopyKey
      ? prRef.provider === 'gitlab'
        ? t(failureCopyKey, { host: prRef.host })
        : t(failureCopyKey)
      : t('ccAgent.gitContext.pr.statusNotFetched');

  const unresolved = status?.ok ? status.unresolvedCount : null;
  const checks = status?.ok ? (status.checks ?? null) : null;
  const checkDetails = checks
    ? [
        { icon: CircleX, count: checks.failed, label: 'failed' },
        { icon: Clock, count: checks.pending, label: 'pending' },
        { icon: Check, count: checks.passed, label: 'passed' },
        { icon: CircleMinus, count: checks.skipped, label: 'skippedLabel' },
      ].filter(({ count }) => count > 0)
    : [];

  const hasCardSettings = Boolean(
    canManage && prCard?.settingsLabel && kind !== 'merged' && kind !== 'closed',
  );
  const openCardSettings = () => {
    if (prCard && !prCard.settingsHtml) cardSettingsButton.current?.click();
    onOpenSettings();
    onClose();
  };

  return (
    <>
      <div className="flex items-start gap-2">
        <a
          href={sessionPrUrl(prRef)}
          onClick={(event) => {
            event.preventDefault();
            void window.electronAPI.openExternal(sessionPrUrl(prRef));
          }}
          // 无框文字按钮：圆角只塑形键盘焦点环（DESIGN.md §5 登记，使用 8px 内层控件圆角）
          className="group block min-w-0 flex-1 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          <span className="flex items-center gap-1 text-12 text-[var(--text-secondary)]">
            <Icon size={12} strokeWidth={1.5} className="shrink-0" style={{ color }} />
            <span className="min-w-0 break-words group-hover:underline">
              {prRef.owner}/{prRef.repo} {prNumberLabel(prRef)}
              {status?.ok && <> · {statusLine}</>}
            </span>
          </span>
          {status?.ok && status.title.trim() && (
            <span className="mt-1 block break-words text-14 font-medium leading-snug text-[var(--text-primary)] group-hover:underline">
              {status.title}
            </span>
          )}
        </a>
        <ChromeIconButton
          aria-label={t('sharing.copyLink')}
          className={cn('-mt-1.5 shrink-0', !onManage && !hasCardSettings && '-mr-2')}
          onClick={async () => {
            try {
              // PR/MR URLs are rendered locally, like the task/link copy actions;
              // the native IPC only accepts text previously issued by Main.
              await navigator.clipboard.writeText(sessionPrUrl(prRef));
              toast.success(t('ccAgent.sidebar.deepLink.copied'));
            } catch {
              toast.error(t('ccAgent.sidebar.deepLink.copyFailed'));
            }
          }}
        >
          <Copy size={14} />
        </ChromeIconButton>
        {canManage &&
          onManage &&
          (hasCardSettings && prCard ? (
            <DropdownMenu onOpenChange={(open) => onCardHoldChange?.('menu', open)}>
              <DropdownMenuTrigger asChild>
                <ChromeIconButton
                  aria-label={t('titleBar.menuItems.settings')}
                  data-pr-manage=""
                  className="-mr-2 -mt-1.5 shrink-0"
                >
                  <Settings size={14} />
                </ChromeIconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onCloseAutoFocus={(event) => event.preventDefault()}>
                <DropdownMenuItem onSelect={openCardSettings}>
                  {prCard.settingsLabel}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    onClose();
                    onManage();
                  }}
                >
                  {t('ccAgent.gitContext.pr.manage.title')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <ChromeIconButton
              aria-label={t('ccAgent.gitContext.pr.manage.title')}
              data-pr-manage=""
              className="-mr-2 -mt-1.5 shrink-0"
              onClick={() => {
                onClose();
                onManage();
              }}
            >
              <Settings size={14} />
            </ChromeIconButton>
          ))}
        {!onManage && hasCardSettings && prCard && (
          <ChromeIconButton
            aria-label={prCard.settingsLabel ?? t('titleBar.menuItems.settings')}
            className="-mr-2 -mt-1.5 shrink-0"
            onClick={openCardSettings}
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
                onClose();
                onOpenSetup(guidance);
              }}
              className="block text-left font-medium text-[var(--text-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              {t(`ccAgent.gitContext.pr.guidance.${guidance}.hint`)}
            </button>
          )}
        </div>
      )}
      {(conflicts || (unresolved !== null && unresolved > 0) || checks !== null) && (
        <div className="mt-3 space-y-3 border-t border-[var(--border-default)] pt-3 text-13">
          {conflicts && (
            <div className="flex items-center justify-between gap-3 whitespace-nowrap">
              <span className="text-[var(--text-primary)]">
                {t('ccAgent.gitContext.pr.merge')}
              </span>
              <span className="shrink-0 font-medium text-[var(--warning-fg)]">
                {t('ccAgent.gitContext.pr.conflicts')}
              </span>
            </div>
          )}
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
      {sessionId && prCard?.summaryHtml && kind !== 'merged' && kind !== 'closed' && (
        <div
          className="mt-3 border-t border-[var(--border-default)] pt-2"
          onPointerEnter={() => onCardHoldChange?.('pointer', true)}
          onPointerLeave={() => onCardHoldChange?.('pointer', false)}
          onFocusCapture={() => onCardHoldChange?.('focus', true)}
          onBlurCapture={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            onCardHoldChange?.('focus', false);
          }}
        >
          <Suspense fallback={null}>
            <GhostCardPreview
              key={prCard.callId}
              {...prCard}
              html={prCard.summaryHtml}
              sessionId={sessionId}
              onEscape={() => {
                onClose();
                onReturnFocus?.();
              }}
              settingsButtonRef={canManage ? cardSettingsButton : undefined}
            />
          </Suspense>
        </div>
      )}
    </>
  );
}

/**
 * 浮窗外挂的配套弹窗（GitHub 安装/登录引导 + PR 跟进卡片设置），
 * 与 Popover 并列渲染，确保关闭浮窗时不会把已打开的弹窗一起卸载。
 */
export function PrSummaryDialogs({
  prRef,
  sessionId,
  setupAction,
  onCloseSetup,
  settingsOpen,
  onSettingsOpenChange,
  prCard,
  onReturnFocus,
}: {
  prRef: PrIdentity;
  sessionId?: string;
  setupAction: PrGuidanceAction | null;
  onCloseSetup: () => void;
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
  prCard: SessionPrCard | null;
  onReturnFocus?: () => void;
}) {
  const { t } = useTranslation();

  return (
    <>
      {setupAction && <GithubSetupDialog initialAction={setupAction} onClose={onCloseSetup} />}
      {settingsOpen && prCard && sessionId && (
        <Dialog.Root open onOpenChange={onSettingsOpenChange}>
          <Dialog.Portal>
            <Dialog.Overlay className="modal-scrim fixed inset-0 z-modal" />
            <Dialog.Content
              aria-describedby={undefined}
              onPointerDownOutside={(event) => event.preventDefault()}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                onReturnFocus?.();
              }}
              className="modal-panel fixed left-1/2 top-1/2 z-modal w-[min(420px,calc(100vw-32px))] max-h-[85vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-4 outline-none"
            >
              <div className="mb-3 flex items-center justify-between gap-2">
                <div>
                  <Dialog.Title className="text-14 font-medium text-[var(--text-primary)]">
                    {prCard.settingsLabel}
                  </Dialog.Title>
                  <div className="mt-1 text-12 text-[var(--text-secondary)]">
                    {prRef.owner}/{prRef.repo} {prNumberLabel(prRef)}
                  </div>
                </div>
                <Dialog.Close asChild>
                  <ChromeIconButton aria-label={t('common.dismiss')}>
                    <X size={14} />
                  </ChromeIconButton>
                </Dialog.Close>
              </div>
              {prCard.settingsHtml && (
                <Suspense fallback={null}>
                  <GhostCardPreview
                    {...prCard}
                    html={prCard.settingsHtml}
                    sessionId={sessionId}
                    onEscape={() => onSettingsOpenChange(false)}
                  />
                </Suspense>
              )}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </>
  );
}
