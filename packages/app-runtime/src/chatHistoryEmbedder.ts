/**
 * chat-history-embedder — embedding-host 的第一个业务 consumer (Phase 1.2)。
 *
 * 职责:
 *   1. 启动时向 EmbeddingService 注册 'chat' source 的 Provider + 'chat_messages_vec_v1' vec 表
 *      (provider 注册是永久的, 不随 enabled 开关变化 —— 开关只控制是否 enqueue)
 *   2. 暴露 onMessageCreated(msg) hook 给 messages IPC 调用; 内部按 enabled / cutoff /
 *      role / size 守卫决定是否入队
 *   3. 暴露 setChatEmbeddingEnabled / isChatEmbeddingEnabled 给 settings store + bootstrap
 *      切换运行时状态; setEnabled(true) 第一次会在 embedding_meta 表写入 cutoff
 *      (chat_embedding_started_at), 之后再 toggle 永不重置
 *
 * 设计取舍:
 *   - 不做"动态注册 / 取消注册 Provider": 入队前的 enabled 守卫已经决定性 ——
 *     关掉就不会新入队, 旧的 pending job 也能继续做完不浪费 (用户花的钱)
 *   - 不做 backfill: cutoff 之前的历史消息永不补嵌入, 这是产品决策
 *   - hook 调用方使用 fire-and-forget (void onMessageCreated(...).catch(...));
 *     本模块内部也保证不抛出错让 createMessage IPC 路径变慢
 */

import type { EmbeddingService } from '@cindy/runtime-db/embedding/EmbeddingService';
import type { DbClient } from '@cindy/runtime-db';
import type { Message, MessageRole } from './sessionTypes.js';
import { isSyntheticTriggerText } from '@cindy/maker-shared/interrupted-turn';
import type {DbLogger} from '@cindy/runtime-db/logging';


