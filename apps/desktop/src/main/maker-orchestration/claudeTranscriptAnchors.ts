import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROJECT_KEY_MAX_LENGTH = 200;
const SYNTHETIC_BLOCK_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-0{10}\d{2}$/i;
const MAX_SCAN_DEPTH = 4;
const TRANSCRIPT_PATH_CACHE_TTL_MS = 60_000;
const TRANSCRIPT_MISS_CACHE_TTL_MS = 5_000;
const MAX_TRANSCRIPT_PATH_CACHE_ENTRIES = 500;

interface TranscriptPathCacheEntry {
  filePath: string | null;
  checkedAt: number;
}

const transcriptPathCache = new Map<string, TranscriptPathCacheEntry>();
const transcriptPathInFlight = new Map<string, Promise<string | null>>();

type JsonObject = Record<string, unknown>;

export interface ClaudeTranscriptAnchorMeta {
  uuid?: string;
  parentUuid?: string;
  transcriptParentUuid?: string;
  requestId?: string;
  sdkSessionId?: string;
}

export interface ClaudeTranscriptEntry {
  uuid: string;
  type: string;
  parentUuid?: string;
  toolParentUuid?: string;
  requestId?: string;
}

export interface ClaudeTranscriptAnchorIndex {
  filePath: string;
  byUuid: Map<string, ClaudeTranscriptEntry>;
  assistantByUuid: Map<string, ClaudeTranscriptEntry>;
  assistantByRequestId: Map<string, ClaudeTranscriptEntry>;
}

