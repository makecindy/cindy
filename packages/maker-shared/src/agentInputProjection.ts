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

/** One live tab in Cindy's built-in browser for the current task. */
export interface AgentInputBrowserTabReference extends AgentInputReferenceBase {
  kind: 'browser-tab';
  tabId: string;
  title?: string;
  url: string;
}

/** One currently open operating-system application window. */
export interface AgentInputDesktopWindowReference extends AgentInputReferenceBase {
  kind: 'desktop-window';
  windowId: number;
  pid: number;
  appName: string;
  title?: string;
}

/** One opaque business object selected from an explicitly scoped Plugin search. */
export interface AgentInputPluginResourceReference extends AgentInputReferenceBase {
  kind: 'plugin-resource';
  ghostId: string;
  tool: string;
  resourceId: string;
  pluginName: string;
  label: string;
  description?: string;
}

/** Structured Composer references preserved beside the human-facing wire text. */
export type AgentInputReference =
  | AgentInputMessageReference
  | AgentInputSessionReference
  | AgentInputProjectReference
  | AgentInputBrowserTabReference
  | AgentInputDesktopWindowReference
  | AgentInputPluginResourceReference;

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

function stripDeepLinkPrefix(
  href: string,
  route: 'session/' | 'project/' | 'browser-tab/' | 'desktop-window/' | 'plugin-resource/',
): string | null {
  for (const scheme of allDeepLinkSchemes()) {
    const prefix = `${scheme}://${route}`;
    if (href.startsWith(prefix)) return href.slice(prefix.length);
  }
  return null;
}

export function buildPluginResourceReferenceHref(args: {
  ghostId: string;
  tool: string;
  resourceId: string;
}): string {
  const scheme = allDeepLinkSchemes()[0];
  const strictEncode = (value: string) => encodeURIComponent(value)
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${scheme}://plugin-resource/${strictEncode(args.ghostId)}/${strictEncode(args.tool)}/${strictEncode(args.resourceId)}`;
}

export function parsePluginResourceReferenceHref(
  href: string,
): { ghostId: string; tool: string; resourceId: string } | null {
  const rest = stripDeepLinkPrefix(href, 'plugin-resource/');
  if (rest === null || rest.length > 1_500 || rest.includes('?') || rest.includes('#')) return null;
  const [rawGhostId, rawTool, rawResourceId, ...extra] = rest.split('/');
  if (extra.length > 0) return null;
  const ghostId = decodeBoundedComponent(rawGhostId, 32);
  const tool = decodeBoundedComponent(rawTool, 64);
  const resourceId = decodeBoundedComponent(rawResourceId, 256);
  if (
    !ghostId
    || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(ghostId)
    || !tool
    || !/^[a-z][a-z0-9_-]{0,63}$/.test(tool)
    || !resourceId
    || /[\u0000-\u001f\u007f\u2028\u2029]/.test(resourceId)
  ) return null;
  return { ghostId, tool, resourceId };
}

function decodeBoundedComponent(value: string, maxLength: number): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded && decoded.length <= maxLength ? decoded : null;
  } catch {
    return null;
  }
}

function queryValue(query: string, key: string, maxLength: number): string | null {
  for (const pair of query.split('&')) {
    const equalsIndex = pair.indexOf('=');
    if (equalsIndex <= 0 || pair.slice(0, equalsIndex) !== key) continue;
    return decodeBoundedComponent(pair.slice(equalsIndex + 1), maxLength);
  }
  return null;
}

export function parseBrowserTabReferenceHref(
  href: string,
): { tabId: string; url: string } | null {
  const rest = stripDeepLinkPrefix(href, 'browser-tab/');
  if (rest === null || rest.length > 5_000) return null;
  const hashIndex = rest.indexOf('#');
  const withoutHash = hashIndex >= 0 ? rest.slice(0, hashIndex) : rest;
  const queryIndex = withoutHash.indexOf('?');
  if (queryIndex <= 0) return null;
  const tabId = decodeBoundedComponent(withoutHash.slice(0, queryIndex), 256);
  const url = queryValue(withoutHash.slice(queryIndex + 1), 'url', 4_096);
  if (!tabId || !url) return null;
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:' ? { tabId, url } : null;
  } catch {
    return null;
  }
}

