// #10142, unit: real bridge at its native IO port. Existing integration only
// covered fast HTTP reads. Minimal input is a queued/partial read with a live
// poll; observe ABI updates and cancellation, without real sockets or waits.
import { afterEach, expect, it, vi } from 'vitest';
import { openNativeByteStream, type NativeByteReader } from '../nativeMediaStream.js';
import type { NativeEnginePort } from '../nativeTransport.js';
const streams: Array<Awaited<ReturnType<typeof openNativeByteStream>>> = [];
afterEach(async () => { for (const stream of streams.splice(0)) await stream.close(); vi.useRealTimers(); });
async function setup(read: NativeByteReader['read'], progress = true) {
  vi.useFakeTimers();
  let requests: Array<{ id: number; start: number; end: number }> = [];
  const active = new Set<number>();
  const commands: Record<string, any>[] = [];
  const closed = vi.fn(async () => {}), destroy = vi.fn(async () => {});
  const engine: NativeEnginePort = { destroy, async command<T>(command: Record<string, any>): Promise<T> {
    commands.push(command);
    if (command.op === 'httpMediaStart') return { url: 'http://127.0.0.1:1234/' + 'a'.repeat(43), ...(progress ? { progress } : {}) } as T;
    if (command.op === 'httpMediaPoll') {
      const pending = requests; requests = [];
      return (command.progress ? { requests: pending, active: [...active] } : pending) as T;
    }
    if (command.op === 'httpMediaReply') active.delete(command.id);
    return true as T;
  } };
  const stream = await openNativeByteStream(engine, 'video/mp4', async () => ({ size: 16, read, close: closed }));
  streams.push(stream);
  const request = async (id: number) => { active.add(id); requests.push({ id, start: 0, end: 15 }); await vi.advanceTimersByTimeAsync(25); };
  return { stream, commands, request, active, closed, destroy };
}
it('reports actual queue/dequeue and bytes in existing polls, never periodic fake progress', async () => {
  let activity!: NonNullable<Parameters<NativeByteReader['read']>[3]>;
  let write!: Parameters<NativeByteReader['read']>[2];
  let finish!: () => void;
  const h = await setup(async (_start, _end, sink, observer) => {
    write = sink; activity = observer!; activity('queued'); await new Promise<void>(resolve => { finish = resolve; });
  });
  await h.request(1); await vi.advanceTimersByTimeAsync(10);
  expect(h.commands.flatMap(c => c.updates ?? [])).toContainEqual({ id: 1, state: 'queued', loaded: 0 });
  const before = h.commands.flatMap(c => c.updates ?? []).length;
  await vi.advanceTimersByTimeAsync(65_000);
  expect(h.commands.flatMap(c => c.updates ?? [])).toHaveLength(before);
  activity('active'); await write(new Uint8Array([7, 8]), 0);
  await vi.advanceTimersByTimeAsync(10);
  expect(h.commands.flatMap(c => c.updates ?? [])).toContainEqual({ id: 1, state: 'active', loaded: 2 });
  finish(); await vi.advanceTimersByTimeAsync(10);
  expect(h.commands.find(c => c.op === 'httpMediaReply')?.data).toBe(Buffer.from([7, 8, ...new Array(14).fill(0)]).toString('base64url'));
});
it('cancels only a retired player read and keeps concurrent healthy requests usable', async () => {
  const signals = new Map<number, AbortSignal>(); let count = 0;
  const h = await setup(async (_start, _end, write, activity) => {
    const id = ++count; signals.set(id, activity!.signal!);
    if (id === 1) await new Promise<void>((_, reject) => activity!.signal!.addEventListener('abort', () => reject(new Error('cancelled'))));
    else await write(new Uint8Array(16).fill(9), 0);
  });
  await h.request(1); h.active.delete(1); await vi.advanceTimersByTimeAsync(10);
  expect(signals.get(1)!.aborted).toBe(true); expect(h.stream.isOpen()).toBe(true);
  await h.request(2);
  expect(h.commands.some(c => c.op === 'httpMediaReply' && c.id === 2)).toBe(true);
  expect(h.commands.some(c => c.op === 'httpMediaReply' && c.id === 1)).toBe(false);
});
it('preserves legacy native commands when progress capability is absent', async () => {
  const h = await setup(async (_s, _e, write, activity) => { activity?.('active', 8); await write(new Uint8Array(16), 0); }, false);
  await h.request(1);
  expect(h.commands.filter(c => c.op === 'httpMediaPoll').every(c => !('progress' in c) && !('updates' in c))).toBe(true);
  expect(h.commands.some(c => c.op === 'httpMediaReply')).toBe(true);
});
it('closes on authorization loss and aborts pending readers before destroying their engine', async () => {
  let signal!: AbortSignal;
  const h = await setup(async (_s, _e, _w, activity) => {
    signal = activity!.signal!; await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled'))));
  });
  await h.request(1); await h.stream.close();
  expect(signal.aborted).toBe(true); expect(h.closed).toHaveBeenCalledOnce(); expect(h.destroy).toHaveBeenCalledOnce();
  expect(h.stream.isOpen()).toBe(false);
});
