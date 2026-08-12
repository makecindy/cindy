/**
 * cardService.ts — 意识聊天卡片供片服务(卡槽③海报模式)。
 *
 * 职责:承接管子上行的 card-update 消息,做完整校验链后落库 + 推送:
 *   形状 → callId 已注册 → 归属验身(这单是不是派给你的)→ 卡槽声明 →
 *   晚到宽限 → 限速 → 体积/height clamp → sanitize → persist → broadcast。
 * 一切拒绝只记日志,对沙箱静默(与 tool-result / previewGate 同纪律,
 * 不给恶意包探测面)。
 *
 * 生命周期:mcp-integrations/ghost.ts 在派发 tool-call 前 registerCall,
 * 拿到结果后 finalizeCall(返回"这单是否供过卡",据此决定要不要往结果里
 * 注 xdt_card_id)。finalize 后留 GRACE_MS 宽限窗兜"最后一版在交卷竞态里
 * 晚到"的毛刺,窗外拒绝——无限接受会给已完结消息留远程改写面。
 *
 * 无会话调用方(2026-08-04,scheduler「仅运行脚本」通道):脚本经 broker 直调
 * 意识,没有 agent session,但意识泄洪落盘(root:'workdir')仍凭 callId 定位
 * 写入根。broker 同样在派发前 registerCall、交卷后 finalizeCall,登记时把
 * schedule.workingDir 记为条目的 scriptWorkdir(sessionId 恒 null)——fs 槽
 * 凭它把写盘钳在该目录内,条目随同一套 finalize/宽限/清扫节奏失效,旧
 * callId 不能跨调用复用(与 inFlightCallInfoOf 注释的目录授权不变量同源)。
 * 脚本通道条目拒绝卡片供片(sessionId/toolUseId 均无锚,broadcast 出去是
 * 孤儿卡)。
 *
 * 依赖全注入(规则 14),纯逻辑可用内存 harness 直测,不碰 Electron。
 */

import {
  GHOST_CARD_HEIGHT_DEFAULT,
  GHOST_CARD_HEIGHT_MAX,
  GHOST_CARD_HEIGHT_MIN,
  GHOST_CARD_MIN_INTERVAL_MS,
  GHOST_CARD_REOPEN_WINDOW_MS,
  GHOST_CARD_WORKING_WINDOW_MS,
  GHOST_CARD_ID_KEY,
  type GhostToolCallResult,
} from '../../shared/ghost.js';
import type { SanitizeCardResult } from './cardSanitizer.js';

/**
 * 把卡片配对令牌(xdt_card_id = callId)注入工具调用结果(纯函数,供
 * mcp-integrations/ghost.ts 编排调用):
 * - 没供过卡 / 失败结果:原样返回(模型永远看不到内部 UUID);
 * - result 为纯对象:注入令牌键;
 * - result 为 null/undefined:升格为只含令牌的对象;
 * - 原始值/数组:保持原样(注入会改形状;手册教"要供卡就交 JSON 对象")。
 */
export function withCardToken(
  result: GhostToolCallResult,
  hasCard: boolean,
  callId: string,
): GhostToolCallResult {
  if (!hasCard || !result.ok) return result;
  if (result.result === null || result.result === undefined) {
    return { ok: true, result: { [GHOST_CARD_ID_KEY]: callId } };
  }
  if (typeof result.result === 'object' && !Array.isArray(result.result)) {
    return {
      ok: true,
      result: { ...(result.result as Record<string, unknown>), [GHOST_CARD_ID_KEY]: callId },
    };
  }
  return result;
}

/**
 * report-height IPC 的参数校验 + clamp(纯函数抽出,规则 14:handler 体可
 * 直接单测)。clamp 与供片/renderer 同一对常量,三处不漂移。
 */
export function parseCardHeightReport(
  callId: unknown,
  height: unknown,
): { ok: true; callId: string; height: number } | { ok: false; error: string } {
  if (typeof callId !== 'string' || callId.length === 0 || callId.length > 128) {
    return { ok: false, error: 'callId must be a non-empty string' };
  }
  if (typeof height !== 'number' || !Number.isFinite(height)) {
    return { ok: false, error: 'height must be a finite number' };
  }
  return {
    ok: true,
    callId,
    height: Math.min(GHOST_CARD_HEIGHT_MAX, Math.max(GHOST_CARD_HEIGHT_MIN, Math.round(height))),
  };
}

