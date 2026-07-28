import { stripChatQuoteMarkerLines } from './chatQuotes.js';
import { allDeepLinkSchemes } from './brandIdentity.js';

/** Maximum copied target-message text kept in one Composer reference. */
export const AGENT_MESSAGE_REFERENCE_MAX_CHARS = 12_000;

/** Common source range for a structured Composer reference. */
interface AgentInputReferenceBase {
  /** Offsets in the persisted/wire `text`, before quote-marker projection. */
  start: number;
  end: number;
  /** Cindy deep link retained only as stable location metadata. */
  href: string;
}

/** One message-anchor chip and the readable target message it represents. */
export interface AgentInputMessageReference extends AgentInputReferenceBase {
  kind: 'message';
  sessionId: string;
  messageClientId: string;
  /** Readable target body. Main may hydrate this before queue acceptance. */
  text?: string;
  truncated?: boolean;
}

/** One whole-session chip. It identifies a conversation; it does not imply transcript import. */
export interface AgentInputSessionReference extends AgentInputReferenceBase {
  kind: 'session';
  sessionId: string;
  title?: string;
}

/** One project chip with the decoded filesystem location. */
export interface AgentInputProjectReference extends AgentInputReferenceBase {
  kind: 'project';
  name: string;
  workingDir: string;
}

/** Structured Composer references preserved beside the human-facing wire text. */
export type AgentInputReference =
  | AgentInputMessageReference
  | AgentInputSessionReference
  | AgentInputProjectReference;

/** Immutable inputs required to derive the text sent to semantic consumers. */
export interface AgentFacingTextSource {
  text: string;
  quotesEncoded?: boolean;
  agentReferences?: readonly AgentInputReference[];
}

/** Bounded readable message text plus an explicit truncation bit. */
export interface BoundedAgentReferenceText {
  text: string;
  truncated: boolean;
}

/** Keep message-reference payloads bounded without using the compact UI label. */
export function boundAgentReferenceText(
  value: string,
  cap = AGENT_MESSAGE_REFERENCE_MAX_CHARS,
): BoundedAgentReferenceText {
  const text = value.trim();
  if (text.length <= cap) return { text, truncated: false };
  return { text: text.slice(0, cap), truncated: true };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function stripDeepLinkPrefix(href: string, route: 'session/' | 'project/'): string | null {
  for (const scheme of allDeepLinkSchemes()) {
    const prefix = `${scheme}://${route}`;
    if (href.startsWith(prefix)) return href.slice(prefix.length);
  }
  return null;
}

/** Remove a trailing slash run in one linear pass over untrusted deep-link input. */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

function parseSessionHref(
  href: string,
): { sessionId: string; messageClientId: string | null } | null {
  const rest = stripDeepLinkPrefix(href, 'session/');
  if (rest === null) return null;
  const hashIndex = rest.indexOf('#');
  const withoutHash = hashIndex >= 0 ? rest.slice(0, hashIndex) : rest;
  const queryIndex = withoutHash.indexOf('?');
  const rawSessionId = stripTrailingSlashes(
    queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash
  );
  if (!rawSessionId) return null;
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(rawSessionId);
  } catch {
    return null;
  }
  if (!sessionId) return null;
  let messageClientId: string | null = null;
  if (queryIndex >= 0) {
    const query = withoutHash.slice(queryIndex + 1);
    for (const pair of query.split('&')) {
      const equalsIndex = pair.indexOf('=');
      if (equalsIndex <= 0 || pair.slice(0, equalsIndex) !== 'message') continue;
      const rawMessageClientId = pair.slice(equalsIndex + 1);
      if (!rawMessageClientId) break;
      try {
        messageClientId = decodeURIComponent(rawMessageClientId) || null;
      } catch {
        messageClientId = null;
      }
      break;
    }
  }
  return { sessionId, messageClientId };
}

function parseProjectHref(href: string): { workingDir: string } | null {
  const rest = stripDeepLinkPrefix(href, 'project/');
  if (rest === null) return null;
  const hashIndex = rest.indexOf('#');
  const withoutHash = hashIndex >= 0 ? rest.slice(0, hashIndex) : rest;
  const queryIndex = withoutHash.indexOf('?');
  const rawWorkingDir = stripTrailingSlashes(
    queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash
  );
  if (!rawWorkingDir) return null;
  try {
    const workingDir = decodeURIComponent(rawWorkingDir);
    return workingDir ? { workingDir } : null;
  } catch {
    return null;
  }
}

function referenceSpanMatchesHref(span: string, href: string): boolean {
  return span === href || (
    span.startsWith('[')
    && span.endsWith(`](${href})`)
  );
}

function readReference(
  value: unknown,
  sourceText: string,
): AgentInputReference | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(candidate.start)
    || !Number.isSafeInteger(candidate.end)
    || !nonEmptyString(candidate.href)
  ) return null;
  const start = candidate.start as number;
  const end = candidate.end as number;
  if (start < 0 || end <= start || end > sourceText.length) return null;
  // The metadata must still point at the exact persisted deep-link span. This
  // rejects stale offsets after arbitrary queue edits instead of replacing
  // unrelated user text with a semantic block.
  if (!referenceSpanMatchesHref(sourceText.slice(start, end), candidate.href)) return null;

  if (candidate.kind === 'message') {
    const target = parseSessionHref(candidate.href);
    if (!target?.messageClientId) return null;
    return {
      kind: 'message',
      start,
      end,
      href: candidate.href,
      sessionId: target.sessionId,
      messageClientId: target.messageClientId,
      ...(typeof candidate.text === 'string' ? { text: candidate.text } : {}),
      ...(candidate.truncated === true ? { truncated: true } : {}),
    };
  }
  if (candidate.kind === 'session') {
    const target = parseSessionHref(candidate.href);
    if (!target || target.messageClientId) return null;
    return {
      kind: 'session',
      start,
      end,
      href: candidate.href,
      sessionId: target.sessionId,
      ...(nonEmptyString(candidate.title) ? { title: candidate.title } : {}),
    };
  }
  if (candidate.kind === 'project' && nonEmptyString(candidate.name)) {
    const target = parseProjectHref(candidate.href);
    if (!target) return null;
    return {
      kind: 'project',
      start,
      end,
      href: candidate.href,
      name: candidate.name,
      workingDir: target.workingDir,
    };
  }
  return null;
}

