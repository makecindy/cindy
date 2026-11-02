/**
 * Codex 来源适配器（原生续做）。
 *
 * - 发现：所有外部 CODEX_HOME（~/.codex、Codex 应用目录、旧品牌目录），不含 Cindy 自己的 codex-home；
 * - 历史文件：`rollout-*.jsonl` 或被 Codex 压缩过的 `rollout-*.jsonl.zst`。状态库里记的路径
 *   可能还是 `.jsonl` 而磁盘上只剩 `.zst`，一律以磁盘实际文件为准；
 * - 识别：文件名 `rollout-<时间>-<threadId>[_<rolloutId>].jsonl[.zst]`，threadId 取第一段 UUID；
 * - 分页历史：session_meta.history_base 指向祖先 rollout 的前若干字节，显示与续做都要带上；
 * - 内部会话（自动审查、子 Agent）只计数，随所属任务一起；
 * - 复制：解压后写进 Cindy 的 codex-home（状态行、rollout、祖先），原文件不动。
 */

import { createReadStream, promises as fsp } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { createZstdDecompress } from 'node:zlib';
import type { Readable } from 'node:stream';

import type Database from 'better-sqlite3';

import { finalizeCodexCitationText } from '@cindy/maker-core';

import { createBetterSqliteDatabase } from '../../localDb/betterSqliteFactory.js';
import {
  discoverExternalCodexHomesSync,
  dumpCodexThreadStateRows,
  findLatestStateDb,
  getDesktopCodexHome,
  importSharedCodexThread,
  normalizeThreadRow,
  readProjectlessThreadIds,
  readRawThreadRow,
  readSessionIndex,
  type CodexThreadSummary,
  type SqlRow,
} from '../../maker-host/codex-local-sessions.js';
import { stripCompleteIdeOpenedFileBlocks } from '../../maker-host/imported-user-content.js';
import { writeMigratedTranscript } from '../../session-share/migrationTranscriptWriter.js';
import { isZstdPath, parseJsonLine, readFirstLine, readLines } from '../lineReader.js';
import type {
  NativeMaterialization,
  NormalizedMessage,
  ReadContext,
  SourceAdapter,
  SourceListResult,
  SourceSession,
  VerifyOutcome,
} from '../types.js';
import {
  blocksText,
  firstNonEmpty,
  hasCindyInjection,
  isInjectedContextText,
  isRecord,
  makeTitle,
  parseDataUrl,
  parseMaybeJson,
  str,
  stringifyOutput,
  stripCindyInjection,
  stripSystemReminders,
  toMs,
  walkFiles,
} from './common.js';

/**
 * 内部会话：自动审查、子 Agent、Agent 自己创建的线程、exec。来自 VS Code 插件、语音对话的
 * 线程（thread_source = vscode / realtime_voice / voice_chat）是用户自己的任务，照常列出。
 */
const INTERNAL_THREAD_SOURCES = new Set(['guardian_review', 'subagent', 'agent_created_thread', 'exec', 'codex_exec']);

