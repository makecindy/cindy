import { afterEach, expect, it, vi } from 'vitest';
import { subscribeChatServer, type ChatSocket } from '@/chat/chatServerSubscription';
const actorId = '00000000-0000-4000-8000-000000000001';
type MockSocket = ChatSocket & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
const sockets: MockSocket[] = [];
function socket(): MockSocket {
  const ws = { readyState: 1, onopen: null, onmessage: null, onclose: null, onerror: null,
    send: vi.fn(), close: vi.fn(() => ws.onclose?.({} as CloseEvent)) } as ChatSocket & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  sockets.push(ws); return ws;
}
const receive = async (ws: ChatSocket, data: unknown) => { ws.onmessage?.({ data: JSON.stringify(data) } as MessageEvent); await Promise.resolve(); await Promise.resolve(); };
let stop = () => {};
afterEach(() => { stop(); sockets.length = 0; vi.useRealTimers(); });
it('authenticates inside the socket, acknowledges string cursors and reconnects without replaying writes', async () => {
  vi.useFakeTimers(); const changed = vi.fn(); const token = vi.fn(async () => 'fixture-token');
  const ready = vi.fn(async () => ({ scope: `actor:${actorId}`, cursor: '9007199254740993' }));
  const create = vi.fn(socket);
  stop = subscribeChatServer({ baseUrl: 'https://chat.example.invalid', token, current: () => true, socket: create, ready, changed, unavailable: vi.fn() });
  await Promise.resolve(); const first = sockets[0]; first.onopen?.({} as Event);
  expect(create).toHaveBeenCalledWith('wss://chat.example.invalid/v1/ws');
  expect(first.send).toHaveBeenCalledWith(JSON.stringify({ type: 'auth', token: 'fixture-token' }));
  await receive(first, { type: 'ready', actorId });
  await receive(first, { type: 'changes', scope: `actor:${actorId}`, cursor: '9007199254740994', changes: [] });
  expect(changed).toHaveBeenCalledOnce();
  expect(first.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'ack', scope: `actor:${actorId}`, cursor: '9007199254740994' }));
  first.close(); await vi.advanceTimersByTimeAsync(1000);
  expect(sockets).toHaveLength(2); expect(token).toHaveBeenCalledTimes(2);
  await receive(sockets[1], { type: 'ready', actorId }); expect(ready).toHaveBeenCalledTimes(2);
});
it('recovers reset cursors and stops revoked scopes instead of retrying membership indefinitely', async () => {
  vi.useFakeTimers(); const changed = vi.fn();
  stop = subscribeChatServer({ baseUrl: 'https://chat.example.invalid', token: async () => 'fixture', current: () => true,
    socket, ready: async () => ({ scope: `actor:${actorId}`, cursor: '0' }), changed, unavailable: vi.fn() });
  await Promise.resolve(); const ws = sockets[0];
  await receive(ws, { type: 'ready', actorId });
  await receive(ws, { type: 'scope_error', scope: `actor:${actorId}`, error: { code: 'RESET_REQUIRED', details: { head: '50' } } });
  expect(ws.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'subscribe', scope: `actor:${actorId}`, after: '50' }));
  await receive(ws, { type: 'scope_error', scope: `actor:${actorId}`, error: { code: 'NOT_MEMBER' } });
  await vi.advanceTimersByTimeAsync(60000); expect(sockets).toHaveLength(1); expect(changed).toHaveBeenCalledTimes(2);
});
it('does not authenticate or reconnect after owner change or disposal', async () => {
  let resolve!: (token: string) => void; let current = true;
  stop = subscribeChatServer({ baseUrl: 'https://chat.example.invalid', token: () => new Promise(r => { resolve = r; }), current: () => current,
    socket, ready: vi.fn(), changed: vi.fn(), unavailable: vi.fn() });
  current = false; resolve('old-owner'); await Promise.resolve(); expect(sockets).toHaveLength(0);
});
