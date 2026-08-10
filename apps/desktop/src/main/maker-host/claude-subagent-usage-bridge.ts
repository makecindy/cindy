/**
 * Claude 子代理 usage 桥。
 *
 * Claude Code 2.1.199 在并发外部模型子代理场景中会把 task_notification usage 写成 0，
 * 但 loopback proxy 仍能看到每条真实响应的 usage。本模块用 Agent 启动回执中的 prompt
 * 匹配子代理请求，并把真实统计留在 host 内存中供 maker-core 同步读取。
 */

import type { RequestTransform, ResponseObserver } from '@cindy/anthropic-compat-proxy';
import { Buffer } from 'node:buffer';

import {
  headerValue,
  isMessagesPath,
  makeDecompressor,
  readSseFrameData,
} from './claude-fast-mode-log.js';

const MAX_TRACKED_TASKS = 200;
const MAX_PENDING_REQUESTS = 1_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface ClaudeSubagentTaskRegistration {
  taskId: string;
  parentToolUseId: string;
  prompt: string;
  model?: string;
}

export interface ClaudeSubagentTaskUsage {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

interface TrackedTask extends ClaudeSubagentTaskRegistration {
  normalizedPrompt: string;
  latestInputTokens: number;
  latestCacheReadTokens: number;
  latestCacheCreateTokens: number;
  cumulativeOutputTokens: number;
  matchedRequests: number;
  registrationOrder: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function normalizePrompt(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

function contentText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter(isPlainObject)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
  return text || null;
}

function requestUserTexts(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.messages)) return [];
  const texts: string[] = [];
  for (const message of body.messages) {
    if (!isPlainObject(message) || message.role !== 'user') continue;
    const text = contentText(message.content);
    if (text) texts.push(normalizePrompt(text));
  }
  return texts;
}

/** In-memory bridge shared by the Claude agent host and loopback proxy observer. */
export class ClaudeSubagentUsageBridge {
  private readonly tasks = new Map<string, TrackedTask>();
  private readonly taskIdByRequestId = new Map<number, string>();
  private readonly activeResponseCountByTaskId = new Map<string, number>();
  private nextRegistrationOrder = 0;

  /** Enforces the task cap without evicting entries still referenced by in-flight responses. */
  private trimTasks(): void {
    const reservedTaskIds = new Set([
      ...this.taskIdByRequestId.values(),
      ...this.activeResponseCountByTaskId.keys(),
    ]);
    while (this.tasks.size > MAX_TRACKED_TASKS) {
      let oldestEvictableTaskId: string | undefined;
      for (const taskId of this.tasks.keys()) {
        if (reservedTaskIds.has(taskId)) continue;
        oldestEvictableTaskId = taskId;
        break;
      }
      if (!oldestEvictableTaskId) break;
      this.tasks.delete(oldestEvictableTaskId);
    }
  }

  registerTask(task: ClaudeSubagentTaskRegistration): void {
    const normalizedPrompt = normalizePrompt(task.prompt);
    if (!task.taskId || !task.parentToolUseId || !normalizedPrompt) return;
    this.tasks.set(task.taskId, {
      ...task,
      normalizedPrompt,
      latestInputTokens: 0,
      latestCacheReadTokens: 0,
      latestCacheCreateTokens: 0,
      cumulativeOutputTokens: 0,
      matchedRequests: 0,
      registrationOrder: this.nextRegistrationOrder++,
    });
    this.trimTasks();
  }

  private selectTask(body: Record<string, unknown>): TrackedTask | null {
    const model = typeof body.model === 'string' ? body.model : undefined;
    const userTexts = requestUserTexts(body);
    if (userTexts.length === 0) return null;

    const candidates = [...this.tasks.values()].filter((task) => {
      if (task.model && model && task.model !== model) return false;
      return userTexts.some((text) => text.includes(task.normalizedPrompt));
    });
    if (candidates.length === 0) return null;
    candidates.sort((left, right) => {
      if (left.normalizedPrompt.length !== right.normalizedPrompt.length) {
        return right.normalizedPrompt.length - left.normalizedPrompt.length;
      }
      if (left.matchedRequests !== right.matchedRequests) {
        return left.matchedRequests - right.matchedRequests;
      }
      return left.registrationOrder - right.registrationOrder;
    });
    const selected = candidates[0];
    if (!selected) return null;
    return selected;
  }

