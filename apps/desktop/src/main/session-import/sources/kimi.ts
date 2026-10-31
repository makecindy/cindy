/**
 * Kimi 来源适配器（换引擎续做），覆盖两代产品：
 *
 * - Kimi Code（`$KIMI_CODE_HOME`，缺省 `~/.kimi-code`）：
 *   `sessions/<目录键>/<会话编号>/state.json` + `agents/main/wire.jsonl`。wire 每行一个事件，
 *   `context.append_message` 是写进上下文的消息，`context.undo` / `context.clear` 撤回；
 *   子 Agent 在 `agents/agent-N/` 下，只计数；
 * - Kimi CLI（`$KIMI_SHARE_DIR`，缺省 `~/.kimi`）：`sessions/<md5(工作目录)>/<会话编号>/context.jsonl`
 *   （OpenAI 风格消息，撤回时工具自己会截断这个文件），工作目录从 `kimi.json` 按 md5 反查。
 *
 * 两代的会话编号可能相同，Kimi CLI 的加 `cli:` 前缀区分。
 */

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { parseJsonLine, readLines } from '../lineReader.js';
import type { NormalizedImage, NormalizedMessage, ReadContext, ScanContext, SourceAdapter, SourceListResult, SourceSession } from '../types.js';
import { envDir, firstNonEmpty, isInjectedContextText, isRecord, makeTitle, parseDataUrl, parseMaybeJson, str, stringifyOutput, toMs, walkFiles } from './common.js';

type KimiLocator = { kind: 'code'; dir: string } | { kind: 'cli'; dir: string };

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    const v = JSON.parse(await fsp.readFile(file, 'utf8')) as unknown;
    return isRecord(v) ? v : {};
  } catch {
    return {};
  }
}

async function subdirs(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
}

/** OpenAI / kosong 风格的消息（content 可以是字符串或 parts，工具调用在 tool_calls / toolCalls）。 */
export function parseKimiMessage(msg: Record<string, unknown>, key: string, createdAt: number): NormalizedMessage[] {
  const role = str(msg.role);
  const out: NormalizedMessage[] = [];
  const content = msg.content;
  const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content.filter(isRecord) : [];
  const texts: string[] = [];
  const images: NormalizedImage[] = [];
  let i = 0;
  for (const p of parts) {
    const type = str(p.type);
    if (type === 'text' && typeof p.text === 'string') texts.push(p.text);
    else if (type === 'think' && role === 'assistant' && firstNonEmpty(p.think)) {
      out.push({ key: `${key}-${i++}`, role: 'thinking', content: { text: str(p.think), durationMs: 0, isRedacted: false }, createdAt });
    } else if (type === 'image_url' && role === 'user') {
      const ref = isRecord(p.image_url) ? p.image_url : isRecord(p.imageUrl) ? p.imageUrl : null;
      const image = ref ? parseDataUrl(str(ref.url)) : null;
      if (image) images.push(image);
    }
  }
  const text = texts.join('\n\n').trim();
  if (role === 'user') {
    if (/^<system>CHECKPOINT \d+<\/system>$/.test(text) || (isInjectedContextText(text) && images.length === 0)) return out;
    if (text || images.length) out.push({ key: `${key}-${i++}`, role: 'user', content: text, ...(images.length ? { images } : {}), createdAt });
    return out;
  }
  if (role === 'tool') {
    const toolUseId = firstNonEmpty(msg.tool_call_id, msg.toolCallId);
    if (toolUseId) out.push({ key: `${key}-${i++}`, role: 'tool_result', content: text || stringifyOutput(content), toolUseId, createdAt });
    return out;
  }
  if (role !== 'assistant') return out;
  if (text) out.push({ key: `${key}-${i++}`, role: 'assistant', content: text, createdAt });
  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : Array.isArray(msg.toolCalls) ? msg.toolCalls : [];
  for (const call of calls) {
    if (!isRecord(call)) continue;
    const fn = isRecord(call.function) ? call.function : call;
    const toolUseId = str(call.id) || `${key}-${i}`;
    out.push({
      key: `${key}-${i++}`,
      role: 'tool_use',
      content: { toolUseId, toolName: str(fn.name) || 'tool', input: parseMaybeJson(fn.arguments) },
      toolUseId,
      createdAt,
    });
  }
  return out;
}

/** Kimi Code：读 wire.jsonl，按 append / undo / clear 还原上下文里的消息。 */
async function codeMessages(dir: string, opts: { maxBytes?: number; signal?: AbortSignal; onBytes?: (n: number) => void } = {}) {
  const wire = path.join(dir, 'agents', 'main', 'wire.jsonl');
  const items: Array<{ msg: Record<string, unknown>; at: number }> = [];
  const prompts: Array<{ msg: Record<string, unknown>; at: number }> = [];
  for await (const line of readLines(wire, opts)) {
    const obj = parseJsonLine(line);
    if (!obj) continue;
    const type = str(obj.type);
    const at = toMs(obj.time);
    const agent = str(obj.agentId);
    if (agent && agent !== 'main') continue;
    if (type === 'context.append_message' && isRecord(obj.message)) items.push({ msg: obj.message, at });
    else if (type === 'turn.prompt' && Array.isArray(obj.input)) prompts.push({ msg: { role: 'user', content: obj.input }, at });
    else if (type === 'context.undo') items.splice(Math.max(0, items.length - Math.max(0, Number(obj.count) || 0)));
    else if (type === 'context.clear') items.length = 0;
  }
  // 少数版本不把用户输入追加进上下文：此时用 turn.prompt 补上，按时间合并。
  if (!items.some((it) => str(it.msg.role) === 'user')) {
    items.push(...prompts);
    items.sort((a, b) => a.at - b.at);
  }
  return items;
}

