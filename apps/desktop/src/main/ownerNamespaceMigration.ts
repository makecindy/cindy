import { app } from 'electron';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { dataOwnerStorageKey, type AppSessionMode } from './appSessionState.js';
import { createLogger } from './logger.js';
import {
  GHOST_MANIFEST_FILE,
  isOfficialGhostId,
  validateGhostManifest,
} from '../shared/ghost.js';
import {
  NO_LEGACY_GHOST_RECOVERY,
  type LegacyGhostRecoveryStatus,
} from '../shared/legacyGhostRecovery.js';

const CLAIM_MARKER = '.owner-namespace-claim-v1.json';
const BUILTIN_PROVISIONING_STATE_FILE = '.builtin-provisioning.json';
const LEGACY_PATHS = [
  'ghost-kv',
  'ghost-fs',
  'ghost-cindy-prefs.json',
  'ghost-workdir-prefs.json',
  'ghost-recent-usage.json',
  'dialogues',
  'learn',
  'maker-memory',
  'cindy-brain',
  'brain',
  'builtin-tools-settings.json',
  'slack-hook.json',
  'hook-bindings.json',
  'hook-connections.json',
  'voice-input-models.json',
  'voice-input-data.v1.json',
  'model-access-credentials.json',
  'memory-settings.json',
  'contacts-settings.json',
  'maker-contacts',
  'compaction-settings.json',
  'subagent-model-settings.json',
] as const;

interface MigrationSessionState {
  mode: AppSessionMode;
  dataOwnerId: string | null;
  user: { id: string } | null;
}

interface ClaimMarker {
  version: 1;
  ownerKey: string;
  complete: boolean;
}

interface MigrationDeps {
  userDataDir(): string;
  readFile(file: string): Promise<string>;
  writeFileExclusive(file: string, text: string): Promise<void>;
  writeFile(file: string, text: string): Promise<void>;
  lstat(file: string): Promise<{ isDirectory(): boolean }>;
  readdir(dir: string): Promise<string[]>;
  mkdir(dir: string): Promise<void>;
  rename(source: string, target: string): Promise<void>;
  rmdir(dir: string): Promise<void>;
  readlink(file: string): Promise<string>;
  /** 共享 userData 的 passive dev(--preserve-running / --passive 非 isolated)。 */
  passiveSharedUserData(): boolean;
  selfPid(): number;
  isPidAlive(pid: number): boolean;
}

/** claim 被推迟(而非放弃)的原因;下次独占启动时自然重试完成。 */
export type OwnerNamespaceClaimDeferredReason =
  | 'passive-shared-user-data'
  | 'concurrent-live-instances';

export interface OwnerNamespaceMigrationResult {
  status: 'skipped' | 'deferred' | 'claimed-by-other-owner' | 'migrated' | 'partial';
  moved: number;
  conflicts: number;
  provisioningStateMoved?: boolean;
  deferredReason?: OwnerNamespaceClaimDeferredReason;
}

const log = createLogger('ownerNamespaceMigration');
const legacyGhostMigrationResults = new Map<
  string,
  OwnerNamespaceMigrationResult['status']
>();

const productionDeps: MigrationDeps = {
  userDataDir: () => app.getPath('userData'),
  readFile: (file) => fs.readFile(file, 'utf-8'),
  writeFileExclusive: (file, text) => fs.writeFile(file, text, { encoding: 'utf-8', flag: 'wx' }),
  writeFile: (file, text) => fs.writeFile(file, text, 'utf-8'),
  lstat: (file) => fs.lstat(file),
  readdir: (dir) => fs.readdir(dir),
  mkdir: async (dir) => {
    await fs.mkdir(dir, { recursive: true });
  },
  rename: (source, target) => fs.rename(source, target),
  rmdir: (dir) => fs.rmdir(dir),
  readlink: (file) => fs.readlink(file),
  passiveSharedUserData: () => process.env.XDT_PASSIVE_SHARED_USER_DATA === '1',
  selfPid: () => process.pid,
  isPidAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM = 进程存在但无权限发信号,同样算存活。
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
};

