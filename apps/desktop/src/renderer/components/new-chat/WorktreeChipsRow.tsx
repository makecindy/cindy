import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
/**
 * WorktreeChipsRow — folder chip + [分支 │ ☑ worktree] 联合控件。
 *
 * 2026-07(分支外显,Codex 风格)把 Branch 从齿轮 popover 提到独立 chip;
 * 2026-07-28 把 worktree 开关提为一级勾选 chip、齿轮 Advanced popover 移除;
 * 2026-07-29 用户裁决(对齐 Claude Code):分支与 worktree 合并为**一个** pill——
 * 左半分支区、竖分隔线、右半 checkbox + "worktree",两个点击区各管各的。
 *
 * 状态不变量:**勾选状态只属于用户**——
 *   - 系统/环境因素(切项目、探测结果、播种)永远不改 checkbox;资格不满足只是
 *     在 OFF 时禁用开启;
 *   - 用户点击 checkbox 本体或显式「改用 worktree」按钮，写入同一勾选记忆;
 *   - 未勾时分支选择只切换主目录；已勾时才写源分支记忆，不联动 checkbox。
 *
 * 2026-08-07 用户裁决(取代 2026-07-29「已 ON 保留关闭入口 + fail-closed」形态):
 * 勾选记忆**只对具备 worktree 资格的目录生效**——
 *   - 探测成功且确认不合格(非 git 仓库 / git 未安装 / 已在 worktree 内)时整条控件
 *     隐藏,发送侧按普通会话放行;记忆本身保留不动,回到合格目录自动恢复;
 *   - 探测进行中 / 探测失败(断线、老端通道缺失等)时**不算**确认不合格:已 ON 则
 *     照旧显示并由上层 fail closed 拦截——一次弱网不能把用户要求的隔离静默降级。
 * 两种状态的区分经 onConfirmedIneligibleChange 上报(null = 尚未确认)。
 *
 * worktree 名称 **自动生成**（不暴露 UI），由 useSuggestName 拉取后透传给上层。
 */

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  useId,
  type KeyboardEvent,
} from 'react';
import {
  GitBranch,
  ChevronDown,
  Folder,
  MessageCircle,
  Search,
  RefreshCw,
  Check,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tip, Tooltip } from '@/components/ui/tooltip';
import { Spinner } from '@/components/ui/spinner';
import {
  FolderPickerPopover,
  addRecentFolder,
  type FolderPickerOption,
  type FolderPickerSelectSource,
} from './FolderPickerPopover';
import { useBranchSync } from '@/hooks/useBranchSync';
import { resolveBranchPick } from './branchPick';
import { useCheckout } from '@/hooks/useCheckout';
import {
  CheckoutError,
  CheckoutNotice,
  CheckoutDialog,
  CheckoutStashes,
  CheckoutSessions,
} from './CheckoutFeedback';
import type { ReactNode } from 'react';
import { useBranches, useDetectCwd, useSuggestName } from '@/hooks/useWorktreeQueries';
import { getProjectPickerDisplayName } from '@/hooks/useProjectPickerOptions';

export type FolderPickerMode = 'folder' | 'project';

/** Derived for display/creation only; never persisted as a source preference. */
export interface WorktreeDefaultSource {
  baseRepo: string | null;
  deviceId: string | null;
  sourceBranch: string;
}

/** The exact OFF label and its scoped refresh, shared with the explicit-start check. */
export interface CheckoutBranchView {
  cwd: string | null;
  deviceId: string | null;
  displayedBranch: string;
  refresh: () => void;
}

export interface WorktreeChipsRowProps {
  cwd: string | null;
  // 接受 null:当 picker 选了"对话(不在项目中)"时,上游需要清掉 workingDir
  // 让 send 流程按 workspaceKind='dialogue' 走。
  onSelectFolder?: (folderPath: string | null) => void;
  folderPickerOpen?: boolean;
  onFolderPickerOpenChange?: (open: boolean) => void;
  folderPickerMode?: FolderPickerMode;
  projectOptions?: readonly FolderPickerOption[];
  /** Phase D — 添加远程项目入口的回调; 上层在 hasAnyAutoConnectHost 为 true
   *  时才传, 透传给 FolderPickerPopover 决定是否渲染按钮。 */
  onAddRemoteProject?: () => void;
  emptyProjectLabel?: string;
  enabled: boolean;
  /**
   * 用户点击 checkbox 或显式「改用 worktree」按钮,上层必持久化
   * (写工作端勾选记忆)。系统任何路径都不得调用它替用户翻状态。
   */
  onEnabledChange: (v: boolean) => void;
  sourceBranch: string;
  onSourceBranchChange: (v: string) => void;
  onDefaultSourceBranchChange?: (value: WorktreeDefaultSource) => void;
  onCheckoutBranchViewChange?: (value: CheckoutBranchView | null) => void;
  onCheckoutBusyChange?: (busy: boolean) => void;
  onBaseRepoChange?: (baseRepo: string | null) => void;
  /**
   * 被控端是否支持 recoveryKey 预创建回收。null 表示当前探测结果尚未就绪；
   * 上层发送侧必须把非 true 视为不具备该能力。
   */
  onRecoveryKeyDiscardSupportChange?: (supported: boolean | null) => void;
  /**
   * 探测**成功**且确认目录不具备 worktree 资格(非 git 仓库 / git 未安装 / 已在
   * worktree 内)时为 true;null = 探测中或探测失败(未确认,上层必须维持 fail
   * closed)。true 时上层发送门放行普通会话——勾选记忆只对合格目录生效。
   */
  onConfirmedIneligibleChange?: (confirmed: boolean | null) => void;
  onSuggestedNameChange?: (name: string) => void;
  worktreeDisabled?: boolean;
  /** Shared creation/environment gate for both halves of the joined control. */
  disabled?: boolean;
  /** Branch preference read/write gate; must not disable the checkbox half. */
  branchDisabled?: boolean;
  /** Checkbox preference write gate; must not disable the branch half. */
  checkboxDisabled?: boolean;
  /**
   * device-link 被控端 deviceId。非空表示 cwd 是被控端路径,git 探测 / 分支列表 /
   * 建议名全部经隧道在被控端执行(本机 git 对远程路径必然误报"不是 git 仓库")。
   */
  deviceLinkDeviceId?: string | null;
  /**
   * relay 或目标设备重连代次。变化时重试远端 git 资格探测，避免一次断线
   * 或超时把 worktree 资格永久缓存成不可用。
   */
  deviceLinkReconnectEpoch?: number;
  /**
   * 渲染变体(2026-07-19 恢复 worktree 入口):统一创建页对齐 Figma 后项目选择
   * 由页面自己的 mode pill 承担,'advancedOnly' 只渲染 [分支 chip][worktree chip]
   * (git 探测/分支/建议名逻辑全保留);缺省 'full' = folder chip + 两 chip 原样。
   */
  variant?: 'full' | 'advancedOnly';
  /** true → 齿轮走 30px 紧凑版 + create-agent 控件 token,与新建页 mode pill 同排对齐。 */
  compact?: boolean;
}

