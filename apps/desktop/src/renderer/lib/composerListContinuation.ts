import type { EditorView } from '@tiptap/pm/view';
import type { ResolvedPos } from '@tiptap/pm/model';

/**
 * Composer 纯文本 Markdown 列表的兼容接续。结构化 bullet / ordered list
 * 由编辑器 schema 处理；本模块继续覆盖粘贴或旧草稿中的文本前缀，以及尚未
 * 结构化的待办和引用前缀。Shift/Alt+Enter 接续或退出当前项，普通 Enter
 * 始终保持发送语义。
 */

export type ListContinuation =
  | { action: 'continue'; insert: string }
  | { action: 'exit' };

export interface ListPrefixMatch {
  /** 前缀(含缩进与其后空白)在行内占据的长度。 */
  prefixLength: number;
  /** 换行后应插入的下一个前缀(缩进 / 分隔符 / 空白与当前行保持一致)。 */
  nextPrefix: string;
}

// 顺序敏感:checkbox 必须先于 bullet 匹配(`- [ ] ` 也满足 bullet 的模式)。
// checkbox 允许行在 `]` 处截止(`(\s+|$)`),这样 "- [ ]" 也能识别成空项退出。
const CHECKBOX_RE = /^(\s*)([-+*])(\s+)\[[ xX]\](\s+|$)/;
const BULLET_RE = /^(\s*)([-+*•])(\s+)/;
const ORDERED_RE = /^(\s*)(\d{1,9})([.)])(\s+)/;
// 中文顿号序号(`1、`)不要求后随空格,符合中文输入习惯。
const ORDERED_CJK_RE = /^(\s*)(\d{1,9})(、)(\s*)/;
const QUOTE_RE = /^(\s*)(>)(\s+)/;

/**
 * 匹配行首的列表 / 待办 / 引用前缀。除列表接续外,也被 composer 的列表行
 * 缩进 decoration(ComposerListIndentDecoration)复用来判断"这行是列表项"。
 */
export function matchListPrefix(line: string): ListPrefixMatch | null {
  let m = line.match(CHECKBOX_RE);
  if (m) {
    // 新项永远是未勾选态;`]` 后无空白(行尾截止)时补一个空格。
    return {
      prefixLength: m[0].length,
      nextPrefix: `${m[1]}${m[2]}${m[3]}[ ]${m[4] || ' '}`,
    };
  }
  m = line.match(BULLET_RE);
  if (m) return { prefixLength: m[0].length, nextPrefix: m[0] };
  m = line.match(ORDERED_RE);
  if (m) {
    return {
      prefixLength: m[0].length,
      nextPrefix: `${m[1]}${Number(m[2]) + 1}${m[3]}${m[4]}`,
    };
  }
  m = line.match(ORDERED_CJK_RE);
  if (m) {
    return {
      prefixLength: m[0].length,
      nextPrefix: `${m[1]}${Number(m[2]) + 1}${m[3]}${m[4]}`,
    };
  }
  m = line.match(QUOTE_RE);
  if (m) return { prefixLength: m[0].length, nextPrefix: m[0] };
  return null;
}

/**
 * 根据"光标前的当前行文本"决定换行行为:
 * - `null`      → 不是列表行,走默认换行。
 * - `continue`  → 插入换行 + `insert` 前缀。
 * - `exit`      → 当前项为空,调用方应删除光标前的整段行文本(即前缀)退出列表。
 *
 * 行文本中的原子节点(mention chip 等)由调用方以 U+FFFC 占位表示——行首是
 * chip 时天然匹配不上任何前缀,无需特判。
 */
export function computeListContinuation(
  lineBeforeCaret: string,
  lineAfterCaret = '',
): ListContinuation | null {
  const match = matchListPrefix(lineBeforeCaret);
  if (!match) return null;
  const rest = lineBeforeCaret.slice(match.prefixLength);
  // 空项判定看**整行**(光标前 rest + 光标后正文):否则 `1. |todo`(光标在标记后、
  // 正文前)会被当成空项退出、删掉标记留下裸 "todo"。光标后仍有正文时
  // 走 continue —— 在光标处插换行 + 下一前缀,把 "todo" 顺成下一项(拆分列表)。
  if (rest.trim().length === 0 && lineAfterCaret.trim().length === 0) return { action: 'exit' };
  return { action: 'continue', insert: match.nextPrefix };
}

