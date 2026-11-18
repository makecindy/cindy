/**
 * hook-control/workspacePrefsStore.ts
 * ---------------------------------------------------------------------------
 * IM hook 工作目录的 agent / model / effort / permissionMode 偏好 —— 本机正本。
 *
 * 这些字段决定「这台正在接 Slack / Telegram / X 的电脑」开哪类会话。模型清单、
 * 凭证和目录都在本机，正本不应放在 hook server 的 user_prefs 里。server 表只
 * 作 /model 卡的镜像：连上后由本机推过去；卡片在线改动经 WS 写回本机。
 *
 * 持久化 <userData>/owners/<hash>/hook-workspace-prefs.json，与
 * hook-workspace-provider-source.json 同级（原子写，不含凭证）。
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  HOOK_WORKSPACE_ALIAS_RE,
  type HookPrefsPatch,
  type HookWorkspacePrefs,
} from '../../shared/hookControlIpc.js';
import { ownerScopedImUserDataPath } from '../im/ownerScopedStorage.js';
import { createLogger } from '../logger.js';
import { clearWorkspaceProviderSourcesForRemoteModelChanges } from './workspaceProviderSourceStore.js';

const log = createLogger('hook-control');

export type HookPrefsChannel = 'slack' | 'telegram' | 'x' | 'feishu';

/**
 * 所有官方机器人共用的那一份(见 sharedProjectPrefs.ts)。它是派发与设置页的正本;
 * 各渠道的行只是给各自服务端 /model 卡看的镜像, 由共享那份投影过去。
 */
export const SHARED_PREFS_CHANNEL = 'shared';
export type HookPrefsStoreChannel = HookPrefsChannel | typeof SHARED_PREFS_CHANNEL;
/**
 * 共用那一份里某个项目的配置归谁: 某个渠道(升级时从它原样并入, 之后没人改过),
 * 或 `edited`(用户在设置页 / IM 里改过或清空过 —— 还有渠道没并入时记着, 免得它晚到时把旧值带回来)。
 */
export const SHARED_PREF_EDITED = 'edited';
export type SharedPrefOrigin = HookPrefsChannel | typeof SHARED_PREF_EDITED;

export interface WorkspacePrefsEntry {
  channel: HookPrefsStoreChannel;
  /** Slack multi-team 归属；Telegram / X / 飞书 / 单绑定为 null。 */
  teamId: string | null;
  workspace: string;
  model: string | null;
  effort: string | null;
  agentKind: string | null;
  permissionMode: string | null;
  /** 本地写入代次。镜像回执必须对上这个值才能清墓碑 / 去掉 dirty。 */
  rev?: number;
  /** 尚未成功镜像的本地写入。缺省：墓碑视为 dirty，旧实值行视为已同步。 */
  dirty?: boolean;
  /**
   * dirty 行里由本机实际修改的字段。缺省表示整行都是旧客户端留下的本机正本；
   * 有值时可先用 server 快照补齐未改字段，再安全地生成完整镜像行。
   */
  dirtyPatch?: HookPrefsPatch;
  /**
   * 这条全空行是项目改名时留在旧名称下的清空墓碑, 不是用户清空的。项目又改回这个名称时,
   * 只有带这个标记的全空行才会被抄回来的值顶掉; 用户主动清空的设置不受改名影响。
   */
  renameTombstone?: boolean;
}

interface StoreFile {
  version: 1;
  migrated: Partial<Record<HookPrefsChannel, boolean>>;
  /** 该渠道原有的按渠道偏好是否已经并入共享那一份(一次性)。 */
  sharedAdopted?: Partial<Record<HookPrefsChannel, boolean>>;
  /**
   * 共用那一份里, 某个项目的配置(偏好行与模型来源)是升级时从哪个渠道原样并入的、之后没人改过。
   * 排在它前面的渠道稍后才并入时凭它按固定顺序顶替; 用户或 IM 里一改就去掉。
   */
  sharedOrigin?: Record<string, SharedPrefOrigin>;
  /** 旧版官方机器人「新对话配置」(全局那份)已在升级时清过一次, 之后不再碰它。 */
  legacyGlobalDefaultsCleared?: boolean;
  /**
   * 还有渠道没并入共用配置的这段时间里让出来的项目名称(项目被移除, 或名称转给了别的目录)。
   * 那些渠道的旧偏好此刻还在服务端, 本机清不到; 等它们连上、导入、并入时凭这份名单跳过,
   * 免得上一个项目的模型和权限并进同名的新项目。四个渠道都并入后这份名单就没用了, 随即删掉。
   */
  releasedNames?: string[];
  entries: WorkspacePrefsEntry[];
}

const FILE_NAME = 'hook-workspace-prefs.json';
const FIELD_MAX = 128;
export const HOOK_WORKSPACE_PREFS_MAX_ENTRIES = 256;
/**
 * 「从哪个渠道原样并入」标记的条数上限。标记既覆盖有偏好行的项目也覆盖只选过来源的项目,
 * 所以不能套用偏好行的上限; 这里只是防文件被写坏的保险, 与项目清单的上限(4096)同量级。
 */
const SHARED_ORIGIN_MAX = 4096;