export function WorktreeChipsRow({
  cwd,
  onSelectFolder,
  folderPickerOpen,
  onFolderPickerOpenChange,
  folderPickerMode = 'folder',
  projectOptions,
  onAddRemoteProject,
  emptyProjectLabel,
  enabled,
  onEnabledChange,
  sourceBranch,
  onSourceBranchChange,
  onDefaultSourceBranchChange,
  onCheckoutBusyChange,
  onCheckoutBranchViewChange,
  onBaseRepoChange,
  onRecoveryKeyDiscardSupportChange,
  onConfirmedIneligibleChange,
  onSuggestedNameChange,
  worktreeDisabled,
  disabled,
  branchDisabled,
  checkboxDisabled,
  deviceLinkDeviceId,
  deviceLinkReconnectEpoch = 0,
  variant = 'full',
  compact = false,
}: WorktreeChipsRowProps) {
  const { t } = useTranslation();
  // 统一创建页的 project-picker 模式下, cwd 为空表示即将创建纯对话。
  // worktree/branch 依赖真实项目目录,这里隐藏 Advanced 并清掉残留状态。
  const advancedHidden = folderPickerMode === 'project' && !cwd;
  const [branchCheckEpoch, setBranchCheckEpoch] = useState(0);
  const detect = useDetectCwd(
    worktreeDisabled ? null : (cwd ?? null),
    deviceLinkDeviceId,
    deviceLinkReconnectEpoch + branchCheckEpoch,
  );
  // 探测成功且三种资格(已装 git / 是 git 仓库 / 未嵌套)同时满足为 true;
  // detect.data 未到达(探测中/失败)时为 null——与「确认不合格」不同,后者必须
  // fail closed。baseRepo 与 confirmedIneligible 皆从此派生,保证两处使用同一条件。
  const gitEligible: boolean | null = detect.data
    ? detect.data.gitInstalled && detect.data.isGitRepo && !detect.data.isInsideWorktree
    : null;
  const baseRepo = gitEligible ? (detect.data!.repoRoot ?? null) : null;
  const confirmedIneligible: boolean | null = detect.data ? !gitEligible : null;

  // 只有明确具备 worktree 资格的仓库才向发送侧提供 repoRoot。发送 / Goal 的 ON 门
  // 据此 fail closed，不能静默降级。useDetectCwd 同时按 {cwd, deviceId} 做 render
  // 阶段 fence，切目标时这里先写 null。
  useLayoutEffect(() => {
    onBaseRepoChange?.(baseRepo);
    onRecoveryKeyDiscardSupportChange?.(
      detect.data ? detect.data.supportsRecoveryKeyDiscard === true : null,
    );
    onConfirmedIneligibleChange?.(confirmedIneligible);
  }, [
    baseRepo,
    detect.data,
    // confirmedIneligible 从 detect.data 纯派生，同一 render 下与 detect.data 同步变化；
    // 保留仅满足 exhaustive-deps lint，运行时不会独立触发此 effect。
    confirmedIneligible,
    onBaseRepoChange,
    onRecoveryKeyDiscardSupportChange,
    onConfirmedIneligibleChange,
  ]);

  const cantUseReason = useMemo<string | null>(() => {
    if (detect.loading) return t('newChat.worktree.detecting');
    if (!detect.data) {
      // 探测失败(非 loading 且无回包):与「确认非 git」不同,这里维持 fail closed,
      // 控件保留、给出失败原因,不能让一次断线看起来像"目录不合格被隐藏"。
      // worktreeDisabled 时根本没发起探测(hook 收到 null),不属于失败。
      return cwd && !worktreeDisabled ? t('newChat.worktree.detectFailed') : null;
    }
    const d = detect.data;
    if (!d.gitInstalled) return t('newChat.worktree.gitMissing');
    if (!d.isGitRepo) return t('newChat.worktree.notGitRepo');
    // 2026-08-07 裁决:isInsideWorktree 时 confirmedIneligible=true → 整条控件隐藏,
    // 此分支的 tooltip 当前不可达,但保留以解耦 cantUseReason 与控件显隐逻辑。
    if (d.isInsideWorktree) return t('newChat.worktree.alreadyInWorktree');
    return null;
  }, [cwd, detect.data, detect.loading, t, worktreeDisabled]);

  const environmentDisabled =
    worktreeDisabled || !!cantUseReason || detect.loading || !cwd || baseRepo === null;
  const switchDisabled = disabled || checkboxDisabled || (environmentDisabled && !enabled);

  // 状态不变量:这里**没有**任何自动改写 enabled 的 effect——勾选状态只属于用户,
  // 资格不满足时 OFF 不能开启；已 ON 必须仍能显式关闭，发送侧同时保留输入并阻塞创建。

  const effectiveWorktreeEnabled = enabled && !advancedHidden && !worktreeDisabled;
  // 分支列表懒加载 latch:worktree 未开时不预拉,首次点开分支 chip 菜单才拉,
  // 之后保持订阅(baseRepo 变化由 hook 自身依赖触发重拉)。
  const [branchListWanted, setBranchListWanted] = useState(false);
  const branches = useBranches(
    effectiveWorktreeEnabled || branchListWanted ? baseRepo : null,
    deviceLinkDeviceId,
  );
  const suggested = useSuggestName(effectiveWorktreeEnabled ? baseRepo : null, deviceLinkDeviceId);

  const lastNameRef = useRef('');
  useEffect(() => {
    if (!effectiveWorktreeEnabled) {
      lastNameRef.current = '';
      onSuggestedNameChange?.('');
      return;
    }
    if (suggested.name && suggested.name !== lastNameRef.current) {
      lastNameRef.current = suggested.name;
      onSuggestedNameChange?.(suggested.name);
    }
  }, [effectiveWorktreeEnabled, suggested.name, onSuggestedNameChange]);

  const folderBasename = useMemo(
    () => getProjectPickerDisplayName(cwd, projectOptions),
    [cwd, projectOptions],
  );

  // project 模式下 cwd 为空就是"对话"默认上下文,但 chip 仍可打开 picker
  // 切到项目;folder 模式保留原来的"选择文件夹"语义。
  const folderSelectLabel =
    folderPickerMode === 'project' && !cwd
      ? (emptyProjectLabel ?? t('newChat.folderPicker.dialogue'))
      : folderPickerMode === 'project'
        ? t('newChat.folderPicker.selectProject')
        : t('newChat.folderPicker.selectFolder');

  // ── 分支 chip 状态 ──
  const currentBranch = detect.data?.currentBranch ?? null;
  const checkout = useCheckout(
    baseRepo,
    deviceLinkDeviceId,
    detect.data?.supportsCheckout === true,
    onCheckoutBusyChange,
    !effectiveWorktreeEnabled && !environmentDisabled && !advancedHidden,
  );
  const actualBranch = checkout.status
    ? checkout.status.current === checkout.status.head
      ? 'HEAD'
      : checkout.status.current
    : branches.current || currentBranch || 'HEAD';
  const refreshDisplayedBranch = useCallback(() => {
    if (detect.data?.supportsCheckout) {
      void checkout.refresh();
    } else {
      // Older controlled computers have no checkout status. Refresh their
      // existing probe (and the branch list only if it was already requested).
      setBranchCheckEpoch((epoch) => epoch + 1);
      if (branchListWanted) branches.refetch();
    }
  }, [detect.data?.supportsCheckout, checkout.refresh, branchListWanted, branches.refetch]);
  useLayoutEffect(() => {
    onCheckoutBranchViewChange?.({
      cwd,
      deviceId: deviceLinkDeviceId ?? null,
      displayedBranch: actualBranch,
      refresh: refreshDisplayedBranch,
    });
    return () => onCheckoutBranchViewChange?.(null);
  }, [cwd, deviceLinkDeviceId, actualBranch, refreshDisplayedBranch, onCheckoutBranchViewChange]);

  const defaultSourceBranch = branches.loading
    ? ''
    : branches.remoteDefaultBranch ||
      (branches.branches.includes('main')
        ? 'main'
        : branches.branches.includes('master')
          ? 'master'
          : actualBranch);
  useLayoutEffect(() => {
    onDefaultSourceBranchChange?.({
      baseRepo,
      deviceId: deviceLinkDeviceId ?? null,
      sourceBranch: baseRepo ? defaultSourceBranch : '',
    });
  }, [baseRepo, deviceLinkDeviceId, defaultSourceBranch, onDefaultSourceBranchChange]);
  const branchLabel = effectiveWorktreeEnabled
    ? sourceBranch || defaultSourceBranch || actualBranch
    : actualBranch;
  // 确认不合格(2026-08-07 裁决)→ 整条控件隐藏,勾选记忆保留、发送侧放行普通会话;
  // 探测中/失败(confirmedIneligible === null)时已 ON 仍显示,由上层 fail closed。
  const showBranchChip =
    !advancedHidden && confirmedIneligible !== true && (enabled || !!detect.data?.isGitRepo);
  // 分支选择与 checkbox 是两条独立轴；仅环境不具备 worktree 资格或创建在途时禁用。
  const branchInteractive =
    !(disabled || branchDisabled || environmentDisabled || checkout.busy) &&
    baseRepo !== null &&
    (effectiveWorktreeEnabled || detect.data?.supportsCheckout === true);

  const handleBranchPick = useCallback(
    (picked: string) => {
      const effect = resolveBranchPick(
        { worktreeEnabled: effectiveWorktreeEnabled, currentBranch: actualBranch, sourceBranch },
        picked,
      );
      if (effect.kind === 'set-source') onSourceBranchChange(effect.branch);
      if (effect.kind === 'checkout') void checkout.pick(effect.branch);
    },
    [effectiveWorktreeEnabled, actualBranch, sourceBranch, onSourceBranchChange, checkout.pick],
  );

  const canUseWorktree =
    !switchDisabled && !environmentDisabled && !effectiveWorktreeEnabled && !checkout.busy;
  const useWorktree = (branch?: string) => {
    if (branch) onSourceBranchChange(branch);
    onEnabledChange(true);
    checkout.usedWorktree();
  };
  const menuStatus = !effectiveWorktreeEnabled ? checkout.status : undefined;
  const branchWorktree = showBranchChip ? (
    <>
      <div className="min-w-0">
        <BranchWorktreeChip
          baseRepo={baseRepo ?? undefined}
          deviceId={deviceLinkDeviceId}
          remoteDefaultBranch={branches.remoteDefaultBranch}
          branchLabel={branchLabel}
          branches={branches.branches}
          branchesLoading={branches.loading}
          branchesFailed={branches.failed}
          onRetryBranches={branches.refetch}
          checked={enabled}
          branchSourceSelected={effectiveWorktreeEnabled && !!sourceBranch}
          branchInteractive={branchInteractive}
          checkoutBusy={checkout.busy}
          checkboxDisabled={switchDisabled || checkout.busy}
          cantUseReason={cantUseReason ?? undefined}
          onPick={handleBranchPick}
          onOpenRequested={() => {
            void checkout.refresh();
            setBranchListWanted(true);
            branches.refetch();
            // 上次拉取失败的话,重新打开菜单就自动重试一次,不逼用户去点重试项。
            if (branches.failed && !branches.loading) branches.refetch();
          }}
          onToggle={onEnabledChange}
          optionDisabledReason={
            effectiveWorktreeEnabled
              ? undefined
              : (branch) => {
                  if (branch === actualBranch) return undefined;
                  if (!menuStatus) return t('newChat.worktree.detecting');
                  if (menuStatus.blocked === 'busy' || menuStatus.blocked === 'operation')
                    return t(`newChat.checkout.errors.${menuStatus.blocked}`);
                  return undefined;
                }
          }
          currentBranchRunning={
            !effectiveWorktreeEnabled &&
            menuStatus?.blocked === 'busy' &&
            menuStatus.sessions.some((s) => s.running)
          }
          menuHeader={
            <>
              <CheckoutStashes checkout={checkout} />
              {!effectiveWorktreeEnabled && menuStatus && (
                <>
                  {(menuStatus.blocked === 'busy' && menuStatus.sessions.some((s) => s.running)) ||
                  !menuStatus.blocked ? (
                    <CheckoutSessions
                      status={menuStatus}
                      onUseWorktree={canUseWorktree ? () => useWorktree() : undefined}
                    />
                  ) : (
                    menuStatus.blocked !== 'occupied' && (
                      <CheckoutNotice
                        warning
                        action={
                          canUseWorktree &&
                          (menuStatus.blocked === 'busy' || !!menuStatus.sessions.length) ? (
                            <Button
                              compact
                              size="sm"
                              variant="secondary"
                              onClick={() => useWorktree()}
                            >
                              {t('newChat.checkout.useWorktree')}
                            </Button>
                          ) : undefined
                        }
                      >
                        <CheckoutError code={menuStatus.blocked} status={menuStatus} />
                        {canUseWorktree &&
                          (menuStatus.blocked === 'busy' || !!menuStatus.sessions.length) && (
                            <p className="mt-1 text-muted-foreground">
                              {t('newChat.worktree.chipTooltip')}
                            </p>
                          )}
                      </CheckoutNotice>
                    )
                  )}
                </>
              )}
            </>
          }
          compact={compact}
        />
      </div>
      <CheckoutDialog
        checkout={checkout}
        onUseWorktree={canUseWorktree ? useWorktree : undefined}
      />
    </>
  ) : null;

  // advancedOnly:项目选择交给页面自己的 pill,这里出 [分支 │ ☑ worktree] 联合控件
  // (cwd 为空时不渲染；环境失效但记忆仍 ON 时保留关闭入口)。
  if (variant === 'advancedOnly') {
    if (advancedHidden) return null;
    return branchWorktree;
  }

  return (
    <div className="inline-flex items-center gap-2">
      <FolderChipBig
        folderName={folderBasename}
        selectLabel={folderSelectLabel}
        folderPickerMode={folderPickerMode}
        projectOptions={projectOptions}
        onAddRemoteProject={onAddRemoteProject}
        cwd={cwd}
        onSelect={(path, source) => {
          // "对话(不在项目中)" 入口:把 cwd 清掉,上游按 workspaceKind='dialogue'
          // 走 send 流程;不写 recent(它不是个真目录)。
          if (source === 'dialogue') {
            onSelectFolder?.(null);
            return;
          }
          if (source !== 'project') addRecentFolder(path);
          onSelectFolder?.(path);
        }}
        open={folderPickerOpen}
        onOpenChange={onFolderPickerOpenChange}
        disabled={disabled}
      />
      {branchWorktree}
    </div>
  );
}

