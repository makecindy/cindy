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

import { randomUUID } from 'node:crypto';

import {
  GHOST_ASSISTANT_HOOK_TIMEOUT_MS,
  GHOST_HOOK_FUSE_THRESHOLD,
  GHOST_HOOK_REWRITE_MAX_CHARS,
  GHOST_HOOK_TIMEOUT_MS,
  GHOST_SUB_QUEUE_MAX,
  type GhostDidEventName,
  type GhostEventSessionData,
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
  onHookFused?(ghost: InstalledGhost): void;
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
    data: GhostEventTurnStartData | GhostEventTurnEndData | GhostEventSessionData,
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
    data: GhostEventTurnStartData | GhostEventTurnEndData | GhostEventSessionData,
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
  async screenUserMessage(input: { sessionId: string; text: string }): Promise<GhostScreenResult> {
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
      });
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
  async screenAssistantMessage(input: {
    sessionId: string;
    text: string;
  }): Promise<GhostAssistantScreenResult> {
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
      });
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
      this.noteHookFailure(ghost, e, deliverFailure ?? 'timeout');
      return null;
    }
    e.hookFails = 0;
    return verdict;
  }

  private noteHookFailure(ghost: InstalledGhost, e: SubEntry, why: string): void {
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
      this.deps.onHookFused?.(ghost);
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
}

export interface TurnEventSink {
  turnStart(data: GhostEventTurnStartData): void;
  turnEnd(data: GhostEventTurnEndData): void;
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

    if (ev.type === 'status') {
      const isRunning =
        typeof ev.data === 'object' && ev.data !== null
          ? (ev.data as { isRunning?: unknown }).isRunning === true
          : false;
      if (isRunning) {
        // closing 期间就开新 turn:上一轮确实没等到定性事件,按中断收口。
        if (this.state === 'closing') this.finish(base, 'interrupted', undefined);
        if (this.state === 'idle') {
          this.state = 'running';
          this.startedAt = now();
          this.startedAgent = base.agent;
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
      this.finish(base, 'completed', usage);
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
    this.opts.sink.turnEnd({
      ...base,
      durationMs: Math.max(0, endAt - this.startedAt),
      endReason,
      ...(usage !== undefined ? { usage } : {}),
    });
  }
}
