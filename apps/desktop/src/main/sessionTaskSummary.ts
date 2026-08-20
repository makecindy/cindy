/**
 * sessionTaskSummary — 置顶会话的"任务现状一句话摘要"生成器
 * ---------------------------------------------------------------------------
 * sidebar-card-mode redesign:置顶卡片不再展示"最近消息前 140 字"原文,
 * 而是一句概括"任务是什么 + 当前进展"。列表/文字模式不展示摘要。
 *
 * 生成时机(两处调用方,都 fire-and-forget):
 *   1. maker-ipc/register.ts — turn 结束(done event)
 *   2. localDb/ipc/sessions.ts — 会话被置顶那一刻(动态 import 避免模块环)
 * 两处都还要满足「置顶段当前是卡片模式」(由 renderer 通知)。
 * 列表/文字模式下的 turn-done(force)会清掉旧摘要,切回卡片时由回填按最新内容重写。
 *
 * 成本控制(对齐 title.ts 的口径):
 *   - 仅 status='active' 且 pinnedAt 非空、置顶段是卡片模式时生成
 *   - maker.oneShot 路由到低价模型(Claude → haiku / Codex → mini),maxTokens 80
 *   - per-session in-flight 守卫 + 20s 节流,失败 swallow
 *
 * 落库直写 summary 列,**不碰 updatedAt**(避免 sidebar 重排),完成后广播
 * local-db:sessions:patched 让 renderer 即时刷新(与 fbotTitle 同通道)。
 *
 * 纯逻辑(档位选择 / sanitize / 定时识别 / 素材判定 / prompt)抽到
 * sessionTaskSummary.logic.ts,便于单测且本文件运行时直接复用——无平行实现漂移。
 */

import { BrowserWindow } from 'electron';
import { and, count, desc, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

import { getMaker } from './maker-host/index.js';
import { isAgentOneShotRouteDisabled } from './maker-host/model-route-guard-live.js';
import { agentSupportsOneShot, requestUtilityText } from './utility-model/oneShotCandidates.js';
import { getDbClient } from './localDb/client/current.js';
import { latestMessageText } from './localDb/latestMessageText.js';
import { extractMessagePreview } from './localDb/mapper.js';
import { messages, sessions } from './localDb/schema.js';
import { createLogger } from './logger.js';
import { tapWindowBroadcast } from './device-link/broadcast-tap.js';
import {
  STALE_SHORT_MS,
  SUMMARY_STALE_MAX_CHARS,
  SUMMARY_PROMPT,
  sanitize,
  isScheduledSession,
  pickTier,
  maxCharsForTier,
  hasSummarizableMaterial,
  shouldGeneratePinnedCardSummary,
  shouldVoidSummaryAfterGenerationAttempt,
  nonCardTurnDisplayPatch,
  shouldForceGenerateOnClear,
  shouldScheduleForceGenerateAfterInFlight,
} from './sessionTaskSummary.logic.js';

const log = createLogger('sessionTaskSummary');

/** 同一 session 两次生成的最小间隔。 */
const THROTTLE_MS = 20_000;

/** 置顶段当前是否卡片模式。默认 false:renderer 未通知前不生成。 */
let pinnedSectionIsCard = false;
/** 一次启动只回填一轮。切到卡片模式会清掉再跑。 */
let backfillDone = false;

/** 正在生成中的 session → 其生成 Promise。去重用;force 模式据此等在跑的那次结束再重生成。 */
const inFlight = new Map<string, Promise<void>>();
const lastGeneratedAt = new Map<string, number>();

/**
 * 广播 sessions:patched 到本机所有窗口 + device-link tap。tap 让该 patch 经 topic 路由
 * 转发给订阅了 `sessions` 的控制端(push 驱动:控制端 applyPatch 即时镜像 summary,无需
 * 等下一次全量 reseed)——与 localDb/ipc/sessions.ts broadcastSessionPatched 同口径。
 */
function broadcastPatched(sessionId: string, patch: Record<string, unknown>): void {
  tapWindowBroadcast('local-db:sessions:patched', { sessionId, patch });
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('local-db:sessions:patched', { sessionId, patch });
    } catch {
      /* swallow */
    }
  }
}

const messageRowid = sql<number>`rowid`;

