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

export type HookPrefsChannel = 'slack' | 'telegram' | 'x';

export interface WorkspacePrefsEntry {
  channel: HookPrefsChannel;
  /** Slack multi-team 归属；Telegram / X / 单绑定为 null。 */
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
}

interface StoreFile {
  version: 1;
  migrated: Partial<Record<HookPrefsChannel, boolean>>;
  entries: WorkspacePrefsEntry[];
}

const FILE_NAME = 'hook-workspace-prefs.json';
const FIELD_MAX = 128;
export const HOOK_WORKSPACE_PREFS_MAX_ENTRIES = 256;

function filePath(): string {
  return ownerScopedImUserDataPath(FILE_NAME);
}

function isChannel(value: unknown): value is HookPrefsChannel {
  return value === 'slack' || value === 'telegram' || value === 'x';
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
    (r.dirtyPatch === undefined || isDirtyPatch(r.dirtyPatch))
  );
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
      for (const channel of ['slack', 'telegram', 'x'] as const) {
        if ((r.migrated as Record<string, unknown>)[channel] === true) {
          migrated[channel] = true;
        }
      }
    }
    const entries = Array.isArray(r.entries) ? r.entries.filter(isEntry) : [];
    return { version: 1, migrated, entries };
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
  channel: HookPrefsChannel,
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

export function listWorkspacePrefs(channel: HookPrefsChannel): HookWorkspacePrefs[] {
  return readStore(filePath()).entries.filter((e) => e.channel === channel).map(toHookPrefs);
}

/**
 * 某 (channel, teamId, workspace) 的偏好。
 * teamId 精确匹配优先，null 行兜底 —— 与设置页 prefsFor 的 multi-team 宽松语义一致。
 */
export function getWorkspacePref(
  channel: HookPrefsChannel,
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
  channel: HookPrefsChannel,
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
      (store.migrated[channel] !== true && !isDirtyRow(localBase)));
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
  const rest = store.entries.filter((e) => !sameKey(e, channel, teamId, workspace));
  // 全空行是未同步的删除墓碑：派发视为跟随默认，重连时向 server 发 all-null。
  // 镜像回执必须对上 rev，才允许 markWorkspacePrefMirrored 清墓碑或去掉 dirty。
  const entries = [...rest, nextRow];
  if (entries.length > HOOK_WORKSPACE_PREFS_MAX_ENTRIES) {
    throw new Error('too many workspace prefs entries');
  }
  writeStore(fp, { ...store, entries });
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
  if (entries.length > HOOK_WORKSPACE_PREFS_MAX_ENTRIES) {
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
  if (entries.length > HOOK_WORKSPACE_PREFS_MAX_ENTRIES) {
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
  if (entries.length > HOOK_WORKSPACE_PREFS_MAX_ENTRIES) {
    throw new Error('too many workspace prefs entries');
  }
  writeStore(fp, { ...store, entries });
  return prunedChannel.map(toHookPrefs);
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
