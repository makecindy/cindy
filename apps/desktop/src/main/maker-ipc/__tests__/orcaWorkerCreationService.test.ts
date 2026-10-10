import { hasAcceptedUserTaskInput } from '../pluginTaskInput.js';
import { assertPluginWorkerDirectoryScope } from '../pluginWorkerDirectory.js';
import { runAcceptedCallback } from '../acceptedCallbackRunner.js';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { PluginTaskError } from '../pluginTaskService.js';
import { resolveAgentCredentialMode, type AgentKind } from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';

import {
  buildNoProviderMessage,
  createOrcaWorkerCreationService,
  orcaWorkerTitle,
  providerRouteRequiresExplicitSelection,
  type OrcaWorkerCreationDeps,
  type OrcaWorkerCreateParams,
  type OrcaWorkerModelCapabilities,
  type OrcaWorkerProviderRoutingContext,
  type OrcaWorkerProviderSnapshot,
} from '../orcaWorkerCreationService';
import { createOrcaTeamService, type OrcaTeamServiceDeps, type OrcaWorkerRecordSnapshot, type DispatchWorkerTaskResult, type OrcaWorkerStatus } from '../orcaTeamService';
import type { MakerSessionCreateOpts } from '../sessionRequest';
import { CredentialModeSwitchBusyError } from '../../maker-host/codex-credential-switch';
import { isActiveWorkerStatus } from '../../../shared/orca-worker-status';
import { deviceAvailableModels, deviceWorkerRoutingContext, sshCodexWorkerRoutingContext } from '../orcaProviderRoutingContext';
import type { ProviderView } from '@cindy/model-providers';
import { createOrcaLifecycleService, type OrcaLifecycleDeps } from '../orcaLifecycleService';

