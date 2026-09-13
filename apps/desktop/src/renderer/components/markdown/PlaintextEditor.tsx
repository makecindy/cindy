/**
 * PlaintextEditor — 统一 CodeMirror 6 编辑器,按调用方意图切三种视觉 chrome:
 *
 *   1. Code 主题(传了非 markdown 的 `language`)— JetBrains Mono 14/1.5,
 *      挂行号。能识别 parser 时再挂 langExtension、syntaxHighlighting,跟
 *      chat 里 highlight.js 颜色 1:1。用于 .py / .json / .ts / Makefile / etc。
 *
 *   2. Markdown 主题(markdown / md)— Inter 文稿排版、无行号,保留 markdown
 *      parser/highlight + live preview 交互。
 *
 *   3. Plain 主题(没传 language)— Inter 15/1.6,无行号、无高亮、无
 *      langExtension,纯文本编辑。padding 和颜色对齐之前 textarea
 *      路径(--msg-assistant-text + px-10 py-7),preview↔edit 不会跳变。
 *      用于 .txt / .log / 未识别后缀。
 *
 * Why CodeMirror everywhere(包括 .md / 普通文本)而不是过去的 textarea 兜底:
 *   - 搜索全量高亮需要在文本上叠 overlay decoration,textarea 不是
 *     contenteditable,做不到 → 之前 .md 编辑模式只能高亮"当前一条",和代
 *     码文件 / preview 的"全量黄底 + 当前琥珀描边"对不上。统一 CodeMirror 后
 *     `cm-doc-search-match` / `cm-doc-search-active` 这套 decoration 在所有文
 *     件上一致工作。
 *   - 顺带拿到 history、软换行、scroll 保持等已有能力,删掉了一整套 textarea
 *     专属代码(taFindAll / taSetActive / handleTextareaKeyDown / ::selection
 *     钩子)。
 *
 * Search API:
 *   `handle.search.findAll(query)` — case-insensitive 全文扫描,缓存命中位置,
 *      一次性派发所有 match decoration。
 *   `handle.search.setActive(index)` — 把第 n 个命中切成 active(琥珀描边)
 *      并 scrollIntoView。故意不动 selection,避免系统蓝色选区盖在 active 橙
 *      色高亮上。
 *   `handle.search.clear()` — 丢弃缓存,清空 decoration。
 */

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import {
  Compartment,
  EditorState,
  EditorSelection,
  Prec,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  keymap,
  lineNumbers,
  type DecorationSet,
  ViewPlugin,
  WidgetType,
  type ViewUpdate,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from '@codemirror/commands';
import { syntaxHighlighting } from '@codemirror/language';
import { SearchCursor } from '@codemirror/search';

import { cn } from '@/lib/utils';
import {
  githubLightHighlight,
  githubDarkHighlight,
  githubLightEditorTheme,
  githubDarkEditorTheme,
  plainLightEditorTheme,
  plainDarkEditorTheme,
  markdownLightEditorTheme,
  markdownDarkEditorTheme,
} from './codemirrorGithubTheme';
import { getCodeMirrorLanguage } from './codemirrorLanguages';
import { codeMirrorSelectionPairing } from './CodeMirrorSelectionPairing';
import {
  clamp,
  findMarkdownTableAtLine,
  markdownTableDecorationField,
  runHistoryCommandPreservingScroll,
  tableMenuLabelsFacet,
  type TableMenuLabels,
} from './markdownTableLivePreview';
import {
  markdownMermaidDecorationField,
  mermaidLocaleFacet,
} from './markdownMermaidLivePreview';
import {
  imageBaseDirFacet,
  imageLocaleFacet,
  markdownImageDecorationField,
} from './markdownImageLivePreview';
import { computeFenceLineRoles, type FenceLineRole } from './markdownFenceLines';
import { getPlaintextEditorChrome } from './plaintextEditorChrome';
import { useIsDarkMode } from './useIsDarkMode';

export interface PlaintextEditorSearchHandle {
  /** Scan the doc for case-insensitive matches of `query`. Returns total. */
  findAll: (query: string) => number;
  /** Focus / scroll to the nth match (0-indexed). No-op if out of range. */
  setActive: (index: number) => void;
  /** Drop cached matches + clear highlight. */
  clear: () => void;
}

export interface PlaintextEditorSelectionLineRange {
  startLine: number;
  endLine: number;
}

export interface PlaintextEditorHandle {
  /** Pull the current text — used by the save action. */
  getValue: () => string;
  /** Insert a default Markdown table near a viewport coordinate or current cursor. */
  insertMarkdownTableAt: (coords?: { x: number; y: number }) => void;
  /**
   * Replace the editor's entire document with `next`. Used by external-change
   * sync (chokidar reload) so the file body updates without remounting the
   * editor (which would lose scroll / cursor position).
   * NOTE: caller is responsible for not clobbering user-in-progress edits ——
   * this method blindly overwrites whatever's in the editor. Typical guard:
   *   if (!editMode && getValue() !== next) setValue(next).
   */
  setValue: (next: string) => void;
  /** Local find-in-doc API. See PlaintextEditorSearchHandle. */
  search: PlaintextEditorSearchHandle;
  /**
   * doc-mode anchor: 当前 viewport 顶部对应的 1-based 行号。view 未挂载或文档
   * 为空时返回 null。算法: 用 viewport.from 这个 char position 反查 doc.lineAt
   * 拿 line.number。viewport.from 是当前可见区域第一个字符的 doc position, 哪怕
   * 那一行只露出半行也算"顶上的行", 跟用户视觉一致。
   */
  getViewportTopLine: () => number | null;
  /**
   * doc-mode anchor: 把指定 1-based 行号对齐到 viewport 顶部。out-of-range / view
   * 未挂载时 no-op。配合 getViewportTopLine 用 (preview→edit 切换时父层先在
   * preview 里捕获 line, 切到 editor 挂载完调本方法对齐位置)。
   */
  scrollToLine: (line: number) => void;
  /** Current non-empty selection's raw document slice. */
  getSelectionText: () => string | null;
  /** Current non-empty selection's 1-based source line range. */
  getSelectionLineRange: () => PlaintextEditorSelectionLineRange | null;
}

export interface PlaintextEditorProps {
  /** Initial text. Editor becomes uncontrolled internally after mount;
   *  remount via key={filePath} to swap content. */
  initialValue: string;
  /** Fires on every keystroke / edit. Use to drive the dirty flag. */
  onChange?: (value: string) => void;
  /** Read-only mode. Toggled at runtime via Compartment.reconfigure,
   *  不重建 EditorView,scrollTop 自然保留。 */
  readOnly?: boolean;
  /** Forwarded to the outer wrapper. */
  className?: string;
  /** highlight.js-style language alias ('python', 'json', 'typescript', ...).
   *  非 markdown alias → 走 code chrome(JetBrains Mono + 行号),parser 存在
   *  时再加高亮;markdown / md 走 markdown 文稿 chrome;undefined 走 plain。 */
  language?: string;
  /** init 时一次性写入 view.scrollDOM.scrollTop —— 用来跨 mount 还原上次
   *  离开 doc 模式时的滚动位置。仅在首次 mount 生效;readOnly 切换不重建
   *  view,自然不会被覆盖。 */
  initialScrollTop?: number;
  /** 上次 viewport 顶部可见行号。Markdown live-preview 下比 scrollTop 更稳。 */
  initialScrollLine?: number | null;
  /** 上次 viewport 顶部在该行/块内的像素偏移,避免恢复时贴到段落/表格开头。 */
  initialScrollOffset?: number | null;
  /** Markdown live-preview 图片的相对路径解析基准目录 —— 传被预览文件自己的
   *  父目录(不是 session cwd)。不传 / 空串时相对路径图片显示"无法解析"占位
   *  卡。仅 markdown chrome 消费,其它模式忽略。 */
  imageBaseDir?: string;
  /** view.scrollDOM 滚动事件回调,带最新 scrollTop。passive listener,无
   *  额外 React state,父组件可以把它直接落到 fileScrollStore。 */
  onScroll?: (top: number, line: number | null, offset: number | null) => void;
}

// ── 大文件降级阈值 ─────────────────────────────────────────────────────────
// CodeMirror 6 自带视口虚拟化, 普通大文件本身没问题, 但下面两件事会变态:
//   1) lineWrapping 会对每行按 viewport 宽度跑一次 measure, 一行 1 MB 的
//      minified bundle / 压缩 JSON → 主线程冻结 2-5 秒。
//   2) syntax highlighting (Lezer) 会全文 lex; 对压缩 JS 一类无格式文件,
//      lex 内存峰值是文档大小的 3-5 倍, 同时把 highlight tree 完整建出来。
// 所以接入两道阈值: 文档过大 / 单行过长时, 自动关掉这两个 feature 进
// "大文件预览模式", 保留 CodeMirror 的滚动 + 编辑能力, 但不再做格式化。
const LARGE_DOC_BYTES = 256 * 1024;       // 文档总字节阈值 (utf-16 char 近似)
const LONG_LINE_CHARS = 5_000;            // 任一行超过这个字符数 → 关 wrap

function detectLargeDoc(doc: string): { largeDoc: boolean; longLine: boolean } {
  const largeDoc = doc.length > LARGE_DOC_BYTES;
  // 只在 largeDoc 命中时才做 longLine 扫描, 避免对小文件白扫一遍。
  // 同时早退: 一旦发现一行超长就 break, 不必扫完整文档。
  let longLine = false;
  if (largeDoc) {
    let prev = -1;
    for (let i = 0; i < doc.length; i++) {
      if (doc.charCodeAt(i) === 10 /* \n */) {
        if (i - prev - 1 > LONG_LINE_CHARS) {
          longLine = true;
          break;
        }
        prev = i;
      }
    }
    if (!longLine && doc.length - prev - 1 > LONG_LINE_CHARS) longLine = true;
  }
  return { largeDoc, longLine };
}

// ── CodeMirror search highlight: StateField + StateEffect ──────────────────
// The effect carries the active set of `{from, to, active}` ranges; the field
// rebuilds a DecorationSet from it. Decoupling search state from the editor
// state means clearing is just dispatching an empty effect — no extra refs.
type SearchRange = { from: number; to: number; active: boolean };

const setSearchRangesEffect = StateEffect.define<SearchRange[]>();

const matchDeco = Decoration.mark({ class: 'cm-doc-search-match' });
const activeDeco = Decoration.mark({ class: 'cm-doc-search-match cm-doc-search-active' });

const searchHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setSearchRangesEffect)) {
        const ranges = e.value;
        if (ranges.length === 0) {
          next = Decoration.none;
        } else {
          next = Decoration.set(
            ranges.map((r) => (r.active ? activeDeco : matchDeco).range(r.from, r.to)),
          );
        }
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

class MarkdownMarkerWidget extends WidgetType {
  constructor(
    private readonly kind: 'empty' | 'bullet' | 'ordered' | 'checked' | 'unchecked',
    private readonly label = '',
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.setAttribute('aria-hidden', 'true');
    span.className = `cm-md-marker cm-md-marker-${this.kind}`;
    if (this.kind === 'bullet') span.textContent = '• ';
    if (this.kind === 'ordered') span.textContent = this.label;
    if (this.kind === 'checked') span.textContent = '☑ ';
    if (this.kind === 'unchecked') span.textContent = '☐ ';
    return span;
  }

  eq(other: MarkdownMarkerWidget): boolean {
    return this.kind === other.kind && this.label === other.label;
  }
}

const emptyMarkdownMarker = Decoration.replace({
  widget: new MarkdownMarkerWidget('empty'),
});
const bulletMarkdownMarker = Decoration.replace({
  widget: new MarkdownMarkerWidget('bullet'),
});
function orderedMarkdownMarker(label: string): Decoration {
  return Decoration.replace({
    widget: new MarkdownMarkerWidget('ordered', label),
  });
}
const checkedMarkdownMarker = Decoration.replace({
  widget: new MarkdownMarkerWidget('checked'),
});
const uncheckedMarkdownMarker = Decoration.replace({
  widget: new MarkdownMarkerWidget('unchecked'),
});

class MarkdownHorizontalRuleWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.setAttribute('aria-hidden', 'true');
    span.className = 'cm-md-horizontal-rule';
    return span;
  }
}

