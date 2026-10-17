import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { applyPendingAgentSwitchIfIdle, createPendingAgentSwitchRegistry, type MakerSessionAgentSwitchHandlerDeps } from '../sessionAgentSwitchHandler';
import { parseOrcaRemoteLead } from '../../../shared/orcaRemoteWorker';

// Execute the actual picker admission branches (local and agent-device), with
// everything after admission represented by applyLive. No Electron bootstrap.
const source = ts.createSourceFile('register.ts', readFileSync(new URL('../register.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true);
const branches: string[] = [];
const confirmationChecks: string[] = [];
let applySelectionAdapter = '';
let piWindowOverride = '';
function visit(node: ts.Node) {
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

describe('Orca model-only picker intent admission', () => {
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