function filePath(): string {
  return ownerScopedImUserDataPath(FILE_NAME);
}

function isChannel(value: unknown): value is HookPrefsStoreChannel {
  return (
    value === 'slack' ||
    value === 'telegram' ||
    value === 'x' ||
    value === 'feishu' ||
    value === SHARED_PREFS_CHANNEL
  );
}

function isNullablePrefField(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' && value.length > 0 && value.length <= FIELD_MAX)
  );
}

const PREF_FIELDS = ['model', 'effort', 'agentKind', 'permissionMode'] as const;
type PrefField = (typeof PREF_FIELDS)[number];

function isDirtyPatch(value: unknown): value is HookPrefsPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const patch = value as Record<string, unknown>;
  if (Object.keys(patch).some((key) => !PREF_FIELDS.includes(key as PrefField))) return false;
  return PREF_FIELDS.every(
    (field) => patch[field] === undefined || isNullablePrefField(patch[field]),
  );
}

function isEntry(raw: unknown): raw is WorkspacePrefsEntry {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return (
    isChannel(r.channel) &&
    (r.teamId === null ||
      (typeof r.teamId === 'string' && r.teamId.length > 0 && r.teamId.length <= 64)) &&
    typeof r.workspace === 'string' &&
    HOOK_WORKSPACE_ALIAS_RE.test(r.workspace) &&
    isNullablePrefField(r.model) &&
    isNullablePrefField(r.effort) &&
    isNullablePrefField(r.agentKind) &&
    isNullablePrefField(r.permissionMode) &&
    (r.rev === undefined ||
      (typeof r.rev === 'number' && Number.isInteger(r.rev) && r.rev >= 0 && r.rev <= 1_000_000_000)) &&
    (r.dirty === undefined || typeof r.dirty === 'boolean') &&
    (r.dirtyPatch === undefined || isDirtyPatch(r.dirtyPatch)) &&
    (r.renameTombstone === undefined || typeof r.renameTombstone === 'boolean')
  );
}

/**
 * 条数上限只数真正的偏好行。项目改名留下的清空墓碑是过渡记录(镜像后即消失), 不占名额 ——
 * 否则表快满时改个项目名, 「新行 + 墓碑」会超限而整次搬移失败, 偏好留在旧名称下读不到。
 */
function exceedsPrefsCap(entries: readonly WorkspacePrefsEntry[]): boolean {
  // 上限按渠道各算各的: 共用那一份会投影到每个已连接的渠道, 合在一起算的话,
  // 配了几十个项目的用户一开第二个机器人就会撞上限。
  // Slack 多 workspace 时每个 workspace 各有一整份, 所以再按 team 分开算。
  const counts = new Map<string, number>();
  for (const entry of entries) {
    // 全空行是「待清空」的过渡记录(推给服务端后即消失), 同样不占名额: 表满时清掉一个项目
    // 再配另一个, 不该因为旧行还没推完而写不下去。
    if (entry.renameTombstone === true || isBlankRow(entry)) continue;
    const scope = `${entry.channel}::${entry.teamId ?? ''}`;
    const count = (counts.get(scope) ?? 0) + 1;
    if (count > HOOK_WORKSPACE_PREFS_MAX_ENTRIES) return true;
    counts.set(scope, count);
  }
  return false;
}

function emptyStore(): StoreFile {
  return { version: 1, migrated: {}, entries: [] };
}

function readStore(fp: string): StoreFile {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    if (!raw || typeof raw !== 'object') return emptyStore();
    const r = raw as Record<string, unknown>;
    const migrated: StoreFile['migrated'] = {};
    if (r.migrated && typeof r.migrated === 'object') {
      for (const channel of ['slack', 'telegram', 'x', 'feishu'] as const) {
        if ((r.migrated as Record<string, unknown>)[channel] === true) {
          migrated[channel] = true;
        }
      }
    }
    const entries = Array.isArray(r.entries) ? r.entries.filter(isEntry) : [];
    const sharedAdopted: NonNullable<StoreFile['sharedAdopted']> = {};
    if (r.sharedAdopted && typeof r.sharedAdopted === 'object') {
      for (const channel of ['slack', 'telegram', 'x', 'feishu'] as const) {
        if ((r.sharedAdopted as Record<string, unknown>)[channel] === true) sharedAdopted[channel] = true;
      }
    }
    const sharedOrigin: NonNullable<StoreFile['sharedOrigin']> = {};
    if (r.sharedOrigin && typeof r.sharedOrigin === 'object' && !Array.isArray(r.sharedOrigin)) {
      for (const [workspace, channel] of Object.entries(r.sharedOrigin as Record<string, unknown>)) {
        if (
          HOOK_WORKSPACE_ALIAS_RE.test(workspace) &&
          (channel === SHARED_PREF_EDITED || (isChannel(channel) && channel !== SHARED_PREFS_CHANNEL)) &&
          Object.keys(sharedOrigin).length < SHARED_ORIGIN_MAX
        ) {
          sharedOrigin[workspace] = channel;
        }
      }
    }
    const releasedNames = Array.isArray(r.releasedNames)
      ? [
          ...new Set(
            r.releasedNames.filter(
              (name): name is string => typeof name === 'string' && HOOK_WORKSPACE_ALIAS_RE.test(name),
            ),
          ),
        ].slice(0, SHARED_ORIGIN_MAX)
      : [];
    return {
      version: 1,
      migrated,
      ...(Object.keys(sharedAdopted).length > 0 ? { sharedAdopted } : {}),
      ...(Object.keys(sharedOrigin).length > 0 ? { sharedOrigin } : {}),
      ...(r.legacyGlobalDefaultsCleared === true ? { legacyGlobalDefaultsCleared: true } : {}),
      ...(releasedNames.length > 0 ? { releasedNames } : {}),
      entries,
    };
  } catch {
    return emptyStore();
  }
}

