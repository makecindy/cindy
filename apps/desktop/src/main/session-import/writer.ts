/**
 * 导入写入层：把适配器产出的统一消息写进 Cindy。
 *
 * - 图片进入 Cindy 统一媒体库（cindy-media，import 引用挂在任务上），不再用旧的按任务图片缓存；
 * - 工具输出与 live 落库同口径截断（8K），截断前先对原文挂媒体引用；
 * - 分批写入（单批行数与字节都有上限），大历史不一次性占满内存或工作线程消息。
 */

import { promises as fsp } from 'node:fs';

import { getDbClient } from '../localDb/client/current.js';
import type { SessionImportTransactionArgs } from '../localDb/client/tx/types.js';
import { commitMessageMediaRefs } from '../cindy-media/chatAttachments.js';
import { ingestMedia } from '../cindy-media/ingest.js';
import { createLogger } from '../logger.js';
import { capImportedToolResultContent } from '../../shared/toolResultPersistCap.js';
import type { NormalizedImage, NormalizedMessage } from './types.js';

const log = createLogger('session-import-writer');

const BATCH_ROWS = 400;
const BATCH_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const IMAGE_EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

type MessageRow = Extract<SessionImportTransactionArgs, { action: 'messages' }>['rows'][number];

export function importClientIdPrefix(sessionId: string): string {
  return `import:${sessionId}:`;
}

export async function runImportTx(args: SessionImportTransactionArgs): Promise<unknown> {
  return getDbClient().tx('sessionImport.execute', args);
}

function normalizeMime(raw: string): string | null {
  const m = raw.trim().toLowerCase();
  const mime = m === 'image/jpg' ? 'image/jpeg' : m;
  return IMAGE_EXT[mime] ? mime : null;
}

