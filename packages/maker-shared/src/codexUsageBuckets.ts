/**
 * codexUsageBuckets — Codex 账号限额「桶」的共享语义(main 与 renderer 共用一份)。
 *
 * 账号可能同时存在多个限额桶: 主配额桶与模型专属促销桶(如 codex_bengalfox /
 * GPT-5.3-Codex-Spark)。app-server 的 account/rateLimits/updated 每次只推**一个**
 * 桶(带 limitId), 因此存储必须按 limitId 隔离, 展示必须按当前会话模型选桶。
 *
 * 这里放各端必须**同口径**的判定与常量 —— 多份实现会漂移(review 实例: 陈旧
 * 宽限一侧 1h 一侧 24h, 导致 main 仍保留而 renderer 已隐藏)。
 * desktop(main / renderer)与 mobile 会话用量详情共用本模块。
 */

/** 桶表的缺省键: 快照没带 limitId 时用它(单桶账号 / 老 app-server)。 */
export const CODEX_DEFAULT_LIMIT_BUCKET = '__default__';

/** 用作对象键会污染原型链的保留名 —— 一律回退缺省桶 / 丢弃。 */
export const UNSAFE_BUCKET_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * 通用(非模型专属)桶的稳定标识 —— 只认桶键, 不看易在部分通知里丢失的 limitName。
 * **按优先级排列**: 显式 'codex' 优先于缺省桶别名 —— 旧快照没带 limitId 时会
 * 落到 '__default__', 之后真正的 'codex' 通知会新建第二个通用桶; 按插入序查找
 * 会一直命中旧的缺省桶并显示陈旧百分比(review 反馈)。
 */
export const GENERIC_BUCKET_KEYS_BY_PRIORITY: readonly string[] = [
  'codex',
  CODEX_DEFAULT_LIMIT_BUCKET,
];

/** 集合形式(成员判定用);优先级查找请用 GENERIC_BUCKET_KEYS_BY_PRIORITY。 */
export const GENERIC_BUCKET_KEYS: ReadonlySet<string> = new Set(GENERIC_BUCKET_KEYS_BY_PRIORITY);

/**
 * 陈旧桶宽限: 窗口全部过点超过它, 视为服务端已停推该 limitId(促销结束等)。
 * main(记录时剪枝)与 renderer(选桶时跳过)必须用同一个值, 否则会出现
 * 「main 保留但 renderer 隐藏」的空窗。
 */
export const STALE_BUCKET_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * 判定所需的最小窗口 / 快照形状 —— main 与 renderer 各自更宽的 RateLimitSnapshot
 * 结构兼容(结构子类型), 这里只声明本模块真正读的字段。
 */
export interface BucketWindowLike {
  usedPercent?: number;
  windowMinutes?: number | null;
  resetsAt?: number | null;
}

export interface BucketSnapshotLike {
  limitId?: string | null;
  limitName?: string | null;
  primary?: BucketWindowLike | null;
  secondary?: BucketWindowLike | null;
}

/** 快照 → 桶键。limitId 缺失 / 为危险保留名时归缺省桶。 */
export function codexLimitBucketKey(snapshot: BucketSnapshotLike | null | undefined): string {
  const limitId = snapshot?.limitId;
  if (typeof limitId !== 'string' || limitId.length === 0) return CODEX_DEFAULT_LIMIT_BUCKET;
  return UNSAFE_BUCKET_KEYS.has(limitId) ? CODEX_DEFAULT_LIMIT_BUCKET : limitId;
}

/**
 * 陈旧桶 = **所有**窗口都带有效 resetsAt 且全部过点超宽限。
 *
 * 只要有一个窗口缺 resetsAt 就不判陈旧 —— 该字段是可选的, 拿「有时间戳的那些
 * 都过期了」当全体过期的证据, 会在周窗口没给时间戳时误删仍然有效的桶
 * (review 反馈)。无窗口同样不判陈旧(信息不足, 交给上层兜底)。
 */
export function isCodexBucketStale(
  bucket: BucketSnapshotLike | null | undefined,
  nowMs: number,
): boolean {
  if (!bucket) return true;
  const windows = [bucket.primary, bucket.secondary].filter(
    (window): window is BucketWindowLike => Boolean(window),
  );
  if (windows.length === 0) return false;
  const resets = windows
    .map((window) => window.resetsAt)
    .filter((value): value is number => typeof value === 'number'
      && Number.isFinite(value)
      && value > 0);
  // 有窗口没给 resetsAt → 信息不足, 保守视为未过期。
  if (resets.length !== windows.length) return false;
  return Math.max(...resets) * 1000 + STALE_BUCKET_GRACE_MS < nowMs;
}

/** 模型 id / 桶名 → 可比较 token(小写, 去非字母数字)。 */
function normalizeModelToken(value: string | null | undefined): string {
  return typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
}

/**
 * 按**当前会话模型**选桶(desktop chip 与 mobile 用量详情共用)。
 *
 * 不能用 account_usage 事件判会话归属: 该 notification 是账号级的, host 把同一条
 * fan-out 给所有 subscriber 再各自包上 sessionId(app-server host.routeNotification),
 * 拿它当会话事实等于把任意会话触发的桶串给所有会话。
 *
 * 规则(按序):
 *   1. 桶的 limitName 命中当前模型(如 'GPT-5.3-Codex-Spark' ↔ gpt-5.3-codex-spark);
 *      精确匹配优先, 其次取最长匹配(重叠桶名下 'GPT-5.3-Codex' 不得抢走 Spark 会话);
 *   2. 通用桶 —— 由**稳定桶键**(limitId 'codex' / 缺省桶)识别, 不能靠「没有
 *      limitName」判断: limitName 可选, 同桶 merge 遇到省略该字段的部分通知会把它
 *      抹成 undefined, 模型专属桶会伪装成通用桶;
 *   3. 都没有 → null。**绝不**退而求其次选一个已知属于别的模型的桶。
 * 陈旧桶(窗口全部过期超宽限, 如促销结束后服务端停推)不参与匹配。
 */
