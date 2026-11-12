// Unit: run the production client executor with native/browser boundaries
// injected. A transport close must preserve resources; explicit disposal must
// release them before replacing the generation. No GUI, input or real timers.
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ execute: null as any, peers: [] as any[], sockets: [] as any[], backends: [] as any[] }));
vi.mock('electron', () => ({ app: { on() {}, once() {}, removeListener() {} }, webContents: { getAllWebContents: () => [] } }));
vi.mock('ws', () => ({ WebSocket: class extends EventEmitter {
  constructor() { super(); f.sockets.push(this); }
  terminate() { this.emit('close'); }
} }));
vi.mock('@cindy/maker-shared/host-platform-rpc', () => ({ createHostPlatformRpc: (_socket: unknown, deps: any) => {
  f.execute = deps.execute;
  const peer = { call: vi.fn(), close: vi.fn(), whenDrained: () => Promise.resolve() };
  f.peers.push(peer); return peer;
} }));
vi.mock('../authManager.js', () => ({ getAuthState: () => ({ user: { id: 'owner' } }) }));
vi.mock('../appSessionState.js', () => ({ activeOwnerScopeKey: () => 'scope', isAppSessionBoundaryPending: () => false }));
vi.mock('../mcp-integrations/computer.desktop.js', () => ({ getComputerMcpDeps: () => ({}), cleanupComputerDriverSession: vi.fn() }));
vi.mock('../remote-desktop/inputOwnership.js', () => ({ pauseDesktopInputForClientUpgrade: () => ({ release() {} }) }));
vi.mock('../mcp-integrations/browser.desktop.js', () => ({ createDesktopEmbeddedBackend: () => {
  const value = { call: vi.fn(async () => ({ generation: f.backends.length })), probeControl: vi.fn(), canReleaseClient: () => true, dispose: vi.fn(async () => {}) };
  f.backends.push(value); return value;
} }));
import { connectHostPlatformClient } from '../host-platform/client.desktop.js';

describe('client embedded browser lifecycle', () => {
  it('preserves the executor across reconnect and replaces it only after explicit disposal', async () => {
    vi.useFakeTimers();
    const client = connectHostPlatformClient({ baseUrl: 'http://127.0.0.1:1', token: 'fixture', instanceId: 'host' });
    try {
      const signal = new AbortController().signal;
      await f.execute({ method: 'identity', ownerId: 'owner' }, signal);
      const first = f.backends[0];
      await f.execute({ method: 'browser.call', request: {} }, signal);
      f.sockets[0].emit('close');
      await vi.advanceTimersByTimeAsync(250);
      expect(f.sockets).toHaveLength(2);
      expect(f.backends).toHaveLength(1);
      expect(first.dispose).not.toHaveBeenCalled();
      let release!: () => void;
      first.dispose.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
      const disposing = f.execute({ method: 'browser.dispose' }, signal);
      await Promise.resolve();
      expect(f.backends).toHaveLength(1);
      release(); await disposing;
      expect(first.dispose).toHaveBeenCalledTimes(1);
      expect(f.backends).toHaveLength(2);
      await f.execute({ method: 'browser.call', request: {} }, signal);
      expect(first.call).toHaveBeenCalledTimes(1);
      expect(f.backends[1].call).toHaveBeenCalledTimes(1);
      await client.close();
      expect(f.backends[1].dispose).toHaveBeenCalledTimes(1);
    } finally { await client.close(); vi.useRealTimers(); }
  });
});