async function ingestImage(image: NormalizedImage, sessionId: string, name: string): Promise<{ url: string; mimeType: string; originalName: string } | null> {
  const mimeType = normalizeMime(image.mimeType);
  if (!mimeType) return null;
  try {
    let buffer: Buffer;
    if (image.base64Data) {
      const data = image.base64Data.replace(/\s/g, '');
      if (Math.floor((data.length * 3) / 4) > MAX_IMAGE_BYTES) return null;
      buffer = Buffer.from(data, 'base64');
    } else if (image.filePath) {
      const stat = await fsp.stat(image.filePath);
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
      buffer = await fsp.readFile(image.filePath);
    } else {
      return null;
    }
    if (buffer.byteLength === 0) return null;
    const written = await ingestMedia({
      buffer,
      mimeType,
      refs: [{ refKind: 'import', refId: sessionId, originKind: 'user' }],
    });
    return { url: written.url, mimeType, originalName: `${name}${IMAGE_EXT[mimeType]}` };
  } catch (err) {
    log.debug('imported image skipped', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** 一条统一消息 → messages 行（content 已序列化）。 */
async function toRow(
  m: NormalizedMessage,
  sessionId: string,
  agentKind: string | null,
): Promise<MessageRow> {
  let content: unknown = m.content;
  if (m.role === 'user') {
    const images = [];
    for (const [i, image] of (m.images ?? []).entries()) {
      const ref = await ingestImage(image, sessionId, `imported-${m.key}-${i}`);
      if (ref) images.push(ref);
    }
    const text = typeof m.content === 'string' ? m.content : '';
    content = images.length > 0 ? { text, images, files: [] } : text;
  }
  if (m.role === 'tool_result' && typeof content === 'string') {
    // 截断前对原文挂账：worker 里看不到媒体账本。
    await commitMessageMediaRefs({ sessionId, role: 'tool_result', content }).catch(() => undefined);
  }
  const capped = capImportedToolResultContent(m.role, content);
  const json = JSON.stringify(capped);
  return {
    key: m.key,
    role: m.role,
    content: json === undefined ? 'null' : json,
    toolUseId: m.toolUseId ?? null,
    agentMeta: m.agentMeta ? JSON.stringify(m.agentMeta) : null,
    agentKind,
    createdAt: m.createdAt,
  };
}

export interface MessageSink {
  push(message: NormalizedMessage): Promise<void>;
  flush(): Promise<void>;
  readonly written: number;
  /** 含 PR 链接的消息（导入完成后交给 PR 关联提取）。 */
  readonly prCandidates: Array<{ role: string; content: unknown; createdAt: number }>;
  /** 已写入（含待写）的第一条与最后一条消息时间；还没有消息时为 0。 */
  readonly firstCreatedAt: number;
  readonly lastCreatedAt: number;
}

/** 时间线上的导入标记（开头一条来源说明，结尾一条分隔），只用于显示，不进入交接与模型上下文。 */
export interface ImportCardMeta {
  source: string;
  sourceLabel: string;
  importedAt: number;
  originalCwd: string | null;
  mode: 'native' | 'handoff';
  harness: string;
}

export async function writeImportCards(params: {
  sessionId: string;
  agentKind: string | null;
  firstCreatedAt: number;
  lastCreatedAt: number;
  meta: ImportCardMeta;
}): Promise<void> {
  const card = (phase: 'start' | 'end', createdAt: number): MessageRow => ({
    key: `card-${phase}`,
    role: 'assistant',
    content: '""',
    toolUseId: null,
    agentMeta: JSON.stringify({ sessionImport: { phase, ...params.meta } }),
    agentKind: params.agentKind,
    createdAt,
  });
  await runImportTx({
    action: 'messages',
    sessionId: params.sessionId,
    clientIdPrefix: importClientIdPrefix(params.sessionId),
    idPrefix: `imp-${params.sessionId}-`,
    rows: [card('start', params.firstCreatedAt - 1), card('end', params.lastCreatedAt + 1)],
  });
}

/**
 * 有序写入：同一毫秒的多条消息按读取顺序递增 1ms，保证在 Cindy 里的显示顺序与原记录一致。
 */
export function createMessageSink(params: {
  sessionId: string;
  agentKind: string | null;
  onWritten?: (count: number) => void;
  /** 旧版导入任务沿用旧的行键前缀（codex-import: / claude-import:），补齐时不重复。 */
  clientIdPrefix?: string;
  idPrefix?: string;
  /** 来源没有逐条时间时，从这个时间起按顺序递增。 */
  startAt?: number;
  /** 每次写库或存图片之前调用；抛错即中止（导入途中切换了账号）。 */
  beforeWrite?: () => void;
}): MessageSink {
  const prefix = params.clientIdPrefix ?? importClientIdPrefix(params.sessionId);
  const idPrefix = params.idPrefix ?? `imp-${params.sessionId}-`;
  let batch: MessageRow[] = [];
  let batchBytes = 0;
  let written = 0;
  let lastCreatedAt = 0;
  let firstCreatedAt = 0;
  const prCandidates: Array<{ role: string; content: unknown; createdAt: number }> = [];
  const flush = async () => {
    if (batch.length === 0) return;
    params.beforeWrite?.();
    const rows = batch;
    batch = [];
    batchBytes = 0;
    await runImportTx({ action: 'messages', sessionId: params.sessionId, clientIdPrefix: prefix, idPrefix, rows });
    written += rows.length;
    params.onWritten?.(written);
  };
  return {
    async push(message) {
      const floor = lastCreatedAt > 0 ? lastCreatedAt + 1 : (params.startAt ?? 1);
      const createdAt = message.createdAt > 0 ? Math.max(message.createdAt, floor) : floor;
      lastCreatedAt = createdAt;
      if (firstCreatedAt === 0) firstCreatedAt = createdAt;
      params.beforeWrite?.();
      const row = await toRow({ ...message, createdAt }, params.sessionId, params.agentKind);
      if ((message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string'
        && message.content.includes('/pull/')) {
        prCandidates.push({ role: message.role, content: message.content, createdAt });
      }
      batch.push(row);
      batchBytes += row.content.length + (row.agentMeta?.length ?? 0);
      if (batch.length >= BATCH_ROWS || batchBytes >= BATCH_BYTES) await flush();
    },
    flush,
    get written() {
      return written + batch.length;
    },
    prCandidates,
    get firstCreatedAt() {
      return firstCreatedAt;
    },
    get lastCreatedAt() {
      return lastCreatedAt;
    },
  };
}