export interface ChatHistoryEmbedderDeps {
  service: EmbeddingService;
  /** DbClient 句柄, 用于读/写 embedding_meta KV 与 message 文本 */
  getDbClient: () => DbClient;
  log: DbLogger;
}
export function createChatHistoryEmbedder() {



const SOURCE = 'chat';

/**
 * chat embedding 的模型 / vec 表 / 维度 —— 写入侧(本模块)与查询侧
 * (localDb/chatHistorySearch.ts 的语义检索)共享的"单一事实源", 导出复用。
 *
 * 为什么必须共享而不能各写一份:
 *   - 模型不同 → query 向量与库内向量落在不同语义空间, 相似度无意义
 *   - 维度不同 → EmbeddingService.searchVectors 直接抛 dim mismatch
 * 改这三个值(如来日切 voyage-4-large / 换表 _v2)时, 写入与查询自动同步。
 */
const CHAT_EMBED_MODEL_ID = 'voyage/voyage-4';
const CHAT_VEC_TABLE = 'chat_messages_vec_v1';
const CHAT_EMBED_DIM = 1024;

const MODEL_ID = CHAT_EMBED_MODEL_ID;
const VEC_TABLE = CHAT_VEC_TABLE;
const DIM = CHAT_EMBED_DIM;
const CUTOFF_KEY = 'chat_embedding_started_at';

/**
 * 默认入队的 role 白名单 ——
 *   user      : 用户提问
 *   assistant : 助手回复 (主要语义信号)
 *   ask_user  : agent 主动询问 (含问题文本)
 *   plan_review : agent 提议的 plan (含 plan 文本)
 * tool_use / tool_result / thinking 是技术性 role, 体积大且语义噪音多, 不嵌入。
 */
const EMBED_ROLES: ReadonlySet<MessageRole> = new Set([
  'user',
  'assistant',
  'ask_user',
  'plan_review',
] as const);

/**
 * 单条消息文本上界 — 超过就跳过, 不嵌入 (避免把大段日志 / 代码塞进 chat 时撑爆
 * 单条 embedding 调用)。30KB 对正常对话宽裕 (UTF-8 中文 ~ 1 万字)。
 */
const MAX_TEXT_BYTES = 30 * 1024;

let _deps: ChatHistoryEmbedderDeps | null = null;
let _enabled = false;
/** 内存 cache 的 cutoff (unix ms); null = 未初始化 (用户从未开过); 等于 'unset' 时强制下次 read DB */
let _cutoffMs: number | null = null;
let _cutoffLoaded = false;

/**
 * 启动期一次性: 注册 Provider 与 vec 表元信息。
 *
 * Provider 注册是幂等的 (registerProvider 内部 Map.set 覆盖, 重复注册等价于 last-write-wins,
 * 但本进程只有一处调用), 即使后续 enabled=false 也不会取消注册 —— 这样旧 pending
 * job 不会因为开关切换而被 Worker 跳过。
 */
function setupChatHistoryEmbedder(deps: ChatHistoryEmbedderDeps): void {
  _deps = deps;

  deps.service.registerVecTable({
    vecTable: VEC_TABLE,
    source: SOURCE,
    modelId: MODEL_ID,
    dim: DIM,
    notes: 'chat 消息默认 embedding 表 (1024d voyage-4)',
  });

  deps.service.registerProvider({
    source: SOURCE,
    getTextsForJobs: async (jobs) => {
      if (jobs.length === 0) return [];
      // sourceId 是 messages.id (string cuid)。SQLite IN-list 用 ? 占位符拼接,
      // 数量上限是 Worker BATCH_SIZE (=32), 远低于 SQLite 默认 999 上限。
      const placeholders = jobs.map(() => '?').join(',');
      const rows = await deps.getDbClient().query<{
        id: string;
        role: string;
        content: string;
        rewind_at: number | null;
      }>(
        `SELECT id, role, content, rewind_at
           FROM messages
          WHERE id IN (${placeholders})`,
        jobs.map((j) => j.sourceId),
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      return jobs.map((j) => {
        const r = byId.get(j.sourceId);
        // 行已不在 (cascade delete 等) 或被 rewind → 返 null, Worker 把 job 标 done
        if (!r || r.rewind_at !== null) return { rowid: j.rowid, text: null };
        const text = extractEmbedText(r.role as MessageRole, r.content);
        return { rowid: j.rowid, text };
      });
    },
  });

  deps.log.info(
    JSON.stringify({
      event: 'chatHistoryEmbedder.setup',
      source: SOURCE,
      vecTable: VEC_TABLE,
      modelId: MODEL_ID,
    }),
  );
}

/**
 * 设置启用状态。第一次置 true 时, 在 embedding_meta 表写入 cutoff 时间戳
 * (chat_embedding_started_at) —— 该时刻之前的消息永不补嵌入。
 *
 * 关 → 开往返不重置 cutoff (保持原始锚点)。
 */
function setChatEmbeddingEnabled(enabled: boolean): void {
  if (!_deps) {
    // bootstrap 顺序问题: setupChatHistoryEmbedder 必须先于本函数调用。
    // 调用方 (settings IPC / bootstrap) 要保证顺序; 此处仅记一行 warn 并暂存 enabled
    // 等 setup 后再生效, 让 settings store 不至于因为时序问题落入"永久关"。
    _enabled = enabled;
    return;
  }
  const wasEnabled = _enabled;
  _enabled = enabled;
  if (enabled && !wasEnabled) {
    // 首次开启 (cold start 或用户 toggle on) — 确保 cutoff 已落盘
    void ensureCutoff();
  }
  _deps.log.info(
    JSON.stringify({
      event: 'chatHistoryEmbedder.setEnabled',
      enabled,
      cutoffMs: _cutoffMs,
    }),
  );
}

function isChatEmbeddingEnabled(): boolean {
  return _enabled;
}

/**
 * messages IPC createMessage 末尾调用的 hook (fire-and-forget)。
 *
 * 守卫顺序 (任一不满足 → 直接 return, 零成本):
 *   1. 全局 enabled 开关
 *   2. cutoff 已存在 (从未启用过 = 无 cutoff = 不嵌; 防御性, 正常路径 setEnabled
 *      会在 enable=true 时立刻写入 cutoff)
 *   3. msg.createdAt >= cutoff
 *   4. role 在白名单内
 *   5. 文本可解出 + 长度 <= MAX_TEXT_BYTES
 *
 * 全程不抛出: 任何错都吞 + log warn, 避免影响 createMessage IPC 返回。
 */
async function onMessageCreated(msg: Message): Promise<void> {
  if (!_enabled || !_deps) return;
  try {
    const cutoff = await readCutoff();
    if (cutoff === null) return;
    // msg.createdAt 在 mapper.ts 是 ISO 字符串; 转回 ms。
    // 早期写入路径 msg.createdAt 也可能是 number — 都兜住。
    const createdAtMs =
      typeof msg.createdAt === 'number'
        ? msg.createdAt
        : Date.parse(msg.createdAt);
    if (!Number.isFinite(createdAtMs) || createdAtMs < cutoff) return;
    if (!EMBED_ROLES.has(msg.role)) return;
    const text = extractEmbedText(msg.role, msg.content);
    if (text === null) return;
    // 按字节数算 (TextEncoder 即时一次), 防 4-byte 表情 / 大段中文撑爆 token 限额
    const byteLen = Buffer.byteLength(text, 'utf-8');
    if (byteLen > MAX_TEXT_BYTES) {
      _deps.log.info(
        JSON.stringify({
          event: 'chatHistoryEmbedder.skip.tooLarge',
          messageId: msg.id,
          role: msg.role,
          bytes: byteLen,
        }),
      );
      return;
    }
    await _deps.service.enqueueJobs({
      source: SOURCE,
      items: [
        {
          sourceId: msg.id,
          modelId: MODEL_ID,
          vecTable: VEC_TABLE,
        },
      ],
    });
  } catch (err) {
    _deps.log.warn(
      JSON.stringify({
        event: 'chatHistoryEmbedder.onMessageCreated.error',
        messageId: msg.id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

// ── internal: cutoff KV (embedding_meta 表) ─────────────────────────────────

/**
 * 读 cutoff (含内存 cache)。返回 null = 从未初始化过 (用户从未开过聊天嵌入)。
 *
 * 切账号时 EmbeddingHost 会 stop, bootstrap 重新调 setupChatHistoryEmbedder,
 * 但本 module-level 的 _cutoffMs / _cutoffLoaded 不会自动重置 —— 由 setup 路径
 * 在每次重启时强制 reset (resetCacheForNewDb)。
 */
async function readCutoff(): Promise<number | null> {
  if (!_deps) return null;
  if (_cutoffLoaded) return _cutoffMs;
  try {
    const row = await _deps.getDbClient().queryOne<{ value: string | null }>(
      `SELECT value FROM embedding_meta WHERE key = ?`,
      [CUTOFF_KEY],
    );
    if (row && row.value) {
      const n = Number(row.value);
      _cutoffMs = Number.isFinite(n) ? n : null;
    } else {
      _cutoffMs = null;
    }
    _cutoffLoaded = true;
    return _cutoffMs;
  } catch (err) {
    _deps.log.warn(
      JSON.stringify({
        event: 'chatHistoryEmbedder.readCutoff.error',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

/**
 * 确保 cutoff 已落盘: 没有就写 now, 已有就不动。
 */
async function ensureCutoff(): Promise<void> {
  if (!_deps) return;
  const existing = await readCutoff();
  if (existing !== null) return;
  const now = Date.now();
  try {
    await _deps.getDbClient().exec(
      `INSERT OR IGNORE INTO embedding_meta (key, value) VALUES (?, ?)`,
      [CUTOFF_KEY, String(now)],
    );
    _cutoffMs = now;
    _cutoffLoaded = true;
    _deps.log.info(
      JSON.stringify({
        event: 'chatHistoryEmbedder.cutoffInitialized',
        cutoffMs: now,
      }),
    );
  } catch (err) {
    _deps.log.warn(
      JSON.stringify({
        event: 'chatHistoryEmbedder.ensureCutoff.error',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * 切账号场景: bootstrap 在 stopEmbeddingHost 后调一次, 让下一次 readCutoff
 * 重新从新 user 的 DB 读取。
 */
function resetCacheForNewDb(): void {
  _cutoffMs = null;
  _cutoffLoaded = false;
  _enabled = false;
  _deps = null;
}

// ── internal: content → text 提取 ────────────────────────────────────────────

/**
 * 把按 role 不同形态的 content 抽取成"可嵌入的一段文本"。
 *
 * content 形态 (按 role):
 *   - user   : 通常是 string; 兼容 { text: string } 老形态; 其它形态返 null
 *   - assistant : string 或 [{ type: 'text', text }, ...] (anthropic 多 block);
 *               非 text block 跳过; 全是非 text → null
 *   - ask_user  : { requestId, questions: [{ question, ... }], ... } —
 *               取所有 question.question 拼成一段
 *   - plan_review : { requestId, plan, planFilePath, ... } — 取 plan 字符串
 *   - 其它 role → null (上游 onMessageCreated 已过滤, 这里是双保险)
 *
 * content 此时是 JSON.parse 后的对象 (messageToCamel 已 parse), 不是原始字符串。
 *
 * 导出仅给本文件 / 测试使用; 主要消费者是 Provider.getTextsForJobs 和 onMessageCreated。
 */
function extractEmbedText(role: MessageRole, content: unknown): string | null {
  // messageToCamel 已 JSON.parse, 但本函数也接受字符串 fallback (Provider 读 raw column)
  const parsed = typeof content === 'string' ? tryParseJson(content) : content;
  switch (role) {
    case 'user': {
      // 合成 UI 指令行(隐藏续跑等)不索引(review P2):它是 role='user' 的正常
      // 落库行但非用户内容,索引进语义历史会让搜索命中隐藏英文指令。
      const guard = (t: string): string | null =>
        isSyntheticTriggerText(t) ? null : nonEmpty(t);
      if (typeof parsed === 'string') return guard(parsed);
      if (parsed && typeof parsed === 'object' && 'text' in parsed) {
        const t = (parsed as { text: unknown }).text;
        return typeof t === 'string' ? guard(t) : null;
      }
      return null;
    }
    case 'assistant': {
      if (typeof parsed === 'string') return nonEmpty(parsed);
      if (Array.isArray(parsed)) {
        const parts: string[] = [];
        for (const block of parsed) {
          if (
            block &&
            typeof block === 'object' &&
            (block as { type?: unknown }).type === 'text' &&
            typeof (block as { text?: unknown }).text === 'string'
          ) {
            parts.push((block as { text: string }).text);
          }
        }
        return parts.length > 0 ? nonEmpty(parts.join('\n\n')) : null;
      }
      // 兼容旧路径 / 单 block: { type: 'text', text }
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed as { type?: unknown }).type === 'text' &&
        typeof (parsed as { text?: unknown }).text === 'string'
      ) {
        return nonEmpty((parsed as { text: string }).text);
      }
      return null;
    }
    case 'ask_user': {
      if (!parsed || typeof parsed !== 'object') return null;
      const qs = (parsed as { questions?: unknown }).questions;
      if (!Array.isArray(qs)) return null;
      const parts: string[] = [];
      for (const q of qs) {
        if (q && typeof q === 'object' && typeof (q as { question?: unknown }).question === 'string') {
          parts.push((q as { question: string }).question);
        }
      }
      return parts.length > 0 ? nonEmpty(parts.join('\n')) : null;
    }
    case 'plan_review': {
      if (!parsed || typeof parsed !== 'object') return null;
      const plan = (parsed as { plan?: unknown }).plan;
      return typeof plan === 'string' ? nonEmpty(plan) : null;
    }
    default:
      return null;
  }
}

function nonEmpty(s: string): string | null {
  const trimmed = s.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s; // 不是 JSON 就当原字符串
  }
}
return {
  CHAT_EMBED_MODEL_ID,
  CHAT_VEC_TABLE,
  CHAT_EMBED_DIM,
  setupChatHistoryEmbedder,
  setChatEmbeddingEnabled,
  isChatEmbeddingEnabled,
  onMessageCreated,
  resetCacheForNewDb
} as const;
}