  /** Reserves a task while the proxy is handling the request, before responses can reorder. */
  reserveRequest(reqId: number, body: Record<string, unknown>): string | null {
    const reservedTaskId = this.taskIdByRequestId.get(reqId);
    if (reservedTaskId) return reservedTaskId;
    // Never evict an in-flight reservation to make room: doing so would also
    // remove its task from trimTasks() protection before the response is recorded.
    if (this.taskIdByRequestId.size >= MAX_PENDING_REQUESTS) return null;

    const selected = this.selectTask(body);
    if (!selected) return null;
    selected.matchedRequests += 1;
    this.taskIdByRequestId.set(reqId, selected.taskId);
    return selected.taskId;
  }

  /** Transfers request protection to a compact per-task counter once the response starts. */
  activateReservedTask(reqId: number): string | null {
    const taskId = this.taskIdByRequestId.get(reqId);
    if (!taskId) return null;
    this.taskIdByRequestId.delete(reqId);
    this.activeResponseCountByTaskId.set(
      taskId,
      (this.activeResponseCountByTaskId.get(taskId) ?? 0) + 1,
    );
    return taskId;
  }

  /** Ends the in-flight protection after the response is fully handled. */
  releaseReservedTask(reqId: number): void {
    this.taskIdByRequestId.delete(reqId);
  }

  /** Ends task protection after an active response has committed or been abandoned. */
  releaseActiveTask(taskId: string): void {
    const count = this.activeResponseCountByTaskId.get(taskId);
    if (!count) return;
    if (count === 1) this.activeResponseCountByTaskId.delete(taskId);
    else this.activeResponseCountByTaskId.set(taskId, count - 1);
  }

  recordResponseUsage(taskId: string, usage: Record<string, unknown>): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const rawInput = numberField(usage, 'input_tokens');
    const cacheRead = numberField(usage, 'cache_read_input_tokens');
    const cacheCreate = numberField(usage, 'cache_creation_input_tokens');
    const inputTokens = rawInput + cacheRead + cacheCreate;
    if (inputTokens > 0) {
      task.latestInputTokens = inputTokens;
      task.latestCacheReadTokens = cacheRead;
      task.latestCacheCreateTokens = cacheCreate;
    }
    task.cumulativeOutputTokens += numberField(usage, 'output_tokens');
  }

  getTaskUsage(taskId: string): ClaudeSubagentTaskUsage | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    const totalTokens = task.latestInputTokens + task.cumulativeOutputTokens;
    if (totalTokens <= 0) return undefined;
    return {
      totalTokens,
      inputTokens: task.latestInputTokens,
      outputTokens: task.cumulativeOutputTokens,
      cacheReadTokens: task.latestCacheReadTokens,
      cacheCreateTokens: task.latestCacheCreateTokens,
    };
  }

  clear(): void {
    this.tasks.clear();
    this.taskIdByRequestId.clear();
    this.activeResponseCountByTaskId.clear();
  }
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : 0;
}

export const claudeSubagentUsageBridge = new ClaudeSubagentUsageBridge();

/** Reserves a subagent task at request time without changing the outbound body. */
export function createClaudeSubagentUsageRequestTransform(
  bridge: ClaudeSubagentUsageBridge = claudeSubagentUsageBridge,
): RequestTransform {
  return (body, ctx) => {
    if (ctx.method !== 'POST' || !isMessagesPath(ctx.url)) return null;
    if (isPlainObject(body)) bridge.reserveRequest(ctx.reqId, body);
    return null;
  };
}

