/**
 * hook-control/workspaceProviderSourceStore.ts
 * ---------------------------------------------------------------------------
 * IM hook 工作目录(含内置「对话」)的**模型来源(providerId)偏好** —— 纯客户端数据。
 *
 * 为什么单独存本地而不进 server prefs 表:来源是纯客户端维度(供应商凭证、
 * 连接态、目录、派发全在客户端,server 对它零感知,Slack /model 卡也不需要
 * 编辑它)。model/effort/agentKind/permissionMode 的正本同样在本机
 * (workspacePrefsStore);本表按 (channel, teamId, workspace) 记来源,派发合成
 * 时与本机目录 model 组合,再经 effectiveSourceIdForModel 校验:显式来源失效时
 * 拒绝新任务而不换账号;目录模型为空(继承 IM 默认)时,账号可用但不提供继承模型
 * 的残留来源被忽略(issue #5912)。远端快照改模型时同键来源一并清除。
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
    r.providerId.length <= 128 &&
    (r.agentDeviceId == null || (typeof r.agentDeviceId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(r.agentDeviceId)))
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
  return getWorkspaceProviderRoute(channel, teamId, workspace)?.providerId ?? null;
}

export function getWorkspaceProviderRoute(
  channel: HookProviderChannel,
  teamId: string | null,
  workspace: string,
): WorkspaceProviderSourceEntry | null {
  const entries = readFileEntries(filePath());
  return (
    entries.find((e) => sameKey(e, channel, teamId, workspace)) ??
    entries.find((e) => sameKey(e, channel, null, workspace)) ??
    null
  );
}

/** 写/清一条来源偏好(providerId = null 删除条目);返回更新后的全量条目。 */
export function setWorkspaceProviderSource(
  channel: HookProviderChannel,
  teamId: string | null,
  workspace: string,
  providerId: string | null,
  agentDeviceId?: string | null,
): WorkspaceProviderSourceEntry[] {
  const fp = filePath();
  const rest = readFileEntries(fp).filter((e) => !sameKey(e, channel, teamId, workspace));
  const next =
    providerId === null ? rest : [...rest, { channel, teamId, workspace, providerId,
      ...(agentDeviceId ? { agentDeviceId } : {}) }];
  writeFileEntries(fp, next);
  return next;
}

/** 只需要偏好行的定位键与路由字段(HookWorkspacePrefs 的子集)。 */
interface WorkspaceRouteRow {
  workspace: string;
  teamId?: string | null;
  agentKind: string | null;
  model: string | null;
}

/**
 * server 快照改动了某目录的路由(agentKind 或 model 改成别的 / 清空 / 整行消失)后,
 * 清掉同键的来源偏好;有清除时返回更新后的全量条目, 否则返回 null。
 *
 * 来源只在本机模型面板里和 (Agent, 模型) 一起选, 远端(/model 卡、服务端快照)改路由时
 * 没有来源通道 —— 留着旧来源就会拼出「新路由 + 旧来源」的不可执行组合(issue #5912)。
 * 本机尚未镜像的写入在快照合并时优先, 路由不会被改动, 也就不会误清刚选的来源。
 *
 * 只按来源条目自身的键比较。null-team 来源被多个 team 当兜底共用, 某个 team 远端改了
 * 自己的路由时不清它: 清掉会让仍在用它的其它 team 静默改走默认来源(换账号)。这种
 * 组合派发时按「显式来源失效」拒绝并提示重新选择。
 */
export function clearWorkspaceProviderSourcesForRemoteModelChanges(
  channel: HookProviderChannel,
  before: readonly WorkspaceRouteRow[],
  after: readonly WorkspaceRouteRow[],
): WorkspaceProviderSourceEntry[] | null {
  const keyOf = (row: { teamId?: string | null; workspace: string }): string =>
    `${row.teamId ?? ''}::${row.workspace}`;
  const routeOf = (row: WorkspaceRouteRow): string =>
    JSON.stringify([row.agentKind ?? null, row.model ?? null]);
  const routeBefore = new Map(before.map((row) => [keyOf(row), routeOf(row)] as const));
  const routeAfter = new Map(after.map((row) => [keyOf(row), routeOf(row)] as const));
  const empty = JSON.stringify([null, null]);
  const changed = (e: WorkspaceProviderSourceEntry): boolean =>
    (routeBefore.get(keyOf(e)) ?? empty) !== (routeAfter.get(keyOf(e)) ?? empty);
  const fp = filePath();
  const entries = readFileEntries(fp);
  const next = entries.filter((e) => e.channel !== channel || !changed(e));
  if (next.length === entries.length) return null;
  writeFileEntries(fp, next);
  return next;
}
