/**
 * 「查看记忆」页的读写规则: 伙伴记忆页与 Cindy 记忆页共用这一份。
 *
 * 两个页面只在「记忆属于谁」上不同(伙伴 / Cindy 记忆的某个范围); 拿到那一份
 * MakerMemoryStore 之后, 列表、搜索、读取、保存、删除的规则完全一样:
 * - 只展示四类正式记忆, 内部 `digest` 不进列表、不能读改删。
 * - 摘要(description)是模型读目录用的钩子, 界面不展示。用户改正文时按正文首句
 *   确定性刷新, 不调用模型; 只改标题时保留原摘要。
 * - 保存 / 删除先比对打开时的 updatedAt, 不一致就拒绝(BOT_MEMORY_CHANGED),
 *   交给用户看最新内容; 同一条记忆的保存与删除在本进程内串行。
 */

import { MemoryError, type MakerMemoryStore, type MemoryRecord } from '@cindy/maker-core';

import {
  BOT_MEMORY_BODY_MAX_BYTES,
  BOT_MEMORY_CHANGED,
  BOT_MEMORY_TITLE_MAX,
  BOT_MEMORY_TYPES,
  type BotMemoryDetail,
  type BotMemorySummary,
  type BotMemoryType,
} from '../../shared/botMemory.js';
import { throwIpcError } from '../utils/ipcValidate.js';

const PREVIEW_CHARS = 240;
export const MEMORY_DESCRIPTION_MAX = 200;
/** FTS 单次命中上限与 maker-core 一致;界面上的搜索只需要最相关的这些。 */
const SEARCH_LIMIT = 50;
const FILENAME_RE = /^(user|feedback|project|reference)_[a-z0-9_-]{1,64}\.md$/;

/** 一份可以被页面读写的记忆: 某个伙伴的, 或 Cindy 记忆的某个范围。 */
export interface MemoryEntryTarget {
  store: MakerMemoryStore;
  /** 同一条记忆的保存 / 删除按 `<lockKey>/<filename>` 串行; 每份记忆一个唯一值。 */
  lockKey: string;
  /** 保存或删除已经落盘之后调用一次(伙伴用它合并请求运行时刷新)。 */
  onChanged?(): void;
}

export interface MemoryEntryUpdate {
  filename: string;
  expected: string;
  title: string;
  body: string;
}

const isMemoryEntryType = (value: string): value is BotMemoryType =>
  (BOT_MEMORY_TYPES as readonly string[]).includes(value);

