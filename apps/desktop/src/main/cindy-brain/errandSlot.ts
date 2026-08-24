/**
 * errandSlot — agent 槽「派活取件(errand)」的主机守门层(2026-07-31 开闸)。
 *
 * 与 agentSlot(把回合发进用户会话,结果给用户看)相对:errand 把任务交给
 * 插件**专属 errand 会话**里的 agent 跑一轮,把最终回复文字取回给插件。
 *
 * 安全边界(全部由本层与注入 runner 的主机代码强制,prompt 不构成边界):
 * - 插件必须声明 `agent` 槽 + `agent.errand: true`(装入确认高风险单列);
 * - 任务文本只进普通 user 消息,绝不进 system prompt;
 * - errand 会话的 agent/模型/权限档/工作目录由用户配置(runner 侧解析;
 *   权限档默认 plan 只读,协议层就没有 bypassPermissions)。唯一例外:
 *   用户没配工作目录时,插件可在请求里**转述**一个目录,runner 只认
 *   pick 台账里用户亲手选过的(pickGrantsStore),台账没有即明拒;
 * - 每插件同时最多 1 单在途 + 相邻提交最小间隔(防刷);
 * - 任务表在内存:主进程重启即丢,query 对丢失单统一回「查无此任务」,
 *   插件按可重新提交处理(与 cindy 槽异步代办同语义)。
 *
 * 真正的会话创建/投递/收口经 runner 注入(maker-ipc 侧实现),本模块不
 * 反向依赖 maker-ipc,规则可单测(规则 14)。
 */

import { randomUUID } from 'node:crypto';

import {
  GHOST_ERRAND_JOB_TTL_MS,
  GHOST_ERRAND_MAX_CONTEXT_JSON_CHARS,
  GHOST_ERRAND_MAX_RESULT_CHARS,
  GHOST_ERRAND_MAX_TASK_CHARS,
  GHOST_ERRAND_MIN_INTERVAL_MS,
  GHOST_ERRAND_SESSION_KEY_RE,
  GHOST_PIPE_CALL_MAX_TOTAL_MS,
  type GhostAgentErrandErrorCode,
  type GhostPipeAgentErrandResult,
  type InstalledGhost,
} from '../../shared/ghost.js';

/** 归因号长度上限(与 cindySlot 同口径)。 */
const MAX_CALL_ID_LEN = 128;
/** 任务号长度上限(主机铸 UUID 量级)。 */
const MAX_JOB_ID_LEN = 64;
/** 每插件完成态任务记录保留上限(同 cindySlot 的第二道闸)。 */
const MAX_SETTLED_JOBS_PER_GHOST = 16;

/** 派活来源：面板/卡片点击 vs MCP/调度器静默回合。由主机归因，插件不能自报。 */
export type GhostErrandOrigin = 'user-action' | 'background';

export interface GhostErrandRunRequest {
  ghostId: string;
  ghostVersion: string;
  /** 主机归因的来源；切任务只认 user-action。 */
  origin: GhostErrandOrigin;
  /** 已组装的最终任务消息(task + 结构化上下文;本层组装,runner 原样投递)。 */
  message: string;
  /** 首次创建对应 errand 会话时的标题提示。 */
  title?: string;
  /**
   * 分会话钥匙(形状已由本层按 GHOST_ERRAND_SESSION_KEY_RE 校验)。缺省 =
   * 插件共用一间;传了 = 同钥匙同间、异钥匙各间(映射按 ghostId+key 存取)。
   */
  sessionKey?: string;
  /**
   * 插件转述的期望工作目录(仅形状校验;是否真是用户亲选目录由 runner
   * 对 pick 台账把关——授权对账需要归一化,归一化实现在 runner 侧)。
   */
  workingDir?: string;
}

export interface GhostErrandRunHooks {
  /** errand 会话 id 一旦确定即回报(异步单据此让 query 尽早可见 sessionId)。 */
  onSession?(sessionId: string): void;
  /** 忙检通过且消息已投进会话后再回报；切任务只认这一下。 */
  onDispatched?(sessionId: string): void;
}

