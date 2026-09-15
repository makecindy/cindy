/**
 * FileTreeView — vscode-style lazy-expansion file tree（虚拟滚动）。
 *
 * 每行布局：
 *   [chevron 12 / ghost 12] [icon 14] [name]
 *   indent = depth * 16 px
 *
 * 视觉对齐 cc-agent 侧栏的 ProjectNode + SessionItem：
 *   - h 7 (28 px) rounded-md
 *   - 选中 text-sm font-medium，其余 normal
 *   - hover bg sidebar-item-hover / selected bg sidebar-item-active
 *
 * 虚拟滚动：树是「扁平行数组 + 固定行高」，node_modules 展开后单棵树上千行。
 * 全量渲染时每行（图标 + i18n wrapper + DOM 创建）实测约 0.25ms，展开一次阻塞
 * 主线程 ~350ms；@tanstack/react-virtual 只渲染视口内的行（+ overscan），行数
 * 不再与渲染成本挂钩。
 *
 * 非激活 tab（RSB keep-alive 的 display:none 子树）的实际行为分两种，行数都有界：
 *   - 首挂载即隐藏（视口从未测量）：虚拟器拿到 initialRect {0,0} → 产出 0 行；
 *   - 可见过再隐藏：virtual-core 的 cleanup() 只断开 observer，不清 scrollRect，
 *     会保留最后一个视口的行（约 视口高/29 + overscan ≈ 25–50 行），不会回退到全量渲染。
 * 所以被删掉的旧 active prop 门控（隐藏 tab 不产出任何行 DOM）已不再保证；active
 * 现在只用于滚动位置的恢复时机（见下）。边界测试见 __tests__/FileTreeView.scroll.test.tsx。
 *
 * 滚动位置：顶部行 + 行内偏移作为锚点存在 treeScrollStore，绑定关系是
 * 「视口身份（scrollScope）+ store key（隐藏态 / 放行态）」。切 tab、切
 * 「显示被忽略的目录」、组件卸载重挂后都会恢复到同一行；具体见
 * useTreeScrollRestore 与 lib/treeScrollStore.ts。
 *
 * 右键菜单（虚拟 trigger 模式，与 ProjectNode 同款）：
 *   - 文件夹 → New File / New Folder / Rename / Show in folder
 *   - 文件   → Open in file browser / sidebar browser / browser / Copy path /
 *              Rename / Show in folder / Delete
 *   菜单项由数据驱动（见 menuActions），实际副作用（IPC、确认弹窗、剪贴板、
 *   toast）全部由父层 props 注入 —— 本组件只负责呼起菜单 + 派发事件。
 *   remote 会话不传对应 handler，菜单项随之隐藏，而不是点了没反应。
 *
 * Inline 新建 / 重命名（VSCode 风格，共用 InlineTreeRow）：
 *   - 新建：父层传 pendingCreate = { kind, parentRel }，树在父目录下方插一行 input；
 *     回车 / 失焦提交 → onPendingSubmit(name)，Esc / 空提交 → onPendingCancel。
 *   - 重命名：父层传 renamingPath，该行换成 prefill 原名的 input（文件选中 basename）；
 *     回车 / 失焦提交 → onRenameSubmit(newName)，Esc / 同名 → onRenameCancel。
 *
 * 键盘：Enter/Space 切换目录 / 选中文件（行内主按钮）；方向键未接线。
 */

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import {
  ChevronDown,
  ChevronRight,
  Clipboard,
  File,
  Globe,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Eye,
  PanelRight,
  Pencil,
  Trash2,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  COMPOSER_MENTION_MIME,
  encodeComposerMentionPayload,
} from '@/lib/composerMentionDrag';
import { isBrowserOpenablePath } from '../../../../shared/browserOpenableExts';
import { pickFileIcon, pickFolderIcon } from './lib/fileIcon';
import { isLightboxImagePath } from './lib/imageExt';
import type { DirEntry, UseFileTreeReturn } from './hooks/useFileTree';
import { useDelayedFlag } from './hooks/useDelayedFlag';
import { useTreeScrollRestore } from './hooks/useTreeScrollRestore';
import { makeTreeScrollScope } from './lib/treeScrollStore';
import {
  TREE_LIST_PADDING,
  TREE_ROW_PITCH,
  flattenTree,
  treeRowKey,
  type PendingCreate,
} from './lib/treeRows';

