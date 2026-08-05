/**
 * ProjectNode — 单个 Project 节点（Header + 受控折叠的子 sessions）
 * ---------------------------------------------------------------------------
 * Project 节点视觉规格：
 *   - Project Header：高 28 / 圆角 6 / padding [0, 8] / gap 6
 *     · chevron-right (折叠) / chevron-down (展开)，14×14 #737373
 *     · displayName Inter 14 / 500 #262626 (Light) / #f5f5f5 (Dark)
 *     · 整行 hover 高亮 sidebar-item-hover
 *   - Project Sessions：padding [2, 0, 0, 0] / gap 2 vertical
 *     缩进 18px 由 SessionItem 自身（indented=true → pl-[18px]）承担，本容器不重复加 pl
 *     折叠时不渲染该容器
 *
 * 交互：
 *   - 点击 Header → onToggle(workingDir)
 *   - 键盘可达：role=button, tabIndex=0, Enter/Space 触发 toggle
 *   - aria-expanded 反映 !isCollapsed
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  EllipsisVertical,
  Folder,
  FolderOpen,
  SquarePen,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/lib/toast';
import { buildProjectDeepLink } from '@/lib/deepLink';
import { createLogger } from '@/lib/logger';
import { SectionCollapse } from '../SectionCollapse';
import { SessionEntryList } from '../SessionEntryList';
import type { SessionClickHandler } from '../SessionItem';
import type { ProjectNode as ProjectNodeData } from '../../lib/projectGrouping';
import type {
  AutomationScheduleAction,
  AutomationScheduleSessionInfo,
  AutomationSessionGroup,
} from '../../lib/automationSidebarGrouping';
import { getProjectSessionCollapseLimit } from '../../lib/sidebarCollapseConfig';
import type { FolderPickerOption } from '@/components/new-chat/FolderPickerPopover';
import type { SessionMoveTarget } from '../sessionMoveTarget';
import type { FilterStatus } from '../../hooks/useSidebarFilter';
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS, MENU_SEPARATOR_CLASS } from '../menuStyles';
import { RemoteProjectIcon } from '../RemoteProjectIcon';
import { isDeviceLinkWriteBlocked } from '../../lib/remoteSessionWriteGuard';
import { projectBulkArchiveActionForStatus } from '../../lib/projectBulkArchiveAction';
import { getRemoteProjectMachineIdentity } from '../../lib/remoteProjectIdentity';

const log = createLogger('ProjectNode');

export interface ProjectNodeProps {
  project: ProjectNodeData;
  /** Optional visible subset; project-level actions still receive the full project. */
  displaySessions?: ProjectNodeData['sessions'];
  /** 置顶栏列表模式可让展开后的会话使用满宽列表行；普通项目默认仍是紧凑文字行。 */
  sessionVariant?: 'text' | 'list';
  /** 当前会话状态筛选，决定项目菜单是批量归档还是批量恢复。 */
  statusFilter: FilterStatus;
  isCollapsed: boolean;
  /** 父级 Projects 段整体收起时,也要让项目内「显示全部」在动画后复位。 */
  parentSectionCollapsed: boolean;
  activeSessionId?: string;
  runningSessionIds: ReadonlySet<string>;
  /** /ctr 接管中的 sessionIds — SessionItem 用来切换左侧 icon */
  attachedSessionIds: ReadonlySet<string>;
  notifications: ReadonlySet<string>;
  scheduleSessionIndex: ReadonlyMap<string, AutomationScheduleSessionInfo>;
  selectedSessionIds?: ReadonlySet<string>;
  /** Sidebar 内容过滤态或时间升序排序下强制展示全部 session entry。 */
  disableSessionCollapse: boolean;
  onToggle: (projectKey: string) => void;
  /** Project pin is independent from conversation pin state. */
  isProjectPinned: boolean;
  onToggleProjectPin: (project: ProjectNodeData, currentlyPinned: boolean) => void;
  onRenameProject: (project: ProjectNodeData, alias: string) => Promise<void>;
  /** 仅隐藏本地项目的侧栏入口，不改变其中任务的生命周期。 */
  onRemoveFromSidebar: (project: ProjectNodeData) => void;
  onSessionClick: SessionClickHandler;
  onAction: (id: string, action: 'delete' | 'archive' | 'archive-now' | 'unarchive') => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string, currentlyPinned: boolean) => void;
  onMoveSession?: (id: string, target: SessionMoveTarget) => void;
  projectOptions?: readonly FolderPickerOption[];
  onScheduleAction: (group: AutomationSessionGroup, action: AutomationScheduleAction) => void;
  /** delayed-create:在该 project 的 workingDir 下进 transient draft route。 */
  onCreateInProject: (project: ProjectNodeData) => void;
  /** 用当前 project 锁定全局对话搜索入口。 */
  onOpenConversationSearch: (project: ProjectNodeData) => void;
  /** 在系统文件管理器中打开该 project 的 workingDir。 */
  onOpenInExplorer: (workingDir: string) => void;
  onLinkCodexProject: (project: ProjectNodeData) => void;
  linkingCodexProject: boolean;
  /** 进入 workdir 文件浏览模式 (vscode-style file tree + body viewer)。
   *  父层负责挑出该 project 下「最近活跃且非 archived」的 session 并 navigate
   *  到 /cc-agent/files/:sessionId。 */
  onBrowseFiles: (project: ProjectNodeData) => void;
  /** 右键菜单 → 归档该 project 下所有非执行中的 session（带二次确认）。 */
  onArchiveAll: (project: ProjectNodeData) => void;
}