/**
 * 提取光标所在"行"里、光标之前的文本与行起点(段落内以 hardBreak 划分行)。
 * 原子节点(mention chip 等)以 U+FFFC 占位——行首是 chip 时天然匹配不上
 * 任何前缀,无需特判。lineStartOffset 是相对段落内容起点的 offset。
 */
function scanCaretLine($from: ResolvedPos): {
  lineText: string;
  lineStartOffset: number;
  lineAfter: string;
} {
  let lineText = '';
  let lineStartOffset = 0;
  $from.parent.nodesBetween(0, $from.parentOffset, (node, pos) => {
    if (node.type.name === 'hardBreak') {
      lineText = '';
      lineStartOffset = pos + node.nodeSize;
    } else if (node.isText) {
      lineText += (node.text ?? '').slice(0, $from.parentOffset - pos);
    } else {
      lineText += '\uFFFC';
    }
    return false;
  });
  // \u5149\u6807\u540E\u3001\u5230\u672C\u884C\u672B(\u4E0B\u4E00\u4E2A hardBreak \u6216\u6BB5\u843D\u672B)\u4E4B\u95F4\u7684\u6587\u672C \u2014\u2014 \u4F9B\u7A7A\u9879\u5224\u5B9A\u770B\u6574\u884C\u3002
  let lineAfter = '';
  let stopped = false;
  $from.parent.nodesBetween($from.parentOffset, $from.parent.content.size, (node, pos) => {
    if (stopped) return false;
    if (node.type.name === 'hardBreak') {
      stopped = true;
      return false;
    }
    if (node.isText) {
      lineAfter += (node.text ?? '').slice(Math.max(0, $from.parentOffset - pos));
    } else {
      lineAfter += '\uFFFC';
    }
    return false;
  });
  return { lineText, lineStartOffset, lineAfter };
}

/**
 * 在 ProseMirror view 上执行列表接续。返回 true 表示已处理(调用方应消费
 * 该按键),false 表示当前行不是列表项(调用方走原有行为:换行或发送)。
 */
export function applyListContinuation(view: EditorView): boolean {
  const { state } = view;
  if (!state.selection.empty) return false;
  const $from = state.selection.$from;
  if (!$from.parent.isTextblock) return false;

  const { lineText, lineStartOffset, lineAfter } = scanCaretLine($from);
  const continuation = computeListContinuation(lineText, lineAfter);
  if (!continuation) return false;

  if (continuation.action === 'exit') {
    // 空项:删除光标前的整段前缀(含缩进),退出列表。
    const lineStartAbs = $from.start() + lineStartOffset;
    view.dispatch(state.tr.delete(lineStartAbs, $from.pos).scrollIntoView());
    return true;
  }

  const hardBreak = state.schema.nodes.hardBreak;
  if (!hardBreak) return false;
  const tr = state.tr.replaceSelectionWith(hardBreak.create(), false);
  tr.insertText(continuation.insert);
  view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * 空列表项整体回删:当前行只剩前缀(如 "2. ")且光标在行尾时,
 * 一次 Backspace 删掉整个前缀——有上一行则连同前面的换行一起删,光标落到
 * 上一行行尾;是首行则只删前缀(等效退出列表)。其余情况返回 false,调用方
 * 走默认退格。
 */
export function applyListBackspace(view: EditorView): boolean {
  const { state } = view;
  if (!state.selection.empty) return false;
  const $from = state.selection.$from;
  if (!$from.parent.isTextblock) return false;

  // 光标必须在行尾:后面要么是段落末尾,要么紧跟 hardBreak。
  const after = $from.nodeAfter;
  if (after && after.type.name !== 'hardBreak') return false;

  const { lineText, lineStartOffset } = scanCaretLine($from);
  const match = matchListPrefix(lineText);
  if (!match) return false;
  // 前缀后还有内容 → 正常退格(一个字符一个字符删)。
  if (lineText.slice(match.prefixLength).trim().length > 0) return false;

  const lineStartAbs = $from.start() + lineStartOffset;
  // 非首行连同前面的 hardBreak(占 1 个 position)一起删。
  const deleteFrom = lineStartOffset > 0 ? lineStartAbs - 1 : lineStartAbs;
  view.dispatch(state.tr.delete(deleteFrom, $from.pos).scrollIntoView());
  return true;
}
