import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { dataOwnerStorageKey, type AppSessionMode } from './appSessionState.js';
import { createLogger } from './logger.js';
import {
  GHOST_MANIFEST_FILE,
  isOfficialGhostId,
  isValidGhostId,
  validateGhostManifest,
} from '../shared/ghost.js';
import {
  NO_LEGACY_GHOST_RECOVERY,
  type LegacyGhostRecoveryStatus,
} from '../shared/legacyGhostRecovery.js';

const CLAIM_MARKER = '.owner-namespace-claim-v1.json';
const LEGACY_GHOST_RECOVERY_MARKER = '.legacy-ghost-recovery-v1.json';
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

interface LegacyGhostRecoveryMarker {
  version: 1;
  ownerKey: string;
  pendingIds: string[];
  /** Deterministic content failures remain inside the frozen id whitelist. */
  failedIds?: string[];
}

type LegacyGhostRecoveryMarkerRead =
  | { kind: 'ready'; marker: LegacyGhostRecoveryMarker }
  | { kind: 'missing' }
  | { kind: 'deferred' }
  | { kind: 'invalid' };

interface MigrationDeps {
  userDataDir(): string;
  readFile(file: string): Promise<string>;
  writeFileExclusive(file: string, text: string): Promise<void>;
  writeFile(file: string, text: string): Promise<void>;
  lstat(file: string): Promise<{
    isDirectory(): boolean;
    isFile?: () => boolean;
    isSymbolicLink?: () => boolean;
  }>;
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
  | 'concurrent-live-instances'
  | 'legacy-discovery-incomplete';

export interface OwnerNamespaceMigrationResult {
  status: 'skipped' | 'deferred' | 'claimed-by-other-owner' | 'migrated' | 'partial';
  moved: number;
  conflicts: number;
  provisioningStateMoved?: boolean;
  deferredReason?: OwnerNamespaceClaimDeferredReason;
  /** Ghost directories moved before approval backfill; durable across restart. */
  recoveredIds?: string[];
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

async function readLegacyGhostRecoveryMarker(
  deps: MigrationDeps,
  markerPath: string,
): Promise<LegacyGhostRecoveryMarkerRead> {
  let text: string;
  try {
    text = await deps.readFile(markerPath);
  } catch (error) {
    return isMissing(error) ? { kind: 'missing' } : { kind: 'deferred' };
  }
  try {
    const parsed = JSON.parse(text) as Partial<LegacyGhostRecoveryMarker>;
    const failedIds = parsed.failedIds ?? [];
    if (
      parsed.version === 1 &&
      typeof parsed.ownerKey === 'string' &&
      Array.isArray(parsed.pendingIds) &&
      parsed.pendingIds.every((id) => typeof id === 'string' && isValidGhostId(id)) &&
      Array.isArray(failedIds) &&
      failedIds.every((id) => typeof id === 'string' && isValidGhostId(id)) &&
      failedIds.every((id) => parsed.pendingIds?.includes(id))
    ) {
      const marker: LegacyGhostRecoveryMarker = {
        version: 1,
        ownerKey: parsed.ownerKey,
        pendingIds: [...new Set(parsed.pendingIds)],
        ...(failedIds.length > 0 ? { failedIds: [...new Set(failedIds)] } : {}),
      };
      return { kind: 'ready', marker };
    }
    return { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

async function writeLegacyGhostRecoveryMarker(
  deps: MigrationDeps,
  markerPath: string,
  marker: LegacyGhostRecoveryMarker,
): Promise<void> {
  await writeJsonAtomically(deps, markerPath, marker);
}

async function writeJsonAtomically(
  deps: MigrationDeps,
  targetPath: string,
  value: unknown,
): Promise<void> {
  const tempPath = `${targetPath}.${randomUUID()}.tmp`;
  await deps.writeFile(tempPath, JSON.stringify(value));
  await deps.rename(tempPath, targetPath);
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
  if (process.env.XDT_PASSIVE_SHARED_USER_DATA === '1') return false;
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
  return !hasConcurrentLiveInstanceSync(userDataDir, isPidAlive);
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

interface LegacyGhostDir {
  root: string;
  id: string;
  dir: string;
  command: string | null;
  rootStats: fsSync.Stats;
  dirStats: fsSync.Stats;
  rootRealPath: string;
  dirRealPath: string;
}

interface LegacyGhostDiscovery {
  ghosts: LegacyGhostDir[];
  deferredRoots: string[];
  deferredIds: string[];
  invalidIds: string[];
}

type LegacyGhostManifestRead =
  | { kind: 'ready'; command: string | null }
  | { kind: 'deferred' }
  | { kind: 'invalid' };

function sameLegacyDirectoryIdentity(expected: fsSync.Stats, current: fsSync.Stats): boolean {
  if (!current.isDirectory() || current.isSymbolicLink()) return false;
  if (expected.dev !== 0 || expected.ino !== 0 || current.dev !== 0 || current.ino !== 0) {
    return expected.dev === current.dev && expected.ino === current.ino;
  }
  return expected.birthtimeMs === current.birthtimeMs && expected.ctimeMs === current.ctimeMs;
}

function sameLegacyCanonicalPath(left: string, right: string): boolean {
  const fold = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  return fold(path.resolve(left)) === fold(path.resolve(right));
}

function isLegacyPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !path.isAbsolute(relative) &&
    relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function readLegacyGhostManifest(
  dir: string,
  expectedId: string,
): LegacyGhostManifestRead {
  let text: string;
  try {
    text = fsSync.readFileSync(path.join(dir, GHOST_MANIFEST_FILE), 'utf-8');
  } catch (error) {
    return isMissing(error) ? { kind: 'invalid' } : { kind: 'deferred' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'invalid' };
  }
  const parsed = validateGhostManifest(raw);
  if (!parsed.ok || parsed.manifest.id !== expectedId) return { kind: 'invalid' };
  return { kind: 'ready', command: parsed.manifest.command ?? null };
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

const OWNER_STORAGE_KEY_RE = /^[a-f0-9]{20}$/;

/** All legacy/content and approval projection roots that must be revoked at an owner boundary. */
export function listLegacyOwnerProjectionRoots(userDataDir: string): string[] {
  const ownersRoot = path.join(userDataDir, 'owners');
  const roots = [
    ...sharedLegacyGhostRootDirs(userDataDir),
  ];
  let entries: fsSync.Dirent[];
  try {
    entries = fsSync.readdirSync(ownersRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return roots;
    throw error;
  }
  for (const entry of entries) {
    if (!OWNER_STORAGE_KEY_RE.test(entry.name)) continue;
    const ownerRoot = path.join(ownersRoot, entry.name);
    let ownerStat: fsSync.Stats;
    try {
      // Dirent.d_type is not authoritative on network/special filesystems. A
      // missed owner directory would bypass the next account-boundary retry.
      ownerStat = fsSync.lstatSync(ownerRoot);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (!ownerStat.isDirectory() || ownerStat.isSymbolicLink()) {
      throw new Error(`owner projection namespace is not a regular directory: ${ownerRoot}`);
    }
    roots.push(
      path.join(ownerRoot, 'brain'),
      path.join(ownerRoot, 'cindy-brain'),
      path.join(ownerRoot, 'ghost-install-state'),
    );
  }
  return roots;
}

function scanLegacyGhostDirsInRoots(
  roots: string[],
): LegacyGhostDiscovery {
  const result: LegacyGhostDiscovery = {
    ghosts: [],
    deferredRoots: [],
    deferredIds: [],
    invalidIds: [],
  };
  for (const root of roots) {
    let rootStats: fsSync.Stats;
    let rootRealPath: string;
    try {
      rootStats = fsSync.lstatSync(root);
      if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        result.invalidIds.push(root);
        continue;
      }
      rootRealPath = fsSync.realpathSync.native(root);
    } catch (error) {
      if (!isMissing(error)) result.deferredRoots.push(root);
      continue;
    }
    let entries: fsSync.Dirent[];
    try {
      entries = fsSync.readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if (!isMissing(error)) result.deferredRoots.push(root);
      continue;
    }
    try {
      const rootAfterRead = fsSync.lstatSync(root);
      const rootRealAfterRead = fsSync.realpathSync.native(root);
      if (!sameLegacyDirectoryIdentity(rootStats, rootAfterRead) ||
          !sameLegacyCanonicalPath(rootRealPath, rootRealAfterRead)) {
        result.deferredRoots.push(root);
        continue;
      }
    } catch {
      result.deferredRoots.push(root);
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const dir = path.join(root, entry.name);
      let dirStats: fsSync.Stats;
      try {
        dirStats = fsSync.lstatSync(dir);
      } catch (error) {
        if (!isMissing(error)) result.deferredIds.push(entry.name);
        continue;
      }
      if (!dirStats.isDirectory() || dirStats.isSymbolicLink()) {
        result.invalidIds.push(entry.name);
        continue;
      }
      let dirRealPath: string;
      try {
        dirRealPath = fsSync.realpathSync.native(dir);
        if (!isLegacyPathInside(rootRealPath, dirRealPath)) {
          result.invalidIds.push(entry.name);
          continue;
        }
      } catch (error) {
        if (!isMissing(error)) result.deferredIds.push(entry.name);
        continue;
      }
      const manifest = readLegacyGhostManifest(dir, entry.name);
      if (manifest.kind === 'deferred') {
        result.deferredIds.push(entry.name);
      } else if (manifest.kind === 'invalid') {
        result.invalidIds.push(entry.name);
      } else {
        try {
          const rootAfterManifest = fsSync.lstatSync(root);
          const dirAfterManifest = fsSync.lstatSync(dir);
          const rootRealAfterManifest = fsSync.realpathSync.native(root);
          const dirRealAfterManifest = fsSync.realpathSync.native(dir);
          if (!sameLegacyDirectoryIdentity(rootStats, rootAfterManifest) ||
              !sameLegacyDirectoryIdentity(dirStats, dirAfterManifest) ||
              !sameLegacyCanonicalPath(rootRealPath, rootRealAfterManifest) ||
              !sameLegacyCanonicalPath(dirRealPath, dirRealAfterManifest) ||
              !isLegacyPathInside(rootRealAfterManifest, dirRealAfterManifest)) {
            result.deferredIds.push(entry.name);
            continue;
          }
        } catch {
          result.deferredIds.push(entry.name);
          continue;
        }
        result.ghosts.push({
          root,
          id: entry.name,
          dir,
          command: manifest.command,
          rootStats,
          dirStats,
          rootRealPath,
          dirRealPath,
        });
      }
    }
  }
  return result;
}

function listLegacyGhostDirsInRoots(roots: string[]): LegacyGhostDir[] {
  return scanLegacyGhostDirsInRoots(roots).ghosts;
}

function hasStableLegacyGhostSourceSync(legacy: LegacyGhostDir): boolean {
  try {
    const currentRoot = fsSync.lstatSync(legacy.root);
    const currentDir = fsSync.lstatSync(legacy.dir);
    const currentRootReal = fsSync.realpathSync.native(legacy.root);
    const currentDirReal = fsSync.realpathSync.native(legacy.dir);
    return sameLegacyDirectoryIdentity(legacy.rootStats, currentRoot) &&
      sameLegacyDirectoryIdentity(legacy.dirStats, currentDir) &&
      sameLegacyCanonicalPath(legacy.rootRealPath, currentRootReal) &&
      sameLegacyCanonicalPath(legacy.dirRealPath, currentDirReal) &&
      isLegacyPathInside(currentRootReal, currentDirReal);
  } catch {
    return false;
  }
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
  const sharedDiscovery = scanLegacyGhostDirsInRoots(sharedLegacyGhostRootDirs(userDataDir));
  const scopedDiscovery = scanLegacyGhostDirsInRoots([
    ownerScopedLegacyGhostRootDir(userDataDir, ownerKey),
  ]);
  if (
    sharedDiscovery.deferredRoots.length > 0 ||
    sharedDiscovery.deferredIds.length > 0 ||
    scopedDiscovery.deferredRoots.length > 0 ||
    scopedDiscovery.deferredIds.length > 0
  ) {
    return [];
  }
  const sharedLegacyGhosts = sharedDiscovery.ghosts;
  const scopedLegacyGhosts = scopedDiscovery.ghosts;
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
  options: { reservedCommands?: ReadonlySet<string> } = {},
  isPidAlive: (pid: number) => boolean = isPidAliveDefault,
): LegacyGhostRecoveryStatus {
  if (boundaryPending || session.mode !== 'cloud' || !session.dataOwnerId || !session.user) {
    return NO_LEGACY_GHOST_RECOVERY;
  }
  if (session.user.id !== session.dataOwnerId) return NO_LEGACY_GHOST_RECOVERY;

  const root = userDataDir ?? app.getPath('userData');
  const ownerKey = dataOwnerStorageKey(session.dataOwnerId);
  const sharedDiscovery = scanLegacyGhostDirsInRoots(sharedLegacyGhostRootDirs(root));
  const scopedDiscovery = scanLegacyGhostDirsInRoots([
    ownerScopedLegacyGhostRootDir(root, ownerKey),
  ]);
  const targetRoot = path.join(root, 'owners', ownerKey, 'cindy-brain');
  const targetDiscovery = scanLegacyGhostDirsInRoots([targetRoot]);
  const sharedLegacyGhosts = sharedDiscovery.ghosts;
  const scopedLegacyGhosts = scopedDiscovery.ghosts;
  const legacyGhosts = [...sharedLegacyGhosts, ...scopedLegacyGhosts];
  const recoveryMarkerRead = readLegacyGhostRecoveryMarkerSync(root, ownerKey);
  const recoveryMarker = recoveryMarkerRead.kind === 'ready'
    ? recoveryMarkerRead.marker
    : null;
  const sourceDiscoveryProblemIds = new Set([
    ...sharedDiscovery.deferredIds,
    ...sharedDiscovery.invalidIds,
    ...scopedDiscovery.deferredIds,
    ...scopedDiscovery.invalidIds,
  ]);
  const targetInvalidIds = new Set(
    targetDiscovery.invalidIds.filter((id) => recoveryMarker?.pendingIds.includes(id)),
  );
  const discoveryDeferred =
    sharedDiscovery.deferredRoots.length > 0 ||
    sharedDiscovery.deferredIds.length > 0 ||
    scopedDiscovery.deferredRoots.length > 0 ||
    scopedDiscovery.deferredIds.length > 0 ||
    targetDiscovery.deferredRoots.length > 0 ||
    targetDiscovery.deferredIds.length > 0;
  const discoveryHasInvalid =
    sourceDiscoveryProblemIds.size > 0 || targetDiscovery.invalidIds.length > 0;
  const installedTargetIds = new Set(targetDiscovery.ghosts.map((ghost) => ghost.id));
  const legacySourceIds = new Set(legacyGhosts.map((ghost) => ghost.id));
  const knownDiscoveryIds = new Set([
    ...legacySourceIds,
    ...sourceDiscoveryProblemIds,
    ...targetInvalidIds,
    ...(recoveryMarker?.pendingIds ?? []),
  ]);
  const deferredRootCount =
    sharedDiscovery.deferredRoots.length +
    scopedDiscovery.deferredRoots.length +
    targetDiscovery.deferredRoots.length;
  const knownDiscoveryCount = knownDiscoveryIds.size + deferredRootCount;
  if (recoveryMarkerRead.kind === 'invalid') {
    return {
      state: 'partial',
      legacyPluginCount: Math.max(1, knownDiscoveryCount),
      canRetry: false,
    };
  }
  if (recoveryMarkerRead.kind === 'deferred' || discoveryDeferred) {
    return {
      state: 'deferred',
      legacyPluginCount: Math.max(1, knownDiscoveryCount),
      canRetry: process.env.XDT_PASSIVE_SHARED_USER_DATA !== '1',
      deferredReason: 'legacy-discovery-incomplete',
    };
  }
  const recoveredIds = (recoveryMarker?.pendingIds ?? []).filter(
    (id) => installedTargetIds.has(id) && !legacySourceIds.has(id),
  );
  const unexpectedFrozenIds = recoveryMarker
    ? legacyGhosts.map((ghost) => ghost.id).filter((id) => !recoveryMarker.pendingIds.includes(id))
    : [];
  const legacyPluginCount = new Set([
    ...legacyGhosts.map((ghost) => ghost.id),
    ...sourceDiscoveryProblemIds,
    ...targetInvalidIds,
    ...recoveredIds,
    ...(recoveryMarker?.pendingIds ?? []),
  ]).size;
  if (discoveryHasInvalid && targetDiscovery.invalidIds.length > 0) {
    return { state: 'partial', legacyPluginCount: Math.max(1, legacyPluginCount), canRetry: false };
  }
  if (legacyPluginCount === 0) return NO_LEGACY_GHOST_RECOVERY;
  if (process.env.XDT_PASSIVE_SHARED_USER_DATA === '1') {
    return { state: 'deferred', legacyPluginCount, canRetry: false };
  }

  if (recoveredIds.length > 0) {
    if (hasConcurrentLiveInstanceSync(root, isPidAlive)) {
      return { state: 'deferred', legacyPluginCount, canRetry: false };
    }
    return { state: 'partial', legacyPluginCount, canRetry: true };
  }
  if (unexpectedFrozenIds.length > 0) {
    return { state: 'partial', legacyPluginCount, canRetry: false };
  }

  if (discoveryHasInvalid && legacyGhosts.length === 0) {
    return { state: 'partial', legacyPluginCount, canRetry: false };
  }
  const markerRead = readMarkerSync(root);
  const sharedRecoveryBlocked =
    sharedLegacyGhosts.length > 0 &&
    (markerRead.invalid ||
      (markerRead.marker !== null && markerRead.marker.ownerKey !== ownerKey));
  if (sharedRecoveryBlocked && scopedLegacyGhosts.length === 0) {
    if (markerRead.marker && markerRead.marker.ownerKey !== ownerKey) {
      return { state: 'claimed-by-other-owner', legacyPluginCount, canRetry: false };
    }
    return { state: 'partial', legacyPluginCount, canRetry: false };
  }
  if (hasConcurrentLiveInstanceSync(root, isPidAlive)) {
    return { state: 'deferred', legacyPluginCount, canRetry: false };
  }

  const eligibleLegacyGhosts = (sharedRecoveryBlocked ? scopedLegacyGhosts : legacyGhosts)
    .filter((ghost) => !recoveryMarker || recoveryMarker.pendingIds.includes(ghost.id));
  if (!hasSafeRecoveryTargetChainSync(root, targetRoot)) {
    return { state: 'partial', legacyPluginCount, canRetry: false };
  }
  const occupiedCommands = new Set(
    targetDiscovery.ghosts
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
    if (
      sharedRecoveryBlocked &&
      markerRead.marker &&
      markerRead.marker.ownerKey !== ownerKey &&
      scopedLegacyGhosts.length === 0
    ) {
      return { state: 'claimed-by-other-owner', legacyPluginCount, canRetry: false };
    }
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
  const recoveryMarkerPath = path.join(
    userDataDir,
    'owners',
    ownerKey,
    LEGACY_GHOST_RECOVERY_MARKER,
  );
  const sharedDiscovery = scanLegacyGhostDirsInRoots(sharedLegacyGhostRootDirs(userDataDir));
  const scopedDiscovery = scanLegacyGhostDirsInRoots([
    ownerScopedLegacyGhostRootDir(userDataDir, ownerKey),
  ]);
  const targetRoot = path.join(userDataDir, 'owners', ownerKey, 'cindy-brain');
  const targetDiscovery = scanLegacyGhostDirsInRoots([targetRoot]);
  const sharedLegacyGhosts = sharedDiscovery.ghosts;
  const scopedLegacyGhosts = scopedDiscovery.ghosts;
  const discoveryDeferred =
    sharedDiscovery.deferredRoots.length > 0 ||
    sharedDiscovery.deferredIds.length > 0 ||
    scopedDiscovery.deferredRoots.length > 0 ||
    scopedDiscovery.deferredIds.length > 0 ||
    targetDiscovery.deferredRoots.length > 0 ||
    targetDiscovery.deferredIds.length > 0;
  const discoveryInvalidCount = new Set([
    ...sharedDiscovery.invalidIds,
    ...scopedDiscovery.invalidIds,
  ]).size;
  if (discoveryDeferred) {
    const result: OwnerNamespaceMigrationResult = {
      status: 'deferred',
      moved: 0,
      conflicts: discoveryInvalidCount,
      deferredReason: 'legacy-discovery-incomplete',
    };
    recordLegacyGhostMigrationResult(ownerId, result, userDataDir);
    return result;
  }
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
  const recoveryMarkerRead = await readLegacyGhostRecoveryMarker(deps, recoveryMarkerPath);
  if (recoveryMarkerRead.kind === 'deferred') {
    log.warn('legacy ghost recovery deferred: durable recovery marker temporarily unreadable');
    const result: OwnerNamespaceMigrationResult = {
      status: 'deferred',
      moved: 0,
      conflicts: 0,
      deferredReason: 'legacy-discovery-incomplete',
    };
    recordLegacyGhostMigrationResult(ownerId, result, userDataDir);
    return result;
  }
  if (recoveryMarkerRead.kind === 'invalid') {
    log.warn('legacy ghost recovery blocked: durable recovery marker is invalid');
    const result: OwnerNamespaceMigrationResult = {
      status: 'partial',
      moved: 0,
      conflicts: sharedLegacyGhosts.length + scopedLegacyGhosts.length,
    };
    recordLegacyGhostMigrationResult(ownerId, result, userDataDir);
    return result;
  }
  const recoveryMarker = recoveryMarkerRead.kind === 'ready'
    ? recoveryMarkerRead.marker
    : null;
  let recoveryMarkerPersisted = recoveryMarker !== null;
  if (recoveryMarker && recoveryMarker.ownerKey !== ownerKey) {
    log.warn('legacy ghost recovery blocked: durable recovery marker owner mismatch', {
      expectedOwnerKey: ownerKey,
      actualOwnerKey: recoveryMarker.ownerKey,
    });
    const result: OwnerNamespaceMigrationResult = {
      status: 'partial',
      moved: 0,
      conflicts: sharedLegacyGhosts.length + scopedLegacyGhosts.length,
    };
    recordLegacyGhostMigrationResult(ownerId, result, userDataDir);
    return result;
  }
  const sourceDiscoveryIds = new Set([
    ...sharedLegacyGhosts.map((ghost) => ghost.id),
    ...scopedLegacyGhosts.map((ghost) => ghost.id),
    ...[...sharedDiscovery.invalidIds, ...scopedDiscovery.invalidIds]
      .filter((id) => isValidGhostId(id)),
  ]);
  const targetDiscoveryIds = new Set(targetDiscovery.ghosts.map((ghost) => ghost.id));
  const pendingRecoveryIds = new Set(recoveryMarker?.pendingIds ?? sourceDiscoveryIds);
  const failedRecoveryIds = new Set(
    recoveryMarker?.failedIds ??
      [...sourceDiscoveryIds].filter((id) =>
        [...sharedDiscovery.invalidIds, ...scopedDiscovery.invalidIds].includes(id),
      ),
  );
  for (const id of [...sharedDiscovery.invalidIds, ...scopedDiscovery.invalidIds]) {
    if (isValidGhostId(id) && pendingRecoveryIds.has(id)) failedRecoveryIds.add(id);
  }
  const movedThisRun = new Set<string>();
  const recoveredTargetIds = (): string[] => [...pendingRecoveryIds]
    .filter((id) => movedThisRun.has(id) || (targetDiscoveryIds.has(id) && !sourceDiscoveryIds.has(id)))
    .sort();
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
  let movableLegacyGhosts: ReturnType<typeof listLegacyGhostDirs> = [];
  const unexpectedFrozenIds = recoveryMarker
    ? [...sourceDiscoveryIds].filter((id) => !pendingRecoveryIds.has(id))
    : [];
  let conflicts = (sharedRecoveryBlocked ? sharedLegacyGhosts.length : 0) +
    discoveryInvalidCount + unexpectedFrozenIds.length;
  const movableById = new Map<string, ReturnType<typeof listLegacyGhostDirs>>();
  for (const legacy of [...eligibleSharedGhosts, ...scopedLegacyGhosts]) {
    if (recoveryMarker && !pendingRecoveryIds.has(legacy.id)) {
      continue;
    }
    if (failedRecoveryIds.has(legacy.id)) {
      // A formerly invalid id may be retried after its manifest is repaired,
      // but it remains inside the original frozen whitelist.
      failedRecoveryIds.delete(legacy.id);
    }
    if (options.rejectReservedIds && isOfficialGhostId(legacy.id)) {
      conflicts += 1;
      continue;
    }
    if ((await pathType(deps, path.join(targetRoot, legacy.id))) === 'missing') {
      const siblings = movableById.get(legacy.id) ?? [];
      siblings.push(legacy);
      movableById.set(legacy.id, siblings);
    } else {
      conflicts += 1;
    }
  }
  for (const siblings of movableById.values()) {
    if (siblings.length === 1) {
      movableLegacyGhosts.push(siblings[0]);
    } else {
      // Same id in multiple legacy roots is ambiguous legacy state. Do not
      // move one copy and leave the other behind: that would create a target
      // which can never be safely backfilled or retried.
      conflicts += siblings.length;
    }
  }
  const activePendingIds = new Set([
    ...pendingRecoveryIds,
  ].filter((id) => sourceDiscoveryIds.has(id) || recoveredTargetIds().includes(id)));
  if (activePendingIds.size > 0) {
    movableLegacyGhosts = movableLegacyGhosts.filter((legacy) =>
      activePendingIds.has(legacy.id),
    );
  }
  if (movableLegacyGhosts.length === 0) {
    const recoveredIds = recoveredTargetIds();
    const result: OwnerNamespaceMigrationResult = {
      status: conflicts > 0 || recoveredIds.length > 0 ? 'partial' : 'skipped',
      moved: 0,
      conflicts,
      ...(recoveredIds.length > 0 ? { recoveredIds } : {}),
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

  // Freeze the recovery whitelist only after passive/concurrent ownership has
  // been ruled out. A deferred instance must not write durable recovery state.
  if (!recoveryMarkerPersisted && pendingRecoveryIds.size > 0 && !sharedRecoveryBlocked) {
    await deps.mkdir(path.dirname(recoveryMarkerPath));
    await writeLegacyGhostRecoveryMarker(deps, recoveryMarkerPath, {
      version: 1,
      ownerKey,
      pendingIds: [...pendingRecoveryIds].sort(),
      ...(failedRecoveryIds.size > 0 ? { failedIds: [...failedRecoveryIds].sort() } : {}),
    });
    recoveryMarkerPersisted = true;
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
    const recoveredIds = recoveredTargetIds();
    const result: OwnerNamespaceMigrationResult = {
      status: conflicts > 0 || recoveredIds.length > 0 ? 'partial' : 'skipped',
      moved: 0,
      conflicts,
      ...(recoveredIds.length > 0 ? { recoveredIds } : {}),
    };
    recordLegacyGhostMigrationResult(ownerId, result, userDataDir);
    return result;
  }
  const occupiedCommands = new Set(
    targetDiscovery.ghosts
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
    const recoveredIds = recoveredTargetIds();
    const result: OwnerNamespaceMigrationResult = {
      status: conflicts > 0 || recoveredIds.length > 0 ? 'partial' : 'skipped',
      moved: 0,
      conflicts,
      ...(recoveredIds.length > 0 ? { recoveredIds } : {}),
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
  if (pendingRecoveryIds.size > 0) {
    if (!hasSafeRecoveryTargetChainSync(userDataDir, targetRoot)) {
      const result: OwnerNamespaceMigrationResult = {
        status: 'partial',
        moved: 0,
        conflicts: conflicts + movableLegacyGhosts.length,
      };
      recordLegacyGhostMigrationResult(ownerId, result, userDataDir);
      return result;
    }
    await deps.mkdir(path.dirname(recoveryMarkerPath));
    const nextRecoveryMarker: LegacyGhostRecoveryMarker = {
      version: 1,
      ownerKey,
      pendingIds: [...pendingRecoveryIds].sort(),
      ...(failedRecoveryIds.size > 0 ? { failedIds: [...failedRecoveryIds].sort() } : {}),
    };
    await writeLegacyGhostRecoveryMarker(deps, recoveryMarkerPath, nextRecoveryMarker);
    recoveryMarkerPersisted = true;
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
    if (!hasStableLegacyGhostSourceSync(legacy)) {
      failed = true;
      conflicts += 1;
      log.warn('legacy ghost recovery refused source whose root or directory changed', {
        id: legacy.id,
      });
      continue;
    }
    try {
      await deps.rename(legacy.dir, target);
      moved += 1;
      movedThisRun.add(legacy.id);
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
  const recoveredIds = recoveredTargetIds();
  const result: OwnerNamespaceMigrationResult = {
    status: failed || conflicts > 0 ? 'partial' : 'migrated',
    moved,
    conflicts,
    ...(provisioningStateMoved ? { provisioningStateMoved: true } : {}),
    ...(concurrentRecoveryInterrupted
      ? { deferredReason: 'concurrent-live-instances' as const }
      : {}),
    ...(recoveredIds.length > 0 ? { recoveredIds } : {}),
  };
  recordLegacyGhostMigrationResult(ownerId, result, userDataDir);
  return result;
}

function readLegacyGhostRecoveryMarkerSync(
  userDataDir: string,
  ownerKey: string,
): LegacyGhostRecoveryMarkerRead {
  let text: string;
  try {
    text = fsSync.readFileSync(
      path.join(
        userDataDir,
        'owners',
        ownerKey,
        LEGACY_GHOST_RECOVERY_MARKER,
      ),
      'utf-8',
    );
  } catch (error) {
    return isMissing(error) ? { kind: 'missing' } : { kind: 'deferred' };
  }
  try {
    const parsed = JSON.parse(text) as Partial<LegacyGhostRecoveryMarker>;
    const failedIds = parsed.failedIds ?? [];
    if (
      parsed.version === 1 &&
      parsed.ownerKey === ownerKey &&
      Array.isArray(parsed.pendingIds) &&
      parsed.pendingIds.every((id) => typeof id === 'string' && isValidGhostId(id)) &&
      Array.isArray(failedIds) &&
      failedIds.every((id) => typeof id === 'string' && isValidGhostId(id)) &&
      failedIds.every((id) => parsed.pendingIds?.includes(id))
    ) {
      return { kind: 'ready', marker: {
          version: 1,
          ownerKey,
          pendingIds: [...new Set(parsed.pendingIds)],
          ...(failedIds.length > 0 ? { failedIds: [...new Set(failedIds)] } : {}),
        } };
    }
    return { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

/**
 * Acknowledge only Ghost ids whose approval backfill finished. Keeping the
 * marker until this point closes the rename -> receipt crash window.
 */
export async function acknowledgeRecoveredLegacyGhosts(
  ownerId: string,
  ids: readonly string[],
  deps: MigrationDeps = productionDeps,
): Promise<void> {
  if (ids.length === 0) return;
  const ownerKey = dataOwnerStorageKey(ownerId);
  const markerPath = path.join(
    deps.userDataDir(),
    'owners',
    ownerKey,
    LEGACY_GHOST_RECOVERY_MARKER,
  );
  const markerRead = await readLegacyGhostRecoveryMarker(deps, markerPath);
  if (markerRead.kind === 'missing') return;
  if (markerRead.kind === 'deferred') {
    throw new Error('legacy ghost recovery marker temporarily unreadable');
  }
  if (markerRead.kind === 'invalid') {
    throw new Error('invalid legacy ghost recovery marker');
  }
  const marker = markerRead.marker;
  if (marker.ownerKey !== ownerKey) {
    throw new Error('legacy ghost recovery marker owner mismatch');
  }
  const acknowledged = new Set(ids);
  const pendingIds = marker.pendingIds.filter((id) => !acknowledged.has(id));
  if (pendingIds.length === marker.pendingIds.length) return;
  await writeLegacyGhostRecoveryMarker(deps, markerPath, {
    version: 1,
    ownerKey,
    pendingIds,
    ...(marker.failedIds?.length
      ? { failedIds: marker.failedIds.filter((id) => !acknowledged.has(id)) }
      : {}),
  });
}

async function pathType(
  deps: MigrationDeps,
  file: string,
): Promise<'missing' | 'directory' | 'file' | 'link' | 'other'> {
  try {
    const stat = await deps.lstat(file);
    if (stat.isSymbolicLink?.()) return 'link';
    if (stat.isDirectory()) return 'directory';
    if (stat.isFile?.()) return 'file';
    return 'other';
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
  assertTargetChain?: () => void,
): Promise<{ moved: number; conflicts: number }> {
  const sourceType = await pathType(deps, source);
  if (sourceType === 'missing') return { moved: 0, conflicts: 0 };
  // Legacy links and special files are not migratable data.  Do not rename
  // them into the owner namespace where later consumers could follow them.
  if (sourceType === 'link' || sourceType === 'other') {
    return { moved: 0, conflicts: 1 };
  }

  const targetType = await pathType(deps, target);
  if (targetType === 'missing') {
    assertTargetChain?.();
    await deps.mkdir(path.dirname(target));
    assertTargetChain?.();
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
      assertTargetChain,
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
  if (!hasSafeRecoveryTargetChainSync(userDataDir, targetRoot)) {
    const existingLegacyPathCount = (
      await Promise.all(
        LEGACY_PATHS.map(async (relativePath) =>
          (await pathType(deps, path.join(userDataDir, relativePath))) !== 'missing',
        ),
      )
    ).filter(Boolean).length;
    const result: OwnerNamespaceMigrationResult = {
      status: 'partial',
      moved: 0,
      conflicts: existingLegacyPathCount,
    };
    recordLegacyGhostMigrationResult(ownerId, result, userDataDir);
    return result;
  }
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
        () => {
          if (!hasSafeRecoveryTargetChainSync(userDataDir, targetRoot)) {
            throw new Error('owner namespace claim target chain is not link-free');
          }
        },
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
    await writeJsonAtomically(deps, markerPath, { ...marker, complete: true });
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
  LEGACY_GHOST_RECOVERY_MARKER,
  LEGACY_PATHS,
  isSameUserDataDir,
  pathExistsNoFollowSync,
  resetLegacyGhostRecoveryState: () => legacyGhostMigrationResults.clear(),
};
