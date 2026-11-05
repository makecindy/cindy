/**
 * Gemini CLI 来源适配器（换引擎续做）。
 *
 * - 根目录：`$GEMINI_CLI_HOME/.gemini`，缺省 `~/.gemini`；
 * - 历史：`tmp/<项目目录名>/chats/session-*.jsonl`（新版逐行追加）或 `session-*.json`（旧版整份）；
 *   子 Agent 记在 `chats/<父会话>/` 下，只计数；
 * - 逐行记录按顺序折叠：同一 id 的消息后写覆盖先写；`$set` 合并元数据（summary 即标题），
 *   `$patch` 改内容或删除/重排消息，`$rewindTo` 撤回到某条之前；
 * - 记录里没有工作目录：按 `projects.json`（路径 → 目录名）与目录里的 `.project_root` 还原。
 */

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { parseJsonLine, readLines } from '../lineReader.js';
import type { NormalizedMessage, ReadContext, ScanContext, SourceAdapter, SourceListResult, SourceSession } from '../types.js';
import { envDir, genaiParts, isRecord, makeTitle, str, stringifyOutput, toMs, walkFiles } from './common.js';

interface GeminiLocator { file: string }

type GeminiMessage = Record<string, unknown> & { id: string };

interface Folded {
  header: Record<string, unknown> | null;
  meta: Record<string, unknown>;
  messages: GeminiMessage[];
}

function geminiRoot(homeDir: string): string {
  const home = envDir('GEMINI_CLI_HOME', homeDir) ?? homeDir;
  return path.join(home, '.gemini');
}

/** 目录名 → 项目路径：projects.json 的反查，以及旧版按 sha256(路径) 命名的目录。 */
async function projectRoots(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(root, 'projects.json'), 'utf8')) as unknown;
    const projects = isRecord(raw) && isRecord(raw.projects) ? raw.projects : {};
    for (const [projectPath, slug] of Object.entries(projects)) {
      if (typeof slug === 'string') out.set(slug, projectPath);
      out.set(createHash('sha256').update(projectPath).digest('hex'), projectPath);
    }
  } catch { /* 没有映射：退回 .project_root */ }
  return out;
}

async function cwdOf(slugDir: string, roots: Map<string, string>): Promise<string | null> {
  const slug = path.basename(slugDir);
  if (roots.has(slug)) return roots.get(slug)!;
  try {
    const recorded = (await fsp.readFile(path.join(slugDir, '.project_root'), 'utf8')).trim();
    return recorded || null;
  } catch {
    return null;
  }
}

function applyPatch(state: Folded, patch: Record<string, unknown>): void {
  const byId = new Map(state.messages.map((m) => [m.id, m]));
  const patchOne = (p: Record<string, unknown>) => {
    const target = byId.get(str(p.id));
    if (!target) return;
    if ('content' in p) target.content = p.content;
    if (Array.isArray(p.toolCalls) && Array.isArray(target.toolCalls)) {
      for (const call of p.toolCalls) {
        if (!isRecord(call)) continue;
        const hit = (target.toolCalls as unknown[]).find((c) => isRecord(c) && c.id === call.id);
        if (isRecord(hit)) Object.assign(hit, call);
      }
    }
  };
  if (str(patch.id)) patchOne(patch);
  if (Array.isArray(patch.updates)) for (const u of patch.updates) if (isRecord(u)) patchOne(u);
  if (Array.isArray(patch.removeIds)) {
    const remove = new Set(patch.removeIds.map(String));
    state.messages = state.messages.filter((m) => !remove.has(m.id));
  }
  if (Array.isArray(patch.orderIds)) {
    const order = patch.orderIds.map(String);
    const listed = new Set(order);
    const ids = new Map(state.messages.map((m) => [m.id, m]));
    state.messages = [
      ...state.messages.filter((m) => !listed.has(m.id)),
      ...order.map((id) => ids.get(id)).filter((m): m is GeminiMessage => !!m),
    ];
  }
}