/** 与 sessions:list / 删除消息同一口径的最近可见消息 preview。 */
async function latestVisiblePreview(sessionId: string): Promise<string | null> {
  const db = getDbClient().drizzle;
  const [sessionRow] = await db
    .select({ clearedAt: sessions.clearedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const visibleAfterClear =
    sessionRow?.clearedAt == null ? undefined : gt(messages.createdAt, sessionRow.clearedAt);
  const [latestRow] = await db
    .select({ content: messages.content, role: messages.role })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        sql`${messages.role} IN ('user', 'assistant')`,
        isNull(messages.rewindAt),
        sql`(${messages.agentMeta} IS NULL OR json_extract(${messages.agentMeta}, '$.autoResume') IS NOT 1)`,
        visibleAfterClear,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messageRowid))
    .limit(1);
  return extractMessagePreview(latestRow?.content, latestRow?.role);
}

/** 已切回卡片:绝不继续写 null。没有生成在飞才 force 再生成;在飞则交给那次结算,避免自等待。 */
async function stopClearBecauseCard(sessionId: string): Promise<boolean> {
  if (!pinnedSectionIsCard) return false;
  const sessionGenerateInFlight = inFlight.has(sessionId);
  if (
    shouldForceGenerateOnClear({
      pinnedSectionIsCard: true,
      sessionGenerateInFlight,
    })
  ) {
    await maybeGenerateSessionTaskSummary(sessionId, { force: true });
    return true;
  }
  if (
    shouldScheduleForceGenerateAfterInFlight({
      pinnedSectionIsCard: true,
      sessionGenerateInFlight,
    })
  ) {
    const pending = inFlight.get(sessionId);
    if (pending) {
      void pending
        .catch(() => undefined)
        .then(() => {
          if (!pinnedSectionIsCard) return;
          return maybeGenerateSessionTaskSummary(sessionId, { force: true });
        });
    }
  }
  return true;
}

/** 列表/文字模式下作废旧摘要,并补上最新 preview。不 bump updatedAt。
 *  读/写之间用户可能已切回卡片:那时不能再抹掉摘要(回填可能刚因非空跳过),
 *  且当前没有生成在飞时才 force 再生成——不得从 generateSummaryOnce.finally 再入 inFlight。 */
async function clearSessionTaskSummary(sessionId: string): Promise<void> {
  try {
    if (await stopClearBecauseCard(sessionId)) return;
    let preview: string | null = null;
    try {
      preview = await latestVisiblePreview(sessionId);
    } catch (err) {
      log.warn('latest visible preview for list settle failed (swallowed)', {
        sessionId,
        error: String(err),
      });
    }
    if (await stopClearBecauseCard(sessionId)) return;
    const db = getDbClient().drizzle;
    const [row] = await db
      .select({ summary: sessions.summary })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (row?.summary) {
      if (await stopClearBecauseCard(sessionId)) return;
      await db.update(sessions).set({ summary: null }).where(eq(sessions.id, sessionId));
      if (await stopClearBecauseCard(sessionId)) return;
    }
    lastGeneratedAt.delete(sessionId);
    broadcastPatched(sessionId, nonCardTurnDisplayPatch(preview));
  } catch (err) {
    log.warn('clear stale task summary failed (swallowed)', {
      sessionId,
      error: String(err),
    });
  }
}

/** renderer 在置顶段显示模式变化时通知。切到卡片会重跑一次置顶回填。 */
export function setPinnedSectionCardMode(enabled: boolean): void {
  const next = enabled === true;
  const was = pinnedSectionIsCard;
  pinnedSectionIsCard = next;
  if (next && !was) {
    backfillDone = false;
    void backfillPinnedSessionSummaries();
  }
}

export async function maybeGenerateSessionTaskSummary(
  sessionId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (!pinnedSectionIsCard) {
    // turn-done 是权威边界:列表态不生成,但必须作废旧摘要,否则切回卡片会先露出上一轮句子。
    if (opts.force) await clearSessionTaskSummary(sessionId);
    return;
  }
  const existing = inFlight.get(sessionId);
  if (existing) {
    if (!opts.force) return; // 已有生成在跑 → 去重跳过
    // force(turn-done 权威刷新):等在跑的那次(可能是 pin 触发、基于部分/旧内容)结束,再用
    // 最新已落库内容重生成覆盖——否则 turn 结束的最终摘要会被 in-flight 早返 / 节流挡掉,卡片
    // 停在部分 / 上一轮摘要(codex review:pin during running turn)。
    await existing.catch(() => undefined);
  }
  // force 跳过 20s 节流(turn-done 永远以最新内容刷新);pin 触发 / 回填仍受节流约束。
  if (!opts.force) {
    const last = lastGeneratedAt.get(sessionId);
    if (last !== undefined && Date.now() - last < THROTTLE_MS) return;
  }

  const run = generateSummaryOnce(sessionId);
  inFlight.set(sessionId, run);
  try {
    await run;
  } finally {
    if (inFlight.get(sessionId) === run) inFlight.delete(sessionId);
  }
}

