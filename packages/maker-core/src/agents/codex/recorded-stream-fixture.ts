import { estimateWordTokens } from '../shared/calibrated-token-speed.js';

/**
 * A real Codex app-server turn reduced to what speed measurement reads: when
 * each notification arrived, how much answer text it carried, and the usage
 * every response reported. No text survives, so a recording can be kept in the
 * repository and replayed by tests and `scripts/token-speed-replay.ts`.
 *
 * Events are `[ms since the first event, code, ...]`:
 * `t` turn/started · `b` / `e` item started / completed: id, type · `d` answer
 * delta: item id, estimated words · `u` output tokens, reasoning tokens · `r`
 * turn/completed.
 */
export interface RecordedCodexStream {
  format: 'codex-stream-timing/1';
  model: string;
  /** How it was recorded: Codex version, effort, what the turn did. */
  note: string;
  events: RecordedCodexEvent[];
}

export type RecordedCodexEvent =
  | [number, 't']
  | [number, 'b' | 'e', string, string]
  | [number, 'd', string, number]
  | [number, 'u', number, number]
  | [number, 'r'];

/** One app-server notification with its arrival time. */
export interface TimedCodexNotification {
  t: number;
  msg: { method?: string; params?: Record<string, unknown> };
}

const TURN_ID = 'recorded-turn';
const THREAD_ID = 'recorded-thread';

/** Strips a captured app-server stream down to timing and sizes. */
export function compactCodexStream(lines: TimedCodexNotification[], model: string, note: string): RecordedCodexStream {
  const events: RecordedCodexEvent[] = [];
  let origin: number | null = null;
  // Provider item ids identify a real conversation; a recording only needs them distinct.
  const ids = new Map<string, string>();
  const anonymous = (id: unknown): string => {
    const key = String(id);
    if (!ids.has(key)) ids.set(key, `item-${ids.size + 1}`);
    return ids.get(key)!;
  };
  for (const { t, msg } of lines) {
    const params = msg.params ?? {};
    const item = params.item as { id?: string; type?: string } | undefined;
    if (msg.method === 'turn/started') origin ??= t;
    if (origin === null) continue;
    const at = t - origin;
    switch (msg.method) {
      case 'turn/started':
        events.push([at, 't']);
        break;
      case 'item/started':
      case 'item/completed':
        if (item?.id && item.type && item.type !== 'userMessage') {
          events.push([at, msg.method === 'item/started' ? 'b' : 'e', anonymous(item.id), item.type]);
        }
        break;
      case 'item/agentMessage/delta': {
        const words = estimateWordTokens(String(params.delta ?? ''));
        const last = events.at(-1);
        const itemId = anonymous(params.itemId);
        // Deltas that arrived in the same millisecond measure the same as one.
        if (last && last[1] === 'd' && last[0] === at && last[2] === itemId) last[3] += words;
        else if (words > 0) events.push([at, 'd', itemId, words]);
        break;
      }
      case 'thread/tokenUsage/updated': {
        const last = (params.tokenUsage as { last?: { outputTokens?: number; reasoningOutputTokens?: number } } | undefined)?.last;
        events.push([at, 'u', last?.outputTokens ?? 0, last?.reasoningOutputTokens ?? 0]);
        break;
      }
      case 'turn/completed':
        events.push([at, 'r']);
        break;
      default:
        break;
    }
  }
  return { format: 'codex-stream-timing/1', model, note, events };
}

/** Rebuilds notifications that measure exactly like the recorded ones. */
export function expandCodexStream(stream: RecordedCodexStream): TimedCodexNotification[] {
  const notify = (t: number, method: string, params: Record<string, unknown>): TimedCodexNotification =>
    ({ t, msg: { method, params: { threadId: THREAD_ID, turnId: TURN_ID, ...params } } });
  return stream.events.map((recorded): TimedCodexNotification => {
    const t = recorded[0];
    switch (recorded[1]) {
      case 't':
        return notify(t, 'turn/started', { turn: { id: TURN_ID } });
      case 'b':
      case 'e':
        return notify(t, recorded[1] === 'b' ? 'item/started' : 'item/completed', {
          item: { id: recorded[2], type: recorded[3], text: '', summary: [], content: [], command: 'recorded' },
        });
      case 'd':
        return notify(t, 'item/agentMessage/delta', { itemId: recorded[2], delta: 'w '.repeat(recorded[3]) });
      case 'u':
        return notify(t, 'thread/tokenUsage/updated', {
          tokenUsage: { last: { outputTokens: recorded[2], reasoningOutputTokens: recorded[3] } },
        });
      case 'r':
        return notify(t, 'turn/completed', { turn: { id: TURN_ID, status: 'completed' } });
    }
  });
}
