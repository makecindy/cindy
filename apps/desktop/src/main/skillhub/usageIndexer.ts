import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { brandUserDataDirName } from '@cindy/maker-shared/brand-identity';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';

import type { DbClient } from '../localDb/client/DbClient.js';
import { getCurrentDbClientSnapshot, getDbClient, type CurrentDbClientSnapshot } from '../localDb/client/current.js';

import { analyzeSkillUsageTranscript, hashSkillContent, type SkillUsageAgentKind } from './usageAnalyzer';
import {
  deleteSkillUsageRecordsBefore,
  deleteSkillUsageRecordsBeforeWithClient,
  getSkillUsageDiagnosisContextFromClient,
  getSkillUsageDiagnosisContextFromDb,
  getSkillUsageSummaryFromClient,
  getSkillUsageSummaryFromDb,
  listSkillUsageSourcesWithRecentExposures,
  listSkillUsageSourcesWithRecentExposuresFromClient,
  markSkillUsageSourceFailed,
  markSkillUsageSourceFailedWithClient,
  persistSkillUsageAnalysis,
  persistSkillUsageAnalysisWithClient,
  promoteSkillUsageAnalyzerVersionWithClient,
  type SkillUsageDiagnosisContext,
  type SkillUsageRecentSourceRecord,
  type SkillUsageSummary,
} from './usageStore';
import { recentWindowStartMs } from './usageWindow';