const horizontalRuleMarker = Decoration.replace({
  widget: new MarkdownHorizontalRuleWidget(),
});

const markdownLivePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    /**
     * 围栏块行角色缓存(1-based 行号 → first/body/last)。只在 docChanged 时
     * 重算 —— buildDecorations 在 selectionSet / viewportChanged 时也会重跑,
     * 那两种更新不能触发全文档扫描(规则 10:热路径不加同步全量工作)。
     */
    fenceLines: Map<number, FenceLineRole>;

    constructor(view: EditorView) {
      this.fenceLines = computeFenceLineRoles(view.state.doc);
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.fenceLines = computeFenceLineRoles(update.state.doc);
      }
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    private buildDecorations(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const seen = new Set<number>();
      const tableLines = new Set<number>();

      for (const range of view.visibleRanges) {
        let line = view.state.doc.lineAt(range.from);
        while (line.from <= range.to) {
          const tableBlock = findMarkdownTableAtLine(view, line.number);
          if (tableBlock && !tableLines.has(line.number)) {
            const fromLine = view.state.doc.lineAt(tableBlock.from);
            const toLine = view.state.doc.lineAt(tableBlock.to);
            for (let n = fromLine.number; n <= toLine.number; n++) tableLines.add(n);
            line = view.state.doc.lineAt(tableBlock.to);
            if (line.to >= view.state.doc.length) break;
            line = view.state.doc.line(line.number + 1);
            continue;
          }
          if (!seen.has(line.from) && !tableLines.has(line.number)) {
            seen.add(line.from);
            const fenceRole = this.fenceLines.get(line.number);
            if (fenceRole) {
              // 已闭合围栏块内的行:整块打卡片 class,且**不做任何 markdown
              // conceal**(代码里的 `- ` / `**` / `---` 必须保持原文显示)。
              // 未闭合围栏的开栏行不在 fenceLines 里,落到下面的逐行 fallback
              // (markdownLineClass 的 fence 分支)渲染成单行 fence 样式。
              builder.add(
                line.from,
                line.from,
                Decoration.line({ class: `cm-md-fence-line cm-md-fence-${fenceRole}` }),
              );
              if (fenceRole !== 'body') {
                // ``` / ```lang 标记行默认隐藏(留下卡片顶/底的一条空带),
                // 光标或选区碰到该行时显形,可直接编辑语言标记或删除围栏。
                // 判定用行边界的**闭区间**相交(而非 getLineRevealRanges 的
                // 半开语义):光标停在行尾时也必须算"在这一行上",否则点进
                // 空带右端会出现"光标在行内但标记不显形"的死角。
                const revealed =
                  view.hasFocus &&
                  view.state.selection.ranges.some(
                    (r) =>
                      Math.min(r.anchor, r.head) <= line.to &&
                      Math.max(r.anchor, r.head) >= line.from,
                  );
                if (!revealed && line.text.length > 0) {
                  builder.add(line.from, line.to, emptyMarkdownMarker);
                }
              }
            } else {
              const cls = markdownLineClass(line.text);
              if (cls) builder.add(line.from, line.from, Decoration.line({ class: cls }));
              addMarkdownConcealDecorations(
                builder,
                line.from,
                line.text,
                getLineRevealRanges(view, line.from, line.to),
              );
            }
          }
          if (line.to >= view.state.doc.length) break;
          line = view.state.doc.line(line.number + 1);
        }
      }

      return builder.finish();
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);

