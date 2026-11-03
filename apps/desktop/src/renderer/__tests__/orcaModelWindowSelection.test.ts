import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { assessModelSwitchContext, MODEL_WINDOW_SWITCH_FORCE_REBUILD_PCT,
  shouldBlockLegacyRemotePiModelWindowSwitch } from '../../shared/modelSwitchAssessment';

// Exercise the production preflight and staging callback together, without mounting
// the editor or starting native agents. Side effects remain observable at the IPC boundary.
const source = ts.createSourceFile('ChatInput.tsx', readFileSync(resolve(__dirname,
  '../components/new-chat/ChatInput.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = new Map<string, string>();
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) &&
      ['confirmModelSwitchContextGuard', 'performAgentSwitch'].includes(node.name.getText(source))) {
    callbacks.set(node.name.getText(source), node.initializer.arguments[0].getText(source));
  }
  ts.forEachChild(node, visit);
}
visit(source);

function setup(options: { agent?: string; role?: string; used?: number; current?: number;
  target?: number; remote?: boolean; hostGuard?: boolean; displayedAgent?: string;
  agentLocationAware?: boolean } = {}) {
  const agent = options.agent ?? 'codex';
  const switchSessionAgent = vi.fn(async () => ({ deferred: true, switched: false }));
  const release = vi.fn();
  const finish = vi.fn();
  const confirmDialog = vi.fn(async () => false);
  const context = { contextTokens: options.used ?? 240000, contextWindow: options.current ?? 1000000, isRunning: false };
  const bindings = {
    sessionId: 's1', sessionOrcaRole: options.role ?? 'worker', settingsLocked: false,
    runtimeAgentKind: agent, currentModelAgentKind: options.displayedAgent ?? agent,
    activeModel: 'old-model', effectiveSourceId: 'old-provider', activeEffort: 'high',
    deviceLinkDeviceId: options.remote ? 'remote' : undefined, remoteHostId: null,
    currentSessionIdRef: { current: 's1' },
    agentLocationAware: options.agentLocationAware ?? false, agentDeviceId: null, effectiveAgentDeviceId: null,
    providers: [], remoteProviders: { providers: [] }, modelMemory: null,
    ccCaps: { capabilities: {} }, codexCaps: { capabilities: {} },
    piCaps: { capabilities: { supportsModelWindowSwitchGuard: options.hostGuard !== false } },
    makerChatStore: { getSnapshot: () => ({ agentStatus: context }), getAgentSwitchIntent: () => null,
      getAgentSwitchIntentRev: () => 0, noteAgentSwitchIntent: vi.fn() },
    getSessionDeviceId: () => options.remote ? 'remote' : undefined,
    hasPendingAgentSendDispatch: () => false, nextAgentSwitchWriteSeq: () => 1, getAgentSwitchWriteSeq: () => 1,
    beginAgentSwitchOperation: () => finish, reserveAgentSwitchExclusive: () => ({ ready: Promise.resolve(), release }),
    isSessionScopeCurrent: (a: string, b: string) => a === b,
    effectiveSourceIdForModel: (_providers: unknown, id: string) => id,
    resolveProviderModelContextWindow: vi.fn(() => options.target ?? 200000),
    assessModelSwitchContext, MODEL_WINDOW_SWITCH_FORCE_REBUILD_PCT, shouldBlockLegacyRemotePiModelWindowSwitch,
    confirmDialog, t: (key: string) => key, toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() },
    resolveModelEfforts: () => ({ efforts: ['high'], defaultEffort: 'high' }),
    resolveRequestedEffort: () => 'high', getRememberedEffort: () => undefined, resolveFastSupported: () => false,
    makerApiFor: () => ({ switchSessionAgent }), makerApiForDevice: () => ({ switchSessionAgent }),
    resolveAgentSwitchAckAction: () => 'apply-intent', isAgentSwitchEchoConfigConsistent: () => true,
    syncSessionDraftModelPrefs: vi.fn(), rememberCatalogModelPrefs: vi.fn(), taskComputerModelMemory: null, mapIpcErrorToI18nKey: (error: unknown) => { throw error; },
  };
  const compiled = ts.transpileModule(`const confirmModelSwitchContextGuard = ${callbacks.get('confirmModelSwitchContextGuard')};
    return ${callbacks.get('performAgentSwitch')};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const pick = new Function(...Object.keys(bindings), compiled)(...Object.values(bindings));
  return { pick, switchSessionAgent, bindings, confirmDialog, release, finish };
}

describe('Orca same-Agent window preflight', () => {
  it.each(['claude-code', 'pi'])('%s overflow must be confirmed before staging for either role', async agent => {
    for (const role of ['lead', 'worker']) {
      const h = setup({ agent, role });
      expect(await h.pick(agent, 'small', 'provider')).toBe(false);
      expect(h.confirmDialog).toHaveBeenCalledOnce();
      expect(h.switchSessionAgent).not.toHaveBeenCalled();
      expect(h.bindings.makerChatStore.noteAgentSwitchIntent).not.toHaveBeenCalled();
      expect(h.bindings.syncSessionDraftModelPrefs).not.toHaveBeenCalled();
      expect(h.release).toHaveBeenCalledOnce();
      expect(h.finish).toHaveBeenCalledOnce();

      h.confirmDialog.mockResolvedValue(true);
      expect(await h.pick(agent, 'small', 'provider')).toBe(true);
      expect(h.switchSessionAgent).toHaveBeenCalledWith('s1', agent, 'small', 'provider', 'high', false,
        { confirmedContextWindow: 200000 }, undefined);
    }
  });

  it.each([100000, 150000, 180000])('allows existing local warning semantics at %i tokens', async used => {
    const h = setup({ used, agent: 'claude-code' });
    expect(await h.pick('claude-code', 'small', 'provider')).toBe(true);
    expect(h.confirmDialog).not.toHaveBeenCalled();
    expect(h.bindings.toast.warning).toHaveBeenCalledTimes(used >= 140000 ? 1 : 0);
  });

  it('does not prompt for same/expanded windows or effort-only changes', async () => {
    for (const target of [1000000, 2000000]) {
      const h = setup({ target, used: 1200000 });
      expect(await h.pick('codex', 'large', 'provider')).toBe(true);
      expect(h.confirmDialog).not.toHaveBeenCalled();
    }
    const h = setup();
    expect(await h.pick('codex', 'old-model', 'old-provider', { effort: 'high', fastMode: false })).toBe(true);
    expect(h.confirmDialog).not.toHaveBeenCalled();
    expect(h.bindings.resolveProviderModelContextWindow).not.toHaveBeenCalled();
  });

  it('checks a same-id model on a different provider, using the runtime Agent even with a cross-Agent preview', async () => {
    const h = setup({ agent: 'claude-code', displayedAgent: 'pi' });
    expect(await h.pick('claude-code', 'old-model', 'small-provider')).toBe(false);
    expect(h.bindings.resolveProviderModelContextWindow).toHaveBeenCalledWith({
      providers: [], providerId: 'small-provider', modelId: 'old-model', agentKind: 'claude-code',
    });
    expect(h.switchSessionAgent).not.toHaveBeenCalled();
  });

  it.each(['claude-code', 'pi'])('blocks a pressured device-link %s selection before staging', async agent => {
    for (const used of [180000, 240000]) {
      const h = setup({ remote: true, agent, used });
      expect(await h.pick(agent, 'small', 'provider')).toBe(false);
      expect(h.confirmDialog).not.toHaveBeenCalled();
      expect(h.switchSessionAgent).not.toHaveBeenCalled();
      expect(h.bindings.toast.error).toHaveBeenCalledOnce();
    }
  });

  it.each([false, true])('lets Codex stage a pressured switch without a handoff confirmation (remote=%s)', async remote => {
    for (const role of ['lead', 'worker']) {
      const h = setup({ remote, role });
      expect(await h.pick('codex', 'small', 'provider')).toBe(true);
      expect(h.confirmDialog).not.toHaveBeenCalled();
      expect(h.bindings.toast.error).not.toHaveBeenCalled();
      expect(h.switchSessionAgent).toHaveBeenCalledWith('s1', 'codex', 'small', 'provider', 'high', false, undefined, undefined);
    }
  });

  it('retains legacy Pi protection and does not guard a true cross-Agent handoff', async () => {
    const h = setup({ remote: true, agent: 'pi', hostGuard: false, used: 10000 });
    expect(await h.pick('pi', 'small', 'provider')).toBe(false);
    expect(h.switchSessionAgent).not.toHaveBeenCalled();
    expect(await h.pick('codex', 'small', 'provider')).toBe(true);
    expect(h.confirmDialog).not.toHaveBeenCalled();
  });

  it('skips the window preflight when the pick moves the Agent to another computer', async () => {
    for (const role of ['lead', 'worker']) {
      const h = setup({ role, agentLocationAware: true });
      expect(await h.pick('codex', 'small', 'provider', { agentDeviceId: 'share:alice-share' })).toBe(true);
      expect(h.confirmDialog).not.toHaveBeenCalled();
      expect(h.bindings.resolveProviderModelContextWindow).not.toHaveBeenCalled();
      expect(h.switchSessionAgent).toHaveBeenCalledWith('s1', 'codex', 'small', 'provider', 'high', false,
        { agentDeviceId: 'share:alice-share' }, undefined);
    }
  });

  it('does not register a choice if the user leaves the session during confirmation', async () => {
    const h = setup({ agent: 'claude-code' });
    h.confirmDialog.mockImplementation(async () => { h.bindings.currentSessionIdRef.current = 's2'; return true; });
    expect(await h.pick('claude-code', 'small', 'provider')).toBe(false);
    expect(h.switchSessionAgent).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('does not turn an unknown target window into acknowledgement', async () => {
    const h = setup({ target: Number.NaN });
    expect(await h.pick('codex', 'unknown', 'provider')).toBe(true);
    expect(h.switchSessionAgent).toHaveBeenCalledWith('s1', 'codex', 'unknown', 'provider', 'high', false, undefined, undefined);
  });

  it('rechecks a pending route when selected again, while axis-only edits skip the dialog', async () => {
    const h = setup({ agent: 'claude-code' });
    h.bindings.makerChatStore.getAgentSwitchIntent = () => ({ target: 'claude-code', model: 'old-model', providerId: 'old-provider' }) as never;
    // The callback holds the same store object; a send rejected for a changed
    // window must be recoverable by selecting the pending model again.
    expect(await h.pick('claude-code', 'old-model', 'old-provider')).toBe(false);
    h.confirmDialog.mockResolvedValue(true);
    expect(await h.pick('claude-code', 'old-model', 'old-provider')).toBe(true);
    expect(h.switchSessionAgent).toHaveBeenLastCalledWith('s1', 'claude-code', 'old-model', 'old-provider', 'high', false,
      { confirmedContextWindow: 200000 }, undefined);
    h.confirmDialog.mockClear();
    expect(await h.pick('claude-code', 'old-model', 'old-provider', { effort: 'high', axesOnly: true })).toBe(true);
    expect(h.confirmDialog).not.toHaveBeenCalled();
  });
});
