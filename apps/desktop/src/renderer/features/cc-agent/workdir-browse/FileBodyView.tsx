/**
 * FileBodyView — middle pane of the workdir-browse view.
 *
 * Render dispatch:
 *   - empty (no selection)  → soft hint
 *   - text + markdown ext   → PlaintextEditor (source-preserving),打开即编辑,
 *                             避免 WYSIWYG round-trip 改写整份 md。
 *   - text + code ext       → 永远走 PlaintextEditor (CodeMirror code 主题)。
 *                             readOnly=!editMode 切预览/编辑。这样代码文件
 *                             的预览和编辑用同一引擎、同一 DOM、同一字体,
 *                             切换零跳变。语法高亮由 CodeMirror 的 Lezer +
 *                             codemirrorGithubTheme(对齐 hljs 颜色)提供。
 *   - text + plain          → preview: bare <pre> (no highlighting)
 *                             edit:    PlaintextEditor (CodeMirror plain 主题)
 *   - binary image          → ImagePreview
 *   - binary other          → UnrenderablePlaceholder
 *   - error                 → simple error card
 *
 * Edit mode:
 *   - code / text 文件:加载完成后**自动进入编辑态**,没有 Pencil/Check 按钮。
 *     dirty 时右上角浮一个 amber "未保存" chip;Ctrl/Cmd+S 直接写盘;右键弹
 *     菜单也只有"保存"一项。保存后留在编辑态(initialContentRef 同步成新内容)。
 *   - markdown 文件:打开后直接编辑源码,变更后 debounce 静默自动保存;
 *     Ctrl/Cmd+S 仍可立即写盘。
 *   外部 chokidar 改动同步:dirty=false 时允许把磁盘新内容推进编辑器;dirty=true
 *   时保留用户未保存的输入,等用户自己消化冲突(VSCode "file changed on disk"
 *   是更完善的方案,先按当前阶段处理)。
 *
 * Local Ctrl+F search:
 *   While this view is mounted, Ctrl/Cmd+F is captured at window level (in
 *   capture phase, with stopImmediatePropagation) so the global FindInPageBar
 *   never sees it for doc content. A floating DocSearchBar appears at top-
 *   right next to the edit button. Search backend is PlaintextEditor:
 *     - PlaintextEditor → editorRef.current.search
 *       (CodeMirror SearchCursor + StateField decoration)
 *   Esc closes; Enter / Shift+Enter walk forward / backward. State is
 *   cleared when switching files.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Save, Table2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fileBrowserApiFor } from '@/lib/fileBrowserTransport';

import { Spinner } from '@/components/ui/spinner';
import { acquireFindInPage } from '@/components/find-in-page/findInPageOwnership';
import { useAppShortcut } from '@/hooks/useAppShortcut';
import {
  PlaintextEditor,
  type PlaintextEditorHandle,
} from '@/components/markdown/PlaintextEditor';
import { MermaidLightboxHost } from '@/components/markdown/MermaidLightboxHost';
import { MermaidSourceEditorHost } from '@/components/markdown/MermaidSourceEditor';
import { MarkdownImageLightboxHost } from '@/components/markdown/MarkdownImageLightboxHost';
import { SelectionQuoteButton } from '@/components/chat/SelectionQuoteButton';
import { resolveLocalPath, toLocalFileUrl } from '@/lib/localPathResolver';
import { detectRenderable } from '@/lib/textPreview';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

import type { FileContent } from './hooks/useFileContent';
import { useDelayedFlag } from './hooks/useDelayedFlag';
import { DrawioPreview } from './DrawioPreview';
import { ImagePreview } from './ImagePreview';
import { PdfPreview } from './PdfPreview';
import { UnrenderablePlaceholder } from './UnrenderablePlaceholder';
import { DocSearchBar } from './DocSearchBar';
import { setActiveFileBodyHandle } from './lib/activeFileBodyHandle';
import { loadFileScroll, saveFileScroll } from './lib/fileScrollStore';
import { basename, formatBytes, formatMtime } from './lib/fileMeta';
import { OpenInSystemActions } from './OpenInSystemActions';
import { isDrawioPath } from './lib/drawioExt';
import { isImagePath } from './lib/imageExt';
import { isPdfPath } from './lib/pdfExt';
import { shouldConsumeStaleSearchJump } from './lib/fileSelectionParams';
import {
  createMarkdownAutosave,
  normalizeBaseline,
  type MarkdownAutosaveHandle,
} from './lib/markdownAutosave';

/**
 * 数 source text 中 `query`(case-insensitive) 在 `targetLine`(1-indexed) 之前
 * 出现了多少次。用作 project-search 跳转: 知道目标行后, 这个计数 = 在 in-file
 * 搜索结果列表里目标行第一个匹配的 0-based index(因为 in-file 搜索也是按
 * 文档顺序、case-insensitive 排出来的)。
 */
function countMatchesBeforeLine(content: string, query: string, targetLine: number): number {
  if (!query) return 0;
  const lines = content.split(/\r?\n/);
  const target = Math.min(Math.max(targetLine, 1), lines.length);
  const needle = query.toLowerCase();
  if (!needle) return 0;
  let count = 0;
  for (let i = 0; i < target - 1; i++) {
    const text = lines[i].toLowerCase();
    let pos = 0;
    while ((pos = text.indexOf(needle, pos)) !== -1) {
      count++;
      pos += needle.length;
    }
  }
  return count;
}

const MARKDOWN_AUTOSAVE_DELAY_MS = 900;
const CONTEXT_MENU_VIEWPORT_PADDING = 8;
const CONTEXT_MENU_ESTIMATED_WIDTH = 168;
const CONTEXT_MENU_ESTIMATED_HEIGHT = 40;

function getContextMenuPosition(x: number, y: number): { x: number; y: number } {
  const maxX = Math.max(
    CONTEXT_MENU_VIEWPORT_PADDING,
    window.innerWidth - CONTEXT_MENU_ESTIMATED_WIDTH - CONTEXT_MENU_VIEWPORT_PADDING,
  );
  const maxY = Math.max(
    CONTEXT_MENU_VIEWPORT_PADDING,
    window.innerHeight - CONTEXT_MENU_ESTIMATED_HEIGHT - CONTEXT_MENU_VIEWPORT_PADDING,
  );
  return {
    x: Math.min(Math.max(CONTEXT_MENU_VIEWPORT_PADDING, x), maxX),
    y: Math.min(Math.max(CONTEXT_MENU_VIEWPORT_PADDING, y), maxY),
  };
}

export interface FileBodyViewProps {
  workdir: string;
  /**
   * 非空 = SSH remote 会话:保存(writeFile)经 main 路由到远端 file-service;
   * 图片 / PDF 预览与"在系统中打开"依赖本机文件路径,remote 下降级为占位卡。
   */
  remoteHostId?: string | null;
  /** 非空 = device-link 远程会话:保存经隧道在被控端执行;预览降级同 SSH。 */
  deviceId?: string | null;
  /** 宿主会话 id:透传给图片 lightbox 启用"发送到对话"。 */
  sessionId?: string;
  /** the currently selected file's relPath, or null when nothing is open */
  relPath: string | null;
  content: FileContent;
  /** false = 只读预览,用于侧边栏拖入工程外文件等不应隐式写盘的入口。 */
  allowEdit?: boolean;
  /**
   * 保存成功后回调,把 disk 上的最新数据回传给父层 useFileContent.setLocal。
   * 同步推 cache + state,避免 refresh() 走 IPC 时闪一帧空白。
   */
  onSaved?: (data: {
    content: string;
    size: number;
    mtimeMs: number;
    truncated: boolean;
  }) => void;
  /**
   * 来自 URL ?search 参数 — workdir-browse 搜索面板里点命中行时,父组件把命中
   * query 传过来。本组件会在文件加载完毕后自动打开 in-file 搜索栏并把它当作
   * query,同时配合 jumpLine 把"最接近目标行的那一个匹配"设为 active。
   * 不再触发 jumpLine 行为靠 useEffect 的 dep 列表保证 — 同 (relPath, query, line)
   * 不会重复触发跳转。
   */
  jumpQuery?: string | null;
  /** 来自 URL ?line 参数 — 1-indexed 行号。 */
  jumpLine?: number | null;
  /** Project-search one-shot jump has been consumed; parent should clear URL params. */
  onSearchJumpConsumed?: () => void;
}