describe('Host provenance across Orca creation waits', () => {
  const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');
  const helper = source.slice(source.indexOf('  const assertPluginWorkerAutoAuthorized ='), source.indexOf('  const orcaWorkerCreationService ='));
  function callback(start: string, end: string, bindings: Record<string, unknown>) {
    const from = source.indexOf(start), to = source.indexOf(end, from);
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const js = ts.transpileModule(`${helper}\nreturn ({${source.slice(from, to)}});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return new Function('hasAcceptedUserTaskInput', 'assertPluginWorkerDirectoryScope', ...Object.keys(bindings), js)(hasAcceptedUserTaskInput, assertPluginWorkerDirectoryScope, ...Object.values(bindings));
  }
  type Action = 'createWorker' | 'enableTeam' | 'startNew' | 'startExisting';
  const phases: Record<Action, string[]> = {
    createWorker: ['team-query', 'worker-list', 'bootstrap', 'renewal', 'worker-write'],
    enableTeam: ['team-query', 'team-create', 'worker-list', 'bootstrap', 'renewal', 'worker-write', 'lead-activation'],
    startNew: ['team-query', 'team-create', 'lead-activation'],
    startExisting: ['team-query', 'lead-activation'],
  };
  function setup(action: Action, phase: string, change: string, entry = 'task') {
    let epoch = { client: {} }, enabled = true;
    const directoryCase = ['config', 'pick'].includes(change);
    const candidate = path.resolve('synthetic-worker');
    let configured = change === 'config' ? candidate : undefined, picked = change === 'pick';
    let directoryResolved = false, directoryReads = 0;
    let queuedAcceptance: (() => void | Promise<void>) | undefined;
    let receipt: { operation: string; pluginId: string; payload: string } | null = change === 'ordinary' ? null : {
      operation: 'create', pluginId: 'plugin', payload: JSON.stringify({ ownershipRevoked: change === 'already-revoked' }),
    };
    const task = { revision: 1, status: 'active', permissionMode: 'auto', planModeEnabled: false, workingDir: path.resolve('synthetic-project') };
    const mutate = (point: string) => {
      if (point !== phase) return;
      if (change === 'uninstalled' || change === 'reinstalled') {
        receipt!.payload = '{"ownershipRevoked":true}'; enabled = change === 'reinstalled';
      } else if (change === 'owner') receipt!.pluginId = 'other-plugin';
      else if (change === 'missing') receipt = null;
      else if (change === 'account') epoch = { client: {} };
      else if (change === 'ask') task.permissionMode = 'default';
      else if (change === 'plan') task.planModeEnabled = true;
      else if (change === 'archived') task.status = 'archived';
      else if (change === 'disabled') enabled = false;
      else if (change === 'config') configured = undefined;
      else if (change === 'pick') picked = false;
    };
    const bindings = {
      maker: {getSession:()=>null}, inputCoordinator: { getAcceptedInputProvenance: () => null },
      PluginTaskError, readPluginTaskPlanReceipt: JSON.parse, getCurrentDbClientSnapshot: () => epoch,
      createPluginTaskStore: () => ({ get: async () => receipt && { ...receipt } }),
      pluginTaskServiceForCurrentOwner: () => ({ get: async (pluginId: string) => {
        if (directoryResolved) {
          directoryReads++;
          if (directoryReads === 2) mutate('final-task');
          if (directoryReads === 3) mutate('final-source');
        }
        if (!receipt || receipt.pluginId !== pluginId || JSON.parse(receipt.payload).ownershipRevoked) throw new PluginTaskError('TASK_NOT_FOUND', 'Revoked');
        return { ...task };
      } }),
      isPluginTaskAuthorized: () => enabled, readPluginTaskConfig: () => ({ permissionMode: 'auto', workingDir: directoryCase ? configured : task.workingDir }),
      resolvePluginWorkerDirectory: vi.fn(async () => {
        directoryResolved = true; directoryReads = 0;
        if (directoryCase && !configured && !picked) throw new PluginTaskError('PERMISSION_DENIED', 'Directory revoked');
        return directoryCase ? candidate : task.workingDir;
      }), isGhostPickedDir: () => picked,
    };
    const { deps, service: creation } = createDeps(callback('    validateCreationPlan: async (', '    getLeadSessionRow: async (', bindings));
    for (const [key, point] of [
      ['listWorkersByLead', 'worker-list'], ['bootstrapSession', 'bootstrap'],
      ['renewWorkerCreationReservation', 'renewal'], ['addOrUpdateWorker', 'worker-write'],
      ['markOrcaRoleIfNeeded', 'role-write'], ['releaseWorkerCreationReservation', 'release'],
    ] as const) {
      const original = deps[key] as (...args: unknown[]) => Promise<unknown>;
      (deps as unknown as Record<string, unknown>)[key] = vi.fn(async (...args: unknown[]) => {
        const result = await original(...args); mutate(point); return result;
      });
    }
    const queuedWorker: OrcaWorkerRecordSnapshot = {
      id: 'worker-1', teamId: 'team-1', leadSessionId: 'lead-1', sessionId: WORKER_SESSION_ID,
      status: 'idle', label: 'sample', role: 'eval', focused: false, idleSince: null,
      session: { title: 'Worker', agentKind: 'codex', model: 'gpt-5.4', effort: null, permissionMode: 'auto', fastMode: false },
    };
    const queuedTeamDeps = {
      getWorkerLinkBySessionId: async () => ({ workerId: queuedWorker.id, teamId: queuedWorker.teamId, workerSessionId: WORKER_SESSION_ID, leadSessionId: 'lead-1' }),
      listWorkersByLead: async () => [queuedWorker],
      getLiveSession: () => ({ isTurnRunning: () => true }),
      getManualInterrupt: () => null, clearManualInterrupt: vi.fn(), broadcastOrcaWorkerChanged: vi.fn(),
      updateWorkerStatus: vi.fn(async () => undefined), log: { info: vi.fn(), warn: vi.fn() },
      dispatchWorkerMessage: async ({ onAccepted }) => {
        queuedAcceptance = onAccepted;
        return { ok: true, mode: 'queued', clientId: 'queued-1', targetTitle: 'Worker', targetLastUserSendAt: null,
          dispatchOutcome: { kind: 'session-dispatch', dispatched: true, source: 'test', wakeKind: 'queued' } };
      },
    } satisfies Partial<OrcaTeamServiceDeps>;
    // This fixture exercises only the queued dispatch/accepted path; unexpected
    // dependencies remain absent so the test cannot silently use another path.
    const queuedTeam = createOrcaTeamService(queuedTeamDeps as unknown as OrcaTeamServiceDeps);
    const lifecycleDeps: OrcaLifecycleDeps = {
      ...callback('    getWorkerPermissionModeOverride: async (', '    setWorkerPermissionMode: applyWorkerPermissionModePreference,', bindings),
      ...callback('    createWorkerInTeam: (params', '    dispatchWorkerTask: (params', { ...bindings, orcaWorkerCreationService: creation }),
      getActiveTeamByLead: vi.fn(async () => { mutate('team-query'); return action === 'createWorker' || action === 'startExisting' ? { id: 'team-1', leadSessionId: 'lead-1' } : null; }),
      createActiveTeam: vi.fn(async () => { mutate('team-create'); return { id: 'new-team', leadSessionId: 'lead-1' }; }),
      isOrphanedTeamInit: vi.fn(async () => false), getWorkerPermissionMode: () => 'bypassPermissions', setWorkerPermissionMode: vi.fn(),
      dispatchWorkerTask: async (params, assertCurrent) => {
        if (entry === 'queued') {
          return queuedTeam.dispatchWorkerTask(params, assertCurrent);
        }
        mutate('accepted'); await assertCurrent?.(); return deps.dispatchWorkerTask(params);
      }, markTeamEnded: vi.fn(async () => undefined), setSessionOrcaRole: vi.fn(async () => undefined),
      clearKnownNonOrcaSession: vi.fn(), setLeadVendorOptions: vi.fn(async () => { mutate('lead-activation'); }), clearLeadVendorOptions: vi.fn(async () => undefined),
      sendWorkerReadyPlaceholder: vi.fn(async (_params, assertCurrent) => { mutate('accepted'); await assertCurrent?.(); }), rollbackCreatedWorker: vi.fn(async () => undefined),
      broadcastSessionCreated: vi.fn(), broadcastOrcaWorkerChanged: vi.fn(),
    };
    const lifecycle = createOrcaLifecycleService(lifecycleDeps);
    const run = () => action === 'createWorker'
      ? lifecycle.createWorker({ leadSessionId: 'lead-1', agent: 'codex', role: 'eval', label: 'sample', initialTask: ['task', 'queued'].includes(entry) ? 'Synthetic task' : undefined, ...(directoryCase ? { workingDir: candidate } : {}) })
      : action === 'enableTeam'
        ? lifecycle.enableTeam({ leadSessionId: 'lead-1', workerAgent: 'codex', role: 'eval', label: 'sample', delegateTask: entry === 'placeholder' ? undefined : 'Synthetic task', deferDelegateTask: entry === 'deferred', ...(directoryCase ? { workingDir: candidate } : {}) })
        : lifecycle.startTeam({ leadSessionId: 'lead-1' });
    return { deps, lifecycleDeps, run, creation, receipt, task,
      resolveDirectory: bindings.resolvePluginWorkerDirectory, acceptQueued: async () => {
      expect(queuedAcceptance).toBeTypeOf('function');
      mutate('accepted');
      return runAcceptedCallback(queuedAcceptance, WORKER_SESSION_ID, 'queued-1');
    } };
  }

  function wireRemoteCreation(deps: OrcaWorkerCreationDeps) {
    deps.openRemoteWorker = vi.fn(async (input: Parameters<NonNullable<OrcaWorkerCreationDeps['openRemoteWorker']>>[0]) => ({
      ok: true as const, proxySessionId: 'remote-proxy', remoteSessionId: 'remote-session',
      agent: input.agent, model: input.model ?? 'remote-default',
      workingDir: input.workingDir ?? '/remote/dialogue',
      proxySession: {
        title: input.title, agentKind: input.agent === 'claude-code' ? 'cc' : input.agent,
        model: input.model ?? 'remote-default', effort: input.effort ?? null,
        permissionMode: input.permissionMode, fastMode: input.fast === true,
      },
    }));
    deps.recordRemoteWorker = vi.fn(async () => undefined);
    deps.discardRemoteWorker = vi.fn(async () => undefined);
  }

  function registerPlan(receipt: NonNullable<ReturnType<typeof setup>['receipt']>, directory: string) {
    receipt.payload = JSON.stringify({ teamPlan: { concurrency: 1, items: [{
      label: 'sample', workingDir: directory,
      route: { agentKind: 'codex', model: 'gpt-5.5', providerId: 'xd', effort: 'medium', fastMode: false },
    }] } });
  }

  it.each([false, true].flatMap(withPlan => ['omitted', 'same-path', 'remote-only'].map(directory => ({ withPlan, directory }))))(
    'rejects plugin-owned execution devices before directory or remote effects (plan: $withPlan, directory: $directory)', async ({ withPlan, directory }) => {
      const { deps, creation, receipt, task, resolveDirectory } = setup('createWorker', '', 'healthy');
      if (withPlan) registerPlan(receipt!, task.workingDir);
      wireRemoteCreation(deps);
      const params: OrcaWorkerCreateParams = {
        leadSessionId: 'lead-1', agent: 'codex', role: 'eval', label: 'sample',
        executionDeviceId: 'device-b',
        ...(directory === 'omitted' ? {} : { workingDir: directory === 'same-path' ? task.workingDir : '/device-b-only' }),
        // The remote branch must not bypass the registered route even when it differs.
        model: 'remote-only-model', providerId: 'remote-provider', effort: 'high', fast: true,
      };
      await expect(creation.createWorker(params)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(resolveDirectory).not.toHaveBeenCalled();
      expect(deps.resolveWorkerWorkingDir).not.toHaveBeenCalled();
      expect(deps.reserveWorkerCreation).not.toHaveBeenCalled();
      expect(deps.openRemoteWorker).not.toHaveBeenCalled();
      expect(deps.recordRemoteWorker).not.toHaveBeenCalled();
      expect(deps.bootstrapSession).not.toHaveBeenCalled();
      expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
    },
  );

  it.each(['ordinary', 'send-receipt', 'already-revoked'])(
    'preserves user-owned remote creation after $change', async change => {
      const { deps, creation, receipt, resolveDirectory } = setup('createWorker', '', change);
      if (change === 'send-receipt') receipt!.operation = 'send';
      wireRemoteCreation(deps);
      await expect(creation.createWorker({ leadSessionId: 'lead-1', agent: 'codex', role: 'eval',
        label: 'sample', executionDeviceId: 'device-b', workingDir: '/device-b-only' })).resolves.toMatchObject({
        ok: true, workerSessionId: 'remote-proxy', executionDeviceId: 'device-b',
      });
      expect(resolveDirectory).not.toHaveBeenCalled();
      expect(deps.openRemoteWorker).toHaveBeenCalledOnce();
      expect(deps.recordRemoteWorker).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])('still validates a local plugin Worker against its registered route (mismatch: %s)', async mismatch => {
    const { deps, creation, receipt, task } = setup('createWorker', '', 'healthy');
    registerPlan(receipt!, task.workingDir);
    const result = await creation.createWorker({ leadSessionId: 'lead-1', agent: 'codex', role: 'eval',
      label: 'sample', workingDir: task.workingDir, ...(mismatch ? { model: 'gpt-5.4' } : {}) });
    expect(result.ok).toBe(!mismatch);
    if (mismatch) {
      expect(deps.bootstrapSession).not.toHaveBeenCalled();
      expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
    } else {
      expect(deps.bootstrapSession).toHaveBeenCalledOnce();
      expect(deps.addOrUpdateWorker).toHaveBeenCalledOnce();
    }
  });
  const cases = (Object.keys(phases) as Action[]).flatMap(action => phases[action].flatMap(phase =>
    ['uninstalled', 'reinstalled', 'account'].map(change => ({ action, phase, change }))));
  cases.push(...(['createWorker', 'enableTeam'] as Action[]).flatMap(action =>
    ['owner', 'missing', 'ask', 'plan', 'archived', 'disabled'].map(change => ({ action, phase: 'bootstrap', change }))));
  cases.push(...(['createWorker', 'enableTeam'] as Action[]).flatMap(action =>
    ['worker-write', 'role-write', 'release', 'final-task', 'final-source', ...(action === 'enableTeam' ? ['lead-activation'] : [])].flatMap(phase =>
      ['config', 'pick'].map(change => ({ action, phase, change })))));
  it.each((['createWorker', 'enableTeam'] as const).flatMap(action => ['config', 'pick'].flatMap(change => ['', 'accepted'].map(phase => ({ action, change, phase }))))) (
    'retains $action $change directory authority after the queued reply: $phase', async ({ action, change, phase }) => {
      const { run, acceptQueued, deps, lifecycleDeps } = setup(action, phase, change, 'queued');
      expect(await run()).toMatchObject({ ok: true, dispatched: false });
      if (phase) await expect(acceptQueued()).rejects.toMatchObject({ name: 'AcceptedCallbackDispatchCancelled' });
      else await expect(acceptQueued()).resolves.toBeUndefined();
      expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
      expect(lifecycleDeps.rollbackCreatedWorker).not.toHaveBeenCalled();
      expect(lifecycleDeps.markTeamEnded).not.toHaveBeenCalled();
    },
  );
  it.each(cases)('rejects $action after $change during $phase without dispatch', async ({ action, phase, change }) => {
    const { deps, lifecycleDeps, run } = setup(action, phase, change);
    const result = await run().catch(() => ({ ok: false }));
    expect(result.ok).toBe(false);
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
    expect(lifecycleDeps.sendWorkerReadyPlaceholder).not.toHaveBeenCalled();
    if (phase === 'bootstrap' || phase === 'renewal') {
      expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
      expect(deps.closeWorkerSession).toHaveBeenCalled();
      expect(deps.releaseWorkerCreationReservation).toHaveBeenCalled();
    }
    if (phase === 'worker-write' || (action === 'enableTeam' && phase === 'lead-activation')) {
      expect(vi.mocked(lifecycleDeps.rollbackCreatedWorker).mock.calls.length + vi.mocked(deps.removeWorker).mock.calls.length).toBeGreaterThan(0);
    }
    if (vi.mocked(lifecycleDeps.createActiveTeam).mock.calls.length) expect(lifecycleDeps.markTeamEnded).toHaveBeenCalledWith('new-team', 'failed');
    else expect(lifecycleDeps.markTeamEnded).not.toHaveBeenCalled();
    expect(lifecycleDeps.setWorkerPermissionMode).not.toHaveBeenCalled();
  });
  it.each((['createWorker', 'enableTeam'] as const).flatMap(action =>
    (action === 'createWorker' ? ['task', 'placeholder'] : ['task', 'placeholder', 'deferred']).flatMap(entry =>
      ['config', 'pick'].flatMap(change => ['', 'accepted'].map(phase => ({ action, entry, change, phase }))))))(
    'retains resolved scope until $action $entry acceptance: $change $phase', async ({ action, entry, change, phase }) => {
      const { run, deps, lifecycleDeps } = setup(action, phase, change, entry);
      const result = await run();
      expect(result.ok).toBe(phase === '');
      if (phase) {
        expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
        expect(lifecycleDeps.rollbackCreatedWorker).toHaveBeenCalled();
      }
      // Public result cannot carry the Host callback or captured authorization facts.
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    },
  );
  it.each((Object.keys(phases) as Action[]).flatMap(action => ['healthy', 'already-revoked'].map(change => ({ action, change }))))(
    'preserves $change behavior for $action', async ({ action, change }) => {
      const { deps, lifecycleDeps, run } = setup(action, '', change);
      expect(await run()).toMatchObject({ ok: true });
      if (action === 'createWorker' || action === 'enableTeam') {
        expect(deps.bootstrapSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: change === 'healthy' ? 'auto' : 'bypassPermissions' }));
        expect(deps.dispatchWorkerTask).toHaveBeenCalledTimes(1);
      }
      expect(lifecycleDeps.setWorkerPermissionMode).not.toHaveBeenCalled();
    },
  );
});

describe('SSH Codex Worker catalog', () => {
  it.each([undefined, 'remote-next', 'controller-only'])('uses remote membership and defaults for %s', async (model) => {
    const models = ['remote-default', 'remote-lead', 'remote-next'].map((id) => ({
      id, efforts: ['low'], defaultEffort: 'low', supportsFastMode: false,
    }));
    const routing = sshCodexWorkerRoutingContext([{ name: 'Remote', models: { codex: models } } as ProviderView]);
    const { deps, service } = createDeps({
      getLeadSessionRow: vi.fn(async () => ({ id: 'lead-1', agentKind: 'codex' as const, workspaceKind: 'project' as const,
        workingDir: '/srv/repo', model: 'remote-lead', effort: 'low', permissionMode: 'default',
        fastMode: false, providerId: 'openai', remoteHostId: 'remote-builder' })),
      getProviderRoutingContext: vi.fn(async () => routing),
      getWorkerDefaults: vi.fn(() => ({ model: 'controller-only', providerId: 'xd', effort: 'high' })),
    });
    const result = await service.createWorker({ leadSessionId: 'lead-1', role: 'reviewer', label: 'reviewer', agent: 'codex', model });
    expect(deps.getProviderRoutingContext).toHaveBeenCalledWith('codex', 'remote-builder');
    expect(deps.getAvailableModels).not.toHaveBeenCalled();
    expect(deps.getWorkerDefaults).not.toHaveBeenCalled();
    if (model === 'controller-only') {
      expect(result.ok).toBe(false);
      expect(deps.bootstrapSession).not.toHaveBeenCalled();
    } else {
      expect(result.ok).toBe(true);
      expect(deps.bootstrapSession).toHaveBeenCalledWith(expect.objectContaining({
        model: model ?? 'remote-lead', providerId: 'openai', remoteHostId: 'remote-builder', effort: 'low', fastMode: false,
      }));
    }
  });
});

describe('orcaWorkerTitle', () => {
  it('names the role once when the label repeats it', () => {
    expect(orcaWorkerTitle('reader', 'reader')).toBe('Worker · reader');
    expect(orcaWorkerTitle('Reviewer', 'reviewer')).toBe('Worker · Reviewer');
    expect(orcaWorkerTitle('developer', 'developer-2')).toBe('Worker · developer · developer-2');
    expect(orcaWorkerTitle('转写', 'transcribe')).toBe('Worker · 转写 · transcribe');
  });
});

describe('Worker running on another device (execution device)', () => {
  const remoteDeps = (overrides: Partial<OrcaWorkerCreationDeps> = {}) => createDeps({
    openRemoteWorker: vi.fn(async (input) => ({
      ok: true as const,
      proxySessionId: 'proxy-1',
      remoteSessionId: 'remote-1',
      proxySession: {
        title: input.title, agentKind: input.agent === 'claude-code' ? 'cc' : input.agent,
        model: input.model ?? 'device-default-model', effort: input.effort ?? null,
        permissionMode: input.permissionMode, fastMode: input.fast === true,
      },
      agent: input.agent,
      model: input.model ?? 'device-default-model',
      workingDir: input.workingDir ?? '/Users/demo/Cindy/dialogues/remote-1',
    })),
    recordRemoteWorker: vi.fn(async () => undefined),
    discardRemoteWorker: vi.fn(async () => undefined),
    ...overrides,
  });

  it('creates the task on the device, records a proxy worker and skips local model admission', async () => {
    const { deps, service } = remoteDeps();
    const result = await service.createWorker({
      leadSessionId: 'lead-1', role: '转写', label: 'transcribe', agent: 'claude-code',
      executionDeviceId: 'mac-mini', workingDir: '/Users/demo/Interviews', model: 'only-on-device',
    });
    expect(result).toMatchObject({
      ok: true,
      workerSessionId: 'proxy-1',
      resolved: { agent: 'claude-code', model: 'only-on-device', label: 'transcribe' },
    });
    expect(deps.openRemoteWorker).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'mac-mini', workerId: 'worker-1', teamId: 'team-1', leadSessionId: 'lead-1',
      label: 'transcribe', role: '转写', agent: 'claude-code', model: 'only-on-device',
      permissionMode: 'auto', workingDir: '/Users/demo/Interviews', title: 'Worker · 转写 · transcribe',
    }));
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
    expect(deps.recordRemoteWorker).toHaveBeenCalledWith({
      workerId: 'worker-1', teamId: 'team-1', leadSessionId: 'lead-1',
      proxySessionId: 'proxy-1', deviceId: 'mac-mini', remoteSessionId: 'remote-1',
      proxySession: expect.objectContaining({ model: 'only-on-device', agentKind: 'cc' }),
      label: 'transcribe', role: '转写',
      workingDir: '/Users/demo/Interviews',
    });
    expect(deps.getProviderRoutingContext).not.toHaveBeenCalled();
    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.resolveWorkerWorkingDir).not.toHaveBeenCalled();
    expect(deps.releaseWorkerCreationReservation).toHaveBeenCalledWith('worker-1');
  });

  it('lets the device allocate a directory when none is given and accepts Windows paths', async () => {
    const { deps, service } = remoteDeps();
    await service.createWorker({
      leadSessionId: 'lead-1', role: 'dev', label: 'a', agent: 'codex', executionDeviceId: 'office',
    });
    expect(deps.openRemoteWorker).toHaveBeenLastCalledWith(expect.not.objectContaining({ workingDir: expect.anything() }));
    const windows = await service.createWorker({
      leadSessionId: 'lead-1', role: 'dev', label: 'b', agent: 'codex', executionDeviceId: 'office',
      workingDir: 'D:\\projects\\site',
    });
    expect(windows.ok).toBe(true);
  });

  it.each([false, true])('reports admitted remote Fast %s instead of the request after recording the Worker', async fastMode => {
    const { deps, service } = remoteDeps({
      openRemoteWorker: vi.fn(async () => ({ ok: true as const,
        proxySessionId: 'proxy-1', remoteSessionId: 'remote-1', agent: 'codex' as const,
        model: 'device-model', workingDir: '/remote',
        proxySession: { title: 'Worker', model: 'device-model', agentKind: 'codex', effort: null,
          permissionMode: 'auto', fastMode },
      })),
    });
    await expect(service.createWorker({ leadSessionId: 'lead-1', role: 'dev', label: 'a',
      agent: 'codex', executionDeviceId: 'mac-mini', fast: !fastMode })).resolves.toMatchObject({
      ok: true, resolved: { fastMode },
    });
    expect(deps.recordRemoteWorker).toHaveBeenCalledWith(expect.objectContaining({
      proxySession: expect.objectContaining({ fastMode }),
    }));
  });

  it.each(['medium', 'low', ''])('reports the admitted remote effort %s after recording the Worker', async effort => {
    const { deps, service } = remoteDeps({
      openRemoteWorker: vi.fn(async () => ({ ok: true as const,
        proxySessionId: 'proxy-1', remoteSessionId: 'remote-1', agent: 'codex' as const,
        model: 'device-model', workingDir: '/remote',
        proxySession: { title: 'Worker', model: 'device-model', agentKind: 'codex', effort,
          permissionMode: 'auto', fastMode: false },
      })),
    });
    await expect(service.createWorker({ leadSessionId: 'lead-1', role: 'dev', label: 'a',
      agent: 'codex', executionDeviceId: 'mac-mini' })).resolves.toMatchObject({
      ok: true, resolved: { effort: effort || null },
    });
    expect(deps.recordRemoteWorker).toHaveBeenCalledWith(expect.objectContaining({
      proxySession: expect.objectContaining({ effort }),
    }));
  });

  it.each([
    ['relative directory', { workingDir: 'relative/dir' }],
    ['malformed device id', { executionDeviceId: 'bad id/../' }],
  ])('rejects a %s before reserving a slot', async (_name, patch) => {
    const { deps, service } = remoteDeps();
    const result = await service.createWorker({
      leadSessionId: 'lead-1', role: 'dev', label: 'a', agent: 'codex', executionDeviceId: 'office', ...patch,
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS' });
    expect(deps.reserveWorkerCreation).not.toHaveBeenCalled();
    expect(deps.openRemoteWorker).not.toHaveBeenCalled();
  });

  it.each([
    ['SSH', { remoteHostId: 'host-1' }],
    ['remote Agent', { agentDeviceId: 'device-b' }],
  ])('refuses to mix with a Lead on %s', async (_name, leadPatch) => {
    const { deps, service } = remoteDeps({
      getLeadSessionRow: vi.fn(async () => ({
        id: 'lead-1', agentKind: 'codex' as const, workspaceKind: 'project' as const, workingDir: '/repo',
        model: 'gpt-5.5', effort: 'medium', permissionMode: 'default', fastMode: false, providerId: 'xd',
        remoteHostId: null, ...leadPatch,
      })),
    });
    const result = await service.createWorker({
      leadSessionId: 'lead-1', role: 'dev', label: 'a', agent: 'codex', executionDeviceId: 'office',
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS' });
    expect(deps.openRemoteWorker).not.toHaveBeenCalled();
  });

  it('passes through device errors without recording a worker', async () => {
    const { deps, service } = remoteDeps({
      openRemoteWorker: vi.fn(async () => ({
        ok: false as const, errorCode: 'UNSUPPORTED_CAPABILITY' as const, message: 'Mac mini 需要更新',
      })),
    });
    const result = await service.createWorker({
      leadSessionId: 'lead-1', role: 'dev', label: 'a', agent: 'codex', executionDeviceId: 'mac-mini',
    });
    expect(result).toEqual({ ok: false, errorCode: 'UNSUPPORTED_CAPABILITY', message: 'Mac mini 需要更新' });
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
    expect(deps.releaseWorkerCreationReservation).toHaveBeenCalledWith('worker-1');
  });

  it('discards the device task when persisting the worker fails', async () => {
    const { deps, service } = remoteDeps({
      recordRemoteWorker: vi.fn(async () => { throw new Error('disk full'); }),
    });
    const result = await service.createWorker({
      leadSessionId: 'lead-1', role: 'dev', label: 'a', agent: 'codex', executionDeviceId: 'mac-mini',
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'INTERNAL' });
    expect(deps.discardRemoteWorker).toHaveBeenCalledWith({
      proxySessionId: 'proxy-1', deviceId: 'mac-mini', remoteSessionId: 'remote-1',
    });
    expect(deps.recordRemoteWorker).toHaveBeenCalledOnce();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
    expect(deps.removeWorker).not.toHaveBeenCalled();
  });

  it('reports remote workers as unsupported when the host did not wire them', async () => {
    const { service } = createDeps();
    const result = await service.createWorker({
      leadSessionId: 'lead-1', role: 'dev', label: 'a', agent: 'codex', executionDeviceId: 'mac-mini',
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS' });
  });
});

describe('Worker of a lead whose agent runs on another computer', () => {
  const sparkModels = ['spark/qwen', 'spark/deepseek'].map((id) => ({
    id, name: id, efforts: ['low', 'high'], defaultEffort: 'high', supportsFastMode: false,
  }));
  const views = [
    { id: 'spark', name: 'Spark', source: 'user', agents: ['claude-code', 'pi'], connected: true,
      models: { 'claude-code': sparkModels, pi: sparkModels }, routing: { 'claude-code': {}, pi: {} } },
    { id: 'offline', name: 'Offline', source: 'user', agents: ['pi'], connected: false,
      models: { pi: [{ id: 'offline/model', name: 'Offline', efforts: [], defaultEffort: null }] }, routing: { pi: {} } },
  ] as unknown as ProviderView[];
  const deviceLead = (overrides: Record<string, unknown> = {}) => ({
    id: 'lead-1', agentKind: 'pi' as const, workspaceKind: 'project' as const, workingDir: '/Users/me/repo',
    model: 'spark/qwen', effort: 'high', permissionMode: 'default', fastMode: false, providerId: 'spark',
    remoteHostId: null, agentDeviceId: 'device-b', ...overrides,
  });

  it.each([undefined, 'spark/deepseek', 'local-only'])('uses that computer for membership and defaults (%s)', async (model) => {
    const routing = deviceWorkerRoutingContext(views, 'pi');
    const { deps, service } = createDeps({
      getLeadSessionRow: vi.fn(async () => deviceLead()),
      getProviderRoutingContext: vi.fn(async () => routing),
      getWorkerDefaults: vi.fn(() => ({ model: 'local-only', providerId: 'xd', effort: 'high' })),
    });
    const result = await service.createWorker({ leadSessionId: 'lead-1', role: 'reviewer', label: 'reviewer', agent: 'pi', model });
    expect(deps.getProviderRoutingContext).toHaveBeenCalledWith('pi', null, 'device-b');
    expect(deps.getAvailableModels).not.toHaveBeenCalled();
    expect(deps.getWorkerDefaults).not.toHaveBeenCalled();
    if (model === 'local-only') {
      expect(result.ok).toBe(false);
      expect(deps.bootstrapSession).not.toHaveBeenCalled();
      return;
    }
    expect(result.ok).toBe(true);
    // Worker 跟 lead 在同一台电脑运行，模型与来源按那台的目录。
    expect(deps.bootstrapSession).toHaveBeenCalledWith(expect.objectContaining({
      model: model ?? 'spark/qwen', providerId: 'spark', agentDeviceId: 'device-b',
    }));
    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({ agentDeviceId: 'device-b' }));
  });

  it("starts from that computer's first model when the lead uses another agent", async () => {
    const routing = deviceWorkerRoutingContext(views, 'claude-code');
    const { deps, service } = createDeps({
      getLeadSessionRow: vi.fn(async () => deviceLead({ agentKind: 'codex', model: 'gpt-5.5', providerId: 'openai' })),
      getProviderRoutingContext: vi.fn(async () => routing),
    });
    const result = await service.createWorker({ leadSessionId: 'lead-1', role: 'reviewer', label: 'reviewer', agent: 'claude-code' });
    expect(result.ok).toBe(true);
    expect(deps.bootstrapSession).toHaveBeenCalledWith(expect.objectContaining({
      agentKind: 'claude-code', model: 'spark/qwen', providerId: 'spark', agentDeviceId: 'device-b',
    }));
  });

  it('lists only connected sources of that computer', () => {
    expect(deviceAvailableModels(views, 'pi')).toEqual([
      { id: 'spark/qwen', label: 'spark/qwen', providers: [{ id: 'spark', name: 'Spark' }], defaultProviderId: 'spark' },
      { id: 'spark/deepseek', label: 'spark/deepseek', providers: [{ id: 'spark', name: 'Spark' }], defaultProviderId: 'spark' },
    ]);
    expect(deviceAvailableModels(views, 'codex')).toEqual([]);
  });

  // 远程供应商与本机供应商一视同仁(2026-10-10)：每个 Worker 可以单独选 Agent 所在电脑。
  describe('when the Worker picks its own Agent location', () => {
    const create = (service: ReturnType<typeof createDeps>['service'], patch: Partial<OrcaWorkerCreateParams>) =>
      service.createWorker({ leadSessionId: 'lead-1', role: 'reviewer', label: 'reviewer', agent: 'pi', ...patch });

    it("runs a local Lead's Worker on another computer with that computer's catalog", async () => {
      const routing = deviceWorkerRoutingContext(views, 'pi');
      const { deps, service } = createDeps({ getProviderRoutingContext: vi.fn(async () => routing) });
      const result = await create(service, { model: 'spark/deepseek', agentDeviceId: 'device-b' });
      expect(result).toMatchObject({ ok: true, resolved: { model: 'spark/deepseek', providerId: 'spark', agentDeviceId: 'device-b' } });
      expect(deps.getProviderRoutingContext).toHaveBeenCalledWith('pi', null, 'device-b');
      expect(deps.bootstrapSession).toHaveBeenCalledWith(expect.objectContaining({
        model: 'spark/deepseek', providerId: 'spark', agentDeviceId: 'device-b',
      }));
    });

    it("runs a remote Lead's Worker on the task computer when asked", async () => {
      const { deps, service } = createDeps({ getLeadSessionRow: vi.fn(async () => deviceLead({ agentKind: 'codex', model: 'gpt-5.5', providerId: 'xd' })) });
      const result = await service.createWorker({
        leadSessionId: 'lead-1', role: 'dev', label: 'dev', agent: 'codex', model: 'gpt-5.4', agentDeviceId: null,
      });
      expect(result).toMatchObject({ ok: true, resolved: { agentDeviceId: null } });
      expect(deps.getProviderRoutingContext).toHaveBeenCalledWith('codex', null);
      const opts = vi.mocked(deps.bootstrapSession).mock.calls[0]![0];
      expect(opts).not.toHaveProperty('agentDeviceId');
    });

    it("does not carry the Lead's model to a computer that lacks it", async () => {
      const { service } = createDeps({
        getLeadSessionRow: vi.fn(async () => deviceLead({ agentKind: 'codex', model: 'gpt-only-on-b', providerId: 'xd' })),
      });
      const result = await service.createWorker({
        leadSessionId: 'lead-1', role: 'dev', label: 'dev', agent: 'codex', agentDeviceId: null,
      });
      expect(result).toMatchObject({ ok: true, resolved: { model: 'gpt-5.5', agentDeviceId: null } });
    });

    it("does not carry the Lead's source to a different computer", async () => {
      // Lead 在 device-b 用的来源 other 在 device-c 上不存在：跟 Lead 同位置时会按「Lead 来源不可用」拒绝，
      // 换了位置就按那台的默认来源。
      const routing = deviceWorkerRoutingContext(views, 'pi');
      const { deps, service } = createDeps({
        getLeadSessionRow: vi.fn(async () => deviceLead({ providerId: 'other' })),
        getProviderRoutingContext: vi.fn(async () => routing),
      });
      const result = await create(service, { agentDeviceId: 'device-c' });
      expect(result).toMatchObject({ ok: true, resolved: { model: 'spark/qwen', providerId: 'spark', agentDeviceId: 'device-c' } });
      expect(deps.getProviderRoutingContext).toHaveBeenCalledWith('pi', null, 'device-c');
    });

    it.each([
      ['[REMOTE_AGENT_SHARE_PAUSED] the owner has paused this share', 'REMOTE_AGENT_SHARE_PAUSED'],
      ['[DEVICE_LINK_NOT_CONNECTED] offline', 'REMOTE_AGENT_DEVICE_UNREACHABLE'],
    ])('fails before reserving a slot when that catalog cannot be read (%s)', async (message, errorCode) => {
      const { deps, service } = createDeps({
        getProviderRoutingContext: vi.fn(async () => { throw new Error(message); }),
      });
      const result = await create(service, { agentDeviceId: 'share:abc' });
      expect(result).toMatchObject({ ok: false, errorCode });
      expect(deps.reserveWorkerCreation).not.toHaveBeenCalled();
      expect(deps.bootstrapSession).not.toHaveBeenCalled();
    });

    it.each([
      ['an SSH Lead', { lead: { remoteHostId: 'host-1' }, params: {} }],
      ['a run-on-device Worker', { lead: {}, params: { executionDeviceId: 'office' } }],
      ['a malformed id', { lead: {}, params: { agentDeviceId: 'bad id/..' } }],
    ])('rejects another computer for %s', async (_name, { lead, params }) => {
      const { deps, service } = createDeps({
        getLeadSessionRow: vi.fn(async () => deviceLead({ agentDeviceId: null, ...lead })),
      });
      const result = await create(service, { agentDeviceId: 'device-b', ...params });
      expect(result).toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS' });
      expect(deps.reserveWorkerCreation).not.toHaveBeenCalled();
    });

    it('treats this computer as the task computer', async () => {
      const { deps, service } = createDeps({ isSelfDeviceId: (id) => id === 'self-pc' });
      const result = await service.createWorker({
        leadSessionId: 'lead-1', role: 'dev', label: 'dev', agent: 'codex', agentDeviceId: 'self-pc',
      });
      expect(result).toMatchObject({ ok: true, resolved: { agentDeviceId: null } });
      expect(deps.getProviderRoutingContext).toHaveBeenCalledWith('codex', null);
    });
  });
});

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WORKER_SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';

describe('buildNoProviderMessage (pi first-class)', () => {
  const snap = (name: string): OrcaWorkerProviderSnapshot => ({ name }) as OrcaWorkerProviderSnapshot;
  it('names Pi (not Claude Code) when pi has no connected provider', () => {
    const msg = buildNoProviderMessage('pi', { 'claude-code': [], codex: [], pi: [] });
    expect(msg).toContain('Pi 当前没有可用的模型供应商');
    expect(msg).not.toContain('Claude Code 当前没有');
  });
  it('suggests pi as a fallback agent when pi alone has a connected provider', () => {
    const msg = buildNoProviderMessage('codex', {
      'claude-code': [],
      codex: [],
      pi: [snap('Cindy AI')],
    });
    expect(msg).toContain('Pi(已连接:Cindy AI)');
  });
});

describe('providerRouteRequiresExplicitSelection', () => {
  it.each(['api-key-header', 'oauth-token', 'none'] as const)(
    'keeps %s routes pinned to the selected provider',
    (strategy) => {
      expect(providerRouteRequiresExplicitSelection(strategy)).toBe(true);
    },
  );

  it.each(['oauth-passthrough', 'provider-oauth-header', 'gateway-key', undefined] as const)(
    'does not force an explicit route for %s',
    (strategy) => {
      expect(providerRouteRequiresExplicitSelection(strategy)).toBe(false);
    },
  );
});

function providerRoutingContext(
  partial: Partial<Record<AgentKind, OrcaWorkerProviderSnapshot[]>>,
): OrcaWorkerProviderRoutingContext {
  const availability: Record<AgentKind, OrcaWorkerProviderSnapshot[]> = {
    'claude-code': partial['claude-code'] ?? [],
    codex: partial.codex ?? [],
    pi: partial.pi ?? [],
  };
  return {
    availability,
    resolveDefaultProviderIdForModel: (agent, model) => (
      availability[agent].find((provider) => provider.models.includes(model))?.id ?? null
    ),
  };
}

function createDeps(overrides: Partial<OrcaWorkerCreationDeps> = {}) {
  const calls: string[] = [];
  const ids = ['worker-1'];
  const reservations = new Set<string>();
  const deps: OrcaWorkerCreationDeps = {
    getActiveTeamByLead: vi.fn(async (leadSessionId) => (
      leadSessionId === 'lead-1'
        ? { id: 'team-1', leadSessionId: 'lead-1' }
        : null
    )),
    listWorkersByLead: vi.fn(async () => []),
    isActiveWorkerStatus: vi.fn(isActiveWorkerStatus),
    readCollaborationSettings: vi.fn(() => ({ workerSoftLimit: 3, workerHardLimit: 5 })),
    getLeadSessionRow: vi.fn(async () => ({
      id: 'lead-1',
      agentKind: 'codex' as const,
      workspaceKind: 'project' as const,
      workingDir: 'C:\\repo',
      model: 'gpt-5.5',
      effort: 'medium',
      permissionMode: 'default',
      fastMode: false,
      providerId: 'xd',
      remoteHostId: null,
    })),
    getWorkerDefaults: vi.fn(() => ({})),
    getWorkerPermissionMode: vi.fn(() => 'auto' as const),
    resolveWorkerWorkingDir: vi.fn(async (dir) => dir),
    getAvailableModels: vi.fn((agent: AgentKind) => (
      agent === 'codex'
        ? [
            { id: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
            { id: 'gpt-5.4', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
            { id: 'gpt-5.4-mini', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
            { id: 'codex/budget', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
          ]
        : [{ id: 'claude-sonnet-4-6', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' }]
    )),
    getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
      'claude-code': [{ id: 'xd', name: 'XD Gateway', models: ['claude-sonnet-4-6'] }],
      codex: [{
        id: 'xd',
        name: 'XD Gateway',
        models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'codex/budget', 'gpt-no-fast'],
      }],
    })),
    readClaudeApiKey: vi.fn((): string | null => 'sk-test'),
    reserveWorkerCreation: vi.fn(async ({ label }) => {
      const canonical = label.toLowerCase();
      if (reservations.has(canonical)) {
        return { ok: false as const, errorCode: 'WORKER_CREATION_IN_PROGRESS' as const };
      }
      reservations.add(canonical);
      return { ok: true as const, occupiedSlotsBefore: 0 };
    }),
    renewWorkerCreationReservation: vi.fn(async () => true),
    releaseWorkerCreationReservation: vi.fn(async () => undefined),
    createId: vi.fn(() => ids.shift() ?? `id-${ids.length}`),
    createSessionId: vi.fn(() => WORKER_SESSION_ID),
    buildCreateOptsWithStderr: vi.fn((opts: MakerSessionCreateOpts) => opts),
    bootstrapSession: vi.fn(async (opts: MakerSessionCreateOpts) => {
      calls.push(`bootstrapSession:${opts.id}`);
      return {
        session: {
          id: opts.id ?? WORKER_SESSION_ID,
          agentKind: opts.agentKind,
        },
        didInjectOrcaInstructions: true,
        didInjectProjectContext: false,
      };
    }),
    addOrUpdateWorker: vi.fn(async (worker) => {
      calls.push(`addOrUpdateWorker:${worker.id}`);
    }),
    markOrcaRoleIfNeeded: vi.fn(async (sessionId, role) => {
      calls.push(`markOrcaRoleIfNeeded:${sessionId}:${role}`);
    }),
    dispatchWorkerTask: vi.fn(async (params) => {
      calls.push(`dispatchWorkerTask:${params.targetSessionId}`);
      return {
        dispatched: true,
        dispatchOutcome: {
          kind: 'session-dispatch',
          source: params.dispatchMeta.source,
          dispatched: true,
        },
        agentKind: 'codex',
        wakeKind: 'resumed',
        targetTitle: 'Worker',
        targetLastUserSendAt: null,
      } satisfies DispatchWorkerTaskResult;
    }),
    broadcastSessionCreated: vi.fn((sessionId) => {
      calls.push(`broadcastSessionCreated:${sessionId}`);
    }),
    broadcastOrcaWorkerChanged: vi.fn((leadSessionId) => {
      calls.push(`broadcastOrcaWorkerChanged:${leadSessionId}`);
    }),
    closeWorkerSession: vi.fn(async (sessionId) => {
      calls.push(`closeWorkerSession:${sessionId}`);
    }),
    archiveWorkerSession: vi.fn(async (sessionId) => {
      calls.push(`archiveWorkerSession:${sessionId}`);
    }),
    forgetWorkerSession: vi.fn((sessionId) => {
      calls.push(`forgetWorkerSession:${sessionId}`);
    }),
    removeWorker: vi.fn(async (workerId) => {
      calls.push(`removeWorker:${workerId}`);
    }),
    ...overrides,
  };
  return {
    calls,
    deps,
    service: createOrcaWorkerCreationService(deps),
  };
}

describe('Orca worker working directory', () => {
  const params: OrcaWorkerCreateParams = {
    leadSessionId: 'lead-1', role: 'developer', agent: 'codex', label: 'worker',
    initialTask: 'Run in the assigned project',
  };

  it('binds the resolved directory before bootstrap (dispatch belongs to lifecycle)', async () => {
    const requested = path.resolve('candidate link ');
    const resolved = path.resolve('candidate real ');
    const { deps, service } = createDeps({
      resolveWorkerWorkingDir: vi.fn(async () => resolved),
    });
    const result = await service.createWorker({ ...params, workingDir: requested });
    expect(result.ok).toBe(true);
    expect(deps.resolveWorkerWorkingDir).toHaveBeenCalledWith(requested, expect.objectContaining({ id: 'lead-1' }));
    expect(deps.bootstrapSession).toHaveBeenCalledWith(expect.objectContaining({
      workingDir: resolved, workspaceKind: 'project',
    }));
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
    expect(vi.mocked(deps.resolveWorkerWorkingDir).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(deps.bootstrapSession).mock.invocationCallOrder[0]!);
  });

  it('preserves Lead directory inheritance when the override is omitted', async () => {
    const { deps, service } = createDeps();
    await service.createWorker(params);
    expect(deps.resolveWorkerWorkingDir).not.toHaveBeenCalled();
    expect(deps.bootstrapSession).toHaveBeenCalledWith(expect.objectContaining({ workingDir: 'C:\\repo' }));
  });

  it.each(['', ' ', 'relative/project', './project', 'a\0b'])('rejects invalid directory %j before creating anything', async (workingDir) => {
    const { deps, service } = createDeps();
    expect(await service.createWorker({ ...params, workingDir })).toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS' });
    expect(deps.resolveWorkerWorkingDir).not.toHaveBeenCalled();
    expect(deps.reserveWorkerCreation).not.toHaveBeenCalled();
    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
  });

  it.each(['missing directory', 'not a directory', 'collaboration disabled'])('does not fall back when resolution fails: %s', async (reason) => {
    const { deps, service } = createDeps({ resolveWorkerWorkingDir: vi.fn(async () => { throw new Error(reason); }) });
    expect(await service.createWorker({ ...params, workingDir: path.resolve('candidate') }))
      .toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS' });
    expect(deps.reserveWorkerCreation).not.toHaveBeenCalled();
    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
  });

  it('uses project context when a dialogue Lead explicitly selects a directory', async () => {
    const { deps, service } = createDeps();
    const lead = await deps.getLeadSessionRow('lead-1');
    vi.mocked(deps.getLeadSessionRow).mockResolvedValue({ ...lead!, workspaceKind: 'dialogue' });
    const workingDir = path.resolve('explicit project');
    expect(await service.createWorker({ ...params, workingDir })).toMatchObject({ ok: true });
    expect(deps.bootstrapSession).toHaveBeenCalledWith(expect.objectContaining({ workingDir, workspaceKind: 'project' }));
  });

  it('resolves SSH paths on the inherited host and binds the result', async () => {
    const { deps, service } = createDeps();
    const lead = await deps.getLeadSessionRow('lead-1');
    vi.mocked(deps.getLeadSessionRow).mockResolvedValue({ ...lead!, remoteHostId: 'host-1' });
    vi.mocked(deps.resolveWorkerWorkingDir).mockResolvedValue('/remote/real');
    expect(await service.createWorker({ ...params, workingDir: '/remote/project' })).toMatchObject({ ok: true });
    expect(deps.resolveWorkerWorkingDir).toHaveBeenCalledWith('/remote/project', expect.objectContaining({ remoteHostId: 'host-1' }));
    expect(deps.bootstrapSession).toHaveBeenCalledWith(expect.objectContaining({ workingDir: '/remote/real', remoteHostId: 'host-1' }));
  });
});

describe('OrcaWorkerCreationService', () => {
  const workerStatus = (status: OrcaWorkerStatus): OrcaWorkerStatus => status;

  it('returns NOT_FOUND without side effects when the lead has no active team', async () => {
    const { deps, service } = createDeps();

    await expect(
      service.createWorker({
        leadSessionId: 'missing-lead',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'NOT_FOUND',
      message: 'no active team for this lead',
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
  });

  it('rejects duplicate labels before bootstrapping a worker session', async () => {
    const { deps, service } = createDeps({
      listWorkersByLead: vi.fn(async () => [{ id: 'worker-existing', label: 'reviewer', status: workerStatus('idle') }]),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'DUPLICATE_LABEL',
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
  });

  it('rejects labels outside the shared worker label contract before reading worker slots', async () => {
    for (const label of ['bad label', '中文', 'x'.repeat(33)]) {
      const { deps, service } = createDeps();

      await expect(
        service.createWorker({
          leadSessionId: 'lead-1',
          role: 'reviewer',
          agent: 'codex',
          label,
        }),
      ).resolves.toMatchObject({
        ok: false,
        errorCode: 'INVALID_PARAMS',
      });

      expect(deps.listWorkersByLead).not.toHaveBeenCalled();
      expect(deps.bootstrapSession).not.toHaveBeenCalled();
      expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
      expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
    }
  });

  it('persists trimmed worker labels after validating the shared label contract', async () => {
    const { deps, service } = createDeps();

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: ' Reviewer_1 ',
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: {
        label: 'reviewer_1',
      },
    });

    expect(deps.addOrUpdateWorker).toHaveBeenCalledWith(expect.objectContaining({
      label: 'reviewer_1',
    }));
  });

  it('allows only one full create lifecycle for concurrent case-insensitive labels', async () => {
    const { deps, service } = createDeps();
    const results = await Promise.all([
      service.createWorker({ leadSessionId: 'lead-1', role: 'tester', agent: 'codex', label: 'tester' }),
      service.createWorker({ leadSessionId: 'lead-1', role: 'tester', agent: 'codex', label: 'TESTER' }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.errorCode === 'WORKER_CREATION_IN_PROGRESS')).toHaveLength(1);
    expect(deps.bootstrapSession).toHaveBeenCalledTimes(1);
    expect(deps.addOrUpdateWorker).toHaveBeenCalledTimes(1);
    expect(deps.markOrcaRoleIfNeeded).toHaveBeenCalledTimes(1);
  });

  it('runs the remote ensure before bootstrap for a remote lead, and skips it for a local lead', async () => {
    // codex-1/orca-2 回归:remote lead 的 worker 继承 remoteHostId, 创建前必须
    // 走 SSH 重连 / agent 安装 / codex daemon MCP 注入的 ensure, 否则远端
    // 协同 MCP 通道不就绪。
    const order: string[] = [];
    const ensureRemoteReadyForSessionStart = vi.fn(async () => {
      order.push('ensure');
    });
    const remoteLeadRow = {
      id: 'lead-1',
      agentKind: 'codex' as const,
      workspaceKind: 'project' as const,
      workingDir: '/srv/repo',
      model: 'gpt-5.5',
      effort: 'medium',
      permissionMode: 'default',
      fastMode: false,
      providerId: 'xd',
      remoteHostId: 'host-remote-1',
    };
    const { service } = createDeps({
      getLeadSessionRow: vi.fn(async () => remoteLeadRow),
      ensureRemoteReadyForSessionStart,
      bootstrapSession: vi.fn(async (opts: MakerSessionCreateOpts) => {
        order.push('bootstrap');
        return {
          session: { id: opts.id ?? WORKER_SESSION_ID, agentKind: opts.agentKind },
          didInjectOrcaInstructions: true,
          didInjectProjectContext: false,
        };
      }),
    });

    await expect(
      service.createWorker({ leadSessionId: 'lead-1', role: 'reviewer', agent: 'codex', label: 'reviewer' }),
    ).resolves.toMatchObject({ ok: true });

    expect(ensureRemoteReadyForSessionStart).toHaveBeenCalledTimes(1);
    expect(ensureRemoteReadyForSessionStart).toHaveBeenCalledWith({
      createOpts: expect.objectContaining({ remoteHostId: 'host-remote-1' }),
    });
    expect(order.slice(0, 2)).toEqual(['ensure', 'bootstrap']);

    // 本地 lead: 不调 ensure。
    const local = createDeps();
    await expect(
      local.service.createWorker({ leadSessionId: 'lead-1', role: 'reviewer', agent: 'codex', label: 'reviewer' }),
    ).resolves.toMatchObject({ ok: true });
    expect(local.deps.ensureRemoteReadyForSessionStart).toBeUndefined();
  });

  it('counts terminal workers toward the hard limit before any creation side effects', async () => {
    const { deps, service } = createDeps({
      readCollaborationSettings: vi.fn(() => ({ workerSoftLimit: 2, workerHardLimit: 4 })),
      listWorkersByLead: vi.fn(async () => [
        { id: 'worker-1', label: 'one', status: workerStatus('idle') },
        { id: 'worker-2', label: 'two', status: workerStatus('running') },
        { id: 'worker-3', label: 'three', status: workerStatus('done') },
        { id: 'worker-4', label: 'four', status: workerStatus('error') },
      ]),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'WORKER_LIMIT_HARD_EXCEEDED',
      limit: {
        workerHardLimit: 4,
        occupiedSlots: 4,
        remainingSlots: 0,
      },
    });

    expect(deps.getAvailableModels).not.toHaveBeenCalled();
    expect(deps.getProviderRoutingContext).not.toHaveBeenCalled();
    expect(deps.getLeadSessionRow).not.toHaveBeenCalled();
    expect(deps.reserveWorkerCreation).not.toHaveBeenCalled();
    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
  });

  it('returns a hard-limit snapshot when the atomic reservation loses a concurrent slot race', async () => {
    const { deps, service } = createDeps({
      readCollaborationSettings: vi.fn(() => ({ workerSoftLimit: 2, workerHardLimit: 3 })),
      reserveWorkerCreation: vi.fn(async () => ({
        ok: false as const,
        errorCode: 'WORKER_LIMIT_HARD_EXCEEDED' as const,
      })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'WORKER_LIMIT_HARD_EXCEEDED',
      limit: {
        workerHardLimit: 3,
        occupiedSlots: 3,
        remainingSlots: 0,
      },
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
  });

  it('rejects unavailable explicit models before reading lead defaults', async () => {
    const { deps, service } = createDeps();

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
        model: 'gpt-unknown',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
      message: expect.stringContaining('gpt-unknown'),
    });

    expect(deps.getLeadSessionRow).toHaveBeenCalledWith('lead-1');
    expect(deps.getWorkerDefaults).not.toHaveBeenCalled();
    expect(deps.bootstrapSession).not.toHaveBeenCalled();
  });

  describe('provider-aware managed model aliases', () => {
    const shortId = 'deepseek-v4-flash';
    const canonicalId = 'deepseek/deepseek-v4-flash';
    const shortModelCapabilities: OrcaWorkerModelCapabilities = {
      id: shortId,
      efforts: ['high', 'max'],
      defaultEffort: 'high',
      supportsFastMode: false,
    };
    const canonicalModelCapabilities: OrcaWorkerModelCapabilities = {
      id: canonicalId,
      efforts: ['high', 'max'],
      defaultEffort: 'high',
      supportsFastMode: false,
    };
    const modelCapabilities: OrcaWorkerModelCapabilities[] = [
      shortModelCapabilities,
      canonicalModelCapabilities,
    ];

    const managedProvider = (
      models: string[] = [canonicalId],
      registryIdentityByModel: Readonly<Record<string, string>> = Object.fromEntries(
        models.map((model) => [model, model]),
      ),
    ): OrcaWorkerProviderSnapshot => ({
      id: 'xd',
      name: 'Cindy AI',
      models,
      registryIdentityByModel,
    });
    const customProvider = (models: string[] = [shortId]): OrcaWorkerProviderSnapshot => ({
      id: 'deepseek',
      name: 'DeepSeek',
      models,
      requiresExplicitRoute: true,
    });
    const workerParams = (
      overrides: Partial<OrcaWorkerCreateParams> = {},
    ): OrcaWorkerCreateParams => ({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      ...overrides,
    });
    const leadWithLegacyModel = (providerId: string | null) => ({
      id: 'lead-1',
      agentKind: 'codex' as const,
      workspaceKind: 'project' as const,
      workingDir: 'C:\\repo',
      model: shortId,
      effort: 'high',
      permissionMode: 'default',
      fastMode: false,
      providerId,
      remoteHostId: null,
    });
    const aliasHarness = (options: {
      agent?: AgentKind;
      providers?: OrcaWorkerProviderSnapshot[];
      availableModels?: OrcaWorkerModelCapabilities[];
      overrides?: Partial<OrcaWorkerCreationDeps>;
    } = {}) => {
      const agent = options.agent ?? 'codex';
      return createDeps({
        getAvailableModels: vi.fn(() => options.availableModels ?? modelCapabilities),
        getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
          [agent]: options.providers ?? [managedProvider()],
        })),
        ...options.overrides,
      });
    };
    const expectNoCreationState = (deps: OrcaWorkerCreationDeps): void => {
      expect(deps.reserveWorkerCreation).not.toHaveBeenCalled();
      expect(deps.bootstrapSession).not.toHaveBeenCalled();
      expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
    };

    it('keeps an exact managed canonical ID unchanged', async () => {
      const { deps, service } = aliasHarness();

      await expect(service.createWorker(workerParams({
        model: canonicalId,
      }))).resolves.toMatchObject({
        ok: true,
        resolved: { model: canonicalId },
      });

      expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
        model: canonicalId,
      }));
    });

    it.each(['codex', 'claude-code'] as const)(
      'maps a unique short ID to the managed canonical ID for %s workers',
      async (agent) => {
        const { deps, service } = aliasHarness({
          agent,
          // Gateway capabilities only advertise the managed canonical ID in the real regression.
          availableModels: [canonicalModelCapabilities],
        });

        await expect(service.createWorker(workerParams({
          agent,
          model: shortId,
        }))).resolves.toMatchObject({
          ok: true,
          resolved: { model: canonicalId },
        });

        expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
          agentKind: agent,
          model: canonicalId,
        }));
      },
    );

    it('keeps a Custom Provider short ID unchanged', async () => {
      const { deps, service } = aliasHarness({
        providers: [managedProvider(), customProvider()],
      });

      await expect(service.createWorker(workerParams({
        model: shortId,
        providerId: 'deepseek',
      }))).resolves.toMatchObject({
        ok: true,
        resolved: { model: shortId, providerId: 'deepseek' },
      });

      expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
        model: shortId,
        providerId: 'deepseek',
      }));
    });

    it('prefers an exact connected short ID over a managed alias candidate', async () => {
      const { deps, service } = aliasHarness({
        providers: [managedProvider(), customProvider()],
      });

      await expect(service.createWorker(workerParams({
        model: shortId,
      }))).resolves.toMatchObject({
        ok: true,
        resolved: { model: shortId, providerId: 'deepseek' },
      });

      expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
        model: shortId,
        providerId: 'deepseek',
      }));
    });

    it('rejects ambiguous managed canonical candidates before creating state', async () => {
      const otherCanonicalId = `mirror/${shortId}`;
      const { deps, service } = aliasHarness({
        providers: [managedProvider([canonicalId, otherCanonicalId])],
        availableModels: [
          ...modelCapabilities,
          { id: otherCanonicalId, efforts: ['high'], defaultEffort: 'high' },
        ],
      });

      await expect(service.createWorker(workerParams({
        model: shortId,
      }))).resolves.toMatchObject({
        ok: false,
        errorCode: 'INVALID_PARAMS',
        message: expect.stringContaining('ambiguous'),
      });

      expectNoCreationState(deps);
    });

    it('rejects a unique managed suffix candidate with a different catalog identity', async () => {
      const standardId = 'gpt-5.5';
      const budgetId = 'codex/gpt-5.5';
      const { deps, service } = aliasHarness({
        providers: [managedProvider(
          [budgetId],
          { [budgetId]: 'xd/codex-gpt-5.5' },
        )],
        availableModels: [
          { id: standardId, efforts: ['high'], defaultEffort: 'high' },
          { id: budgetId, efforts: ['high'], defaultEffort: 'high' },
        ],
      });

      await expect(service.createWorker(workerParams({
        model: standardId,
        providerId: 'xd',
      }))).resolves.toMatchObject({
        ok: false,
        errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
        message: expect.stringContaining(`"${standardId}"`),
      });

      expectNoCreationState(deps);
    });

    it('fails closed when an explicit non-managed provider has no exact short ID', async () => {
      const custom = { ...customProvider(['another-model']), id: 'custom', name: 'Custom' };
      const { deps, service } = aliasHarness({
        providers: [managedProvider(), custom],
      });

      await expect(service.createWorker(workerParams({
        model: shortId,
        providerId: 'custom',
      }))).resolves.toMatchObject({
        ok: false,
        errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
        message: expect.stringContaining('Custom'),
      });

      expectNoCreationState(deps);
    });

    it('does not map a managed candidate that is absent from list_available_models capabilities', async () => {
      const { deps, service } = aliasHarness({
        // list_available_models consumes this capabilities list; the resolver must not create
        // a route to a canonical ID that the same host snapshot does not advertise.
        availableModels: [modelCapabilities[0]],
      });

      await expect(service.createWorker(workerParams({
        model: shortId,
        providerId: 'xd',
      }))).resolves.toMatchObject({
        ok: false,
        errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
        message: expect.stringContaining('Cindy AI'),
      });

      expectNoCreationState(deps);
    });

    it('resolves a legacy persisted Lead model in memory without rewriting the Lead row', async () => {
      const legacyLead = leadWithLegacyModel('xd');
      const { deps, service } = aliasHarness({
        overrides: { getLeadSessionRow: vi.fn(async () => legacyLead) },
      });

      await expect(service.createWorker(workerParams())).resolves.toMatchObject({
        ok: true,
        resolved: { model: canonicalId, providerId: 'xd' },
      });

      expect(legacyLead.model).toBe(shortId);
      expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
        model: canonicalId,
        providerId: 'xd',
      }));
    });

    it('resolves an inherited legacy Worker default with the same rule as an explicit model', async () => {
      const legacyDefaults = { model: shortId, providerId: 'xd' };
      const { deps, service } = aliasHarness({
        overrides: { getWorkerDefaults: vi.fn(() => legacyDefaults) },
      });

      await expect(service.createWorker(workerParams())).resolves.toMatchObject({
        ok: true,
        resolved: { model: canonicalId, providerId: 'xd' },
      });

      expect(legacyDefaults.model).toBe(shortId);
      expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
        model: canonicalId,
        providerId: 'xd',
      }));
    });

    it('falls back from a stale default route while canonicalizing its legacy short ID', async () => {
      const legacyDefaults = { model: shortId, providerId: 'deleted-custom' };
      const { deps, service } = aliasHarness({
        overrides: { getWorkerDefaults: vi.fn(() => legacyDefaults) },
      });

      await expect(service.createWorker(workerParams())).resolves.toMatchObject({
        ok: true,
        resolved: { model: canonicalId, providerId: 'xd' },
      });

      expect(legacyDefaults).toEqual({ model: shortId, providerId: 'deleted-custom' });
      expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
        model: canonicalId,
        providerId: 'xd',
      }));
    });

    it('ignores a stale provider-only default when resolving a legacy Lead short ID', async () => {
      const legacyLead = leadWithLegacyModel('xd');
      const providerOnlyDefaults = { providerId: 'deleted-custom' };
      const { deps, service } = aliasHarness({
        overrides: {
          getLeadSessionRow: vi.fn(async () => legacyLead),
          getWorkerDefaults: vi.fn(() => providerOnlyDefaults),
        },
      });

      await expect(service.createWorker(workerParams())).resolves.toMatchObject({
        ok: true,
        resolved: { model: canonicalId, providerId: 'xd' },
      });

      expect(legacyLead.model).toBe(shortId);
      expect(providerOnlyDefaults).toEqual({ providerId: 'deleted-custom' });
      expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
        model: canonicalId,
        providerId: 'xd',
      }));
    });

    it('does not let a provider-only default override the paired Lead route when another provider offers the same model', async () => {
      const customLead = leadWithLegacyModel('deepseek');
      const otherCustom = {
        ...customProvider(),
        id: 'other-custom',
        name: 'Other Custom',
      };
      const { deps, service } = aliasHarness({
        // Default-route lookup would choose this first exact Custom route if the stale
        // provider-only default incorrectly triggered model route re-resolution.
        providers: [managedProvider(), otherCustom, customProvider()],
        overrides: {
          getLeadSessionRow: vi.fn(async () => customLead),
          getWorkerDefaults: vi.fn(() => ({ providerId: 'xd' })),
        },
      });

      await expect(service.createWorker(workerParams())).resolves.toMatchObject({
        ok: true,
        resolved: { model: shortId, providerId: 'deepseek' },
      });

      expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
        model: shortId,
        providerId: 'deepseek',
      }));
    });

    it('rejects a listed short ID when no connected provider can route it', async () => {
      const legacyLead = leadWithLegacyModel(null);
      const { deps, service } = aliasHarness({
        providers: [{ id: 'other', name: 'Other', models: ['other-model'] }],
        availableModels: [
          modelCapabilities[0],
          { id: 'other-model', efforts: ['high'], defaultEffort: 'high' },
        ],
        overrides: { getLeadSessionRow: vi.fn(async () => legacyLead) },
      });

      await expect(service.createWorker(workerParams())).resolves.toMatchObject({
        ok: false,
        errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
        message: expect.stringContaining(`"${shortId}"`),
      });

      expectNoCreationState(deps);
    });
  });

  it('rejects worker creation when the target agent has no connected provider, suggesting another agent', async () => {
    const { deps, service } = createDeps({
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [{ id: 'xd', name: 'XD Gateway', models: ['claude-sonnet-4-6'] }],
        codex: [],
      })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'NO_PROVIDER_FOR_AGENT',
      message: expect.stringContaining('Claude Code'),
    });

    // Read the Lead host to scope the catalog, but do not create any state.
    expect(deps.getLeadSessionRow).toHaveBeenCalledWith('lead-1');
    expect(deps.getWorkerDefaults).not.toHaveBeenCalled();
    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
  });

  it('rejects worker creation when no agent has a connected provider, without an agent suggestion', async () => {
    const { deps, service } = createDeps({
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({ 'claude-code': [], codex: [] })),
    });

    const result = await service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'NO_PROVIDER_FOR_AGENT' });
    if (!result.ok) {
      expect(result.message).toContain('设置 → 模型供应商');
      expect(result.message).not.toContain('改用');
    }

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND when the lead session row is missing', async () => {
    const { deps, service } = createDeps({
      getLeadSessionRow: vi.fn(async () => null),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'NOT_FOUND',
      message: 'lead session lead-1 not found',
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
  });

  it('rejects a budget Codex model when no api key is configured', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'codex/budget', providerId: null })),
      readClaudeApiKey: vi.fn((): string | null => null),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'BUDGET_MODEL_REQUIRES_API_MODE',
      message: expect.stringContaining('codex/budget'),
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
  });

  it('returns the budget-model error before explicit route fallback when the api key is missing', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.5', providerId: 'openai' })),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{ id: 'openai', name: 'OpenAI', models: ['gpt-5.5'] }],
      })),
      readClaudeApiKey: vi.fn((): string | null => null),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'codex/budget',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'BUDGET_MODEL_REQUIRES_API_MODE',
      message: expect.stringContaining('codex/budget'),
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
  });

  it('returns the budget-model error for an XD-routed default when another provider is connected', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'codex/budget', providerId: 'xd' })),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{ id: 'openai', name: 'OpenAI', models: ['gpt-5.5'] }],
      })),
      readClaudeApiKey: vi.fn((): string | null => null),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'BUDGET_MODEL_REQUIRES_API_MODE',
      message: expect.stringContaining('codex/budget'),
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
  });

  it('rejects explicit minimal effort for a Codex GPT worker at the creation boundary', async () => {
    const { deps, service } = createDeps();

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
        model: 'gpt-5.4-mini',
        effort: 'minimal',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
      message: expect.stringContaining('minimal'),
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
  });

  it('normalizes inherited minimal effort from worker defaults to low for a Codex GPT worker', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.4-mini', effort: 'minimal', fastMode: false })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: {
        model: 'gpt-5.4-mini',
        effort: 'low',
      },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.4-mini',
      effort: 'low',
    }));
  });

  it('inherits remoteHostId from a remote lead into the worker create opts', async () => {
    const { deps, service } = createDeps({
      getLeadSessionRow: vi.fn(async () => ({
        id: 'lead-1',
        agentKind: 'codex' as const,
        workspaceKind: 'project' as const,
        workingDir: '/srv/repo',
        model: 'gpt-5.5',
        effort: 'medium',
        permissionMode: 'default',
        fastMode: false,
        providerId: 'xd',
        remoteHostId: 'remote-host-1',
      })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({ ok: true });

    // remote lead 的 worker 必须在同一台远端主机 spawn,继承远端 workingDir。
    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      workingDir: '/srv/repo',
      remoteHostId: 'remote-host-1',
    }));
  });

  it('omits remoteHostId in worker create opts for a local lead', async () => {
    const { deps, service } = createDeps();

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({ ok: true });

    const arg = (deps.buildCreateOptsWithStderr as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;
    expect('remoteHostId' in arg).toBe(false);
  });

  it('inherits dialogue workspace identity and the managed cwd from its lead', async () => {
    const dialogueWorkingDir = '/app-managed/dialogues/2026-08-02/lead-1';
    const { deps, service } = createDeps({
      getLeadSessionRow: vi.fn(async () => ({
        id: 'lead-1',
        agentKind: 'codex' as const,
        workspaceKind: 'dialogue' as const,
        workingDir: dialogueWorkingDir,
        model: 'gpt-5.5',
        effort: 'medium',
        permissionMode: 'default',
        fastMode: false,
        providerId: 'xd',
        remoteHostId: null,
      })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      workspaceKind: 'dialogue',
      workingDir: dialogueWorkingDir,
    }));
  });

  it('normalizes inherited minimal effort from the lead session to low for a Codex GPT worker', async () => {
    const { deps, service } = createDeps({
      getLeadSessionRow: vi.fn(async () => ({
        id: 'lead-1',
        agentKind: 'codex' as const,
        workspaceKind: 'project' as const,
        workingDir: 'C:\\repo',
        model: 'gpt-5.4-mini',
        effort: 'minimal',
        permissionMode: 'default',
        fastMode: false,
        providerId: 'xd',
        remoteHostId: null,
      })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: {
        model: 'gpt-5.4-mini',
        effort: 'low',
      },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.4-mini',
      effort: 'low',
    }));
  });

  it('normalizes inherited max effort to xhigh when the selected model uses Codex effort names', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.4-mini', effort: 'max', fastMode: false })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: {
        model: 'gpt-5.4-mini',
        effort: 'xhigh',
      },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.4-mini',
      effort: 'xhigh',
    }));
  });

  it('cascades inherited ultra effort down to xhigh when the model tops out at xhigh (issue #352)', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.4-mini', effort: 'ultra', fastMode: false })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: {
        model: 'gpt-5.4-mini',
        // ultra 无对应档 → 级联到最高兼容档 xhigh,而不是掉回 defaultEffort(high)。
        effort: 'xhigh',
      },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.4-mini',
      effort: 'xhigh',
    }));
  });

  it('rejects explicit max effort when the selected Codex model only supports xhigh', async () => {
    const { deps, service } = createDeps();

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
        model: 'gpt-5.4-mini',
        effort: 'max',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
      message: expect.stringContaining('max'),
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
  });

  it('keeps an explicit effort for a custom model whose capabilities were never declared (#5535)', async () => {
    // 自定义来源只填了 id/name:目录与路由快照都没有档位声明,[] 只是占位而不是 valid: none。
    const model = 'custom/step-5-preview';
    const { deps, service } = createDeps({
      getAvailableModels: vi.fn((agent: AgentKind) => (
        agent === 'claude-code'
          ? [{ id: model, efforts: [], defaultEffort: null, effortsUnknown: true }]
          : [{ id: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true }]
      )),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [{
          id: 'custom-anthropic',
          name: 'Custom Anthropic Messages',
          models: [model],
          effortMetaByModel: { [model]: { efforts: [], defaultEffort: null, effortsUnknown: true } },
          requiresExplicitRoute: true,
        }],
        codex: [{ id: 'xd', name: 'XD Gateway', models: ['gpt-5.5'] }],
      })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'claude-code',
        label: 'reviewer',
        model,
        effort: 'medium',
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: { model, effort: 'medium' },
    });
    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({ model, effort: 'medium' }));
  });

  it('rejects explicit minimal effort for a Claude Code worker at the creation boundary', async () => {
    const { deps, service } = createDeps();

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'claude-code',
        label: 'reviewer',
        model: 'claude-sonnet-4-6',
        effort: 'minimal',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
      message: expect.stringContaining('minimal'),
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
  });

  it('normalizes inherited minimal effort to low for a Claude Code worker', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'claude-sonnet-4-6', effort: 'minimal' })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'claude-code',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: {
        model: 'claude-sonnet-4-6',
        effort: 'low',
      },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-sonnet-4-6',
      effort: 'low',
    }));
  });

  it('disables fast mode when the selected model capability does not support it', async () => {
    const { deps, service } = createDeps({
      getAvailableModels: vi.fn((agent: AgentKind) => (
        agent === 'codex'
          ? [{ id: 'gpt-no-fast', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', supportsFastMode: false }]
          : [{ id: 'claude-sonnet-4-6', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' }]
      )),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
        model: 'gpt-no-fast',
        fast: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: {
        model: 'gpt-no-fast',
        fastMode: false,
      },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-no-fast',
      fastMode: false,
    }));
  });

  it('honors an explicit fast request for a Pi worker on a fast-capable model', async () => {
    // Pi 也支持 Fast:显式 fast:true 必须被消费(此前两处判定只认 codex,静默丢弃)。
    // lead.fastMode 默认 false —— 若 pi 未接线,结果会退回 false,构成有效判别。
    const { deps, service } = createDeps({
      getAvailableModels: vi.fn((agent: AgentKind) => (
        agent === 'pi'
          ? [{ id: 'pi-fast-model', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', supportsFastMode: true }]
          : [{ id: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true }]
      )),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        pi: [{ id: 'xd', name: 'XD Gateway', models: ['pi-fast-model'], fastModels: ['pi-fast-model'] }],
      })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'pi',
        label: 'reviewer',
        model: 'pi-fast-model',
        fast: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: {
        model: 'pi-fast-model',
        fastMode: true,
      },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      agentKind: 'pi',
      model: 'pi-fast-model',
      fastMode: true,
    }));
  });

  it('drops an explicit fast request for a Pi worker when the model lacks Fast capability', async () => {
    const { service } = createDeps({
      getAvailableModels: vi.fn((agent: AgentKind) => (
        agent === 'pi'
          ? [{ id: 'pi-no-fast', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', supportsFastMode: false }]
          : [{ id: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true }]
      )),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        pi: [{ id: 'xd', name: 'XD Gateway', models: ['pi-no-fast'], fastModels: [] }],
      })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'pi',
        label: 'reviewer',
        model: 'pi-no-fast',
        fast: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: {
        model: 'pi-no-fast',
        fastMode: false,
      },
    });
  });

  it('keeps medium effort for a Codex GPT worker', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.4-mini', effort: 'medium', fastMode: false })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: {
        model: 'gpt-5.4-mini',
        effort: 'medium',
      },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.4-mini',
      effort: 'medium',
    }));
  });

  it('creates a worker with resolved defaults without dispatching or broadcasting from the creation boundary', async () => {
    const { calls, deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({
        model: 'gpt-5.4',
        effort: 'high',
        fastMode: true,
        providerId: 'xd',
      })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: true,
      teamId: 'team-1',
      workerId: 'worker-1',
      workerSessionId: WORKER_SESSION_ID,
      softLimitExceeded: false,
      limit: {
        workerHardLimit: 5,
        occupiedSlots: 1,
        remainingSlots: 4,
      },
    });

    expect(deps.createSessionId).toHaveBeenCalledTimes(1);
    expect(WORKER_SESSION_ID).toMatch(UUID_V4_RE);
    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      id: WORKER_SESSION_ID,
      agentKind: 'codex',
      workingDir: 'C:\\repo',
      model: 'gpt-5.4',
      providerId: 'xd',
      effort: 'high',
      fastMode: true,
      permissionMode: 'auto',
      title: 'Worker · reviewer',
      orcaRole: 'worker',
      vendorOptions: expect.objectContaining({
        orcaRole: 'worker',
        orcaWorkflowId: 'team-1',
        orcaLeadSessionId: 'lead-1',
        orcaWorkerId: 'worker-1',
        orcaWorkerSessionId: WORKER_SESSION_ID,
      }),
    }));
    expect(deps.addOrUpdateWorker).toHaveBeenCalledWith(expect.objectContaining({
      id: 'worker-1',
      teamId: 'team-1',
      sessionId: WORKER_SESSION_ID,
      status: 'idle',
      label: 'reviewer',
      role: 'reviewer',
      focused: false,
    }));
    expect(calls).toEqual([
      `bootstrapSession:${WORKER_SESSION_ID}`,
      'addOrUpdateWorker:worker-1',
      `markOrcaRoleIfNeeded:${WORKER_SESSION_ID}:worker`,
    ]);
  });

  it.each(
    (['auto', 'bypassPermissions'] as const).flatMap((workerPermissionMode) =>
      (['claude-code', 'codex', 'pi'] as const).map((workerAgent) => ({
        workerPermissionMode,
        workerAgent,
      })),
    ),
  )(
    'starts a $workerAgent Worker with the saved preference $workerPermissionMode',
    async ({ workerPermissionMode, workerAgent }) => {
      const workerModel = workerAgent === 'codex' ? 'gpt-5.5' : 'claude-sonnet-4-6';
      const { deps, service } = createDeps({
        getWorkerPermissionMode: vi.fn(() => workerPermissionMode),
        getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
          'claude-code': [{ id: 'xd', name: 'XD Gateway', models: ['claude-sonnet-4-6'] }],
          codex: [{ id: 'xd', name: 'XD Gateway', models: ['gpt-5.5'] }],
          pi: [{ id: 'xd', name: 'XD Gateway', models: ['claude-sonnet-4-6'] }],
        })),
      });

      await expect(service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: workerAgent,
        label: 'reviewer',
        model: workerModel,
        providerId: 'xd',
      })).resolves.toMatchObject({ ok: true });

      expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
        agentKind: workerAgent,
        permissionMode: workerPermissionMode,
      }));
    },
  );

  it('inherits the target-agent New Maker provider and persists it on the worker session', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({
        model: 'codex/budget',
        effort: 'high',
        fastMode: false,
        providerId: 'custom-codex',
      })),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{ id: 'custom-codex', name: 'Custom Codex', models: ['codex/budget'] }],
      })),
      readClaudeApiKey: vi.fn((): string | null => null),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: 'custom-codex', model: 'codex/budget' },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'custom-codex',
      model: 'codex/budget',
    }));
  });

  it('prefers a compatible Lead route before a cached New Maker route', async () => {
    const { deps, service } = createDeps({
      getLeadSessionRow: vi.fn(async () => ({
        id: 'lead-1',
        agentKind: 'claude-code' as const,
        workspaceKind: 'project' as const,
        workingDir: '/repo',
        model: 'claude-opus-5',
        effort: 'high',
        permissionMode: 'default',
        fastMode: false,
        providerId: 'anthropic',
        remoteHostId: null,
      })),
      getWorkerDefaults: vi.fn(() => ({
        model: 'claude-sonnet-4-6',
        providerId: 'xd',
      })),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [
          { id: 'xd', name: 'Cindy AI', models: ['claude-sonnet-4-6'] },
          {
            id: 'anthropic',
            name: 'Anthropic',
            models: ['claude-opus-5', 'claude-sonnet-4-6'],
          },
        ],
      })),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'developer',
      agent: 'claude-code',
      label: 'developer',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: 'anthropic', model: 'claude-sonnet-4-6' },
    });
    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'anthropic',
      model: 'claude-sonnet-4-6',
    }));
  });

  it.each([
    {
      name: 'trims a cached provider ID before inheriting it',
      providerId: ' custom-codex ',
      expectedProviderId: 'custom-codex',
    },
    {
      name: 'treats a whitespace-only cached provider ID as not selected',
      providerId: '   ',
      expectedProviderId: 'xd',
    },
  ])('$name', async ({ providerId, expectedProviderId }) => {
    const cachedDefaults = { model: 'gpt-5.4', providerId };
    const { deps, service } = createDeps({
      getLeadSessionRow: vi.fn(async () => ({
        id: 'lead-1',
        agentKind: 'claude-code' as const,
        workspaceKind: 'project' as const,
        workingDir: '/repo',
        model: 'claude-sonnet-4-6',
        effort: 'high',
        permissionMode: 'default',
        fastMode: false,
        providerId: 'anthropic',
        remoteHostId: null,
      })),
      getWorkerDefaults: vi.fn(() => cachedDefaults),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [
          { id: 'xd', name: 'Cindy AI', models: ['gpt-5.4'] },
          { id: 'custom-codex', name: 'Custom Codex', models: ['gpt-5.4'] },
        ],
      })),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: expectedProviderId, model: 'gpt-5.4' },
    });
    expect(cachedDefaults.providerId).toBe(providerId);
    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      providerId: expectedProviderId,
      model: 'gpt-5.4',
    }));
  });

  it('keeps the compatible Anthropic Lead route for an explicit Claude Worker model', async () => {
    const { deps, service } = createDeps({
      getLeadSessionRow: vi.fn(async () => ({
        id: 'lead-1',
        agentKind: 'claude-code' as const,
        workspaceKind: 'project' as const,
        workingDir: '/repo',
        model: 'claude-opus-5',
        effort: 'high',
        permissionMode: 'default',
        fastMode: false,
        providerId: 'anthropic',
        remoteHostId: null,
      })),
      getAvailableModels: vi.fn(() => [
        { id: 'claude-opus-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
      ]),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [
          { id: 'xd', name: 'Cindy AI', models: ['claude-opus-5'] },
          { id: 'anthropic', name: 'Anthropic', models: ['claude-opus-5'] },
        ],
      })),
    });

    const result = await service.createWorker({
      leadSessionId: 'lead-1',
      role: 'developer',
      agent: 'claude-code',
      label: 'developer',
      model: 'claude-opus-5',
    });

    expect(result).toMatchObject({
      ok: true,
      resolved: { providerId: 'anthropic', model: 'claude-opus-5' },
    });
    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'anthropic',
      model: 'claude-opus-5',
    }));
    expect(resolveAgentCredentialMode({
      agentKind: 'claude-code',
      providerId: result.ok ? result.resolved.providerId : null,
      model: result.ok ? result.resolved.model : null,
    })).toBe('oauth-bearer');
  });

  it('rejects a missing Anthropic Lead route before falling back to Cindy AI', async () => {
    const { deps, service } = createDeps({
      getLeadSessionRow: vi.fn(async () => ({
        id: 'lead-1',
        agentKind: 'claude-code' as const,
        workspaceKind: 'project' as const,
        workingDir: '/repo',
        model: 'claude-opus-5',
        effort: 'high',
        permissionMode: 'default',
        fastMode: false,
        providerId: 'anthropic',
        remoteHostId: null,
      })),
      getAvailableModels: vi.fn(() => [
        { id: 'claude-opus-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
      ]),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [{ id: 'xd', name: 'Cindy AI', models: ['claude-opus-5'] }],
      })),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'developer',
      agent: 'claude-code',
      label: 'developer',
      model: 'claude-opus-5',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
      message: expect.stringContaining('"anthropic" 当前未连接'),
    });
    expect(deps.reserveWorkerCreation).not.toHaveBeenCalled();
    expect(deps.bootstrapSession).not.toHaveBeenCalled();
  });

  it('persists the current native route when a stale New Maker provider falls back', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.4', providerId: 'deleted-custom' })),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{ id: 'xd', name: 'XD Gateway', models: ['gpt-5.4'] }],
      })),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: 'xd', model: 'gpt-5.4' },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'xd',
      model: 'gpt-5.4',
    }));
  });

  it('falls back from a stale New Maker provider to a sole custom credential route', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.4', providerId: 'deleted-custom' })),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{
          id: 'current-custom',
          name: 'Current Custom',
          models: ['gpt-5.4'],
          requiresExplicitRoute: true,
        }],
      })),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: 'current-custom', model: 'gpt-5.4' },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'current-custom',
      model: 'gpt-5.4',
    }));
  });

  it('persists the current native route for a model-only legacy default', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.5' })),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: 'xd', model: 'gpt-5.5' },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'xd',
    }));
  });

  it('routes a model-only legacy default through another connected provider', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.4' })),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [
          { id: 'xd', name: 'XD Gateway', models: ['gpt-5.5'] },
          {
            id: 'current-custom',
            name: 'Current Custom',
            models: ['gpt-5.4'],
            requiresExplicitRoute: true,
          },
        ],
      })),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: 'current-custom', model: 'gpt-5.4' },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'current-custom',
      model: 'gpt-5.4',
    }));
  });

  it('pins the sole runtime provider when only the worker model is explicit', async () => {
    const availability = {
      'claude-code': [],
      codex: [
        { id: 'custom-codex', name: 'Custom Codex', models: ['gpt-5.5'] },
        { id: 'xd', name: 'XD Gateway', models: ['gpt-5.4'] },
      ],
      pi: [],
    } satisfies Record<AgentKind, OrcaWorkerProviderSnapshot[]>;
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.5', providerId: 'custom-codex' })),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext(availability)),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'gpt-5.4',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: 'xd', model: 'gpt-5.4' },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'xd',
      model: 'gpt-5.4',
    }));
  });

  it('uses the sole XD catalog route for an explicit DeepSeek model instead of Codex native auth', async () => {
    const model = 'deepseek/deepseek-v4-pro';
    const { deps, service } = createDeps({
      getAvailableModels: vi.fn(() => [
        { id: model, efforts: ['high'], defaultEffort: 'high', supportsFastMode: false },
      ]),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{
          id: 'xd',
          name: 'XD Gateway',
          models: [model],
          // gateway-key 不属于 requiresExplicitRoute；唯一来源仍必须固化。
          requiresExplicitRoute: false,
        }],
      })),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'developer',
      agent: 'codex',
      label: 'deepseek_worker',
      model,
    })).resolves.toMatchObject({
      ok: true,
      resolved: { model, providerId: 'xd' },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      model,
      providerId: 'xd',
    }));
  });

  it('persists the sole custom route when an explicit worker model requires session credentials', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.5', providerId: 'xd' })),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{
          id: 'custom-codex',
          name: 'Custom Codex',
          models: ['gpt-5.4'],
          requiresExplicitRoute: true,
        }],
      })),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'gpt-5.4',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: 'custom-codex', model: 'gpt-5.4' },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'custom-codex',
      model: 'gpt-5.4',
    }));
  });

  it('does not require a Cindy API key for an explicit budget model on a custom route', async () => {
    const { deps, service } = createDeps({
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{
          id: 'custom-codex',
          name: 'Custom Codex',
          models: ['codex/budget'],
          requiresExplicitRoute: true,
        }],
      })),
      readClaudeApiKey: vi.fn((): string | null => null),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'codex/budget',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: 'custom-codex', model: 'codex/budget' },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'custom-codex',
      model: 'codex/budget',
    }));
  });

  it('returns a route-specific error when no connected provider offers an explicit worker model', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.5', providerId: 'custom-codex' })),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{ id: 'custom-codex', name: 'Custom Codex', models: ['gpt-5.5'] }],
      })),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'gpt-5.4',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
      message: expect.stringContaining('没有已连接的供应商提供模型 "gpt-5.4"'),
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
  });

  it('rejects a stale cached provider when no current source offers its model', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.4', providerId: 'custom-codex' })),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{ id: 'custom-codex', name: 'Custom Codex', models: ['gpt-5.5'] }],
      })),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
      message: expect.stringContaining('没有已连接的供应商提供模型 "gpt-5.4"'),
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
  });

  it('reports soft-limit overflow while still creating the worker', async () => {
    const { deps, service } = createDeps({
      readCollaborationSettings: vi.fn(() => ({ workerSoftLimit: 1, workerHardLimit: 3 })),
      listWorkersByLead: vi.fn(async () => [{ id: 'worker-existing', label: 'existing', status: workerStatus('idle') }]),
      reserveWorkerCreation: vi.fn(async () => ({ ok: true as const, occupiedSlotsBefore: 1 })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: true,
      softLimitExceeded: true,
    });

    expect(deps.bootstrapSession).toHaveBeenCalledTimes(1);
    expect(deps.addOrUpdateWorker).toHaveBeenCalledTimes(1);
  });

  it('maps credential busy during worker bootstrap to BUSY without creating a worker row', async () => {
    const { deps, service } = createDeps({
      bootstrapSession: vi.fn(async () => {
        throw new CredentialModeSwitchBusyError(['busy-session']);
      }),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'BUSY',
    });

    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
    expect(deps.markOrcaRoleIfNeeded).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
  });

  it('archives a bootstrapped worker session when persistence fails', async () => {
    const { calls, deps, service } = createDeps({
      addOrUpdateWorker: vi.fn(async () => {
        calls.push('addOrUpdateWorker:throw');
        throw new Error('insert failed');
      }),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INTERNAL',
      message: 'insert failed',
    });

    expect(calls).toEqual([
      `bootstrapSession:${WORKER_SESSION_ID}`,
      'addOrUpdateWorker:throw',
      `closeWorkerSession:${WORKER_SESSION_ID}`,
      `forgetWorkerSession:${WORKER_SESSION_ID}`,
      `archiveWorkerSession:${WORKER_SESSION_ID}`,
    ]);
    expect(deps.markOrcaRoleIfNeeded).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
  });

  it('recognizes SQLite expression-index conflicts regardless of quote style', async () => {
    const { deps, service } = createDeps({
      addOrUpdateWorker: vi.fn(async () => {
        throw new Error("UNIQUE constraint failed: index 'uniq_orca_workers_team_label'");
      }),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'DUPLICATE_LABEL',
    });

    expect(deps.archiveWorkerSession).toHaveBeenCalledWith(WORKER_SESSION_ID);
  });

  it('removes the worker link when role marking fails after persistence', async () => {
    const { calls, deps, service } = createDeps({
      markOrcaRoleIfNeeded: vi.fn(async () => {
        calls.push('markOrcaRoleIfNeeded:throw');
        throw new Error('role failed');
      }),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INTERNAL',
      message: 'role failed',
    });

    expect(calls).toEqual([
      `bootstrapSession:${WORKER_SESSION_ID}`,
      'addOrUpdateWorker:worker-1',
      'markOrcaRoleIfNeeded:throw',
      `closeWorkerSession:${WORKER_SESSION_ID}`,
      `forgetWorkerSession:${WORKER_SESSION_ID}`,
      `archiveWorkerSession:${WORKER_SESSION_ID}`,
      'removeWorker:worker-1',
    ]);
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
  });
});

describe('buildNoProviderMessage', () => {
  it('suggests the other agent when it has a connected provider', () => {
    const msg = buildNoProviderMessage('codex', {
      'claude-code': [{ id: 'xd', name: 'XD Gateway', models: ['claude-sonnet-4-6'] }],
      pi: [],
      codex: [],
    });
    expect(msg).toContain('Codex 当前没有可用的模型供应商');
    expect(msg).toContain('改用');
    expect(msg).toContain('Claude Code(已连接:XD Gateway)');
  });

  it('omits the agent suggestion when no agent has a connected provider', () => {
    const msg = buildNoProviderMessage('claude-code', { 'claude-code': [], codex: [], pi: [] });
    expect(msg).toContain('Claude Code 当前没有可用的模型供应商');
    expect(msg).toContain('设置 → 模型供应商');
    expect(msg).not.toContain('改用');
  });

  it('honors an explicit panel-selected provider over the forced default route', async () => {
    const { deps, service } = createDeps({
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [
          { id: 'xd', name: 'XD Gateway', models: ['gpt-5.5'] },
          { id: 'openai', name: 'OpenAI', models: ['gpt-5.5'] },
        ],
      })),
    });

    // 显式 model 且未显式来源时既有语义是强制默认路由(providerId=null);
    // 标准面板显式选定来源后必须原样生效,不再被强制回落。
    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'gpt-5.5',
      providerId: 'openai',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: 'openai', model: 'gpt-5.5' },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'openai',
      model: 'gpt-5.5',
    }));
  });

  it('treats an empty-string providerId as not-explicit and pins a sole runtime source', async () => {
    const { service } = createDeps();

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'gpt-5.5',
      providerId: '',
    })).resolves.toMatchObject({
      ok: true,
      // 空串仍按未显式处理；唯一可用来源由运行时目录解析,不按模型名写死。
      resolved: { providerId: 'xd', model: 'gpt-5.5' },
    });
  });

  it('resolves Fast from the explicit provider catalog entry, not the flattened union', async () => {
    // gpt-5.5 在 xd(拍平清单首来源,不支持 Fast)与 openai(支持)都有:显式选 openai
    // 时 Fast 必须按 openai 自己的条目放行,不被拍平首来源误杀;反向显式选 xd 时压掉。
    const routing = () => providerRoutingContext({
      'claude-code': [],
      codex: [
        { id: 'xd', name: 'XD Gateway', models: ['gpt-5.5'], fastModels: [] },
        { id: 'openai', name: 'OpenAI', models: ['gpt-5.5'], fastModels: ['gpt-5.5'] },
      ],
    });
    const supportsFastByUnion = (supported: boolean) => vi.fn((agent: AgentKind) => (
      agent === 'codex'
        ? [{ id: 'gpt-5.5', efforts: ['high'], defaultEffort: 'high', supportsFastMode: supported }]
        : []
    ));

    const enabled = createDeps({
      getProviderRoutingContext: vi.fn(async () => routing()),
      // 拍平清单说不支持(首来源 xd wins)——显式 openai 仍应放行。
      getAvailableModels: supportsFastByUnion(false),
    });
    await expect(enabled.service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'gpt-5.5',
      providerId: 'openai',
      fast: true,
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: 'openai', fastMode: true },
    });

    const suppressed = createDeps({
      getProviderRoutingContext: vi.fn(async () => routing()),
      // 拍平清单说支持(假设首来源换位)——显式 xd 不支持,必须压掉。
      getAvailableModels: supportsFastByUnion(true),
    });
    await expect(suppressed.service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'gpt-5.5',
      providerId: 'xd',
      fast: true,
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: 'xd', fastMode: false },
    });
  });

  it('normalizes effort against the explicit provider catalog entry, not the flattened union', async () => {
    // gpt-5.5 的拍平首见条目只有 medium 档,而显式来源 openai 的同 id 条目支持
    // low/medium/high:explicit effort=high 必须按 openai 自己的元数据放行,不被
    // 拍平条目在 resolveWorkerConfig 内 error 早退误拒(codex review)。
    const { service } = createDeps({
      getAvailableModels: vi.fn((agent: AgentKind) => (
        agent === 'codex'
          ? [{ id: 'gpt-5.5', efforts: ['medium'], defaultEffort: 'medium', supportsFastMode: false }]
          : []
      )),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [
          { id: 'xd', name: 'XD Gateway', models: ['gpt-5.5'] },
          {
            id: 'openai',
            name: 'OpenAI',
            models: ['gpt-5.5'],
            effortMetaByModel: {
              'gpt-5.5': { efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
            },
          },
        ],
      })),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'gpt-5.5',
      providerId: 'openai',
      effort: 'high',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: 'openai', effort: 'high' },
    });
  });

  it('rejects efforts the explicit no-effort provider copy does not support and defaults to null', async () => {
    // 自定义来源的 gpt-5.5 副本无 effort 档(efforts:[]):explicit effort 必须按该
    // 来源条目拒绝,不能沿用拍平首见条目的档位表放行;非显式输入则落该来源的
    // defaultEffort(null),不带着拍平归一出的档位派发(codex review)。
    const routing = () => providerRoutingContext({
      'claude-code': [],
      codex: [
        { id: 'xd', name: 'XD Gateway', models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'codex/budget'] },
        {
          id: 'custom',
          name: 'Custom Gateway',
          models: ['gpt-5.5'],
          effortMetaByModel: { 'gpt-5.5': { efforts: [], defaultEffort: null } },
        },
      ],
    });

    const rejected = createDeps({ getProviderRoutingContext: vi.fn(async () => routing()) });
    await expect(rejected.service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'gpt-5.5',
      providerId: 'custom',
      effort: 'high',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
    });

    const defaulted = createDeps({ getProviderRoutingContext: vi.fn(async () => routing()) });
    await expect(defaulted.service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'gpt-5.5',
      providerId: 'custom',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: 'custom', effort: null },
    });
  });

  it('allows an explicit effort the flattened descriptor lacks when the route provider supports it', async () => {
    // 拍平首见条目(可能来自已断开来源,不含连接态)缺 xhigh,而实际路由来源
    // (未显式时的生效默认来源)支持:explicit effort 不得在首次归一处 error 早退,
    // 暂存后由路由来源档位表裁决放行(codex review)。
    const { service } = createDeps({
      getAvailableModels: vi.fn((agent: AgentKind) => (
        agent === 'codex'
          ? [{ id: 'gpt-5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', supportsFastMode: false }]
          : []
      )),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{
          id: 'xd',
          name: 'XD Gateway',
          models: ['gpt-5.5'],
          effortMetaByModel: {
            'gpt-5.5': { efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
          },
        }],
      })),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'gpt-5.5',
      effort: 'xhigh',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { model: 'gpt-5.5', effort: 'xhigh' },
    });
  });

  it('surfaces the flattened rejection when the route provider carries no effort metadata', async () => {
    // 路由来源无 effort 元数据(旧组装方)时没有更权威的档位表:explicit 无效输入
    // 的暂存拒绝按拍平条目落地,不静默吞掉派发 null(行为与重构前一致)。
    const { service } = createDeps();

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'gpt-5.5',
      effort: 'ultra',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
    });
  });

  it('renormalizes effort against the default route provider when no explicit source is set', async () => {
    // 未显式选来源时实际路由来源是 lead/defaults 解析出的 xd:其 gpt-5.5 条目只有
    // low 档,lead effort=medium 按拍平条目(四档)归一原样通过,必须再按路由来源
    // 条目重归一落到该来源的 defaultEffort(codex review;与 Fast 的路由来源口径一致)。
    const { service } = createDeps({
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{
          id: 'xd',
          name: 'XD Gateway',
          models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'codex/budget'],
          effortMetaByModel: { 'gpt-5.5': { efforts: ['low'], defaultEffort: 'low' } },
        }],
      })),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { model: 'gpt-5.5', effort: 'low' },
    });
  });

  it('rejects an explicit provider that does not offer the requested model', async () => {
    const { deps, service } = createDeps({
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [
          { id: 'xd', name: 'XD Gateway', models: ['gpt-5.5'] },
          { id: 'openai', name: 'OpenAI', models: ['gpt-5.4'] },
        ],
      })),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'gpt-5.5',
      providerId: 'openai',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
    });
    expect(deps.bootstrapSession).not.toHaveBeenCalled();
  });

  it('does not demand the gateway API key for a budget model on an explicit non-gateway route', async () => {
    const { service } = createDeps({
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{ id: 'custom-codex', name: 'Custom Codex', models: ['codex/budget'] }],
      })),
      readClaudeApiKey: vi.fn((): string | null => null),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'codex/budget',
      providerId: 'custom-codex',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: 'custom-codex', model: 'codex/budget' },
    });
  });
});

describe('SSH remote worker model/provider compatibility gate (R23 P2)', () => {
  const remoteLeadRow = {
    id: 'lead-1',
    agentKind: 'codex' as const,
    workspaceKind: 'project' as const,
    workingDir: '/srv/repo',
    model: 'gpt-5.5',
    effort: 'medium',
    permissionMode: 'default',
    fastMode: false,
    providerId: 'xd',
    remoteHostId: 'remote-host-1',
  };

  it('rejects subscription-direct models for a remote lead (they require the local proxy path)', async () => {
    const { service } = createDeps({
      getLeadSessionRow: vi.fn(async () => remoteLeadRow),
      getAvailableModels: vi.fn(() => [
        { id: 'chatgpt/gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
      ]),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{ id: 'chatgpt', name: 'ChatGPT Subscription', models: ['chatgpt/gpt-5.5'] }],
      })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
        model: 'chatgpt/gpt-5.5',
        providerId: 'chatgpt',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
      message: expect.stringContaining('not available for SSH remote workers'),
    });
  });

  it.each([['deepseek', 'codex'], ['user-openai-account', 'codex'], ['user-claude-account', 'pi']] as const)('rejects local-only source %s/%s before allocating a remote worker', async (providerId, agent) => {
    const { service, deps } = createDeps({
      getLeadSessionRow: vi.fn(async () => remoteLeadRow),
      getAvailableModels: vi.fn(() => [
        { id: 'deepseek-v4', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
      ]),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        [agent]: [{ id: providerId, name: providerId, models: ['deepseek-v4'], localOnlyForSsh: true }],
      })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent,
        label: 'reviewer',
        model: 'deepseek-v4',
        providerId,
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
      message: expect.stringContaining('not available for SSH remote workers'),
    });
    expect(deps.createSessionId).not.toHaveBeenCalled();
  });

  it('still allows SSH-compatible models for a remote lead', async () => {
    const { service } = createDeps({
      getLeadSessionRow: vi.fn(async () => remoteLeadRow),
    });
    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('allows Pi workers for a remote lead (pi SSH remote runtime landed — round 42)', async () => {
    // 轮 42:原闸(pi sessions are local-only)写于 Pi SSH remote 能力落地前;
    // 现 remote pi 全链路可用,worker 继承 lead.remoteHostId 走通用 remote 路径,
    // preflight 不再拒绝,直接进 bootstrap。
    const { service, deps } = createDeps({
      getLeadSessionRow: vi.fn(async () => remoteLeadRow),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{ id: 'xd', name: 'XD Gateway', models: ['gpt-5.5'] }],
        pi: [{ id: 'xd', name: 'XD Gateway', models: ['claude-sonnet-4-6'] }],
      })),
    });
    const result = await service.createWorker({
      leadSessionId: 'lead-1',
      role: 'developer',
      agent: 'pi',
      label: 'pi-dev',
    });
    expect(result).toMatchObject({ ok: true });
    // worker bootstrap 继承 lead 的 remoteHostId + workingDir(同远端主机 spawn)。
    expect(deps.bootstrapSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentKind: 'pi',
        remoteHostId: 'remote-host-1',
        workingDir: '/srv/repo',
        orcaRole: 'worker',
      }),
    );
  });
});

  it('rejects chat-bridged providers resolved through the default route (no explicit providerId)', async () => {
    // R23 P2 回归:resolved.providerId 为 null (默认路由) 时, 兼容闸必须
    // 仍按 budgetRouteProviderId 解析出的实际落点判定 — 只查显式选择会漏。
    const { service } = createDeps({
      getLeadSessionRow: vi.fn(async () => ({
        id: 'lead-1',
        agentKind: 'codex' as const,
        workspaceKind: 'project' as const,
        workingDir: '/srv/repo',
        model: 'gpt-5.5',
        effort: 'medium',
        permissionMode: 'default',
        fastMode: false,
        providerId: 'deepseek',
        remoteHostId: 'remote-host-1',
      })),
      getAvailableModels: vi.fn(() => [
        { id: 'deepseek-v4', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
      ]),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{ id: 'deepseek', name: 'DeepSeek', models: ['deepseek-v4'], localOnlyForSsh: true }],
      })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
        model: 'deepseek-v4',
        // 不传 providerId — 走默认路由解析到 deepseek (chatBridged)。
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
      message: expect.stringContaining('not available for SSH remote workers'),
    });
  });

  it('rejects chat-bridged providers resolved for an inherited (lead) model with no explicit worker model/provider (R24 P2)', async () => {
    // R24 P2 回归:worker 不传 model/provider 时 resolved.providerId 与
    // budgetRouteProviderId 均为 null — 兼容闸必须按 routeProviderId
    // (resolveDefaultProviderIdForModel 解析的实际落点) 判定。
    const { service } = createDeps({
      getLeadSessionRow: vi.fn(async () => ({
        id: 'lead-1',
        agentKind: 'codex' as const,
        workspaceKind: 'project' as const,
        workingDir: '/srv/repo',
        model: 'deepseek-v4',
        effort: 'medium',
        permissionMode: 'default',
        fastMode: false,
        providerId: 'deepseek',
        remoteHostId: 'remote-host-1',
      })),
      getAvailableModels: vi.fn(() => [
        { id: 'deepseek-v4', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
      ]),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{ id: 'deepseek', name: 'DeepSeek', models: ['deepseek-v4'], localOnlyForSsh: true }],
      })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
        // 不传 model / providerId — 继承 lead 的 deepseek-v4 + 默认路由。
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
      message: expect.stringContaining('not available for SSH remote workers'),
    });
  });

it('applies plan limit in atomic reservation',async()=>{const {deps,service}=createDeps({validateCreationPlan:vi.fn(async()=>2)});await service.createWorker({leadSessionId:'lead-1',role:'eval',agent:'codex',label:'sample'});expect(deps.reserveWorkerCreation).toHaveBeenCalledWith(expect.objectContaining({hardLimit:2}));});
it('uses one canonical label at every plan check without mutating the caller', async () => {
  const validateCreationPlan = vi.fn(async (_params: OrcaWorkerCreateParams) => 2);
  const { service } = createDeps({ validateCreationPlan });
  const params = Object.freeze({ leadSessionId: 'lead-1', teamId: 'team-1', role: 'eval', agent: 'codex' as const, label: ' SAMPLE ', workerPermissionMode: 'auto' as const });
  await expect(service.createWorkerInTeam(params)).resolves.toMatchObject({ ok: true });
  expect(validateCreationPlan).toHaveBeenCalledTimes(5);
  for (const call of validateCreationPlan.mock.calls) expect(call[0]).toMatchObject({ label: 'sample' });
  expect(params.label).toBe(' SAMPLE ');
});
it('rejects invalid plan before reservation',async()=>{const {deps,service}=createDeps({validateCreationPlan:vi.fn(async()=>{throw Error('not pending');})});await expect(service.createWorker({leadSessionId:'lead-1',role:'eval',agent:'codex',label:'sample'})).rejects.toThrow('not pending');expect(deps.reserveWorkerCreation).not.toHaveBeenCalled();expect(deps.bootstrapSession).not.toHaveBeenCalled();});
it('revalidates a plan registered during creation preflight and releases the reservation on rejection', async () => {
  let reserved = false;
  const {deps, service} = createDeps({validateCreationPlan: vi.fn(async () => {
    if (reserved) throw new Error('Worker not in newly registered plan');
    return undefined;
  })});
  const reserve = deps.reserveWorkerCreation;
  deps.reserveWorkerCreation = vi.fn(async input => { const result = await reserve(input); reserved = true; return result; });
  await expect(service.createWorker({leadSessionId: 'lead-1', role: 'eval', agent: 'codex', label: 'sample'})).rejects.toThrow('newly registered plan');
  expect(deps.bootstrapSession).not.toHaveBeenCalled();
  expect(deps.releaseWorkerCreationReservation).toHaveBeenCalledTimes(1);
});
it('checks the resolved creation directory before bootstrap and releases a rejected reservation', async () => {
  const resolved = path.resolve('resolved-candidate');
  const validateCreationPlan = vi.fn(async (_params, directory?: string) => {
    if (directory !== undefined && validateCreationPlan.mock.calls.length >= 3) throw new Error('Directory authorization revoked');
    return undefined;
  });
  const {deps, service} = createDeps({validateCreationPlan, resolveWorkerWorkingDir: vi.fn(async () => resolved)});
  const params = {leadSessionId:'lead-1',role:'eval',agent:'codex' as const,label:'sample',workingDir:path.resolve('candidate')};
  await expect(service.createWorker(params)).rejects.toThrow('Directory authorization revoked');
  expect(validateCreationPlan).toHaveBeenLastCalledWith(expect.objectContaining(params), resolved, expect.objectContaining({ model: 'gpt-5.5', providerId: 'xd' }), undefined);
  expect(deps.bootstrapSession).not.toHaveBeenCalled();
  expect(deps.releaseWorkerCreationReservation).toHaveBeenCalledTimes(1);
});

describe('production plugin Auto admission after reservation', () => {
  const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');
  const helper = source.slice(source.indexOf('  const assertPluginWorkerAutoAuthorized ='), source.indexOf('  const orcaWorkerCreationService ='));
  const callback = source.slice(source.indexOf('    validateCreationPlan: async ('), source.indexOf('    getLeadSessionRow: async (leadSessionId) => {'));
  const js = ts.transpileModule(`${helper}\nreturn ({${callback}}).validateCreationPlan;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const override = source.slice(source.indexOf('    getWorkerPermissionModeOverride: async (leadSessionId) => {'), source.indexOf('    setWorkerPermissionMode: applyWorkerPermissionModePreference,'));
  const overrideJs = ts.transpileModule(`${helper}\nreturn ({${override}}).getWorkerPermissionModeOverride;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

  it.each([false, true].flatMap(planned => ['bootstrap', 'renewal'].flatMap(stage =>
    ['disabled', 'uninstalled', 'reinstalled', 'account', 'owner', 'missing', 'downgraded', 'plan', 'archived', 'storage', 'healthy'].map(change => ({ planned, stage, change })),
  )))('rechecks $change after $stage with planned=$planned before persistence and dispatch', async ({ planned, stage, change }) => {
    let epoch = { client: {} };
    let enabled = true, missing = false, storageFailed = false;
    const task = { revision: 1, status: 'active', permissionMode: 'auto', planModeEnabled: false, workingDir: path.resolve('repo') };
    const receipt = { pluginId: 'plugin', operation: 'create', payload: JSON.stringify(planned ? {
      teamPlan: { concurrency: 2, items: [{ label: 'sample', workingDir: task.workingDir,
        route: { agentKind: 'codex', model: 'gpt-5.5', providerId: 'xd', effort: 'medium', fastMode: false } }] },
    } : {}) };
    const callbackDeps = {
      maker: {getSession:()=>null}, inputCoordinator: { getAcceptedInputProvenance: () => null },
      readPluginTaskPlanReceipt: JSON.parse, assertPluginWorkerDirectoryScope, getCurrentDbClientSnapshot: () => epoch,
      createPluginTaskStore: () => ({ get: async () => {
        if (storageFailed) throw new Error('storage unavailable');
        return missing ? null : structuredClone(receipt);
      } }),
      pluginTaskServiceForCurrentOwner: () => ({ get: async () => {
        if (JSON.parse(receipt.payload).ownershipRevoked) throw new PluginTaskError('TASK_NOT_FOUND', 'Not owned');
        return { ...task };
      } }),
      readPluginTaskConfig: () => ({ permissionMode: 'auto', workingDir: task.workingDir }),
      isPluginTaskAuthorized: () => enabled,
      resolvePluginWorkerDirectory: async () => task.workingDir,
      isGhostPickedDir: () => false, PluginTaskError,
    };
    const validateCreationPlan = new Function(...Object.keys(callbackDeps), js)(...Object.values(callbackDeps));
    const { deps, service } = createDeps({ validateCreationPlan });
    const mutate = () => {
      if (change === 'disabled') enabled = false;
      if (['uninstalled', 'reinstalled'].includes(change)) {
        receipt.payload = JSON.stringify({ ...JSON.parse(receipt.payload), ownershipRevoked: true });
        enabled = change === 'reinstalled';
      }
      if (change === 'account') epoch = { client: {} };
      if (change === 'owner') receipt.pluginId = 'other-plugin';
      if (change === 'missing') missing = true;
      if (change === 'downgraded') task.permissionMode = 'default';
      if (change === 'plan') task.planModeEnabled = true;
      if (change === 'archived') task.status = 'archived';
      if (change === 'storage') storageFailed = true;
    };
    const bootstrap = deps.bootstrapSession;
    deps.bootstrapSession = vi.fn(async opts => { const result = await bootstrap(opts); if (stage === 'bootstrap') mutate(); return result; });
    deps.renewWorkerCreationReservation = vi.fn(async () => { if (stage === 'renewal') mutate(); return true; });
    const markTeamEnded = vi.fn(async () => undefined);
    const getWorkerPermissionModeOverride = new Function('hasAcceptedUserTaskInput', ...Object.keys(callbackDeps), overrideJs)(hasAcceptedUserTaskInput, ...Object.values(callbackDeps));
    const lifecycle = createOrcaLifecycleService({
      getWorkerPermissionModeOverride,
      getActiveTeamByLead: async () => planned ? null : { id: 'team-1', leadSessionId: 'lead-1' },
      createActiveTeam: async () => ({ id: 'team-1', leadSessionId: 'lead-1' }),
      isOrphanedTeamInit: async () => false, getWorkerPermissionMode: () => 'auto',
      setWorkerPermissionMode: vi.fn(), createWorkerInTeam: service.createWorkerInTeam,
      dispatchWorkerTask: deps.dispatchWorkerTask, markTeamEnded, setSessionOrcaRole: vi.fn(async () => undefined),
      clearKnownNonOrcaSession: vi.fn(), setLeadVendorOptions: vi.fn(async () => undefined), clearLeadVendorOptions: vi.fn(async () => undefined),
      sendWorkerReadyPlaceholder: vi.fn(async () => undefined), rollbackCreatedWorker: vi.fn(async () => undefined),
      broadcastSessionCreated: deps.broadcastSessionCreated, broadcastOrcaWorkerChanged: deps.broadcastOrcaWorkerChanged,
    });
    const result = planned
      ? await lifecycle.enableTeam({ leadSessionId: 'lead-1', workerAgent: 'codex', role: 'eval', label: 'sample', delegateTask: 'Evaluate sample' })
      : await lifecycle.createWorker({ leadSessionId: 'lead-1', agent: 'codex', role: 'eval', label: 'sample', initialTask: 'Evaluate sample' });
    expect(deps.bootstrapSession).toHaveBeenCalledOnce();
    expect(deps.releaseWorkerCreationReservation).toHaveBeenCalledOnce();
    if (change === 'healthy') {
      expect(result.ok).toBe(true);
      expect(deps.addOrUpdateWorker).toHaveBeenCalledOnce();
      expect(deps.dispatchWorkerTask).toHaveBeenCalledOnce();
      expect(deps.closeWorkerSession).not.toHaveBeenCalled();
    } else {
      expect(result).toMatchObject({ ok: false, errorCode: 'INTERNAL' });
      expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
      expect(deps.markOrcaRoleIfNeeded).not.toHaveBeenCalled();
      expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
      for (const cleanup of [deps.closeWorkerSession, deps.forgetWorkerSession, deps.archiveWorkerSession]) {
        expect(cleanup).toHaveBeenCalledExactlyOnceWith(WORKER_SESSION_ID);
      }
      if (planned) expect(markTeamEnded).toHaveBeenCalledExactlyOnceWith('team-1', 'failed');
    }
  });

  it.each(['uninstalled', 'reinstalled', 'malformed'])('keeps ordinary Worker creation separate from %s plugin receipts', async state => {
    const epoch = { client: {} }, get = vi.fn(async () => { throw new PluginTaskError('TASK_NOT_FOUND', 'Not owned'); });
    const callbackDeps = { getCurrentDbClientSnapshot: () => epoch, PluginTaskError, assertPluginWorkerDirectoryScope,
      createPluginTaskStore: () => ({ get: async () => ({ operation: 'create', pluginId: 'plugin', payload: state === 'malformed' ? '{' : JSON.stringify({ ownershipRevoked: true, teamPlan: { items: [] } }) }) }),
      pluginTaskServiceForCurrentOwner: () => ({ get }), isPluginTaskAuthorized: () => state === 'reinstalled',
      readPluginTaskConfig: () => ({ permissionMode: 'auto' }),
    };
    const validateCreationPlan = new Function(...Object.keys(callbackDeps), js)(...Object.values(callbackDeps));
    const { deps, service } = createDeps({ validateCreationPlan });
    const result = service.createWorker({ leadSessionId: 'lead-1', role: 'worker', label: 'sample', agent: 'codex' });
    if (state === 'malformed') {
      await expect(result).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
      expect(deps.bootstrapSession).not.toHaveBeenCalled();
    } else {
      await expect(result).resolves.toMatchObject({ ok: true });
      expect(get).not.toHaveBeenCalled();
      expect(deps.bootstrapSession).toHaveBeenCalledOnce();
    }
  });

  it.each([
    ...[false, true].flatMap(planned => ['reservation', 'directory', 'receipt', 'final-task', 'task-mode', 'disabled', 'healthy', 'archive-first', 'archive-admission', 'archive-reservation', 'archive-final', 'plan-first', 'plan-reservation', 'plan-final'].map(point => ({ planned, point }))),
    ...['explicit-match', 'canonical-directory', 'different-model', 'different-directory', 'normalized-fast', 'changed-plan', 'normalized-label', 'settled-label'].map(point => ({ planned: true, point })),
    ...['queued-plan-excludes', 'queued-plan-route', 'queued-plan-matches'].map(point => ({ planned: false, point })),
  ])('checks $point with planned=$planned before bootstrap', async ({ planned, point }) => {
    let reserved = false;
    let mode = 'auto';
    let taskMode = 'auto';
    let taskStatus = point === 'archive-first' ? 'archived' : 'active';
    let planModeEnabled = point === 'plan-first';
    let enabled = true;
    let receiptReads = 0;
    let reservedTaskReads = 0;
    const epoch = { client: {} };
    const revoke = () => { mode = 'acceptEdits'; };
    const task = () => ({ revision: 1, status: taskStatus, permissionMode: taskMode, planModeEnabled, workingDir: path.resolve('repo') });
    const planItem = { label: 'sample', workingDir: path.resolve(point === 'canonical-directory' ? 'alias' : point === 'different-directory' ? 'other' : 'repo'), route: { agentKind: 'codex', model: 'gpt-5.5', providerId: 'xd', effort: 'medium', fastMode: point === 'normalized-fast' } };
    const payload = () => JSON.stringify(planned ? { teamPlan: { concurrency: 2, items: [planItem] }, settledLabels: point === 'settled-label' ? ['sample'] : [] } : {});
    const receipt = { pluginId: 'plugin', operation: 'create', payload: payload() };
    const depsForCallback = {
      readPluginTaskPlanReceipt: JSON.parse,
      assertPluginWorkerDirectoryScope,
      getCurrentDbClientSnapshot: () => epoch,
      createPluginTaskStore: () => ({ get: async () => { if (++receiptReads === 6 && point === 'receipt') revoke(); return structuredClone(receipt); } }),
      pluginTaskServiceForCurrentOwner: () => ({ get: async () => {
        if (reserved) ++reservedTaskReads;
        if (reservedTaskReads === 3 && point === 'final-task') revoke();
        if (reservedTaskReads === 3 && point === 'task-mode') taskMode = 'plan';
        if (reservedTaskReads === 3 && point === 'archive-final') taskStatus = 'archived';
        if (reservedTaskReads === 3 && point === 'plan-final') planModeEnabled = true;
        // A registration already past its reservation check commits while the
        // post-reservation service read drains the existing receipt queue.
        if (reservedTaskReads === 2 && point.startsWith('queued-plan-')) {
          receipt.payload = JSON.stringify({ teamPlan: { concurrency: 2, items: [{ ...planItem,
            label: point === 'queued-plan-excludes' ? 'other' : 'sample',
            route: { ...planItem.route, model: point === 'queued-plan-route' ? 'gpt-5.4' : 'gpt-5.5' },
          }] } });
        }
        return task();
      } }),
      readPluginTaskConfig: () => ({ permissionMode: mode, workingDir: path.resolve('repo') }),
      isPluginTaskAuthorized: () => enabled,
      resolvePluginWorkerDirectory: async ({requested}: {requested: string}) => { if (reserved && point === 'directory') revoke(); return requested === path.resolve('other') ? requested : path.resolve('repo'); },
      realpathWorkingDirectory: async (dir: string) => dir === path.resolve('other') ? dir : path.resolve('repo'),
      isGhostPickedDir: () => false,
      PluginTaskError,
    };
    const validateCreationPlan = new Function(...Object.keys(depsForCallback), js)(...Object.values(depsForCallback));
    const { deps, service } = createDeps({ validateCreationPlan, withLeadSendLock: async (_id, operation) => {
      if (point === 'archive-admission') taskStatus = 'archived';
      return operation();
    } });
    if (point === 'normalized-fast') {
      const models = deps.getAvailableModels;
      deps.getAvailableModels = agent => models(agent).map(model => ({ ...model, supportsFastMode: false }));
    }
    const reserve = deps.reserveWorkerCreation;
    deps.reserveWorkerCreation = vi.fn(async input => {
      const result = await reserve(input); reserved = true;
      if (point === 'reservation') revoke();
      if (point === 'disabled') enabled = false;
      if (point === 'archive-reservation') taskStatus = 'archived';
      if (point === 'plan-reservation') planModeEnabled = true;
      if (point === 'changed-plan') {
        planItem.route.model = 'gpt-5.4';
        receipt.payload = payload();
      }
      return result;
    });
    const result = service.createWorker({ leadSessionId: 'lead-1', role: 'eval', agent: 'codex', label: ['normalized-label', 'settled-label'].includes(point) ? ' SAMPLE ' : 'sample', workerPermissionMode: 'auto',
      ...(point === 'explicit-match' ? { model: 'gpt-5.5', providerId: 'xd', effort: 'medium', fast: false, workingDir: path.resolve('repo') } : {}),
      ...(point === 'different-model' ? { model: 'gpt-5.4' } : {}),
      ...(point === 'normalized-fast' ? { fast: true } : {}),
    });
    if (['healthy', 'explicit-match', 'canonical-directory', 'queued-plan-matches', 'normalized-label'].includes(point)) {
      await expect(result).resolves.toMatchObject({ ok: true });
      expect(deps.bootstrapSession).toHaveBeenCalledOnce();
    } else if (['different-model', 'different-directory', 'normalized-fast', 'archive-admission'].includes(point)) {
      // The child PR checks under the Lead send lock before reserving too.
      await expect(result).resolves.toMatchObject({ ok: false, message: point === 'archive-admission' ? 'Archived tasks cannot create Workers' : 'Worker configuration differs from registered plan' });
      expect(deps.reserveWorkerCreation).not.toHaveBeenCalled();
      expect(deps.bootstrapSession).not.toHaveBeenCalled();
    } else {
      await expect(result).rejects.toMatchObject({ code: point.startsWith('archive-') ? 'TASK_BUSY' : ['different-model', 'different-directory', 'normalized-fast', 'changed-plan', 'queued-plan-excludes', 'queued-plan-route', 'settled-label'].includes(point) ? 'INVALID_REQUEST' : 'PERMISSION_DENIED' });
      expect(deps.bootstrapSession).not.toHaveBeenCalled();
    }
    expect(deps.releaseWorkerCreationReservation).toHaveBeenCalledTimes(reserved ? 1 : 0);
  });
});
it('rechecks a newly registered plan under the Lead send lock before reserving', async () => {
  let locked = false, limit: number | undefined;
  const validateCreationPlan = vi.fn(async () => limit);
  const {deps,service}=createDeps({
    validateCreationPlan,
    withLeadSendLock: async (_id, operation) => {
      limit = 1; locked = true;
      try { return await operation(); } finally { locked = false; }
    },
  });
  vi.mocked(deps.reserveWorkerCreation).mockImplementation(async input => {
    expect(locked).toBe(true);expect(input.hardLimit).toBe(1);
    return {ok:true,occupiedSlotsBefore:0};
  });
  const bootstrap=deps.bootstrapSession;
  deps.bootstrapSession=vi.fn(async (opts: MakerSessionCreateOpts) => {expect(locked).toBe(false);return bootstrap(opts);});
  await service.createWorker({leadSessionId:'lead-1',role:'eval',agent:'codex',label:'sample'});
  expect(validateCreationPlan).toHaveBeenCalledTimes(5);
  expect(deps.reserveWorkerCreation).toHaveBeenCalledOnce();
});
it('rejects a plan changed during preparation without reserving or bootstrapping', async () => {
  const validate=vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('not pending'));
  const {deps,service}=createDeps({validateCreationPlan:validate,withLeadSendLock:async (_id, operation)=>operation()});
  const result=await service.createWorker({leadSessionId:'lead-1',role:'eval',agent:'codex',label:'sample'});
  expect(result.ok).toBe(false);expect(deps.reserveWorkerCreation).not.toHaveBeenCalled();expect(deps.bootstrapSession).not.toHaveBeenCalled();
});
