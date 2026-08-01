/**
 * FileTreeView — vscode-style lazy-expansion file tree.
 *
 * Layout per row:
 *   [chevron 12 / ghost 12] [icon 14] [name]
 *   indent = depth * 16 px
 *
 * Visual specs match ProjectNode + SessionItem in cc-agent sidebar:
 *   - h 7 (28 px) rounded-md
 *   - text-sm font-medium for selected, normal otherwise
 *   - hover bg sidebar-item-hover
 *   - selected bg sidebar-item-active
 *
 * Right-click context menu (虚拟 trigger 模式,与 ProjectNode 同款):
 *   - 文件夹 → New File / New Folder (callback 收到 parent relPath)
 *   - 文件   → Delete File / Copy File Path
 *  实际副作用(IPC、确认弹窗、剪贴板写入、toast)由父层 props 注入,本组件
 *  只负责呼起菜单 + 派发事件。这样保持 FileTreeView 纯 UI 化。
 *
 * Inline new-file/folder UX (VSCode 风格):
 *   - 父层把 pendingCreate = { kind, parentRel } 传入,树会在父目录下方
 *     插入一个临时输入行(不发 IPC)。
 *   - 用户回车 / 失焦提交 → onPendingSubmit(name);Esc / 空提交 → onPendingCancel。
 *   - 真正的 IPC + 后续选中由 sidebar 负责;本组件只渲染 + 派发。
 *
 * Virtualization: deferred. Even at 700k total entries the *visible* set is
 * bounded by user expansion (typical: <200 visible rows). If profiling later
 * shows DOM cost, drop in @tanstack/react-virtual on the flat-rendered list.
 *
 * Keyboard: Enter/Space toggles folder or selects file. Arrow keys not yet
 * wired; future iteration.
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useTranslation } from 'react-i18next';
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

export interface PendingCreate {
  kind: 'file' | 'folder';
  /** workdir-relative POSIX path of the parent folder; '' = root. */
  parentRel: string;
}

/**
 * Imperative API:让 caller(WorkdirBrowseSidebar / RSB file-browser plugin)能
 * 在筛选选中 / 跳转后,把目标文件行滚到视口中央。和 useFileTree.expandToPath
 * 配套用 —— 先展开父目录链让目标行渲染出来,再 scrollToPath 让用户看见。
 *
 * 不走 prop 信号(避免 caller 每次都需要做 signal++ 之类的 token 计数),用
 * forwardRef 直接 imperative 调,语义更直白。
 */
export interface FileTreeViewHandle {
  /** 找到 data-relpath 匹配的行,scrollIntoView({ block: 'center' })。
   *  目标行未渲染(父目录未展开 / 文件不存在)→ 静默 no-op,caller 应先调
   *  tree.expandToPath() 并等 React 渲染再调本方法(典型:两次 rAF 之间)。 */
  scrollToPath: (relPath: string) => void;
}

export interface FileTreeViewProps {
  tree: UseFileTreeReturn;
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
  /** Inline 输入态:有值时在 parentRel 下方插临时行。 */
  pendingCreate?: PendingCreate | null;
  /** 用户敲了非空 name + 回车 / 失焦时调用。 */
  onPendingSubmit?: (name: string) => void;
  /** Esc / 空内容失焦 / 父层主动取消。 */
  onPendingCancel?: () => void;
  /** 当前正处于重命名编辑态的 relPath;非 null 时该行渲染成内联 input。 */
  renamingPath?: string | null;
  /** 重命名 input 提交回调,新名(basename, 不含父路径)非空时触发。 */
  onRenameSubmit?: (newName: string) => void;
  /** Esc / 空内容失焦 / 父层主动取消。 */
  onRenameCancel?: () => void;
}

interface EntryRow {
  kind: 'entry';
  entry: DirEntry;
  depth: number;
}

interface PendingRow {
  kind: 'pending';
  pending: PendingCreate;
  depth: number;
}

type Row = EntryRow | PendingRow;

interface MenuState {
  pos: { x: number; y: number };
  entry: DirEntry;
}

function isHtmlPath(filePath: string): boolean {
  return /\.(html?|xhtml)$/i.test(filePath);
}

/**
 * Walk the (entries Map × expanded Set) into a flat in-order list of rows
 * to render. Pure function — recomputed when either input changes.
 *
 * pendingCreate 注入位置:在父行被发出后立刻插一个 pending 行(深度 = 父行+1);
 * 父是 root('') 时插在最顶。这样视觉上 pending 行紧贴父目录,即使父目录里
 * 还没有任何 children 也能看到输入框,符合 VSCode 体验。
 */
