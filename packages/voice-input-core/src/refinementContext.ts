// Keep one history budget across hosts. Append to the old-to-new prompt prefix
// until the high watermark, then leave room for more dictations after compaction.
// The desktop budget was reduced after its 2026-06-21–07-04 log audit: increasing
// history from 33k to 96k chars did not improve acceptance or terminology fixes.
export const VOICE_INPUT_HISTORY_COMPACT_CHARS = 12_000;
export const VOICE_INPUT_HISTORY_COMPACT_TARGET_CHARS = 8_000;
export const VOICE_INPUT_HISTORY_COMPACT_KEEP_ENTRIES = 40;
export const MAX_REFINEMENT_HISTORY_ITEM_CHARS = 360;
export const VOICE_INPUT_HISTORY_HEADER = '语音输入历史（旧到新，仅作术语、别名和用词风格参考）：';
export const MAX_REFINEMENT_SIDE_CONTEXT_CHARS = 1_200;
export const MAX_REFINEMENT_REPLY_TO_MESSAGE_CHARS = 500;

export function normalizeVoiceHistoryText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_REFINEMENT_HISTORY_ITEM_CHARS).trim();
}

export function estimateVoiceInputHistoryContextChars(entries: ReadonlyArray<{ text: string }>): number {
  const texts = entries.map((entry) => normalizeVoiceHistoryText(entry.text)).filter(Boolean);
  return texts.length === 0 ? 0 : texts.reduce((total, text) => total + 3 + text.length, VOICE_INPUT_HISTORY_HEADER.length);
}

/** Entries are newest first. Preserve identity and ordering below the budget. */
export function compactVoiceInputHistoryIfNeeded<T extends { text: string }>(entries: T[]): T[] {
  if (estimateVoiceInputHistoryContextChars(entries) <= VOICE_INPUT_HISTORY_COMPACT_CHARS) return entries;
  const recent = entries.slice(0, VOICE_INPUT_HISTORY_COMPACT_KEEP_ENTRIES);
  while (recent.length > 1 && estimateVoiceInputHistoryContextChars(recent) > VOICE_INPUT_HISTORY_COMPACT_TARGET_CHARS) {
    recent.pop();
  }
  return recent;
}

export function formatVoiceInputHistoryContext(entries: ReadonlyArray<{ text: string }>): string {
  const texts = compactVoiceInputHistoryIfNeeded([...entries])
    .map((entry) => normalizeVoiceHistoryText(entry.text))
    .filter(Boolean)
    .reverse();
  return texts.length === 0 ? '' : [VOICE_INPUT_HISTORY_HEADER, ...texts.map((text) => `- ${text}`)].join('\n');
}

// Cursor-adjacent whitespace is meaningful: a trailing newline or indentation
// describes the insertion point. Only normalize line endings, never trim it.
export function takeRefinementContextHead(text: string, maxChars = MAX_REFINEMENT_SIDE_CONTEXT_CHARS): string {
  return text.replace(/\r\n?/g, '\n').slice(0, maxChars);
}

export function takeRefinementContextTail(text: string, maxChars = MAX_REFINEMENT_SIDE_CONTEXT_CHARS): string {
  return maxChars > 0 ? text.replace(/\r\n?/g, '\n').slice(-maxChars) : '';
}

/** Keep the opening subject and closing question, with an explicit omission. */
export function truncateRefinementReply(text: string, maxChars = MAX_REFINEMENT_REPLY_TO_MESSAGE_CHARS): string {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (normalized.length <= maxChars) return normalized;
  const separator = '\n…\n';
  if (maxChars <= separator.length) return normalized.slice(0, Math.max(0, maxChars));
  const headChars = Math.floor((maxChars - separator.length) / 2);
  const tailChars = maxChars - separator.length - headChars;
  return `${normalized.slice(0, headChars)}${separator}${normalized.slice(-tailChars)}`;
}
