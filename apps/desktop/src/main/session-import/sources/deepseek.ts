/**
 * DeepSeek Harness（dsh）来源适配器（换引擎续做）。
 *
 * - 根目录：`$DSH_HOME`，缺省 `~/.dsh`；会话在 `sessions/`（早期版本 `storages/`）下：
 *   `--<目录键>--/<会话编号>/session.vN.jsonl[.zstd]`，同一会话可能留着多代文件，读版本号最高的；
 * - 首行是会话头（id / createdAt / cwd / isSeeded / origin），其后每行一个事件
 *   （type / seq / time / data）；`origin: "subagent"` 的是子 Agent，只计数；
 * - 分叉出来的会话（isSeeded）开头一段是从父会话复制来的，到最后一个 `session/end-seed`
 *   为止，跳过这段（父会话自己会单独导入）。
 */

import path from 'node:path';

import { parseJsonLine, readFirstLine, readLines } from '../lineReader.js';
import type { NormalizedImage, NormalizedMessage, ReadContext, ScanContext, SourceAdapter, SourceListResult, SourceSession } from '../types.js';
import { envDir, firstNonEmpty, isRecord, makeTitle, parseDataUrl, parseMaybeJson, str, stringifyOutput, toMs, walkFiles } from './common.js';

interface DeepSeekLocator { file: string }

const SESSION_FILE = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd?)?$/;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (isRecord(b) && str(b.type) === 'text' ? str(b.text) : '')).filter(Boolean).join('\n\n');
}

function imagesOf(content: unknown): NormalizedImage[] {
  if (!Array.isArray(content)) return [];
  const out: NormalizedImage[] = [];
  for (const b of content) {
    if (!isRecord(b) || str(b.type) !== 'image') continue;
    const att = isRecord(b.attachment) ? b.attachment : b;
    const mimeType = firstNonEmpty(att.mimeType, att.mediaType, att.mime);
    const data = str(att.data);
    const url = str(att.url);
    if (mimeType && data) out.push({ mimeType, base64Data: data });
    else if (url) {
      const parsed = parseDataUrl(url);
      if (parsed) out.push(parsed);
    } else if (mimeType && str(att.path)) out.push({ mimeType, filePath: str(att.path) });
  }
  return out;
}

/** 一个 dsh 事件 → 统一消息。seenCalls 用来避免助手消息里的 tool-call 与单独的 tool/call 事件重复。 */
export function parseDeepSeekEvent(ev: Record<string, unknown>, index: number, seenCalls: Set<string>): NormalizedMessage[] {
  const type = str(ev.type);
  const data = isRecord(ev.data) ? ev.data : {};
  const createdAt = toMs(ev.time);
  const key = typeof ev.seq === 'number' && Number.isFinite(ev.seq) ? `s${ev.seq}` : `i${index}`;
  if (type === 'user/message') {
    const msg = isRecord(data.content) || Array.isArray(data.content) ? data : isRecord(data.message) ? data.message : data;
    const source = isRecord(msg.source) ? str(msg.source.kind) : 'user';
    if (source && source !== 'user') return [];
    const text = textOf(msg.content).trim();
    const images = imagesOf(msg.content);
    return text || images.length ? [{ key, role: 'user', content: text, ...(images.length ? { images } : {}), createdAt }] : [];
  }
  if (type === 'assistant/message') {
    const msg = isRecord(data.message) ? data.message : data;
    const out: NormalizedMessage[] = [];
    let i = 0;
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (!isRecord(b)) continue;
      const bt = str(b.type);
      if (bt === 'text' && str(b.text).trim()) out.push({ key: `${key}-${i++}`, role: 'assistant', content: str(b.text), createdAt });
      else if (bt === 'reasoning' && str(b.text).trim()) out.push({ key: `${key}-${i++}`, role: 'thinking', content: { text: str(b.text), durationMs: 0, isRedacted: false }, createdAt });
      else if (bt === 'tool-call') {
        const toolUseId = str(b.id) || `${key}-${i}`;
        seenCalls.add(toolUseId);
        out.push({ key: `${key}-${i++}`, role: 'tool_use', content: { toolUseId, toolName: str(b.name) || 'tool', input: parseMaybeJson(b.arguments) }, toolUseId, createdAt });
      }
    }
    if (typeof msg.content === 'string' && msg.content.trim()) out.push({ key: `${key}-${i++}`, role: 'assistant', content: msg.content, createdAt });
    return out;
  }
  if (type === 'tool/call') {
    const toolUseId = str(data.callId);
    if (!toolUseId || seenCalls.has(toolUseId)) return [];
    seenCalls.add(toolUseId);
    return [{ key, role: 'tool_use', content: { toolUseId, toolName: str(data.name) || 'tool', input: parseMaybeJson(data.arguments) }, toolUseId, createdAt }];
  }
  if (type === 'tool/result') {
    const msg = isRecord(data.message) ? data.message : data;
    const toolUseId = firstNonEmpty(msg.toolCallId, data.callId);
    if (!toolUseId) return [];
    const text = textOf(msg.content) || stringifyOutput(msg.content ?? data.error);
    return [{ key, role: 'tool_result', content: text, toolUseId, createdAt }];
  }
  return [];
}

