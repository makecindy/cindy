import { eq } from 'drizzle-orm';
import * as localDbSchema from '@cindy/runtime-db/schema';
import type { DbClient } from '@cindy/runtime-db';
import type { DbLogger } from '@cindy/runtime-db/logging';
import type { InstalledGhost } from '@cindy/plugin-runtime/shared/ghost';
import { GhostActivityTracker, GhostTurnTranslator, GhostTurnOriginTracker, GhostTapPendingQueue,
 isGhostEligibleSessionRow, isGhostSessionSwitchEligibleRow, type GhostSubscriptionGateway,
 type GhostInteractionActivityKind, type GhostScreenResult, type MinimalAgentEvent } from './subscriptionGateway.js';
export interface GhostSessionEventsHost<Stamp> {
 availableGhosts(): InstalledGhost[]; getDbClient(): DbClient;
 getGhostOwnerPushStamp(): Stamp; isGhostOwnerStampCurrent(stamp: Stamp): boolean;
 getGhostSubscriptionGateway(): GhostSubscriptionGateway;
 log: DbLogger;
}
type PendingActivityRequest = {kind: GhostInteractionActivityKind; requestId: string};
export function createGhostSessionEvents<Stamp>(host: GhostSessionEventsHost<Stamp>) {
 const {availableGhosts,getDbClient,getGhostOwnerPushStamp,isGhostOwnerStampCurrent,getGhostSubscriptionGateway,log}=host;
async function isGhostEligibleSession(
  sessionId: string,
  scope: 'default' | 'session-switch' = 'default',
): Promise<
  | { outcome: 'eligible'; agentKind?: string; workdir?: string }
  | { outcome: 'ineligible' }
  | { outcome: 'retry' }
> {
  try {
    // 查询必须 await(DB 走 worker-thread 异步代理,全仓惯用法),不能用
    // 同步 .all()——代理下拿不到真实行(2026-07-12 实测踩坑)。
    const rows = await getDbClient()
      .drizzle.select({
        source: localDbSchema.sessions.source,
        orcaRole: localDbSchema.sessions.orcaRole,
        agentKind: localDbSchema.sessions.agentKind,
        workingDir: localDbSchema.sessions.workingDir,
      })
      .from(localDbSchema.sessions)
      .where(eq(localDbSchema.sessions.id, sessionId))
      .limit(1);
    const row = rows[0];
    if (!row) return { outcome: 'retry' }; // 行未落库(极早期)→ 暂时态
    const isEligible =
      scope === 'session-switch'
        ? isGhostSessionSwitchEligibleRow(row)
        : isGhostEligibleSessionRow(row);
    if (isEligible) {
      return {
        outcome: 'eligible',
        agentKind: row.agentKind ?? undefined,
        workdir: row.workingDir ?? undefined,
      };
    }
    log.debug('ghost eligibility: rejected', {
      sessionId,
      source: String(row.source),
      orcaRole: String(row.orcaRole),
    });
    return { outcome: 'ineligible' };
  } catch (err) {
    // DB 未就绪等基建失败:暂时态,绝不终身定性(也绝不影响会话)。
    log.debug('ghost eligibility: transient failure, will retry', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { outcome: 'retry' };
  }
}

function createGhostSessionTap(sessionId: string): {
  handleEvent(ev: MinimalAgentEvent & { turnOrigin?: { kind?: string } }): void;
  interactionObserver: {
    onStart(request: PendingActivityRequest, route?: { origin?: { kind?: string } }): void;
    onEnd(request: PendingActivityRequest, route?: { origin?: { kind?: string } }): void;
  };
  dispose(): void;
} {
  let translator: GhostTurnTranslator | null = null;
  let activity: GhostActivityTracker | null = null;
  /** 拆线不可逆:资格判定是异步的,回调必须知道自己已经没有归属会话了。 */
  let disposed = false;
  // 资格判定**惰性化 + 可重试**:接线发生在启动重连期,DbClient 可能还没
  // 就绪——判定挪到第一个事件到达时(用户已在交互,DB 必然可用);暂时性
  // 失败(retry)不定性,下个事件再试,封顶后放弃(防怪会话反复打 DB)。
  let state: 'unknown' | 'resolving' | 'eligible' | 'ineligible' = 'unknown';
  // 轮次来源:interaction 侧只靠 route 判断不住 goal / scheduler(它们没 route),
  // 得从事件流上记。语义与理由见 GhostTurnOriginTracker。资格无关,恒记。
  const origin = new GhostTurnOriginTracker();
  let attempts = 0;
  const MAX_ATTEMPTS = 5;
  const MAX_PENDING = 32;
  // 有界缓冲,溢出丢最旧(留下的是到达序后缀,不留孤儿 start),语义见 GhostTapPendingQueue。
  const pending = new GhostTapPendingQueue(MAX_PENDING, () => {
    log.warn('ghost session tap pending overflow while resolving eligibility', {
      sessionId,
      cap: MAX_PENDING,
    });
  });

  const applyActivity = (phase: 'start' | 'end', request: PendingActivityRequest): void => {
    if (!activity) {
      pending.push({ type: 'activity', phase, request });
      return;
    }
    if (phase === 'start') activity.startInteraction(request.kind, request.requestId);
    else activity.endInteraction(request.kind, request.requestId);
  };

  const kickResolve = (): void => {
    if (state !== 'unknown') return;
    if (attempts >= MAX_ATTEMPTS) {
      state = 'ineligible';
      pending.clear();
      return;
    }
    state = 'resolving';
    attempts += 1;
    void isGhostEligibleSession(sessionId).then((info) => {
      // 判定期间会话已拆线:不建 translator、不回放,否则会向已经没人配对的
      // topic 发出一条永远等不到 end 的 did-turn-start。
      if (disposed) return;
      if (info.outcome === 'retry') {
        state = 'unknown'; // 暂时态:留着 pending,下个事件再试
        return;
      }
      if (info.outcome === 'ineligible') {
        state = 'ineligible';
        pending.clear();
        return;
      }
      const gw = getGhostSubscriptionGateway();
      activity = new GhostActivityTracker({
        sessionId,
        sink: { activity: (name, data) => gw.publish('activity', name, data) },
      });
      translator = new GhostTurnTranslator({
        sessionId,
        agent: info.agentKind ?? 'unknown',
        now: () => Date.now(),
        sink: {
          turnStart: (d) => {
            gw.publish('turn', 'did-turn-start', d);
            activity?.beginTurn();
          },
          turnEnd: (d) => {
            activity?.finishTurn();
            gw.publish('turn', 'did-turn-end', d);
          },
        },
      });
      state = 'eligible';
      // 先取快照再回放:applyActivity 在 activity 已就绪后直投,不会再回队。
      const replay = pending.drain();
      log.debug('ghost session tap eligible', {
        sessionId,
        replay: replay.length,
        ...(pending.dropped > 0 ? { droppedPending: pending.dropped } : {}),
      });
      for (const item of replay) {
        if (item.type === 'event') {
          activity.handleEvent(item.event);
          translator.handleEvent(item.event);
        } else {
          applyActivity(item.phase, item.request);
        }
      }
    });
  };

  return {
    handleEvent(ev) {
      if (disposed) return;
      // 记来源要在过滤**之前**:自动化轮次的事件正是"当前轮次不是用户发起"的唯一线索。
      origin.noteEvent(ev);
      if (ev.turnOrigin?.kind && ev.turnOrigin.kind !== 'user') return;
      if (state === 'eligible') {
        activity?.handleEvent(ev);
        translator?.handleEvent(ev);
        return;
      }
      if (state === 'ineligible') return;
      pending.push({
        type: 'event',
        event: {
          type: ev.type,
          data: ev.data,
          source: ev.source,
          ...(ev.turnContinuationId !== undefined
            ? { turnContinuationId: ev.turnContinuationId }
            : {}),
        },
      });
      kickResolve();
    },
    interactionObserver: {
      onStart(request, route) {
        if (state === 'ineligible') return;
        if (!origin.acceptsInteraction(route)) return;
        applyActivity('start', request);
        if (state !== 'eligible') kickResolve();
      },
      onEnd(request, route) {
        if (state === 'ineligible') return;
        void route; // 见 acceptsInteraction 注释:end 只按 requestId 配对,不过滤来源
        applyActivity('end', request);
        if (state !== 'eligible') kickResolve();
      },
    },
    dispose() {
      if (disposed) return; // 两条 disposer 路径都可能跑到,补发只做一次
      disposed = true;
      // 补发都会走插件分发链路,它们的异常不能打断 register.ts 的 disposer 队列
      // (实例替换路径是裸调用,后面还排着 onEvent 退订),也不能让 activity 侧的
      // 失败吃掉 turn 侧的补发,所以两段各自兜住。
      const guard = (stage: string, fn: () => void): void => {
        try {
          fn();
        } catch (err) {
          log.warn('ghost session tap dispose failed', {
            sessionId,
            stage,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };
      // 先收口 activity 再收口 turn:会话关闭 / Session 实例替换时,router 里可能还有
      // interaction 等在 finally 前,而 observer 马上就会被摘掉——不补发 end 插件就会
      // 永久停在"等待审批 / 等待用户输入"。顺序也是契约:未收口的 thinking end 必须
      // 排在 did-turn-end 之前(回合边界只收口 thinking——审批可以跨回合终态,
      // 见 GhostActivityTracker)。
      guard('activity', () => activity?.finishAll());
      guard('turn', () => translator?.dispose());
      activity?.reset();
      translator = null;
      activity = null;
      pending.clear();
      state = 'ineligible';
    },
  };
}

function hasEnabledUserMessageHookGhost(): boolean {
  try {
    return availableGhosts().some(
      (g) => g.enabled && g.manifest.subscribe?.hooks?.includes('will-user-message'),
    );
  } catch {
    // 判定不了就按"有人在管"处理:宁可少一个智能标题,也不把内容送出去。
    return true;
  }
}

async function screenGhostUserMessage(
  sessionId: string,
  text: string,
): Promise<GhostScreenResult> {
  const ownerStamp = getGhostOwnerPushStamp();
  try {
    const hasHookGhost = availableGhosts().some(
      (g) => g.enabled && g.manifest.subscribe?.hooks?.includes('will-user-message'),
    );
    if (!hasHookGhost) return { action: 'allow' };
    // retry(DB 未就绪)也放行:拦截是尽力而为的旁路,fail-open 不挡发送。
    if ((await isGhostEligibleSession(sessionId)).outcome !== 'eligible')
      return { action: 'allow' };
    const result = await getGhostSubscriptionGateway().screenUserMessage(
      { sessionId, text },
      ownerStamp,
    );
    return isGhostOwnerStampCurrent(ownerStamp) ? result : { action: 'allow' };
  } catch (err) {
    log.warn('ghost screen failed (fail-open)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { action: 'allow' };
  }
}
function notifyGhostSessionEvent(
  kind: 'created' | 'archived' | 'switched',
  data: { sessionId: string; workdir?: string },
  shouldPublish: () => boolean | Promise<boolean> = () => true,
  onRetry: () => void = () => {},
): void {
  void (async () => {
    try {
      // 快路径:没人订 session topic 就不查 DB(纯内存判断,调用方零负担)。
      const hasSubscriber = availableGhosts().some(
        (g) => g.enabled && g.manifest.subscribe?.topics?.includes('session'),
      );
      if (!hasSubscriber) return;
      // created / archived 与 turn 事件同口径；switched 额外允许归一后的 Orca Lead。
      // retry 视为不投，生命周期事件不值得引入重试机制。
      const info = await isGhostEligibleSession(
        data.sessionId,
        kind === 'switched' ? 'session-switch' : 'default',
      );
      if (info.outcome !== 'eligible') {
        if (info.outcome === 'retry') onRetry();
        return;
      }
      // switched 的调用方(renderer 路由上报)只有 sessionId,workdir 从资格
      // 查询顺手补上,与 created/archived 的载荷形状对齐。
      const payload =
        data.workdir === undefined && info.workdir !== undefined
          ? { ...data, workdir: info.workdir }
          : data;
      // switched 在异步归一、资格查询完成后再确认一次焦点代次；确认与去重在同一步完成。
      if (!(await shouldPublish())) return;
      getGhostSubscriptionGateway().publish(
        'session',
        kind === 'created'
          ? 'did-session-created'
          : kind === 'archived'
            ? 'did-session-archived'
            : 'did-session-switched',
        payload,
      );
    } catch {
      /* 订阅事件是旁路,静默 */
    }
  })();
}
 return {notifyGhostSessionEvent,isGhostEligibleSession,createGhostSessionTap,hasEnabledUserMessageHookGhost,screenGhostUserMessage};
}
