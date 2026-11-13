import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHostFrameDecoder, startHostEventStream, type HostConnectionState } from '../hostEventStream';

// Unit, production stream entry. Old adapters lost CRLF/chunked frames and
// silently skipped events after a restart or replay-window loss. Fake clocks
// cover reconnection without sockets, account data, sleeps or model calls.
// Measured standalone: 10 cases, < 0.4 s total (under 25 ms test body).
const encode = new TextEncoder();
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
let stop: (() => void) | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(async () => { stop?.(); await tick(); vi.useRealTimers(); });
function harness(confirmations = false) {
  const states: HostConnectionState[] = [];
  const events: Record<string, unknown>[] = [];
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const open = vi.fn(async (_query: string, _signal: AbortSignal) => new Response(new ReadableStream<Uint8Array>({
    start(controller) { streams.push(controller); },
  }), { headers: { 'x-cindy-event-protocol': '2' } }));
  const client = startHostEventStream({ confirmations, open, onEvent: e => events.push(e), onState: s => states.push(s) });
  stop = client.stop;
  const frame = (data: object) => streams.at(-1)!.enqueue(encode.encode(`data: ${JSON.stringify(data)}\n\n`));
  const control = (runtime: string, seq: number, reason: string | null, phase = 'start') =>
    frame({ type: 'host_stream', runtime, seq, reason, phase });
  const ready = (runtime: string, seq: number, reason: string | null) => control(runtime, seq, reason, 'ready');
  return { client, open, streams, states, events, frame, control, ready };
}

describe('Host event transport', () => {
  // Plugin approval must not be replayed or consume the durable task cursor.
  // Existing event tests cover persisted task events, not transient owner UI.
  it('negotiates live confirmations without advancing or weakening the task cursor', async () => {
    const h = harness(true);
    h.control('run-a', 4, 'initial'); h.ready('run-a', 4, 'initial');
    h.frame({ type: 'host_prompt', channel: 'ghosts:confirm-request', payload: { requestId: 'owner-request' } });
    h.frame({ seq: 5, type: 'done' }); await tick();
    expect(h.events).toEqual([{ type: 'plugin_push', channel: 'ghosts:confirm-request', payload: { requestId: 'owner-request' } },
      { seq: 5, type: 'done' }]);
    h.streams[0].close(); await tick(); await vi.advanceTimersByTimeAsync(1_000);
    expect(h.open.mock.calls[1][0]).toBe('?protocol=2&confirmations=1&since=5&runtime=run-a');
    h.control('run-a', 5, null); h.ready('run-a', 5, null);
    h.frame({ seq: 7, type: 'done' }); await tick();
    expect(h.events).toHaveLength(2);
    expect(h.states.at(-1)?.status).toBe('disconnected');
  });
  it('decodes split UTF-8, CRLF and multiline SSE data', () => {
    const got: unknown[] = [];
    const decode = createHostFrameDecoder(frame => got.push(frame));
    const bytes = encode.encode(': keepalive\r\n\r\ndata: {"text": "任务",\r\ndata: "seq": 1}\r\n\r\n');
    for (const byte of bytes) decode(Uint8Array.of(byte));
    expect(got).toEqual([{ text: '任务', seq: 1 }]);
  });

  it('replays a short interruption exactly once without requesting snapshots again', async () => {
    const h = harness();
    h.control('run-a', 4, 'initial'); h.ready('run-a', 4, 'initial');
    h.frame({ seq: 5, type: 'message', text: 'saved' });
    await tick();
    h.streams[0].close(); await tick();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.open.mock.calls[1][0]).toBe('?protocol=2&since=5&runtime=run-a');
    h.control('run-a', 6, null);
    h.frame({ seq: 5, type: 'message', text: 'duplicate' });
    h.frame({ seq: 6, type: 'done' }); h.ready('run-a', 6, null);
    await tick();
    expect(h.events.map(e => e.seq)).toEqual([5, 6]);
    expect(h.states.at(-1)).toMatchObject({ status: 'connected', recovery: 1 });
  });

  it.each(['restarted', 'history-lost', 'invalid-cursor'])(
    'requests reconciliation after %s even when the new sequence is higher', async reason => {
      const h = harness();
      h.control('run-a', 8, 'initial'); h.ready('run-a', 8, 'initial'); await tick();
      h.streams[0].close(); await tick(); await vi.advanceTimersByTimeAsync(1_000);
      h.control('run-b', 90, reason); h.ready('run-b', 90, reason); await tick();
      expect(h.states.at(-1)).toMatchObject({ status: 'connected', recovery: 2, reason });
      expect(h.events).toEqual([]);
    },
  );

  it('does not certify a reset whose ready frame was lost', async () => {
    const h = harness();
    h.control('run-a', 20, 'initial'); await tick();
    h.streams[0].error(new Error('connection lost')); await tick();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.open.mock.calls[1][0]).toBe('?protocol=2');
    h.control('run-a', 21, 'initial'); h.ready('run-a', 21, 'initial'); await tick();
    expect(h.states.at(-1)?.recovery).toBe(1);
  });

  it('a sequence gap forces snapshots instead of accepting a partial history', async () => {
    const h = harness();
    h.control('run-a', 1, 'initial'); h.ready('run-a', 1, 'initial');
    h.frame({ seq: 3, type: 'done' }); await tick();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.events).toEqual([]);
    expect(h.open.mock.calls[1][0]).toBe('?protocol=2');
  });

  it('401 pauses automatic retries; explicit retry resumes without losing the cursor', async () => {
    const h = harness();
    h.control('run-a', 7, 'initial'); h.ready('run-a', 7, 'initial'); await tick();
    h.open.mockResolvedValueOnce(new Response(null, { status: 401 }));
    h.streams[0].close(); await tick(); await vi.advanceTimersByTimeAsync(1_000);
    expect(h.states.at(-1)?.status).toBe('authorization-required');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.open).toHaveBeenCalledTimes(2);
    h.client.reconnect(); await tick();
    expect(h.open.mock.calls[2][0]).toContain('since=7');
    h.control('run-b', 0, 'restarted'); h.ready('run-b', 0, 'restarted'); await tick();
    expect(h.states.at(-1)?.recovery).toBe(2);
  });

  it('reconnects a half-open stream while heartbeats keep a healthy idle stream alive', async () => {
    const h = harness();
    h.control('run-a', 4, 'initial'); h.ready('run-a', 4, 'initial'); await tick();
    await vi.advanceTimersByTimeAsync(30_000);
    h.streams[0].enqueue(encode.encode(': ping\n\n')); await tick();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.open).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(h.open).toHaveBeenCalledTimes(2);
    expect(h.open.mock.calls[1][0]).toContain('since=4');
  });

  it('legacy Hosts reconcile on each reconnect; stop cancels readers and timers', async () => {
    const h = harness();
    h.control('run-a', 0, 'initial'); h.ready('run-a', 0, 'initial'); await tick();
    h.open.mockResolvedValueOnce(new Response(new ReadableStream(), { headers: {} }));
    h.client.reconnect(); await tick(); await vi.advanceTimersByTimeAsync(0); await tick();
    expect(h.states.at(-1)).toMatchObject({ status: 'connected', reason: 'legacy', recovery: 2 });
    h.client.stop(); await tick(); await vi.advanceTimersByTimeAsync(60_000);
    expect(h.open).toHaveBeenCalledTimes(2);
  });
});