export function parseDesktopWindowReferenceHref(
  href: string,
): { pid: number; windowId: number; appName: string } | null {
  const rest = stripDeepLinkPrefix(href, 'desktop-window/');
  if (rest === null || rest.length > 1_000) return null;
  const hashIndex = rest.indexOf('#');
  const withoutHash = hashIndex >= 0 ? rest.slice(0, hashIndex) : rest;
  const queryIndex = withoutHash.indexOf('?');
  if (queryIndex <= 0) return null;
  const [rawPid, rawWindowId, ...extra] = withoutHash.slice(0, queryIndex).split('/');
  if (extra.length > 0) return null;
  const pid = Number(rawPid);
  const windowId = Number(rawWindowId);
  const appName = queryValue(withoutHash.slice(queryIndex + 1), 'app', 200);
  if (
    !Number.isSafeInteger(pid)
    || pid <= 0
    || !Number.isSafeInteger(windowId)
    || windowId < 0
    || !appName
  ) return null;
  return { pid, windowId, appName };
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
  if (candidate.kind === 'browser-tab') {
    const target = parseBrowserTabReferenceHref(candidate.href);
    if (!target) return null;
    return {
      kind: 'browser-tab',
      start,
      end,
      href: candidate.href,
      tabId: target.tabId,
      url: target.url,
      ...(nonEmptyString(candidate.title) ? { title: candidate.title } : {}),
    };
  }
  if (candidate.kind === 'desktop-window') {
    const target = parseDesktopWindowReferenceHref(candidate.href);
    if (!target) return null;
    return {
      kind: 'desktop-window',
      start,
      end,
      href: candidate.href,
      windowId: target.windowId,
      pid: target.pid,
      appName: target.appName,
      ...(nonEmptyString(candidate.title) ? { title: candidate.title } : {}),
    };
  }
  if (
    candidate.kind === 'plugin-resource'
    && nonEmptyString(candidate.pluginName)
    && candidate.pluginName.length <= 128
    && nonEmptyString(candidate.label)
    && candidate.label.length <= 128
  ) {
    const target = parsePluginResourceReferenceHref(candidate.href);
    if (!target) return null;
    return {
      kind: 'plugin-resource',
      start,
      end,
      href: candidate.href,
      ...target,
      pluginName: oneLine(candidate.pluginName),
      label: oneLine(candidate.label),
      ...(nonEmptyString(candidate.description) && candidate.description.length <= 256
        ? { description: oneLine(candidate.description) }
        : {}),
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

function quotedMetadata(value: string): string {
  return JSON.stringify(value)
    .replace(/\[/g, '\\u005b')
    .replace(/\]/g, '\\u005d')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
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
  if (reference.kind === 'browser-tab') {
    return [
      '[Referenced browser tab]',
      `Title: ${quotedMetadata(oneLine(reference.title ?? '') || reference.url)}`,
      `URL: ${quotedMetadata(reference.url)}`,
      `Tab ID: ${quotedMetadata(reference.tabId)}`,
      '[/Referenced browser tab]',
    ].join('\n');
  }
  if (reference.kind === 'desktop-window') {
    return [
      '[Referenced desktop window]',
      `Title: ${quotedMetadata(oneLine(reference.title ?? '') || reference.appName)}`,
      `Application: ${quotedMetadata(oneLine(reference.appName))}`,
      `PID: ${reference.pid}`,
      `Window ID: ${reference.windowId}`,
      '[/Referenced desktop window]',
    ].join('\n');
  }
  if (reference.kind === 'plugin-resource') {
    return [
      '[Referenced plugin resource]',
      `Plugin: ${quotedMetadata(oneLine(reference.pluginName))} (${reference.ghostId})`,
      `Resource ID: ${quotedMetadata(reference.resourceId)}`,
      `Label: ${quotedMetadata(oneLine(reference.label))}`,
      ...(reference.description
        ? [`Summary: ${quotedMetadata(oneLine(reference.description))}`]
        : []),
      `Search tool: ${reference.tool}`,
      'Resolution: call the search tool with query equal to the Resource ID.',
      '[/Referenced plugin resource]',
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
  if (reference.kind === 'browser-tab') return oneLine(reference.title ?? reference.url) || null;
  if (reference.kind === 'desktop-window') {
    return oneLine(reference.title ?? reference.appName) || null;
  }
  if (reference.kind === 'plugin-resource') return oneLine(reference.label) || null;
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
