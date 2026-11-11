/**
 * 扫描服务：并行跑所有来源适配器，合并成界面候选。
 *
 * - 只读：不写数据库、不改任何来源文件；
 * - 单个来源失败只记在 sourceErrors，不影响其它来源；
 * - 已在 Cindy 里的（来源记录或同一原生编号的任务）只计数；
 * - Cindy 自己运行过的、临时目录里的，标记 hidden，由界面决定是否显示；
 * - 结果按账号缓存 30 秒，导入时按 key 取回含 locator 的完整来源记录。
 */

import os from 'node:os';

import { app } from 'electron';

import { getCurrentDbClientUserId, getDbClient } from '../localDb/client/current.js';
import { dialogueWorkspaceRoots } from '../localDb/dialogueWorkspace.js';
import { createLogger } from '../logger.js';
import { createWorktreeResolver, defaultClassifyEnv, groupFor, hiddenCategoryFor, type ClassifyEnv } from './classify.js';
import { SOURCE_ADAPTERS } from './sources/index.js';
import type { ImportCandidate, ImportScanResult, ImportSourceId, SourceSession } from './types.js';

const log = createLogger('session-import-scan');
const CACHE_TTL_MS = 30_000;

export function candidateKey(source: ImportSourceId, id: string): string {
  return `${source}:${id}`;
}

interface ScanSnapshot {
  scope: string;
  expiresAt: number;
  result: ImportScanResult;
  /** 本机全部来源记录，含已在 Cindy 里的（续做未完成的导入、旧版任务补历史、换文件夹都要读原记录）。 */
  sessions: Map<string, SourceSession>;
  /** 已在 Cindy 里的来源 key：不进候选，用户发起的导入也不再重复导入它们。 */
  imported: Set<string>;
}

let cached: ScanSnapshot | null = null;
let inFlight: { scope: string; promise: Promise<ScanSnapshot> } | null = null;

export function invalidateImportScan(): void {
  cached = null;
}

function scope(): string {
  return getCurrentDbClientUserId() ?? '__no-user__';
}

/** 已在 Cindy 里的来源任务：来源记录 + 同一原生编号的存活任务。 */
async function readExistingKeys(): Promise<Set<string>> {
  const db = getDbClient();
  const out = new Set<string>();
  const records = await db.query<{ source: string; sourceSessionId: string }>(`
    SELECT i.source, i.source_session_id AS sourceSessionId
    FROM session_imports i JOIN sessions s ON s.id = i.session_id
    WHERE s.status != 'deleted'
  `);
  for (const r of records) out.add(`${r.source}:${r.sourceSessionId}`);
  const rows = await db.query<{ agentKind: string; sdkSessionId: string | null }>(`
    SELECT agent_kind AS agentKind, sdk_session_id AS sdkSessionId
    FROM sessions
    WHERE status != 'deleted' AND sdk_session_id IS NOT NULL
  `);
  for (const r of rows) {
    if (!r.sdkSessionId) continue;
    if (r.agentKind === 'cc') out.add(`claude:${r.sdkSessionId}`);
    if (r.agentKind === 'codex') out.add(`codex:${r.sdkSessionId.toLowerCase()}`);
  }
  return out;
}

function classifyEnv(): ClassifyEnv {
  let appData: string | null = null;
  try {
    appData = app.getPath('appData');
  } catch {
    appData = null;
  }
  return defaultClassifyEnv({ appDataDir: appData, dialogueRoots: dialogueWorkspaceRoots() });
}

