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
 * 它的渠道(与哪个机器人先连上无关); 权限档取各渠道显式填过的里面最严的一档 —— 合并不会把
 * 任何项目放宽。
 */

import type { HookPrefsPatch, HookWorkspacePrefs } from '../../shared/hookControlIpc.js';
import {
  SHARED_PREFS_CHANNEL,
  SHARED_PREF_EDITED,
  getSharedPrefOrigin,
  getWorkspacePref,
  isLegacyGlobalDefaultsCleared,
  isSharedPrefsAdopted,
  isWorkspacePrefsMigrated,
  listReleasedProjectNames,
  listWorkspacePrefs,
  markLegacyGlobalDefaultsCleared,
  markSharedPrefsAdopted,
  setSharedPrefOrigin,
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

function channelRank(channel: HookPrefsChannel): number {
  return OFFICIAL_PREFS_CHANNELS.indexOf(channel);
}

/**
 * 共享那一份里这个项目的配置现在「归谁」: 没配置过 -> 谁都可以拿(Infinity); 用户或 IM 里
 * 改过 -> 谁也不能顶替(-1); 否则是原样并入它的那个渠道的顺位。
 */
function sharedOwnerRank(workspace: string): number {
  const origin = getSharedPrefOrigin(workspace);
  // 用户动过(哪怕是清空, 此时共享那份里已经没有这个项目的行): 谁也不能把旧值带回来。
  if (origin === SHARED_PREF_EDITED) return -1;
  const configured =
    !isBlank(getSharedProjectPref(workspace)) ||
    getWorkspaceProviderRoute(SHARED_PREFS_CHANNEL, null, workspace) !== null;
  if (!configured) return Number.POSITIVE_INFINITY;
  return origin === null ? -1 : channelRank(origin);
}

/**
 * 把一个渠道原有的按渠道偏好并入共享那一份(每个渠道只做一次)。返回是否并入过。
 *
 * 一个项目的 Agent / 模型 / 思考强度 / 来源是一组, 整组取自固定顺序里第一个配置过它的渠道
 * (只选过来源、没填别的也算配置过):
 * - 共享那份还没有这个项目 -> 整组拿过来, 并记下是从哪个渠道来的;
 * - 已经有了, 而且是排在后面的渠道原样并入的(那个渠道先连上了, 之后没人改过) -> 整组顶替,
 *   这样结果不取决于哪个机器人先连上; 用户或 IM 里改过的不带标记, 不会被顶替;
 * - 其余情况只把权限档收紧到两者里更严的一档。
 * 权限档在任何情况下都取更严的, 合并不放宽任何项目。
 */
export function adoptChannelPrefs(channel: HookPrefsChannel): boolean {
  if (isSharedPrefsAdopted(channel)) return false;
  const rows = listWorkspacePrefs(channel).filter((row) => !isBlank(row));
  const sources = listWorkspaceProviderSources().filter((entry) => entry.channel === channel);
  // 同一个项目可能有多行(Slack 多 team): 不带 team 的在前, 其余按原顺序; 第一行代表这个渠道。
  rows.sort((a, b) => Number((a.teamId ?? null) !== null) - Number((b.teamId ?? null) !== null));
  sources.sort((a, b) => Number(a.teamId !== null) - Number(b.teamId !== null));
  const workspaces = new Set([...rows.map((row) => row.workspace), ...sources.map((entry) => entry.workspace)]);
  // 这个渠道并入之前就让出来的名称(项目已移除, 或名称转给了别的目录): 它带来的是上一个项目的
  // 配置, 不并入 —— 连权限档也不参与收紧。渠道行随后由投影清掉, 推给服务端。
  const released = new Set(listReleasedProjectNames());
  for (const workspace of workspaces) {
    if (released.has(workspace)) continue;
    const projectRows = rows.filter((row) => row.workspace === workspace);
    const row = projectRows[0];
    const route =
      row !== undefined
        ? getWorkspaceProviderRoute(channel, row.teamId ?? null, workspace)
        : (sources.find((entry) => entry.workspace === workspace) ?? null);
    const permissionMode = projectRows.reduce<string | null>(
      (strictest, entry) => stricterPermission(strictest, entry.permissionMode),
      null,
    );
    if (channelRank(channel) >= sharedOwnerRank(workspace)) {
      tightenSharedPermission(workspace, permissionMode);
      continue;
    }
    const shared = getSharedProjectPref(workspace);
    setSharedProjectPref(workspace, {
      agentKind: row?.agentKind ?? null,
      model: row?.model ?? null,
      effort: row?.effort ?? null,
      permissionMode: stricterPermission(shared.permissionMode, permissionMode),
    });
    // 来源与 (Agent, 模型) 是一组: 一起换, 这个渠道没配来源就清掉原来的。
    if (route !== null || getWorkspaceProviderRoute(SHARED_PREFS_CHANNEL, null, workspace) !== null) {
      setWorkspaceProviderSource(
        SHARED_PREFS_CHANNEL,
        null,
        workspace,
        route?.providerId ?? null,
        route?.agentDeviceId ?? null,
      );
    }
    setSharedPrefOrigin(workspace, channel);
  }
  markSharedPrefsAdopted(channel);
  return true;
}

/** 把共享那份的权限档收紧到与 `permissionMode` 相比更严的一档; 不动「从哪个渠道并入」的标记。 */
function tightenSharedPermission(workspace: string, permissionMode: string | null): void {
  const shared = getSharedProjectPref(workspace);
  const next = stricterPermission(shared.permissionMode, permissionMode);
  if (next === shared.permissionMode) return;
  const origin = getSharedPrefOrigin(workspace);
  setSharedProjectPref(workspace, { permissionMode: next });
  setSharedPrefOrigin(workspace, origin);
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
  let failure: unknown = null;
  const write = (teamId: string | null, workspace: string, patch: HookPrefsPatch): void => {
    try {
      setWorkspacePref(channel, teamId, workspace, patch);
      changed = true;
    } catch (err) {
      failure ??= err;
    }
  };
  const shared = listSharedProjectPrefs();
  const sharedNames = new Set(shared.map((row) => row.workspace));
  // 先清: 共享那份里已经清空的项目, 渠道行也清空(写成全空行, 镜像后服务端随之删除)。
  for (const row of listWorkspacePrefs(channel)) {
    if (sharedNames.has(row.workspace) || isBlank(row)) continue;
    write(row.teamId ?? null, row.workspace, {
      agentKind: null,
      model: null,
      effort: null,
      permissionMode: null,
    });
  }
  for (const teamId of teamIds) {
    for (const row of shared) {
      const current = listWorkspacePrefs(channel).find(
        (entry) => entry.workspace === row.workspace && (entry.teamId ?? null) === teamId,
      );
      if (current !== undefined && sameValues(current, row)) continue;
      write(teamId, row.workspace, {
        agentKind: row.agentKind,
        model: row.model,
        effort: row.effort,
        permissionMode: row.permissionMode,
      });
    }
  }
  // 有的行写不下去时: 写成的那部分照常返回「改过」让调用方去推; 一行都没写成才把错误抛出去 ——
  // 这样同一个写不下去的状态不会让调用方一遍遍地重新对齐、重新拉服务端快照。
  if (failure !== null && !changed) throw failure;
  return changed;
}

function keyOf(row: HookWorkspacePrefs): string {
  return `${row.teamId ?? ''}::${row.workspace}`;
}

/**
 * 落完服务端快照之后, 这个渠道「现在的行」: 本机存着的行, 加上快照里明确带着、但因为全空
 * 而没有存下来的行。后者是用户在 IM 里把这个项目的设置清回默认, 和「快照里根本没有这一行」
 * 不是一回事 —— 只有前者要并回共用那份。本机还有没推上去的改动时, 那一行仍存着(本机优先),
 * 不会被当成清空。
 */
export function rowsAfterServerSnapshot(
  stored: readonly HookWorkspacePrefs[],
  serverRows: readonly HookWorkspacePrefs[],
): HookWorkspacePrefs[] {
  const storedKeys = new Set(stored.map(keyOf));
  return [...stored, ...serverRows.filter((row) => isBlank(row) && !storedKeys.has(keyOf(row)))];
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

/**
 * 升级时一次性清掉旧版官方机器人「新对话配置」(IM 默认设置里全局那一份, 以及官方 Slack
 * 以前另读的那一份; 具体清哪些由调用方注入)。
 *
 * 那个设置区块早已从界面上拿掉, 但改过的值还留在盘上, 继续充当没单独配置过的项目的兜底值 ——
 * 用户看不到也改不了。以前靠设置页里一条提示让用户自己点「恢复默认」; 现在项目的模型统一在
 * 「项目与模型」里设置, 升级时直接替用户清掉(2026-11-13 用户裁决), 提示随之移除。清掉之后
 * 没单独配置过的项目按内置默认跑。只做一次: 做过就记下, 之后不再碰这份设置。
 * 返回这次是否真的清了。
 */
export function clearLegacyGlobalDefaultsOnce(deps: {
  isCustomized: () => boolean;
  reset: () => void;
}): boolean {
  if (isLegacyGlobalDefaultsCleared()) return false;
  const customized = deps.isCustomized();
  if (customized) deps.reset();
  markLegacyGlobalDefaultsCleared();
  return customized;
}