export interface LoadClaudeTranscriptAnchorIndexOptions {
  sdkSessionId: string;
  workingDir?: string | null;
  claudeConfigDir?: string;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function sanitizeClaudeProjectKey(cwd: string): string {
  const key = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return key.length <= PROJECT_KEY_MAX_LENGTH ? key : key.slice(0, PROJECT_KEY_MAX_LENGTH);
}

async function normalizedExistingPath(input: string): Promise<string> {
  try {
    return (await fs.realpath(input)).normalize('NFC');
  } catch {
    return input.normalize('NFC');
  }
}

async function fileExists(file: string): Promise<boolean> {
  const stat = await fs.stat(file).catch(() => null);
  return Boolean(stat?.isFile() && stat.size > 0);
}

async function scanProjectDirsForSession(projectsRoot: string, filename: string): Promise<string | null> {
  const visit = async (dir: string, depth: number): Promise<string | null> => {
    if (depth > MAX_SCAN_DEPTH) return null;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if ((entry.isFile() || entry.isSymbolicLink()) && entry.name === filename) {
        if (await fileExists(full)) return full;
      }
      if ((entry.isDirectory() || entry.isSymbolicLink()) && entry.name !== 'subagents') {
        const found = await visit(full, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(projectsRoot, 0);
}

/**
 * JSONL 路径发现按 config root + workingDir + sdkSessionId 单飞并短时缓存。直接路径仍优先；
 * 命中缓存每次先复核文件仍存在，删除/移动后立即回退扫描，不把过期绝对路径返回给 fork/rewind。
 */
export async function findClaudeSessionJsonl(
  sdkSessionId: string,
  workingDir: string | null | undefined,
  projectsRoot: string,
  now = Date.now,
): Promise<string | null> {
  const key = `${projectsRoot}\0${workingDir ?? ''}\0${sdkSessionId}`;

  // Direct paths are cheap to check and authoritative whenever they appear;
  // never let a cached scan result mask a transcript restored into workingDir.
  if (workingDir) {
    const normalized = await normalizedExistingPath(workingDir);
    const directPath = path.join(projectsRoot, sanitizeClaudeProjectKey(normalized), `${sdkSessionId}.jsonl`);
    if (await fileExists(directPath)) return directPath;
  }

  const current = transcriptPathCache.get(key);
  const ttlMs = current?.filePath ? TRANSCRIPT_PATH_CACHE_TTL_MS : TRANSCRIPT_MISS_CACHE_TTL_MS;
  if (current && now() - current.checkedAt < ttlMs) {
    if (!current.filePath || await fileExists(current.filePath)) return current.filePath;
    transcriptPathCache.delete(key);
  }
  const existing = transcriptPathInFlight.get(key);
  if (existing) return existing;

  const task = scanProjectDirsForSession(projectsRoot, `${sdkSessionId}.jsonl`)
    .then((filePath) => {
      transcriptPathCache.set(key, { filePath, checkedAt: now() });
      while (transcriptPathCache.size > MAX_TRANSCRIPT_PATH_CACHE_ENTRIES) {
        const oldestKey = transcriptPathCache.keys().next().value;
        if (oldestKey === undefined) break;
        transcriptPathCache.delete(oldestKey);
      }
      return filePath;
    })
    .finally(() => {
      if (transcriptPathInFlight.get(key) === task) transcriptPathInFlight.delete(key);
    });
  transcriptPathInFlight.set(key, task);
  return task;
}

export function __resetClaudeTranscriptPathCacheForTesting(): void {
  transcriptPathCache.clear();
  transcriptPathInFlight.clear();
}

function uniqueTruthy(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

/**
 * Claude CLI 配置目录候选(优先级序):显式 CLAUDE_CONFIG_DIR → dev 多实例的
 * XDT_USER_DATA_DIR/claude-home(auth-adapters 给 CLI 子进程注入的同款重定向)
 * → 默认 ~/.claude。desktop 侧读写 CLI 转录的模块应经此解析,不要各自硬编码
 * ~/.claude(多实例下会找错根目录)。
 */
export function defaultClaudeConfigDirCandidates(): string[] {
  return uniqueTruthy([
    process.env.CLAUDE_CONFIG_DIR,
    process.env.XDT_USER_DATA_DIR
      ? path.join(process.env.XDT_USER_DATA_DIR, 'claude-home')
      : undefined,
    path.join(os.homedir(), '.claude'),
  ]);
}

function parseTranscriptEntry(line: string): ClaudeTranscriptEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.isSidechain === true) return null;
  const uuid = stringValue(parsed.uuid);
  if (!uuid) return null;
  const type = stringValue(parsed.type) ?? '';
  const sourceToolAssistantUuid = stringValue(parsed.sourceToolAssistantUUID);
  const parentUuid =
    stringValue(parsed.parentUuid) ??
    stringValue(parsed.parent_uuid) ??
    stringValue(parsed.logicalParentUuid) ??
    stringValue(parsed.logical_parent_uuid) ??
    sourceToolAssistantUuid;
  const toolParentUuid =
    stringValue(parsed.parent_tool_use_id) ??
    stringValue(parsed.parentToolUseId) ??
    stringValue(parsed.parentToolUseID) ??
    (type === 'assistant' ? sourceToolAssistantUuid : undefined);
  const message = isRecord(parsed.message) ? parsed.message : undefined;
  const requestId = stringValue(message?.id);
  return {
    uuid,
    type,
    ...(parentUuid ? { parentUuid } : {}),
    ...(toolParentUuid ? { toolParentUuid } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

function isTopLevelAssistant(entry: ClaudeTranscriptEntry): boolean {
  return entry.type === 'assistant' && !entry.toolParentUuid;
}

export async function loadClaudeTranscriptAnchorIndex(
  options: LoadClaudeTranscriptAnchorIndexOptions,
): Promise<ClaudeTranscriptAnchorIndex | null> {
  if (!options.sdkSessionId) return null;
  const claudeConfigDirs = options.claudeConfigDir
    ? [options.claudeConfigDir]
    : defaultClaudeConfigDirCandidates();
  let filePath: string | null = null;
  for (const claudeConfigDir of claudeConfigDirs) {
    filePath = await findClaudeSessionJsonl(
      options.sdkSessionId,
      options.workingDir,
      path.join(claudeConfigDir, 'projects'),
    );
    if (filePath) break;
  }
  if (!filePath) return null;

  const text = await fs.readFile(filePath, 'utf-8');
  const byUuid = new Map<string, ClaudeTranscriptEntry>();
  const assistantByUuid = new Map<string, ClaudeTranscriptEntry>();
  const assistantByRequestId = new Map<string, ClaudeTranscriptEntry>();
  for (const line of text.split('\n')) {
    const entry = parseTranscriptEntry(line);
    if (!entry) continue;
    byUuid.set(entry.uuid, entry);
    if (isTopLevelAssistant(entry)) {
      assistantByUuid.set(entry.uuid, entry);
      if (entry.requestId) assistantByRequestId.set(entry.requestId, entry);
    }
  }

  return { filePath, byUuid, assistantByUuid, assistantByRequestId };
}

export function parseClaudeAgentMeta(raw: string | null): ClaudeTranscriptAnchorMeta {
  if (!raw || raw === 'null') return {};
  try {
    const parsed = JSON.parse(raw) as JsonObject;
    return {
      uuid: stringValue(parsed.uuid),
      parentUuid: stringValue(parsed.parentUuid),
      transcriptParentUuid: stringValue(parsed.transcriptParentUuid),
      requestId: stringValue(parsed.requestId),
      sdkSessionId: stringValue(parsed.sdkSessionId),
    };
  } catch {
    return {};
  }
}

export function isSyntheticClaudeBlockUuid(uuid: string | undefined): boolean {
  return Boolean(uuid && SYNTHETIC_BLOCK_UUID_RE.test(uuid));
}

export function resolveClaudeForkAssistantAnchor(
  meta: ClaudeTranscriptAnchorMeta,
  index: ClaudeTranscriptAnchorIndex | null,
): string | undefined {
  if (index) {
    // The transcript is authoritative when available. Older imports wrote the
    // JSONL transcript parent into agentMeta.parentUuid, so checking that field
    // first incorrectly rejects every ordinary imported assistant. The index's
    // assistant maps already exclude entries with a real toolParentUuid, which
    // preserves the subagent guard while repairing existing SQLite rows without
    // a data migration or re-import.
    if (meta.uuid && index.assistantByUuid.has(meta.uuid)) return meta.uuid;
    if (meta.requestId) return index.assistantByRequestId.get(meta.requestId)?.uuid;
    return undefined;
  }
  // Without the source transcript we cannot safely distinguish a legacy
  // transcript parent from a real tool parent. Keep the conservative behavior.
  if (meta.parentUuid) return undefined;
  return isSyntheticClaudeBlockUuid(meta.uuid) ? undefined : meta.uuid;
}

export function resolveClaudeRewindAssistantAnchor(
  userUuid: string | undefined,
  index: ClaudeTranscriptAnchorIndex | null,
): string | undefined {
  return resolveClaudeRewindAssistantEntry(userUuid, index)?.uuid;
}

export function resolveClaudeRewindAssistantEntry(
  userUuid: string | undefined,
  index: ClaudeTranscriptAnchorIndex | null,
): ClaudeTranscriptEntry | undefined {
  if (!userUuid || !index || !index.byUuid.has(userUuid)) return undefined;
  const seen = new Set<string>();
  let cursor = index.byUuid.get(userUuid)?.parentUuid;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const entry = index.byUuid.get(cursor);
    if (!entry) return undefined;
    const assistant = index.assistantByUuid.get(entry.uuid);
    if (assistant) return assistant;
    cursor = entry.parentUuid;
  }
  return undefined;
}
