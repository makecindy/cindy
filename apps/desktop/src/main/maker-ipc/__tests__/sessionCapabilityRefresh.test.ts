import { describe, expect, it, vi } from 'vitest';
import {
  createSessionCapabilityRefreshCoordinator,
  type CapabilityRefreshSession,
} from '../sessionCapabilityRefresh';
import { createSessionCapabilityMonitor, type CapabilityResourceSnapshot } from '../sessionCapabilityMonitor';
import { readCapabilityFiles, readForwardedCapabilitySnapshot, watchCapabilityPaths, watchRemoteCapabilityPaths } from '../sessionCapabilitySources';
import type { RemoteFileBrowserManager } from '../../file-browser/remote';
import { hasLocalAgentVisibleRuntime, registerLocalAgentVisibleRuntime, takeOverLocalAgentVisibleSession } from '../../local-agent/visibleSessions';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Test value: the production coordinator must not dispatch/acknowledge a new
 * Skill/MCP revision using an old runtime receipt (approved original-task reload
 * feature). BotCompactRuntimeRefresh covers Bot profile boundaries only; it has
 * no applied revision or replacement receipt. Minimal input: one live task and
 * a second change while its first reload is pending. Tier: unit, in-memory only.
 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(timeoutMs?: number) {
  const initial: CapabilityRefreshSession = { id: 'task', instanceId: 'runtime-1' };
  let current = initial;
  let idle = true;
  let activeOwner = true;
  const refresh = vi.fn(async (session: CapabilityRefreshSession, isCurrent: () => boolean) => {
    if (!isCurrent()) throw new Error('stale owner');
    current = { id: session.id, instanceId: `${session.instanceId}-next` };
    return current;
  });
  const coordinator = createSessionCapabilityRefreshCoordinator({
    isCurrent: (session) => activeOwner && session === current,
    isIdle: () => idle,
    refresh,
    timeoutMs,
  });
  return {
    initial, coordinator, refresh,
    get current() { return current; },
    set current(value) { current = value; },
    setIdle(value: boolean) { idle = value; },
    setOwner(value: boolean) { activeOwner = value; },
  };
}