function writeStore(fp: string, store: StoreFile): void {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  fs.renameSync(tmp, fp);
}

const sameKey = (
  e: WorkspacePrefsEntry,
  channel: HookPrefsStoreChannel,
  teamId: string | null,
  workspace: string,
): boolean => e.channel === channel && e.teamId === teamId && e.workspace === workspace;

function toHookPrefs(e: WorkspacePrefsEntry): HookWorkspacePrefs {
  return {
    workspace: e.workspace,
    model: e.model,
    effort: e.effort,
    agentKind: e.agentKind,
    permissionMode: e.permissionMode,
    teamId: e.teamId,
  };
}

function isBlankRow(row: Pick<WorkspacePrefsEntry, 'model' | 'effort' | 'agentKind' | 'permissionMode'>): boolean {
  return row.model === null && row.effort === null && row.agentKind === null && row.permissionMode === null;
}

function rowRev(row: WorkspacePrefsEntry): number {
  return typeof row.rev === 'number' && Number.isInteger(row.rev) && row.rev >= 0 ? row.rev : 0;
}

function isDirtyRow(row: WorkspacePrefsEntry): boolean {
  if (typeof row.dirty === 'boolean') return row.dirty;
  return isBlankRow(row);
}

function mergePatch(base: HookPrefsPatch | undefined, patch: HookPrefsPatch): HookPrefsPatch {
  const merged: HookPrefsPatch = { ...base };
  for (const field of PREF_FIELDS) {
    if (patch[field] !== undefined) merged[field] = patch[field];
  }
  return merged;
}

function mergeDirtyRowWithServer(
  localRow: WorkspacePrefsEntry,
  serverRow: WorkspacePrefsEntry | undefined,
): WorkspacePrefsEntry {
  if (localRow.dirtyPatch === undefined) return localRow;
  const merged: WorkspacePrefsEntry = {
    channel: localRow.channel,
    teamId: localRow.teamId,
    workspace: localRow.workspace,
    model: serverRow?.model ?? null,
    effort: serverRow?.effort ?? null,
    agentKind: serverRow?.agentKind ?? null,
    permissionMode: serverRow?.permissionMode ?? null,
    rev: rowRev(localRow),
    dirty: true,
    dirtyPatch: localRow.dirtyPatch,
  };
  for (const field of PREF_FIELDS) {
    const value = localRow.dirtyPatch[field];
    if (value !== undefined) merged[field] = value;
  }
  return merged;
}

function cleanRow(row: WorkspacePrefsEntry): WorkspacePrefsEntry {
  const rest = { ...row };
  delete rest.dirtyPatch;
  return { ...rest, dirty: false };
}

export function isWorkspacePrefsMigrated(channel: HookPrefsChannel): boolean {
  return readStore(filePath()).migrated[channel] === true;
}

export function markWorkspacePrefsMigrated(channel: HookPrefsChannel): void {
  const fp = filePath();
  const store = readStore(fp);
  if (store.migrated[channel] === true) return;
  writeStore(fp, { ...store, migrated: { ...store.migrated, [channel]: true } });
}

/** 共用那一份里某个项目的配置归谁(见 SharedPrefOrigin; 没记过为 null)。 */
export function getSharedPrefOrigin(workspace: string): SharedPrefOrigin | null {
  return readStore(filePath()).sharedOrigin?.[workspace] ?? null;
}

/** 记下 / 去掉(origin = null)共用那一份里某个项目的归属标记。 */
export function setSharedPrefOrigin(workspace: string, origin: SharedPrefOrigin | null): void {
  const fp = filePath();
  const store = readStore(fp);
  if ((store.sharedOrigin?.[workspace] ?? null) === origin) return;
  writeStore(fp, withSharedOrigin(store, workspace, origin));
}

/**
 * 用户(设置页或 IM 里)动过共用那一份里这个项目的配置, 包括清空与只换模型来源。
 * 还有渠道没并入时记成 `edited`; 都并入之后这个标记再没有用处, 直接去掉。
 */
export function noteSharedPrefEdited(workspace: string): void {
  const fp = filePath();
  const store = readStore(fp);
  const origin = editedOrigin(store);
  if ((store.sharedOrigin?.[workspace] ?? null) === origin) return;
  writeStore(fp, withSharedOrigin(store, workspace, origin));
}

function editedOrigin(store: StoreFile): SharedPrefOrigin | null {
  return adoptionPending(store) ? SHARED_PREF_EDITED : null;
}