/** 落库行(html 已是净化产物,renderer 直接用)。 */
export interface GhostCardRow {
  callId: string;
  ghostId: string;
  sessionId: string | null;
  html: string;
  height: number;
  v: number;
  updatedAt: number;
}

/** 推送给 renderer 的载荷(带 html,免回查)。 */
export interface GhostCardPush {
  callId: string;
  ghostId: string;
  /** agent 侧 tool_use id(claude 路径有,codex 为 null → renderer 走启发式锚定)。 */
  toolUseId: string | null;
  /** 静态版(settle 后 / 历史回放用;与落库内容一致)。 */
  html: string;
  /**
   * 动画版(意识自绘动画,keyframes 已过合成器白名单校验;仅 running 期间
   * 装进画布,**从不落库**——历史卡永远静止)。无动画/校验不过为 null,
   * renderer 回退主机统一扫光。
   */
  animatedHtml: string | null;
  height: number;
  /**
   * 意识声明的后台活动状态(card-action 干活场景):'working' = 过程态卡
   * (renderer 可给该卡挂运行扫光),'done' = 终版。未声明为 null。从不落库
   * ——历史回放的卡永远静止。
   */
  state: 'working' | 'done' | null;
}

export interface GhostCardServiceDeps {
  /** 该意识是否声明了 card 卡槽(装载态现查,卸载/沉睡后拒)。 */
  hasCardSlot(ghostId: string): boolean;
  sanitize(html: string): SanitizeCardResult;
  /** upsert by callId;失败仅记日志(推送已发,重启后可能缺历史卡,可接受)。 */
  persist(row: GhostCardRow): Promise<void>;
  broadcast(payload: GhostCardPush): void;
  /**
   * 后台活动信号(会话呼吸链路,可选):每次**被接受**且(处于重开态,或
   * 显式声明了 state)的 card-update 上报一次。未声明 state 的普通
   * tool-call 供片不报——那时会话本就有真实 turn 运行态,重复上报只添乱。
   * state 为意识声明值(未声明 null,由跟踪器按 TTL 兜底)。
   */
  onActivity?(info: {
    callId: string;
    ghostId: string;
    sessionId: string | null;
    state: 'working' | 'done' | null;
  }): void;
  /** 时钟注入(限速/宽限窗用;缺省 Date.now)。 */
  now?(): number;
  log?: {
    debug(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
}

/** finalize 后仍接受 card-update 的宽限窗 ms。 */
const GRACE_MS = 10_000;
/** 注册表清扫间隔的懒触发下限(每次写操作顺手扫,无定时器)。 */
const SWEEP_MIN_INTERVAL_MS = 30_000;

interface CallEntry {
  ghostId: string;
  toolUseId: string | null;
  sessionId: string | null;
  /**
   * 调用通道:'session' = 会话内 ghost_call(默认);'script' = scheduler
   * 「仅运行脚本」broker 直调。显式字段而非由 sessionId/scriptWorkdir 推导
   * ——workingDir 空白的脚本条目(scriptWorkdir null)也必须被识别为脚本
   * 通道(拒卡判据),不能与会话通道的无会话调用混淆(review m2)。
   */
  channel: 'session' | 'script';
  /**
   * 脚本通道(「仅运行脚本」broker 直调)的落盘根:登记时取 schedule.workingDir,
   * 普通会话调用恒 null。fs 槽 root:'workdir' 在 sessionId 为空时凭它定位
   * 写入根(授权来源 = schedule 自身的工作目录配置,意识自报路径被钳在根内)。
   */
  scriptWorkdir: string | null;
  /**
   * 脚本声明的唯一可写相对路径(broker 登记的 out_file 原值):非 null 时
   * fs 槽只放行恰好等于它的写入——调用在途期间插件也写不了根内其它文件
   * (review P1 第五轮:写窗收窄到脚本声明的单个文件)。
   */
  scriptWritePath: string | null;
  hasCard: boolean;
  lastAcceptedAt: number | null;
  settledAt: number | null;
  /**
   * 被 card-action 重开的时刻(交互卡按钮点击后重开卡片更新窗口)。非 null =
   * 处于重开态:settledAt 归 null(不再判 too-late),窗外由懒清扫按
   * GHOST_CARD_REOPEN_WINDOW_MS 回收。普通 in-flight 单为 null。
   */
  reopenedAt: number | null;
  /**
   * 首个被接受的 state:'working' 版本时刻。非 null 且在
   * GHOST_CARD_WORKING_WINDOW_MS 内 = 跨调用更新窗口打开(不判 too-late、
   * 不被清扫)——生成类流程把过程卡钉在提交调用卡位、由轮询调用跨卡位刷
   * 进度靠它。固定起点不滑动(有界豁免,防连续 working 无限续命);
   * state:'done' 归 null 关窗。
   */
  workingSince: number | null;
}

/** 卡片供片服务(单例装配见 cindy-brain/index.ts)。 */
export class GhostCardService {
  private readonly calls = new Map<string, CallEntry>();
  private lastSweepAt = 0;

  constructor(private readonly deps: GhostCardServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** working 跨调用窗口是否仍有效(固定起点,封顶 WORKING_WINDOW)。 */
  private isWorkingActive(entry: CallEntry, now: number): boolean {
    return entry.workingSince !== null && now - entry.workingSince <= GHOST_CARD_WORKING_WINDOW_MS;
  }

  /** 懒清扫:宽限窗过期的完结单移除(体量 = in-flight + 宽限窗内,天然很小)。 */
  private sweep(): void {
    const now = this.now();
    if (now - this.lastSweepAt < SWEEP_MIN_INTERVAL_MS) return;
    this.lastSweepAt = now;
    for (const [callId, entry] of this.calls) {
      // working 跨调用窗口内(生成类流程钉在提交卡位持续供片):不回收。
      if (this.isWorkingActive(entry, now)) continue;
      // 重开态(交互卡):窗外回收,不看 settledAt(已被重开归 null)。
      if (entry.reopenedAt !== null) {
        if (now - entry.reopenedAt > GHOST_CARD_REOPEN_WINDOW_MS) this.calls.delete(callId);
        continue;
      }
      if (entry.settledAt !== null && now - entry.settledAt > GRACE_MS) {
        this.calls.delete(callId);
      }
    }
  }

  /** 派发 tool-call 前登记(callId 由调用方铸造,与管子下行同值)。 */
  registerCall(
    callId: string,
    info: {
      ghostId: string;
      toolUseId: string | null;
      sessionId: string | null;
      /** 脚本通道调用方传入 schedule.workingDir;普通会话调用省略。 */
      scriptWorkdir?: string | null;
      /** 脚本通道调用方传入脚本声明的 out_file(唯一可写相对路径);无写窗时省略。 */
      scriptWritePath?: string | null;
      /** 脚本通道调用方传 'script';缺省 'session'(会话内 ghost_call)。 */
      channel?: 'script';
    },
  ): void {
    this.sweep();
    this.calls.set(callId, {
      ghostId: info.ghostId,
      toolUseId: info.toolUseId,
      sessionId: info.sessionId,
      channel: info.channel ?? 'session',
      scriptWorkdir: info.scriptWorkdir ?? null,
      scriptWritePath: info.scriptWritePath ?? null,
      hasCard: false,
      lastAcceptedAt: null,
      settledAt: null,
      reopenedAt: null,
      workingSince: null,
    });
  }

  /**
   * 交卷后调用;返回"该单是否收到过 ≥1 版卡"(决定 xdt_card_id 注入)。
   * 条目保留 GRACE_MS 供晚到版,之后由懒清扫回收。
   */
  finalizeCall(callId: string): boolean {
    const entry = this.calls.get(callId);
    if (!entry) return false;
    entry.settledAt = this.now();
    return entry.hasCard;
  }

  /** 该单当前是否已有卡(finalize 前后皆可查)。 */
  hasCard(callId: string): boolean {
    return this.calls.get(callId)?.hasCard ?? false;
  }

  /**
   * 内存归属查询(in-flight + 宽限窗内):callId → ghostId,查无 null。
   * 交互卡 card-action 派发用它快查;窗口外(settle 久 / 重启后)由持久卡库
   * 兜底(cardStoreDb.getGhostCard)。 */
  ownerOf(callId: string): string | null {
    return this.calls.get(callId)?.ghostId ?? null;
  }

  /**
   * 内存条目全息查询(card-action 派发用):除归属外带出 sessionId——
   * 铸衍生卡位(spawnCallId)登记时要续上会话归属,历史回放才能按会话
   * 捞回衍生卡。查无 null(由持久卡库兜底)。fs 槽 workdir 档也经它反查
   * (含 scriptWorkdir——脚本通道的落盘根)。
   */
  callInfoOf(callId: string): { ghostId: string; sessionId: string | null; scriptWorkdir: string | null } | null {
    const e = this.calls.get(callId);
    return e ? { ghostId: e.ghostId, sessionId: e.sessionId, scriptWorkdir: e.scriptWorkdir } : null;
  }

  /**
   * 严格在途查询(workspace 槽的上下文凭证、fs 槽脚本通道的写盘授权用):
   * 仅当该单已登记、未交卷(settledAt 为 null)且非重开态时返回归属。
   * 宽限窗/重开窗/working 窗都是卡片供片语义,不能让 callId 在工具调用
   * 结束后继续充当"目录授权上下文"——否则插件记住一个旧 callId 就能跨
   * 调用复用当时会话的 workdir 自动放行。
   */
  inFlightCallInfoOf(callId: string): { ghostId: string; sessionId: string | null; scriptWorkdir: string | null; scriptWritePath: string | null; channel: 'session' | 'script' } | null {
    const e = this.calls.get(callId);
    if (!e || e.settledAt !== null || e.reopenedAt !== null) return null;
    return { ghostId: e.ghostId, sessionId: e.sessionId, scriptWorkdir: e.scriptWorkdir, scriptWritePath: e.scriptWritePath, channel: e.channel };
  }

  /**
   * 交互卡按钮被点后重开卡片更新窗口(card-action 派发前调,由 dispatcher 接线)。
   * 让意识在卡片结算很久后 / 重启后仍能 card-update 换新卡:
   * - 条目还在(内存命中):归 in-flight(settledAt=null),盖上重开时刻;
   * - 条目已被清扫(settle 久 / 重启):按持久卡库查到的归属重建条目
   *   (sessionId 用持久值,续上历史会话归属,避免换卡把 sessionId 覆盖成 null)。
   * 窗内 card-update 自由通过,窗外由懒清扫按 GHOST_CARD_REOPEN_WINDOW_MS 回收。
   */
  reopenForAction(callId: string, info: { ghostId: string; sessionId: string | null }): void {
    this.sweep();
    const now = this.now();
    const existing = this.calls.get(callId);
    if (existing) {
      existing.settledAt = null;
      existing.reopenedAt = now;
      return;
    }
    this.calls.set(callId, {
      ghostId: info.ghostId,
      toolUseId: null,
      sessionId: info.sessionId,
      // 交互卡重开只发生在会话通道(脚本通道条目拒供片,无卡可点)。
      channel: 'session',
      scriptWorkdir: null,
      scriptWritePath: null,
      hasCard: true,
      lastAcceptedAt: null,
      settledAt: null,
      reopenedAt: now,
      workingSince: null,
    });
  }

  /**
   * 管子 card-update 分支主体。senderGhostId 由主机按 webContents 反查,
   * 不信自报。返回值仅供日志/测试;IPC 层对沙箱恒回 { ok: true }。
   */
  handleCardUpdate(
    senderGhostId: string,
    payload: unknown,
  ): { accepted: boolean; reason?: string } {
    this.sweep();
    const reject = (reason: string, meta?: Record<string, unknown>) => {
      this.deps.log?.warn(`ghost card-update rejected: ${reason}`, {
        senderGhostId,
        ...meta,
      });
      return { accepted: false, reason };
    };

    if (typeof payload !== 'object' || payload === null) return reject('bad-shape');
    const p = payload as Record<string, unknown>;
    if (p.type !== 'card-update') return reject('bad-shape');
    if (typeof p.callId !== 'string' || p.callId.length === 0 || p.callId.length > 128) {
      return reject('bad-call-id');
    }
    if (typeof p.html !== 'string') return reject('bad-html');
    // v 是意识声明的卡片形态:1=海报(默认省略),2=交互卡(带 data-ghost-action 按钮)。
    // 渲染/净化对 v1/v2 无差别处理(放行按钮的闸是净化器不是 v),v 仅作意图声明 + 落库遥测。
    if (p.v !== undefined && p.v !== 1 && p.v !== 2) return reject('bad-version');
    const cardVersion = p.v === 2 ? 2 : 1;
    // state 是后台活动声明(card-action 干活场景):working/done,缺省 null。
    if (p.state !== undefined && p.state !== 'working' && p.state !== 'done') {
      return reject('bad-state');
    }
    const activityState = p.state === 'working' || p.state === 'done' ? p.state : null;

    const entry = this.calls.get(p.callId);
    if (!entry) return reject('unknown-call', { callId: p.callId });
    if (entry.ghostId !== senderGhostId) {
      // 拿着别人的单号供片:归属验身失败(与 pipeDispatcher"不是你的卷子"同款)。
      return reject('not-owner', { callId: p.callId, owner: entry.ghostId });
    }
    // 脚本通道(broker 直调,无会话)条目:sessionId/toolUseId 均无锚,broadcast
    // 出去是孤儿卡——供片语义不成立,直接拒(fs 落盘反查不受影响)。判据用显式
    // channel 字段:workingDir 空白(scriptWorkdir null)的脚本条目同样拒。
    if (entry.channel === 'script') return reject('script-call-no-card', { callId: p.callId });
    if (!this.deps.hasCardSlot(senderGhostId)) return reject('no-card-slot');

    const now = this.now();
    // working 跨调用窗口内豁免 too-late(生成类流程:提交调用的卡位由后续
    // 轮询调用持续刷进度);窗口自首个 working 版本起固定封顶,不滑动。
    if (
      !this.isWorkingActive(entry, now) &&
      entry.settledAt !== null &&
      now - entry.settledAt > GRACE_MS
    ) {
      return reject('too-late', { callId: p.callId });
    }
    if (
      entry.lastAcceptedAt !== null &&
      now - entry.lastAcceptedAt < GHOST_CARD_MIN_INTERVAL_MS
    ) {
      // 限速静默丢(首版免罚):意识狂刷不惊动 UI,也不给它节奏反馈。
      return reject('rate-limited', { callId: p.callId });
    }

    const heightRaw = typeof p.height === 'number' && Number.isFinite(p.height)
      ? Math.round(p.height)
      : GHOST_CARD_HEIGHT_DEFAULT;
    const height = Math.min(GHOST_CARD_HEIGHT_MAX, Math.max(GHOST_CARD_HEIGHT_MIN, heightRaw));

    const sanitized = this.deps.sanitize(p.html);
    if (!sanitized.ok) return reject(`sanitize:${sanitized.reason}`, { callId: p.callId });

    entry.hasCard = true;
    entry.lastAcceptedAt = now;
    // working 窗口记账:首个 working 开窗(固定起点),done 关窗(回到
    // settle 宽限语义,后续更新按旧规则判 too-late)。
    if (activityState === 'working') {
      if (entry.workingSince === null) entry.workingSince = now;
    } else if (activityState === 'done') {
      entry.workingSince = null;
    }

    const row: GhostCardRow = {
      callId: p.callId,
      ghostId: senderGhostId,
      sessionId: entry.sessionId,
      html: sanitized.html,
      height,
      v: cardVersion,
      updatedAt: now,
    };
    // 落库失败不阻断推送:活卡先见,历史回放缺卡由 renderer missing 降级兜底。
    void this.deps.persist(row).catch((err) => {
      this.deps.log?.warn('ghost card persist failed', {
        callId: p.callId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    this.deps.broadcast({
      callId: p.callId,
      ghostId: senderGhostId,
      toolUseId: entry.toolUseId,
      html: sanitized.html,
      animatedHtml: sanitized.animatedHtml ?? null,
      height,
      state: activityState,
    });
    // 会话呼吸链路:重开态(card-action 后台干活)或显式声明了 state 的供片
    // 上报——未声明 state 的普通 tool-call 供片不报(会话本就有真实 turn
    // 运行态,重复上报只添乱)。
    if (entry.reopenedAt !== null || activityState !== null) {
      this.deps.onActivity?.({
        callId: p.callId,
        ghostId: senderGhostId,
        sessionId: entry.sessionId,
        state: activityState,
      });
    }
    this.deps.log?.debug('ghost card accepted', { callId: p.callId, height });
    return { accepted: true };
  }
}
