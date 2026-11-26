import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { providerShareGuestPeer, isProviderSharePeer } from '@cindy/device-link';
import type { AgentEvent, AgentSessionHandle } from '@cindy/maker-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRemoteAgentHost, type RemoteAgentHostDeps } from '../host/runHost';
import { DEFAULT_REMOTE_AGENT_LIMITS, type RemoteAgentLimits } from '../../../shared/remoteAgentLimits';
import { createProviderGroupGuestRelay } from '../../provider-group/guestRelay';
import { createProviderGroupRouter } from '../../provider-group/router';
import { createProviderGroupExternalLoad } from '../../provider-group/externalLoad';
import type { ProviderGroupConfig } from '../../../shared/providerGroup';

let root: string;
let limits: RemoteAgentLimits;
const hosts: ReturnType<typeof createRemoteAgentHost>[] = [];
const handles: AgentSessionHandle[] = [];
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-run-limits-'));
  limits = { perDevice: 2, total: 3 };
});
afterEach(async () => {
  for (const host of hosts.splice(0)) { await host.abortAll(); host.dispose(); }
  handles.length = 0;
  await new Promise(resolve => setTimeout(resolve, 30));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function makeHost(extra: Partial<RemoteAgentHostDeps> = {}, onStarted = () => {}) {
  const host = createRemoteAgentHost({
    readLimits: () => limits,
    isAgentAvailable: () => true,
    isControllerAuthorized: () => true,
    controllerTrust: c => isProviderSharePeer(c) ? 'guest' : 'owner',
    providerAccess: { resolve: async () => 'provider', isAllowed: () => true },
    bindGuestProviderRoute: async () => ({ routeToken: 'test', modelIds: ['m'], release() {} }),
    startHosted: async input => {
      const handle: AgentSessionHandle = {
        id: input.hostSessionId, agentKind: input.kind, model: input.options.model,
        send: async () => {}, steer: async () => {}, abort: async () => {}, close: vi.fn(async () => {}),
        events: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<AgentEvent>>(() => {}) }) }),
        getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
        setInteractionResolver: onStarted,
      };
      handles.push(handle);
      return handle;
    },
    captureOwner: () => 'owner',
    isOwnerCurrent: () => true,
    runsRoot: root,
    ...extra,
  });
  hosts.push(host);
  return host;
}

// open acknowledges receipt before the shadow workspace and tunnel are ready.
// Wait for handle installation rather than vi.waitFor's 1s disk-speed budget;
// the suite's normal test timeout still catches startup that never completes.
function whenStarted(count: number) {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, onStarted: () => { if (--count === 0) resolve(); } };
}