// 多击序列(双击/三击)的位置锚点。首次点击(detail=1)把光标放进目标行会触发
// conceal/reveal:markdown 符号(`**` / `- ` / `---` 等)在该行显形、上一个光标行
// 重新隐藏,行内容变长/变短引起折行数变化,整篇内容随之垂直位移。此时如果
// detail>=2 的后续点击再按屏幕坐标重新求文档位置,同一个屏幕点已经对应到位移后
// 的相邻行 —— 用户实测"双击选词选中了下一行"。reveal 只改显示不改文档内容,
// 首次算出的文档位置始终指向用户瞄准的那个字符,所以这里记住它,同一次多击
// 序列直接复用。WeakMap 按 view 存,编辑器销毁(切文件)后条目自动可回收。
const lastPrimaryClickPos = new WeakMap<EditorView, number>();

const markdownMouseSelection = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (
      event.button !== 0 ||
      event.shiftKey ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
      return false;
    }
    const coordsPos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
    if (coordsPos == null) return false;
    const storedPos = event.detail >= 2 ? lastPrimaryClickPos.get(view) : undefined;
    // storedPos 可能来自更早的文档版本(极端情况:双击间隙文档被外部改写),
    // clamp 到当前文档长度内,避免 dispatch 越界 selection 抛异常。
    const pos =
      storedPos !== undefined
        ? Math.min(storedPos, view.state.doc.length)
        : coordsPos;
    if (event.detail === 1) lastPrimaryClickPos.set(view, coordsPos);

    if (event.detail === 2) {
      event.preventDefault();
      view.focus();
      const word = findVisibleWordAt(view, pos);
      view.dispatch({ selection: EditorSelection.range(word.from, word.to) });
      return true;
    }

    if (event.detail >= 3) {
      event.preventDefault();
      view.focus();
      const line = view.state.doc.lineAt(pos);
      view.dispatch({ selection: EditorSelection.range(line.from, line.to) });
      return true;
    }

    event.preventDefault();
    view.focus();
    view.dispatch({ selection: EditorSelection.cursor(pos) });

    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;

    const cleanup = () => {
      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('mouseup', onMouseUp, true);
    };

    const onMouseMove = (moveEvent: MouseEvent) => {
      const moved = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
      if (!dragging && moved <= 4) return;
      dragging = true;
      moveEvent.preventDefault();
      const head = view.posAtCoords({ x: moveEvent.clientX, y: moveEvent.clientY }, false);
      if (head == null) return;
      view.dispatch({ selection: EditorSelection.range(pos, head) });
    };

    const onMouseUp = (upEvent: MouseEvent) => {
      cleanup();
      upEvent.preventDefault();
      if (!dragging) {
        view.dispatch({ selection: EditorSelection.cursor(pos) });
      }
    };

    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mouseup', onMouseUp, true);
    return true;
  },
});

function findVisibleWordAt(
  view: EditorView,
  pos: number,
): { from: number; to: number } {
  const line = view.state.doc.lineAt(pos);
  const text = line.text;
  const visibleStart = getVisibleContentStart(text);
  const localPos = pos - line.from;

  if (localPos < visibleStart) {
    return { from: line.from, to: line.from + visibleStart };
  }

  let from = localPos;
  let to = localPos;
  while (from > visibleStart && !isWordBoundaryChar(text[from - 1])) from--;
  while (to < text.length && !isWordBoundaryChar(text[to])) to++;
  if (from === to) {
    if (from > visibleStart) from--;
    else if (to < text.length) to++;
  }
  return { from: line.from + from, to: line.from + to };
}

function getVisibleContentStart(text: string): number {
  const heading = /^#{1,6}\s+/.exec(text);
  if (heading) return heading[0].length;
  const task = /^\s*[-*+]\s+\[[ xX]\]\s+/.exec(text);
  if (task) return task[0].length;
  const bullet = /^\s*[-*+]\s+/.exec(text);
  if (bullet) return bullet[0].length;
  const ordered = /^\s*\d+[.)]\s+/.exec(text);
  if (ordered) return ordered[0].length;
  const quote = /^\s*>\s?/.exec(text);
  if (quote) return quote[0].length;
  return 0;
}

function isWordBoundaryChar(char: string): boolean {
  return /[\s\p{P}\p{S}]/u.test(char);
}