/**
 * 父组件可通过 ref 调的命令式接口。当前唯一调用方:WorkdirBrowseRoute 在
 * 关闭含未保存修改的 tab 前先 isDirty() 探测,需要保存就 save()(跳过组件
 * 内部的 "保存修改?" 二次确认 —— 调用方已经在自己的关闭确认里收过用户意图)。
 */
export interface FileBodyHandle {
  /** true = 当前可编辑内容相对原始内容已变化(LF 归一后比对)。 */
  isDirty(): boolean;
  /** 写入磁盘。无 dirty 时直接 resolve(true) 不做任何 IO。返回 false = 写入失败。 */
  save(): Promise<boolean>;
}

export const FileBodyView = forwardRef<FileBodyHandle, FileBodyViewProps>(function FileBodyView(
  {
    workdir,
    remoteHostId = null,
    deviceId = null,
    sessionId,
    relPath,
    content,
    onSaved,
    allowEdit = true,
    jumpQuery,
    jumpLine,
    onSearchJumpConsumed,
  },
  ref,
) {
  const { t } = useTranslation();
  // chat-text-quote:正文根容器 ref,SelectionQuoteButton 用它判定选区归属。
  // 必须在所有条件 return 之前声明(hooks 顺序不可变)。
  const bodyRootRef = useRef<HTMLDivElement>(null);
  // 正文 loading 延迟门控:本地 <30ms 保持空白,SSH / device-link 慢通道超过
  // 阈值后浮现 spinner(见 useDelayedFlag 注释)。
  const showContentSpinner = useDelayedFlag(content.kind === 'loading');
  // ── Edit state ──────────────────────────────────────────────────────────
  // 全部 per-file:relPath 变化时通过下方 effect 一次性清空,避免上一文件的 dirty
  // 错带到新文件里。
  const [editMode, setEditMode] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const editorRef = useRef<PlaintextEditorHandle>(null);
  const getSelectedSourceText = useCallback(
    () => editorRef.current?.getSelectionText() ?? null,
    [],
  );
  const getSelectedSourceLineRange = useCallback(
    () => editorRef.current?.getSelectionLineRange() ?? null,
    [],
  );
  // 用 ref 而不是 state 存 initial value:editor 内部是 uncontrolled 的,
  // 外部不需要为了对比而触发 re-render。
  const initialContentRef = useRef('');
  // initialContentRef 的 LF 归一化镜像:onChange 每键 dirty 判定只做一次
  // 原生 !==,归一化成本挪到基准写入时(setBaseline)一次性支付。
  const initialContentNormalizedRef = useRef('');
  const latestDiskContentRef = useRef('');

  /** dirty 比对基准的唯一写入口:同步维护原文与归一化两份。 */
  const setBaseline = useCallback((raw: string) => {
    initialContentRef.current = raw;
    initialContentNormalizedRef.current = normalizeBaseline(raw);
  }, []);

  // markdown 静默自动保存调度器。writeToDisk 是 useCallback、身份随 deps 变,
  // 经 ref 间接引用让调度器实例可以整个生命周期只建一次。
  const writeToDiskRef = useRef<((opts?: { silent?: boolean; guardExternalChange?: boolean }) => Promise<boolean>) | null>(null);
  const autosaveRef = useRef<MarkdownAutosaveHandle | null>(null);
  if (autosaveRef.current === null) {
    autosaveRef.current = createMarkdownAutosave({
      delayMs: MARKDOWN_AUTOSAVE_DELAY_MS,
      isSaving: () => savingRef.current,
      save: () => {
        void writeToDiskRef.current?.({ silent: true, guardExternalChange: true });
      },
    });
  }
  const autosave = autosaveRef.current;

  // ── Search state ────────────────────────────────────────────────────────
  // barVisible 控制 DocSearchBar 的可见性(Ctrl+F 用户开 / Esc 关)。
  // searchQuery 是真正驱动高亮的字段:运行器只看 query 是否非空,跟 bar 可见
  // 性解耦 —— 这样 project-search 跳转(URL ?search=) 可以无声高亮 + 跳行,
  // 不弹搜索栏。
  // matches 是 ref —— preview 模式存 <mark> 元素列表,edit 模式由
  // PlaintextEditor 内部存,这边只关心 total。
  const [barVisible, setBarVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchActive, setSearchActive] = useState(0);
  const [searchTotal, setSearchTotal] = useState(0);
  // CodeMirror 搜索不截断,当前永远 false。字段保留给 DocSearchBar 统一接口。
  const [searchTruncated, setSearchTruncated] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchRunRef = useRef<{ query: string; total: number } | null>(null);
  // Project-search 跳转去重 key — 见下方 "Project-search jump" 段落。
  // 放这里是为了在 relPath 变化的 reset effect 里能直接清零。
  const lastJumpKeyRef = useRef<string | null>(null);

  // ── Right-click context menu ────────────────────────────────────────────
  // 编辑态下接管右键。Markdown 只给"插入表格";代码/普通文本保留"保存"。
  // menuPos 是 fixed 菜单位置:null = 关。这里不用 Radix DropdownMenu:CodeMirror
  // 文档区有自己的滚动/定位上下文,虚拟 trigger 容易被浮层 collision 逻辑带偏。
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const menuInsertPointRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (menuPos === null) return;

    const closeMenu = () => {
      setMenuPos(null);
      menuInsertPointRef.current = null;
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };

    window.addEventListener('pointerdown', closeMenu);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', closeMenu);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuPos]);

  // ── Auto-enter-edit one-shot key ────────────────────────────────────────
  // 用来去重"自动进入编辑模式"effect:每个 relPath 只触发一次。否则后续
  // content 变化(外部 chokidar 同步)也会重新跑 effect,把 dirty/initialContentRef
  // 重置掉,丢用户已敲的字。relPath reset effect 里会清零。
  const lastInitRelPathRef = useRef<string | null>(null);

  useEffect(() => {
    setEditMode(false);
    setDirty(false);
    setSaving(false);
    setSaveError(null);
    autosave.cancel();
    // 切文件 → 关搜索栏、清掉所有残留高亮 / cached matches。
    setBarVisible(false);
    setSearchQuery('');
    setSearchActive(0);
    setSearchTotal(0);
    setSearchTruncated(false);
    editorRef.current?.search.clear();
    // 切文件时重置跳转去重 key —— 否则用户关了文件 tab 又点同样的命中行
    // 应该重新跳, 但 ref 还记着旧 key 会跳过。
    lastJumpKeyRef.current = null;
    // 关掉可能还开着的右键菜单 + 清自动进编辑 one-shot key,让新文件能再次
    // 触发自动进入编辑。
    setMenuPos(null);
    lastInitRelPathRef.current = null;
  }, [relPath, autosave]);

  const isText = content.kind === 'text';
  const isTruncated = content.kind === 'text' && content.truncated;
  // 可编辑条件:文本 + 未截断 + 有 relPath。Truncated 文件保存会把后半段截掉,
  // 直接禁掉编辑入口,避免数据丢失陷阱。
  const canEdit = allowEdit && relPath !== null && isText && !isTruncated;
  // markdown / 其它文本 / 代码文件都走"永远编辑态",
  // 省掉 Pencil/Check 按钮。
  // 这两个 flag 在多个 effect 和 render 分支里共用,统一在这里推一次。
  const isMarkdown =
    relPath !== null && detectRenderable(relPath).kind === 'markdown';
  const alwaysEdit = canEdit;

  useEffect(() => {
    return () => {
      autosave.cancel();
    };
  }, [autosave]);

  useEffect(() => {
    if (content.kind === 'text') {
      latestDiskContentRef.current = content.content;
    }
  }, [content]);

  // ── External-change sync (chokidar reload → CodeMirror) ─────────────────
  // useFileContent 收到 chokidar change 后会推新 content state, 但 CodeMirror /
  // textarea 是 uncontrolled 编辑器: initialValue 只在 mount 时取一次, 后续
  // content prop 变化不会自动同步进去 —— 体感就是 "agent 在 session 里改了
  // 当前打开的 .json/.ts 等代码文件, 中间预览区不刷新"。
  // 解法: 监听 content.content 变化, 调 editor.setValue() 把新内容推进去。
  // 守护:
  //   - dirty=true:用户有未保存改动 → 静默保留(不覆盖)。
  //   - alwaysEdit 模式下没 dirty → 同步刷, 跟之前 preview 模式行为一致。
  // 同步时把 initialContentRef 一起更新,这样下一次 setDirty 比对的基准也是
  // 磁盘最新内容,不会因为外部刷盘把当前空内容判成"改过"。
  useEffect(() => {
    if (dirty) return;
    if (editMode && !alwaysEdit) return;
    if (content.kind !== 'text') return;
    const editor = editorRef.current;
    if (!editor) return;
    // setValue 内部已经做了"相同则跳过"检查, 这里再做一次是为了避免
    // 不必要的整篇替换。Windows 文件常是 CRLF, CodeMirror 内部会按 LF
    // 表示文档;语义相同但行尾不同的时候不能 setValue,否则会重置 selection。
    // 但等价比较还是要做 —— 否则保存路径会走完整 diff:
    //   save → onSaved(setLocal) → state 变 → 这里 setValue → cm dispatch
    //   change event → onChange → setDirty(true) (但其实没改任何东西)。
    // 走 setValue 的同时, getValue 比对决定要不要真 dispatch。
    const normalize = (s: string) => s.replace(/\r\n/g, '\n');
    if (normalize(editor.getValue()) === normalize(content.content)) {
      setBaseline(content.content);
      return;
    }
    setBaseline(content.content);
    editor.setValue(content.content);
  }, [content, editMode, dirty, alwaysEdit, setBaseline]);

  // ── Auto-enter edit mode for non-markdown files ─────────────────────────
  // code/text 文件加载完成后自动进编辑态,免去用户额外进入编辑。
  // 用 lastInitRelPathRef 去重,保证每个 relPath 只触发一次:
  //   - 首次 content 到达时进编辑态,把 initialContentRef 锁成磁盘内容。
  //   - 之后外部 chokidar 改动让 content 再变,只走上面 sync effect,不重置
  //     dirty/editMode/initialContentRef 三件套(否则一边敲字一边外部 watcher
  //     又触发会丢字)。
  // markdown 也走这里,但不传 language,保持源码不被 markdown AST round-trip 改写。
  useEffect(() => {
    if (!alwaysEdit) return;
    if (content.kind !== 'text') return;
    if (lastInitRelPathRef.current === relPath) return;
    lastInitRelPathRef.current = relPath;
    setBaseline(content.content);
    setDirty(false);
    setEditMode(true);
  }, [alwaysEdit, content, relPath, setBaseline]);

  // 代码 / 编辑态走 PlaintextEditor — 它内部把 scrollTop 通过 onScroll 抛上来,
  // 这里同样落 store。relPath 为 null 不可能走到 editor 渲染分支(那时不
  // mount editor),保护性 guard 仅为类型收窄。
  const handleEditorScroll = useCallback(
    (top: number, line: number | null, offset: number | null) => {
      if (!relPath) return;
      saveFileScroll(workdir, relPath, { top, line, offset });
    },
    [workdir, relPath],
  );

  // writeToDisk —— 真正写文件的核心,不弹任何确认。被三条路径共用:
  //   1) Ctrl+S 或右键菜单"保存" → 直接调。
  //   2) 关 tab 时 ref.save() → 调用方已在关闭对话框里收到意图。
  // markdown / alwaysEdit 模式下保存成功都停留在当前编辑器里。
  // 写盘成功后同步推进 initialContentRef = next,这样下一次 setDirty 比对的基
  // 准就是磁盘最新内容 —— 用户继续敲字的 dirty 判定才正确。
  // 返回值:true = 已保存(或本来就无变化),false = IO 失败(setSaveError 已写)。
  const writeToDisk = useCallback(async (opts?: {
    silent?: boolean;
    guardExternalChange?: boolean;
  }): Promise<boolean> => {
    if (!allowEdit) return true;
    if (!relPath) return true;
    const editorValue = editorRef.current?.getValue();
    if (editorValue == null) return true;
    // textarea.value 按 HTML 规范会把行尾规范化成 LF,但磁盘原文在 Windows
    // 上常是 CRLF。两件事要分开处理:
    //   1) 脏判定 —— 两侧都归一到 LF 再比,避免"没改"被误判成"改了"。
    //   2) 写回磁盘 —— 如果原文是 CRLF,要把 editor 的 LF 还原回 CRLF,
    //      否则一次保存会把整个文件行尾静默换掉,git diff 会炸。
    const normalize = (s: string) => s.replace(/\r\n/g, '\n');
    const original = initialContentRef.current;
    if (normalize(editorValue) === normalize(original)) {
      // 无变化直接退出 —— 避免一次空写入触发 chokidar 反弹。
      setDirty(false);
      return true;
    }
    if (
      opts?.guardExternalChange &&
      normalize(latestDiskContentRef.current) !== normalize(original)
    ) {
      const msg = t('ccAgent.workdirBrowse.fileBody.externalChangeBlocked');
      setSaveError(msg);
      toast.error(t('ccAgent.workdirBrowse.fileBody.saveFailed', { message: msg }));
      return false;
    }
    const originalUsesCRLF = original.includes('\r\n');
    const next = originalUsesCRLF
      ? editorValue.replace(/\r?\n/g, '\r\n')
      : editorValue;
    setSaving(true);
    savingRef.current = true;
    setSaveError(null);
    try {
      const res = await fileBrowserApiFor(deviceId).writeFile({
        workdir,
        remoteHostId,
        relPath,
        content: next,
      });
      if (!res.ok) {
        setSaveError(res.message);
        // 写盘失败:toast 立即提示 + saveError banner 持续展示详情,两者互补
        // (toast 1.2s 自动消失,banner 留到下一次保存或切文件)。
        toast.error(t('ccAgent.workdirBrowse.fileBody.saveFailed', { message: res.message }));
        return false;
      }
      // 同步推进 baseline,后续 dirty 比对从磁盘最新内容算起。
      setBaseline(next);
      latestDiskContentRef.current = next;
      setDirty(false);
      // 把刚写到磁盘的内容直接回传给父层(走 setLocal 路径同步推 cache + state),
      // 不走 refresh() 触发的 cache miss + loading 中间态 → 没有空白闪帧。
      // canEdit 已经把 truncated 文件挡掉(见 canEdit = !isTruncated),所以
      // 走到这里的保存内容一定是完整文件,truncated 固定 false。
      onSaved?.({
        content: next,
        size: res.size,
        mtimeMs: res.mtimeMs,
        truncated: false,
      });
      if (!opts?.silent) {
        toast.success(t('ccAgent.workdirBrowse.fileBody.saved'));
      }
      return true;
    } catch (err) {
      const msg = String(err);
      setSaveError(msg);
      toast.error(t('ccAgent.workdirBrowse.fileBody.saveFailed', { message: msg }));
      return false;
    } finally {
      setSaving(false);
      savingRef.current = false;
    }
  }, [allowEdit, relPath, workdir, remoteHostId, deviceId, onSaved, t, setBaseline]);

  // autosave 调度器经 ref 取最新 writeToDisk(实例只建一次,身份不随 deps 漂)。
  useEffect(() => {
    writeToDiskRef.current = writeToDisk;
  }, [writeToDisk]);

  useImperativeHandle(
    ref,
    () => ({
      isDirty: () => allowEdit && editMode && dirty,
      save: () => (allowEdit ? writeToDisk() : Promise.resolve(true)),
    }),
    [allowEdit, editMode, dirty, writeToDisk],
  );

  // 同步把当前 FileBodyView 的 handle 注册到 module-level singleton,让
  // 同级的 WorkdirBrowseSidebar 在切文件前能跨组件读到 dirty 状态(详见
  // lib/activeFileBodyHandle.ts)。effect 的 deps 跟着 useImperativeHandle 走,
  // editMode/dirty 变化时刷新 store 引用。unmount 时清空。
  useEffect(() => {
    setActiveFileBodyHandle({
      isDirty: () => allowEdit && editMode && dirty,
      save: () => (allowEdit ? writeToDisk() : Promise.resolve(true)),
    });
    return () => setActiveFileBodyHandle(null);
  }, [allowEdit, editMode, dirty, writeToDisk]);

  // ── find-in-page / search-in-project capture ───────────────────────────
  // 组合键定义在 shared/appShortcuts registry (默认 Ctrl/Cmd+F 与
  // Ctrl/Cmd+Shift+F, 用户可改绑)。通过 findInPageOwnership 的引用计数告诉
  // App 根的 FindInPageBar:doc 模式接管 find-in-page,你别管。接管标志保证
  // FindInPageBar 不抢先开自己的搜索框;我们自己的 handler 负责真正打开
  // DocSearchBar。
  //
  // search-in-project → 转发到边栏全文搜索(VSCode 习惯)。仅 doc 模式生效:
  // 这个 handler 只在 FileBodyView 挂载期间存在,其它路由下完全不消费这个
  // 组合键。事件通过 window CustomEvent 派发给同路由下的 WorkdirBrowseSidebar,
  // 解耦两侧组件。
  useEffect(() => {
    const release = acquireFindInPage();
    return () => release();
  }, []);

  // Bail when an app-level mermaid source modal is open. The modal mounts
  // AFTER us so any capture listener it registers can't preempt our
  // `stopImmediatePropagation` by registration order. Without this gate,
  // Cmd+F in the modal textarea would steal focus to a DocSearchBar hidden
  // behind the modal — user types into an invisible input. See
  // markdown/MermaidSourceEditor.tsx where the flag is set.
  const mermaidModalOpen = (): boolean => document.body.dataset.mermaidEditorOpen === '1';

  useAppShortcut(
    'find-in-page',
    () => {
      if (mermaidModalOpen()) return false;
      setBarVisible(true);
      queueMicrotask(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
      return true;
    },
    { stopImmediate: true },
  );

  useAppShortcut(
    'search-in-project',
    () => {
      if (mermaidModalOpen()) return false;
      window.dispatchEvent(new CustomEvent('workdir-open-project-search'));
      return true;
    },
    { stopImmediate: true },
  );

  // ── save-file → 写盘 (默认 Ctrl/⌘+S) ────────────────────────────────────
  // capture + stopImmediatePropagation 的目的是吃掉浏览器默认 "保存网页" 弹窗
  // 和潜在的 menu accelerator。markdown 常驻编辑器;其它文件只有 editMode
  // 下才响应。mermaid modal gate 与查找快捷键同理:活跃 modal 拥有键盘域。
  useAppShortcut(
    'save-file',
    () => {
      if (mermaidModalOpen()) return false;
      if (!canEdit || !editMode) return false;
      // 已经在写盘就不再排队,避免并发 IPC writeFile / chokidar 反弹混乱。
      // 仍然消费事件, 压住浏览器默认"保存网页"弹窗。
      if (!saving) void writeToDisk();
      return true;
    },
    { stopImmediate: true },
  );

  // ── Search runner ───────────────────────────────────────────────────────
  // 一个统一的 effect 在 query / mode / content 变化时重跑搜索:
  //   走 PlaintextEditor → 调 editorRef.current.search.findAll
  //                       (CodeMirror SearchCursor + StateField decoration)
  useLayoutEffect(() => {
    const query = searchQuery;

    if (!query) {
      searchRunRef.current = null;
      setSearchTotal(0);
      setSearchActive(0);
      setSearchTruncated(false);
      editorRef.current?.search.clear();
      return;
    }

    const total = editorRef.current?.search.findAll(query) ?? 0;
    searchRunRef.current = { query, total };

    // initialActive 决定增量高亮"立即同步包哪一段" —— 大文档下,这是关键:
    //   - 普通输入:用上次的 searchActive(clamp 到新 total)。
    //   - project-search 跳转(URL ?search & ?line, 且本轮 jumpKey 还没消费过)
    //     :直接把 jumpLine 翻成 match index,让第一批 mark 就包在跳转目标周围。
    //     否则用户会看到"跳转到行号但目标 mark 还没生成、scrollIntoView 落空"
    //     的卡 1-2 帧的体验。
    let initialActive = total > 0 ? Math.min(searchActive, total - 1) : 0;
    if (
      total > 0 &&
      jumpQuery &&
      jumpQuery === query &&
      jumpLine != null &&
      content.kind === 'text'
    ) {
      const jumpKey = `${relPath}|${jumpQuery}|${jumpLine}`;
      if (lastJumpKeyRef.current !== jumpKey) {
        const idx = countMatchesBeforeLine(content.content, jumpQuery, jumpLine);
        initialActive = Math.min(idx, total - 1);
        // 这里不立刻消费 jumpKey —— 留给下面 jumpEffect 兜底(防止 runner 在
        // 某些 race 下没跑到 scroll 那段时, jumpEffect 还能补一次)。
      }
    }

    setSearchTotal(total);
    setSearchTruncated(false);
    setSearchActive(initialActive);
    if (total > 0) editorRef.current?.search.setActive(initialActive);
    // 注意:依赖里故意不带 searchActive —— active 切换走 navigate 函数,
    // 不需要重新扫描。content 变化(edit 模式下用户敲字)走 dirty 重 fetch,
    // 这里依赖 content 让搜索重新跑。jumpQuery/jumpLine/relPath 进 deps 是为了
    // 跳转目标变了能重新算 initialActive(同 query 不同 line 也要落到对的位置)。
    // barVisible 不在 deps 里 —— 高亮跟搜索栏可见性解耦。
  }, [searchQuery, content, jumpQuery, jumpLine, relPath]);

  // ── Search navigation (Enter / Shift+Enter / chevron buttons) ───────────
  const navigateSearch = useCallback(
    (delta: 1 | -1) => {
      if (searchTotal === 0) return;
      const next = (searchActive + delta + searchTotal) % searchTotal;
      setSearchActive(next);
      editorRef.current?.search.setActive(next);
    },
    [searchActive, searchTotal],
  );

  const closeSearch = useCallback(() => {
    setBarVisible(false);
    setSearchQuery('');
    setSearchActive(0);
    setSearchTotal(0);
    setSearchTruncated(false);
    editorRef.current?.search.clear();
  }, []);

  // ── Esc → 关 DocSearchBar (只在 barVisible 时挂) ─────────────────────────
  // 优先级:Esc 先关 DocSearchBar,后让 sidebar 处理 (mode: search → tree)。
  // 只在 barVisible 时注册,关闭后 effect cleanup 自动摘掉,Esc 才会
  // 落到 sidebar 那边的 listener。capture + stopImmediatePropagation 兜
  // 底:不管 sidebar / 其它 component 的 Esc 监听是否注册顺序在前,都先
  // 我们这一票。
  // DocSearchBar 自己 input 上也有 Esc onKeyDown,window capture stopProp
  // 之后 input 那条不会再 fire,功能上等价,留着是为了焦点不在 input 时
  // (用户点了文档内容然后按 Esc) 也能关。
  // 注:这块 effect 必须放在 closeSearch (useCallback) 之后 —— deps 数组
  // 在 render 时同步求值,放前面会撞 const 的 temporal dead zone。
  useEffect(() => {
    if (!barVisible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      closeSearch();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [barVisible, closeSearch]);

  // ── Project-search jump (URL ?search&line) ─────────────────────────────
  // 父组件从 workdir-browse 的搜索面板里点命中行 → URL 带上 ?search & ?line。
  // **不打开搜索栏** — 只设 searchQuery 让 runner 高亮匹配, 然后跳到目标行。
  // 用户视觉上只看到"打开了文件 + 滚到行 + 命中片段高亮", 不会被搜索栏弹出
  // 打扰(用户反馈"怎么文件内的搜索框也会被打开")。
  //
  // 单一 effect 里完成两件事:
  //  1. setSearchQuery(jumpQuery) — 上面那条 useLayoutEffect runner 会跑一遍
  //     把 marks 包好、searchTotal 设好, 然后本 effect 因 searchTotal 变了再
  //     被触发。
  //  2. query 已扫描完成但没有匹配 → 视为 stale jump,消费 URL 参数。
  //  3. searchTotal > 0 且 (relPath|jumpQuery|jumpLine) 还没消费过时, 算出
  //     jumpLine 对应的 match index → setActive + scrollIntoView。
  //
  // lastJumpKeyRef 一次性 key 防止 setSearchActive 自己又触发本 effect 死循环;
  // 同 key 第二次进来直接 return。同文件不同行 jumpKey 不一样, 仍会跳新位置。
  // (lastJumpKeyRef 在上面 ref 区域已声明, 因为 relPath reset effect 也需要清它)
  useEffect(() => {
    if (!relPath || content.kind !== 'text' || !jumpQuery) return;
    const jumpKey = `${relPath}|${jumpQuery}|${jumpLine ?? ''}`;
    if (lastJumpKeyRef.current === jumpKey) return;

    // 阶段 1: 把 query 灌进去, 等 runner 跑完。setSearchQuery 同值是 no-op
    // (React 优化), 只在真不同时才 setState。
    if (searchQuery !== jumpQuery) {
      setSearchQuery(jumpQuery);
      // 这里不消费 key — 等 runner 跑完 + searchTotal 出来下一轮 effect 跳。
      return;
    }
    // 阶段 2: query 已灌好, 等 runner 扫完。若扫描完成但 0 match,说明
    // project-search result 已过期;同样消费 one-shot URL 参数,让后续 remount
    // 能恢复 saved reading position。
    const lastRun = searchRunRef.current;
    if (!lastRun || lastRun.query !== jumpQuery) return;
    if (shouldConsumeStaleSearchJump(lastRun, jumpQuery)) {
      lastJumpKeyRef.current = jumpKey;
      onSearchJumpConsumed?.();
      return;
    }

    const targetLine = jumpLine ?? null;
    const idx =
      targetLine !== null
        ? countMatchesBeforeLine(content.content, jumpQuery, targetLine)
        : 0;
    const active = Math.min(idx, lastRun.total - 1);
    setSearchActive(active);
    editorRef.current?.search.setActive(active);
    lastJumpKeyRef.current = jumpKey;
    onSearchJumpConsumed?.();
  }, [
    relPath,
    jumpQuery,
    jumpLine,
    content,
    searchQuery,
    searchTotal,
    onSearchJumpConsumed,
  ]);

  // ── Non-text render branches (early returns; no edit affordance) ────────
  if (!relPath || content.kind === 'empty') {
    return (
      <div className="flex h-full w-full items-center justify-center px-8 text-13 text-[var(--cmd-palette-item-meta)]">
        {t('ccAgent.workdirBrowse.fileBody.selectFile')}
      </div>
    );
  }

  if (content.kind === 'loading') {
    // 本地读文件 <30ms,门控内保持空白(规则 7);远程慢通道超过阈值后浮现
    // spinner,避免正文长空白像"点了没反应"。
    return (
      <div className="flex h-full w-full items-center justify-center">
        {showContentSpinner && (
          <Spinner size={16} className="text-[var(--cmd-palette-item-meta)]" />
        )}
      </div>
    );
  }

  if (content.kind === 'error') {
    // [CODE] 是 IPC 错误协议(规则 13):按码映射友好文案,原始信息进 title
    // 供排查,不再对用户裸显技术串。
    const code = /\[([A-Z0-9_]+)\]/.exec(content.message)?.[1];
    const friendly =
      code === 'DEVICE_LINK_NOT_CONNECTED' || code === 'DEVICE_LINK_DEVICE_OFFLINE'
        ? t('ccAgent.workdirBrowse.fileBody.readErrorOffline')
        : code === 'REMOTE_FS_UNAVAILABLE'
          ? t('ccAgent.workdirBrowse.fileBody.readErrorRemoteFsUnavailable')
          : null;
    return (
      <div
        className="flex h-full w-full items-center justify-center px-8 text-center text-13 text-[var(--cmd-palette-item-meta)]"
        title={content.message}
      >
        {friendly ?? t('ccAgent.workdirBrowse.fileBody.readFailed', { message: content.message })}
      </div>
    );
  }

  if (content.kind === 'fetching') {
    return (
      <FetchingProgress received={content.received} total={content.total} phase={content.phase} />
    );
  }

  if (content.kind === 'cached') {
    // 大文件已取回本地:能预览就应用内预览(文本读缓存、图片/PDF 指向缓存
    // 副本),不能预览(超显示上限/二进制)落占位卡 + 系统打开。
    return (
      <CachedFileView
        workdir={workdir}
        stat={content.stat}
        cachePath={content.cachePath}
        stale={content.stale === true}
      />
    );
  }

  if (content.kind === 'oversize') {
    // 远程文本文件超帧限(device-link OVERSIZE):专属"文件过大"文案的占位卡。
    return (
      <UnrenderablePlaceholder
        workdir={workdir}
        relPath={content.stat.relPath}
        size={content.stat.size}
        mtimeMs={content.stat.mtimeMs}
        remote
        oversize
      />
    );
  }

  if (content.kind === 'binary') {
    if (remoteHostId || deviceId) {
      // remote:ImagePreview / PdfPreview 靠 xdt-file:// 读本机路径,远端文件读
      // 不到;统一走占位卡(P4 计划经 file-service 拉字节落本地缓存后解禁)。
      return (
        <UnrenderablePlaceholder
          workdir={workdir}
          relPath={content.stat.relPath}
          size={content.stat.size}
          mtimeMs={content.stat.mtimeMs}
          remote
        />
      );
    }
    if (isImagePath(content.stat.relPath)) {
      return (
        <ImagePreview
          workdir={workdir}
          relPath={content.stat.relPath}
          size={content.stat.size}
          mtimeMs={content.stat.mtimeMs}
          sessionId={sessionId}
        />
      );
    }

    if (isPdfPath(content.stat.relPath)) {
      return (
        <PdfPreview
          workdir={workdir}
          relPath={content.stat.relPath}
          size={content.stat.size}
          mtimeMs={content.stat.mtimeMs}
        />
      );
    }

    // .drawio 在 binary 分支不处理 —— 它本质是 XML 文本, useFileContent 永远
    // 走 text 分支(没 NULL 字节);理论上加密 drawio 才会进 binary, 极罕见,
    // 退回 UnrenderablePlaceholder 即可。

    return (
      <UnrenderablePlaceholder
        workdir={workdir}
        relPath={content.stat.relPath}
        size={content.stat.size}
        mtimeMs={content.stat.mtimeMs}
      />
    );
  }

  // .drawio 实际是 XML 文本, useFileContent 会读成 text 分支(没 NULL 字节)。
  // 用户期望是图形预览, 不是 raw XML, 所以在进入 PlaintextEditor / markdown
  // 之前先截走交给 DrawioPreview。把 content.content 直接作为 xmlContent 传过去,
  // DrawioPreview 不需要再走 fetch(xdt-file://...) —— 该协议 corsEnabled=false,
  // fetch API 会被跨源拦掉。
  if (isDrawioPath(relPath)) {
    return (
      <DrawioPreview
        workdir={workdir}
        relPath={relPath}
        xmlContent={content.content}
        size={content.size}
        mtimeMs={content.mtimeMs}
      />
    );
  }

  // ── Text branch ─────────────────────────────────────────────────────────
  const renderable = detectRenderable(relPath);
  // Markdown live-preview 图片的相对路径基准 = 被预览文件自己的父目录(不是
  // workdir 根):`docs/readme.md` 里的 `![](./img/a.png)` 必须解析到
  // `<workdir>/docs/img/a.png`。纯字符串推导,镜像 TextLightbox 的
  // fileParentDir 逻辑,无需 IPC。
  const imageBaseDir = (() => {
    if (!relPath || renderable.kind !== 'markdown') return undefined;
    // 远程会话(SSH / device-link):workdir 是远端绝对路径,按它拼出来的
    // xdt-file:// 指向控制端本地文件系统——路径恰好存在时会渲染出错误的
    // 本地媒体。禁用行内图片解析(图片位保持占位),远程图片经取回管线
    // 内联预览属后续任务。
    if (remoteHostId || deviceId) return undefined;
    const abs = resolveLocalPath(relPath, workdir);
    const idx = Math.max(abs.lastIndexOf('/'), abs.lastIndexOf('\\'));
    if (idx < 0) return workdir;
    // POSIX 根目录:'/x.md' → 保留 '/',否则丢根变相对路径。
    if (idx === 0) return abs.startsWith('/') ? '/' : abs.slice(0, 1);
    return abs.slice(0, idx);
  })();
  // Project-search jumps (?search=&line=) are one-shot navigation commands.
  // They must win over the saved reading position, otherwise the editor's
  // scheduled restore frames can pull the viewport back after search.setActive()
  // scrolls the match into view.
  const hasSearchJump = Boolean(jumpQuery && jumpLine !== null);
  const scrollAnchor = relPath && !hasSearchJump ? loadFileScroll(workdir, relPath) : null;

  // 所有 text 文件都由 PlaintextEditor 承载:
  //   - code: CodeMirror 代码主题 + 行号 + 语法高亮。
  //   - markdown: CodeMirror markdown live-preview 主题,源码保持型编辑。
  //   - text: plain 主题。
  // 这样不再保留 MarkdownRenderer / DOM-walk 搜索 / heading folding 旧预览
  // 分支,避免维护一个在 alwaysEdit 模式下不可达的 fallback。
  //
  // PlaintextEditor 容器:CodeMirror 自己处理滚动,所以外层不需要 overflow-y-auto。
  // 关键:外层 **不加 max-w/px-**,让 .cm-scroller 拉满到 FileBodyView 的右
  // 边缘 —— 否则垂直滚动条会跟着 max-w 容器一起被推进 30px,看起来浮在内容
  // 中间。左右留白由 .cm-content 的 padding 接管(见 codemirrorGithubTheme:
  // code 主题给 30px,plain 主题给 40px = px-10),markdown 编辑/普通文本编辑
  // /代码编辑 三种都不会缺左右内边距。
  const editContainerCls = 'w-full flex-1 min-h-0 flex flex-col';

  return (
    <div ref={bodyRootRef} className="relative flex h-full w-full min-h-0 flex-col">
      {/* chat-text-quote:文件正文里选中文字 → "添加到对话"浮动按钮,复用聊天
          流同款交互;引用携带当前文件相对路径(— source: 行),模型可据此
          Read 上下文 / 精准编辑。无会话上下文(独立场景)时不挂。 */}
      {sessionId && relPath ? (
        <SelectionQuoteButton
          sessionId={sessionId}
          containerRef={bodyRootRef}
          sourcePath={relPath}
          getQuoteText={getSelectedSourceText}
          getQuoteMetadata={getSelectedSourceLineRange}
        />
      ) : null}
      {/* Listens for clicks on rendered mermaid widgets and opens the
          lightbox modal. Bridges the vanilla-DOM CodeMirror widget to the
          React MermaidLightbox without coupling them. */}
      <MermaidLightboxHost />
      {/* Listens for the "edit source" toolbar button and opens a textarea
          modal so users can fix mermaid syntax without losing the always-edit
          markdown surface (the block widget would otherwise hide the source). */}
      <MermaidSourceEditorHost />
      {/* Same event-bridge pattern for rendered markdown images → full-screen
          ImageLightbox on click. */}
      <MarkdownImageLightboxHost sessionId={sessionId} />
      {/* 右上角浮动操作区。
          - markdown:没有切换按钮和未保存 chip,变更后静默自动保存。
          - alwaysEdit (code/text):没有按钮,只在 dirty 时挂 amber "未保存" chip。
            保存通过 Ctrl+S 或右键菜单,UI 更干净。
          z-10 确保浮在内容上。 */}
      <div className="absolute right-[18px] top-[14px] z-10 flex items-center gap-2">
        {!barVisible && canEdit && !isMarkdown && (alwaysEdit ? dirty || saving : editMode) && (
          <EditingChip dirty={dirty} compact={alwaysEdit} saving={saving} />
        )}
        {barVisible ? (
          <DocSearchBar
            ref={searchInputRef}
            query={searchQuery}
            total={searchTotal}
            activeIndex={searchActive}
            truncated={searchTruncated}
            onChange={(q) => {
              setSearchQuery(q);
              setSearchActive(0); // 新 query → 复位到第 1 个匹配
            }}
            onNext={() => navigateSearch(1)}
            onPrev={() => navigateSearch(-1)}
            onClose={closeSearch}
          />
        ) : null}
      </div>

      {/* 保存错误 toast —— 出现在按钮组下方,主动重试或切文件后清掉。 */}
      {saveError && (
        <div
          role="alert"
          className={cn(
            'absolute right-[18px] top-[54px] z-10 max-w-[360px]',
            'rounded-md border px-3 py-1.5 text-12',
            'border-red-300/70 bg-red-50/95 text-red-700',
            'dark:border-red-800/60 dark:bg-red-950/80 dark:text-red-300',
            'shadow-sm',
          )}
        >
          {t('ccAgent.workdirBrowse.fileBody.saveFailed', { message: saveError })}
        </div>
      )}

      {
        // PlaintextEditor 路径:
        //   - 编辑模式(任意文件):同一套 CodeMirror,代码走 code 主题、
        //                        markdown 走 markdown live-preview 主题、
        //                        text 走 plain 主题。
        //   - 不可编辑文本(如截断文件):readOnly=true,仍然走同一引擎。
        // key 只包含 relPath —— editMode 切换走 PlaintextEditor 内部的 readOnly
        // Compartment reconfigure,不重建 EditorView,这样代码文件 preview↔edit
        // 时 scrollTop 不会被重置回顶部(用户拖到下面点编辑会"跳回顶上"的回归)。
        // initialValue:编辑模式取 initialContentRef.current(enterEdit 时的快
        // 照,作为 dirty 比对基准);预览模式取 content.content(磁盘最新)。
        // 注意:不 remount 时 initialValue 只在首次 mount 生效 —— 这正是想要
        // 的:用户编辑期间外部 onSaved 回调触发 content 刷新不会把编辑器内容
        // 冲掉。文件切换(relPath 变)时 key 变化仍会 remount,无影响。
        <div className="flex min-h-0 flex-1 flex-col">
          {content.truncated && (
            // editContainerCls 现在不带 px(为了让 cm-scroller 拉满到右边沿),
            // 这里 banner 自己补 px-[30px] 让左右内边距和 .cm-content 对齐。
            <div className="flex-none px-[30px] py-3">
              <div
                className={cn(
                  'rounded-lg border px-3 py-2 text-xs',
                  'border-[var(--cmd-palette-border)] bg-[var(--chat-input-chip-bg)] text-[var(--settings-section-desc)]',
                )}
              >
                {t('ccAgent.workdirBrowse.fileBody.truncatedNotice')}
              </div>
            </div>
          )}
          <div
            className={editContainerCls}
            onContextMenu={(e) => {
              // 表格 widget 有自己的结构操作菜单;其它 Markdown 区域继续给
              // 文档级"插入表格",非 Markdown 给"保存"。
              if (!canEdit || !editMode) return;
              const target = e.target;
              if (
                target instanceof HTMLElement &&
                target.closest('.cm-md-table-widget')
              ) {
                return;
              }
              e.preventDefault();
              menuInsertPointRef.current = { x: e.clientX, y: e.clientY };
              setMenuPos(getContextMenuPosition(e.clientX, e.clientY));
            }}
          >
            <PlaintextEditor
              ref={editorRef}
              key={relPath}
              initialValue={editMode ? initialContentRef.current : content.content}
              language={
                renderable.kind === 'code'
                  ? renderable.lang
                  : renderable.kind === 'markdown'
                    ? 'markdown'
                    : undefined
              }
              readOnly={!editMode}
              initialScrollTop={scrollAnchor?.top}
              initialScrollLine={scrollAnchor?.line}
              initialScrollOffset={scrollAnchor?.offset}
              imageBaseDir={imageBaseDir}
              onScroll={handleEditorScroll}
              onChange={
                editMode
                  ? (val) => {
                      // val 来自 CodeMirror,行尾恒为 LF;基准的归一化在
                      // setBaseline 时一次性完成,这里每键只付一次原生比较。
                      const hasChange = val !== initialContentNormalizedRef.current;
                      setDirty(hasChange);
                      if (isMarkdown) {
                        if (hasChange) autosave.schedule();
                        else autosave.cancel();
                      }
                    }
                  : undefined
              }
            />
          </div>
        </div>
      }

      {/* 右键菜单(编辑态触发 → 直接锚到鼠标 client 坐标)。
          Markdown 文档只放插入类动作; 代码 / 普通文本保留保存入口。 */}
      {menuPos !== null &&
        createPortal(
          <div
            role="menu"
            aria-orientation="vertical"
            onPointerDown={(e) => e.stopPropagation()}
            className={cn(
              'fixed z-[9999] w-[168px] rounded-xl p-0.5 overflow-hidden',
              'bg-[var(--cmd-palette-bg)]',
              'border border-[var(--cmd-palette-border)]',
              'shadow-[var(--shadow-menu)]',
            )}
            style={{ left: menuPos.x, top: menuPos.y }}
          >
            {isMarkdown && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const pos = menuInsertPointRef.current;
                  setMenuPos(null);
                  menuInsertPointRef.current = null;
                  editorRef.current?.insertMarkdownTableAt(
                    pos ? { x: pos.x, y: pos.y } : undefined,
                  );
                }}
                className={cn(
                  'flex h-7 w-full items-center rounded-md px-2.5 text-left',
                  'text-13 leading-none text-[var(--msg-assistant-text)]',
                  'hover:bg-[var(--cmd-palette-item-hover)] focus:bg-[var(--cmd-palette-item-hover)] focus:outline-none',
                )}
              >
                <Table2 className="mr-2 h-3.5 w-3.5 shrink-0" />
                <span className="relative top-px">
                  {t('ccAgent.workdirBrowse.fileBody.menuInsertTable')}
                </span>
              </button>
            )}
            {!isMarkdown && (
              <button
                type="button"
                role="menuitem"
                disabled={saving || !dirty}
                onClick={() => {
                  setMenuPos(null);
                  menuInsertPointRef.current = null;
                  void writeToDisk();
                }}
                className={cn(
                  'flex h-7 w-full items-center rounded-md px-2.5 text-left',
                  'text-13 leading-none text-[var(--msg-assistant-text)]',
                  'hover:bg-[var(--cmd-palette-item-hover)] focus:bg-[var(--cmd-palette-item-hover)] focus:outline-none',
                  'disabled:pointer-events-none disabled:opacity-45',
                )}
              >
                <Save className="mr-2 h-3.5 w-3.5 shrink-0" />
                <span className="relative top-px">{t('ccAgent.workdirBrowse.fileBody.menuSave')}</span>
                <span className="ml-auto pl-4 text-11 text-[var(--cmd-palette-item-meta)]">
                  {window.electronAPI?.platform === 'darwin' ? '⌘S' : 'Ctrl+S'}
                </span>
              </button>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
});

/**
 * 编辑中常驻 chip —— 右上角浮动,保存按钮左侧。视觉:浅底色胶囊 + 呼吸圆点 +
 * 文案。dirty 时圆点和文案换成"未保存"+ 琥珀色,提示用户有未提交的改动。
 *
 * compact 模式(alwaysEdit 文件):只在 dirty 时被渲染(父层判定),文案精简成
 * "未保存"。常态没有"编辑中"提示,因为永远在编辑中,提示反而冗余。
 *
 * 非 compact 模式(markdown 编辑态):dirty=false 显示灰底"编辑中",dirty=true
 * 显示 amber"编辑中 · 未保存",作为 preview/edit 双态的可视区分。
 *
 * 点 chip 没有副作用(只是状态指示),所以是 div 不是 button —— 避免误触。
 */
function EditingChip({
  dirty,
  compact = false,
  saving = false,
}: {
  dirty: boolean;
  compact?: boolean;
  saving?: boolean;
}) {
  const { t } = useTranslation();
  // 保存中指示同样延迟门控:本地写盘 <50ms,闪一帧"保存中"反而像抖动;
  // 远程慢通道超过阈值后才切换文案 + 转圈(见 useDelayedFlag 注释)。
  const showSaving = useDelayedFlag(saving);
  // compact 模式只在 dirty/saving 时被渲染 (上游 gate);保存中用中性灰
  // (amber 语义是"有未提交改动"的警示,保存中不是警示态)。
  const showAmber = (compact || dirty) && !showSaving;
  const text = showSaving
    ? t('ccAgent.workdirBrowse.fileBody.chip.saving')
    : compact
      ? t('ccAgent.workdirBrowse.fileBody.chip.unsaved')
      : dirty
        ? t('ccAgent.workdirBrowse.fileBody.chip.editingUnsaved')
        : t('ccAgent.workdirBrowse.fileBody.chip.editing');
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 h-7 text-12 font-medium',
        'shadow-sm backdrop-blur',
        showAmber
          ? cn(
              'border-amber-300/70 bg-amber-50/95 text-amber-800',
              'dark:border-amber-700/60 dark:bg-amber-950/80 dark:text-amber-200',
            )
          : cn(
              'border-[var(--cmd-palette-border)] bg-white/85 text-[var(--settings-section-desc)]',
              'dark:bg-[#1f1f1e]/85',
            ),
      )}
    >
      {showSaving ? (
        <Spinner size={10} />
      ) : (
        <span
          aria-hidden
          className={cn(
            'inline-block size-1.5 rounded-full',
            showAmber ? 'bg-amber-500 animate-pulse' : 'bg-[#22863a] animate-pulse',
          )}
        />
      )}
      {text}
    </div>
  );
}


/**
 * CachedFileView — 大文件缓存副本的应用内预览。
 *  - 图片/PDF:把缓存目录当 workdir 喂给既有预览组件(它们只是 join 出本地
 *    绝对路径再走 xdt-file://,缓存副本就是本地文件,零改动复用)。
 *  - 文本:READ_CACHED 读缓存(32MB 显示上限,二进制探测),只读 <pre> 呈现。
 *  - 其余 / 读取失败:占位卡 + 「在系统中打开」指向缓存副本。
 */
function CachedFileView({
  workdir,
  stat,
  cachePath,
  stale,
}: {
  workdir: string;
  stat: { relPath: string; size: number; mtimeMs: number };
  cachePath: string;
  /** true = 实时取回失败后回落的历史副本(可能非远端最新),顶部标注提示。 */
  stale?: boolean;
}) {
  const { t } = useTranslation();
  const body = <CachedFileBody workdir={workdir} stat={stat} cachePath={cachePath} />;
  if (!stale) return body;
  // stale 副本:顶部一条 amber 标注(配色沿用本文件 EditingChip 的 warning
  // amber 系,语义豁免色),正文照常预览。
  return (
    <div className="flex h-full w-full flex-col">
      <div
        className={cn(
          'shrink-0 border-b px-4 py-1.5 text-center text-12',
          'border-amber-200/60 bg-amber-50/80 text-amber-800',
          'dark:border-amber-800/50 dark:bg-amber-950/60 dark:text-amber-200',
        )}
      >
        {t('ccAgent.workdirBrowse.fileBody.cachedStaleNotice')}
      </div>
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
}

/** CachedFileView 的正文体:按类型分派预览(文本/图片/PDF/视频/占位卡)。 */
function CachedFileBody({
  workdir,
  stat,
  cachePath,
}: {
  workdir: string;
  stat: { relPath: string; size: number; mtimeMs: number };
  cachePath: string;
}) {
  const sep = Math.max(cachePath.lastIndexOf('/'), cachePath.lastIndexOf('\\'));
  const cacheDir = cachePath.slice(0, sep);
  const cacheBase = cachePath.slice(sep + 1);
  const { t } = useTranslation();
  const [text, setText] = useState<string | null>(null);
  /** 缓存副本超 READ_CACHED 32MB 显示上限被截断:顶部提示,别让局部当全量。 */
  const [textTruncated, setTextTruncated] = useState(false);
  const [probed, setProbed] = useState(false);
  // 容器被协议放行但轨道编码 Chromium 不支持(典型:HEVC .mov)→ <video>
  // onError,回落占位卡走系统播放器。
  const [videoFailed, setVideoFailed] = useState(false);
  const isImg = isImagePath(stat.relPath);
  const isPdf = isPdfPath(stat.relPath);
  // Chromium 可原生播放的视频容器;其余视频格式落占位卡走系统播放器。
  const isVideo = /\.(mp4|m4v|mov|webm)$/i.test(stat.relPath);
  // 载入缓存副本(读盘 + IPC + 首次渲染)对 30MB 级文本是秒级的,同样走
  // 延迟门控 loading:小文件保持空白零跳变,大文件超阈值后浮现 spinner。
  const showLoading = useDelayedFlag(!probed && !isImg && !isPdf);

  useEffect(() => {
    setText(null);
    setTextTruncated(false);
    setProbed(false);
    setVideoFailed(false);
    if (isImg || isPdf || isVideo) return;
    let cancelled = false;
    void window.electronAPI.fileBrowser.readCached({ cachePath }).then((res) => {
      if (cancelled) return;
      if (res.ok && res.kind === 'text') {
        setText(res.content);
        setTextTruncated(res.truncated === true);
      }
      setProbed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [cachePath, isImg, isPdf, isVideo]);

  if (isImg) {
    return <ImagePreview workdir={cacheDir} relPath={cacheBase} size={stat.size} mtimeMs={stat.mtimeMs} />;
  }
  if (isPdf) {
    return <PdfPreview workdir={cacheDir} relPath={cacheBase} size={stat.size} mtimeMs={stat.mtimeMs} />;
  }
  if (isVideo) {
    if (videoFailed) {
      return (
        <UnrenderablePlaceholder
          workdir={workdir}
          relPath={stat.relPath}
          size={stat.size}
          mtimeMs={stat.mtimeMs}
          remote
          localCopyPath={cachePath}
        />
      );
    }
    // 布局对齐 ImagePreview:播放器 flex-1 自适应,元信息 + 系统打开按钮
    // shrink-0 固定(min-h-0 + overflow-hidden 防大视频撑破 flex 边界)。
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-8 py-6">
        <div className="flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden">
          {/* 缓存副本是本地文件,xdt-file:// range 流式,2GB 也可拖进度条 */}
          <video
            controls
            className="min-h-0 min-w-0 max-h-full max-w-full rounded-lg bg-black"
            src={toLocalFileUrl(cachePath)}
            onError={() => setVideoFailed(true)}
          />
        </div>
        <div className="shrink-0 text-xs text-[var(--cmd-palette-item-meta)]">
          {basename(stat.relPath)}
          {stat.size > 0 && (
            <>
              {' · '}
              {formatBytes(stat.size)}
              {' · '}
              {t('ccAgent.workdirBrowse.unrenderable.modifiedAt', { time: formatMtime(stat.mtimeMs) })}
            </>
          )}
        </div>
        <OpenInSystemActions absPath={cachePath} folderPath={cacheDir} className="shrink-0" />
      </div>
    );
  }
  if (text !== null) {
    return (
      <div className="h-full w-full overflow-auto">
        {textTruncated && (
          <div className="px-6 pt-4">
            <div
              className={cn(
                'rounded-lg border px-3 py-2 text-xs',
                'border-[var(--cmd-palette-border)] bg-[var(--chat-input-chip-bg)] text-[var(--settings-section-desc)]',
              )}
            >
              {t('ccAgent.workdirBrowse.fileBody.cachedTruncatedNotice')}
            </div>
          </div>
        )}
        <pre className="whitespace-pre-wrap break-words px-6 py-4 font-mono text-12 leading-relaxed text-foreground">
          {text}
        </pre>
      </div>
    );
  }
  if (!probed) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        {showLoading && (
          <Spinner size={16} className="text-[var(--cmd-palette-item-meta)]" />
        )}
      </div>
    );
  }
  return (
    <UnrenderablePlaceholder
      workdir={workdir}
      relPath={stat.relPath}
      size={stat.size}
      mtimeMs={stat.mtimeMs}
      remote
      localCopyPath={cachePath}
    />
  );
}


/**
 * FetchingProgress — 大文件取回进度:分相文案(远端上传 / 下载)+ 百分比 +
 * 字节 + 实时速度。速度按 ≥800ms 采样窗口差分,EMA 平滑;换相时清零重测。
 */
function FetchingProgress({
  received,
  total,
  phase,
}: {
  received: number;
  total: number;
  phase?: 'upload' | 'download';
}) {
  const { t } = useTranslation();
  const sample = useRef<{ t: number; bytes: number; speed: number; phase?: string }>({
    t: 0,
    bytes: 0,
    speed: 0,
    phase: undefined,
  });
  const now = performance.now();
  const st = sample.current;
  if (st.phase !== phase) {
    st.phase = phase;
    st.t = now;
    st.bytes = received;
    st.speed = 0;
  } else if (now - st.t >= 800) {
    const inst = Math.max(0, received - st.bytes) / ((now - st.t) / 1000);
    st.speed = st.speed > 0 ? st.speed * 0.6 + inst * 0.4 : inst;
    st.t = now;
    st.bytes = received;
  }
  const pct = total > 0 ? Math.floor((received / total) * 100) : 0;
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3">
      <Spinner size={18} className="text-[var(--cmd-palette-item-meta)]" />
      <span className="text-13 text-[var(--cmd-palette-item-meta)]">
        {t(
          phase === 'upload'
            ? 'ccAgent.workdirBrowse.fileBody.fetchingRemoteUpload'
            : 'ccAgent.workdirBrowse.fileBody.fetchingRemote',
          {
            percent: pct,
            received: formatBytes(received),
            total: formatBytes(total),
            speed: st.speed > 0 ? `${formatBytes(st.speed)}/s` : '—',
          },
        )}
      </span>
    </div>
  );
}
