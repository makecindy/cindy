/**
 * Pi 来源适配器（原生续做）。
 *
 * - 历史：`~/.pi/agent/sessions/--<目录>--/<时间>_<编号>.jsonl`（可被 PI_CODING_AGENT_SESSION_DIR
 *   或 settings.json 的 sessionDir 改写）。格式有公开文档与版本号（v3）：首行 session 头，
 *   其后每条记录带 id / parentId 组成一棵树，分支都在同一个文件里；
 * - 显示：取当前分支（最后一条记录沿 parentId 回到根）；
 * - 复制：放进 Cindy 的 pi-agent-home，只改写首行的编号与工作目录，整棵树原样保留；
 *   Cindy 用文件绝对路径作为 Pi 的续做编号。
 */

import { createReadStream, promises as fsp, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app } from 'electron';

import { migrationNativeContext } from '../../session-share/migrationNativeContext.js';
import { writeMigratedTranscript } from '../../session-share/migrationTranscriptWriter.js';
import { parseJsonLine, readFirstLine, readLines } from '../lineReader.js';
import type {
  NativeMaterialization,
  NormalizedImage,
  NormalizedMessage,
  ReadContext,
  SourceAdapter,
  SourceListResult,
  SourceSession,
  VerifyOutcome,
} from '../types.js';
import { blocksText, isRecord, makeTitle, str, toMs, walkFiles } from './common.js';

interface PiLocator {
  file: string;
}

function piSessionRoots(): string[] {
  const roots = new Set<string>();
  if (process.env.PI_CODING_AGENT_SESSION_DIR) roots.add(path.resolve(process.env.PI_CODING_AGENT_SESSION_DIR));
  const agentDir = path.join(os.homedir(), '.pi', 'agent');
  roots.add(path.join(agentDir, 'sessions'));
  try {
    const settings = JSON.parse(readFileSync(path.join(agentDir, 'settings.json'), 'utf-8')) as unknown;
    if (isRecord(settings) && typeof settings.sessionDir === 'string' && settings.sessionDir) {
      roots.add(path.resolve(agentDir, settings.sessionDir.replace(/^~(?=$|\/)/, os.homedir())));
    }
  } catch { /* 没有 settings.json */ }
  return [...roots];
}

export function cindyPiAgentHome(): string {
  return path.join(app.getPath('userData'), 'pi-agent-home');
}

interface PiEntry {
  id: string;
  parentId: string | null;
  type: string;
  raw: Record<string, unknown>;
}

/** 读整棵树并取当前分支（最后一条可续接的记录沿 parentId 回到根）。 */
async function activeBranch(file: string, ctx?: ReadContext): Promise<{ header: Record<string, unknown> | null; path: PiEntry[] }> {
  const entries = new Map<string, PiEntry>();
  let header: Record<string, unknown> | null = null;
  let leaf: string | null = null;
  for await (const line of readLines(file, { signal: ctx?.signal, onBytes: ctx?.onBytes })) {
    const obj = parseJsonLine(line);
    if (!obj) continue;
    if (obj.type === 'session') {
      header = obj;
      continue;
    }
    const id = str(obj.id);
    if (!id) continue;
    const entry: PiEntry = { id, parentId: str(obj.parentId) || null, type: str(obj.type), raw: obj };
    entries.set(id, entry);
    if (entry.type === 'message' || entry.type === 'compaction' || entry.type === 'branch_summary') leaf = id;
  }
  const out: PiEntry[] = [];
  const seen = new Set<string>();
  for (let cur = leaf; cur && !seen.has(cur); cur = entries.get(cur)?.parentId ?? null) {
    seen.add(cur);
    const e = entries.get(cur);
    if (!e) break;
    out.push(e);
  }
  return { header, path: out.reverse() };
}

function piImages(content: unknown): NormalizedImage[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((b) => (isRecord(b) && b.type === 'image' && typeof b.data === 'string' && typeof b.mimeType === 'string'
    ? [{ mimeType: b.mimeType, base64Data: b.data }]
    : []));
}

function piText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => isRecord(b) && b.type === 'text' && typeof b.text === 'string').map((b) => (b as { text: string }).text).join('\n\n');
}

