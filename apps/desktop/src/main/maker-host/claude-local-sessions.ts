/**
 * Claude Code local session bridge.
 *
 * Claude Code stores its native conversation history as JSONL files under
 * ~/.claude/projects. Desktop owns that filesystem detail and projects those
 * files into normal xdt-maker Claude sessions (agent_kind='cc'); renderer code
 * continues to consume the existing Session/Message contracts.
 */

import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { getCurrentDbClientUserId, getDbClient } from '../localDb/client/current.js';
import { createLogger } from '../logger.js';
import { normalizeWorkingDirForStorage } from '../../shared/workingDir.js';
import { recordPrRefsForImportedMessages } from '../git-context/prRefsStore.js';
import {
  cacheImportedBase64Image,
  importedUserContent,
  normalizeImageMime,
  stripCompleteIdeOpenedFileBlocks,
  type ImportedImageRef,
} from './imported-user-content.js';

const log = createLogger('claude-local-sessions');

const LOCAL_SESSION_ID_PREFIX = 'claude-';
const MAX_SESSIONS_PER_ROOT = 1000;
const claudeMessageImportFileCache = new Map<string, ExternalImportFileCacheEntry>();

// 扫描摘要只读文件头部:候选列表只需要 sessionId / 标题 / cwd / 更新时间,
// 前三者几乎总在最前几行,更新时间直接用 mtime。全文遍历(算 tokens、追踪
// 最新 cwd)只属于导入路径(readClaudeCodeSessionSummary)。字节上限是单文件
// 扫描成本的硬顶;行数上限是正常快速路径。只有在窗口内确实过滤过 IDE 上下文
// 且尚未找到标题时,才允许越过行数上限继续读到字节硬顶,避免提前回退默认标题。
// 绝不能回到"扫描期把 ~/.claude/projects 全量读完并逐行 JSON.parse"的行为。
const SCAN_SUMMARY_MAX_BYTES = 384 * 1024;
const SCAN_SUMMARY_MAX_LINES = 400;
// 按 (mtimeMs, size) 复用扫描摘要:30s TTL 的 IPC 缓存过期后重扫时,未变化
// 的文件(绝大多数)零 IO。负结果(被拒绝的文件)也缓存,避免每轮重复解析。
const claudeScanSummaryCache = new Map<string, ClaudeScanSummaryCacheEntry>();
const SCAN_SUMMARY_CACHE_MAX_ENTRIES = 8192;

type MessageRole = 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'thinking';
type PermissionMode = 'ask' | 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';

interface ExternalImportFileCacheEntry {
  scope: string;
  path: string;
  mtimeMs: number;
  size: number;
}

type ExternalImportFileStat = Pick<ExternalImportFileCacheEntry, 'mtimeMs' | 'size'>;

/** 扫描候选列表需要的最小摘要,由头部有界读取产出。 */
export interface ClaudeCodeSessionScanSummary {
  sdkSessionId: string;
  title: string;
  cwd: string;
  updatedAt: number;
}

interface ClaudeScanSummaryCacheEntry {
  mtimeMs: number;
  size: number;
  summary: ClaudeCodeSessionScanSummary | null;
}

