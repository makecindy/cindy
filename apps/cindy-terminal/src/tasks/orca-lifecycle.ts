import type { TerminalWorktrees } from '../worktrees/host.js';
import { realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { AgentKind, Session } from '@cindy/maker-core';
import { connectedProvidersForAgent, isModelSelectableForNewRoute } from '@cindy/model-providers';
import { createOrcaWorkerCreationService, type OrcaWorkerCreationPlanValidator } from '@cindy/orca-workflow/host/orcaWorkerCreationService';
import { createOrcaLifecycleService, ORCA_WORKER_READY_MESSAGE } from '@cindy/orca-workflow/host/orcaLifecycleService';
import { buildOrcaWorkerProviderRoutingContext, deviceWorkerRoutingContext } from '@cindy/orca-workflow/host/orcaProviderRoutingContext';
import type { createOrcaRemoteWorkers } from '@cindy/orca-workflow/host/orcaRemoteWorkers';
import type { OrcaTeamService } from '@cindy/orca-workflow/host/orcaTeamService';
import type { MakerSessionCreateOpts } from '@cindy/orca-workflow/host/sessionTypes';
import { readDeviceProviderViews } from '@cindy/remote-agent';
import type { TerminalModelConfig } from '../models/config.js';
import type { TerminalTaskStorage } from './storage.js';
import type { TerminalOrcaStore } from './orca-store.js';

/** Runtime adapters only: lifecycle, limits and compensation stay in the
 * shared services used by Desktop. No synthetic Maker or plugin identity. */
export function createTerminalOrcaLifecycle(deps: {
  store: TerminalOrcaStore; tasks: TerminalTaskStorage; models: TerminalModelConfig;
  team: OrcaTeamService; remote: ReturnType<typeof createOrcaRemoteWorkers>;
  remoteInvoke?: Parameters<typeof readDeviceProviderViews>[0];
  selfDeviceId(): string | undefined;
  worktrees?(): TerminalWorktrees | undefined;
  guard(): void;
  withLock<T>(id: string, work: () => Promise<T>): Promise<T>;
  authority(id: string): Promise<{ permissionMode?: 'auto'; assertCurrent(): Promise<void> }>;
  validatePlan: OrcaWorkerCreationPlanValidator;
  bootstrap(input: MakerSessionCreateOpts): Promise<{ session: Session; didInjectOrcaInstructions: boolean; didInjectProjectContext: boolean }>;
  live(id: string): Session | undefined;
  close(id: string): Promise<void>;
  archive(id: string): Promise<void>;
  forget(id: string): void;
  readyMessage(id: string, message: string, current?: () => Promise<void>): Promise<void>;
  changed(leadId: string): void;
  created(id: string): void;
}) {
  const localModels = (kind: AgentKind) => deps.models.activeCatalog().providers
    .flatMap(provider => provider.models[kind] ?? [])
    .filter((model, index, all) => all.findIndex(entry => entry.id === model.id) === index);
  const creation = createOrcaWorkerCreationService({
    getActiveTeamByLead: id => deps.store.getActiveTeamByLead(id),
    listWorkersByLead: id => deps.store.listWorkersByLead(id),
    isActiveWorkerStatus: () => true, // completed/error Workers still occupy their retained slot
    withLeadSendLock: deps.withLock,
    readCollaborationSettings: () => deps.store.settings(),
    validateCreationPlan: deps.validatePlan,
    getLeadSessionRow: async id => {
      const row = await deps.tasks.get(id); deps.guard();
      if (!row || row.archived || row.deleted) return null;
      return { id, agentKind: row.agentKind, workspaceKind: row.workspaceKind ?? 'project', workingDir: row.workDir,
        model: row.model, effort: row.effort ?? null, permissionMode: row.permissionMode ?? 'default',
        fastMode: row.fastMode ?? false, providerId: row.providerId ?? null, remoteHostId: null,
        agentDeviceId: row.agentDeviceId ?? null,
        ...(row.groupBinding ? { providerGroupEntry: { agentDeviceId: row.groupBinding.groupDeviceId ?? null, providerId: row.groupBinding.providerId } } : {}),
      };
    },
    getWorkerDefaults: kind => {
      const selection = deps.models.snapshot().defaultSelection;
      return selection?.agentKind === kind ? selection : {};
    },
    getWorkerPermissionMode: () => deps.store.settings().workerPermissionMode,
    resolveWorkerWorkingDir: async directory => {
      const resolved = await realpath(directory);
      if (!(await stat(resolved)).isDirectory()) throw new Error('WORKDIR_NOT_DIRECTORY');
      deps.guard(); return resolved;
    },
    resolveWorkerWorktreeSource: async (directory, sourceBranch) => {
      const host = deps.worktrees?.(); if (!host) throw new Error('WORKTREE_HOST_UNAVAILABLE');
      deps.guard(); return host.workerProjects.resolveWorkerWorktreeSource(directory, sourceBranch);
    },
    getWorkerWorktree: id => deps.worktrees?.()?.workerProjects.getWorkerOwnedWorktree(id),
    createWorkerWorktree: async (id, directory, sourceBranch) => {
      const host = deps.worktrees?.(); if (!host) throw new Error('WORKTREE_HOST_UNAVAILABLE');
      deps.guard(); return host.workerProjects.createWorkerWorktree(id, directory, sourceBranch);
    },
    discardWorkerWorktree: id => deps.withLock(id, async () => {
      const host = deps.worktrees?.(); if (!host) throw new Error('WORKTREE_HOST_UNAVAILABLE');
      await host.manager.awaitBackgroundCheckout(id);
      await host.manager.cancelPrecreatedWorktree(id, { path: host.manager.getForSession(id)?.path }, {
        canRemove: async () => { deps.guard(); if (deps.live(id)) return false; const row = await deps.tasks.get(id); return !row || Boolean(row.archived); },
      });
    }),
    getAvailableModels: localModels,
    getProviderRoutingContext: async (kind, _remoteHostId, deviceId) => {
      if (deviceId) {
        if (!deps.remoteInvoke) throw new Error('REMOTE_AGENT_UNAVAILABLE');
        return deviceWorkerRoutingContext(await readDeviceProviderViews(deps.remoteInvoke, deviceId), kind ?? 'claude-code');
      }
      // Discovery may legitimately advance the catalog revision on this read.
      // Take the same post-discovery snapshot used by ordinary task selection.
      const views = await deps.models.views();
      deps.guard();
      if (deps.models.isMutating()) throw new Error('MODEL_CONFIGURATION_CHANGED');
      const context = buildOrcaWorkerProviderRoutingContext(views, deps.models.activeCatalog());
      // Use these same connected/discovered views for model capability checks.
      // The legacy field is the shared service's per-call model snapshot.
      if (kind) context.remoteCodexModels = connectedProvidersForAgent(views, kind)
        .flatMap(provider => (provider.models[kind] ?? []).filter(model => isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' })));
      return context;
    },
    isSelfDeviceId: id => id === deps.selfDeviceId(),
    // This legacy gate concerns Cindy Gateway, never the Claude CLI credential store.
    readClaudeApiKey: () => deps.models.credential('xd', 'claude-code'),
    reserveWorkerCreation: input => deps.store.reserveWorkerCreation(input),
    renewWorkerCreationReservation: (id, lease) => deps.store.renewWorkerCreationReservation(id, lease),
    releaseWorkerCreationReservation: id => deps.store.releaseWorkerCreationReservation(id),
    createId: randomUUID, createSessionId: randomUUID,
    buildCreateOptsWithStderr: input => input,
    bootstrapSession: deps.bootstrap,
    addOrUpdateWorker: async input => { await deps.store.addOrUpdateWorker(input); },
    markOrcaRoleIfNeeded: (id, role) => deps.store.setSessionOrcaRole(id, role),
    closeWorkerSession: deps.close, archiveWorkerSession: deps.archive, forgetWorkerSession: deps.forget,
    removeWorker: id => deps.store.removeWorker(id),
    dispatchWorkerTask: input => deps.team.dispatchWorkerTask(input),
    broadcastSessionCreated: deps.created, broadcastOrcaWorkerChanged: deps.changed,
    openRemoteWorker: input => deps.remote.openRemoteWorker(input),
    recordRemoteWorker: input => deps.remote.recordRemoteWorker(input),
    discardRemoteWorker: input => deps.remote.discardRemoteWorker(input),
  });
  const lifecycle = createOrcaLifecycleService({
    getActiveTeamByLead: id => deps.store.getActiveTeamByLead(id),
    createActiveTeam: leadSessionId => deps.store.createActiveTeam({ leadSessionId }),
    isOrphanedTeamInit: id => deps.store.isOrphanedTeamInit(id),
    getWorkerPermissionMode: () => deps.store.settings().workerPermissionMode,
    setWorkerPermissionMode: async workerPermissionMode => { await deps.store.updateSettings({ workerPermissionMode }); },
    getWorkerPermissionModeOverride: deps.authority,
    createWorkerInTeam: (input, current, created) => creation.createWorkerInTeam(input, current, created),
    dispatchWorkerTask: (input, current) => deps.team.dispatchWorkerTask(input, current),
    markTeamEnded: (id, status) => deps.store.markTeamEnded(id, status),
    setSessionOrcaRole: (id, role) => deps.store.setSessionOrcaRole(id, role),
    clearKnownNonOrcaSession: () => {}, // terminal startup reads role from storage each time
    setLeadVendorOptions: async ({ leadSessionId, teamId, workerId, workerSessionId }) => {
      await deps.live(leadSessionId)?.setVendorOptions({ orcaRole: 'lead', orcaWorkflowId: teamId, orcaLeadSessionId: leadSessionId,
        ...(workerId && workerSessionId ? { initialWorker: { workerId, sessionId: workerSessionId } } : {}) });
    },
    clearLeadVendorOptions: async id => { await deps.live(id)?.setVendorOptions({ orcaRole: null, orcaWorkflowId: null, orcaLeadSessionId: null, initialWorker: null }); },
    sendWorkerReadyPlaceholder: async ({ workerSessionId }, current) => {
      if (!deps.remote.runtime.isRemote(workerSessionId)) await deps.readyMessage(workerSessionId, ORCA_WORKER_READY_MESSAGE, current);
    },
    rollbackCreatedWorker: async ({ workerId, workerSessionId }) => {
      if (await deps.remote.rollbackCreatedWorker(workerSessionId)) return;
      await deps.close(workerSessionId); deps.forget(workerSessionId);
      await deps.archive(workerSessionId); await deps.store.removeWorker(workerId);
    },
    broadcastSessionCreated: deps.created, broadcastOrcaWorkerChanged: deps.changed,
  });
  return { creation, lifecycle };
}