export type GhostErrandRunOutcome =
  | { ok: true; sessionId: string; text: string; agentKind?: string; model?: string }
  | {
      ok: false;
      errorCode:
        | 'HOST_NOT_READY'
        | 'BUSY'
        | 'SESSION_UNAVAILABLE'
        | 'TURN_FAILED'
        | 'TIMEOUT'
        | 'INTERNAL'
        /** 目前仅一种来源:转述的 workingDir 不在用户亲选台账里。 */
        | 'INVALID_REQUEST';
      message: string;
    };

export type GhostErrandRunner = (
  request: GhostErrandRunRequest,
  hooks?: GhostErrandRunHooks,
) => Promise<GhostErrandRunOutcome>;

export interface GhostErrandSlotDeps {
  getGhost(id: string): InstalledGhost | null;
  runner?: GhostErrandRunner | null;
  /** 管子续命挂钩(同 cindySlot 契约;wait 模式的署名单在途期间续命)。 */
  holdPipeCall?(ghostId: string, callId: string, budgetMs: number): void;
  releasePipeCall?(ghostId: string, callId: string): void;
  now?: () => number;
  createJobId?: () => string;
  /** 消费卡片点击票（与 agent.run 同一套 Host 铸造票，一次作废）。 */
  consumeUserActionToken?(token: string, ghostId: string): boolean;
  log?: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  /**
   * 派活落到专属可见任务时，由主机把左侧切过去。
   * 签字门「执行」走这条：插件自己开一间 errand 会话干活。
   */
  onRevealSession?: (sessionId: string) => void;
}

/** 在途/完成的派活任务记录(内存表;语义同 cindySlot 的 CindyAsyncJob)。 */
interface ErrandJob {
  ghostId: string;
  startedAt: number;
  status: 'running' | 'done' | 'failed';
  /** runner 一旦确定 errand 会话即回填(running 期即可见)。 */
  sessionId?: string;
  /** 本单已经切过左侧，onSession + 收口只切一次。 */
  revealed?: boolean;
  /** 主机归因：只有 user-action 才切任务。 */
  origin: GhostErrandOrigin;
  result?: { sessionId: string; text: string; agentKind?: string; model?: string };
  errorCode?: GhostAgentErrandErrorCode;
  error?: string;
  doneAt?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(
  errorCode: GhostAgentErrandErrorCode,
  message: string,
): GhostPipeAgentErrandResult {
  return { ok: false, errorCode, message };
}

/** 结果截断(超长从头保留,尾部带明示标记——静默截断会让插件误判拿到了全文)。 */
export function clampErrandResultText(text: string): string {
  if (text.length <= GHOST_ERRAND_MAX_RESULT_CHARS) return text;
  return `${text.slice(0, GHOST_ERRAND_MAX_RESULT_CHARS)}\n…[结果超长,已截断]`;
}

/** 面板点击到派活必须紧挨着；订阅/定时器不能吃到几分钟前的一次乱点。 */
const USER_GESTURE_TTL_MS = 3_000;

export class GhostErrandSlot {
  private readonly jobs = new Map<string, ErrandJob>();
  private readonly inFlightGhosts = new Set<string>();
  private readonly lastRunAt = new Map<string, number>();
  /** ghostId → 主机观察到的当次点击过期时刻。 */
  private readonly userGestures = new Map<string, number>();
  private runner: GhostErrandRunner | null;
  private onRevealSession: ((sessionId: string) => void) | null;

  constructor(private readonly deps: GhostErrandSlotDeps) {
    this.runner = deps.runner ?? null;
    this.onRevealSession = deps.onRevealSession ?? null;
  }

  /** maker-ipc 初始化完成后注入真实 runner;传 null 用于退出清理。 */
  setRunner(runner: GhostErrandRunner | null): void {
    this.runner = runner;
  }

  /** maker-ipc 初始化完成后注入任务聚焦；传 null 用于退出清理。 */
  setRevealSession(reveal: ((sessionId: string) => void) | null): void {
    this.onRevealSession = reveal;
  }

  /** clearGhost 只删 jobs，不删 inFlightGhosts；收口前两者可能短暂不一致。 */
  hasActiveErrandFor(ghostId: string): boolean {
    return this.inFlightGhosts.has(ghostId) || [...this.jobs.values()].some(
      (job) => job.ghostId === ghostId && job.status === 'running',
    );
  }

  /** 宿主确认的真实点击（卡片按钮 / 面板 mouseDown / keyDown）。 */
  noteUserGesture(ghostId: string): void {
    this.sweepUserGestures();
    this.userGestures.set(ghostId, this.now() + USER_GESTURE_TTL_MS);
  }

