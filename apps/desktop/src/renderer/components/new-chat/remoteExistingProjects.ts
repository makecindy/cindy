/**
 * remoteExistingProjects —— 「添加远程项目」弹窗「已有项目」列表的数据源。
 *
 * 两类远程目标的「对方机器已有项目」来自不同数据源(纯函数 + 一个隧道取数 helper,
 * 全部可单测,UI 只消费 ExistingRemoteProject):
 *   - device-link 被控设备:隧道拉被控端 recent_workdirs(`local-db:recent-workdirs:list`,
 *     已在 device-link allowlist),与被控端本地 folder picker 同源(LRU≤10,session
 *     归档/删除仍保留)。
 *   - SSH 远程主机:远端无 recent 表 —— SSH 会话存在控制端本地、带 remoteHostId,
 *     故「已有项目」= 本地会话里该 host 的 project 会话 workingDir 去重。
 *
 * 显示名一律用 projectGrouping.extractDisplayName 跨全集消歧(与 useProjectPickerOptions
 * 同款),保证与侧边栏/本地项目下拉的命名风格一致。
 */

import { extractDisplayName } from '@/features/cc-agent/lib/projectGrouping';
import type { Session } from '@/lib/ccAgent.types';

export interface ExistingRemoteProject {
  /** 添加时透传给 onProjectAdded 的原始路径(device-link=被控端 native 形态;SSH=远端 POSIX)。 */
  path: string;
  /** 同名消歧后的展示名。 */
  name: string;
  /** device-link 被控端的目录存在性探测;SSH 数据源没有该信息。 */
  exists?: boolean;
}

/** extractDisplayName 按 `/` 切分 —— 统一成 POSIX 再消歧(Windows 反斜杠路径也能正确取名)。 */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** 把一组路径映射成带消歧展示名的项目列表(保序)。 */
function toProjects(paths: readonly string[]): ExistingRemoteProject[] {
  const posixAll = paths.map(toPosix);
  return paths.map((path, idx) => {
    const { name } = extractDisplayName(posixAll[idx], posixAll);
    return { path, name };
  });
}

/** 被控端 recent_workdirs 行(`local-db:recent-workdirs:list` 的返回元素)。 */
interface RecentWorkdirRow {
  path: string;
  lastUsedAt: string;
  exists?: boolean;
}

/** device-link:被控端 recent_workdirs → 已有项目列表(保序,handler 已按 lastUsedAt desc 排好)。 */
export function recentWorkdirsToProjects(
  rows: readonly RecentWorkdirRow[],
): ExistingRemoteProject[] {
  return toProjects(rows.map((r) => r.path)).map((project, index) => ({
    ...project,
    ...(rows[index].exists === undefined ? {} : { exists: rows[index].exists }),
  }));
}

/** SSH:本地会话里 remoteHostId 命中该 host 的 project 会话 workingDir 去重 → 已有项目列表。 */
export function sshExistingProjects(
  sessions: readonly Session[],
  hostId: string,
): ExistingRemoteProject[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const s of sessions) {
    if (s.remoteHostId !== hostId) continue;
    if (s.workspaceKind !== 'project') continue;
    const dir = s.workingDir?.trim();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return toProjects(dirs);
}

/** device-link:隧道拉被控端 recent_workdirs 并映射成已有项目列表。 */
export async function loadDeviceLinkExistingProjects(
  deviceId: string,
): Promise<ExistingRemoteProject[]> {
  const rows = (await window.electronAPI.deviceLink.invoke(
    deviceId,
    'local-db:recent-workdirs:list',
    [],
  )) as RecentWorkdirRow[] | null | undefined;
  return recentWorkdirsToProjects(rows ?? []);
}

/** device-link:从被控端最近项目列表移除一条,不删除会话或磁盘目录。 */
export async function removeDeviceLinkExistingProject(
  deviceId: string,
  path: string,
): Promise<void> {
  await window.electronAPI.deviceLink.invoke(
    deviceId,
    'local-db:recent-workdirs:remove',
    [{ path }],
  );
}
