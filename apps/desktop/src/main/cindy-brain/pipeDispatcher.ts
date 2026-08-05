/**
 * pipeDispatcher.ts — 管子(脑机接口)工具调用派发器。
 * ---------------------------------------------------------------------------
 * 管子派发契约:agent 经 ghost 总机(cindy-tools)拨号 →
 * 本派发器把活顺管子送进目标意识的电子脑,等交卷(callId 配对),
 * 把结果/结构化失败原样交回总机。
 *
 * 职责边界:
 *   - 资格审(装没装 / 醒没醒 / 有没有这个工具 / 熔断没)→ 结构化错误码;
 *   - 按需拉起沙箱(spawn 幂等);
 *   - callId 配对 + 超时掐断(过期卷子作废丢弃);
 *   - 长任务续命:主机代办在途 hold(cindySlot 接线)与插件 tool-progress
 *     心跳都能把超时窗口续到 GHOST_PIPE_CALL_MAX_TOTAL_MS 天花板内;
 *   - 交卷验身:pending 记录派给了谁,别的意识交不了这份卷(不信自报之外
 *     的第二道:连"替别人交卷"的通道都没有);
 *   - 崩溃/熄灯时把在途调用全部按 GHOST_CRASHED/GHOST_ASLEEP 收掉。
 *
 * 全部依赖注入(规则 14),单测用假 deps + 假时钟直测。
 */

import { randomUUID } from 'node:crypto';

import type {
  GhostPipeToolCall,
  GhostToolCallResult,
  InstalledGhost,
} from '../../shared/ghost.js';
import { GHOST_PIPE_CALL_MAX_TOTAL_MS, isGhostPluginErrorCode } from '../../shared/ghost.js';
import type { GhostRuntimeState } from './runtime/GhostRuntime.js';

export interface PipeDispatcherDeps {
  /** 按 id 取已装意识(未装 → null)。 */
  getGhost(id: string): InstalledGhost | null;
  /** 当前运行时状态。 */
  runtimeStateOf(id: string): GhostRuntimeState;
  /** 拉起沙箱(幂等;fused/stopping 拒绝)。 */
  spawn(ghost: InstalledGhost): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 把下行消息发到该意识的电子脑逻辑页;false = 逻辑页不在线。 */
  sendToGhost(ghostId: string, payload: GhostPipeToolCall): boolean;
  /** 单次调用超时(默认 330s,见 DEFAULT_TIMEOUT_MS 注释)。 */
  timeoutMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

interface PendingCall {
  ghostId: string;
  tool: string;
  resolve: (result: GhostToolCallResult) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** 派发时刻(续命天花板从这里起算)。 */
  startedAt: number;
  /** 当前生效的超时时刻(hold / 心跳只延不缩,release 才收)。 */
  deadlineAt: number;
  /** 在途代办 hold 计数(同一卷可并发多单代办,全部收工才收窗)。 */
  holds: number;
}

/**
 * 单次工具调用超时。必须 ≥ network 槽重载荷的 fetch 上限
 * (GHOST_FETCH_MEDIA_TIMEOUT_MAX_MS = 300s,媒体取件/上传/目录上传共用)
 * + 余量——否则意识合法地等一单大上传时,管子先到点向 agent 报 TIMEOUT,
 * 而上传仍在后台继续并可能成功,用户被误导重试造成二次全量上传
 * (2026-07-13 xd-pages 部署迁移时定为 330s;原 180s)。
 * 分钟级以上的长任务不再靠调大本值硬扛:主机代办在途自动续命、插件可发
 * tool-progress 心跳续命,天花板见 GHOST_PIPE_CALL_MAX_TOTAL_MS。
 */
const DEFAULT_TIMEOUT_MS = 330_000;

/** 代办收工(release)后留给意识做后处理与交卷的余量窗口。 */
const HOLD_SETTLE_GRACE_MS = 60_000;

export class GhostPipeDispatcher {
  private readonly pending = new Map<string, PendingCall>();

  constructor(private readonly deps: PipeDispatcherDeps) {}

  /** 在途调用数(诊断/测试用)。 */
  pendingCount(): number {
    return this.pending.size;
  }