/** Summary of one top-level Claude Code JSONL file as an XD session row. */
interface ClaudeCodeSessionSummary {
  sdkSessionId: string;
  title: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  tokensUsed: number;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Imported message row in the existing XD Message schema. */
interface ImportedClaudeMessage {
  lineNo: number;
  partIndex: number;
  role: MessageRole;
  content: unknown;
  toolUseId: string | null;
  agentMeta: Record<string, unknown> | null;
  createdAt: number;
}

/** Result counters for an explicit Settings import. */
export interface ClaudeCodeExternalImportResult {
  roots: number;
  scanned: number;
  inserted: number;
  updated: number;
}

export interface ClaudeCodeExternalSessionCandidate {
  source: 'claude';
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
  archived: boolean;
  sourceFile: string;
}

export interface ClaudeCodeExternalScanResult {
  roots: string[];
  candidates: ClaudeCodeExternalSessionCandidate[];
  rejectedCount: number;
}

export interface ClaudeCodeExternalScanOptions {
  maxSessionsPerRoot?: number;
}

/** 设置导入页使用的只读扫描，不写入 xdt-maker DB。 */
export async function scanExternalClaudeCodeSessions(
  options: ClaudeCodeExternalScanOptions = {},
): Promise<ClaudeCodeExternalScanResult> {
  const maxSessionsPerRoot = options.maxSessionsPerRoot ?? MAX_SESSIONS_PER_ROOT;
  const roots = await discoverClaudeProjectsRoots();
  const candidates: ClaudeCodeExternalSessionCandidate[] = [];
  let rejectedCount = 0;
  for (const root of roots) {
    let scannedForRoot = 0;
    const files = await collectClaudeSessionFiles(root);
    for (const file of files) {
      if (scannedForRoot >= maxSessionsPerRoot) break;
      const summary = await readClaudeCodeSessionScanSummary(file);
      if (!summary) {
        rejectedCount += 1;
        continue;
      }
      scannedForRoot += 1;
      candidates.push({
        source: 'claude',
        id: summary.sdkSessionId,
        title: summary.title,
        cwd: summary.cwd,
        updatedAt: summary.updatedAt,
        archived: false,
        sourceFile: file,
      });
    }
  }
  return { roots, candidates, rejectedCount };
}

/** Import the selected external Claude Code sessions into xdt-maker's session table. */
export async function importExternalClaudeCodeSessions(sdkSessionIds: string[]): Promise<ClaudeCodeExternalImportResult> {
  const roots = await discoverClaudeProjectsRoots();
  const out: ClaudeCodeExternalImportResult = { roots: roots.length, scanned: 0, inserted: 0, updated: 0 };
  const uniqueIds = [...new Set(sdkSessionIds)].filter(isLikelySessionId);
  out.scanned = uniqueIds.length;
  for (const sdkSessionId of uniqueIds) {
    const file = await findClaudeSessionFileById(sdkSessionId);
    if (!file) continue;
    const summary = await readClaudeCodeSessionSummary(file);
    if (!summary) continue;
    const action = await upsertLocalSession(summary);
    if (action === 'inserted') out.inserted += 1;
    else if (action === 'updated') out.updated += 1;
  }
  return out;
}

/**
 * 为导入的 Claude Code 会话按需导入历史消息。
 * 源 JSONL 文件未变化时直接短路；只要会话已有本地新消息，就维持原来的不再刷新外部历史语义。
 */
export async function importExternalClaudeCodeMessagesForSession(sessionId: string): Promise<void> {
  const session = await getDbClient().queryOne<{
    id: string;
    agentKind: string;
    sdkSessionId: string | null;
    model: string;
  }>(`
    SELECT id, agent_kind AS agentKind, sdk_session_id AS sdkSessionId, model
    FROM sessions
    WHERE id = ?
    LIMIT 1
  `, [sessionId]);
  if (session?.agentKind !== 'cc') return;
  if (!session.sdkSessionId) return;
  if (!session.id.startsWith(LOCAL_SESSION_ID_PREFIX)) return;

  const importClientIdPrefix = `claude-import:${session.sdkSessionId}:`;
  // 「已有本地新消息就不再刷新外部历史」守卫。app-exit-interrupted 中断标记行
  // 不算"本地新消息"(review P2):这类行只存在于**简化重构前旧版本**写过的库
  // (2026-07-06 后新中断不再插行,见 shared/interruptedTurn.ts 头注),但旧库
  // 遗留行若被当成本地新消息,会让本守卫早退 —— 崩溃前 Claude 已写 transcript
  // 的产出永不导入,stale 的中断提示一直挂着。守卫需长期保留兼容旧库。
  const hasLocalMessages = await getDbClient().queryOne<{ one: number }>(`
    SELECT 1
    FROM messages
    WHERE session_id = ?
      AND client_id NOT LIKE ?
      AND client_id NOT LIKE 'app-exit-interrupted-%'
    LIMIT 1
  `, [sessionId, `${importClientIdPrefix}%`]);
  if (hasLocalMessages) return;

  const cacheScope = getCurrentDbClientUserId();
  const cachedImportFile = claudeMessageImportFileCache.get(sessionId);
  if (cacheScope && cachedImportFile?.scope === cacheScope) {
    const cachedStat = await statImportFile(cachedImportFile.path);
    if (cachedStat && isCachedImportFileUnchanged(cachedImportFile, cachedStat)) return;
    claudeMessageImportFileCache.delete(sessionId);
  } else if (cachedImportFile) {
    claudeMessageImportFileCache.delete(sessionId);
  }

  const sourceFile = await findClaudeSessionFileById(session.sdkSessionId);
  if (!sourceFile) {
    log.debug('message import skipped: Claude Code session file missing', {
      sessionId,
      sdkSessionId: session.sdkSessionId,
    });
    return;
  }

  const sourceStat = await statImportFile(sourceFile);
  if (!sourceStat) {
    log.debug('message import skipped: Claude Code session file missing', {
      sessionId,
      sdkSessionId: session.sdkSessionId,
    });
    return;
  }

  const imported = await readClaudeCodeMessages(sourceFile, session.id, session.sdkSessionId, session.model);
  if (imported.length === 0) {
    if (cacheScope) {
      claudeMessageImportFileCache.set(sessionId, { scope: cacheScope, path: sourceFile, ...sourceStat });
    }
    return;
  }

  const { changed } = await getDbClient().tx('claude.importMessages', {
    sessionId,
    importClientIdPrefix,
    sdkSessionId: session.sdkSessionId,
    rows: imported.map((row) => ({
      lineNo: row.lineNo,
      partIndex: row.partIndex,
      role: row.role,
      content: row.content,
      toolUseId: row.toolUseId,
      agentMeta: row.agentMeta,
      createdAt: row.createdAt,
    })),
  });
  if (cacheScope) {
    claudeMessageImportFileCache.set(sessionId, { scope: cacheScope, path: sourceFile, ...sourceStat });
  }
  if (changed === 0) return;
  log.info('imported external Claude Code messages', {
    sessionId,
    sdkSessionId: session.sdkSessionId,
    count: changed,
  });
  // session-git-pr-context:导入消息不经 createMessage,在这里补 PR 链接提取
  // (fire-and-forget;upsert 幂等,重复导入刷新无副作用)。
  void recordPrRefsForImportedMessages(
    sessionId,
    imported.map((row) => ({
      role: row.role,
      content: row.content,
      createdAt: row.createdAt,
    })),
  ).catch(() => undefined);
}

async function discoverClaudeProjectsRoots(): Promise<string[]> {
  const defaultRoot = path.join(os.homedir(), '.claude', 'projects');
  const real = await realpathOrNull(defaultRoot);
  if (!real || !(await hasClaudeJsonlFiles(real))) return [];
  return [real];
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fsp.realpath(p);
  } catch {
    return null;
  }
}