export function isInternalCodexThread(row: Record<string, unknown>): boolean {
  const threadSource = str(row.thread_source).trim().toLowerCase();
  if (INTERNAL_THREAD_SOURCES.has(threadSource)) return true;
  const source = `${str(row.source)} ${str(row.originator)}`.toLowerCase();
  return /"?(subagent|guardian|codex_exec)"?/.test(source) || /(^|[\s"])exec("|\s|$)/.test(source);
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROLLOUT_NAME = new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${UUID})(?:_(${UUID}))?\\.jsonl(?:\\.zst)?$`, 'i');

interface CodexLocator {
  home: string;
  dbPath: string | null;
  /** 磁盘上实际存在的 rollout（可能是 .zst）。 */
  file: string;
  threadId: string;
  model: string;
  tokensUsed: number;
}

export function codexRolloutIdentity(file: string): { threadId: string; rolloutId: string } | null {
  const m = path.basename(file).match(ROLLOUT_NAME);
  return m ? { threadId: m[1]!.toLowerCase(), rolloutId: (m[2] ?? m[1])!.toLowerCase() } : null;
}

async function collectRollouts(home: string): Promise<Array<{ file: string; mtimeMs: number; size: number }>> {
  const match = (name: string) => ROLLOUT_NAME.test(name);
  const [live, archived] = await Promise.all([
    walkFiles(path.join(home, 'sessions'), match),
    walkFiles(path.join(home, 'archived_sessions'), match),
  ]);
  return [...live, ...archived];
}

/** 以磁盘实际文件为准解析一条线程的 rollout：先原路径，再 .zst，再按 threadId 在文件列表里找。 */
function resolveRolloutFile(
  recorded: string,
  threadId: string,
  byThread: Map<string, Array<{ file: string; mtimeMs: number; size: number }>>,
): { file: string; size: number } | null {
  const candidates = byThread.get(threadId.toLowerCase()) ?? [];
  for (const p of [recorded, recorded ? `${recorded}.zst` : '']) {
    if (!p) continue;
    const hit = candidates.find((c) => path.resolve(c.file) === path.resolve(p));
    if (hit) return { file: hit.file, size: hit.size };
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.size > 0) return { file: p, size: st.size };
    } catch { /* fall through */ }
  }
  // 同一线程可能有多个分页文件；取最近写入的、非空的那个。
  const best = candidates.filter((c) => c.size > 0).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  return best ? { file: best.file, size: best.size } : null;
}

function readThreadRows(dbPath: string): SqlRow[] {
  let db: Database.Database | null = null;
  try {
    db = createBetterSqliteDatabase(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 3000');
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='threads'").get();
    if (!exists) return [];
    return db.prepare('SELECT * FROM threads').all() as SqlRow[];
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/** 没有状态库行的 rollout：从 session_meta 与前若干行补出摘要。 */
async function summaryFromRollout(file: string, mtimeMs: number): Promise<{
  threadId: string; cwd: string; createdAt: number; title: string; internal: boolean; conversation: boolean; cindy: boolean;
} | null> {
  let threadId = '';
  let cwd = '';
  let createdAt = 0;
  let title = '';
  let internal = false;
  // 只有语音/实时事件、没有任何对话内容的记录不列出；分页历史的对话在祖先里。
  let conversation = false;
  let cindy = false;
  let n = 0;
  for await (const line of readLines(file, { maxBytes: 512 * 1024 })) {
    n += 1;
    const obj = parseJsonLine(line);
    if (!obj) continue;
    const payload = isRecord(obj.payload) ? obj.payload : {};
    if (obj.type === 'session_meta') {
      threadId = threadId || str(payload.id);
      cwd = cwd || str(payload.cwd);
      createdAt = createdAt || toMs(payload.timestamp) || toMs(obj.timestamp);
      if (payload.history_mode === 'paginated' && isRecord(payload.history_base)) conversation = true;
      if (isInternalCodexThread({
        thread_source: payload.thread_source,
        source: JSON.stringify(payload.source ?? ''),
        originator: str(payload.originator),
      })) internal = true;
    } else if (obj.type === 'response_item') {
      if (parseCodexRolloutLine(obj, String(n), threadId).length > 0) conversation = true;
      if (payload.type === 'message' && payload.role === 'user') {
        const raw = blocksText(payload.content);
        if (hasCindyInjection(raw)) cindy = true;
        const text = stripCindyInjection(raw).trim();
        if (!title && text && !isInjectedContextText(text)) title = makeTitle(text, '');
      }
    }
    if ((threadId && title && conversation) || n > 400) break;
  }
  if (!threadId) return null;
  return { threadId: threadId.toLowerCase(), cwd, createdAt: createdAt || mtimeMs, title, internal, conversation, cindy };
}

async function list(): Promise<SourceListResult> {
  const sessions = new Map<string, SourceSession>();
  let internalCount = 0;
  let unreadableCount = 0;
  const internalIds = new Set<string>();
  for (const home of discoverExternalCodexHomesSync()) {
    const projectless = readProjectlessThreadIds(home);
    const index = readSessionIndex(home);
    const files = await collectRollouts(home);
    const byThread = new Map<string, Array<{ file: string; mtimeMs: number; size: number }>>();
    for (const f of files) {
      const id = codexRolloutIdentity(f.file)?.threadId;
      if (!id) continue;
      const list = byThread.get(id) ?? [];
      list.push(f);
      byThread.set(id, list);
    }
    const seen = new Set<string>();
    const dbPath = findLatestStateDb(home);
    let rows: SqlRow[] = [];
    if (dbPath) {
      try {
        rows = readThreadRows(dbPath);
      } catch {
        rows = [];
      }
    }
    const add = (thread: CodexThreadSummary, file: { file: string; size: number }, ranByCindy = false) => {
      const id = thread.threadId.toLowerCase();
      const existing = sessions.get(id);
      if (existing && existing.updatedAt >= thread.updatedAt) return;
      const locator: CodexLocator = {
        home,
        dbPath: thread.sourceDbPath,
        file: file.file,
        threadId: thread.threadId,
        model: thread.model,
        tokensUsed: thread.tokensUsed,
      };
      sessions.set(id, {
        source: 'codex',
        sourceSessionId: id,
        title: thread.title,
        cwd: thread.cwd || null,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        archived: thread.archived,
        sizeBytes: file.size,
        locator: JSON.stringify(locator),
        dialogue: thread.workspaceKind === 'dialogue',
        ...(ranByCindy ? { ranByCindy: true } : {}),
      });
    };
    for (const row of rows) {
      const id = str(row.id).toLowerCase();
      if (!id) continue;
      seen.add(id);
      if (isInternalCodexThread(row)) {
        if (!internalIds.has(id)) { internalIds.add(id); internalCount += 1; }
        continue;
      }
      const thread = normalizeThreadRow(home, dbPath, row, projectless, index);
      if (!thread) continue;
      const file = resolveRolloutFile(thread.rolloutPath, id, byThread);
      if (!file) {
        unreadableCount += 1;
        continue;
      }
      // 状态库里没有任何提问的线程（例如只开过语音）：确认记录里也没有对话再跳过。
      if (!str(row.first_user_message).trim() && !str(row.title).trim()) {
        const summary = await summaryFromRollout(file.file, Date.now()).catch(() => null);
        if (summary && !summary.conversation) continue;
      }
      const firstMessage = str(row.first_user_message);
      const ranByCindy = hasCindyInjection(firstMessage) || hasCindyInjection(str(row.title));
      const title = ranByCindy
        ? makeTitle(firstNonEmpty(thread.title.startsWith('[UI language]') ? '' : stripCindyInjection(thread.title), stripCindyInjection(firstMessage)), 'Codex Session')
        : thread.title;
      add({ ...thread, title }, file, ranByCindy);
    }
    // 没有状态库行的 rollout（旧版 Codex、或状态库丢失）。
    for (const [id, list] of byThread) {
      if (seen.has(id)) continue;
      const newest = [...list].filter((f) => f.size > 0).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
      if (!newest) continue;
      const summary = await summaryFromRollout(newest.file, newest.mtimeMs).catch(() => null);
      if (!summary) { unreadableCount += 1; continue; }
      if (summary.internal) {
        if (!internalIds.has(id)) { internalIds.add(id); internalCount += 1; }
        continue;
      }
      if (!summary.conversation) continue;
      const indexEntry = index.get(id);
      add({
        threadId: summary.threadId,
        sourceHome: home,
        sourceDbPath: null,
        rolloutPath: newest.file,
        title: firstNonEmpty(indexEntry?.customTitle, summary.title, 'Codex Session'),
        cwd: summary.cwd,
        workspaceKind: projectless.has(summary.threadId) ? 'dialogue' : 'project',
        model: '',
        effort: 'high',
        permissionMode: 'ask',
        tokensUsed: 0,
        createdAt: summary.createdAt,
        updatedAt: Math.max(newest.mtimeMs, indexEntry?.updatedAt ?? 0),
        archived: newest.file.includes(`${path.sep}archived_sessions${path.sep}`),
      }, newest, summary.cindy);
    }
  }
  return { sessions: [...sessions.values()], internalCount, unreadableCount };
}

interface HistoryBase { rolloutId: string; endByteOffset: number }

function historyBaseOf(firstLine: string | null): HistoryBase | null {
  const obj = firstLine ? parseJsonLine(firstLine) : null;
  if (!obj || obj.type !== 'session_meta' || !isRecord(obj.payload)) return null;
  if (obj.payload.history_mode !== 'paginated' || !isRecord(obj.payload.history_base)) return null;
  const base = obj.payload.history_base;
  const id = str(base.thread_id).toLowerCase();
  const end = typeof base.end_byte_offset === 'number' ? base.end_byte_offset : 0;
  if (!new RegExp(`^${UUID}$`, 'i').test(id) || !Number.isSafeInteger(end) || end <= 0) return null;
  return { rolloutId: id, endByteOffset: end };
}

/** 从 home 里按 rolloutId 找祖先文件（.jsonl 或 .jsonl.zst）。 */
async function findAncestor(home: string, rolloutId: string): Promise<string | null> {
  const files = await collectRollouts(home);
  const hits = files.filter((f) => codexRolloutIdentity(f.file)?.rolloutId === rolloutId && f.size > 0);
  hits.sort((a, b) => Number(isZstdPath(a.file)) - Number(isZstdPath(b.file)));
  return hits[0]?.file ?? null;
}

/** 祖先链：从最老到最新，每段带引用的字节上限。 */
async function ancestorChain(home: string, file: string): Promise<Array<{ file: string; maxBytes: number }>> {
  const chain: Array<{ file: string; maxBytes: number }> = [];
  const seen = new Set<string>();
  let base = historyBaseOf(await readFirstLine(file));
  while (base) {
    if (seen.has(base.rolloutId) || chain.length > 64) throw new Error('cyclic Codex history ancestry');
    seen.add(base.rolloutId);
    const ancestor = await findAncestor(home, base.rolloutId);
    if (!ancestor) throw new Error('missing Codex history ancestor');
    chain.unshift({ file: ancestor, maxBytes: base.endByteOffset });
    base = historyBaseOf(await readFirstLine(ancestor));
  }
  return chain;
}

/** 一行 rollout → Cindy 消息。只认 response_item；event_msg 是同一内容的另一种投影，跳过避免重复。 */
export function parseCodexRolloutLine(obj: Record<string, unknown>, key: string, threadId: string): NormalizedMessage[] {
  if (obj.type !== 'response_item' || !isRecord(obj.payload)) return [];
  const p = obj.payload;
  const createdAt = toMs(obj.timestamp) || Date.now();
  const agentMeta = { sdkSessionId: threadId };
  const type = str(p.type);
  if (type === 'message') {
    const role = p.role === 'user' ? 'user' : p.role === 'assistant' ? 'assistant' : null;
    if (!role) return [];
    const raw = blocksText(p.content);
    const text = (role === 'user' ? stripSystemReminders(stripCindyInjection(stripCompleteIdeOpenedFileBlocks(raw))) : finalizeCodexCitationText(raw)).trim();
    if (role === 'user' && isInjectedContextText(text)) return [];
    const images = role === 'user' && Array.isArray(p.content)
      ? p.content.flatMap((b) => {
        if (!isRecord(b) || b.type !== 'input_image') return [];
        const parsed = parseDataUrl(str(b.image_url));
        return parsed ? [parsed] : [];
      })
      : [];
    if (!text && images.length === 0) return [];
    return [{ key, role, content: text, images: images.length ? images : undefined, agentMeta, createdAt }];
  }
  if (type === 'function_call' || type === 'custom_tool_call' || type === 'local_shell_call' || type === 'web_search_call') {
    const toolUseId = firstNonEmpty(p.call_id, p.id) || `${key}-call`;
    const toolName = type === 'local_shell_call' ? 'shell' : type === 'web_search_call' ? 'web_search' : str(p.name) || 'tool';
    const input = type === 'function_call' ? parseMaybeJson(p.arguments)
      : type === 'custom_tool_call' ? parseMaybeJson(p.input)
        : (p.action ?? null);
    return [{ key: `${key}-t`, role: 'tool_use', content: { toolUseId, toolName, input }, toolUseId, agentMeta, createdAt }];
  }
  if (type === 'function_call_output' || type === 'custom_tool_call_output') {
    const toolUseId = str(p.call_id);
    if (!toolUseId) return [];
    return [{ key: `${key}-r`, role: 'tool_result', content: stringifyOutput(p.output), toolUseId, agentMeta, createdAt }];
  }
  if (type === 'reasoning') {
    const summary = Array.isArray(p.summary)
      ? p.summary.map((s) => (isRecord(s) ? str(s.text) : '')).filter(Boolean).join('\n\n')
      : '';
    if (!summary.trim()) return [];
    return [{ key: `${key}-k`, role: 'thinking', content: { text: summary, durationMs: 0, isRedacted: false }, agentMeta, createdAt }];
  }
  return [];
}

async function* read(session: SourceSession, ctx: ReadContext): AsyncIterable<NormalizedMessage> {
  const loc = JSON.parse(session.locator) as CodexLocator;
  const chain = await ancestorChain(loc.home, loc.file);
  for (const [depth, part] of chain.entries()) {
    let lineNo = 0;
    for await (const line of readLines(part.file, { maxBytes: part.maxBytes, signal: ctx.signal, onBytes: ctx.onBytes })) {
      lineNo += 1;
      const obj = parseJsonLine(line);
      if (obj) yield* parseCodexRolloutLine(obj, `a${depth}-${lineNo}`, loc.threadId);
    }
  }
  let lineNo = 0;
  for await (const line of readLines(loc.file, { signal: ctx.signal, onBytes: ctx.onBytes })) {
    lineNo += 1;
    const obj = parseJsonLine(line);
    // 行键与旧导入（codex-import:<id>:<行号>）一致，存量任务补齐时不会重复。
    if (obj) yield* parseCodexRolloutLine(obj, String(lineNo), loc.threadId);
  }
}

function openPlain(file: string): Readable {
  const raw = createReadStream(file);
  if (!isZstdPath(file)) return raw;
  const z = createZstdDecompress();
  raw.on('error', (err) => z.destroy(err));
  return raw.pipe(z);
}

/** 复制（必要时解压）到目标；非压缩文件优先用写时复制克隆，不实际多占磁盘。 */
export async function copyNativeFile(source: string, target: string): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  if (!isZstdPath(source)) {
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
    try {
      await fsp.copyFile(source, temp, fs.constants.COPYFILE_FICLONE);
      await fsp.rename(temp, target).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPERM' && error.code !== 'EEXIST') throw error;
        await fsp.rm(target, { force: true });
        await fsp.rename(temp, target);
      });
    } finally {
      await fsp.rm(temp, { force: true });
    }
    return;
  }
  await writeMigratedTranscript(openPlain(source), target, null);
}

/**
 * 把 Cindy 副本的 state 行改成 Cindy 恢复时的 provider 身份。已经是 Cindy 身份
 * （cindy_*）的线程由 Cindy 自己切换模型时处理，不在这里改。
 */
function retagThreadProvider(dbPath: string | null, threadId: string, modelProvider: string): void {
  if (!dbPath) return;
  let db: Database.Database | null = null;
  try {
    db = createBetterSqliteDatabase(dbPath);
    db.pragma('busy_timeout = 5000');
    const columns = (db.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>).map((c) => c.name);
    if (!columns.includes('model_provider')) return;
    db.prepare("UPDATE threads SET model_provider = ? WHERE id = ? AND model_provider NOT LIKE 'cindy\\_%' ESCAPE '\\'")
      .run(modelProvider, threadId);
  } finally {
    db?.close();
  }
}

async function materialize(session: SourceSession, ctx: ReadContext): Promise<NativeMaterialization> {
  const loc = JSON.parse(session.locator) as CodexLocator;
  const desktopHome = getDesktopCodexHome();
  const desktopDb = findLatestStateDb(desktopHome);
  const existing = desktopDb ? readRawThreadRow(desktopDb, loc.threadId) : null;
  const existingRollout = existing ? str(existing.rollout_path) : '';
  // 外部 Codex 记录的是它自己的 provider（如 openai），Cindy 按路由的身份恢复，不一致会被拒绝。
  // 按需加载：这两个模块加载时会读应用路径，扫描与读取不需要它们。
  const [{ codexImportedThreadModelProviderId }, { getCodexProxyAuthInjectionState }] = await Promise.all([
    import('../../maker-host/codex-credential-switch.js'),
    import('../../maker-host/codex-proxy-host.js'),
  ]);
  const modelProvider = codexImportedThreadModelProviderId({
    providerId: ctx.route?.providerId ?? null,
    model: ctx.route?.model ?? loc.model ?? '',
    codexAuthInjection: getCodexProxyAuthInjectionState(),
  });
  // Cindy 里已经有这个线程（旧版导入后续做过）：保留 Cindy 自己的副本，不用外部原文覆盖。
  if (existingRollout && fs.existsSync(existingRollout) && fs.statSync(existingRollout).size > 0) {
    retagThreadProvider(desktopDb, loc.threadId, modelProvider);
    return { sdkSessionId: loc.threadId, model: loc.model || undefined, tokensUsed: loc.tokensUsed };
  }
  const header = parseJsonLine((await readFirstLine(loc.file)) ?? '');
  const headerPayload = header && isRecord(header.payload) ? header.payload : null;
  // 分页历史的字节位置归原生线程库管，只改 state 行，不重写文件。
  const rewriteHeader = !!headerPayload && headerPayload.history_mode !== 'paginated' &&
    str(headerPayload.model_provider) !== modelProvider && !str(headerPayload.model_provider).startsWith('cindy_');
  const stateRows = await dumpCodexThreadStateRows(loc.threadId, { sqliteHome: loc.home, rolloutPath: loc.file });
  const filename = path.basename(loc.file).replace(/\.zst$/, '');
  const result = await importSharedCodexThread({
    threadId: loc.threadId,
    stateRows: {
      threads: stateRows.threads,
      threadDynamicTools: stateRows.threadDynamicTools,
      threadSpawnEdges: stateRows.threadSpawnEdges,
    },
    rolloutBuffer: null,
    writeRollout: (target) => rewriteHeader
      ? writeMigratedTranscript(openPlain(loc.file), target, { agent: 'codex-provider', modelProvider })
      : copyNativeFile(loc.file, target),
    rolloutFilename: filename,
    newCwd: session.cwd ?? '',
    title: session.title,
    updatedAt: session.updatedAt,
  });
  if (!result.rolloutPath) throw new Error('Codex rollout could not be placed');
  retagThreadProvider(findLatestStateDb(desktopHome), loc.threadId, modelProvider);
  // 分页历史的祖先一并放进 Cindy 的 codex-home（保持原相对路径，去掉 .zst）。
  for (const part of await ancestorChain(loc.home, loc.file)) {
    const rel = path.relative(loc.home, part.file).replace(/\.zst$/, '');
    const dest = path.join(desktopHome, rel);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('unsafe Codex ancestor path');
    if (!fs.existsSync(dest)) await copyNativeFile(part.file, dest);
  }
  return { sdkSessionId: loc.threadId, model: loc.model || undefined, tokensUsed: loc.tokensUsed };
}

async function verify(m: NativeMaterialization): Promise<VerifyOutcome> {
  const desktopHome = getDesktopCodexHome();
  const db = findLatestStateDb(desktopHome);
  const row = db ? readRawThreadRow(db, m.sdkSessionId) : null;
  let file = row ? str(row.rollout_path) : '';
  if (!file || !fs.existsSync(file)) {
    const hits = (await collectRollouts(desktopHome))
      .filter((f) => codexRolloutIdentity(f.file)?.threadId === m.sdkSessionId.toLowerCase() && !isZstdPath(f.file));
    file = hits.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file ?? '';
  }
  if (!file) return { ok: false, reason: 'native-unloadable', detail: 'rollout missing in Cindy codex home' };
  const first = parseJsonLine((await readFirstLine(file)) ?? '');
  const id = first && isRecord(first.payload) ? str(first.payload.id).toLowerCase() : '';
  if (first?.type !== 'session_meta' || id !== m.sdkSessionId.toLowerCase()) {
    return { ok: false, reason: 'native-unloadable', detail: 'rollout header does not match the thread' };
  }
  try {
    await ancestorChain(desktopHome, file);
  } catch (err) {
    return { ok: false, reason: 'native-unloadable', detail: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true };
}

export const codexAdapter: SourceAdapter = {
  id: 'codex',
  label: 'Codex',
  native: 'codex',
  list,
  read,
  materialize,
  verify,
};