/** 折叠整份历史。maxBytes 只用于扫描时读标题。 */
async function fold(file: string, opts: { maxBytes?: number; signal?: AbortSignal; onBytes?: (n: number) => void } = {}): Promise<Folded> {
  const state: Folded = { header: null, meta: {}, messages: [] };
  if (file.endsWith('.json')) {
    const raw = JSON.parse(await fsp.readFile(file, 'utf8')) as unknown;
    opts.onBytes?.((await fsp.stat(file)).size);
    if (!isRecord(raw)) return state;
    state.header = raw;
    state.meta = { summary: raw.summary, lastUpdated: raw.lastUpdated };
    state.messages = (Array.isArray(raw.messages) ? raw.messages : [])
      .filter((m): m is GeminiMessage => isRecord(m) && typeof m.id === 'string');
    return state;
  }
  const index = new Map<string, number>();
  for await (const line of readLines(file, opts)) {
    const obj = parseJsonLine(line);
    if (!obj) continue;
    if (!state.header && typeof obj.sessionId === 'string' && !('type' in obj)) {
      state.header = obj;
      continue;
    }
    if (isRecord(obj.$set)) {
      Object.assign(state.meta, obj.$set);
      if (Array.isArray(obj.$set.messages)) {
        state.messages = obj.$set.messages.filter((m): m is GeminiMessage => isRecord(m) && typeof m.id === 'string');
        index.clear();
        state.messages.forEach((m, i) => index.set(m.id, i));
      }
      continue;
    }
    if (isRecord(obj.$patch)) {
      applyPatch(state, obj.$patch);
      index.clear();
      state.messages.forEach((m, i) => index.set(m.id, i));
      continue;
    }
    if (typeof obj.$rewindTo === 'string') {
      const at = index.get(obj.$rewindTo);
      state.messages = at === undefined ? [] : state.messages.slice(0, at);
      index.clear();
      state.messages.forEach((m, i) => index.set(m.id, i));
      continue;
    }
    if (typeof obj.id !== 'string') continue;
    const at = index.get(obj.id);
    if (at === undefined) {
      index.set(obj.id, state.messages.length);
      state.messages.push(obj as GeminiMessage);
    } else {
      state.messages[at] = obj as GeminiMessage;
    }
  }
  return state;
}

function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  const list = Array.isArray(content) ? content : [content];
  return list.map((p) => (isRecord(p) && typeof p.text === 'string' && p.thought !== true ? p.text : typeof p === 'string' ? p : '')).join('');
}

