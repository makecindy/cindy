/**
 * 伙伴记忆页的读写服务:把设置页的「看 / 改 / 删」落到伙伴自己的 MakerMemoryStore。
 *
 * - 存储、MEMORY.md 索引与 FTS 由 maker-core 的 store 维护;这里不另建一份。
 * - 摘要(description)是模型读目录用的钩子,界面不展示。用户改正文时按正文首句
 *   确定性刷新,不调用模型;只改标题时保留原摘要。
 * - store 本身是 last-write-wins。伙伴可能在用户编辑期间写同一条,所以保存 / 删除前
 *   比对打开时看到的 updatedAt,不一致就拒绝(BOT_MEMORY_CHANGED),交给用户看最新内容。
 *   同一条记忆在本进程内串行,避免两次保存交错;与伙伴工具之间仍有极短的检查-写入窗口。
 * - 运行中的伙伴在会话启动时冻结了记忆目录。改动后合并请求一次运行时刷新,
 *   让下一轮拿到新目录;刷新失败不影响已经落盘的改动。
 */

import {
  buildBotMemoryScopeKey,
  MemoryError,
  type MakerMemoryStore,
  type MemoryRecord,
} from '@cindy/maker-core';

import {
  BOT_MEMORY_BODY_MAX_BYTES,
  BOT_MEMORY_CHANGED,
  BOT_MEMORY_TITLE_MAX,
  BOT_MEMORY_TYPES,
  type BotMemoryDeleteInput,
  type BotMemoryDetail,
  type BotMemorySummary,
  type BotMemoryType,
  type BotMemoryUpdateInput,
} from '../../shared/botMemory.js';
import { throwIpcError } from '../utils/ipcValidate.js';

const PREVIEW_CHARS = 240;
const DESCRIPTION_MAX = 200;
/** FTS 单次命中上限与 maker-core 一致;界面上的搜索只需要最相关的这些。 */
const SEARCH_LIMIT = 50;
/** 连续编辑会产生多次保存,合并成一次运行时刷新。 */
const REFRESH_COALESCE_MS = 3_000;
const FILENAME_RE = /^(user|feedback|project|reference)_[a-z0-9_-]{1,64}\.md$/;

interface BotMemoryOwner {
  canonicalSessionId: string | null;
}

