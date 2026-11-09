import { EventEmitter } from 'node:events';
import net from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  SystemScreenSharingProbeHost,
  verifySystemScreenSharingHost,
} from '../systemScreenSharingProbe';

vi.mock('node:net', async (original) => {
  const actual = await original<typeof import('node:net')>();
  return { default: { ...actual, createServer: vi.fn(), createConnection: vi.fn() } };
});

// Unit: real ephemeral signatures and host/client entry points over in-memory sockets.
// New behavior: verify the selected Cindy peer at a private IP without OS credentials.
// Existing viewer tests mock TCP reachability and cannot catch forged/replayed proofs,
// endpoint-address mismatches, stale listeners or cross-controller cleanup.
class Socket extends EventEmitter {
  localAddress = '10.0.0.8';
  other?: Socket;
  destroyed = false;
  setTimeout() {
    return this;
  }
  write(text: string) {
    queueMicrotask(() => {
      if (!this.other?.destroyed) this.other?.emit('data', Buffer.from(text));
    });
    return true;
  }
  end(text: string) {
    this.write(text);
    return this;
  }
  destroy() {
    if (this.destroyed) return this;
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
    this.other?.destroy();
    return this;
  }
}
class Server extends EventEmitter {
  listening = false;
  maxConnections = 0;
  port = 0;
  constructor(readonly accept: (socket: net.Socket) => void) {
    super();
  }
  listen(_port: number, _host: string, ready: () => void) {
    this.port = nextPort++;
    queueMicrotask(() => {
      this.listening = true;
      servers.set(this.port, this);
      ready();
    });
    return this;
  }
  address() {
    return { port: this.port };
  }
  close() {
    this.listening = false;
    servers.delete(this.port);
    return this;
  }
  unref() {
    return this;
  }
}
let nextPort = 50000;
const servers = new Map<number, Server>();
const host = new SystemScreenSharingProbeHost();
const id = '1'.repeat(32);
const secondId = '2'.repeat(32);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(net.createServer).mockImplementation(
    ((accept: (socket: net.Socket) => void) => new Server(accept)) as unknown as typeof net.createServer,
  );
  vi.mocked(net.createConnection).mockImplementation(((options: { port: number }) => {
    const client = new Socket();
    const serverSocket = new Socket();
    client.other = serverSocket;
    serverSocket.other = client;
    queueMicrotask(() => {
      const server = servers.get(options.port);
      if (!server?.listening) return void client.destroy();
      server.accept(serverSocket as unknown as net.Socket);
      client.emit('connect');
    });
    return client;
  }) as unknown as typeof net.createConnection);
});
afterEach(() => {
  host.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('verifies a new challenge at the reported private IP and closes the listener on end', async () => {
  const proof = await host.begin('controller-a', id, () => true);
  expect(await verifySystemScreenSharingHost('10.0.0.8', proof, id, () => true)).toBe(true);
  host.stop('controller-a', id);
  expect(servers.size).toBe(0);
  expect(await verifySystemScreenSharingHost('10.0.0.8', proof, id, () => true)).toBe(false);
});

it('rejects a different peer key and an endpoint at a different private address', async () => {
  const proof = await host.begin('controller-a', id, () => true);
  const other = await host.begin('controller-b', secondId, () => true);
  expect(
    await verifySystemScreenSharingHost(
      '10.0.0.8',
      { ...proof, publicKey: other!.publicKey },
      id,
      () => true,
    ),
  ).toBe(false);
  expect(await verifySystemScreenSharingHost('10.0.0.9', proof, id, () => true)).toBe(false);
});

it('rejects replaying a previous signature for a fresh challenge', async () => {
  const proof = await host.begin('controller-a', id, () => true);
  const write = Socket.prototype.write;
  let savedReply: string | undefined;
  vi.spyOn(Socket.prototype, 'write').mockImplementation(function (this: Socket, text: string) {
    if (text.includes('"signature"')) {
      savedReply ??= text;
      return write.call(this, savedReply);
    }
    return write.call(this, text);
  });
  expect(await verifySystemScreenSharingHost('10.0.0.8', proof, id, () => true)).toBe(true);
  expect(await verifySystemScreenSharingHost('10.0.0.8', proof, id, () => true)).toBe(false);
});

it('rejects public/loopback targets and malformed descriptors before opening a socket', async () => {
  const proof = await host.begin('controller-a', id, () => true);
  for (const address of ['8.8.8.8', '127.0.0.1', '169.254.1.1', '::1', '10.0.0.8;id']) {
    expect(await verifySystemScreenSharingHost(address, proof, id, () => true)).toBe(false);
  }
  for (const patch of [{ id: secondId }, { port: 0 }, { port: 70000 }, { publicKey: 'invalid' }]) {
    expect(
      await verifySystemScreenSharingHost('10.0.0.8', { ...proof, ...patch }, id, () => true),
    ).toBe(false);
  }
  expect(net.createConnection).not.toHaveBeenCalled();
});

it('closes a pending listener when cancelled before listen completes', async () => {
  const pending = host.begin('controller-a', id, () => true);
  host.stop('controller-a', id);
  expect(await pending).toBeNull();
  await Promise.resolve();
  expect(servers.size).toBe(0);
});

it('revokes an old proof without disrupting another controller', async () => {
  let current = true;
  const first = await host.begin('controller-a', id, () => current);
  const second = await host.begin('controller-b', secondId, () => true);
  current = false;
  expect(await verifySystemScreenSharingHost('10.0.0.8', first, id, () => true)).toBe(false);
  expect(await verifySystemScreenSharingHost('10.0.0.8', second, secondId, () => true)).toBe(true);
});

it('expires an unused listener and rejects a stale controller result', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const proof = await host.begin('controller-a', id, () => true);
  expect(await verifySystemScreenSharingHost('10.0.0.8', proof, id, () => false)).toBe(false);
  vi.advanceTimersByTime(10_000);
  expect(servers.size).toBe(0);
});
