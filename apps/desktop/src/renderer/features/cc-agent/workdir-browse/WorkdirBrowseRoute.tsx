/**
 * WorkdirBrowseRoute — `/cc-agent/files/:sessionId`.
 *
 * Layout (in this order on the page):
 *   ┌────────────────────────────────────────────────────────────┐
 *   │ [sidebar Shell — owns FileTreeView, see CCAgentSidebarUpper]│
 *   │ <Outlet> here:                                              │
 *   │   ┌─────────────────────────────┬──────────────────────────┐│
 *   │   │ FileBodyView (fill)          │ CCAgentSessionView (rail)││
 *   │   └─────────────────────────────┴──────────────────────────┘│
 *   └────────────────────────────────────────────────────────────┘
 *
 * Right rail strategy: render the existing `CCAgentSessionView` inside a
 * width-constrained column. CCAgentSessionView reads sessionId from URL
 * params and loads the chat as it normally would — no fork required.
 *
 * Rail width is user-resizable via a drag handle on its left edge
 * (useChatRailResize: 400 default, 400-1120 bounds, persisted to localStorage).
 *
 * Caveat (documented in design discussion): four message-card components
 * (PermissionPrompt / AskUserQuestionPrompt / Plan*Card) hardcode width
 * 914px. They will overflow horizontally inside the narrow rail; the rail
 * container has `overflow-x-auto` so they degrade to scrollable cards rather
 * than break layout. Long-term fix: make those cards `max-w-[914px] w-full`.
 *
 * Selected file is encoded in URL search param `?file=<relPath>`. The sidebar's
 * FileTreeView reads / writes the same param — single source of truth.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { useCCSessions } from '@/hooks/useCCSessions';
import { InteractionPromptSlot } from '@/components/interaction-portal';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { makerChatStore } from '@/lib/makerChatStore';
import { discardDraft as discardComposerDraft } from '@/lib/composerDraftStore';
import { fetchDirtyWorktreeForRemoval } from '@/lib/worktreeRemovalWarning';
import * as sessionService from '@/lib/sessionService';
import { getDraft, getFastModeForModel } from '@/state/newMakerDraft';
import { isAgentIslandSupported } from '@/hooks/useAgentIslandSettings';
import { resolveAgentIslandVisibleSessionIdForWorkdirBrowseRail } from '@/lib/agentIslandVisibleSessionRoute';
import type { AgentKind } from '@/lib/ccAgent.types';
import { CCAgentSessionView } from '../CCAgentSessionView';
import {
  comparePinnedByStatusThenPinnedDesc,
  compareSessionsByStatusThenSortTimeDesc,
  normalizeWorkingDir,
  projectIdentityKeyForSession,
} from '../lib/projectGrouping';
import { isOrcaLeadSession, isOrcaWorkerSession } from '@/lib/orcaSessionIdentity';
import { OrcaSplitView } from '../OrcaSplitView';
import { useFileContent } from './hooks/useFileContent';
import {
  getSessionDeviceId,
  remoteProjectsStore,
} from '@/features/device-link/remoteProjectsStore';
import { useChatRailResize } from './hooks/useChatRailResize';
import { useChatRailCollapsed } from './hooks/useChatRailCollapsed';
import { FileBodyView, type FileBodyHandle } from './FileBodyView';
import { useConfirmSwitchAwayIfDirty } from './hooks/useConfirmSwitchAwayIfDirty';
import { FileTabsBar } from './FileTabsBar';
import { SessionTabsBar } from './SessionTabsBar';
import { addTab as storeAddTab } from './lib/openTabsStore';
import { saveSelectedFile } from './lib/selectedFileStore';
import {
  buildNormalFileSelectionParams,
  clearConsumedSearchJumpParams,
} from './lib/fileSelectionParams';

const log = createLogger('cc-agent.workdir-browse.route');

export function WorkdirBrowseRoute() {
  const { t } = useTranslation();
  const { sessionId } = useParams<{ sessionId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  // Resolve workdir from session list (already cached in this feature's
  // shared sessions hook — no extra IPC).
  const sessionsHook = useCCSessions({ includeArchived: 'all' });
  const { confirm: confirmDialog, confirmThree } = useConfirmDialog();
  // 当前 active 文件对应的 FileBodyView 命令式句柄。关 tab 前用它探测
  // dirty / 触发 save。非 active tab 不挂载 FileBodyView,因此天然只能拿到
  // 当前文件的状态 —— 这正是我们要拦截的范围(只有正在编辑的文件可能丢内容)。
  const fileBodyRef = useRef<FileBodyHandle>(null);
  // device-link 镜像会话不在本地 DB 列表里,只按 sessionsHook 查会得到 null →
  // workdir 空串 → 路由落空视图。镜像快照兜底(useSyncExternalStore 订阅,
  // 断链/重连后列表变化会重渲染)。
  const remoteMirrorSessions = useSyncExternalStore(
    remoteProjectsStore.subscribe,
    remoteProjectsStore.getMergedRemoteSessions,
  );
  const currentSession = useMemo(
    () =>
      sessionId
        ? sessionsHook.sessions.find((s) => s.id === sessionId) ??
          remoteMirrorSessions.find((s) => s.id === sessionId) ??
          null
        : null,
    [sessionId, sessionsHook.sessions, remoteMirrorSessions],
  );
  const workdir = currentSession?.workingDir ?? '';
  // 会话归属三路(见 FileBrowserBody 同款注释):device-link 会话 deviceId 优先,
  // 其自带的 remoteHostId 是被控端的 SSH host,由被控端 device-op 二跳处理。
  const deviceId = useSyncExternalStore(remoteProjectsStore.subscribe, () =>
    sessionId ? getSessionDeviceId(sessionId) ?? null : null,
  );
  const remoteHostId = deviceId ? null : currentSession?.remoteHostId ?? null;
  const browsableWorkdir = workdir;

  // 若 URL :sessionId 指向的是 Orca Worker session, 自动 redirect 到它的 Lead。
  // 原因: SessionTabsBar 过滤掉所有 Worker (Worker 只能从 Lead 的协同视图进入),
  // Lead 才会渲染 OrcaSplitView toggle, 让用户看到熟悉的 [Lead | Worker] 切换。
  // 入口典型: 用户在 chat 协同模式 active pane 停在 Worker → 点 sidebar Browse Files,
  // handleBrowseFiles 直接拿 activeSessionId 跳到 /cc-agent/files/<workerId>, 此时
  // tab 不高亮 + chat 区落到 fallback CCAgentSessionView 看起来"什么都没选中"。
  useEffect(() => {
    if (!currentSession || !isOrcaWorkerSession(currentSession)) return;
    let cancelled = false;
    void window.electronAPI.localDb.orcaWorkflows
      .getByWorkerSession(currentSession.id)
      .then((workflow) => {
        if (cancelled || !workflow) return;
        const search = searchParams.toString();
        navigate(
          `/cc-agent/files/${workflow.leadSessionId}${search ? `?${search}` : ''}`,
          { replace: true },
        );
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [currentSession, navigate, searchParams]);

  // SessionTabsBar 的 tab 列表 = 当前 workdir 下所有 active 普通会话,按 sidebar
  // projects 内组内排序对齐
  // (pinned 优先 → status → pinnedAt/sortTime desc)。每次进 doc 模式 /
  // 新建 / 归档,这个 memo 都会基于最新 sessions 重算,SessionTabsBar 纯渲染,
  // 无需自己维护 "已打开" 列表。
  const sortedWorkdirSessions = useMemo(() => {
    if (!browsableWorkdir) return [];
    // 历史 session 写入 DB 时 path 分隔符不统一(例: 同一目录有的存
    // `C:/Smash/CakeIsland`、有的存 `C:\Smash\CakeIsland`),且 worktree session
    // 实际 cwd 是 `<repo>/.cindy-worktrees/<name>`（或历史托管目录）子目录。raw 字符串相等会把
    // 同一项目下的 session 拆成多个 doc 视图; 用 normalizeWorkingDir 归一后比较,
    // 与 sidebar projects 分组对齐(同一 project 的 session 在 doc 模式都能列出来)。
    const normWorkdir = normalizeWorkingDir(browsableWorkdir);
    if (!normWorkdir) return [];
    const currentProjectKey = currentSession ? projectIdentityKeyForSession(currentSession) : null;
    if (!currentProjectKey) return [];
    // Orca Worker session 在 sidebar 也是隐藏的 (CCAgentSidebarUpper.tsx),
    // Worker 的入口走 Lead 的 split-view (resolveSessionRoute),不该单独
    // 出现在 doc tab 里和 Lead 并列。
    const list = sessionsHook.sessions.filter(
      (s) =>
        projectIdentityKeyForSession(s) === currentProjectKey &&
        s.status === 'active' &&
        !isOrcaWorkerSession(s),
    );
    return list.slice().sort((a, b) => {
      const aPinned = a.pinnedAt != null;
      const bPinned = b.pinnedAt != null;
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      return aPinned
        ? comparePinnedByStatusThenPinnedDesc(a, b)
        : compareSessionsByStatusThenSortTimeDesc(a, b);
    });
  }, [sessionsHook.sessions, browsableWorkdir, currentSession]);

  const selectedPath = searchParams.get('file');
  const { content, setLocal: setLocalContent } = useFileContent(browsableWorkdir, selectedPath, remoteHostId, deviceId);
  const rail = useChatRailResize();
  const railCollapse = useChatRailCollapsed();
  const activeSessionIsOrcaLead = Boolean(currentSession && isOrcaLeadSession(currentSession));
  const agentIslandVisibleSessionId = useMemo(
    () =>
      resolveAgentIslandVisibleSessionIdForWorkdirBrowseRail({
        sessionId,
        railCollapsed: railCollapse.collapsed,
        isOrcaLead: activeSessionIsOrcaLead,
      }),
    [activeSessionIsOrcaLead, railCollapse.collapsed, sessionId],
  );
  const syncAgentIslandVisibleSession = useCallback(() => {
    if (!isAgentIslandSupported()) return;
    if (!document.hasFocus()) return;
    void window.electronAPI.agentIsland?.setVisibleSession?.(agentIslandVisibleSessionId);
  }, [agentIslandVisibleSessionId]);

  useEffect(() => {
    if (activeSessionIsOrcaLead) return;
    syncAgentIslandVisibleSession();
    window.addEventListener('focus', syncAgentIslandVisibleSession);
    return () => {
      window.removeEventListener('focus', syncAgentIslandVisibleSession);
      if (!isAgentIslandSupported()) return;
      void window.electronAPI.agentIsland?.setVisibleSession?.(null);
    };
  }, [activeSessionIsOrcaLead, syncAgentIslandVisibleSession]);

  const confirmSwitchAway = useConfirmSwitchAwayIfDirty();

  // Tab 条点击/关闭后切换 active：写 URL ?file= + 同步 selectedFile / openTabs。
  // 与 Sidebar 的 handleSelectFile 逻辑保持等价，避免单击 tab 仅刷 URL 不写存储
  // 导致下次重启时 selectedFile 与 active tab 不一致。
  // 切走前同样过 confirmSwitchAway 拦截 —— 当前文件 dirty 时弹三选一,详见
  // useConfirmSwitchAwayIfDirty。
  const handleActivate = useCallback(
    async (relPath: string) => {
      if (!(await confirmSwitchAway(selectedPath, relPath))) return;
      setSearchParams(
        (prev) => buildNormalFileSelectionParams(prev, relPath),
        { replace: true },
      );
      saveSelectedFile(browsableWorkdir, relPath);
      storeAddTab(browsableWorkdir, relPath);
    },
    [setSearchParams, browsableWorkdir, confirmSwitchAway, selectedPath],
  );

  // 跳过 confirmSwitchAway 的 activate —— 仅供 FileTabsBar 在批量关闭(单 × /
  // 关闭其他 / 关闭右侧 / 关闭左侧 / 关闭所有)切 next active 时调用。
  // 用户在 handleBeforeCloseFile 已经选过"不保存",再问一遍是冗余;且若不跳过,
  // closeMany 不 await 这次 activate,二次 dialog cancel 会造成 tabs 已删 active
  // 但 URL 还指向它的错位状态(react-router setSearchParams 在 confirmSwitchAway
  // return false 时不会执行)。逻辑除去 confirmSwitchAway 外与 handleActivate 等价。
  const handleActivateAfterClose = useCallback(
    (relPath: string) => {
      setSearchParams(
        (prev) => buildNormalFileSelectionParams(prev, relPath),
        { replace: true },
      );
      saveSelectedFile(browsableWorkdir, relPath);
      storeAddTab(browsableWorkdir, relPath);
    },
    [setSearchParams, browsableWorkdir],
  );

  // 关 file tab 前的拦截:
  //   - 关的不是 active tab → 直接放行(非 active 的 FileBodyView 没挂载,
  //     不会有 dirty,无需弹窗)。
  //   - 关 active tab + 不脏 → 直接放行。
  //   - 关 active tab + 脏 → 三选一 dialog:
  //       保存(primary)  → save() 成功才放行,失败留在编辑态(saveError 已显示)。
  //       不保存(tertiary) → 放行,丢弃改动。
  //       取消(cancel/Esc) → 不关闭。
  const handleBeforeCloseFile = useCallback(
    async (relPath: string): Promise<boolean> => {
      if (relPath !== selectedPath) return true;
      const handle = fileBodyRef.current;
      if (!handle || !handle.isDirty()) return true;
      const choice = await confirmThree({
        title: t('ccAgent.workdirBrowse.confirmSwitchAway.title'),
        description: t('ccAgent.workdirBrowse.confirmSwitchAway.descriptionCloseTab', { path: relPath }),
        confirmText: t('ccAgent.workdirBrowse.confirmSwitchAway.save'),
        tertiaryText: t('ccAgent.workdirBrowse.confirmSwitchAway.tertiary'),
        cancelText: t('ccAgent.workdirBrowse.confirmSwitchAway.cancel'),
      });
      if (choice === 'cancel') return false;
      if (choice === 'tertiary') return true;
      // choice === 'confirm' → 触发保存。失败时 FileBodyView 自己显示 saveError,
      // 这里阻止关闭让用户看到错误并决定下一步。
      return await handle.save();
    },
    [selectedPath, confirmThree, t],
  );

  // 切 session tab → 把 URL :sessionId 段换掉，?file= 等 search 参数完整保留
  // (用户在同 workdir 里的不同 session 之间来回跳，文档侧不重新选)。
  const handleActivateSession = useCallback(
    (nextId: string) => {
      if (nextId === sessionId) return;
      const search = searchParams.toString();
      navigate(`/cc-agent/files/${nextId}${search ? `?${search}` : ''}`, { replace: true });
    },
    [navigate, searchParams, sessionId],
  );

  // + 新建 session:用户从 SessionTabsBar 的下拉里挑了一种 agent
  // (Claude / Codex)。model / effort / permissionMode / fastMode 全部走
  // newMakerDraft 的 lastByVendor[agentKind] —— 与 NewMakerDraftRoute 草稿
  // 完全同源,行为对齐用户在 /cc-agent/new 页面的最近一次配置。workingDir
  // 用 doc 模式当前打开的目录(忽略 draft.workingDir)。新 session 创建后
  // workingDir 命中,会通过 sortedWorkdirSessions memo 自然出现在 tab 列表里。
  const handleCreateNewSession = useCallback(async (agentKind: AgentKind) => {
    if (!browsableWorkdir) return;
    // device-link 远程视图:控制端无法替被控端创建会话,本地新建只会得到一个
    // 指向远端路径的坏会话(+ 按钮已隐藏,这里是防御性短路)。
    if (deviceId) return;
    try {
      const prefs = getDraft().lastByVendor[agentKind];
      const newSession = await sessionsHook.createSession({
        agentKind,
        model: prefs.model,
        effort: prefs.effort,
        permissionMode: prefs.permissionMode,
        fastMode: getFastModeForModel(prefs.model),
        workingDir: browsableWorkdir,
        // SSH remote 视图:新会话必须落在同一远端 host,否则会变成"本地会话 +
        // 远端绝对路径"的坏组合(agent 在本地对不存在的路径开跑)。
        remoteHostId: remoteHostId ?? undefined,
      });
      if (!newSession) {
        log.warn('createSession returned null in doc mode');
        return;
      }
      const search = searchParams.toString();
      navigate(`/cc-agent/files/${newSession.id}${search ? `?${search}` : ''}`, { replace: true });
    } catch (err) {
      log.error('failed to create session in doc mode', err);
    }
  }, [navigate, searchParams, sessionsHook, browsableWorkdir, remoteHostId, deviceId]);

  // 关 session tab → 默认语义 = archive。流程:
  //   1. running / 远程接管中 → toast 阻断(同 sidebar 单条 archive 行为)。
  //   2. confirmDialog 二次确认。
  //   3. closeSessionQuery + sessionService.update(status:'archived', pinnedAt:null)
  //      + purgeSession + clearComposerDraft + refreshSessions —— 与 sidebar
  //      的归档副作用对齐,保证 doc 模式关 tab = sidebar 单条归档。
  //   4. session 状态 → archived 后,sortedWorkdirSessions memo 重算自然剔除该 tab。
  //   5. 若关的是 active,navigate 到 neighbor;neighbor 也没有时回 /cc-agent。
  //      (上一轮约定「禁用关闭最后一个」由 bar 自身在 sessions.length<=1 时隐藏 ×
  //       兜底,这里逻辑里再容错一次,避免兜底失效跳到空白页。)
  const handleCloseSession = useCallback(
    async (closingId: string, neighborId: string | null) => {
      const closing = sessionsHook.sessions.find((s) => s.id === closingId);
      const closingTitle = closing?.title?.trim() || t('ccAgent.common.unnamedSession');
      const runningSnapshot = makerChatStore.getRunningSnapshot();
      if (runningSnapshot.has(closingId)) {
        toast.warning(t('ccAgent.workdirBrowse.archiveSession.runningBlocked'));
        return;
      }
      try {
        const binding = await window.electronAPI.binding.resolveSession(closingId);
        if (binding.attached) {
          toast.warning(t('ccAgent.workdirBrowse.archiveSession.attachedBlocked'));
          return;
        }
      } catch {
        // resolveSession 失败不阻断后续 confirm —— 与 sidebar 单条 archive 行为一致。
      }

      const dirtyWorktree = await fetchDirtyWorktreeForRemoval(
        closingId,
        closing?.deviceLinkDeviceId,
      );
      const ok = await confirmDialog({
        title: t('ccAgent.workdirBrowse.archiveSession.title'),
        description:
          t('ccAgent.workdirBrowse.archiveSession.description', { title: closingTitle }) +
          (dirtyWorktree
            ? ' ' + t('ccAgent.sidebar.confirmArchive.dirtyWorktreeWarning')
            : ''),
        confirmText: t('ccAgent.workdirBrowse.archiveSession.confirm'),
        cancelText: t('ccAgent.workdirBrowse.archiveSession.cancel'),
      });
      if (!ok) return;

      makerChatStore.closeSessionQuery(closingId);

      try {
        await sessionService.setStatus(closingId, 'archived');
      } catch (err) {
        log.error('archive session in doc mode failed', err);
        toast.error(t('ccAgent.workdirBrowse.archiveSession.failed'));
        return;
      }

      makerChatStore.purgeSession(closingId);
      discardComposerDraft(closingId);
      // 跨 bucket 同步:refreshSessions 只刷自己当前 filter 桶 ('all'),sidebar 的
      // 'active' 桶不会被刷,导致 sidebar 仍把已归档 session 当 active 渲染。
      // patchLocal 遍历所有桶就地合并字段,弥补单桶 refresh 的覆盖盲区。
      sessionsHook.patchLocal(closingId, { status: 'archived', pinnedAt: null });
      void sessionsHook.refreshSessions();

      if (closingId === sessionId) {
        const search = searchParams.toString();
        if (neighborId) {
          navigate(`/cc-agent/files/${neighborId}${search ? `?${search}` : ''}`, { replace: true });
        } else {
          navigate('/cc-agent', { replace: true });
        }
      }
    },
    [confirmDialog, navigate, searchParams, sessionId, sessionsHook, workdir, t],
  );

  // 双击 SessionTabsBar 上的 tab 改 title。乐观先 patchLocal(列表顺序不变),
  // 失败回滚旧值 + toast。与 sidebar CCAgentSidebarUpper.handleRename 同款逻辑,
  // 保证 doc 模式重命名 = sidebar 单条重命名。
  const handleRenameSession = useCallback(
    async (id: string, newTitle: string) => {
      const oldTitle = sessionsHook.sessions.find((s) => s.id === id)?.title;
      sessionsHook.patchLocal(id, { title: newTitle });
      try {
        // patchMeta 按来源路由(远程走窄口径隧道);本机行为不变。
        await sessionService.patchMeta(id, { title: newTitle });
      } catch (err) {
        log.error('[session rename] doc mode', err);
        toast.error(t('ccAgent.sidebar.renameFailed'));
        if (oldTitle !== undefined) sessionsHook.patchLocal(id, { title: oldTitle });
      }
    },
    [sessionsHook, t],
  );

  // 关闭最后一个 tab / 关闭无邻居的 active tab → 清空 ?file= + 清空 selectedFile，
  // 让中间区回到 empty 提示态。
  const handleClear = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('file');
        return next;
      },
      { replace: true },
    );
    saveSelectedFile(browsableWorkdir, null);
  }, [setSearchParams, browsableWorkdir]);

  const handleSearchJumpConsumed = useCallback(() => {
    setSearchParams(
      (prev) => clearConsumedSearchJumpParams(prev),
      { replace: true },
    );
  }, [setSearchParams]);

  // 进 doc 模式后,主动把 keyboard focus 锚到本路由的根容器上 ——
  // 配合右下方 <CCAgentSessionView disableAutofocus />,焦点不会被 chat
  // 输入框 (TipTap contenteditable) 抢走。这件事很重要:
  //   Windows 中文 IME 在 contenteditable 获得焦点时进入 active 状态,会在
  //   OS 层吞掉 Ctrl+Shift+F 这类组合键 (实测连 keydown 都不会派发到
  //   Chromium),用户必须先点击非 contenteditable 区域让 IME 退出 active
  //   才能用快捷键。
  //   把焦点固定在一个 tabIndex={-1} 的普通 div 上,IME 不 active,所有
  //   window 级快捷键 (Ctrl+Shift+F / Ctrl+F / Ctrl+S) 立刻可用。
  // 只在 activeElement 是 body / null / html 时介入 (避免抢走用户已经聚焦的
  // input、tab 项等)。
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // workdir 也进 deps —— mount 那一帧若 session 还没加载,早 return 渲染的
    // 是不带 ref 的占位 div,rootRef.current=null,focus() no-op。workdir 一
    // 解析出来,真实 div 才挂上 ref,这时再跑一次 effect 把焦点锚住。
    if (!browsableWorkdir) return;
    const ae = document.activeElement;
    if (ae && ae !== document.body && ae !== document.documentElement) return;
    rootRef.current?.focus({ preventScroll: true });
  }, [sessionId, browsableWorkdir]);

  if (!browsableWorkdir) {
    // Session not found / not loaded yet. Render empty middle so the layout
    // doesn't shift when sessions arrive.
    return <div className="h-full w-full" />;
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className={cn(
        'flex h-full w-full min-h-0 outline-none',
        // 拖拽中给整层 select-none + col-resize cursor,跟项目内 MainLayout 同款
        rail.isDragging && 'select-none cursor-col-resize',
      )}
    >
      {/* Middle: file body viewer.
          关键:border-r + 内嵌 absolute handle 都挂在这个元素上,handle 的高亮
          线和 border-r 在 同一像素 重叠 —— 这才是 Sidebar.tsx 的精确做法。
          (之前把 handle 放 rail 上,导致 border-r 和高亮线是相邻 2 像素,
           hover/drag 时视觉变成 2px 粗) */}
      {/* 中栏 (tab bar + body) 用 bg-background 与左 sidebar / 右 rail (--sidebar)
          区分,模仿 Obsidian 主区域的层次感 ——
          light: 白 vs Surface #f8f8f6;dark: #252523 vs #1f1f1e。 */}
      {/* contain:layout paint style —— 把 doc 子树的 layout / paint / style
          副作用圈在自己边界内, 浏览器收到 chat rail 的 mutation 时不会再
          invalidate 整个 viewport 的 layout/paint。streaming 期间 doc 的滚动
          / Find 高亮 / 选区帧时间下来一截。size 不能加, 否则 flex-1 拿不到
          父容器宽高。 */}
      <div className="relative flex-1 min-w-0 h-full overflow-hidden border-r border-[var(--cmd-palette-border)] bg-background [contain:layout_paint_style]">
        <div className="flex h-full w-full flex-col">
          <FileTabsBar
            workdir={browsableWorkdir}
            activePath={selectedPath}
            onActivate={handleActivate}
            onActivateAfterClose={handleActivateAfterClose}
            onClear={handleClear}
            onBeforeClose={handleBeforeCloseFile}
            isChatRailCollapsed={railCollapse.collapsed}
            onToggleChatRail={railCollapse.toggle}
          />
          <div className="min-h-0 flex-1">
            <FileBodyView
              ref={fileBodyRef}
              workdir={browsableWorkdir}
              remoteHostId={remoteHostId}
              deviceId={deviceId}
              sessionId={sessionId}
              relPath={selectedPath}
              content={content}
              onSaved={setLocalContent}
              jumpQuery={searchParams.get('search') || null}
              jumpLine={(() => {
                const v = searchParams.get('line');
                if (!v) return null;
                const n = Number.parseInt(v, 10);
                return Number.isFinite(n) && n > 0 ? n : null;
              })()}
              onSearchJumpConsumed={handleSearchJumpConsumed}
            />
          </div>
          {/* Interaction prompt slot — permission/askUser/plan 卡片在这一栏挂出来,
              rail 里只显占位。empty:hidden 让无 pending 时整栏从布局中消失。
              不画 border-t — 卡片自带 border + cornerRadius,视觉边界够清晰,
              再加分隔线会像两层框堆叠。 */}
          <InteractionPromptSlot className="empty:hidden py-3" />
        </div>
        {/* 折叠态下不渲染拖拽 handle —— rail 宽度被钉死在 0, 拖也没意义;
            额外好处:折叠期间用户的 hover/拖拽不会误触, 跟 sidebar 折叠时
            同样隐藏 resize handle 的设计一致。 */}
        {!railCollapse.collapsed && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t('ccAgent.workdirBrowse.chatRail.resizeAria')}
            onPointerDown={rail.handleDragStart}
            onDoubleClick={rail.resetWidth}
            className="absolute right-0 top-0 z-10 h-full w-[4px] cursor-col-resize group/handle"
          >
            {/* 1px 视觉条 —— right-0 与 middle 的 border-r 同位,所以 hover 时
                单纯把那 1px 由 border-r 灰色换成 sidebar-action-icon,不会增厚。 */}
            <div
              className={cn(
                'absolute right-0 top-0 h-full w-px transition-colors',
                rail.isDragging
                  ? 'bg-sidebar-action-icon'
                  : 'bg-transparent group-hover/handle:bg-sidebar-action-icon',
              )}
            />
          </div>
        )}
      </div>

      {/* Right rail: SessionTabsBar (doc-mode 专用差分) + full chat session.
          overflow-x-auto rescues the 914-wide hardcoded card components
          (Permission / AskUser / Plan) — they become horizontally scrollable
          rather than blow up the layout.
          外层多套一层 vertical flex,把 tab 条贴在 rail 顶部、chat view 占余下
          空间。CCAgentSessionView 自身负责内部滚动,不会受 tab 条影响。 */}
      {/* contain:layout paint style —— 同 doc 侧理由, 把 chat rail 的高频
          mutation (token streaming → DOM grow → layout/paint) 圈在 rail 子树
          里, 不让它触发 doc 列重新 layout。size 不能加, rail 宽度由
          rail.width style 接管, 高度需要继承父 flex 的 100%。 */}
      {/* 折叠 / 展开 width 过渡:对标 MainLayout / Sidebar 的折叠动画 ——
          transition-[width] 250ms cubic-bezier(0.4, 0, 0.2, 1)。motion-reduce
          兜住"系统级减少动效"用户。
          width 来源:展开 → useChatRailResize 持久化的宽度;折叠 → 0。
          aria-hidden 在折叠态打开, 让 SR 跳过被裁掉的子树。
          注意 [contain:layout_paint_style] 已经隐式 clip overflow, 不需要再加
          overflow-hidden。 */}
      <div
        style={{ width: railCollapse.collapsed ? 0 : rail.width }}
        aria-hidden={railCollapse.collapsed || undefined}
        className={cn(
          'h-full shrink-0 flex flex-col min-h-0 [contain:layout_paint_style]',
          'transition-[width] duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:duration-0',
          // 拖宽度时禁用 transition, 否则拖动有延迟跟手感受会很糟。useChatRailResize
          // 的 isDragging 已经覆盖这一帧, 加上 !transition 让宽度 1:1 跟随鼠标。
          rail.isDragging && '!transition-none',
        )}
      >
        <SessionTabsBar
          activeSessionId={sessionId ?? null}
          sessions={sortedWorkdirSessions}
          onActivate={handleActivateSession}
          onCreateNew={handleCreateNewSession}
          canCreateNew={!deviceId}
          onClose={handleCloseSession}
          onRename={handleRenameSession}
        />
        <div className="min-h-0 flex-1 overflow-x-auto chat-rail-compact">
          {/* 当 active session 是 Orca Lead 时, 用 doc 专用 OrcaSplitView toggle 展示
              Lead/Worker。用户从 × 关协同后,disableOrca 会把 lead.orcaRole 清掉,
              activeSession 自然 fallback 到下面的单 CCAgentSessionView,不需要跳路由。 */}
          {(() => {
            // 用未过滤的 sessionsHook.sessions 查 active —— sortedWorkdirSessions
            // 已剔除 Worker / 非 active, 但 active session 自身可能是 archived
            // (用户直接通过 URL 进来),Lead 判断不该依赖那层过滤。
            const activeSession = sessionId
              ? sessionsHook.sessions.find((s) => s.id === sessionId) ?? null
              : null;
            if (activeSession && isOrcaLeadSession(activeSession)) {
              return (
                <OrcaSplitView
                  leadSessionId={activeSession.id}
                  reportAgentIslandVisibility={!railCollapse.collapsed}
                />
              );
            }
            return <CCAgentSessionView viewVisible={!railCollapse.collapsed} />;
          })()}
        </div>
      </div>
    </div>
  );
}
