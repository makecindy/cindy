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
 * 这些来源之间原本没有"必须连续"的保证:app 退到后台 / 网络抖动 / relay 断连期间漏收的 push
 * 不会补回来,而 `setLatestMessageWindow` 曾只要求缓存旧页与最新页**有交集**就整段保留。于是
 * store 里会出现"首段 + 尾段"这种孤岛窗口,中间几百行从未加载。
 *
 * 现在窗口连续性由 store 从**源头**保证:最新页上沿之外还有服务端历史时(满页 / 被裁行),早于
 * 本页的缓存段一律不保留(见 `setLatestMessageWindow` 的 `moreBeyondWindow` 与 #1222)。本模块
 * 因此退居两个角色:
 *  - **兜底**:旧版本客户端留下的缓存、以及任何绕过那条判据形成的不连续窗口,仍能被发现并补齐;
 *  - **补内容**:store 那条判据只保证"不把不可信的段当相邻",它把段丢掉、不会把中间的行取回来;
 *    真要让用户看到完整历史,还是得靠这里沿 `before` 游标把缺的那段拉回窗口。
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
 * 一次访问最多**翻页补齐**几处空洞。
 *
 * 多段拼接的窗口确实可能有几处真实缺行,但不设总闸就成了一路往上翻整场历史。只统计真的花了
 * 翻页请求的那些结局(covered / budget / exhausted);正常停顿的探测另有下面那道闸。
 */
export const HISTORY_BACKFILL_MAX_GAPS_PER_VISIT = 3;

/**
 * 一次访问最多**考察**几处跳变(探测 + 翻页共用的总闸)。
 *
 * 为什么翻页额度之外还要这一道:`contiguous`(探测确认服务端本来就相邻)刻意不占翻页额度,
 * 否则窗口里几处隔夜停顿就能把额度吃光、更早的真实缺行永远排不到。但跨数百天的长期会话可能
 * 有几十上百处正常停顿,而每处 contiguous 结局都会在飞行标记清除时触发下一次检测 —— 只有翻页
 * 额度的话,打开这种会话会串行发出上百次 `limit=1` 探测,每次重新访问还会重来一遍(#1210 review)。
 *
 * 6 次是"典型多段窗口(缓存段 + 若干次在不同位置打开留下的段)都够考察一遍"与"最坏情况也只有
 * 6 个几百字节请求"之间的折中。耗尽后停手:渲染层的空洞守卫仍保证不谎报时长,用户也仍可用
 * 「加载更早」自己往上翻。
 *
 * 为什么不跨访问持久化探测结论:那要把结果落到 AsyncStorage 并处理失效(消息被 rewind / clear
 * 之后 key 就不再指向同一对相邻行),复杂度远超收益 —— 真实空洞几乎总在窗口尾部附近,前几次
 * 考察就能覆盖。
 */
export const HISTORY_GAP_MAX_CONSIDERED_PER_VISIT = 6;

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

/**
 * 探测最多往同一毫秒组内推进几步。
 *
 * 同一毫秒落库的多行,在手机端只剩相同的 `createdAt`;服务端的次级排序键是 `rowid`,而它不在
 * 手机端窗口里的每一行上都有(push 追加的行就没有),所以**检测阶段无法知道同毫秒组内谁更旧**。
 * 于是跳变较新一侧挑出的锚点可能不是该组最旧的一行,`limit=1` 探测会取回同组的另一行 —— 若把
 * 这当成"取回了别的行"就会误判成有洞,一路翻页并把这处正常停顿记成 `backfilled`,三处这样的
 * 停顿就能耗尽翻页额度、让更早的真实空洞继续缺失(#1210 review)。
 *
 * 处置办法不是去猜组内次序,而是让探测**沿组内继续往更旧处走**:取回的行仍落在同一毫秒时,把
 * 它当新游标再探一次。同毫秒组通常只有几行(一次 turn 的并发落库),8 步足够;病态数据(几百行
 * 挤在同一毫秒)超出后按"有洞"处理,翻页循环自己会正常前进,不会卡住。
 */
export const HISTORY_GAP_PROBE_MAX_STEPS = 8;

export interface HistoryWindowGap {
  /** 空洞较新一侧那一行的 id —— 探测与向上翻页的起始 `before` 游标。 */
  newerId: string;
  /** 空洞较旧一侧那一行的 id —— 取回它即视为窗口已连上。 */
  olderId: string;
  /**
   * 两侧的落库时刻。判定"是否相邻"用的是**时刻**而不是 id 精确匹配:两侧都可能是同毫秒组里的
   * 任意一行(见 `HISTORY_GAP_PROBE_MAX_STEPS`),按时刻比就把这种模糊性一并吃掉 —— 探测取回的行
   * 只要落在 `olderMs` 或更早,就说明 `newerId` 之前没有别的时刻,这段安静是真的。
   */
  newerMs: number;
  olderMs: number;
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
   * 按 `before` 游标取一页(实现方负责 payload 降级重试)。
   *
   * **必须保持服务端返回顺序**(`local-db:messages:list` 是最新在前、页尾最旧):下一页的游标按
   * 页尾取,见 `nextPageCursor` 的说明。实现方不要在这里重排。
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
    // 同毫秒组内的次序在手机端不可知(见 HISTORY_GAP_PROBE_MAX_STEPS),所以这里挑出的两侧锚点
    // 只保证"落在正确的那一毫秒",不保证是组内最旧/最新那一行;探测阶段按时刻判定,把这种
    // 模糊性吃掉,不需要在这里猜 rowid 次序。
    const gap: HistoryWindowGap = {
      newerId: newer.id,
      olderId: older.id,
      newerMs: newer.ms,
      olderMs: older.ms,
      gapMs,
    };
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
    // ── 探测:先确认这段安静到底是不是空洞 ────────────────────────────────────────────
    // 判定按**时刻**而不是 id 精确匹配,并允许沿同毫秒组往更旧处推进(见
    // HISTORY_GAP_PROBE_MAX_STEPS):取回的行落在 olderMs 或更早 → 服务端本来相邻;仍落在
    // newerMs → 是同组另一行,换成它继续探;落在两者之间 → 确实有洞,它就是洞里的第一行。
    let probeCursor = gap.newerId;
    let probeRows = 0;
    let probeRequests = 0;
    for (let step = 0; step < HISTORY_GAP_PROBE_MAX_STEPS; step++) {
      const probe = await deps.listPage(probeCursor, HISTORY_GAP_PROBE_LIMIT);
      if (deps.isCancelled()) return 'cancelled';
      probeRequests += 1;
      if (probe.length === 0) return 'exhausted';
      const probedId = nextPageCursor(probe);
      const probedMs = probedRowMs(probe);
      // 整页都是没有 id / 时间不可解析的行:无法继续判定,按"有洞"交给翻页循环。
      if (!probedId || probedMs === null) {
        deps.merge(probe);
        probeRows += probe.length;
        probeCursor = probedId ?? probeCursor;
        break;
      }
      if (probedMs <= gap.olderMs) {
        // 服务端相邻:窗口本来就连续。探测到的行已在窗口里,不留副作用直接收工。
        return 'contiguous';
      }
      deps.merge(probe);
      probeRows += probe.length;
      probeCursor = probedId;
      // 只有**恰好落在 newerMs 那一毫秒**才继续沿组内往更旧处探;其它情况(落在两侧之间 →
      // 确实有洞、这一行就是洞里的第一行;或被控端违反 before 语义返回了更新的行 → 保守处理)
      // 一律交给翻页循环。
      if (probedMs !== gap.newerMs) break;
    }

    let before = probeCursor;
    let rows = probeRows;
    let requests = probeRequests;
    while (rows < HISTORY_BACKFILL_MAX_ROWS && requests < HISTORY_BACKFILL_MAX_REQUESTS) {
      const page = await deps.listPage(before, MESSAGE_PAGE_SIZE);
      if (deps.isCancelled()) return 'cancelled';
      requests += 1;
      if (page.length === 0) return 'exhausted';
      deps.merge(page);
      rows += page.length;
      // 连上判定同样按**时刻**而不是 `olderId` 精确匹配:较旧一侧也可能是同毫秒组里的任意一行
      // (见 HISTORY_GAP_PROBE_MAX_STEPS),按 id 比会漏判成"还没连上",于是白翻到预算耗尽、把
      // 已经补好的空洞记成 budget。翻页是沿 before 连续往前的,所以"本页取到了 olderMs 或更早的
      // 行"就等价于"两段之间再无缺口"。
      if (page.some((row) => rowMsAtOrBefore(row, gap.olderMs))) return 'covered';
      const nextBefore = nextPageCursor(page);
      // 游标没有前进(整页都是没有 id 的行,或被控端反复返回同一段)→ 停手,避免死循环。
      if (!nextBefore || nextBefore === before) return 'exhausted';
      before = nextBefore;
    }
    return 'budget';
  } catch {
    return 'failed';
  }
}

