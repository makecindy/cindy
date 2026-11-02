import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { applyPendingAgentSwitchIfIdle, createPendingAgentSwitchRegistry, isUserPendingAgentSwitchIntent, type MakerSessionAgentSwitchHandlerDeps, type PendingAgentSwitchIntent } from '../sessionAgentSwitchHandler';
import { parseOrcaRemoteLead } from '../../../shared/orcaRemoteWorker';
import { acquireSendToSessionLock, withSendToSessionLock } from '../sendToSessionLock';
import { takeOverLocalAgentVisibleSession } from '../../local-agent/visibleSessions';
import { effectiveSourceIdForModel, findCatalogModel, type ProviderView } from '@cindy/model-providers';
import { resolveSessionRuntimeAxes } from '../sessionRuntimeControl';
import { parseScheduledModelBaseline } from '../../../shared/scheduledModelBaseline';
import { applyScheduledModelSelection, createScheduledModelScope, type ScheduledModelSelection } from '../scheduledModelSelection';

// Execute the actual picker admission branches (local and agent-device), with
// everything after admission represented by applyLive. No Electron bootstrap.
const source = ts.createSourceFile('register.ts', readFileSync(new URL('../register.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true);
const branches: string[] = [];
const confirmationChecks: string[] = [];
let applySelectionAdapter = '';
let piWindowOverride = '';
let directSendAdapter = '';
let directSendEntry = '';
let scheduledScopeBusyAdapter = '';
let archivedAdmission = '';
let terminalGuard = '';
let stageAxisAdapter = '';
let scheduledAxisAdapter = '';
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'acquirePendingAgentSwitchForDirectSend' && node.body) {
    directSendEntry = node.getText(source).replace(/^export /, '');
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'updateSavedScheduledAxis') {
    scheduledAxisAdapter = node.initializer!.getText(source);
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'stagePendingUserRuntimeAxis') {
    stageAxisAdapter = node.initializer!.getText(source);
  }
  if (ts.isBinaryExpression(node) && node.left.getText(source) === 'pendingAgentSwitchApplyHolder') {
    directSendAdapter = node.right.getText(source);
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'scheduledModelScope'
      && node.initializer && ts.isCallExpression(node.initializer)) {
    const options = node.initializer.arguments[0];
    if (options && ts.isObjectLiteralExpression(options)) {
      const busy = options.properties.find(property => ts.isPropertyAssignment(property)
        && property.name.getText(source) === 'isBusy');
      if (busy && ts.isPropertyAssignment(busy)) scheduledScopeBusyAdapter = busy.initializer.getText(source);
    }
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'canStageArchivedSelection') {
    archivedAdmission = node.initializer!.getText(source);
  }
  if (ts.isIfStatement(node) && node.expression.getText(source) === "runtimeStatus.status !== 'active' && !canStageArchivedSelection") {
    terminalGuard = node.getText(source);
  }
  if (ts.isPropertyAssignment(node)) {
    if (node.name.getText(source) === 'confirmedTargetPressure' && node.initializer.getText(source).includes('runtimeStatus.orcaRole')) {
      confirmationChecks.push(node.initializer.getText(source));
    }
    if (node.name.getText(source) === 'selectSameAgentModel') applySelectionAdapter = node.initializer.getText(source);
  }
  if (ts.isIfStatement(node) && node.expression.getText(source).includes('!internalOptions.applyingUserSelectionOnSend')
    && node.thenStatement.getText(source).includes('pendingUntilSend: true')) {
    branches.push(node.getText(source));
  }
  if (ts.isIfStatement(node) && node.thenStatement.getText(source).includes('targetContextWindow = confirmedContextWindow ?? targetContextWindow')) {
    piWindowOverride = node.getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
const remoteLead = { leadDeviceId: 'lead-device', leadSessionId: 'lead-session', workerLabel: 'worker' };
const orcaIdentities = [
  { orcaRole: 'lead' },
  { orcaRole: 'worker' },
  { orcaRole: null, orcaRemoteLead: JSON.stringify(remoteLead) },
];

function compile(expression: string, bindings: Record<string, unknown>) {
  const js = ts.transpileModule(`return ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}

function axisCatalogBindings(row: object = {}) {
  const models = ['target', 'new'].map(id => ({ id, name: id, mode: 'chat', efforts: ['low', 'high'], defaultEffort: 'low', supportsFastMode: true }));
  const providers = [{ id: 'provider', connected: true, agents: ['codex', 'pi'], routing: { codex: {}, pi: {} },
    models: { codex: models, pi: models } }] as unknown as ProviderView[];
  return {
    effectiveSourceIdForModel, findCatalogModel, resolveSessionRuntimeAxes,
    getActiveCatalog: () => ({}),
    getDesktopProviderService: () => ({ listProviders: async () => providers }),
    readUsableAgentDeviceProviders: vi.fn(async () => providers),
    agentSwitchDeps: { getSessionRow: async () => row },
    throwIpcError: (code: string, message: string) => { throw new Error(`[${code}] ${message}`); },
  };
}

describe('owner settings during an automatic turn', () => {
  it.each([{ effort: 'high' as const }, { fastMode: true }])('saves %j against the owner model', async (patch) => {
    const baseline = { scopeId: 'run', agentKind: 'codex', model: 'target', providerId: 'provider',
      effort: 'low', fastMode: false };
    const updateScheduledPreference = vi.fn(async () => {});
    const assertCurrent = vi.fn();
    const query = { from: () => query, where: () => query, limit: async () => [{ baseline: JSON.stringify(baseline) }] };
    const update = compile(scheduledAxisAdapter, {
      ...axisCatalogBindings(), parseScheduledModelBaseline,
      getDbClient: () => ({ drizzle: { select: () => query } }),
      sessions: {}, eq: vi.fn(), updateScheduledPreference,
    });
    expect(await update('s1', patch, assertCurrent)).toBe(true);
    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(updateScheduledPreference).toHaveBeenCalledExactlyOnceWith('s1', patch);
  });
});

// Unit: stale UI axes must be admitted against the pending execution route,
// before publishing or persisting a recovery tail. Previous send tests only
// used target-compatible values and could not detect this bypass.
describe('pending target axis admission', () => {
  const routes = ['cross-engine', 'remote', 'remote-same-agent', 'inherited-remote', 'return-local', 'recovery'] as const;
  it.each(routes.flatMap(route => ['effort', 'fastMode'].map(axis => ({ route, axis }))))(
    'rejects stale $axis for $route without changing intent or DB', async ({ route, axis }) => {
      const row = { agentDeviceId: route === 'inherited-remote' || route === 'remote-same-agent' || route === 'return-local' ? 'old-device' : null };
      const bindings = axisCatalogBindings(row);
      const providers = [{ id: 'provider', connected: true, models: { pi: [{ id: 'target', efforts: ['low'], defaultEffort: 'low', supportsFastMode: false }] } }] as unknown as ProviderView[];
      bindings.getDesktopProviderService = () => ({ listProviders: async () => providers });
      bindings.readUsableAgentDeviceProviders.mockResolvedValue(providers);
      const pending = createPendingAgentSwitchRegistry();
      const intent = { targetAgentKind: 'pi', model: 'target', providerId: 'provider', effort: 'low', fastMode: false,
        confirmedContextWindow: 200000,
        ...(route === 'remote' ? { targetAgentDeviceId: 'target-device' } : {}),
        ...(route === 'remote-same-agent' ? { sameAgentSelection: true } : {}),
        ...(route === 'return-local' ? { targetAgentDeviceId: null } : {}),
        ...(route === 'recovery' ? { resumeFallbackRecovery: { boundaryClientId: 'boundary' } } : {}),
      } as PendingAgentSwitchIntent;
      pending.set('s1', intent);
      const persist = vi.fn();
      const changed = vi.fn();
      const stage = compile(stageAxisAdapter, { ...bindings, agentSwitchPending: pending,
        agentSwitchDeps: { ...bindings.agentSwitchDeps, onPendingSwitchChanged: changed,
          selectSameAgentModel: vi.fn(async () => ({ deferred: true })) },
        persistSessionFields: persist, projectPendingAgentSwitchIntent: (value: unknown) => value,
        wakeSessionInputAfterCredentialSwitch: vi.fn() });
      await expect(stage('s1', intent, axis === 'effort' ? { effort: 'xhigh' } : { fastMode: true }, vi.fn()))
        .rejects.toThrow('INVALID_PARAMS');
      expect(pending.get('s1')).toBe(intent);
      expect(persist).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
      const device = route === 'remote' ? 'target-device' : route === 'inherited-remote' || route === 'remote-same-agent' ? 'old-device' : null;
      if (device) expect(bindings.readUsableAgentDeviceProviders).toHaveBeenCalledWith(device, 'pi', 'target', 'provider');
      else expect(bindings.readUsableAgentDeviceProviders).not.toHaveBeenCalled();
    });

  it.each(['valid', 'owner-changed', 'catalog-failed'] as const)('uses the target device catalog and preserves the route: %s', async mode => {
    const bindings = axisCatalogBindings();
    const localRead = vi.fn(async () => []);
    bindings.getDesktopProviderService = () => ({ listProviders: localRead });
    if (mode === 'catalog-failed') bindings.readUsableAgentDeviceProviders.mockRejectedValue(new Error('device unavailable'));
    const pending = createPendingAgentSwitchRegistry();
    const intent = { targetAgentKind: 'pi', model: 'target', providerId: 'provider', effort: 'low', fastMode: false,
      targetAgentDeviceId: 'target-device', confirmedContextWindow: 200000 } as PendingAgentSwitchIntent;
    pending.set('s1', intent);
    const stage = compile(stageAxisAdapter, { ...bindings, agentSwitchPending: pending,
      projectPendingAgentSwitchIntent: (value: unknown) => value, wakeSessionInputAfterCredentialSwitch: vi.fn() });
    const assertCurrent = () => { if (mode === 'owner-changed') throw new Error('owner changed'); };
    const result = stage('s1', intent, { effort: 'high', fastMode: true }, assertCurrent);
    if (mode === 'valid') {
      await expect(result).resolves.toMatchObject({ pendingUntilSend: true });
      expect(pending.get('s1')).toEqual({ ...intent, effort: 'high', fastMode: true });
    } else {
      await expect(result).rejects.toThrow(mode === 'owner-changed' ? 'owner changed' : 'device unavailable');
      expect(pending.get('s1')).toBe(intent);
    }
    expect(localRead).not.toHaveBeenCalled();
  });
});

// PR #6403 round 5: earlier closure tests pre-populated the intent and skipped
// Renderer persistence. Exercise the real queue/lease and recovery boundary;
// Renderer-to-IPC persistence is covered in the existing cross-file guard suite.
describe('complete selection commit boundaries', () => {
  // 2026-10-23: the real direct-send adapter restored the owner's smaller
  // window before applying the next automation. Existing tests covered picker
  // intents only. Unit tier: preserve native history across repeated automation
  // sends and restore the durable owner preference only for an ordinary send.
  // PR #6831: legacy schedules have no complete selection, but still must
  // preserve the native context before the runner applies their model override.
  it.each(['explicit', 'legacy', 'ordinary'])('applies only the next send route (%s)', async route => {
    const owner: ScheduledModelSelection = {
      agentKind: 'codex', model: 'owner-model', providerId: 'provider', effort: 'high', fastMode: false,
    };
    const automatic = { ...owner, model: 'automatic-model' };
    let profile = owner;
    let baseline: string | null = null;
    const transitions: string[] = [];
    const apply = async (_id: string, next: ScheduledModelSelection) => {
      transitions.push(next.model);
      profile = next;
      return next;
    };
    const deps = {
      createId: () => 'saved-owner', read: async () => ({ profile, baseline }),
      write: async (_id: string, saved: unknown) => { baseline = saved ? JSON.stringify(saved) : null; },
      isBusy: () => false,
      apply: async (id: string, next: ScheduledModelSelection) => { await apply(id, next); },
    };
    await createScheduledModelScope(deps).begin('scheduled-task');
    profile = automatic;
    // A new scope instance also exercises a restart between turns.
    const adapter = compile(directSendAdapter, {
      takeOverLocalAgentVisibleSession,
      scheduledModelScope: createScheduledModelScope(deps),
      acquireSendToSessionLock, agentSwitchPending: new Map(),
      isUserPendingAgentSwitchIntent, reconcileBotModelRoute: vi.fn(),
      applyPendingAgentSwitchIfIdle: vi.fn(), agentSwitchDeps: {},
      applyScheduledProfile: apply, contextOverflowRolloverHolder: null,
      // 发送边界的预算对账（register.ts）：本用例只关心路由选择，注入 no-op。
      reconcileSessionContextWindowBudgetUnderLock: vi.fn(async () => {}),
      replayPendingSessionContextWindowBudgetUnderLock: vi.fn(async () => {}),
      appliedContextWindowBudgets: new Map<string, number | null>(),
      pendingSessionContextWindowBudgetReconciles: new Set<string>(),
    });
    const directSend = compile(directSendEntry, { pendingAgentSwitchApplyHolder: adapter });
    const lease = await directSend('scheduled-task', undefined,
      route === 'explicit' ? automatic : undefined, route === 'legacy');
    // The legacy runner applies its model later under this same lease.
    if (route === 'legacy') await apply('scheduled-task', automatic);
    if (typeof lease === 'function') lease();
    else lease.release();
    expect(transitions).toEqual([route === 'ordinary' ? owner.model : automatic.model]);
    expect(profile.model).toBe(route === 'ordinary' ? owner.model : automatic.model);
    expect(baseline === null).toBe(route === 'ordinary');
  });

  // Test value
  // - Production entry and observable result: the actual direct-send lease keeps an Agent-registered target route until the send consumer applies it.
  // - Bug basis: #8263; automatic scheduled-baseline restoration can cross Harnesses before pending Agent intent is consumed.
  // - Existing coverage gap: picker intent tests do not combine runtimeSource='agent' with a saved scheduled baseline.
  // - Minimal failure input: one pending Agent Harness intent plus a baseline whose Harness differs from the current route.
  // - Tier: unit; in-memory scope and send-lock dependencies, no Electron or external process.
  // - Measured file runtime: 88.44s on Windows / Node 24.22.1; 87.12s was collection and test execution was 214ms.
  it('consumes an Agent runtime intent before a scheduled baseline can overwrite it', async () => {
    const sessionId = 'agent-with-scheduled-baseline';
    const pending = createPendingAgentSwitchRegistry();
    const intent: PendingAgentSwitchIntent = {
      runtimeSource: 'agent', targetAgentKind: 'claude-code', model: 'agent-model', providerId: 'agent-provider',
    };
    pending.set(sessionId, intent);
    let baseline: string | null = JSON.stringify({
      agentKind: 'codex', model: 'owner-model', providerId: 'owner-provider',
      effort: null, fastMode: false, scopeId: 'scheduled-run',
    });
    const isBusy = compile(scheduledScopeBusyAdapter, {
      isSessionInTurn: () => false, maker: { getSession: () => undefined },
      isUserPendingAgentSwitchIntent, agentSwitchPending: pending,
    }) as (id: string) => boolean;
    const restoreBaseline = vi.fn(async (_id: string, selection: ScheduledModelSelection) => {
      // A cross-Harness baseline restore commits through the normal switch path;
      // that path CAS-clears the pending registry entry it observed at start.
      await applyScheduledModelSelection(selection, {
        getTarget: async () => ({ agentKind: 'pi', status: 'active' }),
        isBusy: () => false,
        resolveSelection: async value => value,
        switchHarness: async () => { pending.clear(sessionId); return { engineReady: true }; },
        applyModel: async () => {},
      });
    });
    const scope = createScheduledModelScope({
      createId: () => 'unused', isBusy,
      read: async () => ({ profile: {
        agentKind: 'pi', model: 'scheduled-model', providerId: 'scheduled-provider', effort: null, fastMode: false,
      }, baseline }),
      write: async (_id, next) => { baseline = next ? JSON.stringify(next) : null; return true; },
      apply: restoreBaseline,
    });
    let consumed: PendingAgentSwitchIntent | undefined;
    const applyPending = vi.fn(async (_deps: unknown, id: string) => {
      consumed = pending.get(id);
      if (consumed) pending.clear(id);
    });
    const adapter = compile(directSendAdapter, {
      takeOverLocalAgentVisibleSession, acquireSendToSessionLock, scheduledModelScope: scope,
      agentSwitchPending: pending, isUserPendingAgentSwitchIntent,
      restoreArchivedSessionForSend: vi.fn(), reconcileBotModelRoute: vi.fn(async () => {}),
      applyPendingAgentSwitchIfIdle: applyPending, agentSwitchDeps: {},
      replayPendingSessionContextWindowBudgetUnderLock: vi.fn(async () => {}),
      contextOverflowRolloverHolder: null,
    });
    const directSend = compile(directSendEntry, { pendingAgentSwitchApplyHolder: adapter });
    const lease = await directSend(sessionId);
    try {
      expect(restoreBaseline).not.toHaveBeenCalled();
      expect(consumed).toEqual(intent);
      expect(pending.get(sessionId)).toBeUndefined();
      expect(baseline).not.toBeNull(); // The automation baseline remains available for the next ordinary send.
    } finally {
      if (typeof lease === 'function') lease();
      else lease.release();
    }
  });

  it('reads a picker intent staged while the direct send waits for the real route lock', async () => {
    const pending = createPendingAgentSwitchRegistry();
    let status = 'archived';
    let finishPicker!: () => void;
    let pickerStarted!: () => void;
    const started = new Promise<void>(resolve => { pickerStarted = resolve; });
    const picker = withSendToSessionLock('queued-picker', async () => {
      pickerStarted();
      await new Promise<void>(resolve => { finishPicker = resolve; });
      pending.set('queued-picker', { targetAgentKind: 'codex', model: 'new', providerId: null, sameAgentSelection: true });
    });
    await started;
    const selected = vi.fn(async () => {
      if (status !== 'active') throw new Error('archived selection applied');
      return {};
    });
    const deps = { pendingSwitches: pending, getLiveSession: () => null, selectSameAgentModel: selected,
      bootstrapSwitchedSession: vi.fn(), log: { warn: vi.fn() } } as unknown as MakerSessionAgentSwitchHandlerDeps;
    const directSend = compile(directSendAdapter, { agentSwitchPending: pending, acquireSendToSessionLock,
      takeOverLocalAgentVisibleSession,
      scheduledModelScope: { restore: vi.fn(async () => {}) },
      restoreArchivedSessionForSend: async () => { status = 'active'; },
      reconcileBotModelRoute: vi.fn(), applyPendingAgentSwitchIfIdle, isUserPendingAgentSwitchIntent,
      agentSwitchDeps: deps, contextOverflowRolloverHolder: null,
      reconcileSessionContextWindowBudgetUnderLock: vi.fn(async () => {}),
      replayPendingSessionContextWindowBudgetUnderLock: vi.fn(async () => {}),
      appliedContextWindowBudgets: new Map<string, number | null>(),
      pendingSessionContextWindowBudgetReconciles: new Set<string>() });
    const sending = directSend('queued-picker');
    finishPicker();
    await picker;
    const lease = await sending;
    try {
      expect(status).toBe('active');
      expect(selected).toHaveBeenCalledOnce();
      expect(pending.get('queued-picker')).toBeUndefined();
      let subsequentStarted = false;
      const subsequent = withSendToSessionLock('queued-picker', async () => { subsequentStarted = true; });
      await Promise.resolve();
      expect(subsequentStarted).toBe(false);
      lease.release();
      await subsequent;
    } finally { lease.release(); }
  });

  it.each([false, true])('retains new axes through the recovery tail (persistence fails: %s)', async fails => {
      const pending = createPendingAgentSwitchRegistry();
      const row = { status: 'archived', model: 'target', effort: 'low', fastMode: false };
      const intent: PendingAgentSwitchIntent = { targetAgentKind: 'codex', model: 'target', providerId: null,
        effort: 'low', fastMode: false, resumeFallbackRecovery: {
          boundaryClientId: 'boundary', boundaryContent: { fromAgentKind: 'cc', toAgentKind: 'codex',
            fromModel: 'old', toModel: 'target', fromSdkSessionId: null, handoff: 'handoff', resumed: false },
          handoff: 'handoff', handoffClearEpoch: 0,
        } };
      pending.set('s1', intent);
      const persistSessionFields = vi.fn(async (_id: string, patch: object) => {
        if (fails) throw new Error('sqlite rejected');
        Object.assign(row, patch);
      });
      const deps = { pendingSwitches: pending, getLiveSession: () => null, getSessionRow: async () => row,
        applyResumeFallbackAtomically: vi.fn(), setPendingHandoff: vi.fn(), onPendingSwitchChanged: vi.fn(),
        log: { warn: vi.fn() } } as unknown as MakerSessionAgentSwitchHandlerDeps;
      const stageAxis = compile(stageAxisAdapter, { ...axisCatalogBindings(row), agentSwitchPending: pending, agentSwitchDeps: deps,
        persistSessionFields, projectPendingAgentSwitchIntent: (value: unknown) => value,
        wakeSessionInputAfterCredentialSwitch: vi.fn() });
      if (fails) {
        await expect(stageAxis('s1', intent, { effort: 'high', fastMode: true }, vi.fn())).rejects.toThrow('sqlite rejected');
        expect(pending.get('s1')).toBe(intent);
        expect(row).toMatchObject({ effort: 'low', fastMode: false });
      } else {
        await stageAxis('s1', intent, { effort: 'high', fastMode: true }, vi.fn());
        await applyPendingAgentSwitchIfIdle(deps, 's1');
        expect(pending.get('s1')).toBeUndefined();
        expect(row).toMatchObject({ model: 'target', effort: 'high', fastMode: true });
      }
  });
});

describe('Orca model-only picker intent admission', () => {
  // PR #6403 P1: the composer already restores archived tasks, but Goal's
  // direct-send lease did not. Execute the real lease, send boundary and model
  // admission together; earlier picker tests stop before this boundary (unit).
  const directSendCases = ['archived', 'cross-engine', 'relocation', 'config', 'agent', 'restore-failed', 'cancelled'] as const;
  it.each(directSendCases)('handles archived direct-send selection: %s', async mode => {
    const row = { id: 's1', status: 'archived', agentKind: 'codex', model: 'old', providerId: 'provider', effort: 'low', fastMode: false,
      sdkSessionId: null, remoteHostId: null, agentDeviceId: null };
    const pending = createPendingAgentSwitchRegistry();
    const crossEngine = mode === 'cross-engine';
    const intent: PendingAgentSwitchIntent = { targetAgentKind: crossEngine ? 'pi' : 'codex', model: 'new', providerId: 'provider',
      ...(mode === 'relocation' ? { targetAgentDeviceId: 'executor-device' } : !crossEngine ? { sameAgentSelection: true } : {}),
      ...(mode === 'config' ? { configStaged: true } : mode === 'agent' ? { runtimeSource: 'agent' } : {}),
    };
    pending.set('s1', intent);
    const applied = vi.fn(() => ({ deferred: false }));
    const throwIpcError = (code: string, message: string) => { throw new Error(`[${code}] ${message}`); };
    const admission = compile(`(internalOptions) => {
      const canStageArchivedSelection = ${archivedAdmission};
      ${terminalGuard}
      return applied();
    }`, { runtimeStatus: row, applied, throwIpcError });
    const selectSameAgentModel = compile(applySelectionAdapter, { throwIpcError,
      applySessionRuntimeSelection: (_id: string, _model: string, _provider: unknown, _axes: unknown, opts: unknown) => admission(opts),
    });
    const release = vi.fn();
    const acquire = vi.fn(async () => release);
    const restore = vi.fn(async () => {
      if (mode === 'restore-failed') throw new Error('restore failed');
      row.status = 'active';
    });
    const switchToDb = vi.fn(async (_id: string, patch: object) => {
      expect(row.status).toBe('active');
      Object.assign(row, patch);
    });
    const automatic = mode === 'config' || mode === 'agent';
    const deps = { pendingSwitches: pending, getSessionRow: async () => row,
      getLiveSession: () => ({ isTurnRunning: () => automatic }), selectSameAgentModel,
      closeSession: vi.fn(), listMessagesForHandoff: async () => [], applyAgentSwitchToDb: switchToDb,
      setSessionProvider: vi.fn(), insertBoundaryMessage: async () => 'boundary', setPendingHandoff: vi.fn(),
      bootstrapSwitchedSession: vi.fn(), withCloseSuppressed: (_id: string, fn: () => Promise<unknown>) => fn(),
      log: { info: vi.fn(), warn: vi.fn() } } as unknown as MakerSessionAgentSwitchHandlerDeps;
    const directSend = compile(directSendAdapter, {
      takeOverLocalAgentVisibleSession,
      scheduledModelScope: { restore: vi.fn(async () => {}) },
      agentSwitchPending: pending, restoreArchivedSessionForSend: restore,
      acquireSendToSessionLock: acquire, reconcileBotModelRoute: vi.fn(),
      applyPendingAgentSwitchIfIdle, isUserPendingAgentSwitchIntent, agentSwitchDeps: deps, contextOverflowRolloverHolder: null,
      reconcileSessionContextWindowBudgetUnderLock: vi.fn(async () => {}),
      replayPendingSessionContextWindowBudgetUnderLock: vi.fn(async () => {}),
      appliedContextWindowBudgets: new Map<string, number | null>(),
      pendingSessionContextWindowBudgetReconciles: new Set<string>(),
    });
    if (mode === 'cross-engine' || mode === 'relocation') {
      const stageAxis = compile(stageAxisAdapter, { ...axisCatalogBindings(row), agentSwitchPending: pending, agentSwitchDeps: deps,
        projectPendingAgentSwitchIntent: (intent: unknown) => intent, wakeSessionInputAfterCredentialSwitch: vi.fn() });
      await stageAxis('s1', pending.get('s1'), { effort: 'high' }, vi.fn());
      await stageAxis('s1', pending.get('s1'), { fastMode: true }, vi.fn());
      expect(row).toMatchObject({ status: 'archived', model: 'old', effort: 'low', fastMode: false });
    }
    const controller = new AbortController();
    if (mode === 'cancelled') controller.abort();
    if (automatic) {
      const lease = await directSend('s1', controller.signal);
      expect(restore).not.toHaveBeenCalled();
      expect(row.status).toBe('archived');
      expect(pending.get('s1')).toBe(intent);
      expect(applied).not.toHaveBeenCalled();
      expect(switchToDb).not.toHaveBeenCalled();
      lease.release();
    } else if (mode !== 'restore-failed' && mode !== 'cancelled') {
      const sending = directSend('s1', controller.signal);
      const lease = await sending;
      expect(row.status).toBe('active');
      if (mode === 'archived') expect(applied).toHaveBeenCalledOnce();
      else {
        expect(switchToDb).toHaveBeenCalledOnce();
        expect(row.model).toBe('new');
        expect(row.agentKind).toBe(mode === 'relocation' ? 'codex' : 'pi');
        if (mode === 'relocation') expect(row.agentDeviceId).toBe('executor-device');
        if (mode === 'cross-engine' || mode === 'relocation') expect(row).toMatchObject({ effort: 'high', fastMode: true });
      }
      expect(pending.get('s1')).toBeUndefined();
      expect(acquire.mock.invocationCallOrder[0]).toBeLessThan(restore.mock.invocationCallOrder[0]);
      expect(restore).toHaveBeenCalledWith('s1', { routeLockHeld: true, signal: controller.signal });
      expect(release).not.toHaveBeenCalled();
      lease.release();
      expect(release).toHaveBeenCalledOnce();
    } else {
      await expect(directSend('s1', controller.signal)).rejects.toThrow(mode === 'restore-failed' ? 'restore failed' : /abort/i);
      expect(row.status).toBe('archived');
      expect(applied).not.toHaveBeenCalled();
      expect(switchToDb).not.toHaveBeenCalled();
      expect(pending.get('s1')).toBeDefined();
      if (mode === 'cancelled') expect(restore).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    }
  });

  it.each(['lead', 'worker'] as const)('stages %s model and axes on both execution locations until send', async orcaRole => {
    expect(branches).toHaveLength(2);
    for (const branch of branches) {
      const onOtherDevice = !branch.includes('!runtimeStatus.remoteHostId');
      const pending = new Map();
      const applyLive = vi.fn(() => ({ deferred: false, superseded: false }));
      const changed = vi.fn();
      const runtimeStatus = { orcaRole, remoteHostId: null, agentDeviceId: onOtherDevice ? 'other' : null,
        agentKind: 'codex', model: 'old', providerId: 'old-provider', effort: 'low', fastMode: false };
      const internalOptions = { source: 'user', applyingUserSelectionOnSend: false };
      const bindings = {
        internalOptions, runtimeStatus, sessionId: 's1', model: 'new',
        targetProviderId: 'provider', effectiveProviderId: 'provider', currentProviderId: 'old-provider',
        agentKind: 'codex', dbToMakerAgentKind: (kind: string) => kind,
        targetEffort: 'high', targetFastMode: true, targetContextWindow: undefined,
        confirmedContextWindow: 200000 as number | undefined,
        atomicSelection: { effort: 'high', fastMode: true },
        assertRuntimeOwnerCurrent: vi.fn(), assertSharedTaskCurrent: { admit: vi.fn() },
        assertAgentDeviceRouteUsable: vi.fn(), supersededByOwnerBoundary: () => false,
        clearPendingCredentialSwitchForSession: vi.fn(), agentSwitchPending: pending,
        agentSwitchDeps: { onPendingSwitchChanged: changed },
        projectPendingAgentSwitchIntent: (intent: unknown) => intent,
        wakeSessionInputAfterCredentialSwitch: vi.fn(),
        isDeviceLinkInvoke: () => true, markRemoteSettingPersistedInsideHandler: vi.fn(), applyLive,
      };
      const compiled = ts.transpileModule(`return async () => { ${branch}; return applyLive(); };`,
        { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
      const run = () => new Function(...Object.keys(bindings), compiled)(...Object.values(bindings))();
      expect(await run()).toMatchObject({ deferred: true, pendingUntilSend: true });
      expect(pending.get('s1')).toMatchObject({ sameAgentSelection: true, targetAgentKind: 'codex',
        model: 'new', providerId: 'provider', effort: 'high', fastMode: true });
      expect(changed).toHaveBeenCalledTimes(1);
      // A deferred choice must not let Device Link overwrite the source route,
      // including when this task's Agent runs on another computer.
      expect(bindings.markRemoteSettingPersistedInsideHandler).toHaveBeenCalledOnce();
      expect(applyLive).not.toHaveBeenCalled();
      expect(runtimeStatus.model).toBe('old');
      if (!onOtherDevice) {
        expect(pending.get('s1').confirmedContextWindow).toBe(200000);
        // Axis-only restaging retains this route's receipt; a different route
        // must not inherit acknowledgement from the previous selection.
        bindings.confirmedContextWindow = undefined;
        await run();
        expect(pending.get('s1').confirmedContextWindow).toBe(200000);
        bindings.model = 'another-model';
        await run();
        expect(pending.get('s1')).not.toHaveProperty('confirmedContextWindow');
      }
      if (onOtherDevice) expect(bindings.assertAgentDeviceRouteUsable).toHaveBeenCalledWith('other', 'codex', 'new', 'provider');
      // Use the real send boundary: a running turn keeps the intent, the next
      // idle send applies it once instead of staging it again.
      let running = true;
      const deps = {
        pendingSwitches: { get: (id: string) => pending.get(id), clear: (id: string) => pending.delete(id) },
        getLiveSession: () => ({ isTurnRunning: () => running }),
        selectSameAgentModel: async (_id: string, _intent: unknown, applyNow: boolean) => {
          internalOptions.applyingUserSelectionOnSend = applyNow;
          return run();
        },
        log: { info: vi.fn(), warn: vi.fn() },
      } as unknown as MakerSessionAgentSwitchHandlerDeps;
      await applyPendingAgentSwitchIfIdle(deps, 's1');
      expect(applyLive).not.toHaveBeenCalled();
      expect(pending.has('s1')).toBe(true);
      running = false;
      await applyPendingAgentSwitchIfIdle(deps, 's1');
      expect(pending.has('s1')).toBe(false);
      await applyPendingAgentSwitchIfIdle(deps, 's1');
      expect(applyLive).toHaveBeenCalledTimes(1);
      expect(changed).toHaveBeenCalledTimes(onOtherDevice ? 1 : 3);
    }
  });

  it.each([undefined, 400000, 200000])('authorizes Orca local/final Pi rebuild only for the checked window: %s', confirmed => {
    expect(confirmationChecks).toHaveLength(2);
    for (const expression of confirmationChecks) {
      const check = new Function('runtimeStatus', 'internalOptions', 'isDeviceLinkInvoke',
        'confirmedContextWindow', 'targetContextWindow', 'finalPiWindow', 'parseOrcaRemoteLead', `return ${expression};`);
      for (const identity of orcaIdentities) {
        for (const remote of [false, true]) {
          expect(check(identity, { source: 'user', applyingUserSelectionOnSend: true },
            () => remote, confirmed, 200000, 200000, parseOrcaRemoteLead)).toBe(!remote && confirmed === 200000);
        }
      }
      expect(check({ orcaRole: null }, { source: 'user', applyingUserSelectionOnSend: true },
        () => false, confirmed, 200000, 200000, parseOrcaRemoteLead)).toBe(true);
    }
  });

  it('keeps the verified Pi window for execution-device Workers instead of trusting an old confirmation', () => {
    expect(piWindowOverride).not.toBe('');
    const check = new Function('runtimeStatus', 'isDeviceLinkInvoke', 'runtimeAgentKind',
      'confirmedContextWindow', 'targetContextWindow', 'parseOrcaRemoteLead',
      `${piWindowOverride}; return targetContextWindow;`);
    for (const identity of orcaIdentities) {
      expect(check(identity, () => false, 'pi', 400000, 200000, parseOrcaRemoteLead)).toBe(200000);
      expect(check(identity, () => false, 'pi', 400000, undefined, parseOrcaRemoteLead)).toBeUndefined();
    }
    expect(check({ orcaRole: null }, () => false, 'pi', 400000, 200000, parseOrcaRemoteLead)).toBe(400000);
  });

  it('retains intent when the send-time window still needs confirmation and retries with the new receipt', async () => {
    const pending = createPendingAgentSwitchRegistry();
    const apply = vi.fn(async (_id: string, _model: string, _provider: unknown, selection: { confirmedContextWindow?: number }) =>
      selection.confirmedContextWindow === 200000 ? { deferred: false } :
        { deferred: false, contextWindowConfirmationRequired: 200000 });
    const bindings = { applySessionRuntimeSelection: apply,
      throwIpcError: (_code: string, message: string) => { throw new Error(message); } };
    const code = ts.transpileModule(`return ${applySelectionAdapter};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const selectSameAgentModel = new Function(...Object.keys(bindings), code)(...Object.values(bindings));
    pending.set('s1', { sameAgentSelection: true, targetAgentKind: 'codex', model: 'small', providerId: 'provider' });
    const deps = { pendingSwitches: pending, getLiveSession: () => undefined, selectSameAgentModel,
      log: { info: vi.fn(), warn: vi.fn() } } as unknown as MakerSessionAgentSwitchHandlerDeps;
    await expect(applyPendingAgentSwitchIfIdle(deps, 's1')).rejects.toThrow('select the model again');
    expect(pending.get('s1')).toBeDefined();
    pending.set('s1', { ...pending.get('s1')!, confirmedContextWindow: 200000 });
    await applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(pending.get('s1')).toBeUndefined();
    expect(apply.mock.calls[1][3]).toMatchObject({ confirmedContextWindow: 200000 });
  });
});
