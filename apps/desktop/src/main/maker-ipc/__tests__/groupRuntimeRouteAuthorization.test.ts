import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ScriptTarget, transpileModule } from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { createBotSessionTaskRouteBridge } from '../botSessionTaskRouteBridge.js';
import { createSessionControlService } from '../sessionControlService.js';
import { GroupToolAuthorizationError, authorizeGroupTool, registerGroupToolAuthority } from '../botGroupToolAuthorization.js';
import { setSessionRuntimeHarness } from '../sessionRuntimeHarnessSelection.js';
import { createPendingAgentSwitchRegistry, performSessionAgentSwitch } from '../sessionAgentSwitchHandler.js';
import { applyRuntimeSetModelChange } from '../runtimeSetModel.js';
import { mergeSessionRuntimeProfilePatch } from '../sessionRuntimeControl.js';
import { clearSessionProvider, getSessionProvider, setSessionProvider } from '../../maker-host/session-provider-store.js';

const source = readFileSync(resolve(__dirname, '../register.ts'), 'utf8');
const start = source.indexOf('    setSessionRuntime: async ({ targetSessionId, expectedGeneration, patch, beforeMutation }) =>');
const end = source.indexOf('    assertExternalInputAllowed:', start);
const mutationStart = source.indexOf('? await applyRuntimeSetModelChange({');
const mutationEnd = source.indexOf('})', source.indexOf('              logger: log,', mutationStart)) + 2;
const mutation = transpileModule(`return (async () => ${source.slice(mutationStart + 2, mutationEnd)})();`, {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;
const adapter = transpileModule(`return ({${source.slice(start, end)}}).setSessionRuntime;`, {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;

afterEach(() => clearSessionProvider('route-child'));

it.each(['catalog', 'harness-read', 'native-preview', 'valid-harness', 'valid-model'] as const)(
  'carries the group authority through the actual host runtime adapter: %s', async point => {
    let revoked = false;
    const release = registerGroupToolAuthority('route-group', { botId: 'bot-route', mode: 'owner',
      isCurrent: () => true,
      validate: async () => { if (revoked) throw new GroupToolAuthorizationError(); } });
    const current = { agentKind: 'pi' as const, model: 'old', providerId: 'provider', effort: null, fastMode: false };
    const next = { ...current, agentKind: point === 'native-preview' || point === 'valid-model' ? 'pi' as const : 'codex' as const, model: 'next' };
    const pending = createPendingAgentSwitchRegistry();
    const nativeSet = vi.fn(async () => {});
    const close = vi.fn();
    const supersede = vi.fn();
    const profile = { control: { generation: 1, pending: null }, effective: current };
    const runtime = { ok: true, runtime: { runtimeGeneration: 1, effectiveProfile: current } };
    const maker = {
      getSession: () => ({ agentKind: 'pi' as const, model: 'old', setModel: nativeSet,
        previewModelSwitch: async () => {
          if (point === 'native-preview') revoked = true;
          return { action: 'hot' as const, targetContextWindow: 100000, windowVerified: true };
        } }),
      listActiveSessions: () => [], closeSession: close,
    };
    setSessionProvider('route-child', 'provider');
    const deps = {
      setSessionRuntimeHarness, performSessionAgentSwitch,
      withSendToSessionLock: async (_id: string, fn: () => Promise<unknown>) => fn(),
      captureSessionRuntimeControlOwnerEpoch: () => 'owner',
      getSessionRuntimeControlSnapshot: () => ({ generation: 1, effectiveOverride: current, pending: null }),
      agentSwitchPending: pending,
      readSessionRuntimeProfiles: async () => profile,
      assertModelRouteUsable: async () => null,
      getActiveCatalog: () => ({}),
      getDesktopProviderService: () => ({ listProviders: async () => {
        if (point === 'catalog') revoked = true;
        return [{ id: 'provider', connected: true }];
      } }),
      findCatalogModel: () => ({}),
      resolveSessionRuntimeAxes: () => ({ ok: true, effort: null, fastMode: false }),
      mergeSessionRuntimeProfilePatch,
      runtimeSelectionRequiresModelWindowConfirmation: () => false,
      agentSwitchDeps: {
        getSessionRow: async () => {
          if (point === 'harness-read') revoked = true;
          return { id: 'route-child', agentKind: 'pi', status: 'active' };
        },
        pendingSwitches: pending, supersedePendingCredentialSwitch: supersede,
        log: { info: vi.fn() },
      },
      applySessionRuntimeSelection: async (_id: string, model: string, providerId: string, _selection: unknown, options: { beforeMutation?: () => Promise<void> }) => {
        // Execute the host's real native-mutation adapter as well, so dropping the
        // callback at either host boundary makes the revocation case fail.
        const mutationDeps = {
          applyRuntimeSetModelChange, maker, internalOptions: options, sessionId: 'route-child', model,
          effectiveProviderId: providerId, assertRuntimeOwnerCurrent: vi.fn(), assertSharedTaskCurrent: { admit: vi.fn() },
          piConfigurationRefresh: false, canTransferThread: false, atomicSelection: { effort: null, fastMode: false },
          rebuildLiveOrcaWorker: false, runtimeAgentKind: 'pi', runtimeRouteChanged: true,
          isSessionInTurn: () => false, registerPendingCredentialSwitchForSession: vi.fn(),
          clearPendingCredentialSwitchForSession: vi.fn(), getPendingCredentialSwitchTarget: () => null,
          getCodexProxyAuthInjectionState: () => null, log: { debug: vi.fn(), info: vi.fn() },
        };
        const result = await new Function(...Object.keys(mutationDeps), mutation)(...Object.values(mutationDeps));
        return { deferred: result.status === 'deferred', generation: 1 };
      },
    };
    const host = new Function(...Object.keys(deps), adapter)(...Object.values(deps));
    const control = createSessionControlService({ sessionExists: async () => true, getLiveSession: () => null, setSessionRuntime: host } as never);
    const bridge = createBotSessionTaskRouteBridge({ getSessionRuntime: async () => runtime as never,
      setSessionRuntime: params => control.setSessionRuntime(params), readConfiguredCandidate: vi.fn() });
    try {
      const authority = await authorizeGroupTool('route-group', 'bot-route', 'owner-action');
      const action = bridge.advance('route-child', 1, next, authority.refresh);
      if (point.startsWith('valid')) {
        expect(await action).toMatchObject({ ok: true, status: point === 'valid-harness' ? 'deferred' : 'applied' });
        if (point === 'valid-harness') expect(pending.get('route-child')).toMatchObject({ model: 'next' });
        else expect(nativeSet).toHaveBeenCalledOnce();
      } else {
        await expect(action).rejects.toMatchObject({ code: 'GROUP_AUTHORIZATION_REQUIRED' });
        expect(pending.get('route-child')).toBeUndefined();
        expect(nativeSet).not.toHaveBeenCalled();
        expect(supersede).not.toHaveBeenCalled();
      }
      expect(close).not.toHaveBeenCalled();
      expect(getSessionProvider('route-child')).toBe('provider');
    } finally { release(); }
  },
);

it.each([true, false])('refreshes after the final deferred-route read (revoked=%s)', async revoked => {
  // Execute the production deferred commit closure, with its asynchronous metadata boundary.
  const begin = source.indexOf('      const deferLockedSelection = async () => {');
  const finish = source.indexOf('      // 远端回合中不能 live', begin);
  const js = transpileModule(`${source.slice(begin, finish)}\nreturn deferLockedSelection;`, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  let prepared = false;
  const accept = vi.fn(() => 2);
  const deps = {
    sessionId: 'route-child', model: 'next', effectiveProviderId: 'provider', routeExplicit: true, atomicSelection: undefined,
    internalOptions: { source: 'agent', beforeMutation: async () => {
      if (prepared && revoked) throw new GroupToolAuthorizationError();
    } },
    maker: { getSessionMeta: async () => { prepared = true; return { agentKind: 'pi' }; }, getSession: () => null },
    supersededByOwnerBoundary: () => false, assertSharedTaskCurrent: { admit: vi.fn() },
    acceptSessionRuntimeMutation: accept, buildDeferredRuntimeSelectionProfile: (p: unknown) => p,
    getSessionFastMode: () => false, getPendingCredentialSwitchTarget: () => null,
    broadcastSessionRuntimeProjection: vi.fn(async () => {}), normalizeSessionProviderId: (id: string) => id,
  };
  const run = new Function(...Object.keys(deps), js)(...Object.values(deps));
  if (revoked) {
    await expect(run()).rejects.toMatchObject({ code: 'GROUP_AUTHORIZATION_REQUIRED' });
    expect(accept).not.toHaveBeenCalled();
    expect(deps.broadcastSessionRuntimeProjection).not.toHaveBeenCalled();
  } else {
    expect(await run()).toMatchObject({ deferred: true, generation: 2 });
    expect(accept).toHaveBeenCalledOnce();
  }
});