async function statImportFile(file: string): Promise<ExternalImportFileStat | null> {
  const stat = await fsp.stat(file).catch(() => null);
  return stat ? { mtimeMs: stat.mtimeMs, size: stat.size } : null;
}

function isCachedImportFileUnchanged(
  cached: ExternalImportFileCacheEntry,
  stat: ExternalImportFileStat,
): boolean {
  return cached.mtimeMs === stat.mtimeMs && cached.size === stat.size;
}

async function hasClaudeJsonlFiles(root: string): Promise<boolean> {
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectDir = path.join(root, entry.name);
      const files = await fsp.readdir(projectDir, { withFileTypes: true });
      if (files.some((file) => file.isFile() && file.name.endsWith('.jsonl'))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

// 异步枚举:扫描可能发生在冷文件缓存下(开机后首次),同步 readdir/stat 会
// 阻塞 main 事件循环,这里必须走 fsp。
async function collectClaudeSessionFiles(root: string): Promise<string[]> {
  const files: Array<{ file: string; mtime: number }> = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'subagents') continue;
        await visit(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl') && !isSubagentPath(full)) {
        try {
          files.push({ file: full, mtime: (await fsp.stat(full)).mtimeMs });
        } catch {
          /* ignore unreadable session */
        }
      }
    }
  };
  await visit(root, 0);
  return files.sort((a, b) => b.mtime - a.mtime).map((x) => x.file);
}

async function findClaudeSessionFileById(sdkSessionId: string): Promise<string | null> {
  const roots = await discoverClaudeProjectsRoots();
  const filename = `${sdkSessionId}.jsonl`;
  for (const root of roots) {
    const files = await collectClaudeSessionFiles(root);
    const found = files.find((file) => path.basename(file) === filename);
    if (found) return found;
  }
  return null;
}

/**
 * 扫描专用的头部有界摘要读取。与全文版的语义差异(有意为之):
 * - updatedAt 一律取文件 mtime,不再扫全文找最大 timestamp;
 * - cwd 取头部窗口内最后出现的值(而非全文最后),窗口外的 cd 不影响候选分组;
 * - 不统计 tokens / model / permissionMode——候选列表用不到,导入时由全文版补齐;
 * - 头部窗口内没有任何顶层 user/assistant 事件的文件按 rejected 处理。
 * 结果按 (mtimeMs, size) 缓存,文件未变化时零 IO。
 */
export async function readClaudeCodeSessionScanSummary(file: string): Promise<ClaudeCodeSessionScanSummary | null> {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat) return null;
  const cached = claudeScanSummaryCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.summary;
  }

  const summary = await readScanSummaryFromHead(file, stat.mtimeMs);
  if (claudeScanSummaryCache.size >= SCAN_SUMMARY_CACHE_MAX_ENTRIES) claudeScanSummaryCache.clear();
  claudeScanSummaryCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
  return summary;
}

