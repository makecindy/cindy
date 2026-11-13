/**
 * hook-control/projectCatalog.ts
 * ---------------------------------------------------------------------------
 * 侧栏的本机项目, 供官方 IM 机器人使用: 登记过的目录减去已移除的, 名字取用户起的
 * 名字、否则目录名。与 Agent 的 list_projects、伙伴的关联项目读的是同一份数据
 * (recent_workdirs + project_aliases + 侧栏移除标记); 伙伴自己的项目不在其中 ——
 * 它只从伙伴进入, 不作为普通项目出现在选择里。
 */

import path from 'node:path';

import { desc } from 'drizzle-orm';
import { BrowserWindow } from 'electron';
import { isTeammateProjectPath } from '@cindy/maker-shared/teammate-project';

import { getActiveDataOwnerPushStamp, isAppSessionBoundaryPending } from '../appSessionState.js';
import { tryGetDbClient } from '../localDb/client/current.js';
import { listProjectAliases } from '../localDb/ipc/projectAliases.js';
import { upsertRecentWorkdir } from '../localDb/ipc/recentWorkdirs.js';
import { recentWorkdirs } from '../localDb/schema.js';
import {
  validateExistingLocalProjectDirectory,
  validateLocalProjectDirectory,
} from '../mcp-integrations/createProject.js';
import { loadSidebarSettingsSnapshot, restoreLocalProjectVisibility } from '../sidebarSettingsStore.js';
import { isTrustedAppRendererWindow } from '../security/trustedAppRenderer.js';
import { projectKeyComparisonKey } from '../../shared/projectKeys.js';
import type { ProjectCatalogSnapshot } from './projectWorkspaceSync.js';

const identity = (directory: string): string | null =>
  projectKeyComparisonKey(`local:${directory}`, process.platform);

/** 读当前账号的侧栏本机项目(最近使用在前); 存储没就绪或账号正在切换时返回 null。 */
export async function loadImProjectCatalog(): Promise<ProjectCatalogSnapshot | null> {
  const client = tryGetDbClient();
  if (!client || isAppSessionBoundaryPending()) return null;
  const owner = getActiveDataOwnerPushStamp();
  const isCurrent = (): boolean => {
    const current = getActiveDataOwnerPushStamp();
    return (
      !isAppSessionBoundaryPending() &&
      tryGetDbClient() === client &&
      current.dataOwnerId === owner.dataOwnerId &&
      current.ownerGeneration === owner.ownerGeneration
    );
  };
  const [rows, aliases] = await Promise.all([
    client.drizzle
      .select({ path: recentWorkdirs.path, lastUsedAt: recentWorkdirs.lastUsedAt })
      .from(recentWorkdirs)
      .orderBy(desc(recentWorkdirs.lastUsedAt)),
    listProjectAliases(client),
  ]);
  if (!isCurrent()) return null;
  const hidden = new Set(
    loadSidebarSettingsSnapshot().hiddenProjectKeys.map((key) =>
      projectKeyComparisonKey(key, process.platform),
    ),
  );
  const names = new Map<string | null, string>();
  // 名字按新到旧返回; 同一项目留最新的一个(与 list_projects 相同)。
  for (const row of aliases) {
    const key = projectKeyComparisonKey(row.projectKey, process.platform);
    if (!names.has(key)) names.set(key, row.alias);
  }
  const projects = rows
    .filter((row) => !hidden.has(identity(row.path)) && !isTeammateProjectPath(row.path))
    .map((row) => ({
      path: row.path,
      name: names.get(identity(row.path)) ?? (path.basename(row.path) || row.path),
      lastUsedAtMs: row.lastUsedAt,
    }));
  return { projects, isCurrent, isRemoved: (directory) => hidden.has(identity(directory)) };
}

export type RegisterImProjectResult =
  | { ok: true; workingDir: string }
  | { ok: false; errorCode: string; message: string };

/**
 * 把一个本机目录登记成项目(侧栏与 IM 机器人共用的那一份); 之前移除过的恢复显示。
 * 不能是对话的托管目录、任务 worktree 或伙伴的项目。默认要求目录存在; 升级迁移传
 * `requireExisting: false`, 暂时不在的目录(外接盘没插)也登记。
 */
export async function registerImProjectDirectory(
  directory: string,
  options: { requireExisting?: boolean } = {},
): Promise<RegisterImProjectResult> {
  const lexical = validateLocalProjectDirectory(directory);
  if (!lexical.ok) return lexical;
  if (isTeammateProjectPath(lexical.workingDir)) {
    return { ok: false, errorCode: 'INVALID_ARGS', message: 'Teammate projects are opened from the teammate.' };
  }
  const client = tryGetDbClient();
  if (!client || isAppSessionBoundaryPending()) {
    return { ok: false, errorCode: 'HOST_NOT_READY', message: 'Cindy project storage is not ready.' };
  }
  const owner = getActiveDataOwnerPushStamp();
  try {
    // 先按字面拦对话托管目录, 再看磁盘; 目录不在时 stat 抛错。
    const physical = await validateExistingLocalProjectDirectory(lexical.workingDir);
    if (!physical.ok) return physical;
  } catch {
    if (options.requireExisting !== false) {
      return { ok: false, errorCode: 'NOT_FOUND', message: 'Directory does not exist.' };
    }
  }
  if (tryGetDbClient() !== client || isAppSessionBoundaryPending()) {
    return { ok: false, errorCode: 'PRECONDITION_FAILED', message: 'The active Cindy account changed.' };
  }
  if (!(await upsertRecentWorkdir(lexical.workingDir, Date.now(), process.platform, client))) {
    return { ok: false, errorCode: 'INTERNAL', message: 'Could not register the project directory.' };
  }
  await restoreLocalProjectVisibility(lexical.workingDir, owner);
  // 侧栏的项目列表靠这条广播刷新(与 create_project 同一条)。
  for (const window of BrowserWindow.getAllWindows()) {
    if (!isTrustedAppRendererWindow(window)) continue;
    try {
      window.webContents.send('local-db:recent-workdirs:changed', { path: lexical.workingDir }, owner);
    } catch {
      /* 列表下次读取时刷新 */
    }
  }
  return { ok: true, workingDir: lexical.workingDir };
}