  /**
   * 派活主入口(ghost 总机的 callGhostTool 回调)。
   * 永不 reject——一切失败都折叠成结构化 GhostToolCallResult。
   */
  async callGhostTool(request: {
    ghostId: string;
    tool: string;
    args: Record<string, unknown>;
    /**
     * 预铸配对号(卡槽③:调用方需先向 cardService.registerCall 登记同一
     * callId,故由它铸好传入;缺省自铸,老调用方零改动)。
     */
    callId?: string;
  }): Promise<GhostToolCallResult> {
    const { ghostId, tool, args } = request;

    // ── 资格审 ─────────────────────────────────────────────────────────
    const ghost = this.deps.getGhost(ghostId);
    if (!ghost) {
      return { ok: false, errorCode: 'GHOST_NOT_FOUND', message: `插件 ${ghostId} 未安装或已卸载` };
    }
    if (!ghost.enabled) {
      return { ok: false, errorCode: 'GHOST_ASLEEP', message: `插件 ${ghostId} 未启用(可在主界面侧边栏「插件」中启用)` };
    }
    const declared = ghost.manifest.tools?.some((t) => t.name === tool);
    if (!declared) {
      return { ok: false, errorCode: 'TOOL_NOT_FOUND', message: `插件 ${ghostId} 没有工具 ${tool}` };
    }
    if (this.deps.runtimeStateOf(ghostId) === 'fused') {
      return { ok: false, errorCode: 'GHOST_CRASHED', message: `插件 ${ghostId} 已熔断(反复崩溃),重载或重新启用后再试` };
    }

    // ── 按需拉起 ────────────────────────────────────────────────────────
    if (this.deps.runtimeStateOf(ghostId) !== 'running') {
      const spawned = await this.deps.spawn(ghost);
      if (!spawned.ok) {
        return { ok: false, errorCode: 'GHOST_CRASHED', message: `插件启动失败:${spawned.reason}` };
      }
    }

    // ── 派发 + 配对等待 ────────────────────────────────────────────────
    const callId = request.callId && request.callId.length > 0 ? request.callId : randomUUID();
    const payload: GhostPipeToolCall = { type: 'tool-call', callId, tool, args };

    return new Promise<GhostToolCallResult>((resolve) => {
      const startedAt = Date.now();
      const entry: PendingCall = {
        ghostId,
        tool,
        resolve,
        timer: undefined,
        startedAt,
        deadlineAt: startedAt + this.baseTimeoutMs(),
        holds: 0,
      };
      this.pending.set(callId, entry);
      this.armTimer(callId, entry);

      if (!this.deps.sendToGhost(ghostId, payload)) {
        // 逻辑页不在线(拉起后瞬时死亡等):立即收卷。
        this.settle(callId, { ok: false, errorCode: 'GHOST_CRASHED', message: '电子脑离线,派发失败' });
      }
    });
  }

  /** 基础超时档(注入值钳到天花板内,保证初始 deadline 不越过绝对上限)。 */
  private baseTimeoutMs(): number {
    return Math.min(this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, GHOST_PIPE_CALL_MAX_TOTAL_MS);
  }

  /** 按 entry.deadlineAt 重挂超时闹钟(旧闹钟一并清掉)。 */
  private armTimer(callId: string, entry: PendingCall): void {
    (this.deps.clearTimeoutFn ?? clearTimeout)(entry.timer);
    const setT = this.deps.setTimeoutFn ?? setTimeout;
    entry.timer = setT(() => {
      if (this.pending.delete(callId)) {
        this.deps.log?.warn('ghost tool call timed out', {
          ghostId: entry.ghostId,
          tool: entry.tool,
          callId,
          totalMs: Date.now() - entry.startedAt,
        });
        entry.resolve({
          ok: false,
          errorCode: 'TIMEOUT',
          message: `工具 ${entry.tool} 执行超时(任务可能仍在后台继续,稍后重试或许能直接取回已完成的结果)`,
        });
      }
    }, Math.max(0, entry.deadlineAt - Date.now()));
  }

  /**
   * 把在途卷的超时时刻至少延到 targetAt:只延不缩,且不超过派发起算的
   * GHOST_PIPE_CALL_MAX_TOTAL_MS 天花板(到顶后不再续,卷到点照常作废)。
   */
  private extendDeadline(callId: string, entry: PendingCall, targetAt: number): void {
    const cap = entry.startedAt + GHOST_PIPE_CALL_MAX_TOTAL_MS;
    const next = Math.min(Math.max(targetAt, entry.deadlineAt), cap);
    // <=:双保险守住"只延不缩"——即使 deadline 因注入值异常已在 cap 之上,
    // 也绝不反向收短(baseTimeoutMs 的钳制让这理论上不会发生)。
    if (next <= entry.deadlineAt) return;
    entry.deadlineAt = next;
    this.armTimer(callId, entry);
  }

  /**
   * 代办 hold:主机自己正为该卷干活(cindy 槽署名代办)时替它续命。
   * ghostId = 主机反查的代办发起方身份——与交卷/心跳同纪律配对校验,
   * 沙箱填错/冒用别人在途的 callId 不能续命他人的卷、也不污染其计数。
   * budgetMs = 这单代办自身的预算(如视频 expected×3);窗口延到
   * now + budget + 交卷余量。查无此卷/不是它的卷,静默忽略。
   *
   * 已知边界:callId 归因是插件自报的(记账同契约),同一意识自己的两个
   * 并发调用互填 callId 主机无从分辨(沙箱内部并发,主机没有"正在处理哪
   * 份卷"的会话状态)。错配只伤它自己:错署名的调用不获续命照常超时,
   * 被错挂的调用最多被延长;release 收窗下限是基础窗口(见 releaseCall),
   * 不会把任何卷收到无续命机制时的行为之下。
   */
  holdCall(ghostId: string, callId: string, budgetMs: number): void {
    const entry = this.pending.get(callId);
    if (!entry || entry.ghostId !== ghostId) return;
    entry.holds += 1;
    this.extendDeadline(callId, entry, Date.now() + budgetMs + HOLD_SETTLE_GRACE_MS);
  }

