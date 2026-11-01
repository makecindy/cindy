/** Test value: new public request/resolve round trip, not covered by the read-only catalog tests.
 * Protects plugin-security §3/§5 and Electron §5: minimal foreign-window answer, account switch
 * during async validation, revoked source and closed page must never deliver a route. Tier: unit.
 * No Electron, filesystem, network or real waits. Standalone wall time: 2.18s (2026-10-28).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import type { InstalledGhost } from '../../../shared/ghost.js';
import type { PluginTaskRoute } from '../../../shared/pluginTasks.js';
import type { PluginModelPickerRequest } from '../../../shared/pluginModelPicker.js';
import { GhostModelPicker, chooseModelPickerWindow, isPluginModelPickerRouteAvailable, isPluginRouteHarnessInstalled, setPluginRouteAgentStatusProvider } from '../ghostModelPicker.js';

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

  it('rejects malformed and disabled requests, concurrent dialogs and immediate reopening', async () => {
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
    expect(await h.picker.request('plugin')).toMatchObject({ errorCode: 'RATE_LIMITED' });
    h.advance();
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