/**
 * 下一页的 `before` 游标:按**服务端返回顺序**取页尾那一行,不自己按时间戳排序。
 *
 * `local-db:messages:list` 的分页契约是 `ORDER BY createdAt DESC, rowid DESC`(见桌面
 * `localDb/ipc/messages.ts`),也就是**最新在前、页尾最旧**;device-link 隧道的裁行只截前缀
 * (`sliceRemoteMessageWindowForChannel`),不改顺序。
 *
 * 为什么不能自己排:同一毫秒落库的多行在客户端只剩相同的 `createdAt`,再拿消息 id 的字典序做
 * 次级键就与服务端的 `rowid` 次序脱钩(id 是 cuid 之类,与插入顺序无关)。于是可能挑中页内**较
 * 新**的那一行当游标,下一页把已经 merge 过的行再取回来 —— 连续同毫秒消息时,补齐会在 12 次
 * 请求预算里只前进几行,然后把这处空洞永久记成 `budget`,历史仍然缺失(#1210 review)。
 * rowid 不在手机端的 `RemoteMessage` 契约里(compact 后也不保证带上),所以只能依赖顺序。
 *
 * 跳过本地合成的系统卡(`mobile-system-*`):它们没有服务端对应行,当游标什么都匹配不上。
 */
function nextPageCursor(page: readonly RemoteMessage[]): string | null {
  return pageTailRow(page)?.id ?? null;
}

