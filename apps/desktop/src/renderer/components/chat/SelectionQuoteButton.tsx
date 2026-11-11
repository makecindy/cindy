import { Button } from '@/components/ui/button';
/**
 * SelectionQuoteButton — 聊天消息流的"选中文字 → 添加到对话"浮动按钮。
 *
 * 交互(对标图片标注的"发送到对话"心智):在消息流([data-scroll-container])
 * 内选中任意文字,选区上方浮出胶囊按钮;点击把选中文本追加进当前会话草稿的
 * 正文(composerDraftStore.appendQuoteToDraft,非 silent → ChatInput 立即插入
 * 引用块并把光标放到其后),随后清除选区、按钮消失。
 *
 * 实现要点:
 * - selectionchange 只负责"选区塌缩就隐藏";按钮定位在 mouseup 时计算一次
 *   (选区定型后),不随滚动跟随——消息流滚动会触发 scroll 隐藏,避免按钮
 *   悬在错位处。
 * - 按钮用 onMouseDown preventDefault:点击瞬间浏览器默认会先清除选区,
 *   否则 click 时 selection 已空拿不到文本。
 * - portal 到 body,fixed 定位;z-index 低于 lightbox(9999),高于消息流。
 * - 宿主不限于聊天流:文件浏览器(FileBodyView)以自己的正文容器 + 当前
 *   文件相对路径复用同一交互,引用随消息携带来源文件。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquarePlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ChatQuote } from '@/lib/chatQuotes';
import { appendQuoteToDraft } from '@/lib/composerDraftStore';
import { CHAT_SELECTION_EXCLUDE_SELECTOR, hasChatSelectionGap, isChatSelectionRow } from './chatSelectionClipboard';

/** 单条引用的长度上限:防止误选整篇转录把 prompt 撑爆;超出截断并加省略号。 */
const QUOTE_MAX_CHARS = 4000;

interface SelectionAnchor {
  text: string;
  x: number;
  y: number;
  placement: 'above' | 'below';
}

const BUTTON_GAP_PX = 8;
const BUTTON_HEIGHT_ESTIMATE_PX = 28;
const BUTTON_MIN_TOP_PX = 44;
// The fixed-position element's auto width is otherwise shrink-to-fit from its
// untransformed `left` edge. Keep a full pill-width clearance on both sides:
// the visual centering transform does not participate in that calculation.
const BUTTON_EDGE_MARGIN_PX = 8;

interface RectBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getSelectionDirection(selection: Selection): 'forward' | 'backward' {
  if (!selection.anchorNode || !selection.focusNode) return 'forward';
  if (selection.anchorNode === selection.focusNode) {
    return selection.focusOffset >= selection.anchorOffset ? 'forward' : 'backward';
  }

  const position = selection.anchorNode.compareDocumentPosition(selection.focusNode);
  if (position & Node.DOCUMENT_POSITION_FOLLOWING) return 'forward';
  if (position & Node.DOCUMENT_POSITION_PRECEDING) return 'backward';
  return 'forward';
}

function getRectBounds(rects: readonly DOMRect[]): RectBounds | null {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  for (const rect of rects) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }

  if (
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    !Number.isFinite(right) ||
    !Number.isFinite(bottom)
  ) {
    return null;
  }

  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

function getFloatingAnchor(selection: Selection, range: Range): Omit<SelectionAnchor, 'text'> | null {
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 && rect.height > 0,
  );
  if (rects.length === 0) return null;

  const bounds = getRectBounds(rects);
  if (!bounds) return null;

  const direction = getSelectionDirection(selection);
  const edgeRect = direction === 'forward' ? rects[rects.length - 1] : rects[0];
  if (!edgeRect) return null;

  const edgeMiddleY = edgeRect.top + edgeRect.height / 2;
  const boundsMiddleY = bounds.top + bounds.height / 2;
  const canPlaceAbove =
    edgeRect.top - BUTTON_GAP_PX - BUTTON_HEIGHT_ESTIMATE_PX >= BUTTON_MIN_TOP_PX;
  const canPlaceBelow =
    edgeRect.bottom + BUTTON_GAP_PX + BUTTON_HEIGHT_ESTIMATE_PX <= window.innerHeight;
  const placement =
    edgeMiddleY > boundsMiddleY && canPlaceBelow ? 'below' : canPlaceAbove ? 'above' : 'below';

  return {
    x: direction === 'forward' ? edgeRect.right : edgeRect.left,
    y: placement === 'above' ? edgeRect.top : edgeRect.bottom,
    placement,
  };
}

