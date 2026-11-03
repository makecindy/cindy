import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { confirmAgentLocationForPick } from '@/session/sessionAgentSwitchConfirmation';
import { shouldBlockLegacyRemoteModelWindowSwitch } from '@cindy/maker-shared/agent-capabilities';

vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }));

// Run the production callbacks without mounting native controls or remote services.
const source = ts.createSourceFile('session.tsx', readFileSync(
  resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = new Map<string, string>();
let intentGate = '';
let remoteCatalogGate = '';
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer) {
    const name = node.name.getText(source);
    if (name === 'orcaModelSelectionUsesIntent') intentGate = node.initializer.getText(source);
    if (name === 'orcaRemoteAgentDeviceId') remoteCatalogGate = node.initializer.getText(source);
    if (ts.isCallExpression(node.initializer) && ['useCallback', 'useMemo'].includes(node.initializer.expression.getText(source))) {
      callbacks.set(name, node.initializer.arguments[0].getText(source));
    }
  }
  ts.forEachChild(node, visit);
}
visit(source);

function setup(orcaRole: 'lead' | 'worker' | null, supported = true, agentDeviceId: string | null = null,
  windowState: { agent?: string; used?: number; current?: number; target?: number; hostGuard?: boolean } = {}) {
  const selection = { model: 'new-model', providerId: 'provider', effort: 'high', fastMode: true };
  const write = vi.fn(async (_intent: unknown) => true);
  const setModel = vi.fn(async () => true);
  const runControlAction = vi.fn(async (action: () => Promise<unknown>) => action());
  const remoteCapabilities = vi.fn(async (_agent: string): Promise<unknown> => undefined);
  const bindings = {
    currentSession: { orcaRole, agentDeviceId, agentKind: windowState.agent ?? 'codex', model: 'old-model', effort: 'low', fastMode: false,
      contextTokens: windowState.used, contextWindow: windowState.current },
    currentAgentDeviceId: agentDeviceId,
    remoteAgentCatalogs: ['current', 'other'].map(deviceId => ({ deviceId, providers: [] })),
    sessionAgentSwitchSupported: supported, sessionAgentKind: windowState.agent ?? 'codex', modelSheetAgentKind: windowState.agent ?? 'codex',
    canUseRemoteSessionControls: true, canConfigureSessionModel: true, controlBusy: false,
    sessionId: 's1', deviceId: 'host', deviceIdRef: { current: 'host' },
    agentLocationMovable: false, controlledComputerName: 'Host', remoteAgentDeviceName: vi.fn(),
    agentSwitchIntent: { targetAgentKind: 'codex', ...selection },
    modelSheetSelection: selection, modelSheetCapabilities: { supportsModelWindowSwitchGuard: windowState.hostGuard !== false },
    sessionMirrorAccessors: {}, composerDeviceProviders: { providers: [] },
    resolveRowSelection: () => selection, reconcileRuntimeDraftWithCapabilities: () => selection,
    resolveAgentCapability: () => ({ supportsFastMode: true, contextWindow: windowState.target ?? 200000 }),
    normalizeMobileAgentCapabilities: (value: unknown) => value ?? ({ hasFastMode: true, supportsModelWindowSwitchGuard: windowState.hostGuard !== false }),
    maker: { getCapabilities: vi.fn(), setEffort: vi.fn(), setFastMode: vi.fn() },
    executionMakerForDevice: vi.fn((_id: string) => ({ getCapabilities: remoteCapabilities })),
    isProviderShareAgentDeviceId: (id: unknown) => typeof id === 'string' && id.startsWith('share:'),
    confirmAgentLocationForPick, intentChangesAgentLocation: () => false,
    confirmMobileSessionAgentSwitch: vi.fn(async () => true),
    shouldBlockLegacyRemoteModelWindowSwitch, showRemoteModelWindowUnsupported: vi.fn(),
    writeSessionAgentSwitchIntent: write, setComposerModel: setModel, runControlAction,
    setModelSheetOpen: vi.fn(), setModelSheetAgentKind: vi.fn(),
  };
  const names = ['selectComposerModelRow', 'selectUnifiedComposerModel', 'selectComposerFlatModel',
    'changeComposerSelectedEffort', 'changeComposerSelectedFastMode'];
  const compiled = ts.transpileModule(`const orcaModelSelectionUsesIntent = ${intentGate};
    const orcaRemoteAgentDeviceId = ${remoteCatalogGate};
    const loadComposerAgentCapabilities = ${callbacks.get('loadComposerAgentCapabilities')};
    const canStageOrcaModelSelection = ${callbacks.get('canStageOrcaModelSelection')};
    return {${names.map(name => `${name}: ${callbacks.get(name)}`).join(',')}, loadComposerAgentCapabilities,
      catalogs: (${callbacks.get('modelSheetRemoteCatalogs')})()};`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const handlers = new Function(...Object.keys(bindings), compiled)(...Object.values(bindings));
  return { handlers, write, setModel, runControlAction, bindings, selection, remoteCapabilities };
}

const picks = [
  ['selectComposerModelRow', { model: { id: 'new-model', contextWindow: 200000 } }, 'provider'],
  ['selectUnifiedComposerModel', { agent: 'codex', modelId: 'new-model', providerId: 'provider', effort: 'high', fast: true }, 'provider'],
  ['selectComposerFlatModel', { id: 'new-model', contextWindow: 200000 }, null],
] as const;

describe('Orca model-only selection', () => {
  it.each(['claude-code', 'codex', 'pi'])('loads and selects %s using the current execution computer capabilities', async agent => {
    const h = setup('worker', true, 'current', { used: 1000, current: 1000000 });
    h.bindings.maker.getCapabilities.mockRejectedValue(new Error('target harness is not registered on host'));
    h.remoteCapabilities.mockResolvedValue({ hasFastMode: true, supportsModelWindowSwitchGuard: true });
    await expect(h.handlers.loadComposerAgentCapabilities(agent)).resolves.toMatchObject({ hasFastMode: true });
    await expect(h.handlers.selectUnifiedComposerModel({ agent, modelId: 'new-model', providerId: 'provider',
      effort: 'high', fast: true }, { deviceId: 'current' })).resolves.toBe(true);
    expect(h.remoteCapabilities).toHaveBeenCalledWith(agent);
    expect(h.bindings.executionMakerForDevice).toHaveBeenCalledWith('current');
    expect(h.bindings.maker.getCapabilities).not.toHaveBeenCalled();
    expect(h.write).toHaveBeenCalledWith(expect.objectContaining({ targetAgentKind: agent }));
    expect(h.write.mock.calls[0][0]).not.toHaveProperty('agentDeviceId');
  });

  it('reads capabilities for a share catalog through the controlled computer', async () => {
    const h = setup('worker', true, 'share:share-1');
    h.bindings.maker.getCapabilities.mockResolvedValue({ hasFastMode: true, supportsModelWindowSwitchGuard: true });
    await expect(h.handlers.loadComposerAgentCapabilities('codex')).resolves.toMatchObject({ hasFastMode: true });
    expect(h.bindings.executionMakerForDevice).not.toHaveBeenCalled();
    expect(h.bindings.maker.getCapabilities).toHaveBeenCalledWith('codex');
  });

  it('uses the selected computer Fast support instead of borrowing it from the task host', async () => {
    const h = setup('worker', true, 'current');
    h.remoteCapabilities.mockResolvedValue({ hasFastMode: false, supportsModelWindowSwitchGuard: true });
    await expect(h.handlers.selectUnifiedComposerModel({ agent: 'codex', modelId: 'new-model', providerId: 'provider',
      effort: 'high', fast: true }, { deviceId: 'current' })).resolves.toBe(false);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.bindings.maker.getCapabilities).not.toHaveBeenCalled();
  });
  it.each(['claude-code', 'codex', 'pi'])('guards all pickers before staging a pressured %s shrink', async agent => {
    for (const role of ['lead', 'worker'] as const) {
      for (const hostGuard of [true, false]) {
        for (const used of [180000, 240000]) {
          for (const [name, input] of picks) {
            const h = setup(role, true, null, { agent, used, current: 1000000, hostGuard });
            await h.handlers[name]({ ...input, ...(name === 'selectUnifiedComposerModel' ? { agent } : {}) });
            await vi.waitFor(() => expect(h.bindings.showRemoteModelWindowUnsupported).toHaveBeenCalledWith(200000));
            expect(h.write).not.toHaveBeenCalled();
            expect(h.setModel).not.toHaveBeenCalled();
            expect(h.runControlAction).not.toHaveBeenCalled();
            expect(h.bindings.currentSession.model).toBe('old-model');
          }
        }
      }
    }
  });

  it.each([
    { used: 179999, current: 1000000 },
    { used: 240000, current: 200000 },
    { used: 240000, current: 100000 },
    { used: undefined, current: undefined },
  ])('keeps supported-host low-pressure, same/expanded and unknown windows selectable: %j', async state => {
    for (const [name, input] of picks) {
      const h = setup('worker', true, null, state);
      await h.handlers[name](input);
      await vi.waitFor(() => expect(h.write).toHaveBeenCalledTimes(1));
      expect(h.bindings.showRemoteModelWindowUnsupported).not.toHaveBeenCalled();
    }
  });

  it('keeps legacy unknown-window and Pi checks before intent registration', async () => {
    for (const agent of ['claude-code', 'codex', 'pi']) {
      const h = setup('lead', true, null, { agent, hostGuard: false });
      expect(await h.handlers.selectUnifiedComposerModel({ ...picks[1][1], agent })).toBe(false);
      expect(h.write).not.toHaveBeenCalled();
      expect(h.bindings.showRemoteModelWindowUnsupported).toHaveBeenCalledOnce();
    }
  });

  it('uses the chosen remote catalog window instead of the host catalog', async () => {
    const h = setup('worker', true, 'current', { used: 240000, current: 1000000, target: 200000 });
    expect(await h.handlers.selectUnifiedComposerModel(picks[1][1], { deviceId: 'current' })).toBe(false);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.bindings.showRemoteModelWindowUnsupported).toHaveBeenCalledWith(200000);
  });

  it('does not apply the same-Agent window guard to cross-Agent picks or pending effort/Fast edits', async () => {
    const h = setup('worker', true, null, { used: 240000, current: 1000000 });
    expect(await h.handlers.selectUnifiedComposerModel({ ...picks[1][1], agent: 'pi' })).toBe(true);
    h.handlers.changeComposerSelectedEffort('medium');
    h.handlers.changeComposerSelectedFastMode(false);
    expect(h.write).toHaveBeenCalledTimes(3);
    expect(h.bindings.showRemoteModelWindowUnsupported).not.toHaveBeenCalled();
  });

  it.each(['lead', 'worker'] as const)('keeps only the current remote catalog and selects in place for %s', async role => {
    const h = setup(role, true, 'current');
    expect(h.handlers.catalogs.map((item: { deviceId: string }) => item.deviceId)).toEqual(['current']);
    expect(await h.handlers.selectUnifiedComposerModel(picks[1][1], { deviceId: 'current' })).toBe(true);
    expect(h.write).toHaveBeenCalledWith({ targetAgentKind: 'codex', model: 'new-model',
      providerId: 'provider', effort: 'high', fastMode: true });
    for (const deviceId of [null, 'other']) {
      expect(await h.handlers.selectUnifiedComposerModel(picks[1][1], { deviceId })).toBe(false);
    }
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.setModel).not.toHaveBeenCalled();
    expect(h.bindings.currentSession.agentDeviceId).toBe('current');
  });

  it.each(['lead', 'worker'] as const)('stages all three model pickers for %s without patching the current runtime', async role => {
    for (const [name, input, providerId] of picks) {
      const h = setup(role);
      await h.handlers[name](input);
      await vi.waitFor(() => expect(h.write).toHaveBeenCalledTimes(1));
      expect(h.write).toHaveBeenCalledWith({ targetAgentKind: 'codex', model: 'new-model',
        providerId, effort: 'high', fastMode: true });
      expect(h.setModel).not.toHaveBeenCalled();
      expect(h.runControlAction).not.toHaveBeenCalled();
      expect(h.bindings.currentSession.model).toBe('old-model');
    }
  });

  it.each([['lead', false], [null, true]] as const)('preserves legacy model routing for role=%s supported=%s', async (role, supported) => {
    for (const [name, input] of picks) {
      const h = setup(role, supported);
      await h.handlers[name](input);
      await vi.waitFor(() => expect(h.setModel).toHaveBeenCalledTimes(1));
      expect(h.write).not.toHaveBeenCalled();
    }
  });

  it('does not fall back to setModel when the switch intent is rejected', async () => {
    const h = setup('worker');
    h.write.mockResolvedValue(false);
    expect(await h.handlers.selectUnifiedComposerModel(picks[1][1])).toBe(false);
    expect(h.setModel).not.toHaveBeenCalled();
    expect(h.runControlAction).not.toHaveBeenCalled();
  });

  it.each(['lead', 'worker'] as const)('updates effort and Fast on the pending model for %s', role => {
    const h = setup(role);
    h.handlers.changeComposerSelectedEffort('medium');
    h.handlers.changeComposerSelectedFastMode(false);
    expect(h.write).toHaveBeenNthCalledWith(1, { ...h.bindings.agentSwitchIntent, effort: 'medium' });
    expect(h.write).toHaveBeenNthCalledWith(2, { ...h.bindings.agentSwitchIntent, fastMode: false });
    expect(h.bindings.maker.setEffort).not.toHaveBeenCalled();
    expect(h.bindings.maker.setFastMode).not.toHaveBeenCalled();
  });
});