  /** 插件停用/卸载时清除节流状态与任务记录,防止权限/信息残留。 */
  clearGhost(ghostId: string): void {
    this.lastRunAt.delete(ghostId);
    this.userGestures.delete(ghostId);
    for (const [jobId, job] of [...this.jobs]) {
      if (job.ghostId === ghostId) this.jobs.delete(jobId);
    }
  }

  /** 处理一条 agent-errand-request;所有失败折叠成结构化返回,永不 reject。 */
  async handleRequest(ghostId: string, payload: unknown): Promise<GhostPipeAgentErrandResult> {
    this.sweepJobs();
    const ghost = this.deps.getGhost(ghostId);
    if (!ghost?.enabled || !ghost.manifest.slots.includes('agent') || ghost.manifest.agent?.errand !== true) {
      return fail('PERMISSION_DENIED', '插件未申请「派活取件」权限(身份卡 agent.errand),或当前未启用');
    }
    if (!isPlainObject(payload) || payload.type !== 'agent-errand-request') {
      return fail('INVALID_REQUEST', 'agent-errand-request 载荷必须是对象');
    }
    if (payload.kind === 'query') {
      return this.handleQuery(ghostId, payload);
    }
    if (payload.kind !== 'run') {
      return fail('INVALID_REQUEST', "kind 必须是 'run' 或 'query'");
    }

    if (
      typeof payload.task !== 'string' ||
      payload.task.trim().length === 0 ||
      payload.task.length > GHOST_ERRAND_MAX_TASK_CHARS
    ) {
      return fail('INVALID_REQUEST', `task 必须是 1–${GHOST_ERRAND_MAX_TASK_CHARS} 字符的非空字符串`);
    }
    if (
      payload.title !== undefined &&
      (typeof payload.title !== 'string' || payload.title.trim().length === 0 || payload.title.length > 100)
    ) {
      return fail('INVALID_REQUEST', 'title 必须是 1–100 字符的字符串');
    }
    if (payload.mode !== undefined && payload.mode !== 'wait') {
      return fail('INVALID_REQUEST', "mode 只支持 'wait'(同步等待)或不传(异步受理 + query 轮询)");
    }
    if (
      payload.sessionKey !== undefined &&
      (typeof payload.sessionKey !== 'string' || !GHOST_ERRAND_SESSION_KEY_RE.test(payload.sessionKey))
    ) {
      return fail(
        'INVALID_REQUEST',
        'sessionKey 只能是 1–64 位的字母/数字/./_/-(不传 = 插件共用一间 errand 会话)',
      );
    }
    if (
      payload.workingDir !== undefined &&
      (typeof payload.workingDir !== 'string' ||
        payload.workingDir.trim().length === 0 ||
        payload.workingDir.length > 1024)
    ) {
      return fail('INVALID_REQUEST', 'workingDir 必须是 1–1024 字符的绝对路径字符串,或不传');
    }
    if (
      payload.callId !== undefined &&
      (typeof payload.callId !== 'string' || payload.callId.length === 0 || payload.callId.length > MAX_CALL_ID_LEN)
    ) {
      return fail('INVALID_REQUEST', 'callId 不合法(1–128 字符的字符串,或不传)');
    }
    const callId = (payload.callId as string | undefined) ?? 'unattributed';
    if (
      payload.userActionToken !== undefined &&
      (typeof payload.userActionToken !== 'string' ||
        payload.userActionToken.length === 0 ||
        payload.userActionToken.length > MAX_CALL_ID_LEN)
    ) {
      return fail('INVALID_REQUEST', 'userActionToken 不合法');
    }
    const userActionToken =
      typeof payload.userActionToken === 'string' ? payload.userActionToken : undefined;

    // 结构化上下文:JSON 化由主机做(确定性代码),超限明拒。
    let contextJson: string | null = null;
    if (payload.context !== undefined) {
      try {
        contextJson = JSON.stringify(payload.context);
      } catch {
        return fail('INVALID_REQUEST', 'context 必须可以转换成 JSON');
      }
      if (contextJson.length > GHOST_ERRAND_MAX_CONTEXT_JSON_CHARS) {
        return fail('INVALID_REQUEST', `context 转成 JSON 后不能超过 ${GHOST_ERRAND_MAX_CONTEXT_JSON_CHARS} 字符`);
      }
    }

    // 频控两道:相邻提交最小间隔 + 每插件单在途。间隔在一切校验通过后才
    // 记账(runner 失败也不退,防重试放大,与 agentSlot 票据同纪律)。
    const now = this.now();
    const last = this.lastRunAt.get(ghostId) ?? 0;
    if (now - last < GHOST_ERRAND_MIN_INTERVAL_MS) {
      return fail('RATE_LIMITED', '派活太频繁,请稍后再试');
    }
    if (this.inFlightGhosts.has(ghostId)) {
      return fail('BUSY', '这个插件已有一单派活在途,先取回或等它完成');
    }
    if (!this.runner) {
      return fail('HOST_NOT_READY', '派活服务尚未准备好');
    }

    this.lastRunAt.set(ghostId, now);
    this.evictSettledJobs(ghostId);
    const jobId = (this.deps.createJobId ?? randomUUID)();
    const origin = this.resolveOrigin(ghostId, userActionToken);
    const job: ErrandJob = { ghostId, startedAt: now, status: 'running', origin };
    this.jobs.set(jobId, job);
    this.inFlightGhosts.add(ghostId);

    // 任务消息组装是确定性代码:上下文以固定标记附尾,格式契约写进手册。
    const message =
      contextJson !== null
        ? `${payload.task}\n\n[结构化上下文 JSON]\n${contextJson}`
        : (payload.task as string);

    this.deps.log?.info('ghost errand run start', {
      ghostId,
      jobId,
      callId,
      origin,
      mode: payload.mode === 'wait' ? 'wait' : 'submit',
    });

    const execute = async (): Promise<void> => {
      try {
        const outcome = await this.runner!(
          {
            ghostId,
            ghostVersion: ghost.manifest.version,
            origin,
            message,
            ...(typeof payload.title === 'string' ? { title: payload.title.trim() } : {}),
            ...(typeof payload.workingDir === 'string' ? { workingDir: payload.workingDir } : {}),
            ...(typeof payload.sessionKey === 'string' ? { sessionKey: payload.sessionKey } : {}),
          },
          {
            onSession: (sessionId) => {
              job.sessionId = sessionId;
            },
            onDispatched: (sessionId) => {
              job.sessionId = sessionId;
              this.revealSessionOnce(job, sessionId);
            },
          },
        );
        if (outcome.ok) {
          job.status = 'done';
          job.sessionId = outcome.sessionId;
          this.revealSessionOnce(job, outcome.sessionId);
          job.result = {
            sessionId: outcome.sessionId,
            text: clampErrandResultText(outcome.text),
            ...(outcome.agentKind !== undefined ? { agentKind: outcome.agentKind } : {}),
            ...(outcome.model !== undefined ? { model: outcome.model } : {}),
          };
        } else {
          job.status = 'failed';
          job.errorCode = outcome.errorCode;
          job.error = outcome.message;
        }
      } catch (err) {
        job.status = 'failed';
        job.errorCode = 'INTERNAL';
        job.error = err instanceof Error ? err.message : String(err);
      } finally {
        job.doneAt = this.now();
        this.inFlightGhosts.delete(ghostId);
        if (job.status === 'failed') {
          this.deps.log?.warn('ghost errand run failed', {
            ghostId,
            jobId,
            errorCode: job.errorCode,
            error: job.error,
          });
        } else {
          this.deps.log?.info('ghost errand run done', {
            ghostId,
            jobId,
            sessionId: job.sessionId,
            chars: job.result?.text.length ?? 0,
          });
        }
      }
    };

    if (payload.mode === 'wait') {
      // 同步等待:署名单在途期间替管子那头的 tool-call 续命(预算直接给到
      // 天花板,extendDeadline 会按 GHOST_PIPE_CALL_MAX_TOTAL_MS 钳制)。
      const shouldHold = callId !== 'unattributed';
      if (shouldHold) this.deps.holdPipeCall?.(ghostId, callId, GHOST_PIPE_CALL_MAX_TOTAL_MS);
      try {
        await execute();
      } finally {
        if (shouldHold) this.deps.releasePipeCall?.(ghostId, callId);
      }
      return this.jobResult(jobId, job);
    }

    void execute();
    return {
      ok: true,
      jobId,
      status: 'running',
      ...(job.sessionId !== undefined ? { sessionId: job.sessionId } : {}),
    };
  }

