import net, { type Socket } from 'node:net';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { TerminalClient } from './contracts.js';
import { withCrossProcessLock } from '@cindy/remote-agent/crossProcessLock';
import { atomicPrivateWrite, privateDirectory, readPrivateFile, socketPath, profileLifecycleLockPath } from './platform.js';

const MAX_FRAME = 8 * 1024 * 1024;
type Frame = Record<string, unknown>;
type Endpoint = { version: 1; pid: number; socket: string; key: string; instance: string };
function proof(key: string, role: string, client: string, server: string) {
  return createHmac('sha256', Buffer.from(key, 'hex')).update(`${role}:${client}:${server}`).digest('hex');
}
function sameProof(a: unknown, b: string) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
/**
 * A service.json pid is only a hint: after a crash or pid reuse it may refer
 * to an unrelated process. Prove ownership through the endpoint's HMAC
 * handshake before treating the record as a live Cindy service.
 */
async function probeEndpoint(endpoint: Endpoint): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection(endpoint.socket);
    let verifiedServer = false;
    let settled = false;
    const nonce = randomBytes(32).toString('hex');
    let timer: NodeJS.Timeout;
    const finish = (alive: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(alive);
    };
    timer = setTimeout(() => finish(false), 750);
    timer.unref();
    socket.once('connect', () => write(socket, { type: 'hello', nonce }));
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
    frames(socket, frame => {
      if (frame.type === 'challenge' && typeof frame.nonce === 'string'
        && /^[a-f0-9]{64}$/.test(frame.nonce)
        && sameProof(frame.proof, proof(endpoint.key, 'server', nonce, frame.nonce))) {
        verifiedServer = true;
        write(socket, { type: 'authenticate', proof: proof(endpoint.key, 'client', nonce, frame.nonce) });
      } else if (frame.type === 'ready' && verifiedServer) finish(true);
      else finish(false);
    });
  });
}
function write(socket: Socket, value: Frame) {
  const frame = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(frame) > MAX_FRAME || socket.writableLength > MAX_FRAME * 2) { socket.destroy(); return; }
  socket.write(frame);
}
function frames(socket: Socket, receive: (frame: Frame) => void) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', data => {
    buffer += data;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_FRAME) { socket.destroy(); return; }
      try {
        const frame: unknown = JSON.parse(line);
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('INVALID_FRAME');
        receive(frame as Frame);
      } catch { socket.destroy(); return; }
    }
    if (Buffer.byteLength(buffer) > MAX_FRAME) socket.destroy();
  });
}

export class TerminalTransportServer {
  private endpoint: Endpoint;
  private server = net.createServer(socket => this.accept(socket));
  private clients = new Set<Socket>();
  private connections = new Set<Socket>();
  private ending = false;
  constructor(private profileDir: string, private invoke: (channel: string, args: unknown[], deviceId?: string) => Promise<unknown>) {
    this.endpoint = { version: 1, pid: process.pid, socket: socketPath(profileDir), key: randomBytes(32).toString('hex'), instance: randomUUID() };
  }

  async listen(): Promise<void> {
    // The parent may be a user-selected shared folder (including /tmp). Never
    // chmod it as though it were our private profile.
    await fs.mkdir(path.dirname(this.profileDir), { recursive: true, mode: 0o700 });
    await withCrossProcessLock(profileLifecycleLockPath(this.profileDir), { label: 'terminal service startup' }, async status => {
    if (!status.held) throw new Error(status.reason === 'busy' ? 'SERVICE_ALREADY_STARTING' : 'SERVICE_LOCK_UNAVAILABLE');
    if (await readPrivateFile(`${profileLifecycleLockPath(this.profileDir)}.restore`)) throw new Error('PROFILE_RECOVERY_REQUIRED');
    await privateDirectory(this.profileDir);
    if (process.platform !== 'win32') await privateDirectory(path.dirname(this.endpoint.socket));
    const endpointPath = path.join(this.profileDir, 'service.json');
    const previous = await readPrivateFile(endpointPath);
    if (previous) {
      const old = JSON.parse(previous.toString()) as Endpoint;
      if (old.version !== 1 || !Number.isSafeInteger(old.pid) || old.pid <= 0 || old.socket !== this.endpoint.socket) throw new Error('SERVICE_ENDPOINT_INVALID');
      if (await probeEndpoint(old)) throw new Error('SERVICE_ALREADY_RUNNING');
      if (process.platform !== 'win32' && old.socket === this.endpoint.socket) {
        const stat = await fs.lstat(old.socket).catch(() => null);
        if (stat && (!stat.isSocket() || stat.uid !== process.getuid?.())) throw new Error('UNSAFE_SERVICE_SOCKET');
        await fs.rm(old.socket, { force: true });
      }
    }
    await new Promise<void>((resolve, reject) => {
      const failed = (error: NodeJS.ErrnoException) => reject(error.code === 'EADDRINUSE' ? new Error('SERVICE_ALREADY_RUNNING') : error);
      this.server.once('error', failed);
      this.server.listen(this.endpoint.socket, () => { this.server.off('error', failed); resolve(); });
    });
    this.server.on('error', () => { /* Per-client failures are reported at the caller. */ });
    if (process.platform !== 'win32') await fs.chmod(this.endpoint.socket, 0o600);
    try { await atomicPrivateWrite(endpointPath, JSON.stringify(this.endpoint)); }
    catch (error) { await this.closeUnlocked(); throw error; }
    });
  }

