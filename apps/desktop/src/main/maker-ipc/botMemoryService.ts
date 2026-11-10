/**
 * 伙伴记忆页的读写服务:把设置页的「看 / 改 / 删」落到伙伴自己的 MakerMemoryStore。
 *
 * - 存储、MEMORY.md 索引与 FTS 由 maker-core 的 store 维护;这里不另建一份。
 * - 列表、搜索、读取、保存、删除的规则(只展示四类、摘要按正文首句刷新、保存前比对
 *   updatedAt)与 Cindy 记忆页共用,见 memoryEntries.ts;这里只负责「哪个伙伴的记忆」
 *   与伙伴独有的导入、云端恢复。
 * - 保存 / 删除在共享 storage 互斥内比对 updatedAt，与伙伴工具写入串行；
 *   不一致就拒绝(BOT_MEMORY_CHANGED)，交给用户看最新内容。
 * - 运行中的伙伴在会话启动时冻结了记忆目录。改动后合并请求一次运行时刷新,
 *   让下一轮拿到新目录;刷新失败不影响已经落盘的改动。
 */

import {
  buildBotMemoryScopeKey,
  MemoryError,
  type MakerMemoryStore,
} from '@cindy/maker-core';

import {
  BOT_MEMORY_BODY_MAX_BYTES,
  BOT_MEMORY_TITLE_MAX,
  type BotMemoryDeleteInput,
  type BotMemoryDetail,
  type BotMemorySummary,
  type BotMemoryType,
  type BotMemoryUpdateInput,
} from '../../shared/botMemory.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import matter from 'gray-matter';
import {
  createMemoryEntryAccess,
  MEMORY_DESCRIPTION_MAX as DESCRIPTION_MAX,
  memoryDescriptionFromBody,
  parseMemoryEntryDelete,
  parseMemoryEntryUpdate,
  readMemoryFilename as readFilename,
  translateMemoryStoreError as translateStoreError,
  type MemoryEntryTarget,
} from './memoryEntries.js';

/** 连续编辑会产生多次保存,合并成一次运行时刷新。 */
const REFRESH_COALESCE_MS = 3_000;

/** 伙伴导入与云端恢复沿用的名字;规则本身在 memoryEntries.ts。 */
export const botMemoryDescriptionFromBody = memoryDescriptionFromBody;

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

export function createBotMemoryService(deps: BotMemoryServiceDeps) {
  const access = createMemoryEntryAccess();
  const { serialized } = access;
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
      owner.assertCurrent?.();
      const store = await deps.getStore(owner.scopeKey ?? buildBotMemoryScopeKey(botId));
      owner.assertCurrent?.();
      return { store, owner };
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
        try {
          owner.assertCurrent?.();
          void deps.requestRefresh(sessionId).catch(() => {});
        } catch {
          // The initiating account has left; never refresh another account's runtime.
        }
      }, REFRESH_COALESCE_MS),
    );
  }

  /** 伙伴这一份记忆在共用读写规则里的样子:改动后合并请求一次运行时刷新。 */
  const targetOf = (botId: string, store: MakerMemoryStore, owner: BotMemoryOwner): MemoryEntryTarget => ({
    store,
    lockKey: botId,
    onChanged: () => scheduleRefresh(owner),
  });

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
      return access.list(store, rawQuery);
    },

    async read(botId: string, rawFilename: unknown): Promise<BotMemoryDetail> {
      const filename = readFilename(rawFilename);
      const { store } = await storeOf(botId);
      return access.read(store, filename);
    },

    async update(input: BotMemoryUpdateInput): Promise<BotMemoryDetail> {
      const update = parseMemoryEntryUpdate(input);
      const { store, owner } = await storeOf(input.botId);
      return access.update(targetOf(input.botId, store, owner), update);
    },

    /**
     * Restore one memory file exactly as another computer stored it (cloud companions).
     * Goes through the store so MEMORY.md, FTS and the runtime refresh stay consistent.
     */
    async restoreRaw(botId: string, rawFilename: unknown, raw: string): Promise<void> {
      const filename = readFilename(rawFilename);
      const [, type, name] = /^([a-z]+)_(.+)\.md$/.exec(filename)!;
      const parsed = matter(raw);
      const data = parsed.data as { title?: unknown; description?: unknown; bodyLength?: unknown };
      const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim().slice(0, BOT_MEMORY_TITLE_MAX) : name!;
      const exact = Number.isSafeInteger(data.bodyLength) && parsed.content.length === (data.bodyLength as number) + 1 && parsed.content.endsWith('\n');
      const body = exact ? parsed.content.slice(0, -1) : parsed.content.trim();
      if (!body) throwIpcError('INVALID_PARAMS', 'Invalid memory content');
      const description = typeof data.description === 'string' && data.description.trim()
        ? data.description.trim().slice(0, DESCRIPTION_MAX) : botMemoryDescriptionFromBody(body) || title;
      const { store, owner } = await storeOf(botId);
      await serialized(`${botId}/${filename}`, async () => {
        owner.assertCurrent?.();
        const existing = await store.read(filename).catch((error: unknown) => {
          if (error instanceof MemoryError && error.code === 'not-found') return null;
          throw error;
        });
        await store.write({ type: type as BotMemoryType, name: name!, title, description, body,
          mode: existing ? 'update' : 'create', preserveBody: exact }).catch(translateStoreError);
        owner.assertCurrent?.();
      });
      scheduleRefresh(owner);
    },

    /** Remove a memory regardless of its version (cloud tombstone). Missing is fine. */
    async removeRaw(botId: string, rawFilename: unknown): Promise<void> {
      const filename = readFilename(rawFilename);
      const { store, owner } = await storeOf(botId);
      await serialized(`${botId}/${filename}`, async () => {
        await store.delete(filename).catch((error: unknown) => {
          if (error instanceof MemoryError && error.code === 'not-found') return;
          translateStoreError(error);
        });
      });
      scheduleRefresh(owner);
    },

    async delete(input: BotMemoryDeleteInput): Promise<void> {
      const target = parseMemoryEntryDelete(input);
      const { store, owner } = await storeOf(input.botId);
      await access.delete(targetOf(input.botId, store, owner), target);
    },
  };
}