/** 实际生成一次:读素材 → 选档 → oneShot → 写回前重查 → 落库 + 广播。失败 swallow。 */
async function generateSummaryOnce(sessionId: string): Promise<void> {
  let wroteFresh = false;
  try {
    const db = getDbClient().drizzle;
    const [session] = await db
      .select({
        title: sessions.title,
        status: sessions.status,
        pinnedAt: sessions.pinnedAt,
        agentKind: sessions.agentKind,
        source: sessions.source,
        updatedAt: sessions.updatedAt,
        userSendAt: sessions.userSendAt,
        clearedAt: sessions.clearedAt,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (
      !session ||
      !shouldGeneratePinnedCardSummary({
        status: session.status,
        pinnedAt: session.pinnedAt,
        pinnedSectionIsCard,
      })
    ) {
      return;
    }
    const isScheduled = isScheduledSession(session.source, session.title);

    // 消息计数与 latestMessageText 同口径地尊重 /clear 边界——只数 clearedAt 之后、
    // 未 rewind 的消息。否则 /clear 前堆了几百条、清后只剩寥寥几条的会话会被误判成
    // 重上下文(long 档),让 LLM 产出与实际素材不符的过长摘要。
    const msgCountConds = [eq(messages.sessionId, sessionId), isNull(messages.rewindAt)];
    if (session.clearedAt != null) msgCountConds.push(gt(messages.createdAt, session.clearedAt));

    const [userMsg, assistantMsg, [msgCount]] = await Promise.all([
      latestMessageText(sessionId, 'user'),
      latestMessageText(sessionId, 'assistant'),
      db
        .select({ n: count() })
        .from(messages)
        .where(and(...msgCountConds)),
    ]);
    // 没有任何对话素材(空草稿被置顶)——没东西可总结
    if (!hasSummarizableMaterial(userMsg, assistantMsg)) return;

    // 档位以「距今时间(最近活动→现在)」为主轴(用户需求:越久没活动,描述越精简,
    // 卡片区自然分出厚薄层次)。用 userSendAt(最后一次用户真实发送)而非 updatedAt 算距今
    // ——updatedAt 会被置顶/归档等 sessions:update 刷成 now,刚置顶的久会话 updatedAt=now
    // 会被误判成"新鲜"而拿到长档(本条 bug 根因);userSendAt 不被这些操作 bump,与卡片
    // 显示时间同源。具体分档规则见 pickTier。
    const messageCount = msgCount?.n ?? 0;
    const inactiveMs = Date.now() - (session.userSendAt ?? session.updatedAt);
    const tier = pickTier({ inactiveMs, messageCount, isScheduled });

    const agentKind =
      session.agentKind === 'codex' || session.agentKind === 'pi'
        ? session.agentKind
        : 'claude-code';
    const prompt = SUMMARY_PROMPT(session.title, userMsg, assistantMsg, tier);
    // 模型走系统统一配置:优先用"轻量任务模型链"(utility-model,与起标题同源,
    // 由 getUtilityModelChainProfiles 决定),配置缺失/不可用时再回退到 agent 自带的
    // oneShot 兜底——不再写死 haiku/mini。maxTokens 120:长档 30+ CJK 字可能超 80 token,留余量防截断。
    const utility = await requestUtilityText(getMaker(), prompt, {
      maxTokens: 120,
      timeoutMs: 30_000,
    });
    // 停用轴:agent one-shot 兜底是新的付费调用,该 agent 的默认路由被停用时不派发
    // (摘要 best-effort,直接放弃本轮,PR #744 review)。
    // oneShot 能力轴:Pi 未实现 oneShot(继承 BaseAgent 的 not-implemented),对 Pi 会话
    // 走该兜底会抛错、外层 catch 静默把摘要留空。此处摘要绑定会话自身 agent,不像 help
    // 那样跨 agent 兜底 —— 会话 agent 不支持 oneShot 时直接跳过兜底(仅靠 utility-model)。
    const text = utility.ok
      ? utility.text
      : !agentSupportsOneShot(agentKind) || (await isAgentOneShotRouteDisabled(agentKind))
        ? ''
        : await getMaker().oneShot(agentKind, prompt, { maxTokens: 120 });
    const summary = sanitize(text, maxCharsForTier(tier));
    if (!summary) return;

    // 写回前重查会话状态:oneShot 是异步的(数秒),in-flight 期间会话可能已变化,无条件写回
    // 会写入一份已过时的摘要(codex review)。任一不符即跳过:
    //   - clearedAt 变化 = 期间发生过 /clear(handler 已把 summary 置 null),旧摘要基于已隐藏内容;
    //   - status / pinnedAt 变化 = 已归档 / 取消置顶,不该再有摘要;
    //   - userSendAt 变化 = 期间用户又发了新一轮(touchUserSendInDb 已 bump),这份是"上一轮"的
    //     摘要;且新一轮 turn-done 常被 inFlight / 20s 节流挡掉,若此处仍写回旧摘要会长期停在过时态。
    const [cur] = await db
      .select({
        status: sessions.status,
        pinnedAt: sessions.pinnedAt,
        clearedAt: sessions.clearedAt,
        userSendAt: sessions.userSendAt,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!cur || cur.clearedAt !== session.clearedAt || cur.userSendAt !== session.userSendAt) {
      return;
    }
    if (
      !shouldGeneratePinnedCardSummary({
        status: cur.status,
        pinnedAt: cur.pinnedAt,
        pinnedSectionIsCard,
      })
    ) {
      return;
    }

    // 直写 summary,不 bump updatedAt——摘要刷新不应引起 sidebar 重排
    await db.update(sessions).set({ summary }).where(eq(sessions.id, sessionId));
    lastGeneratedAt.set(sessionId, Date.now());
    wroteFresh = true;
    broadcastPatched(sessionId, { summary });
  } catch (err) {
    log.warn('generate task summary failed (swallowed)', {
      sessionId,
      error: String(err),
    });
  } finally {
    // 不变量:生成尝试一旦开始,结算时若不在卡片模式且没写出新摘要,旧句子必须作废。
    // 覆盖成功写回以外的全部出口(空结果 / 抛错 / 写回放弃 / 中途 return)。
    if (
      shouldVoidSummaryAfterGenerationAttempt({
        wroteFresh,
        pinnedSectionIsCard,
      })
    ) {
      await clearSessionTaskSummary(sessionId);
    }
  }
}

/** 回填上限——置顶通常个位数,封顶防极端数据。 */
const BACKFILL_MAX = 20;

/**
 * 启动回填:两类置顶活跃会话需要补/重生成(串行执行避免并发打满 LLM 通道;
 * 由 sessions:list IPC 首次调用时 fire-and-forget,那时 db 必然 ready):
 *   1. 还没有摘要——老数据/上线前置顶的会话不会有 turn-done 触发点
 *   2. 时间衰减降级——久置(>3天)但摘要还没降到超短档(>11字)的会话。
 *      久置会话不会再有 turn-done,启动巡检是衰减唯一的执行点
 */
export async function backfillPinnedSessionSummaries(): Promise<void> {
  if (!pinnedSectionIsCard) return;
  if (backfillDone) return;
  backfillDone = true;
  try {
    const db = getDbClient().drizzle;
    const rows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.status, 'active'),
          isNotNull(sessions.pinnedAt),
          or(
            isNull(sessions.summary),
            and(
              // 距今用 userSendAt(回退 updatedAt)——updatedAt 会被置顶刷成 now,
              // 否则刚置顶的久会话漏检、长摘要降不下来。
              lt(
                sql`coalesce(${sessions.userSendAt}, ${sessions.updatedAt})`,
                Date.now() - STALE_SHORT_MS,
              ),
              sql`length(${sessions.summary}) > ${SUMMARY_STALE_MAX_CHARS}`,
            ),
          ),
        ),
      )
      .limit(BACKFILL_MAX);
    for (const row of rows) {
      await maybeGenerateSessionTaskSummary(row.id);
    }
  } catch (err) {
    log.warn('backfill pinned summaries failed (swallowed)', { error: String(err) });
  }
}
