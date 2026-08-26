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
    isNullablePrefField(r.permissionMode)
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
): HookWorkspacePrefs[] {
  const fp = filePath();
  const store = readStore(fp);
  const current =
    store.entries.find((e) => sameKey(e, channel, teamId, workspace)) ??
    ({
      channel,
      teamId,
      workspace,
      model: null,
      effort: null,
      agentKind: null,
      permissionMode: null,
    } satisfies WorkspacePrefsEntry);
  const nextRow: WorkspacePrefsEntry = {
    ...current,
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
    ...(patch.agentKind !== undefined ? { agentKind: patch.agentKind } : {}),
    ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
  };
  const rest = store.entries.filter((e) => !sameKey(e, channel, teamId, workspace));
  // 全空行是删除墓碑：派发视为跟随默认，重连时向 server 发 all-null，
  // 避免 /model 卡全量快照把已清除的目录偏好救活。
  const entries = [...rest, nextRow];
  if (entries.length > HOOK_WORKSPACE_PREFS_MAX_ENTRIES) {
    throw new Error('too many workspace prefs entries');
  }
  writeStore(fp, { ...store, entries });
  return entries.filter((e) => e.channel === channel).map(toHookPrefs);
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
  const incoming: WorkspacePrefsEntry[] = [];
  for (const pref of serverPrefs) {
    const row = asStoreRow(channel, pref);
    if (row === null || isBlankRow(row)) continue;
    if (localKeys.has(prefKey(row.teamId, row.workspace))) continue;
    incoming.push(row);
  }
  const entries = [...store.entries, ...incoming];
  if (entries.length > HOOK_WORKSPACE_PREFS_MAX_ENTRIES) {
    throw new Error('too many workspace prefs entries');
  }
  writeStore(fp, { ...store, migrated: { ...store.migrated, [channel]: true }, entries });
}

/**
 * /model 卡主动推送的全量快照：本机墓碑优先（未同步的清空不能被救活），
 * 其余以快照为准；快照里没有的本机实值行保留（可能还没镜像上去）。
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
    if (row === null || isBlankRow(row)) continue;
    serverByKey.set(prefKey(row.teamId, row.workspace), row);
  }
  const nextChannel: WorkspacePrefsEntry[] = [];
  const seen = new Set<string>();
  for (const localRow of local) {
    const key = prefKey(localRow.teamId, localRow.workspace);
    seen.add(key);
    if (isBlankRow(localRow)) {
      nextChannel.push(localRow);
      continue;
    }
    nextChannel.push(serverByKey.get(key) ?? localRow);
  }
  for (const [key, serverRow] of serverByKey) {
    if (seen.has(key)) continue;
    nextChannel.push(serverRow);
  }
  const entries = [...other, ...nextChannel];
  if (entries.length > HOOK_WORKSPACE_PREFS_MAX_ENTRIES) {
    throw new Error('too many workspace prefs entries');
  }
  writeStore(fp, { ...store, entries });
  return nextChannel.map(toHookPrefs);
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
