// @vitest-environment jsdom
import { useRemoteDraftDefaults, useRemoteDraftSelection, useRemoteDraftPush } from '../useRemoteDraftDefaults';
import type { AgentKind, AgentCapabilities } from '@/hooks/useAgentCapabilities';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getDataOwnerGeneration, setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { forgetRemoteDraftDefaults, getRemoteDraftDefaults, rememberRemoteDraftDefaults } from '../remoteDraftDefaultsCache';

// Unit regression: mount the production read/selection/push hooks, with only
// the Electron transport replaced. Covers cache reuse and authoritative writes.
function usePageDefaults(bindings: Parameters<typeof useRemoteDraftDefaults>[0] & { capabilities: AgentCapabilities }) {
  const remoteDefaults = useRemoteDraftDefaults(bindings);
  useRemoteDraftSelection({
    remoteDefaults, usesDeviceCatalog: true, catalogDeviceId: bindings.effectiveDeviceLinkDeviceId,
    capabilityAgentKind: bindings.capabilityAgentKind, agentCatalogProviders: [], capabilities: bindings.capabilities,
    capabilitiesLoading: false, deviceProvidersUnsupported: true, deviceProvidersLoading: false,
    deviceDraftDefaultsReady: remoteDefaults.remoteDraftState.status === 'ready',
    deviceDraftDefaults: remoteDefaults.remoteDraftState.value, isAgentDeviceDraft: false,
  });
  useRemoteDraftPush({ ...bindings, remoteDefaults, effectiveAgentDeviceId: undefined, agentCatalogProviders: [] });
  return { ...remoteDefaults, touch: () => { remoteDefaults.dlRuntimeTouchedRef.current = true; } };
}
type State = ReturnType<typeof usePageDefaults>;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
beforeEach(() => setDataOwnerGeneration('cache-test'));
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.unstubAllGlobals(); });
function mount(deviceId = 'host', agent: AgentKind = 'codex') {
  act(() => root?.unmount());
  let resolveRead!: (value: unknown) => void;
  let rejectRead!: (error: unknown) => void;
  const promise = new Promise((resolve, reject) => { resolveRead = resolve; rejectRead = reject; });
  const invoke = vi.fn(() => promise);
  let push!: (event: unknown, stamp: unknown) => void;
  let statusChanged!: (event: { status: string }) => void;
  Object.assign(window, { electronAPI: { deviceLink: { invoke, onPresenceChanged: () => () => {}, onStatusChanged: (callback: typeof statusChanged) => { statusChanged = callback; return () => {}; }, onRemotePush: (callback: typeof push) => { push = callback; return () => {}; } } } });
  const bindings = {
    isDeviceLinkDraft: true, effectiveDeviceLinkDeviceId: deviceId,
    capabilityAgentKind: agent,
    wtPreferenceTransactionRef: { current: null as { deviceId: string; status: string; enabled?: boolean } | null },
    dataOwnerId: getDataOwnerGeneration().dataOwnerId,
    dataOwnerGeneration: getDataOwnerGeneration().generation,
    capabilities: { availableModels: ['chosen', 'new-choice', 'manual'].map(id => ({ id, displayName: id, efforts: [], contextWindow: 100_000, defaultEffort: null })), permissionModes: [], effortLevels: [], hasFastMode: false },
  };
  let state!: State;
  function Harness() { state = usePageDefaults(bindings); return null; }
  root = createRoot(document.createElement('div'));
  const render = () => act(() => root!.render(createElement(Harness)));
  render();
  return { bindings, render, invoke, resolveRead, rejectRead, reconnect: () => act(() => statusChanged({ status: 'online' })), push: (value: unknown) => act(() => push({ deviceId, channel: 'maker:new-maker-draft:changed', payload: { [agent === 'claude-code' ? 'claudeCode' : agent]: value } }, { dataOwnerId: getDataOwnerGeneration().dataOwnerId, ownerGeneration: getDataOwnerGeneration().generation })), get state() { return state; } };
}
const defaults = (model: string) => ({ model, modelChosenByUser: true, worktreeEnabled: false });

