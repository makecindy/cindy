/** Positions use UTF-16 offsets in the rendered text, scoped to one immutable response. */
export interface MessageAnnotationAnchor {
  messageClientId: string;
  sourceVersion: string;
  start: number;
  end: number;
  quote: string;
  prefix: string;
  suffix: string;
}

export interface MessageAnnotation extends MessageAnnotationAnchor {
  id: string;
  sessionId: string;
  ordinal: number;
  comment: string;
  createdAt: number;
  sentAt: number | null;
  /** Reserved by a queued/in-flight input; cancellation releases the reservation. */
  queued?: boolean;
}

export type MessageAnnotationRequest =
  | { action: 'list'; sessionId: string }
  | { action: 'add'; sessionId: string; anchor: MessageAnnotationAnchor; comment: string }
  | { action: 'remove'; sessionId: string; id: string };

const ANNOTATION_START = '<!-- cindy:message-annotations:v1 -->';
const ANNOTATION_END = '<!-- /cindy:message-annotations -->';

/** Read only the bounded, versioned envelope produced by the composer. Quotes remain data. */
export function sentMessageAnnotationSnapshots(content: unknown): Array<{ annotationId: string; quote: string; reply: string; responseVersion: string; number?: number }> {
  const text = typeof content === 'string' ? content
    : content && typeof content === 'object' && 'text' in content && typeof content.text === 'string' ? content.text : '';
  const opening = `\n${ANNOTATION_START}\n`, closing = `\n${ANNOTATION_END}`;
  const start = text.lastIndexOf(opening), end = text.lastIndexOf(closing);
  if (start < 0 || end <= start || end - start > 4_000_000) return [];
  try {
    const data: unknown = JSON.parse(text.slice(start + opening.length, end).trim());
    if (!Array.isArray(data) || data.length > 1000) return [];
    return data.filter(value => value && typeof value.annotationId === 'string' && typeof value.quote === 'string'
      && typeof value.reply === 'string' && typeof value.responseVersion === 'string');
  } catch { return []; }
}

export function messageAnnotationPresentation(text: string) {
  // Editing a sent message may append ordinary text after the envelope. Keep
  // that full message visible rather than silently hiding the user's new reply.
  if (!text.trimEnd().endsWith(ANNOTATION_END)) return null;
  const annotations = sentMessageAnnotationSnapshots(text);
  const heading = text.lastIndexOf('## 对 AI 回答的批注\n');
  if (!annotations.length || heading < 0) return null;
  return { text: text.slice(0, heading).trimEnd(), annotations };
}

/** A revision guard, not an authorization token. Identity is always session + clientId. */
export function annotationSourceVersion(text: string): string {
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 0x01000193);
    b = Math.imul(b ^ text.charCodeAt(i), 0x85ebca6b);
  }
  return `${text.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
}

export function annotationMatchesText(anchor: MessageAnnotationAnchor, text: string): boolean {
  return text.slice(anchor.start, anchor.end) === anchor.quote
    && text.slice(Math.max(0, anchor.start - anchor.prefix.length), anchor.start) === anchor.prefix
    && text.slice(anchor.end, anchor.end + anchor.suffix.length) === anchor.suffix;
}

export function formatMessageAnnotationsForSend(text: string, annotations: readonly MessageAnnotation[]): string {
  if (!annotations.length) return text;
  // JSON keeps quote boundaries unambiguous even when a comment contains Markdown fences.
  const evidence = annotations.map(({ id, messageClientId, sourceVersion, ordinal, start, end, quote, prefix, suffix, comment }) => ({
    annotationId: id, messageClientId, responseVersion: sourceVersion, number: ordinal,
    renderedTextRange: { start, end, unit: 'UTF-16' }, quote, precedingText: prefix, followingText: suffix,
    reply: comment,
  }));
  return [text, '## 对 AI 回答的批注\n请逐条处理下面的用户批注。quote 是被批注的原文，reply 是用户对此处的回复；消息 ID、位置及前后文用于区分重复文字。\n'
    + ANNOTATION_START + '\n' + JSON.stringify(evidence, null, 2) + '\n' + ANNOTATION_END].filter(Boolean).join('\n\n');
}