function request(runId = randomUUID(), extra: Record<string, unknown> = {}) {
  return { op: 'open', runId, agentKind: 'claude-code', payload: { json: {
    sessionId: runId, virtualWorkspace: true, options: { model: 'm' },
    workspace: { workingDir: '/project', platform: 'darwin', shell: 'bash' },
    projectFiles: [], ancestorFiles: [], personal: { files: [] }, mcpServers: [], ...extra,
  } } };
}
describe('provider computer session limits', () => {
  it('recovers guest allocation after idle relays fill their shared authenticated controller quota', async () => {
    limits = { perDevice: 2, total: 3, idleMinutes: 30 };
    const started = whenStarted(2);
    const host = makeHost({}, started.onStarted);
    const first = request(undefined, { relay: 'aaaaaaaaaaaaaaaa' });
    await host.handle('group-computer', first);
    await host.handle('group-computer', request(undefined, { relay: 'bbbbbbbbbbbbbbbb' }));
    await started.promise;
    const failure = await host.handle('group-computer', request(undefined, { relay: 'cccccccccccccccc' }))
      .catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ message: expect.stringContaining('[DEVICE_LIMIT]') });
    expect(host.limitUsage()).toEqual({ total: 2, devices: 1, largestDevice: 2 });
    const config: ProviderGroupConfig = { strategy: 'order', autoSwitch: true, members: ['executor', 'spare'].map(id => ({
      key: `device:${id}:provider`, kind: 'device', agentDeviceId: id, providerId: 'provider', limit: 4, weight: 1, paused: false,
    })) };
    const router = createProviderGroupRouter({ readGroup: () => config, listBindings: () => ({}),
      isTurnRunning: () => false, now: () => 1_000,
      // Only catalog transport is faked: both real production scheduler and
      // real executor capacity handling are used. Idle handles report zero load.
      directory: { resolveMembers: async () => config.members.map(member => ({ member, label: member.key,
        state: 'ok' as const, reportedRunning: 0, view: { id: 'provider', connected: true,
          agents: ['claude-code'], models: { 'claude-code': [{ id: 'm' }] } } })) } as never,
    });
    const relay = createProviderGroupGuestRelay({ scope: () => ({ router,
      externalLoad: createProviderGroupExternalLoad({ now: () => 1_000 }), isCurrent: () => true }),
      readGroup: () => config, connect: () => ({ invoke: args => host.handle('group-computer', args[0]), poller: {} as never }),
      now: () => 1_000, log: { warn() {} } });
    const plan = { kind: 'claude-code' as const, providerId: 'provider', model: 'm', exclude: new Set<string>() };
    relay.noteStartFailure('provider', { memberKey: config.members[0].key, agentDeviceId: 'executor',
      providerId: 'provider', sameAccount: true }, failure);
    expect(await relay.plan(plan)).toMatchObject({ agentDeviceId: 'spare' });
    await host.handle('group-computer', { op: 'close', runId: first.runId, mode: 'close', reason: 'navigation' });
    expect(await relay.plan(plan)).toMatchObject({ agentDeviceId: 'executor' });
  });
  // Unit: real host open → replacement of an idle logical session. Previously
  // only same-runId retries were tested; a reconnect uses a NEW runId, and at
  // capacity could never reach startRun's superseded-instance cleanup.
  it.each([undefined, 'aaaaaaaaaaaaaaaa'])('replaces its own idle session at capacity (relay=%s)', async relay => {
    limits = { perDevice: 1, total: 1, idleMinutes: 30 };
    const started = whenStarted(1);
    const host = makeHost({}, started.onStarted);
    const first = request(undefined, { sessionId: 'logical-session', ...(relay ? { relay } : {}) });
    await host.handle('a', first);
    await started.promise;
    // setInteractionResolver runs at the end of startup; let its finally settle.
    await new Promise(resolve => setImmediate(resolve));
    await expect(host.handle('a', request(undefined, { sessionId: 'logical-session', ...(relay ? { relay } : {}) })))
      .resolves.toEqual({});
    expect(handles[0].close).toHaveBeenCalledOnce();
    expect(host.limitUsage().total).toBe(1);
  });
  it('keeps defaults and advertises the configured limit', async () => {
    expect(DEFAULT_REMOTE_AGENT_LIMITS).toEqual({ perDevice: 16, total: 64, idleMinutes: 30 });
    const host = makeHost();
    expect(await host.handle('a', { op: 'caps' })).toMatchObject({ maxRuns: 2 });
    limits = { perDevice: 70, total: 100 };
    expect(await host.handle('a', { op: 'caps' })).toMatchObject({ maxRuns: 70 });
  });
  it('reports authenticated device and total capacity including idle and closing instances', async () => {
    limits = { perDevice: 1, total: 2 };
    const started = whenStarted(1);
    const host = makeHost({}, started.onStarted);
    const first = request();
    await host.handle('a', first);
    await started.promise;
    expect(await host.handle('a', { op: 'caps' })).toMatchObject({ runCapacityAvailable: false });
    expect(await host.handle('b', { op: 'caps' })).toMatchObject({ runCapacityAvailable: true });
    let release!: () => void;
    vi.mocked(handles[0].close).mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const closing = host.handle('a', { op: 'close', runId: first.runId, mode: 'close', reason: 'navigation' });
    expect(await host.handle('a', { op: 'caps' })).toMatchObject({ runCapacityAvailable: false });
    release();
    await closing;
    expect(await host.handle('a', { op: 'caps' })).toMatchObject({ runCapacityAvailable: true });
    await host.handle('b', request());
    await host.handle('c', request());
    expect(await host.handle('a', { op: 'caps' })).toMatchObject({ runCapacityAvailable: false });
  });
  it.each(['busy', 'other-controller', 'other-relay', 'denied-provider'] as const)
    ('does not evict an ineligible instance to reconnect (%s)', async reason => {
      limits = { perDevice: 1, total: 1 };
      const started = whenStarted(1);
      let allowed = true;
      const host = makeHost({ providerAccess: { resolve: async () => allowed ? 'p' : null,
        isAllowed: () => allowed } }, started.onStarted);
      await host.handle('a', request(undefined, { sessionId: 'same-session', relay: 'aaaaaaaaaaaaaaaa' }));
      await started.promise;
      await new Promise(resolve => setImmediate(resolve));
      if (reason === 'busy') handles[0].isTurnRunning = () => true;
      if (reason === 'denied-provider') allowed = false;
      await expect(host.handle(reason === 'other-controller' ? 'b' : 'a', request(undefined,
        { sessionId: 'same-session', relay: reason === 'other-relay' ? 'bbbbbbbbbbbbbbbb' : 'aaaaaaaaaaaaaaaa' })))
        .rejects.toThrow(reason === 'denied-provider' ? 'PROVIDER_NOT_ALLOWED' : reason === 'other-controller' ? 'TOTAL_LIMIT' : 'DEVICE_LIMIT');
      expect(handles[0].close).not.toHaveBeenCalled();
      expect(host.limitUsage().total).toBe(1);
    });
  it('keeps the replacement reservation behind the old native close and rechecks permission afterwards', async () => {
    limits = { perDevice: 1, total: 1 };
    const started = whenStarted(1);
    let allowed = true;
    const host = makeHost({ providerAccess: { resolve: async () => 'p', isAllowed: () => allowed } }, started.onStarted);
    await host.handle('a', request(undefined, { sessionId: 'same-session' }));
    await started.promise;
    await new Promise(resolve => setImmediate(resolve));
    const closing = whenStarted(1);
    let release!: () => void;
    vi.mocked(handles[0].close).mockImplementation(() => {
      closing.onStarted();
      return new Promise<void>(resolve => { release = resolve; });
    });
    const replacing = host.handle('a', request(undefined, { sessionId: 'same-session' }));
    // Attach the rejection assertion before settling the deferred close.
    const result = expect(replacing).rejects.toThrow('PROVIDER_NOT_ALLOWED');
    try {
      await closing.promise;
      expect(host.limitUsage().total).toBe(1);
      await expect(host.handle('b', request())).rejects.toThrow('[TOTAL_LIMIT]');
      allowed = false;
    } finally { release(); }
    await result;
    expect(host.limitUsage().total).toBe(0);
    expect(handles).toHaveLength(1);
  });
  it('combines shares and direct connections from one authenticated device', async () => {
    const host = makeHost();
    await host.handle(providerShareGuestPeer('share-a', 'member-a', 'device-a'), request());
    await host.handle(providerShareGuestPeer('share-b', 'member-b', 'device-a'), request());
    await expect(host.handle('device-a', request())).rejects.toThrow('[REMOTE_AGENT_BUSY] [DEVICE_LIMIT]');
    expect(host.limitUsage()).toEqual({ total: 2, devices: 1, largestDevice: 2 });
    await host.handle('device-b', request());
    await expect(host.handle('device-c', request())).rejects.toThrow('[REMOTE_AGENT_BUSY] [TOTAL_LIMIT]');
  });
  it('does not multiply capacity with different relay identifiers', async () => {
    const host = makeHost();
    await host.handle('group-device', request(undefined, { relay: 'aaaaaaaaaaaaaaaa' }));
    await host.handle('group-device', request(undefined, { relay: 'bbbbbbbbbbbbbbbb' }));
    await expect(host.handle('group-device', request(undefined, { relay: 'cccccccccccccccc' }))).rejects.toThrow('[DEVICE_LIMIT]');
  });
  it('still refuses unapproved reshares with free capacity', async () => {
    const host = makeHost({ reshare: { allows: () => false, sync: async () => ({ entries: [] }) } });
    await expect(host.handle(providerShareGuestPeer('s', 'm', 'd'),
      request(undefined, { relay: 'aaaaaaaaaaaaaaaa', reshareKey: 'bbbbbbbbbbbbbbbb' }))).rejects.toThrow('REMOTE_AGENT_RESHARE_NOT_ALLOWED');
    expect(host.limitUsage().total).toBe(0);
  });
  it('rechecks after async preparation to prevent concurrent opens exceeding the total', async () => {
    limits = { perDevice: 1, total: 1 };
    let ready!: () => void;
    const gate = new Promise<void>(resolve => { ready = resolve; });
    const host = makeHost({ providerAccess: { resolve: async () => { await gate; return 'p'; }, isAllowed: () => true } });
    const pending = Array.from({ length: 8 }, (_, i) => host.handle('device-' + i, request()));
    ready();
    const results = await Promise.allSettled(pending);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(host.limitUsage().total).toBe(1);
  });
  it('keeps retries idempotent and existing tasks alive after lowering limits', async () => {
    const started = whenStarted(2);
    const host = makeHost({}, started.onStarted);
    const first = request();
    await host.handle('a', first);
    await host.handle('a', request());
    await host.handle('a', first);
    await started.promise;
    expect(handles).toHaveLength(2);
    limits = { perDevice: 1, total: 1 };
    expect(host.limitUsage().total).toBe(2);
    expect(handles.every(h => vi.mocked(h.close).mock.calls.length === 0)).toBe(true);
    await expect(host.handle('a', request(undefined, { sessionId: first.runId }))).rejects.toThrow('[DEVICE_LIMIT]');
    expect(handles.every(h => vi.mocked(h.close).mock.calls.length === 0)).toBe(true);
    await expect(host.handle('b', request())).rejects.toThrow('[TOTAL_LIMIT]');
    await host.handle('a', { op: 'close', runId: first.runId, mode: 'close', reason: 'navigation' });
    expect(host.limitUsage().total).toBe(1);
    limits = { perDevice: 2, total: 3 };
    await host.handle('b', request());
    expect(host.limitUsage().total).toBe(2);
  });
  it('counts a slot until asynchronous close finishes', async () => {
    limits = { perDevice: 1, total: 1 };
    const started = whenStarted(1);
    const host = makeHost({}, started.onStarted);
    const first = request();
    await host.handle('a', first);
    await started.promise;
    expect(handles).toHaveLength(1);
    let finish!: () => void;
    vi.mocked(handles[0].close).mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const closing = host.handle('a', { op: 'close', runId: first.runId, mode: 'close', reason: 'navigation' });
    await expect(host.handle('a', request())).rejects.toThrow('[DEVICE_LIMIT]');
    finish();
    await closing;
    await host.handle('a', request());
    expect(host.limitUsage().total).toBe(1);
  });
  // Unit regression: open ACKs before startHosted completes. Closing during
  // startup must not free capacity while that native process is still starting
  // or closing; the existing close test only covers an installed handle.
  it('retains capacity through cancelled startup and the late native close', async () => {
    limits = { perDevice: 1, total: 1 };
    const entered = whenStarted(1);
    const closingNative = whenStarted(1);
    let releaseStart!: () => void;
    let releaseClose!: () => void;
    const startGate = new Promise<void>(resolve => { releaseStart = resolve; });
    const closeGate = new Promise<void>(resolve => { releaseClose = resolve; });
    const host = makeHost({ startHosted: async input => {
      entered.onStarted();
      await startGate;
      return {
        id: input.hostSessionId, agentKind: input.kind, model: input.options.model,
        close: async () => { closingNative.onStarted(); await closeGate; },
      } as AgentSessionHandle;
    } });
    const first = request();
    try {
      await host.handle('a', first);
      await entered.promise;
      await host.handle('a', { op: 'close', runId: first.runId, mode: 'close', reason: 'navigation' });
      expect(host.limitUsage()).toEqual({ total: 1, devices: 1, largestDevice: 1 });
      await expect(host.handle('b', request())).rejects.toThrow('[TOTAL_LIMIT]');
      releaseStart();
      await closingNative.promise;
      await expect(host.handle('b', request())).rejects.toThrow('[TOTAL_LIMIT]');
      releaseClose();
      await vi.waitFor(() => expect(host.limitUsage().total).toBe(0));
      await expect(host.handle('b', request())).resolves.toEqual({});
    } finally {
      releaseStart();
      releaseClose();
      await host.dispose();
    }
  });
  it('returns a slot after agent startup failure', async () => {
    limits = { perDevice: 1, total: 1 };
    const entered = whenStarted(1);
    const host = makeHost({ startHosted: async () => {
      entered.onStarted();
      throw new Error('startup failed');
    } });
    await host.handle('a', request());
    // Preparation performs real IO; measure slot cleanup after the failing
    // startup is actually reached, retaining waitFor's original 1s budget.
    await entered.promise;
    await vi.waitFor(() => expect(host.limitUsage().total).toBe(0));
    await expect(host.handle('a', request())).resolves.toEqual({});
  });
});
