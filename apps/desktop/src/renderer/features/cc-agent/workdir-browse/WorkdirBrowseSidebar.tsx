/**
 * WorkdirBrowseSidebar — sidebar content shown while on
 * `/cc-agent/files/:sessionId`.
 *
 * Layout matches the design稿 (skillhub Market sidebar pattern):
 *
 *   ┌──────────────────────────────────┐
 *   │ ← Back to Projects               │  ← h-9 rounded-full (slot of New Chat)
 *   ├──────────────────────────────────┤
 *   │ <workdir name>           [⇡⇣] [↻]│  ← collapse all / refresh
 *   ├──────────────────────────────────┤
 *   │ ▼ Assets                         │  ← lazy file tree
 *   │   ▶ Editor                       │
 *   │   ...                            │
 *   │ CLAUDE.md          (selected)    │
 *   │ ...                              │
 *   └──────────────────────────────────┘
 *
 * The watcher (chokidar) lifecycle is tied to this component's mount/unmount
 * via useFileTree → on route change away from /files, sidebar swaps back to
 * the Projects view, this component unmounts, watcher closes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Check, ChevronDown, ChevronsDownUp, RefreshCw, Search, X as XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';

import { useFileTree, type DirEntry } from './hooks/useFileTree';
import { fileBrowserApiFor } from '@/lib/fileBrowserTransport';
import { useConfirmSwitchAwayIfDirty } from './hooks/useConfirmSwitchAwayIfDirty';
import { useProjectFileList } from './hooks/useProjectFileList';
import { FileTreeView, type FileTreeViewHandle, type PendingCreate } from './FileTreeView';
import { useRevealFileInTree } from './hooks/useRevealFileInTree';
import { FileFilterInput } from './FileFilterInput';
import { FilterResultList } from './FilterResultList';
import { FILTER_RESULT_LIMIT, filterFiles } from './lib/filterFiles';
import { loadSelectedFile, saveSelectedFile } from './lib/selectedFileStore';
import { loadExpandedSet, saveExpandedSet } from './lib/expandedStore';
import { clearFileScroll } from './lib/fileScrollStore';
import {
  openUrlInSidebarBrowser,
  pathToFileUrl,
} from '@/features/right-sidebar/lib/openInSidebarBrowser';
import {
  addTab as storeAddTab,
  removeTab as storeRemoveTab,
  renameTabPrefix as storeRenameTabPrefix,
} from './lib/openTabsStore';
import {
  hasSwitchableDocModeProject,
  shouldIgnoreDocModeProjectSwitch,
  type DocModeSwitchProject,
} from './lib/docModeSwitchProjects';
import { buildNormalFileSelectionParams } from './lib/fileSelectionParams';
import { toOsAbsolutePath } from './lib/fileMeta';
import { SearchPanel } from './search/SearchPanel';
import { useProjectSearch } from './search/hooks/useProjectSearch';

const log = createLogger('cc-agent.workdir-browse.sidebar');

/** Project search hard cap — 命中达到这个数后 main 会 kill rg 并返回 truncated。 */
const SEARCH_MAX_MATCHES = 1000;

type SidebarMode = 'tree' | 'search';

/**
 * Join workdir + POSIX relPath into an OS-native absolute path. POSIX-only on
 * mac/linux; on Windows we swap "/" → "\\" so users get the native form they
 * can paste into Explorer / cmd.
 */
/**
 * 在已加载的 entries Map 里按 relPath 找 DirEntry。重命名只对已可见的行可触发,
 * 所以一定在某个父目录的 listing 里。线性扫描成本可忽略(单 listing 几百条,
 * 单次操作)。找不到 → null,调用方走 cancel。
 */
function findEntryByRelPath(
  entries: ReadonlyMap<string, readonly DirEntry[]>,
  relPath: string,
): DirEntry | null {
  const slashIdx = relPath.lastIndexOf('/');
  const parent = slashIdx < 0 ? '' : relPath.slice(0, slashIdx);
  const list = entries.get(parent);
  if (!list) return null;
  return list.find((e) => e.relPath === relPath) ?? null;
}

export interface WorkdirBrowseSidebarProps {
  /** Session id whose workdir we're browsing. */
  sessionId: string;
  /** Resolved absolute workdir path (caller derives from sessionId). */
  workdir: string;
  /**
   * 非空 = SSH remote 会话:workdir 是远端路径,文件操作经 main 路由到远端
   * file-service;"显示所在文件夹"等本机-only 菜单项隐藏。
   */
  remoteHostId?: string | null;
  /** 非空 = device-link 远程会话(被控设备);优先于 remoteHostId(嵌套时二跳在被控端)。 */
  deviceId?: string | null;
  /** Display name for the section title (typically project basename). */
  displayName: string;
  /** Current project identity key, used to mark the active project in switcher. */
  projectKey: string | null;
  /** Local projects that have at least one active session and can be opened in doc mode. */
  switchProjects: readonly DocModeSwitchProject[];
}

