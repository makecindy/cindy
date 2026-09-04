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
 *   - 唯一改动路径 = 用户点击 checkbox 本体,并写入工作端勾选记忆;
 *   - 分支选择始终只修改 worktree 源分支,永远不联动 checkbox。
 *
 * 2026-08-07 用户裁决(取代 2026-07-29「已 ON 保留关闭入口 + fail-closed」形态):
 * 勾选记忆**只对具备 worktree 资格的目录生效**——
 *   - 探测成功且确认不合格(非 git 仓库 / git 未安装 / 已在 worktree 内)时整条控件
 *     隐藏,发送侧按普通会话放行;记忆本身保留不动,回到合格目录自动恢复;
 *   - 探测进行中 / 探测失败(断线、老端通道缺失等)时**不算**确认不合格:已 ON 则
 *     照旧显示并由上层 fail closed 拦截——一次弱网不能把用户要求的隔离静默降级。
 * 两种状态的区分经 onConfirmedIneligibleChange 上报(null = 尚未确认)。
 *
 * 分支区语义:始终选择新 worktree 的源分支;checkbox 只决定本次新 session 是否
 * 真正创建 worktree。两者是独立控制,允许用户先选分支、再决定是否隔离。
 *
 * worktree 名称 **自动生成**（不暴露 UI），由 useSuggestName 拉取后透传给上层。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import { GitBranch, ChevronDown, Folder, MessageCircle, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tip, Tooltip } from '@/components/ui/tooltip';
