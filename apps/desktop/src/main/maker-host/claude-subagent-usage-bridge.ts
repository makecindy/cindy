/**
 * Claude 子代理 usage 桥。
 *
 * Claude Code 2.1.199 在并发外部模型子代理场景中会把 task_notification usage 写成 0，
 * 但 loopback proxy 仍能看到每条真实响应的 usage。本模块用 Agent 启动回执中的 prompt
 * 匹配子代理请求，并把真实统计留在 host 内存中供 maker-core 同步读取。
 */

import type { RequestTransform, ResponseObserver } from '@cindy/anthropic-compat-proxy';
import type { ClaudeSubagentTaskRegistration, ClaudeSubagentTaskUsage } from '@cindy/maker-core';
import { Buffer } from 'node:buffer';

import {
  headerValue,
  isMessagesPath,
  makeDecompressor,
  readSseFrameData,
} from './claude-fast-mode-log.js';

const MAX_TRACKED_TASKS = 200;
const MAX_PENDING_REQUESTS = 1_000;
// Reclaim orphaned receipts if an interrupted session never reaches settlement.
const ORPHAN_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_SEGMENTS_PER_TASK = 1_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type { ClaudeSubagentTaskRegistration, ClaudeSubagentTaskUsage } from '@cindy/maker-core';

interface TrackedTask extends ClaudeSubagentTaskRegistration {
  normalizedPrompt: string;
  latestInputTokens: number;
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

const COUNT_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;
type BillingUsage = Partial<Record<typeof COUNT_FIELDS[number], number>> & {
  cacheCreate1hTokens?: number;
  speed?: unknown;
  tier?: unknown;
};

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Provider usage frames are cumulative snapshots. An omitted field carries no new evidence. */
function mergeBillingUsage(total: BillingUsage, usage: Record<string, unknown>): boolean {
  for (const key of COUNT_FIELDS) {
    const count = usage[key];
    if (count === undefined) continue;
    if (!validCount(count)) return false;
    total[key] = Math.max(total[key] ?? 0, count);
  }
  if (usage.cache_creation != null) {
    if (!isPlainObject(usage.cache_creation)) return false;
    const count = usage.cache_creation.ephemeral_1h_input_tokens;
    if (count !== undefined) {
      if (!validCount(count)) return false;
      total.cacheCreate1hTokens = Math.max(total.cacheCreate1hTokens ?? 0, count);
    }
  }
  total.speed = usage.speed ?? total.speed;
  total.tier = usage.service_tier ?? total.tier;
  return true;
}

type BillingReceipt = NonNullable<ClaudeSubagentTaskUsage['billing']>['segments'][number];
interface BillingReservation {
  segments: BillingReceipt[];
  requestedFast: boolean;
  reservedAt: number;
  parentToolUseId?: string;
}

function recordBillingSegment(
  reservation: BillingReservation,
  message: Record<string, unknown> | null,
  usage: BillingUsage,
): void {
  const { segments, reservedAt, parentToolUseId, requestedFast } = reservation;
  if (!message || typeof message.id !== 'string' || !message.id ||
      typeof message.model !== 'string' || !message.model.trim() ||
      usage.input_tokens === undefined || usage.output_tokens === undefined) return;
  const speed = usage.speed ?? (requestedFast ? 'fast' : 'standard');
  const tier = usage.tier;
  if (speed !== 'standard' && speed !== 'fast') return;
  if (tier != null && tier !== 'standard' && tier !== 'priority' && tier !== 'batch' && tier !== 'default') return;
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  const cache1h = usage.cacheCreate1hTokens ?? 0;
  if (cache1h > cacheCreate) return;
  const id = message.id;
  // Deduplicate after invocation matching: a stale receipt may share both the
  // provider ID and the last observed parent with a newly reserved request.
  if (segments.length >= MAX_SEGMENTS_PER_TASK) return;
  segments.push({
    reservedAt, parentToolUseId, id, model: message.model, modelConfirmed: true,
    complete: usage.cache_read_input_tokens !== undefined && usage.cache_creation_input_tokens !== undefined,
    priceVariant: speed === 'fast' || tier === 'priority' ? 'priority' : tier === 'batch' ? 'batch' : 'standard',
    inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0, cacheCreateTokens: cacheCreate,
    cacheCreate1hTokens: cache1h,
  });
}

/** In-memory bridge shared by the Claude agent host and loopback proxy observer. */
export class ClaudeSubagentUsageBridge {
  private readonly tasks = new Map<string, TrackedTask>();
  private readonly reservations = new Map<number, {
    taskId: string;
    billing?: BillingReservation;
  }>();
  private readonly activeResponseCountByTaskId = new Map<string, number>();
  // A background request can complete before the SDK sends its async launch receipt.
  private readonly segmentsByOwner = new Map<string, {
    taskId: string;
    registered: boolean;
    lastRequestAt: number;
    segments: BillingReceipt[];
  }>();
  private nextRegistrationOrder = 0;