async function readScanSummaryFromHead(file: string, mtimeMs: number): Promise<ClaudeCodeSessionScanSummary | null> {
  // end 截断可能把最后一行读成半截 JSON,parseJsonObject 解析失败会自然跳过。
  const input = createReadStream(file, { encoding: 'utf-8', end: SCAN_SUMMARY_MAX_BYTES - 1 });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const fallbackSessionId = sessionIdFromFilename(file);
  let sdkSessionId = fallbackSessionId;
  let title = '';
  let cwd = projectDirFromClaudeStorageDir(path.basename(path.dirname(file))) ?? '';
  let sawTopLevelEvent = false;
  let removedIdeContextWithoutTitle = false;
  let lineCount = 0;

  try {
    for await (const line of rl) {
      lineCount += 1;
      const obj = parseJsonObject(line);
      if (
        lineCount > SCAN_SUMMARY_MAX_LINES &&
        !removedIdeContextWithoutTitle &&
        !isIdeOnlyUserRecord(obj)
      ) {
        break;
      }
      if (!obj || obj.isSidechain === true) continue;
      const lineCwd = stringValue(obj.cwd);
      if (lineCwd) cwd = lineCwd;

      const type = stringValue(obj.type);
      if (type !== 'user' && type !== 'assistant') continue;
      sawTopLevelEvent = true;

      const lineSessionId = firstNonEmpty(stringValue(obj.sessionId), stringValue(obj.session_id));
      if (lineSessionId) sdkSessionId = lineSessionId;
      if (type === 'user' && !title && isRecord(obj.message)) {
        const content = obj.message.content;
        const text = extractUserText(content).trim();
        if (text) title = makeTitle(text);
        else if (hasCompleteIdeOpenedFileBlock(content)) removedIdeContextWithoutTitle = true;
      }
      // 需要的字段已齐,提前停读——大文件只消耗前几行。
      if (title) break;
    }
  } catch {
    /* 读取中途出错(文件被并发轮转等):按已读到的内容收尾 */
  } finally {
    rl.close();
    input.destroy();
  }

  if (!sawTopLevelEvent || !isLikelySessionId(sdkSessionId)) return null;
  return {
    sdkSessionId,
    title: title || 'Claude Code Session',
    cwd: cwd || os.homedir(),
    updatedAt: Math.floor(mtimeMs),
  };
}

export async function readClaudeCodeSessionSummary(file: string): Promise<ClaudeCodeSessionSummary | null> {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat) return null;

  const input = createReadStream(file, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const fallbackSessionId = sessionIdFromFilename(file);
  let sdkSessionId = fallbackSessionId;
  let title = '';
  let cwd = projectDirFromClaudeStorageDir(path.basename(path.dirname(file))) ?? '';
  let model = '';
  let permissionMode: PermissionMode = 'ask';
  let tokensUsed = 0;
  let createdAt = Number.POSITIVE_INFINITY;
  let updatedAt = 0;
  let sawTopLevelEvent = false;

  for await (const line of rl) {
    const obj = parseJsonObject(line);
    if (!obj || obj.isSidechain === true) continue;
    const lineCwd = stringValue(obj.cwd);
    if (lineCwd) cwd = lineCwd;

    const ts = timestampFromIso(stringValue(obj.timestamp));
    if (ts > 0) {
      createdAt = Math.min(createdAt, ts);
      updatedAt = Math.max(updatedAt, ts);
    }

    const type = stringValue(obj.type);
    if (type !== 'user' && type !== 'assistant') continue;
    sawTopLevelEvent = true;

    const lineSessionId = firstNonEmpty(stringValue(obj.sessionId), stringValue(obj.session_id));
    if (lineSessionId) sdkSessionId = lineSessionId;
    permissionMode = normalizePermissionMode(firstNonEmpty(stringValue(obj.permissionMode), permissionMode));

    if (type === 'user' && !title && isRecord(obj.message)) {
      const text = extractUserText(obj.message.content).trim();
      if (text) title = makeTitle(text);
    }
    if (type === 'assistant' && isRecord(obj.message)) {
      model = normalizeClaudeModel(firstNonEmpty(stringValue(obj.message.model), model));
      tokensUsed += usageTokenCount(obj.message.usage);
    }
  }

  if (!sawTopLevelEvent || !isLikelySessionId(sdkSessionId)) return null;
  const statMs = Math.floor(stat.mtimeMs);
  return {
    sdkSessionId,
    title: title || 'Claude Code Session',
    cwd: cwd || os.homedir(),
    model: model || 'claude-sonnet-4-6',
    permissionMode,
    tokensUsed,
    archived: false,
    createdAt: Number.isFinite(createdAt) ? createdAt : statMs,
    updatedAt: updatedAt > 0 ? Math.max(updatedAt, statMs) : statMs,
  };
}

