/**
 * hook-control/sharedProjectPrefs.ts
 * ---------------------------------------------------------------------------
 * 所有官方 IM 机器人(飞书 / Telegram / Slack / X)共用一套「项目 -> Agent / 模型 /
 * 思考强度 / 权限档 / 模型来源」。同一个项目在哪个渠道里被用到, 都按这一份跑。
 *
 * 数据放在原有的两份本机文件里(hook-workspace-prefs.json 与
 * hook-workspace-provider-source.json), 渠道键是 `shared`:
 *   - 派发(session-runner)与设置页只读写 `shared` 这一份;
 *   - 各渠道自己的行不再是正本, 只是给各自服务端 /model、/settings 卡看的镜像:
 *     共享那份变了就投影到各渠道行(projectSharedOntoChannel), 再由原有的镜像流程
 *     (workspacePrefsMirror)推给服务端;
 *   - 在 IM 里用 /model 卡改了某个渠道的行, 改动并回共享那份(absorbChannelChange),
 *     再投影到其它渠道 —— 在哪个机器人里改都一样。
 *
 * 升级: 各渠道原有的按渠道偏好一次性并入(adoptChannelPrefs), 顺序固定为
 * 飞书 -> Telegram -> Slack -> X: 一个项目的 Agent / 模型 / 思考强度 / 来源取第一个配置过
 * 它的渠道; 权限档取各渠道显式填过的里面最严的一档 —— 合并不会把任何项目放宽。
 */

import type { HookPrefsPatch, HookWorkspacePrefs } from '../../shared/hookControlIpc.js';
import {
  SHARED_PREFS_CHANNEL,
  getWorkspacePref,
  isSharedPrefsAdopted,
  isWorkspacePrefsMigrated,
  listWorkspacePrefs,
  markSharedPrefsAdopted,
  setWorkspacePref,
  type HookPrefsChannel,
} from './workspacePrefsStore.js';
import {
  getWorkspaceProviderRoute,
  listWorkspaceProviderSources,
  setWorkspaceProviderSource,
} from './workspaceProviderSourceStore.js';

/** 并入共享那一份时的固定顺序。 */
export const OFFICIAL_PREFS_CHANNELS: readonly HookPrefsChannel[] = ['feishu', 'telegram', 'slack', 'x'];

const FIELDS = ['agentKind', 'model', 'effort', 'permissionMode'] as const;

/**
 * 权限档从严到宽。与各 Agent capabilities 声明的顺序一致(claude-code:
 * ask/acceptEdits/auto/bypassPermissions; codex: ask/auto/bypassPermissions)。
 * 不认识的档按最严算: 合并只能更严, 不能因为一个没见过的名字而放宽。
 */
const PERMISSION_ORDER = ['ask', 'default', 'plan', 'acceptEdits', 'auto', 'bypassPermissions'];

function permissionRank(mode: string): number {
  const index = PERMISSION_ORDER.indexOf(mode);
  return index === -1 ? -1 : index;
}

/** 两个显式权限档里更严的那个; 没填(null)等于跟随默认(无人值守默认完全访问), 算最宽。 */
export function stricterPermission(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return permissionRank(b) < permissionRank(a) ? b : a;
}

function isBlank(row: HookWorkspacePrefs): boolean {
  return FIELDS.every((field) => row[field] === null);
}

function sameValues(a: HookWorkspacePrefs, b: HookWorkspacePrefs): boolean {
  return FIELDS.every((field) => a[field] === b[field]);
}

export function getSharedProjectPref(workspace: string): HookWorkspacePrefs {
  return getWorkspacePref(SHARED_PREFS_CHANNEL, null, workspace);
}

export function listSharedProjectPrefs(): HookWorkspacePrefs[] {
  return listWorkspacePrefs(SHARED_PREFS_CHANNEL).filter((row) => !isBlank(row));
}

export function setSharedProjectPref(workspace: string, patch: HookPrefsPatch): void {
  setWorkspacePref(SHARED_PREFS_CHANNEL, null, workspace, patch);
}

/**
 * 把一个渠道原有的按渠道偏好并入共享那一份(每个渠道只做一次)。
 * 共享那份还没有这个项目: 整行拿过来, 连同它的模型来源; 已经有了(来自排在前面的渠道):
 * 只把权限档收紧到两者里更严的一档。返回是否并入过。
 */
export function adoptChannelPrefs(channel: HookPrefsChannel): boolean {
  if (isSharedPrefsAdopted(channel)) return false;
  const rows = listWorkspacePrefs(channel).filter((row) => !isBlank(row));
  // 同一个项目可能有多行(Slack 多 team): 不带 team 的行在前, 其余按原顺序。
  rows.sort((a, b) => Number((a.teamId ?? null) !== null) - Number((b.teamId ?? null) !== null));
  for (const row of rows) {
    const shared = getSharedProjectPref(row.workspace);
    if (isBlank(shared)) {
      setSharedProjectPref(row.workspace, {
        agentKind: row.agentKind,
        model: row.model,
        effort: row.effort,
        permissionMode: row.permissionMode,
      });
      const route = getWorkspaceProviderRoute(channel, row.teamId ?? null, row.workspace);
      if (route !== null && getWorkspaceProviderRoute(SHARED_PREFS_CHANNEL, null, row.workspace) === null) {
        setWorkspaceProviderSource(
          SHARED_PREFS_CHANNEL,
          null,
          row.workspace,
          route.providerId,
          route.agentDeviceId ?? null,
        );
      }
      continue;
    }
    const permissionMode = stricterPermission(shared.permissionMode, row.permissionMode);
    if (permissionMode !== shared.permissionMode) {
      setSharedProjectPref(row.workspace, { permissionMode });
    }
  }
  markSharedPrefsAdopted(channel);
  return true;
}

