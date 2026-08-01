/**
 * hook-control/workspaceProviderSourceStore.ts
 * ---------------------------------------------------------------------------
 * IM hook 工作目录(含内置「对话」)的**模型来源(providerId)偏好** —— 纯客户端数据。
 *
 * 为什么单独存本地而不进 server prefs 表:来源是纯客户端维度(供应商凭证、
 * 连接态、目录、派发全在客户端,server 对它零感知,Slack /model 卡也不需要
 * 编辑它)。server prefs 继续只存 model/effort/agentKind/permissionMode 四字段
 * 服务卡片展示;本表按 (channel, teamId, workspace) 记来源,派发合成时与
 * server 显式 model 组合,再经 effectiveSourceIdForModel 收窄到真实已连接来源
 * (来源断开/不提供该模型时自动回落,不会拼出不可能路由)。
 *
 * 持久化 <userData>/hook-workspace-provider-source.json —— 属配置而非业务数据,
 * 与 slack-hook.json 同级同模式(原子写防半截文件);不含任何凭证。
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  HOOK_WORKSPACE_ALIAS_RE,
  type HookWorkspaceProviderSourceEntry,
} from '../../shared/hookControlIpc.js';
import { ownerScopedImUserDataPath } from '../im/ownerScopedStorage.js';

export type HookProviderChannel = HookWorkspaceProviderSourceEntry['channel'];
/** 持久化条目形状 = IPC 契约形状(shared 单一来源, 防 main/renderer 漂移)。 */
export type WorkspaceProviderSourceEntry = HookWorkspaceProviderSourceEntry;

interface StoreFile {
  entries: WorkspaceProviderSourceEntry[];
}

const FILE_NAME = 'hook-workspace-provider-source.json';

// owner-scoped(owners/<hash>/…):来源偏好属账号数据 —— 放 userData 根会让
// 同机第二个账号消费第一个账号留下的订阅来源(Greptile/codex review 同点)。
// 新文件无 legacy 迁移负担,直接落 scoped 路径。
function filePath(): string {
  return ownerScopedImUserDataPath(FILE_NAME);
}

// 读侧与 IPC 写侧同规收紧(Copilot review):文件被手工改坏/外部写入异常值时,
// 不合规条目在读取即被过滤,不透传 renderer、不参与派发查找。
function isEntry(raw: unknown): raw is WorkspaceProviderSourceEntry {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return (
    (r.channel === 'slack' || r.channel === 'telegram' || r.channel === 'x') &&
    (r.teamId === null || (typeof r.teamId === 'string' && r.teamId.length > 0 && r.teamId.length <= 64)) &&
    typeof r.workspace === 'string' &&
    HOOK_WORKSPACE_ALIAS_RE.test(r.workspace) &&
    typeof r.providerId === 'string' &&
    r.providerId.length > 0 &&
    r.providerId.length <= 128
  );
}

function readFileEntries(fp: string): WorkspaceProviderSourceEntry[] {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    const entries = (raw as StoreFile | null)?.entries;
    if (!Array.isArray(entries)) return [];
    return entries.filter(isEntry);
  } catch {
    // 文件不存在 / 损坏 → 空表(损坏文件在下次写入时被完整覆盖)
    return [];
  }
}

function writeFileEntries(fp: string, entries: WorkspaceProviderSourceEntry[]): void {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ entries } satisfies StoreFile, null, 2), 'utf-8');
  fs.renameSync(tmp, fp);
}

const sameKey = (
  e: WorkspaceProviderSourceEntry,
  channel: HookProviderChannel,
  teamId: string | null,
  workspace: string,
): boolean => e.channel === channel && e.teamId === teamId && e.workspace === workspace;

/** 全量条目(设置页一次拉取)。 */
export function listWorkspaceProviderSources(): WorkspaceProviderSourceEntry[] {
  return readFileEntries(filePath());
}

/**
 * 某 (channel, teamId, workspace) 的来源偏好。
 * teamId 精确匹配优先,null 行兜底 —— 与 prefsFor 的 multi-team 宽松语义一致。
 */
export function getWorkspaceProviderSource(
  channel: HookProviderChannel,
  teamId: string | null,
  workspace: string,
): string | null {
  const entries = readFileEntries(filePath());
  return (
    entries.find((e) => sameKey(e, channel, teamId, workspace))?.providerId ??
    entries.find((e) => sameKey(e, channel, null, workspace))?.providerId ??
    null
  );
}

/** 写/清一条来源偏好(providerId = null 删除条目);返回更新后的全量条目。 */
export function setWorkspaceProviderSource(
  channel: HookProviderChannel,
  teamId: string | null,
  workspace: string,
  providerId: string | null,
): WorkspaceProviderSourceEntry[] {
  const fp = filePath();
  const rest = readFileEntries(fp).filter((e) => !sameKey(e, channel, teamId, workspace));
  const next =
    providerId === null ? rest : [...rest, { channel, teamId, workspace, providerId }];
  writeFileEntries(fp, next);
  return next;
}