export interface TranscriptSource {
  agentKind: SkillUsageAgentKind;
  rawFilePath: string;
  sessionId: string;
  sdkSessionId: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface TranscriptDiscoveryOptions {
  homeDir?: string;
  appDataDir?: string;
  userDataDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  maxSourcesPerRefresh?: number;
  maxDiscoveredTranscriptFiles?: number;
  nowMs?: number;
  statSource?: (file: string) => Promise<SourceStat | null>;
}

export interface SkillUsageRefreshOptions extends TranscriptDiscoveryOptions {
  readTranscriptFile?: (file: string) => Promise<string>;
}

interface TranscriptDiscoveryContext {
  homeDir: string;
  appDataDir: string;
  userDataDir: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

interface SourceStat {
  mtimeMs: number;
  sizeBytes: number;
}

interface TranscriptFileCollection {
  files: string[];
  hadIncompleteDiscovery: boolean;
}

interface JsonlFileCollectionOptions {
  maxFiles?: number;
}

interface CachedSourceStat {
  analyzerVersion: string;
  mtimeMs: number;
  sizeBytes: number;
  status: string;
}

type SkillUsageDatabase = Database.Database | DbClient;

export interface SkillUsageSummaryResult {
  success: true;
  summary: SkillUsageSummary;
  refreshing: boolean;
}

export interface SkillUsageDiagnosisContextResult {
  success: true;
  context: SkillUsageDiagnosisContext;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MAX_SOURCES_PER_REFRESH = 1_000;
const MAX_DISCOVERED_TRANSCRIPT_FILES = 100_000;
const TRANSCRIPT_STAT_CONCURRENCY = 32;
const ANALYZER_VERSION_META_KEY = 'skill_usage_analyzer_version';
const MIN_BACKGROUND_REFRESH_INTERVAL_MS = 15_000;
// 解析规则变化时递增。新版完整构建完成前，UI 继续读取旧 active 版本。
const ANALYZER_VERSION = '6';
interface SkillUsageRefreshState {
  promise: Promise<void> | null;
  lastBackgroundRefreshFinishedAt: number;
}
const refreshStateByDatabase = new WeakMap<object, SkillUsageRefreshState>();
let activeRefreshCount = 0;

export async function getLocalSkillUsageSummary(params: {
  skillName: string;
  currentSkillContent?: string | null;
  db?: Database.Database;
  client?: DbClient;
}): Promise<SkillUsageSummaryResult> {
  const currentDocumentHash = params.currentSkillContent
    ? hashSkillContent(params.currentSkillContent)
    : null;
  const database = params.db ?? params.client ?? getDbClient();
  const analyzerVersion = await readActiveAnalyzerVersion(database);
  return {
    success: true,
    summary: isRawDatabase(database)
      ? getSkillUsageSummaryFromDb(database, {
          skillName: params.skillName,
          currentDocumentHash,
          currentDocumentContent: params.currentSkillContent ?? null,
          analyzerVersion,
        })
      : await getSkillUsageSummaryFromClient(database, {
          skillName: params.skillName,
          currentDocumentHash,
          currentDocumentContent: params.currentSkillContent ?? null,
          analyzerVersion,
        }),
    refreshing: isLocalSkillUsageAnalyticsRefreshing(database),
  };
}

export async function getLocalSkillUsageDiagnosisContext(params: {
  skillName: string;
  currentSkillContent?: string | null;
  skillPath?: string | null;
  db?: Database.Database;
  client?: DbClient;
}): Promise<SkillUsageDiagnosisContextResult> {
  const currentDocumentHash = params.currentSkillContent
    ? hashSkillContent(params.currentSkillContent)
    : null;
  const database = params.db ?? params.client ?? getDbClient();
  await refreshLocalSkillUsageAnalytics(database);
  const analyzerVersion = await readActiveAnalyzerVersion(database);
  return {
    success: true,
    context: isRawDatabase(database)
      ? getSkillUsageDiagnosisContextFromDb(database, {
          skillName: params.skillName,
          currentDocumentHash,
          currentDocumentContent: params.currentSkillContent ?? null,
          analyzerVersion,
          skillPath: params.skillPath ?? null,
        })
      : await getSkillUsageDiagnosisContextFromClient(database, {
          skillName: params.skillName,
          currentDocumentHash,
          currentDocumentContent: params.currentSkillContent ?? null,
          analyzerVersion,
          skillPath: params.skillPath ?? null,
        }),
  };
}

export function isLocalSkillUsageAnalyticsRefreshing(database?: SkillUsageDatabase): boolean {
  return database
    ? getRefreshState(database).promise !== null
    : activeRefreshCount > 0;
}

export function requestLocalSkillUsageAnalyticsRefresh(
  database: SkillUsageDatabase = getDbClient(),
): Promise<void> | null {
  const state = getRefreshState(database);
  if (state.promise) return state.promise;
  const now = Date.now();
  if (now - state.lastBackgroundRefreshFinishedAt < MIN_BACKGROUND_REFRESH_INTERVAL_MS) return null;
  return startLocalSkillUsageAnalyticsRefresh(database);
}

export function refreshLocalSkillUsageAnalytics(
  database: SkillUsageDatabase = getDbClient(),
  options: SkillUsageRefreshOptions = {},
): Promise<void> {
  return startLocalSkillUsageAnalyticsRefresh(database, options);
}

function startLocalSkillUsageAnalyticsRefresh(
  database: SkillUsageDatabase,
  options: SkillUsageRefreshOptions = {},
): Promise<void> {
  const state = getRefreshState(database);
  if (!state.promise) {
    activeRefreshCount += 1;
    state.promise = runLocalSkillUsageAnalyticsRefresh(database, options).finally(() => {
      state.lastBackgroundRefreshFinishedAt = Date.now();
      state.promise = null;
      activeRefreshCount -= 1;
    });
  }
  return state.promise;
}

function getRefreshState(database: SkillUsageDatabase): SkillUsageRefreshState {
  const existing = refreshStateByDatabase.get(database);
  if (existing) return existing;
  const state: SkillUsageRefreshState = {
    promise: null,
    lastBackgroundRefreshFinishedAt: 0,
  };
  refreshStateByDatabase.set(database, state);
  return state;
}

async function runLocalSkillUsageAnalyticsRefresh(
  database: SkillUsageDatabase,
  options: SkillUsageRefreshOptions = {},
): Promise<void> {
  // In-process DbClient resolves getRawDb() dynamically. Keep the refresh tied
  // to the owner/epoch it started with so an account switch cannot redirect a
  // later write, cleanup, or promotion into the next owner's database.
  const snapshot = captureRefreshSnapshot(database);
  if (!isRefreshDatabaseStable(snapshot)) return;
  const activeBeforeRefresh = await readActiveAnalyzerVersion(database);
  if (!isRefreshDatabaseStable(snapshot)) return;
  await ensureActiveAnalyzerVersionMeta(database, activeBeforeRefresh);
  const nowMs = options.nowMs ?? Date.now();
  const recentSince = recentWindowStartMs(nowMs);
  const platform = options.platform ?? process.platform;
  const discovery = await discoverTranscriptSourcesForRefresh({ ...options, nowMs });
  const cachedRecent = await statCachedRecentSources(
    database,
    activeBeforeRefresh,
    recentSince,
    options.statSource ?? statSource,
  );
  if (!isRefreshDatabaseStable(snapshot)) return;
  const readTranscriptFile = options.readTranscriptFile ?? ((file: string) => fs.readFile(file, 'utf-8'));
  const sourceBatchSize = Math.max(1, options.maxSourcesPerRefresh ?? MAX_SOURCES_PER_REFRESH);
  const sources = mergeTranscriptSources(discovery.sources, cachedRecent.sources, platform);
  const cachedSourceStats = await readCachedSourceStats(database, sources.map((source) => source.rawFilePath));
  const dirtySources = sources.filter((source) => !isCachedSourceFresh(cachedSourceStats, source));
  const scannedAt = Date.now();
  let failedCount = 0;
  for (let start = 0; start < dirtySources.length; start += sourceBatchSize) {
    const batch = dirtySources.slice(start, start + sourceBatchSize);
    for (const source of batch) {
      if (!isRefreshDatabaseStable(snapshot)) return;
      try {
        const text = await readTranscriptFile(source.rawFilePath);
        const analysis = analyzeSkillUsageTranscript({
          agentKind: source.agentKind,
          sessionId: source.sessionId,
          sdkSessionId: source.sdkSessionId,
          rawFilePath: source.rawFilePath,
          lines: text.split(/\r?\n/),
        });
        if (!isRefreshDatabaseStable(snapshot)) return;
        await persistSkillUsageAnalysisInDatabase(database, {
          rawFilePath: source.rawFilePath,
          analyzerVersion: ANALYZER_VERSION,
          agentKind: source.agentKind,
          sessionId: source.sessionId,
          sdkSessionId: source.sdkSessionId,
          mtimeMs: source.mtimeMs,
          sizeBytes: source.sizeBytes,
          scannedAt,
        }, analysis);
      } catch (err) {
        failedCount += 1;
        if (!isRefreshDatabaseStable(snapshot)) return;
        await markSkillUsageSourceFailedInDatabase(database, {
          rawFilePath: source.rawFilePath,
          analyzerVersion: ANALYZER_VERSION,
          agentKind: source.agentKind,
          sessionId: source.sessionId,
          sdkSessionId: source.sdkSessionId,
          mtimeMs: source.mtimeMs,
          sizeBytes: source.sizeBytes,
          scannedAt,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (start + sourceBatchSize < dirtySources.length) await yieldToEventLoop();
  }
  if (!isRefreshDatabaseStable(snapshot)) return;
  if (!discovery.hadDiscoveryFailure && !cachedRecent.hadStatFailure) {
    await deleteSkillUsageRecordsBeforeInDatabase(database, ANALYZER_VERSION, recentSince);
  }
  if (!discovery.hadDiscoveryFailure && !cachedRecent.hadStatFailure && failedCount === 0) {
    await promoteAnalyzerVersion(database, ANALYZER_VERSION);
  }
}

type RefreshSnapshot = CurrentDbClientSnapshot | null;

function captureRefreshSnapshot(database: SkillUsageDatabase): RefreshSnapshot {
  if (isRawDatabase(database)) return null;
  const snapshot = getCurrentDbClientSnapshot();
  return snapshot?.client === database ? snapshot : null;
}

function isRefreshDatabaseStable(snapshot: RefreshSnapshot): boolean {
  if (!snapshot) return true;
  const current = getCurrentDbClientSnapshot();
  return current?.client === snapshot.client
    && current.userId === snapshot.userId
    && current.clientEpoch === snapshot.clientEpoch;
}

async function readActiveAnalyzerVersion(database: SkillUsageDatabase): Promise<string> {
  const row = isRawDatabase(database)
    ? database.prepare('SELECT value FROM migration_meta WHERE key = ?').get(ANALYZER_VERSION_META_KEY) as
      | { value: string | null }
      | undefined
    : await database.queryOne<{ value: string | null }>(
        'SELECT value FROM migration_meta WHERE key = ?', [ANALYZER_VERSION_META_KEY],
      );
  if (row?.value) return row.value;
  const previousSql = `
    SELECT analyzer_version AS analyzerVersion
    FROM skill_usage_exposures
    WHERE analyzer_version <> ?
    ORDER BY seen_at DESC
    LIMIT 1
  `;
  const latestPreviousExposure = isRawDatabase(database)
    ? database.prepare(previousSql).get(ANALYZER_VERSION) as { analyzerVersion: string | null } | undefined
    : await database.queryOne<{ analyzerVersion: string | null }>(previousSql, [ANALYZER_VERSION]);
  if (latestPreviousExposure?.analyzerVersion) return latestPreviousExposure.analyzerVersion;
  const latestSql = `
    SELECT analyzer_version AS analyzerVersion
    FROM skill_usage_exposures
    ORDER BY seen_at DESC
    LIMIT 1
  `;
  const latestExposure = isRawDatabase(database)
    ? database.prepare(latestSql).get() as { analyzerVersion: string | null } | undefined
    : await database.queryOne<{ analyzerVersion: string | null }>(latestSql);
  return latestExposure?.analyzerVersion || ANALYZER_VERSION;
}

async function ensureActiveAnalyzerVersionMeta(
  database: SkillUsageDatabase,
  analyzerVersion: string,
): Promise<void> {
  const sql = `
    INSERT INTO migration_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO NOTHING
  `;
  if (isRawDatabase(database)) {
    database.prepare(sql).run(ANALYZER_VERSION_META_KEY, analyzerVersion);
  } else {
    await database.exec(sql, [ANALYZER_VERSION_META_KEY, analyzerVersion]);
  }
}

async function promoteAnalyzerVersion(
  database: SkillUsageDatabase,
  analyzerVersion: string,
): Promise<void> {
  if (!isRawDatabase(database)) {
    await promoteSkillUsageAnalyzerVersionWithClient(database, analyzerVersion);
    return;
  }
  const tx = database.transaction(() => {
    database.prepare(`
      INSERT INTO migration_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(ANALYZER_VERSION_META_KEY, analyzerVersion);
    database.prepare('DELETE FROM skill_usage_exposures WHERE analyzer_version <> ?').run(analyzerVersion);
  });
  tx();
}

function isRawDatabase(database: SkillUsageDatabase): database is Database.Database {
  return 'prepare' in database && typeof database.prepare === 'function';
}

async function persistSkillUsageAnalysisInDatabase(
  database: SkillUsageDatabase,
  source: Parameters<typeof persistSkillUsageAnalysis>[1],
  analysis: Parameters<typeof persistSkillUsageAnalysis>[2],
): Promise<void> {
  if (isRawDatabase(database)) persistSkillUsageAnalysis(database, source, analysis);
  else await persistSkillUsageAnalysisWithClient(database, source, analysis);
}

async function markSkillUsageSourceFailedInDatabase(
  database: SkillUsageDatabase,
  source: Parameters<typeof markSkillUsageSourceFailed>[1],
): Promise<void> {
  if (isRawDatabase(database)) markSkillUsageSourceFailed(database, source);
  else await markSkillUsageSourceFailedWithClient(database, source);
}

async function deleteSkillUsageRecordsBeforeInDatabase(
  database: SkillUsageDatabase,
  analyzerVersion: string,
  recentSince: number,
): Promise<void> {
  if (isRawDatabase(database)) deleteSkillUsageRecordsBefore(database, analyzerVersion, recentSince);
  else await deleteSkillUsageRecordsBeforeWithClient(database, analyzerVersion, recentSince);
}

export async function discoverTranscriptSources(options: TranscriptDiscoveryOptions = {}): Promise<TranscriptSource[]> {
  const result = await discoverTranscriptSourcesForRefresh(options);
  return result.sources;
}

async function discoverTranscriptSourcesForRefresh(options: TranscriptDiscoveryOptions = {}): Promise<{
  sources: TranscriptSource[];
  hadDiscoveryFailure: boolean;
}> {
  const context = resolveTranscriptDiscoveryContext(options);
  const recentSince = recentWindowStartMs(options.nowMs ?? Date.now());
  const maxDiscoveredTranscriptFiles = Math.max(
    1,
    options.maxDiscoveredTranscriptFiles ?? MAX_DISCOVERED_TRANSCRIPT_FILES,
  );
  const [claudeHomes, codexHomes] = await Promise.all([
    uniqueExistingDirectories(claudeHomeCandidates(context), context.platform),
    uniqueExistingDirectories(codexHomeCandidates(context), context.platform),
  ]);
  const [claudeFileGroups, codexFileGroups] = await Promise.all([
    Promise.all(claudeHomes.map((home) => collectJsonlFiles(
      path.join(home, 'projects'),
      { maxFiles: maxDiscoveredTranscriptFiles },
    ))),
    Promise.all(codexHomes.flatMap((home) => [
      collectJsonlFiles(path.join(home, 'sessions'), { maxFiles: maxDiscoveredTranscriptFiles }),
      collectJsonlFiles(path.join(home, 'archived_sessions'), { maxFiles: maxDiscoveredTranscriptFiles }),
    ])),
  ]);
  const hadIncompleteDiscovery = [...claudeFileGroups, ...codexFileGroups].some((group) => group.hadIncompleteDiscovery);
  const claudeFiles = uniquePaths(claudeFileGroups.flatMap((group) => group.files), context.platform);
  const codexFiles = uniquePaths(codexFileGroups.flatMap((group) => group.files), context.platform);
  const candidates = [
    ...claudeFiles.map((file): Omit<TranscriptSource, 'mtimeMs' | 'sizeBytes'> => {
      const sdkSessionId = claudeSdkSessionIdFromFile(file);
      return {
        agentKind: 'claude-code',
        rawFilePath: file,
        sessionId: `claude-${sdkSessionId}`,
        sdkSessionId,
      };
    }),
    ...codexFiles.map((file): Omit<TranscriptSource, 'mtimeMs' | 'sizeBytes'> => {
      const sdkSessionId = codexThreadIdFromFile(file);
      return {
        agentKind: 'codex',
        rawFilePath: file,
        sessionId: `codex-${sdkSessionId}`,
        sdkSessionId,
      };
    }),
  ];
  const result = await statTranscriptSources(
    candidates,
    options.statSource ?? statSource,
    recentSince,
  );
  return {
    sources: result.sources,
    hadDiscoveryFailure: hadIncompleteDiscovery || result.hadStatFailure,
  };
}

function claudeSdkSessionIdFromFile(file: string): string {
  const basename = path.basename(file, '.jsonl');
  if (path.basename(path.dirname(file)) !== 'subagents') return basename;
  const suffix = createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 12);
  return `${basename}-${suffix}`;
}

function resolveTranscriptDiscoveryContext(options: TranscriptDiscoveryOptions): TranscriptDiscoveryContext {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const appDataDir = options.appDataDir ?? env.APPDATA ?? path.join(homeDir, 'AppData', 'Roaming');
  return {
    homeDir,
    appDataDir,
    userDataDir: options.userDataDir ?? env.XDT_USER_DATA_DIR ?? defaultXdtUserDataDir(platform, homeDir, appDataDir, env),
    env,
    platform,
  };
}

// 生产调用链 options 为空时会落到这里(不经 app.getPath),目录名必须与
// Electron userData 实际目录一致——从 brand-identity 派生,改名时自动跟随。
function defaultXdtUserDataDir(
  platform: NodeJS.Platform,
  homeDir: string,
  appDataDir: string,
  env: NodeJS.ProcessEnv,
): string {
  // 按现有区域目录映射取值(global=CindyGlobal,cn=Cindy，同机双装分库)。
  const dirName = brandUserDataDirName(CURRENT_CINDY_REGION);
  if (platform === 'darwin') return path.join(homeDir, 'Library', 'Application Support', dirName);
  if (platform === 'win32') return path.join(appDataDir, dirName);
  return path.join(env.XDG_CONFIG_HOME ?? path.join(homeDir, '.config'), dirName);
}

function claudeHomeCandidates(context: TranscriptDiscoveryContext): string[] {
  return [
    context.env.CLAUDE_CONFIG_DIR ?? '',
    path.join(context.homeDir, '.claude'),
    path.join(context.userDataDir, 'claude-home'),
  ];
}

function codexHomeCandidates(context: TranscriptDiscoveryContext): string[] {
  const candidates = [
    context.env.CODEX_HOME ?? '',
    path.join(context.homeDir, '.codex'),
    path.join(context.userDataDir, 'codex-home'),
  ];
  if (context.platform === 'darwin') {
    const appSupport = path.join(context.homeDir, 'Library', 'Application Support');
    candidates.push(path.join(appSupport, 'Codex', 'codex-home'), path.join(appSupport, 'Codex'));
  } else if (context.platform === 'win32') {
    candidates.push(path.join(context.appDataDir, 'Codex', 'codex-home'), path.join(context.appDataDir, 'Codex'));
  } else {
    candidates.push(path.join(context.env.XDG_CONFIG_HOME ?? path.join(context.homeDir, '.config'), 'codex'));
  }
  return candidates;
}

async function uniqueExistingDirectories(candidates: string[], platform: NodeJS.Platform): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    if (!candidate.trim()) continue;
    const real = await realDirectoryPath(candidate);
    if (!real) continue;
    const key = normalizePathForCompare(real, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(real);
  }
  return out;
}

async function realDirectoryPath(candidate: string): Promise<string | null> {
  try {
    const real = await fs.realpath(candidate);
    const stat = await fs.stat(real);
    return stat.isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function uniquePaths(files: string[], platform: NodeJS.Platform): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of files) {
    const key = normalizePathForCompare(file, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

function normalizePathForCompare(filePath: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(filePath);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function collectJsonlFiles(
  root: string,
  options: JsonlFileCollectionOptions = {},
): Promise<TranscriptFileCollection> {
  const files: string[] = [];
  let hadIncompleteDiscovery = false;
  const maxFiles = Math.max(1, options.maxFiles ?? MAX_DISCOVERED_TRANSCRIPT_FILES);
  const stack = [root];
  while (stack.length > 0 && files.length < maxFiles) {
    const dir = stack.pop();
    if (!dir) break;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (!isMissingCollectionRoot(root, dir, err)) hadIncompleteDiscovery = true;
      continue;
    }
    const sortedEntries = [...entries].sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of sortedEntries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
        if (files.length >= maxFiles) {
          hadIncompleteDiscovery = true;
          break;
        }
      }
    }
    if (files.length >= maxFiles) break;
    for (const entry of [...sortedEntries].reverse()) {
      if (!entry.isDirectory()) continue;
      const childDir = path.join(dir, entry.name);
      stack.push(childDir);
    }
  }
  if (stack.length > 0) hadIncompleteDiscovery = true;
  return { files, hadIncompleteDiscovery };
}

function isMissingCollectionRoot(root: string, dir: string, err: unknown): boolean {
  return dir === root && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

async function statCachedRecentSources(
  database: SkillUsageDatabase,
  analyzerVersion: string,
  recentSince: number,
  statFile: (file: string) => Promise<SourceStat | null>,
): Promise<{ sources: TranscriptSource[]; hadStatFailure: boolean }> {
  const cachedSources = isRawDatabase(database)
    ? listSkillUsageSourcesWithRecentExposures(database, analyzerVersion, recentSince)
    : await listSkillUsageSourcesWithRecentExposuresFromClient(database, analyzerVersion, recentSince);
  if (cachedSources.length === 0) return { sources: [], hadStatFailure: false };
  const result = await statTranscriptSourcesWithoutRecentFilter(cachedSources, statFile);
  return result;
}

async function statTranscriptSourcesWithoutRecentFilter(
  cachedSources: SkillUsageRecentSourceRecord[],
  statFile: (file: string) => Promise<SourceStat | null>,
): Promise<{ sources: TranscriptSource[]; hadStatFailure: boolean }> {
  const sources: TranscriptSource[] = [];
  let hadStatFailure = false;
  for (const cached of cachedSources) {
    try {
      const stat = await statFile(cached.rawFilePath);
      if (!stat) {
        hadStatFailure = true;
        continue;
      }
      sources.push({ ...cached, ...stat });
    } catch {
      hadStatFailure = true;
    }
  }
  return { sources, hadStatFailure };
}

async function statTranscriptSources(
  candidates: Array<Omit<TranscriptSource, 'mtimeMs' | 'sizeBytes'>>,
  statFile: (file: string) => Promise<SourceStat | null>,
  recentSince: number,
): Promise<{ sources: TranscriptSource[]; hadStatFailure: boolean }> {
  if (candidates.length === 0) {
    return { sources: [], hadStatFailure: false };
  }

  const sources: TranscriptSource[] = [];
  let nextIndex = 0;
  let hadStatFailure = false;
  const workerCount = Math.min(TRANSCRIPT_STAT_CONCURRENCY, candidates.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < candidates.length) {
      const candidate = candidates[nextIndex];
      nextIndex += 1;
      try {
        const stat = await statFile(candidate.rawFilePath);
        if (!stat) {
          hadStatFailure = true;
          continue;
        }
        if (stat.mtimeMs < recentSince) continue;
        sources.push({ ...candidate, ...stat });
      } catch {
        hadStatFailure = true;
      }
    }
  });
  await Promise.all(workers);
  sources.sort(compareTranscriptSourcesByRecency);
  return { sources, hadStatFailure };
}

function mergeTranscriptSources(
  discoveredSources: TranscriptSource[],
  cachedSources: TranscriptSource[],
  platform: NodeJS.Platform,
): TranscriptSource[] {
  const byPath = new Map<string, TranscriptSource>();
  for (const source of cachedSources) {
    byPath.set(normalizePathForCompare(source.rawFilePath, platform), source);
  }
  for (const source of discoveredSources) {
    byPath.set(normalizePathForCompare(source.rawFilePath, platform), source);
  }
  return [...byPath.values()].sort(compareTranscriptSourcesByRecency);
}

function compareTranscriptSourcesByRecency(a: TranscriptSource, b: TranscriptSource): number {
  return b.mtimeMs - a.mtimeMs || a.rawFilePath.localeCompare(b.rawFilePath);
}

function isCachedSourceFresh(
  cachedSourceStats: ReadonlyMap<string, CachedSourceStat>,
  source: TranscriptSource,
): boolean {
  const cached = cachedSourceStats.get(source.rawFilePath);
  return (
    cached?.status === 'ok' &&
    cached.analyzerVersion === ANALYZER_VERSION &&
    cached.mtimeMs === source.mtimeMs &&
    cached.sizeBytes === source.sizeBytes
  );
}

async function statSource(file: string): Promise<SourceStat | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return null;
    return { mtimeMs: Math.round(stat.mtimeMs), sizeBytes: stat.size };
  } catch {
    return null;
  }
}

async function readCachedSourceStats(
  database: SkillUsageDatabase,
  rawFilePaths: string[],
): Promise<Map<string, CachedSourceStat>> {
  if (rawFilePaths.length === 0) return new Map();
  const sql = `
    SELECT
      s.raw_file_path AS rawFilePath,
      s.analyzer_version AS analyzerVersion,
      s.mtime_ms AS mtimeMs,
      s.size_bytes AS sizeBytes,
      s.status
    FROM json_each(?) wanted
    JOIN skill_usage_sources s
      ON s.raw_file_path = CAST(wanted.value AS TEXT)
  `;
  const params = [JSON.stringify(rawFilePaths)];
  const rows = isRawDatabase(database)
    ? database.prepare(sql).all(...params) as Array<CachedSourceStat & { rawFilePath: string }>
    : await database.query<CachedSourceStat & { rawFilePath: string }>(sql, params);
  return new Map(rows.map((row) => [row.rawFilePath, row]));
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function codexThreadIdFromFile(file: string): string {
  const name = path.basename(file, '.jsonl');
  return UUID_RE.exec(name)?.[0] ?? name;
}