function withSharedOrigin(store: StoreFile, workspace: string, origin: SharedPrefOrigin | null): StoreFile {
  const sharedOrigin = { ...store.sharedOrigin };
  if (origin === null) delete sharedOrigin[workspace];
  else sharedOrigin[workspace] = origin;
  const next: StoreFile = { ...store, sharedOrigin };
  if (Object.keys(sharedOrigin).length === 0) delete next.sharedOrigin;
  return next;
}

export function isLegacyGlobalDefaultsCleared(): boolean {
  return readStore(filePath()).legacyGlobalDefaultsCleared === true;
}

export function markLegacyGlobalDefaultsCleared(): void {
  const fp = filePath();
  const store = readStore(fp);
  if (store.legacyGlobalDefaultsCleared === true) return;
  writeStore(fp, { ...store, legacyGlobalDefaultsCleared: true });
}

export function isSharedPrefsAdopted(channel: HookPrefsChannel): boolean {
  return readStore(filePath()).sharedAdopted?.[channel] === true;
}

export function markSharedPrefsAdopted(channel: HookPrefsChannel): void {
  const fp = filePath();
  const store = readStore(fp);
  if (store.sharedAdopted?.[channel] === true) return;
  const next: StoreFile = { ...store, sharedAdopted: { ...store.sharedAdopted, [channel]: true } };
  // 四个渠道都并入了: 再没有迟到的旧偏好要挡, 让出名称的名单随之作废。
  if (!adoptionPending(next)) delete next.releasedNames;
  writeStore(fp, next);
}

/** 这段时间里让出来的项目名称(见 StoreFile.releasedNames)。 */
export function listReleasedProjectNames(): string[] {
  return readStore(filePath()).releasedNames ?? [];
}

function adoptionPending(store: StoreFile): boolean {
  return (['slack', 'telegram', 'x', 'feishu'] as const).some(
    (channel) => store.sharedAdopted?.[channel] !== true,
  );
}

export function listWorkspacePrefs(channel: HookPrefsStoreChannel): HookWorkspacePrefs[] {
  return readStore(filePath()).entries.filter((e) => e.channel === channel).map(toHookPrefs);
}

/**
 * 某 (channel, teamId, workspace) 的偏好。
 * teamId 精确匹配优先，null 行兜底 —— 与设置页 prefsFor 的 multi-team 宽松语义一致。
 */
export function getWorkspacePref(
  channel: HookPrefsStoreChannel,
  teamId: string | null,
  workspace: string,
): HookWorkspacePrefs {
  const entries = readStore(filePath()).entries.filter((e) => e.channel === channel);
  const hit =
    entries.find((e) => sameKey(e, channel, teamId, workspace)) ??
    entries.find((e) => sameKey(e, channel, null, workspace));
  return hit
    ? toHookPrefs(hit)
    : { workspace, model: null, effort: null, agentKind: null, permissionMode: null, teamId };
}

export function setWorkspacePref(
  channel: HookPrefsStoreChannel,
  teamId: string | null,
  workspace: string,
  patch: HookPrefsPatch,
): { prefs: HookWorkspacePrefs[]; row: HookWorkspacePrefs; rev: number } {
  const fp = filePath();
  const store = readStore(fp);
  const exact = store.entries.find((e) => sameKey(e, channel, teamId, workspace));
  const inherited =
    exact === undefined && teamId !== null
      ? store.entries.find((e) => sameKey(e, channel, null, workspace))
      : undefined;
  const current =
    exact ??
    (inherited
      ? { ...inherited, teamId }
      : ({
          channel,
          teamId,
          workspace,
          model: null,
          effort: null,
          agentKind: null,
          permissionMode: null,
        } satisfies WorkspacePrefsEntry));
  const rev = rowRev(current) + 1;
  const localBase = exact ?? inherited;
  const fullLocalAuthority =
    localBase !== undefined &&
    ((isDirtyRow(localBase) && localBase.dirtyPatch === undefined) ||
      (channel !== SHARED_PREFS_CHANNEL &&
        store.migrated[channel] !== true &&
        !isDirtyRow(localBase)));
  const dirtyPatch = fullLocalAuthority
    ? undefined
    : mergePatch(localBase && isDirtyRow(localBase) ? localBase.dirtyPatch : undefined, patch);
  const nextRow: WorkspacePrefsEntry = {
    ...current,
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
    ...(patch.agentKind !== undefined ? { agentKind: patch.agentKind } : {}),
    ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
    rev,
    dirty: true,
    dirtyPatch,
  };
  // 用户亲手写过这一行, 它就不再是改名留下的墓碑(哪怕写进去的仍是全空)。
  delete nextRow.renameTombstone;
  const rest = store.entries.filter((e) => !sameKey(e, channel, teamId, workspace));
  // 全空行是未同步的删除墓碑：派发视为跟随默认，重连时向 server 发 all-null。
  // 镜像回执必须对上 rev，才允许 markWorkspacePrefMirrored 清墓碑或去掉 dirty。
  // 共用那一份不镜像到任何服务端, 全空行没有「待清空」要传达: 不存在与全空同义, 直接不留。
  // 留着的话它永远不会被清掉, 配置过又清空的项目会一直占着条数上限。
  const entries =
    channel === SHARED_PREFS_CHANNEL && isBlankRow(nextRow) ? rest : [...rest, nextRow];
  if (exceedsPrefsCap(entries)) {
    throw new Error('too many workspace prefs entries');
  }
  // 共用那一份被写过(设置页或 IM 里改的)就不再算「原样并入」。
  const nextStore =
    channel === SHARED_PREFS_CHANNEL ? withSharedOrigin(store, workspace, editedOrigin(store)) : store;
  writeStore(fp, { ...nextStore, entries });
  return {
    prefs: entries.filter((e) => e.channel === channel).map(toHookPrefs),
    row: toHookPrefs(nextRow),
    rev,
  };
}