async function runScan(scopeKey: string): Promise<ScanSnapshot> {
  const startedAt = Date.now();
  const env = classifyEnv();
  const resolveWorktree = createWorktreeResolver(env);
  const ctx = { homeDir: os.homedir(), cindyUserDataDir: safeUserData() };
  const settled = await Promise.all(SOURCE_ADAPTERS.map(async (adapter) => {
    try {
      return { adapter, result: await adapter.list(ctx), error: null as string | null };
    } catch (err) {
      return { adapter, result: null, error: err instanceof Error ? err.message : String(err) };
    }
  }));
  const existing = await readExistingKeys();
  const sessions = new Map<string, SourceSession>();
  const candidates: ImportCandidate[] = [];
  const hiddenCounts = { cindy: 0, temp: 0, internal: 0, imported: 0 };
  const sourceCounts = new Map<ImportSourceId, number>();
  const sourceErrors: ImportScanResult['sourceErrors'] = [];
  for (const { adapter, result, error } of settled) {
    if (error || !result) {
      sourceErrors.push({ id: adapter.id, message: error ?? 'unknown error' });
      continue;
    }
    hiddenCounts.internal += result.internalCount;
    for (const s of result.sessions) {
      const key = candidateKey(s.source, s.sourceSessionId);
      sessions.set(key, s);
      if (existing.has(key)) {
        hiddenCounts.imported += 1;
        continue;
      }
      const hidden = s.ranByCindy ? 'cindy' : hiddenCategoryFor(s.cwd, env);
      if (hidden) hiddenCounts[hidden] += 1;
      const group = groupFor(s.cwd, s.dialogue === true, env, resolveWorktree);
      candidates.push({
        key,
        source: s.source,
        id: s.sourceSessionId,
        title: s.title,
        cwd: s.cwd,
        ...group,
        updatedAt: s.updatedAt,
        archived: s.archived,
        sizeBytes: s.sizeBytes,
        missingDir: !!s.cwd && !group.dialogue && !env.exists(s.cwd),
        hidden,
        unsupportedVersion: s.unsupportedVersion ?? null,
      });
      sourceCounts.set(s.source, (sourceCounts.get(s.source) ?? 0) + 1);
    }
  }
  candidates.sort((a, b) => b.updatedAt - a.updatedAt);
  const result: ImportScanResult = {
    candidates,
    hiddenCounts,
    sources: SOURCE_ADAPTERS
      .filter((a) => (sourceCounts.get(a.id) ?? 0) > 0)
      .map((a) => ({ id: a.id, label: a.label, count: sourceCounts.get(a.id) ?? 0 })),
    sourceErrors,
    scannedAt: Date.now(),
  };
  log.info('session import scan complete', {
    ms: Date.now() - startedAt,
    candidates: candidates.length,
    hidden: hiddenCounts,
    errors: sourceErrors.map((e) => e.id),
  });
  return { scope: scopeKey, expiresAt: Date.now() + CACHE_TTL_MS, result, sessions, imported: existing };
}

function safeUserData(): string | null {
  try {
    return app.getPath('userData');
  } catch {
    return null;
  }
}

async function snapshot(force: boolean): Promise<ScanSnapshot> {
  const s = scope();
  if (!force && cached && cached.scope === s && cached.expiresAt > Date.now()) return cached;
  if (inFlight && inFlight.scope === s) return inFlight.promise;
  const promise = runScan(s).then((snap) => {
    if (scope() === s) cached = snap;
    return snap;
  }).finally(() => {
    if (inFlight?.promise === promise) inFlight = null;
  });
  inFlight = { scope: s, promise };
  return promise;
}

export async function scanImportSources(force = false): Promise<ImportScanResult> {
  return (await snapshot(force)).result;
}

/**
 * 按 key 取回来源记录；缓存过期则重新扫描一次。用户发起的新导入（默认）不返回已在 Cindy 里的记录；
 * 续做中断的导入、旧版任务补历史与换文件夹传 includeImported 读取已登记来源的原记录。
 */
export async function resolveSourceSessions(
  keys: string[],
  options: { includeImported?: boolean } = {},
): Promise<Map<string, SourceSession>> {
  const usable = (snap: ScanSnapshot, k: string) =>
    snap.sessions.has(k) && (options.includeImported === true || !snap.imported.has(k));
  let snap = await snapshot(false);
  if (keys.some((k) => !usable(snap, k))) snap = await snapshot(true);
  const out = new Map<string, SourceSession>();
  for (const k of keys) {
    const s = snap.sessions.get(k);
    if (s && usable(snap, k)) out.set(k, s);
  }
  return out;
}
