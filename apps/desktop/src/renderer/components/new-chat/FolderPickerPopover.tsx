import { ErrorNotice } from '@/components/ui/error-notice';
import { Button } from '@/components/ui/button';
import {
  Folder,
  FolderPlus,
  Globe,
  Loader2,
  MessageCircle,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { recentWorkdirsStore } from '@/lib/recentWorkdirsStore';

const RECENT_FOLDERS_KEY = 'cc-agent-recent-folders';
const MAX_RECENT = 5;

export interface RecentFolder {
  path: string;
  name: string;
}

export interface FolderPickerOption {
  /** Stable key across machines. Falls back to path for local-only callers. */
  key?: string;
  path: string;
  name: string;
  description?: string;
  /** true = 目录已不在磁盘上(迁移/删除),行置灰并提示,仍可选(磁盘可能重新挂载)。 */
  missing?: boolean;
  /** Present only when this path belongs to a paired device. */
  remoteDevice?: {
    deviceId: string;
    deviceName: string;
  };
}

/**
 * 项目区当前所属的设备(#807 方案 B)。设备由创建页的设备 pill 选定,这里只负责在**该设备的
 * 语境内**渲染「对话 + 项目」:所以不需要跨设备分组,列表长度不随设备数膨胀,「对话」也只出现
 * 一次(它归属当前设备,而不是悬在所有设备之上)。
 */
export interface FolderPickerDeviceScope {
  deviceId: string;
  deviceName: string;
  /** 远程项目读取状态；只有 ready + 空数组才允许渲染权威空态。 */
  status: 'loading' | 'ready' | 'error';
  error?: string | null;
  retry?: () => void;
}

export type FolderPickerSelectSource = 'project' | 'recent' | 'browse' | 'dialogue';

const WHEEL_LINE_HEIGHT = 16;

/** 带路径的项目行高 56px,可视区约放 4 行;超过这个数才有必要搜索。 */
const PROJECT_SEARCH_MIN_COUNT = 5;

/**
 * 项目列表的可视高度刻意不取行高(56px)整数倍:4.5 行让第 5 行露出半截,
 * 用户一眼看出下面还有内容。224px(恰好 4 行)时第 5 行正卡在边界外,看不出能滚动。
 */
const PROJECT_LIST_MAX_HEIGHT_PX = 252;
const PROJECT_LIST_MAX_HEIGHT_CLASS = 'max-h-[252px]';

export function filterFolderPickerOptions(
  options: readonly FolderPickerOption[],
  query: string,
): readonly FolderPickerOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return options;
  return options.filter((option) =>
    [option.name, option.description, option.path].some((field) =>
      field?.toLowerCase().includes(needle),
    ),
  );
}

/**
 * Read recent folders from localStorage.
 */
export function getRecentFolders(): RecentFolder[] {
  try {
    const raw = localStorage.getItem(RECENT_FOLDERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentFolder[];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

/**
 * Add a folder to the recent list. If it already exists, move it to the front.
 */
export function addRecentFolder(folderPath: string): void {
  const name = folderPath.split(/[\\/]/).pop() ?? folderPath;
  const current = getRecentFolders();
  const filtered = current.filter((f) => f.path !== folderPath);
  const updated = [{ path: folderPath, name }, ...filtered].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(updated));
  } catch {
    // Storage full or unavailable — silently ignore
  }
}

function normalizeWheelDeltaY(e: React.WheelEvent): number {
  if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) return e.deltaY * WHEEL_LINE_HEIGHT;
  if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) return e.deltaY * window.innerHeight;
  return e.deltaY;
}

function handleFolderPickerWheel(e: React.WheelEvent<HTMLElement>) {
  e.stopPropagation();

  const current = e.currentTarget;
  const target = e.target instanceof HTMLElement ? e.target : null;
  const scrollRoot =
    target?.closest<HTMLElement>('[data-folder-picker-scroll="true"]') ??
    current.querySelector<HTMLElement>('[data-folder-picker-scroll="true"]');

  if (!scrollRoot || scrollRoot.scrollHeight <= scrollRoot.clientHeight) return;

  e.preventDefault();
  scrollRoot.scrollTop += normalizeWheelDeltaY(e);
}