  /** Enforces the task cap without evicting entries still referenced by in-flight responses. */
  private trimTasks(): void {
    const reservedTaskIds = new Set(this.activeResponseCountByTaskId.keys());
    for (const { taskId } of this.reservations.values()) reservedTaskIds.add(taskId);
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
    for (const entry of this.segmentsByOwner.values()) {
      if (entry.taskId === task.taskId) entry.registered = true;
    }
    this.tasks.set(task.taskId, {
      ...task,
      normalizedPrompt,
      latestInputTokens: 0,
      cumulativeOutputTokens: 0,
      matchedRequests: 0,
      registrationOrder: this.nextRegistrationOrder++,
    });
    this.trimTasks();
  }

  private selectTask(body: Record<string, unknown>) {
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
    return candidates[0] ?? null;
  }

  /** Reserves a task while the proxy is handling the request, before responses can reorder. */
  reserveRequest(reqId: number, body: Record<string, unknown>, sdkSessionId?: string, agentId?: string): string | null {
    const reserved = this.reservations.get(reqId);
    if (reserved) return reserved.taskId;
    // Never evict an in-flight reservation to make room: doing so would also
    // remove its task from trimTasks() protection before the response is recorded.
    if (this.reservations.size >= MAX_PENDING_REQUESTS) return null;

    const selected = agentId ? this.tasks.get(agentId) : this.selectTask(body);
    const taskId = selected?.taskId ?? (sdkSessionId ? agentId : undefined);
    if (!taskId) return null;
    if (selected) selected.matchedRequests += 1;
    let segments: BillingReceipt[] | undefined;
    if (sdkSessionId && agentId) {
      const owner = JSON.stringify([sdkSessionId, agentId]);
      const current = this.segmentsByOwner.get(owner);
      if (current) current.lastRequestAt = Date.now();
      segments = current?.segments;
      if (!segments) {
        if (this.segmentsByOwner.size >= MAX_TRACKED_TASKS) {
          // Only reclaim abandoned, unregistered owners. An observer may still be writing
          // through its reservation, or the launched task may be awaiting settlement.
          const protectedTasks = new Set(this.activeResponseCountByTaskId.keys());
          for (const reservation of this.reservations.values()) protectedTasks.add(reservation.taskId);
          for (const [key, entry] of this.segmentsByOwner) {
            const expired = Date.now() - entry.lastRequestAt > ORPHAN_RETENTION_MS;
            if ((!entry.registered || expired) && !protectedTasks.has(entry.taskId)) {
              this.segmentsByOwner.delete(key);
              break;
            }
          }
        }
        if (this.segmentsByOwner.size < MAX_TRACKED_TASKS) {
          segments = [];
          this.segmentsByOwner.set(owner, { taskId, segments, registered: Boolean(selected), lastRequestAt: Date.now() });
        }
      }
    }
    this.reservations.set(reqId, {
      taskId,
      billing: segments && (body.speed == null || body.speed === 'standard' || body.speed === 'fast')
        ? { segments, requestedFast: body.speed === 'fast', reservedAt: performance.now(), parentToolUseId: selected?.parentToolUseId }
        : undefined,
    });
    return taskId;
  }

  billingForRequest(reqId: number) {
    return this.reservations.get(reqId)?.billing;
  }

  /** Transfers request protection to a compact per-task counter once the response starts. */
  activateReservedTask(reqId: number): string | null {
    const taskId = this.reservations.get(reqId)?.taskId;
    if (!taskId) return null;
    this.reservations.delete(reqId);
    this.activeResponseCountByTaskId.set(
      taskId,
      (this.activeResponseCountByTaskId.get(taskId) ?? 0) + 1,
    );
    return taskId;
  }

