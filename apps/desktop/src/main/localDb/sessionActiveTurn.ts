/**
 * interrupted-turn-resume — 会话级「疑似中断」检测(简化版)。
 *
 * 需求:app 退出(崩溃 / ⌘Q)时在飞的任务,重启后在会话里给出「继续任务 / 忽略」
 * 提示,不再靠用户口头输入"继续"。
 *
 * 设计(2026-07-06 产品决策的简化重构,替代早期的多进程标记所有权协议):
 *  - sessions 上两个 **append-only 覆盖写**的时间戳,没有"清除"操作:
 *      · active_turn_started_at —— turn 启动(status:isRunning=true)时写 now;
 *      · last_turn_ended_at     —— turn 正常收尾(done / terminal error / close /
 *        stop / reconcile)或用户确认「继续 / 忽略」旧中断时写 now。
 *  - 「疑似中断」= 纯读判定:startedAt > endedAt(且 > cleared_at,且会话空闲)。
 *    崩溃 / 强杀没有机会写 ended;⌘Q 由退出编排的 freeze 挡住 shutdown close
 *    触发的 ended 写 —— 两者重启后都满足 startedAt > endedAt。
 *  - **不往消息流插任何行**:提示是纯 UI 态(renderer 打开会话时读 session 行
 *    判定,InterruptedTurnBanner 展示);「忽略」立即写 ended，「继续」在 vendor
 *    dispatch 成功后用 dispatch 前冻结的时间戳写 ended。旧版本
 *    插入的 reason='app-exit-interrupted' 历史行仍由 renderer 按尾部错误行优雅
 *    展示。「继续」先把续跑项插到队首，真正 dispatch 后才确认旧中断；续跑
 *    turn 启动会写新的 startedAt，因此再次中断仍能被识别。
 *
 * 为什么这样够了(与早期协议版的取舍):
 *  - 没有 clear 操作 → 不存在清标与 mark / sweep / error 持久化的并发交错,
 *    CAS / 所有权 / defer / 扫尾 / peer 探测整族问题不存在;
 *  - 没有中断消息行 → 不存在 createdAt 锚定 / 外部导入重排 / 双卡问题;
 *  - dev/release 双开共库降级为**尽力而为**:两实例写同一行时间戳可能互踩,
 *    最坏多一张或少一张"继续?"提示(点继续时模型自查 transcript 后会说明
 *    实际进度,无副作用)。双开是开发者场景,不为它引入跨进程协议。
 *
 * 写序:started / ended 都是 fire-and-forget 异步写,per-session 一条极简
 * promise 链保证落库顺序(极短 turn 的 ended 不会先于 started 落库,否则会
 * 留下 startedAt > endedAt 的假中断)。链上只有 UPDATE,无读改写。
 *
 * ended 落库后广播(2026-07-07 假阳性修复):renderer 的 session 快照(serverSession /
 * sessions 列表缓存)可能是在 turn 飞行中或「done → ended 落库」的空窗里取的,天然
 * 呈 startedAt > endedAt;此前只有用户点「忽略」的 ack 路径会广播 lastTurnEndedAt
 * patch,正常收尾是静默写 —— 快照永不纠正,导致任务正常结束后切回会话仍弹「应用
 * 退出中断」。现在每次 ended 真正落库后经注入的回调广播 sessions:patched
 * (localDb/ipc/sessions.ts 注入,避免反向 import 成环),renderer 合并后判定自动
 * 熄灭。started 故意**不**广播:它只会把"飞行中"状态推给 renderer 制造更多疑似
 * 中断快照,而真正的中断检测只发生在重启后的全量读,不需要实时 started。
 *
 * 写入范围:本机与 SSH remote(session.remoteHostId 非空)会话都写 —— 后者
 * session 行在本地 DB、事件流走本进程,只是 agent 跑在远端;device-link 被控
 * 会话不进本进程 maker-core,天然不经过。
 *
 * 写入频率:每个 turn 起止各一次 UPDATE,不在事件热路径,对 maker-core 四指标
 * 无影响(规则 10)。所有写入吞错落日志:这是尽力而为的辅助信号,绝不阻塞
 * turn 主流程。
 */