function markdownLineClass(text: string): string | null {
  const heading = /^(#{1,6})\s+/.exec(text);
  if (heading) return `cm-md-heading-line cm-md-heading-${heading[1].length}`;
  if (/^\s*>\s?/.test(text)) return 'cm-md-quote-line';
  if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(text)) return 'cm-md-list-line cm-md-task-line';
  if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(text)) return 'cm-md-list-line';
  if (/^\s*\|.*\|\s*$/.test(text)) return 'cm-md-table-line';
  if (/^\s*(```|~~~)/.test(text)) return 'cm-md-fence-line';
  return null;
}

function addMarkdownConcealDecorations(
  builder: RangeSetBuilder<Decoration>,
  lineFrom: number,
  text: string,
  revealRanges: Array<{ from: number; to: number }>,
): void {
  const heading = /^(#{1,6})\s+/.exec(text);
  if (heading) {
    addConcealUnlessRevealed(
      builder,
      lineFrom,
      0,
      heading[0].length,
      revealRanges,
      emptyMarkdownMarker,
      { revealStart: heading[0].length, revealEnd: text.length },
    );
    addInlineMarkerConceals(builder, lineFrom, text, heading[0].length, revealRanges);
    return;
  }

  const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+/.exec(text);
  if (task) {
    const marker = task[2].toLowerCase() === 'x' ? checkedMarkdownMarker : uncheckedMarkdownMarker;
    addConcealUnlessRevealed(
      builder,
      lineFrom,
      task[1].length,
      task[0].length,
      revealRanges,
      marker,
      { revealStart: task[1].length, revealEnd: task[1].length + 1 },
    );
    addInlineMarkerConceals(builder, lineFrom, text, task[0].length, revealRanges);
    return;
  }

  const bullet = /^(\s*)[-*+]\s+/.exec(text);
  if (bullet) {
    addConcealUnlessRevealed(
      builder,
      lineFrom,
      bullet[1].length,
      bullet[0].length,
      revealRanges,
      bulletMarkdownMarker,
      { revealStart: bullet[1].length, revealEnd: bullet[1].length + 1 },
    );
    addInlineMarkerConceals(builder, lineFrom, text, bullet[0].length, revealRanges);
    return;
  }

  const ordered = /^(\s*)(\d+[.)])\s+/.exec(text);
  if (ordered) {
    addConcealUnlessRevealed(
      builder,
      lineFrom,
      ordered[1].length,
      ordered[0].length,
      revealRanges,
      orderedMarkdownMarker(`${ordered[2]} `),
      { revealStart: ordered[1].length, revealEnd: ordered[1].length + ordered[2].length },
    );
    addInlineMarkerConceals(builder, lineFrom, text, ordered[0].length, revealRanges);
    return;
  }

  const quote = /^(\s*)>\s?/.exec(text);
  if (quote) {
    addConcealUnlessRevealed(
      builder,
      lineFrom,
      quote[1].length,
      quote[0].length,
      revealRanges,
      emptyMarkdownMarker,
      { revealStart: quote[0].length, revealEnd: text.length },
    );
    addInlineMarkerConceals(builder, lineFrom, text, quote[0].length, revealRanges);
    return;
  }

  if (/^\s*(```|~~~)/.test(text)) return;
  const horizontalRule = /^(\s*)(?:-{3,}|\*{3,}|_{3,})\s*$/.exec(text);
  if (horizontalRule) {
    addConcealUnlessRevealed(
      builder,
      lineFrom,
      horizontalRule[1].length,
      text.length,
      revealRanges,
      horizontalRuleMarker,
      { revealStart: horizontalRule[1].length, revealEnd: text.length },
    );
    return;
  }
  addInlineMarkerConceals(builder, lineFrom, text, 0, revealRanges);
}