export function matchCodexBucketForModel<T extends BucketSnapshotLike>(
  buckets: Record<string, T> | null | undefined,
  modelId: string | null | undefined,
  nowMs: number = Date.now(),
): T | null {
  const entries = Object.entries(buckets ?? {}).filter(
    ([, bucket]) => !isCodexBucketStale(bucket, nowMs),
  );
  if (entries.length === 0) return null;
  const model = normalizeModelToken(modelId);
  if (model) {
    // 精确匹配优先; 否则取**最长**的 substring 匹配 —— 桶顺序反映更新 / 持久化
    // 顺序, 按首个匹配返回会让 'GPT-5.3-Codex' 抢走本属于 'GPT-5.3-Codex-Spark'
    // 的会话, 通用名 'Codex' 更会命中所有 codex/* 模型(review 反馈)。
    let longest: { bucket: T; length: number } | null = null;
    for (const [, bucket] of entries) {
      const name = normalizeModelToken(bucket.limitName);
      if (!name) continue;
      if (name === model) return bucket;
      if (model.includes(name) && (longest === null || name.length > longest.length)) {
        longest = { bucket, length: name.length };
      }
    }
    if (longest) return longest.bucket;
  }
  // 按优先级取通用桶(不能靠 entries 的插入序, 见 GENERIC_BUCKET_KEYS_BY_PRIORITY)。
  for (const key of GENERIC_BUCKET_KEYS_BY_PRIORITY) {
    const hit = entries.find(([entryKey]) => entryKey === key);
    if (hit) return hit[1];
  }
  return null;
}

/**
 * 防御式选桶入口(unknown 进 / unknown 出)—— 供 mobile 会话用量详情直接串在
 * summarizeAccountRateLimits 之前使用: 两端拿到的 payload 形状都不保证。
 *
 * 桶来源优先级: 权威 rateLimitsByLimitId > 组合 payload 的 appServerBuckets;
 * 两者都没有(旧被控端 / 尚无数据)→ 原样返回 fallback 顶层快照, 保持旧行为。
 * 有桶表时以选桶结果为准, 匹配不到返回 null(不渲染限额区), 绝不显示别的模型的桶。
 */
export function selectCodexUsageForModel(input: {
  fallback?: unknown;
  byLimitId?: unknown;
  appServerBuckets?: unknown;
  modelId?: string | null;
  nowMs?: number;
}): unknown {
  const nowMs = input.nowMs ?? Date.now();
  const buckets = resolveCodexBucketTable(input);
  if (!buckets) return input.fallback ?? null;
  return matchCodexBucketForModel(buckets, input.modelId, nowMs);
}

/**
 * 解析出**实际生效**的桶表: 权威 rateLimitsByLimitId 优先, 空表 / 畸形则回退
 * appServerBuckets, 都不可用 → null。
 *
 * 选桶与「到点重选」定时器必须共用它 —— 用 `a ?? b` 只挡 null/undefined,
 * 空对象 `{}` 会被当成有效表, 于是选桶回退到了 appServerBuckets 而定时器却按
 * 空表算出「无需定时」, 面板跨过失效时刻不会重选(review 反馈)。
 */
export function resolveCodexBucketTable(input: {
  byLimitId?: unknown;
  appServerBuckets?: unknown;
}): Record<string, BucketSnapshotLike> | null {
  return readBucketTable(input.byLimitId) ?? readBucketTable(input.appServerBuckets);
}

/**
 * 桶表中最近一个「由有效转为陈旧」的时刻(ms);没有可预期的转变 → null。
 * 陈旧判定只在选桶时求值, 界面常驻时不会自己重算 —— desktop chip 与 mobile
 * 用量面板都用它安排一次到点重选, 否则过期促销桶会一直挂着(review 反馈)。
 */
export function nextCodexBucketStaleAtMs(buckets: unknown, nowMs: number): number | null {
  const table = readBucketTable(buckets);
  if (!table) return null;
  let soonest: number | null = null;
  for (const bucket of Object.values(table)) {
    if (isCodexBucketStale(bucket, nowMs)) continue;
    const windows = [bucket.primary, bucket.secondary].filter(
      (window): window is BucketWindowLike => Boolean(window),
    );
    if (windows.length === 0) continue;
    const resets = windows
      .map((window) => window.resetsAt)
      .filter((value): value is number => typeof value === 'number'
        && Number.isFinite(value)
        && value > 0);
    // 与 isCodexBucketStale 同口径: 有窗口缺时间戳就永不进入陈旧, 无需定时。
    if (resets.length !== windows.length) continue;
    const staleAt = Math.max(...resets) * 1000 + STALE_BUCKET_GRACE_MS;
    if (staleAt > nowMs && (soonest === null || staleAt < soonest)) soonest = staleAt;
  }
  return soonest;
}

/** unknown → 桶表(丢弃非对象条目与危险键);不是可用桶表 → null。 */
function readBucketTable(value: unknown): Record<string, BucketSnapshotLike> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, BucketSnapshotLike> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (UNSAFE_BUCKET_KEYS.has(key)) continue;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      out[key] = entry as BucketSnapshotLike;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}