  /** Ends the in-flight protection after the response is fully handled. */
  releaseReservedTask(reqId: number): void {
    this.reservations.delete(reqId);
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
    const inputTokens = numberField(usage, 'input_tokens')
      + numberField(usage, 'cache_read_input_tokens')
      + numberField(usage, 'cache_creation_input_tokens');
    if (inputTokens > 0) task.latestInputTokens = inputTokens;
    task.cumulativeOutputTokens += numberField(usage, 'output_tokens');
  }

  getTaskUsage(taskId: string, sdkSessionId?: string): ClaudeSubagentTaskUsage | undefined {
    const task = this.tasks.get(taskId);
    const totalTokens = task ? task.latestInputTokens + task.cumulativeOutputTokens : 0;
    if (sdkSessionId) {
      // Only billing settlement supplies the SDK session. Notifications read the card total.
      const owner = JSON.stringify([sdkSessionId, taskId]);
      const segments = this.segmentsByOwner.get(owner)?.segments;
      this.segmentsByOwner.delete(owner);
      if (segments?.length) return { totalTokens, billing: { sdkSessionId, segments: segments.slice() } };
    }
    return totalTokens > 0 ? { totalTokens } : undefined;
  }

  clear(): void {
    this.segmentsByOwner.clear();
    this.tasks.clear();
    this.reservations.clear();
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
    if (isPlainObject(body)) {
      bridge.reserveRequest(ctx.reqId, body,
        headerValue(ctx.headers, 'x-claude-code-session-id'),
        headerValue(ctx.headers, 'x-claude-code-agent-id'));
    }
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
    const billing = bridge.billingForRequest(ctx.reqId);
    const taskId = bridge.activateReservedTask(ctx.reqId);
    if (!taskId) return null;

    let done = false;
    let cardUsageCommitted = false;
    let totalBytes = 0;
    let buffer = '';
    let latestInputUsage: Record<string, unknown> | null = null;
    let latestOutputUsage: Record<string, unknown> | null = null;

    let message: Record<string, unknown> | null = null;
    let billingUsage: BillingUsage = {};
    let sawInputStart = false;
    let sawOutputUpdate = false;
    let responseError = false;
    let cycleStopped = false;
    const commitCardUsage = (): void => {
      if (cardUsageCommitted) return;
      cardUsageCommitted = true;
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

    const markInvalidData = (): void => { responseError = true; };
    const processFrame = (frame: string): void => {
      const data = readSseFrameData(frame, markInvalidData);
      if (!data) return;
      if (data.type === 'error') responseError = true;
      const start = isPlainObject(data.message) ? data.message : null;
      if (data.type === 'message_start') {
        cycleStopped = false;
        if (!message || message.id !== start?.id) {
          message = start;
          billingUsage = {};
          sawInputStart = false;
          sawOutputUpdate = false;
        } else if (!message.model && start?.model) {
          message = start;
        }
        if (isPlainObject(start?.usage) && validCount(start.usage.input_tokens)) sawInputStart = true;
      }
      const usage = start && isPlainObject(start.usage)
        ? start.usage
        : isPlainObject(data.usage)
          ? data.usage
          : null;
      if (usage) {
        if (billing && (data.type === 'message_start' || data.type === 'message_delta')) {
          if (!mergeBillingUsage(billingUsage, usage)) responseError = true;
          if (data.type === 'message_delta' && validCount(usage.output_tokens)) sawOutputUpdate = true;
        }
        const inputTokens = numberField(usage, 'input_tokens')
          + numberField(usage, 'cache_read_input_tokens')
          + numberField(usage, 'cache_creation_input_tokens');
        if (inputTokens > 0) latestInputUsage = usage;
        if (numberField(usage, 'output_tokens') > 0) latestOutputUsage = usage;
      }
      if (data.type === 'message_stop') {
        cycleStopped = true;
        commitCardUsage();
      }
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
          message = body;
          if (billing) {
            sawInputStart = validCount(body.usage.input_tokens);
            sawOutputUpdate = validCount(body.usage.output_tokens);
            if (!mergeBillingUsage(billingUsage, body.usage)) responseError = true;
          }
          latestInputUsage = body.usage;
          latestOutputUsage = body.usage;
        }
      }
      commitCardUsage();
      // One HTTP response may carry several SSE cycles for the same message.
      // Only its clean end and the last cycle's stop establish the billing boundary.
      if (billing && (isJson || cycleStopped) && sawInputStart && sawOutputUpdate && !responseError) {
        recordBillingSegment(billing, message, billingUsage);
      }
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
