/**
 * 托管会话留在本机 Agent 目录里的会话记录(受邀者的分享删除时清理)。
 *  - Claude Code：按影子目录分的项目记录(含本机侧任务 id)，以及按会话 id 存放的文件快照、
 *    会话环境、待办与调试日志；
 *  - Pi：按本机侧任务 id 存放的子代理运行目录；
 *  - Codex 与 Pi 的会话历史本身在受邀者目录(runHost 的 guest-homes)里，随它整体删除。
 * 一律按 id 精确匹配，不碰本机用户自己的会话。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

import { piSubagentRunRoot, stopAndRemovePiSubagentRuns } from '@cindy/maker-core/pi-subagent-runs';

import { claudeConfigDir } from '../controller/projectFiles';

/**
 * 删除 Claude Code 为这些本机侧任务写下的会话记录。会话记录按工作目录(影子目录)分项目存放，
 * 项目目录名由工作目录路径换算而来，本机侧任务 id 原样保留在其中。
 */
export async function purgeClaudeHostedTranscripts(
  hostSessionIds: readonly string[],
  configDir: string = claudeConfigDir(),
): Promise<void> {
  const ids = hostSessionIds.filter(Boolean);
  if (!ids.length) return;
  const projectsDir = path.join(configDir, 'projects');
  let entries: string[];
  try {
    entries = await fsp.readdir(projectsDir);
  } catch {
    return;
  }
  await Promise.all(entries
    .filter((name) => ids.some((id) => name.includes(id)))
    .map((name) => fsp.rm(path.join(projectsDir, name), { recursive: true, force: true })));
}

/** Claude Code 的会话 id(UUID)。只按这种形状的 id 拼路径，避免把别的字符串当目录名。 */
const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 删除 Claude Code 按会话 id 存放的附属记录：文件快照(file-history/<id>)、会话环境
 * (session-env/<id>)、待办(todos/<id>-*.json)与调试日志(debug/<id>.txt)。
 */
export async function purgeClaudeHostedSessionArtifacts(
  nativeIds: readonly string[],
  configDir: string = claudeConfigDir(),
): Promise<void> {
  const ids = [...new Set(nativeIds.filter((id) => CLAUDE_SESSION_ID.test(id)).map((id) => id.toLowerCase()))];
  if (!ids.length) return;
  const removals: Array<Promise<void>> = [];
  for (const id of ids) {
    removals.push(fsp.rm(path.join(configDir, 'file-history', id), { recursive: true, force: true }));
    removals.push(fsp.rm(path.join(configDir, 'session-env', id), { recursive: true, force: true }));
    removals.push(fsp.rm(path.join(configDir, 'debug', `${id}.txt`), { force: true }));
  }
  const todos = await fsp.readdir(path.join(configDir, 'todos')).catch(() => [] as string[]);
  for (const name of todos) {
    const lower = name.toLowerCase();
    if (ids.some((id) => lower === `${id}.json` || lower.startsWith(`${id}-`))) {
      removals.push(fsp.rm(path.join(configDir, 'todos', name), { force: true }));
    }
  }
  await Promise.all(removals);
}

/**
 * 删除 Pi 为这些本机侧任务留下的子代理运行目录(按任务 id 精确定位，含子代理的会话与记录)。
 * 父任务已经结束；仍在后台跑的子代理先停下再删。确认不了停止的保留，抛错让上层下次重试。
 */
export async function purgePiHostedSubagentRuns(
  hostSessionIds: readonly string[],
  agentHome: string,
  removeRuns: (root: string) => Promise<boolean> = stopAndRemovePiSubagentRuns,
): Promise<void> {
  const failed: string[] = [];
  for (const id of new Set(hostSessionIds.filter(Boolean))) {
    let root: string;
    try {
      root = piSubagentRunRoot(agentHome, id);
    } catch {
      continue;
    }
    if (!(await fsp.stat(root).then(() => true, () => false))) continue;
    if (!(await removeRuns(root))) failed.push(id);
  }
  if (failed.length) throw new Error(`Pi subagent runs could not be stopped for ${failed.length} task(s)`);
}