/** Validate untrusted persisted/remote reference metadata against its wire text. */
export function readAgentInputReferences(
  value: unknown,
  sourceText: string,
): AgentInputReference[] {
  if (!Array.isArray(value)) return [];
  const references = value
    .map((candidate) => readReference(candidate, sourceText))
    .filter((candidate): candidate is AgentInputReference => candidate !== null)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const nonOverlapping: AgentInputReference[] = [];
  let previousEnd = 0;
  for (const reference of references) {
    if (reference.start < previousEnd) continue;
    nonOverlapping.push(reference);
    previousEnd = reference.end;
  }
  return nonOverlapping;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function formatReference(reference: AgentInputReference): string {
  if (reference.kind === 'message') {
    const bounded = boundAgentReferenceText(reference.text ?? '');
    const truncated = reference.truncated === true || bounded.truncated;
    return [
      '[Referenced message]',
      `Session ID: ${reference.sessionId}`,
      `Message ID: ${reference.messageClientId}`,
      'Content:',
      bounded.text || '(message content unavailable)',
      ...(truncated ? ['[Content truncated]'] : []),
      '[/Referenced message]',
    ].join('\n');
  }
  if (reference.kind === 'session') {
    return [
      '[Referenced conversation]',
      `Title: ${oneLine(reference.title ?? '') || `Conversation ${reference.sessionId}`}`,
      `Session ID: ${reference.sessionId}`,
      '[/Referenced conversation]',
    ].join('\n');
  }
  return [
    '[Referenced project]',
    `Name: ${oneLine(reference.name)}`,
    `Working directory: ${reference.workingDir}`,
    '[/Referenced project]',
  ].join('\n');
}

function projectLiteralText(text: string, quotesEncoded: boolean): string {
  return quotesEncoded ? stripChatQuoteMarkerLines(text) : text;
}

/**
 * Derive immutable agent-facing text from Composer wire data.
 *
 * The persisted text remains untouched. Quote markers are removed only when
 * their persisted flag is true, while structured reference spans are replaced
 * in source order with readable semantic blocks.
 */
export function projectAgentFacingText(source: AgentFacingTextSource): string {
  const references = readAgentInputReferences(source.agentReferences, source.text);
  const stripMarkers = source.quotesEncoded === true;
  if (references.length === 0) return projectLiteralText(source.text, stripMarkers);

  const parts: string[] = [];
  let cursor = 0;
  for (const reference of references) {
    parts.push(projectLiteralText(source.text.slice(cursor, reference.start), stripMarkers));
    parts.push(formatReference(reference));
    cursor = reference.end;
  }
  parts.push(projectLiteralText(source.text.slice(cursor), stripMarkers));
  return parts.join('');
}

/**
 * 只取用户自己写下的正文:引用 span 被整段剔除(而不是像
 * {@link projectAgentFacingText} 那样替换成 `[Referenced ...]` 语义块),引用块
 * marker 行按 quotesEncoded 剥离。
 *
 * 用途是判定「这条消息里有没有真正可用于起名的文字」。会话/项目引用展开后的
 * 语义块是给模型看的机器格式,既不该出现在标题里,也不该被当成"用户打了字"
 * 的证据 —— 拿它去起名会得到 `[Referenced conversation] Title: ...` 这种标题,
 * 或让标题模型对着一坨元数据硬编。
 *
 * 注意:选中文字引用(blockquote)的正文**会**保留 —— 那是真实文字内容,可以
 * 起出有意义的标题。
 */
export function projectLiteralUserText(source: AgentFacingTextSource): string {
  const references = readAgentInputReferences(source.agentReferences, source.text);
  const stripMarkers = source.quotesEncoded === true;
  if (references.length === 0) return projectLiteralText(source.text, stripMarkers).trim();

  const parts: string[] = [];
  let cursor = 0;
  for (const reference of references) {
    parts.push(projectLiteralText(source.text.slice(cursor, reference.start), stripMarkers));
    cursor = reference.end;
  }
  parts.push(projectLiteralText(source.text.slice(cursor), stripMarkers));
  return parts.join('').trim();
}

/** 被引用对象的可读名字(会话标题 / 项目名 / 被引用消息正文)。取不到 → null。 */
export function describeAgentInputReference(reference: AgentInputReference): string | null {
  if (reference.kind === 'session') return oneLine(reference.title ?? '') || null;
  if (reference.kind === 'project') return oneLine(reference.name) || null;
  return oneLine(reference.text ?? '') || null;
}

/**
 * Project the persisted `{text, quotesEncoded, agentReferences}` envelope.
 * Returns null for non-user/unknown shapes so callers can keep their existing
 * assistant/tool extraction logic.
 */
export function projectPersistedAgentFacingUserText(content: unknown): string | null {
  let value = content;
  if (typeof value === 'string') {
    if (!value || (value[0] !== '{' && value[0] !== '[')) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.text !== 'string') return null;
  return projectAgentFacingText({
    text: record.text,
    quotesEncoded: record.quotesEncoded === true,
    agentReferences: readAgentInputReferences(record.agentReferences, record.text),
  });
}