export function ProjectNode({
  project,
  displaySessions,
  sessionVariant = 'text',
  statusFilter,
  isCollapsed,
  parentSectionCollapsed,
  activeSessionId,
  runningSessionIds,
  attachedSessionIds,
  notifications,
  scheduleSessionIndex,
  selectedSessionIds,
  disableSessionCollapse,
  onToggle,
  isProjectPinned,
  onToggleProjectPin,
  onRenameProject,
  onRemoveFromSidebar,
  onSessionClick,
  onAction,
  onRename,
  onTogglePin,
  onMoveSession,
  projectOptions,
  onScheduleAction,
  onCreateInProject,
  onOpenConversationSearch,
  onOpenInExplorer,
  onLinkCodexProject,
  linkingCodexProject,
  onBrowseFiles,
  onArchiveAll,
}: ProjectNodeProps) {
  const { t } = useTranslation();
  // remote 项目复用本地专属入口（在文件管理器打开 / 复制深链 / 同步 Codex）会按本机
  // 路径误操作或丢失 host 身份，故这些入口对 remote 一律隐藏；host-aware 版本后续单独迭代。
  const isRemote = project.scope === 'remote';
  // device-link 远程项目(被控设备的项目):与 SSH remote 一样隐藏本机 FS 入口,
  // 但徽标用设备 icon 而非 SSH 的 Globe,tooltip 显示设备名。
  const isDeviceLink = project.deviceLinkDeviceId != null;
  const remoteIdentity = getRemoteProjectMachineIdentity(project);
  const projectWritesBlocked = isDeviceLinkWriteBlocked(project);
  const bulkArchiveAction = projectBulkArchiveActionForStatus(statusFilter);
  // 项目图标两态(2026-07 用户定稿,参考 MivoCanvas):收起 Folder / 展开 FolderOpen,
  // 常驻在标题左侧;展开/收起指示箭头移到标题右侧、hover 才渐显(见下方 Chevron)。
  const FolderIcon = isCollapsed ? Folder : FolderOpen;
  const Chevron = isCollapsed ? ChevronRight : ChevronDown;
  // 右键菜单：参照 ChatImageView 的 controlled DropdownMenu + 隐形定位 trigger 模式，
  // 鼠标点击位置即菜单出现位置。
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [isEditingName, setIsEditingName] = useState(false);
  const [editValue, setEditValue] = useState(project.displayName);
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  const beginRename = useCallback(() => {
    setMenuPos(null);
    setEditValue(project.displayName);
    committedRef.current = false;
    setIsEditingName(true);
  }, [project.displayName]);

  const commitRename = useCallback(async () => {
    if (committedRef.current) return;
    committedRef.current = true;
    const trimmed = editValue.trim();
    setIsEditingName(false);
    if (trimmed !== project.displayName) {
      try {
        await onRenameProject(project, trimmed);
      } catch {
        committedRef.current = false;
      }
    }
  }, [editValue, onRenameProject, project]);

  useEffect(() => {
    if (isEditingName && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditingName]);

  // 复制 cindy://project/<urlencoded-workingDir> 到剪贴板。
  // workingDir 是 POSIX 全路径,会被 encodeURIComponent 编码进 URL,跨机粘贴
  // 时若对方没这个 workingDir 会在 sidebar 那侧 toast "project not found"。
  const handleCopyDeepLink = useCallback(async () => {
    const link = buildProjectDeepLink(project.workingDir);
    try {
      await navigator.clipboard.writeText(link);
      toast.success(t('ccAgent.sidebar.deepLink.copied'));
    } catch (err) {
      log.warn('clipboard write failed', err);
      toast.warning(t('ccAgent.sidebar.deepLink.copyFailed'));
    }
  }, [project.workingDir, t]);

  const handleCreateInProject = useCallback(() => {
    if (projectWritesBlocked) {
      toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
      return;
    }
    onCreateInProject(project);
  }, [onCreateInProject, project, projectWritesBlocked, t]);

  const handleArchiveAll = useCallback(() => {
    if (projectWritesBlocked) {
      toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
      return;
    }
    setMenuPos(null);
    onArchiveAll(project);
  }, [onArchiveAll, project, projectWritesBlocked, t]);

  const handleRemoveFromSidebar = useCallback(() => {
    setMenuPos(null);
    onRemoveFromSidebar(project);
  }, [onRemoveFromSidebar, project]);

  return (
    // 两个 data 属性各自服务不同消费者:
    //   - data-project-working-dir : Sortable drop-target 识别 (历史: ProjectsSection 手写拖拽热区,
    //                                现已被 SortableList 接管,但保留供深度链接/测试 hook)
    //   - data-project-workingdir  : CCAgentSidebarUpper 深度链接 scrollIntoView
    // 名字差一个连字符是历史遗留,保留两个比贸然统一更稳。
    <div
      data-project-working-dir={project.projectKey}
      data-project-workingdir={project.projectKey}
      className={cn('relative flex flex-col w-full select-none')}
    >
      {/* Project Header
          group 用于 hover 显示右侧 More / + New 图标按钮。
          data-project-workingdir 挂在外层 wrapper 上 — 深度链接 scrollIntoView
          需要据此 querySelector 定位该 project 节点。 */}
      <div
        data-project-header="true"
        role="button"
        tabIndex={0}
        aria-expanded={!isCollapsed}
        onClick={() => {
          if (!isEditingName) onToggle(project.projectKey);
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          beginRename();
        }}
        onKeyDown={(e) => {
          if (isEditingName) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle(project.projectKey);
          }
        }}
        onContextMenu={(e) => {
          if (isEditingName) return;
          e.preventDefault();
          e.stopPropagation();
          setMenuPos({ x: e.clientX, y: e.clientY });
        }}
        className={cn(
          // pl-3:树容器 pl-3(12) + 本行 pl-3(12) = 图标左缘 24px,与顶部四行图标
          // (容器 pl-3 + 行 px-3)、段标题(pl-6)同一左对齐线(2026-07 用户定稿)。
          // gap-2.5(10px)与顶部导航行同款 → 项目名与「新建/自动化」同一文字列;
          // font-normal:与顶部导航行同粗细(2026-07 用户定稿,原 font-medium 偏重)。
          // 文字色与文件夹图标同款 meta 灰(比会话标题的 foreground 淡一档,
          // 2026-07 用户定稿:项目行作分组容器退后半步,让会话行更突出)。
          // h-8 + rounded-full:hover 底与顶部导航行 / 会话行同款药丸形,三处
          // 高度、圆角、左右边界(同容器 w-full)完全一致(2026-07 用户定稿)。
          'group flex h-8 w-full items-center gap-2.5 rounded-full pl-3 pr-1',
          'text-sm font-normal text-[var(--sidebar-list-muted)]',
          // 整行点击 = toggle 折叠，常态用 pointer。即便支持手动拖拽排序也不显示
          // grab 光标——只有真正进入拖拽时（SortableList onStart 给 body 挂
          // .xdt-sorting → 全局 grabbing）才切到拖动光标，避免"hover 上去就像在拖动"。
          isEditingName ? 'cursor-text' : 'cursor-pointer',
          'transition-colors',
          !isEditingName && 'hover:bg-sidebar-item-hover',
        )}
      >
        <FolderIcon
          size={15}
          strokeWidth={1.8}
          className="shrink-0 text-[var(--sidebar-list-muted)]"
        />
        {/* 名字 + remote identity 同组占据 flex-1。远程项目常态展示机器身份,
            避免相同 workingDir 的项目只能靠 hover 才能区分。 */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {isEditingName ? (
            <input
              ref={inputRef}
              value={editValue}
              aria-label={t('ccAgent.sidebar.projectAlias.inputLabel')}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void commitRename();
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setIsEditingName(false);
                }
              }}
              onClick={(e) => e.stopPropagation()}
              className={cn(
                'min-w-0 flex-1 h-6 px-1.5 rounded',
                'text-sm font-normal text-foreground',
                'bg-transparent outline-none',
                'border-[1.5px] border-[var(--focus-ring)]',
              )}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate">{project.displayName}</span>
          )}
          {!isEditingName && isDeviceLink ? (
            <Tip text={remoteIdentity?.displayLabel ?? project.deviceLinkDeviceId ?? ''}>
              <RemoteProjectIcon
                kind="device-link"
                connectionStatus={project.deviceLinkConnectionStatus}
                className="text-[var(--folder-item-icon)]"
              />
            </Tip>
          ) : !isEditingName && isRemote ? (
            <Tip text={remoteIdentity?.displayLabel ?? project.remoteHostId ?? ''}>
              <RemoteProjectIcon kind="ssh" className="text-[var(--folder-item-icon)]" />
            </Tip>
          ) : null}
          {!isEditingName && remoteIdentity ? (
            <span
              title={remoteIdentity.displayLabel}
              className="max-w-[45%] shrink truncate text-[11px] text-[var(--cmd-palette-item-meta)]"
            >
              {remoteIdentity.displayLabel}
            </span>
          ) : null}
          {/* 展开/收起指示箭头:标题右侧、hover 才渐显(参考 MivoCanvas 的
              row-hover-arrow;仅 opacity 渐显,不做位移,守 docs/design-rules/cindy-design-system.md §14.4)。 */}
          {!isEditingName && (
            <Chevron
              size={13}
              strokeWidth={2}
              aria-hidden
              className="shrink-0 text-[var(--cmd-palette-item-meta)] opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100"
            />
          )}
        </div>
        {/* 悬浮工具组——常态隐藏，hover 整行时淡入。
            stopPropagation 阻止冒泡触发 Header 的 toggle。 */}
        {!isEditingName && (
          <div
            className={cn(
              'shrink-0 flex items-center gap-0.5',
              'opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100',
            )}
          >
            {/* More 按钮 —— 点击锚定 menuPos 到按钮正下方,复用下面同一份
                DropdownMenu(右键也走它,菜单 items 一份维护)。原本 Search /
                ShowFiles / OpenInExplorer 三个独立按钮整合到这个菜单里。 */}
            <ProjectAction
              label={t('ccAgent.common.moreActions')}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setMenuPos({ x: rect.left, y: rect.bottom + 2 });
              }}
            >
              <EllipsisVertical size={14} strokeWidth={2} />
            </ProjectAction>
            {/* delayed-create:在此目录新建会话——保留为独立按钮(primary 操作,
                跟 SessionItem 的 Archive/Undo 等位)。父层会预填 workingDir 到
                newMakerDraft store 并 navigate('/cc-agent/new')。vendor 由
                NewMakerDraftRoute 内的 segmented switcher 决定(默认走用户上次选择)。 */}
            <ProjectAction
              label={
                projectWritesBlocked
                  ? t('ccAgent.remoteSession.actionsUnavailable')
                  : t('ccAgent.sidebar.projectAction.newInDirectory')
              }
              disabled={projectWritesBlocked}
              onClick={handleCreateInProject}
            >
              <SquarePen size={14} strokeWidth={2} />
            </ProjectAction>
          </div>
        )}
      </div>

      {/* 右键菜单：与消息流图片右键菜单（ChatImageView）同款 DropdownMenu。 */}
      <DropdownMenu
        open={menuPos !== null}
        onOpenChange={(open) => {
          if (!open) setMenuPos(null);
        }}
      >
        <DropdownMenuTrigger asChild>
          <span
            aria-hidden
            style={{
              position: 'fixed',
              left: menuPos?.x ?? 0,
              top: menuPos?.y ?? 0,
              width: 0,
              height: 0,
              pointerEvents: 'none',
            }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={2}
          // 统一菜单 surface(menuStyles):与 SessionItem / Dialogue / 自动化 等同款
          className={cn(MENU_CONTENT_CLASS, 'min-w-[160px] overflow-hidden')}
        >
          <DropdownMenuItem
            onClick={() => {
              beginRename();
            }}
            className={MENU_ITEM_CLASS}
          >
            {t('ccAgent.sidebar.projectAction.rename')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              setMenuPos(null);
              onToggleProjectPin(project, isProjectPinned);
            }}
            className={MENU_ITEM_CLASS}
          >
            {t(
              isProjectPinned
                ? 'ccAgent.sidebar.projectAction.unpin'
                : 'ccAgent.sidebar.projectAction.pin',
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator className="my-1 h-px bg-[var(--cmd-palette-border)]" />
          {/* 菜单 items 顺序:浏览 → 工具 → 危险
              [搜索, 查看文件, 在文件管理器中打开] - [复制深度链接, 同步 Codex] - [全部归档]
              与 SessionItem 风格保持一致:纯文字、无 icon。
              remote 项目隐藏「查看文件 / 在文件管理器中打开 / 复制深链 / 同步 Codex」四项:
              前三者均按本机路径误操作或丢 host 身份;「查看文件」走本地文件 IPC、读不到远端
              host 文件系统(只能 fallback 跳对话页,反直觉),在 host-aware 远端浏览能力落地
              前一并屏蔽。remote 菜单收敛为 [搜索] - [全部归档]。
              注:handleBrowseFiles 的 remote 重定向 + WorkdirBrowseRoute 路由守卫保留,
              作为直达 /cc-agent/files/:id 的安全兜底。 */}
          <DropdownMenuItem
            onClick={() => {
              setMenuPos(null);
              onOpenConversationSearch(project);
            }}
            className={MENU_ITEM_CLASS}
          >
            {t('ccAgent.sidebar.projectAction.search')}
          </DropdownMenuItem>
          {!isRemote && (
            <>
              <DropdownMenuItem
                onClick={() => {
                  setMenuPos(null);
                  onBrowseFiles(project);
                }}
                className={MENU_ITEM_CLASS}
              >
                {t('ccAgent.sidebar.projectAction.showFiles')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  setMenuPos(null);
                  onOpenInExplorer(project.workingDir);
                }}
                className={MENU_ITEM_CLASS}
              >
                {t('ccAgent.sidebar.projectAction.openInExplorer')}
              </DropdownMenuItem>
              <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />
              <DropdownMenuItem
                onClick={() => {
                  setMenuPos(null);
                  void handleCopyDeepLink();
                }}
                className={MENU_ITEM_CLASS}
              >
                {t('ccAgent.sidebar.projectAction.copyDeepLink')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  setMenuPos(null);
                  onLinkCodexProject(project);
                }}
                disabled={linkingCodexProject}
                className={MENU_ITEM_CLASS}
              >
                {t('ccAgent.sidebar.projectAction.syncCodex')}
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />
          {project.scope === 'local' && (
            <DropdownMenuItem onClick={handleRemoveFromSidebar} className={MENU_ITEM_CLASS}>
              {t('ccAgent.sidebar.projectAction.removeFromSidebar')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            disabled={projectWritesBlocked}
            onClick={() => {
              handleArchiveAll();
            }}
            className={MENU_ITEM_CLASS}
          >
            {t(
              bulkArchiveAction === 'unarchive'
                ? 'ccAgent.sidebar.projectAction.unarchiveAll'
                : 'ccAgent.sidebar.projectAction.archivedAll',
            )}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Project Sessions（容器只负责 gap + 顶部 padding；左缩进由 SessionItem 自身承担）
          展开/收起走 SectionCollapse 高度动画；「显示全部」在收起动画结束后复位。
          data-no-drag: 拦截 SortableList 默认 filter,阻止"鼠标落在子 session 上按下"
          被父层 ProjectsSection SortableList 当成"拖动整个 ProjectNode"的起点。
          SessionItem 的 root 是 role="button" 而非 <button> 标签,默认 filter 拦不下来。 */}
      <SectionCollapse collapsed={isCollapsed} data-no-drag>
        {/* pb-1.5:展开块与下一个项目标题之间的间距(4px 树 gap + 6px = 10px),
            大于会话行间距(gap-0.5),让项目块之间有分组呼吸(参考 Codex,2026-07 定稿)。 */}
        <div
          className={cn(
            'flex flex-col gap-0.5 pt-0.5 pb-1.5 pr-0',
            sessionVariant === 'list' ? 'pl-3' : 'pl-0',
          )}
        >
          <SessionEntryList
            sessions={displaySessions ?? project.sessions}
            activeSessionId={activeSessionId}
            runningSessionIds={runningSessionIds}
            attachedSessionIds={attachedSessionIds}
            notifications={notifications}
            scheduleSessionIndex={scheduleSessionIndex}
            selectedSessionIds={selectedSessionIds}
            collapsible
            collapseLimit={getProjectSessionCollapseLimit()}
            disableCollapse={disableSessionCollapse}
            sectionCollapsed={isCollapsed || parentSectionCollapsed}
            onSessionClick={onSessionClick}
            onAction={onAction}
            onRename={onRename}
            onTogglePin={onTogglePin}
            onMoveSession={onMoveSession}
            projectOptions={projectOptions}
            onScheduleAction={onScheduleAction}
            indented
            sessionVariant={sessionVariant}
          />
        </div>
      </SectionCollapse>
    </div>
  );
}

interface ProjectActionProps {
  label: string;
  /** 事件参数可选 —— More 按钮用 e.currentTarget 拿 BoundingRect 锚定菜单位置,
   *  其它直接动作按钮(SquarePen)忽略事件即可。 */
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  children: React.ReactNode;
}

/** Project Header 右侧图标按钮——尺寸/视觉与 SessionItem 的 ⋮ 同套规格。 */
function ProjectAction({ label, onClick, disabled = false, children }: ProjectActionProps) {
  return (
    <Tip text={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          if (disabled) return;
          onClick(e);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        className={cn(
          'shrink-0 size-5 flex items-center justify-center rounded-md',
          'text-sidebar-action-icon hover:text-foreground',
          'hover:bg-sidebar-item-hover focus:outline-none',
          'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
        )}
      >
        {children}
      </button>
    </Tip>
  );
}