// ── 主操作：folder chip（42px 大 chip） ──────────────────────

function FolderChipBig({
  folderName,
  selectLabel,
  folderPickerMode,
  projectOptions,
  onAddRemoteProject,
  cwd,
  onSelect,
  open,
  onOpenChange,
  disabled,
}: {
  folderName: string | null;
  selectLabel: string;
  folderPickerMode: FolderPickerMode;
  projectOptions?: readonly FolderPickerOption[];
  onAddRemoteProject?: () => void;
  cwd: string | null;
  onSelect: (path: string, source: FolderPickerSelectSource) => void;
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  disabled?: boolean;
}) {
  const [suppressTooltip, setSuppressTooltip] = useState(false);
  const suppressTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (suppressTimerRef.current !== null) window.clearTimeout(suppressTimerRef.current);
    };
  }, []);

  const handleSelect = useCallback(
    (path: string, source: FolderPickerSelectSource) => {
      onSelect(path, source);
      setSuppressTooltip(true);
      if (suppressTimerRef.current !== null) window.clearTimeout(suppressTimerRef.current);
      suppressTimerRef.current = window.setTimeout(() => {
        suppressTimerRef.current = null;
        setSuppressTooltip(false);
      }, 700);
    },
    [onSelect],
  );

  return (
    <FolderPickerPopover
      open={open ?? false}
      onOpenChange={onOpenChange ?? (() => {})}
      onSelect={handleSelect}
      projectOptions={folderPickerMode === 'project' ? (projectOptions ?? []) : undefined}
      onAddRemoteProject={folderPickerMode === 'project' ? onAddRemoteProject : undefined}
    >
      <Tip text={cwd ?? null} mono disabled={suppressTooltip}>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'inline-flex h-[42px] items-center gap-2.5 rounded-full',
            'border border-border bg-[var(--chat-input-bg)] px-[18px]',
            'text-14 font-medium text-foreground',
            'transition-colors hover:bg-sidebar-item-hover',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
          aria-label={selectLabel}
        >
          {folderPickerMode === 'project' && !cwd ? (
            <MessageCircle size={15} className="shrink-0" />
          ) : (
            <Folder size={15} className="shrink-0" />
          )}
          {/* project 模式占位 label "对话"(CJK)视觉重心比 icon 偏高,nudge 1px
              居中;选中项目后(cwd 有值)项目名多为英文/混排,保持默认基线。 */}
          <span
            className={cn(
              'truncate max-w-[240px]',
              folderPickerMode === 'project' && !cwd && 'relative top-px',
            )}
          >
            {folderName ?? selectLabel}
          </span>
          <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
        </button>
      </Tip>
    </FolderPickerPopover>
  );
}

