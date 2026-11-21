/**
 * The recent project record of a user's send: moved verbatim out of touchUserSendInDb
 * (localDb/ipc/sessions.ts, which imports electron), which calls it where the record stood. The Node
 * Host's touchUserSend records the same way.
 */
import type { DbClient } from '../client/DbClient';
import type { touchUserSendRow } from '../sessionQueries.js';
import type { touchRecentWorkdir as touchRecentWorkdirInDb } from './recentWorkdirsCore.js';
import { isRetainableProjectSession } from '../../../shared/sessionSource.js';
import { normalizeWorkingDirForProjectSettings } from '../../../shared/workingDir.js';

/**
 * touchUserSendInDb's record: a send to a task in a retainable local project keeps that project's real
 * use time and announces it. `updated` is touchUserSendRow's result, at least one row.
 */
export async function recordRecentWorkdirForSend<OwnerScope>({
  updated,
  ts,
  dbClient,
  ownerScope,
  touchRecentWorkdir,
  broadcastRecentWorkdirsChanged,
}: {
  updated: Awaited<ReturnType<typeof touchUserSendRow>>;
  ts: number;
  dbClient: DbClient;
  ownerScope: OwnerScope;
  touchRecentWorkdir: typeof touchRecentWorkdirInDb;
  broadcastRecentWorkdirsChanged: (path: string, ownerScope: OwnerScope) => void;
}): Promise<void> {
  // 项目独立保留真实使用时间；不能等归档/删除时再取清理时间，也不能从剩余任务重算。
  // 复用入口处的 client，避免 await 期间切换账号后把旧项目写入新账号数据库。
  const row = updated[0];
  if (
    row.workspaceKind === 'project' &&
    row.workingDir &&
    !row.remoteHostId &&
    isRetainableProjectSession(row)
  ) {
    const projectDir = normalizeWorkingDirForProjectSettings(row.projectDir ?? row.workingDir);
    const touched = await touchRecentWorkdir(projectDir, ts, process.platform, dbClient);
    if (touched && projectDir) broadcastRecentWorkdirsChanged(projectDir, ownerScope);
  }
}