export interface BotMemoryServiceDeps {
  getStore(scopeKey: string): Promise<MakerMemoryStore>;
  /** 当前账号下的伙伴;不存在或正在删除时返回 null。 */
  readBot(botId: string): Promise<BotMemoryOwner | null>;
  requestRefresh(sessionId: string): Promise<unknown>;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const isBotMemoryType = (value: string): value is BotMemoryType =>
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
export function botMemoryDescriptionFromBody(body: string): string {
  const text = plainText(body);
  const sentence = /^.+?[。！？!?；;](?=\s|$|[^。！？!?；;])/u.exec(text)?.[0] ?? text;
  return Array.from(sentence).slice(0, DESCRIPTION_MAX).join('').trim();
}

function preview(body: string): string {
  const text = plainText(body);
  const chars = Array.from(text);
  return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join('')}…` : text;
}

function toSummary(record: MemoryRecord): BotMemorySummary | null {
  const type = record.frontmatter.type;
  if (!isBotMemoryType(type)) return null;
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
  if (!isBotMemoryType(type)) throwIpcError('NOT_FOUND', 'Memory not found');
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

function translateStoreError(error: unknown): never {
  if (error instanceof MemoryError) {
    if (error.code === 'not-found') throwIpcError('NOT_FOUND', 'Memory not found');
    if (error.code === 'not-ready')
      throwIpcError('PRECONDITION_FAILED', 'Memory is not ready; retry');
    throwIpcError('INVALID_PARAMS', error.message);
  }
  throw error;
}

function readFilename(value: unknown): string {
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

export function createBotMemoryService(deps: BotMemoryServiceDeps) {
  const locks = new Map<string, Promise<unknown>>();
  const pendingRefresh = new Map<string, unknown>();
  const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer =
    deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  async function storeOf(
    botId: string,
  ): Promise<{ store: MakerMemoryStore; owner: BotMemoryOwner }> {
    const owner = await deps.readBot(botId);
    if (!owner) throwIpcError('NOT_FOUND', 'Teammate not found');
    try {
      return { store: await deps.getStore(buildBotMemoryScopeKey(botId)), owner };
    } catch (error) {
      return translateStoreError(error);
    }
  }

  function scheduleRefresh(owner: BotMemoryOwner): void {
    const sessionId = owner.canonicalSessionId;
    if (!sessionId) return;
    const previous = pendingRefresh.get(sessionId);
    if (previous !== undefined) clearTimer(previous);
    pendingRefresh.set(
      sessionId,
      setTimer(() => {
        pendingRefresh.delete(sessionId);
        void deps.requestRefresh(sessionId).catch(() => {});
      }, REFRESH_COALESCE_MS),
    );
  }

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
    const current = await store.read(filename).catch(translateStoreError);
    if (current.frontmatter.updatedAt !== expected) {
      throwIpcError('PRECONDITION_FAILED', BOT_MEMORY_CHANGED);
    }
    return current;
  }

  return {
    async list(botId: string, rawQuery?: unknown): Promise<BotMemorySummary[]> {
      const { store } = await storeOf(botId);
      const query = typeof rawQuery === 'string' ? rawQuery.trim().slice(0, 200) : '';
      try {
        if (!query) {
          return (await store.list()).flatMap((record) => toSummary(record) ?? []).sort(byNewest);
        }
        const hits = await store.search(query, { limit: SEARCH_LIMIT });
        const entries: BotMemorySummary[] = [];
        for (const hit of hits) {
          if (!isBotMemoryType(hit.type)) continue;
          // 命中与读取之间可能被伙伴删掉,跳过即可。
          const record = await store.read(hit.filename).catch((error: unknown) => {
            if (error instanceof MemoryError && error.code === 'not-found') return null;
            throw error;
          });
          const summary = record ? toSummary(record) : null;
          if (summary) entries.push(summary);
        }
        return entries;
      } catch (error) {
        return translateStoreError(error);
      }
    },

    async read(botId: string, rawFilename: unknown): Promise<BotMemoryDetail> {
      const filename = readFilename(rawFilename);
      const { store } = await storeOf(botId);
      return toDetail(await store.read(filename).catch(translateStoreError));
    },

    async update(input: BotMemoryUpdateInput): Promise<BotMemoryDetail> {
      const filename = readFilename(input.filename);
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
      const { store, owner } = await storeOf(input.botId);
      return serialized(`${input.botId}/${filename}`, async () => {
        const current = await readCurrent(store, filename, expected);
        const type = current.frontmatter.type;
        if (!isBotMemoryType(type)) throwIpcError('NOT_FOUND', 'Memory not found');
        if (current.frontmatter.title === title && current.body === body) return toDetail(current);
        const description =
          current.body === body
            ? current.frontmatter.description
            : botMemoryDescriptionFromBody(body) || title;
        await store
          .write({ type, name: current.slug, title, description, body, mode: 'update' })
          .catch(translateStoreError);
        const saved = toDetail(await store.read(filename).catch(translateStoreError));
        scheduleRefresh(owner);
        return saved;
      });
    },

    async delete(input: BotMemoryDeleteInput): Promise<void> {
      const filename = readFilename(input.filename);
      const expected = readExpected(input.expectedUpdatedAt);
      const { store, owner } = await storeOf(input.botId);
      await serialized(`${input.botId}/${filename}`, async () => {
        await readCurrent(store, filename, expected);
        await store.delete(filename).catch(translateStoreError);
      });
      scheduleRefresh(owner);
    },
  };
}