export type { PendingCreate } from './lib/treeRows';

/** 视口上下各多渲染几行，滚动不闪白。 */
const OVERSCAN = 12;

/**
 * Imperative API：让 caller（WorkdirBrowseSidebar / RSB file-browser plugin）在
 * 筛选选中 / 跳转后，把目标文件行滚到视口中央。和 useFileTree.expandToPath 配套用
 * —— 先展开父目录链让目标行进入虚拟列表，再 scrollToPath 让用户看见。
 */
export interface FileTreeViewHandle {
  /** 找到 relPath 对应的行并滚到视口中央。行不在当前树里（父目录未展开 /
   *  文件不存在）→ 静默 no-op；caller 应先调 tree.expandToPath() 并等 React
   *  渲染再调本方法（典型：两次 rAF 之间，见 useRevealFileInTree）。 */
  scrollToPath: (relPath: string) => void;
}

export interface FileTreeViewProps {
  tree: UseFileTreeReturn;
  /**
   * 视口身份。同一份 store（同 workdir / 同开关状态）可能同时挂在多个
   * FileTreeView 上 —— RSB 每个文件浏览器 tab 一个，doc 侧栏一个 —— 滚动锚点按
   * 「视口 + store」分片，这个值是视口那一半。同一 tab 生命周期内必须稳定
   * （RSB 传 ctx.tabId，doc 侧栏传固定字符串）。
   */
  scrollScope: string;
  /**
   * 宿主是否处于激活状态（RSB 多标签 keep-alive）。仅影响**滚动位置的恢复时机**：
   * 非激活 → 激活时重新对齐到锚点。不承担行渲染门控：首挂载即隐藏的 tab 产 0 行，
   * 可见过再隐藏的 tab 保留最后一个视口的行（≤ 视口高/29 + overscan，见文件头注释）。
   * 默认真（doc 侧栏等单宿主场景）。
   */
  active?: boolean;
  /** Currently selected file relPath (from URL). Used to draw highlight. */
  selectedPath: string | null;
  /** Click on a file row → caller updates URL search param. */
  onSelectFile: (relPath: string) => void;
  /** 图片文件行的小眼睛操作；仅传入该能力的宿主显示。 */
  onPreviewImage?: (entry: DirEntry) => void;
  /** Right-click 文件夹 → 新建文件。parentRel 是被点中文件夹的 relPath。 */
  onNewFile?: (parentRel: string) => void;
  /** Right-click 文件夹 → 新建子文件夹。 */
  onNewFolder?: (parentRel: string) => void;
  /** Right-click 文件 → 删除该文件。entry 透传给父层用于二次确认文案。 */
  onDeleteFile?: (entry: DirEntry) => void;
  /** Right-click 文件 → 复制 OS 绝对路径到剪贴板。 */
  onCopyFilePath?: (entry: DirEntry) => void;
  /** Right-click 文件/文件夹 → 在 OS 文件管理器中打开并选中该条目。 */
  onRevealInFolder?: (entry: DirEntry) => void;
  /** Right-click 文件 → 新开一个 RSB 文件浏览器 tab 并选中该文件。 */
  onOpenInFileBrowser?: (entry: DirEntry) => void;
  /** Right-click HTML 文件 → 在当前会话的侧边栏浏览器新开页签。 */
  onOpenInSidebarBrowser?: (entry: DirEntry) => void;
  /** Right-click 浏览器可渲染文件 → 交给系统浏览器打开。 */
  onOpenInBrowser?: (entry: DirEntry) => void;
  /** Right-click 文件/文件夹 → 重命名。父层负责进入 renaming 态。 */
  onRename?: (entry: DirEntry) => void;
  /** Inline 输入态：有值时在 parentRel 下方插临时行。 */
  pendingCreate?: PendingCreate | null;
  /** 用户敲了非空 name + 回车 / 失焦时调用。 */
  onPendingSubmit?: (name: string) => void;
  /** Esc / 空内容失焦 / 父层主动取消。 */
  onPendingCancel?: () => void;
  /** 当前正处于重命名编辑态的 relPath；非 null 时该行渲染成内联 input。 */
  renamingPath?: string | null;
  /** 重命名 input 提交回调，新名（basename，不含父路径）非空且与原名字不同时触发。 */
  onRenameSubmit?: (newName: string) => void;
  /** Esc / 同名 / 空内容失焦。 */
  onRenameCancel?: () => void;
}

