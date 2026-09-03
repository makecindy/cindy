/**
 * skillhub/autoSyncService.ts — product-curated SkillHub auto install/update.
 *
 * This service runs after auth is available. It quietly reconciles a small
 * product-owned whitelist against SkillHub, reusing the existing installer so
 * zip verification, registry writes, and global skill links stay centralized.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { app, net } from 'electron';
import { getCurrentUserId } from '../authManager';
import { ensureBaseUrl } from '../manifestService';
import { createLogger } from '../logger';
import * as installService from './installService';
import { SkillhubMarketService } from './marketService';
import { listIgnoredAutoSyncSkills, recordAutoSyncCandidateSkills } from './autoSyncPreferences';
import { registryService } from './registry';
import type { StoredInstall } from './registry/types';
import { skillhubCatalogKey, type SkillhubCatalogScope } from '../../shared/skillhubCatalog';

const log = createLogger('skillhub:autoSync');

/**
 * Product-owned SkillHub whitelist.
 *
 * Keep this list intentionally explicit. Add published SkillHub slugs here
 * when a release should auto-install / auto-update them for signed-in users.
 */
export const DEFAULT_SKILLHUB_AUTO_SYNC_SLUGS: readonly string[] = [];
const SKILLHUB_AUTO_SYNC_CONFIG_PATH = 'cfg/auto-sync-skills.json';
const CONFIG_FETCH_TIMEOUT_MS = 5_000;
const PENDING_CLEANUP_STORE_VERSION = 1;

type InstallFn = typeof installService.install;
type InstallResult = Awaited<ReturnType<InstallFn>>;

interface ListedInstall {
  skillName: string;
  installPath: string;
  entry: StoredInstall;
}

interface SyncResultItem {
  name: string;
  exists: boolean;
  latestVersion?: string;
  catalogScope?: SkillhubCatalogScope;
}

interface AutoSyncSkill {
  name: string;
  version?: string;
  /** Product config must identify the catalog that owns this slug. */
  catalogScope?: SkillhubCatalogScope;
}

interface AutoSyncConfigResult {
  skills: AutoSyncSkill[];
  usingFallbackConfig: boolean;
}

interface AutoSyncDeps {
  getCurrentUserId: () => string | null;
  fetchConfig: () => Promise<AutoSyncSkill[] | AutoSyncConfigResult>;
  listAllInstalls: () => Promise<ListedInstall[]>;
  syncMarket: (params: {
    skills?: Array<{ slug: string; catalogScope: SkillhubCatalogScope }>;
  }) => Promise<{ success: boolean; results?: SyncResultItem[]; error?: string }>;
  detectClaudeSkillConflict: (slug: string, expectedSharedPath: string) => Promise<ClaudeSkillConflict | null>;
  install: InstallFn;
  cancelInstall: (name: string) => boolean;
  listIgnoredSkills: (userId: string) => Promise<Set<string>>;
  recordCandidateSkills: (userId: string, names: string[], options?: { replace?: boolean }) => Promise<void>;
  cleanupInstall: (params: CancelledInstallCleanup) => Promise<void>;
  loadPendingCancellationCleanups: () => Promise<CancelledInstallCleanup[]>;
  savePendingCancellationCleanups: (cleanups: CancelledInstallCleanup[]) => Promise<void>;
  pathExists: (p: string) => Promise<boolean>;
}

interface CancelledInstallCleanup {
  slug: string;
  absolutePath: string;
  previousInstall?: ListedInstall;
  replacedBackupPath?: string;
}

interface ClaudeSkillConflict {
  path: string;
  reason: string;
}

/**
 * Runs a one-shot, best-effort reconciliation between the product whitelist
 * and the local SkillHub registry after a user is authenticated.
 */
export class SkillhubAutoSyncService {
  private completedUserId: string | null = null;
  private inFlight: Promise<void> | null = null;
  private inFlightUserId: string | null = null;
  private activeInstallSlug: string | null = null;
  private externalCancelRequested = false;
  private readonly pendingCancellationCleanups = new Map<string, CancelledInstallCleanup>();
  private pendingCancellationCleanupsLoaded = false;
  private readonly deps: AutoSyncDeps;

