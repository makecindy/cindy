/**
 * The native Agent-Net engine in Node (Desktop's Agent-Net worker): `packages/agent-net-native/node`, a Node-API module around
 * the engine the phones load through their C ABI. It implements `NativeEnginePort`, so `NativeTransport` drives it as it
 * drives a phone's.
 *
 * The module runs the engine's own thread (the phones' pump thread): it receives, acknowledges, retransmits and paces without
 * this thread, and wakes it only when the engine has something to read, with one byte to a loopback UDP socket this thread
 * listens on (the module's thread never calls into Node: lib.rs). Every call here is synchronous and short (one engine call
 * under the module's lock); waiting is a promise that a wake byte or a timer settles, so nothing blocks this thread.
 */
import dgram from 'node:dgram';
// Not `import { createRequire }`: the worker bundle's banner (build.mjs) declares that name at the top of the same module.
import nodeModule from 'node:module';
import type { NativeEnginePort } from './nativeTransport.js';

/** What the module exports (packages/agent-net-native/node/src/lib.rs). */
export interface NodeNativeBinding {
  /** `wakePort`: a UDP port on 127.0.0.1 that receives a byte from `wakeSource()` when there is something to read. */
  create(options: string, wakePort: number): NodeNativeHandle;
}
interface NodeNativeHandle {
  command(input: string): string;
  io(input: Uint8Array): Uint8Array;
  ready(): boolean;
  wakeSource(): number;
  destroy(): void;
}
/**
 * The engine's options (packages/agent-net-native/src/lib.rs `create`): the identity's keys as they are (`keys`: the X25519
 * transport secret and the Ed25519 signing seed, base64url), or the seed and context they are derived from. They never leave
 * this process.
 */
export interface NodeNativeEngineOptions {
  keys?: { transport: string; signing: string };
  seed?: string;
  context?: string;
  deviceId: string;
  legacySigning?: boolean;
  udp?: boolean;
  enhancedTransport?: boolean;
}

/** Loads the module from an absolute path; throws when it is missing or does not load on this system. */
export function loadNodeNativeBinding(file: string): NodeNativeBinding {
  const binding = nodeModule.createRequire(file)(file) as Partial<NodeNativeBinding>;
  if (typeof binding?.create !== 'function') throw new Error('AGENT_NET_NATIVE_BINDING_INVALID');
  return binding as NodeNativeBinding;
}

const EMPTY = new Uint8Array(0);

export class NodeNativeEngine implements NativeEnginePort {
  private destroyed = false;
  /** The engine announced something to read and no wait has taken it yet. */
  private work = false;
  private readonly waiters = new Set<(work: boolean) => void>();

  private constructor(private readonly handle: NodeNativeHandle, private readonly wake: dgram.Socket) {
    const source = handle.wakeSource();
    // Only the module's own wake socket counts; anything else on this port is ignored.
    wake.on('message', (_bytes, from) => { if (from.port === source && from.address === '127.0.0.1') this.signal(); });
  }
  static async create(binding: NodeNativeBinding, options: NodeNativeEngineOptions): Promise<NodeNativeEngine> {
    const wake = dgram.createSocket('udp4');
    try {
      await new Promise<void>((resolve, reject) => { wake.once('error', reject); wake.bind(0, '127.0.0.1', () => { wake.off('error', reject); resolve(); }); });
      // It never keeps the worker alive by itself; a quiet error (the port went away) only costs a wake, and timers cover it.
      wake.unref();
      wake.on('error', () => undefined);
      return new NodeNativeEngine(binding.create(JSON.stringify(options), wake.address().port), wake);
    } catch (error) { wake.close(); throw error; }
  }

  async command<T = unknown>(command: Record<string, unknown>): Promise<T> {
    if (this.destroyed) throw new Error('AGENT_NET_ENGINE_CLOSED');
    const response = JSON.parse(this.handle.command(JSON.stringify(command))) as { ok: boolean; value?: T; code?: string };
    if (!response.ok) throw new Error(response.code || 'AGENT_NET_NATIVE_COMMAND_FAILED');
    return response.value as T;
  }
  /**
   * True as soon as the engine has something to read, false after `maxMs`. The engine first takes a turn here: what JS wrote
   * since its last read may have left a datagram for the relay WebSocket, which no packet on the socket would announce.
   */
  wait = (maxMs: number): Promise<boolean> => {
    if (this.destroyed) return Promise.reject(new Error('AGENT_NET_ENGINE_CLOSED'));
    if (this.work || this.handle.ready()) { this.work = false; return Promise.resolve(true); }
    return new Promise((resolve) => {
      const done = (work: boolean) => { clearTimeout(timer); this.waiters.delete(done); resolve(work); };
      const timer = setTimeout(() => done(false), Math.max(1, maxMs));
      this.waiters.add(done);
    });
  };
  /** See `NativeEnginePort.io`: with `waitMs` it waits as `wait` does and reads only when there is something (empty otherwise). */
  io = async (input: Uint8Array, waitMs = 0, kick = false): Promise<Uint8Array> => {
    if (waitMs > 0 && !(await this.wait(waitMs))) return EMPTY;
    if (this.destroyed) throw new Error('AGENT_NET_ENGINE_CLOSED');
    const output = this.handle.io(input);
    if (kick && this.handle.ready()) this.signal();
    return output;
  };
  /** A waiting call returns now and reads. */
  kick = (): void => { this.signal(); };
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.handle.destroy();
    this.wake.close();
    for (const done of [...this.waiters]) done(false);
  }
  private signal(): void {
    if (this.destroyed) return;
    if (!this.waiters.size) { this.work = true; return; }
    this.work = false;
    for (const done of [...this.waiters]) done(true);
  }
}
