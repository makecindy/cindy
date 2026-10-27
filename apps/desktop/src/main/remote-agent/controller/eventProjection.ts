/** 远程事件落库和广播前还原文件引用；不改 Agent 的原生会话或执行权限。 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { isTerminalAgentErrorEvent, type AgentEvent } from '@cindy/maker-core';

import { mapJsonPathText, pathTextContext, type ExecutorWorkspace, type PathTextContext } from '../executor/workspace';

const URL_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s\x60"'<>()[\]{}]+/gi;
const TEXT_BOUNDARIES = new Set(['tool_use', 'tool_result', 'tool_result_full', 'interaction_request', 'done', 'error', 'compact_boundary']);
const IDENTITY_FIELDS = new Set(['id', 'toolUseId', 'toolUseIds', 'agentMessageId', 'taskId', 'parentToolUseId', 'turnId', 'requestId', 'blockId', 'sessionId', 'sdkSessionId', 'toolName', 'lastToolName', 'model', 'providerId']);

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

function localText(value: string, workspace: ExecutorWorkspace, context: PathTextContext = 'text'): string {
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
    const local = workspace.mapAliasInText(remote);
    if (code !== undefined && local !== remote && /\s/.test(remote) && !fs.existsSync(local)) return literal;
    return local === remote ? literal : code !== undefined ? '\x60' + local + '\x60' : '<' + local + '>';
  });
  // URL 单独解析；HTTP 与媒体仓标识不得被普通路径替换改写。
  const parts: string[] = [];
  let end = 0;
  for (const match of value.matchAll(URL_TEXT)) {
    parts.push(workspace.mapTextFromAgent(value.slice(end, match.index), context), localFileUrl(match[0], workspace));
    end = match.index! + match[0].length;
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

/** 只暂存末尾未闭合的路径，避免地址被多个 delta 切开后漏掉映射。 */
function pendingPathIndex(text: string, workspace: ExecutorWorkspace): number {
  let pending = text.length;
  const prefixes = workspace.agentPathPrefixes().flatMap((prefix) => {
    const forward = prefix.replace(/\\/g, '/');
    const backward = forward.replace(/\//g, '\\');
    return [forward, backward, backward.replace(/\\/g, '\\\\')];
  });
  if (!prefixes.length) return pending;
  // 完整 URL 出现前保留 scheme，才能在后续 delta 中判断文件 URL 或外部 URL。
  prefixes.push('file://', 'xdt-file://', 'xdt-audio://', 'http://', 'https://', 'cindy-media://');
  for (const prefix of prefixes) {
    const insensitive = /^[A-Za-z]:|^[a-z-]+:\/\//i.test(prefix);
    const source = insensitive ? text.toLowerCase() : text;
    const target = insensitive ? prefix.toLowerCase() : prefix;
    let start = -1;
    while ((start = source.indexOf(target[0], start + 1)) >= 0) {
      if (start && /[A-Za-z0-9_]/.test(text[start - 1])) continue;
      const tail = source.slice(start);
      const quote = text[start - 1];
      const closing = quote === '<' ? '>' : /["'\x60]/.test(quote ?? '') ? quote : undefined;
      if (target.startsWith(tail)) {
        pending = Math.min(pending, closing ? start - 1 : start);
        continue;
      }
      if (!tail.startsWith(target)) continue;
      if (!prefix.includes('://') && !/^[\\/]/.test(tail.slice(target.length))) continue;
      const suffix = text.slice(start + target.length);
      const ended = closing ? suffix.includes(closing) : prefix.includes('://')
        ? /[\s\x60"'<>()[\]{}]/.test(suffix) : /[\s\x60"'<>()[\]{};|&]/.test(suffix);
      if (!ended) {
        pending = Math.min(pending, closing ? start - 1 : start);
      }
    }
  }
  // 引号可能独占一个 delta；保留开引号，下一段路径才能按完整引用(含空格)解析。
  const trailing = text.at(-1);
  if (pending === text.length && trailing && /["'\x60<]/.test(trailing)
    && (trailing === '<' || text.split(trailing).length % 2 === 0)) pending = text.length - 1;
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
