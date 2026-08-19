/**
 * 「初始记忆」的形状契约与幂等判定 —— renderer 与 main 共用。
 *
 * 背景:阵容卡上写着一个角色是谁,但在这一批之前,**只有** identitySource 会跟着
 * 角色一起落地;模板并没有任何「TA 一开始就记得的事」。于是新伙伴的设置页里
 * 「TA 记得的」永远是空的,用户得先聊上一阵才看得出这块是干什么用的。
 *
 * 本模块只负责三件小事,故意做成纯函数放在 shared:
 *   1. 规定一条初始记忆长什么样(`BotMemorySeedEntry`);
 *   2. 从 IPC 边界收到的 `unknown` 里把它规整出来(main 侧入参校验);
 *   3. 幂等 —— 已经存在同名 slug 的分片一律跳过,不覆盖用户改过的内容。
 *
 * **幂等以 slug 为准,不以内容为准**:用户把「提醒要短」这条改写成自己的说法之后,
 * 再触发一次写入(重装、重试、导入)也不能把他的改动冲掉;要真想恢复出厂那条,
 * 删掉再重来即可。
 */

/**
 * 初始记忆允许的分片类型。
 *
 * 与 maker-core 的 `CURATED_MEMORY_TYPES` 同名同义,但**不从那里 import**:本文件
 * 会被 renderer 打包,而 `@cindy/maker-core` 是 main 侧依赖。两边不一致会被
 * `botMemorySeed.test.ts` 里的对齐断言抓到。`digest` 是系统内部类型,初始记忆
 * 永远不该写它(那会写进一个用户看不见的角落)。
 */
export const BOT_MEMORY_SEED_TYPES = ['user', 'feedback', 'project', 'reference'] as const;

export type BotMemorySeedType = (typeof BOT_MEMORY_SEED_TYPES)[number];

/** 一条初始记忆。字段名与 memory store 的 `WriteOptions` 一一对应。 */
export interface BotMemorySeedEntry {
  /** 文件名 slug,同时是幂等键。必须 `[a-z0-9_-]{1,64}`。 */
  slug: string;
  type: BotMemorySeedType;
  /** 「TA 记得的」列表里显示的那一行。 */
  title: string;
  /** 副行 hook。 */
  description: string;
  /** 正文(markdown)。 */
  body: string;
}

/** 一次落地的结果。`skipped` = 已经有同 slug 的分片,按幂等跳过。 */
export interface BotMemorySeedResult {
  written: number;
  skipped: number;
}

/**
 * slug 白名单,与 maker-core storage 的 slug 校验同口径。
 *
 * 存储层还会拒绝以 `<type>_` 开头的 slug(文件名是 `<type>_<slug>.md`),模板里
 * 的 slug 一律用连字符,天然绕开。
 */
const SLUG_PATTERN = /^[a-z0-9_-]{1,64}$/;

/** 与 memory store 默认上限同口径的软约束,避免把一整篇文章当成"初始记忆"塞进去。 */
const MAX_TITLE_CHARS = 100;
const MAX_DESCRIPTION_CHARS = 200;
const MAX_BODY_CHARS = 2000;
/** 一次调用最多写几条 —— 模板最多 2 条,AI 生成最多 3 条,留一倍余量。 */
export const BOT_MEMORY_SEED_MAX_ENTRIES = 8;

function readTrimmed(source: Record<string, unknown>, key: string, max: number): string | null {
  const value = source[key];
  if (typeof value !== 'string') return null;
  // description 进 MEMORY.md 索引行,换行会把索引撑成两行;统一压成空格。
  const trimmed = value.replace(/\s+/gu, ' ').trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : null;
}

function isSeedType(value: unknown): value is BotMemorySeedType {
  return (
    typeof value === 'string' && (BOT_MEMORY_SEED_TYPES as readonly string[]).includes(value)
  );
}

/**
 * 把一条来路不明的值规整成 `BotMemorySeedEntry`;缺字段 / 非法 slug / 未知 type
 * 一律返回 null —— 宁可少写一条,也不要往用户的记忆里塞一条形状不对的分片。
 */
export function normalizeBotMemorySeedEntry(value: unknown): BotMemorySeedEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const slug = typeof record.slug === 'string' ? record.slug.trim().toLowerCase() : '';
  if (!SLUG_PATTERN.test(slug)) return null;
  if (!isSeedType(record.type)) return null;
  const title = readTrimmed(record, 'title', MAX_TITLE_CHARS);
  const description = readTrimmed(record, 'description', MAX_DESCRIPTION_CHARS);
  if (!title || !description) return null;
  // body 保留换行(它是 markdown 正文,不进索引行)。
  const rawBody = typeof record.body === 'string' ? record.body.trim() : '';
  const body = rawBody.length > 0 ? rawBody.slice(0, MAX_BODY_CHARS) : description;
  return { slug, type: record.type, title, description, body };
}

/** 批量规整 + 同批去重(同 slug 保留第一条),超过上限截断。 */
export function normalizeBotMemorySeedEntries(value: unknown): BotMemorySeedEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: BotMemorySeedEntry[] = [];
  for (const item of value) {
    if (out.length >= BOT_MEMORY_SEED_MAX_ENTRIES) break;
    const entry = normalizeBotMemorySeedEntry(item);
    if (!entry || seen.has(entry.slug)) continue;
    seen.add(entry.slug);
    out.push(entry);
  }
  return out;
}

/**
 * 幂等过滤:去掉已经存在的 slug。
 *
 * `existingSlugs` 由调用方从 store 的现有分片里取(`MemoryRecord.slug`)。
 */
export function selectMissingBotMemorySeedEntries(
  entries: readonly BotMemorySeedEntry[],
  existingSlugs: Iterable<string>,
): BotMemorySeedEntry[] {
  const existing = new Set<string>();
  for (const slug of existingSlugs) existing.add(slug.trim().toLowerCase());
  return entries.filter((entry) => !existing.has(entry.slug));
}
