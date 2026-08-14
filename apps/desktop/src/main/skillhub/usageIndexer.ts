import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { brandUserDataDirName } from '@cindy/maker-shared/brand-identity';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';

import { getRawDb } from '../localDb';

import { analyzeSkillUsageTranscript, hashSkillContent, type SkillUsageAgentKind } from './usageAnalyzer';
import {
  deleteSkillUsageRecordsBefore,
  getSkillUsageDiagnosisContextFromDb,
  getSkillUsageSummaryFromDb,
  listSkillUsageSourcesWithRecentExposures,
  markSkillUsageSourceFailed,
  persistSkillUsageAnalysis,
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
let refreshPromise: Promise<void> | null = null;
let lastBackgroundRefreshFinishedAt = 0;

export async function getLocalSkillUsageSummary(params: {
  skillName: string;
  currentSkillContent?: string | null;
  db?: Database.Database;
}): Promise<SkillUsageSummaryResult> {
  const currentDocumentHash = params.currentSkillContent
    ? hashSkillContent(params.currentSkillContent)
    : null;
  const db = params.db ?? getRawDb();
  const analyzerVersion = readActiveAnalyzerVersion(db);
  return {
    success: true,
    summary: getSkillUsageSummaryFromDb(db, {
      skillName: params.skillName,
      currentDocumentHash,
      currentDocumentContent: params.currentSkillContent ?? null,
      analyzerVersion,
    }),
    refreshing: isLocalSkillUsageAnalyticsRefreshing(),
  };
}

export async function getLocalSkillUsageDiagnosisContext(params: {
  skillName: string;
  currentSkillContent?: string | null;
  skillPath?: string | null;
  db?: Database.Database;
}): Promise<SkillUsageDiagnosisContextResult> {
  const currentDocumentHash = params.currentSkillContent
    ? hashSkillContent(params.currentSkillContent)
    : null;
  const db = params.db ?? getRawDb();
  await refreshLocalSkillUsageAnalytics(db);
  const analyzerVersion = readActiveAnalyzerVersion(db);
  return {
    success: true,
    context: getSkillUsageDiagnosisContextFromDb(db, {
      skillName: params.skillName,
      currentDocumentHash,
      currentDocumentContent: params.currentSkillContent ?? null,
      analyzerVersion,
      skillPath: params.skillPath ?? null,
    }),
  };
}

export function isLocalSkillUsageAnalyticsRefreshing(): boolean {
  return refreshPromise !== null;
}

export function requestLocalSkillUsageAnalyticsRefresh(db: Database.Database): Promise<void> | null {
  if (refreshPromise) return refreshPromise;
  const now = Date.now();
  if (now - lastBackgroundRefreshFinishedAt < MIN_BACKGROUND_REFRESH_INTERVAL_MS) return null;
  return startLocalSkillUsageAnalyticsRefresh(db);
}

export function refreshLocalSkillUsageAnalytics(
  db: Database.Database,
  options: SkillUsageRefreshOptions = {},
): Promise<void> {
  return startLocalSkillUsageAnalyticsRefresh(db, options);
}

function startLocalSkillUsageAnalyticsRefresh(
  db: Database.Database,
  options: SkillUsageRefreshOptions = {},
): Promise<void> {
  if (!refreshPromise) {
    refreshPromise = runLocalSkillUsageAnalyticsRefresh(db, options).finally(() => {
      lastBackgroundRefreshFinishedAt = Date.now();
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

async function runLocalSkillUsageAnalyticsRefresh(
  db: Database.Database,
  options: SkillUsageRefreshOptions = {},
): Promise<void> {
  const activeBeforeRefresh = readActiveAnalyzerVersion(db);
  ensureActiveAnalyzerVersionMeta(db, activeBeforeRefresh);
  const nowMs = options.nowMs ?? Date.now();
  const recentSince = recentWindowStartMs(nowMs);
  const platform = options.platform ?? process.platform;
  const discovery = await discoverTranscriptSourcesForRefresh({ ...options, nowMs });
  const cachedRecent = await statCachedRecentSources(
    db,
    activeBeforeRefresh,
    recentSince,
    options.statSource ?? statSource,
  );
  const readTranscriptFile = options.readTranscriptFile ?? ((file: string) => fs.readFile(file, 'utf-8'));
  const sourceBatchSize = Math.max(1, options.maxSourcesPerRefresh ?? MAX_SOURCES_PER_REFRESH);
  const sources = mergeTranscriptSources(discovery.sources, cachedRecent.sources, platform);
  const dirtySources = sources.filter((source) => !isCachedSourceFresh(db, source));
  const scannedAt = Date.now();
  let failedCount = 0;
  for (let start = 0; start < dirtySources.length; start += sourceBatchSize) {
    const batch = dirtySources.slice(start, start + sourceBatchSize);
    for (const source of batch) {
      try {
        const text = await readTranscriptFile(source.rawFilePath);
        const analysis = analyzeSkillUsageTranscript({
          agentKind: source.agentKind,
          sessionId: source.sessionId,
          sdkSessionId: source.sdkSessionId,
          rawFilePath: source.rawFilePath,
          lines: text.split(/\r?\n/),
        });
        persistSkillUsageAnalysis(db, {
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
        markSkillUsageSourceFailed(db, {
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
  if (!discovery.hadDiscoveryFailure && !cachedRecent.hadStatFailure) {
    deleteSkillUsageRecordsBefore(db, ANALYZER_VERSION, recentSince);
  }
  if (!discovery.hadDiscoveryFailure && !cachedRecent.hadStatFailure && failedCount === 0) {
    promoteAnalyzerVersion(db, ANALYZER_VERSION);
  }
}

function readActiveAnalyzerVersion(db: Database.Database): string {
  const row = db.prepare('SELECT value FROM migration_meta WHERE key = ?').get(ANALYZER_VERSION_META_KEY) as
    | { value: string | null }
    | undefined;
  if (row?.value) return row.value;
  const latestPreviousExposure = db.prepare(`
    SELECT analyzer_version AS analyzerVersion
    FROM skill_usage_exposures
    WHERE analyzer_version <> ?
    ORDER BY seen_at DESC
    LIMIT 1
  `).get(ANALYZER_VERSION) as { analyzerVersion: string | null } | undefined;
  if (latestPreviousExposure?.analyzerVersion) return latestPreviousExposure.analyzerVersion;
  const latestExposure = db.prepare(`
    SELECT analyzer_version AS analyzerVersion
    FROM skill_usage_exposures
    ORDER BY seen_at DESC
    LIMIT 1
  `).get() as { analyzerVersion: string | null } | undefined;
  return latestExposure?.analyzerVersion || ANALYZER_VERSION;
}

function ensureActiveAnalyzerVersionMeta(db: Database.Database, analyzerVersion: string): void {
  db.prepare(`
    INSERT INTO migration_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO NOTHING
  `).run(ANALYZER_VERSION_META_KEY, analyzerVersion);
}

function promoteAnalyzerVersion(db: Database.Database, analyzerVersion: string): void {
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO migration_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(ANALYZER_VERSION_META_KEY, analyzerVersion);
    db.prepare('DELETE FROM skill_usage_exposures WHERE analyzer_version <> ?').run(analyzerVersion);
  });
  tx();
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
  db: Database.Database,
  analyzerVersion: string,
  recentSince: number,
  statFile: (file: string) => Promise<SourceStat | null>,
): Promise<{ sources: TranscriptSource[]; hadStatFailure: boolean }> {
  const cachedSources = listSkillUsageSourcesWithRecentExposures(db, analyzerVersion, recentSince);
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

function isCachedSourceFresh(db: Database.Database, source: TranscriptSource): boolean {
  const cached = readCachedSourceStat(db, source.rawFilePath);
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

function readCachedSourceStat(db: Database.Database, rawFilePath: string): CachedSourceStat | null {
  const row = db.prepare(`
    SELECT analyzer_version AS analyzerVersion, mtime_ms AS mtimeMs, size_bytes AS sizeBytes, status
    FROM skill_usage_sources
    WHERE raw_file_path = ?
  `).get(rawFilePath) as CachedSourceStat | undefined;
  return row ?? null;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function codexThreadIdFromFile(file: string): string {
  const name = path.basename(file, '.jsonl');
  return UUID_RE.exec(name)?.[0] ?? name;
}