interface MenuState {
  pos: { x: number; y: number };
  entry: DirEntry;
}

interface TreeMenuAction {
  key: string;
  icon: LucideIcon;
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

function isHtmlPath(filePath: string): boolean {
  return /\.(html?|xhtml)$/i.test(filePath);
}

export const FileTreeView = forwardRef<FileTreeViewHandle, FileTreeViewProps>(function FileTreeView(
  {
    tree,
    scrollScope,
    active = true,
    selectedPath,
    onSelectFile,
    onPreviewImage,
    onNewFile,
    onNewFolder,
    onDeleteFile,
    onCopyFilePath,
    onRevealInFolder,
    onOpenInFileBrowser,
    onOpenInSidebarBrowser,
    onOpenInBrowser,
    onRename,
    pendingCreate,
    onPendingSubmit,
    onPendingCancel,
    renamingPath,
    onRenameSubmit,
    onRenameCancel,
  },
  ref,
) {
  const { t } = useTranslation();
  const rows = useMemo(
    () => flattenTree(tree.entries, tree.expanded, pendingCreate ?? null),
    [tree.entries, tree.expanded, pendingCreate],
  );

  // 单个 dropdown 实例，通过虚拟 trigger 在右键位置显示。同一时间只可能有一个
  // 右键菜单打开，把状态提到 view 顶层而不是每行一个，避免 N 个 DropdownMenu
  // 实例的额外开销。
  const [menu, setMenu] = useState<MenuState | null>(null);

  const canOpenEntryInSidebarBrowser = (entry: DirEntry): boolean =>
    entry.type === 'file' && Boolean(onOpenInSidebarBrowser) && isHtmlPath(entry.relPath);
  const canOpenEntryInBrowser = (entry: DirEntry): boolean =>
    entry.type === 'file' && Boolean(onOpenInBrowser) && isBrowserOpenablePath(entry.relPath);
  const hasContextActions = (entry: DirEntry): boolean => {
    if (entry.type === 'directory') {
      return Boolean(onNewFile || onNewFolder || onRename || onRevealInFolder);
    }
    return Boolean(
      onOpenInFileBrowser ||
        canOpenEntryInSidebarBrowser(entry) ||
        onCopyFilePath ||
        onRename ||
        onRevealInFolder ||
        canOpenEntryInBrowser(entry) ||
        onDeleteFile,
    );
  };

  // 稳定引用：每行的 memo 依赖它。用 ref 转发到最新实现，依赖数组留空 —— 这个
  // 回调的语义是「用当前 props 打开菜单」，不是「捕获首次 props」。
  const contextMenuRef = useRef<(entry: DirEntry, e: React.MouseEvent<HTMLDivElement>) => void>(
    () => {},
  );
  contextMenuRef.current = (entry, e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!hasContextActions(entry)) return;
    setMenu({ pos: { x: e.clientX, y: e.clientY }, entry });
  };
  const handleRowContextMenu = useCallback(
    (entry: DirEntry, e: React.MouseEvent<HTMLDivElement>) =>
      contextMenuRef.current(entry, e),
    [],
  );

  // scroll 容器 ref —— 虚拟器与滚动锚点都以它为坐标原点。
  const containerRef = useRef<HTMLDivElement>(null);

  // 行内编辑行（新建 / 重命名）必须始终留在虚拟窗口里：输入值存在 InlineTreeRow
  // 自己的 state 里、提交靠 blur —— 行被虚拟化回收时元素从 DOM 移除，浏览器不会
  // 给被移除的元素派发 blur，草稿静默丢失；滚回来时又会以空值重新挂载并抢焦点。
  // rangeExtractor 把这一行额外钉进渲染集合（其余行照旧按视口回收），滚动不再
  // 打断编辑。
  const pinnedEditRowIndex = useMemo(() => {
    if (renamingPath) {
      const index = rows.findIndex(
        (row) => row.kind === 'entry' && row.entry.relPath === renamingPath,
      );
      if (index >= 0) return index;
    }
    if (pendingCreate) {
      const index = rows.findIndex(
        (row) =>
          row.kind === 'pending' &&
          row.pending.parentRel === pendingCreate.parentRel &&
          row.pending.kind === pendingCreate.kind,
      );
      if (index >= 0) return index;
    }
    return -1;
  }, [pendingCreate, renamingPath, rows]);

  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      if (pinnedEditRowIndex >= 0 && !indexes.includes(pinnedEditRowIndex)) {
        indexes.push(pinnedEditRowIndex);
        indexes.sort((a, b) => a - b);
      }
      return indexes;
    },
    [pinnedEditRowIndex],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    // 非激活 tab 不发滚动元素：虚拟器会断开观察，激活时重新订阅并**同步**读一次
    // 真实视口尺寸（observeElementRect 订阅时立即 read offsetWidth/Height）。
    // 不能只靠 ResizeObserver 把「视口从 0 变回来」告诉虚拟器：display:none 子树
    // 上的 RO 回调时机不可靠（窗口不可见时 Chrome 干脆不派发），懒挂载的隐藏 tab
    // 切回后就会永远 scrollRect=0、一行不渲染（实测）。
    getScrollElement: () => (active ? containerRef.current : null),
    estimateSize: () => TREE_ROW_PITCH,
    overscan: OVERSCAN,
    paddingStart: TREE_LIST_PADDING,
    paddingEnd: TREE_LIST_PADDING,
    rangeExtractor,
    // 行内容的稳定 key：展开/折叠后行的 index 会位移，靠 key 复用 measure 缓存。
    getItemKey: (index) => {
      const row = rows[index];
      return row ? treeRowKey(row) : index;
    },
  });
  // imperative handle 的 deps 为空（避免每帧重建），用 ref 取最新值。
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;

  // 滚动位置：onScroll 持续记录锚点；挂载 / 换 store / 重新激活时自动恢复。
  const handleScroll = useTreeScrollRestore(
    makeTreeScrollScope(scrollScope, tree.storeKey),
    rows,
    containerRef,
    active,
  );

  // 首载 loading 延迟门控：本地到不了 300ms 保持空白，SSH / device-link 慢通道
  // 超时后浮现 spinner（见 useDelayedFlag 注释）。
  const showInitialSpinner = useDelayedFlag(tree.initialLoading);

  useImperativeHandle(
    ref,
    () => ({
      scrollToPath: (relPath: string) => {
        // 虚拟化后目标行多半不在 DOM 里（甚至还没进视口），不能再 querySelector +
        // scrollIntoView —— 按行索引让虚拟器滚过去，它会把目标行渲染出来。
        const index = rowsRef.current.findIndex(
          (row) => row.kind === 'entry' && row.entry.relPath === relPath,
        );
        if (index < 0) return; // 行不在当前树里（父目录未展开 / 文件不存在），静默 no-op
        virtualizerRef.current?.scrollToIndex(index, { align: 'center', behavior: 'smooth' });
      },
    }),
    [],
  );

  // 右键菜单项：按 entry 类型 + 宿主提供了哪些 handler 动态生成。
  const menuActions = useMemo<TreeMenuAction[]>(() => {
    if (!menu) return [];
    const entry = menu.entry;
    const close = () => setMenu(null);
    const actions: TreeMenuAction[] = [];
    if (entry.type === 'directory') {
      if (onNewFile) {
        actions.push({
          key: 'new-file',
          icon: FilePlus,
          label: t('ccAgent.workdirBrowse.treeMenu.newFile'),
          onSelect: () => {
            close();
            onNewFile(entry.relPath);
          },
        });
      }
      if (onNewFolder) {
        actions.push({
          key: 'new-folder',
          icon: FolderPlus,
          label: t('ccAgent.workdirBrowse.treeMenu.newFolder'),
          onSelect: () => {
            close();
            onNewFolder(entry.relPath);
          },
        });
      }
    } else {
      if (onOpenInFileBrowser) {
        actions.push({
          key: 'open-in-file-browser',
          icon: FolderTree,
          label: t('ccAgent.workdirBrowse.treeMenu.openInFileBrowser'),
          onSelect: () => {
            close();
            onOpenInFileBrowser(entry);
          },
        });
      }
      if (canOpenEntryInSidebarBrowser(entry)) {
        actions.push({
          key: 'open-in-sidebar-browser',
          icon: PanelRight,
          label: t('chat.markdownRenderer.openInSidebarBrowser'),
          onSelect: () => {
            close();
            onOpenInSidebarBrowser?.(entry);
          },
        });
      }
      if (onCopyFilePath) {
        actions.push({
          key: 'copy-path',
          icon: Clipboard,
          label: t('ccAgent.workdirBrowse.treeMenu.copyFilePath'),
          onSelect: () => {
            close();
            onCopyFilePath(entry);
          },
        });
      }
    }
    if (onRename) {
      actions.push({
        key: 'rename',
        icon: Pencil,
        label: t('ccAgent.workdirBrowse.treeMenu.rename'),
        onSelect: () => {
          close();
          onRename(entry);
        },
      });
    }
    // remote 会话不传 onRevealInFolder（文件在远端，本机文件管理器打不开），
    // 菜单项整个隐藏而不是点了没反应。
    if (onRevealInFolder) {
      actions.push({
        key: 'reveal-in-folder',
        icon: FolderOpen,
        label: t('ccAgent.workdirBrowse.treeMenu.showInFolder'),
        onSelect: () => {
          close();
          onRevealInFolder(entry);
        },
      });
    }
    if (entry.type === 'file') {
      if (canOpenEntryInBrowser(entry)) {
        actions.push({
          key: 'open-in-browser',
          icon: Globe,
          label: t('chat.markdownRenderer.openInBrowser'),
          onSelect: () => {
            close();
            onOpenInBrowser?.(entry);
          },
        });
      }
      if (onDeleteFile) {
        actions.push({
          key: 'delete',
          icon: Trash2,
          label: t('ccAgent.workdirBrowse.treeMenu.deleteFile'),
          danger: true,
          onSelect: () => {
            close();
            onDeleteFile(entry);
          },
        });
      }
    }
    return actions;
  }, [
    menu,
    onCopyFilePath,
    onDeleteFile,
    onNewFile,
    onNewFolder,
    onOpenInBrowser,
    onOpenInFileBrowser,
    onOpenInSidebarBrowser,
    onRevealInFolder,
    onRename,
    t,
  ]);

  // 空 / loading 也留在**同一个**滚动容器里：容器是虚拟器的 getScrollElement，如果
  // 这两个分支返回另一个 div，切开关（新 store 首帧 rows 为空，必走空分支）就会让
  // containerRef 指向别处 —— 虚拟器失去滚动元素后内部 offset 与真实 scrollTop 脱节。
  const emptyState = tree.initialLoading ? (
    // 本地首个 listDir <50ms，门控内保持空白（规则 7）；远程慢通道超过阈值后浮现
    // spinner + 提示，避免长空白被读成"项目是空的 / 坏了"。
    <div className="flex h-full w-full flex-col items-center justify-center gap-2">
      {showInitialSpinner && (
        <>
          <Spinner size={16} className="text-[var(--cmd-palette-item-meta)]" />
          <span className="text-12 text-[var(--cmd-palette-item-meta)]">
            {t('ccAgent.workdirBrowse.treeLoading')}
          </span>
        </>
      )}
    </div>
  ) : (
    <div className="flex h-full w-full items-center justify-center px-4 text-12 text-[var(--cmd-palette-item-meta)]">
      {t('ccAgent.workdirBrowse.treeEmpty')}
    </div>
  );

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-y-auto"
      onScroll={handleScroll}
    >
      {rows.length === 0 ? (
        emptyState
      ) : (
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index];
            if (!row) return null;
            let content: ReactNode;
            if (row.kind === 'pending') {
              content = (
                <InlineTreeRow
                  icon={row.pending.kind === 'folder' ? Folder : File}
                  depth={row.depth}
                  placeholder={row.pending.kind === 'folder' ? 'new-folder' : 'untitled'}
                  onSubmit={onPendingSubmit}
                  onCancel={onPendingCancel}
                />
              );
            } else if (renamingPath === row.entry.relPath) {
              content = (
                <InlineTreeRow
                  icon={row.entry.type === 'directory' ? Folder : File}
                  depth={row.depth}
                  initialValue={row.entry.name}
                  cancelWhenUnchanged
                  selection={row.entry.type === 'file' ? 'basename' : 'all'}
                  onSubmit={onRenameSubmit}
                  onCancel={onRenameCancel}
                />
              );
            } else {
              const { entry, depth } = row;
              content = (
                <FileTreeRow
                  entry={entry}
                  depth={depth}
                  selected={entry.type === 'file' && entry.relPath === selectedPath}
                  expanded={tree.expanded.has(entry.relPath)}
                  loading={tree.loadingPaths.has(entry.relPath)}
                  onToggleFolder={tree.toggleFolder}
                  onSelectFile={onSelectFile}
                  onPreviewImage={onPreviewImage}
                  onContextMenu={handleRowContextMenu}
                />
              );
            }
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: TREE_ROW_PITCH,
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                {content}
              </div>
            );
          })}
        </div>
      )}

      {/* 虚拟 trigger 右键菜单 —— 与 ProjectNode 同款做法：点中位置插一个
          width/height=0 的占位元素当 anchor，DropdownMenu 沿 align="start"
          展开，Radix 自动处理边界翻转 / 焦点循环 / Esc 关闭 / outside-click。 */}
      <DropdownMenu
        open={menu !== null}
        onOpenChange={(open) => {
          if (!open) setMenu(null);
        }}
      >
        <DropdownMenuTrigger asChild>
          <span
            aria-hidden
            style={{
              position: 'fixed',
              left: menu?.pos.x ?? 0,
              top: menu?.pos.y ?? 0,
              width: 0,
              height: 0,
              pointerEvents: 'none',
            }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={2}
          className={cn(
            'rounded-xl p-0.5 overflow-hidden',
            'bg-[var(--cmd-palette-bg)]',
            'border border-[var(--cmd-palette-border)]',
            'shadow-[var(--shadow-menu)]',
          )}
        >
          {menuActions.map((action) => (
            <DropdownMenuItem
              key={action.key}
              onClick={action.onSelect}
              className={cn(
                'h-7 px-2.5 rounded-md text-13 leading-none text-[var(--msg-assistant-text)]',
                'focus:bg-[var(--cmd-palette-item-hover)]',
                action.danger &&
                  'text-red-500 dark:text-red-400 focus:bg-red-50 dark:focus:bg-red-500/10',
              )}
            >
              <action.icon className="mr-2 h-3.5 w-3.5 shrink-0" />
              <span className="relative top-px">{action.label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
});

interface FileTreeRowProps {
  entry: DirEntry;
  depth: number;
  selected: boolean;
  expanded: boolean;
  /** 该目录正在懒加载子项（listDir in-flight）。延迟门控后 chevron 原位转圈。 */
  loading?: boolean;
  onToggleFolder: (relPath: string) => void;
  onSelectFile: (relPath: string) => void;
  onPreviewImage?: (entry: DirEntry) => void;
  /** 稳定回调（entry 由行内回传）。行组件已 memo，父组件传内联箭头会让 memo
   *  全部失效 —— node_modules 展开时每次 store 更新都会重渲染全部行。 */
  onContextMenu: (entry: DirEntry, e: React.MouseEvent<HTMLDivElement>) => void;
}

const FileTreeRow = memo(function FileTreeRow({
  entry,
  depth,
  selected,
  expanded,
  loading = false,
  onToggleFolder,
  onSelectFile,
  onPreviewImage,
  onContextMenu,
}: FileTreeRowProps) {
  const { t } = useTranslation();
  const isFolder = entry.type === 'directory';
  const canPreviewImage =
    !isFolder && Boolean(onPreviewImage) && isLightboxImagePath(entry.relPath);
  // 展开慢时 chevron 原位换 spinner（同尺寸，行几何零变化）；门控见 useDelayedFlag。
  const showLoadingChevron = useDelayedFlag(loading && isFolder);
  const Chev = expanded ? ChevronDown : ChevronRight;
  const Icon = isFolder ? pickFolderIcon(expanded) : pickFileIcon(entry.name);

  // Indent: 16 px per depth + 8 px base padding.
  const paddingLeft = depth * 16 + 8;
  const rowStyle = {
    WebkitUserDrag: 'element',
  } as CSSProperties & {
    WebkitUserDrag: 'element';
  };

  const handleClick = () => {
    if (isFolder) onToggleFolder(entry.relPath);
    else onSelectFile(entry.relPath);
  };

  // 行内回传 entry，父组件因此能传稳定引用（memo 才生效）。
  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => onContextMenu(entry, e);

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData(
      COMPOSER_MENTION_MIME,
      encodeComposerMentionPayload({
        type: isFolder ? 'directory' : 'file',
        relPath: entry.relPath,
        name: entry.name,
      }),
    );
    // Firefox requires at least one text payload to keep the drag alive.
    e.dataTransfer.setData('text/plain', entry.relPath);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 行内主按钮承载键盘语义；外层 click 只补回 padding 死区，眼睛按钮会阻止冒泡。
    <div
      draggable
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onDragStart={handleDragStart}
      style={rowStyle}
      data-relpath={entry.relPath}
      className={cn(
        'group/file-row flex h-7 w-full shrink-0 items-center rounded-md pr-2',
        'cursor-pointer text-13 transition-colors',
        selected
          ? 'bg-sidebar-item-active font-medium text-sidebar-item-active-foreground'
          : 'text-foreground hover:bg-sidebar-item-hover',
      )}
    >
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          handleClick();
        }}
        style={{ paddingLeft }}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 bg-transparent p-0 text-left text-inherit focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
      >
        {isFolder ? (
          showLoadingChevron ? (
            <Spinner size={12} strokeWidth={2} className="text-[var(--cmd-palette-item-meta)]" />
          ) : (
            <Chev
              size={12}
              strokeWidth={2}
              className="shrink-0 text-[var(--cmd-palette-item-meta)]"
            />
          )
        ) : (
          // Phantom 12 px slot so file icons line up with folder icons at the
          // same depth. Same trick as VSCode.
          <span aria-hidden className="inline-block w-3 shrink-0" />
        )}
        <Icon
          size={14}
          strokeWidth={1.75}
          className={cn(
            'shrink-0',
            selected
              ? 'text-sidebar-item-active-foreground'
              : 'text-[var(--cmd-palette-item-meta)]',
          )}
        />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      </button>
      {canPreviewImage ? (
        <Tip text={t('ccAgent.workdirBrowse.imagePreview.viewLarge')} side="left">
          <button
            type="button"
            aria-label={t('ccAgent.workdirBrowse.imagePreview.viewLarge')}
            onClick={(event) => {
              event.stopPropagation();
              onPreviewImage?.(entry);
            }}
            className={cn(
              'pointer-events-none flex size-5 shrink-0 select-none items-center justify-center rounded-full opacity-0',
              'transition-[color,background-color,opacity] duration-[var(--motion-fast)] active:scale-[0.98]',
              'group-hover/file-row:pointer-events-auto group-hover/file-row:opacity-100',
              'group-focus-within/file-row:pointer-events-auto group-focus-within/file-row:opacity-100',
              'focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]',
              selected
                ? 'text-sidebar-item-active-foreground'
                : 'text-sidebar-action-icon hover:bg-sidebar-item-hover hover:text-foreground',
            )}
          >
            <Eye size={14} strokeWidth={1.75} />
          </button>
        </Tip>
      ) : null}
    </div>
  );
});

