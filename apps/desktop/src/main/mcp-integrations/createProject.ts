import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import { eq } from 'drizzle-orm';
import { getActiveDataOwnerPushStamp, isAppSessionBoundaryPending } from '../appSessionState.js';
import { tryGetDbClient } from '../localDb/client/current.js';
import { dialogueWorkspaceRoots } from '../localDb/dialogueWorkspace.js';
import { sessions, botSessionLinks } from '../localDb/schema.js';
import { normalizeRecentWorkdirPath, upsertRecentWorkdir } from '../localDb/ipc/recentWorkdirs.js';
import { restoreLocalProjectVisibility } from '../sidebarSettingsStore.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import { createLogger } from '../logger.js';
import type { ControlResult } from '@cindy/mcps';
import type { DbClient } from '../localDb/client/DbClient.js';
import type { DataOwnerPushStamp } from '../../shared/dataOwnerPush.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { isTrustedAppRendererWindow } from '../security/trustedAppRenderer.js';

const log = createLogger('mcp/projects');
const fail = (errorCode: string, message: string) => ({ ok: false as const, errorCode, message });

export interface LocalProjectContext {
  client: DbClient;
  owner: DataOwnerPushStamp;
  assertCurrent: () => void;
}

/** All project operations use one captured account and validate the calling local task. */
export async function withLocalProjectContext<T extends object>(
  callerSessionId: string,
  run: (context: LocalProjectContext) => Promise<ControlResult<T, string>>,
): Promise<ControlResult<T, string>> {
  const client = tryGetDbClient();
  if (!client || isAppSessionBoundaryPending())
    return fail('HOST_NOT_READY', 'Cindy project storage is not ready.');
  const owner = getActiveDataOwnerPushStamp();
  const isCurrent = () => {
    const current = getActiveDataOwnerPushStamp();
    return (
      !isAppSessionBoundaryPending() &&
      tryGetDbClient() === client &&
      current.dataOwnerId === owner.dataOwnerId &&
      current.ownerGeneration === owner.ownerGeneration
    );
  };
  const assertCurrent = () => {
    if (!isCurrent()) throwIpcError('PRECONDITION_FAILED', 'The active Cindy account changed.');
  };
  try {
    const [caller] = await client.drizzle
      .select({ id: sessions.id, remoteHostId: sessions.remoteHostId })
      .from(sessions)
      .where(eq(sessions.id, callerSessionId))
      .limit(1);
    if (!isCurrent()) return fail('PRECONDITION_FAILED', 'The active Cindy account changed.');
    if (!caller)
      return fail('NO_SESSION_CONTEXT', 'The calling task is not available in this account.');
    if (caller.remoteHostId)
      return fail(
        'UNSUPPORTED_CAPABILITY',
        'Project registration only supports local Cindy tasks.',
      );
    // Account-generation checkpoint. Bot callers may manage projects; the
    // helper surface names the five project tools and keeps the rest of
    // control/history closed. This read must stay so an account switch during
    // the lookup still fails closed.
    await client.drizzle
      .select({ botId: botSessionLinks.botId })
      .from(botSessionLinks)
      .where(eq(botSessionLinks.sessionId, callerSessionId))
      .limit(1);
    assertCurrent();
    const result = await run({ client, owner, assertCurrent });
    assertCurrent();
    return result;
  } catch (error) {
    if (isIpcError(error)) return fail(error.code, error.message);
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT')
      return fail('NOT_FOUND', 'Directory does not exist. Create it with your file tools first.');
    if (code === 'ENOTDIR') return fail('NOT_A_DIRECTORY', 'working_dir is not a directory.');
    log.warn('project operation failed', { error: String(error) });
    return fail('INTERNAL', 'Could not complete the project operation.');
  }
}

export function validateLocalProjectDirectory(
  workingDir: string,
): ControlResult<{ workingDir: string }, string> {
  if (!path.isAbsolute(workingDir) || workingDir.includes('\0')) {
    return fail('INVALID_ARGS', 'working_dir must be an absolute local directory path.');
  }
  // Shared project identity treats backslashes as separators, even on POSIX.
  if (process.platform !== 'win32' && workingDir.includes('\\')) {
    return fail(
      'INVALID_ARGS',
      'Cindy project paths cannot contain literal backslashes on this platform.',
    );
  }
  const directory = normalizeRecentWorkdirPath(path.normalize(workingDir));
  return directory
    ? { ok: true, workingDir: directory }
    : fail('INVALID_ARGS', 'Managed task worktrees cannot be registered as separate projects.');
}

function isWithinDirectory(directory: string, root: string): boolean {
  const relative = path.relative(root, directory);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** Check physical targets without changing the caller's normalized project identity. */
export async function validateExistingLocalProjectDirectory(workingDir: string) {
  const roots = dialogueWorkspaceRoots();
  if (roots.some((root) => isWithinDirectory(workingDir, root))) {
    return fail('INVALID_ARGS', 'Managed dialogue workspaces cannot be registered as projects.');
  }
  if (!(await stat(workingDir)).isDirectory())
    return fail('NOT_A_DIRECTORY', 'working_dir is not a directory.');
  // Resolve both sides: userData itself may use a symlink (e.g. /var on macOS).
  const physicalDirectory = await realpath(workingDir);
  for (const root of roots) {
    const physicalRoot = await realpath(root).catch((error: NodeJS.ErrnoException) => {
      // Unavailable current or historical roots must not block unrelated projects.
      // Keep their lexical boundary (also checked above), and still resolve accessible aliases.
      if (typeof error.code === 'string') return root;
      throw error;
    });
    if (isWithinDirectory(physicalDirectory, physicalRoot)) {
      return fail('INVALID_ARGS', 'Managed dialogue workspaces cannot be registered as projects.');
    }
  }
  return validateLocalProjectDirectory(physicalDirectory);
}

/** Register only: filesystem creation and task execution remain separate agent actions. */
export async function createProject({
  callerSessionId,
  workingDir,
}: {
  callerSessionId: string;
  workingDir: string;
}) {
  const directory = validateLocalProjectDirectory(workingDir);
  if (!directory.ok) return directory;
  return withLocalProjectContext(callerSessionId, async ({ client, owner, assertCurrent }) => {
    const physicalDirectory = await validateExistingLocalProjectDirectory(directory.workingDir);
    if (!physicalDirectory.ok) return physicalDirectory;
    assertCurrent();
    if (!(await upsertRecentWorkdir(directory.workingDir, Date.now(), process.platform, client))) {
      return fail('INTERNAL', 'Could not register the project directory.');
    }
    assertCurrent();
    await restoreLocalProjectVisibility(directory.workingDir, owner);
    assertCurrent();
    for (const window of BrowserWindow.getAllWindows()) {
      if (!isTrustedAppRendererWindow(window)) continue;
      try {
        window.webContents.send(
          'local-db:recent-workdirs:changed',
          { path: directory.workingDir },
          owner,
        );
      } catch (error) {
        log.warn('project registered but window refresh failed', { error: String(error) });
      }
    }
    return directory;
  });
}
