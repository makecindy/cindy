// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearModelVisibilityMirror,
  getModelVisibilityMirrorSnapshot,
  setModelVisibilityMirror,
  waitForModelVisibilityMirror,
} from '../../../desktop/src/main/maker-host/model-visibility-mirror';
import {
  clearAllDeviceProviders,
  evictDeviceProviders,
  fetchDeviceProvidersFresh,
  getCachedDeviceProviders,
} from '@/device-link/deviceProvidersCache';
import { useDeviceProviders, type UseDeviceProvidersResult } from '@/device-link/useDeviceProviders';
import { canUseFlatModelFallback } from '@/session/modelPickerSheetModel';
import { resolveNewSessionAutoDefault } from '@/session/newSession';

const transport = vi.hoisted(() => ({ listProviders: vi.fn(), epoch: 0 }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({
  connectionEpoch: transport.epoch, status: 'online', recoveringDeviceIds: new Set(),
}) }));
vi.mock('@/device-link/useMobileMakerTransport', () => ({ useMobileMakerTransport: () => transport }));
vi.mock('react-native', () => ({ AppState: {
  currentState: 'active',
  addEventListener: () => ({ remove() {} }),
} }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let state: UseDeviceProvidersResult;
function Probe({ deviceId = 'host' }: { deviceId?: string }) {
  state = useDeviceProviders(deviceId);
  return null;
}
function allowsFlatFallback(): boolean {
  return canUseFlatModelFallback({
    providers: state.providers,
    providersReady: state.ready,
    providersUnsupported: state.unsupported,
    loading: state.loading,
    browsingOtherAgent: false,
  });
}
beforeEach(() => {
  clearAllDeviceProviders();
  clearModelVisibilityMirror();
  vi.useFakeTimers();
  transport.listProviders.mockReset();
  transport.epoch = 0;
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  clearAllDeviceProviders();
  clearModelVisibilityMirror();
});

describe('mobile provider visibility readiness', () => {
  it('retires cached routes and overrides after reconnecting to an older host, including remount', async () => {
    transport.listProviders.mockResolvedValue({ providers: [{ id: 'old-route' }],
      modelVisibilityOverrides: { 'codex:old-route:old-model': false } });
    await act(async () => { root.render(createElement(Probe)); });
    expect(state.providers).toEqual([{ id: 'old-route' }]);
    expect(state.ready).toBe(true);
    transport.listProviders.mockRejectedValue(new Error('[CHANNEL_NOT_ALLOWED] unavailable'));
    transport.epoch += 1;
    await act(async () => { root.render(createElement(Probe)); });
    expect(state).toMatchObject({ providers: [], ready: false, loading: false, unsupported: true });
    expect(state.modelVisibilityOverrides).toBeUndefined();
    expect(getCachedDeviceProviders('host')).toBeUndefined();
    expect(allowsFlatFallback()).toBe(true);
    await act(async () => { root.render(null); });
    await act(async () => { root.render(createElement(Probe)); });
    expect(transport.listProviders).toHaveBeenCalledTimes(3);
    expect(state.providers).toEqual([]);
    expect(allowsFlatFallback()).toBe(true);

    transport.listProviders.mockResolvedValue({ providers: [{ id: 'new-route' }], modelVisibilityOverrides: {} });
    transport.epoch += 1;
    await act(async () => { root.render(createElement(Probe)); });
    expect(state).toMatchObject({ providers: [{ id: 'new-route' }], ready: true, error: null, unsupported: false });
    expect(allowsFlatFallback()).toBe(false);
  });

  it('host timeout survives serialization; exhausted short retries keep defaults closed until recovery', async () => {
    transport.listProviders.mockImplementation(async () => {
      try {
        await waitForModelVisibilityMirror(100);
        return { providers: [], modelVisibilityOverrides: getModelVisibilityMirrorSnapshot() };
      } catch (error) {
        // dispatch sends only err.message in IPC_ERROR; mobile unwraps it as a plain Error.
        throw new Error((error as Error).message);
      }
    });
    await act(async () => { root.render(createElement(Probe)); });
    expect(allowsFlatFallback()).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(1050); });
    expect(transport.listProviders).toHaveBeenCalledTimes(3);
    expect(state).toMatchObject({ ready: false, loading: false, unsupported: false });
    expect(state.error).toContain('[MODEL_VISIBILITY_NOT_READY]');
    expect(allowsFlatFallback()).toBe(false);
    expect(resolveNewSessionAutoDefault({
      userTouched: false, appliedDeviceId: null, selectedDeviceId: 'host', sessions: [],
      modelRows: [], rowsAgentKind: 'codex', catalogReady: state.ready,
      providersUnsupported: state.unsupported, currentEffort: 'medium',
      availableModels: [{ id: 'hidden', label: 'Hidden', efforts: ['medium'],
        effortDisplayNames: {}, defaultEffort: 'medium', supportsFastMode: false,
        newSessionDefault: ['codex'] }],
    })).toBeNull();
    setModelVisibilityMirror({ 'codex:xd:hidden': false }, { fallback: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(state).toMatchObject({ ready: true, error: null, modelVisibilityOverrides: { 'codex:xd:hidden': false } });
    expect(allowsFlatFallback()).toBe(false);
  });

  it('accepts synchronized switches on retry without an intermediate error or flat fallback', async () => {
    transport.listProviders.mockImplementation(async () => {
      await waitForModelVisibilityMirror(100);
      return { providers: [], modelVisibilityOverrides: getModelVisibilityMirrorSnapshot() };
    });
    await act(async () => { root.render(createElement(Probe)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(state.loading).toBe(true);
    expect(state.error).toBeNull();
    expect(allowsFlatFallback()).toBe(false);
    setModelVisibilityMirror({ 'codex:xd:hidden': false }, { fallback: false });
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(transport.listProviders).toHaveBeenCalledTimes(2);
    expect(state).toMatchObject({ ready: true, error: null, modelVisibilityOverrides: { 'codex:xd:hidden': false } });
    expect(allowsFlatFallback()).toBe(false);
  });

  it.each([
    [new Error('[INTERNAL] CHANNEL_NOT_ALLOWED is only text'), false],
    [new Error('MODEL_VISIBILITY_NOT_READY: untyped'), false],
    [Object.assign(new Error('unsupported'), { code: 'CHANNEL_NOT_ALLOWED' }), true],
  ])('does not retry other failures; only explicit old-host errors allow fallback: %s', async (error, unsupported) => {
    transport.listProviders.mockRejectedValue(error);
    await act(async () => { root.render(createElement(Probe)); });
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(transport.listProviders).toHaveBeenCalledTimes(1);
    expect(state.ready).toBe(false);
    expect(allowsFlatFallback()).toBe(unsupported);
  });

  it('reports a failed fresh read to the mounted picker and clears its ready state', async () => {
    transport.listProviders.mockResolvedValue({ providers: [], modelVisibilityOverrides: { 'codex:xd:hidden': false } });
    await act(async () => { root.render(createElement(Probe)); });
    expect(state.ready).toBe(true);
    await act(async () => {
      await expect(fetchDeviceProvidersFresh('host', async () => { throw new Error('[INTERNAL] failed'); }))
        .rejects.toThrow('failed');
    });
    expect(state).toMatchObject({ ready: false, loading: false, unsupported: false });
    expect(state.error).toContain('failed');
    expect(allowsFlatFallback()).toBe(false);
  });

  it('does not let a retired device retry after switching to another device', async () => {
    transport.listProviders.mockRejectedValueOnce(new Error('[MODEL_VISIBILITY_NOT_READY] waiting'))
      .mockResolvedValue({ providers: [], modelVisibilityOverrides: {} });
    await act(async () => { root.render(createElement(Probe)); });
    await act(async () => { root.render(createElement(Probe, { deviceId: 'other' })); });
    evictDeviceProviders('host');
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(transport.listProviders).toHaveBeenCalledTimes(2);
    expect(state).toMatchObject({ ready: true, error: null, unsupported: false });
  });
});