/** Kimi CLI：context.jsonl 里以 `_` 开头的 role 是控制行。 */
async function cliMessages(dir: string, opts: { maxBytes?: number; signal?: AbortSignal; onBytes?: (n: number) => void } = {}) {
  const items: Array<{ msg: Record<string, unknown>; at: number }> = [];
  for await (const line of readLines(path.join(dir, 'context.jsonl'), opts)) {
    const obj = parseJsonLine(line);
    if (!obj || str(obj.role).startsWith('_')) continue;
    items.push({ msg: obj, at: 0 });
  }
  return items;
}

function firstUserText(items: Array<{ msg: Record<string, unknown> }>): string {
  for (const { msg } of items) {
    if (str(msg.role) !== 'user') continue;
    const parsed = parseKimiMessage(msg, 'x', 0).find((m) => m.role === 'user');
    if (parsed && typeof parsed.content === 'string' && parsed.content.trim()) return parsed.content;
  }
  return '';
}

async function dirSize(dir: string): Promise<{ size: number; mtimeMs: number }> {
  const files = await walkFiles(dir, (n) => n.endsWith('.jsonl') || n === 'state.json', { maxDepth: 3 });
  return files.reduce((acc, f) => ({ size: acc.size + f.size, mtimeMs: Math.max(acc.mtimeMs, f.mtimeMs) }), { size: 0, mtimeMs: 0 });
}

async function list(ctx: ScanContext): Promise<SourceListResult> {
  const sessions: SourceSession[] = [];
  let internalCount = 0;
  let unreadableCount = 0;

  const codeRoot = envDir('KIMI_CODE_HOME', ctx.homeDir) ?? path.join(ctx.homeDir, '.kimi-code');
  for (const keyDir of await subdirs(path.join(codeRoot, 'sessions'))) {
    for (const dir of await subdirs(keyDir)) {
      try {
        const state = await readJson(path.join(dir, 'state.json'));
        const agents = isRecord(state.agents) ? Object.values(state.agents) : [];
        internalCount += agents.filter((a) => isRecord(a) && str(a.type) === 'sub').length;
        const wire = await fsp.stat(path.join(dir, 'agents', 'main', 'wire.jsonl')).catch(() => null);
        if (!wire?.isFile() || wire.size === 0) continue;
        const { size, mtimeMs } = await dirSize(dir);
        const title = makeTitle(firstNonEmpty(state.title, state.lastPrompt) || firstUserText(await codeMessages(dir, { maxBytes: 256 * 1024 })), '');
        if (!title) continue;
        sessions.push({
          source: 'kimi',
          sourceSessionId: str(state.id) || path.basename(dir),
          title,
          cwd: str(state.cwd) || null,
          createdAt: toMs(state.createdAt) || Math.floor(mtimeMs),
          updatedAt: toMs(state.updatedAt) || Math.floor(mtimeMs),
          archived: state.archived === true,
          sizeBytes: size,
          locator: JSON.stringify({ kind: 'code', dir } satisfies KimiLocator),
        });
      } catch {
        unreadableCount += 1;
      }
    }
  }

  const cliRoot = envDir('KIMI_SHARE_DIR', ctx.homeDir) ?? path.join(ctx.homeDir, '.kimi');
  const config = await readJson(path.join(cliRoot, 'kimi.json'));
  const byHash = new Map<string, string>();
  for (const wd of Array.isArray(config.work_dirs) ? config.work_dirs : []) {
    if (!isRecord(wd) || typeof wd.path !== 'string') continue;
    const md5 = createHash('md5').update(wd.path).digest('hex');
    const kaos = str(wd.kaos);
    byHash.set(kaos && kaos !== 'local' ? `${kaos}_${md5}` : md5, wd.path);
  }
  for (const keyDir of await subdirs(path.join(cliRoot, 'sessions'))) {
    for (const dir of await subdirs(keyDir)) {
      try {
        const context = await fsp.stat(path.join(dir, 'context.jsonl')).catch(() => null);
        if (!context?.isFile() || context.size === 0) continue;
        const subagents = await subdirs(path.join(dir, 'subagents'));
        internalCount += subagents.length;
        const state = await readJson(path.join(dir, 'state.json'));
        const title = makeTitle(str(state.custom_title) || firstUserText(await cliMessages(dir, { maxBytes: 256 * 1024 })), '');
        if (!title) continue;
        const birth = await fsp.stat(dir).catch(() => null);
        sessions.push({
          source: 'kimi',
          sourceSessionId: `cli:${path.basename(dir)}`,
          title,
          cwd: byHash.get(path.basename(keyDir)) ?? null,
          createdAt: Math.floor(birth?.birthtimeMs || context.mtimeMs),
          updatedAt: Math.floor(context.mtimeMs),
          archived: false,
          sizeBytes: context.size,
          locator: JSON.stringify({ kind: 'cli', dir } satisfies KimiLocator),
        });
      } catch {
        unreadableCount += 1;
      }
    }
  }
  return { sessions, internalCount, unreadableCount };
}

async function* read(session: SourceSession, ctx: ReadContext): AsyncIterable<NormalizedMessage> {
  const locator = JSON.parse(session.locator) as KimiLocator;
  const opts = { signal: ctx.signal, onBytes: ctx.onBytes };
  const items = locator.kind === 'code' ? await codeMessages(locator.dir, opts) : await cliMessages(locator.dir, opts);
  // 没有逐条时间（Kimi CLI）时交给写入层从任务创建时间起顺序递增。
  for (const [i, { msg, at }] of items.entries()) {
    if (ctx.signal?.aborted) return;
    yield* parseKimiMessage(msg, `${i}`, at);
  }
}

export const kimiAdapter: SourceAdapter = { id: 'kimi', label: 'Kimi Code', list, read };
