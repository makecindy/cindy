/**
 * subscriptionGateway.ts — 订阅槽①网关(旁听 did- + 拦截 will-,2026-07-12 开闸)。
 * ---------------------------------------------------------------------------
 * 订阅卡槽:意识经管子旁听会话事件(fire-and-forget),
 * 或对用户消息行使拦截裁决(停等 + fail-open)。一种事件模型两个类型:
 *
 *   did-  旁听:publish() 按 topic 白名单扇出 → 在跑直投 / 熄灯进队列
 *         (上限 GHOST_SUB_QUEUE_MAX 丢最旧,dropped 计数随下一条带出)→
 *         事件到达触发按需拉起,醒后按 seq 顺序补投。投完即走,意识
 *         崩/慢不影响任何会话。
 *   will- 拦截:screenUserMessage() 串行询问声明了钩子的意识(装入序,
 *         谁先 block 谁生效短路);单意识硬超时 GHOST_HOOK_TIMEOUT_MS,
 *         超时/崩溃 = 放行(fail-open,聊天绝不被坏意识卡死);连续
 *         GHOST_HOOK_FUSE_THRESHOLD 次失败熔断降级为只旁听并通知宿主。
 *
 * 确定性纪律(规则 9):topic 过滤、限速缓冲、超时、熔断、短路顺序全部
 * 代码强制,意识只能在协议留出的两个决策位(是否订阅、allow/block)表态。
 * 依赖注入(规则 14):意识清单/运行态/唤醒/投递全经 deps,单测直喂。
 */

import { createHash, randomUUID } from 'node:crypto';

import { isTurnContinuationBoundaryEvent } from '@cindy/maker-shared/turn-continuation';

import {
  GHOST_ASSISTANT_HOOK_TIMEOUT_MS,
  GHOST_HOOK_FUSE_THRESHOLD,
  GHOST_HOOK_REWRITE_MAX_CHARS,
  GHOST_HOOK_TIMEOUT_MS,
  GHOST_SUB_QUEUE_MAX,
  type GhostActivityEventName,
  type GhostDidEventData,
  type GhostDidEventName,
  type GhostEventActivityData,
  type GhostEventInteractionActivityData,
  type GhostEventThinkingData,
  type GhostEventTurnEndData,
  type GhostEventTurnStartData,
  type GhostPipeEventPush,
  type GhostSubscribeTopic,
  type InstalledGhost,
} from '../../shared/ghost.js';

/** block 理由展示上限(超长截断,防意识用理由塞小作文)。 */
const BLOCK_REASON_MAX_CHARS = 200;

/** 单意识裁决(askOne 归一化产物;null = 本轮失败已计熔断)。 */
type HookVerdict = {
  action: 'allow' | 'block' | 'rewrite' | 'render';
  reason?: string;
  text?: string;
  html?: string;
  height?: number;
};

/**
 * 用户消息拦截结果(will-user-message,宿主消费):
 * - allow:原样派发;
 * - rewrite:用 text 替换正文后派发,气泡留痕署名;
 * - block:丢弃 + 被拦气泡署名。
 */
export type GhostScreenResult =
  | { action: 'allow' }
  | { action: 'block'; ghostId: string; ghostName: string; reason: string }
  | { action: 'rewrite'; ghostId: string; ghostName: string; text: string };

/**
 * AI 回复拦截结果(will-assistant-message,宿主消费):
 * - allow:原样定案;
 * - rewrite:用 text 替换回复正文后定案(静默替换);
 * - render:意识自绘卡片替换气泡——html 待宿主净化 + clamp;text = 定案的
 *   权威正文(供落库 + "查看原文");无 block(AI 已生成,拦无意义)。
 */
export type GhostAssistantScreenResult =
  | { action: 'allow' }
  | { action: 'rewrite'; ghostId: string; ghostName: string; text: string }
  | { action: 'render'; ghostId: string; ghostName: string; html: string; height?: number; text: string };

export interface GhostSubscriptionGatewayDeps {
  /** 当前已装且启用的意识清单(现读跟随装卸/启停热更)。 */
  listGhosts(): InstalledGhost[];
  /** 意识电子脑是否在跑。 */
  isRunning(ghostId: string): boolean;
  /** 按需拉起电子脑(幂等;失败 reject)。 */
  wake(ghost: InstalledGhost): Promise<void>;
  /** 管子下行投递(electronSandboxAdapter.sendToGhostLogic;失败抛/返 false)。 */
  sendToGhost(ghostId: string, payload: GhostPipeEventPush): void;
  now(): number;
  /** 钩子熔断回调(通知 renderer + 日志;每意识只触发一次)。 */
  onHookFused?(ghost: InstalledGhost, ownerStamp?: unknown): void;
  /** hookId 生成(测试注入固定序列;缺省 randomUUID)。 */
  newHookId?(): string;
  log?: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
}

/** 每意识的订阅运行态。 */
interface SubEntry {
  seq: number;
  /** 熄灯期缓冲(did- 事件,按 seq 序)。 */
  buffer: GhostPipeEventPush[];
  /** 溢出丢弃数(随下一条成功入队/投递的事件带出)。 */
  pendingDropped: number;
  /** 唤醒在途标记(合并并发 kick,避免重复 spawn)。 */
  waking: boolean;
  /** 钩子连续失败数(超时/投递失败;成功裁决清零)。 */
  hookFails: number;
  /** 熔断:钩子降级为不再询问(旁听不受影响)。意识重启不自动复位,
   *  重新启停(disable/enable 清 entry)或重启应用后恢复。 */
  hookFused: boolean;
}

/** 待决钩子(hookId → 归属意识与 resolver)。 */
interface PendingHook {
  ghostId: string;
  resolve(verdict: HookVerdict | null): void;
}

