import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import { resolveVerifiedContextWindow } from '../../../shared/sessionContextWindow';
import { createContextOverflowRollover } from '../contextOverflowRollover';
import { applyPendingAgentSwitchIfIdle, createPendingAgentSwitchRegistry, projectPendingAgentSwitchIntent,
  type MakerSessionAgentSwitchHandlerDeps, type PendingAgentSwitchIntent } from '../sessionAgentSwitchHandler';

// Run the production remote-selection adapter, send boundary and window rollover
// together. Only device I/O, native processes and persistent writes are replaced.
const source = ts.createSourceFile('register.ts', readFileSync(new URL('../register.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true);
let remoteSelection = '';
let selectionAdapter = '';
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'applyAgentDeviceRuntimeSelection') {
    remoteSelection = node.initializer!.getText(source);
  }
  if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'selectSameAgentModel') {
    selectionAdapter = node.initializer.getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
const compile = (expression: string, bindings: Record<string, unknown>) => {
  const js = ts.transpileModule(`return ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
};

function setup(agent: 'cc' | 'codex' | 'pi' = 'codex', role: string | null = 'worker', cold = false) {
  const agentKind = agent === 'cc' ? 'claude-code' : agent;
  const state = { tokens: 1000, window: 200000, verified: true };
  const row = { status: 'active', orcaRole: role, agentKind: agent, model: 'old', providerId: 'provider',
    agentDeviceId: 'executor', effort: 'high', fastMode: false, remoteHostId: null, sdkSessionId: 'native', clearedAt: null };
  const runtime = { isTurnRunning: () => false, getUsageSnapshot: () => ({ contextTokens: state.tokens, contextWindow: 1000000 }),
    setModel: vi.fn(), setFastMode: vi.fn(), requiresModelSwitchRebuild: vi.fn(async () => false) };
  let live: typeof runtime | undefined = cold ? undefined : runtime;
  const close = vi.fn(async () => { live = undefined; });
  const rebuild = vi.fn();
  const pending = createPendingAgentSwitchRegistry();
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const rollover = createContextOverflowRollover({
    getSessionRow: async () => ({ ...row, contextTokens: state.tokens, contextWindow: 1000000 }),
    getLiveSession: () => live, rehydrateColdPiRuntimeForWindowVerification: async () => { live = runtime; },
    drainPersistQueue: async () => {}, closeSession: close, commitRebuild: rebuild,
    listMessages: async () => [{ role: 'user', content: 'history', clientId: 'u1', createdAt: 1 }],
    findLatestRebuildMeta: async () => null, setPendingHandoff: vi.fn(),
    replayUserMessage: async () => ({ accepted: true }),
    withCloseSuppressed: async (_id, run) => run(), log,
  });
  const readProviders = vi.fn(async (): Promise<ProviderView[]> => [{
    id: 'provider', routing: { [agentKind]: {} }, models: { [agentKind]: [
      { id: 'new', contextWindow: state.window, contextWindowVerified: state.verified },
    ] },
  } as unknown as ProviderView]);
  const persist = vi.fn(async () => {});
  const throwIpcError = (code: string, message: string): never => { throw new Error(`[${code}] ${message}`); };
  const accept = vi.fn(() => 1);
  const bindings = {
    acceptSessionRuntimeMutation: accept, broadcastSessionPatched: vi.fn(),
    maker: { getSession: () => live, closeSession: close }, agentSwitchPending: pending,
    hasSessionProvider: () => false, getSessionProvider: () => 'provider', normalizeSessionProviderId: (id: unknown) => id,
    dbToMakerAgentKind: () => agentKind, isSessionInTurn: () => false,
    assertAgentDeviceRouteUsable: vi.fn(async () => {}), readUsableAgentDeviceProviders: readProviders,
    resolveVerifiedContextWindow, contextOverflowRolloverHolder: rollover,
    agentSwitchDeps: { onPendingSwitchChanged: vi.fn() }, projectPendingAgentSwitchIntent,
    wakeSessionInputAfterCredentialSwitch: vi.fn(), persistSessionFields: persist,
    updateScheduledPreference: vi.fn(async () => {}),
    isDeviceLinkInvoke: () => false, markRemoteSettingPersistedInsideHandler: vi.fn(),
    setSessionProvider: vi.fn(), setSessionEffort: vi.fn(), setSessionFastMode: vi.fn(), getSessionEffort: () => 'high',
    recordUserSessionRuntimeMutation: () => 1, broadcastSessionRuntimeProjection: async () => {},
    withRehydrateCloseSuppressed: async (_id: string, run: () => unknown) => run(), throwIpcError, log,
  };
  const applyRemote = compile(remoteSelection, bindings);
  const assertRuntimeOwnerCurrent = vi.fn();
  const selectSameAgentModel = compile(selectionAdapter, { throwIpcError,
    applySessionRuntimeSelection: (sessionId: string, model: string, providerId: unknown,
      selection: { effort: string; fastMode: boolean; confirmedContextWindow?: number }, internalOptions: unknown) => applyRemote({
      sessionId, model, providerId, atomicSelection: selection, internalOptions, runtimeStatus: row,
      confirmedContextWindow: selection.confirmedContextWindow, assertRuntimeOwnerCurrent,
      assertSharedTaskCurrent: { admit: vi.fn() }, supersededByOwnerBoundary: () => false,
    }),
  });
  const deps = { pendingSwitches: pending, getLiveSession: () => live, selectSameAgentModel, log } as unknown as MakerSessionAgentSwitchHandlerDeps;
  const stage = (confirmedContextWindow?: number) => selectSameAgentModel('s1', {
    sameAgentSelection: true, targetAgentKind: agentKind, model: 'new', providerId: 'provider', effort: 'high', fastMode: false,
    ...(confirmedContextWindow !== undefined ? { confirmedContextWindow } : {}),
  } satisfies PendingAgentSwitchIntent, false);
  const fallback = () => applyRemote({ sessionId: 's1', model: 'new', providerId: 'other',
    atomicSelection: { effort: 'high', fastMode: true }, internalOptions: { source: 'fallback' }, runtimeStatus: row,
    assertRuntimeOwnerCurrent, assertSharedTaskCurrent: { admit: vi.fn() }, supersededByOwnerBoundary: () => false });
  return { state, stage, fallback, accept, send: () => applyPendingAgentSwitchIfIdle(deps, 's1'),
    readProviders, pending, runtime, close, rebuild, persist, rollover, assertRuntimeOwnerCurrent };
}

describe('Orca remote-Agent window protection at send', () => {
  const cases = (['cc', 'pi'] as const).flatMap(agent => ['lead', 'worker'].flatMap(role =>
    [false, true].map(cold => ({ agent, role, cold }))));
  it.each(cases)('rechecks pressure for $agent $role cold=$cold and retains an unconfirmed intent', async ({ agent, role, cold }) => {
    const h = setup(agent, role, cold);
    await h.stage();
    expect(h.readProviders).not.toHaveBeenCalled();
    // A running turn can grow after selection, before the next dispatch.
    h.state.tokens = 190000;
    await expect(h.send()).rejects.toThrow('select the model again');
    expect(h.readProviders).toHaveBeenCalledWith('executor', agent === 'cc' ? 'claude-code' : agent, 'new', 'provider');
    expect(h.pending.get('s1')).toBeDefined();
    expect(h.runtime.setModel).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
    expect(h.rebuild).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
    // Lower pressure allows retry without losing or duplicating the selection.
    h.state.tokens = 1000;
    await h.send();
    expect(h.pending.get('s1')).toBeUndefined();
    expect(h.persist).toHaveBeenCalledOnce();
    if (!cold || agent === 'pi') {
      expect(h.runtime.setModel).toHaveBeenCalledExactlyOnceWith('new', { providerId: 'provider', effort: 'high' });
    } else {
      expect(h.runtime.setModel).not.toHaveBeenCalled();
    }
  });

  // Unit: remote Orca dispatch must preserve Codex native history even when the
  // fresh target window is smaller than the current turn or an old acknowledgement.
  // Covers the production send adapter for both roles and cold/live runtimes.
  it.each(['lead', 'worker'].flatMap(role => [false, true].map(cold => ({ role, cold }))))(
    'keeps native Codex history for $role cold=$cold despite target pressure', async ({ role, cold }) => {
      const h = setup('codex', role, cold);
      await h.stage(1000000);
      h.state.tokens = 190000;
      await h.send();
      expect(h.readProviders).toHaveBeenCalledWith('executor', 'codex', 'new', 'provider');
      expect(h.pending.get('s1')).toBeUndefined();
      expect(h.persist).toHaveBeenCalledOnce();
      expect(h.close).not.toHaveBeenCalled();
      expect(h.rebuild).not.toHaveBeenCalled();
      if (cold) expect(h.runtime.setModel).not.toHaveBeenCalled();
      else expect(h.runtime.setModel).toHaveBeenCalledExactlyOnceWith('new', { providerId: 'provider', effort: 'high' });
    },
  );

  it('does not treat an unverified catalog window or its old acknowledgement as permission to rebuild', async () => {
    const h = setup();
    await h.stage(200000);
    h.state.verified = false;
    h.state.tokens = 190000;
    await h.send();
    expect(h.readProviders).toHaveBeenCalledOnce();
    expect(h.close).not.toHaveBeenCalled();
    expect(h.rebuild).not.toHaveBeenCalled();
    expect(h.runtime.setModel).toHaveBeenCalledOnce();
    expect(h.pending.get('s1')).toBeUndefined();
  });

  it('preserves ordinary task selection without adding the Orca send-time catalog read', async () => {
    const h = setup('codex', null);
    await h.stage();
    await h.send();
    expect(h.readProviders).not.toHaveBeenCalled();
    expect(h.runtime.setModel).toHaveBeenCalledOnce();
    expect(h.persist).toHaveBeenCalledOnce();
  });

  it('does not persist a cold selection if the owner changes during window verification', async () => {
    const h = setup('codex', 'worker', true);
    await h.stage();
    vi.spyOn(h.rollover, 'prepareModelWindowSwitch').mockImplementation(async () => {
      h.assertRuntimeOwnerCurrent.mockImplementation(() => { throw new Error('owner changed'); });
      return 'not-needed';
    });
    await expect(h.send()).rejects.toThrow('owner changed');
    expect(h.pending.get('s1')).toBeDefined();
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('does not substitute a stale acknowledged window for the fresh execution-device catalog', async () => {
    const h = setup('cc');
    await h.stage(1000000);
    h.state.tokens = 190000;
    await expect(h.send()).rejects.toThrow('select the model again');
    expect(h.close).not.toHaveBeenCalled();
    expect(h.rebuild).not.toHaveBeenCalled();
    await h.stage(200000);
    await h.send();
    expect(h.rebuild).toHaveBeenCalledOnce();
    expect(h.runtime.setModel).not.toHaveBeenCalled();
    expect(h.pending.get('s1')).toBeUndefined();
  });

  it.each(['unknown-context', 'in-flight', 'remote-unsupported'] as const)('keeps the intent and route on %s', async prepared => {
    const h = setup();
    vi.spyOn(h.rollover, 'prepareModelWindowSwitch').mockResolvedValue(prepared);
    await h.stage();
    await expect(h.send()).rejects.toThrow('could not be verified');
    expect(h.pending.get('s1')).toBeDefined();
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.runtime.setModel).not.toHaveBeenCalled();
  });

  it('does not mutate the route when the execution computer cannot be rechecked', async () => {
    const h = setup();
    await h.stage();
    h.readProviders.mockRejectedValueOnce(new Error('executor unavailable'));
    await expect(h.send()).rejects.toThrow('executor unavailable');
    expect(h.pending.get('s1')).toBeDefined();
    expect(h.runtime.setModel).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
  });
});

it('applies same-location fallback to the remote runtime and retains its execution location', async () => {
  const h = setup('codex', null);
  expect(await h.fallback()).toMatchObject({ deferred: false, superseded: false });
  expect(h.runtime.setModel).toHaveBeenCalledWith('new', { providerId: 'other', effort: 'high' });
  expect(h.runtime.setFastMode).toHaveBeenCalledWith(true);
  expect(h.persist).toHaveBeenCalledWith('s1', expect.objectContaining({ model: 'new', providerId: 'other' }));
  expect(h.accept).toHaveBeenCalledWith(expect.objectContaining({ source: 'fallback',
    profile: expect.objectContaining({ agentDeviceId: 'executor', providerId: 'other', model: 'new' }) }));
});