function verifiedCloudOwner(state: MigrationSessionState): string | null {
  if (state.mode !== 'cloud') return null;
  if (!state.dataOwnerId || !state.user || state.user.id !== state.dataOwnerId) {
    throw new Error('owner namespace migration requires a verified cloud membership');
  }
  return state.user.id;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function readMarker(deps: MigrationDeps, markerPath: string): Promise<ClaimMarker | null> {
  try {
    const parsed = JSON.parse(await deps.readFile(markerPath)) as Partial<ClaimMarker>;
    if (
      parsed.version === 1 &&
      typeof parsed.ownerKey === 'string' &&
      typeof parsed.complete === 'boolean'
    ) {
      return parsed as ClaimMarker;
    }
    throw new Error('invalid owner namespace claim marker');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function isPidAliveDefault(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但无权限发信号,同样算存活。
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Synchronous twin of findConcurrentLiveInstancePids for the importer gate
 * (hasLegacyOwnerNamespaceClaim runs in sync call sites). Fail-closed: any
 * unreadable registry state counts as "a peer may be live". Same signals —
 * `.dev-instances/<pid>.json` records plus the packaged SingletonLock
 * symlink (retroactive signal for pre-registry packaged builds).
 */
function hasConcurrentLiveInstanceSync(
  userDataDir: string,
  isPidAlive: (pid: number) => boolean,
): boolean {
  const selfPid = process.pid;
  const registryDir = path.join(userDataDir, '.dev-instances');
  let names: string[] = [];
  try {
    names = fsSync.readdirSync(registryDir);
  } catch (error) {
    if (!isMissing(error)) return true;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let raw: string;
    try {
      raw = fsSync.readFileSync(path.join(registryDir, name), 'utf-8');
    } catch (error) {
      if (isMissing(error)) continue;
      return true;
    }
    let record: Partial<{ pid: number; userDataDir: string }>;
    try {
      record = JSON.parse(raw) as Partial<{ pid: number; userDataDir: string }>;
    } catch {
      continue; // torn leftover
    }
    const pid = record.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid === selfPid) continue;
    if (
      typeof record.userDataDir === 'string' &&
      !isSameUserDataDir(record.userDataDir, userDataDir, process.platform)
    ) {
      continue;
    }
    if (isPidAlive(pid)) return true;
  }
  try {
    const lockTarget = fsSync.readlinkSync(path.join(userDataDir, 'SingletonLock'));
    const match = /-(\d+)$/.exec(lockTarget);
    const lockPid = match ? Number(match[1]) : null;
    if (
      lockPid !== null &&
      Number.isInteger(lockPid) &&
      lockPid !== selfPid &&
      isPidAlive(lockPid)
    ) {
      return true;
    }
  } catch {
    // ENOENT(无 packaged 实例)/EINVAL(非 symlink)——无信号。
  }
  return false;
}

/**
 * Whether this process may safely inspect or claim state from the shared,
 * pre-owner userData namespace. Unlike hasLegacyOwnerNamespaceClaim, this
 * predicate does not require a verified cloud-owner marker, so stable local
 * profiles can use it for their own one-time owner attribution.
 */
export function hasExclusiveSharedLegacyUserDataAccess(
  userDataDir = app.getPath('userData'),
  isPidAlive: (pid: number) => boolean = isPidAliveDefault,
): boolean {
  return (
    process.env.XDT_PASSIVE_SHARED_USER_DATA !== '1' &&
    !hasConcurrentLiveInstanceSync(userDataDir, isPidAlive)
  );
}

/**
 * Legacy secrets may only be imported by the cloud owner that won the global
 * pre-namespace claim. The marker is intentionally outside owner roots so a
 * later account cannot reinterpret the same shared legacy credential files.
 *
 * True only for a COMPLETED claim: consumers (provider secrets / IM storage /
 * brain account import) move files themselves, so a partial claim must keep
 * them waiting until the deferred main migration finishes — otherwise a
 * passive or concurrent startup could still relocate legacy files out from
 * under an older live instance through these side channels. Passive
 * shared-userData instances always answer false for the same reason, and so
 * does any moment where another live instance shares this userData: a claim
 * completed long ago does not make TODAY exclusive (an older build started
 * later would still lose its legacy secret/IM files to these importers —
 * exactly the 2026-07-23 safe-storage incident shape). Importers re-run on
 * every login, so a false here only defers the import, never cancels it.
 */
export function hasLegacyOwnerNamespaceClaim(
  ownerId: string,
  userDataDir = app.getPath('userData'),
  isPidAlive: (pid: number) => boolean = isPidAliveDefault,
): boolean {
  if (!hasExclusiveSharedLegacyUserDataAccess(userDataDir, isPidAlive)) return false;
  try {
    const parsed = JSON.parse(
      fsSync.readFileSync(path.join(userDataDir, CLAIM_MARKER), 'utf-8'),
    ) as Partial<ClaimMarker>;
    if (
      parsed.version !== 1 ||
      parsed.ownerKey !== dataOwnerStorageKey(ownerId) ||
      parsed.complete !== true
    ) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

function readMarkerSync(
  userDataDir: string,
): { marker: ClaimMarker | null; invalid: boolean } {
  try {
    const parsed = JSON.parse(
      fsSync.readFileSync(path.join(userDataDir, CLAIM_MARKER), 'utf-8'),
    ) as Partial<ClaimMarker>;
    if (
      parsed.version === 1 &&
      typeof parsed.ownerKey === 'string' &&
      typeof parsed.complete === 'boolean'
    ) {
      return { marker: parsed as ClaimMarker, invalid: false };
    }
    return { marker: null, invalid: true };
  } catch (error) {
    return isMissing(error)
      ? { marker: null, invalid: false }
      : { marker: null, invalid: true };
  }
}

/**
 * Whether the immutable shared legacy-data claim belongs to another owner.
 * Partial claims count: once a marker names an owner, later accounts must not
 * reinterpret or wait on that owner's remaining legacy files.
 */
export function isLegacyOwnerNamespaceClaimedByOtherOwner(
  ownerId: string,
  userDataDir = app.getPath('userData'),
): boolean {
  const { marker, invalid } = readMarkerSync(userDataDir);
  return !invalid && marker !== null && marker.ownerKey !== dataOwnerStorageKey(ownerId);
}

/**
 * Read-only inspection for consumers opening data that is already owner-scoped.
 * This is not permission to move shared legacy files: unlike
 * hasLegacyOwnerNamespaceClaim, it accepts partial claims and intentionally
 * ignores passive/live peers.
 */
export function isLegacyOwnerNamespaceClaimOwnedBy(
  ownerId: string,
  userDataDir = app.getPath('userData'),
): boolean {
  const { marker, invalid } = readMarkerSync(userDataDir);
  return (
    !invalid &&
    marker !== null &&
    marker.ownerKey === dataOwnerStorageKey(ownerId)
  );
}

interface LegacyGhostDir {
  root: string;
  id: string;
  dir: string;
  command: string | null;
}

function filterLegacyGhostsByIdPolicy(
  ghosts: LegacyGhostDir[],
  rejectReservedIds: boolean,
): LegacyGhostDir[] {
  return rejectReservedIds ? ghosts.filter((ghost) => !isOfficialGhostId(ghost.id)) : ghosts;
}

function readValidLegacyGhostDir(
  dir: string,
  expectedId: string,
): Pick<LegacyGhostDir, 'command'> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fsSync.readFileSync(path.join(dir, GHOST_MANIFEST_FILE), 'utf-8'));
  } catch {
    return null;
  }
  const parsed = validateGhostManifest(raw);
  if (!parsed.ok || parsed.manifest.id !== expectedId) return null;
  return { command: parsed.manifest.command ?? null };
}

function pathExistsNoFollowSync(
  file: string,
  lstat: (path: string) => fsSync.Stats = fsSync.lstatSync,
): boolean {
  try {
    lstat(file);
    return true;
  } catch (error) {
    return !isMissing(error);
  }
}

function hasBlockingProvisioningStateSync(legacyRoot: string, targetRoot: string): boolean {
  const sourceState = path.join(legacyRoot, BUILTIN_PROVISIONING_STATE_FILE);
  let sourceStateStats: fsSync.Stats;
  try {
    sourceStateStats = fsSync.lstatSync(sourceState);
  } catch (error) {
    return !isMissing(error);
  }
  if (!sourceStateStats.isFile() || sourceStateStats.isSymbolicLink()) return true;
  return pathExistsNoFollowSync(path.join(targetRoot, BUILTIN_PROVISIONING_STATE_FILE));
}

function sharedLegacyGhostRootDirs(userDataDir: string): string[] {
  return [path.join(userDataDir, 'cindy-brain'), path.join(userDataDir, 'brain')];
}

function ownerScopedLegacyGhostRootDir(userDataDir: string, ownerKey: string): string {
  return path.join(userDataDir, 'owners', ownerKey, 'brain');
}

function listLegacyGhostDirsInRoots(
  roots: string[],
): LegacyGhostDir[] {
  const result: LegacyGhostDir[] = [];
  for (const root of roots) {
    try {
      const stats = fsSync.lstatSync(root);
      if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    let entries: fsSync.Dirent[];
    try {
      entries = fsSync.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const dir = path.join(root, entry.name);
      let dirStats: fsSync.Stats;
      try {
        dirStats = fsSync.lstatSync(dir);
      } catch {
        continue;
      }
      if (!dirStats.isDirectory() || dirStats.isSymbolicLink()) continue;
      const valid = readValidLegacyGhostDir(dir, entry.name);
      if (valid) result.push({ root, id: entry.name, dir, command: valid.command });
    }
  }
  return result;
}

function listSharedLegacyGhostDirs(
  userDataDir: string,
): LegacyGhostDir[] {
  return listLegacyGhostDirsInRoots(sharedLegacyGhostRootDirs(userDataDir));
}

function listOwnerScopedLegacyGhostDirs(
  userDataDir: string,
  ownerKey: string,
): LegacyGhostDir[] {
  return listLegacyGhostDirsInRoots([
    ownerScopedLegacyGhostRootDir(userDataDir, ownerKey),
  ]);
}

function listLegacyGhostDirs(
  userDataDir: string,
  ownerKey?: string,
): LegacyGhostDir[] {
  const shared = listSharedLegacyGhostDirs(userDataDir);
  return ownerKey
    ? [...shared, ...listOwnerScopedLegacyGhostDirs(userDataDir, ownerKey)]
    : shared;
}

export function countLegacyGhostPlugins(
  userDataDir = app.getPath('userData'),
  ownerKey?: string,
): number {
  return listLegacyGhostDirs(userDataDir, ownerKey).length;
}

export function listLegacyGhostPluginSources(
  ownerId: string,
  userDataDir = app.getPath('userData'),
): Array<{ id: string; dir: string }> {
  const ownerKey = dataOwnerStorageKey(ownerId);
  return listLegacyGhostDirs(userDataDir, ownerKey).map(({ id, dir }) => ({ id, dir }));
}

/**
 * Return only legacy roots whose provisioning state and owner claim can move
 * into the active owner namespace. Tombstones from a foreign or blocked root
 * must not suppress built-ins that will be reconciled for the active owner.
 */
export function listLegacyGhostTombstoneRoots(
  ownerId: string,
  userDataDir = app.getPath('userData'),
): string[] {
  const ownerKey = dataOwnerStorageKey(ownerId);
  const targetRoot = path.join(userDataDir, 'owners', ownerKey, 'cindy-brain');
  const sharedLegacyGhosts = listSharedLegacyGhostDirs(userDataDir);
  const scopedLegacyGhosts = listOwnerScopedLegacyGhostDirs(userDataDir, ownerKey);
  const markerRead = readMarkerSync(userDataDir);
  const sharedRecoveryBlocked =
    sharedLegacyGhosts.length > 0 &&
    (markerRead.invalid ||
      (markerRead.marker !== null && markerRead.marker.ownerKey !== ownerKey));
  const eligible = sharedRecoveryBlocked
    ? scopedLegacyGhosts
    : [...sharedLegacyGhosts, ...scopedLegacyGhosts];
  const blockedRoots = new Set(
    eligible
      .map((legacy) => legacy.root)
      .filter((legacyRoot) => hasBlockingProvisioningStateSync(legacyRoot, targetRoot)),
  );
  return [...new Set(eligible.map((legacy) => legacy.root))].filter(
    (legacyRoot) => !blockedRoots.has(legacyRoot),
  );
}

function hasSafeRecoveryTargetChainSync(userDataDir: string, targetRoot: string): boolean {
  const relative = path.relative(userDataDir, targetRoot);
  if (
    relative.length === 0 ||
    path.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`)
  ) {
    return false;
  }
  let current = userDataDir;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      const stats = fsSync.lstatSync(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    } catch (error) {
      if (isMissing(error)) continue;
      return false;
    }
  }
  return true;
}

export function recordLegacyGhostMigrationResult(
  ownerId: string,
  result: OwnerNamespaceMigrationResult,
  userDataDir = app.getPath('userData'),
): void {
  const ownerKey = dataOwnerStorageKey(ownerId);
  let status = result.status;
  if (
    status === 'migrated' &&
    result.conflicts > 0 &&
    countLegacyGhostPlugins(userDataDir, ownerKey) > 0
  ) {
    status = 'partial';
  }
  legacyGhostMigrationResults.set(ownerKey, status);
}

export function getLegacyGhostRecoveryStatus(
  session: MigrationSessionState,
  userDataDir?: string,
  boundaryPending = false,
  options: {
    reservedCommands?: ReadonlySet<string>;
    rejectReservedIds?: boolean;
  } = {},
  isPidAlive: (pid: number) => boolean = isPidAliveDefault,
): LegacyGhostRecoveryStatus {
  if (boundaryPending || session.mode !== 'cloud' || !session.dataOwnerId || !session.user) {
    return NO_LEGACY_GHOST_RECOVERY;
  }
  if (session.user.id !== session.dataOwnerId) return NO_LEGACY_GHOST_RECOVERY;

  const root = userDataDir ?? app.getPath('userData');
  const ownerKey = dataOwnerStorageKey(session.dataOwnerId);
  const rejectReservedIds = options.rejectReservedIds === true;
  const sharedLegacyGhosts = filterLegacyGhostsByIdPolicy(
    listSharedLegacyGhostDirs(root),
    rejectReservedIds,
  );
  const scopedLegacyGhosts = filterLegacyGhostsByIdPolicy(
    listOwnerScopedLegacyGhostDirs(root, ownerKey),
    rejectReservedIds,
  );

  const markerRead = readMarkerSync(root);
  const sharedRecoveryBlocked =
    sharedLegacyGhosts.length > 0 &&
    (markerRead.invalid ||
      (markerRead.marker !== null && markerRead.marker.ownerKey !== ownerKey));
  if (sharedRecoveryBlocked && scopedLegacyGhosts.length === 0) {
    if (markerRead.marker && markerRead.marker.ownerKey !== ownerKey) {
      // 已明确属于其他账号的共享目录不是当前账号的恢复任务。
      return NO_LEGACY_GHOST_RECOVERY;
    }
    return {
      state: 'partial',
      legacyPluginCount: sharedLegacyGhosts.length,
      canRetry: false,
    };
  }
  const eligibleLegacyGhosts = sharedRecoveryBlocked
    ? scopedLegacyGhosts
    : [...sharedLegacyGhosts, ...scopedLegacyGhosts];
  const legacyPluginCount = eligibleLegacyGhosts.length;
  if (legacyPluginCount === 0) return NO_LEGACY_GHOST_RECOVERY;
  if (process.env.XDT_PASSIVE_SHARED_USER_DATA === '1') {
    return { state: 'deferred', legacyPluginCount, canRetry: false };
  }
  if (hasConcurrentLiveInstanceSync(root, isPidAlive)) {
    return { state: 'deferred', legacyPluginCount, canRetry: false };
  }

  const targetRoot = path.join(root, 'owners', ownerKey, 'cindy-brain');
  if (!hasSafeRecoveryTargetChainSync(root, targetRoot)) {
    return { state: 'partial', legacyPluginCount, canRetry: false };
  }
  const occupiedCommands = new Set(
    listLegacyGhostDirsInRoots([targetRoot])
      .map((legacy) => legacy.command?.toLowerCase() ?? null)
      .filter((command): command is string => command !== null),
  );
  for (const command of options.reservedCommands ?? []) {
    occupiedCommands.add(command.toLowerCase());
  }
  const blockedRoots = new Set(
    eligibleLegacyGhosts
      .map((legacy) => legacy.root)
      .filter((legacyRoot) => hasBlockingProvisioningStateSync(legacyRoot, targetRoot)),
  );
  const canRetry = eligibleLegacyGhosts.some((legacy) => {
    if (blockedRoots.has(legacy.root)) return false;
    if (pathExistsNoFollowSync(path.join(targetRoot, legacy.id))) return false;
    const command = legacy.command?.toLowerCase() ?? null;
    return command === null || !occupiedCommands.has(command);
  });
  if (!canRetry) {
    return { state: 'partial', legacyPluginCount, canRetry: false };
  }

  const marker = markerRead.marker;
  const last = legacyGhostMigrationResults.get(ownerKey);
  if (last === 'deferred') return { state: 'deferred', legacyPluginCount, canRetry: true };
  if (last === 'partial') return { state: 'partial', legacyPluginCount, canRetry: true };
  if (marker && !marker.complete) return { state: 'partial', legacyPluginCount, canRetry: true };
  return { state: 'partial', legacyPluginCount, canRetry: true };
}

export async function recoverLegacyGhostPlugins(
  state: MigrationSessionState,
  deps: MigrationDeps = productionDeps,
  options: {
    shouldAbort?: () => boolean;
    reservedCommands?: ReadonlySet<string>;
    rejectReservedIds?: boolean;
  } = {},
): Promise<OwnerNamespaceMigrationResult> {
  const ownerId = verifiedCloudOwner(state);
  if (!ownerId) return { status: 'skipped', moved: 0, conflicts: 0 };
  if (options.shouldAbort?.()) return { status: 'deferred', moved: 0, conflicts: 0 };

  const userDataDir = deps.userDataDir();
  const ownerKey = dataOwnerStorageKey(ownerId);
  const markerPath = path.join(userDataDir, CLAIM_MARKER);
  const rejectReservedIds = options.rejectReservedIds === true;
  const sharedLegacyGhosts = filterLegacyGhostsByIdPolicy(
    listSharedLegacyGhostDirs(userDataDir),
    rejectReservedIds,
  );
  const scopedLegacyGhosts = filterLegacyGhostsByIdPolicy(
    listOwnerScopedLegacyGhostDirs(userDataDir, ownerKey),
    rejectReservedIds,
  );
  let marker: ClaimMarker | null = null;
  let eligibleSharedGhosts = sharedLegacyGhosts;
  let sharedRecoveryBlocked = false;
  if (sharedLegacyGhosts.length > 0) {
    try {
      marker = await readMarker(deps, markerPath);
      if (marker && marker.ownerKey !== ownerKey) {
        eligibleSharedGhosts = [];
        sharedRecoveryBlocked = true;
      }
    } catch (error) {
      eligibleSharedGhosts = [];
      sharedRecoveryBlocked = true;
      log.warn('legacy ghost recovery blocked: claim marker unreadable', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (
    sharedRecoveryBlocked &&
    scopedLegacyGhosts.length === 0 &&
    marker &&
    marker.ownerKey !== ownerKey
  ) {
    const result: OwnerNamespaceMigrationResult = {
      status: 'claimed-by-other-owner',
      moved: 0,
      conflicts: 0,
    };
    recordLegacyGhostMigrationResult(ownerId, result, userDataDir);
    return result;
  }

  const targetRoot = path.join(userDataDir, 'owners', ownerKey, 'cindy-brain');
  let movableLegacyGhosts: ReturnType<typeof listLegacyGhostDirs> = [];
  let conflicts = sharedRecoveryBlocked ? sharedLegacyGhosts.length : 0;
  for (const legacy of [...eligibleSharedGhosts, ...scopedLegacyGhosts]) {
    if ((await pathType(deps, path.join(targetRoot, legacy.id))) === 'missing') {
      movableLegacyGhosts.push(legacy);
    } else {
      conflicts += 1;
    }
  }
  if (movableLegacyGhosts.length === 0) {
    const result: OwnerNamespaceMigrationResult = {
      status: conflicts > 0 ? 'partial' : 'skipped',
      moved: 0,
      conflicts,
    };
    recordLegacyGhostMigrationResult(ownerId, result, userDataDir);
    return result;
  }

  if (deps.passiveSharedUserData()) {
    const result: OwnerNamespaceMigrationResult = {
      status: 'deferred',
      moved: 0,
      conflicts: 0,
      deferredReason: 'passive-shared-user-data',
    };
    recordLegacyGhostMigrationResult(ownerId, result, userDataDir);
    return result;
  }
  try {
    const pids = await findConcurrentLiveInstancePids(deps, userDataDir);
    if (pids.length > 0) {
      const result: OwnerNamespaceMigrationResult = {
        status: 'deferred',
        moved: 0,
        conflicts: 0,
        deferredReason: 'concurrent-live-instances',
      };
      recordLegacyGhostMigrationResult(ownerId, result, userDataDir);
      return result;
    }
  } catch (error) {
    log.warn('legacy ghost recovery deferred: instance registry unreadable', {
      error: error instanceof Error ? error.message : String(error),
    });
    const result: OwnerNamespaceMigrationResult = {
      status: 'deferred',
      moved: 0,
      conflicts: 0,
      deferredReason: 'concurrent-live-instances',
    };
    recordLegacyGhostMigrationResult(ownerId, result, userDataDir);
    return result;
  }

  if (options.shouldAbort?.()) return { status: 'deferred', moved: 0, conflicts: 0 };
  await deps.mkdir(userDataDir);
  const sharedDirs = new Set(sharedLegacyGhosts.map((legacy) => legacy.dir));

  let moved = 0;
  let provisioningStateMoved = false;
  let failed = false;
  let concurrentRecoveryInterrupted = false;
  if (!hasSafeRecoveryTargetChainSync(userDataDir, targetRoot)) {
    const result: OwnerNamespaceMigrationResult = {
      status: 'partial',
      moved: 0,
      conflicts: conflicts + movableLegacyGhosts.length,
    };
    recordLegacyGhostMigrationResult(ownerId, result, userDataDir);
    return result;
  }
  const preflightBlockedRoots = new Set(
    movableLegacyGhosts
      .map((legacy) => legacy.root)
      .filter((legacyRoot) => hasBlockingProvisioningStateSync(legacyRoot, targetRoot)),
  );
  if (preflightBlockedRoots.size > 0) {
    const blockedCount = movableLegacyGhosts.filter((legacy) =>
      preflightBlockedRoots.has(legacy.root)
    ).length;
    conflicts += blockedCount;
    failed = true;
    movableLegacyGhosts = movableLegacyGhosts.filter(
      (legacy) => !preflightBlockedRoots.has(legacy.root),
    );
  }
  if (movableLegacyGhosts.length === 0) {
    const result: OwnerNamespaceMigrationResult = {
      status: conflicts > 0 ? 'partial' : 'skipped',
      moved: 0,
      conflicts,
    };
    recordLegacyGhostMigrationResult(ownerId, result, userDataDir);
    return result;
  }
  const occupiedCommands = new Set(
    listLegacyGhostDirsInRoots([targetRoot])
      .map((legacy) => legacy.command?.toLowerCase() ?? null)
      .filter((command): command is string => command !== null),
  );
  for (const command of options.reservedCommands ?? []) {
    occupiedCommands.add(command.toLowerCase());
  }
  const commandSafeLegacyGhosts: typeof movableLegacyGhosts = [];
  for (const legacy of movableLegacyGhosts) {
    const command = legacy.command?.toLowerCase() ?? null;
    if (command !== null && occupiedCommands.has(command)) {
      conflicts += 1;
      continue;
    }
    if (command !== null) occupiedCommands.add(command);
    commandSafeLegacyGhosts.push(legacy);
  }
  movableLegacyGhosts = commandSafeLegacyGhosts;
  if (movableLegacyGhosts.length === 0) {
    const result: OwnerNamespaceMigrationResult = {
      status: conflicts > 0 ? 'partial' : 'skipped',
      moved: 0,
      conflicts,
    };
    recordLegacyGhostMigrationResult(ownerId, result, userDataDir);
    return result;
  }
  if (options.shouldAbort?.()) return { status: 'deferred', moved: 0, conflicts: 0 };
  const needsSharedClaim = movableLegacyGhosts.some((legacy) => sharedDirs.has(legacy.dir));
  if (needsSharedClaim && !marker) {
    marker = { version: 1, ownerKey, complete: false };
    try {
      await deps.writeFileExclusive(markerPath, JSON.stringify(marker));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      marker = await readMarker(deps, markerPath);
      if (!marker) throw new Error('owner namespace claim marker disappeared');
      if (marker.ownerKey !== ownerKey) {
        const scopedMovableGhosts = movableLegacyGhosts.filter(
          (legacy) => !sharedDirs.has(legacy.dir),
        );
        if (scopedMovableGhosts.length === 0) {
          const result: OwnerNamespaceMigrationResult = {
            status: 'claimed-by-other-owner',
            moved: 0,
            conflicts: 0,
          };
          recordLegacyGhostMigrationResult(ownerId, result, userDataDir);
          return result;
        }
        conflicts += movableLegacyGhosts.length - scopedMovableGhosts.length;
        movableLegacyGhosts = scopedMovableGhosts;
      }
    }
  }
  const targetRootWasMissing = (await pathType(deps, targetRoot)) === 'missing';
  await deps.mkdir(targetRoot);
  if (!hasSafeRecoveryTargetChainSync(userDataDir, targetRoot)) {
    const result: OwnerNamespaceMigrationResult = {
      status: 'partial',
      moved: 0,
      conflicts: conflicts + movableLegacyGhosts.length,
    };
    recordLegacyGhostMigrationResult(ownerId, result, userDataDir);
    return result;
  }
  const blockedRoots = new Set<string>();
  for (const legacyRoot of new Set(movableLegacyGhosts.map((legacy) => legacy.root))) {
    const sourceState = path.join(legacyRoot, BUILTIN_PROVISIONING_STATE_FILE);
    let sourceStateStats: fsSync.Stats;
    try {
      sourceStateStats = fsSync.lstatSync(sourceState);
    } catch (error) {
      if (isMissing(error)) continue;
      blockedRoots.add(legacyRoot);
      failed = true;
      log.warn('legacy ghost recovery blocked: provisioning state unreadable', {
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!sourceStateStats.isFile() || sourceStateStats.isSymbolicLink()) {
      blockedRoots.add(legacyRoot);
      failed = true;
      log.warn('legacy ghost recovery blocked: provisioning state is not a regular file');
      continue;
    }
    const targetState = path.join(targetRoot, BUILTIN_PROVISIONING_STATE_FILE);
    if (pathExistsNoFollowSync(targetState)) {
      blockedRoots.add(legacyRoot);
      failed = true;
      log.warn('legacy ghost recovery blocked: provisioning state target already exists');
      continue;
    }
    let racedPids: number[];
    try {
      racedPids = await findConcurrentLiveInstancePids(deps, userDataDir);
    } catch (error) {
      blockedRoots.add(legacyRoot);
      failed = true;
      concurrentRecoveryInterrupted = true;
      log.warn('legacy ghost recovery blocked: instance registry unreadable before state move', {
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (racedPids.length > 0) {
      blockedRoots.add(legacyRoot);
      failed = true;
      concurrentRecoveryInterrupted = true;
      log.info('legacy ghost recovery blocked: instance started before state move', {
        racedPids,
      });
      continue;
    }
    if (options.shouldAbort?.()) {
      blockedRoots.add(legacyRoot);
      failed = true;
      continue;
    }
    try {
      await deps.rename(sourceState, targetState);
      if (options.shouldAbort?.()) {
        let rollbackAllowed = false;
        try {
          const rollbackPeers = await findConcurrentLiveInstancePids(deps, userDataDir);
          rollbackAllowed = rollbackPeers.length === 0;
          if (!rollbackAllowed) {
            concurrentRecoveryInterrupted = true;
            log.info('legacy ghost recovery skipped provisioning rollback: instance started', {
              racedPids: rollbackPeers,
            });
          }
        } catch (error) {
          concurrentRecoveryInterrupted = true;
          log.warn('legacy ghost recovery skipped provisioning rollback: registry unreadable', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (rollbackAllowed) {
          try {
            await deps.rename(targetState, sourceState);
          } catch (rollbackError) {
            provisioningStateMoved = true;
            log.warn('legacy ghost recovery could not roll back provisioning state', {
              error:
                rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            });
          }
        } else {
          provisioningStateMoved = true;
        }
        blockedRoots.add(legacyRoot);
        failed = true;
        continue;
      }
      provisioningStateMoved = true;
    } catch (error) {
      blockedRoots.add(legacyRoot);
      failed = true;
      log.warn('legacy ghost recovery failed to move provisioning state', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (blockedRoots.size > 0) {
    const blockedCount = movableLegacyGhosts.filter((legacy) =>
      blockedRoots.has(legacy.root)
    ).length;
    conflicts += blockedCount;
    movableLegacyGhosts = movableLegacyGhosts.filter(
      (legacy) => !blockedRoots.has(legacy.root),
    );
  }
  for (const legacy of movableLegacyGhosts) {
    if (options.shouldAbort?.()) {
      failed = true;
      break;
    }
    const target = path.join(targetRoot, legacy.id);
    if ((await pathType(deps, target)) !== 'missing') {
      conflicts += 1;
      continue;
    }
    let racedPids: number[];
    try {
      racedPids = await findConcurrentLiveInstancePids(deps, userDataDir);
    } catch (error) {
      failed = true;
      concurrentRecoveryInterrupted = true;
      log.warn('legacy ghost recovery interrupted: registry unreadable mid-recovery', {
        id: legacy.id,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
    if (racedPids.length > 0) {
      failed = true;
      concurrentRecoveryInterrupted = true;
      log.info('legacy ghost recovery interrupted: instance started mid-recovery', {
        id: legacy.id,
        racedPids,
      });
      break;
    }
    try {
      await deps.rename(legacy.dir, target);
      moved += 1;
    } catch (error) {
      failed = true;
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        conflicts += 1;
        continue;
      }
      log.warn('legacy ghost recovery failed to move plugin', {
        id: legacy.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const legacyRoot of new Set(movableLegacyGhosts.map((legacy) => legacy.root))) {
    if (options.shouldAbort?.()) {
      failed = true;
      break;
    }
    let cleanupPids: number[];
    try {
      cleanupPids = await findConcurrentLiveInstancePids(deps, userDataDir);
    } catch (error) {
      failed = true;
      concurrentRecoveryInterrupted = true;
      log.warn('legacy ghost recovery kept old root: registry unreadable before cleanup', {
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
    if (cleanupPids.length > 0) {
      failed = true;
      concurrentRecoveryInterrupted = true;
      log.info('legacy ghost recovery kept old root: instance started before cleanup', {
        racedPids: cleanupPids,
      });
      break;
    }
    try {
      await deps.rmdir(legacyRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY' && !isMissing(error)) {
        log.warn('legacy ghost recovery could not remove an empty root', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  if (targetRootWasMissing && moved === 0 && !provisioningStateMoved) {
    let canRemoveTargetRoot = false;
    try {
      canRemoveTargetRoot =
        (await findConcurrentLiveInstancePids(deps, userDataDir)).length === 0;
    } catch (error) {
      log.warn('legacy ghost recovery kept empty target: instance registry unreadable', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (canRemoveTargetRoot && hasSafeRecoveryTargetChainSync(userDataDir, targetRoot)) {
      try {
        await deps.rmdir(targetRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY' && !isMissing(error)) {
          log.warn('legacy ghost recovery could not remove empty target root', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
  const result: OwnerNamespaceMigrationResult = {
    status: failed || conflicts > 0 ? 'partial' : 'migrated',
    moved,
    conflicts,
    ...(provisioningStateMoved ? { provisioningStateMoved: true } : {}),
    ...(concurrentRecoveryInterrupted
      ? { deferredReason: 'concurrent-live-instances' as const }
      : {}),
  };
  recordLegacyGhostMigrationResult(ownerId, result, userDataDir);
  return result;
}

async function pathType(
  deps: MigrationDeps,
  file: string,
): Promise<'missing' | 'directory' | 'other'> {
  try {
    return (await deps.lstat(file)).isDirectory() ? 'directory' : 'other';
  } catch (error) {
    if (isMissing(error)) return 'missing';
    throw error;
  }
}

/**
 * Thrown from an abortCheck when a concurrent instance appears mid-move.
 * The claim loop turns it into a partial result (resume on next exclusive
 * start) instead of a per-path failure log.
 */
class ClaimInterruptedError extends Error {
  constructor(
    public readonly racedPids: number[],
    public readonly cause?: unknown,
  ) {
    super(
      cause
        ? 'owner namespace claim interrupted: registry unreadable mid-move'
        : 'owner namespace claim interrupted by a concurrent instance',
    );
  }
}

async function moveWithoutOverwrite(
  deps: MigrationDeps,
  source: string,
  target: string,
  abortCheck?: () => Promise<void>,
): Promise<{ moved: number; conflicts: number }> {
  const sourceType = await pathType(deps, source);
  if (sourceType === 'missing') return { moved: 0, conflicts: 0 };

  const targetType = await pathType(deps, target);
  if (targetType === 'missing') {
    await deps.mkdir(path.dirname(target));
    try {
      await deps.rename(source, target);
      return { moved: 1, conflicts: 0 };
    } catch (error) {
      // Another process for the same owner may have won the target race.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  if (sourceType !== 'directory' || (await pathType(deps, target)) !== 'directory') {
    return { moved: 0, conflicts: 1 };
  }

  let moved = 0;
  let conflicts = 0;
  for (const name of await deps.readdir(source)) {
    // 合并式目录递归可能很长(dialogues/cindy-brain 等):子项之间也让并发检查
    // 有机会中断(节流由调用方控制),避免「per-path 初扫后整树长窗口」。
    await abortCheck?.();
    const result = await moveWithoutOverwrite(
      deps,
      path.join(source, name),
      path.join(target, name),
      abortCheck,
    );
    moved += result.moved;
    conflicts += result.conflicts;
  }
  try {
    await deps.rmdir(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY' && !isMissing(error)) throw error;
  }
  return { moved, conflicts };
}

/**
 * Windows(含盘符)与 macOS 的默认卷都是大小写不敏感文件系统,仅按字节比较会把
 * 大小写不同、实际同一目录的记录误判为「别的 userData」而漏掉活实例——漏判方向
 * 是数据事故。反向(在大小写敏感卷上把两个真不同的目录折叠成同一)的误判方向只是
 * 多推迟一轮迁移,保守安全,因此 win32/darwin 一律折叠。Linux 默认大小写敏感,
 * 保持字节精确。
 */
function isSameUserDataDir(a: string, b: string, platform: NodeJS.Platform): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return platform === 'win32' || platform === 'darwin'
    ? ra.toLowerCase() === rb.toLowerCase()
    : ra === rb;
}

/**
 * Other live Cindy instances sharing this userData, discovered via the
 * `.dev-instances/<pid>.json` runtime provenance registry (devStartupStatus;
 * written by dev AND packaged builds — dev/release share the userData by
 * design with per-flavor single-instance lock scopes, so packaged instances
 * must be visible to this scan too). A userData never touched by this build
 * line resolves to an empty list.
 *
 * Error posture is asymmetric on purpose: a record file that VANISHES
 * (ENOENT) means that instance exited — skip it; a record file that exists
 * but cannot be READ (EACCES, I/O errors) may hide a live instance — fail
 * closed by rethrowing so the caller defers the destructive claim. Only a
 * record that reads fine but fails to PARSE is treated as a torn leftover
 * (writes are atomic rename, so torn content cannot be a live registration).
 */
async function findConcurrentLiveInstancePids(
  deps: MigrationDeps,
  userDataDir: string,
): Promise<number[]> {
  const registryDir = path.join(userDataDir, '.dev-instances');
  let names: string[];
  try {
    names = await deps.readdir(registryDir);
  } catch (error) {
    if (!isMissing(error)) throw error;
    names = []; // 注册表目录不存在 ≠ 无并发:下方 SingletonLock 探测仍要跑。
  }
  const selfPid = deps.selfPid();
  const pids: number[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let raw: string;
    try {
      raw = await deps.readFile(path.join(registryDir, name));
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    let record: Partial<{ pid: number; userDataDir: string }>;
    try {
      record = JSON.parse(raw) as Partial<{ pid: number; userDataDir: string }>;
    } catch {
      continue; // torn leftover, never a live registration
    }
    const pid = record.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid === selfPid) continue;
    // 只认同一 userData 的记录;userDataDir 不一致说明是异常拷贝进来的残留。
    if (
      typeof record.userDataDir === 'string' &&
      !isSameUserDataDir(record.userDataDir, userDataDir, process.platform)
    ) {
      continue;
    }
    if (deps.isPidAlive(pid)) pids.push(pid);
  }

  // 追溯 fallback:本补丁之前的 packaged build 不写注册表,但 Chromium 单例锁是
  // 它们也一直持有的信号——packaged 的锁域就是 userData 根(bootstrap-electron
  // resolveSingleInstanceLockUserDataDir;dev 锁域在 dev-single-instance-lock/
  // 子目录,不会污染这里)。macOS/Linux 上锁是 SingletonLock symlink,target 形如
  // `<hostname>-<pid>`;解析 pid 做存活探测,stale 残留(崩溃后 pid 已死)自动排除。
  // win32 的 Chromium 用命名 mutex 无文件可查,该平台的历史盲区随 release 升级
  // 消失。best-effort:读不出/解析不出不阻塞(Chromium 自身会清理重建锁)。
  try {
    const lockTarget = await deps.readlink(path.join(userDataDir, 'SingletonLock'));
    const match = /-(\d+)$/.exec(lockTarget);
    const lockPid = match ? Number(match[1]) : null;
    if (
      lockPid !== null &&
      Number.isInteger(lockPid) &&
      lockPid !== selfPid &&
      !pids.includes(lockPid) &&
      deps.isPidAlive(lockPid)
    ) {
      pids.push(lockPid);
    }
  } catch {
    // ENOENT(无 packaged 实例)/EINVAL(非 symlink,如 win32 lockfile)——无信号。
  }
  return pids;
}

/**
 * Claim pre-namespace private data for the first verified cloud owner.
 * Local/signed-out sessions return before resolving or probing userData.
 *
 * The claim renames files out of the shared legacy root, which breaks any
 * concurrently running pre-namespace build reading those paths (2026-07-23
 * incident: a passive dev instance migrated slack-hook.json etc. from under
 * a live older main). Two guards therefore defer — never cancel — the claim:
 * passive shared-userData instances must stay read-only, and any instance
 * must hold the userData exclusively before moving files. Deferral is safe:
 * every consumer of hasLegacyOwnerNamespaceClaim fails closed (legacy imports
 * simply wait), and the next exclusive startup completes the claim.
 */
export async function claimLegacyOwnerNamespace(
  state: MigrationSessionState,
  deps: MigrationDeps = productionDeps,
): Promise<OwnerNamespaceMigrationResult> {
  const ownerId = verifiedCloudOwner(state);
  if (!ownerId) return { status: 'skipped', moved: 0, conflicts: 0 };

  const userDataDir = deps.userDataDir();
  const ownerKey = dataOwnerStorageKey(ownerId);
  const markerPath = path.join(userDataDir, CLAIM_MARKER);
  const targetRoot = path.join(userDataDir, 'owners', ownerKey);

  // 已终态的 claim 直接回答,不进 guard:完成后的常规多开启动不该被报成 deferred,
  // 也犯不着每次扫实例注册表。guard 只挡在「确实还有搬动要做」的路径前。
  const existingMarker = await readMarker(deps, markerPath);
  if (existingMarker && existingMarker.ownerKey !== ownerKey) {
    return { status: 'claimed-by-other-owner', moved: 0, conflicts: 0 };
  }
  if (existingMarker?.complete) {
    return { status: 'migrated', moved: 0, conflicts: 0 };
  }

  if (deps.passiveSharedUserData()) {
    log.info('owner namespace claim deferred: passive shared-userData instance stays read-only');
    return {
      status: 'deferred',
      moved: 0,
      conflicts: 0,
      deferredReason: 'passive-shared-user-data',
    };
  }

  let concurrentPids: number[];
  try {
    concurrentPids = await findConcurrentLiveInstancePids(deps, userDataDir);
  } catch (error) {
    log.warn('owner namespace claim deferred: instance registry unreadable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      status: 'deferred',
      moved: 0,
      conflicts: 0,
      deferredReason: 'concurrent-live-instances',
    };
  }
  if (concurrentPids.length > 0) {
    log.info('owner namespace claim deferred: other live instances share this userData', {
      concurrentPids,
    });
    return {
      status: 'deferred',
      moved: 0,
      conflicts: 0,
      deferredReason: 'concurrent-live-instances',
    };
  }

  await deps.mkdir(userDataDir);
  let marker = existingMarker;
  if (!marker) {
    marker = { version: 1, ownerKey, complete: false };
    try {
      await deps.writeFileExclusive(markerPath, JSON.stringify(marker));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      marker = await readMarker(deps, markerPath);
      if (!marker) throw new Error('owner namespace claim marker disappeared');
    }
  }
  if (marker.ownerKey !== ownerKey) {
    return { status: 'claimed-by-other-owner', moved: 0, conflicts: 0 };
  }
  if (marker.complete) {
    return { status: 'migrated', moved: 0, conflicts: 0 };
  }

  let moved = 0;
  let conflicts = 0;
  let failed = false;
  // 合并式目录递归内的并发复查(节流 500ms):大目录(dialogues/cindy-brain 等)
  // 逐子项合并可能耗时,子项之间也要让窗口内新启动的实例被发现。
  let lastAbortScanMs = 0;
  const throttledAbortCheck = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastAbortScanMs < 500) return;
    lastAbortScanMs = now;
    let racedPids: number[];
    try {
      racedPids = await findConcurrentLiveInstancePids(deps, userDataDir);
    } catch (error) {
      // 与 per-path 扫描同一 fail-closed 语义:读不了注册表可能藏着活实例,
      // 包成中断信号让外层 break 整个搬迁,而不是当单 path 失败继续。
      throw new ClaimInterruptedError([], error);
    }
    if (racedPids.length > 0) throw new ClaimInterruptedError(racedPids);
  };
  for (const relativePath of LEGACY_PATHS) {
    try {
      const source = path.join(userDataDir, relativePath);
      if ((await pathType(deps, source)) === 'missing') continue;
      // 启动竞态收窄:初检与搬迁之间新实例可能已启动登记。每个仍存在的 path
      // 搬迁前重扫注册表,窗口内出现活实例就中断剩余搬迁(marker 保持未
      // complete,moveWithoutOverwrite 幂等,下次独占启动续跑)——把暴露窗口
      // 从全部搬迁总时长缩到单次 rename 的原子粒度。扫描失败按 fail closed
      // 同样中断。对不参与本协议的历史 build,窗口无法为零,这已是追溯下界。
      let racedPids: number[];
      try {
        racedPids = await findConcurrentLiveInstancePids(deps, userDataDir);
        lastAbortScanMs = Date.now(); // 刚扫过,递归首个子项不必立刻重扫
      } catch (error) {
        failed = true;
        log.warn('legacy owner path migration interrupted: registry unreadable mid-claim', {
          relativePath,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
      if (racedPids.length > 0) {
        failed = true;
        log.info('legacy owner path migration interrupted: instance started mid-claim', {
          relativePath,
          racedPids,
        });
        break;
      }
      const result = await moveWithoutOverwrite(
        deps,
        source,
        path.join(targetRoot, relativePath),
        throttledAbortCheck,
      );
      moved += result.moved;
      conflicts += result.conflicts;
    } catch (error) {
      failed = true;
      if (error instanceof ClaimInterruptedError) {
        log.info('legacy owner path migration interrupted mid-directory-merge', {
          relativePath,
          racedPids: error.racedPids,
          ...(error.cause
            ? {
                registryError:
                  error.cause instanceof Error ? error.cause.message : String(error.cause),
              }
            : {}),
        });
        break;
      }
      log.warn('legacy owner path migration failed', {
        relativePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!failed) {
    // 写 complete 前的最后一次独占确认:全部 path 都 missing 的空 claim 不经过
    // 任何 mid-claim 检查,而 complete 一旦写下,legacy 导入 gate 即视为可放行
    // ——这里是最后的闸口。发现并发(或扫描失败,fail closed)就保持未 complete,
    // 下次独占启动重新确认后再完成。
    try {
      const finalPids = await findConcurrentLiveInstancePids(deps, userDataDir);
      if (finalPids.length > 0) {
        failed = true;
        log.info('owner namespace claim left incomplete: instance registered before completion', {
          finalPids,
        });
      }
    } catch (error) {
      failed = true;
      log.warn('owner namespace claim left incomplete: registry unreadable at completion', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (!failed) {
    await deps.writeFile(markerPath, JSON.stringify({ ...marker, complete: true }));
  }
  log.info('legacy owner namespace claim completed', {
    ownerKey,
    moved,
    conflicts,
    failed,
  });
  return { status: failed ? 'partial' : 'migrated', moved, conflicts };
}

export const __testing = {
  CLAIM_MARKER,
  LEGACY_PATHS,
  isSameUserDataDir,
  pathExistsNoFollowSync,
  resetLegacyGhostRecoveryState: () => legacyGhostMigrationResults.clear(),
};