/** Creates a read-only response observer that records only matched subagent responses. */
export function createClaudeSubagentUsageResponseObserver(
  bridge: ClaudeSubagentUsageBridge = claudeSubagentUsageBridge,
): ResponseObserver {
  return (ctx) => {
    if (ctx.method !== 'POST' || !isMessagesPath(ctx.url)) return null;
    if (ctx.status < 200 || ctx.status >= 300) return null;

    const contentType = (ctx.responseHeaders['content-type'] ?? '').toLowerCase();
    const isSse = contentType.includes('text/event-stream');
    const isJson = contentType.includes('application/json');
    if (!isSse && !isJson) {
      bridge.releaseReservedTask(ctx.reqId);
      return null;
    }
    const taskId = bridge.activateReservedTask(ctx.reqId);
    if (!taskId) return null;

    let done = false;
    let usageCommitted = false;
    let totalBytes = 0;
    let buffer = '';
    let latestInputUsage: Record<string, unknown> | null = null;
    let latestOutputUsage: Record<string, unknown> | null = null;

    const commitUsage = (): void => {
      if (usageCommitted) return;
      usageCommitted = true;
      const usage = {
        input_tokens: latestInputUsage ? numberField(latestInputUsage, 'input_tokens') : 0,
        cache_read_input_tokens: latestInputUsage
          ? numberField(latestInputUsage, 'cache_read_input_tokens')
          : 0,
        cache_creation_input_tokens: latestInputUsage
          ? numberField(latestInputUsage, 'cache_creation_input_tokens')
          : 0,
        output_tokens: latestOutputUsage ? numberField(latestOutputUsage, 'output_tokens') : 0,
      };
      bridge.recordResponseUsage(taskId, usage);
    };

    const finishWithoutUsage = (): void => {
      if (done) return;
      done = true;
      bridge.releaseActiveTask(taskId);
    };

    const processFrame = (frame: string): void => {
      const data = readSseFrameData(frame);
      if (!data) return;
      const message = isPlainObject(data.message) ? data.message : null;
      const usage = message && isPlainObject(message.usage)
        ? message.usage
        : isPlainObject(data.usage)
          ? data.usage
          : null;
      if (usage) {
        const inputTokens = numberField(usage, 'input_tokens')
          + numberField(usage, 'cache_read_input_tokens')
          + numberField(usage, 'cache_creation_input_tokens');
        if (inputTokens > 0) latestInputUsage = usage;
        if (numberField(usage, 'output_tokens') > 0) latestOutputUsage = usage;
      }
      if (data.type === 'message_stop') commitUsage();
    };

    const drain = (flush: boolean): void => {
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) processFrame(frame);
      if (!done && flush && buffer.trim()) processFrame(buffer);
    };

    const appendText = (text: string): void => {
      if (done) return;
      totalBytes += text.length;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        finishWithoutUsage();
        return;
      }
      buffer += text;
      if (isSse) drain(false);
    };

    const finalize = (): void => {
      if (done) return;
      if (isSse) {
        drain(true);
      } else {
        const body = parseJsonObject(buffer);
        if (body && isPlainObject(body.usage)) {
          latestInputUsage = body.usage;
          latestOutputUsage = body.usage;
        }
      }
      commitUsage();
      done = true;
      bridge.releaseActiveTask(taskId);
    };

    const decoder = makeDecompressor(headerValue(ctx.responseHeaders, 'content-encoding'));
    if (decoder) {
      decoder.on('data', (chunk: Buffer) => appendText(chunk.toString('utf8')));
      decoder.on('end', finalize);
      decoder.on('error', () => {
        finishWithoutUsage();
      });
    }

    return {
      onData: (chunk: Buffer) => {
        if (done) return;
        if (decoder) decoder.write(chunk);
        else appendText(chunk.toString('utf8'));
      },
      onEnd: () => {
        if (decoder) decoder.end();
        else finalize();
      },
      onError: () => {
        finishWithoutUsage();
        decoder?.destroy();
      },
    };
  };
}
