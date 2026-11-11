import path from 'node:path';
import type {
  WorkerProjectContext,
  WorkerProjectInfo,
  WorkerWorktreeRequest,
} from '../../shared/orca-worker-project';
import { throwIpcError } from '../utils/ipcValidate';

interface ProjectSession {
  id: string;
  workingDir: string | null;
  worktreePath?: string | null;
  workspaceKind?: string | null;
  remoteHostId?: string | null;
  orcaRole?: string | null;
}

interface WorkerProjectHandlerDeps<Event, Owner> {
  isDeviceLinkInvoke(): boolean;
  assertTrustedAppRendererEvent(event: Event): void;
  getOwner(): Owner | null;
  getSession(owner: Owner, id: string): Promise<ProjectSession | undefined>;
  getTeamByWorkerSession(id: string): Promise<{ leadSessionId: string } | null>;
  readContext(lead: ProjectSession): Promise<WorkerProjectContext>;
  probe(directory: string, details: boolean): Promise<WorkerProjectInfo>;
  remember(directory: string, ownerId: string): Promise<void>;
  log: { warn(message: string, meta: Record<string, unknown>): void };
}

/** Local project IPC adapters. Legacy requests bypass local-only reads and retain their wire semantics. */
export function createOrcaWorkerProjectHandlers<Event, Owner extends { userId: string }>(
  deps: WorkerProjectHandlerDeps<Event, Owner>,
) {
  // Local-only project reads. These channels intentionally do not enter device-link's allowlist.
  async function localWorkerProjectLead(event: Event, id: unknown) {
    if (deps.isDeviceLinkInvoke()) throwIpcError('PERMISSION_DENIED', 'Local project UI required');
    deps.assertTrustedAppRendererEvent(event);
    if (typeof id !== 'string' || !id || id.length > 128)
      throwIpcError('INVALID_PARAMS', 'leadSessionId required');
    const owner = deps.getOwner();
    if (!owner) throwIpcError('INTERNAL', 'Task storage unavailable');
    const lead = await deps.getSession(owner, id);
    if (deps.getOwner() !== owner) throwIpcError('PERMISSION_DENIED', 'Account changed');
    if (!lead || lead.remoteHostId) throwIpcError('INVALID_PARAMS', 'Local project required');
    return { lead, owner };
  }

  async function context(event: Event, id: unknown, directory?: unknown) {
    const { lead, owner } = await localWorkerProjectLead(event, id);
    if (
      directory !== undefined &&
      (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.length > 32768)
    ) {
      throwIpcError('INVALID_PARAMS', 'Absolute project directory required');
    }
    // A project change reads only its target; the renderer retains this opening's list.
    const context =
      typeof directory === 'string'
        ? await deps.probe(directory, true)
        : await deps.readContext(lead);
    if (deps.getOwner() !== owner) throwIpcError('PERMISSION_DENIED', 'Account changed');
    return context;
  }

  async function label(event: Event, workerSessionId: unknown) {
    const { lead: worker, owner } = await localWorkerProjectLead(event, workerSessionId);
    if (worker.orcaRole !== 'worker') return null;
    const team = await deps.getTeamByWorkerSession(worker.id);
    if (!team) return null;
    const { lead } = await localWorkerProjectLead(event, team.leadSessionId);
    if (!worker.workingDir || !lead.workingDir) return null;
    const [workerProject, leadProject] = await Promise.all([
      deps.probe(worker.workingDir, false),
      deps.probe(lead.workingDir, false),
    ]);
    if (deps.getOwner() !== owner) throwIpcError('PERMISSION_DENIED', 'Account changed');
    const workerBase = workerProject.baseRepo ?? worker.workingDir;
    const leadBase = leadProject.baseRepo ?? lead.workingDir;
    const sameProject =
      process.platform === 'win32'
        ? workerBase.toLowerCase() === leadBase.toLowerCase()
        : workerBase === leadBase;
    return sameProject ? null : { name: path.basename(workerBase), path: workerBase };
  }

  // Parse only the local project extension; callers retain legacy request parsing and
  // lifecycle dispatch, and invoke remember only after successful Worker creation.
  async function localWorkerProjectOptions(
    event: Event,
    id: string,
    body: Record<string, unknown>,
  ) {
    const requested =
      body.worktree !== undefined ||
      body.projectPath !== undefined ||
      (body.workingDir !== undefined && !body.executionDeviceId);
    if (!requested) return { fields: {}, remember: async () => {} };
    const { lead, owner } = await localWorkerProjectLead(event, id);
    if (body.executionDeviceId)
      throwIpcError('INVALID_PARAMS', 'Worker project options require local execution');
    if (
      body.workingDir !== undefined &&
      (typeof body.workingDir !== 'string' ||
        !path.isAbsolute(body.workingDir) ||
        body.workingDir.length > 32768)
    ) {
      throwIpcError('INVALID_PARAMS', 'Absolute workingDir required');
    }
    if (
      body.projectPath !== undefined &&
      (typeof body.projectPath !== 'string' ||
        !path.isAbsolute(body.projectPath) ||
        body.projectPath.length > 32768)
    ) {
      throwIpcError('INVALID_PARAMS', 'Absolute projectPath required');
    }
    let worktree: WorkerWorktreeRequest | undefined;
    if (body.worktree !== undefined) {
      const source = (body.worktree as WorkerWorktreeRequest | null)?.sourceBranch;
      if (
        typeof source !== 'string' ||
        !source ||
        source.length > 1024 ||
        source.startsWith('-') ||
        Array.from(source).some((character) => character.charCodeAt(0) < 32)
      ) {
        throwIpcError('INVALID_PARAMS', 'Worktree sourceBranch required');
      }
      if (lead.workspaceKind === 'dialogue' && body.workingDir === undefined)
        throwIpcError('INVALID_PARAMS', 'Worker worktree requires a project');
      worktree = { sourceBranch: source };
    }
    return {
      fields: {
        ...(typeof body.workingDir === 'string' ? { workingDir: body.workingDir } : {}),
        ...(worktree ? { worktree } : {}),
      },
      remember: async () => {
        if (typeof body.projectPath !== 'string' || deps.getOwner() !== owner) return;
        try {
          await deps.remember(body.projectPath, owner.userId);
        } catch (error) {
          deps.log.warn('Worker project history could not be saved', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    };
  }

  return { context, label, options: localWorkerProjectOptions };
}