export function WorkdirBrowseSidebar({
  sessionId,
  workdir,
  remoteHostId = null,
  deviceId = null,
  displayName,
  projectKey,
  switchProjects,
}: WorkdirBrowseSidebarProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { confirm: confirmDialog } = useConfirmDialog();
  // VSCode 风格内联输入态。null = 当前没有占位行;非 null 时 FileTreeView
  // 会在对应 parentRel 下方插一行带 input 的 PendingInputRow。
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  // 重命名编辑态:命中的 entry.relPath。null = 没有正在重命名的行。
  // 一个时刻只能有一个 row 处于编辑态(右键菜单也是单实例),所以单 string 够用。
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  // 侧边栏模式 — tree(默认文件树) | search(项目级文本搜索)。
  // 状态升到这里(而不是 SearchPanel 内部)是为了切回 tree 再切回 search 时,
  // 之前的输入和结果还在(用户答复"切回文件树时保留")。
  const [mode, setMode] = useState<SidebarMode>('tree');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const lastResetWorkdirRef = useRef<string | null>(null);
  const lastRestoredWorkdirRef = useRef<string | null>(null);
  const search = useProjectSearch({
    workdir,
    remoteHostId,
    deviceId,
    query: searchQuery,
    caseSensitive: searchCaseSensitive,
    maxMatches: SEARCH_MAX_MATCHES,
  });

  // workdir 切换 → 同时把 mode 拉回 tree, 输入/选项也清掉(useProjectSearch
  // 内部自己清累积态 + cancel 在跑的 search)。
  useEffect(() => {
    if (lastResetWorkdirRef.current === workdir) return;
    lastResetWorkdirRef.current = workdir;
    setMode('tree');
    setSearchQuery('');
    setSearchCaseSensitive(false);
    setFilterQuery('');
  }, [workdir]);

  // Doc 模式 Ctrl/Cmd+Shift+F → 转过来的 CustomEvent。FileBodyView 在自己的
  // keydown handler 里 dispatch,我们这里只负责切到 search 模式 + 把焦点送到
  // 搜索输入框。focus 走 querySelector(SearchInput 上挂了 data-attr),省得
  // 在 SearchPanel→SearchInput 链路里穿 ref。
  //
  // ⚠ 不能用 queueMicrotask:SearchPanel 的容器 div 是 `display: none` ↔ `block`
  // 切换,React commit 之前 input 还在 display:none 子树里,`focus()` 静默
  // no-op。queueMicrotask 排在 React 的 flush microtask 之前还是之后取决于注册
  // 顺序,实测会先跑 → 焦点拿不到 → 用户首次按 Ctrl+Shift+F 看不到光标,以为
  // 快捷键失效。setTimeout(0) 是 macrotask,必然排在当前任务的所有 microtask
  // (含 React commit) 之后,DOM 已经 visible 才 focus,稳定。
  useEffect(() => {
    const onOpen = () => {
      setMode('search');
      setTimeout(() => {
        const input = document.querySelector<HTMLInputElement>(
          'input[data-workdir-search-input]',
        );
        input?.focus();
        input?.select();
      }, 0);
    };
    window.addEventListener('workdir-open-project-search', onOpen);
    return () => window.removeEventListener('workdir-open-project-search', onOpen);
  }, []);

  // Esc → 退出 sidebar 的 search 模式 (切回 tree)。
  // 优先级:DocSearchBar (doc 内 Ctrl+F 浮条) 是更高优先级 —— 它如果可见,
  //   Esc 应该先关它,我们这条让位。判据走 DOM (data-doc-search-bar) 而不是
  //   注册 ownership ref,跨组件不需要再加协议层,鲁棒性也够 (只有 doc-mode
  //   渲染 DocSearchBar 这一个生产者)。
  // 只在 mode === 'search' 时挂 listener,避免 tree 模式下白白吃 Esc 影响
  //   其它弹层 (ImageLightbox / DiffPanel 等) 的 Esc 关闭。
  useEffect(() => {
    if (mode !== 'search') return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 让位:DocSearchBar 在,先让它的 Esc handler 处理,自己跳过。
      if (document.querySelector('[data-doc-search-bar]')) return;
      e.preventDefault();
      e.stopPropagation();
      setMode('tree');
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [mode]);

  // Doc 模式: 暂时关闭。开启后切到 doc 视图首屏会卡 —— 根目录每个子目录都
  // 要递归扫一遍判断 "有没有 doc 文件"(即使 sibling 已经并行,顶层走完一轮
  // 仍然有感知)。先放开让用户看全部文件,等 hasDocDescendant 加缓存或换成
  // 流式增量返回再启用。scanner.ts 的过滤逻辑保留,改回 true 即可恢复。
  const tree = useFileTree({ workdir, remoteHostId, deviceId, hideMetaFiles: true, docMode: false });

  // 文件名筛选 query —— tree 模式下用,独立于内容搜索。空 query 显示文件树,有
  // 内容显示筛选结果列表。workdir 切换时自动清空(下方 useEffect)。
  const [filterQuery, setFilterQuery] = useState('');
  // 项目级文件名扁平列表(走 ripgrep --files honor .gitignore),给"筛选文件"用。
  // 模块级 cache 跨 doc 模式 / RSB plugin 共享同一份索引;tree refresh 时同步 invalidate。
  // enabled 惰性拉取:query 为空(FilterResultList 不显示)时不扫描 —— 切会话
  // 不再为用不上的索引付 rg + IPC + 建索引的主线程成本。trim 与 filterFiles
  // 的匹配语义对齐:纯空格 query 结果必为空,不值得为它扫描。
  const projectFiles = useProjectFileList(workdir, remoteHostId, deviceId, {
    enabled: filterQuery.trim() !== '',
  });
  const filteredFiles = useMemo(
    () => filterFiles(filterQuery, projectFiles.files),
    [filterQuery, projectFiles.files],
  );

  const selectedPath = searchParams.get('file');

  // 持久化恢复:URL 没带 ?file= 时,从 localStorage 取上次该 workdir 打开的文件,
  // 写回 URL —— 这样切回 workdir-browse 模式 自动回到上次看的文件,而不是
  // 空预览态。只在 workdir 变化时生效,避免覆盖用户在 url 里的当前选择。
  useEffect(() => {
    if (lastRestoredWorkdirRef.current === workdir) return;
    lastRestoredWorkdirRef.current = workdir;
    if (selectedPath) return;
    const remembered = loadSelectedFile(workdir);
    if (!remembered) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('file', remembered);
        return next;
      },
      { replace: true },
    );
    // 恢复出来的 active 文件也要确保有对应 tab（首次启动 / openTabs 还没有它的情况）。
    storeAddTab(workdir, remembered);
  }, [selectedPath, setSearchParams, workdir]);

  const confirmSwitchAway = useConfirmSwitchAwayIfDirty();
  const currentSelectedFile = searchParams.get('file');
  const canSwitchProject = hasSwitchableDocModeProject(
    switchProjects,
    projectKey,
    sessionId,
  );

  const handleBack = useCallback(async () => {
    // 离开整个 doc 模式回到 chat 视图。如果当前文件处于 dirty 编辑状态,
    // 同样要弹三选一(否则用户的改动会随着 navigate 被默默丢弃)。
    // null 表示离开当前文件上下文,不是切到某个相对路径;dirty 时必须弹确认。
    if (!(await confirmSwitchAway(currentSelectedFile, null))) return;
    // 不直接跳到 doc 当前的 sessionId —— 那个 session 属于 doc 选中的 workdir,
    // 不一定是用户切过去之前在 chat 里选中的那条(常常是别的 workdir)。
    // 走 /cc-agent 让 CCAgentIndexRedirect 读 lastChatView,把用户带回切过去
    // 之前 project 里选中的 session(失效时再走 fallback)。
    navigate('/cc-agent');
  }, [navigate, confirmSwitchAway, currentSelectedFile]);

  const handleSwitchProject = useCallback(
    async (project: DocModeSwitchProject) => {
      if (shouldIgnoreDocModeProjectSwitch(project, projectKey, sessionId)) return;
      if (!(await confirmSwitchAway(currentSelectedFile, null))) return;
      // 清掉当前文件 / 搜索 URL 参数。目标项目会按自己的 selectedFileStore 恢复
      // 最近打开文件；没有记录时保持空预览态，避免拿当前项目的 relPath 去读新项目。
      navigate(`/cc-agent/files/${project.sessionId}`, { replace: true });
    },
    [confirmSwitchAway, currentSelectedFile, navigate, projectKey, sessionId],
  );

  const handleSelectFile = useCallback(
    async (relPath: string) => {
      // 切走前先 dirty 拦截:当前文件处于编辑+脏状态时弹三选一,用户选取消
      // 就直接 return 不切换。详见 useConfirmSwitchAwayIfDirty。
      if (!(await confirmSwitchAway(currentSelectedFile, relPath))) return;
      // setSearchParams(updater) form keeps unrelated params if any exist;
      // 但 search/line 是 search panel 跳转专用,从文件树切文件时要清掉,否则
      // 上次跳转过的 highlight 会黏在新文件上。
      setSearchParams(
        (prev) => buildNormalFileSelectionParams(prev, relPath),
        { replace: true },
      );
      // 同步落地到 localStorage,下次切回该 workdir 时自动恢复。
      saveSelectedFile(workdir, relPath);
      // 同步加到 tab 列表。已存在 = 切换已打开文档,保留阅读位置;
      // 新增 = 新打开文档,清掉可能残留的内存 scroll anchor,从头开始读。
      const openedNow = storeAddTab(workdir, relPath);
      if (openedNow) clearFileScroll(workdir, relPath);
    },
    [setSearchParams, workdir, confirmSwitchAway, currentSelectedFile],
  );

  // 搜索面板里点命中行 → 打开文件 + 把当前 query/lineNumber 写入 URL,
  // FileBodyView 会读这两个参数走 PlaintextEditor.search.findAll/setActive,
  // 自动滚到对应行 + 高亮命中(复用 in-file search 已有能力)。
  const handleOpenMatch = useCallback(
    async (relPath: string, lineNumber: number) => {
      if (!(await confirmSwitchAway(currentSelectedFile, relPath))) return;
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('file', relPath);
          next.set('search', searchQuery);
          next.set('line', String(lineNumber));
          return next;
        },
        { replace: true },
      );
      saveSelectedFile(workdir, relPath);
      storeAddTab(workdir, relPath);
    },
    [setSearchParams, workdir, searchQuery, confirmSwitchAway, currentSelectedFile],
  );

  const handleToggleSearchMode = useCallback(() => {
    setMode((m) => (m === 'search' ? 'tree' : 'search'));
  }, []);

  const handleCollapseAll = useCallback(() => {
    tree.collapseAll();
  }, [tree]);

  const handleRefresh = useCallback(() => {
    void tree.refresh();
    // 文件树刷新时同步 invalidate 项目级文件索引,新增 / 重命名 / 删除的文件下次
    // 筛选才能看到。
    projectFiles.refresh();
  }, [tree, projectFiles]);

  // FileTreeView 的 imperative ref —— useRevealFileInTree 通过它调 scrollToPath。
  const fileTreeRef = useRef<FileTreeViewHandle>(null);
  const revealFileInTree = useRevealFileInTree(tree, fileTreeRef);

  // 筛选结果点击 → 走跟 handleSelectFile 同样的 URL + storeAddTab 流程,然后清掉
  // filter query(用户找到目标文件 = 想看它,而不是接着筛选)。
  // 选完再调 revealFileInTree:展开父目录链 + 滚动到该行,跟 RSB 版同一份逻辑。
  const handleSelectFromFilter = useCallback(
    async (relPath: string) => {
      const ok = await confirmSwitchAway(currentSelectedFile, relPath);
      if (!ok) return;
      setSearchParams(
        (prev) => buildNormalFileSelectionParams(prev, relPath),
        { replace: true },
      );
      saveSelectedFile(workdir, relPath);
      const openedNow = storeAddTab(workdir, relPath);
      if (openedNow) clearFileScroll(workdir, relPath);
      setFilterQuery('');
      void revealFileInTree(relPath);
    },
    [confirmSwitchAway, currentSelectedFile, revealFileInTree, setSearchParams, workdir],
  );

  // 右键 文件夹 → New File / New Folder:开 VSCode 风格内联输入行。
  //   1. 父目录折叠时先展开(toggleFolder 是 toggle 语义,先判 expanded)
  //      —— 否则 PendingInputRow 视觉上会"挂"在折叠的父下方,反直觉。
  //   2. setPendingCreate 触发 FileTreeView 插入临时 input 行。
  //   3. 真正的创建在 handlePendingSubmit 里跑(用户回车或失焦后)。
  const startInlineCreate = useCallback(
    (kind: 'file' | 'folder', parentRel: string) => {
      if (parentRel !== '' && !tree.expanded.has(parentRel)) {
        tree.toggleFolder(parentRel);
      }
      setPendingCreate({ kind, parentRel });
    },
    [tree],
  );
  const handleNewFile = useCallback(
    (parentRel: string) => startInlineCreate('file', parentRel),
    [startInlineCreate],
  );
  const handleNewFolder = useCallback(
    (parentRel: string) => startInlineCreate('folder', parentRel),
    [startInlineCreate],
  );

  // PendingInputRow 提交回调:校验文件名 → 调 IPC → watcher 推送会刷父目录
  // listing,这里不动 tree state,只负责 select(file 模式)+ 清 pending。
  // 校验失败 / IPC 失败:toast.error,但仍清掉 pending 让用户重新右键开新行
  // (保留并重 focus 输入框成本太高,跟 VSCode 在 IPC 失败时也是 toast 的策略一致)。
  const handlePendingSubmit = useCallback(
    async (name: string) => {
      if (!pendingCreate) return;
      const { kind, parentRel } = pendingCreate;
      // 客户端硬校验:路径分隔符 + . / .. —— assertInsideWorkdir 在 main 侧也会
      // 拦,但提前在 renderer 拦能给更精准的中文 toast,不用暴露 main-side error 文案。
      if (name === '.' || name === '..' || /[\\/]/.test(name)) {
        toast.warning(t('ccAgent.workdirBrowse.invalidName'));
        setPendingCreate(null);
        return;
      }
      const newRel = parentRel === '' ? name : `${parentRel}/${name}`;
      setPendingCreate(null);
      const api = fileBrowserApiFor(deviceId);
      const res = kind === 'file'
        ? await api.createFile({ workdir, remoteHostId, relPath: newRel })
        : await api.createFolder({ workdir, remoteHostId, relPath: newRel });
      if (!res.ok) {
        log.warn(`create ${kind} failed`, { newRel, message: res.message });
        toast.error(t('ccAgent.workdirBrowse.createFailed', { message: res.message }));
        return;
      }
      if (kind === 'file') {
        // 走完整 select 流程:URL ?file= + persisted selectedFile + tab。
        handleSelectFile(newRel);
      }
    },
    [pendingCreate, workdir, handleSelectFile, t],
  );

  const handlePendingCancel = useCallback(() => {
    setPendingCreate(null);
  }, []);

  // 右键 文件 → Delete File。confirm 二次确认 → 调 IPC → 副作用清理:
  // 关掉对应 tab、若是当前 active 文件清空 ?file= + persisted。watcher 自然
  // 刷掉条目,所以不动 tree state。
  const handleDeleteFile = useCallback(
    async (entry: DirEntry) => {
      const ok = await confirmDialog({
        title: t('ccAgent.workdirBrowse.deleteFile.title'),
        description: t('ccAgent.workdirBrowse.deleteFile.description', { name: entry.name }),
        confirmText: t('ccAgent.workdirBrowse.deleteFile.confirm'),
        cancelText: t('ccAgent.workdirBrowse.deleteFile.cancel'),
      });
      if (!ok) return;
      const res = await fileBrowserApiFor(deviceId).deleteEntry({
        workdir,
        remoteHostId,
        relPath: entry.relPath,
      });
      if (!res.ok) {
        log.warn('delete failed', { relPath: entry.relPath, message: res.message });
        toast.error(t('ccAgent.workdirBrowse.deleteFailed', { message: res.message }));
        return;
      }
      storeRemoveTab(workdir, entry.relPath);
      if (selectedPath === entry.relPath) {
        saveSelectedFile(workdir, null);
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            next.delete('file');
            return next;
          },
          { replace: true },
        );
      }
    },
    [confirmDialog, selectedPath, setSearchParams, workdir, t],
  );

  // 右键 文件/文件夹 → 在 OS 文件管理器中打开并选中该条目。
  // 直接复用已有的 shell:show-item-in-folder IPC(已做 path-traversal /
  // 系统目录黑名单校验)。文件夹也走 showItemInFolder —— Electron 在文件夹上
  // 的语义是"打开父目录并选中该文件夹",体感和文件一致。
  const handleRevealInFolder = useCallback(
    async (entry: DirEntry) => {
      const abs = toOsAbsolutePath(workdir, entry.relPath);
      const res = await window.electronAPI.showItemInFolder({ filePath: abs });
      if (!res.success) {
        log.warn('reveal in folder failed', { relPath: entry.relPath, error: res.error });
        toast.error(t('ccAgent.workdirBrowse.revealFailed', { error: res.error ?? t('ccAgent.common.unknownError') }));
      }
    },
    [workdir, t],
  );

  const handleOpenInSidebarBrowser = useCallback(
    async (entry: DirEntry) => {
      const abs = toOsAbsolutePath(workdir, entry.relPath);
      try {
        await openUrlInSidebarBrowser(sessionId, pathToFileUrl(abs));
      } catch (err) {
        log.warn('open in sidebar browser failed', { relPath: entry.relPath, error: String(err) });
        toast.error(t('chat.markdownRenderer.openInSidebarFailed'));
      }
    },
    [sessionId, workdir, t],
  );

  const handleOpenInBrowser = useCallback(
    async (entry: DirEntry) => {
      const abs = toOsAbsolutePath(workdir, entry.relPath);
      const res = await window.electronAPI.openFileInBrowser(abs);
      if (!res.success) {
        log.warn('open in browser failed', { relPath: entry.relPath, error: res.error });
        toast.error(res.error ?? t('chat.markdownRenderer.openInBrowserFailed'));
      }
    },
    [workdir, t],
  );

  // 右键 文件/文件夹 → 重命名。进入 inline 编辑态;真正的 IPC + 副作用清理
  // 在 handleRenameSubmit 里跑(回车 / 失焦后)。
  // 同时关掉 pendingCreate 防止两个编辑态同屏(用户先开新建再去 rename 别人的情况)。
  const handleRename = useCallback((entry: DirEntry) => {
    setPendingCreate(null);
    setRenamingPath(entry.relPath);
  }, []);

  const handleRenameCancel = useCallback(() => {
    setRenamingPath(null);
  }, []);

  // 重命名提交:newName 是新 basename(不含父路径)。
  // 流程:校验 → 调 IPC → 成功后副作用清理:
  //   - tab 列表里相关条目改前缀(见 storeRenameTabPrefix)
  //   - 当前 active 文件命中 → 同步 ?file= URL + persistedSelectedFile
  //   - 文件夹 rename:expanded localStorage 里所有以 oldRel/ 开头的子路径
  //     需要前缀替换,否则下次打开 workdir 时会去 fetch 已经不存在的旧路径。
  //     hook 内部 expanded state 不动 — 重命名后的新文件夹会显示成折叠态,
  //     v1 接受;chokidar add/unlink 会自然刷父目录 listing。
  const handleRenameSubmit = useCallback(
    async (newName: string) => {
      const entry = renamingPath
        ? findEntryByRelPath(tree.entries, renamingPath)
        : null;
      if (!renamingPath || !entry) {
        setRenamingPath(null);
        return;
      }
      // 客户端硬校验。同 handlePendingSubmit:中文 toast > main-side error 文案。
      if (newName === '.' || newName === '..' || /[\\/]/.test(newName)) {
        toast.warning(t('ccAgent.workdirBrowse.invalidName'));
        setRenamingPath(null);
        return;
      }
      const oldRel = entry.relPath;
      const slashIdx = oldRel.lastIndexOf('/');
      const parentRel = slashIdx < 0 ? '' : oldRel.slice(0, slashIdx);
      const newRel = parentRel === '' ? newName : `${parentRel}/${newName}`;
      if (newRel === oldRel) {
        setRenamingPath(null);
        return;
      }
      setRenamingPath(null);

      const res = await fileBrowserApiFor(deviceId).renameEntry({
        workdir,
        remoteHostId,
        fromRel: oldRel,
        toRel: newRel,
      });
      if (!res.ok) {
        log.warn('rename failed', { oldRel, newRel, message: res.message });
        toast.error(t('ccAgent.workdirBrowse.renameFailed', { message: res.message }));
        return;
      }

      // tab 列表前缀替换(同时覆盖 file=oldRel 和 folder/foo... 两种情况)。
      storeRenameTabPrefix(workdir, oldRel, newRel);

      // 当前 active 文件命中 → 重新指向新路径。
      const isActiveHit =
        selectedPath !== null &&
        (selectedPath === oldRel || selectedPath.startsWith(`${oldRel}/`));
      if (isActiveHit) {
        const newSelected =
          selectedPath === oldRel
            ? newRel
            : `${newRel}/${selectedPath.slice(oldRel.length + 1)}`;
        saveSelectedFile(workdir, newSelected);
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            next.set('file', newSelected);
            return next;
          },
          { replace: true },
        );
      }

      // 文件夹 rename:把 expanded 持久化里所有 oldRel / oldRel/* 的条目改前缀。
      // 实时 expanded 集合不改 — 反正打开重命名后的新文件夹时会重新 fetch。
      if (entry.type === 'directory') {
        const persisted = loadExpandedSet(workdir);
        let dirty = false;
        const next = new Set<string>();
        for (const p of persisted) {
          if (p === oldRel) {
            next.add(newRel);
            dirty = true;
          } else if (p.startsWith(`${oldRel}/`)) {
            next.add(`${newRel}/${p.slice(oldRel.length + 1)}`);
            dirty = true;
          } else {
            next.add(p);
          }
        }
        if (dirty) saveExpandedSet(workdir, next);
      }
    },
    [renamingPath, tree.entries, workdir, selectedPath, setSearchParams, t],
  );

  // 右键 文件 → Copy File Path。Electron renderer 启用了 clipboard write,
  // 直接走 navigator.clipboard。失败时 toast.warning(典型场景:权限被禁,
  // 但本应用是桌面端,几乎不会出现)。
  const handleCopyFilePath = useCallback(
    async (entry: DirEntry) => {
      const abs = toOsAbsolutePath(workdir, entry.relPath);
      try {
        await navigator.clipboard.writeText(abs);
        toast.success(t('ccAgent.workdirBrowse.pathCopied'));
      } catch (err) {
        log.warn('clipboard write failed', err);
        toast.warning(t('ccAgent.workdirBrowse.copyFailed'));
      }
    },
    [workdir, t],
  );

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      {/* Top slot — same geometry as the "New Chat" button (h-9 rounded-full,
          pt-4 pr-3 pb-3.5 pl-3 + gap-0.5). Matches skillhub MarketCell when
          on /skillhub/market. */}
      <div className="flex flex-col gap-0.5 pt-4 pr-3 pb-3.5 pl-3">
        <button
          type="button"
          onClick={handleBack}
          aria-label={t('ccAgent.workdirBrowse.backToProjects')}
          className={cn(
            'flex h-9 w-full items-center gap-2.5 rounded-full px-3',
            'text-foreground text-sm font-normal transition-colors',
            'hover:bg-sidebar-item-hover',
          )}
        >
          <ArrowLeft size={18} className="shrink-0" />
          <span className="leading-none mt-[2px]">{t('ccAgent.workdirBrowse.backToProjects')}</span>
        </button>
      </div>

      {/* Workdir title row — 在搜索态的 "Search Section Title" 与普通态的
          "Workdir Section Title" 之间切换:
          padding: [8, 12, 4, 24]
          tree 模式: <displayName> 14/600 #262626 + [search, collapse, refresh] 14×14 #737373 gap:6
          search 模式: "Search" 14/600 + <displayName> 11/normal #737373 gap:8
                      + [refresh, collapse, X] 14×14 #737373 gap:6
          (X 是退出搜索, 替代了原来的 search 按钮位置 — 用户反馈"搜索状态下应变 X")。 */}
      <div className="flex items-center justify-between pt-2 pb-1 pl-6 pr-3">
        {mode === 'search' ? (
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{t('ccAgent.workdirBrowse.searchPanel.headingSearch')}</span>
            <span className="min-w-0 truncate text-11 text-sidebar-muted">
              {displayName}
            </span>
          </div>
        ) : canSwitchProject ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Tip text={t('ccAgent.workdirBrowse.switchProject')}>
                <button
                  type="button"
                  aria-label={t('ccAgent.workdirBrowse.switchProject')}
                  className={cn(
                    'flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 -ml-1.5',
                    'text-sm font-semibold text-foreground transition-colors',
                    'hover:bg-sidebar-item-active hover:text-sidebar-item-active-foreground',
                    'data-[state=open]:bg-sidebar-item-active data-[state=open]:text-sidebar-item-active-foreground',
                  )}
                >
                  <span className="min-w-0 truncate">{displayName}</span>
                  <ChevronDown size={14} strokeWidth={2} className="shrink-0 text-sidebar-action-icon" />
                </button>
              </Tip>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              sideOffset={4}
              className={cn(
                'rounded-xl p-0.5 overflow-hidden min-w-[180px] max-w-[260px]',
                'bg-[var(--cmd-palette-bg)]',
                'border border-[var(--cmd-palette-border)]',
                'shadow-[var(--shadow-menu)]',
              )}
            >
              {switchProjects.map((project) => {
                const active = project.projectKey === projectKey;
                return (
                  <DropdownMenuItem
                    key={project.projectKey}
                    onSelect={() => handleSwitchProject(project)}
                    className="h-8 px-2.5 rounded-md text-13 text-[var(--msg-assistant-text)] focus:bg-[var(--cmd-palette-item-hover)]"
                  >
                    <span className="min-w-0 flex-1 truncate">{project.displayName}</span>
                    <span className="ml-2 shrink-0 text-11 text-[var(--cmd-palette-item-meta)]">
                      {t('ccAgent.workdirBrowse.activeSessionCount', {
                        count: project.activeSessionCount,
                      })}
                    </span>
                    {active && <Check size={14} strokeWidth={2} className="ml-2 shrink-0 text-foreground" />}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span className="truncate text-sm font-semibold text-foreground">
            {displayName}
          </span>
        )}
        <div className="flex shrink-0 items-center gap-1.5">
          {mode === 'search' ? (
            // search 是独立态: refresh / collapse 只对文件树有意义,搜索时不该出现。
            // 只保留 X = 退出搜索回到 tree 模式。
            <Tip text={t('ccAgent.workdirBrowse.searchPanel.exit')}>
              <button
                type="button"
                onClick={handleToggleSearchMode}
                className="flex size-5 items-center justify-center rounded-md text-sidebar-action-icon hover:bg-sidebar-item-active hover:text-sidebar-item-active-foreground"
              >
                <XIcon size={14} strokeWidth={2} />
              </button>
            </Tip>
          ) : (
            <>
              <Tip text={t('ccAgent.workdirBrowse.searchPanel.searchFiles')}>
                <button
                  type="button"
                  onClick={handleToggleSearchMode}
                  className="flex size-5 items-center justify-center rounded-md text-sidebar-action-icon hover:bg-sidebar-item-active hover:text-sidebar-item-active-foreground"
                >
                  <Search size={14} strokeWidth={2} />
                </button>
              </Tip>
              <Tip text={t('ccAgent.workdirBrowse.treeAction.collapseAll')}>
                <button
                  type="button"
                  onClick={handleCollapseAll}
                  className="flex size-5 items-center justify-center rounded-md text-sidebar-action-icon hover:bg-sidebar-item-active hover:text-sidebar-item-active-foreground"
                >
                  <ChevronsDownUp size={14} strokeWidth={2} />
                </button>
              </Tip>
              <Tip text={t('ccAgent.workdirBrowse.treeAction.refresh')}>
                <button
                  type="button"
                  onClick={handleRefresh}
                  className="flex size-5 items-center justify-center rounded-md text-sidebar-action-icon hover:bg-sidebar-item-active hover:text-sidebar-item-active-foreground"
                >
                  <RefreshCw size={14} strokeWidth={2} />
                </button>
              </Tip>
            </>
          )}
        </div>
      </div>

      {/* Body: tree 或 search panel(切换时不卸载彼此 — 用 hidden 而非
          条件 mount, 否则切回 search 时 useProjectSearch 的累积态会丢)。
          注:tree 一侧不能再加横向 padding, 行内自带 paddingLeft 规则。 */}
      <div className="min-h-0 flex-1">
        {/* tree mode:常驻 FileFilterInput + (筛选结果列表 / 文件树)。
            筛选 query 走 ripgrep --files 项目级文件索引(useProjectFileList),跟
            mode=search 的内容搜索是两套独立能力,互补。
            注:className 必须**只在隐藏时**加 `hidden`,**不能**同时写 `block` ——
            Tailwind 的 `block` 是 display:block,会覆盖 `flex`,容器不再是 flex 容器,
            内部 `min-h-0 flex-1` 拿不到明确高度,FileTreeView 的 overflow-y-auto
            就滚不动了。 */}
        <div className={cn('flex h-full flex-col', mode !== 'tree' && 'hidden')}>
          <FileFilterInput value={filterQuery} onChange={setFilterQuery} />
          {filterQuery ? (
            <FilterResultList
              files={filteredFiles}
              truncated={
                projectFiles.truncated || filteredFiles.length >= FILTER_RESULT_LIMIT
              }
              isLoading={projectFiles.isLoading}
              indexError={projectFiles.error}
              selectedPath={selectedPath}
              onSelectFile={handleSelectFromFilter}
            />
          ) : (
            <FileTreeView
              ref={fileTreeRef}
              tree={tree}
              selectedPath={selectedPath}
              onSelectFile={handleSelectFile}
              onNewFile={handleNewFile}
              onNewFolder={handleNewFolder}
              onDeleteFile={handleDeleteFile}
              onCopyFilePath={handleCopyFilePath}
              onRevealInFolder={remoteHostId || deviceId ? undefined : handleRevealInFolder}
              onOpenInSidebarBrowser={remoteHostId || deviceId ? undefined : handleOpenInSidebarBrowser}
              onOpenInBrowser={remoteHostId || deviceId ? undefined : handleOpenInBrowser}
              onRename={handleRename}
              pendingCreate={pendingCreate}
              onPendingSubmit={handlePendingSubmit}
              onPendingCancel={handlePendingCancel}
              renamingPath={renamingPath}
              onRenameSubmit={handleRenameSubmit}
              onRenameCancel={handleRenameCancel}
            />
          )}
        </div>
        <div className={cn('h-full', mode === 'search' ? 'block' : 'hidden')}>
          <SearchPanel
            query={searchQuery}
            onQueryChange={setSearchQuery}
            caseSensitive={searchCaseSensitive}
            onCaseSensitiveChange={setSearchCaseSensitive}
            results={search.results}
            totalMatches={search.totalMatches}
            totalFiles={search.totalFiles}
            status={search.status}
            errorMessage={search.errorMessage}
            errorCode={search.errorCode}
            maxMatches={SEARCH_MAX_MATCHES}
            onOpenMatch={handleOpenMatch}
          />
        </div>
      </div>
    </div>
  );
}
