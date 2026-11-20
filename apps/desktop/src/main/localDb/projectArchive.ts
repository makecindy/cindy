import type { ProjectArchiveGuard } from './projectArchiveGuard.js';
import { CINDY_MAKE_ENABLED, isCindyMakeSource } from '@cindy/maker-shared/cindy-make-feature';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { sessionProjectDirectory } from '@cindy/maker-shared/worktree-paths';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { sessions } from './schema.js';
import { getDbClient } from './client/current.js';
import { ordinaryTaskListFilter } from './sessionQueries.js';
import { remoteVisibleSessionSql } from './ipc/botRemoteVisibility.js';
import { normalizeWorkingDirForGrouping, workingDirEquals } from '../../shared/workingDir.js';
import type { ProjectArchiveMember, ProjectArchiveReceipt } from '../../shared/projectArchive.js';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';

type Status = 'active' | 'archived';
interface ProjectArchivePorts {
  busy(id: string): boolean;
  withLock<T>(id: string, task: () => Promise<T>): Promise<T>;
  write(
    id: string,
    status: Status,
    assertCurrent: () => void,
    guard: ProjectArchiveGuard,
    preserveFiles?: boolean,
  ): Promise<void>;
}

// Device Link groups by owning device + normalized project directory. Read only
// ordinary visible task metadata; sidebar pagination and filters do not limit the operation.
export async function runProjectArchive(
  input: unknown,
  viaDeviceLink: boolean,
  ports: ProjectArchivePorts,
) {
  const request = requireObject(input, 'request');
  const directory = requireString(request.directory, 'directory');
  const { operation } = request;
  // A distinct action fails closed on versions without file-preserving archive.
  const preserveFiles = !viaDeviceLink && request.remoteHostId == null && request.action === 'archiveOnRemoval';
  const action = preserveFiles ? 'archive' : request.action;
  const remoteHostId =
    !viaDeviceLink && request.remoteHostId != null
      ? requireString(request.remoteHostId, 'remoteHostId')
      : null;
  if (
    (operation !== 'preview' && operation !== 'apply') ||
    (action !== 'archive' && action !== 'unarchive')
  )
    throwIpcError('INVALID_PARAMS', 'Invalid project archive action');
  const targetStatus = action === 'archive' ? 'archived' : 'active';
  const sessionId = operation === 'apply' ? requireString(request.sessionId, 'sessionId') : null;
  const owner = activeOwnerScopeKey();
  const client = getDbClient();
  function assertCurrent() {
    if (
      owner !== activeOwnerScopeKey() ||
      isAppSessionBoundaryPending() ||
      getDbClient() !== client
    )
      throwIpcError('PRECONDITION_FAILED', 'Project owner changed');
  }
  async function readMembers(): Promise<(ProjectArchiveMember & ProjectArchiveGuard)[]> {
    assertCurrent();
    const rows = await client.drizzle
      .select({
        id: sessions.id,
        source: sessions.source,
        remoteHostId: sessions.remoteHostId,
        workspaceKind: sessions.workspaceKind,
        workingDir: sessions.workingDir,
        projectDir: sessions.projectDir,
        pinnedAt: sessions.pinnedAt,
        worktreePath: sessions.worktreePath,
        attached: sql<number>`EXISTS (SELECT 1 FROM im_bindings b WHERE b.target_session_id = sessions.id)`,
      })
      .from(sessions)
      .where(
        and(
          ordinaryTaskListFilter(),
          viaDeviceLink ? sql.raw(remoteVisibleSessionSql('sessions')) : undefined,
          viaDeviceLink
            ? undefined
            : remoteHostId
              ? eq(sessions.remoteHostId, remoteHostId)
              : isNull(sessions.remoteHostId),
          sql`(${sessions.orcaRole} IS NULL OR ${sessions.orcaRole} <> 'worker')`,
          or(
            eq(sessions.workspaceKind, 'project'),
            sql`EXISTS (
              SELECT 1 FROM bot_session_links lane WHERE lane.session_id = sessions.id AND lane.role = 'group'
            )`,
          ),
          eq(sessions.status, action === 'archive' ? 'active' : 'archived'),
          sessionId ? eq(sessions.id, sessionId) : undefined,
        ),
      );
    assertCurrent();
    return rows
      .filter((row) => {
        if (!CINDY_MAKE_ENABLED && isCindyMakeSource(row.source)) return false;
        const path = normalizeWorkingDirForGrouping(sessionProjectDirectory(row));
        return viaDeviceLink || remoteHostId
          ? path === directory
          : workingDirEquals(path, directory);
      })
      .map((row) => ({
        id: row.id,
        remoteHostId: row.remoteHostId,
        workingDir: row.workingDir,
        projectDir: row.projectDir,
        workspaceKind: row.workspaceKind,
        hasWorktree: Boolean(row.worktreePath),
        blocked:
          action !== 'archive'
            ? null
            : row.pinnedAt != null
              ? 'pinned'
              : row.attached
                ? 'attached'
                : ports.busy(row.id)
                  ? 'running'
                  : null,
      }));
  }
  if (sessionId === null) {
    const members = await readMembers();
    return members.map(({ id, blocked, hasWorktree }) => ({ id, blocked, hasWorktree }));
  }
  return ports.withLock(sessionId, async (): Promise<ProjectArchiveReceipt> => {
    const [member] = await readMembers();
    if (!member) return 'changed';
    if (member.blocked) return member.blocked;
    const beforeWrite = () => {
      assertCurrent();
      if (action === 'archive' && ports.busy(sessionId))
        throwIpcError('PRECONDITION_FAILED', 'Task started running');
    };
    beforeWrite();
    await ports.write(sessionId, targetStatus, beforeWrite, {
      remoteHostId: member.remoteHostId,
      workingDir: member.workingDir,
      projectDir: member.projectDir,
      workspaceKind: member.workspaceKind,
    }, preserveFiles);
    return 'updated';
  });
}