function needsTeamTombstone(entries: WorkspacePrefsEntry[], row: WorkspacePrefsEntry): boolean {
  return (
    row.teamId !== null &&
    entries.some(
      (candidate) => sameKey(candidate, row.channel, null, row.workspace) && !isBlankRow(candidate),
    )
  );
}

function pruneRedundantBlankRows(entries: WorkspacePrefsEntry[]): WorkspacePrefsEntry[] {
  return entries.filter(
    (row) => !isBlankRow(row) || isDirtyRow(row) || needsTeamTombstone(entries, row),
  );
}

function shouldMirrorRow(row: WorkspacePrefsEntry): boolean {
  return isDirtyRow(row);
}

function samePrefs(row: WorkspacePrefsEntry, prefs: HookWorkspacePrefs): boolean {
  return (
    row.teamId === (prefs.teamId ?? null) &&
    row.workspace === prefs.workspace &&
    row.model === prefs.model &&
    row.effort === prefs.effort &&
    row.agentKind === prefs.agentKind &&
    row.permissionMode === prefs.permissionMode
  );
}

/**
 * 确认某次本地写入已镜像到 server：代次必须仍是 expectedRev。
 * team 空行若仍需遮住 null-team 兜底就转为 clean 墓碑；其余墓碑丢掉。
 */
export function markWorkspacePrefMirrored(
  channel: HookPrefsChannel,
  teamId: string | null,
  workspace: string,
  expectedRev: number,
): void {
  const fp = filePath();
  const store = readStore(fp);
  const current = store.entries.find((e) => sameKey(e, channel, teamId, workspace));
  if (!current || rowRev(current) !== expectedRev) return;
  if (isBlankRow(current)) {
    if (needsTeamTombstone(store.entries, current)) {
      writeStore(fp, {
        ...store,
        entries: store.entries.map((e) =>
          sameKey(e, channel, teamId, workspace) ? cleanRow(e) : e,
        ),
      });
      return;
    }
    const remaining = store.entries.filter((e) => !sameKey(e, channel, teamId, workspace));
    const otherChannels = remaining.filter((e) => e.channel !== channel);
    const currentChannel = remaining.filter((e) => e.channel === channel);
    writeStore(fp, {
      ...store,
      entries: [...otherChannels, ...pruneRedundantBlankRows(currentChannel)],
    });
    return;
  }
  if (!isDirtyRow(current)) return;
  writeStore(fp, {
    ...store,
    entries: store.entries.map((e) =>
      sameKey(e, channel, teamId, workspace) ? cleanRow(e) : e,
    ),
  });
}

/** 用 server 全量快照替换某渠道全部本地行（/model 卡遥控）。 */
export function replaceChannelWorkspacePrefs(
  channel: HookPrefsChannel,
  prefs: HookWorkspacePrefs[],
): HookWorkspacePrefs[] {
  const fp = filePath();
  const store = readStore(fp);
  const incoming: WorkspacePrefsEntry[] = [];
  for (const pref of prefs) {
    if (!HOOK_WORKSPACE_ALIAS_RE.test(pref.workspace)) continue;
    const teamId = pref.teamId === undefined || pref.teamId === null ? null : pref.teamId;
    if (teamId !== null && (teamId.length === 0 || teamId.length > 64)) continue;
    const row: WorkspacePrefsEntry = {
      channel,
      teamId,
      workspace: pref.workspace,
      model: isNullablePrefField(pref.model) ? pref.model : null,
      effort: isNullablePrefField(pref.effort) ? pref.effort : null,
      agentKind: isNullablePrefField(pref.agentKind) ? pref.agentKind : null,
      permissionMode: isNullablePrefField(pref.permissionMode) ? pref.permissionMode : null,
      rev: 0,
      dirty: false,
    };
    if (isBlankRow(row)) continue;
    incoming.push(row);
  }
  const kept = store.entries.filter((e) => e.channel !== channel);
  const entries = [...kept, ...incoming];
  if (exceedsPrefsCap(entries)) {
    throw new Error('too many workspace prefs entries');
  }
  writeStore(fp, { ...store, entries });
  return incoming.map(toHookPrefs);
}

function prefKey(teamId: string | null | undefined, workspace: string): string {
  return `${teamId ?? ''}::${workspace}`;
}