interface InlineTreeRowProps {
  icon: LucideIcon;
  depth: number;
  /** 初始文本。重命名 = 原名字；新建 = 空。 */
  initialValue?: string;
  /** 提交值与原值相同（或为空）时走 onCancel（重命名语义；新建只判空）。 */
  cancelWhenUnchanged?: boolean;
  placeholder?: string;
  /** 聚焦时的选区策略：新建不选、重命名文件只选 basename、文件夹全选。 */
  selection?: 'none' | 'all' | 'basename';
  onSubmit?: (value: string) => void;
  onCancel?: () => void;
}

/**
 * Inline 输入行 —— 新建与重命名共用（几何 / 提交语义 / 双提交锁只有一份实现）。
 *
 * 提交语义：
 *   - Enter → 非空且（对重命名）有变化 → submit；否则 cancel
 *   - Esc   → cancel
 *   - blur  → 同 Enter
 *   - 路径分隔符 / `.` / `..` 由父层校验，这里不做（父层有更精准的 toast）。
 *
 * commit 用 ref 锁：Enter 后立刻 blur 也会触发 onBlur，不锁会提交两次；父层卸载
 * 本组件是异步的，中间 onBlur 仍会跑。
 */
function InlineTreeRow({
  icon: Icon,
  depth,
  initialValue = '',
  cancelWhenUnchanged = false,
  placeholder,
  selection = 'none',
  onSubmit,
  onCancel,
}: InlineTreeRowProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (selection === 'basename') {
      // VSCode F2 同款：文件只选 basename（不含 . + ext），方便直接改主名；
      // 没有扩展名（Dockerfile 等）落回全选。
      const dot = el.value.lastIndexOf('.');
      if (dot > 0) {
        el.setSelectionRange(0, dot);
        return;
      }
    }
    if (selection !== 'none') el.select();
  }, [selection]);

  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    const trimmed = value.trim();
    if (!trimmed || (cancelWhenUnchanged && trimmed === initialValue)) {
      onCancel?.();
    } else {
      onSubmit?.(trimmed);
    }
  };

  const cancel = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCancel?.();
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  return (
    <div
      style={{ paddingLeft: depth * 16 + 8 }}
      className={cn(
        'flex h-7 w-full shrink-0 items-center gap-1.5 rounded-md pr-2',
        'bg-sidebar-item-active text-sidebar-item-active-foreground',
      )}
    >
      <span aria-hidden className="inline-block w-3 shrink-0" />
      <Icon
        size={14}
        strokeWidth={1.75}
        className="shrink-0 text-[var(--cmd-palette-item-meta)]"
      />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKey}
        onBlur={commit}
        placeholder={placeholder}
        className={cn(
          'min-w-0 flex-1 bg-transparent text-13 leading-none outline-none',
          'border border-[var(--cmd-palette-item-meta)] rounded-sm px-1 py-0.5',
          'text-sidebar-item-active-foreground placeholder:text-[var(--cmd-palette-item-meta)]',
        )}
      />
    </div>
  );
}
