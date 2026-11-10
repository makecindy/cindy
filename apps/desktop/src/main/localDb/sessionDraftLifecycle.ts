import { eq } from 'drizzle-orm';
import { getDbClient } from './client/current.js';
import { sessions } from './schema.js';
import { ensureOpenedProjectGit } from './sessionOpening.js';
import { claimOwnedProvisionalSession, forgetProvisionalSession, provisionalManagedDir,
  deleteUnsentSessionRow, removeEmptyDialogueDir } from './provisionalSessions.js';
import { createLogger } from '../logger.js';
const log = createLogger('local-db-sessions');
export interface SessionDraftPorts {
  emitSessionCreated(sessionId: string): void;
  emitSessionListChangedLocally(sessionId: string): void;
  notifyPluginSessionCreated(input: { sessionId: string; workdir?: string }): void;
}

export async function commitProvisionalSession(sessionId: string, ports: SessionDraftPorts): Promise<boolean> {
  if (claimOwnedProvisionalSession(sessionId) !== 'owned') return false;
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({
      workingDir: sessions.workingDir,
      workspaceKind: sessions.workspaceKind,
      remoteHostId: sessions.remoteHostId,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row) return false;
  await ensureOpenedProjectGit({ id: sessionId, ...row }).catch((error) => {
    log.warn('provisional session git bootstrap failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  // The account may have changed during the awaits: then it stays an unsent leftover of the
  // old account (claim parks it) instead of becoming an ordinary task there.
  if (claimOwnedProvisionalSession(sessionId) !== 'owned') return false;
  forgetProvisionalSession(sessionId);
  ports.emitSessionCreated(sessionId);
  ports.notifyPluginSessionCreated({ sessionId, ...(row.workingDir ? { workdir: row.workingDir } : {}) });
  log.info('provisional session committed', { sessionId });
  return true;
}

/**
 * 删掉一个未发送任务（用户清空了新建页的输入）：仍未发送、没有消息时才真正删除行，
 * 顺带删掉为它新建、仍为空的对话目录，并通知本机窗口移除。调用方负责先关掉它的 Agent。
 */
export async function discardProvisionalSessionRow(sessionId: string, ports: SessionDraftPorts): Promise<boolean> {
  if (claimOwnedProvisionalSession(sessionId) !== 'owned') return false;
  const managedDir = provisionalManagedDir(sessionId);
  const deleted = await deleteUnsentSessionRow(sessionId);
  if (!deleted) {
    // Already sent (or gone): it is an ordinary task now.
    forgetProvisionalSession(sessionId);
    return false;
  }
  removeEmptyDialogueDir(sessionId, managedDir);
  forgetProvisionalSession(sessionId);
  // Other local windows re-read their lists; the row is gone, so it drops out. No status
  // patch: the same id may be opened again when the user types again.
  ports.emitSessionListChangedLocally(sessionId);
  log.info('provisional session discarded', { sessionId });
  return true;
}