  /**
   * 代办收工:hold 计数归零时把窗口收回(不短于插件本来的基础窗口,并留
   * 交卷余量)——不让 16 分钟的 hold 在任务 3 分钟完成后继续吊着失败面。
   * 验身同 holdCall(冒名 release 不能提前收短别人的窗口)。
   */
  releaseCall(ghostId: string, callId: string): void {
    const entry = this.pending.get(callId);
    if (!entry || entry.ghostId !== ghostId) return;
    entry.holds = Math.max(0, entry.holds - 1);
    if (entry.holds > 0) return;
    const target = Math.max(entry.startedAt + this.baseTimeoutMs(), Date.now() + HOLD_SETTLE_GRACE_MS);
    if (target < entry.deadlineAt) {
      entry.deadlineAt = target;
      this.armTimer(callId, entry);
    }
  }

  /**
   * 心跳续命(ghost-pipe:send 的 tool-progress 分支)。验身同交卷:callId
   * 不是派给你的即拒(拒因只进日志,不给沙箱探测面)。每次心跳把窗口
   * 重新续满一个基础档;天花板由 extendDeadline 统一钳制。
   */
  handleToolProgress(senderGhostId: string, payload: unknown): { accepted: boolean; reason?: string } {
    const p = payload as { callId?: unknown };
    if (typeof p?.callId !== 'string') {
      return { accepted: false, reason: 'tool-progress 载荷形状不合法' };
    }
    const entry = this.pending.get(p.callId);
    if (!entry) {
      return { accepted: false, reason: '卷子不存在或已过期' };
    }
    if (entry.ghostId !== senderGhostId) {
      return { accepted: false, reason: '不是你的卷子' };
    }
    this.extendDeadline(p.callId, entry, Date.now() + this.baseTimeoutMs());
    return { accepted: true };
  }

  /**
   * 交卷(ghost-pipe:send 的 tool-result 分支)。
   * senderGhostId 来自主机按 webContents 反查的身份——callId 配对之外再验
   * "这份卷子当初是不是派给你的",别的意识拿到 callId 也交不了。
   */
  handleToolResult(senderGhostId: string, payload: unknown): { accepted: boolean; reason?: string } {
    const p = payload as {
      callId?: unknown;
      ok?: unknown;
      result?: unknown;
      errorCode?: unknown;
      message?: unknown;
    };
    if (typeof p?.callId !== 'string' || typeof p?.ok !== 'boolean') {
      return { accepted: false, reason: 'tool-result 载荷形状不合法' };
    }
    const entry = this.pending.get(p.callId);
    if (!entry) {
      // 超时作废/重复交卷:丢弃即可,不给沙箱探测在途表的机会。
      return { accepted: false, reason: '卷子不存在或已过期' };
    }
    if (entry.ghostId !== senderGhostId) {
      this.deps.log?.warn('ghost tool result identity mismatch', {
        callId: p.callId,
        expected: entry.ghostId,
        actual: senderGhostId,
      });
      return { accepted: false, reason: '不是你的卷子' };
    }
    const result: GhostToolCallResult = p.ok
      ? { ok: true, result: p.result ?? null }
      : {
          ok: false,
          errorCode: isGhostPluginErrorCode(p.errorCode) ? p.errorCode : 'INTERNAL',
          message: typeof p.message === 'string' ? p.message : '插件执行失败',
        };
    this.settle(p.callId, result);
    return { accepted: true };
  }

  /**
   * 运行时状态钩子:意识崩溃/熔断/熄灯时,把它名下全部在途调用收掉
   * (brain/index.ts 在 onStateChanged 里接线)。
   */
  onRuntimeState(ghostId: string, state: GhostRuntimeState): void {
    if (state === 'running' || state === 'starting') return;
    const isCrash = state === 'crashed' || state === 'fused';
    for (const [callId, entry] of [...this.pending]) {
      if (entry.ghostId !== ghostId) continue;
      this.settle(
        callId,
        isCrash
          ? { ok: false, errorCode: 'GHOST_CRASHED', message: '插件执行中崩溃' }
          : { ok: false, errorCode: 'GHOST_ASLEEP', message: '插件执行中被停用' },
      );
    }
  }

  private settle(callId: string, result: GhostToolCallResult): void {
    const entry = this.pending.get(callId);
    if (!entry) return;
    this.pending.delete(callId);
    (this.deps.clearTimeoutFn ?? clearTimeout)(entry.timer);
    entry.resolve(result);
  }
}