function flattenTree(
  entries: ReadonlyMap<string, readonly DirEntry[]>,
  expanded: ReadonlySet<string>,
  pending: PendingCreate | null | undefined,
): Row[] {
  const out: Row[] = [];
  const root = entries.get('') ?? [];

  // Root-level pending 行:在所有顶层 entry 之前。
  if (pending && pending.parentRel === '') {
    out.push({ kind: 'pending', pending, depth: 0 });
  }

  const visit = (list: readonly DirEntry[], depth: number) => {
    for (const entry of list) {
      out.push({ kind: 'entry', entry, depth });
      if (entry.type === 'directory') {
        // 嵌套 pending 行:父行 push 完之后立刻插 —— 不依赖 children 是否已加载,
        // 没加载时输入框单独悬挂在父下方,跟 VSCode 行为一致。
        if (pending && pending.parentRel === entry.relPath) {
          out.push({ kind: 'pending', pending, depth: depth + 1 });
        }
        if (expanded.has(entry.relPath)) {
          const children = entries.get(entry.relPath);
          if (children) visit(children, depth + 1);
        }
      }
    }
  };
  visit(root, 0);
  return out;
}

export const FileTreeView = forwardRef<FileTreeViewHandle, FileTreeViewProps>(function FileTreeView(
  {
    tree,
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

  // 单个 dropdown 实例,通过虚拟 trigger 在右键位置显示。同一时间只可能有
  // 一个右键菜单打开,把状态提到 view 顶层而不是每行一个,避免 N 个
  // DropdownMenu 实例的额外开销。
  const [menu, setMenu] = useState<MenuState | null>(null);
  const close = () => setMenu(null);
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

  // scroll 容器 ref —— scrollToPath 在容器内 querySelector 找到目标行,再
  // scrollIntoView(用容器自己的 scroll,不是 window scroll)。
  const containerRef = useRef<HTMLDivElement>(null);
  // 首载 loading 延迟门控:本地到不了 300ms 保持空白,SSH / device-link 慢
  // 通道超时后浮现 spinner(见 useDelayedFlag 注释)。
  const showInitialSpinner = useDelayedFlag(tree.initialLoading);
  useImperativeHandle(
    ref,
    () => ({
      scrollToPath: (relPath: string) => {
        const container = containerRef.current;
        if (!container) return;
        // CSS.escape 防 relPath 里的 `.` / `/` / `[]` 等被 querySelector 当成
        // CSS 语法解析(实际 .pen / node_modules/foo 等路径常带这类字符)。
        const sel = `[data-relpath="${CSS.escape(relPath)}"]`;
        const el = container.querySelector<HTMLElement>(sel);
        if (!el) return; // 行未渲染(父目录未展开 / 文件不存在),静默 no-op
        // block: 'nearest' 是"已在视口内就不动";筛选场景里命中文件大概率不
        // 在当前 scroll 位置,改成 'center' 把它放到中部更醒目。
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      },
    }),
    [],
  );

  if (tree.initialLoading) {
    // 本地首个 listDir <50ms,门控内保持空白(规则 7);远程慢通道超过阈值
    // 后浮现 spinner + 提示,避免长空白被读成"项目是空的 / 坏了"。
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2">
        {showInitialSpinner && (
          <>
            <Spinner size={16} className="text-[var(--cmd-palette-item-meta)]" />
            <span className="text-[12px] text-[var(--cmd-palette-item-meta)]">
              {t('ccAgent.workdirBrowse.treeLoading')}
            </span>
          </>
        )}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center px-4 text-[12px] text-[var(--cmd-palette-item-meta)]">
        {t('ccAgent.workdirBrowse.treeEmpty')}
      </div>
    );
  }

  const isFolderMenu = menu?.entry.type === 'directory';

  return (
    <div ref={containerRef} className="flex h-full w-full flex-col gap-px overflow-y-auto py-2">
      {rows.map((row) => {
        if (row.kind === 'pending') {
          return (
            <PendingInputRow
              // key 加 parentRel,避免在不同父目录间复用同一 input 的 value 残留。
              key={`__pending__:${row.pending.parentRel}:${row.pending.kind}`}
              pending={row.pending}
              depth={row.depth}
              onSubmit={onPendingSubmit}
              onCancel={onPendingCancel}
            />
          );
        }
        const { entry, depth } = row;
        if (renamingPath === entry.relPath) {
          // 命中 renaming 态:同位置渲染一个 inline input,与新建行复用 PendingInputRow,
          // 但 prefill 当前 name + 文件类型选区策略走 RenamingInputRow 的逻辑。
          return (
            <RenamingInputRow
              key={`__rename__:${entry.relPath}`}
              entry={entry}
              depth={depth}
              onSubmit={onRenameSubmit}
              onCancel={onRenameCancel}
            />
          );
        }
        return (
          <FileTreeRow
            key={entry.relPath}
            entry={entry}
            depth={depth}
            selected={entry.type === 'file' && entry.relPath === selectedPath}
            expanded={tree.expanded.has(entry.relPath)}
            loading={tree.loadingPaths.has(entry.relPath)}
            onToggleFolder={tree.toggleFolder}
            onSelectFile={onSelectFile}
            onPreviewImage={onPreviewImage}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!hasContextActions(entry)) return;
              setMenu({ pos: { x: e.clientX, y: e.clientY }, entry });
            }}
          />
        );
      })}

      {/* 虚拟 trigger 右键菜单 —— 与 ProjectNode 同款做法:点中位置插一个
          width/height=0 的占位元素当 anchor,DropdownMenu 沿 align="start"
          展开,Radix 自动处理边界翻转 / 焦点循环 / Esc 关闭 / outside-click。 */}
      <DropdownMenu
        open={menu !== null}
        onOpenChange={(open) => {
          if (!open) close();
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
          {isFolderMenu && menu ? (
            <>
              {onNewFile && (
                <DropdownMenuItem
                  onClick={() => {
                    const parent = menu.entry.relPath;
                    close();
                    onNewFile(parent);
                  }}
                  className="h-7 px-2.5 rounded-md text-[13px] leading-none text-[var(--msg-assistant-text)] focus:bg-[var(--cmd-palette-item-hover)]"
                >
                  <FilePlus className="mr-2 h-3.5 w-3.5 shrink-0" />
                  <span className="relative top-px">{t('ccAgent.workdirBrowse.treeMenu.newFile')}</span>
                </DropdownMenuItem>
              )}
              {onNewFolder && (
                <DropdownMenuItem
                  onClick={() => {
                    const parent = menu.entry.relPath;
                    close();
                    onNewFolder(parent);
                  }}
                  className="h-7 px-2.5 rounded-md text-[13px] leading-none text-[var(--msg-assistant-text)] focus:bg-[var(--cmd-palette-item-hover)]"
                >
                  <FolderPlus className="mr-2 h-3.5 w-3.5 shrink-0" />
                  <span className="relative top-px">{t('ccAgent.workdirBrowse.treeMenu.newFolder')}</span>
                </DropdownMenuItem>
              )}
              {onRename && (
                <DropdownMenuItem
                  onClick={() => {
                    const entry = menu.entry;
                    close();
                    onRename(entry);
                  }}
                  className="h-7 px-2.5 rounded-md text-[13px] leading-none text-[var(--msg-assistant-text)] focus:bg-[var(--cmd-palette-item-hover)]"
                >
                  <Pencil className="mr-2 h-3.5 w-3.5 shrink-0" />
                  <span className="relative top-px">{t('ccAgent.workdirBrowse.treeMenu.rename')}</span>
                </DropdownMenuItem>
              )}
              {/* remote 会话不传 onRevealInFolder(文件在远端,本机文件管理器
                  打不开),菜单项整个隐藏而不是点了没反应。 */}
              {onRevealInFolder && (
                <DropdownMenuItem
                  onClick={() => {
                    const entry = menu.entry;
                    close();
                    onRevealInFolder(entry);
                  }}
                  className="h-7 px-2.5 rounded-md text-[13px] leading-none text-[var(--msg-assistant-text)] focus:bg-[var(--cmd-palette-item-hover)]"
                >
                  <FolderOpen className="mr-2 h-3.5 w-3.5 shrink-0" />
                  <span className="relative top-px">{t('ccAgent.workdirBrowse.treeMenu.showInFolder')}</span>
                </DropdownMenuItem>
              )}
            </>
          ) : menu ? (
            <>
              {onOpenInFileBrowser && (
                <DropdownMenuItem
                  onClick={() => {
                    const entry = menu.entry;
                    close();
                    onOpenInFileBrowser(entry);
                  }}
                  className="h-7 px-2.5 rounded-md text-[13px] leading-none text-[var(--msg-assistant-text)] focus:bg-[var(--cmd-palette-item-hover)]"
                >
                  <FolderTree className="mr-2 h-3.5 w-3.5 shrink-0" />
                  <span className="relative top-px">{t('ccAgent.workdirBrowse.treeMenu.openInFileBrowser')}</span>
                </DropdownMenuItem>
              )}
              {canOpenEntryInSidebarBrowser(menu.entry) && (
                <DropdownMenuItem
                  onClick={() => {
                    const entry = menu.entry;
                    close();
                    onOpenInSidebarBrowser?.(entry);
                  }}
                  className="h-7 px-2.5 rounded-md text-[13px] leading-none text-[var(--msg-assistant-text)] focus:bg-[var(--cmd-palette-item-hover)]"
                >
                  <PanelRight className="mr-2 h-3.5 w-3.5 shrink-0" />
                  <span className="relative top-px">{t('chat.markdownRenderer.openInSidebarBrowser')}</span>
                </DropdownMenuItem>
              )}
              {onCopyFilePath && (
                <DropdownMenuItem
                  onClick={() => {
                    const entry = menu.entry;
                    close();
                    onCopyFilePath(entry);
                  }}
                  className="h-7 px-2.5 rounded-md text-[13px] leading-none text-[var(--msg-assistant-text)] focus:bg-[var(--cmd-palette-item-hover)]"
                >
                  <Clipboard className="mr-2 h-3.5 w-3.5 shrink-0" />
                  <span className="relative top-px">{t('ccAgent.workdirBrowse.treeMenu.copyFilePath')}</span>
                </DropdownMenuItem>
              )}
              {onRename && (
                <DropdownMenuItem
                  onClick={() => {
                    const entry = menu.entry;
                    close();
                    onRename(entry);
                  }}
                  className="h-7 px-2.5 rounded-md text-[13px] leading-none text-[var(--msg-assistant-text)] focus:bg-[var(--cmd-palette-item-hover)]"
                >
                  <Pencil className="mr-2 h-3.5 w-3.5 shrink-0" />
                  <span className="relative top-px">{t('ccAgent.workdirBrowse.treeMenu.rename')}</span>
                </DropdownMenuItem>
              )}
              {/* remote 会话不传 onRevealInFolder(文件在远端,本机文件管理器
                  打不开),菜单项整个隐藏而不是点了没反应。 */}
              {onRevealInFolder && (
                <DropdownMenuItem
                  onClick={() => {
                    const entry = menu.entry;
                    close();
                    onRevealInFolder(entry);
                  }}
                  className="h-7 px-2.5 rounded-md text-[13px] leading-none text-[var(--msg-assistant-text)] focus:bg-[var(--cmd-palette-item-hover)]"
                >
                  <FolderOpen className="mr-2 h-3.5 w-3.5 shrink-0" />
                  <span className="relative top-px">{t('ccAgent.workdirBrowse.treeMenu.showInFolder')}</span>
                </DropdownMenuItem>
              )}
              {canOpenEntryInBrowser(menu.entry) && (
                <DropdownMenuItem
                  onClick={() => {
                    const entry = menu.entry;
                    close();
                    onOpenInBrowser?.(entry);
                  }}
                  className="h-7 px-2.5 rounded-md text-[13px] leading-none text-[var(--msg-assistant-text)] focus:bg-[var(--cmd-palette-item-hover)]"
                >
                  <Globe className="mr-2 h-3.5 w-3.5 shrink-0" />
                  <span className="relative top-px">{t('chat.markdownRenderer.openInBrowser')}</span>
                </DropdownMenuItem>
              )}
              {onDeleteFile && (
                <DropdownMenuItem
                  onClick={() => {
                    const entry = menu.entry;
                    close();
                    onDeleteFile(entry);
                  }}
                  className="h-7 px-2.5 rounded-md text-[13px] leading-none text-red-500 dark:text-red-400 focus:bg-red-50 dark:focus:bg-red-500/10"
                >
                  <Trash2 className="mr-2 h-3.5 w-3.5 shrink-0" />
                  <span className="relative top-px">{t('ccAgent.workdirBrowse.treeMenu.deleteFile')}</span>
                </DropdownMenuItem>
              )}
            </>
          ) : null}
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
  /** 该目录正在懒加载子项(listDir in-flight)。延迟门控后 chevron 原位转圈。 */
  loading?: boolean;
  onToggleFolder: (relPath: string) => void;
  onSelectFile: (relPath: string) => void;
  onPreviewImage?: (entry: DirEntry) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

function FileTreeRow({
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
  // 展开慢时 chevron 原位换 spinner(同尺寸,行几何零变化);门控见 useDelayedFlag。
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
      onContextMenu={onContextMenu}
      onDragStart={handleDragStart}
      style={rowStyle}
      // data-relpath:让 FileTreeView 的 imperative scrollToPath 能 querySelector
      // 找到这一行 scrollIntoView(筛选选中 / 跳转命中场景)。文件 + 文件夹都打,
      // 未来要"展开到某个文件夹"也能直接复用。
      data-relpath={entry.relPath}
      className={cn(
        'group/file-row flex h-7 w-full shrink-0 items-center rounded-md pr-2',
        'cursor-pointer text-[13px] transition-colors',
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
}

interface PendingInputRowProps {
  pending: PendingCreate;
  depth: number;
  onSubmit?: (name: string) => void;
  onCancel?: () => void;
}

/**
 * Inline 输入行 —— 与 FileTreeRow 同款几何/缩进,但中间是 input。
 *
 * 提交语义:
 *   - Enter      → 非空 submit / 空 cancel
 *   - Esc        → cancel
 *   - blur       → 同 Enter (非空 submit / 空 cancel);用 ref 锁防止双提交
 *   - 路径分隔符 / `.` / `..` 在父层校验,这里不做(让 IPC 与父层 toast 处理)
 *
 * commit 状态用 ref 锁:Enter 后立刻 blur 也会触发 onBlur,如果不锁就会调
 * 两次 onSubmit。父层会 setPendingCreate(null) 卸载本组件,但卸载是异步的,
 * 这中间 onBlur 仍会跑一次 —— ref 守住保证 onSubmit 只跑一次。
 */
interface RenamingInputRowProps {
  entry: DirEntry;
  depth: number;
  onSubmit?: (newName: string) => void;
  onCancel?: () => void;
}

/**
 * Inline 重命名行 —— 与 FileTreeRow 同位同款几何,只把 name span 换成 input。
 *
 * 选区策略(VSCode F2 同款):
 *   - 文件:有扩展名时只选 basename(不含 . + ext),方便直接改主名
 *   - 文件夹:全选(没有扩展名概念)
 *   - 没有扩展名的文件(如 README, Dockerfile):全选
 *
 * 提交语义同 PendingInputRow,空 / 与原名一致 → cancel(空算用户后悔,
 * 与原名一致是 no-op,也 cancel 比错误地走 IPC 更省心)。
 */
function RenamingInputRow({ entry, depth, onSubmit, onCancel }: RenamingInputRowProps) {
  const [value, setValue] = useState(entry.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (entry.type === 'file') {
      const dot = entry.name.lastIndexOf('.');
      if (dot > 0) {
        el.setSelectionRange(0, dot);
        return;
      }
    }
    el.select();
  }, [entry.name, entry.type]);

  const isFolder = entry.type === 'directory';
  const Icon = isFolder ? Folder : File;
  const paddingLeft = depth * 16 + 8;

  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    const trimmed = value.trim();
    if (!trimmed || trimmed === entry.name) {
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
      style={{ paddingLeft }}
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
        className={cn(
          'min-w-0 flex-1 bg-transparent text-[13px] leading-none outline-none',
          'border border-[var(--cmd-palette-item-meta)] rounded-sm px-1 py-0.5',
          'text-sidebar-item-active-foreground placeholder:text-[var(--cmd-palette-item-meta)]',
        )}
      />
    </div>
  );
}

function PendingInputRow({ pending, depth, onSubmit, onCancel }: PendingInputRowProps) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const Icon = pending.kind === 'folder' ? Folder : File;
  const paddingLeft = depth * 16 + 8;

  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    const trimmed = value.trim();
    if (!trimmed) {
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
      style={{ paddingLeft }}
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
        placeholder={pending.kind === 'folder' ? 'new-folder' : 'untitled'}
        className={cn(
          'min-w-0 flex-1 bg-transparent text-[13px] leading-none outline-none',
          'border border-[var(--cmd-palette-item-meta)] rounded-sm px-1 py-0.5',
          'text-sidebar-item-active-foreground placeholder:text-[var(--cmd-palette-item-meta)]',
        )}
      />
    </div>
  );
}
