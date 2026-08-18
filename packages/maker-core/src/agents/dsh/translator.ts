import type { Logger } from '../../interfaces/logger.js';
import type { AgentEvent, UsageSnapshot } from '../../types/events.js';
import { createAsyncQueue, type AsyncQueue } from '../shared/async-queue.js';
import type { DshSessionEvent, DshTokenUsage } from './protocol.js';

export interface DshTranslateContext { logger: Logger; isStreaming: boolean; thinkingSeq: number; thinkingBlocks: Map<number, string>; toolCalls: Map<number, { id?: string; name?: string; arguments: string }>; finalText: string; pendingTurnEndReason: string | null; usage: UsageSnapshot; }
export function createDshTranslateContext(logger: Logger): DshTranslateContext { return { logger, isStreaming: false, thinkingSeq: 0, thinkingBlocks: new Map(), toolCalls: new Map(), finalText: '', pendingTurnEndReason: null, usage: { tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 } }; }
export function createDshEventQueue(): AsyncQueue<AgentEvent> { return createAsyncQueue<AgentEvent>(); }
function status(queue: AsyncQueue<AgentEvent>, ctx: DshTranslateContext, text: string, isRunning: boolean): void { queue.push({ type: 'status', data: { status: text, ...ctx.usage, isRunning }, source: 'pi' }); }
function applyUsage(ctx: DshTranslateContext, usage: DshTokenUsage | undefined): void { if (!usage) return; const input = usage.inputTokens || 0; const output = usage.outputTokens || 0; ctx.usage = { ...ctx.usage, tokenUsage: input + output, contextTokens: input + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0) }; }
function record(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined; }
export function translateDshEvent(event: DshSessionEvent, queue: AsyncQueue<AgentEvent>, ctx: DshTranslateContext): void {
  const data = event.data as Record<string, unknown> | undefined;
  if (event.type === 'turn/start') { ctx.isStreaming = true; ctx.toolCalls.clear(); ctx.thinkingBlocks.clear(); ctx.finalText = ''; ctx.pendingTurnEndReason = null; status(queue, ctx, 'Working…', true); return; }
  if (event.type === 'turn/end') { ctx.isStreaming = false; ctx.pendingTurnEndReason = String(record(data?.reason)?.kind ?? 'completed'); return; }
  if (event.type === 'tool/call' && data) { const id = typeof data.callId === 'string' ? data.callId : `dsh-tool-${Date.now()}`; queue.push({ type: 'tool_use', data: { toolUseId: id, name: String(data.name ?? 'tool'), input: parseArguments(data.arguments) }, source: 'pi' }); return; }
  if (event.type === 'tool/result' && data) { const id = typeof data.callId === 'string' ? data.callId : 'dsh-tool-result'; const fullText = typeof data.message === 'string' ? data.message : JSON.stringify(data.message ?? ''); queue.push({ type: 'tool_result_full', data: { toolUseId: id, fullText, isError: Boolean(data.error) }, source: 'pi' }); return; }
  if (event.type !== 'assistant/chunk' || !data) return;
  const chunk = record(data.chunk); if (!chunk || typeof chunk.type !== 'string') return;
  const index = typeof chunk.index === 'number' ? chunk.index : 0;
  switch (chunk.type) {
    case 'text-delta': if (typeof chunk.text === 'string') { ctx.finalText += chunk.text; queue.push({ type: 'text', data: { text: chunk.text }, source: 'pi' }); } break;
    case 'reasoning-delta': if (typeof chunk.text === 'string') { let blockId = ctx.thinkingBlocks.get(index); if (!blockId) { blockId = `dsh-think-${++ctx.thinkingSeq}`; ctx.thinkingBlocks.set(index, blockId); queue.push({ type: 'thinking', data: { stage: 'start', blockId, startedAt: Date.now() }, source: 'pi' }); } queue.push({ type: 'thinking', data: { stage: 'delta', blockId, text: chunk.text }, source: 'pi' }); } break;
    case 'tool-call-delta': { const existing = ctx.toolCalls.get(index) ?? { arguments: '' }; if (typeof chunk.id === 'string') existing.id = chunk.id; if (typeof chunk.name === 'string') existing.name = chunk.name; if (typeof chunk.argumentsDelta === 'string') existing.arguments += chunk.argumentsDelta; ctx.toolCalls.set(index, existing); break; }
    case 'block-end': { const block = record(chunk.block); if (block?.type === 'reasoning') { const blockId = ctx.thinkingBlocks.get(index); if (blockId) { queue.push({ type: 'thinking', data: { stage: 'final', blockId }, source: 'pi' }); ctx.thinkingBlocks.delete(index); } } else if (block?.type === 'tool-call') { const cached = ctx.toolCalls.get(index); const id = typeof block.id === 'string' ? block.id : cached?.id ?? `dsh-tool-${index}`; const name = typeof block.name === 'string' ? block.name : cached?.name ?? 'tool'; const args = typeof block.arguments === 'string' ? block.arguments : cached?.arguments; queue.push({ type: 'tool_use', data: { toolUseId: id, name, input: parseArguments(args) }, source: 'pi' }); } break; }
    case 'usage': applyUsage(ctx, chunk.usage as DshTokenUsage | undefined); break;
  }
}
/** dsh sends `turn/end` before `session.status: idle`; only the pair closes Cindy's turn. */
export function settleDshTurnOnIdle(queue: AsyncQueue<AgentEvent>, ctx: DshTranslateContext): void {
  if (ctx.pendingTurnEndReason === null) return;
  queue.push({ type: 'done', data: { result: ctx.finalText, reason: ctx.pendingTurnEndReason, usage: ctx.usage }, source: 'pi' });
  ctx.pendingTurnEndReason = null;
  status(queue, ctx, 'Done', false);
}
function parseArguments(value: unknown): unknown { if (typeof value !== 'string') return {}; try { return JSON.parse(value); } catch { return { raw: value }; } }