async function upsertLocalSession(summary: ClaudeCodeSessionSummary): Promise<'inserted' | 'updated' | 'skipped'> {
  const existingBySdkRows = await getDbClient().query<{ id: string; updatedAt: number; status: string }>(`
    SELECT id, updated_at AS updatedAt, status
    FROM sessions
    WHERE agent_kind = 'cc' AND sdk_session_id = ?
  `, [summary.sdkSessionId]);
  // skip 只认「存活」的非本地行,与扫描侧(session-import 只看 status != 'deleted')
  // 对齐:分享导入的会话(UUID id)被软删后,残留行不该继续挡 CLI 导入——否则
  // 扫描重新出候选、点导入却静默无效(#599 幽灵候选在已删除场景的回归)。
  if (existingBySdkRows.some((row) => row.status !== 'deleted' && !row.id.startsWith(LOCAL_SESSION_ID_PREFIX))) {
    return 'skipped';
  }
  const existingBySdk = existingBySdkRows.find((row) => row.id.startsWith(LOCAL_SESSION_ID_PREFIX));

  const localId = existingBySdk?.id ?? `${LOCAL_SESSION_ID_PREFIX}${summary.sdkSessionId}`;
  const existingById = await getDbClient().queryOne<{ id: string }>(
    'SELECT id FROM sessions WHERE id = ? LIMIT 1',
    [localId],
  );
  const existed = !!existingBySdk || !!existingById;
  const result = await getDbClient().exec(`
    INSERT INTO sessions (
      id, title, working_dir, model, effort, permission_mode, status, sdk_session_id,
      total_token_usage, total_cost_usd, context_tokens, context_window, fast_mode,
      cleared_at, pinned_at, user_send_at, agent_kind, parent_session_id,
      forked_at_message_id, worktree_path, source, feishu_open_id, feishu_bot_app_id,
      used_project_context, extra_dirs, workspace_kind, created_at, updated_at
    )
    VALUES (
      ?, ?, ?, ?, 'high', ?, ?, ?,
      ?, 0, 0, 0, 0,
      NULL, NULL, ?, 'cc', NULL,
      NULL, NULL, 'desktop', NULL, NULL,
      0, '[]', 'project', ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      title = CASE WHEN sessions.updated_at <= excluded.updated_at THEN excluded.title ELSE sessions.title END,
      working_dir = CASE WHEN sessions.updated_at <= excluded.updated_at THEN excluded.working_dir ELSE sessions.working_dir END,
      workspace_kind = excluded.workspace_kind,
      model = CASE WHEN sessions.updated_at <= excluded.updated_at THEN excluded.model ELSE sessions.model END,
      permission_mode = CASE WHEN sessions.updated_at <= excluded.updated_at THEN excluded.permission_mode ELSE sessions.permission_mode END,
      sdk_session_id = excluded.sdk_session_id,
      total_token_usage = CASE WHEN sessions.updated_at <= excluded.updated_at THEN excluded.total_token_usage ELSE sessions.total_token_usage END,
      user_send_at = COALESCE(sessions.user_send_at, excluded.user_send_at),
      updated_at = MAX(sessions.updated_at, excluded.updated_at)
  `, [
    localId,
    summary.title,
    // 存储级归一(#537):CLI 转录里的 cwd 在 Windows 上是反斜杠,直接入库会与
    // sessions:create 归一后的正斜杠写法并存,同一物理目录裂成两种 workingDir。
    normalizeWorkingDirForStorage(summary.cwd) ?? summary.cwd,
    summary.model,
    summary.permissionMode,
    summary.archived ? 'archived' : 'active',
    summary.sdkSessionId,
    summary.tokensUsed,
    summary.updatedAt,
    summary.createdAt,
    summary.updatedAt,
  ]);
  if (!existed && result.changes > 0) return 'inserted';
  if (existed && result.changes > 0) return 'updated';
  return 'skipped';
}