interface FolderPickerPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (
    folderPath: string,
    source: FolderPickerSelectSource,
    option?: FolderPickerOption,
  ) => void | Promise<void>;
  projectOptions?: readonly FolderPickerOption[];
  allowDialogue?: boolean;
  allowRemove?: boolean;
  /**
   * 非空 = 项目区列的是这台对端设备的项目(本机时不传)。只用于空态文案与「浏览文件夹」
   * 的目标设备,行本身的归属仍看每个 option 的 remoteDevice。
   */
  deviceScope?: FolderPickerDeviceScope;
  onRemoveRemoteProject?: (option: FolderPickerOption) => void | Promise<void>;
  /**
   * 仅 isProjectPicker 模式下生效, 且只在传入时显示。回调激发 = 用户想从远端
   * 添加一个新的项目目录;调用方应关闭 popover 并打开 AddRemoteProjectDialog。
   * 上层按当前可用的 SSH / device-link 目标决定是否传入,这里不做判断。
   */
  onAddRemoteProject?: (deviceId?: string) => void;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  collisionPadding?: number;
  children: React.ReactNode;
}

export function FolderPickerPopover({
  open,
  onOpenChange,
  onSelect,
  projectOptions,
  allowDialogue = true,
  allowRemove = true,
  deviceScope,
  onRemoveRemoteProject,
  onAddRemoteProject,
  side,
  align = 'end',
  sideOffset = 4,
  collisionPadding,
  children,
}: FolderPickerPopoverProps) {
  const { t } = useTranslation();
  const isProjectPicker = projectOptions !== undefined;
  const effectiveProjectOptions = projectOptions ?? [];
  const recentFolders = open && !isProjectPicker ? getRecentFolders() : [];
  const selectionPendingRef = useRef(false);
  const [selectionPending, setSelectionPending] = useState(false);
  const [projectQuery, setProjectQuery] = useState('');
  const [browseFailed, setBrowseFailed] = useState(false);
  const projectSearchRef = useRef<HTMLInputElement>(null);
  // 用 state 持有列表元素:内容经 Radix Portal 渲染,首个 commit 时还没挂进 DOM,
  // 普通 ref 配依赖数组的 effect 会在元素出现前测量一次,之后列表不变就再也不测。
  const [projectScrollEl, setProjectScrollEl] = useState<HTMLDivElement | null>(null);
  const [scrollFade, setScrollFade] = useState({ top: false, bottom: false });
  // 上半区(标题/「对话」/「项目」标签/搜索框 + 列表)是同一个滚动容器:空间充足时它不
  // 溢出,列表仍按原契约在 252px 上限内独立滚动,外观与旧版一致;放不下「固定项 + 列表
  // 上限高度」时它收缩并接管滚动,顶部随列表一起向上滚走,底部操作项钉在弹层底部。
  // upperScrollOverflows = 上半区自然高度超过可用高度 → 列表让出滚动给外层(取消自身
  // 高度上限),避免外层与内层并存的双滚动条。
  const [upperScrollEl, setUpperScrollEl] = useState<HTMLDivElement | null>(null);
  const [upperScrollOverflows, setUpperScrollOverflows] = useState(false);
  const [upperScrollFade, setUpperScrollFade] = useState({ top: false, bottom: false });
  // 溢出态的一次性对齐目标:有搜索框时对齐到它(sticky 贴顶 + 紧接完整项目行),
  // 没有搜索框(项目数少/最近列表)对齐到列表顶。用户滚过后不再抢滚动位置,
  // 回到不溢出状态后重置,下次溢出再对齐。
  const [searchAnchorEl, setSearchAnchorEl] = useState<HTMLDivElement | null>(null);
  const upperSnappedRef = useRef(false);
  const showProjectSearch =
    isProjectPicker && effectiveProjectOptions.length >= PROJECT_SEARCH_MIN_COUNT;
  const activeProjectQuery = showProjectSearch ? projectQuery.trim() : '';
  const visibleProjectOptions = useMemo(
    () => filterFolderPickerOptions(effectiveProjectOptions, activeProjectQuery),
    [effectiveProjectOptions, activeProjectQuery],
  );

  // 每次打开都从完整列表开始,不残留上次的搜索词。
  useEffect(() => {
    if (!open) {
      setProjectQuery('');
      setBrowseFailed(false);
      upperSnappedRef.current = false;
    }
  }, [open]);

  // 项目异步到达(远程设备首读、本机首次加载)时搜索框晚于弹层出现,onOpenAutoFocus 已错过。
  // 本次打开内搜索框首次出现时补一次聚焦;只接管仍停在弹层内的焦点,不抢用户已移走的焦点。
  const searchAutoFocusedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      searchAutoFocusedRef.current = false;
      return;
    }
    const input = projectSearchRef.current;
    if (!showProjectSearch || !input || searchAutoFocusedRef.current) return;
    searchAutoFocusedRef.current = true;
    const active = document.activeElement;
    if (active === input) return;
    const content = input.closest('[role="dialog"]');
    if (!active || active === document.body || content?.contains(active)) input.focus();
  }, [open, showProjectSearch]);

  const updateScrollFade = useCallback(() => {
    const el = projectScrollEl;
    const next = el
      ? {
          top: el.scrollTop > 1,
          bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 1,
        }
      : { top: false, bottom: false };
    setScrollFade((prev) => (prev.top === next.top && prev.bottom === next.bottom ? prev : next));
  }, [projectScrollEl]);

  // upperScrollOverflows 必须在依赖里:充足→溢出→充足切换时列表 scrollTop 被钳到 0,
  // 不随状态翻转重算的话,回到充足态会残留旧的顶部渐隐(下次滚动才自愈)。
  useLayoutEffect(() => {
    updateScrollFade();
  }, [visibleProjectOptions, deviceScope?.status, upperScrollOverflows, updateScrollFade]);

  const updateUpperScrollFade = useCallback(() => {
    const el = upperScrollEl;
    let next = { top: false, bottom: false };
    if (el) {
      // sticky 搜索框已钉在容器顶(滚动量到达它在流内的偏移)时不再加顶部渐隐:
      // mask 会把它一起淡化,而它后面滚过的内容本来就被它的不透明底遮住。
      // 容器带 relative,offsetTop 是相对它的流内偏移(不多算弹层 padding/border);
      // jsdom 无布局恒为 0 → 视为未钉住。
      const searchPinned =
        searchAnchorEl !== null &&
        searchAnchorEl.offsetTop > 0 &&
        el.scrollTop >= searchAnchorEl.offsetTop - 1;
      next = {
        top: el.scrollTop > 1 && !searchPinned,
        bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 1,
      };
    }
    setUpperScrollFade((prev) =>
      prev.top === next.top && prev.bottom === next.bottom ? prev : next,
    );
  }, [upperScrollEl, searchAnchorEl]);

  // 上半区是否需要整体滚动:自然高度 = 顶部固定项 + 列表按 252px 上限应有的高度。
  // 不能直接看 el.scrollHeight —— 列表处于自滚动态时按实际渲染高度贡献(clientHeight,
  // 会被 flex 收缩),必须换回它「该占的高度」min(scrollHeight, 252) 才是自然高度。
  // 列表没有更高优先的收缩对手:固定项放不下时整个上半区滚动,不再让列表缩没。
  useLayoutEffect(() => {
    const el = upperScrollEl;
    if (!el || !open) return;
    const measure = () => {
      const list = projectScrollEl;
      const natural =
        el.scrollHeight -
        (list ? list.clientHeight : 0) +
        (list ? Math.min(list.scrollHeight, PROJECT_LIST_MAX_HEIGHT_PX) : 0);
      const overflows = natural > el.clientHeight + 1;
      if (!overflows) upperSnappedRef.current = false;
      setUpperScrollOverflows((prev) => (prev === overflows ? prev : overflows));
      updateUpperScrollFade();
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (projectScrollEl) observer.observe(projectScrollEl);
    return () => observer.disconnect();
  }, [
    upperScrollEl,
    projectScrollEl,
    open,
    visibleProjectOptions,
    deviceScope?.status,
    updateUpperScrollFade,
  ]);

  // 上半区一开始滚动就对齐一次:有搜索框时把它贴到容器顶(sticky 钉住,
  // 紧接至少一个完整项目行);没有搜索框则对齐到列表顶。标题/「对话」/「项目」
  // 标签自然滚到上方(向上滚即回)。
  useLayoutEffect(() => {
    const el = upperScrollEl;
    const anchor = searchAnchorEl ?? projectScrollEl;
    if (!upperScrollOverflows || !el || !anchor || upperSnappedRef.current) return;
    upperSnappedRef.current = true;
    el.scrollTop =
      anchor.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    updateUpperScrollFade();
  }, [upperScrollOverflows, upperScrollEl, projectScrollEl, searchAnchorEl, updateUpperScrollFade]);

  const handleSelectPath = async (
    folderPath: string,
    source: FolderPickerSelectSource,
    option?: FolderPickerOption,
  ): Promise<void> => {
    // The popover stays open while onSelect persists its target. Guard before
    // the first await so a rapid second click cannot be silently rejected by
    // the parent and then close the popover as though that newer choice won.
    if (selectionPendingRef.current) return;
    selectionPendingRef.current = true;
    setSelectionPending(true);
    try {
      await onSelect(folderPath, source, option);
    } finally {
      selectionPendingRef.current = false;
      setSelectionPending(false);
      // Selection callbacks may persist the directory before handing a pending
      // send back to the parent. Close only after that hand-off completes so a
      // controlled popover cannot clear the pending payload first.
      onOpenChange(false);
    }
  };

  const handleRemoveProject = (project: FolderPickerOption) => {
    if (project.remoteDevice) {
      void onRemoveRemoteProject?.(project);
      return;
    }
    void recentWorkdirsStore.remove(project.path);
  };

  const renderProject = (project: FolderPickerOption, index: number) => {
    const canRemove = allowRemove && (!project.remoteDevice || onRemoveRemoteProject !== undefined);
    // 有搜索词时首个结果常亮:回车选中的就是它。
    const isEnterTarget = activeProjectQuery !== '' && index === 0;
    return (
      /* 行容器**不可交互**(Codex review P1):选择与删除是**兄弟**控件。
         之前为了避开 <button> 里嵌 <button> 的非法 HTML,把外层改成 div[role="button"] ——
         那只换掉了 HTML 层面的问题:ARIA 同样不允许 role="button" 里再有交互后代,读屏可能把删除
         按钮压平进项目按钮、或当成激活它的一部分,于是「删除」要么读不到、要么按下就选中了项目。
         现在容器只负责布局与 hover 视觉(group),里面两个真正的 <button> 并列 —— 合法 HTML、
         语义清晰,也不再需要 stopPropagation 去拦冒泡。 */
      <div
        key={project.key ?? project.path}
        className={cn(
          'group flex w-full items-center gap-3 rounded-[8px] px-3 py-[10px]',
          'transition-colors',
          'hover:bg-[var(--folder-item-hover)]',
          isEnterTarget && 'bg-[var(--folder-item-hover)]',
        )}
      >
        <button
          type="button"
          disabled={selectionPending}
          onClick={() => handleSelectPath(project.path, 'project', project)}
          className={cn(
            'flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left',
            'outline-none',
          )}
        >
          <Folder
            size={20}
            className={cn(
              'shrink-0 text-[var(--folder-item-icon)]',
              project.missing && 'opacity-50',
            )}
          />
          <div className="flex min-w-0 flex-1 flex-col items-start">
            <span
              className={cn(
                'w-full truncate text-sm font-medium text-[var(--folder-item-name)]',
                project.missing && 'opacity-50',
              )}
            >
              {project.name}
            </span>
            {(project.description || project.missing) && (
              <span
                className={cn(
                  'w-full truncate text-xs text-[var(--folder-item-path)]',
                  project.missing && 'opacity-50',
                )}
              >
                {project.missing && (
                  <span className="text-[var(--error-fg)]">
                    {t('newChat.folderPicker.missingDir')}
                    {project.description ? ' · ' : ''}
                  </span>
                )}
                {project.description}
              </span>
            )}
          </div>
        </button>
        {canRemove && (
          <button
            type="button"
            disabled={selectionPending}
            aria-label={t('newChat.folderPicker.removeFromList')}
            onClick={() => handleRemoveProject(project)}
            className={cn(
              // 圆角走 pill:DESIGN.md §5 只允许 8px(内控件)/ 12px(容器)/ 9999px(pill)三档,
              // 6px 是被明文禁止的中间值。这里选 pill 而非 8px —— §5 把 8px 限定为「小到无法戴
              // pill 的交互件」(多行输入、行高亮、块内小格),24×24 的图标按钮戴上 pill 就是个
              // 正圆,完全成立;而外层行本身已是 8px,内层再用 8px 也不满足「内圆角要比容器小」。
              // 同款 hover 才显形的小图标按钮在 ChatInput / PendingQueuePanel 里都是 rounded-full。
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
              'text-[var(--folder-item-path)] opacity-0 transition-opacity',
              'group-hover:opacity-100 focus-visible:opacity-100',
              'hover:bg-[var(--surface-hover)] hover:text-[var(--folder-item-name)]',
              'outline-none',
            )}
          >
            <X size={14} />
          </button>
        )}
      </div>
    );
  };

  const handleChooseDifferent = async () => {
    // 远程设备语境下绝不能开本机原生目录对话框:选出来的是**控制端**路径,而草稿里的
    // deviceId 仍指向对端 —— 发送时要么被被控端 path guard 拒掉,要么(路径恰好在对端也存在)
    // 在一个毫不相关的远程目录里把会话建起来。改为打开设备域的远程浏览器,并带上当前设备。
    // 判据只看 deviceScope,**不再 && onAddRemoteProject**:后者由上层按 hasAnyRemoteTarget 下发,
    // 而选中的对端一旦离线、且它是唯一远程目标时那个 gate 会变 false —— 于是条件不成立、直接
    // 落到下面的本机对话框,选出控制端路径配上远程 deviceId,又回到「被 path guard 拒 / 在对端
    // 同名无关目录里建会话」。远程语境下宁可什么都不做,也绝不能开本机 picker。
    if (deviceScope) {
      onAddRemoteProject?.(deviceScope.deviceId);
      onOpenChange(false);
      return;
    }
    setBrowseFailed(false);
    const result = await window.electronAPI.showOpenDirectoryDialog().catch(() => {
      setBrowseFailed(true);
      return undefined;
    });
    if (!result) return;
    if (!result.canceled && result.path) {
      await handleSelectPath(result.path, 'browse');
    }
    // If canceled, popover stays open per spec
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          // 弹层整体不高过 Radix 算出的视口可用高度(与 ModelSelector / SpeechVoiceMenu
          // 同款契约);flex-col + overflow-hidden 让中间列表收缩,两端操作项不被窗口裁掉。
          'z-[10010] flex max-h-[var(--radix-popover-content-available-height)] w-[320px] flex-col overflow-hidden rounded-[12px] p-2',
          'bg-[var(--folder-picker-bg)]',
          'border border-[var(--folder-picker-border)]',
        )}
        onWheel={handleFolderPickerWheel}
        onOpenAutoFocus={(e) => {
          // 项目多到需要搜索时,打开后的下一个动作多半是输入:直接聚焦搜索框。
          const input = projectSearchRef.current;
          if (!input) return;
          e.preventDefault();
          input.focus();
        }}
        onEscapeKeyDown={(e) => {
          // 输入法组合中的 Esc 属于取消候选词,不关闭也不清空。
          if (e.isComposing) {
            e.preventDefault();
            return;
          }
          // 有搜索词时 Esc 先清空搜索,再按一次才关闭。
          if (!projectQuery) return;
          e.preventDefault();
          setProjectQuery('');
        }}
        aria-busy={selectionPending}
      >
        {/* 上半区共用滚动容器:放不下「顶部固定项 + 列表上限高度」时整体滚动,
            标题/「对话」/「项目」标签/搜索框随列表一起向上滚走;空间充足时它不溢出,
            内部列表保持原有的 252px 独立滚动,视觉与旧版一致。底部操作区在容器外
            shrink-0,始终钉在弹层底部。 */}
        <div
          ref={setUpperScrollEl}
          data-folder-picker-scroll={upperScrollOverflows ? true : undefined}
          onScroll={updateUpperScrollFade}
          className={cn(
            'pending-queue-scroll -mr-2 flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain pr-2',
            // relative 让 sticky 搜索框的 offsetTop 相对本容器取值(钉住判定用)。
            'relative',
            // 键盘 Tab/Shift+Tab 聚焦行时浏览器按 block:nearest 滚进视口:scroll-pt-9
            // 留出 sticky 搜索框的高度(input h-8 + pb-1 = 36px),向上聚焦的行落在搜索框
            // 下方而不是被它的不透明底遮住。充足态容器不滚动,无副作用。
            searchAnchorEl && 'scroll-pt-9',
            upperScrollFade.top && 'folder-picker-fade-top',
            upperScrollFade.bottom && 'folder-picker-fade-bottom',
          )}
        >
          {isProjectPicker && (
            <>
              {allowDialogue && (
                <>
                  <div className="shrink-0 px-3 py-2">
                    <span className="text-xs font-normal text-[var(--folder-label)]">
                      {t('newChat.folderPicker.dialogueOrSelectProject')}
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={selectionPending}
                    onClick={() => handleSelectPath('', 'dialogue')}
                    className={cn(
                      'flex w-full shrink-0 items-center gap-3 rounded-[8px] px-3 py-[10px] text-left',
                      'transition-colors outline-none',
                      'hover:bg-[var(--folder-item-hover)]',
                    )}
                  >
                    <MessageCircle size={20} className="shrink-0 text-[var(--folder-item-icon)]" />
                    <span className="relative top-px text-sm font-medium text-[var(--folder-item-name)]">
                      {t('newChat.folderPicker.dialogue')}
                    </span>
                  </button>
                </>
              )}
              <div className="shrink-0 px-3 pb-1 pt-3">
                <span className="text-xs font-normal text-[var(--folder-label)]">
                  {t('newChat.folderPicker.projects')}
                </span>
              </div>
              {showProjectSearch && (
                // sticky 钉在滚动区顶部:溢出态下标题/「对话」/「项目」标签与列表可以
                // 向上滚走,搜索框始终可见;不透明底与弹层同色,滚过的内容从它下面经过
                // 不重叠、不透字。充足态容器不滚动,sticky 无效果,外观与旧版一致。
                <div
                  ref={setSearchAnchorEl}
                  data-folder-picker-search="true"
                  className="sticky top-0 z-10 shrink-0 bg-[var(--folder-picker-bg)] px-1 pb-1"
                >
                  <div className="relative">
                    <Search
                      size={12}
                      className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--folder-item-path)]"
                    />
                    <input
                      ref={projectSearchRef}
                      type="text"
                      value={projectQuery}
                      onChange={(e) => {
                        setProjectQuery(e.target.value);
                        // 列表处于普通文档流,即使搜索框已经 sticky 吸顶,仍能从列表
                        // 坐标还原其流内位置。减去搜索框高度,让首项完整出现在它下方。
                        if (upperScrollOverflows && upperScrollEl && projectScrollEl) {
                          upperScrollEl.scrollTop =
                            projectScrollEl.getBoundingClientRect().top -
                            upperScrollEl.getBoundingClientRect().top +
                            upperScrollEl.scrollTop -
                            (searchAnchorEl?.getBoundingClientRect().height ?? 0);
                        } else if (projectScrollEl) {
                          projectScrollEl.scrollTop = 0;
                        }
                      }}
                      onKeyDown={(e) => {
                        // 弹层经 portal 渲染,React 事件仍会冒泡到所在的输入区;搜索框的按键只归它自己。
                        e.stopPropagation();
                        if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                        const first = activeProjectQuery ? visibleProjectOptions[0] : undefined;
                        if (!first) return;
                        e.preventDefault();
                        void handleSelectPath(first.path, 'project', first);
                      }}
                      placeholder={t('newChat.folderPicker.searchProjects')}
                      aria-label={t('newChat.folderPicker.searchProjects')}
                      className={cn(
                        'h-8 w-full rounded-full border border-[var(--folder-picker-border)] bg-transparent',
                        'pl-7 pr-2 text-13 text-[var(--folder-item-name)] outline-none',
                        // DESIGN.md §4 Inputs & Forms:单行 input 一律 pill;placeholder 与 focus
                        // 对齐分支选择器的搜索框。
                        'placeholder:text-[var(--text-placeholder)]',
                        'focus:border-[var(--focus-ring)] focus:ring-1 focus:ring-[var(--focus-ring-soft)]',
                      )}
                    />
                  </div>
                </div>
              )}
              <div
                ref={setProjectScrollEl}
                data-folder-picker-list="true"
                // 滚动标记只在上半区不溢出时挂在列表上:上半区接管滚动后滚轮
                // 交给外层容器,否则最近的那个 scroll 标记会抢到不滚动的列表。
                {...(upperScrollOverflows ? {} : { 'data-folder-picker-scroll': true })}
                onScroll={updateScrollFade}
                className={cn(
                  upperScrollOverflows
                    ? // 上半区在整体滚动:列表取消自身高度上限、不再自滚,内容全高交给
                      // 外层一条滚动条,避免嵌套双滚动条;shrink-0 保证不被压回一行以内。
                      '-mr-2 shrink-0 overflow-x-hidden pr-2'
                    : cn(
                        // 上半区放得下:列表维持原契约 —— flex-1 + min-h-0 可收缩,
                        // 252px 上限内独立滚动,第 5 行露半截提示可滚。
                        'pending-queue-scroll -mr-2 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pr-2',
                        scrollFade.top && 'folder-picker-fade-top',
                        scrollFade.bottom && 'folder-picker-fade-bottom',
                        'min-h-0',
                        PROJECT_LIST_MAX_HEIGHT_CLASS,
                      ),
                )}
              >
                {deviceScope?.status === 'loading' ? (
                  <div className="flex items-center gap-2 px-3 py-[10px] text-sm text-[var(--folder-item-path)]">
                    <span className="inline-flex shrink-0 animate-spinner motion-reduce:animate-none">
                      <Loader2 size={14} />
                    </span>
                    <span>{t('newChat.addRemoteProject.existingLoading')}</span>
                  </div>
                ) : deviceScope?.status === 'error' ? (
                  <>
                    <ErrorNotice
                      role="alert"
                      className="mx-1"
                      message={t('newChat.folderPicker.remoteProjectsLoadFailed', {
                        device: deviceScope.deviceName,
                      })}
                      actions={
                        deviceScope.retry && (
                          <Button
                            size="sm"
                            compact
                            disabled={selectionPending}
                            onClick={deviceScope.retry}
                          >
                            <RefreshCw size={12} />
                            {t('newChat.folderPicker.retryRemoteProjects')}
                          </Button>
                        )
                      }
                    />
                    {visibleProjectOptions.map(renderProject)}
                  </>
                ) : visibleProjectOptions.length > 0 ? (
                  visibleProjectOptions.map(renderProject)
                ) : activeProjectQuery ? (
                  <div
                    role="status"
                    className="px-3 py-[10px] text-sm text-[var(--folder-item-path)]"
                  >
                    {t('newChat.folderPicker.noMatchingProjects')}
                  </div>
                ) : deviceScope && onAddRemoteProject ? (
                  /* 对端设备上一个项目都没有:空态里直接给「浏览文件夹」,并带着设备身份进弹窗 ——
                   否则用户得自己退出去找入口,而这台机器恰恰是最可能需要新建目录的。 */
                  <div className="flex items-center justify-between gap-3 px-3 py-[10px]">
                    <span className="min-w-0 text-xs text-[var(--folder-item-path)]">
                      {t('newChat.addRemoteProject.existingEmpty')}
                    </span>
                    <button
                      type="button"
                      disabled={selectionPending}
                      onClick={() => {
                        onAddRemoteProject(deviceScope.deviceId);
                        onOpenChange(false);
                      }}
                      className="shrink-0 text-xs font-medium text-[var(--folder-item-name)] hover:underline"
                    >
                      {t('newChat.addRemoteProject.tabBrowse')}
                    </button>
                  </div>
                ) : (
                  <div className="px-3 py-[10px] text-sm text-[var(--folder-item-path)]">
                    {t('newChat.folderPicker.noProjects')}
                  </div>
                )}
              </div>
            </>
          )}

          {/* Recent folders — same contract as the project list: the label scrolls
            with the list inside the shared upper region; only the divider and
            footer actions stay pinned below. */}
          {!isProjectPicker && recentFolders.length > 0 && (
            <>
              <div className="shrink-0 px-3 py-2">
                <span className="text-xs font-normal text-[var(--folder-label)]">
                  {t('newChat.folderPicker.recent')}
                </span>
              </div>
              <div
                ref={setProjectScrollEl}
                data-folder-picker-list="true"
                {...(upperScrollOverflows ? {} : { 'data-folder-picker-scroll': true })}
                className={cn(
                  upperScrollOverflows
                    ? '-mr-2 shrink-0 overflow-x-hidden pr-2'
                    : cn(
                        'pending-queue-scroll -mr-2 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pr-2',
                        'min-h-0',
                        PROJECT_LIST_MAX_HEIGHT_CLASS,
                      ),
                )}
              >
                {recentFolders.map((folder) => (
                  <button
                    key={folder.path}
                    type="button"
                    disabled={selectionPending}
                    onClick={() => handleSelectPath(folder.path, 'recent')}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-[8px] px-3 py-[10px] text-left',
                      'transition-colors outline-none',
                      'hover:bg-[var(--folder-item-hover)]',
                    )}
                  >
                    <Folder size={20} className="shrink-0 text-[var(--folder-item-icon)]" />
                    <div className="flex min-w-0 flex-1 flex-col items-start">
                      <span className="w-full truncate text-sm font-medium text-[var(--folder-item-name)]">
                        {folder.name}
                      </span>
                      <span className="w-full truncate text-xs text-[var(--folder-item-path)]">
                        {folder.path}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* 分隔线与下方操作区一起钉在弹层底部,不进上半滚动区。 */}
        {(isProjectPicker || recentFolders.length > 0) && (
          <div className="mx-2 my-1 h-px shrink-0 bg-[var(--folder-picker-border)]" />
        )}

        {browseFailed && (
          <ErrorNotice
            role="alert"
            className="mx-1 shrink-0"
            message={t('newChat.folderPicker.browseFailed')}
          />
        )}
        {/* Choose a different folder */}
        <button
          type="button"
          disabled={selectionPending}
          onClick={handleChooseDifferent}
          className={cn(
            'flex w-full shrink-0 items-center gap-3 rounded-[8px] px-3 py-[10px] text-left',
            'transition-colors outline-none',
            'hover:bg-[var(--folder-item-hover)]',
          )}
        >
          <FolderPlus size={20} className="shrink-0 text-[var(--folder-item-icon)]" />
          {/* CJK label 视觉重心比 icon 偏高,nudge 1px 居中。与 chip 上 "对话" 同样处理。 */}
          <span className="relative top-px text-sm font-medium text-[var(--folder-item-name)]">
            {isProjectPicker
              ? t('newChat.folderPicker.browseProjectFolder')
              : t('newChat.folderPicker.browseFolder')}
          </span>
        </button>

        {/* Phase D: 添加远程项目入口。仅 isProjectPicker 且上层传了
            onAddRemoteProject (即至少一台 host 勾了 autoConnect) 时显示,
            位置紧贴「选择其他项目文件夹」下方 — 跟用户要求一致。

            **已选定远程设备时不出现**(2026-07-30 用户裁决)。三条理由:
              · 职责已被上面那项承担 —— deviceScope 存在时「选择其他项目文件夹」点下去就是浏览
                这台设备的文件夹(见 handleBrowse),两个入口并列只是让人以为它们是两件事;
              · 它**不带 deviceId**,弹窗会让用户从头重选目标 —— 于是可以从设备 A 的语境里点一个
                叫「添加远程项目」的入口、选到设备 B,等于绕过设备 pill 改掉了设备这一级维度。
                #807 方案 B 的前提就是「设备是一级维度、由设备 pill 独占」,这条路径与之冲突;
              · SSH 与 device-link 本就互斥(remoteHostId / deviceLinkDeviceId 二者只能有一个),
                所以「在对端设备的语境里添加 SSH 项目」本身是语境错位;要用 SSH 先把设备切回本机,
                与设备 pill 的语义一致。
            对端一个项目都没有时的空态入口不受影响 —— 那条走 tabBrowse 且**带**设备身份。 */}
        {isProjectPicker && onAddRemoteProject && !deviceScope && (
          <button
            type="button"
            disabled={selectionPending}
            onClick={() => {
              onAddRemoteProject();
              onOpenChange(false);
            }}
            className={cn(
              'flex w-full shrink-0 items-center gap-3 rounded-[8px] px-3 py-[10px] text-left',
              'transition-colors outline-none',
              'hover:bg-[var(--folder-item-hover)]',
            )}
          >
            <Globe size={20} className="shrink-0 text-[var(--folder-item-icon)]" />
            <span className="relative top-px text-sm font-medium text-[var(--folder-item-name)]">
              {t('newChat.projectPicker.addRemoteProject')}
            </span>
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
