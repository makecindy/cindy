/**
 * WorktreeChipsRow — folder chip + 分支 chip + 齿轮(Advanced popover)。
 *
 * 2026-07(分支外显,Codex 风格)在 F1-E Hidden Advanced 基础上把 Branch 从
 * 齿轮 popover 提到独立 chip:
 *   - folder chip 是主操作;分支 chip 常态显示仓库当前 HEAD 分支,
 *     worktree ON 时显示 worktree 源分支(带主色提示,与齿轮同款)
 *   - 点分支 chip 弹分支列表:worktree ON 时改源分支;OFF 时选非当前分支
 *     自动开启 worktree(语义见 branchPick.ts —— 绝不 checkout 用户的 checkout)
 *   - 齿轮 popover 只剩 worktree 开关;关闭 popover 不丢状态,ON 时齿轮带主色
 *
 * worktree 名称 **自动生成**（不暴露 UI），由 useSuggestName 拉取后透传给上层。
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { GitBranch, ChevronDown, Folder, MessageCircle, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tip, Tooltip } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  FolderPickerPopover,
  addRecentFolder,
  type FolderPickerOption,
  type FolderPickerSelectSource,
} from './FolderPickerPopover';
import { resolveBranchPick } from './branchPick';
import { useBranches, useDetectCwd, useSuggestName } from '@/hooks/useWorktreeQueries';
import { getProjectPickerDisplayName } from '@/hooks/useProjectPickerOptions';

export type FolderPickerMode = 'folder' | 'project';

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
  onEnabledChange: (v: boolean) => void;
  sourceBranch: string;
  onSourceBranchChange: (v: string) => void;
  onBaseRepoChange?: (baseRepo: string | null) => void;
  onSuggestedNameChange?: (name: string) => void;
  worktreeDisabled?: boolean;
  disabled?: boolean;
  /**
   * device-link 被控端 deviceId。非空表示 cwd 是被控端路径,git 探测 / 分支列表 /
   * 建议名全部经隧道在被控端执行(本机 git 对远程路径必然误报"不是 git 仓库")。
   */
  deviceLinkDeviceId?: string | null;
  /**
   * 渲染变体(2026-07-19 恢复 worktree 入口):统一创建页对齐 Figma 后项目选择
   * 由页面自己的 mode pill 承担,'advancedOnly' 只渲染齿轮 AdvancedPopover
   * (git 探测/分支/建议名逻辑全保留);缺省 'full' = folder chip + 齿轮原样。
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
  onBaseRepoChange,
  onSuggestedNameChange,
  worktreeDisabled,
  disabled,
  deviceLinkDeviceId,
  variant = 'full',
  compact = false,
}: WorktreeChipsRowProps) {
  const { t } = useTranslation();
  // 统一创建页的 project-picker 模式下, cwd 为空表示即将创建纯对话。
  // worktree/branch 依赖真实项目目录,这里隐藏 Advanced 并清掉残留状态。
  const advancedHidden = folderPickerMode === 'project' && !cwd;
  const detect = useDetectCwd(worktreeDisabled ? null : (cwd ?? null), deviceLinkDeviceId);
  const baseRepo = detect.data?.repoRoot ?? null;

  useEffect(() => {
    onBaseRepoChange?.(baseRepo);
  }, [baseRepo, onBaseRepoChange]);

  const cantUseReason = useMemo<string | null>(() => {
    if (detect.loading) return t('newChat.worktree.detecting');
    if (!detect.data) return null;
    const d = detect.data;
    if (!d.gitInstalled) return t('newChat.worktree.gitMissing');
    if (!d.isGitRepo) return t('newChat.worktree.notGitRepo');
    if (d.isInsideWorktree) return t('newChat.worktree.alreadyInWorktree');
    return null;
  }, [detect.data, detect.loading, t]);

  const switchDisabled = disabled || worktreeDisabled || !!cantUseReason || detect.loading || !cwd;

  useEffect(() => {
    if (detect.loading) return;
    if (cantUseReason && enabled) onEnabledChange(false);
  }, [cantUseReason, enabled, onEnabledChange, detect.loading]);

  useEffect(() => {
    if (advancedHidden && enabled) onEnabledChange(false);
  }, [advancedHidden, enabled, onEnabledChange]);

  useEffect(() => {
    if (worktreeDisabled && enabled) onEnabledChange(false);
  }, [worktreeDisabled, enabled, onEnabledChange]);

  const effectiveWorktreeEnabled = enabled && !advancedHidden && !worktreeDisabled;
  // 分支列表懒加载 latch:worktree 未开时不预拉,首次点开分支 chip 菜单才拉,
  // 之后保持订阅(baseRepo 变化由 hook 自身依赖触发重拉)。
  const [branchListWanted, setBranchListWanted] = useState(false);
  const branches = useBranches(
    effectiveWorktreeEnabled || branchListWanted ? baseRepo : null,
    deviceLinkDeviceId,
  );
  const suggested = useSuggestName(effectiveWorktreeEnabled ? baseRepo : null, deviceLinkDeviceId);

  useEffect(() => {
    if (!effectiveWorktreeEnabled || sourceBranch || !branches.current) return;
    onSourceBranchChange(branches.current);
  }, [effectiveWorktreeEnabled, sourceBranch, branches.current, onSourceBranchChange]);

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
  // worktree ON 显源分支,列表加载失败/未返回时回退 'main'(与发送管线的源分支
  // 回退值一致,也是旧 Advanced popover 的默认显示)—— ON 状态下 chip 是唯一的
  // 分支入口,绝不能因加载失败而消失。OFF 显仓库当前 HEAD 分支,空(detached /
  // 未探测)则不出 chip。
  const branchLabel = effectiveWorktreeEnabled
    ? sourceBranch || branches.current || 'main'
    : (currentBranch ?? '');
  const showBranchChip = !advancedHidden && !!detect.data?.isGitRepo && branchLabel !== '';
  // 只读场景:worktree 开不了(已在 worktree 内 / 探测中)时 chip 仅展示不弹菜单。
  const branchChipInteractive = !disabled && (effectiveWorktreeEnabled || !switchDisabled);

  const handleBranchPick = useCallback(
    (picked: string) => {
      const effect = resolveBranchPick(
        { worktreeEnabled: effectiveWorktreeEnabled, currentBranch, sourceBranch: branchLabel },
        picked,
      );
      if (effect.kind === 'set-source') {
        onSourceBranchChange(effect.branch);
      } else if (effect.kind === 'enable-worktree') {
        // 同帧一起写:sourceBranch 非空会让"worktree 开启后回填 current"的
        // effect 自然跳过,不会覆盖用户的选择。
        onEnabledChange(true);
        onSourceBranchChange(effect.branch);
      }
    },
    [effectiveWorktreeEnabled, currentBranch, branchLabel, onSourceBranchChange, onEnabledChange],
  );

  const branchChip = showBranchChip ? (
    <BranchChip
      label={branchLabel}
      branches={branches.branches}
      loading={branches.loading}
      failed={branches.failed}
      onRetry={branches.refetch}
      worktreeEnabled={effectiveWorktreeEnabled}
      interactive={branchChipInteractive}
      onPick={handleBranchPick}
      onOpenRequested={() => {
        setBranchListWanted(true);
        // 上次拉取失败的话,重新打开菜单就自动重试一次,不逼用户去点重试项。
        if (branches.failed && !branches.loading) branches.refetch();
      }}
      compact={compact}
    />
  ) : null;

  // advancedOnly:项目选择交给页面自己的 pill,这里出 [分支 chip][齿轮]
  // (cwd 为空时随 advancedHidden 整体不渲染,与 full 变体同一套隐藏/清状态 effect)。
  if (variant === 'advancedOnly') {
    if (advancedHidden) return null;
    return (
      <>
        {branchChip}
        <AdvancedPopover
          enabled={enabled}
          onEnabledChange={onEnabledChange}
          switchDisabled={switchDisabled}
          cantUseReason={cantUseReason ?? undefined}
          disabled={disabled || worktreeDisabled}
          compact={compact}
        />
      </>
    );
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
      {branchChip}
      {!advancedHidden && (
        <AdvancedPopover
          enabled={enabled}
          onEnabledChange={onEnabledChange}
          switchDisabled={switchDisabled}
          cantUseReason={cantUseReason ?? undefined}
          disabled={disabled || worktreeDisabled}
          compact={compact}
        />
      )}
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
            'text-[14px] font-medium text-foreground',
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

// ── 分支 chip:常显当前/源分支,点开选分支 ──────────────────

function BranchChip({
  label,
  branches,
  loading,
  failed,
  onRetry,
  worktreeEnabled,
  interactive,
  onPick,
  onOpenRequested,
  compact,
}: {
  label: string;
  branches: string[];
  loading: boolean;
  /** 上次分支列表请求失败(区分于"仓库没分支"),菜单给重试入口。 */
  failed: boolean;
  onRetry: () => void;
  worktreeEnabled: boolean;
  interactive: boolean;
  onPick: (branch: string) => void;
  /** 菜单打开时通知上层解锁分支列表懒加载(失败态由上层顺带自动重试)。 */
  onOpenRequested: () => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();

  const trigger = (
    <button
      type="button"
      disabled={!interactive}
      data-testid="create-agent-branch-chip"
      className={cn(
        'inline-flex items-center rounded-full border transition-colors',
        // 只读态不弹菜单但也不该像 disabled 一样淡出 —— 分支信息本身是有效展示。
        !interactive && 'cursor-default',
        compact
          ? 'h-[30px] max-w-[220px] gap-1.5 border-[var(--create-agent-control-border)] bg-[var(--create-agent-control-bg)] px-3 text-[12px] font-medium leading-[14px] text-[var(--create-agent-control-text)]'
          : 'h-[42px] max-w-[260px] gap-2.5 border-border bg-[var(--chat-input-bg)] px-[18px] text-[14px] font-medium text-foreground',
        interactive &&
          (compact
            ? 'hover:bg-[var(--create-agent-control-bg-hover)] active:bg-[var(--create-agent-control-bg-pressed)]'
            : 'hover:bg-sidebar-item-hover'),
        // worktree ON 时与齿轮同款主色提示:一眼看出"这是隔离启动的源分支"。
        worktreeEnabled && 'border-primary/50 text-primary',
        worktreeEnabled && interactive && 'hover:bg-primary/10',
      )}
      aria-label={t('newChat.branchChip.label')}
    >
      <GitBranch size={compact ? 12 : 15} className="shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
      {interactive && (
        <ChevronDown
          size={12}
          className={cn('shrink-0', worktreeEnabled ? 'text-primary' : 'text-muted-foreground')}
        />
      )}
    </button>
  );

  const tipped = (
    <Tip
      text={
        worktreeEnabled
          ? t('newChat.branchChip.sourceTooltip')
          : t('newChat.branchChip.currentTooltip')
      }
    >
      {trigger}
    </Tip>
  );

  if (!interactive) return tipped;

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) onOpenRequested();
      }}
    >
      <DropdownMenuTrigger asChild>{tipped}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={4}
        className="max-h-[280px] min-w-[200px] overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-lg"
      >
        {loading ? (
          <div className="px-3 py-1.5 text-[13px] text-muted-foreground">
            {t('newChat.branchChip.loading')}
          </div>
        ) : failed || branches.length === 0 ? (
          /* 失败与空列表都给重试入口(空列表也可能是隧道/瞬时问题);
             onSelect 阻止默认关闭,重试期间菜单留在原地显示 loading。 */
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              onRetry();
            }}
            className="cursor-pointer rounded-md px-3 py-1.5 text-[13px] text-muted-foreground focus:bg-accent focus:text-accent-foreground"
          >
            {t('newChat.branchChip.loadFailed')}
          </DropdownMenuItem>
        ) : (
          branches.map((b) => (
            <DropdownMenuItem
              key={b}
              onSelect={() => onPick(b)}
              className={cn(
                'cursor-pointer rounded-md px-3 py-1.5 text-[13px] text-foreground',
                'focus:bg-accent focus:text-accent-foreground',
                b === label && 'bg-accent/60',
              )}
            >
              {b}
            </DropdownMenuItem>
          ))
        )}
        {/* worktree OFF 时说明点选语义:不动当前 checkout,以 worktree 隔离启动。 */}
        {!worktreeEnabled && (
          <div className="mt-1 border-t border-border px-3 pb-1 pt-1.5 text-[11px] leading-snug text-muted-foreground">
            {t('newChat.branchChip.worktreeHint')}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── 辅助：齿轮按钮 + 高级 popover（worktree 开关） ──────

function AdvancedPopover({
  enabled,
  onEnabledChange,
  switchDisabled,
  cantUseReason,
  disabled,
  compact,
}: {
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  switchDisabled?: boolean;
  cantUseReason?: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);

  // worktree ON 时齿轮显示主色提示，让用户在 popover 关闭时也能感知到 worktree 已启用
  const gearActive = enabled;

  const trigger = (
    <button
      type="button"
      disabled={disabled}
      data-testid="create-agent-worktree-advanced"
      className={cn(
        'inline-flex items-center justify-center rounded-full border transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        // compact:30px 紧凑版,取 create-agent 控件 token 与新建页 mode pill 同排同调
        compact ? 'h-[30px] w-[30px]' : 'h-[42px] w-[42px] bg-[var(--chat-input-bg)]',
        gearActive
          ? 'border-primary/50 text-primary hover:bg-primary/10'
          : compact
            ? 'border-[var(--create-agent-control-border)] bg-[var(--create-agent-control-bg)] text-[var(--create-agent-control-icon)] hover:bg-[var(--create-agent-control-bg-hover)]'
            : 'border-border text-muted-foreground hover:bg-sidebar-item-hover hover:text-foreground',
      )}
      aria-label="Advanced settings (worktree)"
      aria-pressed={gearActive}
    >
      <SlidersHorizontal size={compact ? 13 : 15} className="shrink-0" />
    </button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[240px] rounded-xl border border-border bg-popover p-2 shadow-lg"
      >
        <div className="px-2 pt-1.5 pb-1 text-[13px] font-medium text-muted-foreground">
          Advanced
        </div>

        {/* Worktree toggle(Branch 已外显为独立 chip,见 BranchChip) */}
        <WorktreePopRow
          checked={enabled}
          onChange={onEnabledChange}
          disabled={switchDisabled}
          disabledReason={cantUseReason}
        />
      </PopoverContent>
    </Popover>
  );
}

function WorktreePopRow({
  checked,
  onChange,
  disabled,
  disabledReason,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const btn = (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-md px-2',
        'text-[13px] transition-colors hover:bg-sidebar-item-hover',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'text-primary' : 'text-muted-foreground',
      )}
      aria-pressed={checked}
      aria-label="Use worktree isolation"
    >
      <span
        className={cn(
          'inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded',
          'border-[1.5px] transition-colors',
          checked
            ? // CREATE AGENT 的深色主题 primary-foreground 与 primary 可能同为浅色，
              // 直接使用全局 primary 会让勾选符号和背景缺少对比度。
              // 复用草稿页已有的反色中性色，保证 light/dark 都能看清勾选状态。
              'border-[var(--create-agent-send-bg)] bg-[var(--create-agent-send-bg)] text-[var(--create-agent-send-icon)]'
            : 'border-muted-foreground bg-transparent',
        )}
      >
        {checked && (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            className="h-[10px] w-[10px]"
          >
            <path d="M3 8l3.5 3.5L13 5" />
          </svg>
        )}
      </span>
      <span>worktree</span>
    </button>
  );

  if (disabled && disabledReason) {
    return (
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span className="inline-flex w-full" tabIndex={0}>
            {btn}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Content side="top">{disabledReason}</Tooltip.Content>
      </Tooltip.Root>
    );
  }

  return btn;
}
