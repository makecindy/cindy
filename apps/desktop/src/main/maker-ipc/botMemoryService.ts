/**
 * 伙伴记忆页的读写服务:把设置页的「看 / 改 / 删」落到伙伴自己的 MakerMemoryStore。
 *
 * - 存储、MEMORY.md 索引与 FTS 由 maker-core 的 store 维护;这里不另建一份。
 * - 摘要(description)是模型读目录用的钩子,界面不展示。用户改正文时按正文首句
 *   确定性刷新,不调用模型;只改标题时保留原摘要。
 * - 保存 / 删除在共享 storage 互斥内比对 updatedAt，与伙伴工具写入串行；
 *   不一致就拒绝(BOT_MEMORY_CHANGED)，交给用户看最新内容。
 * - 运行中的伙伴在会话启动时冻结了记忆目录。改动后合并请求一次运行时刷新,
 *   让下一轮拿到新目录;刷新失败不影响已经落盘的改动。
 */

import {
  buildBotMemoryScopeKey,
  isSafeMemoryMarkdownFilename,
  MemoryError,
  parseFilename,
  PROJECT_MEMORY_HARD_BYTES,
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
import matter from 'gray-matter';

const PREVIEW_CHARS = 240;
const DESCRIPTION_MAX = 200;
/** FTS 单次命中上限与 maker-core 一致;界面上的搜索只需要最相关的这些。 */
const SEARCH_LIMIT = 50;
/** 连续编辑会产生多次保存,合并成一次运行时刷新。 */
const REFRESH_COALESCE_MS = 3_000;
const FILENAME_RE = /^(user|feedback|project|reference)_[a-z0-9_-]{1,64}\.md$/;

/** Shared with import progress so counts use the storage service's exact boundaries. */
export function splitImportedMemoryText(text: string): string[] {
  const chunks: string[] = [];
  let chunk = '', bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > BOT_MEMORY_BODY_MAX_BYTES) { chunks.push(chunk); chunk = ''; bytes = 0; }
    chunk += char; bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

interface BotMemoryOwner {
  canonicalSessionId: string | null;
  assertCurrent?: () => void;
  /** A project-mode teammate keeps its memory in its project, like an ordinary task there. */
  scopeKey?: string;
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
  return sentence.slice(0, DESCRIPTION_MAX).replace(/[\uD800-\uDBFF]$/u, '').trim();
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
    if (error.code === 'version-conflict') throwIpcError('PRECONDITION_FAILED', BOT_MEMORY_CHANGED);
    if (error.code === 'not-found') throwIpcError('NOT_FOUND', 'Memory not found');
    if (error.code === 'not-ready')
      throwIpcError('PRECONDITION_FAILED', 'Memory is not ready; retry');
    throwIpcError('INVALID_PARAMS', error.message);
  }
  throw error;
}

function readFilename(value: unknown, allowFreeform = false): string {
  if (typeof value !== 'string') throwIpcError('INVALID_PARAMS', 'Invalid memory');
  if (FILENAME_RE.test(value)) return value;
  if (
    allowFreeform
    && isSafeMemoryMarkdownFilename(value, { allowIndex: true })
    && parseFilename(value)?.type !== 'digest'
  ) {
    return value;
  }
  throwIpcError('INVALID_PARAMS', 'Invalid memory');
}