async function readClaudeCodeMessages(
  file: string,
  sessionId: string,
  sdkSessionId: string,
  fallbackModel: string,
): Promise<ImportedClaudeMessage[]> {
  const input = createReadStream(file, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const out: ImportedClaudeMessage[] = [];
  let lineNo = 0;
  let sequence = 0;
  for await (const line of rl) {
    lineNo += 1;
    const rows = await parseClaudeCodeMessageLineForImport(line, lineNo, sessionId, sdkSessionId, fallbackModel);
    for (const row of rows) {
      sequence += 1;
      out.push({ ...row, createdAt: row.createdAt + sequence });
    }
  }
  return out;
}

export function parseClaudeCodeMessageLine(
  line: string,
  lineNo: number,
  sdkSessionId: string,
  fallbackModel: string,
): ImportedClaudeMessage[] {
  const obj = parseJsonObject(line);
  if (!obj || obj.isSidechain === true) return [];
  const type = stringValue(obj.type);
  if ((type !== 'user' && type !== 'assistant') || !isRecord(obj.message)) return [];

  const createdAt = timestampFromIso(stringValue(obj.timestamp)) || Date.now();
  if (type === 'user') {
    return parseUserLine(obj, lineNo, sdkSessionId, createdAt);
  }
  return parseAssistantLine(obj, lineNo, sdkSessionId, fallbackModel, createdAt);
}

async function parseClaudeCodeMessageLineForImport(
  line: string,
  lineNo: number,
  sessionId: string,
  sdkSessionId: string,
  fallbackModel: string,
): Promise<ImportedClaudeMessage[]> {
  const obj = parseJsonObject(line);
  if (!obj || obj.isSidechain === true) return [];
  const type = stringValue(obj.type);
  if ((type !== 'user' && type !== 'assistant') || !isRecord(obj.message)) return [];

  const createdAt = timestampFromIso(stringValue(obj.timestamp)) || Date.now();
  if (type === 'user') {
    return parseUserLineForImport(obj, lineNo, sessionId, sdkSessionId, createdAt);
  }
  return parseAssistantLine(obj, lineNo, sdkSessionId, fallbackModel, createdAt);
}

function parseUserLine(
  obj: Record<string, unknown>,
  lineNo: number,
  sdkSessionId: string,
  createdAt: number,
): ImportedClaudeMessage[] {
  const message = obj.message as Record<string, unknown>;
  const content = message.content;
  const out: ImportedClaudeMessage[] = [];
  let partIndex = 0;

  for (const result of extractToolResults(content)) {
    out.push({
      lineNo,
      partIndex: partIndex++,
      role: 'tool_result',
      content: result.text,
      toolUseId: result.toolUseId,
      agentMeta: agentMetaFromRecord(obj, sdkSessionId),
      createdAt,
    });
  }

  const text = extractUserText(content).trim();
  if (text) {
    out.push({
      lineNo,
      partIndex: partIndex++,
      role: 'user',
      content: text,
      toolUseId: null,
      agentMeta: agentMetaFromRecord(obj, sdkSessionId),
      createdAt,
    });
  }

  return out;
}

async function parseUserLineForImport(
  obj: Record<string, unknown>,
  lineNo: number,
  sessionId: string,
  sdkSessionId: string,
  createdAt: number,
): Promise<ImportedClaudeMessage[]> {
  const message = obj.message as Record<string, unknown>;
  const content = message.content;
  const out: ImportedClaudeMessage[] = [];
  let partIndex = 0;

  for (const result of extractToolResults(content)) {
    out.push({
      lineNo,
      partIndex: partIndex++,
      role: 'tool_result',
      content: result.text,
      toolUseId: result.toolUseId,
      agentMeta: agentMetaFromRecord(obj, sdkSessionId),
      createdAt,
    });
  }

  const userPartIndex = partIndex;
  const text = extractUserText(content).trim();
  const images = await extractClaudeUserImages(content, sessionId, lineNo, userPartIndex);
  if (text || images.length > 0) {
    out.push({
      lineNo,
      partIndex: partIndex++,
      role: 'user',
      content: importedUserContent(text, images),
      toolUseId: null,
      agentMeta: agentMetaFromRecord(obj, sdkSessionId),
      createdAt,
    });
  }

  return out;
}

function parseAssistantLine(
  obj: Record<string, unknown>,
  lineNo: number,
  sdkSessionId: string,
  fallbackModel: string,
  createdAt: number,
): ImportedClaudeMessage[] {
  const message = obj.message as Record<string, unknown>;
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const out: ImportedClaudeMessage[] = [];
  const meta = agentMetaFromAssistant(obj, sdkSessionId, fallbackModel);
  let partIndex = 0;

  for (const block of content) {
    if (!isRecord(block)) continue;
    const blockType = stringValue(block.type);
    if (blockType === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      out.push({
        lineNo,
        partIndex: partIndex++,
        role: 'assistant',
        content: block.text,
        toolUseId: null,
        agentMeta: meta,
        createdAt,
      });
    } else if (blockType === 'tool_use') {
      const toolUseId = stringValue(block.id);
      out.push({
        lineNo,
        partIndex: partIndex++,
        role: 'tool_use',
        content: {
          toolUseId,
          toolName: stringValue(block.name),
          input: block.input ?? null,
        },
        toolUseId: toolUseId || null,
        agentMeta: meta,
        createdAt,
      });
    } else if (blockType === 'thinking' && typeof block.thinking === 'string') {
      out.push({
        lineNo,
        partIndex: partIndex++,
        role: 'thinking',
        content: {
          text: block.thinking,
          durationMs: 0,
          isRedacted: false,
        },
        toolUseId: null,
        agentMeta: meta,
        createdAt,
      });
    } else if (blockType === 'redacted_thinking') {
      out.push({
        lineNo,
        partIndex: partIndex++,
        role: 'thinking',
        content: {
          text: '',
          durationMs: 0,
          isRedacted: true,
        },
        toolUseId: null,
        agentMeta: meta,
        createdAt,
      });
    }
  }
  return out;
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') {
    const text = stripCompleteIdeOpenedFileBlocks(content);
    return isSyntheticClaudeUserText(text) ? '' : text;
  }
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'tool_result') continue;
    if ((block.type === 'text' || block.type === 'input_text') && typeof block.text === 'string') {
      parts.push(stripCompleteIdeOpenedFileBlocks(block.text));
    }
  }
  return parts.join('\n\n');
}