/** 正文里去掉 Markdown 列表符号与换行后的纯文本。 */
function plainText(body: string): string {
  return body
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^#+\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 模型目录用的一句话摘要:正文首句,单行、不超过 store 的 200 字上限。 */
export function memoryDescriptionFromBody(body: string): string {
  const text = plainText(body);
  const sentence = /^.+?[。！？!?；;](?=\s|$|[^。！？!?；;])/u.exec(text)?.[0] ?? text;
  return sentence.slice(0, MEMORY_DESCRIPTION_MAX).replace(/[\uD800-\uDBFF]$/u, '').trim();
}

function preview(body: string): string {
  const text = plainText(body);
  const chars = Array.from(text);
  return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join('')}…` : text;
}

function toSummary(record: MemoryRecord): BotMemorySummary | null {
  const type = record.frontmatter.type;
  if (!isMemoryEntryType(type)) return null;
  return {
    filename: record.filename,
    type,
    title: record.frontmatter.title,
    preview: preview(record.body),
    updatedAt: record.frontmatter.updatedAt,
  };
}

function toDetail(record: MemoryRecord): BotMemoryDetail {
  const type = record.frontmatter.type;
  if (!isMemoryEntryType(type)) throwIpcError('NOT_FOUND', 'Memory not found');
  return {
    filename: record.filename,
    type,
    title: record.frontmatter.title,
    body: record.body,
    updatedAt: record.frontmatter.updatedAt,
  };
}

const byNewest = (a: BotMemorySummary, b: BotMemorySummary) =>
  b.updatedAt.localeCompare(a.updatedAt) || a.filename.localeCompare(b.filename);

export function translateMemoryStoreError(error: unknown): never {
  if (error instanceof MemoryError) {
    if (error.code === 'version-conflict') throwIpcError('PRECONDITION_FAILED', BOT_MEMORY_CHANGED);
    if (error.code === 'not-found') throwIpcError('NOT_FOUND', 'Memory not found');
    if (error.code === 'not-ready')
      throwIpcError('PRECONDITION_FAILED', 'Memory is not ready; retry');
    throwIpcError('INVALID_PARAMS', error.message);
  }
  throw error;
}

export function readMemoryFilename(value: unknown): string {
  if (typeof value !== 'string' || !FILENAME_RE.test(value)) {
    throwIpcError('INVALID_PARAMS', 'Invalid memory');
  }
  return value;
}

function readExpected(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 64) {
    throwIpcError('INVALID_PARAMS', 'Invalid memory version');
  }
  return value;
}

/** 校验一次保存的入参并规范化标题与正文; 不合法在打开任何存储之前就拒绝。 */
export function parseMemoryEntryUpdate(input: {
  filename: unknown;
  title: unknown;
  body: unknown;
  expectedUpdatedAt: unknown;
}): MemoryEntryUpdate {
  const filename = readMemoryFilename(input.filename);
  const expected = readExpected(input.expectedUpdatedAt);
  if (typeof input.title !== 'string' || typeof input.body !== 'string') {
    throwIpcError('INVALID_PARAMS', 'Invalid memory');
  }
  const title = input.title.replace(/\s+/g, ' ').trim();
  const body = input.body.trim();
  if (!title || Array.from(title).length > BOT_MEMORY_TITLE_MAX) {
    throwIpcError('INVALID_PARAMS', 'Invalid memory title');
  }
  if (!body || Buffer.byteLength(body, 'utf8') > BOT_MEMORY_BODY_MAX_BYTES) {
    throwIpcError('INVALID_PARAMS', 'Invalid memory content');
  }
  return { filename, expected, title, body };
}

export function parseMemoryEntryDelete(input: {
  filename: unknown;
  expectedUpdatedAt: unknown;
}): { filename: string; expected: string } {
  return {
    filename: readMemoryFilename(input.filename),
    expected: readExpected(input.expectedUpdatedAt),
  };
}

/** 一个进程内的读写入口: 持有按记忆串行的队列, 伙伴与 Cindy 记忆各建一个。 */
export function createMemoryEntryAccess() {
  const locks = new Map<string, Promise<unknown>>();

  async function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    locks.set(key, next);
    try {
      return await next;
    } finally {
      if (locks.get(key) === next) locks.delete(key);
    }
  }

  async function readCurrent(store: MakerMemoryStore, filename: string, expected: string) {
    const current = await store.read(filename).catch(translateMemoryStoreError);
    if (current.frontmatter.updatedAt !== expected) {
      throwIpcError('PRECONDITION_FAILED', BOT_MEMORY_CHANGED);
    }
    return current;
  }

  return {
    serialized,

    async list(store: MakerMemoryStore, rawQuery?: unknown): Promise<BotMemorySummary[]> {
      const query = typeof rawQuery === 'string' ? rawQuery.trim().slice(0, 200) : '';
      try {
        if (!query) {
          return (await store.list()).flatMap((record) => toSummary(record) ?? []).sort(byNewest);
        }
        const hits = await store.search(query, { limit: SEARCH_LIMIT });
        const entries: BotMemorySummary[] = [];
        for (const hit of hits) {
          if (!isMemoryEntryType(hit.type)) continue;
          // 命中与读取之间可能被 Agent 删掉,跳过即可。
          const record = await store.read(hit.filename).catch((error: unknown) => {
            if (error instanceof MemoryError && error.code === 'not-found') return null;
            throw error;
          });
          const summary = record ? toSummary(record) : null;
          if (summary) entries.push(summary);
        }
        return entries;
      } catch (error) {
        return translateMemoryStoreError(error);
      }
    },

    async read(store: MakerMemoryStore, filename: string): Promise<BotMemoryDetail> {
      return toDetail(await store.read(filename).catch(translateMemoryStoreError));
    },

    update(target: MemoryEntryTarget, input: MemoryEntryUpdate): Promise<BotMemoryDetail> {
      const { filename, expected, title, body } = input;
      return serialized(`${target.lockKey}/${filename}`, async () => {
        const current = await readCurrent(target.store, filename, expected);
        if (!isMemoryEntryType(current.frontmatter.type)) {
          throwIpcError('NOT_FOUND', 'Memory not found');
        }
        if (current.frontmatter.title === title && current.body === body) return toDetail(current);
        const description =
          current.body === body
            ? current.frontmatter.description
            : memoryDescriptionFromBody(body) || title;
        const saved = toDetail(
          await target.store
            .update(filename, expected, { title, description, body })
            .catch(translateMemoryStoreError),
        );
        target.onChanged?.();
        return saved;
      });
    },

    async delete(
      target: MemoryEntryTarget,
      input: { filename: string; expected: string },
    ): Promise<void> {
      await serialized(`${target.lockKey}/${input.filename}`, async () => {
        await readCurrent(target.store, input.filename, input.expected);
        await target.store.delete(input.filename, input.expected).catch(translateMemoryStoreError);
      });
      target.onChanged?.();
    },
  };
}
