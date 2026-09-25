import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../shared/ghost';
import {
  GhostNodeRuntimeBroker,
  type NodeWorkerProcess,
  type GhostNodeRuntimeBrokerDeps,
} from '../nodeRuntimeBroker';

class Worker extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  pid = 42;
  requests: Array<{ id: string; method: string; cindy?: unknown }> = [];
  controls: Array<Record<string, unknown>> = [];
  listener?: (value: unknown) => void;
  constructor(autoSpawn = true) {
    super();
    this.stdin.on('data', (chunk) => this.requests.push(JSON.parse(String(chunk))));
    if (autoSpawn) queueMicrotask(() => this.emit('spawn'));
  }
  onControl(listener: (value: unknown) => void) {
    this.listener = listener;
  }
  sendControl(value: unknown) {
    this.controls.push(value as Record<string, unknown>);
    return true;
  }
  kill(signal = 'SIGTERM') {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }
}

const brokers: GhostNodeRuntimeBroker[] = [];
afterEach(() => {
  for (const b of brokers.splice(0)) b.destroyAll();
});

function harness(
  autoSpawn = true,
  extra: Partial<GhostNodeRuntimeBrokerDeps> = {},
  identity?: { ghost?: InstalledGhost; requestId?: string },
) {
  const worker = new Worker();
  const children: Worker[] = [];
  const calls = new Map([
    ['call-a', new AbortController()],
    ['call-b', new AbortController()],
  ]);
  const ghost = identity?.ghost ?? {
    manifest: {
      id: 'test-plugin',
      name: 'Test',
      version: '1.0.0',
      network: { hosts: ['provider.example'] },
      node: {
        entry: 'worker.cjs',
        entries: ['child.cjs'],
        protocol: 'json-rpc-stdio',
        childSpawn: true,
      },
    },
    dir: path.resolve('test-plugin'),
    enabled: true,
  } as InstalledGhost;
  const requestId = identity?.requestId ?? ghost.manifest.id;
  const broker = new GhostNodeRuntimeBroker({
    ...extra,
    getGhost: extra.getGhost ?? (() => ghost),
    getCallSignal: extra.getCallSignal ?? ((id, callId) =>
      id === requestId ? (calls.get(callId)?.signal ?? null) : null),
    spawnProcess: () => {
      queueMicrotask(() => worker.emit('spawn'));
      return worker as NodeWorkerProcess;
    },
    spawnChildProcess: () => {
      const child = new Worker(autoSpawn);
      children.push(child);
      return child as NodeWorkerProcess;
    },
  });
  brokers.push(broker);
  const request = (callId?: string) =>
    broker.handleRequest(requestId, {
      type: 'node-request',
      method: 'tools/call',
      params: { name: 'login' },
      ...(callId ? { callId, cancelWithCall: true } : {}),
    });
  const spawn = (rpcId: string | undefined, reqId: string) =>
    worker.listener?.({
      type: 'spawn-child',
      reqId,
      entry: 'child.cjs',
      args: [],
      ...(rpcId ? { rpcId } : {}),
    });
  return { worker, children, calls, broker, request, spawn };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 50; i++) {
    if (check()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error('Expected lifecycle transition did not occur');
}

describe('Node cancellation boundaries', () => {
  it('stops a child cancelled before its ready handshake', async () => {
    const h = harness(false);
    const result = h.request('call-a');
    await until(() => h.worker.requests.length === 1);
    h.spawn(h.worker.requests[0].id, 'starting');
    await until(() => h.children.length === 1);
    h.calls.get('call-a')!.abort();
    expect(await result).toMatchObject({ ok: false, errorCode: 'CANCELLED' });
    await until(() => h.worker.controls.some((x) => x.reqId === 'starting'));
    expect(h.children[0].killed).toBe(true);
    expect(h.worker.controls.find((x) => x.reqId === 'starting')).toMatchObject({ ok: false });
    expect(h.worker.killed).toBe(false);
  });

  it('kills the cancelled request child and preserves another request in the same worker', async () => {
    const h = harness();
    const first = h.request('call-a');
    const second = h.request('call-b');
    await until(() => h.worker.requests.length === 2);
    const [a, b] = h.worker.requests;
    expect(a.cindy).toEqual({ cancelWithCall: true });
    h.spawn(a.id, 'spawn-a');
    h.spawn(b.id, 'spawn-b');
    await until(
      () => h.worker.controls.filter((x) => x.type === 'spawn-child-result').length === 2,
    );
    h.calls.get('call-a')!.abort();
    expect(await first).toMatchObject({ ok: false, errorCode: 'CANCELLED' });
    expect(h.children[0].killed).toBe(true);
    expect(h.children[1].killed).toBe(false);
    expect(h.worker.killed).toBe(false);
    h.spawn(a.id, 'late-spawn');
    await until(() => h.worker.controls.some((x) => x.reqId === 'late-spawn'));
    expect(h.children.length).toBe(2);
    expect(h.worker.controls.find((x) => x.reqId === 'late-spawn')).toMatchObject({ ok: false });
    h.worker.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { kept: true } }) + '\n',
    );
    expect(await second).toEqual({ ok: true, result: { kept: true } });
    expect(h.children[1].killed).toBe(true);
  });

  it('rejects stale bindings before starting a worker', async () => {
    const h = harness();
    expect(await h.request('missing')).toMatchObject({ ok: false, errorCode: 'CANCELLED' });
    h.calls.get('call-a')!.abort();
    expect(await h.request('call-a')).toMatchObject({ ok: false, errorCode: 'CANCELLED' });
    expect(h.worker.requests).toEqual([]);
  });

  it.each([undefined, false])('keeps legacy callId metadata nonbinding (opt-in: %s)', async cancelWithCall => {
    const h = harness();
    const result = h.broker.handleRequest('test-plugin', {
      type: 'node-request', method: 'background/start', callId: 'obsolete-call', cancelWithCall,
    });
    await until(() => h.worker.requests.length === 1);
    expect(h.worker.requests[0].cindy).toBeUndefined();
    h.spawn(undefined, 'background');
    await until(() => h.children.length === 1);
    h.worker.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: h.worker.requests[0].id, result: true }) + '\n');
    expect(await result).toEqual({ ok: true, result: true });
    expect(h.children[0].killed).toBe(false);
  });

  it('does not stop legacy autonomous children when an unbound RPC returns', async () => {
    const h = harness();
    const result = h.request();
    await until(() => h.worker.requests.length === 1);
    h.spawn(undefined, 'background');
    await until(() => h.worker.controls.some((x) => x.reqId === 'background'));
    const id = h.worker.requests[0].id;
    expect(h.worker.requests[0].cindy).toBeUndefined();
    h.worker.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: true }) + '\n');
    expect(await result).toEqual({ ok: true, result: true });
    expect(h.children[0].killed).toBe(false);
  });
});