// ── [分支 │ ☑ worktree] 联合控件(对齐 Claude Code,2026-07-29 用户裁决) ──────

export function BranchWorktreeChip({
  baseRepo,
  deviceId,
  remoteDefaultBranch,
  branchLabel,
  branchDisplayLabel = branchLabel.replace(/^refs\/remotes\//, ''),
  branchOnly = false,
  branches,
  branchesLoading,
  branchesFailed,
  onRetryBranches,
  checked,
  branchSourceSelected,
  branchInteractive,
  checkoutBusy = false,
  checkboxDisabled,
  cantUseReason,
  onPick,
  onOpenRequested,
  onToggle,
  compact,
  menuHeader,
  currentBranchRunning,
  optionDisabledReason,
}: {
  menuHeader?: ReactNode;
  currentBranchRunning?: boolean;
  optionDisabledReason?: (branch: string) => string | undefined;
  baseRepo?: string;
  deviceId?: string | null;
  remoteDefaultBranch?: string;
  branchLabel: string;
  /** Display text only; branchLabel remains the selection value. */
  branchDisplayLabel?: string;
  branchOnly?: boolean;
  branches: string[];
  branchesLoading: boolean;
  /** 上次分支列表请求失败(区分于"仓库没分支"),菜单给重试入口。 */
  branchesFailed: boolean;
  onRetryBranches: () => void;
  /** worktree 勾选状态(工作端记忆原样直出;禁用时也照常显示,不做视觉造假)。 */
  checked: boolean;
  /** 用户是否已经显式选择过源分支(用于区分 tooltip 与首次展示的当前 HEAD)。 */
  branchSourceSelected: boolean;
  /** 分支菜单是否可开(与 checkbox 状态独立)。 */
  branchInteractive: boolean;
  /** Preserve the chevron slot while checkout temporarily disables the menu. */
  checkoutBusy?: boolean;
  checkboxDisabled?: boolean;
  cantUseReason?: string;
  onPick: (branch: string) => void;
  /** 菜单打开时刷新分支列表和切换资格。 */
  onOpenRequested: () => void;
  /** checkbox 与显式「改用 worktree」按钮共用的偏好写入路径。 */
  onToggle: (v: boolean) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();

  const sync = useBranchSync(baseRepo, branchLabel, deviceId);
  const allBranches = useMemo(
    () => (remoteDefaultBranch ? [remoteDefaultBranch, ...branches] : branches),
    [checked, branchOnly, remoteDefaultBranch, branches],
  );
  const displayBranch = (value: string) =>
    value === remoteDefaultBranch ? value.replace(/^refs\/remotes\//, '') : value;
  const syncDisabled = sync.disabled || checkoutBusy;

  // 分支菜单内搜索词(2026-08-20 用户裁决:对齐 Codex 分支选择器,菜单顶部加搜索框)。
  // 菜单关闭即清空——搜索只是本次挑选的临时过滤,不是需要记忆的偏好。
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState('');
  const normalizedBranchQuery = branchQuery.trim().toLowerCase();
  const visibleBranches = normalizedBranchQuery
    ? allBranches.filter((b) => displayBranch(b).toLowerCase().includes(normalizedBranchQuery))
    : allBranches;

  // 组合框键盘导航(2026-09-08 Codex review:改用 aria-activedescendant 组合框结构):
  // 焦点始终留在输入框,方向键只移动高亮项,Enter 选中高亮项——不再依赖菜单
  // typeahead 或焦点冒泡,可打印字符输入与选项导航各走各的,互不干扰。
  const [activeBranchIndex, setActiveBranchIndex] = useState(0);
  const listboxId = useId();
  const listboxRef = useRef<HTMLDivElement>(null);
  // Refreshes must not steal keyboard focus from the menu's existing actions.
  const focusBranchSearch = useCallback((el: HTMLInputElement | null) => {
    el?.focus({ preventScroll: true });
  }, []);
  const noticesRef = useRef<HTMLDivElement>(null);
  const autoLocate = useRef(true);
  const keyboardLocate = useRef(false);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  // 过滤后列表可能变短,钳住下标避免指向已不可见的项;空列表用 -1 表示无高亮。
  const clampedActiveIndex =
    visibleBranches.length === 0 ? -1 : Math.min(activeBranchIndex, visibleBranches.length - 1);

  const revealBranch = useCallback((index: number) => {
    const list = listboxRef.current;
    const option = optionRefs.current[index];
    if (!list || !option) return;
    const viewport = list.getBoundingClientRect();
    const row = option.getBoundingClientRect();
    // Nearest-edge scrolling limited to the list, never the surrounding page.
    if (row.top < viewport.top) list.scrollTop -= viewport.top - row.top;
    else if (row.bottom > viewport.bottom) list.scrollTop += row.bottom - viewport.bottom;
  }, []);

  useEffect(() => {
    if (!branchMenuOpen || branchesLoading || branchesFailed) return;
    let frame: number;
    const locate = () => {
      if (autoLocate.current) revealBranch(allBranches.indexOf(branchLabel));
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(locate);
    });
    // The portal, notices and available-height constraint can settle in separate
    // layouts. Keep watching until the user takes over, with no fixed delay.
    frame = requestAnimationFrame(() => {
      const list = listboxRef.current;
      if (!list) return;
      observer.observe(list);
      if (noticesRef.current) observer.observe(noticesRef.current);
      for (const group of list.querySelectorAll('[role="group"]')) observer.observe(group);
      locate();
    });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [branchMenuOpen, branchesLoading, branchesFailed, allBranches, branchLabel, revealBranch]);

  // Explicit keyboard navigation continues to reveal its highlighted option,
  // even after automatic positioning of the current branch has been cancelled.
  useEffect(() => {
    if (!branchMenuOpen || !keyboardLocate.current) return;
    const frame = requestAnimationFrame(() => {
      keyboardLocate.current = false;
      revealBranch(clampedActiveIndex);
    });
    return () => cancelAnimationFrame(frame);
  }, [branchMenuOpen, clampedActiveIndex, revealBranch]);

  // 打开菜单、或菜单开着时分支列表异步到达/刷新,都要把高亮重新定位到当前源
  // 分支——不能依赖 branches 数组里恰好排第几位(该接口不保证顺序,参见
  // WorktreeManager.listBranches 用的是 `git branch` 默认序)。只在用户还没
  // 输入搜索词时接管,避免打断已经在筛选/用方向键挑选的操作。
  useEffect(() => {
    if (!branchMenuOpen || !autoLocate.current || normalizedBranchQuery) return;
    const current = allBranches.indexOf(branchLabel);
    setActiveBranchIndex(current >= 0 ? current : 0);
  }, [branchMenuOpen, allBranches, branchLabel, normalizedBranchQuery]);

  const pickBranch = (branch: string) => {
    if (optionDisabledReason?.(branch)) return;
    onPick(branch);
    setBranchMenuOpen(false);
    setBranchQuery('');
  };

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // IME 组合中的键击属于候选词编辑:导航/Enter 不应触发选择。
    // (组合中的 Escape 不关弹层由 PopoverContent 的 onEscapeKeyDown 拦截——
    // Radix 的 Escape 监听在 document 捕获阶段,这里的 stopPropagation 拦不住。)
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      // Home/End 不拦截:焦点有意留在可编辑输入框里(combobox 模式),这两个键要
      // 保留原生的"光标跳行首/行尾"文本编辑行为;只有方向键才用于选项导航
      // (对齐仓库里唯一同构的先例 LoginPage.tsx 的 SSO 组织历史下拉,同样没有
      // 拦截 Home/End)。
      case 'ArrowDown':
      case 'ArrowUp': {
        autoLocate.current = false;
        keyboardLocate.current = true;
        e.preventDefault();
        if (clampedActiveIndex < 0) return;
        setActiveBranchIndex(
          e.key === 'ArrowDown'
            ? (clampedActiveIndex + 1) % visibleBranches.length
            : (clampedActiveIndex - 1 + visibleBranches.length) % visibleBranches.length,
        );
        return;
      }
      case 'Enter': {
        if (clampedActiveIndex < 0) return;
        e.preventDefault();
        pickBranch(visibleBranches[clampedActiveIndex]);
        return;
      }
      default:
        // Escape 及其余键照常冒泡:Escape 由 Radix Popover 关闭弹层并把焦点还给 trigger。
        break;
    }
  };

  const branchSegment = (
    <button
      type="button"
      aria-disabled={!branchInteractive}
      aria-busy={checkoutBusy || undefined}
      tabIndex={branchInteractive ? 0 : -1}
      data-testid="create-agent-branch-chip"
      className={cn(
        'inline-flex h-full min-w-0 items-center transition-colors',
        // 只读态不弹菜单但也不该像 disabled 一样淡出 —— 分支信息本身是有效展示。
        !branchInteractive && 'cursor-default',
        compact
          ? 'max-w-[180px] gap-1.5 pl-3 pr-2 text-12 font-medium leading-[1.167]'
          : 'max-w-[220px] gap-2.5 pl-[18px] pr-2.5 text-14 font-medium',
        branchInteractive &&
          (compact
            ? 'hover:bg-[var(--create-agent-control-bg-hover)] active:bg-[var(--create-agent-control-bg-pressed)]'
            : 'hover:bg-sidebar-item-hover'),
        // 勾选时主色提示与容器边框呼应:一眼看出"这是隔离启动的源分支"。
        checked && 'text-primary',
        checked && branchInteractive && 'hover:bg-primary/10',
      )}
      aria-label={t('newChat.branchChip.label')}
    >
      <GitBranch size={compact ? 12 : 15} className="shrink-0" />
      <span className="min-w-0 truncate" title={branchDisplayLabel}>
        {branchDisplayLabel}
      </span>
      {checkoutBusy ? (
        <Spinner
          size={12}
          aria-hidden
          className={checked ? 'text-primary' : 'text-muted-foreground'}
        />
      ) : branchInteractive ? (
        <ChevronDown
          size={12}
          className={cn('shrink-0', checked ? 'text-primary' : 'text-muted-foreground')}
        />
      ) : null}
    </button>
  );

  const branchTipped = (
    <Tip
      text={
        checked || branchSourceSelected
          ? t('newChat.branchChip.sourceTooltip')
          : t('newChat.branchChip.currentTooltip')
      }
    >
      {branchSegment}
    </Tip>
  );

  const branchArea = branchInteractive ? (
    <Popover
      open={branchMenuOpen}
      onOpenChange={(open) => {
        setBranchMenuOpen(open);
        if (open) {
          autoLocate.current = true;
          keyboardLocate.current = false;
          onOpenRequested();
          void sync.refresh();
          // 高亮定位交给上面的 useEffect(依赖 branches,分支异步到达/刷新时
          // 会自动重新定位到当前源分支,不再只在“打开那一刻”算一次)。
        } else {
          setBranchQuery('');
        }
      }}
    >
      <PopoverTrigger asChild>{branchTipped}</PopoverTrigger>
      <PopoverContent
        style={WINDOW_NO_DRAG_STYLE}
        align="end"
        sideOffset={4}
        // IME 组合中的 Escape 只是取消候选,不能关弹层(CJK 高频路径)。
        // 注意 Radix 的 Escape 监听挂在 document 捕获阶段,在输入框里
        // stopPropagation 拦不住它,必须在 onEscapeKeyDown 里 preventDefault。
        onEscapeKeyDown={(e) => {
          if (e.isComposing) e.preventDefault();
        }}
        className="flex max-h-[min(480px,var(--radix-popover-content-available-height))] flex-col w-auto min-w-[min(280px,calc(100vw-32px))] max-w-[min(360px,calc(100vw-32px))] overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-[shadow:var(--shadow-menu)]"
      >
        <div ref={noticesRef} className="shrink-0" data-testid="checkout-menu-notices">
          {menuHeader}
        </div>
        {branchesLoading ? (
          <div className="px-3 py-1.5 text-13 text-muted-foreground">
            {t('newChat.branchChip.loading')}
          </div>
        ) : branchesFailed || allBranches.length === 0 ? (
          /* 失败与空列表都给重试入口(空列表也可能是隧道/瞬时问题);
             点击不关闭弹层,重试期间留在原地显示 loading。 */
          <button
            type="button"
            onClick={onRetryBranches}
            className={cn(
              'w-full cursor-pointer rounded-[8px] px-3 py-1.5 text-left text-13 text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            )}
          >
            {t('newChat.branchChip.loadFailed')}
          </button>
        ) : (
          <>
            <div className="shrink-0 bg-popover pb-1">
              <div className="relative">
                <Search
                  size={12}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <input
                  ref={focusBranchSearch}
                  role="combobox"
                  aria-expanded
                  aria-autocomplete="list"
                  aria-controls={listboxId}
                  aria-activedescendant={
                    clampedActiveIndex >= 0
                      ? `${listboxId}-option-${clampedActiveIndex}`
                      : undefined
                  }
                  value={branchQuery}
                  onChange={(e) => {
                    autoLocate.current = false;
                    setBranchQuery(e.target.value);
                    // 过滤集合变了,高亮回到首项,避免停留在已不可见的位置。
                    setActiveBranchIndex(0);
                  }}
                  onKeyDown={onSearchKeyDown}
                  placeholder={t('newChat.branchChip.searchPlaceholder')}
                  aria-label={t('newChat.branchChip.searchPlaceholder')}
                  className={cn(
                    'h-8 w-full rounded-full border border-border bg-transparent',
                    'pl-7 pr-2 text-13 text-foreground outline-none',
                    // DESIGN.md §4 Inputs & Forms:单行 input 一律 pill 圆角;
                    // placeholder 走 --text-placeholder(过浅会像已填写内容);
                    // focus 走 --focus-ring 一对 token(对齐 FileFilterInput)。
                    'placeholder:text-[var(--text-placeholder)]',
                    'focus:border-[var(--focus-ring)] focus:ring-1 focus:ring-[var(--focus-ring-soft)]',
                  )}
                />
              </div>
            </div>
            <div
              ref={listboxRef}
              onWheel={() => {
                autoLocate.current = false;
              }}
              onTouchMove={() => {
                autoLocate.current = false;
              }}
              onPointerDown={() => {
                autoLocate.current = false;
              }}
              className="min-h-0 overflow-y-auto"
              role="listbox"
              id={listboxId}
              aria-label={t('newChat.branchChip.label')}
            >
              {['remote', 'local'].map((group) => {
                const values = visibleBranches.filter(
                  (b) => (b === remoteDefaultBranch) === (group === 'remote'),
                );
                if (!values.length) return null;
                return (
                  <div key={group} role="group" aria-label={t(`newChat.branchSync.${group}Group`)}>
                    {remoteDefaultBranch && (
                      <div className="px-3 py-1 text-12 text-muted-foreground">
                        {t(`newChat.branchSync.${group}Group`)}
                      </div>
                    )}
                    {values.map((b) => {
                      const index = visibleBranches.indexOf(b);
                      return (
                        <div
                          key={b}
                          ref={(el) => {
                            optionRefs.current[index] = el;
                          }}
                          id={`${listboxId}-option-${index}`}
                          role="option"
                          aria-selected={b === branchLabel}
                          aria-disabled={!!optionDisabledReason?.(b)}
                          onMouseMove={() => setActiveBranchIndex(index)}
                          onClick={() => pickBranch(b)}
                          className={cn(
                            'cursor-pointer break-words rounded-[8px] px-3 py-1.5 text-13 text-foreground',
                            optionDisabledReason?.(b) && 'cursor-default opacity-60',
                            index === clampedActiveIndex
                              ? 'bg-accent text-accent-foreground'
                              : b === branchLabel && 'bg-accent/60',
                          )}
                        >
                          {currentBranchRunning && b === branchLabel ? (
                            <span className="flex items-center justify-between gap-2">
                              <span className="min-w-0 break-words">{displayBranch(b)}</span>
                              <span className="shrink-0 text-11 text-[var(--text-tertiary)]">
                                ● {t('newChat.checkout.running')}
                              </span>
                            </span>
                          ) : (
                            displayBranch(b)
                          )}
                          {b === branchLabel && sync.details && (
                            <div className="text-12 text-muted-foreground">{sync.details}</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            {/* 常驻播报区域，让过滤为空时的文本更新可被读屏感知；列表关联始终保留。 */}
            <div
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className={cn(
                'text-13 text-muted-foreground',
                visibleBranches.length === 0 && 'px-3 py-1.5',
              )}
            >
              {visibleBranches.length === 0 ? t('newChat.branchChip.noMatch') : null}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  ) : (
    branchTipped
  );

  const checkboxSegment = (
    <label
      data-testid="create-agent-worktree-chip"
      className={cn(
        'inline-flex h-full items-center transition-colors',
        checkboxDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        compact
          ? 'gap-1.5 pl-2 pr-3 text-12 font-medium leading-[1.167]'
          : 'gap-2.5 pl-2.5 pr-[18px] text-14 font-medium',
        !checkboxDisabled &&
          (compact
            ? 'hover:bg-[var(--create-agent-control-bg-hover)] active:bg-[var(--create-agent-control-bg-pressed)]'
            : 'hover:bg-sidebar-item-hover'),
        checked && 'text-primary',
        checked && !checkboxDisabled && 'hover:bg-primary/10',
      )}
    >
      <Checkbox
        checked={checked}
        disabled={checkboxDisabled}
        onChange={() => onToggle(!checked)}
        aria-label={t('newChat.worktree.toggleAria')}
        className="disabled:opacity-100"
      />
      {/* 术语表裁决:worktree 四语一律保留英文小写原词,故 label 不走 locale 分叉。 */}
      <span>worktree</span>
    </label>
  );

  // 不可用时 tooltip 说明原因;可用时解释语义。禁用只针对 checkbox 半区,
  // 分支信息照常展示——环境不合格不该把整条控件打成灰。
  const checkboxArea =
    checkboxDisabled && cantUseReason ? (
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span className="inline-flex h-full" tabIndex={0}>
            {checkboxSegment}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Content side="top">{cantUseReason}</Tooltip.Content>
      </Tooltip.Root>
    ) : checkboxDisabled ? (
      checkboxSegment
    ) : (
      <Tip
        text={t('newChat.worktree.chipTooltip')}
        contentClassName="max-w-[min(360px,calc(100vw-32px))] break-words"
      >
        {checkboxSegment}
      </Tip>
    );

  return (
    <div
      data-testid="create-agent-branch-worktree"
      style={WINDOW_NO_DRAG_STYLE}
      className={cn(
        'group inline-flex items-stretch overflow-hidden rounded-full border transition-colors',
        compact
          ? 'h-[30px] border-[var(--create-agent-control-border)] bg-[var(--create-agent-control-bg)] text-[var(--create-agent-control-text)]'
          : 'h-[42px] border-border bg-[var(--chat-input-bg)] text-foreground',
        // 勾选时与旧分支 chip 同款主色边框提示。
        checked && 'border-primary/50',
      )}
    >
      {branchArea}
      {sync.visible && (
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <span
              className="inline-flex h-full"
              tabIndex={syncDisabled ? 0 : undefined}
              onMouseEnter={sync.onHover}
              onFocus={sync.onHover}
            >
              <button
                type="button"
                disabled={syncDisabled}
                aria-disabled={syncDisabled}
                aria-label={sync.hint}
                onClick={() => void sync.sync()}
                className={cn(
                  'inline-flex h-full w-8 shrink-0 items-center justify-center text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50',
                  compact
                    ? 'hover:bg-[var(--create-agent-control-bg-hover)] active:bg-[var(--create-agent-control-bg-pressed)]'
                    : 'hover:bg-sidebar-item-hover',
                  branchOnly && 'pr-1',
                )}
              >
                {sync.done ? (
                  <Check size={14} aria-hidden />
                ) : (
                  <Spinner icon={RefreshCw} size={14} spinning={sync.busy} aria-hidden />
                )}
              </button>
            </span>
          </Tooltip.Trigger>
          <Tooltip.Content
            side="top"
            className="max-w-[320px] whitespace-pre-line break-normal [overflow-wrap:anywhere]"
          >
            <div className="space-y-2">
              {sync.hint.split('\n').map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}
            </div>
          </Tooltip.Content>
        </Tooltip.Root>
      )}
      {!branchOnly && (
        <>
          {/* 悬停激活任一半区时分隔线隐去,让 hover 填充看起来是一体的(对齐 Claude Code)。 */}
          <span
            aria-hidden
            className={cn(
              'w-px shrink-0 self-center transition-opacity group-hover:opacity-0',
              compact ? 'h-[14px] bg-[var(--create-agent-control-border)]' : 'h-[18px] bg-border',
            )}
          />
          {checkboxArea}
        </>
      )}
    </div>
  );
}
