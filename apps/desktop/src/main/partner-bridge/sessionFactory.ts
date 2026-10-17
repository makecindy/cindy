/**
 * partner-bridge/sessionFactory.ts
 * ---------------------------------------------------------------------------
 * 给外部调用建专属会话行(不拉起 agent 进程,首条消息由统一投递通路拉起)。
 *
 * 与 createGhostErrandSession 同流程(见 localDb/ipc/pluginWorkspaceSessions.ts):
 * 缺省落 app 托管的对话目录,给了 workingDir 才进项目工作区;git bootstrap、
 * 最近项目、广播的副作用与其保持一致,差别只有 source='bridge' —— 会话在侧边栏
 * 「对话」分组可见,用户能进去看、能停,不做隐藏会话。
 */

import { randomUUID } from 'node:crypto';

import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { sessionCreateToRow } from '../localDb/mapper.js';
import { ensureDialogueWorkspaceDir } from '../localDb/dialogueWorkspace.js';
import { ensureProjectGitInitialized } from '../git-snapshot/projectGitBootstrap.js';
import { readGitSafetySettings } from '../maker-host/git-safety-settings-store.js';
import { upsertRecentWorkdir } from '../localDb/ipc/recentWorkdirs.js';
import { createLogger } from '../logger.js';
import { normalizeWorkingDirForStorage } from '../../shared/workingDir.js';

import type { PartnerSessionCreateParams } from './types.js';

const log = createLogger('partner-bridge');

export async function createPartnerSession(params: PartnerSessionCreateParams): Promise<string> {
  const db = getDbClient().drizzle;
  const now = Date.now();
  const id = randomUUID();
  const projectDir = params.workingDir
    ? (normalizeWorkingDirForStorage(params.workingDir) ?? undefined)
    : undefined;
  const workspaceKind = projectDir ? ('project' as const) : ('dialogue' as const);
  const workingDir = projectDir ?? ensureDialogueWorkspaceDir(id, now);
  const insertRow = {
    ...sessionCreateToRow(
      id,
      {
        workingDir,
        workspaceKind,
        permissionMode: params.permissionMode,
        ...(params.agentKind ? { agentKind: params.agentKind } : {}),
        ...(params.model ? { model: params.model } : {}),
        ...(params.effort ? { effort: params.effort } : {}),
        ...(params.fastMode !== undefined ? { fastMode: params.fastMode } : {}),
        ...(params.providerId !== undefined ? { providerId: params.providerId } : {}),
      },
      now,
    ),
    source: 'bridge' as const,
    ...(params.title ? { title: params.title } : {}),
  };
  await ensureProjectGitInitialized({
    workingDir: insertRow.workingDir,
    workspaceKind: insertRow.workspaceKind,
    remoteHostId: insertRow.remoteHostId,
    sessionId: id,
    autoSnapshotEnabled: readGitSafetySettings().autoSnapshotEnabled,
    source: 'partner-bridge-session',
  });
  await db.insert(sessions).values(insertRow);
  if (projectDir && insertRow.workingDir) {
    void upsertRecentWorkdir(insertRow.workingDir, now);
  }
  log.info('partner session created', {
    sessionId: id,
    key: params.key,
    workspaceKind,
    workingDir: insertRow.workingDir,
  });
  return id;
}