import { and, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';

import { getDbClient } from './client/current';
import { messages, sessions } from './schema';
import { createLogger } from '../logger';
import { DESKTOP_VISIBLE_SESSION_SOURCES } from '../../shared/sessionSource.js';

const log = createLogger('session-active-turn');

/**
 * 退出冻结:app 退出编排(quit chain)一启动就置 true,此后新发起的时间戳写
 * 全部 no-op。语义:⌘Q / SIGTERM 时 shutdown-maker 会批量 close 所有 session,
 * 若不冻结,close 触发的 ended 写会把"退出时还在飞的 turn"伪装成正常收尾,
 * 重启后就没有中断提示了。冻结只在入队时刻判定,freeze 前已入队的写照常落盘。
 */
let _quitFrozen = false;

/** app 退出编排 sync 阶段调用(bootstrap-electron onQuit),此后时间戳只读。 */
export function freezeSessionActiveTurnMarkers(): void {
  _quitFrozen = true;
}

/**
 * ended 落库后的通知回调(见文件头「ended 落库后广播」)。由 localDb/ipc/sessions.ts
 * 在 registerSessionIpc 时注入 broadcastSessionPatched —— 本模块不直接 import 它,
 * 因为 ipc/sessions.ts 已 import 本模块(ack 路径),反向依赖会成环;注入也让单测
 * 无需 mock electron。回调异常吞掉,绝不影响写链。
 */
let _onTurnEndedPersisted:
  | ((sessionId: string, endedAt: number, context: unknown) => void)
  | null = null;
let _captureTurnEndedPersistedContext: (() => unknown) | null = null;

/** 注入 ended 落库后的广播回调(传 null 清除;测试与 registerSessionIpc 用)。 */
export function setOnSessionTurnEndedPersisted(
  fn: ((sessionId: string, endedAt: number, context: unknown) => void) | null,
  captureContext: (() => unknown) | null = null,
): void {
  _onTurnEndedPersisted = fn;
  _captureTurnEndedPersistedContext = fn ? captureContext : null;
}

function captureTurnEndedPersistedContext(): unknown {
  try {
    return _captureTurnEndedPersistedContext?.();
  } catch (err) {
    log.warn('capture turn-ended notify context failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

function notifyTurnEndedPersisted(sessionId: string, endedAt: number, context: unknown): void {
  if (!_onTurnEndedPersisted) return;
  try {
    _onTurnEndedPersisted(sessionId, endedAt, context);
  } catch (notifyErr) {
    log.warn('onTurnEndedPersisted notify failed', {
      sessionId,
      error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
    });
  }
}

/** started / ended 的 per-session 写链:只做 UPDATE 排队保序,无读改写。 */
const _writeChains = new Map<string, Promise<void>>();

/** 返回链上本次写完成(含失败吞错)的 promise,供需要落库确认的调用方 await。 */
function chainWrite(sessionId: string, op: () => Promise<void>): Promise<void> {
  const prev = _writeChains.get(sessionId) ?? Promise.resolve();
  const next = prev.then(op).catch(() => undefined);
  _writeChains.set(sessionId, next);
  return next;
}

/** turn 启动:写 active_turn_started_at = now。fire-and-forget,失败只落日志。 */
export function markSessionTurnStarted(sessionId: string): void {
  if (_quitFrozen) return;
  const startedAt = Date.now();
  chainWrite(sessionId, async () => {
    try {
      await getDbClient()
        .drizzle.update(sessions)
        .set({ activeTurnStartedAt: startedAt })
        .where(eq(sessions.id, sessionId));
    } catch (err) {
      log.warn('markSessionTurnStarted failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/**
 * turn 正常收尾 / 用户确认继续或忽略中断提示:写 last_turn_ended_at。幂等,
 * fire-and-forget。frozen 后 no-op(见 _quitFrozen)。
 *
 * endedAtOverride:调用方需要把写入延后(如等 error 行 durable 后再写,见
 * register.ts terminal error 路径)时,先在逻辑收尾时刻定格时间戳再延后调用 ——
 * 若延后期间用户已启动新 turn,新 started 定格晚于本值,不会被本次写伪装成
 * 已结束。不传时取 now;未来值 clamp 到 now(跨设备 ack 的时钟偏移防御)。
 *
 * 写入用 MAX 守卫(单语句原子,非读改写):延后的写可能晚于后续 turn 的正常
 * 收尾写入队,盲写会把更新的 ended 回退成旧定格值,让"已正常完成的后续 turn"
 * 在重启后误判为中断。只允许时间戳前进。
 */
export function markSessionTurnEnded(sessionId: string, endedAtOverride?: number): void {
  if (_quitFrozen) return;
  const notifyContext = captureTurnEndedPersistedContext();
  enqueueEndedWrite(
    sessionId,
    Math.min(endedAtOverride ?? Date.now(), Date.now()),
    notifyContext,
  );
}

/**
 * barrier 版收尾打标(register.ts 的 markTurnEndedAfterPersistDrain 用):
 * **freeze 判定与时间戳定格都在调用时刻**,barrier(persist queue 排空)完成后
 * 直接入链写、不再看 freeze —— 调用时未冻结 = turn 真实逻辑收尾,即使 barrier
 * 等待期间 ⌘Q 置了 freeze,该写也必须落盘,否则已完成的 turn 会因 ended 缺失在
 * 重启后误报"应用退出中断"(假阳性)。shutdown close 触发的收尾事件到达时
 * freeze 已置位,在调用时刻即被挡,不会经 barrier 漏进来 —— 与文件头「冻结只在
 * 入队时刻判定」的语义一致(barrier 版的"入队时刻"= 本函数调用时刻)。
 */
export function markSessionTurnEndedAfterBarrier(sessionId: string, barrier: Promise<unknown>): void {
  if (_quitFrozen) return;
  const endedAt = Date.now();
  const notifyContext = captureTurnEndedPersistedContext();
  void barrier.then(
    () => enqueueEndedWrite(sessionId, endedAt, notifyContext),
    () => enqueueEndedWrite(sessionId, endedAt, notifyContext),
  );
}

/**
 * 用户显式确认「继续 / 忽略」中断提示的 awaited 版收尾打标:与
 * markSessionTurnEnded 同一落库路径(链 + MAX 守卫),但**等本次 UPDATE
 * 真正落库(含排在前面的链上写)后
 * 才 resolve** —— 调用入口需要在返回 / 广播 sessions:patched 之前确认持久化,
 * 否则用户确认后立刻退出,写还在内存链上,重启后同一提示复现(review P2)。
 * 写失败吞错落日志照旧(本地 SQLite UPDATE 失败极罕见,不为它扩 UI 错误面),
 * 但 resolve 时"写已尝试完成"的时序保证成立。
 */
export async function ackSessionTurnEndedDurable(
  sessionId: string,
  endedAtOverride?: number,
): Promise<number> {
  const endedAt = Math.min(endedAtOverride ?? Date.now(), Date.now());
  const notifyContext = captureTurnEndedPersistedContext();
  if (!_quitFrozen) await enqueueEndedWrite(sessionId, endedAt, notifyContext);
  return endedAt;
}

/**
 * 批量处置专用的**条件** ended 写:只在 active_turn_started_at 仍等于捕获值时落库,
 * 并返回是否真的写进去了。
 *
 * 为什么需要它(PR #879 review P1):批量处置先用 listInterruptedPendingSessionIds
 * 取快照,再逐个 ack。快照之后、轮到某会话之前,自动化可能已经启动了新 turn(写了新的
 * activeTurnStartedAt)。此时盲写 ended 会把**刚启动的活跃 turn** 记成已收尾 ——
 * 它真被中断时下次启动就检测不到了。bootAt 守卫只保证「查询时刻」正确,盖不住这段
 * TOCTOU 窗口,所以把捕获的 startedAt 带进 WHERE 做 CAS。
 *
 * 仍走 per-session 写链(保序)与 MAX 守卫(ended 只前进),语义与普通 ended 写一致。
 */
export async function ackSessionTurnEndedIfUnchanged(
  sessionId: string,
  expectedStartedAt: number,
): Promise<boolean> {
  if (_quitFrozen) return false;
  const endedAt = Date.now();
  const notifyContext = captureTurnEndedPersistedContext();
  let landed = false;
  await chainWrite(sessionId, async () => {
    try {
      const db = getDbClient().drizzle;
      await db
        .update(sessions)
        .set({ lastTurnEndedAt: sql`MAX(COALESCE(${sessions.lastTurnEndedAt}, 0), ${endedAt})` })
        .where(and(eq(sessions.id, sessionId), eq(sessions.activeTurnStartedAt, expectedStartedAt)));
      // 读回校验:CAS 未命中(新 turn 已启动)或写失败都算未处置,调用方据此回报 failed。
      const [row] = await db
        .select({
          startedAt: sessions.activeTurnStartedAt,
          endedAt: sessions.lastTurnEndedAt,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      landed =
        row?.startedAt === expectedStartedAt &&
        row.endedAt != null &&
        row.endedAt >= expectedStartedAt;
      if (landed && _onTurnEndedPersisted && row?.endedAt != null) {
        notifyTurnEndedPersisted(sessionId, row.endedAt, notifyContext);
      }
    } catch (err) {
      log.warn('ackSessionTurnEndedIfUnchanged failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  return landed;
}

/** ended 写入的唯一落库实现:MAX 守卫 + per-session 链,见 markSessionTurnEnded 注释。 */
function enqueueEndedWrite(sessionId: string, endedAt: number, notifyContext: unknown): Promise<void> {
  return chainWrite(sessionId, async () => {
    try {
      const db = getDbClient().drizzle;
      await db
        .update(sessions)
        .set({ lastTurnEndedAt: sql`MAX(COALESCE(${sessions.lastTurnEndedAt}, 0), ${endedAt})` })
        .where(eq(sessions.id, sessionId));
      if (_onTurnEndedPersisted) {
        // 广播值必须**读回生效值**:MAX 守卫可能保留了比本次 endedAt 更新的已有值
        // (延后定格写晚入队的场景),盲播本次入参会把 renderer 快照的 ended 回退,
        // 复活假中断。每 turn 一次的 SELECT,不在事件热路径(规则 10 无影响)。
        const [row] = await db
          .select({ endedAt: sessions.lastTurnEndedAt })
          .from(sessions)
          .where(eq(sessions.id, sessionId));
        if (row?.endedAt != null) {
          notifyTurnEndedPersisted(sessionId, row.endedAt, notifyContext);
        }
      }
    } catch (err) {
      log.warn('markSessionTurnEnded failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/**
 * 本进程启动时刻(模块加载即定格)。「中断」的完整定义需要它:
 * startedAt > endedAt 只说明「有个 turn 没收尾」,**正在跑的 turn 同样满足**;
 * 真正的中断还要求这个 turn **开始于本进程启动之前** —— 那才只能是上一个进程留下的。
 *
 * 早先这条约束只写在注释里(「只在启动首拉时消费」),于是任何运行时调用都会把
 * 正在跑的会话误判为中断:红点侧会给运行中的会话亮红点,批量处置侧更糟 —— 会对
 * 活跃 turn 写 lastTurnEndedAt,把它伪装成已收尾,导致这个 turn 真被中断时下次启动
 * 检测不到(PR #879 review P1,两个 reviewer 独立指出)。现在把边界下沉进查询本身,
 * 调用时机不再影响正确性。
 */
let _bootAtMs = Date.now();

/** 测试专用:定格「本进程启动时刻」,让中断判定不依赖真实时钟。 */
export function _setBootAtMsForTests(ms: number): void {
  _bootAtMs = ms;
}

/**
 * 「疑似中断」的 active 会话 id:turn 开始于本进程启动之前、至今未收尾,且未被
 * /clear 越过,来源在桌面可见白名单内。继续 / 忽略都会写 ended,自然不再命中。
 *
 * 这是红点派生的两条腿之一(另一条是 listErrorTailPendingSessionIds)。红点侧只在
 * 启动首拉消费它(见下方两条腿消费周期的说明);但 startedAt < bootAt 的守卫让它
 * 在任何时刻调用都不会把运行中的会话算进来,批量处置因此也可以安全复用。
 */
export async function listInterruptedPendingRows(): Promise<
  { sessionId: string; startedAt: number }[]
> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({ id: sessions.id, startedAt: sessions.activeTurnStartedAt })
    .from(sessions)
    .where(
      and(
        eq(sessions.status, 'active'),
        // 只统计桌面 sidebar 可见来源(含 feishu/slack 等 IM 渠道)——
        // 不可见来源的红点无处展示也无法清除。
        inArray(sessions.source, DESKTOP_VISIBLE_SESSION_SOURCES),
        gt(sessions.activeTurnStartedAt, sql`COALESCE(${sessions.lastTurnEndedAt}, 0)`),
        gt(sessions.activeTurnStartedAt, sql`COALESCE(${sessions.clearedAt}, 0)`),
        // 只认「开始于本进程启动之前」的 turn —— 排除正在跑的(见 _bootAtMs 注释)。
        lt(sessions.activeTurnStartedAt, _bootAtMs),
      ),
    );
  // startedAt 必非 null(上面的 gt/lt 比较已排除),类型收窄用于批量处置的 CAS。
  return rows.flatMap((r) => (r.startedAt == null ? [] : [{ sessionId: r.id, startedAt: r.startedAt }]));
}

/** 同上,只要会话 id —— 红点首拉用。 */
export async function listInterruptedPendingSessionIds(): Promise<string[]> {
  const rows = await listInterruptedPendingRows();
  return rows.map((r) => r.sessionId);
}

/**
 * 「尾部停在未处理错误行」的 active 会话 id —— 红点派生的第二条腿。
 *
 * 为什么需要它(2026-07 红点与横幅统一):侧栏红点此前只认 renderer 内存态
 * (makerChatStore 的 state.error),而那份内存态有两个不可靠处 —— LRU 上限会驱逐
 * 整条会话 slice;错误行落库后「会话不在活跃视图」时会主动清掉 live error。两者
 * 都会让红点消失而输入框上方的 error-tail banner 仍在。banner 的判定
 * (CCAgentSessionView 的 errorTailMsg)依赖已加载的 messages[],只有打开过的会话
 * 算得出来,所以必须在 main 侧补一份对任意会话都成立的持久判定。
 *
 * 判定 = 会话未被 rewind 的**最后一条**消息是 role='error' 且未 dismissed。turn 一
 * 旦重新跑起来就会插入新的 user 行,该 error 行不再是尾行,查询自然不再命中 ——
 * 与 banner「会话空闲才展示」的条件天然对齐,不需要额外的 running 判定。
 *
 * ⚠️ 四个必须照做的点(踩过的坑):
 *  1. content 是 TEXT 列而非 JSON 列,可能存非法 JSON(见 mergeDismissedIntoErrorContent
 *     的 fallback 分支)。json_extract 遇非法 JSON 直接抛 malformed JSON,故先用
 *     json_valid 守卫,非法内容按「未 dismissed」处理 —— 宁可多提示一次,不吞掉报错。
 *  2. 「最后一条」用 (created_at, rowid) 双键严格大于,同毫秒靠插入序区分,并且两侧
 *     都要 rewind_at IS NULL —— 漏掉会把已被 rewind 截断的历史行当成尾行。口径与
 *     hasAssistantProgressAfterMessage 完全一致。
 *  3. **必须带 /clear 可见性边界**(created_at > cleared_at):`/clear` 不删消息行,
 *     只推进 sessions.cleared_at,消息读取路径靠它把旧历史挡在视图外。漏掉这条会
 *     让 clear 之前的 error 行继续被判为「未处理告警」—— 横幅根本不显示(消息已不
 *     可见),红点却挂着且无法处置,批量处置还会去改已隐藏的历史行。中断态那条腿
 *     (listInterruptedPendingSessionIds)一直有同款 cleared_at 守卫。
 *  4. 必须走 `.select().from()` builder(同上函数的 ⚠️):生产 worker 模式的
 *     drizzleProxy 只路由带 toSQL 的 builder,裸 `.all(sql)` 会被静默吞掉。
 */
export async function listErrorTailPendingRows(): Promise<
  { sessionId: string; clientId: string }[]
> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({ sessionId: messages.sessionId, clientId: messages.clientId })
    .from(messages)
    .innerJoin(sessions, eq(sessions.id, messages.sessionId))
    .where(
      and(
        eq(sessions.status, 'active'),
        inArray(sessions.source, DESKTOP_VISIBLE_SESSION_SOURCES),
        eq(messages.role, 'error'),
        isNull(messages.rewindAt),
        // /clear 可见性边界(见上方 ⚠️ 3):clear 之前的行在视图里已不可见,不能算告警。
        gt(messages.createdAt, sql`COALESCE(${sessions.clearedAt}, 0)`),
        // 顶层 dismissed:true = 用户点过「忽略」(mergeDismissedIntoErrorContent 写入)。
        sql`(json_valid(${messages.content}) = 0
          OR json_extract(${messages.content}, '$.dismissed') IS NOT 1)`,
        // 该 error 行必须是会话尾行(见上方 ⚠️ 2)。
        sql`NOT EXISTS (
          SELECT 1 FROM messages m2
          WHERE m2.session_id = ${messages.sessionId}
            AND m2.rewind_at IS NULL
            AND (m2.created_at > ${messages.createdAt}
              OR (m2.created_at = ${messages.createdAt}
                AND m2.rowid > ${sql.raw('"messages"."rowid"')}))
        )`,
      ),
    );
  // 尾行判定保证每会话最多一行(同毫秒同 rowid 不可能并存)。
  return rows;
}

/** 同上,只要会话 id —— 红点派生用。 */
export async function listErrorTailPendingSessionIds(): Promise<string[]> {
  const rows = await listErrorTailPendingRows();
  return [...new Set(rows.map((r) => r.sessionId))];
}

/**
 * ⚠️ 两条腿语义不同,**不要**再提供一个「合集」入口:
 * 中断是「上一个进程留下的未收尾 turn」,一次性、只增不减(用户 ack 后永久消失);
 * 错误尾行是「当前消息流的尾部状态」,会随 turn 起落自然变化。renderer 因此分开
 * 消费:中断腿只在启动首拉一次并由 lastTurnEndedAt patch 收敛,错误尾行腿参与每轮
 * 重算。批量处置需要 clientId,直接用 listErrorTailPendingRows。
 *
 * 正确性不再依赖调用时机:中断腿自带 startedAt < bootAt 守卫(见 _bootAtMs),
 * 运行中的会话在任何时刻都不会被它算进来。
 */

/**
 * 错误重试续跑判定(agent-input-coordinator 的 hasAssistantProgressAfter dep):
 * 某条已派发 user 消息之后,agent 是否已产出内容(assistant / tool_use / thinking /
 * ask_user / plan_review 持久化行,rewind 软删的不算)。找不到该 user 行(失败
 * 早于持久化 / 已被 rewind)按无产出处理 —— 重发原文是安全兜底。
 *
 * 单条 SQL 完成:"之后"的边界用 (created_at, rowid) 双键严格大于(同毫秒共存
 * 行靠插入序区分);user 行查询与产出判定在同一语句内(EXISTS,SQLite 单语句
 * 一致性),无两查询间被 rewind 的竞态。
 *
 * ⚠️ 必须走 `.select().from()` query builder,禁止 root db 裸 `.all(sql)`:
 * 生产 worker 模式的 drizzleProxy 只路由带 toSQL 的 builder,裸终端方法直接抛错
 * 且被调用方 catch 吞掉,打包版会静默退化为"永远重发原文"。
 */
export async function hasAssistantProgressAfterMessage(
  sessionId: string,
  userClientId: string,
): Promise<boolean> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({ found: sql<number>`1` })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        inArray(messages.role, ['assistant', 'tool_use', 'thinking', 'ask_user', 'plan_review']),
        isNull(messages.rewindAt),
        sql`EXISTS (
          SELECT 1 FROM messages u
          WHERE u.session_id = ${sessionId}
            AND u.client_id = ${userClientId}
            AND u.rewind_at IS NULL
            AND (${messages.createdAt} > u.created_at
              OR (${messages.createdAt} = u.created_at AND ${sql.raw('"messages"."rowid"')} > u.rowid))
        )`,
      ),
    )
    .limit(1);
  return Boolean(row?.found);
}

/** 测试专用:重置模块内存态。 */
export function _resetSessionActiveTurnStateForTests(): void {
  _writeChains.clear();
  _quitFrozen = false;
  _onTurnEndedPersisted = null;
}