  publish(channel: string, args: unknown[]): void {
    for (const socket of this.clients) write(socket, { type: 'event', channel, args });
  }

  async close(): Promise<void> {
    if (this.ending) return;
    this.ending = true;
    await withCrossProcessLock(profileLifecycleLockPath(this.profileDir), { label: 'terminal service shutdown' }, async status => {
      if (!status.held) throw new Error('SERVICE_LOCK_UNAVAILABLE');
      await this.closeUnlocked();
    });
  }

  private async closeUnlocked(): Promise<void> {
    for (const client of this.connections) client.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    const file = path.join(this.profileDir, 'service.json');
    const current = await readPrivateFile(file);
    if (current && (JSON.parse(current.toString()) as Endpoint).instance === this.endpoint.instance) await fs.rm(file, { force: true });
  }

  private accept(socket: Socket): void {
    if (this.ending || this.connections.size >= 32) { socket.destroy(); return; }
    this.connections.add(socket);
    let clientNonce = '', serverNonce = '', authenticated = false, inFlight = 0;
    const deadline = setTimeout(() => socket.destroy(), 5000);
    deadline.unref();
    socket.on('error', () => {});
    socket.once('close', () => { clearTimeout(deadline); this.clients.delete(socket); this.connections.delete(socket); });
    frames(socket, frame => {
      if (!authenticated) {
        if (frame.type === 'hello' && !clientNonce && typeof frame.nonce === 'string' && /^[a-f0-9]{64}$/.test(frame.nonce)) {
          clientNonce = frame.nonce; serverNonce = randomBytes(32).toString('hex');
          write(socket, { type: 'challenge', nonce: serverNonce, proof: proof(this.endpoint.key, 'server', clientNonce, serverNonce) });
        } else if (frame.type === 'authenticate' && clientNonce && sameProof(frame.proof, proof(this.endpoint.key, 'client', clientNonce, serverNonce))) {
          authenticated = true; clearTimeout(deadline); this.clients.add(socket); write(socket, { type: 'ready' });
        } else socket.destroy();
        return;
      }
      if (frame.type !== 'invoke' || typeof frame.id !== 'string' || frame.id.length > 80 || typeof frame.channel !== 'string' || frame.channel.length > 160 || !Array.isArray(frame.args) || (frame.deviceId !== undefined && typeof frame.deviceId !== 'string')) { socket.destroy(); return; }
      if (inFlight >= 64) { write(socket, { type: 'result', id: frame.id, error: 'TOO_MANY_REQUESTS' }); return; }
      inFlight++;
      void this.invoke(frame.channel, frame.args, frame.deviceId as string | undefined).then(
        result => write(socket, { type: 'result', id: frame.id, result: result ?? null }),
        error => {
          // Exception messages may contain provider URLs or entered credentials.
          const remoteCode = error?.code === 'IPC_ERROR' && typeof error.message === 'string'
            ? /^\[([A-Z][A-Z0-9_]{1,79})\]/.exec(error.message)?.[1] : undefined;
          const raw = remoteCode ?? (error && typeof error === 'object' ? error.code ?? error.message : undefined);
          const code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(raw) ? raw : 'OPERATION_FAILED';
          write(socket, { type: 'result', id: frame.id, error: code });
        },
      ).finally(() => { inFlight--; });
    });
  }
}