export class GhostSubscriptionGateway {
  private readonly entries = new Map<string, SubEntry>();
  private readonly pendingHooks = new Map<string, PendingHook>();

  constructor(private readonly deps: GhostSubscriptionGatewayDeps) {}

  /* ── did- 旁听 ─────────────────────────────────────────────────────── */

  /** 向所有订阅了该 topic 的启用意识扇出一条 did- 事件。 */
  publish(
    topic: GhostSubscribeTopic,
    name: GhostDidEventName,
    data: GhostDidEventData,
  ): void {
    for (const ghost of this.deps.listGhosts()) {
      if (!ghost.enabled) continue;
      if (!ghost.manifest.slots.includes('subscribe')) continue;
      if (!ghost.manifest.subscribe?.topics?.includes(topic)) continue;
      this.dispatchTo(ghost, topic, name, data);
    }
  }

  private entry(ghostId: string): SubEntry {
    let e = this.entries.get(ghostId);
    if (!e) {
      e = { seq: 0, buffer: [], pendingDropped: 0, waking: false, hookFails: 0, hookFused: false };
      this.entries.set(ghostId, e);
    }
    return e;
  }

  private dispatchTo(
    ghost: InstalledGhost,
    topic: GhostSubscribeTopic,
    name: GhostDidEventName,
    data: GhostDidEventData,
  ): void {
    const ghostId = ghost.manifest.id;
    const e = this.entry(ghostId);
    const evt: GhostPipeEventPush = {
      type: 'event',
      name,
      topic,
      seq: ++e.seq,
      ts: this.deps.now(),
      data,
    };

    // 直投条件:在跑 + 缓冲已清 + 无唤醒在途——三者缺一都排队,否则新事件
    // 会插到缓冲里旧事件前面(seq 乱序)。投递失败(刚崩窗口期)同样回落缓冲。
    if (this.deps.isRunning(ghostId) && e.buffer.length === 0 && !e.waking) {
      if (this.sendOne(ghostId, e, evt)) return;
    }
    this.buffer(ghost, e, evt);
  }

  /** 实际投递一条 did- 事件:溢出丢弃数在此刻附着(构造期附着会被后续
   *  同样溢出的事件把计数吞掉),投成才清零。返回是否投成。 */
  private sendOne(ghostId: string, e: SubEntry, evt: GhostPipeEventPush): boolean {
    const payload = e.pendingDropped > 0 ? { ...evt, dropped: e.pendingDropped } : evt;
    try {
      this.deps.sendToGhost(ghostId, payload);
      e.pendingDropped = 0;
      return true;
    } catch {
      return false;
    }
  }

  private buffer(ghost: InstalledGhost, e: SubEntry, evt: GhostPipeEventPush): void {
    if (e.buffer.length >= GHOST_SUB_QUEUE_MAX) {
      e.buffer.shift();
      e.pendingDropped += 1;
    }
    e.buffer.push(evt);
    this.kickWake(ghost, e);
  }