function titleOf(data: unknown): string {
  if (typeof data === 'string') return data;
  if (!isRecord(data)) return '';
  return firstNonEmpty(data.title, data.text, data.value);
}

async function list(ctx: ScanContext): Promise<SourceListResult> {
  const home = envDir('DSH_HOME', ctx.homeDir) ?? path.join(ctx.homeDir, '.dsh');
  // 每个会话目录只取版本号最高的那代文件。
  const best = new Map<string, { file: string; version: number; size: number; mtimeMs: number }>();
  for (const sub of ['sessions', 'storages']) {
    const files = await walkFiles(path.join(home, sub), (name) => SESSION_FILE.test(name), { maxDepth: 3 });
    for (const f of files) {
      const version = Number(SESSION_FILE.exec(path.basename(f.file))?.[1] ?? 0);
      const dir = path.dirname(f.file);
      const prev = best.get(dir);
      if (!prev || version > prev.version) best.set(dir, { ...f, version });
    }
  }
  const sessions: SourceSession[] = [];
  let internalCount = 0;
  let unreadableCount = 0;
  for (const f of best.values()) {
    try {
      const header = parseJsonLine((await readFirstLine(f.file)) ?? '');
      if (!header || str(header.type) !== 'session') {
        unreadableCount += 1;
        continue;
      }
      if (str(header.origin) === 'subagent' || Number(header.delegationDepth) > 0) {
        internalCount += 1;
        continue;
      }
      let title = '';
      let firstUser = '';
      let lastAt = 0;
      for await (const line of readLines(f.file, { maxBytes: 512 * 1024 })) {
        const ev = parseJsonLine(line);
        if (!ev) continue;
        lastAt = Math.max(lastAt, toMs(ev.time));
        if (str(ev.type) === 'session/title') title = titleOf(ev.data) || title;
        if (!firstUser && str(ev.type) === 'user/message') {
          const m = parseDeepSeekEvent(ev, 0, new Set()).find((x) => x.role === 'user');
          if (m && typeof m.content === 'string') firstUser = m.content;
        }
      }
      const shown = makeTitle(title || firstUser, '');
      if (!shown) continue;
      sessions.push({
        source: 'deepseek',
        sourceSessionId: str(header.id) || path.basename(path.dirname(f.file)),
        title: shown,
        cwd: str(header.cwd) || null,
        createdAt: toMs(header.createdAt) || Math.floor(f.mtimeMs),
        updatedAt: Math.max(lastAt, Math.floor(f.mtimeMs)),
        archived: false,
        sizeBytes: f.size,
        locator: JSON.stringify({ file: f.file } satisfies DeepSeekLocator),
        ...(Number(header.version) > 4 ? { unsupportedVersion: `v${Number(header.version)}` } : {}),
      });
    } catch {
      unreadableCount += 1;
    }
  }
  return { sessions, internalCount, unreadableCount };
}

async function* read(session: SourceSession, ctx: ReadContext): AsyncIterable<NormalizedMessage> {
  const { file } = JSON.parse(session.locator) as DeepSeekLocator;
  const events: Record<string, unknown>[] = [];
  let header: Record<string, unknown> | null = null;
  let seedEnd = -1;
  for await (const line of readLines(file, { signal: ctx.signal, onBytes: ctx.onBytes })) {
    const ev = parseJsonLine(line);
    if (!ev) continue;
    if (!header) {
      header = ev;
      continue;
    }
    if (str(ev.type) === 'session/end-seed') seedEnd = events.length;
    events.push(ev);
  }
  const start = header?.isSeeded === true && seedEnd >= 0 ? seedEnd + 1 : 0;
  const seenCalls = new Set<string>();
  for (let i = start; i < events.length; i += 1) {
    if (ctx.signal?.aborted) return;
    yield* parseDeepSeekEvent(events[i]!, i, seenCalls);
  }
}

export const deepseekAdapter: SourceAdapter = { id: 'deepseek', label: 'DeepSeek Harness', list, read };
