// ── 长文本折叠阈值 ──
// 行数对齐消息气泡「长消息收起」的手打阈值(14 行)再放宽一档:短粘贴保持
// 直觉(所见即所得),真正的大段 log / diff 才折叠。字符阈值兜住"单行超长"
// (压缩 JSON / base64)。上限:原文会进节点 attrs 并随 toDOM 写进
// data-pasted-text(剪贴板回环依赖它,见 PastedTextChipNode),超大文本挂
// 在 DOM attribute 上代价过高——超限的粘贴不折叠,走默认粘贴(极罕见,
// 编辑器变慢但内容无损)。
export const LONG_PASTE_LINE_THRESHOLD = 24;
export const LONG_PASTE_CHAR_THRESHOLD = 4_000;
export const LONG_PASTE_MAX_CHARS = 2_000_000;

/** 粘贴文本是否该折叠成 PastedTextChip。 */
export function isLongPasteText(text: string): boolean {
  if (text.length > LONG_PASTE_MAX_CHARS) return false;
  if (text.length >= LONG_PASTE_CHAR_THRESHOLD) return true;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 && ++lines >= LONG_PASTE_LINE_THRESHOLD) return true;
  }
  return false;
}

/** 粘贴文本的行数(chip 文案用)。 */
export function countPasteLines(text: string): number {
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lines++;
  }
  return lines;
}