export async function connectTerminal(profileDir: string): Promise<TerminalClient> {
  const raw = await readPrivateFile(path.join(profileDir, 'service.json'));
  if (!raw) throw new Error('SERVICE_NOT_RUNNING');
  const endpoint = JSON.parse(raw.toString()) as Endpoint;
  if (endpoint.version !== 1 || endpoint.socket !== socketPath(profileDir) || !/^[a-f0-9]{64}$/.test(endpoint.key) || !Number.isSafeInteger(endpoint.pid) || endpoint.pid <= 0 || typeof endpoint.instance !== 'string') throw new Error('SERVICE_ENDPOINT_INVALID');
  const socket = net.createConnection(endpoint.socket);
  const events = new EventEmitter();
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let ready = false, verifiedServer = false;
  const nonce = randomBytes(32).toString('hex');
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => { reject(new Error('SERVICE_CONNECT_TIMEOUT')); socket.destroy(); }, 5000);
    socket.once('connect', () => write(socket, { type: 'hello', nonce }));
    socket.on('error', () => { clearTimeout(deadline); if (!ready) reject(new Error('SERVICE_NOT_RUNNING')); });
    socket.once('close', () => {
      clearTimeout(deadline);
      if (!ready) reject(new Error('SERVICE_AUTHENTICATION_FAILED'));
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('CONNECTION_LOST_OUTCOME_UNKNOWN')); }
      pending.clear(); events.emit('push', 'terminal:connection-lost', []);
    });
    frames(socket, frame => {
      if (!ready) {
        if (frame.type === 'challenge' && typeof frame.nonce === 'string' && /^[a-f0-9]{64}$/.test(frame.nonce) && sameProof(frame.proof, proof(endpoint.key, 'server', nonce, frame.nonce))) {
          verifiedServer = true;
          write(socket, { type: 'authenticate', proof: proof(endpoint.key, 'client', nonce, frame.nonce) });
        } else if (frame.type === 'ready' && verifiedServer) { ready = true; clearTimeout(deadline); resolve(); }
        else socket.destroy();
        return;
      }
      if (frame.type === 'event' && typeof frame.channel === 'string' && Array.isArray(frame.args)) events.emit('push', frame.channel, frame.args);
      else if (frame.type === 'result' && typeof frame.id === 'string') {
        const item = pending.get(frame.id); if (!item) return;
        clearTimeout(item.timer); pending.delete(frame.id);
        if (typeof frame.error === 'string') item.reject(new Error(frame.error)); else item.resolve(frame.result);
      }
    });
  });
  return {
    invoke<T>(channel: string, args: unknown[] = [], deviceId?: string): Promise<T> {
      if (socket.destroyed) return Promise.reject(new Error('SERVICE_DISCONNECTED'));
      if (pending.size >= 64) return Promise.reject(new Error('TOO_MANY_REQUESTS'));
      const id = randomUUID();
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('REQUEST_TIMEOUT_OUTCOME_UNKNOWN')); }, 120_000);
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
        write(socket, { type: 'invoke', id, channel, args, ...(deviceId ? { deviceId } : {}) });
      });
    },
    subscribe(listener) { events.on('push', listener); return () => events.off('push', listener); },
    close() { socket.destroy(); },
  };
}

/** Reconnect the view, never replay an operation whose result is unknown. */
export function reconnectingClient(profileDir: string, initial: TerminalClient): TerminalClient {
  let connection: TerminalClient | undefined = initial;
  let closed = false;
  let attempts = 0;
  let timer: NodeJS.Timeout | undefined;
  let unsubscribe = () => {};
  const listeners = new Set<(channel: string, args: unknown[]) => void>();
  function emit(channel: string, args: unknown[]) { for (const listener of listeners) listener(channel,args); }
  function attach(client: TerminalClient) {
    unsubscribe();
    connection = client;
    unsubscribe = client.subscribe((channel,args) => {
      emit(channel,args);
      if (channel === 'terminal:connection-lost' && !closed) {
        connection = undefined;
        schedule();
      }
    });
  }
  function schedule() {
    if (closed || timer) return;
    timer = setTimeout(async () => {
      timer = undefined;
      try {
        const client = await connectTerminal(profileDir);
        if (closed) { client.close(); return; }
        attempts = 0; attach(client); emit('terminal:connection-ready',[]);
      } catch { attempts++; schedule(); }
    }, Math.min(30_000, 500 * 2 ** Math.min(attempts,6)));
    timer.unref();
  }
  attach(initial);
  return {
    invoke: <T>(channel: string, args?: unknown[], deviceId?: string) => connection ? connection.invoke<T>(channel,args,deviceId) : Promise.reject(new Error('SERVICE_RECONNECTING')),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() { closed = true; clearTimeout(timer); unsubscribe(); connection?.close(); listeners.clear(); },
  };
}