  /** 事件到达即按需拉起(去重:唤醒在途不重复 spawn),醒后顺序补投。 */
  private kickWake(ghost: InstalledGhost, e: SubEntry): void {
    if (e.waking) return;
    e.waking = true;
    void this.deps
      .wake(ghost)
      .then(() => this.flush(ghost.manifest.id, e))
      .catch((err) => {
        // 唤醒失败缓冲保留(封顶丢最旧),下一条事件再试。
        this.deps.log?.warn('ghost subscribe wake failed', {
          ghostId: ghost.manifest.id,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        e.waking = false;
      });
  }

  private flush(ghostId: string, e: SubEntry): void {
    while (e.buffer.length > 0 && this.deps.isRunning(ghostId)) {
      if (!this.sendOne(ghostId, e, e.buffer[0])) break; // 又熄灯了:留在缓冲等下次
      e.buffer.shift();
    }
  }

  /* ── will- 拦截 ────────────────────────────────────────────────────── */

  /**
   * 用户消息发出前的拦截询问。串行(装入序)问每个声明了 will-user-message
   * 且未熔断的启用意识,**链式变换**:前一个 rewrite 的输出是后一个的输入
   * (currentText 累积)。block 即短路返回;任何异常都不外抛——本方法在发送
   * 热路径上,只能收敛为 allow / 累积 rewrite。
   */
  async screenUserMessage(
    input: { sessionId: string; text: string },
    ownerStamp?: unknown,
  ): Promise<GhostScreenResult> {
    let currentText = input.text;
    let rewritten = false;
    let lastRewriteGhost: InstalledGhost | null = null;
    for (const ghost of this.deps.listGhosts()) {
      if (!ghost.enabled) continue;
      if (!ghost.manifest.subscribe?.hooks?.includes('will-user-message')) continue;
      const ghostId = ghost.manifest.id;
      const e = this.entry(ghostId);
      if (e.hookFused) continue;

      const verdict = await this.askOne(ghost, e, 'will-user-message', {
        sessionId: input.sessionId,
        text: currentText,
      }, ownerStamp);
      if (verdict?.action === 'block') {
        const reason = (verdict.reason ?? '').slice(0, BLOCK_REASON_MAX_CHARS);
        this.deps.log?.info('ghost hook blocked user message', { ghostId, sessionId: input.sessionId });
        return { action: 'block', ghostId, ghostName: ghost.manifest.name, reason };
      }
      if (verdict?.action === 'rewrite' && typeof verdict.text === 'string') {
        const next = verdict.text.slice(0, GHOST_HOOK_REWRITE_MAX_CHARS).trim();
        // 空改写(意识把正文清空)视为无意义,忽略此次 rewrite 保原文。
        if (next.length > 0 && next !== currentText) {
          currentText = next;
          rewritten = true;
          lastRewriteGhost = ghost;
          this.deps.log?.info('ghost hook rewrote user message', { ghostId, sessionId: input.sessionId });
        }
      }
    }
    if (rewritten && lastRewriteGhost) {
      return {
        action: 'rewrite',
        ghostId: lastRewriteGhost.manifest.id,
        ghostName: lastRewriteGhost.manifest.name,
        text: currentText,
      };
    }
    return { action: 'allow' };
  }

  /**
   * AI 回复定案前的拦截询问(will-assistant-message,出口钩子)。与
   * screenUserMessage 同构:串行(装入序)问每个声明了该钩子且未熔断的启用
   * 意识,**链式变换**——前一个 rewrite 的输出是后一个的输入。区别:
   * - 无 block(AI 已生成,拦无意义;意识若误发 block 按 allow 略过);
   * - 新增 render(自绘卡片替换气泡)——**最后一个 render 胜出**(与"最后一个
   *   rewrite 胜出"一致);html 原样带出,由宿主净化 + clamp。
   * text(权威正文,供落库 + "查看原文")= 链式 rewrite 后的 currentText
   * (无 rewrite 即等于 AI 原文)。本方法在 turn 结束的独立续跑里跑,异常绝不
   * 外抛,只收敛为 allow / rewrite / render。
   */
  async screenAssistantMessage(
    input: { sessionId: string; text: string },
    ownerStamp?: unknown,
  ): Promise<GhostAssistantScreenResult> {
    let currentText = input.text;
    let lastRewriteGhost: InstalledGhost | null = null;
    let renderGhost: InstalledGhost | null = null;
    let renderHtml = '';
    let renderHeight: number | undefined;
    for (const ghost of this.deps.listGhosts()) {
      if (!ghost.enabled) continue;
      if (!ghost.manifest.subscribe?.hooks?.includes('will-assistant-message')) continue;
      const ghostId = ghost.manifest.id;
      const e = this.entry(ghostId);
      if (e.hookFused) continue;

      const verdict = await this.askOne(ghost, e, 'will-assistant-message', {
        sessionId: input.sessionId,
        text: currentText,
      }, ownerStamp);
      if (verdict?.action === 'rewrite' && typeof verdict.text === 'string') {
        const next = verdict.text.slice(0, GHOST_HOOK_REWRITE_MAX_CHARS).trim();
        // 空改写(意识把正文清空)视为无意义,忽略此次 rewrite 保原文。
        if (next.length > 0 && next !== currentText) {
          currentText = next;
          lastRewriteGhost = ghost;
          this.deps.log?.info('ghost hook rewrote assistant message', { ghostId, sessionId: input.sessionId });
        }
      } else if (verdict?.action === 'render' && typeof verdict.html === 'string' && verdict.html.trim().length > 0) {
        // 最后一个 render 胜出:记录它,html 净化交给宿主 apply 层。
        renderGhost = ghost;
        renderHtml = verdict.html;
        renderHeight = typeof verdict.height === 'number' ? verdict.height : undefined;
        this.deps.log?.info('ghost hook rendered assistant message', { ghostId, sessionId: input.sessionId });
      }
      // allow / block(对本钩子非法)/ 空 render / 空 rewrite:略过,继续链。
    }
    // render 优先于 rewrite:render 是呈现层替换,text 仍带出权威正文(可能已被
    // 链上 rewrite 改过)供落库 + "查看原文"。
    if (renderGhost) {
      return {
        action: 'render',
        ghostId: renderGhost.manifest.id,
        ghostName: renderGhost.manifest.name,
        html: renderHtml,
        height: renderHeight,
        text: currentText,
      };
    }
    if (lastRewriteGhost) {
      return {
        action: 'rewrite',
        ghostId: lastRewriteGhost.manifest.id,
        ghostName: lastRewriteGhost.manifest.name,
        text: currentText,
      };
    }
    return { action: 'allow' };
  }

  /** 问一个意识:唤醒(如需)+ 投递 + 等裁决,整体套一只超时闸。
   *  投递(含 wake)**不在超时闸前阻塞**——fire 后立刻进入等待,wake 挂死
   *  (恶意/损坏意识 load 永不完成)照样 3s 放行,这才是真正的整体上界;
   *  迟到的 wake 完成后即便把事件送出去,hookId 已过期,裁决被静默丢。
   *  返回 null = 本轮失败(已计入熔断),外层按放行继续。 */
  private async askOne(
    ghost: InstalledGhost,
    e: SubEntry,
    hookName: 'will-user-message' | 'will-assistant-message',
    input: { sessionId: string; text: string },
    ownerStamp?: unknown,
  ): Promise<HookVerdict | null> {
    const ghostId = ghost.manifest.id;
    const hookId = this.deps.newHookId?.() ?? randomUUID();
    // 超时按钩子分:入口(user-message)必须快(挡发送);出口(assistant-message)
    // 是后台后置钩,容许长处理(见 GHOST_ASSISTANT_HOOK_TIMEOUT_MS)。
    const timeoutMs =
      hookName === 'will-assistant-message' ? GHOST_ASSISTANT_HOOK_TIMEOUT_MS : GHOST_HOOK_TIMEOUT_MS;

    let resolveVerdict!: (v: HookVerdict | null) => void;
    const verdictPromise = new Promise<HookVerdict | null>((resolve) => {
      resolveVerdict = resolve;
    });
    this.pendingHooks.set(hookId, { ghostId, resolve: resolveVerdict });
    const timer = setTimeout(() => {
      if (this.pendingHooks.delete(hookId)) resolveVerdict(null); // 超时 = fail-open
    }, timeoutMs);

    let deliverFailure: string | null = null;
    void (async () => {
      // 常驻意识正常在跑;崩溃恢复窗口内兜底拉一次。
      if (!this.deps.isRunning(ghostId)) await this.deps.wake(ghost);
      this.deps.sendToGhost(ghostId, {
        type: 'event',
        name: hookName,
        hookId,
        ts: this.deps.now(),
        data: { sessionId: input.sessionId, text: input.text },
      });
    })().catch((err) => {
      if (this.pendingHooks.delete(hookId)) {
        deliverFailure = `deliver: ${err instanceof Error ? err.message : String(err)}`;
        resolveVerdict(null);
      }
    });

    const verdict = await verdictPromise;
    clearTimeout(timer);
    if (verdict === null) {
      this.noteHookFailure(ghost, e, deliverFailure ?? 'timeout', ownerStamp);
      return null;
    }
    e.hookFails = 0;
    return verdict;
  }

  private noteHookFailure(
    ghost: InstalledGhost,
    e: SubEntry,
    why: string,
    ownerStamp?: unknown,
  ): void {
    e.hookFails += 1;
    this.deps.log?.warn('ghost hook failed (fail-open)', {
      ghostId: ghost.manifest.id,
      why,
      fails: e.hookFails,
    });
    if (e.hookFails >= GHOST_HOOK_FUSE_THRESHOLD && !e.hookFused) {
      e.hookFused = true;
      this.deps.log?.warn('ghost hook fused: degraded to observe-only', {
        ghostId: ghost.manifest.id,
      });
      this.deps.onHookFused?.(ghost, ownerStamp);
    }
  }

  /** 上行裁决(ghost-pipe:send 'event-verdict' 分支)。冒名/过期/畸形静默丢
   *  (不给意识探测面);归属校验:hookId 必须是问到该意识头上的那只。 */
  handleVerdict(ghostId: string, payload: unknown): void {
    if (typeof payload !== 'object' || payload === null) return;
    const p = payload as Record<string, unknown>;
    if (p.type !== 'event-verdict' || typeof p.hookId !== 'string') return;
    if (p.action !== 'allow' && p.action !== 'block' && p.action !== 'rewrite' && p.action !== 'render') return;
    const pending = this.pendingHooks.get(p.hookId);
    if (!pending || pending.ghostId !== ghostId) return;
    this.pendingHooks.delete(p.hookId);
    pending.resolve({
      action: p.action,
      ...(typeof p.reason === 'string' ? { reason: p.reason } : {}),
      ...(typeof p.text === 'string' ? { text: p.text } : {}),
      ...(typeof p.html === 'string' ? { html: p.html } : {}),
      ...(typeof p.height === 'number' ? { height: p.height } : {}),
    });
  }

  /** 意识停用/抽离时清态(缓冲、熔断、seq 全部归零;待决钩子按超时自然收口)。 */
  dropGhost(ghostId: string): void {
    this.entries.delete(ghostId);
  }
}

/**
 * 订阅事件投递资格的行级判定(纯谓词,抽出便于单测;DB 查询在调用方):
 * 只投**用户主会话**——亲手建的(desktop)与分享导入后自己在用的(shared);
 * IM 机器人渠道(feishu/slack/discord)、本机自动化(scheduler/learn)与 Orca
 * 协同会话(orcaRole 非空)一律排除,它们的动态对意识是噪音。
 * (2026-07-13 实撞:shared 会话被旧的 desktop-only 判定静默排除,用户切到
 * 分享导入的会话时 did-session-switched 不发,还连带切回时重复发上一会话。)
 */
export function isGhostEligibleSessionRow(row: {
  source: string | null | undefined;
  orcaRole: string | null | undefined;
}): boolean {
  // orcaRole 宽松判空:worker-thread 代理序列化可能把 NULL 列变 undefined。
  // plugin 来源:workspace 槽创建的项目会话,用户打开后正常交互,应享有完整的
  // ghost 事件(turn/hook/session-switched 等),与 desktop/shared 同等待遇。
  return (row.source === 'desktop' || row.source === 'shared' || row.source === 'plugin') && row.orcaRole == null;
}

/**
 * 会话切换去重器(did-session-switched 的入口滤波,抽成工厂便于单测):
 * renderer 的路由 effect 每次路由变化都上报"当前台前会话"(路由重渲/非会话
 * 页为 null),这里只放行**真变化**——连续同 id 不重发;切去非会话页(null)
 * 只清位不发事件;切走再切回(A → null → A)算一次新切换照发。
 */
export function createGhostSessionFocusTracker(
  notify: (sessionId: string) => void,
): { note(sessionId: string | null): void; current(): string | null } {
  let last: string | null = null;
  return {
    note(sessionId) {
      if (sessionId === last) return;
      last = sessionId;
      if (sessionId) notify(sessionId);
    },
    // 台前会话快照(preview 槽缺省落点等"当前会话"语境用;非会话页为 null)。
    current() {
      return last;
    },
  };
}

/* ── 会话事件翻译器(AgentEvent → did-turn-*)────────────────────────────
 * maker-core 没有独立的 turn_start/turn_end 事件:turn 生命周期由 status
 * (data.isRunning 翻转)+ done / terminal error 携带。本翻译器把它折叠成
 * 意识事件,每会话一实例,状态机三值:idle → running → idle。 */

/** 翻译器吃的最小事件形状(AgentEvent 子集,避免依赖 maker-core 类型)。 */
export interface MinimalAgentEvent {
  type: string;
  data?: unknown;
  source?: string;
  turnContinuationId?: number;
}

export interface TurnEventSink {
  turnStart(data: GhostEventTurnStartData): void;
  turnEnd(data: GhostEventTurnEndData): void;
}

/**
 * 读 status 事件的 isRunning。非 status 事件返回 null(供"这是不是轮次起点"判断);
 * status 但 data 形状不对按 false —— 拿不准就不算在跑。
 */
export function readStatusIsRunning(ev: MinimalAgentEvent): boolean | null {
  if (ev.type !== 'status') return null;
  if (typeof ev.data !== 'object' || ev.data === null) return false;
  return (ev.data as { isRunning?: unknown }).isRunning === true;
}

export type GhostTapPendingItem =
  | { type: 'event'; event: MinimalAgentEvent }
  | {
      type: 'activity';
      phase: 'start' | 'end';
      request: { kind: GhostInteractionActivityKind; requestId: string };
    };

/**
 * 资格判定期的有界缓冲。DB 未就绪时判定要重试,这段时间的事件先攒着,判定通过后
 * 按序回放;封顶防怪会话把内存吃干。
 *
 * 溢出策略:**丢最旧**(与网关缓冲一致)。要护住的不变量是"回放出去的流里不留孤儿
 * start" —— 没有 end 的 start 会让插件永久停在"在忙 / 在等审批",要等会话销毁才被
 * finishAll 兜底。丢最旧天然满足它:留下的永远是到达序的一个**后缀**,某个 start 还在
 * 队里就意味着它之后的一切都还在,它的 end 也在。
 *
 * 反过来落单的 end 无害 —— 三个下游状态机对它一律 no-op:translator 在 idle 收到
 * done/error 直接 return、非 running 收到 status(false) 不动;endThinking 认 blockId、
 * endInteraction 认在场 requestId。极端情况下连 status(true) 一起被挤掉,turnActive
 * 压根不置起,那一轮连 thinking 都整体静默 —— 是"少一段情节",不是"半段情节"。
 *
 * 所以这里不需要按事件类型做配对压缩:丢最新才需要(收口事件本就排在最后,首当其冲),
 * 而那要求队列认识 thinking / turn / interaction 各自的语义。
 */
export class GhostTapPendingQueue {
  private readonly items: GhostTapPendingItem[] = [];
  private droppedCount = 0;

  constructor(
    private readonly cap: number,
    /** 首次溢出回调(只回一次,避免怪会话刷爆日志)。 */
    private readonly onFirstOverflow?: () => void,
  ) {}

  get size(): number {
    return this.items.length;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  push(item: GhostTapPendingItem): void {
    if (this.items.length >= this.cap) {
      this.items.shift();
      this.noteDropped(1);
    }
    this.items.push(item);
  }

  /** 取快照并清空(回放用:先清再放,回放中新到的事件不会被本轮吞掉)。 */
  drain(): GhostTapPendingItem[] {
    return this.items.splice(0, this.items.length);
  }

  clear(): void {
    this.items.length = 0;
  }

  private noteDropped(count: number): void {
    const wasEmpty = this.droppedCount === 0;
    this.droppedCount += count;
    if (wasEmpty) this.onFirstOverflow?.();
  }
}

/**
 * activity 标识的对外投影:把上游 id 换成**主机域内的不透明配对键**。
 *
 * 为什么必须投影 —— provider 侧的 id 不保证语义中立。codex 的 MCP elicitation 会把
 * 服务名拼进 requestId(`mcp-elicitation:<serverName>:…`,`codex/index.ts:4699`),
 * 计划审批带 `codex-plan-review:` 前缀(`:3838`);原样转发就等于告诉插件"正在请求
 * 哪个 MCP 服务 / 这是计划审批",与权限确认框宣称的"只知道时机、看不到待批准的操作"
 * 不符。thinking 的 blockId 今天是时间戳 / 随机 / provider item id,并不泄露,但一起
 * 投影才能让这个协议**结构上**不透传任何 provider 值 —— 上游以后往 id 里塞东西也伤
 * 不到我们,而不是依赖"我们审计过今天的形态"。
 *
 * 为什么是确定性哈希而不是分配式 ID —— 同一个上游 id 恒定映射到同一个 token,所以
 * start/end 的配对契约逐字不变,不需要映射表、不需要清理、不新增任何状态。
 * 掺 sessionId 是为了让同一个上游 id 在不同会话里得到不同 token(不给跨会话关联留口)。
 * 截 16 位十六进制 = 64 bit:单会话内标识量级 ≤ 10³,碰撞概率约 10⁻¹⁴,可忽略。
 *
 * 注意 `sessionId` 本身不投影 —— 它是 turn / session / activity 三个 topic 共用的关联键,
 * 换掉会断掉插件"把 activity 关联回哪个会话"的能力,而它本来就在 turn / session 里明文投。
 */
export function ghostActivityId(sessionId: string, upstreamId: string): string {
  // 带长度前缀拼接:两段都可能含任意分隔符,前缀保证拼接无歧义
  // (不同的 (sessionId, upstreamId) 组合不可能拼出同一个串)。
  return createHash('sha256')
    .update(`${sessionId.length}:${sessionId}:${upstreamId}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * 轮次来源跟踪:回答"这条 interaction 该不该投给插件"。
 *
 * 为什么需要它 —— interaction router 给 observer 的 `route.origin` 是另一套取值
 * (TurnPermissionOrigin: desktop / im / scheduler / hook),而且只有 hook-control 与
 * IM turnRunner 会 beginInteractionRoute。goal 续跑与 scheduler 定时任务都是直发
 * session.send,压根没有 route,光看 route 会把它们的审批 / 提问放行;而事件侧
 * (turnOrigin 非 user)又把它们的轮次事件滤掉了,插件就会收到"没有对应轮次的审批",
 * 违反作者手册"不投后台自动化"的契约。所以来源要从事件流上自己记。
 */
export class GhostTurnOriginTracker {
  /** 缺省 user:接线发生在任何轮次之前,首个轮次起点到达前按用户会话处理。 */
  private kind = 'user';

  /**
   * 只在轮次起点(status isRunning:true)更新:Session 越过 dispatch 边界后才装
   * currentTurnOrigin,provider 的 status(true) 必然带上本轮 origin;而轮次终态之后
   * origin 会被清空,逐事件更新会被 undefined 抹回 user。
   *
   * 也**不在轮次结束时复位** —— codex 计划审批就发生在轮次终态之后,复位会把它
   * 误判成用户轮次。下一个轮次起点自然会覆盖。
   */
  noteEvent(ev: MinimalAgentEvent & { turnOrigin?: { kind?: string } }): void {
    if (readStatusIsRunning(ev) === true) this.kind = ev.turnOrigin?.kind ?? 'user';
  }

  /**
   * 两道独立的门:route 存在时必须是 desktop 面(IM / hook 注册的是 channel-card /
   * headless);route 缺省即 Desktop 面,此时再看当前轮次来源挡掉 goal / scheduler。
   *
   * **只该用在 start 侧**:end 由 GhostActivityTracker 按 requestId 配对,没登记过的
   * requestId 本就是 no-op。若 end 也过滤,一旦来源在等待期间翻转(理论上被 Session
   * busy 守卫挡住,但不该依赖它),start 就会永远等不到 end。
   */
  acceptsInteraction(route?: { origin?: { kind?: string } }): boolean {
    if (route?.origin?.kind && route.origin.kind !== 'desktop') return false;
    return this.kind === 'user';
  }
}

export type GhostInteractionActivityKind =
  | 'permission'
  | 'plan_review'
  | 'ask_user_question';

export interface ActivityEventSink {
  activity(
    name: GhostActivityEventName,
    data: GhostEventActivityData,
  ): void;
}

/** interaction kind → 对插件暴露的活动类型(等待用户回答 vs 等待用户批准)。 */
function activityTypeOf(kind: GhostInteractionActivityKind): 'approval' | 'user-input' {
  return kind === 'ask_user_question' ? 'user-input' : 'approval';
}

/**
 * activity 边界状态机：同步、O(1)、不读取正文。两类活动的生命周期主人不同:
 *
 * - **thinking 归回合**:是单活跃 block 模型(vendor 的 reasoning block 串行产出,
 *   新 block 开始即代表上一个已收口),只在回合内有意义,turn 收口时强制结束。
 * - **approval / user-input 归 router,可跨回合终态**:codex 计划模式里
 *   runPlanReviewFlow 是在计划 turn 把 status(false) 与 done **入队之后**才发起
 *   plan_review(见 agents/codex/index.ts 的 "放在 done 之后 (AsyncQueue FIFO)"),
 *   即 done 必然先被消费。若拿 turnActive 当门控,这个审批的 start 会被直接丢掉,
 *   插件根本不知道用户正在批计划;若靠 turn 收口去补 end,又会在用户还在审批时
 *   谎报"审批结束"。所以这两类只认 SessionInteractionRouter 的 dispatch/finally
 *   ——finally 保证每个 requestId 一定收口,回合边界不插手。
 *
 * 两类都按 id 集合跟踪:同一轮的并行工具调用会让多个 permission 同时等在 router
 * 里(见 SessionInteractionRouter.pending),用单值覆盖会在第二个请求开始时提前给
 * 第一个发 end。每个 id 各配一对 start/end,插件按集合非空判断是否仍在等待。
 */
export class GhostActivityTracker {
  private turnActive = false;
  private thinkingBlockId: string | null = null;
  private lastEndedThinkingBlockId: string | null = null;
  private readonly interactionRequestIds: Record<'approval' | 'user-input', Set<string>> = {
    approval: new Set(),
    'user-input': new Set(),
  };

  constructor(private readonly opts: { sessionId: string; sink: ActivityEventSink }) {}

  beginTurn(): void {
    if (this.turnActive) this.finishTurn();
    this.turnActive = true;
    this.lastEndedThinkingBlockId = null;
  }

  handleEvent(ev: MinimalAgentEvent): void {
    if (!this.turnActive) return;
    if (ev.type !== 'thinking' || typeof ev.data !== 'object' || ev.data === null) return;
    const data = ev.data as { stage?: unknown; blockId?: unknown };
    if (typeof data.blockId !== 'string' || data.blockId.length === 0) return;
    if (
      data.stage !== 'start' &&
      data.stage !== 'delta' &&
      data.stage !== 'final' &&
      data.stage !== 'redacted'
    ) return;
    if (data.stage === 'start' || data.stage === 'delta') {
      this.startThinking(data.blockId);
      return;
    }
    if (this.thinkingBlockId !== data.blockId) {
      if (this.lastEndedThinkingBlockId === data.blockId) return;
      this.startThinking(data.blockId);
    }
    this.endThinking(data.blockId);
  }

  /** 不看 turnActive:审批可以在回合终态之后才开始(codex 计划模式),见类注释。 */
  startInteraction(kind: GhostInteractionActivityKind, requestId: string): void {
    if (!requestId) return;
    const type = activityTypeOf(kind);
    // 同一 requestId 重复进入(路由重投)不重复发 start。
    if (this.interactionRequestIds[type].has(requestId)) return;
    this.interactionRequestIds[type].add(requestId);
    this.emitInteraction(type, 'start', requestId);
  }

  endInteraction(kind: GhostInteractionActivityKind, requestId: string): void {
    const type = activityTypeOf(kind);
    // delete 返回 false = 这个 requestId 没在场(已收口或从未开始),不重复发 end。
    if (!this.interactionRequestIds[type].delete(requestId)) return;
    this.emitInteraction(type, 'end', requestId);
  }

  /** 回合收口:只结束 thinking。在场的审批交给 router 的 finally,不在这里谎报结束。 */
  finishTurn(): void {
    if (!this.turnActive) return;
    if (this.thinkingBlockId) this.endThinking(this.thinkingBlockId);
    this.lastEndedThinkingBlockId = null;
    this.turnActive = false;
  }

  /**
   * 会话级收口(tap dispose):observer 即将被摘掉,router 的 finally 再也到不了
   * 这里,所以此刻必须把仍在场的审批 / 等待输入逐个补 end,否则插件永久停在等待态。
   */
  finishAll(): void {
    this.finishTurn();
    this.finishInteraction('approval');
    this.finishInteraction('user-input');
  }

  reset(): void {
    this.turnActive = false;
    this.thinkingBlockId = null;
    this.lastEndedThinkingBlockId = null;
    this.interactionRequestIds.approval.clear();
    this.interactionRequestIds['user-input'].clear();
  }

  private startThinking(blockId: string): void {
    if (this.thinkingBlockId === blockId) return;
    if (this.thinkingBlockId) this.endThinking(this.thinkingBlockId);
    this.thinkingBlockId = blockId;
    this.lastEndedThinkingBlockId = null;
    this.opts.sink.activity('did-thinking-start', this.thinkingData(blockId));
  }

  private endThinking(blockId: string): void {
    if (this.thinkingBlockId !== blockId) return;
    this.opts.sink.activity('did-thinking-end', this.thinkingData(blockId));
    this.thinkingBlockId = null;
    this.lastEndedThinkingBlockId = blockId;
  }

  /** 给所有仍在场的 requestId 各补一条 end(仅会话级收口调用,见 finishAll)。 */
  private finishInteraction(type: 'approval' | 'user-input'): void {
    const ids = this.interactionRequestIds[type];
    if (ids.size === 0) return;
    // 先取快照再清:emit 是同步回调,清空后再遍历可避免被回调内的再入改动影响。
    const pending = [...ids];
    ids.clear();
    for (const requestId of pending) this.emitInteraction(type, 'end', requestId);
  }

  /** 内部状态一律用上游原值配对,只在**出网关那一刻**投影(见 ghostActivityId)。 */
  private thinkingData(blockId: string): GhostEventThinkingData {
    return {
      sessionId: this.opts.sessionId,
      blockId: ghostActivityId(this.opts.sessionId, blockId),
    };
  }

  private emitInteraction(
    type: 'approval' | 'user-input',
    edge: 'start' | 'end',
    requestId: string,
  ): void {
    const data: GhostEventInteractionActivityData = {
      sessionId: this.opts.sessionId,
      requestId: ghostActivityId(this.opts.sessionId, requestId),
    };
    if (type === 'approval') {
      this.opts.sink.activity(edge === 'start' ? 'did-approval-start' : 'did-approval-end', data);
    } else {
      this.opts.sink.activity(edge === 'start' ? 'did-user-input-start' : 'did-user-input-end', data);
    }
  }
}

/** 从 done 事件的 usage 里尽力抽 token 数。三种真实形态都认:
 *  cc snake_case(input_tokens/cache_read_input_tokens…)、通用 camelCase、
 *  codex translator 形态(promptTokens/completionTokens/cachedTokens);
 *  抽不出的字段缺省——协议里 usage 字段全部可选。 */
export function normalizeTurnUsage(raw: unknown): GhostEventTurnEndData['usage'] {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const u = raw as Record<string, unknown>;
  const pick = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = u[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return undefined;
  };
  const inputTokens = pick('inputTokens', 'input_tokens', 'promptTokens');
  const outputTokens = pick('outputTokens', 'output_tokens', 'completionTokens');
  const cacheReadTokens = pick(
    'cacheReadTokens',
    'cache_read_input_tokens',
    'cachedInputTokens',
    'cachedTokens',
  );
  const cacheCreationTokens = pick('cacheCreateTokens', 'cache_creation_input_tokens');
  const usage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function mergeTurnUsage(
  left: GhostEventTurnEndData['usage'],
  right: GhostEventTurnEndData['usage'],
): GhostEventTurnEndData['usage'] {
  const compact = (
    usage: GhostEventTurnEndData['usage'],
  ): GhostEventTurnEndData['usage'] => {
    if (!usage) return undefined;
    const entries = Object.entries(usage).filter(([, value]) => value > 0);
    return entries.length > 0
      ? (Object.fromEntries(entries) as NonNullable<GhostEventTurnEndData['usage']>)
      : undefined;
  };
  left = compact(left);
  right = compact(right);
  if (!left) return right;
  if (!right) return left;
  const merged = {
    inputTokens: (left.inputTokens ?? 0) + (right.inputTokens ?? 0),
    outputTokens: (left.outputTokens ?? 0) + (right.outputTokens ?? 0),
    cacheReadTokens: (left.cacheReadTokens ?? 0) + (right.cacheReadTokens ?? 0),
    cacheCreationTokens:
      (left.cacheCreationTokens ?? 0) + (right.cacheCreationTokens ?? 0),
  };
  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value > 0),
  ) as NonNullable<GhostEventTurnEndData['usage']>;
}

/** status(false) 后等 done/error 定性的宽限窗:两个 agent 的真实事件序都是
 *  先 status(isRunning:false) 后 done(cc/codex translator 皆如此),status
 *  一到就收口会把所有正常完成误判成 interrupted。同队列的 done 毫秒级即到,
 *  500ms 只是"真中断没有后续事件"时的兜底定性延迟。 */
const TURN_END_GRACE_MS = 500;

export class GhostTurnTranslator {
  /** 状态机:idle →(status true)→ running →(status false)→ closing
   *  →(done/error 定性 | 宽限到期按 interrupted)→ idle。 */
  private state: 'idle' | 'running' | 'closing' = 'idle';
  private startedAt = 0;
  /** closing 进入时刻(duration 以它为准,不算宽限等待)。 */
  private endedAt = 0;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Usage sealed by claimed SDK boundaries inside the still-running product turn. */
  private continuationUsage: GhostEventTurnEndData['usage'];
  /** 本轮 did-turn-start 实际发出去的 agent(已含 ev.source 覆盖);拆线补发 end 要
   *  复用它,不能退回 opts.agent——两者取值域不同,见 dispose。 */
  private startedAgent: string | null = null;

  constructor(
    private readonly opts: {
      sessionId: string;
      agent: string;
      model?: string;
      now(): number;
      sink: TurnEventSink;
      /** 宽限毫秒(测试注入;缺省 TURN_END_GRACE_MS)。 */
      graceMs?: number;
    },
  ) {}

  handleEvent(ev: MinimalAgentEvent): void {
    const { sessionId, agent, model, now, sink } = this.opts;
    const base: GhostEventTurnStartData = {
      sessionId,
      agent: ev.source ?? agent,
      ...(model !== undefined ? { model } : {}),
    };

    if (isTurnContinuationBoundaryEvent(ev)) {
      if (this.state !== 'idle' && ev.type === 'done') {
        const usage = normalizeTurnUsage(
          typeof ev.data === 'object' && ev.data !== null
            ? (ev.data as { usage?: unknown }).usage
            : undefined,
        );
        this.continuationUsage = mergeTurnUsage(this.continuationUsage, usage);
      }
      return;
    }

    if (ev.type === 'status') {
      const isRunning = readStatusIsRunning(ev) === true;
      if (isRunning) {
        // closing 期间就开新 turn:上一轮确实没等到定性事件,按中断收口。
        if (this.state === 'closing') this.finish(base, 'interrupted', undefined);
        if (this.state === 'idle') {
          this.state = 'running';
          this.startedAt = now();
          this.startedAgent = base.agent;
          this.continuationUsage = undefined;
          sink.turnStart(base);
        }
      } else if (this.state === 'running') {
        // 先到的 status(false) 不定性:紧随其后的 done/error 才知道是正常
        // 完成还是出错;宽限到期都没来 = 真中断(用户打断/进程没了)。
        this.state = 'closing';
        this.endedAt = now();
        this.graceTimer = setTimeout(() => {
          this.graceTimer = null;
          if (this.state === 'closing') this.finish(base, 'interrupted', undefined);
        }, this.opts.graceMs ?? TURN_END_GRACE_MS);
      }
      return;
    }

    if (this.state === 'idle') return; // done/error 只在 turn 内有意义,幂等防重
    if (ev.type === 'done') {
      const usage = normalizeTurnUsage(
        typeof ev.data === 'object' && ev.data !== null
          ? (ev.data as { usage?: unknown }).usage
          : undefined,
      );
      this.finish(base, 'completed', mergeTurnUsage(this.continuationUsage, usage));
    } else if (ev.type === 'error') {
      const isTerminal =
        typeof ev.data === 'object' && ev.data !== null
          ? (ev.data as { isTerminal?: unknown }).isTerminal !== false
          : true;
      if (isTerminal) this.finish(base, 'error', undefined);
    }
  }

  /**
   * 会话拆线收口(tap dispose 调用):turn 在场时补一条 did-turn-end。
   *
   * 漏发的后果是插件永久卡住:订阅方靠 did-turn-start / did-turn-end 配对维护
   * 「AI 是否在忙」,拆线时缺了 end,它的外层状态就停在 working 再也回不来——下一轮
   * 到达时序列变成 start, start,配对彻底断掉,插件除重启没有自愈手段。
   *
   * 两条拆线路径(会话关闭、Session 实例替换)一律报 interrupted:对插件的含义相同
   * ——这一轮的产出不会再来。实例替换不会因此把一个仍在跑的 turn 拆成两轮,因为
   * agent 切换只在会话空闲时落实(`applyPendingAgentSwitchIfIdle` 的 `isTurnRunning`
   * 守卫),替换发生时本状态机必然已回到 idle,下面的补发分支根本不触发。
   *
   * dispose 时没有 ev 可用,`agent` 复用本轮 start 发出的值而不是 `opts.agent`:后者
   * 来自 `sessions.agent_kind`(默认 `'cc'`),而 start 走的是 `ev.source`
   * (`'claude-code'`)。补发的 end 必须与那条 start 报同一个 agent,否则按 agent
   * 分组维护状态的插件配不上这一对,配对照样闭合不了。
   */
  dispose(): void {
    this.clearGraceTimer();
    if (this.state === 'idle') return;
    const { sessionId, agent, model } = this.opts;
    this.finish(
      {
        sessionId,
        agent: this.startedAgent ?? agent,
        ...(model !== undefined ? { model } : {}),
      },
      'interrupted',
      undefined,
    );
  }

  private clearGraceTimer(): void {
    if (!this.graceTimer) return;
    clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  private finish(
    base: GhostEventTurnStartData,
    endReason: GhostEventTurnEndData['endReason'],
    usage: GhostEventTurnEndData['usage'],
  ): void {
    this.clearGraceTimer();
    // running 态直接定性(done 先于 status false 的容错路径)用当前时刻;
    // closing 态用 status(false) 到达时刻,宽限等待不算进 turn 时长。
    const endAt = this.state === 'closing' ? this.endedAt : this.opts.now();
    this.state = 'idle';
    this.startedAgent = null;
    this.continuationUsage = undefined;
    this.opts.sink.turnEnd({
      ...base,
      durationMs: Math.max(0, endAt - this.startedAt),
      endReason,
      ...(usage !== undefined ? { usage } : {}),
    });
  }
}