/**
 * 按固定顺序并入所有已经可以并入的渠道。「可以」= 该渠道的偏好正本已经在本机
 * (isWorkspacePrefsMigrated); 还没连过服务端的渠道, 它的偏好还在服务端, 等它第一次连上、
 * 把服务端那份导入本机之后再并入。
 */
export function adoptReadyChannels(): HookPrefsChannel[] {
  const adopted: HookPrefsChannel[] = [];
  for (const channel of OFFICIAL_PREFS_CHANNELS) {
    if (isWorkspacePrefsMigrated(channel) && adoptChannelPrefs(channel)) adopted.push(channel);
  }
  return adopted;
}

/**
 * 让一个渠道的镜像行与共享那一份一致; 返回是否改过(改过就需要重新镜像到它的服务端)。
 * `teamIds`: 这个渠道要写哪些 team 的行(Slack 多 team 时每个 team 一行, 其余渠道是 [null])。
 */
export function projectSharedOntoChannel(
  channel: HookPrefsChannel,
  teamIds: ReadonlyArray<string | null>,
): boolean {
  let changed = false;
  const shared = listSharedProjectPrefs();
  const sharedNames = new Set(shared.map((row) => row.workspace));
  for (const teamId of teamIds) {
    for (const row of shared) {
      const current = listWorkspacePrefs(channel).find(
        (entry) => entry.workspace === row.workspace && (entry.teamId ?? null) === teamId,
      );
      if (current !== undefined && sameValues(current, row)) continue;
      setWorkspacePref(channel, teamId, row.workspace, {
        agentKind: row.agentKind,
        model: row.model,
        effort: row.effort,
        permissionMode: row.permissionMode,
      });
      changed = true;
    }
  }
  // 共享那份里已经清空的项目, 渠道行也清空(写成全空行, 镜像后服务端随之删除)。
  for (const row of listWorkspacePrefs(channel)) {
    if (sharedNames.has(row.workspace) || isBlank(row)) continue;
    setWorkspacePref(channel, row.teamId ?? null, row.workspace, {
      agentKind: null,
      model: null,
      effort: null,
      permissionMode: null,
    });
    changed = true;
  }
  return changed;
}

/**
 * 某个渠道的行被服务端改了(用户在 IM 里用 /model 卡改的): 把变化并回共享那一份。
 * `before` / `after` 是这个渠道落服务端快照前后的行。返回被改动的项目名。
 *
 * - 只并入「变了、且与共享那份不一样」的字段: 没变的行不动共享那份, 一份过期的快照不会把
 *   它整体冲回去; 本机刚写下去的值(已经和共享那份一致)也不会被当成远端改动。
 * - 快照里整行消失不算改动: 换绑到一个还没有偏好的机器人、或服务端丢了数据时也是这个样子,
 *   照着清空会把所有项目的配置抹掉。行还在、字段变成空才算「在 IM 里改回了默认」。
 * - 改了 Agent 或模型时, 原先配的模型来源一并作废 —— 来源只能在本机的模型面板里和
 *   (Agent, 模型) 一起选, 留着会拼出「新模型 + 旧来源」。
 */
export function absorbChannelChange(
  before: readonly HookWorkspacePrefs[],
  after: readonly HookWorkspacePrefs[],
): string[] {
  const keyOf = (row: HookWorkspacePrefs): string => `${row.teamId ?? ''}::${row.workspace}`;
  const beforeByKey = new Map(before.map((row) => [keyOf(row), row] as const));
  const touched = new Set<string>();
  for (const next of after) {
    const previous = beforeByKey.get(keyOf(next));
    const shared = getSharedProjectPref(next.workspace);
    const patch: HookPrefsPatch = {};
    for (const field of FIELDS) {
      const from = previous?.[field] ?? null;
      const to = next[field];
      if (from !== to && to !== shared[field]) patch[field] = to;
    }
    if (Object.keys(patch).length === 0) continue;
    setSharedProjectPref(next.workspace, patch);
    if (
      (patch.agentKind !== undefined || patch.model !== undefined) &&
      getWorkspaceProviderRoute(SHARED_PREFS_CHANNEL, null, next.workspace) !== null
    ) {
      setWorkspaceProviderSource(SHARED_PREFS_CHANNEL, null, next.workspace, null);
    }
    touched.add(next.workspace);
  }
  return [...touched];
}

/** 共享那一份的模型来源条目(设置页用)。 */
export function listSharedProviderSources(): ReturnType<typeof listWorkspaceProviderSources> {
  return listWorkspaceProviderSources().filter((entry) => entry.channel === SHARED_PREFS_CHANNEL);
}