  constructor(deps?: Partial<AutoSyncDeps>) {
    const marketService = new SkillhubMarketService();
    this.deps = {
      getCurrentUserId,
      fetchConfig: fetchRemoteAutoSyncConfig,
      listAllInstalls: () => registryService.listAllInstalls(),
      syncMarket: (params) => marketService.sync(params),
      detectClaudeSkillConflict: detectClaudeGlobalSkillConflict,
      install: installService.install,
      cancelInstall: installService.cancelInstall,
      listIgnoredSkills: listIgnoredAutoSyncSkills,
      recordCandidateSkills: recordAutoSyncCandidateSkills,
      cleanupInstall: cleanupAutoSyncedGlobalInstall,
      loadPendingCancellationCleanups,
      savePendingCancellationCleanups,
      pathExists,
      ...deps,
    };
  }

  runOnceAfterLogin(): Promise<void> {
    const userId = this.deps.getCurrentUserId();
    if (!userId) return Promise.resolve();
    if (this.completedUserId === userId) return Promise.resolve();
    if (this.inFlight) {
      if (this.inFlightUserId === userId) return this.inFlight;
      return this.inFlight.finally(() => this.runOnceAfterLogin());
    }

    this.externalCancelRequested = false;
    this.inFlightUserId = userId;
    this.inFlight = this.run()
      .then(() => {
        this.completedUserId = userId;
      })
      .catch((err) => {
        log.warn('auto sync failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.inFlight = null;
        this.inFlightUserId = null;
      });
    return this.inFlight;
  }

  cancelInFlight(): void {
    this.externalCancelRequested = true;
    if (this.activeInstallSlug) {
      this.deps.cancelInstall(this.activeInstallSlug);
    }
  }

  private async run(): Promise<void> {
    const userId = this.deps.getCurrentUserId();
    if (!userId) return;

    await this.loadPendingCancellationCleanupsOnce();
    await this.retryPendingCancellationCleanups();

    const config = await this.deps.fetchConfig().then(normalizeAutoSyncConfigResult).catch((err) => {
      log.warn('fetch auto sync config failed, using fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { skills: defaultAutoSyncSkills(), usingFallbackConfig: true };
    });
    const { skills, usingFallbackConfig } = config;
    if (skills.length === 0) {
      await this.recordCandidateSkills(userId, [], { replace: !usingFallbackConfig });
      return;
    }
    const ignoredSkills = await this.deps.listIgnoredSkills(userId).catch((err) => {
      log.warn('read auto sync ignored skills failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    });
    await this.recordCandidateSkills(userId, skills.map((skill) => skill.name), { replace: !usingFallbackConfig });
    const enabledSkills = skills.filter((skill) => {
      if (!ignoredSkills.has(skill.name)) return true;
      log.info('auto sync skipped user-ignored skill', { slug: skill.name });
      return false;
    });
    if (enabledSkills.length === 0) return;
    const refs = enabledSkills.map((skill) => ({
      slug: skill.name,
      catalogScope: skill.catalogScope ?? ('market' as const),
    }));
    const slugs = refs.map(({ slug }) => slug);

    const localInstalls = await this.deps.listAllInstalls().catch((err) => {
      log.warn('list local installs failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    });
    const autoSyncSlugs = new Set(slugs);
    const relevantInstalls = buildRelevantInstallMap(localInstalls, refs, autoSyncSlugs);
    const blockedGlobalInstalls = buildBlockedGlobalInstallMap(localInstalls, autoSyncSlugs);

    const sync = await this.deps.syncMarket({ skills: refs }).catch((err) => {
      log.warn('market sync failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
    if (!sync?.success) {
      if (sync?.error) log.warn('market sync returned failure', { error: sync.error });
      throw new Error(sync?.error ?? 'market sync failed');
    }

    this.assertAuthUnchanged();

    const marketByName = new Map((sync.results ?? []).map((item) => [
      skillhubCatalogKey(item.name, item.catalogScope ?? 'market'),
      item,
    ]));
    const failedSlugs: string[] = [];
    for (const skill of enabledSkills) {
      const slug = skill.name;
      const catalogScope = skill.catalogScope ?? 'market';
      const local = relevantInstalls.get(skillhubCatalogKey(slug, catalogScope));
      let localInstallPathExists = false;
      if (!local) {
        const blocked = blockedGlobalInstalls.get(slug);
        if (blocked) {
          if (await this.deps.pathExists(blocked.installPath)) {
            log.warn('auto sync skipped user-owned global skill', {
              slug,
              origin: blocked.entry.origin,
            });
            continue;
          }
          log.warn('user-owned global skill registry entry is missing on disk', {
            slug,
            origin: blocked.entry.origin,
            installPath: blocked.installPath,
          });
        }
      }
      if (local) {
        localInstallPathExists = await this.deps.pathExists(local.installPath);
      }

      const market = marketByName.get(skillhubCatalogKey(slug, catalogScope));
      const targetVersion = skill.version ?? market?.latestVersion;
      if (!market?.exists || !targetVersion) {
        log.warn('whitelisted skill is unavailable in SkillHub', { slug });
        if (local) {
          await this.cleanupUnavailableManagedInstall(slug, local);
        }
        continue;
      }

      const expectedSharedInstallPath = local?.installPath ?? path.join(os.homedir(), '.agents', 'skills', slug);
      const claudeConflict = await this.deps.detectClaudeSkillConflict(slug, expectedSharedInstallPath);
      if (claudeConflict) {
        log.warn('auto sync skipped user-owned claude skill', {
          slug,
          installPath: claudeConflict.path,
          reason: claudeConflict.reason,
        });
        continue;
      }

      if (local && isLocalVersionSatisfied({ targetVersion, localVersion: local.entry.version, exact: !!skill.version })) {
        if (localInstallPathExists) continue;
        log.warn('managed global skill registry entry is missing on disk', {
          slug,
          installPath: local.installPath,
        });
      }

      const params: installService.InstallParams = local
        ? {
          name: slug,
          catalogScope,
          autoSync: true,
          installPath: local.installPath,
          version: targetVersion,
          force: true,
          skipBackup: !localInstallPathExists,
        }
        : { name: slug, catalogScope, autoSync: true, ...(skill.version ? { version: targetVersion } : {}) };
      const previousInstall = local && localInstallPathExists ? local : undefined;

      this.assertAuthUnchanged();
      const result = await this.installWithAuthCancel(slug, params, previousInstall);
      this.assertAuthUnchanged();
      if (!result.success) {
        if (result.errorCode === 'CONFLICT_USER_OWNED') {
          log.warn('auto sync skipped user-owned global skill', {
            slug,
            errorCode: result.errorCode,
            message: result.message,
          });
          continue;
        }
        if (result.errorCode === 'CANCELLED') {
          throw new Error(result.message);
        }
        log.warn('auto install/update failed', {
          slug,
          version: targetVersion,
          errorCode: result.errorCode,
          message: result.message,
        });
        failedSlugs.push(slug);
      }
    }
    if (failedSlugs.length > 0) {
      throw new Error(`auto sync failed for ${failedSlugs.join(', ')}`);
    }
  }

  private async installWithAuthCancel(
    slug: string,
    params: installService.InstallParams,
    previousInstall?: ListedInstall,
  ): Promise<InstallResult> {
    let cancelRequested = false;
    const cancelIfAuthChanged = (): boolean => {
      if (this.externalCancelRequested) {
        cancelRequested = true;
        this.deps.cancelInstall(slug);
        return true;
      }
      const currentUserId = this.deps.getCurrentUserId();
      if (currentUserId && currentUserId === this.inFlightUserId) return false;
      cancelRequested = true;
      this.deps.cancelInstall(slug);
      return true;
    };

    this.activeInstallSlug = slug;
    const watchdog = setInterval(cancelIfAuthChanged, 250);
    try {
      if (cancelIfAuthChanged()) {
        return {
          success: false,
          errorCode: 'CANCELLED',
          message: 'auth user changed during auto sync',
        };
      }
      const result = await this.deps.install(params, () => {
        cancelIfAuthChanged();
      }).catch((err) => ({
        success: false as const,
        errorCode: 'INTERNAL' as const,
        message: err instanceof Error ? err.message : String(err),
      }));
      cancelIfAuthChanged();
      if (cancelRequested && result.success) {
        const cleanupParams = {
          slug,
          absolutePath: result.absolutePath,
          previousInstall,
          replacedBackupPath: result.replacedBackupPath,
        };
        try {
          await this.deps.cleanupInstall(cleanupParams);
          await this.clearPendingCancellationCleanup(slug);
        } catch (err) {
          this.pendingCancellationCleanups.set(slug, cleanupParams);
          try {
            await this.persistPendingCancellationCleanups();
          } catch (persistErr) {
            log.warn('auto sync persist pending cancellation cleanup failed', {
              slug,
              installPath: result.absolutePath,
              cleanupError: err instanceof Error ? err.message : String(err),
              persistError: persistErr instanceof Error ? persistErr.message : String(persistErr),
            });
            return {
              success: false,
              errorCode: 'INTERNAL',
              message: `cleanup after auth cancellation failed and could not be persisted: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
            };
          }
          log.warn('auto sync cleanup after auth cancellation failed', {
            slug,
            installPath: result.absolutePath,
            error: err instanceof Error ? err.message : String(err),
          });
          return {
            success: false,
            errorCode: 'INTERNAL',
            message: `cleanup after auth cancellation failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        return {
          success: false,
          errorCode: 'CANCELLED',
          message: 'auth user changed during auto sync',
        };
      }
      return result;
    } finally {
      clearInterval(watchdog);
      if (this.activeInstallSlug === slug) {
        this.activeInstallSlug = null;
      }
    }
  }

  private async retryPendingCancellationCleanups(): Promise<void> {
    for (const slug of Array.from(this.pendingCancellationCleanups.keys())) {
      await this.retryPendingCancellationCleanup(slug);
    }
  }

  private async retryPendingCancellationCleanup(slug: string): Promise<void> {
    const cleanupParams = this.pendingCancellationCleanups.get(slug);
    if (!cleanupParams) return;

    try {
      await this.deps.cleanupInstall(cleanupParams);
      await this.clearPendingCancellationCleanup(slug);
    } catch (err) {
      log.warn('auto sync pending cancellation cleanup failed', {
        slug,
        installPath: cleanupParams.absolutePath,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(`pending cancellation cleanup failed for ${slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async cleanupUnavailableManagedInstall(slug: string, local: ListedInstall): Promise<void> {
    try {
      await this.deps.cleanupInstall({
        slug,
        absolutePath: local.installPath,
      });
      log.warn('auto sync removed inaccessible managed global skill', {
        slug,
        installPath: local.installPath,
      });
    } catch (err) {
      log.warn('auto sync cleanup inaccessible managed global skill failed', {
        slug,
        installPath: local.installPath,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(`cleanup inaccessible managed skill failed for ${slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async recordCandidateSkills(userId: string, names: string[], options: { replace?: boolean }): Promise<void> {
    await this.deps.recordCandidateSkills(userId, names, options).catch((err) => {
      log.warn('record auto sync candidate skills failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private async loadPendingCancellationCleanupsOnce(): Promise<void> {
    if (this.pendingCancellationCleanupsLoaded) return;
    const cleanups = await this.deps.loadPendingCancellationCleanups();
    for (const cleanup of cleanups) {
      this.pendingCancellationCleanups.set(cleanup.slug, cleanup);
    }
    this.pendingCancellationCleanupsLoaded = true;
  }

  private async clearPendingCancellationCleanup(slug: string): Promise<void> {
    this.pendingCancellationCleanups.delete(slug);
    await this.persistPendingCancellationCleanups();
  }

  private async persistPendingCancellationCleanups(): Promise<void> {
    await this.deps.savePendingCancellationCleanups(Array.from(this.pendingCancellationCleanups.values()));
  }

  private assertAuthUnchanged(): void {
    const currentUserId = this.deps.getCurrentUserId();
    if (!currentUserId || currentUserId !== this.inFlightUserId) {
      throw new Error('auth user changed during auto sync');
    }
  }
}

export const skillhubAutoSyncService = new SkillhubAutoSyncService();

function defaultAutoSyncSkills(): AutoSyncSkill[] {
  return DEFAULT_SKILLHUB_AUTO_SYNC_SLUGS.map((name) => ({ name, catalogScope: 'market' }));
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

async function fetchRemoteAutoSyncConfig(): Promise<AutoSyncConfigResult> {
  const url = process.env.XDT_SKILLHUB_AUTO_SYNC_CONFIG_URL
    ?? `${(await ensureBaseUrl()).replace(/\/+$/, '')}/${SKILLHUB_AUTO_SYNC_CONFIG_PATH}`;
  const response = await fetchJsonWithTimeout(url, CONFIG_FETCH_TIMEOUT_MS);
  const skills = parseAutoSyncConfig(response);
  if (skills) return { skills, usingFallbackConfig: false };
  return { skills: defaultAutoSyncSkills(), usingFallbackConfig: true };
}

function normalizeAutoSyncConfigResult(result: AutoSyncSkill[] | AutoSyncConfigResult): AutoSyncConfigResult {
  if (Array.isArray(result)) {
    return { skills: result, usingFallbackConfig: false };
  }
  return result;
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<unknown> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const response = await net.fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, {
      method: 'GET',
      signal: ac.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function pendingCancellationCleanupStorePath(): string {
  return path.join(app.getPath('userData'), 'skillhub', 'auto-sync-pending-cleanups.json');
}

async function loadPendingCancellationCleanups(): Promise<CancelledInstallCleanup[]> {
  const filePath = pendingCancellationCleanupStorePath();
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    log.warn('read pending cancellation cleanup store failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    await clearUnreadablePendingCancellationCleanupStore(filePath);
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsePendingCancellationCleanupStore(parsed);
  } catch (err) {
    log.warn('parse pending cancellation cleanup store failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    await clearUnreadablePendingCancellationCleanupStore(filePath);
    return [];
  }
}

async function clearUnreadablePendingCancellationCleanupStore(filePath: string): Promise<void> {
  try {
    await fs.promises.rm(filePath, { recursive: true, force: true });
  } catch (err) {
    log.warn('delete unreadable pending cancellation cleanup store failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function savePendingCancellationCleanups(cleanups: CancelledInstallCleanup[]): Promise<void> {
  const filePath = pendingCancellationCleanupStorePath();
  if (cleanups.length === 0) {
    try {
      await fs.promises.unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return;
  }

  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(
      tmpPath,
      `${JSON.stringify({ schemaVersion: PENDING_CLEANUP_STORE_VERSION, cleanups }, null, 2)}\n`,
      'utf-8',
    );
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

function parsePendingCancellationCleanupStore(value: unknown): CancelledInstallCleanup[] {
  if (!value || typeof value !== 'object') return [];
  const cleanups = (value as { cleanups?: unknown }).cleanups;
  if (!Array.isArray(cleanups)) return [];
  return cleanups
    .map(parsePendingCancellationCleanup)
    .filter((cleanup): cleanup is CancelledInstallCleanup => cleanup !== null);
}

function parsePendingCancellationCleanup(value: unknown): CancelledInstallCleanup | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as {
    slug?: unknown;
    absolutePath?: unknown;
    previousInstall?: unknown;
    replacedBackupPath?: unknown;
  };
  if (typeof obj.slug !== 'string' || typeof obj.absolutePath !== 'string') return null;

  const previousInstall = parseListedInstall(obj.previousInstall);
  const replacedBackupPath = typeof obj.replacedBackupPath === 'string' ? obj.replacedBackupPath : undefined;
  return {
    slug: obj.slug,
    absolutePath: obj.absolutePath,
    ...(previousInstall ? { previousInstall } : {}),
    ...(replacedBackupPath ? { replacedBackupPath } : {}),
  };
}

function parseListedInstall(value: unknown): ListedInstall | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as { skillName?: unknown; installPath?: unknown; entry?: unknown };
  if (typeof obj.skillName !== 'string' || typeof obj.installPath !== 'string') return undefined;
  if (!obj.entry || typeof obj.entry !== 'object') return undefined;
  return {
    skillName: obj.skillName,
    installPath: obj.installPath,
    entry: obj.entry as StoredInstall,
  };
}

export function parseAutoSyncConfig(value: unknown): AutoSyncSkill[] | null {
  if (!value || typeof value !== 'object') return null;
  const rawSkills = (value as { skills?: unknown }).skills;
  if (!Array.isArray(rawSkills)) return null;

  const seen = new Set<string>();
  const skills: AutoSyncSkill[] = [];
  for (const raw of rawSkills) {
    const skill = parseAutoSyncSkill(raw);
    if (!skill) continue;
    // Global discovery has exactly one ~/.agents/skills/<slug> slot. Preserve
    // the historical first-entry-wins behavior when a remote config repeats a
    // slug with different catalog scopes instead of scheduling two installs
    // that would target the same directory.
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    skills.push(skill);
  }
  return skills;
}

function parseAutoSyncSkill(value: unknown): AutoSyncSkill | null {
  if (typeof value === 'string') {
    const name = normalizeSkillName(value);
    return name ? { name, catalogScope: 'market' } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const obj = value as {
    name?: unknown;
    slug?: unknown;
    enabled?: unknown;
    version?: unknown;
    catalogScope?: unknown;
    scope?: unknown;
  };
  if (obj.enabled === false) return null;
  const name = normalizeSkillName(obj.name ?? obj.slug);
  if (!name) return null;
  const version = typeof obj.version === 'string' && obj.version.trim() ? obj.version.trim() : undefined;
  const rawScope = obj.catalogScope ?? obj.scope;
  if (rawScope !== undefined && rawScope !== 'team' && rawScope !== 'market') return null;
  const catalogScope = rawScope === 'team' || rawScope === 'market' ? rawScope : 'market';
  return { name, catalogScope, ...(version ? { version } : {}) };
}

function normalizeSkillName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name ? name : null;
}

function buildRelevantInstallMap(
  installs: ListedInstall[],
  refs: Array<{ slug: string; catalogScope: SkillhubCatalogScope }>,
  autoSyncSlugs: Set<string>,
): Map<string, ListedInstall> {
  const result = new Map<string, ListedInstall>();
  const globalRoot = path.join(os.homedir(), '.agents', 'skills');
  const configuredKeys = new Set(refs.map(({ slug, catalogScope }) => skillhubCatalogKey(slug, catalogScope)));

  for (const install of installs) {
    if (!isAutoSyncedGlobalInstall(install, autoSyncSlugs)) continue;
    if (!isGlobalSkillInstall(globalRoot, install)) continue;
    const key = skillhubCatalogKey(install.skillName, install.entry.catalogScope);
    if (!configuredKeys.has(key)) continue;
    if (!result.has(key)) result.set(key, install);
  }
  return result;
}

function buildBlockedGlobalInstallMap(installs: ListedInstall[], autoSyncSlugs: Set<string>): Map<string, ListedInstall> {
  const result = new Map<string, ListedInstall>();
  const globalRoot = path.join(os.homedir(), '.agents', 'skills');

  for (const install of installs) {
    if (isAutoSyncedGlobalInstall(install, autoSyncSlugs)) continue;
    if (!isGlobalSkillInstall(globalRoot, install)) continue;
    if (!result.has(install.skillName)) result.set(install.skillName, install);
  }
  return result;
}

function isAutoSyncedGlobalInstall(install: ListedInstall, autoSyncSlugs: Set<string>): boolean {
  if (install.entry.origin !== 'installed') return false;
  if (install.entry.autoSynced === true) return true;
  // 兼容旧版本：auto-sync 首版写入的 registry 没有 autoSynced 字段。
  return install.entry.autoSynced === undefined && autoSyncSlugs.has(install.skillName);
}

function isGlobalSkillInstall(globalRoot: string, install: ListedInstall): boolean {
  return isGlobalSkillPath(globalRoot, install.skillName, install.installPath);
}

function isGlobalSkillPath(globalRoot: string, skillName: string, installPath: string): boolean {
  const expected = path.join(globalRoot, skillName);
  return normalizeForCompare(installPath) === normalizeForCompare(expected);
}

async function detectClaudeGlobalSkillConflict(
  slug: string,
  expectedSharedPath: string,
): Promise<ClaudeSkillConflict | null> {
  const claudePath = path.join(os.homedir(), '.claude', 'skills', slug);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(claudePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return {
      path: claudePath,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (!stat.isSymbolicLink()) {
    return {
      path: claudePath,
      reason: 'path exists and is not a managed symlink',
    };
  }

  let target: string;
  try {
    const rawTarget = await fs.promises.readlink(claudePath);
    target = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(path.dirname(claudePath), rawTarget);
  } catch (err) {
    return {
      path: claudePath,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (normalizeForCompare(target) === normalizeForCompare(expectedSharedPath)) return null;
  return {
    path: claudePath,
    reason: 'symlink points to a different target',
  };
}

function normalizeForCompare(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function cleanupAutoSyncedGlobalInstall({
  slug,
  absolutePath,
  previousInstall,
  replacedBackupPath,
}: CancelledInstallCleanup): Promise<void> {
  const globalRoot = path.join(os.homedir(), '.agents', 'skills');
  if (!isGlobalSkillPath(globalRoot, slug, absolutePath)) {
    log.warn('auto sync cleanup skipped non-global install path', {
      slug,
      installPath: absolutePath,
    });
    return;
  }

  if (previousInstall) {
    if (replacedBackupPath && isGlobalSkillPath(globalRoot, previousInstall.skillName, previousInstall.installPath)) {
      if (await pathExists(replacedBackupPath)) {
        await fs.promises.rm(absolutePath, { recursive: true, force: true });
        await moveDirectory(replacedBackupPath, previousInstall.installPath);
      } else if (!(await pathExists(previousInstall.installPath))) {
        throw new Error(`cancelled update backup missing and previous install not restored: ${replacedBackupPath}`);
      }
      await registryService.addInstall(previousInstall.skillName, previousInstall.installPath, previousInstall.entry);
      return;
    }
    log.warn('auto sync cleanup skipped cancelled update without backup', {
      slug,
      installPath: absolutePath,
    });
    return;
  }

  await fs.promises.rm(absolutePath, { recursive: true, force: true });
  await registryService.removeInstall(slug, absolutePath).catch((err) => {
    log.warn('auto sync cleanup registry remove failed', {
      slug,
      installPath: absolutePath,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  await cleanupBrokenSkillLinks(slug, absolutePath);
}

async function moveDirectory(from: string, to: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.promises.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fs.promises.cp(from, to, { recursive: true, verbatimSymlinks: true });
    await fs.promises.rm(from, { recursive: true, force: true });
  }
}

async function cleanupBrokenSkillLinks(slug: string, removedPath: string): Promise<void> {
  const normalizedRemovedPath = path.normalize(removedPath);
  const candidates = [
    path.join(os.homedir(), '.claude', 'skills', slug),
    path.join(os.homedir(), '.codex', 'skills', slug),
  ];

  for (const candidate of candidates) {
    try {
      const stat = await fs.promises.lstat(candidate);
      if (!stat.isSymbolicLink()) continue;
      const target = path.resolve(path.dirname(candidate), await fs.promises.readlink(candidate));
      if (path.normalize(target) === normalizedRemovedPath || !(await pathExists(target))) {
        await fs.promises.unlink(candidate);
      }
    } catch {
      // best effort cleanup only
    }
  }
}

function isLocalVersionSatisfied({
  targetVersion,
  localVersion,
  exact,
}: {
  targetVersion: string;
  localVersion: string;
  exact: boolean;
}): boolean {
  return exact
    ? stripVersionPrefix(localVersion) === stripVersionPrefix(targetVersion)
    : semverCompare(targetVersion, localVersion) <= 0;
}

function semverCompare(a: string, b: string): number {
  const pa = parseSemverCore(a);
  const pb = parseSemverCore(b);
  for (let i = 0; i < 3; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    const diff = av - bv;
    if (diff !== 0) return diff;
  }
  return 0;
}

function parseSemverCore(version: string): number[] {
  const core = stripVersionPrefix(version).split(/[+-]/, 1)[0];
  return core.split('.').slice(0, 3).map((part) => {
    const n = Number(part);
    return Number.isFinite(n) ? n : 0;
  });
}

function stripVersionPrefix(version: string): string {
  return version.trim().replace(/^v(?=\d)/i, '');
}
