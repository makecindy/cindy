/**
 * 导入外部工具历史时对用户消息正文的通用清理（Claude Code / Codex 适配器共用）。
 */

const IDE_OPENED_FILE_OPEN_TAG = '<ide_opened_file>';
const IDE_OPENED_FILE_CLOSE_TAG = '</ide_opened_file>';

/**
 * Remove complete Claude IDE context blocks from imported user text.
 *
 * Malformed or unclosed blocks are preserved. This intentionally uses a
 * deterministic scanner instead of a broad XML-like regex so one broken open
 * tag cannot consume later real user input or a separate valid block.
 */
export function stripCompleteIdeOpenedFileBlocks(text: string): string {
  let cursor = 0;
  let output = '';

  while (cursor < text.length) {
    const openIndex = text.indexOf(IDE_OPENED_FILE_OPEN_TAG, cursor);
    if (openIndex < 0) return output + text.slice(cursor);

    const contentStart = openIndex + IDE_OPENED_FILE_OPEN_TAG.length;
    const closeIndex = text.indexOf(IDE_OPENED_FILE_CLOSE_TAG, contentStart);
    if (closeIndex < 0) return output + text.slice(cursor);

    const nestedOpenIndex = text.indexOf(IDE_OPENED_FILE_OPEN_TAG, contentStart);
    if (nestedOpenIndex >= 0 && nestedOpenIndex < closeIndex) {
      output += text.slice(cursor, nestedOpenIndex);
      cursor = nestedOpenIndex;
      continue;
    }

    output += text.slice(cursor, openIndex);
    output += '\n';
    cursor = closeIndex + IDE_OPENED_FILE_CLOSE_TAG.length;
  }

  return output;
}
