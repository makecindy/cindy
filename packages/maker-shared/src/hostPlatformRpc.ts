/** Authenticated transport is supplied by the hosts. No retries or payload logs.
 * A disconnected dispatched call is uncertain, never automatically replayed. */
export interface PlatformSocket {
  send(data: string): void;
  terminate(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}
export function createHostPlatformRpc(socket: PlatformSocket, options: {
  assertCurrent(): void;
  execute?(operation: unknown, signal: AbortSignal): Promise<unknown>;
}) {
  let closed = false, sequence = 0, lastIncoming = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }>();
  const executing = new Map<number, AbortController>();
  const drainWaiters = new Set<() => void>();
  const check = () => { if (closed) throw Error('PLATFORM_CONNECTION_CLOSED'); options.assertCurrent(); };
  const send = (value: unknown) => { check(); socket.send(JSON.stringify(value)); };
  const close = () => {
    if (closed) return;
    closed = true;
    for (const request of pending.values()) {
      request.cleanup(); request.reject(Error('PLATFORM_CLIENT_RESULT_UNCERTAIN'));
    }
    pending.clear();
    for (const abort of executing.values()) abort.abort(Error('PLATFORM_CONNECTION_CLOSED'));
    socket.off('message', message); socket.off('close', close); socket.off('error', close);
    socket.terminate();
  };
  async function receive(raw: { toString(): string }) {
    check();
    const item = JSON.parse(raw.toString());
    if (!Number.isSafeInteger(item?.id) || item.id <= 0) throw Error('PLATFORM_PROTOCOL_INVALID');
    if (item.type === 'result') {
      const request = pending.get(item.id);
      if (!request) return;
      pending.delete(item.id); request.cleanup();
      if (item.error) request.reject(Object.assign(Error('Platform operation failed'), { code: String(item.error) }));
      else request.resolve(item.value);
      return;
    }
    if (item.type === 'cancel') { executing.get(item.id)?.abort(Error('REQUEST_CANCELLED')); return; }
    if (item.type !== 'call' || !options.execute || item.id <= lastIncoming || executing.size >= 128)
      throw Error('PLATFORM_PROTOCOL_INVALID');
    lastIncoming = item.id;
    const abort = new AbortController(); executing.set(item.id, abort);
    try {
      check();
      const value = await options.execute(item.operation, abort.signal);
      check(); send({ type: 'result', id: item.id, value });
    } catch (error) {
      // Error messages can contain input values; return only a bounded code.
      const code = (error as { code?: unknown })?.code;
      send({ type: 'result', id: item.id, error: typeof code === 'string' && /^[A-Z_]{1,80}$/.test(code) ? code : 'PLATFORM_OPERATION_FAILED' });
    } finally {
      executing.delete(item.id);
      if (!executing.size) { for (const resolve of drainWaiters) resolve(); drainWaiters.clear(); }
    }
  }
  const message = (raw: { toString(): string }) => { void receive(raw).catch(close); };
  socket.on('message', message); socket.on('close', close); socket.on('error', close);
  return {
    call(operation: unknown, { signal }: { signal?: AbortSignal } = {}): Promise<unknown> {
      check(); signal?.throwIfAborted();
      if (pending.size >= 128) throw Error('PLATFORM_REQUEST_LIMIT');
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const abort = () => {
          // Keep this request in flight until the executor acknowledges its end.
          // Rejecting early would let an upgrade race the still-running input.
          try { send({ type: 'cancel', id }); } catch { close(); }
        };
        pending.set(id, { resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort) });
        signal?.addEventListener('abort', abort, { once: true });
        try { send({ type: 'call', id, operation }); } catch { close(); }
      });
    },
    close,
    whenDrained: () => executing.size ? new Promise<void>(resolve => drainWaiters.add(resolve)) : Promise.resolve(),
  };
}
