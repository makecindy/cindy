import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient, AcpRpcError } from './client.js';
import type { AcpTransport } from './transport.js';
function fixture(options: ConstructorParameters<typeof AcpClient>[1] = {}) {
  const writes: Record<string, unknown>[] = [];
  let line: (value: string) => void = () => {};
  let closed: (info: { reason: string }) => void = () => {};
  const transport: AcpTransport = {
    writeLine: vi.fn(async value => { writes.push(JSON.parse(value)); }),
    onLine: handler => { line = handler; return vi.fn(); },
    onClose: handler => { closed = handler; return vi.fn(); }, close: vi.fn(async () => {}),
  };
  const client = new AcpClient(transport, options);
  return { client, transport, writes, receive: (value: unknown) => line(JSON.stringify(value)), raw: (value: string) => line(value), closed };
}
afterEach(() => vi.useRealTimers());
describe('ACP JSON-RPC client', () => {
  it('correlates ID zero and concurrent replies, ignores unknown IDs', async () => {
    const f = fixture();
    const first = f.client.request('initialize', {}); const second = f.client.request('session/new', {});
    expect(f.writes[0].id).toBe(0);
    f.receive({ jsonrpc: '2.0', id: 99, result: 'unknown' });
    f.receive({ jsonrpc: '2.0', id: 1, result: 'second' }); f.receive({ jsonrpc: '2.0', id: 0, result: 'first' });
    await expect(first).resolves.toBe('first'); await expect(second).resolves.toBe('second');
  });
  it('routes notifications and answers server requests with ID zero', async () => {
    const onNotification = vi.fn(); const f = fixture({ onNotification, onRequest: async () => ({ ok: true }) });
    f.receive({ jsonrpc: '2.0', method: 'session/update', params: { text: 'hello' } });
    f.receive({ jsonrpc: '2.0', id: 0, method: 'session/request_permission', params: {} });
    await Promise.resolve();
    expect(onNotification).toHaveBeenCalledWith('session/update', { text: 'hello' });
    expect(f.writes).toContainEqual({ jsonrpc: '2.0', id: 0, result: { ok: true } });
  });
  it('returns method-not-found and sanitized internal errors', async () => {
    const f = fixture(); f.receive({ jsonrpc: '2.0', id: 'remote', method: 'unknown' });
    expect(f.writes[0]).toEqual({ jsonrpc: '2.0', id: 'remote', error: { code: -32601, message: 'Method not found' } });
    const g = fixture({ onRequest: () => { throw new Error('private secret'); } });
    g.receive({ jsonrpc: '2.0', id: 0, method: 'bad' });
    expect(JSON.stringify(g.writes)).not.toContain('private secret');
    expect(g.writes[0]).toMatchObject({ error: { code: -32603 } });
  });
  it('rejects malformed responses and validates protocol envelopes', async () => {
    const f = fixture(); f.raw('{'); f.receive([]); f.receive({ jsonrpc: '1.0', method: 'bad' });
    expect(f.writes.map(value => (value.error as { code: number }).code)).toEqual([-32700, -32600, -32600]);
    const pending = f.client.request('test');
    f.receive({ jsonrpc: '2.0', id: 0, result: null, error: { code: 1, message: 'bad' } });
    await expect(pending).rejects.toThrow('Invalid ACP response');
  });
  it('preserves RPC error code and data for explicit caller handling', async () => {
    const f = fixture(); const pending = f.client.request('test');
    f.receive({ jsonrpc: '2.0', id: 0, error: { code: -32000, message: 'Denied', data: { reason: 'auth' } } });
    await expect(pending).rejects.toMatchObject({ code: -32000, data: { reason: 'auth' } });
  });
  it('bounds requests and removes abort listeners on every terminal path', async () => {
    vi.useFakeTimers(); const f = fixture(); const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = f.client.request('test', {}, { signal: controller.signal, timeoutMs: 20 });
    const assertion = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(20); await assertion;
    expect(remove).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    f.receive({ jsonrpc: '2.0', id: 0, result: 'late' });
    const aborted = f.client.request('test', {}, { signal: controller.signal }); controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0);
    await expect(f.client.request('test', {}, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(f.client.request('test', {}, { timeoutMs: Infinity })).rejects.toThrow('bounded');
  });
  it('rejects pending requests on disconnect and supports repeated close', async () => {
    const f = fixture(); const pending = f.client.request('test'); f.closed({ reason: 'lost' });
    await expect(pending).rejects.toThrow('lost');
    await expect(f.client.notify('test')).rejects.toThrow('lost');
    await Promise.all([f.client.close(), f.client.close()]); expect(f.transport.close).toHaveBeenCalledTimes(1);
  });
  it('cleans synchronous serialization and async write failures', async () => {
    const f = fixture(); const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    await expect(f.client.request('test', cyclic)).rejects.toThrow('serialization');
    vi.mocked(f.transport.writeLine).mockRejectedValueOnce(new Error('secret'));
    await expect(f.client.request('test')).rejects.toThrow('write failed');
  });
  it('returns explicit RPC handler errors and suppresses replies after close', async () => {
    const f = fixture({ onRequest: () => { throw new AcpRpcError(-32602, 'Invalid params'); } });
    f.receive({ jsonrpc: '2.0', id: 7, method: 'test' });
    expect(f.writes[0]).toMatchObject({ error: { code: -32602 } });
    let resolve!: (value: unknown) => void;
    const g = fixture({ onRequest: () => new Promise(r => { resolve = r; }) });
    g.receive({ jsonrpc: '2.0', id: 0, method: 'test' }); await g.client.close(); resolve('late');
    await Promise.resolve(); expect(g.writes).toHaveLength(0);
  });
});