it('reopens immediately with host defaults, refreshes in the background and preserves them on failure', async () => {
  const first = mount();
  expect(first.state.remoteDraftState.status).toBe('loading');
  await act(async () => first.resolveRead(defaults('chosen')));
  const reopened = mount();
  expect(reopened.state.remoteDraftState).toEqual({ status: 'ready', value: defaults('chosen') });
  expect(reopened.state.dlSel?.model).toBe('chosen');
  expect(reopened.invoke).toHaveBeenCalledTimes(1);
  await act(async () => reopened.resolveRead(defaults('new-choice')));
  expect(reopened.state.remoteDraftState.value?.model).toBe('new-choice');
  expect(reopened.state.dlSel?.model).toBe('new-choice');
  const failedRefresh = mount();
  await act(async () => failedRefresh.rejectRead(new Error('offline')));
  expect(failedRefresh.state.remoteDraftState).toEqual({ status: 'ready', value: defaults('new-choice') });
  const restartingHost = mount();
  await act(async () => restartingHost.resolveRead({}));
  expect(restartingHost.state.remoteDraftState).toEqual({ status: 'ready', value: defaults('new-choice') });
});

it('refreshes untouched selections on push while preserving controller choices', async () => {
  rememberRemoteDraftDefaults('host', 'codex', defaults('chosen'));
  const page = mount();
  page.push(defaults('new-choice'));
  expect(page.state.dlSel?.model).toBe('new-choice');
  page.state.touch();
  page.push(defaults('chosen'));
  expect(page.state.dlSel?.model).toBe('new-choice');
});

it('restarts a pending read after same-owner authentication repair', async () => {
  const page = mount();
  setDataOwnerGeneration('cache-test');
  page.bindings.dataOwnerGeneration = getDataOwnerGeneration().generation;
  page.invoke.mockImplementation(async () => defaults('new-choice'));
  await act(async () => page.render());
  expect(page.invoke).toHaveBeenCalledTimes(2);
  await act(async () => page.resolveRead(defaults('chosen')));
  expect(page.state.dlSel?.model).toBe('new-choice');
});

it.each(['writing', 'reconciling-success', 'reconciling-unknown'])('rejects stale pushes during a %s worktree transaction', async (status) => {
  const page = mount();
  page.bindings.wtPreferenceTransactionRef.current = { deviceId: 'host', status, enabled: true };
  forgetRemoteDraftDefaults('host');
  page.push(defaults('chosen'));
  expect(getRemoteDraftDefaults('host', 'codex')).toBeUndefined();
  page.push({ ...defaults('chosen'), worktreeEnabled: true });
  expect(getRemoteDraftDefaults('host', 'codex')?.worktreeEnabled).toBe(true);
});

it('isolates device, engine and account, and rejects a late response from the old account', async () => {
  rememberRemoteDraftDefaults('host', 'codex', defaults('chosen'));
  expect(mount('other').state.remoteDraftState.status).toBe('loading');
  expect(mount('host', 'pi').state.remoteDraftState.status).toBe('loading');
  const old = mount();
  setDataOwnerGeneration('new-owner');
  await act(async () => old.resolveRead(defaults('old-owner-late')));
  expect(getRemoteDraftDefaults('host', 'codex')).toBeUndefined();
  expect(mount().state.remoteDraftState.status).toBe('loading');
});

it('does not use cached defaults to acknowledge a pending worktree write', async () => {
  rememberRemoteDraftDefaults('host', 'codex', defaults('chosen'));
  const page = mount();
  page.bindings.wtPreferenceTransactionRef.current = { deviceId: 'host', status: 'reconciling-success' };
  act(() => page.state.setRemoteDraftRetryEpoch(epoch => epoch + 1));
  expect(page.state.remoteDraftState.status).toBe('loading');
  await act(async () => page.rejectRead(new Error('offline')));
  expect(page.state.remoteDraftState.status).toBe('error');
  forgetRemoteDraftDefaults('host');
  expect(getRemoteDraftDefaults('host', 'codex')).toBeUndefined();
});

it('keeps initial errors retryable and does not remember an uninitialized host snapshot', async () => {
  const failed = mount();
  await act(async () => failed.rejectRead(new Error('offline')));
  expect(failed.state.remoteDraftState.status).toBe('error');
  const empty = mount();
  await act(async () => empty.resolveRead({}));
  expect(getRemoteDraftDefaults('host', 'codex')).toBeUndefined();
  const legacy = mount();
  await act(async () => legacy.rejectRead(new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] unsupported')));
  expect(legacy.state.remoteDraftState.status).toBe('ready');
});

it('refreshes after relay reconnection without hiding the cached choice', async () => {
  rememberRemoteDraftDefaults('host', 'codex', defaults('chosen'));
  const page = mount();
  await act(async () => page.rejectRead(new Error('offline')));
  page.invoke.mockImplementation(async () => defaults('new-choice'));
  await act(async () => page.reconnect());
  expect(page.invoke).toHaveBeenCalledTimes(2);
  expect(page.state.remoteDraftState.status).toBe('ready');
  expect(page.state.dlSel?.model).toBe('new-choice');
});