import {
  FolderPickerPopover,
  addRecentFolder,
  type FolderPickerOption,
  type FolderPickerSelectSource,
} from './FolderPickerPopover';
import { resolveBranchPick } from './branchPick';
import { filterBranches } from './branchFilter';
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
  /**
   * 用户点击 checkbox 本体切换 worktree——**唯一**的状态改动路径,上层必持久化
   * (写工作端勾选记忆)。系统任何路径都不得调用它替用户翻状态。
   */
  onEnabledChange: (v: boolean) => void;
  sourceBranch: string;
  onSourceBranchChange: (v: string) => void;
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
  const detect = useDetectCwd(
    worktreeDisabled ? null : (cwd ?? null),
    deviceLinkDeviceId,
    deviceLinkReconnectEpoch,
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
  // 分支与 checkbox 独立:未勾时也要回显用户刚选的源分支,否则菜单虽然可点、
  // 选择后却仍显示当前 HEAD,看起来像没有生效。首次未选择时回退当前 checkout。
  const branchLabel = sourceBranch || branches.current || currentBranch || 'HEAD';
  // 确认不合格(2026-08-07 裁决)→ 整条控件隐藏,勾选记忆保留、发送侧放行普通会话;
  // 探测中/失败(confirmedIneligible === null)时已 ON 仍显示,由上层 fail closed。
  const showBranchChip =
    !advancedHidden
    && confirmedIneligible !== true
    && (enabled || !!detect.data?.isGitRepo);
  // 分支选择与 checkbox 是两条独立轴；仅环境不具备 worktree 资格或创建在途时禁用。
  const branchInteractive =
    !(disabled || branchDisabled || environmentDisabled) && baseRepo !== null;

  const handleBranchPick = useCallback(
    (picked: string) => {
      const effect = resolveBranchPick(
        { worktreeEnabled: effectiveWorktreeEnabled, currentBranch, sourceBranch: branchLabel },
        picked,
      );
      if (effect.kind === 'set-source') onSourceBranchChange(effect.branch);
    },
    [effectiveWorktreeEnabled, currentBranch, branchLabel, onSourceBranchChange],
  );

  const branchWorktree = showBranchChip ? (
    <BranchWorktreeChip
      branchLabel={branchLabel}
      branches={branches.branches}
      branchesLoading={branches.loading}
      branchesFailed={branches.failed}
      onRetryBranches={branches.refetch}
      checked={enabled}
      branchSourceSelected={!!sourceBranch}
      branchInteractive={branchInteractive}
      checkboxDisabled={switchDisabled}
      cantUseReason={cantUseReason ?? undefined}
      onPick={handleBranchPick}
      onOpenRequested={() => {
        setBranchListWanted(true);
        // 上次拉取失败的话,重新打开菜单就自动重试一次,不逼用户去点重试项。
        if (branches.failed && !branches.loading) branches.refetch();
      }}
      onToggle={onEnabledChange}
      compact={compact}
    />
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

// 导出仅为让分支搜索的交互(打开即聚焦 / 过滤 / 键盘导航 / 关闭清空)能被单测直接
// render;它不是对外 API,WorktreeChipsRow 之外不要拿它当组件用。
export function BranchWorktreeChip({
  branchLabel,
  branches,
  branchesLoading,
  branchesFailed,
  onRetryBranches,
  checked,
  branchSourceSelected,
  branchInteractive,
  checkboxDisabled,
  cantUseReason,
  onPick,
  onOpenRequested,
  onToggle,
  compact,
}: {
  branchLabel: string;
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
  checkboxDisabled?: boolean;
  cantUseReason?: string;
  onPick: (branch: string) => void;
  /** 菜单打开时通知上层解锁分支列表懒加载(失败态由上层顺带自动重试)。 */
  onOpenRequested: () => void;
  /** 用户点击 checkbox——唯一的状态改动路径(上层持久化到工作端)。 */
  onToggle: (v: boolean) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  // 搜索词是纯视图状态:面板一关就丢弃,不入 store、不持久化,也不回传上层——
  // 上层只关心最终选中的分支,过滤过程与它无关。
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => filterBranches(branches, query), [branches, query]);

  /**
   * 关面板。关闭与清空搜索词是同一件事,收在这一个出口 —— 选中一项、Esc、点面板外
   * 三条路径都走它。受控 Popover 的 onOpenChange 只在 Radix 自己发起关闭时触发,
   * 程序化 setOpen(false) 不会走那条回调;两处各自记得清空的话,选中项这条路径必然
   * 漏掉,于是上次的搜索词被带到下次打开(单测 branchPickerSearch 抓到过)。
   */
  const closePanel = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  const pick = useCallback(
    (branch: string) => {
      onPick(branch);
      closePanel();
    },
    [onPick, closePanel],
  );

  const listItems = useCallback(
    () =>
      Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button[role="option"]') ?? []),
    [],
  );

  /** 把焦点移进分支列表:delta>0 从头进,<0 从尾进;越过首项则退回搜索框。 */
  const moveListFocus = useCallback(
    (delta: number) => {
      const items = listItems();
      if (items.length === 0) return;
      const from = items.indexOf(document.activeElement as HTMLButtonElement);
      // 焦点还在搜索框(from = -1)时,向下从首项进、向上从末项进。
      const next = from < 0 ? (delta > 0 ? 0 : items.length - 1) : from + delta;
      if (next < 0) {
        inputRef.current?.focus();
        return;
      }
      // 末项继续向下就停在末项;不做环绕,免得焦点从列表尾跳回头部让人丢失位置感。
      items[Math.min(next, items.length - 1)]?.focus();
    },
    [listItems],
  );

  const jumpListFocus = useCallback(
    (to: 'first' | 'last') => {
      const items = listItems();
      (to === 'first' ? items[0] : items[items.length - 1])?.focus();
    },
    [listItems],
  );

  const branchSegment = (
    <button
      type="button"
      aria-disabled={!branchInteractive}
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
      <span className="min-w-0 truncate">{branchLabel}</span>
      {branchInteractive && (
        <ChevronDown
          size={12}
          className={cn('shrink-0', checked ? 'text-primary' : 'text-muted-foreground')}
        />
      )}
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

  // 用 Popover 而非 DropdownMenu 承载这个下拉:菜单的 typeahead 会把单字符按键
  // 拿去做菜单项跳转(@radix-ui/react-menu Content 的 onKeyDown),而 Item 的
  // onPointerMove 还会把焦点抢到鼠标掠过的那一项 —— 两条都跟"面板里有个输入框"
  // 冲突,后者靠 stopPropagation 也绕不掉。仓内另两处带搜索的下拉
  // (OneshotModelPinPicker / ScriptCapabilityMultiSelect)同样是 Popover。
  const branchArea = branchInteractive ? (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          closePanel();
          return;
        }
        setOpen(true);
        onOpenRequested();
      }}
    >
      <PopoverTrigger asChild>{branchTipped}</PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={4}
        onOpenAutoFocus={(event) => {
          // Popover 默认把焦点压在面板本体上,这里改交给搜索框:打开即可直接打字,
          // 不必先点一下输入框。
          event.preventDefault();
          inputRef.current?.focus();
        }}
        className="flex w-auto min-w-[200px] max-w-[320px] flex-col gap-1.5 rounded-xl border border-border bg-popover p-1.5 shadow-lg"
      >
        <div className="flex items-center gap-2 rounded-full border border-border bg-[var(--surface-elevated)] px-2.5 py-[5px]">
          <Search size={13} className="shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('newChat.branchChip.searchPlaceholder')}
            aria-label={t('newChat.branchChip.searchPlaceholder')}
            className="min-w-0 flex-1 bg-transparent text-13 text-foreground outline-none placeholder:text-[var(--text-placeholder)]"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                const first = filtered[0];
                // 没有匹配项时 Enter 什么都不做,也不关面板 —— 免得手一快就把
                // 输错的搜索词连面板一起丢掉。
                if (first) pick(first);
                return;
              }
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                moveListFocus(e.key === 'ArrowDown' ? 1 : -1);
              }
              // Escape 不拦,交给 Popover 自己关闭。
            }}
          />
        </div>
        <div
          ref={listRef}
          role="listbox"
          aria-label={t('newChat.branchChip.label')}
          className="flex max-h-[240px] flex-col overflow-y-auto overscroll-contain"
          onKeyDown={(e) => {
            // Home / End 只挂在列表上,不挂搜索框 —— 在输入框里这两个键得留给文本光标。
            if (e.key === 'Home' || e.key === 'End') {
              e.preventDefault();
              jumpListFocus(e.key === 'Home' ? 'first' : 'last');
              return;
            }
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            moveListFocus(e.key === 'ArrowDown' ? 1 : -1);
          }}
        >
          {branchesLoading ? (
            <div className="px-3 py-1.5 text-13 text-muted-foreground">
              {t('newChat.branchChip.loading')}
            </div>
          ) : branchesFailed || branches.length === 0 ? (
            /* 失败与空列表都给重试入口(空列表也可能是隧道/瞬时问题);
               这里是普通 button,点了不关面板,重试期间原地显示 loading。 */
            <button
              type="button"
              onClick={onRetryBranches}
              className="cursor-pointer rounded-[8px] px-3 py-1.5 text-left text-13 text-muted-foreground hover:bg-sidebar-item-hover focus-visible:bg-sidebar-item-hover focus-visible:outline-none"
            >
              {t('newChat.branchChip.loadFailed')}
            </button>
          ) : filtered.length === 0 ? (
            /* 有分支但搜索词一个都没命中 —— 与"加载失败"是两回事,不能复用重试文案。 */
            <div className="px-3 py-1.5 text-13 text-muted-foreground">
              {t('newChat.branchChip.noMatch')}
            </div>
          ) : (
            filtered.map((b, i) => (
              <button
                key={b}
                type="button"
                role="option"
                aria-selected={b === branchLabel}
                // roving tabIndex:Tab 一次进列表、落在首项,再 Tab 就走出去。分支上百条时
                // 逐项 Tab 穿越是灾难 —— 组内换项靠 ↑↓ 与 Home/End(容器 onKeyDown)。
                tabIndex={i === 0 ? 0 : -1}
                onClick={() => pick(b)}
                className={cn(
                  'cursor-pointer truncate rounded-[8px] px-3 py-1.5 text-left text-13 text-foreground',
                  'hover:bg-sidebar-item-hover focus-visible:bg-sidebar-item-hover focus-visible:outline-none',
                  b === branchLabel && 'bg-accent/60',
                )}
              >
                {b}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  ) : (
    branchTipped
  );

  const checkboxSegment = (
    <button
      type="button"
      onClick={() => !checkboxDisabled && onToggle(!checked)}
      disabled={checkboxDisabled}
      data-testid="create-agent-worktree-chip"
      aria-pressed={checked}
      aria-label={t('newChat.worktree.toggleAria')}
      className={cn(
        'inline-flex h-full items-center transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
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
      {/* 术语表裁决:worktree 四语一律保留英文小写原词,故 label 不走 locale 分叉。 */}
      <span>worktree</span>
    </button>
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
      <Tip text={t('newChat.worktree.chipTooltip')}>{checkboxSegment}</Tip>
    );

  return (
    <div
      data-testid="create-agent-branch-worktree"
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
      {/* 悬停激活任一半区时分隔线隐去,让 hover 填充看起来是一体的(对齐 Claude Code)。 */}
      <span
        aria-hidden
        className={cn(
          'w-px shrink-0 self-center transition-opacity group-hover:opacity-0',
          compact ? 'h-[14px] bg-[var(--create-agent-control-border)]' : 'h-[18px] bg-border',
        )}
      />
      {checkboxArea}
    </div>
  );
}