/** 页尾那一行的落库时刻(同 `nextPageCursor` 的取行口径);不可解析时 null。 */
function probedRowMs(page: readonly RemoteMessage[]): number | null {
  const row = pageTailRow(page);
  if (!row) return null;
  const ms = Date.parse(row.createdAt);
  return Number.isFinite(ms) ? ms : null;
}

/** 这一行是否落在 `ms` 或更早(时间不可解析的行一律不算,免得把噪声当成"已连上")。 */
function rowMsAtOrBefore(row: RemoteMessage, ms: number): boolean {
  const rowMs = Date.parse(row.createdAt);
  return Number.isFinite(rowMs) && rowMs <= ms;
}

function pageTailRow(page: readonly RemoteMessage[]): RemoteMessage | null {
  for (let index = page.length - 1; index >= 0; index--) {
    const message = page[index];
    if (!message.id || message.id.startsWith('mobile-system-')) continue;
    return message;
  }
  return null;
}

/**
 * 同一处空洞的稳定标识:补齐失败 / 判定为真安静之后,不再对同一处重复发请求。
 *
 * 身份取**两侧的时刻对**,不是两侧的行 id:一处跳变的本质是"这两个时刻之间没有东西",而两侧各自
 * 是同毫秒组里的哪一行是不确定的(见 `HISTORY_GAP_PROBE_MAX_STEPS`)。用 id 组 key 时,只要探测
 * 往组内 merge 进一行、而它的 id 在字典序上排到原锚点之后,下一轮检测就会挑出**同一处停顿**的
 * 另一个 id 组合 → key 变了 → 同一处被重新探测,一处停顿吃掉两次考察额度,更早的真实空洞在本次
 * 访问里仍然补不上(#1210 review)。时刻对不受组内成员变化影响。
 */
export function historyWindowGapKey(gap: HistoryWindowGap): string {
  return `${gap.olderMs}→${gap.newerMs}`;
}
