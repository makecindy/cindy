import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { assertPluginTaskResult, PluginTaskError } from '../pluginTaskService.js';
import { createOrcaLifecycleService, type OrcaLifecycleDeps } from '../orcaLifecycleService.js';
import { startOrcaTeamWithPermissionGate } from '../orcaStartTeamPermissionGate.js';
import { hasAcceptedUserTaskInput } from '../pluginTaskInput.js';

vi.mock('../../maker-host/codex-credential-switch.js', () => ({ isCredentialModeSwitchBusyError: () => false }));

const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');
const branch = source.slice(source.indexOf("      case 'startTeam': {"), source.indexOf("      case 'setTeamPlan':"));
const authorization = source.slice(source.indexOf('  const assertPluginWorkerAutoAuthorized ='), source.indexOf('  // Uninstall keeps the historical receipt'));
const js = ts.transpileModule(`${authorization}\nreturn async function(pluginId, request) { switch(request.kind) { ${branch} } }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture(initial = 'active', afterConfirmation = initial) {
  const epoch = {};
  const task = { taskId: 'task', status: initial, revision: 1, permissionMode: 'auto' };
  const service = { get: vi.fn(async () => ({ ...task })) };
  const create = vi.fn(async () => ({ ok: true, teamId: 'team' }));
  const start = vi.fn(async (_id: string, _mode: unknown, check: () => Promise<void>) => {
    task.status = afterConfirmation;
    await check();
    return create();
  });
  const deps = { service, getCurrentDbClientSnapshot: () => epoch, PluginTaskError, assertPluginTaskResult, startOrcaTeamForCaller: start,
    isPluginTaskAuthorized: () => true, readGhostErrandConfig: () => ({ permissionMode: 'auto' }) };
  const run = new Function(...Object.keys(deps), js)(...Object.values(deps));
  return { run: () => run('plugin', { kind: 'startTeam', taskId: 'task' }), start, create };
}

describe('plugin team active-task admission', () => {
  it('rejects an already archived task before the start flow', async () => {
    const f = fixture('archived');
    await expect(f.run()).rejects.toMatchObject({ code: 'TASK_BUSY' });
    expect(f.start).not.toHaveBeenCalled();
  });
  it('rejects archive during confirmation even without a revision change', async () => {
    const f = fixture('active', 'archived');
    await expect(f.run()).rejects.toMatchObject({ code: 'TASK_BUSY' });
    expect(f.create).not.toHaveBeenCalled();
  });
  it('starts a still-active task', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toEqual({ ok: true, teamId: 'team' });
    expect(f.create).toHaveBeenCalledOnce();
  });
});

describe('public start_team Full access admission', () => {
  const helper = source.slice(source.indexOf('  const startOrcaTeamForCaller ='), source.indexOf('  const pluginPermissionRequests ='));
  const authority = source.slice(source.indexOf('  const assertPluginWorkerAutoAuthorized ='), source.indexOf('  const orcaWorkerCreationService ='));
  const wired = ts.transpileModule(`${authority}\n${helper}\nreturn { start: startOrcaTeamForCaller, capture: captureOrcaPluginAuthority };`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const states = ['plugin', 'ask', 'plan', 'disabled', 'revoked-running', 'ordinary', 'revoked-idle', 'revoked-human'] as const;
  const cases = (['auto', 'bypassPermissions'] as const).flatMap(preference => [
    ...states.map(state => ({ state, preference, requested: 'bypassPermissions' as 'auto' | 'bypassPermissions' | undefined })),
    ...(['auto', undefined] as const).map(requested => ({ state: 'plugin' as const, preference, requested })),
  ]);

  it.each(cases)(
    '$state requests $requested with global preference $preference', async ({ state, preference, requested }) => {
      const epoch = { client: {} };
      const revoked = state.startsWith('revoked-');
      const input = state === 'revoked-running' ? { clientId: 'plugin-task:run' }
        : state === 'revoked-human' ? { clientId: 'human', authoredText: 'Start a team' } : null;
      const ordinary = ['ordinary', 'revoked-idle', 'revoked-human'].includes(state);
      const task = { status: 'active', permissionMode: state === 'ask' ? 'default' : 'auto', planModeEnabled: state === 'plan' };
      const request = vi.fn(async () => ({ confirmed: true }));
      const create = vi.fn(async () => ({ id: 'team', leadSessionId: 'lead' }));
      const setPreference = vi.fn();
      let capture: OrcaLifecycleDeps['getWorkerPermissionModeOverride'];
      const lifecycle = createOrcaLifecycleService({
        getWorkerPermissionMode: () => preference,
        getWorkerPermissionModeOverride: (id: string) => capture!(id),
        setWorkerPermissionMode: setPreference,
        getActiveTeamByLead: async () => null, createActiveTeam: create,
        setSessionOrcaRole: vi.fn(), clearKnownNonOrcaSession: vi.fn(), setLeadVendorOptions: vi.fn(),
        markTeamEnded: vi.fn(), clearLeadVendorOptions: vi.fn(),
      } as unknown as OrcaLifecycleDeps);
      const bindings = {
        PluginTaskError, hasAcceptedUserTaskInput, startOrcaTeamWithPermissionGate,
        getCurrentDbClientSnapshot: () => epoch,
        maker: { getSession: () => null }, inputCoordinator: { getAcceptedInputProvenance: () => input },
        createPluginTaskStore: () => ({ get: async () => state === 'ordinary' ? null
          : { operation: 'create', pluginId: 'plugin', payload: JSON.stringify({ ownershipRevoked: revoked }) } }),
        pluginTaskServiceForCurrentOwner: () => ({ get: async () => task }),
        isPluginTaskAuthorized: () => state !== 'disabled', readGhostErrandConfig: () => ({ permissionMode: 'auto' }),
        assertLeadCollabProjectEnabled: async () => {}, getWorkerPermissionModeFromCreationPrefs: () => preference,
        orcaWorkerPermissionConfirmBridge: { request }, t: (key: string) => key, orcaLifecycleService: lifecycle,
      };
      const run = new Function(...Object.keys(bindings), wired)(...Object.values(bindings));
      capture = run.capture;
      const result = await run.start('lead', requested);
      if (ordinary) {
        expect(result).toMatchObject({ ok: true, workerPermissionMode: 'bypassPermissions' });
        expect(request).toHaveBeenCalledTimes(preference === 'auto' ? 1 : 0);
        expect(setPreference).toHaveBeenCalledWith('bypassPermissions');
        expect(create).toHaveBeenCalledOnce();
      } else if (requested === 'bypassPermissions') {
        expect(result).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
        expect(request).not.toHaveBeenCalled();
        expect(setPreference).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({ ok: true, workerPermissionMode: 'auto' });
        expect(request).not.toHaveBeenCalled();
        expect(setPreference).not.toHaveBeenCalled();
        expect(create).toHaveBeenCalledOnce();
      }
    },
  );
});

describe('plugin team activation uses the native lifecycle compensation', () => {
  const helper = source.slice(source.indexOf('  const startOrcaTeamForCaller ='), source.indexOf('  const pluginPermissionRequests ='));
  const wired = ts.transpileModule(`${helper}\n${js}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const changes = ['archived', 'deleted', 'permission', 'planMode', 'route', 'directory', 'configuredPermission', 'configuredDirectory', 'disabled', 'revoked', 'account', 'storage', 'healthy'] as const;
  const stages = ['lookup', 'create', 'role', 'vendor'] as const;

  it.each(stages.flatMap(stage => changes.map(change => ({ stage, change }))))('new team: $change during $stage', async ({ stage, change }) => {
    await exercise(false, stage, change);
  });
  it.each((['lookup', 'role', 'vendor'] as const).flatMap(stage => changes.map(change => ({ stage, change }))))('existing team: $change during $stage', async ({ stage, change }) => {
    await exercise(true, stage, change);
  });

  async function exercise(existing: boolean, stage: typeof stages[number], change: typeof changes[number]) {
    let epoch = {}, unavailable = false, authorized = true, teamActive = existing;
    const cfg = { permissionMode: 'auto', workingDir: '/answer' };
    let role: 'lead' | null = existing ? 'lead' : null;
    let vendorActive = existing;
    const originalEpoch = epoch;
    const task = { taskId: 'task', status: 'active', revision: 1, permissionMode: 'auto', planModeEnabled: false,
      workingDir: '/answer', resolvedConfig: { agentKind: 'codex', model: 'model', providerId: 'mine', effort: 'high', fastMode: false } };
    const changeAt = (point: typeof stages[number]) => {
      if (point !== stage || change === 'healthy') return;
      if (change === 'archived' || change === 'deleted') task.status = change;
      if (change === 'permission') task.permissionMode = 'plan';
      if (change === 'planMode') task.planModeEnabled = true;
      if (change === 'route') task.resolvedConfig.model = 'changed';
      if (change === 'directory') task.workingDir = '/other';
      if (change === 'configuredPermission') cfg.permissionMode = 'plan';
      if (change === 'configuredDirectory') cfg.workingDir = '/other';
      if (change === 'disabled') authorized = false;
      if (change === 'revoked' || change === 'storage') unavailable = true;
      if (change === 'account') epoch = {};
      // Status/permission checks must not rely on a test-provided revision change.
    };
    const service = { get: vi.fn(async () => {
      if (unavailable || task.status === 'deleted') throw new PluginTaskError('TASK_NOT_FOUND', 'Unavailable');
      return structuredClone(task);
    }), completeOperation: async <T>(fn: () => Promise<T>) => fn() };
    const deps: OrcaLifecycleDeps = {
      getActiveTeamByLead: vi.fn(async () => { changeAt('lookup'); return existing ? { id: 'team', leadSessionId: 'task' } : null; }),
      createActiveTeam: vi.fn(async () => { teamActive = true; changeAt('create'); return { id: 'team', leadSessionId: 'task' }; }),
      isOrphanedTeamInit: vi.fn(async () => false), getWorkerPermissionMode: () => 'auto', setWorkerPermissionMode: vi.fn(),
      createWorkerInTeam: vi.fn(), dispatchWorkerTask: vi.fn(),
      markTeamEnded: vi.fn(async () => { teamActive = false; }),
      setSessionOrcaRole: vi.fn(async (_id, next) => { role = next; task.revision++; if (next === 'lead') changeAt('role'); }),
      clearKnownNonOrcaSession: vi.fn(),
      setLeadVendorOptions: vi.fn(async () => { vendorActive = true; changeAt('vendor'); }),
      clearLeadVendorOptions: vi.fn(async () => { vendorActive = false; }),
      sendWorkerReadyPlaceholder: vi.fn(), rollbackCreatedWorker: vi.fn(), broadcastSessionCreated: vi.fn(), broadcastOrcaWorkerChanged: vi.fn(),
    };
    const callbacks = { service, getCurrentDbClientSnapshot: () => epoch, PluginTaskError, assertPluginTaskResult,
      isPluginTaskAuthorized: () => authorized, readGhostErrandConfig: () => ({ ...cfg }),
      assertLeadCollabProjectEnabled: async () => {}, getWorkerPermissionModeFromCreationPrefs: () => 'auto',
      startOrcaTeamWithPermissionGate, orcaWorkerPermissionConfirmBridge: { request: vi.fn() }, t: (key: string) => key,
      orcaLifecycleService: createOrcaLifecycleService(deps) };
    const run = new Function(...Object.keys(callbacks), wired)(...Object.values(callbacks));
    const operation = run('plugin', { kind: 'startTeam', taskId: 'task' });
    if (change === 'healthy') {
      await expect(operation).resolves.toMatchObject({ ok: true, teamId: 'team' });
      expect(teamActive).toBe(true); expect(role).toBe('lead'); expect(vendorActive).toBe(true);
      expect(epoch).toBe(originalEpoch);
    } else {
      await expect(operation).rejects.toBeInstanceOf(Error);
      expect(teamActive).toBe(existing); expect(role).toBe(existing ? 'lead' : null); expect(vendorActive).toBe(existing);
      expect(deps.markTeamEnded).toHaveBeenCalledTimes(!existing && stage !== 'lookup' ? 1 : 0);
    }
    expect(deps.createWorkerInTeam).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
  }
});