describe('original task capability refresh', () => {
  it('reports timeout while retaining the native operation until it actually settles', async () => {
    vi.useFakeTimers();
    try {
      const h = fixture(100);
      const loading = deferred<CapabilityRefreshSession>();
      h.refresh.mockImplementationOnce(() => loading.promise);
      h.coordinator.markChanged(h.initial);
      const first = h.coordinator.beforeSend(h.initial);
      await vi.advanceTimersByTimeAsync(100);
      expect(h.coordinator.state(h.initial)?.phase).toBe('failed');
      const retry = h.coordinator.beforeSend(h.initial);
      expect(h.refresh).toHaveBeenCalledOnce();
      h.current = { id: 'task', instanceId: 'two' };
      loading.resolve(h.current);
      expect((await first).kind).toBe('failed');
      expect((await retry).kind).toBe('failed');
      expect(h.refresh).toHaveBeenCalledOnce();
      expect(h.coordinator.state(h.current)?.appliedRevision).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('does no work without a change and merges changes before the safe boundary', async () => {
    const h = fixture();
    await expect(h.coordinator.attempt(h.initial)).resolves.toEqual({ kind: 'unchanged' });
    h.coordinator.markChanged(h.initial);
    h.coordinator.markChanged(h.initial);
    const result = await h.coordinator.attempt(h.initial);
    expect(result).toEqual({
      kind: 'refreshed', session: h.current,
    });
    expect(h.refresh).toHaveBeenCalledOnce();
    expect(h.coordinator.state(h.current)).toMatchObject({
      phase: 'loaded', revision: 2, appliedRevision: 2,
    });
    await expect(h.coordinator.attempt(h.current)).resolves.toEqual({ kind: 'unchanged' });
    expect(h.refresh).toHaveBeenCalledOnce();
  });

  it('preserves pending changes while a turn, background work or interaction is active', async () => {
    const h = fixture();
    h.coordinator.markChanged(h.initial);
    h.setIdle(false);
    await expect(h.coordinator.attempt(h.initial)).resolves.toEqual({ kind: 'deferred' });
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.coordinator.state(h.initial)?.phase).toBe('pending');
    h.setIdle(true);
    await expect(h.coordinator.attempt(h.initial)).resolves.toMatchObject({ kind: 'refreshed' });
  });

  it('joins concurrent sends and settles only after actual loading completes', async () => {
    const h = fixture();
    const loading = deferred<CapabilityRefreshSession>();
    h.refresh.mockImplementationOnce(() => loading.promise);
    h.coordinator.markChanged(h.initial);
    let completed = false;
    const first = h.coordinator.attempt(h.initial).then((result) => { completed = true; return result; });
    const second = h.coordinator.attempt(h.initial);
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(h.refresh).toHaveBeenCalledOnce();
    expect(h.coordinator.state(h.initial)?.phase).toBe('refreshing');
    const replacement = { id: 'task', instanceId: 'runtime-2' };
    h.current = replacement;
    loading.resolve(replacement);
    expect(await first).toEqual({ kind: 'refreshed', session: replacement });
    expect(await second).toEqual({ kind: 'refreshed', session: replacement });
  });

  it('does not acknowledge a change made during the previous refresh', async () => {
    const h = fixture();
    const loading = deferred<CapabilityRefreshSession>();
    h.refresh.mockImplementationOnce(() => loading.promise);
    h.coordinator.markChanged(h.initial);
    const first = h.coordinator.attempt(h.initial);
    await Promise.resolve();
    h.coordinator.markChanged(h.initial);
    h.current = { id: 'task', instanceId: 'runtime-2' };
    loading.resolve(h.current);
    await first;
    expect(h.coordinator.state(h.current)).toMatchObject({
      phase: 'pending', revision: 2, appliedRevision: 1,
    });
    await h.coordinator.attempt(h.current);
    expect(h.refresh).toHaveBeenCalledTimes(2);
    expect(h.coordinator.state(h.current)).toMatchObject({
      phase: 'loaded', revision: 2, appliedRevision: 2,
    });
  });

  it('retains a failed revision and permits an explicit retry without a new change', async () => {
    const h = fixture();
    const error = new Error('native startup failed');
    h.refresh.mockRejectedValueOnce(error);
    h.coordinator.markChanged(h.initial);
    await expect(h.coordinator.attempt(h.initial)).resolves.toEqual({ kind: 'failed', error });
    expect(h.coordinator.state(h.initial)).toEqual({
      sessionId: 'task', instanceId: 'runtime-1', phase: 'failed', revision: 1, appliedRevision: 0,
    });
    await h.coordinator.attempt(h.initial);
    expect(h.coordinator.state(h.current)?.phase).toBe('loaded');
  });

  it('rechecks ownership and idleness before invoking native refresh', async () => {
    const h = fixture();
    h.coordinator.markChanged(h.initial);
    const pending = h.coordinator.attempt(h.initial);
    h.setIdle(false);
    await expect(pending).resolves.toEqual({ kind: 'deferred' });
    expect(h.refresh).not.toHaveBeenCalled();
    h.setIdle(true);
    h.setOwner(false);
    h.coordinator.markChanged(h.initial);
    await expect(h.coordinator.attempt(h.initial)).resolves.toEqual({ kind: 'superseded' });
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it.each(['close', 'account-change'] as const)('ignores a late refresh receipt after %s', async (reason) => {
    const h = fixture();
    const loading = deferred<CapabilityRefreshSession>();
    h.refresh.mockImplementationOnce(() => loading.promise);
    h.coordinator.markChanged(h.initial);
    const pending = h.coordinator.attempt(h.initial);
    await Promise.resolve();
    if (reason === 'close') h.coordinator.forget(h.initial);
    else { h.setOwner(false); h.coordinator.clear(); }
    const replacement = { id: 'task', instanceId: 'runtime-2' };
    h.current = replacement;
    loading.resolve(replacement);
    await expect(pending).resolves.toEqual({ kind: 'superseded' });
    expect(h.coordinator.state(replacement)).toBeUndefined();
  });

  it('does not let an old close clear the replacement, or old work overwrite a newer entry', async () => {
    const h = fixture();
    const loading = deferred<CapabilityRefreshSession>();
    h.refresh.mockImplementationOnce(() => loading.promise);
    h.coordinator.markChanged(h.initial);
    const pending = h.coordinator.attempt(h.initial);
    await Promise.resolve();
    const replacement = { id: 'task', instanceId: 'runtime-2' };
    h.current = replacement;
    h.coordinator.markChanged(replacement);
    h.coordinator.forget(h.initial);
    loading.reject(new Error('late old startup failure'));
    await expect(pending).resolves.toEqual({ kind: 'superseded' });
    expect(h.coordinator.state(replacement)).toMatchObject({
      instanceId: 'runtime-2', phase: 'pending', appliedRevision: 0,
    });
    await h.coordinator.attempt(replacement);
    h.coordinator.forget(replacement);
    expect(h.coordinator.state(h.current)?.phase).toBe('loaded');
  });
});

describe('native resource discovery and send boundary', () => {
  it.each(['claude-code', 'codex', 'pi'] as const)(
    'tracks the exact controller-side forwarded Skill snapshot for a hosted %s task', async agentKind => {
      const collectProject = vi.fn(async () => [{ path: '.agents/skills/demo/SKILL.md', data: 'cHJvamVjdA==' }]);
      const collectPersonal = vi.fn(async () => ({ personal: { files: [
        { path: '.agents/skills/personal/SKILL.md', data: 'Zmlyc3Q=' },
        { path: '.claude/rules/unrelated.md', data: 'cnVsZQ==' },
      ] }, roots: [{ relative: '.agents/skills/personal', local: '/controller/.agents/skills/personal' }] }));
      const deps = { collectProject, collectPersonal, skipCredentials: true,
        homeDir: '/controller', codexHome: '/controller/codex', mcpCatalog: [] };
      const scope = { agentKind, workDir: '/controller/project' };
      const before = await readForwardedCapabilitySnapshot(scope, deps);
      expect(collectProject).toHaveBeenCalledWith(scope.workDir, { skipCredentials: true });
      expect(collectPersonal).toHaveBeenCalledWith(agentKind, expect.any(Array), { skipCredentials: true });
      collectPersonal.mockResolvedValue({ personal: { files: [
        { path: '.agents/skills/personal/SKILL.md', data: 'c2Vjb25k' },
      ] }, roots: [{ relative: '.agents/skills/personal', local: '/controller/.agents/skills/personal' }] });
      const changed = await readForwardedCapabilitySnapshot(scope, deps);
      expect(changed.revision).not.toBe(before.revision);
      expect(changed.watchPaths).toContain('/controller/.agents/skills');
      expect(JSON.stringify(changed)).not.toContain('c2Vjb25k');
    },
  );
  it('owns only its remote watch consumer and ignores late events after ownership changes', async () => {
    let emit!: (event: { event: string; data: { workdir: string } }) => void;
    let reconnect!: () => void;
    let current = true;
    const request = vi.fn(async () => ({ ok: true }));
    const offEvent = vi.fn();
    const offReconnect = vi.fn();
    const manager = {
      request,
      onHostEvent: (_host: string, callback: typeof emit) => { emit = callback; return offEvent; },
      onHostConnected: (_host: string, callback: () => void) => { reconnect = callback; return offReconnect; },
    } as unknown as RemoteFileBrowserManager;
    const changed = vi.fn();
    const dispose = await watchRemoteCapabilityPaths(manager, 'ssh', 'task-consumer', ['/remote/skills'], changed, () => current);
    emit({ event: 'fileTree', data: { workdir: '/other/skills' } });
    expect(changed).not.toHaveBeenCalled();
    emit({ event: 'fileTree', data: { workdir: '/remote/skills' } });
    await Promise.resolve();
    expect(changed).toHaveBeenCalledOnce();
    current = false;
    reconnect();
    emit({ event: 'fileTree', data: { workdir: '/remote/skills' } });
    await Promise.resolve();
    expect(changed).toHaveBeenCalledOnce();
    dispose();
    expect(request).toHaveBeenLastCalledWith('ssh', 'watchStop', { workdir: '/remote/skills', consumerId: 'task-consumer' });
    expect(offEvent).toHaveBeenCalledOnce();
    expect(offReconnect).toHaveBeenCalledOnce();
  });
  it('discovers remote config and newly created roots without watch events, serializes polls, and stops at owner loss', async () => {
    vi.useFakeTimers();
    let dispose = () => {};
    try {
      const session = { id: 'ssh-task', instanceId: 'first' };
      let current = session;
      let revision = 'original';
      let owner = true;
      const reload = vi.fn(async () => { current = { ...session, instanceId: 'next' }; return current; });
      const monitor = createSessionCapabilityMonitor({
        isCurrent: candidate => owner && candidate === current, isIdle: () => true,
        read: async () => ({ revision, watchPaths: ['/missing/.pi/skills'] }),
        reload, changed: () => {},
      });
      await monitor.track(session);
      const gate = deferred<void>();
      let held = true;
      const changed = vi.fn(async () => {
        if (held) await gate.promise;
        await monitor.check(current);
        await monitor.beforeSend(current);
      });
      const request = vi.fn(async (_host: string, method: string) => {
        if (method === 'watchStart') throw new Error('ENOENT');
      });
      const manager = { request, onHostEvent: () => () => {}, onHostConnected: () => () => {} } as unknown as RemoteFileBrowserManager;
      dispose = await watchRemoteCapabilityPaths(manager, 'ssh', 'only-this-task', ['/missing/.pi/skills'], changed, () => owner);
      revision = 'mcp-file-edited';
      await vi.advanceTimersByTimeAsync(60_000);
      expect(changed).toHaveBeenCalledOnce();
      expect(reload).not.toHaveBeenCalled();
      held = false;
      gate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(reload).toHaveBeenCalledOnce();
      expect(monitor.state(current)?.phase).toBe('loaded');
      revision = 'new-skill-root-created';
      await vi.advanceTimersByTimeAsync(30_000);
      expect(reload).toHaveBeenCalledTimes(2);
      owner = false;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(changed).toHaveBeenCalledTimes(2);
      dispose();
      owner = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(changed).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenLastCalledWith('ssh', 'watchStop', { workdir: '/missing/.pi/skills', consumerId: 'only-this-task' });
    } finally { dispose(); vi.useRealTimers(); }
  });
  it('hashes actual file changes and observes atomic replacement after watch readiness', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-capability-watch-'));
    let dispose = () => {};
    try {
      const file = path.join(root, 'SKILL.md');
      await fs.writeFile(file, 'first');
      const first = await readCapabilityFiles([], [file], [file]);
      const changed = deferred<void>();
      dispose = await watchCapabilityPaths([file], () => changed.resolve());
      const next = path.join(root, 'next');
      await fs.writeFile(next, 'second');
      await fs.rename(next, file);
      await changed.promise;
      const second = await readCapabilityFiles([], [file], [file]);
      expect(second.revision).not.toBe(first.revision);
      expect(JSON.stringify(second)).not.toContain('second');
      expect((await readCapabilityFiles([], [file], [file])).revision).toBe(second.revision);
    } finally {
      dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  function monitored(allowAdvisoryDiscoveryFailure = false) {
    const initial = { id: 'task', instanceId: 'one' };
    let current = initial;
    let revision = 'original';
    let idle = true;
    const read = vi.fn(async (): Promise<CapabilityResourceSnapshot> => ({ revision, watchPaths: [] }));
    const reload = vi.fn(async () => {
      current = { id: initial.id, instanceId: `${current.instanceId}-next` };
      return current;
    });
    const inputReady = vi.fn();
    const monitor = createSessionCapabilityMonitor({
      inputReadyAfterDiscoveryFailure: inputReady,
      canContinueAfterDiscoveryError: () => allowAdvisoryDiscoveryFailure,
      isCurrent: session => session === current,
      current: () => current,
      isIdle: () => idle, read, reload, changed: vi.fn(),
    });
    return { initial, monitor, reload, read, inputReady,
      get current() { return current; },
      change(value: string) { revision = value; },
      busy() { idle = false; }, idle() { idle = true; },
      replace(value: typeof initial) { current = value; },
    };
  }

  it('detects a missed watch notification before sending and keeps unchanged tasks intact', async () => {
    const h = monitored();
    await h.monitor.track(h.initial);
    expect((await h.monitor.beforeSend(h.initial)).kind).toBe('unchanged');
    h.change('installed-from-shell');
    expect((await h.monitor.beforeSend(h.initial)).kind).toBe('refreshed');
    expect(h.reload).toHaveBeenCalledOnce();
    expect((await h.monitor.beforeSend(h.current)).kind).toBe('unchanged');
  });

  it('can track and refresh the next owner after clearing old runtime state', async () => {
    const h = monitored();
    await h.monitor.track(h.initial);
    h.monitor.markChanged(h.initial);
    h.monitor.clear();
    const next = { id: 'task', instanceId: 'next-owner' };
    h.replace(next);
    await h.monitor.track(next);
    expect(h.monitor.state(next)).toBeUndefined();
    h.change('next-owner-installed-skill');
    expect((await h.monitor.beforeSend(next)).kind).toBe('refreshed');
    expect(h.monitor.state(h.current)?.phase).toBe('loaded');
  });

  it('keeps the registered dynamic-Maker entry hooks when the real owner cleanup runs', async () => {
    const source = await fs.readFile(new URL('../register.ts', import.meta.url), 'utf8');
    const start = source.indexOf('  disposeSessionCapabilitiesHolder = () => {');
    expect(start).toBeGreaterThan(0);
    const end = source.indexOf('\n  };', start);
    const stopWatching = vi.fn();
    const clear = vi.fn();
    const dispose = vi.fn();
    const hooks = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    // Execute the actual owner-boundary body. IPC uses a dynamic Maker facade,
    // so clearing one owner's data must not disable the next owner's callbacks.
    const bindings = {
      capabilityWatchers: new Map([['old', stopWatching]]),
      capabilityMonitor: { clear }, reportedCapabilityPhases: new Map(),
      detachedCapabilitySessions: new Map(),
      codexCapabilityEnvironmentDirty: new Set(), piCapabilityEnvironmentDirty: new Set(),
      nativeCapabilityEnvironmentRefresh: Promise.resolve(), mcpSharedCodexPending: true,
      mcpConfiguration: { dispose },
      trackSessionCapabilitiesHolder: hooks[0], captureSessionCapabilitiesHolder: hooks[1],
      adoptSessionCapabilitiesHolder: hooks[2], settleSessionCapabilitiesHolder: hooks[3],
    };
    const cleanup = new Function(...Object.keys(bindings), `let disposeSessionCapabilitiesHolder;
      ${source.slice(start, end + '\n  };'.length)}
      disposeSessionCapabilitiesHolder();
      return [trackSessionCapabilitiesHolder, captureSessionCapabilitiesHolder,
        adoptSessionCapabilitiesHolder, settleSessionCapabilitiesHolder];`);
    expect(cleanup(...Object.values(bindings))).toEqual(hooks);
    expect(stopWatching).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('retains only local Codex refresh intents across the shared host soft-close', async () => {
    const source = await fs.readFile(new URL('../register.ts', import.meta.url), 'utf8');
    const body = (name: string) => {
      const start = source.indexOf(`  function ${name}(`);
      expect(start).toBeGreaterThan(0);
      return source.slice(source.indexOf('{\n', start) + 1, source.indexOf('\n  }', start));
    };
    const local = { id: 'local', agentKind: 'codex' };
    const remote = { id: 'ssh', agentKind: 'codex', remoteHostId: 'ssh' };
    const device = { id: 'device', agentKind: 'codex', agentDeviceId: 'device' };
    const pi = { id: 'pi', agentKind: 'pi' };
    const external = { id: 'application-owned', agentKind: 'codex' };
    const unregister = registerLocalAgentVisibleRuntime(external.id, async () => {});
    try {
      let live: typeof local | undefined = local;
      const maker = { listActiveSessions: () => [local, remote, device, pi, external], getSession: () => live };
      const detachedCapabilitySessions = new Map();
      const markChanged = vi.fn();
      new Function('maker', 'detachedCapabilitySessions', 'getSessionProvider', 'capabilityMonitor', 'hasLocalAgentVisibleRuntime',
        body('captureCodexCapabilityRefreshIntents'))(maker, detachedCapabilitySessions,
        () => 'account-provider', { markChanged }, hasLocalAgentVisibleRuntime);
      expect([...detachedCapabilitySessions.keys()]).toEqual(['local']);
      expect(markChanged).toHaveBeenCalledExactlyOnceWith(local);
      expect(detachedCapabilitySessions.get('local').providerId).toBe('account-provider');
      const current = new Function('maker', 'detachedCapabilitySessions', 'sessionId', 'hasLocalAgentVisibleRuntime', body('currentCapabilitySession'));
      live = undefined; // Existing shared-host code detached the native handle.
      expect(current(maker, detachedCapabilitySessions, 'local', hasLocalAgentVisibleRuntime)).toBe(local);
      live = { id: 'local', agentKind: 'codex' };
      expect(current(maker, detachedCapabilitySessions, 'local', hasLocalAgentVisibleRuntime)).toBe(live);
      live = external;
      expect(current(maker, detachedCapabilitySessions, external.id, hasLocalAgentVisibleRuntime)).toBeUndefined();
      unregister();
      expect(current(maker, detachedCapabilitySessions, external.id, hasLocalAgentVisibleRuntime)).toBe(external);
    } finally { unregister(); }
  });

  it('leaves an application-owned visible runtime untouched until explicit Cindy takeover', async () => {
    const source = await fs.readFile(new URL('../register.ts', import.meta.url), 'utf8');
    const start = source.indexOf('  trackSessionCapabilitiesHolder = session => {');
    expect(start).toBeGreaterThan(0);
    const end = source.indexOf('\n  };', start);
    const session = { id: 'visible-app-owner', instanceId: 'native-app', onEvent: vi.fn(() => () => {}) };
    const capabilityOwners = new WeakMap();
    const read = vi.fn(async () => ({ revision: 'changed-global-skill', watchPaths: [] }));
    const stopWatching = vi.fn();
    const watch = vi.fn(async () => stopWatching);
    const close = vi.fn(async () => { unregister(); });
    const unregister = registerLocalAgentVisibleRuntime(session.id, close);
    const bindings = { hasLocalAgentVisibleRuntime, capabilityOwners,
      getActiveAppSession: () => ({ generation: 1 }), detachedCapabilitySessions: new Map(),
      capabilityMonitor: { track: read, forget: vi.fn() }, maker: { getSession: () => session },
      isAppSessionBoundaryPending: () => false, capabilityWatchers: new Map(),
      watchCapabilityPaths: watch, settleSessionCapabilitiesHolder: vi.fn(),
      getWiredSessionCloseReason: () => 'manual-close',
    };
    const tracker = new Function(...Object.keys(bindings), `let trackSessionCapabilitiesHolder;
      ${source.slice(start, end + '\n  };'.length)}
      return trackSessionCapabilitiesHolder;`)(...Object.values(bindings));
    try {
      const disposeExternal = tracker(session);
      await Promise.resolve();
      expect(read).not.toHaveBeenCalled();
      expect(session.onEvent).not.toHaveBeenCalled();
      expect(watch).not.toHaveBeenCalled();
      expect(capabilityOwners.has(session)).toBe(false);
      disposeExternal();
      expect(close).not.toHaveBeenCalled();
      // The existing API handoff, rather than automatic reload, releases ownership.
      await takeOverLocalAgentVisibleSession(session.id);
      expect(close).toHaveBeenCalledOnce();
      const disposeCindy = tracker(session);
      await vi.waitFor(() => expect(watch).toHaveBeenCalledOnce());
      expect(read).toHaveBeenCalledExactlyOnceWith(session);
      expect(capabilityOwners.get(session)).toBe(1);
      disposeCindy();
      expect(stopWatching).toHaveBeenCalledOnce();
    } finally { unregister(); }
  });

  it('compares against the pre-launch receipt instead of silently adopting a startup edit', async () => {
    const h = monitored();
    h.monitor.adopt(h.initial, { revision: 'before-native-start', watchPaths: [] });
    h.change('edited-during-start');
    expect((await h.monitor.beforeSend(h.initial)).kind).toBe('refreshed');
    expect(h.reload).toHaveBeenCalledOnce();
  });

  it('preserves native handling of pre-existing discovery errors and blocks newly broken resources', async () => {
    const h = monitored();
    h.read.mockResolvedValue({ revision: 'existing', watchPaths: [], discoveryErrorRevision: 'known' });
    await h.monitor.track(h.initial);
    expect((await h.monitor.beforeSend(h.initial)).kind).toBe('unchanged');
    h.read.mockResolvedValue({ revision: 'changed', watchPaths: [], discoveryErrorRevision: 'new-error' });
    expect((await h.monitor.beforeSend(h.initial)).kind).toBe('failed');
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('keeps Pi self-repair usable on advisory scan errors and reloads after repair', async () => {
    const h = monitored(true);
    await h.monitor.track(h.initial);
    h.read.mockResolvedValue({ revision: 'unreadable-skill', watchPaths: [], discoveryErrorRevision: 'advisory' });
    const dispatch = vi.fn();
    const outcome = await h.monitor.beforeSend(h.initial);
    if (outcome.kind === 'unchanged') dispatch();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.monitor.state(h.initial)?.phase).toBe('failed');
    h.read.mockResolvedValue({ revision: 'repaired-skill', watchPaths: [] });
    expect((await h.monitor.beforeSend(h.initial)).kind).toBe('refreshed');
    expect(h.monitor.state(h.current)?.phase).toBe('loaded');
  });

  it('allows advisory file-read repair but keeps real native reload failures blocking', async () => {
    const h = monitored(true);
    await h.monitor.track(h.initial);
    h.read.mockRejectedValueOnce(new Error('unreadable preview file'));
    expect((await h.monitor.beforeSend(h.initial)).kind).toBe('unchanged');
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.monitor.state(h.initial)?.phase).toBe('failed');
    h.change('fixed-preview');
    h.inputReady.mockClear();
    h.reload.mockRejectedValueOnce(new Error('native startup failed'));
    expect((await h.monitor.beforeSend(h.initial)).kind).toBe('failed');
    expect(h.inputReady).not.toHaveBeenCalled();
  });

  it('retains self-repair when discovery fails at refresh preflight before close', async () => {
    const h = monitored(true);
    await h.monitor.track(h.initial);
    h.read.mockResolvedValueOnce({ revision: 'new-resource', watchPaths: [] })
      .mockRejectedValueOnce(new Error('preview changed during read'));
    expect((await h.monitor.beforeSend(h.initial)).kind).toBe('unchanged');
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.monitor.state(h.initial)?.phase).toBe('failed');
  });

  it('drains a new entry created by a change notification during runtime replacement', async () => {
    const h = monitored();
    await h.monitor.track(h.initial);
    h.change('first');
    h.reload.mockImplementationOnce(async () => {
      const replacement = { id: 'task', instanceId: 'replacement' };
      h.replace(replacement);
      h.monitor.markChanged(replacement);
      return replacement;
    });
    expect((await h.monitor.beforeSend(h.initial)).kind).toBe('refreshed');
    expect(h.reload).toHaveBeenCalledTimes(2);
    expect(h.monitor.state(h.current)?.phase).toBe('loaded');
  });

  it('waits for native reload before allowing a message to dispatch', async () => {
    const h = monitored();
    await h.monitor.track(h.initial);
    const loading = deferred<typeof h.initial>();
    h.reload.mockImplementationOnce(() => loading.promise);
    h.change('new-mcp');
    const dispatched = vi.fn();
    const sending = h.monitor.beforeSend(h.initial).then(dispatched);
    await vi.waitFor(() => expect(h.reload).toHaveBeenCalledOnce());
    expect(dispatched).not.toHaveBeenCalled();
    const replacement = { id: 'task', instanceId: 'two' };
    h.replace(replacement);
    loading.resolve(replacement);
    await sending;
    expect(dispatched).toHaveBeenCalledOnce();
  });

  it('applies a second external edit received during native startup before dispatch', async () => {
    const h = monitored();
    await h.monitor.track(h.initial);
    h.change('first');
    h.reload.mockImplementationOnce(async () => {
      h.change('second');
      const replacement = { id: 'task', instanceId: 'two' };
      h.replace(replacement);
      return replacement;
    });
    await h.monitor.beforeSend(h.initial);
    expect(h.reload).toHaveBeenCalledTimes(2);
    expect(h.monitor.state(h.current)?.phase).toBe('loaded');
  });

  it('leaves a busy task intact and retries a failed reload on the next send', async () => {
    const h = monitored();
    await h.monitor.track(h.initial);
    h.change('updated');
    h.busy();
    expect((await h.monitor.beforeSend(h.initial)).kind).toBe('deferred');
    expect(h.reload).not.toHaveBeenCalled();
    h.idle();
    h.reload.mockRejectedValueOnce(new Error('native start failed'));
    expect((await h.monitor.beforeSend(h.initial)).kind).toBe('failed');
    expect(h.monitor.state(h.initial)?.phase).toBe('failed');
    expect((await h.monitor.beforeSend(h.initial)).kind).toBe('refreshed');
  });

  it('does not close a healthy runtime when resource discovery fails', async () => {
    const h = monitored();
    await h.monitor.track(h.initial);
    h.read.mockRejectedValueOnce(new Error('incomplete file'));
    expect((await h.monitor.beforeSend(h.initial)).kind).toBe('failed');
    expect(h.reload).not.toHaveBeenCalled();
  });
});