describe('Node private authorization bridge', () => {
  it('cannot promote legacy callId metadata into an authorization capability', async () => {
    const open = vi.fn(), session = vi.fn(() => 'trusted-session');
    const h = harness(true, { getCallSessionId: session, openAuthorization: open });
    const result = h.broker.handleRequest('test-plugin', {
      type: 'node-request', method: 'legacy', callId: 'call-a',
    });
    await until(() => h.worker.requests.length === 1);
    const id = h.worker.requests[0].id;
    h.worker.listener?.({
      type: 'plugin-authorize', reqId: 'forged-opt-in', rpcId: id,
      request: { kind: 'browser', url: 'https://provider.example/activate' },
    });
    expect(h.worker.controls.find(x => x.reqId === 'forged-opt-in')).toMatchObject({ ok: false });
    expect(session).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    h.worker.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: 'original-completion' }) + '\n');
    expect(await result).toEqual({ ok: true, result: 'original-completion' });
  });

  it('routes generic device codes privately and keeps setup completion tied to the Node result', async () => {
    const finish = vi.fn(),
      dispose = vi.fn();
    const open = vi.fn(
      (input: Parameters<NonNullable<GhostNodeRuntimeBrokerDeps['openAuthorization']>>[0]) => {
        expect(input.sessionId).toBe('trusted-session');
        expect(input.request).toEqual({
          kind: 'device',
          url: 'https://provider.example/activate',
          userCode: '123456789',
        });
        return {
          opened: Promise.resolve(),
          result: Promise.resolve({ kind: 'opened' as const }),
          finish,
          dispose,
        };
      },
    );
    const h = harness(true, { getCallSessionId: () => 'trusted-session', openAuthorization: open });
    const result = h.request('call-a');
    await until(() => h.worker.requests.length === 1);
    const id = h.worker.requests[0].id;
    h.worker.listener?.({
      type: 'plugin-authorize',
      reqId: 'generic',
      rpcId: id,
      request: { kind: 'device', url: 'https://provider.example/activate', userCode: '123456789' },
    });
    await until(() => h.worker.controls.some((x) => x.reqId === 'generic'));
    expect(h.worker.controls.find((x) => x.reqId === 'generic')).toEqual({
      type: 'plugin-authorize-result',
      reqId: 'generic',
      ok: true,
      result: { kind: 'opened' },
    });
    expect(finish).not.toHaveBeenCalled();
    h.worker.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } }) + '\n');
    expect(await result).toEqual({ ok: true, result: { ok: true } });
    expect(finish).toHaveBeenCalledWith(true);
    expect(JSON.stringify(h.worker.requests)).not.toContain('123456789');
  });

  it('does not revive a cancelled generic request when its private callback arrives late', async () => {
    let receive!: (value: { kind: 'opened' }) => void;
    const waiting = new Promise<{ kind: 'opened' }>((r) => {
      receive = r;
    });
    const finish = vi.fn(),
      dispose = vi.fn();
    const h = harness(true, {
      getCallSessionId: () => 'trusted-session',
      openAuthorization: () => ({ opened: Promise.resolve(), result: waiting, finish, dispose }),
    });
    const result = h.request('call-a');
    await until(() => h.worker.requests.length === 1);
    const id = h.worker.requests[0].id;
    h.worker.listener?.({
      type: 'plugin-authorize',
      reqId: 'generic',
      rpcId: id,
      request: { kind: 'browser', url: 'https://provider.example/qr' },
    });
    h.calls.get('call-a')!.abort();
    expect(await result).toMatchObject({ ok: false, errorCode: 'CANCELLED' });
    receive({ kind: 'opened' });
    await until(() => h.worker.controls.some((x) => x.reqId === 'generic'));
    expect(h.worker.controls.find((x) => x.reqId === 'generic')).toMatchObject({ ok: false });
    expect(dispose).toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it('applies the same declared target check to generic browser requests', async () => {
    const open = vi.fn();
    const h = harness(true, { getCallSessionId: () => 'trusted-session', openAuthorization: open });
    const result = h.request('call-a');
    await until(() => h.worker.requests.length === 1);
    h.worker.listener?.({
      type: 'plugin-authorize',
      reqId: 'generic',
      rpcId: h.worker.requests[0].id,
      request: { kind: 'browser', url: 'https://untrusted.example/qr' },
    });
    expect(open).not.toHaveBeenCalled();
    expect(await result).toMatchObject({ ok: false, errorCode: 'CANCELLED' });
  });

  it('rejects an undeclared browser target and cancels the bound request', async () => {
    const open = vi.fn();
    const h = harness(true, {
      getCallSessionId: () => 'trusted-session',
      openDeviceAuthorization: open,
    });
    const result = h.request('call-a');
    await until(() => h.worker.requests.length === 1);
    h.worker.listener?.({
      type: 'device-authorize',
      reqId: 'untrusted-target',
      rpcId: h.worker.requests[0].id,
      url: 'https://untrusted.example/device',
    });
    expect(h.worker.controls.find((x) => x.reqId === 'untrusted-target')).toMatchObject({
      ok: false,
    });
    expect(open).not.toHaveBeenCalled();
    expect(await result).toMatchObject({ ok: false, errorCode: 'CANCELLED' });
  });

  it('binds to Main task identity, rejects unbound/duplicate control frames, and cancels only its child after opened', async () => {
    let input!: Parameters<NonNullable<GhostNodeRuntimeBrokerDeps['openDeviceAuthorization']>>[0];
    const dispose = vi.fn();
    const finish = vi.fn();
    const open = vi.fn((value: typeof input) => {
      input = value;
      return { opened: Promise.resolve(), finish, dispose };
    });
    const h = harness(true, {
      getCallSessionId: (g, id) =>
        g === 'test-plugin' && id === 'call-a' ? 'trusted-session' : null,
      openDeviceAuthorization: open,
    });
    const first = h.request('call-a');
    const second = h.request('call-b');
    await until(() => h.worker.requests.length === 2);
    const [a, b] = h.worker.requests;
    h.spawn(a.id, 'spawn-a');
    h.spawn(b.id, 'spawn-b');
    await until(
      () => h.worker.controls.filter((x) => x.type === 'spawn-child-result').length === 2,
    );
    const frame = {
      type: 'device-authorize',
      reqId: 'authorize-a',
      rpcId: a.id,
      url: 'https://provider.example/device?code=synthetic',
    };
    h.worker.listener?.({ ...frame, reqId: 'forged', rpcId: b.id });
    expect(open).not.toHaveBeenCalled();
    h.worker.listener?.(frame);
    await until(() => h.worker.controls.some((x) => x.reqId === 'authorize-a'));
    expect(h.worker.controls.find((x) => x.reqId === 'authorize-a')).toMatchObject({ ok: true });
    expect(input.sessionId).toBe('trusted-session');
    expect(input.ghost.id).toBe('test-plugin');
    input.assertCurrent();
    h.worker.listener?.({ ...frame, reqId: 'duplicate' });
    expect(open).toHaveBeenCalledTimes(1);
    expect(h.worker.controls.find((x) => x.reqId === 'duplicate')).toMatchObject({ ok: false });
    input.cancel();
    expect(await first).toMatchObject({ ok: false, errorCode: 'CANCELLED' });
    expect(dispose).toHaveBeenCalled();
    expect(() => input.assertCurrent()).toThrow();
    expect(h.children[0].killed).toBe(true);
    expect(h.children[1].killed).toBe(false);
    h.worker.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: a.id, result: { ok: true } }) + '\n',
    );
    expect(finish).not.toHaveBeenCalled();
    h.worker.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { ok: true } }) + '\n',
    );
    await second;
  });

  it('looks up remote authorization by physical instance id, not manifest ghostId', async () => {
    const storagePart = '_ns__acme__test-plugin';
    const orgGhost = {
      manifest: {
        id: 'test-plugin',
        name: 'Test',
        version: '1.0.0',
        network: { hosts: ['provider.example'] },
        node: {
          entry: 'worker.cjs',
          entries: ['child.cjs'],
          protocol: 'json-rpc-stdio',
          childSpawn: true,
        },
      },
      namespace: 'acme',
      dir: '/fake/_ns/acme/test-plugin',
      enabled: true,
    } as InstalledGhost;
    let input!: Parameters<NonNullable<GhostNodeRuntimeBrokerDeps['openDeviceAuthorization']>>[0];
    const open = vi.fn((value: typeof input) => {
      input = value;
      return { opened: Promise.resolve(), finish: vi.fn(), dispose: vi.fn() };
    });
    const h = harness(
      true,
      {
        getGhost: (id) => (id === storagePart ? orgGhost : null),
        getCallSessionId: (g, id) =>
          g === storagePart && id === 'call-a' ? 'trusted-session' : null,
        openDeviceAuthorization: open,
      },
      { ghost: orgGhost, requestId: storagePart },
    );
    const result = h.request('call-a');
    await until(() => h.worker.requests.length === 1);
    h.worker.listener?.({
      type: 'device-authorize',
      reqId: 'authorize-ns',
      rpcId: h.worker.requests[0].id,
      url: 'https://provider.example/device',
    });
    await until(() => h.worker.controls.some((x) => x.reqId === 'authorize-ns'));
    expect(open).toHaveBeenCalledTimes(1);
    expect(h.worker.controls.find((x) => x.reqId === 'authorize-ns')).toMatchObject({ ok: true });
    expect(input.ghost.id).toBe(storagePart);
    expect(input.sessionId).toBe('trusted-session');
    input.assertCurrent();
    h.worker.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: h.worker.requests[0].id, result: { ok: true } }) + '\n',
    );
    expect(await result).toEqual({ ok: true, result: { ok: true } });
  });

  it.each([true, false])(
    'finishes the authorization before invalidating its binding (CLI ok=%s)',
    async (ok) => {
      let assertCurrent!: () => void;
      const finish = vi.fn((value: boolean) => {
        assertCurrent();
        expect(value).toBe(ok);
      });
      const h = harness(true, {
        getCallSessionId: () => 'trusted-session',
        openDeviceAuthorization: (input) => {
          assertCurrent = input.assertCurrent;
          return { opened: Promise.resolve(), finish, dispose: () => {} };
        },
      });
      const result = h.request('call-a');
      await until(() => h.worker.requests.length === 1);
      const id = h.worker.requests[0].id;
      h.worker.listener?.({
        type: 'device-authorize',
        reqId: 'a',
        rpcId: id,
        url: 'https://provider.example/device',
      });
      await until(() => h.worker.controls.some((x) => x.reqId === 'a'));
      h.worker.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: { structuredContent: { ok }, isError: !ok },
        }) + '\n',
      );
      await result;
      expect(finish).toHaveBeenCalledWith(ok);
      expect(() => assertCurrent()).toThrow();
    },
  );
});