/** Pi 分支上的一条记录 → Cindy 消息（与 Cindy 自己的 Pi 树重建同口径）。 */
export function parsePiEntry(entry: PiEntry, sdkSessionId: string): NormalizedMessage[] {
  if (entry.type !== 'message' || !isRecord(entry.raw.message)) return [];
  const m = entry.raw.message;
  const createdAt = toMs(entry.raw.timestamp) || toMs(m.timestamp) || Date.now();
  const base = { uuid: entry.id, sdkSessionId };
  if (m.role === 'user') {
    const text = piText(m.content).trim();
    const images = piImages(m.content);
    if (!text && !images.length) return [];
    return [{ key: `${entry.id}-user`, role: 'user', content: text, images: images.length ? images : undefined, agentMeta: base, createdAt }];
  }
  if (m.role === 'assistant') {
    const meta = { ...base, ...(typeof m.model === 'string' ? { model: m.model } : {}) };
    const blocks = Array.isArray(m.content) ? m.content : [];
    const out: NormalizedMessage[] = [];
    blocks.forEach((raw, i) => {
      if (!isRecord(raw)) return;
      if (raw.type === 'text' && typeof raw.text === 'string' && raw.text) {
        out.push({ key: `${entry.id}-text-${i}`, role: 'assistant', content: raw.text, agentMeta: meta, createdAt: createdAt + i });
      } else if (raw.type === 'thinking' && typeof raw.thinking === 'string') {
        out.push({ key: `${entry.id}-thinking-${i}`, role: 'thinking', content: { text: raw.thinking, durationMs: 0, isRedacted: raw.redacted === true }, agentMeta: meta, createdAt: createdAt + i });
      } else if (raw.type === 'toolCall' && typeof raw.id === 'string') {
        out.push({
          key: `${entry.id}-tool-${i}`,
          role: 'tool_use',
          content: { toolUseId: raw.id, toolName: str(raw.name) || 'tool', input: raw.arguments ?? null },
          toolUseId: raw.id,
          agentMeta: meta,
          createdAt: createdAt + i,
        });
      }
    });
    return out;
  }
  if (m.role === 'toolResult' && typeof m.toolCallId === 'string') {
    return [{ key: `${entry.id}-result`, role: 'tool_result', content: blocksText(m.content), toolUseId: m.toolCallId, agentMeta: base, createdAt }];
  }
  return [];
}

async function list(): Promise<SourceListResult> {
  const sessions: SourceSession[] = [];
  let unreadableCount = 0;
  const cindyHome = path.resolve(cindyPiAgentHome());
  for (const root of piSessionRoots()) {
    if (path.resolve(root).startsWith(cindyHome)) continue;
    for (const f of await walkFiles(root, (name) => name.endsWith('.jsonl'), { maxDepth: 2 })) {
      if (f.size === 0) continue;
      const header = parseJsonLine((await readFirstLine(f.file)) ?? '');
      if (!header || header.type !== 'session' || !str(header.id)) { unreadableCount += 1; continue; }
      let title = '';
      for await (const line of readLines(f.file, { maxBytes: 256 * 1024 })) {
        const obj = parseJsonLine(line);
        if (obj?.type === 'session_info' && str(obj.name)) { title = str(obj.name); break; }
        if (!title && obj?.type === 'message' && isRecord(obj.message) && obj.message.role === 'user') {
          const t = piText(obj.message.content).trim();
          if (t) title = makeTitle(t, '');
        }
      }
      const version = Number(header.version ?? 1);
      sessions.push({
        source: 'pi',
        sourceSessionId: str(header.id),
        title: title || 'Pi',
        cwd: str(header.cwd) || null,
        createdAt: toMs(header.timestamp) || Math.floor(f.mtimeMs),
        updatedAt: Math.floor(f.mtimeMs),
        archived: false,
        sizeBytes: f.size,
        locator: JSON.stringify({ file: f.file } satisfies PiLocator),
        ...(version > 3 ? { unsupportedVersion: `v${version}` } : {}),
      });
    }
  }
  return { sessions, internalCount: 0, unreadableCount };
}

async function* read(session: SourceSession, ctx: ReadContext): AsyncIterable<NormalizedMessage> {
  const { file } = JSON.parse(session.locator) as PiLocator;
  const branch = await activeBranch(file, ctx);
  for (const entry of branch.path) yield* parsePiEntry(entry, session.sourceSessionId);
}

/** 副本编号按账号 + 目标任务 + 原编号生成（见 Claude Code 的同名说明）。 */
function importedPiFile(sourceSessionId: string, ctx: ReadContext): { newId: string; target: string } {
  const newId = migrationNativeContext(
    `session-import:pi:${ctx.ownerId ?? ''}:${ctx.cindySessionId}:${sourceSessionId}`,
    [sourceSessionId],
  ).id(sourceSessionId);
  return { newId, target: path.join(cindyPiAgentHome(), 'sessions', 'imported', `${newId}.jsonl`) };
}

async function materialize(session: SourceSession, ctx: ReadContext): Promise<NativeMaterialization> {
  const { file } = JSON.parse(session.locator) as PiLocator;
  const { newId, target } = importedPiFile(session.sourceSessionId, ctx);
  await writeMigratedTranscript(createReadStream(file), target, { agent: 'pi', sessionId: newId, cwd: session.cwd ?? os.homedir() });
  return { sdkSessionId: target };
}

async function verify(m: NativeMaterialization): Promise<VerifyOutcome> {
  const stat = await fsp.stat(m.sdkSessionId).catch(() => null);
  if (!stat?.isFile() || stat.size === 0) return { ok: false, reason: 'native-unloadable', detail: 'copied Pi session missing' };
  const header = parseJsonLine((await readFirstLine(m.sdkSessionId)) ?? '');
  if (header?.type !== 'session') return { ok: false, reason: 'native-unloadable', detail: 'copied Pi session has no header' };
  const branch = await activeBranch(m.sdkSessionId);
  return branch.path.length > 0 ? { ok: true } : { ok: false, reason: 'native-unloadable', detail: 'copied Pi session has no entries' };
}

export const piAdapter: SourceAdapter = {
  id: 'pi',
  label: 'Pi',
  native: 'pi',
  list,
  read,
  materialize,
  verify,
};
