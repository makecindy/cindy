import { collapseWorktreeDirForGrouping } from './worktreePaths.js';
import {
  normalizeProjectOrderPath,
  parseSyncedProjectOrderOwnerStamp,
  type SyncedProjectOrderOwnerStamp,
} from './projectOrderSync.js';

export const PROJECT_ALIASES_GET_CHANNEL = 'sidebar-settings:get-project-aliases';
export const PROJECT_ALIASES_CHANGED_CHANNEL = 'local-db:project-aliases:changed';

export interface HostProjectAliasesSnapshot {
  /** Host identities only: a controller's device: overrides stay on that controller. */
  aliases: readonly { projectKey: string; alias: string }[];
  platform: string;
  ownerStamp?: SyncedProjectOrderOwnerStamp;
}

export type ProjectAliasesByDevice = ReadonlyMap<string, HostProjectAliasesSnapshot>;
/** Supports the host snapshots and main's already-shipped local-name projection. */
export type ProjectAliasDisplayIndex = ProjectAliasesByDevice | ReadonlyMap<string, string>;

export interface ProjectAliasSessionLike {
  workingDir: string | null;
  remoteHostId?: string | null;
  /** Physical source, never canonicalDeviceId (which is only a display identity). */
  deviceLinkDeviceId?: string | null;
}

function normalizeAliasPath(raw: string): string | null {
  if (!raw.trim()) return null;
  let value = raw;
  if (value.startsWith('\\\\?\\UNC\\')) value = `\\\\${value.slice(8)}`;
  else if (value.startsWith('\\\\?\\')) value = value.slice(4);
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('//')) {
    value = value.replaceAll('\\', '/');
  }
  while (value.length > 1 && value.endsWith('/') && !/^[A-Za-z]:\/$/.test(value)) {
    value = value.slice(0, -1);
  }
  return collapseWorktreeDirForGrouping(value);
}

/** Comparison only; never use this value as an IO path or a controller grouping key. */
export function projectAliasComparisonKey(raw: string, platform: string): string | null {
  if (raw.startsWith('local:')) {
    const path = normalizeAliasPath(raw.slice(6));
    if (path === null) return null;
    const windows = /^[A-Za-z]:\//.test(path) || path.startsWith('//');
    return `local:${platform === 'win32' && windows ? path.toLowerCase() : path}`;
  }
  if (!raw.startsWith('remote:')) return null;
  const separator = raw.indexOf(':', 7);
  if (separator < 0) return null;
  try {
    const host = decodeURIComponent(raw.slice(7, separator));
    const path = normalizeAliasPath(raw.slice(separator + 1));
    return host && path !== null ? `remote:${encodeURIComponent(host)}:${path}` : null;
  } catch {
    return null;
  }
}

export function parseHostProjectAliasesSnapshot(raw: unknown): HostProjectAliasesSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.aliases) || typeof value.platform !== 'string') return null;
  const ownerStamp = parseSyncedProjectOrderOwnerStamp(value.ownerStamp);
  if (Object.prototype.hasOwnProperty.call(value, 'ownerStamp') && !ownerStamp) return null;
  const aliases: { projectKey: string; alias: string }[] = [];
  const seen = new Set<string>();
  for (const row of value.aliases) {
    if (!row || typeof row !== 'object') continue;
    const { projectKey, alias } = row as Record<string, unknown>;
    if (typeof projectKey !== 'string' || typeof alias !== 'string') continue;
    const comparison = projectAliasComparisonKey(projectKey, value.platform);
    const trimmed = alias.trim();
    if (!comparison || !trimmed || trimmed.length > 80 || seen.has(comparison)) continue;
    // Host rows are newest-first, matching the desktop's legacy duplicate handling.
    seen.add(comparison);
    aliases.push({ projectKey, alias: trimmed });
  }
  return { aliases, platform: value.platform, ...(ownerStamp ? { ownerStamp } : {}) };
}

const aliasIndexes = new WeakMap<HostProjectAliasesSnapshot, ReadonlyMap<string, string>>();

function aliasIndex(snapshot: HostProjectAliasesSnapshot): ReadonlyMap<string, string> {
  const existing = aliasIndexes.get(snapshot);
  if (existing) return existing;
  const next = new Map<string, string>();
  for (const row of snapshot.aliases) {
    const key = projectAliasComparisonKey(row.projectKey, snapshot.platform);
    if (key && !next.has(key)) next.set(key, row.alias);
  }
  aliasIndexes.set(snapshot, next);
  return next;
}

/** Existing mixed-identity groups keep their path title, rather than borrowing one member's alias. */
export function resolveProjectAliasForSessions(
  sessions: readonly ProjectAliasSessionLike[],
  snapshots: ProjectAliasDisplayIndex | undefined,
  defaultDeviceId?: string,
): string | null {
  if (!snapshots || sessions.length === 0) return null;
  let identity: string | undefined;
  let alias: string | null = null;
  for (const session of sessions) {
    const deviceId = session.deviceLinkDeviceId || defaultDeviceId;
    if (!deviceId || !session.workingDir) return null;
    const snapshot = snapshots.get(deviceId);
    if (!snapshot || typeof snapshot === 'string') {
      // The legacy projection carries only local aliases, never SSH identity.
      if (session.remoteHostId) return null;
      const key = `device:${encodeURIComponent(deviceId)}:${normalizeProjectOrderPath(session.workingDir)}`;
      const value = snapshots.get(key);
      const current = JSON.stringify([deviceId, key]);
      if (identity !== undefined && identity !== current) return null;
      identity = current;
      alias = typeof value === 'string' ? value : null;
      continue;
    }
    const key = projectAliasComparisonKey(
      session.remoteHostId
        ? `remote:${encodeURIComponent(session.remoteHostId)}:${session.workingDir}`
        : `local:${session.workingDir}`,
      snapshot.platform,
    );
    if (!key) return null;
    const current = JSON.stringify([deviceId, key]);
    if (identity !== undefined && identity !== current) return null;
    identity = current;
    alias = aliasIndex(snapshot).get(key) ?? null;
  }
  return alias;
}

