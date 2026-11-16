import type { openSession, OpenedSessionRow } from '../localDb/sessionOpening.js';
import type { TaskActionDeliveryGuard } from './taskActionAuthorization.js';
import type { RemoteSessionCreation, RemoteSessionCreated } from '../../shared/remoteSessionCreation.js';
import { resolveSessionExecutionSelection, type SessionExecutionSelection } from './sessionExecutionSelection.js';
import type { HandoffWorkingDirValidation } from './handoffWorkingDir.js';

type Failure = { ok: false; errorCode: string; message: string };
type Execution = Pick<RemoteSessionCreated, 'agentKind' | 'model' | 'fastMode'>
  & { providerId?: string | null; effort?: RemoteSessionCreated['effort']; agentDeviceId?: string | null };

/** Resolve target defaults against the chosen provider computer, without borrowing its source ID. */
export function createRemoteSessionExecutionResolver(deps: {
  isSelfDeviceId(id: string): boolean;
  resolveLocal(input: RemoteSessionCreation): Promise<Execution>;
  readDefault(): SessionExecutionSelection | undefined;
  readRemoteRouting(deviceId: string, agent: Execution['agentKind']): Promise<Parameters<typeof resolveSessionExecutionSelection>[0]['providerRouting']>;
}) {
  return async (input: RemoteSessionCreation): Promise<Execution> => {
    const deviceId = input.agentDeviceId && !deps.isSelfDeviceId(input.agentDeviceId) ? input.agentDeviceId : null;
    if (!deviceId) return deps.resolveLocal(input);
    const defaults = deps.readDefault();
    const agentKind = input.agentKind ?? defaults?.agentKind;
    if (!agentKind) throw new Error('Select an agent for the remote provider');
    let routing: Awaited<ReturnType<typeof deps.readRemoteRouting>>;
    try { routing = await deps.readRemoteRouting(deviceId, agentKind); }
    catch (error) {
      throw Object.assign(new Error(`Cannot read providers of provider_device_id "${deviceId}": ${error instanceof Error ? error.message : String(error)}`),
        { code: 'PROVIDER_ROUTE_UNAVAILABLE' });
    }
    const selected = resolveSessionExecutionSelection({
      selection: { agentKind, model: input.model, effort: input.effort, fastMode: input.fast },
      source: defaults ? { ...defaults, providerId: undefined } : undefined,
      availableAgents: [agentKind], availableModels: routing.remoteCodexModels ?? [], providerRouting: routing,
      hasCindyAiApiKey: true, locationChanged: true,
    });
    // Keep the destination's resolved provider explicit when execution moves computers.
    return { ...selected, providerId: selected.providerId ?? routing.resolveDefaultProviderIdForModel(agentKind, selected.model),
      agentDeviceId: deviceId };
  };
}

/** Ordinary task creation on the destination. Sending is still owned by the handoff queue. */
export function createRemoteSessionOpener(deps: {
  openSession: typeof openSession;
  openSessionCommit(row: OpenedSessionRow, assertCurrent: () => void): Promise<void>;
  captureOwner(): () => void;
  withSessionLock<T>(id: string, run: () => Promise<T>): Promise<T>;
  sessionExists(id: string): Promise<boolean>;
  resolveProject(input: { projectDir?: string | null; workingDir?: string }): Promise<{ ok: true; projectDir: string | null } | Failure>;
  validateDirectory(path: string): Promise<HandoffWorkingDirValidation>;
  resolveExecution(options: RemoteSessionCreation): Promise<Execution>;
  prepareWorktree(id: string, directory: string): Promise<{ ok: true; path: string } | Failure>;
  discardWorktree(id: string): Promise<unknown>;
  broadcastCreated(id: string): void;
}) {
  return async (id: string, input: RemoteSessionCreation, guard: TaskActionDeliveryGuard): Promise<({ ok: true } & RemoteSessionCreated) | Failure> => {
    const assertOwner = deps.captureOwner();
    const check = async () => { assertOwner(); await guard(); assertOwner(); };
    try { return await deps.withSessionLock(id, async () => {
      await check();
      // A replay must never enqueue another first message or modify an existing task.
      if (await deps.sessionExists(id)) return { ok: false, errorCode: 'DELIVERY_UNKNOWN',
        message: 'This task ID already exists. Inspect its history and queue; do not create another task.' };
      const project = await deps.resolveProject(input);
      await check();
      if (!project.ok) return project;
      let workingDir = input.workingDir ?? project.projectDir ?? undefined;
      if (workingDir !== undefined) {
        const checked = await deps.validateDirectory(workingDir);
        await check();
        if (!checked.ok) return { ok: false, errorCode: 'INVALID_ARGS', message: checked.message };
        workingDir = checked.dir;
      }
      const execution = await deps.resolveExecution(input);
      await check();
      let worktreePath: string | null = null;
      let persistenceStarted = false;
      try {
        if (input.useWorktree) {
          if (!workingDir) return { ok: false, errorCode: 'INVALID_ARGS', message: 'use_worktree requires a project or working_dir on the destination.' };
          const tree = await deps.prepareWorktree(id, workingDir);
          if (!tree.ok) return tree;
          worktreePath = tree.path;
          workingDir = tree.path;
          await check();
        }
        const { row } = await deps.openSession({ id, assertCurrent: assertOwner,
          body: {
            title: input.title,
            projectDir: project.projectDir,
            workspaceKind: project.projectDir === null ? 'dialogue' : 'project',
            workingDir,
            agentKind: execution.agentKind === 'claude-code' ? 'cc' : execution.agentKind,
            model: execution.model, providerId: execution.providerId,
            agentDeviceId: execution.agentDeviceId ?? null,
            effort: execution.effort ?? '', fastMode: execution.fastMode,
            permissionMode: input.permissionMode,
          },
        }, async (row, assertCurrent) => {
          // Revalidate the source after model/directory preparation and before the first write.
          await check(); assertCurrent();
          persistenceStarted = true;
          await deps.openSessionCommit({ ...row, worktreePath }, assertCurrent);
        });
        assertOwner();
        deps.broadcastCreated(id);
        return { ok: true, targetSessionId: id, targetTitle: row.title ?? null,
          agentKind: execution.agentKind, model: row.model, providerId: row.providerId ?? null,
          effort: (row.effort || null) as RemoteSessionCreated['effort'], fastMode: row.fastMode ?? false,
          projectDir: project.projectDir, workspaceKind: row.workspaceKind ?? (project.projectDir === null ? 'dialogue' : 'project'),
          workingDir: row.workingDir ?? '', worktreePath };
      } catch (error) {
        // A database write may have committed even when its reply was lost. Keep its workspace.
        if (worktreePath && !persistenceStarted) await deps.discardWorktree(id).catch(() => undefined);
        if (persistenceStarted) return { ok: false, errorCode: 'DELIVERY_UNKNOWN',
          message: 'Creation may have completed. Inspect this task ID before sending or creating again.' };
        throw error;
      }
    }); } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      return { ok: false, errorCode: code === 'PROVIDER_ROUTE_UNAVAILABLE' || code === 'BUDGET_MODEL_REQUIRES_API_MODE' ? code : 'INVALID_ARGS',
        message: error instanceof Error ? error.message : 'Task creation validation failed' };
    }
  };
}
