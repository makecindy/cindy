import { computeListContinuation, matchListPrefix } from './composerListContinuation';

/**
 * Composer 列表接续的**原生 textarea 适配层**(纯字符串逻辑,无 DOM 依赖)。
 *
 * `composerListContinuation.ts` 里的核心匹配(matchListPrefix /
 * computeListContinuation)是编辑器无关的纯文本函数;那份文件另有一套绑定
 * ProseMirror(tiptap)的 apply* 适配,供主 composer ChatInput 使用。这里是
 * 第二套适配:面向 `<textarea>` 的 `value` + 光标 offset,让所有原生 textarea
 * 型输入框(二次编辑框、新建目标、待发队列……)复用同一套列表行为,无需各自
 * 重写逻辑。
 *
 * 与 tiptap 版的差异(纯文本框固有限制):textarea 做不了逐行 inline 缩进
 * 装饰,所以只提供"序号接续 + 空项退出",没有 ChatInput 那个整行缩进的视觉
 * 反馈;等宽对齐由消费组件挂 `tabular-nums` class 解决。
 */

/** 一次编辑的结果:替换后的完整文本 + 折叠后的新光标 offset。 */
export interface TextareaListEdit {
  value: string;
  /** 编辑后光标落点(selectionStart === selectionEnd)。 */
  caret: number;
}

/** 光标所在行的起点 offset(该行第一个字符的下标;行首无换行时为 0)。 */
function lineStartOffset(value: string, caret: number): number {
  return value.lastIndexOf('\n', caret - 1) + 1;
}

/**
 * Shift/Alt+Enter 在 textarea 里的列表接续。返回 null 表示当前行不是列表项
 * (调用方应放行默认换行);否则返回替换后的文本与新光标。
 *
 * - continue:在光标处插入 `\n` + 下一个前缀(有序列表序号 +1)。
 * - exit(空项):删掉当前行光标前的整段前缀,停在行首,退出列表。
 *
 * 仅在光标折叠(无选区)时生效——有选区时换行语义由默认行为处理。
 */
export function computeTextareaContinuation(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): TextareaListEdit | null {
  if (selectionStart !== selectionEnd) return null;
  const caret = selectionStart;
  const lineStart = lineStartOffset(value, caret);
  const lineBeforeCaret = value.slice(lineStart, caret);
  // 光标后到本行末的正文,一起参与空项判定(`1. |todo` 不算空项,见 computeListContinuation)。
  const lineEnd = value.indexOf('\n', caret);
  const lineAfterCaret = value.slice(caret, lineEnd === -1 ? value.length : lineEnd);

  const continuation = computeListContinuation(lineBeforeCaret, lineAfterCaret);
  if (!continuation) return null;

  if (continuation.action === 'exit') {
    // 空项:清掉光标前的整段前缀,光标回到行首(等效退出列表)。
    return {
      value: value.slice(0, lineStart) + value.slice(caret),
      caret: lineStart,
    };
  }

  const insert = `\n${continuation.insert}`;
  return {
    value: value.slice(0, caret) + insert + value.slice(caret),
    caret: caret + insert.length,
  };
}

/**
 * 空列表项退出(对齐 ChatInput):当前行只剩前缀(如 "2. ")且光标在行尾时,
 * 一次 Backspace 只删掉前缀(含缩进)、保留本行换行,光标停在行首;再按一次
 * 才走默认退格回到上一行。其余情况返回 null(走默认退格)。
 *
 * "行尾"= 光标后紧跟换行或已到文本末尾;仅光标折叠时生效。
 */
export function computeTextareaBackspace(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): TextareaListEdit | null {
  if (selectionStart !== selectionEnd) return null;
  const caret = selectionStart;

  // 光标必须在行尾:后面要么是换行,要么是文本末尾。
  const nextChar = value[caret];
  if (nextChar !== undefined && nextChar !== '\n') return null;

  const lineStart = lineStartOffset(value, caret);
  const line = value.slice(lineStart, caret);
  const match = matchListPrefix(line);
  if (!match) return null;
  // 前缀后还有内容 → 正常退格(逐字符删),不整删。
  if (line.slice(match.prefixLength).trim().length > 0) return null;

  return {
    value: value.slice(0, lineStart) + value.slice(caret),
    caret: lineStart,
  };
}
