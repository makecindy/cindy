import { and, eq } from 'drizzle-orm';
import type { XdtHelperMcpDeps } from '@cindy/mcps';
import { isCindyMakeFamilySource } from '../../shared/cindyMakeMerge.js';
import { sessions, orcaTeams, orcaWorkers, botSessionLinks } from '../localDb/schema.js';
import { updateSessionInDb } from '../localDb/ipc/sessions.js';
import * as worktreeStore from '../worktree/worktreeStore.js';
import { bindingStore } from '../im/binding.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  validateExistingLocalProjectDirectory,
  validateLocalProjectDirectory,
  withLocalProjectContext,
  type LocalProjectContext,
} from './createProject.js';

type HostMoveHandler = (
  sessionId: string,
  workingDir: string | null,
  assertAuthority: () => void,
) => ReturnType<typeof moveSessionProject>;
let deferredHostMove: HostMoveHandler | null = null;
export function setDeferredHostMove(handler: HostMoveHandler | null): void {
  deferredHostMove = handler;
}

/** The caller supplies the same live running-state projection used by the sidebar. */
export function createMoveSession(
  isSessionRunning: (sessionId: string) => boolean,
): NonNullable<XdtHelperMcpDeps['moveSession']> {
  return async ({ callerSessionId, sessionId, workingDir }) => {
    if (callerSessionId === sessionId) {
      return {
        ok: false,
        errorCode: 'PRECONDITION_FAILED',
        message: 'Cannot move the calling task while it is running.',
      };
    }
    return moveSessionProject(isSessionRunning, callerSessionId, sessionId, workingDir);
  };
}

/** Trusted UI entry: identity/remote-control authority is checked by the host route.
 * Unlike a running agent, the UI may move its selected task itself.
 */
export function moveSessionProjectFromHost(
  isSessionRunning: (sessionId: string) => boolean,
  sessionId: string,
  workingDir: string | null,
  assertAuthority: () => void,
) {
  assertAuthority();
  return (
    deferredHostMove?.(sessionId, workingDir, assertAuthority) ??
    moveSessionProject(isSessionRunning, sessionId, sessionId, workingDir, assertAuthority)
  );
}

export async function moveSessionProject(
  isSessionRunning: (sessionId: string) => boolean,
  contextSessionId: string,
  sessionId: string,
  workingDir: string | null,
  assertAuthority: () => void = () => {},
  options: { routeLockHeld?: boolean; strictTranscriptRelocation?: boolean } = {},
) {
  const directory = workingDir === null ? null : validateLocalProjectDirectory(workingDir);
  if (directory && !directory.ok) return directory;
  const targetDir = directory?.workingDir ?? null;
  return withLocalProjectContext(contextSessionId, async (context) => {
    const assertCurrent = () => {
      context.assertCurrent();
      assertAuthority();
    };
    assertCurrent();
    const assertMoveAllowed = () =>
      inspectSessionProjectMove(
        context,
        sessionId,
        targetDir,
        isSessionRunning,
        assertCurrent,
      ).then(() => {});
    const patch =
      targetDir === null
        ? { workspaceKind: 'dialogue' }
        : { workspaceKind: 'project', workingDir: targetDir };
    const updated = await updateSessionInDb(sessionId, patch, undefined, {
      assertCurrent,
      beforeUpdate: assertMoveAllowed,
      beforeWrite: assertMoveAllowed,
      ...options,
    });
    return {
      ok: true,
      sessionId: updated.id,
      workingDir: updated.workingDir ?? null,
      workspaceKind: updated.workspaceKind ?? 'project',
    };
  });
}

/** Same guards at request time and again under the route/worktree locks. */
export async function inspectSessionProjectMove(
  context: LocalProjectContext,
  sessionId: string,
  targetDir: string | null,
  isSessionRunning: (id: string) => boolean,
  assertCurrent: () => void = context.assertCurrent,
  allowBusy = false,
) {
  assertCurrent();
  const [target] = await context.client.drizzle
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  assertCurrent();
  if (!target) throwIpcError('NOT_FOUND', 'Task does not exist in this account.');
  if (target.remoteHostId) throwIpcError('UNSUPPORTED_CAPABILITY', 'Remote tasks cannot be moved.');
  // A remote Agent's workspace and conversation record are keyed by task id.
  // Its owner may move an idle task without relocating that remote workspace.
  // Worktree metadata, project identity and runtime cwd form one binding.
  // Moving only the session row would detach that binding or run in the main checkout.
  if (worktreeStore.get(sessionId)) {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'Tasks in an independent worktree cannot be moved between groups.');
  }
  if (target.status !== 'active')
    throwIpcError('PRECONDITION_FAILED', 'Only active tasks can be moved.');
  // Review immutability is also enforced by updateSessionInDb for all callers.
  if (target.source === 'review')
    throwIpcError('UNSUPPORTED_CAPABILITY', 'Review task settings are fixed to the source task.');
  // Make continuation, completion and cleanup rely on this managed workspace binding.
  if (isCindyMakeFamilySource(target.source))
    throwIpcError(
      'UNSUPPORTED_CAPABILITY',
      'Cindy Make tasks must stay in their managed workspace.',
    );
  // Bot runtime resolves its workspace from the ownership link, including legacy tasks.
  const [botLink] = await context.client.drizzle
    .select({ botId: botSessionLinks.botId })
    .from(botSessionLinks)
    .where(eq(botSessionLinks.sessionId, sessionId))
    .limit(1);
  assertCurrent();
  if (target.source === 'bot' || botLink)
    throwIpcError('UNSUPPORTED_CAPABILITY', 'Bot tasks use their own managed workspace.');
  if (targetDir) {
    const physicalDirectory = await validateExistingLocalProjectDirectory(targetDir);
    if (!physicalDirectory.ok) throwIpcError('INVALID_PARAMS', physicalDirectory.message);
  }
  // Re-read active team membership at each checkpoint, including after
  // transcript copying/runtime close. Do not retain the pre-move snapshot.
  const workers = await context.client.drizzle
    .select({ sessionId: orcaWorkers.sessionId })
    .from(orcaWorkers)
    .innerJoin(orcaTeams, eq(orcaWorkers.teamId, orcaTeams.id))
    .where(and(eq(orcaTeams.leadSessionId, sessionId), eq(orcaTeams.status, 'active')));
  assertCurrent();
  if (
    !allowBusy &&
    (isSessionRunning(sessionId) || workers.some((worker) => isSessionRunning(worker.sessionId)))
  ) {
    throwIpcError(
      'PRECONDITION_FAILED',
      'Running tasks or leads with running workers cannot be moved.',
    );
  }
  if (bindingStore.findByTarget(sessionId))
    throwIpcError('PRECONDITION_FAILED', 'IM-controlled tasks cannot be moved.');
  return { target, workers };
}