/** Whether imported user content contains at least one removable IDE context block. */
function hasCompleteIdeOpenedFileBlock(content: unknown): boolean {
  if (typeof content === 'string') {
    return stripCompleteIdeOpenedFileBlocks(content) !== content;
  }
  if (!Array.isArray(content)) return false;
  return content.some((block) => (
    isRecord(block) &&
    (block.type === 'text' || block.type === 'input_text') &&
    typeof block.text === 'string' &&
    stripCompleteIdeOpenedFileBlocks(block.text) !== block.text
  ));
}

/** Whether a scan-limit boundary row is a removable IDE-only user record. */
function isIdeOnlyUserRecord(obj: Record<string, unknown> | null): boolean {
  if (!obj || obj.isSidechain === true || stringValue(obj.type) !== 'user' || !isRecord(obj.message)) {
    return false;
  }
  const content = obj.message.content;
  return !extractUserText(content).trim() && hasCompleteIdeOpenedFileBlock(content);
}

async function extractClaudeUserImages(
  content: unknown,
  sessionId: string,
  lineNo: number,
  partIndex: number,
): Promise<ImportedImageRef[]> {
  if (!Array.isArray(content)) return [];
  const out: ImportedImageRef[] = [];
  let imageIndex = 0;
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'image' || !isRecord(block.source)) continue;
    const source = block.source;
    if (stringValue(source.type) !== 'base64') continue;
    const mimeType = normalizeImageMime(firstNonEmpty(
      stringValue(source.media_type),
      stringValue(source.mime_type),
      stringValue(source.mediaType),
      stringValue(source.mimeType),
    ));
    const data = stringValue(source.data);
    if (!mimeType || !data) continue;
    const ref = await cacheImportedBase64Image({
      sessionId,
      source: 'claude',
      lineNo,
      partIndex,
      imageIndex,
      mimeType,
      base64Data: data,
    });
    imageIndex += 1;
    if (ref) out.push(ref);
  }
  return out;
}

function extractToolResults(content: unknown): Array<{ toolUseId: string; text: string }> {
  if (typeof content === 'string') {
    const taskResult = parseTaskNotification(content);
    return taskResult ? [taskResult] : [];
  }
  if (!Array.isArray(content)) return [];
  const out: Array<{ toolUseId: string; text: string }> = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_result') continue;
    const toolUseId = stringValue(block.tool_use_id);
    if (!toolUseId) continue;
    const text = extractToolResultText(block.content);
    if (text) out.push({ toolUseId, text });
  }
  return out;
}

function parseTaskNotification(content: string): { toolUseId: string; text: string } | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('<task-notification>')) return null;
  const toolUseId = extractXmlTag(trimmed, 'tool-use-id');
  if (!toolUseId) return null;
  const text = extractXmlTag(trimmed, 'result') || extractXmlTag(trimmed, 'summary') || trimmed;
  return { toolUseId, text };
}

function extractXmlTag(content: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`<${escaped}>([\\s\\S]*?)</${escaped}>`));
  return match?.[1]?.trim() ?? '';
}

function isSyntheticClaudeUserText(content: string): boolean {
  const trimmed = content.trimStart();
  return (
    trimmed.startsWith('<local-command-caveat>') ||
    trimmed.startsWith('<command-name>') ||
    trimmed.startsWith('<local-command-stdout>') ||
    trimmed.startsWith('<local-command-stderr>') ||
    trimmed.startsWith('<task-notification>')
  );
}