// Message rows contain source labels, timestamps, controls and hidden measurement
// text as well as the sent body. Filter those nodes without changing the live
// selection (including ranges crossing into the following assistant reply).
function readQuoteText(selection: Selection, range: Range): string {
  const scopeSelector = '[data-selection-quote-scope]';
  const bodySelector = '[data-selection-quote-body]';
  const common = range.commonAncestorContainer;
  const element = common instanceof Element ? common : common.parentElement;
  if (!element) return '';
  // Preserve Chromium's serialization for body-only selections and other hosts
  // such as file previews. Only mixed/scoped selections need DOM filtering.
  if (element.closest(bodySelector) || (
    !element.closest(scopeSelector)
    && !Array.from(element.querySelectorAll(scopeSelector)).some(node => range.intersectsNode(node))
  )) return selection.toString();

  let text = '';
  let pendingBreaks = 0;
  let pendingSpace = false;
  let tableRow: { separator: string; inCell: boolean } | null = null;
  const selectability = new WeakMap<Element, boolean>();
  const canSelect = (el: Element): boolean => {
    const cached = selectability.get(el);
    if (cached !== undefined) return cached;
    const value = getComputedStyle(el).userSelect;
    // auto follows the parent's used value; an explicit text/all descendant
    // can restore selection inside a non-selectable ancestor.
    const selectable = value === 'none' ? false
      : value === 'text' || value === 'all' || !el.parentElement ? true : canSelect(el.parentElement);
    selectability.set(el, selectable);
    return selectable;
  };
  const append = (value: string) => {
    if (!value) return;
    if (text && pendingBreaks) {
      const trailing = text.match(/\n*$/)![0].length;
      const leading = value.match(/^\n*/)![0].length;
      text += '\n'.repeat(Math.max(0, pendingBreaks - trailing - leading));
    }
    // Commit cell separators only when more selected cell content follows.
    // Empty intervening cells retain their columns; row-end separators expire.
    if (tableRow?.inCell) {
      text += tableRow.separator;
      tableRow.separator = '';
    }
    if (pendingSpace && text && !/\s$/.test(text) && !/^\s/.test(value)) text += ' ';
    text += value;
    pendingBreaks = 0;
    pendingSpace = false;
  };
  const visit = (node: Node, parentStyle?: CSSStyleDeclaration) => {
    if (!range.intersectsNode(node)) return;
    const el = node instanceof Element ? node : node.parentElement;
    if (!el) return;
    if (el.closest(CHAT_SELECTION_EXCLUDE_SELECTOR)) return;
    if (el.closest(scopeSelector) && !el.closest(bodySelector) && !el.querySelector(bodySelector)) return;
    if (node.nodeType === Node.TEXT_NODE) {
      if (!canSelect(el)) return;
      const value = node.textContent ?? '';
      append(value.slice(node === range.startContainer ? range.startOffset : 0,
        node === range.endContainer ? range.endOffset : value.length));
      return;
    }
    if (!(node instanceof Element)) return;
    // KaTeX's clipped accessibility tree duplicates its visible glyphs. Keep
    // only the visual range, so a partial formula stays partial. Native fields
    // hold interactive state/options, not selected prose (as in chat copy).
    if (node.matches('.katex-mathml, input, textarea, select')) return;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    if (node.tagName === 'BR') { if (canSelect(node)) append('\n'); return; }
    // Keep paragraph/list/table boundaries and preformatted whitespace when a
    // cross-message selection is rebuilt. Range.toString() alone joins blocks.
    // Flex/grid blockification must not turn inline labels/values into lines.
    const rowItem = style.display === 'block' && parentStyle && isChatSelectionRow(parentStyle);
    const breaks = node.tagName === 'P' ? 2 : rowItem ? 0
      : /^(block|flex|grid|list-item|table|table-row)$/.test(style.display) ? 1 : 0;
    const outerRow = tableRow;
    if (style.display === 'table-row') tableRow = { separator: '', inCell: false };
    if (style.display === 'table-cell' && tableRow) tableRow.inCell = true;
    pendingBreaks = Math.max(pendingBreaks, breaks);
    if (node.tagName === 'DETAILS' && !node.hasAttribute('open')) {
      // Closed disclosures render only their first direct summary. Their other
      // descendants can still report normal display/visibility in computed style.
      const summary = Array.from(node.children).find(child => child.tagName === 'SUMMARY');
      if (summary) visit(summary, style);
    } else if (hasChatSelectionGap(style) && !node.closest('.katex-html')) {
      const outerSpace = pendingSpace;
      let selectedChild = false;
      node.childNodes.forEach(child => {
        const before = text.length;
        pendingSpace ||= selectedChild;
        visit(child, style);
        selectedChild ||= text.length > before;
      });
      // A gap belongs between selected children, never after the last one.
      pendingSpace = selectedChild ? false : outerSpace;
    } else {
      node.childNodes.forEach(child => visit(child, style));
    }
    pendingBreaks = Math.max(pendingBreaks, breaks);
    if (style.display === 'table-cell' && tableRow) {
      if (canSelect(node)) tableRow.separator += '\t';
      tableRow.inCell = false;
    }
    tableRow = outerRow;
  };
  visit(common, common.parentElement ? getComputedStyle(common.parentElement) : undefined);
  return text;
}