/** Cloud copies include internal shards, freeform project notes, and curated MEMORY.md. */
function readRawFilename(value: unknown, allowFreeform = false) {
  if (typeof value !== 'string') throwIpcError('INVALID_PARAMS', 'Invalid memory');
  const parsed = parseFilename(value);
  if (parsed && parsed.slug.length <= 64 && !/[^a-z0-9_-]/.test(parsed.slug)) {
    return { filename: value, parsed, freeform: false };
  }
  if (allowFreeform && isSafeMemoryMarkdownFilename(value, { allowIndex: true })) {
    return { filename: value, parsed: null, freeform: true };
  }
  throwIpcError('INVALID_PARAMS', 'Invalid memory');
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

  async function ownerOf(botId: string): Promise<BotMemoryOwner> {
    const owner = await deps.readBot(botId);
    if (!owner) throwIpcError('NOT_FOUND', 'Buddy not found');
    owner.assertCurrent?.();
    return owner;
  }

  async function storeForOwner(
    botId: string,
    owner: BotMemoryOwner,
  ): Promise<{ store: MakerMemoryStore; owner: BotMemoryOwner }> {
    try {
      owner.assertCurrent?.();
      const store = await deps.getStore(owner.scopeKey ?? buildBotMemoryScopeKey(botId));
      owner.assertCurrent?.();
      return { store, owner };
    } catch (error) {
      return translateStoreError(error);
    }
  }

  async function storeOf(
    botId: string,
  ): Promise<{ store: MakerMemoryStore; owner: BotMemoryOwner }> {
    const owner = await ownerOf(botId);
    return storeForOwner(botId, owner);
  }

  function scheduleRefresh(owner: BotMemoryOwner, changedFilename?: string): void {
    // V2 project teammates only inject MEMORY.md at session start; editing ordinary topic notes
    // on disk does not need a session runtime epoch rebuild (keeps prompt cache warm).
    if (owner.scopeKey && changedFilename && changedFilename !== 'MEMORY.md') return;
    const sessionId = owner.canonicalSessionId;
    if (!sessionId) return;
    const previous = pendingRefresh.get(sessionId);
    if (previous !== undefined) clearTimer(previous);
    pendingRefresh.set(
      sessionId,
      setTimer(() => {
        pendingRefresh.delete(sessionId);
        try {
          owner.assertCurrent?.();
          void deps.requestRefresh(sessionId).catch(() => {});
        } catch {
          // The initiating account has left; never refresh another account's runtime.
        }
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
    /** Deterministic source-document import; uses the same index, FTS and owner fence as settings. */
    async importDocument(botId: string, id: string, title: string, text: string, type: 'user' | 'reference' = 'reference'): Promise<void> {
      if (!/^[a-z0-9_-]{1,40}$/.test(id) || !text.trim()) throwIpcError('INVALID_PARAMS', 'Invalid imported memory');
      const { store, owner } = await storeOf(botId);
      const chunks = splitImportedMemoryText(text);
      for (const [index, body] of chunks.entries()) {
        // Whitespace inside a source document is content too.
        if (!body) continue;
        const name = `import_${id}_${index}`;
        try { await serialized(`${botId}/${type}_${name}.md`, async () => {
          owner.assertCurrent?.();
          const existing = await store.read(`${type}_${name}.md`).catch(error => {
            if (error instanceof MemoryError && error.code === 'not-found') return null;
            throw error;
          });
          if (existing) {
            // Exact-body imports include whitespace in their identity. Only old
            // shards whose storage format discarded it use the legacy comparison.
            const unchanged = existing.frontmatter.bodyLength === undefined
              ? existing.body.trim() === body.trim() : existing.body === body;
            if (!unchanged) throw new MemoryError('version-conflict', '[PRECONDITION_FAILED] Imported memory was edited');
            return;
          }
          await store.write({ type, name, title: title.slice(0, BOT_MEMORY_TITLE_MAX).replace(/[\uD800-\uDBFF]$/u, ''),
            description: botMemoryDescriptionFromBody(body) || botMemoryDescriptionFromBody(title) || id, body, preserveBody: true });
          const saved = await store.read(`${type}_${name}.md`);
          if (saved.body !== body) throw new MemoryError('io-error', 'Imported content readback mismatch');
          owner.assertCurrent?.();
        }); } catch (error) {
          if (error instanceof Error) Object.assign(error, { importProgress: { saved: index, total: chunks.length } });
          throw error;
        }
      }
      scheduleRefresh(owner);
    },
    async list(botId: string, rawQuery?: unknown): Promise<BotMemorySummary[]> {
      const { store } = await storeOf(botId);
      const query = typeof rawQuery === 'string' ? rawQuery.trim().slice(0, 200) : '';
      try {
        if (!query) {
          return (await store.list()).flatMap((record) => toSummary(record) ?? []).sort(byNewest);
        }
        const hits = await store.search(query, { limit: SEARCH_LIMIT, excludeTypes: ['digest'] });
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
      const owner = await ownerOf(botId);
      const filename = readFilename(rawFilename, !!owner.scopeKey);
      const { store } = await storeForOwner(botId, owner);
      return toDetail(await store.read(filename).catch(translateStoreError));
    },

    async update(input: BotMemoryUpdateInput): Promise<BotMemoryDetail> {
      const expected = readExpected(input.expectedUpdatedAt);
      if (typeof input.title !== 'string' || typeof input.body !== 'string') {
        throwIpcError('INVALID_PARAMS', 'Invalid memory');
      }
      const title = input.title.replace(/\s+/g, ' ').trim();
      const body = input.body.trim();
      if (!title || Array.from(title).length > BOT_MEMORY_TITLE_MAX) {
        throwIpcError('INVALID_PARAMS', 'Invalid memory title');
      }
      const owner = await ownerOf(input.botId);
      const filename = readFilename(input.filename, !!owner.scopeKey);
      const maxBodyBytes = owner.scopeKey ? PROJECT_MEMORY_HARD_BYTES : BOT_MEMORY_BODY_MAX_BYTES;
      if (!body || Buffer.byteLength(body, 'utf8') > maxBodyBytes) {
        throwIpcError('INVALID_PARAMS', 'Invalid memory content');
      }
      const { store } = await storeForOwner(input.botId, owner);
      return serialized(`${input.botId}/${filename}`, async () => {
        const current = await readCurrent(store, filename, expected);
        const type = current.frontmatter.type;
        if (!isBotMemoryType(type)) throwIpcError('NOT_FOUND', 'Memory not found');
        if (current.frontmatter.title === title && current.body === body) return toDetail(current);
        const description =
          current.body === body
            ? current.frontmatter.description
            : botMemoryDescriptionFromBody(body) || title;
        const saved = toDetail(await store
          .update(filename, expected, { title, description, body })
          .catch(translateStoreError));
        scheduleRefresh(owner, filename);
        return saved;
      });
    },

    /**
     * Restore one memory file exactly as another computer stored it (cloud companions).
     * Goes through the store so FTS and runtime refresh stay consistent; V2 project stores
     * preserve freeform Markdown files, MEMORY.md and >8KB notes verbatim via writeRaw.
     */
    async restoreRaw(botId: string, rawFilename: unknown, raw: string): Promise<void> {
      const owner = await ownerOf(botId);
      const allowFreeform = !!owner.scopeKey;
      const target = readRawFilename(rawFilename, allowFreeform);
      const { filename } = target;
      if (allowFreeform && (target.freeform || filename === 'MEMORY.md' || Buffer.byteLength(raw, 'utf8') > BOT_MEMORY_BODY_MAX_BYTES)) {
        if (!raw.trim()) throwIpcError('INVALID_PARAMS', 'Invalid memory content');
        const { store } = await storeForOwner(botId, owner);
        await serialized(`${botId}/${filename}`, async () => {
          owner.assertCurrent?.();
          await store.writeRaw(filename, raw).catch(translateStoreError);
          owner.assertCurrent?.();
        });
        scheduleRefresh(owner, filename);
        return;
      }
      if (!target.parsed) throwIpcError('INVALID_PARAMS', 'Invalid memory');
      const { type, slug: name } = target.parsed;
      const parsed = matter(raw);
      const data = parsed.data as { title?: unknown; description?: unknown; bodyLength?: unknown };
      const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim().slice(0, BOT_MEMORY_TITLE_MAX) : name;
      const exact = Number.isSafeInteger(data.bodyLength) && parsed.content.length === (data.bodyLength as number) + 1 && parsed.content.endsWith('\n');
      const body = exact ? parsed.content.slice(0, -1) : parsed.content.trim();
      if (!body) throwIpcError('INVALID_PARAMS', 'Invalid memory content');
      const description = typeof data.description === 'string' && data.description.trim()
        ? data.description.trim().slice(0, DESCRIPTION_MAX) : botMemoryDescriptionFromBody(body) || title;
      const { store } = await storeForOwner(botId, owner);
      await serialized(`${botId}/${filename}`, async () => {
        owner.assertCurrent?.();
        const existing = await store.read(filename).catch((error: unknown) => {
          if (error instanceof MemoryError && error.code === 'not-found') return null;
          throw error;
        });
        // 传完整文件名: 恢复要原样重建旧分片 (可能带 <type>- 前缀), 不能当成新 slug
        await store.write({ type, name: filename, title, description, body,
          mode: existing ? 'update' : 'create', preserveBody: exact }).catch(translateStoreError);
        owner.assertCurrent?.();
      });
      scheduleRefresh(owner, filename);
    },

    /** Remove a memory regardless of its version (cloud tombstone). Missing is fine. */
    async removeRaw(botId: string, rawFilename: unknown): Promise<void> {
      const owner = await ownerOf(botId);
      const { filename } = readRawFilename(rawFilename, !!owner.scopeKey);
      const { store } = await storeForOwner(botId, owner);
      await serialized(`${botId}/${filename}`, async () => {
        await store.delete(filename).catch((error: unknown) => {
          if (error instanceof MemoryError && error.code === 'not-found') return;
          translateStoreError(error);
        });
      });
      scheduleRefresh(owner, filename);
    },

    async delete(input: BotMemoryDeleteInput): Promise<void> {
      const expected = readExpected(input.expectedUpdatedAt);
      const owner = await ownerOf(input.botId);
      const filename = readFilename(input.filename, !!owner.scopeKey);
      const { store } = await storeForOwner(input.botId, owner);
      await serialized(`${input.botId}/${filename}`, async () => {
        await readCurrent(store, filename, expected);
        await store.delete(filename, expected).catch(translateStoreError);
      });
      scheduleRefresh(owner, filename);
    },
  };
}