function serverRowForLocal(
  serverByKey: Map<string, WorkspacePrefsEntry>,
  row: Pick<WorkspacePrefsEntry, 'teamId' | 'workspace'>,
): WorkspacePrefsEntry | undefined {
  return (
    serverByKey.get(prefKey(row.teamId, row.workspace)) ??
    (row.teamId !== null ? serverByKey.get(prefKey(null, row.workspace)) : undefined)
  );
}

function asStoreRow(channel: HookPrefsChannel, pref: HookWorkspacePrefs): WorkspacePrefsEntry | null {
  if (!HOOK_WORKSPACE_ALIAS_RE.test(pref.workspace)) return null;
  const teamId = pref.teamId === undefined || pref.teamId === null ? null : pref.teamId;
  if (teamId !== null && (teamId.length === 0 || teamId.length > 64)) return null;
  return {
    channel,
    teamId,
    workspace: pref.workspace,
    model: isNullablePrefField(pref.model) ? pref.model : null,
    effort: isNullablePrefField(pref.effort) ? pref.effort : null,
    agentKind: isNullablePrefField(pref.agentKind) ? pref.agentKind : null,
    permissionMode: isNullablePrefField(pref.permissionMode) ? pref.permissionMode : null,
    rev: 0,
    dirty: false,
  };
}

/**
 * 升级后第一次连上：按目录合并 server 快照。
 * 本地已有的键（含清空墓碑）一律保留；只补本地从未写过的目录。
 */
export function importWorkspacePrefsIfNeeded(
  channel: HookPrefsChannel,
  serverPrefs: HookWorkspacePrefs[],
): void {
  if (isWorkspacePrefsMigrated(channel)) return;
  const fp = filePath();
  const store = readStore(fp);
  const localKeys = new Set(
    store.entries.filter((e) => e.channel === channel).map((e) => prefKey(e.teamId, e.workspace)),
  );
  const serverByKey = new Map<string, WorkspacePrefsEntry>();
  const incoming: WorkspacePrefsEntry[] = [];
  for (const pref of serverPrefs) {
    const row = asStoreRow(channel, pref);
    if (row === null) continue;
    serverByKey.set(prefKey(row.teamId, row.workspace), row);
    if (localKeys.has(prefKey(row.teamId, row.workspace))) continue;
    incoming.push(row);
  }
  // 首次迁移前的既有本地行是正本，必须作为 dirty 行镜像；本次刚导入的 server 行
  // 保持 clean，避免把 prefs.get 的旧快照无条件回写。
  const combined = [
    ...store.entries.map((row) => {
      if (row.channel !== channel) return row;
      const dirtyRow = { ...row, dirty: true };
      return mergeDirtyRowWithServer(dirtyRow, serverRowForLocal(serverByKey, row));
    }),
    ...incoming,
  ];
  const channelRows = combined.filter((row) => row.channel === channel);
  const retainedChannelRows = new Set(pruneRedundantBlankRows(channelRows));
  const entries = combined.filter(
    (row) => row.channel !== channel || retainedChannelRows.has(row),
  );
  if (exceedsPrefsCap(entries)) {
    throw new Error('too many workspace prefs entries');
  }
  writeStore(fp, { ...store, migrated: { ...store.migrated, [channel]: true }, entries });
}

/**
 * /model 卡主动推送的全量快照：所有尚未镜像的本机写入优先；已同步行以 server 为准。
 * team 空行在仍有 null-team 兜底时必须保留，避免该 team 的显式清空被兜底重新救活。
 */
