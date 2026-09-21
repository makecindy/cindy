import { and, eq } from 'drizzle-orm';
import type { XdtHelperMcpDeps } from '@cindy/mcps';
import { sessions, orcaTeams, orcaWorkers, botSessionLinks } from '../localDb/schema.js';
import { updateSessionInDb } from '../localDb/ipc/sessions.js';
import { bindingStore } from '../im/binding.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  validateExistingLocalProjectDirectory,
  validateLocalProjectDirectory,
  withLocalProjectContext,
} from './createProject.js';

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
    const directory = workingDir === null ? null : validateLocalProjectDirectory(workingDir);
    if (directory && !directory.ok) return directory;
    const targetDir = directory?.workingDir ?? null;
    return withLocalProjectContext(callerSessionId, async (context) => {
      const assertMoveAllowed = async () => {
        context.assertCurrent();
        const [target] = await context.client.drizzle
          .select()
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1);
        context.assertCurrent();
        if (!target) throwIpcError('NOT_FOUND', 'Task does not exist in this account.');
        if (target.remoteHostId)
          throwIpcError('UNSUPPORTED_CAPABILITY', 'Remote tasks cannot be moved.');
        if (target.status !== 'active')
          throwIpcError('PRECONDITION_FAILED', 'Only active tasks can be moved.');
        // Review immutability is also enforced by updateSessionInDb for all callers.
        if (target.source === 'review')
          throwIpcError(
            'UNSUPPORTED_CAPABILITY',
            'Review task settings are fixed to the source task.',
          );
        // Bot runtime resolves its workspace from the ownership link, including legacy tasks.
        const [botLink] = await context.client.drizzle
          .select({ botId: botSessionLinks.botId })
          .from(botSessionLinks)
          .where(eq(botSessionLinks.sessionId, sessionId))
          .limit(1);
        context.assertCurrent();
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
        context.assertCurrent();
        if (
          isSessionRunning(sessionId) ||
          workers.some((worker) => isSessionRunning(worker.sessionId))
        ) {
          throwIpcError(
            'PRECONDITION_FAILED',
            'Running tasks or leads with running workers cannot be moved.',
          );
        }
        if (bindingStore.findByTarget(sessionId))
          throwIpcError('PRECONDITION_FAILED', 'IM-controlled tasks cannot be moved.');
      };
      const patch =
        targetDir === null
          ? { workspaceKind: 'dialogue' }
          : { workspaceKind: 'project', workingDir: targetDir };
      const updated = await updateSessionInDb(sessionId, patch, undefined, {
        assertCurrent: context.assertCurrent,
        beforeUpdate: assertMoveAllowed,
        beforeWrite: assertMoveAllowed,
      });
      return {
        ok: true,
        sessionId: updated.id,
        workingDir: updated.workingDir ?? null,
        workspaceKind: updated.workspaceKind ?? 'project',
      };
    });
  };
}