  private handleQuery(
    ghostId: string,
    payload: Record<string, unknown>,
  ): GhostPipeAgentErrandResult {
    if (
      typeof payload.jobId !== 'string' ||
      payload.jobId.length === 0 ||
      payload.jobId.length > MAX_JOB_ID_LEN
    ) {
      return fail('INVALID_REQUEST', 'jobId 不合法');
    }
    const job = this.jobs.get(payload.jobId);
    // 归属校验与查无此单同一句话术:不给沙箱探测别人 jobId 的空间。
    if (!job || job.ghostId !== ghostId) {
      return fail('JOB_NOT_FOUND', '查无此任务(可能已过期或主机重启过),请重新提交');
    }
    return this.jobResult(payload.jobId, job);
  }

  /** 把任务记录折叠成协议返回(run wait 收口与 query 共用)。 */
  private jobResult(jobId: string, job: ErrandJob): GhostPipeAgentErrandResult {
    if (job.status === 'running') {
      return {
        ok: true,
        jobId,
        status: 'running',
        ...(job.sessionId !== undefined ? { sessionId: job.sessionId } : {}),
        elapsedSeconds: Math.max(0, Math.round((this.now() - job.startedAt) / 1000)),
      };
    }
    if (job.status === 'done' && job.result) {
      return {
        ok: true,
        jobId,
        status: 'done',
        sessionId: job.result.sessionId,
        text: job.result.text,
        ...(job.result.agentKind !== undefined ? { agentKind: job.result.agentKind } : {}),
        ...(job.result.model !== undefined ? { model: job.result.model } : {}),
      };
    }
    return fail(job.errorCode ?? 'TURN_FAILED', job.error ?? '派活失败');
  }