export function applyIncomingServerWorkspacePrefs(
  channel: HookPrefsChannel,
  serverPrefs: HookWorkspacePrefs[],
): HookWorkspacePrefs[] {
  const fp = filePath();
  const store = readStore(fp);
  const local = store.entries.filter((e) => e.channel === channel);
  const other = store.entries.filter((e) => e.channel !== channel);
  const serverByKey = new Map<string, WorkspacePrefsEntry>();
  for (const pref of serverPrefs) {
    const row = asStoreRow(channel, pref);
    if (row === null) continue;
    serverByKey.set(prefKey(row.teamId, row.workspace), row);
  }
  const nextChannel: WorkspacePrefsEntry[] = [];
  const seen = new Set<string>();
  for (const localRow of local) {
    const key = prefKey(localRow.teamId, localRow.workspace);
    seen.add(key);
    if (isDirtyRow(localRow)) {
      nextChannel.push(mergeDirtyRowWithServer(localRow, serverRowForLocal(serverByKey, localRow)));
      continue;
    }
    const serverRow = serverByKey.get(key);
    if (serverRow) {
      nextChannel.push({ ...serverRow, rev: rowRev(localRow), dirty: false });
      continue;
    }
    if (isBlankRow(localRow)) nextChannel.push(localRow);
  }
  for (const [key, serverRow] of serverByKey) {
    if (seen.has(key)) continue;
    nextChannel.push(serverRow);
  }
  const prunedChannel = pruneRedundantBlankRows(nextChannel);
  const entries = [...other, ...prunedChannel];
  if (exceedsPrefsCap(entries)) {
    throw new Error('too many workspace prefs entries');
  }
  writeStore(fp, { ...store, entries });
  const next = prunedChannel.map(toHookPrefs);
  // 主动推送与重连镜像都经这里落 server 快照: 快照改掉的目录模型, 其配对来源
  // 随之作废(issue #5912)。偏好已落盘, 来源清理失败只记日志, 不让调用方当作
  // 快照失败重试 —— 重试时模型已无变化, 清理也不会再触发。
  try {
    if (clearWorkspaceProviderSourcesForRemoteModelChanges(channel, local.map(toHookPrefs), next)) {
      log.info(`workspace provider source cleared after remote model change (${channel})`);
    }
  } catch (err) {
    log.warn(
      `workspace provider source cleanup (${channel}) failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return next;
}

export interface WorkspacePrefsMirrorCandidate {
  prefs: HookWorkspacePrefs;
  rev: number;
}

/**
 * 完整行写回期间若撞上更新的 server 快照，本机 dirty 行已经合并了该快照。
 * 固定当前完整行，避免重试拉到刚被旧写回覆盖的 server 行后再次丢掉新字段。
 */
export function pinWorkspacePrefForMirrorRetry(
  channel: HookPrefsChannel,
  teamId: string | null,
  workspace: string,
): void {
  const fp = filePath();
  const store = readStore(fp);
  const current = store.entries.find((row) => sameKey(row, channel, teamId, workspace));
  if (!current || !isDirtyRow(current) || current.dirtyPatch === undefined) return;
  const pinned = { ...current };
  delete pinned.dirtyPatch;
  writeStore(fp, {
    ...store,
    entries: store.entries.map((row) =>
      sameKey(row, channel, teamId, workspace) ? pinned : row,
    ),
  });
}

/**
 * 渠道重连时先合并完整 server 快照，再返回需要镜像的本机完整行及其代次。
 * 首次连接保留升级迁移语义；之后每次连接都吸收 /model 在离线期间的改动。
 */
export function reconcileWorkspacePrefsForMirror(
  channel: HookPrefsChannel,
  serverPrefs: HookWorkspacePrefs[],
): WorkspacePrefsMirrorCandidate[] {
  if (isWorkspacePrefsMigrated(channel)) {
    applyIncomingServerWorkspacePrefs(channel, serverPrefs);
  } else {
    importWorkspacePrefsIfNeeded(channel, serverPrefs);
  }
  const channelRows = readStore(filePath()).entries.filter((row) => row.channel === channel);
  return channelRows
    .filter(shouldMirrorRow)
    .map((row) => ({ prefs: toHookPrefs(row), rev: rowRev(row) }));
}

/** 发送镜像帧前再次确认候选仍是当前本地正本，关闭快照与逐行发送之间的竞态窗口。 */
export function isWorkspacePrefsMirrorCandidateCurrent(
  channel: HookPrefsChannel,
  candidate: WorkspacePrefsMirrorCandidate,
): boolean {
  const channelRows = readStore(filePath()).entries.filter((row) => row.channel === channel);
  const row = channelRows.find((entry) =>
    sameKey(entry, channel, candidate.prefs.teamId ?? null, candidate.prefs.workspace),
  );
  return (
    row !== undefined &&
    rowRev(row) === candidate.rev &&
    samePrefs(row, candidate.prefs) &&
    shouldMirrorRow(row)
  );
}

/**
 * 派发取值：本机显式字段优先。
 * 尚未从 server 迁过时，允许沿用 dispatch options（旧桌面 / 升级窗口）。
 * 迁完之后，null 就是「跟随 IM 默认」，不再吃 server 便签。
 */
export function resolveWorkspacePrefOverrides(
  local: HookWorkspacePrefs | null,
  dispatched: {
    agentKind: string | null;
    model: string | null;
    effort: string | null;
    permissionMode: string | null;
  },
  migrated: boolean,
): {
  agentKind: string | null;
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
} {
  const pick = (field: 'agentKind' | 'model' | 'effort' | 'permissionMode'): string | null => {
    const explicit = local?.[field] ?? null;
    if (explicit !== null) return explicit;
    return migrated ? null : dispatched[field];
  };
  return {
    agentKind: pick('agentKind'),
    model: pick('model'),
    effort: pick('effort'),
    permissionMode: pick('permissionMode'),
  };
}

/**
 * 项目改名后, 把按旧名称存的偏好挪到新名称下; 返回有改动的渠道。
 *
 * 新名称下还没有行时照抄旧行(整行作为本机正本镜像出去); 已经有行(用户在新名称下改过,
 * 或主动清空留下的全空行)就不覆盖。例外是上一次改名留在这个名称下、还没镜像出去的清空
 * 墓碑(renameTombstone; 项目离线改名又改回来): 把它当成「已有设置」会两头都清空, 所以
 * 照样抄过去。
 * 旧行一律收成未同步的清空墓碑, 镜像后两边一起消失 —— 留着它, 用户之后清空新名称下的
 * 偏好时, 下一次整理又会把旧值抄回来。
 * 可重复执行: 旧名称下没有实值时什么也不做。
 */
export function moveWorkspacePrefsToRenamed(
  renames: ReadonlyArray<{ from: string; to: string }>,
): HookPrefsChannel[] {
  if (renames.length === 0) return [];
  const fp = filePath();
  const store = readStore(fp);
  let entries = store.entries;
  const touched = new Set<HookPrefsChannel>();
  let movedAny = false;
  // 「从哪个渠道原样并入」的标记跟着配置走: 挪到新名称下(新名称已经有自己的共用配置时不带,
  // 那份不是并入来的), 旧名称下一律去掉 —— 留着的话, 项目日后改回旧名称时, 它会重新贴到
  // 用户已经改过的配置上。
  const sharedOrigin = { ...store.sharedOrigin };
  for (const { from, to } of renames) {
    if (from === to || !HOOK_WORKSPACE_ALIAS_RE.test(to)) continue;
    const origin = sharedOrigin[from];
    if (origin !== undefined) {
      const targetConfigured = entries.some(
        (entry) => sameKey(entry, SHARED_PREFS_CHANNEL, null, to) && !isBlankRow(entry),
      );
      if (!targetConfigured && sharedOrigin[to] === undefined) sharedOrigin[to] = origin;
      delete sharedOrigin[from];
      movedAny = true;
    }
    for (const row of entries.filter((entry) => entry.workspace === from && !isBlankRow(entry))) {
      const target = entries.find((entry) => sameKey(entry, row.channel, row.teamId, to));
      const keepTarget =
        target !== undefined && !(isBlankRow(target) && target.renameTombstone === true);
      const tombstone: WorkspacePrefsEntry = {
        channel: row.channel,
        teamId: row.teamId,
        workspace: from,
        model: null,
        effort: null,
        agentKind: null,
        permissionMode: null,
        rev: rowRev(row) + 1,
        dirty: true,
        renameTombstone: true,
      };
      const moved: WorkspacePrefsEntry = {
        channel: row.channel,
        teamId: row.teamId,
        workspace: to,
        model: row.model,
        effort: row.effort,
        agentKind: row.agentKind,
        permissionMode: row.permissionMode,
        rev: (target ? rowRev(target) : 0) + 1,
        dirty: true,
      };
      // 共用那一份不镜像到任何服务端, 旧名称下不需要留「待清空」的行。
      const shared = row.channel === SHARED_PREFS_CHANNEL;
      entries = [
        ...entries.filter((entry) => entry !== row && (keepTarget || entry !== target)),
        ...(shared ? [] : [tombstone]),
        ...(keepTarget ? [] : [shared ? { ...moved, dirty: false } : moved]),
      ];
      movedAny = true;
      if (row.channel !== SHARED_PREFS_CHANNEL) touched.add(row.channel);
    }
  }
  if (!movedAny) return [];
  if (exceedsPrefsCap(entries)) {
    throw new Error('too many workspace prefs entries');
  }
  const next: StoreFile = { ...store, sharedOrigin, entries };
  if (Object.keys(sharedOrigin).length === 0) delete next.sharedOrigin;
  writeStore(fp, next);
  return [...touched];
}

/**
 * 清掉按这些项目名称存的全部偏好(项目已从侧栏移除, 或名称转给了别的目录)。
 * 共用那一份直接删行; 各渠道的行收成「待清空」的全空行, 推给服务端后消失。
 * 返回有行被清的渠道(调用方据此触发镜像)。
 */
export function clearWorkspacePrefsFor(names: readonly string[]): HookPrefsChannel[] {
  if (names.length === 0) return [];
  const fp = filePath();
  const store = readStore(fp);
  const released = new Set(names);
  const touched = new Set<HookPrefsChannel>();
  let changed = false;
  const entries: WorkspacePrefsEntry[] = [];
  for (const entry of store.entries) {
    if (!released.has(entry.workspace)) {
      entries.push(entry);
      continue;
    }
    if (entry.channel === SHARED_PREFS_CHANNEL) {
      changed = true;
      continue;
    }
    if (isBlankRow(entry)) {
      entries.push(entry);
      continue;
    }
    changed = true;
    touched.add(entry.channel);
    entries.push({
      channel: entry.channel,
      teamId: entry.teamId,
      workspace: entry.workspace,
      model: null,
      effort: null,
      agentKind: null,
      permissionMode: null,
      rev: rowRev(entry) + 1,
      dirty: true,
    });
  }
  // 归属标记一并去掉: 这个名称以后若有新项目用, 从头算。
  const sharedOrigin = { ...store.sharedOrigin };
  for (const name of released) {
    if (sharedOrigin[name] !== undefined) {
      delete sharedOrigin[name];
      changed = true;
    }
  }
  // 还有渠道没并入: 它们的旧偏好还在服务端, 这里清不到, 先把名称记下, 并入时跳过。
  const releasedNames = adoptionPending(store)
    ? [...new Set([...(store.releasedNames ?? []), ...released])].slice(-SHARED_ORIGIN_MAX)
    : [];
  if (releasedNames.length !== (store.releasedNames ?? []).length) changed = true;
  if (!changed) return [];
  const next: StoreFile = { ...store, sharedOrigin, entries };
  if (Object.keys(sharedOrigin).length === 0) delete next.sharedOrigin;
  if (releasedNames.length > 0) next.releasedNames = releasedNames;
  else delete next.releasedNames;
  writeStore(fp, next);
  return [...touched];
}