export function SelectionQuoteButton({
  sessionId,
  containerRef,
  sourcePath,
  getQuoteText,
  getQuoteMetadata,
  onAskInSideChat,
}: {
  onAskInSideChat?: (quote: string) => Promise<boolean>;
  sessionId: string;
  /**
   * 引用来源文件(workdir 相对路径)。文件浏览器宿主传入;聊天消息流不传。
   * 带来源的引用发送时携带 `— source:` 行,模型可 Read 上下文 / 精准编辑。
   */
  sourcePath?: string;
  /** Optional raw text source override; file bodies use the CodeMirror document slice. */
  getQuoteText?: () => string | null;
  /** Optional file/editor metadata to attach to the quote. */
  getQuoteMetadata?: () => Pick<ChatQuote, 'startLine' | 'endLine'> | null;
  /**
   * 本按钮所属消息流的滚动容器。判定选区归属必须用**自己的**容器——协同
   * 模式下多个聊天流(lead + workers)同时挂载,各有一个本组件实例;若用
   * 全局 querySelector 找第一个容器,选区会被错误实例认领,引用就加进了
   * 别的会话的输入框。绑定自己的容器后,选区落在哪个流,只有那个流的
   * 按钮出现,append 的 sessionId 必然正确。
   */
  containerRef: React.RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<SelectionAnchor | null>(null);
  const [openingSideChat, setOpeningSideChat] = useState(false);
  const pillRef = useRef<HTMLDivElement>(null);
  const [pillWidth, setPillWidth] = useState(200);
  useLayoutEffect(() => {
    if (anchor && pillRef.current) setPillWidth(pillRef.current.getBoundingClientRect().width);
  }, [anchor, openingSideChat, onAskInSideChat, t]);
  const anchorRef = useRef<SelectionAnchor | null>(null);
  anchorRef.current = anchor;

  const commitQuote = useCallback((selectionAnchor: SelectionAnchor) => {
    const text =
      selectionAnchor.text.length > QUOTE_MAX_CHARS
        ? `${selectionAnchor.text.slice(0, QUOTE_MAX_CHARS)}…`
        : selectionAnchor.text;
    const metadata = getQuoteMetadata?.() ?? null;
    appendQuoteToDraft(
      sessionId,
      sourcePath ? { text, sourcePath, ...(metadata ?? {}) } : { text },
    );
    window.getSelection()?.removeAllRanges();
    setAnchor(null);
  }, [getQuoteMetadata, sessionId, sourcePath]);

  useEffect(() => {
    // Position follows the actual selected text edge, not the mouse-up point. This keeps
    // the button attached to the selection even if the pointer is released outside it.
    const readSelectionInStream = (): SelectionAnchor | null => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
      const container = containerRef.current;
      if (!container) return null;
      const range = sel.getRangeAt(0);
      // 选区必须整体落在消息流容器内(输入框/侧栏里的选中不触发)。
      if (
        !container.contains(range.startContainer) ||
        !container.contains(range.endContainer)
      ) {
        return null;
      }
      const raw = getQuoteText?.() ?? readQuoteText(sel, range);
      if (!raw.trim()) return null;
      // 前导**缩进空格**必须保留:空白敏感代码(FileBodyView 选中缩进行)的
      // 引用要与文件原文逐字符一致,模型才能按引用文本定位 / 精准编辑。但前
      // 导 / 尾部**换行**要剥:对定位无意义,且以换行开头的引用会让
      // formatQuoteForSend 的首行产出裸 `>`,引用解析的 `> ` 守卫会失配。
      // trim 仅用于上面的空选区判定。
      const text = raw.replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, '');
      const floatingAnchor = getFloatingAnchor(sel, range);
      if (!floatingAnchor) return null;

      return { text, ...floatingAnchor };
    };

    const onMouseUp = () => {
      // 松手后 selection 需要一帧定型(双击选词等场景)。
      requestAnimationFrame(() => setAnchor(readSelectionInStream()));
    };
    const onSelectionChange = () => {
      // 只负责"选区没了就藏"——避免每次拖动扩选都重算位置导致按钮乱跳。
      const sel = window.getSelection();
      if ((!sel || sel.isCollapsed) && anchorRef.current) setAnchor(null);
    };
    const onScrollOrResize = () => {
      if (anchorRef.current) setAnchor(null);
    };
    const container = containerRef.current;
    if (container) container.dataset.selectionQuoteContext = '';
    const unsubscribeAddToChat = window.electronAPI.onSelectionContextMenuAddToChat(() => {
      const currentSelection = readSelectionInStream();
      if (currentSelection) commitQuote(currentSelection);
    });
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('selectionchange', onSelectionChange);
    // capture:消息流滚动事件不冒泡到 document,用捕获段拿到。
    document.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
      unsubscribeAddToChat();
      if (container?.dataset.selectionQuoteContext === '') {
        delete container.dataset.selectionQuoteContext;
      }
    };
  }, [commitQuote, containerRef, getQuoteText]);

  if (!anchor) return null;

  const handleAdd = () => {
    commitQuote(anchor);
  };

  return createPortal(
    <div
      ref={pillRef}
      // mousedown 先于 click 触发浏览器清选区;preventDefault 保住选区与按钮。
      onMouseDown={(e) => e.preventDefault()}
      className="fixed z-[60] flex w-max max-w-[calc(100vw-16px)] flex-wrap justify-center gap-1 rounded-full bg-popover p-1 shadow-[shadow:var(--shadow-menu)]"
      style={{
        left: clamp(anchor.x, pillWidth / 2 + BUTTON_EDGE_MARGIN_PX, window.innerWidth - pillWidth / 2 - BUTTON_EDGE_MARGIN_PX),
        top:
          anchor.placement === 'above'
            ? Math.max(anchor.y - BUTTON_GAP_PX, BUTTON_MIN_TOP_PX)
            : Math.min(
                anchor.y + BUTTON_GAP_PX,
                Math.max(
                  BUTTON_MIN_TOP_PX,
                  window.innerHeight - BUTTON_HEIGHT_ESTIMATE_PX - BUTTON_GAP_PX,
                ),
              ),
        transform: anchor.placement === 'above' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
      }}
    >
      <Button variant="secondary" size="sm" compact type="button" onClick={handleAdd}>
        <MessageSquarePlus className="h-3.5 w-3.5" />
        {t('chat.quote.addToChat')}
      </Button>
      {onAskInSideChat && <Button variant="secondary" size="sm" compact type="button" disabled={openingSideChat}
        onClick={async () => {
          setOpeningSideChat(true);
          try {
            if (await onAskInSideChat(anchor.text.slice(0, QUOTE_MAX_CHARS))) {
              window.getSelection()?.removeAllRanges();
              setAnchor(null);
            }
          } finally { setOpeningSideChat(false); }
        }}>
        {t(openingSideChat ? 'chat.sideChat.opening' : 'chat.sideChat.title')}
      </Button>}
    </div>,
    document.body,
  );
}