function addInlineMarkerConceals(
  builder: RangeSetBuilder<Decoration>,
  lineFrom: number,
  text: string,
  minIndex: number,
  revealRanges: Array<{ from: number; to: number }>,
): void {
  const ranges = [
    ...getPairedMarkerConceals(text, /\*\*([^*\n]+)\*\*/g, 2, minIndex, revealRanges),
    ...getPairedMarkerConceals(text, /`([^`\n]+)`/g, 1, minIndex, revealRanges),
  ].sort((a, b) => a.from - b.from || a.to - b.to);

  for (const range of ranges) {
    builder.add(lineFrom + range.from, lineFrom + range.to, range.decoration);
  }
}

function getPairedMarkerConceals(
  text: string,
  regex: RegExp,
  markerLength: number,
  minIndex: number,
  revealRanges: Array<{ from: number; to: number }>,
): Array<{ from: number; to: number; decoration: Decoration }> {
  const ranges: Array<{ from: number; to: number; decoration: Decoration }> = [];
  for (const match of text.matchAll(regex)) {
    const start = match.index;
    if (start == null || start < minIndex) continue;
    const end = start + match[0].length;
    const shouldReveal = rangeTouchesAnyReveal(
      start + markerLength,
      end - markerLength,
      revealRanges,
    );
    if (shouldReveal) continue;
    ranges.push(
      { from: start, to: start + markerLength, decoration: emptyMarkdownMarker },
      { from: end - markerLength, to: end, decoration: emptyMarkdownMarker },
    );
  }
  return ranges;
}

function getLineRevealRanges(
  view: EditorView,
  lineFrom: number,
  lineTo: number,
): Array<{ from: number; to: number }> {
  if (!view.hasFocus) return [];
  const out: Array<{ from: number; to: number }> = [];
  for (const range of view.state.selection.ranges) {
    const from = Math.max(Math.min(range.anchor, range.head), lineFrom);
    const to = Math.min(Math.max(range.anchor, range.head), lineTo);
    if (range.empty) {
      if (range.anchor >= lineFrom && range.anchor <= lineTo) {
        const local = range.anchor - lineFrom;
        out.push({ from: local, to: local });
      }
    } else if (from <= to) {
      out.push({ from: from - lineFrom, to: to - lineFrom });
    }
  }
  return out;
}

function addConcealUnlessRevealed(
  builder: RangeSetBuilder<Decoration>,
  lineFrom: number,
  from: number,
  to: number,
  revealRanges: Array<{ from: number; to: number }>,
  conceal: Decoration,
  revealArea: { revealStart: number; revealEnd: number },
): void {
  if (rangeTouchesAnyReveal(revealArea.revealStart, revealArea.revealEnd, revealRanges)) return;
  builder.add(lineFrom + from, lineFrom + to, conceal);
}

function rangeTouchesAnyReveal(
  from: number,
  to: number,
  revealRanges: Array<{ from: number; to: number }>,
): boolean {
  return revealRanges.some((range) => {
    if (range.from === range.to) return range.from >= from && range.from < to;
    return range.from < to && range.to > from;
  });
}

function toggleMarkdownStrong(view: EditorView): boolean {
  const transaction = view.state.changeByRange((range) => {
    const doc = view.state.doc;
    const from = Math.min(range.anchor, range.head);
    const to = Math.max(range.anchor, range.head);
    const line = doc.lineAt(from);
    const lineText = line.text;
    const overlappedStrong = findOverlappingStrong(lineText, from, to, line.from);
    if (overlappedStrong) {
      const selectionFrom = range.empty
        ? clamp(range.from - 2, overlappedStrong.openFrom, overlappedStrong.closeFrom - 2)
        : Math.max(from - 2, overlappedStrong.openFrom);
      const selectionTo = range.empty
        ? selectionFrom
        : Math.min(to - 2, overlappedStrong.closeFrom - 2);
      return {
        changes: [
          { from: overlappedStrong.closeFrom, to: overlappedStrong.closeTo },
          { from: overlappedStrong.openFrom, to: overlappedStrong.openTo },
        ],
        range: range.empty
          ? EditorSelection.cursor(selectionFrom)
          : EditorSelection.range(selectionFrom, selectionTo),
      };
    }

    if (!range.empty) {
      return {
        changes: [
          { from: to, insert: '**' },
          { from, insert: '**' },
        ],
        range: EditorSelection.range(from + 2, to + 2),
      };
    }

    const word = findMarkdownStrongTarget(doc, range.from);
    if (word) {
      return {
        changes: [
          { from: word.to, insert: '**' },
          { from: word.from, insert: '**' },
        ],
        range: EditorSelection.range(word.from + 2, word.to + 2),
      };
    }

    return {
      changes: { from: range.from, insert: '****' },
      range: EditorSelection.cursor(range.from + 2),
    };
  });

  view.dispatch(transaction, { userEvent: 'input' });
  return true;
}

function insertMarkdownTableShortcut(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  return insertMarkdownTable(view, selection.from, { requireSlashCommand: true });
}

function insertMarkdownTable(
  view: EditorView,
  pos: number,
  opts?: { requireSlashCommand?: boolean },
): boolean {
  const line = view.state.doc.lineAt(pos);
  const table = '| Header 1 | Header 2 |\n| --- | --- |\n|  |  |\n|  |  |';
  const trimmed = line.text.trim();

  if (opts?.requireSlashCommand && trimmed !== '/table') return false;

  const prevLine = line.number > 1 ? view.state.doc.line(line.number - 1).text : '';
  const nextLine = line.number < view.state.doc.lines ? view.state.doc.line(line.number + 1).text : '';
  const prefix = trimmed.length === 0 && isMarkdownTableSourceLine(prevLine) ? '\n' : '';
  const suffix = trimmed.length === 0 && isMarkdownTableSourceLine(nextLine) ? '\n' : '';
  const insert =
    trimmed === '/table'
      ? { from: line.from, to: line.to, text: table }
      : trimmed.length === 0
        ? { from: line.from, to: line.to, text: `${prefix}${table}${suffix}` }
        : {
            from: line.to,
            to: line.to,
            text: `${line.to < view.state.doc.length ? '\n\n' : '\n'}${table}${isMarkdownTableSourceLine(nextLine) ? '\n' : ''}`,
          };

  view.dispatch({
    changes: { from: insert.from, to: insert.to, insert: insert.text },
    selection: EditorSelection.cursor(insert.from + insert.text.length),
    userEvent: 'input',
  });
  return true;
}

function isMarkdownTableSourceLine(text: string): boolean {
  return /^\s*\|.*\|\s*$/.test(text);
}

function findOverlappingStrong(
  text: string,
  from: number,
  to: number,
  lineFrom: number,
): { openFrom: number; openTo: number; closeFrom: number; closeTo: number } | null {
  for (const match of text.matchAll(/\*\*([^*\n]+)\*\*/g)) {
    const start = match.index;
    if (start == null) continue;
    const openFrom = lineFrom + start;
    const openTo = lineFrom + start + 2;
    const closeFrom = lineFrom + start + match[0].length - 2;
    const closeTo = lineFrom + start + match[0].length;
    if (from === to) {
      if (from >= openTo && from <= closeFrom) {
        return { openFrom, openTo, closeFrom, closeTo };
      }
    } else if (from < closeTo && to > openFrom) {
      return { openFrom, openTo, closeFrom, closeTo };
    }
  }
  return null;
}

function findMarkdownStrongTarget(
  doc: EditorState['doc'],
  pos: number,
): { from: number; to: number } | null {
  const line = doc.lineAt(pos);
  let from = pos;
  let to = pos;
  const text = line.text;
  let local = pos - line.from;

  if (local > 0 && (local === text.length || isMarkdownStrongBoundary(text[local]))) {
    local -= 1;
  }
  if (local < 0 || local >= text.length || isMarkdownStrongBoundary(text[local])) {
    return null;
  }

  from = line.from + local;
  to = line.from + local + 1;
  while (from > line.from && !isMarkdownStrongBoundary(doc.sliceString(from - 1, from))) {
    from--;
  }
  while (to < line.to && !isMarkdownStrongBoundary(doc.sliceString(to, to + 1))) {
    to++;
  }
  return from < to ? { from, to } : null;
}

function isMarkdownStrongBoundary(char: string | undefined): boolean {
  return !char || /[\s\p{P}\p{S}]/u.test(char);
}

const markdownFormattingKeymap = Prec.high(keymap.of([
  {
    key: 'Mod-z',
    run: (view) => runHistoryCommandPreservingScroll(view, undo),
  },
  {
    key: 'Mod-Shift-z',
    run: (view) => runHistoryCommandPreservingScroll(view, redo),
  },
  {
    key: 'Mod-y',
    run: (view) => runHistoryCommandPreservingScroll(view, redo),
  },
  {
    key: 'Enter',
    run: insertMarkdownTableShortcut,
  },
  {
    key: 'Mod-b',
    run: toggleMarkdownStrong,
  },
]));

type PlaintextEditorInitialConfig = {
  doc: string;
  initialScrollTop: number | undefined;
  initialScrollLine: number | null | undefined;
  initialScrollOffset: number | null | undefined;
  language: string | undefined;
  isMarkdown: boolean;
  useCodeChrome: boolean;
  skipHighlight: boolean;
  skipWrap: boolean;
};

interface ViewportTopAnchor {
  line: number | null;
  offset: number | null;
}

function getViewportTopAnchor(view: EditorView): ViewportTopAnchor {
  // 关键: 不能用 view.viewport.from —— 它是 render 范围 (含上下 buffer),
  // 比用户视觉顶高几行甚至几十行。用 lineBlockAtHeight(scrollTop) 拿真正
  // 用户视觉顶第一行 block。scrollTop 是 doc-relative height,直接传即可。
  try {
    const top = view.scrollDOM.scrollTop;
    const block = view.lineBlockAtHeight(top);
    return {
      line: view.state.doc.lineAt(block.from).number,
      offset: Math.max(0, top - block.top),
    };
  } catch {
    return { line: null, offset: null };
  }
}

function getViewportTopLine(view: EditorView): number | null {
  return getViewportTopAnchor(view).line;
}

function scrollViewToLine(view: EditorView, line: number): void {
  const doc = view.state.doc;
  if (line < 1 || line > doc.lines) return;
  const pos = doc.line(line).from;
  view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start' }) });
}

function getSelectionLineRange(view: EditorView): PlaintextEditorSelectionLineRange | null {
  if (!view.hasFocus) return null;
  const selection = view.state.selection.main;
  if (selection.empty) return null;
  const from = Math.min(selection.from, selection.to);
  const to = Math.max(selection.from, selection.to);
  const doc = view.state.doc;
  let startPos = from;
  let endPos = to;
  while (startPos < endPos && doc.sliceString(startPos, startPos + 1) === '\n') {
    startPos += 1;
  }
  while (endPos > startPos && doc.sliceString(endPos - 1, endPos) === '\n') {
    endPos -= 1;
  }
  if (startPos >= endPos) return null;
  const startLine = doc.lineAt(startPos).number;
  const endLine = doc.lineAt(endPos - 1).number;
  return { startLine, endLine: Math.max(startLine, endLine) };
}

function getSelectionText(view: EditorView): string | null {
  if (!view.hasFocus) return null;
  const selection = view.state.selection.main;
  if (selection.empty) return null;
  const from = Math.min(selection.from, selection.to);
  const to = Math.max(selection.from, selection.to);
  return view.state.doc.sliceString(from, to);
}

export const PlaintextEditor = forwardRef<PlaintextEditorHandle, PlaintextEditorProps>(
  function PlaintextEditor(
    {
      initialValue,
      onChange,
      readOnly = false,
      className,
      language,
      initialScrollTop,
      initialScrollLine,
      initialScrollOffset,
      imageBaseDir,
      onScroll,
    },
    ref,
  ) {
    const isDarkMode = useIsDarkMode();
    const { t, i18n: i18nInst } = useTranslation();
    const currentLocale = i18nInst.language;
    const editorChrome = getPlaintextEditorChrome(language);
    const isMarkdown = editorChrome === 'markdown';
    // UI chrome 分三种:
    //   - code: monospace + 行号;parser 存在时才语法高亮。
    //   - markdown: sans 排版 + markdown parser/highlight + 无行号。
    //   - plain: sans 排版 + 无 parser/highlight + 无行号。
    // 大文件检测: 在 CodeMirror init 之前就决定要不要关 wrap / lang。
    // initialValue / language 是 mount-only 输入: 父层切文件靠 key remount,
    // 编辑期内部 uncontrolled,不能把 initialValue 加进 init effect 依赖导致重建。
    const initialConfigRef = useRef<PlaintextEditorInitialConfig | null>(null);
    if (initialConfigRef.current === null) {
      const initialEditorChrome = getPlaintextEditorChrome(language);
      const docFlags = detectLargeDoc(initialValue);
      initialConfigRef.current = {
        doc: initialValue,
        initialScrollTop,
        initialScrollLine,
        initialScrollOffset,
        language,
        isMarkdown: initialEditorChrome === 'markdown',
        useCodeChrome: initialEditorChrome === 'code',
        // largeDoc 命中时强制关 highlighting (避免 Lezer 全文 lex);
        // longLine 命中时同时关 wrap (避免 wrap measure 卡死)。
        skipHighlight: docFlags.largeDoc,
        skipWrap: docFlags.longLine,
      };
    }

    const cmContainerRef = useRef<HTMLDivElement>(null);
    const cmViewRef = useRef<EditorView | null>(null);
    const docValueRef = useRef(initialConfigRef.current.doc);
    const scrollTopRef = useRef(initialConfigRef.current.initialScrollTop ?? 0);
    const scrollLineRef = useRef<number | null>(
      initialConfigRef.current.initialScrollLine ?? null,
    );
    const scrollOffsetRef = useRef<number | null>(
      initialConfigRef.current.initialScrollOffset ?? null,
    );
    const readOnlyRef = useRef(readOnly);
    readOnlyRef.current = readOnly;

    // Cached search positions — written by findAll(), read by setActive().
    // Use a ref so search ops don't trigger re-renders.
    const matchesRef = useRef<{ from: number; to: number }[]>([]);

    // readOnly 用 Compartment 包起来,让 preview↔edit 可以 reconfigure 而不
    // remount。否则父组件靠 key 切换 readOnly 会让 CodeMirror 整个销毁重建,
    // 滚动位置会被重置回顶部 —— 用户拖到下面点编辑就会"跳回顶上"。
    const editableCompartment = useRef(new Compartment()).current;
    const tableLabelsCompartment = useRef(new Compartment()).current;
    const mermaidLocaleCompartment = useRef(new Compartment()).current;
    const imageBaseDirCompartment = useRef(new Compartment()).current;

    // imageBaseDir 走 ref 保鲜:init effect 不能依赖它(否则 prop identity 变化
    // 会重建 EditorView 丢滚动位置);运行时变更由下面的 reconfigure effect 处理。
    const imageBaseDirRef = useRef(imageBaseDir ?? '');
    imageBaseDirRef.current = imageBaseDir ?? '';

    const tableMenuLabels = useMemo<TableMenuLabels>(
      () => ({
        'add-row-above': t('ccAgent.workdirBrowse.fileBody.tableMenu.addRowAbove'),
        'add-row-below': t('ccAgent.workdirBrowse.fileBody.tableMenu.addRowBelow'),
        'delete-row': t('ccAgent.workdirBrowse.fileBody.tableMenu.deleteRow'),
        'add-column-left': t('ccAgent.workdirBrowse.fileBody.tableMenu.addColumnLeft'),
        'add-column-right': t('ccAgent.workdirBrowse.fileBody.tableMenu.addColumnRight'),
        'delete-column': t('ccAgent.workdirBrowse.fileBody.tableMenu.deleteColumn'),
        'delete-table': t('ccAgent.workdirBrowse.fileBody.tableMenu.deleteTable'),
      }),
      [t],
    );
    const tableMenuLabelsRef = useRef(tableMenuLabels);
    tableMenuLabelsRef.current = tableMenuLabels;

    // onChange / onScroll 用 ref 保鲜。init effect 不能跟着 callback identity
    // 重跑,否则会销毁 EditorView 并丢滚动 / 光标。
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const onScrollRef = useRef(onScroll);
    onScrollRef.current = onScroll;

    // ── Search helpers (单一 CodeMirror 实现) ────────────────────────────
    const search = useMemo<PlaintextEditorSearchHandle>(
      () => ({
        findAll: (query: string): number => {
          const view = cmViewRef.current;
          if (!view) return 0;
          if (!query) {
            matchesRef.current = [];
            view.dispatch({ effects: setSearchRangesEffect.of([]) });
            return 0;
          }
          const doc = view.state.doc;
          // Case-insensitive: SearchCursor's normalize fn is applied to BOTH
          // the search term and the doc, so lowercase both sides → ascii-CI.
          // Unicode folding could be added later if needed.
          const cursor = new SearchCursor(doc, query, 0, doc.length, (s) => s.toLowerCase());
          const out: { from: number; to: number }[] = [];
          while (!cursor.next().done) {
            out.push({ from: cursor.value.from, to: cursor.value.to });
          }
          matchesRef.current = out;
          // Render all matches; no active until setActive() picks one.
          view.dispatch({
            effects: setSearchRangesEffect.of(
              out.map((r) => ({ from: r.from, to: r.to, active: false })),
            ),
          });
          return out.length;
        },
        setActive: (index: number): void => {
          const view = cmViewRef.current;
          if (!view) return;
          const matches = matchesRef.current;
          if (index < 0 || index >= matches.length) return;
          // 故意不改 selection —— 否则系统选区(蓝)会盖在我们的橙色 active
          // decoration 上,视觉上变成蓝绿色选中态,跟 preview 模式的纯橙高亮
          // 完全不一致。改用 scrollIntoView effect 单独把 active 滚入视野。
          view.dispatch({
            effects: [
              EditorView.scrollIntoView(matches[index].from, { y: 'center' }),
              setSearchRangesEffect.of(
                matches.map((r, i) => ({ from: r.from, to: r.to, active: i === index })),
              ),
            ],
          });
        },
        clear: (): void => {
          matchesRef.current = [];
          const view = cmViewRef.current;
          if (!view) return;
          view.dispatch({ effects: setSearchRangesEffect.of([]) });
        },
      }),
      [],
    );

    useImperativeHandle(
      ref,
      () => ({
        getValue: () => cmViewRef.current?.state.doc.toString() ?? '',
        insertMarkdownTableAt: (coords) => {
          const view = cmViewRef.current;
          if (!view || !isMarkdown || readOnly) return;
          const pos = coords
            ? view.posAtCoords({ x: coords.x, y: coords.y }, false)
            : null;
          insertMarkdownTable(view, pos ?? view.state.selection.main.from);
          view.focus();
        },
        setValue: (next: string) => {
          // dispatch 一个把 [0, doc.length) 替换成 next 的事务。
          // 这条事务会被 history() 当成一次普通编辑记账; 但调用者只在 readOnly /
          // 非 edit 模式下推外部更新,本地 history 此时本来就没意义。
          const view = cmViewRef.current;
          if (!view) return;
          const cur = view.state.doc.toString();
          if (cur === next) return;
          view.dispatch({ changes: { from: 0, to: cur.length, insert: next } });
        },
        search,
        getViewportTopLine: () =>
          cmViewRef.current ? getViewportTopLine(cmViewRef.current) : null,
        scrollToLine: (line: number) => {
          const view = cmViewRef.current;
          if (!view) return;
          // EditorView.scrollIntoView with y:'start' 把目标 char 对齐到 viewport
          // 顶部 — 配合 anchor 捕获方向上的"顶部行"语义。
          scrollViewToLine(view, line);
        },
        getSelectionText: () => {
          const view = cmViewRef.current;
          return view ? getSelectionText(view) : null;
        },
        getSelectionLineRange: () => {
          const view = cmViewRef.current;
          return view ? getSelectionLineRange(view) : null;
        },
      }),
      [isMarkdown, readOnly, search],
    );

    // ── CodeMirror init / teardown ───────────────────────────────────────
    // We construct the EditorView once on mount and tear it down on unmount.
    // File switching is handled by the parent remounting via key={viewingPath}
    // so we don't need to re-sync `initialValue` here.
    // Theme switching (light↔dark) re-creates the editor — acceptable since
    // theme flips are rare and the alternative (StateEffect.reconfigure) is
    // a lot of plumbing for marginal benefit.
    useEffect(() => {
      if (!cmContainerRef.current) return;
      const initialConfig = initialConfigRef.current;
      if (!initialConfig) return;
      const langExtension = getCodeMirrorLanguage(initialConfig.language);
      const highlightExtensions =
        !initialConfig.skipHighlight && langExtension !== null
          ? [
              langExtension,
              syntaxHighlighting(isDarkMode ? githubDarkHighlight : githubLightHighlight),
            ]
          : [];
      // 按降级 flag + chrome 模式拼 extension 列表:
      //   - skipWrap → 不挂 lineWrapping。
      //   - skipHighlight 或没有 parser → 不挂 langExtension + syntaxHighlighting,
      //     这样 Lezer 不会被触发, init 时间从 2-5s 跌回 50-100ms。
      //   - code chrome → 始终挂 lineNumbers gutter,即使 parser 缺失。
      const extensions = [
        history(),
        codeMirrorSelectionPairing,
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
        ...(initialConfig.skipWrap ? [] : [EditorView.lineWrapping]),
        ...(initialConfig.useCodeChrome ? [lineNumbers()] : []),
        ...highlightExtensions,
        ...(initialConfig.isMarkdown
          ? [
              markdownTableDecorationField,
              tableLabelsCompartment.of(tableMenuLabelsFacet.of(tableMenuLabelsRef.current)),
              markdownFormattingKeymap,
              markdownLivePreviewPlugin,
              markdownMermaidDecorationField,
              markdownImageDecorationField,
              imageBaseDirCompartment.of(imageBaseDirFacet.of(imageBaseDirRef.current)),
              // mermaid / image widget 的 i18n 文案都在 toDOM 时读取,共用同一个
              // locale compartment,语言切换时一次 reconfigure 触发两个 field 重建。
              mermaidLocaleCompartment.of([
                mermaidLocaleFacet.of(currentLocale),
                imageLocaleFacet.of(currentLocale),
              ]),
              markdownMouseSelection,
            ]
          : []),
        initialConfig.isMarkdown
          ? isDarkMode
            ? markdownDarkEditorTheme
            : markdownLightEditorTheme
          : initialConfig.useCodeChrome
          ? isDarkMode
            ? githubDarkEditorTheme
            : githubLightEditorTheme
          : isDarkMode
            ? plainDarkEditorTheme
            : plainLightEditorTheme,
        searchHighlightField,
        editableCompartment.of(EditorView.editable.of(!readOnlyRef.current)),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          const next = u.state.doc.toString();
          docValueRef.current = next;
          onChangeRef.current?.(next);
        }),
      ];
      const state = EditorState.create({ doc: docValueRef.current, extensions });
      const view = new EditorView({ state, parent: cmContainerRef.current });
      cmViewRef.current = view;
      // 还原跨 mount 滚动位置。Markdown live-preview/table widgets 会在
      // mount 后几帧内持续改变 height map；恢复期间触发的 scroll event 是
      // 程序化中间态，不能写回 store，否则下一次切回会随机使用这些半成品
      // 位置。这里用同一个目标 anchor 连续校准几帧，最后只提交稳定后的实际
      // viewport anchor。
      const restoreTargetLine = scrollLineRef.current;
      const restoreTargetOffset = scrollOffsetRef.current;
      const restoreTargetTop = scrollTopRef.current;
      const shouldRestore = restoreTargetLine !== null || restoreTargetTop > 0;
      let suppressScrollEmit = shouldRestore;
      let restoreFrame: number | null = null;
      // Empirically enough for Markdown table live-preview widgets to finish
      // their first few measure/repaint passes after mount (~133ms at 60Hz).
      let restoreFramesRemaining = shouldRestore ? 8 : 0;
      let userInterruptedRestore = false;

      const readCurrentScrollAnchor = () => {
        const top = view.scrollDOM.scrollTop;
        const anchor = getViewportTopAnchor(view);
        scrollTopRef.current = top;
        scrollLineRef.current = anchor.line;
        scrollOffsetRef.current = anchor.offset;
        return { top, line: anchor.line, offset: anchor.offset };
      };

      const finishRestore = () => {
        suppressScrollEmit = false;
        const anchor = readCurrentScrollAnchor();
        onScrollRef.current?.(anchor.top, anchor.line, anchor.offset);
      };

      const cancelRestoreForUserInput = () => {
        if (!suppressScrollEmit) return;
        userInterruptedRestore = true;
        restoreFramesRemaining = 0;
        if (restoreFrame !== null) {
          window.cancelAnimationFrame(restoreFrame);
          restoreFrame = null;
        }
        finishRestore();
      };

      const restoreInitialScroll = () => {
        const setRestoredScrollTop = (top: number) => {
          view.scrollDOM.scrollTop = top;
          // Programmatic scrollTop writes can leave CodeMirror's measured
          // viewport one frame behind, which is visible for table widgets as
          // blank cells until the user scrolls. Force a measure pass after
          // each restore tick so decorations/widgets repaint for the target
          // viewport, not for the previous one.
          view.requestMeasure();
        };
        if (restoreTargetLine !== null) {
          try {
            const doc = view.state.doc;
            if (restoreTargetLine >= 1 && restoreTargetLine <= doc.lines) {
              const line = doc.line(restoreTargetLine);
              const block = view.lineBlockAt(line.from);
              setRestoredScrollTop(block.top + (restoreTargetOffset ?? 0));
              return;
            }
          } catch {
            // Fall through to pixel fallback below.
          }
          if (restoreTargetTop > 0) setRestoredScrollTop(restoreTargetTop);
          return;
        }
        if (restoreTargetTop > 0) setRestoredScrollTop(restoreTargetTop);
      };

      const scheduleRestoreFrame = () => {
        if (userInterruptedRestore) return;
        if (restoreFramesRemaining <= 0) {
          finishRestore();
          return;
        }
        restoreFrame = window.requestAnimationFrame(() => {
          restoreFrame = null;
          if (userInterruptedRestore) return;
          restoreFramesRemaining -= 1;
          restoreInitialScroll();
          scheduleRestoreFrame();
        });
      };

      if (shouldRestore) {
        restoreInitialScroll();
        scheduleRestoreFrame();
      }

      // 监听内部滚动 —— 父层通过 onScroll 把 scrollTop 落到 fileScrollStore。
      // passive 让浏览器不等回调 → 不阻塞滚动主线程。
      const handleScroll = () => {
        const anchor = readCurrentScrollAnchor();
        if (suppressScrollEmit) return;
        onScrollRef.current?.(anchor.top, anchor.line, anchor.offset);
      };
      view.scrollDOM.addEventListener('scroll', handleScroll, { passive: true });
      view.scrollDOM.addEventListener('wheel', cancelRestoreForUserInput, { passive: true });
      view.scrollDOM.addEventListener('touchmove', cancelRestoreForUserInput, { passive: true });
      view.scrollDOM.addEventListener('pointerdown', cancelRestoreForUserInput, { passive: true });
      view.scrollDOM.addEventListener('keydown', cancelRestoreForUserInput);
      return () => {
        if (restoreFrame !== null) window.cancelAnimationFrame(restoreFrame);
        // Do not emit onScroll from cleanup. In React dev/StrictMode, effect
        // cleanup also runs as a mount probe; writing that transient position
        // would overwrite the user's saved anchor with 0 or an early layout.
        view.scrollDOM.removeEventListener('scroll', handleScroll);
        view.scrollDOM.removeEventListener('wheel', cancelRestoreForUserInput);
        view.scrollDOM.removeEventListener('touchmove', cancelRestoreForUserInput);
        view.scrollDOM.removeEventListener('pointerdown', cancelRestoreForUserInput);
        view.scrollDOM.removeEventListener('keydown', cancelRestoreForUserInput);
        view.destroy();
        cmViewRef.current = null;
      };
    }, [isDarkMode, editableCompartment, tableLabelsCompartment]);

    // locale / t 变化时只换 Markdown table 菜单文案,不重建整棵 EditorView。
    useEffect(() => {
      const view = cmViewRef.current;
      if (!view || !isMarkdown) return;
      view.dispatch({
        effects: tableLabelsCompartment.reconfigure(tableMenuLabelsFacet.of(tableMenuLabels)),
      });
    }, [isMarkdown, tableMenuLabels, tableLabelsCompartment]);

    // Mermaid / image widget 内的文案走 i18n.t() 在 toDOM 时读字符串,语言切换
    // 不会自动刷新。这里把当前 locale 通过 facet 喂给两个 live-preview
    // StateField,facet 翻转触发 widget 全量重建,新的 t() 在重建时拿到当前
    // 语言下的字符串。
    useEffect(() => {
      const view = cmViewRef.current;
      if (!view || !isMarkdown) return;
      view.dispatch({
        effects: mermaidLocaleCompartment.reconfigure([
          mermaidLocaleFacet.of(currentLocale),
          imageLocaleFacet.of(currentLocale),
        ]),
      });
    }, [isMarkdown, currentLocale, mermaidLocaleCompartment]);

    // imageBaseDir 变更 → reconfigure(不重建 view)。宿主一般靠 key remount
    // 切文件,这里只是兜底(同一 mount 内 prop 变化也能正确刷新解析基准)。
    useEffect(() => {
      const view = cmViewRef.current;
      if (!view || !isMarkdown) return;
      view.dispatch({
        effects: imageBaseDirCompartment.reconfigure(
          imageBaseDirFacet.of(imageBaseDir ?? ''),
        ),
      });
    }, [isMarkdown, imageBaseDir, imageBaseDirCompartment]);

    // readOnly 切换 → 通过 Compartment.reconfigure 在 EditorView 内运行时改写,
    // 不销毁 view、不重建 DOM,scrollTop 自然保留。配合父组件移除 key 里的
    // editMode,实现"代码文件预览↔编辑切换 不掉滚动位置"。
    useEffect(() => {
      const view = cmViewRef.current;
      if (!view) return;
      view.dispatch({
        effects: editableCompartment.reconfigure(EditorView.editable.of(!readOnly)),
      });
    }, [readOnly, editableCompartment]);

    return (
      // select-text:globals.css 全局禁了文本选中,CodeMirror 内部的 .cm-scroller /
      // 选区高亮层等非 contenteditable 元素不加这个会出现选中延迟、双击选词偶尔不
      // 高亮等问题。.select-text * 会递归生效到所有内部 div。
      <div
        ref={cmContainerRef}
        className={cn('select-text flex min-h-0 flex-1 flex-col overflow-auto', className)}
      />
    );
  },
);
