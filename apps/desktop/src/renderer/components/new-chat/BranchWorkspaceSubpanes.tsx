import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ArrowDownCircle,
  ArrowLeft,
  Check,
  ChevronRight,
  Info,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { BranchSyncStatus } from '../../../shared/worktreeBranchSync';
import type {
  WorkspaceClutterSummary,
  WorkspaceClutterTier,
} from '../../../shared/worktreeWorkspaceClutter';
import type { BranchCleanupFocusScopes } from '@/lib/branchCleanupPrompt';

export interface WorktreeModeCardProps {
  checked: boolean;
  disabled?: boolean;
  cantUseReason?: string;
  onToggle: (next: boolean) => void;
}

/** Human-first worktree isolation Switch card with an expandable 2-column visual comparison. */
export function WorktreeModeCard({
  checked,
  disabled,
  cantUseReason,
  onToggle,
}: WorktreeModeCardProps) {
  const { t } = useTranslation();
  const [explainOpen, setExplainOpen] = useState(false);

  const switchEl = (
    <Switch
      data-testid="create-agent-worktree-chip"
      checked={checked}
      disabled={disabled}
      onCheckedChange={onToggle}
      aria-label={t('newChat.worktree.toggleAria')}
    />
  );

  return (
    <div className="border-b border-[var(--border-default)] px-2.5 py-2">
      <div className="rounded-[10px] border border-[var(--border-default)] bg-[var(--surface)] px-2.5 py-2">
        <div className="flex items-start justify-between gap-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-12 font-semibold text-[var(--text-primary)]">
                {t('newChat.workspaceCapsule.worktreeTitle')}
              </span>
              {/* Glossary invariant: lowercase `worktree` kept verbatim across locales. */}
              <span className="rounded bg-[var(--surface-chip)] px-1.5 py-[1px] font-mono text-10 font-medium text-[var(--text-secondary)]">
                worktree
              </span>
            </div>
            <p className="mt-0.5 text-11 leading-[1.4] text-[var(--text-secondary)]">
              {checked
                ? t('newChat.workspaceCapsule.worktreeOnDesc')
                : t('newChat.workspaceCapsule.worktreeOffDesc')}
            </p>
          </div>
          {disabled && cantUseReason ? (
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <span className="inline-flex shrink-0" tabIndex={0}>
                  {switchEl}
                </span>
              </Tooltip.Trigger>
              <Tooltip.Content side="top">{cantUseReason}</Tooltip.Content>
            </Tooltip.Root>
          ) : (
            <div className="shrink-0 pt-0.5">{switchEl}</div>
          )}
        </div>

        <button
          type="button"
          aria-expanded={explainOpen}
          onClick={() => setExplainOpen((v) => !v)}
          className="mt-1 inline-flex items-center gap-1 rounded text-11 font-medium text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          <ChevronRight
            size={11}
            strokeWidth={2.2}
            aria-hidden
            className={cn(
              'shrink-0 transition-transform duration-[var(--motion-fast)] motion-reduce:transition-none',
              explainOpen && 'rotate-90',
            )}
          />
          <span>{t('newChat.workspaceCapsule.worktreeCompareToggle')}</span>
        </button>

        {explainOpen && (
          <div className="mt-2 grid grid-cols-2 gap-2 border-t border-dashed border-[var(--border-default)] pt-2">
            <div
              className={cn(
                'rounded-lg border bg-[var(--surface-elevated)] p-2',
                !checked ? 'border-[var(--text-tertiary)]' : 'border-[var(--border-default)]',
              )}
            >
              <div className="mb-1 flex items-center justify-between gap-1 text-11 font-semibold text-[var(--text-primary)]">
                <span title={t('newChat.workspaceCapsule.compareDirectTitle')} className="truncate">
                  {t('newChat.workspaceCapsule.compareDirectTitle')}
                </span>
                <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-1.5 py-[1px] text-10 font-medium text-[var(--text-secondary)]">
                  {!checked
                    ? t('newChat.workspaceCapsule.badgeCurrent')
                    : t('newChat.workspaceCapsule.badgeOff')}
                </span>
              </div>
              <div className="flex items-center justify-between rounded bg-[var(--surface)] px-1.5 py-1 text-10 text-[var(--text-secondary)]">
                <span>{t('newChat.workspaceCapsule.compareMainDir')}</span>
                <span>{t('newChat.workspaceCapsule.compareDirectWrite')}</span>
              </div>
              <p className="mt-1 text-10 leading-[1.4] text-[var(--text-tertiary)]">
                {t('newChat.workspaceCapsule.compareDirectNote')}
              </p>
            </div>

            <div
              className={cn(
                'rounded-lg border bg-[var(--surface-elevated)] p-2',
                checked ? 'border-[var(--text-tertiary)]' : 'border-[var(--border-default)]',
              )}
            >
              <div className="mb-1 flex items-center justify-between gap-1 text-11 font-semibold text-[var(--text-primary)]">
                <span title={t('newChat.workspaceCapsule.compareIsolatedTitle')} className="truncate">
                  {t('newChat.workspaceCapsule.compareIsolatedTitle')}
                </span>
                <span
                  className={cn(
                    'shrink-0 rounded-full px-1.5 py-[1px] text-10 font-medium',
                    checked
                      ? 'bg-[var(--surface-chip)] text-[var(--status-success)]'
                      : 'bg-[var(--surface-chip)] text-[var(--text-secondary)]',
                  )}
                >
                  {checked
                    ? t('newChat.workspaceCapsule.badgeCurrent')
                    : t('newChat.workspaceCapsule.badgeRecommended')}
                </span>
              </div>
              <div className="flex items-center justify-between rounded bg-[var(--surface)] px-1.5 py-1 text-10 text-[var(--text-secondary)]">
                <span>{t('newChat.workspaceCapsule.compareMainDir')}</span>
                <span>{t('newChat.workspaceCapsule.compareUntouched')}</span>
              </div>
              <div className="mt-1 flex items-center justify-between rounded border border-dashed border-[var(--remote-status-ready)] bg-[var(--surface)] px-1.5 py-1 text-10 text-[var(--text-primary)]">
                <span>{t('newChat.workspaceCapsule.compareTaskCopy')}</span>
                <span>{t('newChat.workspaceCapsule.compareIsolatedRun')}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export interface BranchSyncStatusSectionProps {
  branchLabel: string;
  status?: BranchSyncStatus;
  busy: boolean;
  done: boolean;
  errorText?: string;
  hint: string;
  canRebaseDiverged: boolean;
  divergedConflictFiles: string[];
  canAskAgentOnDiverged: boolean;
  syncDisabled: boolean;
  checkoutBusy?: boolean;
  onSync: (strategy?: 'ff-only' | 'rebase') => void;
  onResolveConflict: () => void;
}

/**
 * Progressive-disclosure sync status area inside the single-capsule popover.
 * Plain human language on the surface; exact Git refs, conflict files, and command safety inside "Technical details".
 */
export function BranchSyncStatusSection({
  branchLabel,
  status,
  busy,
  done,
  errorText,
  hint,
  canRebaseDiverged,
  divergedConflictFiles,
  canAskAgentOnDiverged,
  syncDisabled,
  checkoutBusy,
  onSync,
  onResolveConflict,
}: BranchSyncStatusSectionProps) {
  const { t } = useTranslation();
  const [techOpen, setTechOpen] = useState(false);

  if (!status && !errorText) return null;

  const remoteDisplay = status
    ? `${status.remote ?? 'origin'}/${status.remoteBranch ?? branchLabel}`
    : '';
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const dirtyFiles = status?.dirtyFiles ?? 0;

  if (status?.remoteOnly) {
    return (
      <div className="border-b border-[var(--border-default)] px-3 py-2">
        <div className="flex items-center gap-1.5 text-12 text-[var(--text-secondary)]">
          <Check size={13} strokeWidth={2.2} aria-hidden className="shrink-0 text-[var(--remote-status-ready)]" />
          <span>{t('newChat.workspaceCapsule.remoteLatestReady')}</span>
        </div>
      </div>
    );
  }

  // Error state
  if (errorText) {
    return (
      <div className="border-b border-[var(--border-default)] px-3 py-2.5">
        <div className="rounded-[10px] border border-[var(--border-default)] bg-[var(--warning-bg-soft)] p-2.5">
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0 text-[var(--warning-fg)]" />
            <div className="min-w-0 flex-1 text-12 leading-[1.45] text-[var(--text-primary)]">
              {t('newChat.branchSync.failed', { reason: errorText })}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Diverged state: clean zero-token rebase OR conflict/dirty Agent handoff
  if (status?.blocked === 'diverged') {
    const isConflict = !canRebaseDiverged;
    const headline = canRebaseDiverged
      ? t('newChat.workspaceCapsule.divergedCleanTitle')
      : divergedConflictFiles.length > 0
        ? t('newChat.workspaceCapsule.divergedConflictTitle')
        : dirtyFiles > 0
          ? t('newChat.workspaceCapsule.divergedDirtyTitle', { count: dirtyFiles })
          : t('newChat.workspaceCapsule.divergedConflictTitle');

    const subtitle = canRebaseDiverged
      ? t('newChat.workspaceCapsule.divergedCleanDesc')
      : divergedConflictFiles.length > 0
        ? t('newChat.workspaceCapsule.divergedConflictDesc', { count: divergedConflictFiles.length })
        : dirtyFiles > 0
          ? t('newChat.workspaceCapsule.divergedDirtyDesc')
          : t('newChat.workspaceCapsule.divergedGenericDesc');

    return (
      <div className="border-b border-[var(--border-default)] px-3 py-2.5">
        <div
          className={cn(
            'rounded-[10px] border p-2.5',
            isConflict
              ? 'border-[var(--border-default)] bg-[var(--warning-bg-soft)]'
              : 'border-[var(--border-default)] bg-[var(--surface)]',
          )}
        >
          <div className="flex items-start gap-2">
            {isConflict ? (
              <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0 text-[var(--warning-fg)]" />
            ) : (
              <Info size={14} aria-hidden className="mt-0.5 shrink-0 text-[var(--text-secondary)]" />
            )}
            <div className="min-w-0 flex-1">
              <div className="text-12 font-semibold leading-[1.35] text-[var(--text-primary)]">
                {headline}
              </div>
              <p className="mt-0.5 text-11 leading-[1.45] text-[var(--text-secondary)]">
                {subtitle}
              </p>
            </div>
          </div>

          <div className="mt-2 flex items-center justify-between gap-2">
            <button
              type="button"
              aria-expanded={techOpen}
              onClick={() => setTechOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded text-11 font-medium text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              <ChevronRight
                size={11}
                strokeWidth={2.2}
                aria-hidden
                className={cn(
                  'shrink-0 transition-transform duration-[var(--motion-fast)] motion-reduce:transition-none',
                  techOpen && 'rotate-90',
                )}
              />
              <span>
                {divergedConflictFiles.length > 0
                  ? t('newChat.workspaceCapsule.filesAndDetails')
                  : t('newChat.workspaceCapsule.techDetails')}
              </span>
            </button>

            {canRebaseDiverged ? (
              <Button
                compact
                size="sm"
                variant="secondary"
                disabled={syncDisabled}
                onClick={() => onSync('rebase')}
              >
                {busy ? <Spinner size={12} aria-hidden /> : null}
                {t('newChat.branchSync.rebaseNow')}
              </Button>
            ) : canAskAgentOnDiverged ? (
              <Button
                compact
                size="sm"
                variant="secondary"
                disabled={checkoutBusy}
                onClick={onResolveConflict}
              >
                {t('newChat.branchSync.askAgentResolve')}
              </Button>
            ) : null}
          </div>

          {techOpen && (
            <div className="mt-2 space-y-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] p-2 text-11 text-[var(--text-secondary)]">
              <div className="flex items-baseline justify-between gap-2">
                <span className="shrink-0 text-[var(--text-tertiary)]">
                  {t('newChat.workspaceCapsule.techCommitsLabel')}
                </span>
                <span className="truncate font-mono text-10 text-[var(--text-primary)]">
                  {t('newChat.branchSync.diverging', {
                    remote: remoteDisplay,
                    ahead,
                    behind,
                    count: ahead,
                  })}
                </span>
              </div>
              {divergedConflictFiles.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-0.5">
                  {divergedConflictFiles.map((file) => (
                    <span
                      key={file}
                      className="rounded bg-[var(--surface-chip)] px-1.5 py-0.5 font-mono text-10 text-[var(--text-primary)]"
                    >
                      {file}
                    </span>
                  ))}
                </div>
              )}
              <p className="text-10 leading-[1.45] text-[var(--text-tertiary)]">
                {canRebaseDiverged
                  ? t('newChat.workspaceCapsule.techRebaseSafety')
                  : t('newChat.workspaceCapsule.techAgentSafety')}
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Other blocked states (conflict on fast-forward, no-remote, missing-remote, multiple-checkouts)
  if (status?.blocked) {
    return (
      <div className="border-b border-[var(--border-default)] px-3 py-1.5">
        <div className="flex items-center gap-1.5 text-11 leading-[1.4] text-[var(--text-secondary)]">
          <Info size={12} aria-hidden className="shrink-0 text-[var(--text-tertiary)]" />
          <span title={hint} className="min-w-0 flex-1 truncate">
            {hint}
          </span>
        </div>
      </div>
    );
  }

  // Behind remote (clean fast-forward available)
  if (status && behind > 0) {
    return (
      <div className="border-b border-[var(--border-default)] px-3 py-2.5">
        <div className="rounded-[10px] border border-[var(--border-default)] bg-[var(--surface)] p-2.5">
          <div className="flex items-start gap-2">
            <ArrowDownCircle size={14} aria-hidden className="mt-0.5 shrink-0 text-[var(--text-secondary)]" />
            <div className="min-w-0 flex-1">
              <div className="text-12 font-semibold leading-[1.35] text-[var(--text-primary)]">
                {t('newChat.workspaceCapsule.behindTitle', { count: behind })}
              </div>
              <p className="mt-0.5 text-11 leading-[1.45] text-[var(--text-secondary)]">
                {t('newChat.workspaceCapsule.behindDesc')}
              </p>
            </div>
          </div>

          <div className="mt-2 flex items-center justify-between gap-2">
            <button
              type="button"
              aria-expanded={techOpen}
              onClick={() => setTechOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded text-11 font-medium text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              <ChevronRight
                size={11}
                strokeWidth={2.2}
                aria-hidden
                className={cn(
                  'shrink-0 transition-transform duration-[var(--motion-fast)] motion-reduce:transition-none',
                  techOpen && 'rotate-90',
                )}
              />
              <span>{t('newChat.workspaceCapsule.techDetails')}</span>
            </button>

            <Button
              compact
              size="sm"
              variant="secondary"
              disabled={syncDisabled}
              onClick={() => onSync('ff-only')}
            >
              {busy ? <Spinner size={12} aria-hidden /> : null}
              {t('newChat.workspaceCapsule.syncNow')}
            </Button>
          </div>

          {techOpen && (
            <div className="mt-2 space-y-1 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] p-2 text-11 text-[var(--text-secondary)]">
              <div className="flex items-baseline justify-between gap-2">
                <span className="shrink-0 text-[var(--text-tertiary)]">
                  {t('newChat.workspaceCapsule.techRefsLabel')}
                </span>
                <span className="truncate font-mono text-10 text-[var(--text-primary)]">
                  {branchLabel} ← {remoteDisplay}
                </span>
              </div>
              <p className="text-10 leading-[1.45] text-[var(--text-tertiary)]">
                {t('newChat.workspaceCapsule.techFfSafety')}
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Up to date (or ahead-only) — whisper-quiet 1-line strip with expandable Technical Details
  const syncedText = done
    ? hint
    : ahead > 0
      ? t('newChat.workspaceCapsule.aheadOnlyStatus', { count: ahead })
      : t('newChat.workspaceCapsule.syncedStatus');
  const refsSummaryText = `${branchLabel} ⇄ ${remoteDisplay}`;

  return (
    <div className="border-b border-[var(--border-default)] px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex min-w-0 items-center gap-1.5 text-12 text-[var(--text-secondary)]">
          <Check size={13} strokeWidth={2.2} aria-hidden className="shrink-0 text-[var(--remote-status-ready)]" />
          <span title={syncedText} className="truncate">
            {syncedText}
          </span>
        </div>
        <button
          type="button"
          aria-expanded={techOpen}
          onClick={() => setTechOpen((v) => !v)}
          className="inline-flex shrink-0 items-center gap-0.5 rounded text-11 font-medium text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          <ChevronRight
            size={11}
            strokeWidth={2.2}
            aria-hidden
            className={cn(
              'shrink-0 transition-transform duration-[var(--motion-fast)] motion-reduce:transition-none',
              techOpen && 'rotate-90',
            )}
          />
          <span>{t('newChat.workspaceCapsule.techDetails')}</span>
        </button>
      </div>

      {techOpen && status && (
        <div className="mt-2 space-y-1 rounded-lg border border-[var(--border-default)] bg-[var(--surface)] p-2 text-11 text-[var(--text-secondary)]">
          <div className="flex items-baseline justify-between gap-2">
            <span className="shrink-0 text-[var(--text-tertiary)]">
              {t('newChat.workspaceCapsule.techRefsLabel')}
            </span>
            <span title={refsSummaryText} className="truncate font-mono text-10 text-[var(--text-primary)]">
              {refsSummaryText}
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="shrink-0 text-[var(--text-tertiary)]">
              {t('newChat.workspaceCapsule.techCommitsLabel')}
            </span>
            <span className="font-mono text-10 text-[var(--text-primary)]">
              +{ahead} / -{behind}
            </span>
          </div>
          {dirtyFiles > 0 && (
            <div className="flex items-baseline justify-between gap-2">
              <span className="shrink-0 text-[var(--text-tertiary)]">
                {t('newChat.workspaceCapsule.techWorkingTreeLabel')}
              </span>
              <span className="font-mono text-10 text-[var(--text-primary)]">
                {t('newChat.branchSync.dirty', { count: dirtyFiles })}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export interface WorkspaceCleanupEntryRowProps {
  summary: WorkspaceClutterSummary | null;
  tier: WorkspaceClutterTier;
  showRedDot: boolean;
  onOpen: () => void;
}

/** Conditional AI workspace organization entry row (hidden at L0 healthy). */
export function WorkspaceCleanupEntryRow({
  summary,
  tier,
  showRedDot,
  onOpen,
}: WorkspaceCleanupEntryRowProps) {
  const { t } = useTranslation();
  if (!summary || tier === 'healthy') return null;

  const isUrgent = tier === 'urgent';
  const titleText = isUrgent
    ? t('newChat.workspaceCleanup.entryUrgentTitle')
    : t('newChat.workspaceCleanup.entrySuggestTitle');
  const subText =
    summary.failedCleanupCount > 0
      ? t('newChat.workspaceCleanup.entrySubWithFailed', {
          cindyBranches: summary.cindyBranchCount,
          idleWorktrees: summary.idleWorktreeCount,
          failed: summary.failedCleanupCount,
        })
      : t('newChat.workspaceCleanup.entrySub', {
          cindyBranches: summary.cindyBranchCount,
          idleWorktrees: summary.idleWorktreeCount,
        });

  return (
    <div className="border-t border-[var(--border-default)] p-1.5">
      <button
        type="button"
        data-testid="workspace-cleanup-entry"
        onClick={onOpen}
        className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className={cn(
              'inline-flex size-[22px] shrink-0 items-center justify-center rounded-md',
              showRedDot
                ? 'bg-[var(--error-bg)] text-[var(--error-fg)]'
                : 'bg-[var(--warning-bg-soft)] text-[var(--warning-fg)]',
            )}
          >
            <Sparkles size={12} strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <div title={titleText} className="truncate text-12 font-medium text-[var(--text-primary)]">
              {titleText}
            </div>
            <div title={subText} className="truncate text-10 text-[var(--text-tertiary)]">
              {subText}
            </div>
          </div>
        </div>
        <div className="inline-flex shrink-0 items-center gap-1">
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-1.5 py-[2px] text-10 font-medium',
              showRedDot
                ? 'bg-[var(--error-bg)] text-[var(--error-fg)]'
                : 'bg-[var(--warning-bg-soft)] text-[var(--warning-fg)]',
            )}
          >
            {showRedDot && (
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-[var(--error-fg)]" />
            )}
            <span>
              {t('newChat.workspaceCleanup.entryCountBadge', {
                branches: summary.localBranchCount,
                worktrees: summary.idleWorktreeCount,
              })}
            </span>
          </span>
          <ChevronRight size={12} aria-hidden className="text-[var(--text-tertiary)]" />
        </div>
      </button>
    </div>
  );
}

/** Inline 30-second visual guide for users unfamiliar with Git branches and worktrees. */
export function BranchGuidePane({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <div data-testid="workspace-guide-pane" className="flex flex-col">
      <div className="flex items-center justify-between border-b border-[var(--border-default)] px-2.5 py-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-12 font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          <ArrowLeft size={13} aria-hidden />
          <span>{t('newChat.workspaceCapsule.back')}</span>
        </button>
        <span className="text-12 font-semibold text-[var(--text-primary)]">
          {t('newChat.workspaceCapsule.guideTitle')}
        </span>
        <span className="w-11" aria-hidden />
      </div>

      <div className="space-y-2.5 p-3">
        <div className="rounded-[10px] border border-[var(--border-default)] bg-[var(--surface)] p-2.5">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-12 font-semibold text-[var(--text-primary)]">
              {t('newChat.workspaceCapsule.guideBranchTitle')}
            </span>
            <span className="rounded bg-[var(--surface-chip)] px-1.5 py-[1px] font-mono text-10 text-[var(--text-secondary)]">
              branch
            </span>
          </div>
          <p className="text-11 leading-[1.5] text-[var(--text-secondary)]">
            {t('newChat.workspaceCapsule.guideBranchDesc')}
          </p>
          <div className="mt-2 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2.5 py-2">
            <svg width="100%" height="44" viewBox="0 0 296 44" fill="none" aria-hidden="true">
              <line
                x1="14"
                y1="14"
                x2="198"
                y2="14"
                stroke="var(--border-default)"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
              <path
                d="M82 14 C98 14, 102 32, 120 32 L198 32"
                stroke="var(--remote-status-ready)"
                strokeWidth="1.8"
                strokeLinecap="round"
                fill="none"
              />
              <circle cx="24" cy="14" r="4" fill="var(--text-primary)" />
              <circle cx="82" cy="14" r="4" fill="var(--text-primary)" />
              <circle cx="186" cy="14" r="4" fill="var(--text-tertiary)" />
              <circle cx="136" cy="32" r="4" fill="var(--remote-status-ready)" />
              <circle cx="186" cy="32" r="4" fill="var(--remote-status-ready)" />
              <text
                x="206"
                y="17"
                fill="var(--text-secondary)"
                fontSize="10"
                fontFamily="var(--font-mono)"
              >
                {t('newChat.workspaceCapsule.guideGraphMain')}
              </text>
              <text
                x="206"
                y="35"
                fill="var(--status-success)"
                fontSize="10"
                fontFamily="var(--font-mono)"
              >
                {t('newChat.workspaceCapsule.guideGraphTask')}
              </text>
            </svg>
          </div>
        </div>

        <div className="rounded-[10px] border border-[var(--border-default)] bg-[var(--surface)] p-2.5">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-12 font-semibold text-[var(--text-primary)]">
              {t('newChat.workspaceCapsule.guideWorktreeTitle')}
            </span>
            <span className="rounded bg-[var(--surface-chip)] px-1.5 py-[1px] font-mono text-10 text-[var(--text-secondary)]">
              worktree
            </span>
          </div>
          <p className="text-11 leading-[1.5] text-[var(--text-secondary)]">
            {t('newChat.workspaceCapsule.guideWorktreeDesc')}
          </p>
        </div>

        <div className="rounded-[10px] border border-[var(--border-default)] bg-[var(--surface)] p-2.5">
          <div className="mb-1.5 text-12 font-semibold text-[var(--text-primary)]">
            {t('newChat.workspaceCapsule.guideChoiceTitle')}
          </div>
          <div className="space-y-1.5 text-11 leading-[1.45] text-[var(--text-secondary)]">
            <div>
              <strong className="font-semibold text-[var(--text-primary)]">
                {t('newChat.workspaceCapsule.guideRemoteLabel')}
              </strong>{' '}
              {t('newChat.workspaceCapsule.guideRemoteDesc')}
            </div>
            <div className="border-t border-[var(--border-default)] pt-1.5">
              <strong className="font-semibold text-[var(--text-primary)]">
                {t('newChat.workspaceCapsule.guideLocalLabel')}
              </strong>{' '}
              {t('newChat.workspaceCapsule.guideLocalDesc')}
            </div>
          </div>
        </div>

        <p className="px-1 text-center text-10 text-[var(--text-tertiary)]">
          {t('newChat.workspaceCapsule.guideProHint')}
        </p>
      </div>
    </div>
  );
}

export interface WorkspaceCleanupPaneProps {
  summary: WorkspaceClutterSummary;
  showRedDot: boolean;
  onBack: () => void;
  onSnoozeRedDot: () => void;
  onStartCleanup: (scopes: BranchCleanupFocusScopes) => void;
}

/** Inline read-only-first AI workspace cleanup preview & confirmation pane. */
export function WorkspaceCleanupPane({
  summary,
  showRedDot,
  onBack,
  onSnoozeRedDot,
  onStartCleanup,
}: WorkspaceCleanupPaneProps) {
  const { t } = useTranslation();
  const [scopes, setScopes] = useState<BranchCleanupFocusScopes>({
    merged: true,
    worktrees: true,
    unpushed: false,
  });

  const toggleScope = (key: keyof BranchCleanupFocusScopes) => {
    setScopes((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      if (!next.merged && !next.worktrees && !next.unpushed) return prev;
      return next;
    });
  };

  return (
    <div data-testid="workspace-cleanup-pane" className="flex flex-col">
      <div className="flex items-center justify-between border-b border-[var(--border-default)] px-2.5 py-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-12 font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          <ArrowLeft size={13} aria-hidden />
          <span>{t('newChat.workspaceCapsule.back')}</span>
        </button>
        <span className="text-12 font-semibold text-[var(--text-primary)]">
          {t('newChat.workspaceCleanup.paneTitle')}
        </span>
        <span className="w-11" aria-hidden />
      </div>

      <div className="space-y-2.5 p-3">
        <div className="flex items-start gap-2 rounded-[10px] border border-[var(--border-default)] bg-[var(--surface)] p-2.5">
          <ShieldCheck
            size={15}
            aria-hidden
            className="mt-0.5 shrink-0 text-[var(--status-success)]"
          />
          <div className="min-w-0 flex-1">
            <div className="text-12 font-semibold text-[var(--text-primary)]">
              {t('newChat.workspaceCleanup.safeBannerTitle')}
            </div>
            <p className="mt-0.5 text-11 leading-[1.45] text-[var(--text-secondary)]">
              {t('newChat.workspaceCleanup.safeBannerDesc')}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-[9px] border border-[var(--border-default)] bg-[var(--surface)] px-2.5 py-2">
            <div className="text-10 text-[var(--text-tertiary)]">
              {t('newChat.workspaceCleanup.statBranchesLabel')}
            </div>
            <div className="mt-0.5 text-15 font-bold text-[var(--text-primary)]">
              {t('newChat.workspaceCleanup.statCount', { count: summary.localBranchCount })}
            </div>
            <div className="mt-0.5 text-10 text-[var(--text-secondary)]">
              {t('newChat.workspaceCleanup.statCindyBranches', { count: summary.cindyBranchCount })}
            </div>
          </div>

          <div className="rounded-[9px] border border-[var(--border-default)] bg-[var(--surface)] px-2.5 py-2">
            <div className="text-10 text-[var(--text-tertiary)]">
              {t('newChat.workspaceCleanup.statWorktreesLabel')}
            </div>
            <div className="mt-0.5 text-15 font-bold text-[var(--text-primary)]">
              {t('newChat.workspaceCleanup.statCount', { count: summary.worktreeCount })}
            </div>
            <div className="mt-0.5 text-10 text-[var(--text-secondary)]">
              {summary.failedCleanupCount > 0
                ? t('newChat.workspaceCleanup.statIdleAndFailed', {
                    idle: summary.idleWorktreeCount,
                    failed: summary.failedCleanupCount,
                  })
                : summary.activeWorktreeCount > 0
                  ? t('newChat.workspaceCleanup.statActiveProtected', {
                      count: summary.activeWorktreeCount,
                    })
                  : t('newChat.workspaceCleanup.statIdleOnly', {
                      count: summary.idleWorktreeCount,
                    })}
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="text-11 font-semibold text-[var(--text-secondary)]">
            {t('newChat.workspaceCleanup.scopesTitle')}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ['merged', t('newChat.workspaceCleanup.scopeMerged')],
                ['worktrees', t('newChat.workspaceCleanup.scopeWorktrees')],
                ['unpushed', t('newChat.workspaceCleanup.scopeUnpushed')],
              ] as const
            ).map(([key, label]) => {
              const active = scopes[key];
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleScope(key)}
                  className={cn(
                    'inline-flex h-[26px] cursor-pointer items-center gap-1 rounded-full border px-2.5 text-11 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                    active
                      ? 'border-[var(--text-tertiary)] bg-[var(--surface-chip)] text-[var(--text-primary)]'
                      : 'border-[var(--border-default)] bg-[var(--surface)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
                  )}
                >
                  {active && <Check size={11} strokeWidth={2.4} aria-hidden />}
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-start gap-1.5 text-10 leading-[1.45] text-[var(--text-tertiary)]">
          <Info size={12} aria-hidden className="mt-0.5 shrink-0" />
          <span>{t('newChat.workspaceCleanup.mainRepoNote')}</span>
        </div>

        <div className="flex flex-col gap-1.5 pt-0.5">
          <Button
            data-testid="start-ai-cleanup-btn"
            variant="primary"
            size="sm"
            className="w-full justify-center rounded-full"
            onClick={() => onStartCleanup(scopes)}
          >
            <Sparkles size={13} aria-hidden />
            <span>{t('newChat.workspaceCleanup.startAuditAction')}</span>
          </Button>
          {showRedDot && (
            <button
              type="button"
              data-testid="snooze-cleanup-red-dot-btn"
              onClick={onSnoozeRedDot}
              className="h-7 w-full cursor-pointer rounded-full text-11 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              {t('newChat.workspaceCleanup.snooze7Days')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
