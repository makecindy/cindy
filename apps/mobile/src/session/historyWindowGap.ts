/**
 * 历史窗口空洞的检测与补齐(手机端)。
 *
 * ## 空洞是怎么来的
 *
 * 手机端的消息窗口不是一次拉全的,它由几个来源拼起来:
 *  - 冷开时的本地缓存(`mobileSessionMessageCache`,上次看到的那一页);
 *  - `listMessages` 的最新窗口(`MESSAGE_PAGE_SIZE` 条,payload 超限时还会降级到更少);
 *  - `local-db:messages:created` push 逐条追加的尾部。
 *
 * 这些来源之间没有"必须连续"的保证:app 退到后台 / 网络抖动 / relay 断连期间漏收的 push
 * 不会补回来,而 `setLatestMessageWindow` 只要求缓存旧页与最新页**有交集**就整段保留。于是
 * store 里会出现"首段 + 尾段"这种孤岛窗口,中间几百行从未加载。
 *
 * 渲染层看到的是两段"相邻"item,中间的 user 行(唯一的 turn 边界)全部缺席,跨空洞的动作会被
 * 折成同一个「已工作 Xs」——2026-07-31 实测:一条「已工作 142m 32s」吞掉整场会话的 6 轮对话,
 * 手机上看起来就是"中间掉了一大段"。渲染层现在有 `HISTORY_GAP_SPLIT_MS` 守卫兜底(不会再谎报
 * 时长),但内容还是得靠本模块把它拉回来。
 *
 * ## 为什么先探测再补齐
 *
 * 时间跳变**不等于**空洞:正常会话里"用户隔夜回来继续聊"同样会留下几小时的相邻间隔。拿时间
 * 阈值直接触发翻页,那类会话每次打开都要白翻几页。所以补齐前先花一次 `limit=1` 的请求探测:
 * 以空洞较新一侧那行为 `before` 游标只取 1 行,取回的正是较旧一侧那行 → 两行在服务端本来就
 * 相邻(真安静,不是空洞),直接收工;取回别的行 → 确实有洞,再进翻页循环。这一次探测的 payload
 * 只有一行,不会触发 relay 帧上限。
 *
 * ## 不改跨端协议
 *
 * 全程只用既有的 `local-db:messages:list` 的 `before` 游标(与「加载更早」同一个通道),不需要给
 * device-link 隧道加 `after` 方向,不触碰 wire protocol。
 */
import { HISTORY_GAP_SPLIT_MS } from '@cindy/maker-shared/history-gap';

import { MESSAGE_PAGE_SIZE } from '@/session/messagePaging';
import type { RemoteMessage } from '@/session/types';

/**
 * 一次补齐的行数预算。
 *
 * 对照的是**本次补齐已取回的行数**(每页 `page.length` 累加),不是窗口总行数。它是循环的
 * 准入条件而非硬上限:判定在取页**之前**,所以最后一页整页拉回时总数会略微超出预算
 * (例如已取 390 行仍会再拉一整页)。这是有意的 —— 为省下几十行去要半页会多一次往返。
 *
 * 手机内存与列表挂载树都比桌面紧,桌面的 `JUMP_BACKFILL_MAX_ITEMS`(600)在这里偏激进。
 * 400 行 ≈ 5 个满页,足以覆盖"看了个开头就切走、两小时后回来"这类真实空洞(实测那场 445 行
 * 的会话,空洞两侧相隔约 420 行);超出仍未连上时交给渲染层的空洞守卫兜底,并保留
 * 「加载更早」入口让用户自己往上翻。
 */
export const HISTORY_BACKFILL_MAX_ROWS = 400;

/**
 * 请求次数上限,与行数预算分开计。
 *
 * 不能只按行数算预算:被控端结果帧超限时 `listMessagesWithPayloadRetry` 会一路降 limit,
 * device-link 侧还会静默裁行(`remoteRowsTrimmed`),那种分片每次只带回几行。若与行数共用一个
 * 计数器,这类会话会在远未取到 400 行时就发出几十个请求。12 次是"5 个满页 + 若干降级页"的
 * 保守上界,也兼作防死循环兜底。
 */
export const HISTORY_BACKFILL_MAX_REQUESTS = 12;

/** 探测两行在服务端是否真的相邻时的页大小(只要一行就够,payload 最小)。 */
export const HISTORY_GAP_PROBE_LIMIT = 1;

export interface HistoryWindowGap {
  /** 空洞较新一侧那一行的 id —— 向上翻页的 `before` 游标。 */
  newerId: string;
  /** 空洞较旧一侧那一行的 id —— 取回它即视为窗口已连上。 */
  olderId: string;
  /** 两行的时间差,仅用于日志与测试断言。 */
  gapMs: number;
}

export type HistoryBackfillOutcome =
  /** 已连上:本次翻页真正取回了 `olderId`。 */
  | 'covered'
  /** 两行在服务端本来就相邻,不存在空洞(真安静的会话)。 */
  | 'contiguous'
  /** 沿 `before` 游标翻到历史起点仍未连上(中间的行已被 rewind 软删 / clear 边界切掉等)。 */
  | 'exhausted'
  /** 超出行数或请求数预算,交给渲染层的空洞守卫兜底。 */
  | 'budget'
  /** 会话已切走 / 窗口已重置,调用方不得再 merge 本次抓到的行。 */
  | 'cancelled'
  /** 请求异常。 */
  | 'failed';

