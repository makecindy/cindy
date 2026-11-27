import { countWideChars } from '../shared/calibrated-token-speed.js';

/**
 * A real Claude Code stream reduced to what speed measurement reads: when each
 * main-thread event arrived, how many characters it carried, and the usage every
 * request reported. No text survives, so a recording can be kept in the
 * repository and replayed by tests and `scripts/token-speed-replay.ts`.
 *
 * Events are `[ms since the first event, code, ...]`:
 * `m` message_start · `b` index, block type · `d` index, delta kind, narrow chars, wide chars ·
 * `n` index, provider-estimated thinking tokens · `e` index · `u` output tokens, thinking tokens ·
 * `r` turn result.
 */
export interface RecordedStream {
  format: 'claude-stream-timing/1';
  model: string;
  /** How it was recorded: SDK version, thinking display, what the turn did. */
  note: string;
  events: RecordedEvent[];
}

export type RecordedDeltaKind = 'text' | 'thinking' | 'json';
export type RecordedEvent =
  | [number, 'm']
  | [number, 'b', number, string]
  | [number, 'd', number, RecordedDeltaKind, number, number]
  | [number, 'n', number, number]
  | [number, 'e', number]
  | [number, 'u', number, number]
  | [number, 'r'];

/** One message as the Agent SDK delivers it, with its arrival time. */
export interface TimedSdkMessage {
  t: number;
  msg: { type?: string; parent_tool_use_id?: string | null; event?: Record<string, unknown> };
}

interface StreamEventShape {
  type?: string;
  index?: number;
  message?: { model?: string };
  content_block?: { type?: string };
  delta?: { type?: string; text?: unknown; thinking?: unknown; partial_json?: unknown; estimated_tokens?: unknown };
  usage?: { output_tokens?: number; output_tokens_details?: { thinking_tokens?: number } };
}

/** Strips a captured SDK stream down to timing and sizes. Subagent output is dropped. */
export function compactRecordedStream(lines: TimedSdkMessage[], note: string): RecordedStream {
  const events: RecordedEvent[] = [];
  let model = '';
  let origin: number | null = null;
  for (const { t, msg } of lines) {
    if (msg.type === 'result' && origin !== null) events.push([t - origin, 'r']);
    if (msg.type !== 'stream_event' || msg.parent_tool_use_id || !msg.event) continue;
    const event = msg.event as StreamEventShape;
    origin ??= t;
    const at = t - origin;
    const index = typeof event.index === 'number' ? event.index : 0;
    switch (event.type) {
      case 'message_start':
        model = event.message?.model ?? model;
        events.push([at, 'm']);
        break;
      case 'content_block_start':
        events.push([at, 'b', index, event.content_block?.type ?? 'text']);
        break;
      case 'content_block_delta': {
        const delta = event.delta;
        if (delta?.type === 'thinking_delta' && typeof delta.estimated_tokens === 'number') {
          events.push([at, 'n', index, delta.estimated_tokens]);
          break;
        }
        const kind: RecordedDeltaKind | null = delta?.type === 'thinking_delta' ? 'thinking'
          : delta?.type === 'input_json_delta' ? 'json' : delta?.type === 'text_delta' ? 'text' : null;
        const text = kind === 'thinking' ? delta?.thinking : kind === 'json' ? delta?.partial_json : delta?.text;
        if (!kind || typeof text !== 'string' || text.length === 0) break;
        const wide = countWideChars(text);
        const last = events.at(-1);
        // Deltas that arrived in the same millisecond measure the same as one.
        if (last && last[1] === 'd' && last[0] === at && last[2] === index && last[3] === kind) {
          last[4] += text.length - wide;
          last[5] += wide;
        } else {
          events.push([at, 'd', index, kind, text.length - wide, wide]);
        }
        break;
      }
      case 'content_block_stop':
        events.push([at, 'e', index]);
        break;
      case 'message_delta':
        events.push([at, 'u', event.usage?.output_tokens ?? 0, event.usage?.output_tokens_details?.thinking_tokens ?? 0]);
        break;
      default:
        break;
    }
  }
  return { format: 'claude-stream-timing/1', model, note, events };
}

/** Rebuilds SDK messages that measure exactly like the recorded ones. */
export function expandRecordedStream(stream: RecordedStream): TimedSdkMessage[] {
  let toolCalls = 0;
  const streamEvent = (t: number, event: Record<string, unknown>): TimedSdkMessage =>
    ({ t, msg: { type: 'stream_event', parent_tool_use_id: null, event } });
  return stream.events.map((recorded): TimedSdkMessage => {
    const t = recorded[0];
    switch (recorded[1]) {
      case 'm':
        return streamEvent(t, { type: 'message_start', message: { model: stream.model, usage: { input_tokens: 1 } } });
      case 'b': {
        const type = recorded[3];
        const block = type === 'tool_use'
          ? { type, id: `toolu_recorded_${++toolCalls}`, name: 'Write', input: {} }
          : type === 'thinking' ? { type, thinking: '' } : { type, text: '' };
        return streamEvent(t, { type: 'content_block_start', index: recorded[2], content_block: block });
      }
      case 'd': {
        const text = 'a'.repeat(recorded[4]) + '中'.repeat(recorded[5]);
        const delta = recorded[3] === 'thinking' ? { type: 'thinking_delta', thinking: text }
          : recorded[3] === 'json' ? { type: 'input_json_delta', partial_json: text } : { type: 'text_delta', text };
        return streamEvent(t, { type: 'content_block_delta', index: recorded[2], delta });
      }
      case 'n':
        return streamEvent(t, {
          type: 'content_block_delta',
          index: recorded[2],
          delta: { type: 'thinking_delta', thinking: '', estimated_tokens: recorded[3] },
        });
      case 'e':
        return streamEvent(t, { type: 'content_block_stop', index: recorded[2] });
      case 'u':
        return streamEvent(t, {
          type: 'message_delta',
          usage: { output_tokens: recorded[2], output_tokens_details: { thinking_tokens: recorded[3] } },
        });
      case 'r':
        return { t, msg: { type: 'result' } };
    }
  });
}
