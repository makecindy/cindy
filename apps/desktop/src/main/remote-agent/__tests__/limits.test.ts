import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { providerShareGuestPeer, isProviderSharePeer } from '@cindy/device-link';
import type { AgentEvent, AgentSessionHandle } from '@cindy/maker-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRemoteAgentHost, type RemoteAgentHostDeps } from '../host/runHost';
import { DEFAULT_REMOTE_AGENT_LIMITS, type RemoteAgentLimits } from '../../../shared/remoteAgentLimits';

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

function makeHost(extra: Partial<RemoteAgentHostDeps> = {}) {
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
        setInteractionResolver() {},
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
function request(runId = randomUUID(), extra: Record<string, unknown> = {}) {
  return { op: 'open', runId, agentKind: 'claude-code', payload: { json: {
    sessionId: runId, virtualWorkspace: true, options: { model: 'm' },
    workspace: { workingDir: '/project', platform: 'darwin', shell: 'bash' },
    projectFiles: [], ancestorFiles: [], personal: { files: [] }, mcpServers: [], ...extra,
  } } };
}
describe('provider computer session limits', () => {
  it('keeps defaults and advertises the configured limit', async () => {
    expect(DEFAULT_REMOTE_AGENT_LIMITS).toEqual({ perDevice: 16, total: 64 });
    const host = makeHost();
    expect(await host.handle('a', { op: 'caps' })).toMatchObject({ maxRuns: 2 });
    limits = { perDevice: 70, total: 100 };
    expect(await host.handle('a', { op: 'caps' })).toMatchObject({ maxRuns: 70 });
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
    const host = makeHost();
    const first = request();
    await host.handle('a', first);
    await host.handle('a', request());
    await host.handle('a', first);
    await vi.waitFor(() => expect(handles).toHaveLength(2));
    limits = { perDevice: 1, total: 1 };
    expect(host.limitUsage().total).toBe(2);
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
    const host = makeHost();
    const first = request();
    await host.handle('a', first);
    await vi.waitFor(() => expect(handles).toHaveLength(1));
    let finish!: () => void;
    vi.mocked(handles[0].close).mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const closing = host.handle('a', { op: 'close', runId: first.runId, mode: 'close', reason: 'navigation' });
    await expect(host.handle('a', request())).rejects.toThrow('[DEVICE_LIMIT]');
    finish();
    await closing;
    await host.handle('a', request());
    expect(host.limitUsage().total).toBe(1);
  });
  it('returns a slot after agent startup failure', async () => {
    limits = { perDevice: 1, total: 1 };
    const host = makeHost({ startHosted: async () => { throw new Error('startup failed'); } });
    await host.handle('a', request());
    await vi.waitFor(() => expect(host.limitUsage().total).toBe(0));
    await expect(host.handle('a', request())).resolves.toEqual({});
  });
});