type ReadAliases = () => Promise<unknown>;
type IsCurrent = (snapshot?: HostProjectAliasesSnapshot) => boolean;
interface AliasRead {
  read: ReadAliases;
  isCurrent: IsCurrent;
  revision: number;
  pending?: Promise<void>;
}

function missingChannel(error: unknown): boolean {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : null;
  const code = typeof record?.code === 'string' ? record.code : undefined;
  const message = typeof error === 'string' ? error : record?.message;
  const resolved = code ?? (typeof message === 'string' ? message.match(/\[([A-Z0-9_]+)\]/)?.[1] : undefined);
  return resolved === 'CHANNEL_NOT_ALLOWED' || resolved === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED';
}

function snapshotsEqual(a: HostProjectAliasesSnapshot | undefined, b: HostProjectAliasesSnapshot): boolean {
  return !!a && a.platform === b.platform
    && a.ownerStamp?.dataOwnerId === b.ownerStamp?.dataOwnerId
    && a.ownerStamp?.ownerGeneration === b.ownerStamp?.ownerGeneration
    && a.aliases.length === b.aliases.length
    && a.aliases.every((row, index) => row.projectKey === b.aliases[index].projectKey && row.alias === b.aliases[index].alias);
}

/** In-memory read model. Hosts own persistence; adapters own authorization and connection recovery. */
export function createProjectAliasMirror() {
  let snapshots: ProjectAliasesByDevice = new Map();
  const reads = new Map<string, AliasRead>();
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  // Display metadata has its own small budget; it never holds up session-list recovery.
  let activeReads = 0;
  const waitingReads: (() => void)[] = [];
  async function acquireReadSlot(): Promise<() => void> {
    if (activeReads >= 6) await new Promise<void>((resolve) => { waitingReads.push(resolve); });
    else activeReads += 1;
    return () => {
      const next = waitingReads.shift();
      if (next) next(); // Transfer the occupied slot directly to the next waiting reader.
      else activeReads -= 1;
    };
  }

  function apply(deviceId: string, snapshot: HostProjectAliasesSnapshot): void {
    if (snapshotsEqual(snapshots.get(deviceId), snapshot)) return;
    const next = new Map(snapshots);
    next.set(deviceId, snapshot);
    snapshots = next;
    notify();
  }

  function request(deviceId: string, read: ReadAliases, isCurrent: IsCurrent = () => true, invalidate = false): Promise<void> {
    let state = reads.get(deviceId);
    if (!state) {
      state = { read, isCurrent, revision: 0 };
      reads.set(deviceId, state);
    }
    state.read = read;
    state.isCurrent = isCurrent;
    if (invalidate) state.revision += 1;
    if (state.pending) return state.pending;
    const active = state;
    // Defer execution until pending is assigned, including synchronous reader throws.
    const pending = Promise.resolve().then(async () => {
      while (reads.get(deviceId) === active) {
        const release = await acquireReadSlot();
        if (reads.get(deviceId) !== active || !active.isCurrent()) {
          release();
          return;
        }
        const revision = active.revision;
        const guard = active.isCurrent;
        const loader = active.read;
        try {
          const snapshot = parseHostProjectAliasesSnapshot(await loader());
          if (reads.get(deviceId) !== active) return;
          if (revision !== active.revision) continue;
          if (snapshot && guard(snapshot)) apply(deviceId, snapshot);
        } catch (error) {
          if (reads.get(deviceId) !== active) return;
          if (revision !== active.revision) continue;
          // A transient failure must not erase a known name. An old host has no aliases to mirror.
          if (missingChannel(error) && guard()) apply(deviceId, { aliases: [], platform: '' });
        } finally {
          release();
        }
        // A synchronous subscriber can invalidate while apply() publishes the snapshot.
        if (revision !== active.revision) continue;
        active.pending = undefined;
        return;
      }
    }).finally(() => {
      if (reads.get(deviceId) === active && active.pending === pending) active.pending = undefined;
    });
    active.pending = pending;
    return pending;
  }

  return {
    getSnapshot: (): ProjectAliasesByDevice => snapshots,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refresh: (deviceId: string, read: ReadAliases, isCurrent?: IsCurrent) => request(deviceId, read, isCurrent),
    invalidate: (deviceId: string, read: ReadAliases, isCurrent?: IsCurrent) => request(deviceId, read, isCurrent, true),
    suspend(deviceId: string): void { reads.delete(deviceId); },
    remove(deviceId: string): void {
      reads.delete(deviceId);
      if (!snapshots.has(deviceId)) return;
      const next = new Map(snapshots);
      next.delete(deviceId);
      snapshots = next;
      notify();
    },
    clear(): void {
      reads.clear();
      if (snapshots.size === 0) return;
      snapshots = new Map();
      notify();
    },
  };
}
