import type { AgentEvent, UsageSnapshot } from '../../types/events.js';
import type { AsyncQueue } from '../shared/async-queue.js';
import type { TrueForgeEvent, TrueForgeToolCall } from './protocol.js';
import { parseToolArguments, toolNameOf } from './protocol.js';

export interface TrueForgeTranslateState {
  finalText: string;
  usage: UsageSnapshot;
  inputTokens: number;
  outputTokens: number;
  hasModelUsage: boolean;
  calls: Map<string, TrueForgeToolCall>;
  emittedCalls: Set<string>;
}

export function createTrueForgeTranslateState(contextWindow: number): TrueForgeTranslateState {
  return {
    finalText: '',
    usage: { tokenUsage: 0, contextTokens: 0, contextWindow, costUsd: 0 },
    inputTokens: 0,
    outputTokens: 0,
    hasModelUsage: false,
    calls: new Map(),
    emittedCalls: new Set(),
  };
}

export function beginTrueForgeTurn(state: TrueForgeTranslateState): void {
  state.finalText = '';
  state.usage.tokenUsage = 0;
  state.usage.contextTokens = 0;
  state.inputTokens = 0;
  state.outputTokens = 0;
  state.hasModelUsage = false;
  state.calls.clear();
  state.emittedCalls.clear();
}

export function rememberToolCalls(
  state: TrueForgeTranslateState,
  calls: readonly TrueForgeToolCall[] | undefined,
): void {
  for (const call of calls ?? []) {
    if (call.id) state.calls.set(call.id, call);
  }
}

export function emitToolUse(
  queue: AsyncQueue<AgentEvent>,
  state: TrueForgeTranslateState,
  call: TrueForgeToolCall,
): void {
  if (!call.id || state.emittedCalls.has(call.id)) return;
  state.emittedCalls.add(call.id);
  queue.push({
    type: 'tool_use',
    source: 'trueforge',
    data: {
      toolUseId: call.id,
      toolName: toolNameOf(call),
      input: parseToolArguments(call.function?.arguments),
    },
  });
}

export function translateTrueForgeEvent(
  event: TrueForgeEvent,
  queue: AsyncQueue<AgentEvent>,
  state: TrueForgeTranslateState,
): void {
  if (
    (event.type === 'model.message' || event.type === 'model.message.delta') &&
    event.threadId &&
    event.threadId !== 'main'
  )
    return;
  // Delta tool calls are fragments. The stream adapter remembers the SDK-merged base event;
  // accepting the raw fragment here would overwrite complete arguments with partial JSON.
  if (event.type !== 'model.message.delta') rememberToolCalls(state, event.toolCalls);
  switch (event.type) {
    case 'turn.created':
      queue.push({
        type: 'status',
        source: 'trueforge',
        data: { status: 'Working…', ...state.usage, isRunning: true },
      });
      return;
    case 'model.message':
      if (event.usage) {
        state.hasModelUsage = true;
        state.usage.contextTokens =
          event.usage.inputTokens +
          (event.usage.cacheReadTokens ?? 0) +
          (event.usage.cacheWriteTokens ?? 0);
      }
      return;
    case 'model.message.delta':
      if (event.usage) {
        state.hasModelUsage = true;
        state.usage.contextTokens =
          event.usage.inputTokens +
          (event.usage.cacheReadTokens ?? 0) +
          (event.usage.cacheWriteTokens ?? 0);
      }
      if (event.content) {
        state.finalText += event.content;
        queue.push({
          type: 'text',
          source: 'trueforge',
          data: { text: event.content, isFinal: false },
        });
      }
      return;
    case 'tool.response': {
      const call = event.toolCallId ? state.calls.get(event.toolCallId) : undefined;
      if (call) emitToolUse(queue, state, call);
      const toolUseId = event.toolCallId ?? '';
      const fullText = typeof event.content === 'string' ? event.content : '';
      queue.push({
        type: 'tool_result_full',
        source: 'trueforge',
        data: { toolUseId, fullText, isError: false },
      });
      queue.push({
        type: 'tool_result',
        source: 'trueforge',
        data: { summary: 'done', toolUseIds: [toolUseId] },
      });
      return;
    }
    case 'turn.done': {
      const metrics = event.state?.metrics;
      if (metrics) {
        const input = metrics.totalInputTokens ?? 0;
        const output = metrics.totalOutputTokens ?? 0;
        const cacheRead = metrics.totalCacheReadTokens ?? 0;
        const cacheWrite = metrics.totalCacheWriteTokens ?? 0;
        state.inputTokens += input;
        state.outputTokens += output;
        state.usage.tokenUsage += metrics.totalTokens ?? input + output;
        // contextTokens comes from the final model.message usage above. Turn metrics aggregate
        // every model call and would overstate the live context gauge for tool-heavy turns.
        if (!state.hasModelUsage) {
          state.usage.contextTokens = input + cacheRead + cacheWrite;
        }
        state.usage.costUsd += metrics.totalCostInUsd ?? 0;
      }
      return;
    }
    default:
      return;
  }
}

export function finishTrueForgeTurn(
  queue: AsyncQueue<AgentEvent>,
  state: TrueForgeTranslateState,
  error?: string,
): void {
  if (error) {
    queue.push({
      type: 'error',
      source: 'trueforge',
      data: { message: error, sdkError: error, isTerminal: true },
    });
  }
  queue.push({
    type: 'status',
    source: 'trueforge',
    data: { status: 'Done', ...state.usage, isRunning: false },
  });
  queue.push({
    type: 'done',
    source: 'trueforge',
    data: {
      type: 'trueforge/turn.done',
      result: state.finalText,
      usage: {
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
      },
    },
  });
}