  private resolveOrigin(ghostId: string, userActionToken?: string): GhostErrandOrigin {
    // 只认 Host 铸造的当次点击：卡片票，或面板 webview 上真实的 mouse/key。
    if (
      userActionToken &&
      this.deps.consumeUserActionToken?.(userActionToken, ghostId) === true
    ) {
      this.userGestures.delete(ghostId);
      return 'user-action';
    }
    if (this.consumeUserGesture(ghostId)) return 'user-action';
    return 'background';
  }

  private consumeUserGesture(ghostId: string): boolean {
    const expiresAt = this.userGestures.get(ghostId);
    if (expiresAt === undefined) return false;
    this.userGestures.delete(ghostId);
    return expiresAt > this.now();
  }

  private sweepUserGestures(): void {
    const now = this.now();
    for (const [ghostId, expiresAt] of [...this.userGestures]) {
      if (expiresAt <= now) this.userGestures.delete(ghostId);
    }
  }

  private revealSessionOnce(job: ErrandJob, sessionId: string): void {
    if (job.origin !== 'user-action') return;
    if (job.revealed) return;
    job.revealed = true;
    try {
      this.onRevealSession?.(sessionId);
    } catch {
      // 聚焦失败不能让已经受理的派活对插件变失败。
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** 惰性清理:完成态超过 TTL 出表(running 永不清,同 cindySlot)。 */
  private sweepJobs(): void {
    if (this.jobs.size === 0) return;
    const now = this.now();
    for (const [jobId, job] of [...this.jobs]) {
      if (job.status !== 'running' && now - (job.doneAt ?? 0) > GHOST_ERRAND_JOB_TTL_MS) {
        this.jobs.delete(jobId);
      }
    }
  }

  /** 新 job 入表前按插件淘汰最旧完成记录(条数上限,同 cindySlot 契约)。 */
  private evictSettledJobs(ghostId: string): void {
    const entries = [...this.jobs.entries()].filter(([, j]) => j.ghostId === ghostId);
    const running = entries.filter(([, j]) => j.status === 'running').length;
    const settled = entries
      .filter(([, j]) => j.status !== 'running')
      .sort((a, b) => (a[1].doneAt ?? 0) - (b[1].doneAt ?? 0));
    const excess = settled.length - (MAX_SETTLED_JOBS_PER_GHOST - running - 1);
    for (let i = 0; i < excess; i++) {
      this.jobs.delete(settled[i][0]);
    }
  }
}
