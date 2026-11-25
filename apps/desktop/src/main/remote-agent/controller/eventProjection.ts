/** 远程事件落库和广播前还原文件引用；不改 Agent 的原生会话或执行权限。 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { isTerminalAgentErrorEvent, type AgentEvent } from '@cindy/maker-core';

import { mapJsonPathText, pathTextContext, type ExecutorWorkspace, type PathTextContext } from '../executor/workspace';

// 文件链接仍按 Markdown 分隔符与中文标点取路径；其它 URL 的括号、IPv6 方括号等属于地址，不能当成本机路径正文。
const URL_TEXT = /(?:file|xdt-(?:file|audio|image)):\/\/[^\s\x60"'<>()[\]{}，。、；：！？（）【】《》「」『』“”‘’]+|[a-z][a-z0-9+.-]*:\/\/[^\s\x60"'<>]+/gi;
/** Markdown 链接 `[名称](file:///绝对路径)` 与 `[名称](xdt-file:///绝对路径)` 开头；支持前导水平空白。 */
const MARKDOWN_FILE_LINK_OPEN = /\]\(([ \t]*(?:file:\/\/|xdt-(?:file|image):\/\/\/))/gi;
const FILE_URL_SCHEME = /^(?:file|xdt-(?:file|audio|image)):\/\//i;
const BARE_URL_HARD_STOP = /[\r\n\x60"'<>()[\]{}，。、；：！？（）【】《》「」『』“”‘’]/;
const BARE_URL_STOP = /[\s\x60"'<>()[\]{}，。、；：！？（）【】《》「」『』“”‘’]/;
const FILE_URL_PREFIX_BEFORE_PATH = /(?:file|xdt-(?:file|audio|image)):\/\/(?:localhost)?\/?$/i;

/**
 * 扫描 Markdown 链接 `](...)` 内容直到匹配的闭合 `)`；支持路径中的成对括号，并跳过空白后的引号标题
 * (`"..."` / `'...'`) 内的括号。遇到换行或串尾仍未闭合时返回 -1。
 */
function findMarkdownLinkEnd(text: string, contentStart: number): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let index = contentStart; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === '\r' || ch === '\n') return -1;
    if (quote) {
      if (ch === '\\' && index + 1 < text.length) {
        index += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if ((ch === '"' || ch === "'") && index > contentStart && /[ \t]/.test(text[index - 1])) {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return -1;
}

function fileUrlExistsLocally(urlValue: string, workspace: ExecutorWorkspace): boolean {
  try {
    const url = new URL(urlValue);
    if (url.protocol !== 'file:' && url.protocol !== 'xdt-file:' && url.protocol !== 'xdt-image:') return false;
    const remote = url.hostname
      ? '//' + url.hostname + decodeURIComponent(url.pathname)
      : decodeURIComponent(url.pathname).replace(/^\/(?=[A-Za-z]:[\\/])/, '');
    const local = workspace.mapAlias(remote);
    return local !== remote && fs.existsSync(local);
  } catch {
    return false;
  }
}

/** 分离 Markdown 链接目标与尾部空白 / 三种合法标题定界形式（`"..."`、`'...'`、`(...)`）。 */
function splitMarkdownLinkTarget(raw: string, workspace: ExecutorWorkspace): { target: string; suffix: string } {
  const trimmedEnd = raw.replace(/[ \t]+$/, '');
  const trailingSpace = raw.slice(trimmedEnd.length);
  const lastChar = trimmedEnd.at(-1);
  if (lastChar === '"' || lastChar === "'") {
    for (let index = trimmedEnd.length - 2; index > 0; index -= 1) {
      if (trimmedEnd[index] !== lastChar) continue;
      let slashes = 0;
      for (let back = index - 1; back >= 0 && trimmedEnd[back] === '\\'; back -= 1) slashes += 1;
      if (slashes % 2 === 1) continue;
      if (/[ \t]/.test(trimmedEnd[index - 1])) {
        let sep = index - 1;
        while (sep > 0 && /[ \t]/.test(trimmedEnd[sep - 1])) sep -= 1;
        return { target: trimmedEnd.slice(0, sep), suffix: trimmedEnd.slice(sep) + trailingSpace };
      }
      break;
    }
  }
  if (lastChar === ')') {
    const parenTitle = /([ \t]+\([^()\r\n]*\))$/.exec(trimmedEnd);
    if (parenTitle && !fileUrlExistsLocally(trimmedEnd.replace(/\s/g, encodeURIComponent), workspace)) {
      return { target: trimmedEnd.slice(0, parenTitle.index), suffix: parenTitle[1] + trailingSpace };
    }
  }
  return { target: trimmedEnd, suffix: trailingSpace };
}

function replaceMarkdownFileLinks(value: string, workspace: ExecutorWorkspace): string {
  let result = '';
  let last = 0;
  for (const match of value.matchAll(MARKDOWN_FILE_LINK_OPEN)) {
    const start = match.index!;
    if (start < last) continue;
    const contentStart = start + 2;
    const close = findMarkdownLinkEnd(value, contentStart);
    if (close < 0) continue;
    const raw = value.slice(contentStart, close);
    const body = raw.replace(/^[ \t]+/, '');
    const leading = raw.slice(0, raw.length - body.length);
    const { target, suffix } = splitMarkdownLinkTarget(body, workspace);
    const encoded = target.replace(/\s/g, encodeURIComponent);
    const local = localFileUrl(encoded, workspace);
    if (local === encoded) continue;
    // Markdown 链接目标里的括号需要编码，避免本机目录或文件名带括号时提前闭合链接。
    const safe = local.replace(/\(/g, '%28').replace(/\)/g, '%29');
    result += value.slice(last, start) + '](' + leading + safe + suffix + ')';
    last = close + 1;
  }
  return last === 0 ? value : result + value.slice(last);
}
const TEXT_BOUNDARIES = new Set(['tool_use', 'tool_result', 'tool_result_full', 'interaction_request', 'done', 'error', 'compact_boundary']);
const IDENTITY_FIELDS = new Set(['id', 'toolUseId', 'toolUseIds', 'agentMessageId', 'taskId', 'parentToolUseId', 'turnId', 'requestId', 'blockId', 'sessionId', 'sdkSessionId', 'toolName', 'lastToolName', 'model', 'providerId']);

interface SpacedAliasPrefix { target: string; windows: boolean }
const spacedAliasCache = new WeakMap<readonly string[], SpacedAliasPrefix[]>();

function spacedAliasPrefixes(workspace: ExecutorWorkspace): SpacedAliasPrefix[] {
  const aliases = workspace.agentPathPrefixes();
  let cached = spacedAliasCache.get(aliases);
  if (cached) return cached;
  cached = aliases
    .filter((alias) => /\s/.test(alias))
    .map((alias) => {
      const forward = alias.replace(/\\/g, '/').replace(/\/+$/, '');
      const windows = /^[A-Za-z]:|^\/\//.test(forward);
      return { target: windows ? forward.toLowerCase() : forward, windows };
    });
  spacedAliasCache.set(aliases, cached);
  return cached;
}

/** 裸 `file://` URL 命中带空格的影子目录前缀(如 macOS `Application Support`)时，补全完整路径段。 */
function extendSpacedFileUrl(
  value: string, start: number, raw: string, workspace: ExecutorWorkspace,
): { raw: string; mapped: string } | null {
  const scheme = /^(?:file:\/\/(?:localhost)?|xdt-(?:file|image):\/\/)/i.exec(raw);
  if (!scheme) return null;
  const spaced = spacedAliasPrefixes(workspace);
  if (!spaced.length) return null;
  const restStart = start + scheme[0].length;
  const afterScheme = value.slice(restStart);
  for (const { target, windows } of spaced) {
    const driveLead = windows && /^[\\/]/.test(afterScheme) && !target.startsWith('//') ? 1 : 0;
    const candidate = afterScheme.slice(driveLead, driveLead + target.length).replace(/\\/g, '/');
    const compared = windows ? candidate.toLowerCase() : candidate;
    if (compared !== target) continue;
    let end = driveLead + target.length;
    const next = afterScheme[end];
    if (next !== undefined && next !== '/' && next !== '\\' && next !== '?' && next !== '#' && !BARE_URL_STOP.test(next)) continue;
    while (end < afterScheme.length && !BARE_URL_STOP.test(afterScheme[end])) end += 1;
    const full = value.slice(start, restStart + end);
    const encoded = full.replace(/\s/g, encodeURIComponent);
    const mapped = localFileUrl(encoded, workspace);
    if (mapped !== encoded) return { raw: full, mapped };
  }
  return null;
}

function localFileUrl(value: string, workspace: ExecutorWorkspace): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'file:') {
      // 不能用本机平台的 fileURLToPath 解析另一台电脑的 Windows/POSIX URL。
      const remote = url.hostname
        ? '//' + url.hostname + decodeURIComponent(url.pathname)
        : decodeURIComponent(url.pathname).replace(/^\/(?=[A-Za-z]:[\\/])/, '');
      const local = workspace.mapAlias(remote);
      if (local === remote) return value;
      const result = pathToFileURL(local);
      result.search = url.search;
      result.hash = url.hash;
      return result.href;
    }
    if ((url.protocol === 'xdt-file:' || url.protocol === 'xdt-image:') && !url.hostname && !url.searchParams.has('path')) {
      // 无 host 形态由出站收集器按本机路径读盘；括号也要编码，否则会提前闭合 Markdown 链接。
      const remote = decodeURIComponent(url.pathname).replace(/^\/(?=[A-Za-z]:[\\/])/, '');
      const local = workspace.mapAlias(remote);
      if (local === remote) return value;
      return url.protocol + pathToFileURL(local).href.slice('file:'.length).replace(/\(/g, '%28').replace(/\)/g, '%29');
    }
    if (url.protocol === 'xdt-file:' || url.protocol === 'xdt-audio:') {
      const remote = url.searchParams.get('path');
      if (!remote) return value;
      const local = workspace.mapAlias(remote);
      if (local === remote) return value;
      url.searchParams.set('path', local);
      return url.href;
    }
  } catch { /* 普通文本和无法解析的 URL 保持既有行为。 */ }
  return value;
}

/** 事件正文与 MCP 文本入参共用的还原；URL、JSON 转义和源码分隔符沿用同一判据。 */
export function localText(value: string, workspace: ExecutorWorkspace, context: PathTextContext = 'text'): string {
  // 先处理 JSON 字符串，保留 Windows 转义、正文格式和非字符串字节。
  if (/^\s*[{["]/.test(value)) {
    try {
      return mapJsonPathText(value, (decoded, context) => {
        const local = workspace.mapAlias(decoded);
        const complete = context === 'path' || ((context === 'untyped' || context === 'ambiguous-path')
          && local !== decoded && fs.existsSync(local));
        return localText(complete ? local : decoded, workspace, context);
      });
    } catch { /* 非 JSON 按文件引用投影。 */ }
  }
  // 尖括号链接是明确的完整路径。代码段也可能是命令，含空白时只有已存在的完整
  // 文件/目录才按单一路径处理；其余回到下方逐 token 投影，保留参数和正文中的斜杠。
  // 分隔符沿用 Agent 的写法：Markdown 会把链接里的 `\.git`、`\_x` 当成转义吃掉。
  value = value.replace(/\x60([^\x60\r\n]+)\x60|<([^<>\r\n]+)>/g, (literal, code: string | undefined, angle: string | undefined) => {
    const remote = code ?? angle!;
    if (angle !== undefined && FILE_URL_SCHEME.test(remote)) {
      const encoded = remote.replace(/\s/g, encodeURIComponent);
      const local = localFileUrl(encoded, workspace);
      return local === encoded ? literal : '<' + local + '>';
    }
    const local = workspace.mapAliasInText(remote);
    if (code !== undefined && local !== remote && /\s/.test(remote) && !fs.existsSync(local)) return literal;
    return local === remote ? literal : code !== undefined ? '\x60' + local + '\x60' : '<' + local + '>';
  });
  // URL 分词会在裸空格处截断路径，Markdown 文件链接先按括号取完整地址；未映射的保持原文。
  value = replaceMarkdownFileLinks(value, workspace);
  // URL 单独解析；HTTP 与媒体仓标识不得被普通路径替换改写。
  const parts: string[] = [];
  let end = 0;
  for (const match of value.matchAll(URL_TEXT)) {
    const start = match.index!;
    if (start < end) continue;
    let raw = match[0];
    let mapped = localFileUrl(raw, workspace);
    if (mapped === raw && FILE_URL_SCHEME.test(raw)) {
      const extended = extendSpacedFileUrl(value, start, raw, workspace);
      if (extended) {
        raw = extended.raw;
        mapped = extended.mapped;
      }
    }
    parts.push(workspace.mapTextFromAgent(value.slice(end, start), context), mapped);
    end = start + raw.length;
  }
  parts.push(workspace.mapTextFromAgent(value.slice(end), context));
  return parts.join('');
}

function localValue(value: unknown, workspace: ExecutorWorkspace, key = ''): unknown {
  if (typeof value === 'string') return localText(value, workspace, pathTextContext(key));
  if (Array.isArray(value)) return value.map((item) => localValue(item, workspace, key));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, IDENTITY_FIELDS.has(key) ? item : localValue(item, workspace, key)]));
}

/**
 * 计划审阅：计划正文与计划文件按本机路径展示和保存，计划里的文件才能点开。权限与提问的回执要与
 * 原请求逐字对应，保持原样。
 */
export function localPlanReview<T extends { kind: string }>(request: T, workspace: ExecutorWorkspace): T {
  if (request.kind !== 'plan_review') return request;
  const { plan, planFilePath } = request as { plan?: unknown; planFilePath?: unknown };
  return {
    ...request,
    ...(typeof plan === 'string' ? { plan: localText(plan, workspace) } : {}),
    ...(typeof planFilePath === 'string' ? { planFilePath: workspace.mapAlias(planFilePath) } : {}),
  };
}

interface PendingPrefix { prefix: string; insensitive: boolean; target: string }

/** 前缀展开只与别名数组有关，按 agentPathPrefixes() 返回的数组引用缓存(#7710)：每个 delta 都要判断。 */
const pendingPrefixCache = new WeakMap<readonly string[], PendingPrefix[]>();

function pendingPrefixes(workspace: ExecutorWorkspace): PendingPrefix[] {
  const aliases = workspace.agentPathPrefixes();
  let cached = pendingPrefixCache.get(aliases);
  if (cached) return cached;
  const prefixes = aliases.flatMap((prefix) => {
    const forward = prefix.replace(/\\/g, '/');
    const backward = forward.replace(/\//g, '\\');
    return [forward, backward, backward.replace(/\\/g, '\\\\')];
  });
  // 完整 URL 出现前保留 scheme，才能在后续 delta 中判断文件 URL 或外部 URL。
  if (prefixes.length) prefixes.push('file://', 'xdt-file://', 'xdt-audio://', 'xdt-image://', 'http://', 'https://', 'cindy-media://');
  cached = prefixes.map((prefix) => {
    const insensitive = /^[A-Za-z]:|^[a-z-]+:\/\//i.test(prefix);
    return { prefix, insensitive, target: insensitive ? prefix.toLowerCase() : prefix };
  });
  pendingPrefixCache.set(aliases, cached);
  return cached;
}

function hasClosingParen(suffix: string): boolean {
  return suffix.includes('\r') || suffix.includes('\n') || findMarkdownLinkEnd(suffix, 0) >= 0;
}

function isBareFileUrlEnded(suffix: string, workspace: ExecutorWorkspace): boolean {
  if (!BARE_URL_STOP.test(suffix)) return false;
  if (BARE_URL_HARD_STOP.test(suffix)) return true;
  const spaced = spacedAliasPrefixes(workspace);
  if (!spaced.length) return true;
  const normalized = suffix.replace(/^localhost(?=[\\/])/i, '');
  for (const { target, windows } of spaced) {
    const driveLead = windows && /^[\\/]/.test(normalized) && !target.startsWith('//') ? 1 : 0;
    const body = normalized.slice(driveLead).replace(/\\/g, '/');
    const compared = windows ? body.toLowerCase() : body;
    if (target.startsWith(compared)) return false;
    if (compared.startsWith(target)) {
      const rest = body.slice(target.length);
      if (!rest || (/^[\\/?#]/.test(rest) && !BARE_URL_STOP.test(rest))) return false;
    }
  }
  return true;
}

/** 只暂存末尾未闭合的路径，避免地址被多个 delta 切开后漏掉映射。 */
function pendingPathIndex(text: string, workspace: ExecutorWorkspace): number {
  let pending = text.length;
  const prefixes = pendingPrefixes(workspace);
  if (!prefixes.length) return pending;
  let lowered: string | undefined;
  for (const { prefix, insensitive, target } of prefixes) {
    const isUrlScheme = prefix.includes('://');
    const isFileUrlScheme = prefix === 'file://' || prefix === 'xdt-file://' || prefix === 'xdt-image://';
    const source = insensitive ? lowered ??= text.toLowerCase() : text;
    let start = -1;
    while ((start = source.indexOf(target[0], start + 1)) >= 0) {
      if (start && /[A-Za-z0-9_]/.test(text[start - 1])) continue;
      // 紧跟在 file:// / xdt-file:// 后的路径归对应 URL scheme 统一判断边界，不能把 scheme 和路径拆开刷出。
      if (!isUrlScheme && start >= 7 && FILE_URL_PREFIX_BEFORE_PATH.test(text.slice(Math.max(0, start - 32), start))) continue;
      const tail = source.slice(start);
      const quote = text[start - 1];
      const closing = quote === '<' ? '>' : /["'\x60]/.test(quote ?? '') ? quote : undefined;
      let linkOpen = -1;
      if (isFileUrlScheme && start >= 2) {
        let before = start - 1;
        while (before > 0 && (text[before] === ' ' || text[before] === '\t')) before -= 1;
        if (before >= 1 && text[before - 1] === ']' && text[before] === '(') linkOpen = before - 1;
      }
      const markdownLink = linkOpen >= 0;
      const openStart = markdownLink ? linkOpen : closing ? start - 1 : start;
      if (target.startsWith(tail)) {
        pending = Math.min(pending, openStart);
        continue;
      }
      if (!tail.startsWith(target)) continue;
      if (!isUrlScheme && !/^[\\/]/.test(tail.slice(target.length))) continue;
      const suffix = text.slice(start + target.length);
      const ended = markdownLink
        ? hasClosingParen(suffix)
        : closing
          ? suffix.includes(closing)
          : isFileUrlScheme
            ? isBareFileUrlEnded(suffix, workspace)
            : isUrlScheme
              ? /[\s\x60"'<>()[\]{}]/.test(suffix)
              : /[\s\x60"'<>()[\]{};|&]/.test(suffix);
      if (!ended) {
        pending = Math.min(pending, openStart);
      }
    }
  }
  // 引号或 Markdown 链接开括号可能独占一个 delta；保留它们，下一段路径才能按完整引用(含空格)解析。
  if (pending === text.length) {
    const openLink = /\]\([ \t]*$/.exec(text);
    if (openLink) pending = openLink.index;
    else if (text.endsWith(']')) pending = text.length - 1;
    else {
      const trailing = text.at(-1);
      if (trailing && /["'\x60<]/.test(trailing)
        && (trailing === '<' || text.split(trailing).length % 2 === 0)) pending = text.length - 1;
    }
  }
  return pending;
}

/** 保留原事件身份和增量/全文语义；仅把数据中的已知虚拟文件引用还原。 */
export class RemoteEventProjection {
  private pending = new Map<string, AgentEvent>();

  constructor(private readonly workspace: ExecutorWorkspace) {}

  private streamKey(event: AgentEvent): string {
    return JSON.stringify([event.source, event.turnScope, event.agentMeta?.parentUuid,
      event.turnAttemptToken, event.sessionTurnGeneration, event.sessionInstanceId, event.backgroundTurnStartedAt]);
  }

  flush(stream?: string): AgentEvent[] {
    const output: AgentEvent[] = [];
    for (const key of stream === undefined ? this.pending.keys() : [stream]) {
      const event = this.pending.get(key);
      if (!event) continue;
      this.pending.delete(key);
      output.push({ ...event, data: localValue(event.data, this.workspace) });
    }
    return output;
  }

  project(event: AgentEvent): AgentEvent[] {
    // Native image payloads are bytes and source-side recovery metadata, not
    // virtual-workspace text. In particular JPEG Base64 can start with '/'.
    if (event.type === 'image' && event.source === 'codex'
      && (event.data as { kind?: unknown } | null)?.kind === 'generation') return [event];
    const data = event.data as { text?: unknown; isFinal?: boolean; isFullText?: boolean; isRunning?: boolean; agentMessageId?: string } | null;
    const stream = this.streamKey(event);
    let pending = this.pending.get(stream);
    // 独立提示有自己的持久行，不能截断正在流式传输的正文路径。
    if (event.type === 'text' && event.standaloneText) {
      return [{ ...event, data: localValue(event.data, this.workspace) }];
    }
    if (event.type === 'text' && typeof data?.text === 'string' && !data.isFinal && !data.isFullText && !event.standaloneText) {
      const output: AgentEvent[] = [];
      if (pending) {
        const previous = pending.data as typeof data;
        if (previous?.agentMessageId !== data.agentMessageId) {
          output.push(...this.flush(stream));
          pending = undefined;
        }
      }
      const raw = (pending?.data as typeof data)?.text;
      const text = (typeof raw === 'string' ? raw : '') + data.text;
      const boundary = pendingPathIndex(text, this.workspace);
      if (boundary < text.length) this.pending.set(stream, { ...event, data: { ...data, text: text.slice(boundary) } });
      else this.pending.delete(stream);
      if (boundary) output.push({ ...event, data: { ...data, text: localText(text.slice(0, boundary), this.workspace) } });
      return output;
    }
    // 全文终态覆盖同一消息的未闭合尾段；先输出半截虚拟前缀会让 Claude 的前缀校准失效。
    if (event.type === 'text' && pending && typeof data?.text === 'string' && (data.isFinal || data.isFullText)) {
      const previous = pending.data as typeof data;
      if (previous?.agentMessageId === data.agentMessageId
        && (data.isFullText || (typeof previous.text === 'string' && data.text.includes(previous.text)))) this.pending.delete(stream);
    }
    // Agent 可先发停止状态，且不一定随后有 done；正文必须在停止状态前送出。
    const stopped = event.type === 'status' && data?.isRunning === false;
    const terminal = !event.agentMeta?.parentUuid && event.turnScope !== 'background'
      && (stopped || ['done', 'compact_boundary'].includes(event.type)
        || (event.type === 'error' && isTerminalAgentErrorEvent(event)));
    const output = event.type === 'text' || stopped || TEXT_BOUNDARIES.has(event.type)
      ? this.flush(terminal ? undefined : stream) : [];
    // agentMeta、session/tool id 和权限回执不经过递归文本改写。
    output.push({ ...event, data: event.type === 'interaction_request' ? event.data : localValue(event.data, this.workspace) });
    return output;
  }
}
