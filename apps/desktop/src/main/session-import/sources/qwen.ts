/**
 * Qwen Code 来源适配器（换引擎续做）。
 *
 * - 根目录：`$QWEN_RUNTIME_DIR`，否则 `$QWEN_HOME`，缺省 `~/.qwen`；
 * - 历史：`projects/<目录转码>/chats/<会话编号>.jsonl`，归档在 `chats/archive/`；
 *   子 Agent 在 `projects/<…>/subagents/` 下，只计数；
 * - 每行一条记录，带 uuid / parentUuid 与 cwd：从最后一条对话记录沿 parentUuid 走回根，
 *   得到当前分支（/rewind 写的是指回更早位置的记录，被撤回的轮次自然落在死分支上）；
 *   同一 uuid 的多行合并 parts；
 * - 标题取最后一条 custom_title，否则第一句提问。
 */

import path from 'node:path';

import { parseJsonLine, readLines } from '../lineReader.js';
import type { NormalizedMessage, ReadContext, ScanContext, SourceAdapter, SourceListResult, SourceSession } from '../types.js';
import { envDir, genaiParts, isRecord, makeTitle, str, toMs, walkFiles } from './common.js';

interface QwenLocator { file: string }

interface QwenRecord {
  uuid: string;
  parentUuid: string | null;
  type: string;
  subtype: string;
  timestamp: number;
  cwd: string;
  parts: unknown[];
  isSidechain: boolean;
  systemPayload: unknown;
}

const FILE = /^[0-9a-fA-F-]{32,36}\.jsonl$/;
/** 不在对话主线上的系统记录（遥测、命令记录等），不能当作当前分支的末端。 */
const ARTIFACT_SUBTYPES = new Set(['ui_telemetry', 'file_history_snapshot', 'custom_title', 'session_model', 'notification', 'slash_command', 'at_command']);

function qwenRoots(homeDir: string): string[] {
  const roots = [envDir('QWEN_RUNTIME_DIR', homeDir), envDir('QWEN_HOME', homeDir), path.join(homeDir, '.qwen')]
    .filter((r): r is string => !!r);
  return [...new Set(roots)];
}

function toRecord(obj: Record<string, unknown>): QwenRecord | null {
  const uuid = str(obj.uuid);
  if (!uuid) return null;
  const message = isRecord(obj.message) ? obj.message : null;
  return {
    uuid,
    parentUuid: str(obj.parentUuid) || null,
    type: str(obj.type),
    subtype: str(obj.subtype),
    timestamp: toMs(obj.timestamp),
    cwd: str(obj.cwd),
    parts: message && Array.isArray(message.parts) ? message.parts : [],
    isSidechain: obj.isSidechain === true,
    systemPayload: obj.systemPayload,
  };
}

interface Loaded {
  records: Map<string, QwenRecord>;
  order: string[];
  title: string;
  cwd: string;
  firstAt: number;
  lastAt: number;
}

async function load(file: string, opts: { maxBytes?: number; signal?: AbortSignal; onBytes?: (n: number) => void } = {}): Promise<Loaded> {
  const records = new Map<string, QwenRecord>();
  const order: string[] = [];
  let title = '';
  let cwd = '';
  let firstAt = 0;
  let lastAt = 0;
  for await (const line of readLines(file, opts)) {
    const obj = parseJsonLine(line);
    if (!obj) continue;
    if (str(obj.subtype).startsWith('managed_session_')) continue;
    const r = toRecord(obj);
    if (!r) continue;
    if (r.subtype === 'custom_title' && isRecord(r.systemPayload)) title = str(r.systemPayload.customTitle) || title;
    if (r.cwd && !cwd) cwd = r.cwd;
    if (r.timestamp) {
      firstAt = firstAt || r.timestamp;
      lastAt = Math.max(lastAt, r.timestamp);
    }
    const prev = records.get(r.uuid);
    if (prev) {
      prev.parts = [...prev.parts, ...r.parts];
      prev.timestamp = Math.max(prev.timestamp, r.timestamp);
    } else {
      records.set(r.uuid, r);
      order.push(r.uuid);
    }
  }
  return { records, order, title, cwd, firstAt, lastAt };
}

