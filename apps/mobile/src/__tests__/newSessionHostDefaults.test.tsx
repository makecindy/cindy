// @vitest-environment jsdom
import { useNewSessionHostDefaults } from '@/session/useNewSessionHostDefaults';
import { useNewSessionDefaultSelection } from '@/session/useNewSessionDefaultSelection';
import { DEFAULT_NEW_SESSION_DRAFT, isNewSessionRuntimePending, type NewSessionAgentKind, type NewSessionStoredPreferences } from '@/session/newSession';
import type { MobileNewMakerDefaults } from '@/device-link/mobileMakerTransport';
import { buildMobileModelSections } from '@/session/providerModelSections';
import { act, createElement, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getMobileAuthOwner, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { getNewSessionHostDefaults } from '@/session/newSessionHostDefaultsCache';

// Unit regression: import the same hooks as the page. The remote transport and
// native permission UI are boundaries; cache/selection/lifecycle code is real.
vi.mock('@/session/fullAccessConfirmation', () => ({ confirmFullAccessChange: vi.fn(async () => true) }));
vi.mock('@/debug/mobileDebugLog', () => ({ mobileDebugLog: vi.fn() }));
function usePageDefaults(bindings: Parameters<typeof useNewSessionHostDefaults>[0] & {
  preferences: NewSessionStoredPreferences | null;
}) {
  const [draft, setDraft] = useState(bindings.draft);
  const [settledDeviceId, setSettledDeviceId] = useState<string | null>(null);
  const userTouchedRuntimeRef = useRef(false);
  const defaults = useNewSessionHostDefaults({ ...bindings, draft });
  const selectedDeviceRef = useRef(bindings.selectedDeviceId);
  selectedDeviceRef.current = bindings.selectedDeviceId;
  const deviceProviders = useRef({ providers: [], ready: false, loading: true, unsupported: false, error: null }).current;
  useNewSessionDefaultSelection({
    ...defaults, draft, setDraft, userTouchedRuntimeRef,
    selectedDeviceId: bindings.selectedDeviceId, selectedDeviceRef,
    newSessionPreferencesLoaded: true, newSessionPreferences: bindings.preferences,
    preferredDefaultDevice: { deviceId: bindings.selectedDeviceId },
    autoDefaultDeviceRef: useRef(null),
    appliedPermissionMemoryRef: useRef(true),
    runtimeActionSeqRef: useRef(0), deviceProviders, deviceProvidersRef: useRef(deviceProviders),
    catalogReadyRef: useRef(false), capabilities: null, modelRows: [],
    modelSections: buildMobileModelSections({ providers: [], agentKind: draft.agentKind }),
    flatModelsForUnsupportedHost: () => undefined, targetAgentHasFast: () => false,
    draftMemory: { getFast: () => false, getEffort: () => undefined, setFast: () => {}, setEffort: () => {} },
    settleRuntime: (_source, deviceId) => setSettledDeviceId(deviceId),
  });
  return {
    settled: defaults.hostDefaultsSettled, runtime: defaults.hostRuntimeFor('codex'),
    runtimeFor: defaults.hostRuntimeFor, draft, wait: defaults.waitHostDraftDefaults,
    pending: isNewSessionRuntimePending({
      settled: settledDeviceId === bindings.selectedDeviceId,
      selectedDeviceId: bindings.selectedDeviceId, userTouched: userTouchedRuntimeRef.current,
      remoteAgentPicked: false, catalogReady: deviceProviders.ready, catalogFailed: false, modelRowCount: 0,
    }),
    choose: (mark: boolean) => {
      userTouchedRuntimeRef.current = true;
      setDraft(bindings.draft);
      defaults.requestHostChoiceWrite(mark);
    },
  };
}
type State = ReturnType<typeof usePageDefaults>;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
beforeEach(() => { setMobileAuthOwner('defaults-test'); });
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  setMobileAuthOwner(null);
  vi.useRealTimers();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mount(deviceId = 'desktop', agentKind: NewSessionAgentKind = 'codex', failedAgent?: string, storedAgent: NewSessionAgentKind | null = null, pendingAgents: NewSessionAgentKind[] = []) {
  if (root) act(() => root!.unmount());
  const read = deferred<MobileNewMakerDefaults>();
  const pendingReads = new Map(pendingAgents.map((agent) => [agent, deferred<MobileNewMakerDefaults>()]));
  const bindings = {
    selectedDeviceId: deviceId, deviceLinkStatus: 'online', selectedDeviceRef: { current: deviceId },
    outboxOwner: getMobileAuthOwner(), remoteAgentChoice: null,
    draft: { ...DEFAULT_NEW_SESSION_DRAFT, agentKind, model: 'chosen', providerId: 'provider', effort: 'high', fastMode: false },
    maker: { getNewMakerDefaults: vi.fn((agent?: string) => agent === failedAgent ? Promise.reject(new Error('read failed')) : pendingReads.get(agent as NewSessionAgentKind)?.promise ?? read.promise), applyNewMakerDraftPref: vi.fn(async () => {}) },
    openLink: vi.fn(async () => {}),
    preferences: storedAgent ? { agentKind: storedAgent, permissionModeByAgent: {}, device: null, workspaceKind: null, workingDirByDevice: {} } : null,
  };
  let state!: State;
  function Harness() { state = usePageDefaults(bindings); return null; }
  root = createRoot(document.createElement('div'));
  const render = () => act(() => root!.render(createElement(Harness)));
  render();
  return { read, pendingReads, bindings, render, get state() { return state; } };
}
const defaults = (model: string) => ({ worktreeEnabled: false, model, providerId: 'provider', effort: 'high' });

// A new-task page can be left before optional engines finish. Its successful
// engine and explicit model choice must already be available on the next visit.
it.each(['codex', 'pi', 'claude-code'] as const)('settles and caches %s without waiting for unrelated engines', async (agent) => {
  const others = (['codex', 'pi', 'claude-code'] as const).filter((kind) => kind !== agent);
  const first = mount('desktop', agent, undefined, agent, others);
  let waited = false;
  await act(async () => { void first.state.wait('desktop', agent).then(() => { waited = true; }); });
  expect(first.state.pending).toBe(true);
  await act(async () => first.read.resolve(defaults('ready')));
  expect(first.state.pending).toBe(false);
  expect(first.state.draft.model).toBe('ready');
  expect(waited).toBe(true);
  expect(getNewSessionHostDefaults('desktop')?.byAgent[agent]?.model).toBe('ready');
  const reopened = mount('desktop', agent, undefined, agent);
  await act(async () => {});
  expect(reopened.state.pending).toBe(false);
  expect(reopened.state.draft.model).toBe('ready');
  await act(async () => {
    for (const pending of first.pendingReads.values()) pending.resolve(defaults('late'));
  });
  for (const other of others) expect(getNewSessionHostDefaults('desktop')?.byAgent[other]).toBeUndefined();
});

it.each(['codex', 'pi', 'claude-code'] as const)('keeps a first-visit manual %s choice even when all reads are pending', async (agent) => {
  const first = mount('desktop', agent);
  act(() => first.state.choose(true));
  expect(getNewSessionHostDefaults('desktop')?.byAgent[agent]?.model).toBe('chosen');
  const reopened = mount('desktop', agent, undefined, agent);
  await act(async () => {});
  expect(reopened.state.pending).toBe(false);
  expect(reopened.state.draft.model).toBe('chosen');
  await act(async () => first.read.resolve(defaults('late')));
  expect(getNewSessionHostDefaults('desktop')?.byAgent[agent]?.model).toBe('chosen');
});

it('restores the remembered engine before applying fresh background defaults', async () => {
  const first = mount();
  await act(async () => first.read.resolve(defaults('cached')));
  const page = mount('desktop', 'codex', undefined, 'pi');
  await act(async () => {});
  expect(page.state.draft.agentKind).toBe('pi');
  expect(page.state.draft.model).toBe('cached');
  await act(async () => page.read.resolve(defaults('fresh')));
  expect(page.state.draft.agentKind).toBe('pi');
  expect(page.state.draft.model).toBe('fresh');
});

it('reopens with cached defaults immediately and refreshes the next visit in the background', async () => {
  const first = mount();
  expect(first.state.settled).toBe(false);
  await act(async () => first.read.resolve(defaults('first')));
  expect(first.state.runtime?.model).toBe('first');

  const second = mount();
  expect(second.state.settled).toBe(true);
  expect(second.state.runtime?.model).toBe('first');
  let waited = false;
  await act(async () => { void second.state.wait('desktop', 'codex').then(() => { waited = true; }); });
  expect(waited).toBe(true);
  await act(async () => second.read.resolve(defaults('updated-on-desktop')));
  expect(second.state.draft.model).toBe('updated-on-desktop');
  expect(mount().state.runtime?.model).toBe('updated-on-desktop');
  await act(async () => {});
});

it.each(['codex', 'pi', 'claude-code'] as const)('preserves a manual %s choice while refreshing the other engines', async (agent) => {
  const first = mount();
  await act(async () => first.read.resolve(defaults('first')));
  const second = mount('desktop', agent);
  act(() => second.state.choose(true));
  await act(async () => second.read.resolve(defaults('old-response')));
  expect(second.state.runtimeFor(agent)?.model).toBe('chosen');
  expect(second.state.draft.model).toBe('chosen');
  for (const other of ['codex', 'pi', 'claude-code'] as const) {
    if (other === agent) continue;
    expect(second.state.runtimeFor(other)?.model).toBe('old-response');
    expect(getNewSessionHostDefaults('desktop')?.byAgent[other]?.model).toBe('old-response');
  }
  expect(mount('desktop', agent).state.runtimeFor(agent)?.model).toBe('chosen');
  await act(async () => {});
});

it('caches successful engines independently and waits for an uncached engine on reopen', async () => {
  const first = mount('desktop', 'codex', 'pi');
  await act(async () => first.read.resolve(defaults('first')));
  expect(getNewSessionHostDefaults('desktop')?.byAgent.codex?.model).toBe('first');
  expect(getNewSessionHostDefaults('desktop')?.byAgent.pi).toBeUndefined();
  expect(mount().state.settled).toBe(true);
  const pi = mount('desktop', 'pi');
  expect(pi.state.settled).toBe(false);
  await act(async () => pi.read.resolve(defaults('pi-choice')));
  expect(pi.state.settled).toBe(true);
});

it('preserves cached defaults on refresh failure, but does not cache a failed first read', async () => {
  const first = mount();
  await act(async () => first.read.resolve(defaults('first')));
  const second = mount();
  await act(async () => second.read.reject(new Error('read failed')));
  expect(second.state.runtime?.model).toBe('first');
  expect(mount().state.runtime?.model).toBe('first');

  const other = mount('other-desktop');
  expect(other.state.settled).toBe(false);
  expect(other.state.runtime).toBeNull();
  await act(async () => other.read.reject(new Error('read failed')));
  expect(other.state.settled).toBe(true);
  expect(mount('other-desktop').state.settled).toBe(false);
});

it('drops cached and in-flight defaults when the account changes', async () => {
  const first = mount();
  await act(async () => first.read.resolve(defaults('first')));
  const pending = mount();
  act(() => pending.state.choose(true));
  act(() => setMobileAuthOwner('different-account'));
  const newAccount = deferred<MobileNewMakerDefaults>();
  pending.bindings.outboxOwner = getMobileAuthOwner();
  pending.bindings.maker.getNewMakerDefaults.mockImplementation(() => newAccount.promise);
  pending.render();
  expect(pending.state.settled).toBe(false);
  expect(pending.state.runtime).toBeNull();
  await act(async () => pending.read.resolve(defaults('old-account')));
  expect(getNewSessionHostDefaults('desktop')).toBeNull();
  await act(async () => newAccount.resolve(defaults('new-account')));
  expect(mount().state.runtime?.model).toBe('new-account');
  await act(async () => {});
});

it('caches a confirmed empty default but retries an unready host without discarding old defaults', async () => {
  vi.useFakeTimers();
  const first = mount();
  await act(async () => first.read.resolve({ worktreeEnabled: false }));
  const second = mount();
  expect(second.state.settled).toBe(true);
  expect(second.state.runtime).toBeNull();
  await act(async () => second.read.resolve({}));
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(second.bindings.maker.getNewMakerDefaults).toHaveBeenCalledTimes(9);
  expect(mount().state.settled).toBe(true);
  await act(async () => {});
});
