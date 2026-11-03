import { eq } from 'drizzle-orm';
import {
  activeOwnerScopeKey,
  getActiveDataOwnerPushStamp,
  isAppSessionBoundaryPending,
} from './appSessionState.js';
import { createProjectFromTaskHandlers, type CreateProjectFromTaskDeps } from './createProjectFromTask.js';
import { isManagedDialogueWorkspace } from './localDb/dialogueWorkspace.js';
import { tryGetDbClient } from './localDb/client/current.js';
import { sessions } from './localDb/schema.js';
import { withSessionRouteLock } from './localDb/sessionRouteLock.js';
import {
  createProject,
  validateExistingLocalProjectDirectory,
  withLocalProjectContext,
} from './mcp-integrations/createProject.js';
import { assertSessionMovable, moveSessionProjectFromHost } from './mcp-integrations/moveSession.js';
import { resolveProjectsRoot } from './mcp-integrations/projectManagement.js';
import { writeProjectsRootDirectory } from './projects-root-settings.js';
import { setLocalProjectHidden } from './sidebarSettingsStore.js';
import { throwIpcError } from './utils/ipcValidate.js';
import { isIpcErrorCode } from '../shared/ipc-errors.js';

/** Production wiring for the local UI entry; the native picker never crosses device-link. */
export function createLocalProjectFromTaskHandlers(deps: {
  isSessionBusy(sessionId: string): boolean;
  chooseDirectory(): Promise<string | null>;
}) {
  const inTaskContext = async <T extends object>(
    sessionId: string,
    run: Parameters<typeof withLocalProjectContext<T>>[1],
  ): Promise<T> => {
    const result = await withLocalProjectContext(sessionId, run);
    if (result.ok) return result;
    throwIpcError(isIpcErrorCode(result.errorCode) ? result.errorCode : 'INTERNAL', result.message);
  };
  const service: CreateProjectFromTaskDeps = {
    withTaskLock: withSessionRouteLock,
    readTask: (sessionId) =>
      inTaskContext(sessionId, async ({ client, assertCurrent }) => {
        const [row] = await client.drizzle
          .select({ title: sessions.title, workingDir: sessions.workingDir, workspaceKind: sessions.workspaceKind })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1);
        assertCurrent();
        if (!row) throwIpcError('NOT_FOUND', 'Task does not exist in this account.');
        return { ok: true as const, ...row };
      }),
    assertMovable: async (sessionId) => {
      await inTaskContext(sessionId, async ({ client, assertCurrent }) => {
        await assertSessionMovable(client, sessionId, deps.isSessionBusy, assertCurrent);
        return { ok: true as const };
      });
    },
    isManagedDialogueWorkspace,
    validateProjectDirectory: validateExistingLocalProjectDirectory,
    registerProject: (sessionId, workingDir) => createProject({ callerSessionId: sessionId, workingDir }),
    hideProject: async (directory) => {
      await setLocalProjectHidden(directory, true, getActiveDataOwnerPushStamp());
    },
    moveTask: (sessionId, directory) =>
      moveSessionProjectFromHost(deps.isSessionBusy, sessionId, directory, () => {}),
  };
  return createProjectFromTaskHandlers({
    service,
    resolveRoot: resolveCurrentProjectsRoot,
    chooseDirectory: deps.chooseDirectory,
    writeRoot: writeProjectsRootDirectory,
  });
}

function resolveCurrentProjectsRoot() {
  const client = tryGetDbClient();
  if (!client || isAppSessionBoundaryPending()) {
    throwIpcError('PRECONDITION_FAILED', 'Cindy project storage is not ready.');
  }
  return resolveProjectsRoot(client);
}

/** Settings page: the stored value is only ever a picker result or null (follow the suggestion). */
export function createProjectsRootSettingsHandlers(deps: { chooseDirectory(): Promise<string | null> }) {
  const mutate = async (choose: boolean) => {
    const scope = activeOwnerScopeKey();
    const directory = choose ? await deps.chooseDirectory() : null;
    if (choose && directory === null) return resolveCurrentProjectsRoot();
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== scope) {
      throwIpcError('PRECONDITION_FAILED', 'projects root owner changed');
    }
    await writeProjectsRootDirectory(directory);
    return resolveCurrentProjectsRoot();
  };
  return {
    get: resolveCurrentProjectsRoot,
    choose: () => mutate(true),
    reset: () => mutate(false),
  };
}