/** 当前分支：最后一条对话记录沿 parentUuid 回到根。 */
function activeBranch(loaded: Loaded): QwenRecord[] {
  let leaf: QwenRecord | undefined;
  for (let i = loaded.order.length - 1; i >= 0; i -= 1) {
    const r = loaded.records.get(loaded.order[i]!)!;
    if (r.isSidechain || ARTIFACT_SUBTYPES.has(r.subtype)) continue;
    leaf = r;
    break;
  }
  const out: QwenRecord[] = [];
  const seen = new Set<string>();
  for (let r = leaf; r && !seen.has(r.uuid); r = r.parentUuid ? loaded.records.get(r.parentUuid) : undefined) {
    seen.add(r.uuid);
    out.push(r);
  }
  return out.reverse();
}

function firstUserText(loaded: Loaded): string {
  for (const id of loaded.order) {
    const r = loaded.records.get(id)!;
    if (r.type !== 'user') continue;
    const text = r.parts.map((p) => (isRecord(p) && typeof p.text === 'string' && p.thought !== true ? p.text : '')).join('').trim();
    if (text) return text;
  }
  return '';
}

async function list(ctx: ScanContext): Promise<SourceListResult> {
  const sessions: SourceSession[] = [];
  let internalCount = 0;
  let unreadableCount = 0;
  const seen = new Set<string>();
  for (const root of qwenRoots(ctx.homeDir)) {
    const projects = path.join(root, 'projects');
    const files = await walkFiles(projects, (name, full) => name.endsWith('.jsonl')
      && (full.includes(`${path.sep}chats${path.sep}`) || full.includes(`${path.sep}subagents${path.sep}`)), { maxDepth: 5 });
    for (const f of files) {
      if (f.file.includes(`${path.sep}subagents${path.sep}`)) {
        internalCount += 1;
        continue;
      }
      if (!FILE.test(path.basename(f.file)) || f.size === 0) continue;
      const id = path.basename(f.file, '.jsonl');
      if (seen.has(id)) continue;
      seen.add(id);
      try {
        const loaded = await load(f.file, { maxBytes: 512 * 1024 });
        const title = makeTitle(loaded.title || firstUserText(loaded), '');
        if (!title) continue;
        sessions.push({
          source: 'qwen',
          sourceSessionId: id,
          title,
          cwd: loaded.cwd || null,
          createdAt: loaded.firstAt || Math.floor(f.mtimeMs),
          updatedAt: Math.max(Math.floor(f.mtimeMs), loaded.lastAt),
          archived: f.file.includes(`${path.sep}chats${path.sep}archive${path.sep}`),
          sizeBytes: f.size,
          locator: JSON.stringify({ file: f.file } satisfies QwenLocator),
        });
      } catch {
        unreadableCount += 1;
      }
    }
  }
  return { sessions, internalCount, unreadableCount };
}

async function* read(session: SourceSession, ctx: ReadContext): AsyncIterable<NormalizedMessage> {
  const { file } = JSON.parse(session.locator) as QwenLocator;
  const loaded = await load(file, { signal: ctx.signal, onBytes: ctx.onBytes });
  for (const r of activeBranch(loaded)) {
    if (ctx.signal?.aborted) return;
    if (r.type === 'user') yield* genaiParts('user', r.parts, r.uuid, r.timestamp);
    else if (r.type === 'assistant') yield* genaiParts('assistant', r.parts, r.uuid, r.timestamp);
    else if (r.type === 'tool_result') yield* genaiParts('user', r.parts, r.uuid, r.timestamp).filter((m) => m.role === 'tool_result');
  }
}

export const qwenAdapter: SourceAdapter = { id: 'qwen', label: 'Qwen Code', list, read };