async function list(ctx: ScanContext): Promise<SourceListResult> {
  const root = geminiRoot(ctx.homeDir);
  const roots = await projectRoots(root);
  const files = await walkFiles(
    path.join(root, 'tmp'),
    (name, full) => /^session-.*\.jsonl?$/.test(name) || (full.includes(`${path.sep}chats${path.sep}`) && name.endsWith('.jsonl')),
    { maxDepth: 4 },
  );
  // 同名的 .json 已被迁移成 .jsonl 时只算新的那份。
  const jsonl = new Set(files.filter((f) => f.file.endsWith('.jsonl')).map((f) => f.file.slice(0, -1)));
  const sessions: SourceSession[] = [];
  let internalCount = 0;
  let unreadableCount = 0;
  const cwdCache = new Map<string, string | null>();
  for (const f of files) {
    if (f.file.endsWith('.json') && jsonl.has(f.file)) continue;
    const chatsAt = f.file.lastIndexOf(`${path.sep}chats${path.sep}`);
    if (chatsAt < 0) continue;
    const chatsDir = f.file.slice(0, chatsAt + 1 + 'chats'.length);
    // chats/ 下再深一层的是子 Agent 记录。
    if (path.dirname(f.file) !== chatsDir) {
      internalCount += 1;
      continue;
    }
    try {
      const state = await fold(f.file, { maxBytes: 512 * 1024 });
      const header = state.header ?? {};
      if (str(header.kind) === 'subagent') {
        internalCount += 1;
        continue;
      }
      const sessionId = str(header.sessionId) || path.basename(f.file).replace(/\.jsonl?$/, '');
      const firstUser = state.messages.find((m) => m.type === 'user' && userText(m.content).trim());
      const title = makeTitle(str(state.meta.summary) || (firstUser ? userText(firstUser.content) : ''), '');
      if (!title && state.messages.length === 0) continue;
      const slugDir = path.dirname(chatsDir);
      if (!cwdCache.has(slugDir)) cwdCache.set(slugDir, await cwdOf(slugDir, roots));
      sessions.push({
        source: 'gemini',
        sourceSessionId: sessionId,
        title: title || 'Gemini CLI',
        cwd: cwdCache.get(slugDir) ?? null,
        createdAt: toMs(header.startTime) || Math.floor(f.mtimeMs),
        updatedAt: toMs(state.meta.lastUpdated) || toMs(header.lastUpdated) || Math.floor(f.mtimeMs),
        archived: false,
        sizeBytes: f.size,
        locator: JSON.stringify({ file: f.file } satisfies GeminiLocator),
      });
    } catch {
      unreadableCount += 1;
    }
  }
  return { sessions, internalCount, unreadableCount };
}

/** 一条 Gemini CLI 消息 → 统一消息。 */
export function parseGeminiMessage(m: GeminiMessage): NormalizedMessage[] {
  const createdAt = toMs(m.timestamp);
  const key = m.id;
  const type = str(m.type);
  if (type === 'user') return genaiParts('user', m.content, key, createdAt);
  if (type !== 'gemini') return [];
  const out: NormalizedMessage[] = [];
  const thoughts = Array.isArray(m.thoughts) ? m.thoughts : [];
  thoughts.forEach((th, i) => {
    if (!isRecord(th)) return;
    const text = [str(th.subject), str(th.description)].filter(Boolean).join('\n\n');
    if (text) out.push({ key: `${key}-th${i}`, role: 'thinking', content: { text, durationMs: 0, isRedacted: false }, createdAt: toMs(th.timestamp) || createdAt });
  });
  out.push(...genaiParts('assistant', m.content, key, createdAt));
  const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
  calls.forEach((call, i) => {
    if (!isRecord(call)) return;
    const toolUseId = str(call.id) || `${key}-call${i}`;
    const at = toMs(call.timestamp) || createdAt;
    out.push({
      key: `${key}-call${i}`,
      role: 'tool_use',
      content: { toolUseId, toolName: str(call.name) || str(call.displayName) || 'tool', input: call.args ?? null },
      toolUseId,
      createdAt: at,
    });
    let text = '';
    if (Array.isArray(call.result)) {
      text = call.result
        .map((p) => (isRecord(p) && isRecord(p.functionResponse) ? stringifyOutput(isRecord(p.functionResponse.response) ? p.functionResponse.response.output ?? p.functionResponse.response : p.functionResponse.response) : ''))
        .filter(Boolean)
        .join('\n');
    }
    if (!text && call.resultDisplay != null) text = stringifyOutput(call.resultDisplay);
    if (text || call.result != null) out.push({ key: `${key}-res${i}`, role: 'tool_result', content: text, toolUseId, createdAt: at });
  });
  return out;
}

async function* read(session: SourceSession, ctx: ReadContext): AsyncIterable<NormalizedMessage> {
  const { file } = JSON.parse(session.locator) as GeminiLocator;
  const state = await fold(file, { signal: ctx.signal, onBytes: ctx.onBytes });
  for (const m of state.messages) {
    if (ctx.signal?.aborted) return;
    yield* parseGeminiMessage(m);
  }
}

export const geminiAdapter: SourceAdapter = { id: 'gemini', label: 'Gemini CLI', list, read };
