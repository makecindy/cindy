import { ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  FILE_PEER_COMMAND_TIMEOUT_MS,
  FILE_PEER_RECEIVE_TIMEOUT_MS,
  FILE_PEER_WRITE_BATCH_BYTES,
  RPC_BODY_MAX_BYTES,
  type FilePeerRuntimeBridge,
} from '@cindy/device-link';
import { FILE_PEER_LOCAL, type FilePeerCommand } from '../../shared/filePeer';
import { DesktopCaptureWindow } from './captureWindow';
import type { TerminalFilePeerRuntime } from '../../../../cindy-terminal/src/remote/files';

/** The original isolated files renderer and its original bridge contract.
 * Path resolution, owner checks, file tickets and streaming credit remain in
 * the shared terminal host and createFilePeerRuntime respectively. */
export function createTerminalFilePeerRuntime(
  bridge: FilePeerRuntimeBridge,
): TerminalFilePeerRuntime {
  const connections = new Set<string>();
  const sinks = new Map<string, string>();
  const replies = new Map<
    string,
    {
      connection: string;
      timer: NodeJS.Timeout;
      resolve(value?: string): void;
      reject(error: Error): void;
    }
  >();
  let epoch = 0;
  let starting: Promise<void> | undefined;
  const host = new DesktopCaptureWindow(() => dispose(), 'files');
  const failure = () => new Error('FILE_PEER_UNAVAILABLE');
  const assertConnection = (id: unknown): string => {
    if (typeof id !== 'string' || !connections.has(id)) throw failure();
    return id;
  };
  const offset = (value: unknown): number => {
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw failure();
    return value as number;
  };
  const progress = (connection: string) => {
    assertConnection(connection);
    for (const pending of replies.values())
      if (pending.connection === connection) pending.timer.refresh();
  };
  function close(id: string) {
    if (!connections.delete(id)) return;
    for (const [key, pending] of replies)
      if (pending.connection === id) {
        clearTimeout(pending.timer);
        replies.delete(key);
        pending.reject(failure());
      }
    for (const [sink, connection] of sinks) if (connection === id) sinks.delete(sink);
    const contents = host.contents;
    if (contents && !contents.isDestroyed())
      contents.send(FILE_PEER_LOCAL.COMMAND, randomUUID(), { action: 'close', connection: id });
  }
  function dispose() {
    epoch++;
    starting = undefined;
    for (const id of [...connections]) {
      close(id);
      bridge.closed?.(id);
    }
    host.dispose();
  }
  async function command(value: FilePeerCommand): Promise<string | undefined> {
    const generation = epoch;
    assertConnection(value.connection);
    if (!starting && !host.contents) {
      const work = host.start().finally(() => {
        if (starting === work) starting = undefined;
      });
      starting = work;
    }
    await starting;
    if (generation !== epoch) throw failure();
    assertConnection(value.connection);
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(
        () => {
          replies.delete(id);
          close(value.connection);
          bridge.closed?.(value.connection);
          reject(new Error('FILE_PEER_TIMEOUT'));
        },
        value.action === 'receive' ? FILE_PEER_RECEIVE_TIMEOUT_MS : FILE_PEER_COMMAND_TIMEOUT_MS,
      );
      timer.unref();
      replies.set(id, { connection: value.connection, timer, resolve, reject });
      try {
        host.contents!.send(FILE_PEER_LOCAL.COMMAND, id, value);
      } catch {
        clearTimeout(timer);
        replies.delete(id);
        reject(failure());
      }
    });
  }
  ipcMain.handle(FILE_PEER_LOCAL.REGISTER, (event) => host.registered(event));
  ipcMain.handle(FILE_PEER_LOCAL.CLOSED, (event, id: unknown) => {
    host.assertSender(event);
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw failure();
    if (connections.has(id)) {
      close(id);
      bridge.closed?.(id);
    }
  });
  ipcMain.handle(FILE_PEER_LOCAL.REPLY, (event, id: unknown, ok: unknown, value: unknown) => {
    host.assertSender(event);
    if (
      typeof id !== 'string' ||
      typeof ok !== 'boolean' ||
      (value !== undefined && (typeof value !== 'string' || value.length > 4 * 1024 * 1024))
    )
      throw failure();
    const pending = replies.get(id);
    if (!pending) return;
    replies.delete(id);
    clearTimeout(pending.timer);
    if (ok) pending.resolve(value as string | undefined);
    else pending.reject(failure());
  });
  ipcMain.handle(
    FILE_PEER_LOCAL.READ,
    async (event, id: unknown, ticket: unknown, position: unknown) => {
      host.assertSender(event);
      assertConnection(id);
      if (typeof ticket !== 'string' || !/^[a-f0-9-]{36}$/.test(ticket)) throw failure();
      const value = await bridge.read(id as string, ticket, offset(position));
      progress(id as string);
      return value;
    },
  );
  ipcMain.handle(
    FILE_PEER_LOCAL.WRITE,
    async (event, sink: unknown, position: unknown, base64: unknown) => {
      host.assertSender(event);
      if (
        typeof sink !== 'string' ||
        !sinks.has(sink) ||
        typeof base64 !== 'string' ||
        base64.length > Math.ceil(FILE_PEER_WRITE_BATCH_BYTES / 3) * 4
      )
        throw failure();
      const connection = assertConnection(sinks.get(sink));
      await (bridge.writeBatch ?? bridge.write)(sink, offset(position), base64);
      progress(connection);
    },
  );
  ipcMain.handle(FILE_PEER_LOCAL.INVOKE, (event, id: unknown, payload: unknown, body: unknown) => {
    host.assertSender(event);
    assertConnection(id);
    if (
      typeof payload !== 'string' ||
      payload.length > 4 * 1024 * 1024 ||
      (body !== undefined &&
        (!(body instanceof Uint8Array) || body.byteLength > RPC_BODY_MAX_BYTES)) ||
      !bridge.invoke
    )
      throw failure();
    return bridge.invoke(id as string, payload, body as Uint8Array | undefined);
  });
  const open = (id: string) => {
    if (!/^[a-f0-9-]{36}$/.test(id) || connections.has(id)) throw failure();
    connections.add(id);
  };
  return {
    async offer(connection, servers, streaming) {
      open(connection);
      return (await command({ action: 'offer', connection, servers, streaming }))!;
    },
    async accept(connection, servers, sdp) {
      open(connection);
      return (await command({ action: 'accept', connection, servers, sdp }))!;
    },
    async answer(connection, sdp) {
      await command({ action: 'answer', connection, sdp });
    },
    async receive(connection, ticket, size, sink) {
      assertConnection(connection);
      sinks.set(sink, connection);
      try {
        await command({ action: 'receive', connection, ticket, size, sink });
      } finally {
        sinks.delete(sink);
      }
    },
    close,
    dispose,
  };
}