function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if ((block.type === 'text' || block.type === 'output_text') && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

function agentMetaFromRecord(
  obj: Record<string, unknown>,
  fallbackSessionId: string,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  const uuid = stringValue(obj.uuid);
  const isAssistant = stringValue(obj.type) === 'assistant';
  const sourceToolAssistantUuid = stringValue(obj.sourceToolAssistantUUID);
  // Claude transcript parentage and tool/subagent parentage are different graphs:
  // `parentUuid` / `parent_uuid` links adjacent JSONL records, while
  // `parent_tool_use_id` (and legacy sourceToolAssistantUUID) marks tool-owned
  // assistant output. Fork/rewind must not treat every transcript child as a
  // subagent message, so persist the two meanings separately.
  const transcriptParentUuid = firstNonEmpty(
    stringValue(obj.parentUuid),
    stringValue(obj.parent_uuid),
    stringValue(obj.logicalParentUuid),
    stringValue(obj.logical_parent_uuid),
    // Claude uses sourceToolAssistantUUID as the transcript-chain parent for
    // user/tool_result records, but as the tool-owned assistant marker for
    // assistant records. Keep those meanings separate in agentMeta.
    !isAssistant ? sourceToolAssistantUuid : '',
  );
  const parentUuid = firstNonEmpty(
    stringValue(obj.parent_tool_use_id),
    stringValue(obj.parentToolUseId),
    stringValue(obj.parentToolUseID),
    isAssistant ? sourceToolAssistantUuid : '',
  );
  const sdkSessionId = firstNonEmpty(stringValue(obj.sessionId), stringValue(obj.session_id), fallbackSessionId);
  if (uuid) meta.uuid = uuid;
  if (transcriptParentUuid) meta.transcriptParentUuid = transcriptParentUuid;
  if (parentUuid) meta.parentUuid = parentUuid;
  if (sdkSessionId) meta.sdkSessionId = sdkSessionId;
  return meta;
}

function agentMetaFromAssistant(
  obj: Record<string, unknown>,
  fallbackSessionId: string,
  fallbackModel: string,
): Record<string, unknown> {
  const meta = agentMetaFromRecord(obj, fallbackSessionId);
  const message = isRecord(obj.message) ? obj.message : {};
  const model = normalizeClaudeModel(firstNonEmpty(stringValue(message.model), fallbackModel));
  if (model) meta.model = model;
  const stopReason = firstNonEmpty(stringValue(message.stop_reason), stringValue(message.stopReason));
  if (stopReason) meta.stopReason = stopReason;
  const requestId = stringValue(message.id);
  if (requestId) meta.requestId = requestId;
  if (isRecord(message.usage)) {
    meta.usage = {
      inputTokens: numberOrUndefined(message.usage.input_tokens),
      outputTokens: numberOrUndefined(message.usage.output_tokens),
      cacheReadInputTokens: numberOrUndefined(message.usage.cache_read_input_tokens),
      cacheCreationInputTokens: numberOrUndefined(message.usage.cache_creation_input_tokens),
    };
  }
  return meta;
}

function usageTokenCount(usage: unknown): number {
  if (!isRecord(usage)) return 0;
  return (
    numberValue(usage.input_tokens) +
    numberValue(usage.output_tokens) +
    numberValue(usage.cache_read_input_tokens) +
    numberValue(usage.cache_creation_input_tokens)
  );
}

function normalizeClaudeModel(raw: string): string {
  const model = raw.trim();
  if (!model) return '';
  if (model.includes('opus-5')) return 'claude-opus-5';
  if (model.includes('opus-4-8')) return 'claude-opus-4-8';
  if (model.includes('opus-4-7')) return 'claude-opus-4-7';
  if (model.includes('opus-4-6')) return 'claude-opus-4-6';
  if (model.includes('fable-5')) return 'claude-fable-5';
  if (model.includes('haiku-4-5')) return 'claude-haiku-4-5';
  if (model.includes('sonnet-5')) return 'claude-sonnet-5';
  if (model.includes('sonnet-4-6')) return 'claude-sonnet-4-6';
  // 历史会话里的裸 'sonnet' 别名(修复前 toSdkModelString 的产物)实际命中的是 4.6。
  if (model.includes('sonnet')) return 'claude-sonnet-4-6';
  if (model.includes('haiku')) return 'claude-haiku-4-5';
  return model;
}

function normalizePermissionMode(raw: string): PermissionMode {
  if (
    raw === 'ask' ||
    raw === 'default' ||
    raw === 'acceptEdits' ||
    raw === 'plan' ||
    raw === 'auto' ||
    raw === 'bypassPermissions'
  ) {
    return raw;
  }
  return 'ask';
}

function makeTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Claude Code Session';
}

let claudeProjectDirByStorageName: Map<string, string> | null = null;

function projectDirFromClaudeStorageDir(storageName: string): string | null {
  if (!storageName) return null;
  const projects = readClaudeProjectDirByStorageName();
  return projects.get(storageName) ?? null;
}

function readClaudeProjectDirByStorageName(): Map<string, string> {
  if (claudeProjectDirByStorageName) return claudeProjectDirByStorageName;
  const out = new Map<string, string>();
  const configPath = path.join(os.homedir(), '.claude.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
    if (isRecord(parsed) && isRecord(parsed.projects)) {
      for (const projectPath of Object.keys(parsed.projects)) {
        out.set(claudeProjectStorageName(projectPath), projectPath);
      }
    }
  } catch {
    /* optional Claude Code project registry */
  }
  claudeProjectDirByStorageName = out;
  return out;
}

function claudeProjectStorageName(projectPath: string): string {
  return projectPath.replace(/[/:]/g, '-');
}

function sessionIdFromFilename(file: string): string {
  return path.basename(file, '.jsonl');
}

function isSubagentPath(file: string): boolean {
  return file.split(path.sep).includes('subagents');
}

function isLikelySessionId(id: string): boolean {
  return /^[0-9a-fA-F-]{20,}$/.test(id);
}

function timestampFromIso(raw: string): number {
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : 0;
}

function parseJsonObject(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function firstNonEmpty(...values: string[]): string {
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function numberOrUndefined(value: unknown): number | undefined {
  const n = numberValue(value);
  return n > 0 ? n : undefined;
}