export interface HistoryBackfillDeps {
  /**
   * 按 `before` 游标取一页(实现方负责 payload 降级重试)。返回的行序不限,本模块只按 id 判定。
   */
  listPage(before: string, limit: number): Promise<readonly RemoteMessage[]>;
  /** 把取回的行并入窗口(按 key 合并,不覆盖更完整的既有行)。 */
  merge(rows: readonly RemoteMessage[]): void;
  /** 会话切走 / `/clear` / rewind 等让本次补齐失去意义;每次 await 前后都会问一次。 */
  isCancelled(): boolean;
}

/**
 * 找窗口里**最靠尾部的、尚未考察过**的一处空洞;没有则返回 null。
 *
 * 为什么从尾部找而不是从头:补齐是沿 `before` 从新往旧翻页,先补最靠尾部的洞时游标离窗口尾
 * 最近、翻页量最小。
 *
 * 为什么必须能跳过已考察的:补齐成功(`covered`)会把中间行 merge 进来、那处跳变自然消失,但
 * 其它结局不会 —— 尤其 `contiguous`(隔夜等合法间隔,探测确认服务端本来就相邻)既不 merge、
 * 跳变也一直留在窗口里。若检测恒定返回最靠尾部那一处,窗口有 ≥3 段时(多次在不同位置打开
 * 同一会话拼出的缓存),只要最尾部那处是合法间隔,更早处真实缺行就永远进不了探测:补齐只盯
 * 着这处 contiguous 收工,而「加载更早」只从最旧行往外翻、够不到窗口内部的空洞,内容于是静默
 * 丢失(#1210 review)。所以调用方把**已考察过的** gapKey 传进来,检测跳过它们继续往前找。
 *
 * 只看真实 host 行:本地合成的系统卡(`mobile-system-*`,/pwd、/context 等)没有服务端对应行,
 * 拿它当 `before` 游标什么都匹配不上,只会白拉一页最新消息。
 */
export function findHistoryWindowGap(
  messages: readonly RemoteMessage[],
  /** 已考察过的空洞(见 `historyWindowGapKey`);命中的跳变会被跳过,继续往更早处找。 */
  consideredGapKeys: ReadonlySet<string> = new Set(),
): HistoryWindowGap | null {
  const rows = messages
    .filter((message) => !!message.id && !message.id.startsWith('mobile-system-'))
    .map((message) => ({ id: message.id, ms: Date.parse(message.createdAt) }))
    .filter((row) => Number.isFinite(row.ms))
    .sort((a, b) => (a.ms === b.ms ? a.id.localeCompare(b.id) : a.ms - b.ms));
  for (let index = rows.length - 1; index > 0; index--) {
    const newer = rows[index];
    const older = rows[index - 1];
    const gapMs = newer.ms - older.ms;
    if (gapMs <= HISTORY_GAP_SPLIT_MS) continue;
    const gap: HistoryWindowGap = { newerId: newer.id, olderId: older.id, gapMs };
    if (consideredGapKeys.has(historyWindowGapKey(gap))) continue;
    return gap;
  }
  return null;
}

/**
 * 把一处空洞补齐到"窗口连续"。
 *
 * 先探测两行是否本来就相邻(见文件头),确认有洞后沿 `before` 游标向上翻页,直到**本页真正取回
 * 了** `olderId`。判定必须看本页取回的行,不能看合并后的窗口:较旧那一段本来就躺在窗口里,拿
 * 合并结果判定的话,随便一页(哪怕内容完全无关)都会让判定成立,空洞就永远补不回来。
 */
export async function backfillHistoryWindowGap(
  gap: HistoryWindowGap,
  deps: HistoryBackfillDeps,
): Promise<HistoryBackfillOutcome> {
  if (deps.isCancelled()) return 'cancelled';
  try {
    const probe = await deps.listPage(gap.newerId, HISTORY_GAP_PROBE_LIMIT);
    if (deps.isCancelled()) return 'cancelled';
    if (probe.length === 0) return 'exhausted';
    if (probe.some((row) => row.id === gap.olderId)) {
      // 服务端相邻:窗口本来就连续,这段安静是真的。探测到的行已在窗口里,merge 是幂等的,
      // 但也没有必要——直接收工,不留副作用。
      return 'contiguous';
    }
    deps.merge(probe);

    let before = oldestRowId(probe) ?? gap.newerId;
    let rows = probe.length;
    let requests = 1;
    while (rows < HISTORY_BACKFILL_MAX_ROWS && requests < HISTORY_BACKFILL_MAX_REQUESTS) {
      const page = await deps.listPage(before, MESSAGE_PAGE_SIZE);
      if (deps.isCancelled()) return 'cancelled';
      requests += 1;
      if (page.length === 0) return 'exhausted';
      deps.merge(page);
      rows += page.length;
      if (page.some((row) => row.id === gap.olderId)) return 'covered';
      const nextBefore = oldestRowId(page);
      // 游标没有前进(整页都是没有 id 的行,或被控端反复返回同一段)→ 停手,避免死循环。
      if (!nextBefore || nextBefore === before) return 'exhausted';
      before = nextBefore;
    }
    return 'budget';
  } catch {
    return 'failed';
  }
}

function oldestRowId(page: readonly RemoteMessage[]): string | null {
  let oldest: { id: string; ms: number } | null = null;
  for (const message of page) {
    if (!message.id || message.id.startsWith('mobile-system-')) continue;
    const ms = Date.parse(message.createdAt);
    if (!Number.isFinite(ms)) continue;
    if (!oldest || ms < oldest.ms || (ms === oldest.ms && message.id.localeCompare(oldest.id) < 0)) {
      oldest = { id: message.id, ms };
    }
  }
  return oldest?.id ?? null;
}

/** 同一处空洞的稳定标识:补齐失败 / 判定为真安静之后,不再对同一处重复发请求。 */
export function historyWindowGapKey(gap: HistoryWindowGap): string {
  return `${gap.olderId}→${gap.newerId}`;
}
