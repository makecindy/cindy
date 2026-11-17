/** Test value: new public request/resolve round trip, not covered by the read-only catalog tests.
 * Protects plugin-security §3/§5 and Electron §5: minimal foreign-window answer, account switch
 * during async validation, revoked source and closed page must never deliver a route. Tier: unit.
 * No Electron, user data, network or real waits; routing source is read once as a fixture.
 * Standalone wall time: 1.09s (2026-11-02).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { installGhostPageModelPicker } from '../ghostPageModelPicker.js';
import type { ProviderView } from '@cindy/model-providers';
import type { InstalledGhost } from '../../../shared/ghost.js';
import type { PluginTaskRoute } from '../../../shared/pluginTasks.js';
import type { PluginModelPickerRequest } from '../../../shared/pluginModelPicker.js';
import { GhostModelPicker, chooseModelPickerWindow, readPluginModelRouteCatalog, isGhostCardModelRouteAvailable, isPluginModelPickerRouteAvailable, isPluginRouteHarnessInstalled, setPluginRouteAgentStatusProvider } from '../ghostModelPicker.js';

// Run the production routing entry without booting Electron or loading the IPC registry.
const hostSource = ts.createSourceFile('index.ts', readFileSync(new URL('../index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const routeEntry = hostSource.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'routeGhostNewTask');
if (!routeEntry) throw new Error('routeGhostNewTask entry missing');
const routeEntryCode = ts.transpileModule(`(${routeEntry.getText(hostSource).replace(/^export\s+/, '')})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const route: PluginTaskRoute = {
  agentKind: 'codex',
  providerId: 'mine',
  model: 'model',
  effort: 'high',
  fastMode: 'ultrafast',
};
function setup() {
  let installation = 'owner-a:revision-1',
    now = 1_000;
  const ghost = { enabled: true, manifest: { name: 'Example' } } as InstalledGhost;
  const sent: PluginModelPickerRequest[] = [];
  const dismiss = vi.fn(),
    available = vi.fn(async () => true);
  let cancel!: () => void;
  const target = vi.fn(() => ({
    id: 7,
    supportsRemoteRoutes: true,
    dismiss,
    send: (request: PluginModelPickerRequest, close: () => void) => {
      sent.push(request);
      cancel = close;
      return true;
    },
  }));
  const picker = new GhostModelPicker({
    getGhost: () => ghost,
    installation: () => installation,
    target,
    available,
    now: () => now,
  });
  return {
    picker,
    ghost,
    sent,
    dismiss,
    available,
    target,
    changeOwner: () => {
      installation = 'owner-b:revision-1';
    },
    advance: () => {
      now += 3_000;
    },
    close: () => cancel(),
  };
}
afterEach(() => vi.useRealTimers());

// Test value: the approved page's real IPC handler must address its own host, default to all
// sources and revoke in-flight requests on navigation. The logic-page tests don't cover guest
// frame/anchor validation. Minimal input: one attached guest and a same-ID remote provider. Tier: unit.
describe('plugin page picker bridge', () => {
  function page() {
    const h = setup();
    const guest = Object.assign(new EventEmitter(), {
      id: 42, ipc: Object.assign(new EventEmitter(), { handle: vi.fn() }),
      mainFrame: {}, isDestroyed: () => false, getZoomFactor: () => 1, focus: vi.fn(),
    });
    const host = Object.assign(new EventEmitter(), { id: 8, isDestroyed: () => false, getZoomFactor: () => 1 });
    const push = vi.fn();
    installGhostPageModelPicker({ guest: guest as unknown as WebContents, host: host as unknown as WebContents,
      instanceId: 'plugin', isCurrent: () => true, picker: () => h.picker, push });
    const invoke = (options: unknown, frame = guest.mainFrame) => guest.ipc.handle.mock.calls[0][1](
      { sender: guest, senderFrame: frame }, options,
    ) as Promise<unknown>;
    return { ...h, guest, host, push, invoke };
  }
  const anchor = { x: 12, y: 24, width: 140, height: 32 };
  it('uses the originating host and returns the full remote route through the guest request', async () => {
    const h = page();
    const result = h.invoke({ anchor });
    const presentation = h.push.mock.calls[0][1];
    expect(presentation).toMatchObject({ allowRemote: true, pageAnchor: { guestId: 42, rect: anchor } });
    expect(h.target).not.toHaveBeenCalled();
    const selected = { ...route, agentDeviceId: 'share:demo' };
    expect(await h.picker.resolve(7, presentation.requestId, selected)).toEqual({ handled: false, accepted: false });
    expect(await h.picker.resolve(8, presentation.requestId, selected)).toEqual({ handled: true, accepted: true });
    expect(await result).toEqual({ ok: true, route: selected });
    expect(h.guest.focus).toHaveBeenCalledOnce();
    expect(h.guest.listenerCount('did-start-navigation')).toBe(0);
  });
  it('rejects subframes, nonfinite anchors and arbitrary IPC options without showing a picker', async () => {
    const h = page();
    expect(await h.invoke({ anchor }, {})).toMatchObject({ errorCode: 'PERMISSION_DENIED' });
    for (const value of [{ anchor: { ...anchor, x: NaN } }, { anchor, mobilePageId: 'another-page' },
      { anchor, allowRemote: 'yes' }]) {
      expect(await h.invoke(value)).toMatchObject({ errorCode: 'INVALID_REQUEST' });
    }
    expect(h.push).not.toHaveBeenCalled();
  });
  it.each(['guest-navigation', 'host-navigation', 'page-scroll'])(
    'cancels %s without returning a route to a replacement document', async reason => {
      const h = page();
      const result = h.invoke({ anchor });
      if (reason === 'page-scroll') h.guest.ipc.emit('ghost-page:cancel-model-picker', { sender: h.guest, senderFrame: h.guest.mainFrame });
      else (reason === 'guest-navigation' ? h.guest : h.host).emit('did-start-navigation', {}, 'new-page', false, true);
      expect(await result).toMatchObject({ errorCode: 'CANCELLED' });
      expect(h.push).toHaveBeenLastCalledWith('ghosts:model-picker:dismissed', expect.anything());
      expect(h.guest.focus).not.toHaveBeenCalled();
    },
  );
});

describe('Host plugin model picker', () => {
  it('returns a complete configuration only to the originating installation after its Host window answers', async () => {
    const h = setup(),
      result = h.picker.request('plugin', { initial: route });
    const id = h.sent[0].requestId;
    expect(await h.picker.resolve(99, id, route)).toEqual({ handled: false, accepted: false });
    expect(await h.picker.resolve(7, 'other-request', route)).toEqual({
      handled: false,
      accepted: false,
    });
    expect(await h.picker.resolve(7, id, route)).toEqual({ handled: true, accepted: true });
    expect(await result).toEqual({ ok: true, route });
    expect(h.dismiss).toHaveBeenCalledWith(id);
    expect(await h.picker.resolve(7, id, route)).toEqual({ handled: false, accepted: false });
  });

  it('keeps the picker open when a source disappears and accepts a later valid selection', async () => {
    const h = setup(),
      result = h.picker.request('plugin');
    const id = h.sent[0].requestId;
    expect(await h.picker.resolve(7, id, { ...route, apiKey: 'private' })).toEqual({
      handled: true,
      accepted: false,
    });
    h.available.mockResolvedValueOnce(false);
    expect(await h.picker.resolve(7, id, route)).toEqual({ handled: true, accepted: false });
    expect(h.dismiss).not.toHaveBeenCalled();
    await h.picker.resolve(7, id, { ...route, providerId: 'replacement' });
    expect(await result).toEqual({ ok: true, route: { ...route, providerId: 'replacement' } });
  });

  it.each(['installation', 'page'] as const)(
    'does not deliver a route when %s changes during validation',
    async (boundary) => {
      const h = setup(),
        result = h.picker.request('plugin');
      const target = h.target.mock.results[0].value as { isCurrent?: () => boolean };
      h.available.mockImplementationOnce(async () => {
        if (boundary === 'installation') h.changeOwner();
        else target.isCurrent = () => false;
        return true;
      });
      expect(await h.picker.resolve(7, h.sent[0].requestId, route)).toEqual({
        handled: true,
        accepted: false,
      });
      expect(await result).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    },
  );

  it.each(['cancel', 'page-abort', 'window-close', 'timeout'] as const)(
    'settles %s without returning a configuration',
    async (reason) => {
      vi.useFakeTimers();
      const h = setup(),
        controller = new AbortController();
      const result = h.picker.request('plugin', {}, () => true, controller.signal);
      if (reason === 'cancel') await h.picker.resolve(7, h.sent[0].requestId, null);
      else if (reason === 'page-abort') controller.abort();
      else if (reason === 'window-close') h.close();
      else vi.advanceTimersByTime(90_000);
      expect(await result).toMatchObject({ ok: false, errorCode: 'CANCELLED' });
      expect(h.dismiss).toHaveBeenCalledWith(h.sent[0].requestId);
    },
  );

  // #8964: cancellation must win over an already-running remote availability check.
  // Existing cancellation cases resolve before validation starts. Tier: unit, no real waiting.
  it('discards a remote selection that finishes validation after cancellation', async () => {
    const h = setup();
    let finishValidation!: (value: boolean) => void;
    h.available.mockImplementationOnce(() => new Promise((done) => { finishValidation = done; }));
    const result = h.picker.request('plugin', { allowRemote: true });
    const id = h.sent[0].requestId;
    const selection = h.picker.resolve(7, id, { ...route, agentDeviceId: 'share:fixture' });
    expect(await h.picker.resolve(7, id, null)).toEqual({ handled: true, accepted: true });
    expect(await result).toMatchObject({ ok: false, errorCode: 'CANCELLED' });
    finishValidation(true);
    expect(await selection).toEqual({ handled: false, accepted: false });
    expect(h.dismiss).toHaveBeenCalledExactlyOnceWith(id);
  });

  // Regression: the inherited directory-picker cooldown blocked normal rapid close/reopen
  // and switching between the page popover and dialog. Keep the clock fixed to catch it. Tier: unit.
  it('rejects malformed, disabled and concurrent requests but allows immediate reopening', async () => {
    const h = setup();
    expect(
      await h.picker.request('plugin', { initial: { ...route, endpoint: 'private' } }),
    ).toMatchObject({ errorCode: 'INVALID_REQUEST' });
    h.ghost.enabled = false;
    expect(await h.picker.request('plugin')).toMatchObject({ errorCode: 'PERMISSION_DENIED' });
    h.ghost.enabled = true;
    const pending = h.picker.request('plugin');
    expect(await h.picker.request('other')).toMatchObject({ errorCode: 'BUSY' });
    h.picker.cancel();
    await pending;
    const reopened = h.picker.request('plugin');
    expect(h.sent).toHaveLength(2);
    await h.picker.resolve(7, h.sent[1].requestId, route);
    expect(await reopened).toEqual({ ok: true, route });
    h.target.mockReturnValueOnce(null as never);
    expect(await h.picker.request('plugin')).toMatchObject({ errorCode: 'UNAVAILABLE' });
  });

  it('forwards an explicit mobile origin without falling back to a local window', async () => {
    const h = setup();
    h.target.mockReturnValueOnce(null as never);
    expect(await h.picker.request('plugin', { mobilePageId: 'expired-phone-page' })).toMatchObject({
      errorCode: 'UNAVAILABLE',
    });
    expect(h.target).toHaveBeenCalledExactlyOnceWith('plugin', 'expired-phone-page');
  });
});

it('validates effort and Fast against the exact connected model and available engine', () => {
  const provider = {
    id: 'mine',
    source: 'user',
    connected: true,
    agents: ['codex'],
    routing: { codex: { enabled: true } },
    models: {
      codex: [
        {
          id: 'model',
          mode: 'chat',
          efforts: ['high'],
          supportsFastMode: true,
          supportsUltrafastMode: true,
        },
      ],
    },
  } as unknown as ProviderView;
  expect(isPluginModelPickerRouteAvailable(route, [provider], ['codex'])).toBe(true);
  for (const candidate of [
    { ...route, providerId: 'other' },
    { ...route, effort: 'low' },
  ])
    expect(isPluginModelPickerRouteAvailable(candidate, [provider], ['codex'])).toBe(false);
  expect(isPluginModelPickerRouteAvailable(route, [provider], [])).toBe(false);
  provider.models.codex![0].supportsUltrafastMode = false;
  expect(isPluginModelPickerRouteAvailable(route, [provider], ['codex'])).toBe(false);
  provider.connected = false;
  expect(
    isPluginModelPickerRouteAvailable({ ...route, fastMode: false }, [provider], ['codex']),
  ).toBe(false);
});

// Rule: the card dropdown also offers other computers and shared providers. A remote pick must be a
// location that is currently offered, and the model must be in that location's remotely callable catalog.
it('checks a card model at its own location: local catalog, or the offered remote location', async () => {
  const view = (models: string[]) => ({
    id: 'mine', source: 'user', connected: true, agents: ['codex'], routing: { codex: { enabled: true } },
    models: { codex: models.map((id) => ({ id, mode: 'chat', efforts: ['high'], supportsFastMode: true, supportsUltrafastMode: true })) },
  }) as unknown as ProviderView;
  const remoteViews = vi.fn(async (id: string) => [view(id === 'mac-mini' ? ['remote-model'] : [])]);
  const sources = {
    localViews: async () => [view(['model'])],
    localAgents: () => ['codex'],
    locations: async () => ({ locations: [{ agentDeviceId: 'mac-mini' }, { agentDeviceId: 'share:abc' }] }),
    remoteViews,
  };
  expect(await isGhostCardModelRouteAvailable(route, sources)).toBe(true);
  expect(await isGhostCardModelRouteAvailable({ ...route, model: 'remote-model', agentDeviceId: 'mac-mini' }, sources)).toBe(true);
  // Remote engines are judged by the remote catalog, not by what is installed here.
  expect(await isGhostCardModelRouteAvailable({ ...route, model: 'remote-model', agentDeviceId: 'mac-mini' }, { ...sources, localAgents: () => [] })).toBe(true);
  expect(await isGhostCardModelRouteAvailable({ ...route, agentDeviceId: 'mac-mini' }, sources)).toBe(false);
  expect(await isGhostCardModelRouteAvailable({ ...route, model: 'remote-model', agentDeviceId: 'offline-mac' }, sources)).toBe(false);
  expect(remoteViews).not.toHaveBeenCalledWith('offline-mac');
  expect(await isGhostCardModelRouteAvailable({ ...route, agentDeviceId: 'mac-mini' }, { ...sources, locations: null })).toBe(false);
});

// Unit: after a first successful pick, "choose a model" on a PR card stopped opening the picker.
// The request went to a pre-warmed hidden app window (still an app window) and timed out unseen.
describe('chooseModelPickerWindow', () => {
  it('uses the focused window only when usable, otherwise the first visible app window', () => {
    const hidden = { id: 'prewarmed', usable: false }, main = { id: 'main', usable: true };
    const usable = (w: { usable: boolean }) => w.usable;
    expect(chooseModelPickerWindow(hidden, [hidden, main], usable)).toBe(main);
    expect(chooseModelPickerWindow(null, [hidden, main], usable)).toBe(main);
    expect(chooseModelPickerWindow(main, [hidden, main], usable)).toBe(main);
    expect(chooseModelPickerWindow(null, [hidden], usable)).toBeUndefined();
  });
});

// Rule: a plugin model must never stop the message. A Harness that is not installed makes the send
// gate block with a dialog, so the route falls back; a failed check is left to that gate.
it('reports a routed Harness as missing only when the host says so', async () => {
  setPluginRouteAgentStatusProvider(async (agent) => ({ binaryReady: agent !== 'codex' }));
  expect(await isPluginRouteHarnessInstalled('codex')).toBe(false);
  expect(await isPluginRouteHarnessInstalled('pi')).toBe(true);
  setPluginRouteAgentStatusProvider(async () => { throw new Error('status failed'); });
  expect(await isPluginRouteHarnessInstalled('codex')).toBe(true);
  setPluginRouteAgentStatusProvider(async () => ({ binaryReady: false }));
  expect(await isPluginRouteHarnessInstalled('claude-code')).toBe(true);
});

// PR #8460 / unit: a remote catalog can advertise Pi when that source has no Pi runtime.
// Previous cases checked only local status or catalog availability, not the routed/kept outcome.
// Minimal input: connected Pi model, explicit share source, and a definitive binaryReady value.
it.each([false, true])('checks the remote runtime before accepting a route (binaryReady=%s)', async (binaryReady) => {
  const localStatus = vi.fn(async (agent: string) => ({ binaryReady: agent !== 'pi' }));
  setPluginRouteAgentStatusProvider(localStatus);
  const remoteStatus = vi.fn(async () => ({ binaryReady }));
  const remoteRoute = { agentKind: 'pi', providerId: 'mine', model: 'model', agentDeviceId: 'share:fixture' };
  const remoteView = {
    id: 'mine', source: 'user', connected: true, agents: ['pi'], routing: { pi: { enabled: true } },
    models: { pi: [{ id: 'model', name: 'Remote model', mode: 'chat', efforts: [] }] },
  } as unknown as ProviderView;
  const ghost = { manifest: { name: 'Example' } };
  const run = runInNewContext(routeEntryCode, {
    activeOwnerScopeKey: () => 'owner', availableGhosts: () => [ghost],
    findInstalledGhostByInstanceId: () => ghost, publishedRouteModels: () => [{ id: 'auto' }],
    screenGhostControlPoint: async () => ({ action: 'route', route: remoteRoute, ghostName: 'Example' }),
    getDesktopProviderService: () => ({ listProviders: async () => [] }),
    readPluginModelRouteCatalog, readGhostAgentRemoteViews: async () => [remoteView],
    getPluginModelPickerAgents: () => ['codex'], readGhostAgentRemoteStatus: remoteStatus,
    isPluginRouteHarnessInstalled, isPluginModelPickerRouteAvailable, log: { warn: vi.fn() },
  });
  const result = await run('plugin', { modelId: 'auto', route });
  expect(result).toMatchObject(binaryReady
    ? { outcome: 'routed', route: remoteRoute }
    : { outcome: 'kept', why: 'unavailable-route' });
  expect(remoteStatus).toHaveBeenCalledExactlyOnceWith('share:fixture', 'pi');
  expect(localStatus).not.toHaveBeenCalled();
});

// Bug: plugin routing validated only the local catalog; a share with the same provider/model
// could either disappear or run locally. Exact source catalog is observable through acceptance.
// Existing availability fixtures cover only local views. Minimal input: share route + local namesake.
// Tier: unit; no network or Electron.
it('reads only the selected share and never falls back to a local namesake', async () => {
  const local = vi.fn(async () => [{ id: 'local' }] as ProviderView[]);
  const remote = vi.fn(async () => [] as ProviderView[]);
  expect(await readPluginModelRouteCatalog({ agentDeviceId: 'share:fixture' }, {
    local, remote, localAgents: () => ['codex'],
  })).toMatchObject({ views: [] });
  expect(remote).toHaveBeenCalledWith('share:fixture');
  expect(local).not.toHaveBeenCalled();
  expect(await readPluginModelRouteCatalog({ agentDeviceId: 'share:fixture' }, {
    local, localAgents: () => ['codex'],
  })).toMatchObject({ views: [] });
  remote.mockRejectedValueOnce(new Error('share revoked'));
  await expect(readPluginModelRouteCatalog({ agentDeviceId: 'share:fixture' }, {
    local, remote, localAgents: () => ['codex'],
  })).rejects.toThrow('share revoked');
  expect(local).not.toHaveBeenCalled();
});

// Old callers use this picker to create local plugin tasks. Remote answers are accepted only
// after explicit opt-in, so adding route sources cannot change their execution contract. Tier: unit.
it('requires remote opt-in and keeps the complete share location in the accepted reply', async () => {
  const h = setup();
  const remote = { ...route, agentDeviceId: 'share:fixture' };
  const localResult = h.picker.request('plugin');
  expect(await h.picker.resolve(7, h.sent[0].requestId, remote)).toEqual({ handled: true, accepted: false });
  h.close();
  await localResult;
  h.advance();
  const remoteResult = h.picker.request('plugin', { allowRemote: true, initial: remote });
  expect(h.sent[1].allowRemote).toBe(true);
  expect(await h.picker.resolve(7, h.sent[1].requestId, remote)).toEqual({ handled: true, accepted: true });
  expect(await remoteResult).toEqual({ ok: true, route: remote });
});
