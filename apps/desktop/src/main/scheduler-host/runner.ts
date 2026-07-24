/**
 * Phase 3: MakerScheduleRunner
 *
 * 实现 `ScheduleRunner` 接口（来自 @cindy/maker-scheduler）。
 *
 * 一次 fire 的工作流：
 *   1. effort 白名单校验 — 防止 user-input 把非法 effort 透传给 maker.createSession
 *      （Phase 2 mapper 没有运行时校验，runner 是最后一道关卡）。
 *   2. heartbeat 模式（schedule.targetSessionId 存在）：并行查
 *        a) maker.getSessionMeta → 拿 sdkSessionId 做 SDK resume
 *        b) desktop sessions 表的 status 列 → 判断是否 archived/deleted
 *      命中兜底 → scheduler.pause(scheduleId) + notify failure + throw
 *      （maker-core SessionMeta 已删 status 字段——archived 是 desktop 产品语义，
 *       存在 sessions.status enum，必须直查；详见 plan 文件 §「关键事实 #3」）
 *   3. workingDir：useWorktree=true 走 workdir-resolver 建 ephemeral worktree
 *      （绝不手动注册清理，maker-host:116-122 onClose 会自动清）
 *   4. maker.createSession（heartbeat 模式不传 title，让现有 row 标题保留）
 *   5. 一次性 listener：onEvent 收 done/error 任一立刻 unsubscribe
 *      （硬规则：listener 加 session 不加 maker；done/error 后立刻 unsub 防泄漏）
 *   6. session.send（硬规则：send 后**不要**立刻 closeSession，会切断后续事件）
 *   7. 收到 done/error 后组装 ScheduleRun，主动调 notifier.notify
 *      （Phase 1 changelog L1141 方案 A：runner 内部主动 notify，
 *        而非 host 订阅 scheduler.on('completed'|'failed') 后回查 storage join 元数据。
 *        runner 已持有全部上下文，方案 A 更简单、不引入 host 层订阅复杂度）
 *
 * 与 plan 文件偏离的地方：
 *   - extractErr() 内联实现（参考 runAgentTurn.ts:382-385 的 errData 解析模式）
 *   - randomSessionId 用 crypto.randomUUID
 *   - workingDir 在 heartbeat 模式下不能由 schedule 重新指定（已有 row 的 workDir 才是真）
 */

import { randomUUID } from 'node:crypto';

import { isTerminalAgentErrorEvent } from '@cindy/maker-core';
import type { Maker, AgentEvent, AgentKind, Effort, PermissionMode } from '@cindy/maker-core';
import { clampEffortToSupported } from '@cindy/model-providers';
import type {
  Schedule,
  ScheduleRun,
  ScheduleRunner,
  Notifier,
  Logger,
  FireContext,
  FireResult,
  Scheduler,
} from '@cindy/maker-scheduler';

import { createMessage } from '../localDb/ipc/messages.js';
import { getSessionRowSnapshot, touchUserSendInDb } from '../localDb/ipc/sessions.js';
import {
  getSessionProvider,
  setSessionProvider,
  hydrateSessionProvider,
} from '../maker-host/session-provider-store.js';
import {
  CredentialModeSwitchBusyError,
  prepareLocalCodexCredentialModeSwitch,
  prepareLocalSessionCredentialModeSwitch,
  shouldCloseSessionForCredentialSwitch,
} from '../maker-host/codex-credential-switch.js';
import { ensureDialogueWorkspaceDir } from '../localDb/dialogueWorkspace';
import { wireSessionToIpc, isSessionInTurn, noteSilentStopUserSend, onSilentStopSettled } from '../maker-ipc/register.js';
import { agentHandoffPending } from '../maker-ipc/agentHandoffPendingSingleton.js';
import { prependHandoffToUserMessage } from '../maker-ipc/agentHandoff.js';
import {
  sanitizeSendOutcomeError,
  toDesktopSessionDispatchOutcome,
  type SanitizedSendOutcomeError,
} from '../maker-host/send-outcome.js';
import { resolveWorkingDir } from './workdir-resolver';
import { WorktreePool } from '../worktree';
import type { SchedulerDrizzleDb } from './storage';
import { backfillSessionMeta } from './runners/_shared';
import { buildSkipResultText, executePreRunHook, formatPreRunHookFailure } from './pre-run-hook';
import { defaultModelFor } from './model-defaults';
import {
  cancelReleasedOutput,
  onReleasedAgentEvent,
} from '../content-moderation/outputHub.js';

const ALLOWED_EFFORT = new Set<string>([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);

// ── 撞忙顺延 / 活跃礼让(仅 heartbeat 复用 session 场景)─────────────────────
// 心跳与用户远程控制共享同一 maker session。session 同时只能跑一个 turn,
// 撞上正在跑的 turn 不该记失败(那是正常并发)。
/** 用户最近"按下发送"距今 < 此窗口视为"正在远程控制",心跳主动礼让。 */
const ACTIVE_YIELD_WINDOW_MS = 10 * 60_000;
/**
 * 顺延后多久重试(ms)。顺延极廉价(不建 session、不发消息、不烧 token),所以
 * 用固定短延轮询直到会话空闲即可 —— 会话一旦空闲下个 RETRY 就真跑,响应及时,
 * 90s 间距也不会忙循环。无需重试次数上限。
 */
const RETRY_DELAY_MS = 90_000;
/**
 * 排队派发等待的存活探测间隔(ms)。慢轮询只兜"coordinator 静默放弃排队项"的
 * 事件盲区(见 fireHeartbeatViaQueue 内注释),正常派发/丢弃/abort 都走事件通道,
 * 探测永远不触发;60s 一次纯内存查询,零负担。
 */
const QUEUED_DISPATCH_TRACK_POLL_MS = 60_000;

/**
 * 后台 subagent 兜底静默窗口(ms)。
 *
 * agent 在 turn 内派出后台 subagent(Agent tool run_in_background)时,主 turn 会先
 * 以"等待中"文本收 done,subagent 完成后 SDK 经 task_notification 自动续新 turn 产出
 * 真正的最终 summary —— 所以有在途后台任务时不能在首个 done 就定格 resultText。
 * 但若某个任务的终态事件丢失(subagent 进程异常等),run 会永久等不到"无在途任务的
 * done"。兜底:等待期间 session 连续静默(无任何事件)超过此窗口,强制按当前 buffer
 * 收尾 —— 宁可发一条中间态通知,不让 run 永久挂起。正常等待不会误触发:subagent
 * 运行中会周期性上报 task_progress,每个事件都刷新计时。
 */
export const BG_TASK_IDLE_FALLBACK_MS = 10 * 60_000;

/**
 * 调度场景的 model / permissionMode 兜底默认 —— schedule 表单允许"留空走默认"，
 * runner 必须把空值翻成具体合法值，否则落库就是空字符串 / 'ask'，主区右下角
 * model picker 显示 placeholder + permission 模式在 headless 跑时会卡所有需 approval
 * 的 tool 调用（没人在线点同意）。
 *
 * model 兜底已抽到 ./model-defaults.ts(defaultModelFor,broker 也复用);同步约束见彼处:
 * cc → claude-sonnet-4-6，codex → gpt-5.5。**故意不跟对话的 Opus 默认**
 * (modelDefinitions.ts getDefaultModelForVendor)：自动化无人值守反复执行，
 * 冷启动兜底走成本保守路线，要 Opus 的用户会在任务里显式选。
 * 三级回退（任务上次选择 → 对话上次选择 → 这里的兜底）在 renderer 表单层完成
 * 且保存时落显式值，runner 这条只兜 MCP 创建的 / 历史遗留的空 model 任务。
 * ⚠️ 必须与 UI 显示的空值回退一致（ModelEffortChip 也走 getScheduleDefaultModel），
 * 否则用户看到"已选 X"实际跑的却是 Y（2026-06 实际踩坑：UI 显示 Opus 4.8、跑的 4.7）。
 *
 * permissionMode 两个 agent 都用 'bypassPermissions'（types/common.ts:23 注释确认
 * codex 支持子集 ask/auto/bypassPermissions）—— 调度本质是 unattended，bypass 是
 * 唯一行得通的策略；用户想要更严格可未来给 Schedule schema 加显式 permissionMode 字段。
 */
function defaultPermissionModeForSchedule(): PermissionMode {
  // 两个 agent 都支持 bypassPermissions（types/common.ts:23），暂不按 agentKind 分支
  return 'bypassPermissions';
}

/**
 * 心跳撞忙排队桥(实现见 maker-ipc/register.ts 的 scheduler 排队桥一节)。
 * 心跳 fire 撞上绑定会话正忙时,把 prompt 作为排队消息入 coordinator 队列
 * (UI 里可见、可删除),turn 结束后按队列顺序自动派发;runner 经 onAccepted
 * 拿到派发时机后沿用既有的 run 结果捕获/通知链路。未注入(测试/启动早期
 * 降级)时回退直发 + 顺延的旧行为。
 */
export interface SchedulerQueueDeps {
  /** 目标会话当前是否忙(turn 运行中 / 队列有积压 / 凭证切换等待中)。 */
  isSessionBusy(sessionId: string): boolean;
  /** 该 schedule 是否已有排队中(或正在派发)的心跳消息 —— 防重复入队。 */
  hasQueuedPrompt(sessionId: string, scheduleId: string): boolean;
  enqueuePrompt(req: {
    sessionId: string;
    text: string;
    persistedContent: string;
    origin: { kind: 'scheduler'; scheduleId: string; scheduleName: string; runId: string };
    onAccepted: () => void | Promise<void>;
    onAcceptedRollback?: () => void | Promise<void>;
    onDiscarded?: () => void;
  }): Promise<{ clientId: string } | { duplicate: true } | { retry: true }>;
  removeQueuedPrompt(sessionId: string, clientId: string): void;
  /**
   * 排队项(含派发中 / 可重试 recovery)是否仍被 coordinator 跟踪。派发等待的
   * 存活探测:coordinator 存在不经 onDiscarded 的静默放弃路径(新输入顶掉
   * active-turn recovery、清会话等),不探测的话 run 会永久挂在等待派发上。
   */
  isPromptTracked(sessionId: string, clientId: string): boolean;
}

export interface MakerScheduleRunnerDeps {
  maker: Maker;
  getDb: () => SchedulerDrizzleDb;
  notifier: Notifier;
  logger: Logger;
  beforeDispatchUserTurn?: (sessionId: string) => void | Promise<void>;
  onUndispatchedUserTurn?: (sessionId: string) => void;
  /** heartbeat 直发前落实 deferred agent switch,并 bootstrap 新 live session。 */
  applyPendingAgentSwitch?: (sessionId: string, signal?: AbortSignal) => Promise<void>;
  /** 可选:撞忙排队桥。未注入时心跳撞忙回退为顺延(deferFire)旧行为。 */
  schedulerQueue?: SchedulerQueueDeps;
}

/** createTurnCompletionWaiter 的返回:turn 终态等待 + 文本缓冲 + 幂等摘除。 */
interface TurnCompletionWaiter {
  turnFinished: Promise<void>;
  stopListening: () => void;
  getAssistantText: () => string;
}

export class MakerScheduleRunner implements ScheduleRunner {
  private scheduler: Scheduler | null = null;

  constructor(private readonly deps: MakerScheduleRunnerDeps) {}

  /** scheduler-host/index.ts 在 startScheduler 内调一次，让 runner 反向 pause schedule */
  attachScheduler(scheduler: Scheduler): void {
    this.scheduler = scheduler;
  }

  /**
   * 顺延本轮:返回 deferred FireResult(engine 据此撤销预插 run、不通知、把
   * nextFireAt 短延 RETRY_DELAY_MS 后重试)。reason 仅用于日志。
   */
  private deferFire(
    schedule: Schedule,
    sessionId: string,
    reason: 'user-active' | 'session-running' | 'already-queued' | 'queue-restore-pending',
  ): FireResult {
    this.deps.logger.info?.(
      `[runner] defer fire (${reason}) schedule=${schedule.id} retryIn=${RETRY_DELAY_MS}ms`,
    );
    return { sessionId, deferred: true, deferRetryMs: RETRY_DELAY_MS };
  }

  /**
   * 顺延只对「能被 tick 真正重试」的 schedule 成立 —— recurring 且 active。
   * 顺延把重试写进 nextFireAt 等下一次 tick/fireOne 接力,而 tick 只遍历 activeSchedules、
   * 重启只 listActive() 加载 active 行:non-recurring(manual / once)、已 expired、paused
   * 的行即便写了 nextFireAt 也永不被重试 —— 静默顺延会直接丢任务(见 PR #129 review
   * Thread A / E)。这类撞忙不顺延,回退为可见失败(PR 前行为),让用户看到并可手动重试。
   */
  private canDefer(schedule: Schedule): boolean {
    return schedule.recurring === true && schedule.status === 'active';
  }

  private async failOrDeferSessionRunning(
    schedule: Schedule,
    ctx: FireContext,
    sessionId: string,
    allowDefer: boolean,
  ): Promise<FireResult> {
    if (allowDefer && this.canDefer(schedule)) {
      return this.deferFire(schedule, sessionId, 'session-running');
    }
    const sendContext = buildSchedulerSendContext(schedule, ctx, sessionId);
    const errMsg = formatSchedulerSendError(sendContext, 'SESSION_RUNNING');
    await this.notifyFailureSilent(schedule, ctx, errMsg);
    throw new Error(errMsg);
  }

  /**
   * fire 的收尾包装:ephemeral 会话(非 heartbeat、非持续会话)在 run 走到任何终态
   * (成功 / 失败 / 中止 / 中途异常)后关闭 in-memory 句柄。
   *
   * 为什么必须关:每次 fire 创建的会话都在 main 进程常驻一整套上下文(agent 子进程
   * 句柄 + 全部 MCP server 注册 + 事件 wiring),runner 此前从不关闭,高频调度任务下
   * 单调积累直至 V8 堆耗尽(2026-07-07 凌晨 03:05 实际 OOM 崩溃:一夜 186 个未关闭
   * 会话)。会话消息 / meta 已全部落库,关闭句柄不丢数据 —— 用户在 UI 里打开该会话
   * 走 SEND 的 lazy-create + sdkSessionId resume,可正常续聊(与归档语义一致)。
   *
   * 不关的两类:
   *   - heartbeat(复用 targetSessionId):用户既有会话,生命周期不归 runner 管。
   *   - persistentSession:产品语义就是「持续会话」,跨 fire 复用同一 session。
   * 另外收尾时会话上若有**新的** turn 在跑(用户从运行历史点开会话接管了对话),
   * 让位不关 —— 该会话已转为用户驱动。
   *
   * 用 wrapper + holder 而非在 fireInner 内部套 try/finally:fireInner 里 createSession
   * 之后仍有未捕获 throw 点(backfillSessionMeta / wireSessionToIpc 等),wrapper 的
   * finally 保证所有路径都收尾。头注释第 6 条「send 后不要立刻 closeSession」说的是
   * 事件流进行中不能关;这里在 run 终态(done/error 已收)之后关,不冲突。
   */
  async fire(schedule: Schedule, ctx: FireContext): Promise<FireResult> {
    const holder: EphemeralSessionHolder = {};
    try {
      throwIfFireAborted(ctx.signal, 'runner entry');
      return await this.fireInner(schedule, ctx, holder);
    } finally {
      if (
        holder.sessionId &&
        !holder.keepAlive &&
        (holder.closeOnAbort || !isSessionInTurn(holder.sessionId))
      ) {
        try {
          await this.deps.maker.closeSession(holder.sessionId);
        } catch (err) {
          this.deps.logger.warn?.('[runner] ephemeral session close failed (non-fatal)', {
            sessionId: holder.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (holder.worktreeSessionId && !holder.sessionId) {
        await WorktreePool.releaseWorktree(holder.worktreeSessionId).catch((err) => {
          this.deps.logger.warn?.('[runner] cancelled worktree release failed (non-fatal)', {
            sessionId: holder.worktreeSessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
  }

  private async fireInner(
    schedule: Schedule,
    ctx: FireContext,
    holder: EphemeralSessionHolder,
  ): Promise<FireResult> {
    // 1. effort 白名单
    if (schedule.effort && !ALLOWED_EFFORT.has(schedule.effort)) {
      const errMsg = `invalid effort: ${schedule.effort}`;
      await this.notifyFailureSilent(schedule, ctx, errMsg);
      throw new Error(errMsg);
    }

    // 1.5 前置检查脚本(Pre-run Hook):放在一切查询 / worktree 创建 / session 创建
    // 之前 —— 被拦截的轮次除了跑一个脚本什么都不做,零 token 零副作用。
    // exit 0 放行;exit 2 跳过(写留痕消息后返回 skipped,engine 落 'skipped' run);
    // 其它退出码 / 超时 / spawn 失败 fail-closed：持久化检查结果并阻止 agent。
    if (schedule.preRunHook?.command?.trim()) {
      // cwd:heartbeat(绑定会话)任务以会话 meta.workDir 为**权威**(与步骤 3 的
      // workingDir 解析口径一致)—— schedule.workingDir 可能为空,也可能是"project
      // 任务后来改绑会话"留下的过期值,只作 meta 读不到时的回落。否则 hook 回落
      // homedir / 过期目录,仓库相关检查(git 等)会恒失败并阻止任务,造成误拦截。
      // getSessionMeta 是纯读查询,不产生目录副作用;失败(会话缺失等)回落原值,
      // 交给后面 archived 兜底。dialogue 任务无目录时仍由执行器回落 homedir
      // (脚本内应使用绝对路径)。刻意不在此处解析 worktree / dialogue 目录 ——
      // 跳过的轮次不应产生目录副作用。
      let hookCwd = schedule.workingDir;
      if (schedule.targetSessionId) {
        const boundMeta = await this.deps.maker
          .getSessionMeta(schedule.targetSessionId)
          .catch(() => null);
        if (boundMeta?.workDir?.trim()) hookCwd = boundMeta.workDir;
      }
      const hook = await executePreRunHook({
        command: schedule.preRunHook.command,
        timeoutMs: schedule.preRunHook.timeoutMs,
        cwd: hookCwd,
        // pause/delete 的 abortInflightAndWait 只等几秒:信号透传进执行器,abort
        // 即树杀脚本进程立即返回,不让长 hook 拖住暂停/删除、也不在其后继续建会话。
        signal: ctx.signal,
        stdinPayload: {
          event: 'schedule-pre-run',
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          runId: ctx.runId,
          firedAt: ctx.firedAt,
          workingDir: hookCwd,
          lastFinishedAt: schedule.lastFinishedAt,
        },
      });
      await ctx.onPreRunHookCompleted?.(hook);
      if (hook.status === 'aborted' || ctx.signal.aborted) {
        // 本轮已被 pause/delete 中止:不留痕、不继续执行,直接抛回 engine
        // (controller.signal.aborted 会让 run 记 'aborted' 而非 'failed')。
        this.deps.logger.info?.('[runner] pre-run hook aborted by pause/delete', {
          scheduleId: schedule.id,
          runId: ctx.runId,
        });
        throw new Error('fire aborted during pre-run hook');
      }
      if (hook.decision === 'skip') {
        this.deps.logger.info?.('[runner] pre-run hook blocked this fire', {
          scheduleId: schedule.id,
          runId: ctx.runId,
          exitCode: hook.exitCode,
          durationMs: hook.durationMs,
        });
        return {
          // exit 2 只保留 schedule_runs 中的 skipped 记录，不创建或更新会话。
          sessionId: '',
          skipped: true,
          resultText: buildSkipResultText(hook),
        };
      }
      if (hook.decision === 'block') {
        const errMsg = formatPreRunHookFailure(hook);
        this.deps.logger.warn?.('[runner] pre-run hook failed; fail-closed (run blocked)', {
          scheduleId: schedule.id,
          runId: ctx.runId,
          status: hook.status,
          exitCode: hook.exitCode,
          error: hook.error,
          stderr: hook.stderr.slice(0, 500),
        });
        await this.notifyFailureSilent(schedule, ctx, errMsg);
        throw new Error(errMsg);
      }
      // exit 0 正常放行也要留痕:否则"hook 到底跑没跑"无从排查。
      this.deps.logger.info?.('[runner] pre-run hook passed (exit 0); run proceeds', {
        scheduleId: schedule.id,
        runId: ctx.runId,
        durationMs: hook.durationMs,
        stdout: hook.stdout.slice(0, 200),
      });
    }

    // isHeartbeat / sessionId 在 persistentSession 自我续命分支里可能被翻回新建路径，
    // 所以这里用 let，下面的 archived 兜底里会显式重置。
    let isHeartbeat = !!schedule.targetSessionId;
    let sessionId = schedule.targetSessionId ?? randomUUID();
    let resumeSessionId: string | undefined;
    // heartbeat 模式：workingDir 取自已有 session 的 meta（已有 row 的 workDir 是
    // 权威 —— 用户最初建 session 时选的）；model / effort 用 meta 值做"是否变化"
    // 判断基线,schedule 上显式设置的值优先（任务编辑器里的改动要生效）。
    let heartbeatWorkingDir: string | undefined;
    let heartbeatModel: string | undefined;
    let heartbeatEffort: string | undefined;
    let heartbeatAgentKind: AgentKind | undefined;
    // 持续会话沿用 session 自己存的 fast 态（与 model 同源取 meta）。
    let heartbeatFastMode: boolean | undefined;
    // 持续会话当前选定的来源(供应商)id —— schedule.providerId 留空时沿用它
    // （与 model 留空沿用 meta.model 对称）。取自 sessions.provider_id 快照,null=未选。
    let heartbeatProviderId: string | null = null;

    // 2. heartbeat archived/missing 兜底
    if (isHeartbeat) {
      // 直发路径不经过 makerSendTransaction。先落实 pending switch,再读取 meta/row,
      // 才能让本轮 createSession 与 send 都指向切换后的 live engine。
      throwIfFireAborted(ctx.signal, 'credential switch setup');
      await this.deps.applyPendingAgentSwitch?.(sessionId, ctx.signal);
      throwIfFireAborted(ctx.signal, 'credential switch setup');
      const [meta, row] = await Promise.all([
        this.deps.maker.getSessionMeta(sessionId).catch(() => null),
        getSessionRowSnapshot(sessionId),
      ]);
      const archived =
        !row || row.status === 'archived' || row.status === 'deleted';
      if (archived) {
        // persistentSession=true：自我续命。清空死的 targetSessionId,本次 fire 走新建分支,
        // session 创建成功后 4.7.1 会重新绑定到新 sessionId。这样用户即便手动归档/删除
        // 了之前持续会话的 session,自动化也不会卡死,而是无感开新的继续跑。
        if (schedule.persistentSession && this.scheduler) {
          this.deps.logger.info?.(
            `[runner] persistent session ${sessionId} archived; auto-rebinding`,
          );
          try {
            await this.scheduler.update(schedule.id, { targetSessionId: undefined });
          } catch (err) {
            this.deps.logger.warn?.('[runner] persistent rebind clear failed', err);
          }
          isHeartbeat = false;
          sessionId = randomUUID();
          // resumeSessionId / heartbeatWorkingDir / heartbeatModel 仍是 undefined,
          // 下方 workingDir 解析自然走 schedule.workingDir + schedule.useWorktree 分支
        } else {
          const errMsg = `target session not available (${row?.status ?? 'missing'})`;
          // exemptRunId=本轮自己:pause 会 abortInflightAndWait,本 run 已在
          // inflight 注册,不豁免会 abort 自己的 signal 并白等 5s 超时才返回。
          await this.scheduler?.pause(schedule.id, { exemptRunId: ctx.runId }).catch((err) => {
            this.deps.logger.warn?.('scheduler.pause failed', err);
          });
          await this.notifyFailureSilent(schedule, ctx, errMsg);
          throw new Error(errMsg);
        }
      } else {
        // B1 活跃礼让:最近有人往这个 session 发过输入(userSendAt 在窗口内)且
        // session 正跑 turn → 本轮不抢,顺延。两条件都满足才让:仅"刚发过"
        // 但 turn 已结束属正常 heartbeat 时机;仅"在跑"但非最近有输入多半是上轮
        // 心跳没跑完,交给 B2 的撞忙顺延。零新增查询(复用已取的 row.userSendAt
        // + 内存 tracker)。
        // 注:userSendAt 现在也被 scheduler 自身 fire bump(见 onAccepted),所以窗口内
        // 命中可能来自上一次自动 fire 而非真人。这只会让 B1 更保守——但唯一效果是"正在
        // 跑 turn 时顺延",而正在跑 turn 的 send 本就会被 B2(SESSION_RUNNING)顺延,两者
        // 落点一致,无功能回退,仅 telemetry reason 偏"user-active"。
        const recentlyUserDriven =
          row?.userSendAt != null && Date.now() - row.userSendAt < ACTIVE_YIELD_WINDOW_MS;
        if (recentlyUserDriven && isSessionInTurn(sessionId) && this.canDefer(schedule)) {
          return this.deferFire(schedule, sessionId, 'user-active');
        }
        // B1.5 撞忙排队(替代旧的"盲发 → SESSION_RUNNING → 顺延"路径):会话忙
        // (turn 运行中 / 队列有积压)时把心跳作为排队消息入 coordinator 队列 ——
        // 用户在会话里看得见、可删除,turn 结束后按序自动派发,不打断在跑的任务
        // (2026-07-14 实踩:自动续跑 turn 的 isTurnRunning 误报空闲,心跳 prompt
        // 被直接注入运行中的 turn;maker-core 已修误报,这里把"撞忙"从静默顺延
        // 升级为可见排队)。B1 活跃礼让仍优先:用户正在对话时连队都不排,顺延到
        // 用户空闲再说。桥未注入(测试/启动早期)时走原直发路径,行为不变。
        if (this.deps.schedulerQueue?.isSessionBusy(sessionId)) {
          // 同任务去重快路径(内存视角)。权威判定在 enqueuePrompt 内部:它会先
          // await 崩溃恢复快照读回再查重,覆盖"重启后快照未恢复、内存队列还空"
          // 的窗口(review P1)—— 命中时返回 duplicate,下方按同一语义收口。
          if (this.deps.schedulerQueue.hasQueuedPrompt(sessionId, schedule.id)) {
            return await this.settleDuplicateQueuedFire(schedule, ctx, sessionId);
          }
          return await this.fireHeartbeatViaQueue(schedule, ctx, sessionId, {
            model: meta?.model,
            effort: meta?.effort,
            providerId: row?.providerId ?? null,
          });
        }
        resumeSessionId = meta?.sdkSessionId;
        heartbeatWorkingDir = meta?.workDir;
        heartbeatModel = meta?.model;
        heartbeatEffort = meta?.effort;
        heartbeatAgentKind = meta?.agentKind;
        heartbeatFastMode = meta?.fastMode;
        heartbeatProviderId = row?.providerId ?? null;
      }
    }

    // 3. workingDir 解析（heartbeat 模式不允许自己建 worktree —— 已有 session 的 workDir 是权威）
    // The heartbeat metadata lookup above can take time.  Check again before
    // allocating a dialogue directory or creating an ephemeral worktree.
    throwIfFireAborted(ctx.signal, 'workspace allocation');
    let workingDir = isHeartbeat ? heartbeatWorkingDir : schedule.workingDir;
    // 未指定目录且不要 worktree → 回退 dialogue 语义(分配 app 管理的工作区)。
    // MCP/对话路径创建的任务经常不带 workingDir,而引擎 create() 默认
    // workspaceKind='project',此前这里会每轮抛 "workingDir is required" 永久
    // 失败且无法自愈 —— "没选目录"应当意味着"用对话工作区",不是"永远报错"。
    const isDialogueTarget =
      !isHeartbeat &&
      (schedule.workspaceKind === 'dialogue' ||
        (!schedule.useWorktree && !(schedule.workingDir ?? '').trim()));
    if (isDialogueTarget) {
      workingDir = ensureDialogueWorkspaceDir(sessionId, Date.now());
      this.deps.logger.info?.('[runner] allocated dialogue workspace', {
        scheduleId: schedule.id,
        sessionId,
        workingDir,
      });
      // 存量坏数据自愈:本修复前(或旧 MCP 客户端)创建的 project 形态无目录
      // 任务,把分类落库改成 dialogue —— 否则任务列表永远归在"其他"分组,且
      // 每轮 fire 都重复走回退判断。失败只 warn,不阻塞本轮。
      if (schedule.workspaceKind !== 'dialogue' && this.scheduler) {
        try {
          await this.scheduler.update(schedule.id, { workspaceKind: 'dialogue' });
        } catch (err) {
          this.deps.logger.warn?.('[runner] persist dialogue workspaceKind failed', err);
        }
      }
    } else if (!isHeartbeat && schedule.useWorktree) {
      const wt = await resolveWorkingDir(schedule, sessionId);
      if (!wt.ok) {
        const errMsg = `worktree create failed: ${wt.error}`;
        await this.notifyFailureSilent(schedule, ctx, errMsg);
        throw new Error(errMsg);
      }
      workingDir = wt.path;
      holder.worktreeSessionId = wt.worktreeSessionId ?? sessionId;
    }
    if (!workingDir) {
      const errMsg = isHeartbeat
        ? 'heartbeat target session has no workingDir in meta'
        : 'schedule.workingDir is required for non-heartbeat fire';
      await this.notifyFailureSilent(schedule, ctx, errMsg);
      throw new Error(errMsg);
    }

    // 4. createSession
    // model: schedule.model 显式设置时永远优先（任务编辑器里选的模型必须生效，
    // 含 heartbeat —— 否则用户在任务里改模型被静默忽略，只能去会话里改）；
    // heartbeat 且 schedule.model 留空才沿用绑定 session 的 meta.model；
    // 都空时按 agentKind 兜底 (与 renderer schedulerFallbackModel 同源)，
    // 不留空字符串 — UI picker 显示 placeholder。
    // permissionMode: schedule 没字段，runner 强制 'bypassPermissions'（headless 唯一可行）。
    const effectiveAgentKind = isHeartbeat
      ? (heartbeatAgentKind ?? schedule.agentKind)
      : schedule.agentKind;
    const rawModel = schedule.model?.trim()
      ? schedule.model
      : isHeartbeat
        ? heartbeatModel
        : undefined;
    const model = rawModel?.trim() ? rawModel : defaultModelFor(effectiveAgentKind);
    const permissionMode = defaultPermissionModeForSchedule();
    // fastMode 只对 codex 有意义（claude-code agent 忽略此字段）；Claude 恒不传，
    // 确保「不影响 Claude」。heartbeat 沿用 session meta 里的 fast 态，非 heartbeat 取 schedule。
    const fastMode =
      effectiveAgentKind === 'codex'
        ? isHeartbeat
          ? heartbeatFastMode
          : schedule.fastMode
        : undefined;
    const explicitProviderId = schedule.providerId?.trim() ? schedule.providerId.trim() : null;
    const createProviderId = explicitProviderId ?? (isHeartbeat ? heartbeatProviderId : null);
    // issue #456:未门控入口(定时任务 fire)按所选模型自报的 supported efforts 把 effort
    // clamp 到最高兼容档,避免把模型不支持的档(如 gpt-5.5 + max/ultra)透给上游被拒。
    // 模型已声明支持的档原样保留(不降级 —— 保 #352 交互式口径);schedule 配置本身不回写,
    // 只影响本次 fire 的运行值(该模型日后支持该档时自动生效)。直发 / 排队两路径共用
    // reconcileEffortForModel(见其注释),口径一致;lookup 失败不阻断 headless 运行。
    const reconciledEffort = this.reconcileEffortForModel(
      effectiveAgentKind,
      model,
      schedule.effort,
      schedule.id,
    );
    // 复用判定必须在 createSession 之前取：之后 session 必然在 activeSessions 里,
    // 区分不出"本来就活着(复用, opts 被忽略)"还是"这次 fire 才 spawn(opts 已生效)"。
    // TOCTOU 窗口(判定后、createSession 前 session 恰好关闭)只会把 fresh spawn 误判
    // 成复用 → set 失败时多跳过一次落库 → 下次 fire 重试, 方向保守无害。
    let reusedLiveSession = this.deps.maker.isSessionAlive(sessionId);
    if (reusedLiveSession) {
      const liveSession = this.deps.maker.getSession(sessionId);
      const currentProviderId = getSessionProvider(sessionId) ?? heartbeatProviderId;
      const nextProviderId = explicitProviderId ?? currentProviderId;
      if (
        liveSession &&
        shouldCloseSessionForCredentialSwitch({
          agentKind: liveSession.agentKind,
          remoteHostId: liveSession.remoteHostId,
          currentProviderId,
          nextProviderId,
          currentModel: liveSession.model,
          nextModel: model,
          currentCodexProxyActive: liveSession.codexProxyActive,
        })
      ) {
        if (isHeartbeat && isSessionInTurn(sessionId)) {
          return this.failOrDeferSessionRunning(schedule, ctx, sessionId, true);
        }
        try {
          throwIfFireAborted(ctx.signal, 'credential mode switch');
          if (liveSession.agentKind === 'codex') {
            await prepareLocalCodexCredentialModeSwitch({
              maker: this.deps.maker,
              isSessionInTurn,
              signal: ctx.signal,
            });
          } else {
            await prepareLocalSessionCredentialModeSwitch({
              maker: this.deps.maker,
              sessionId,
              isSessionInTurn,
              signal: ctx.signal,
            });
          }
          throwIfFireAborted(ctx.signal, 'credential mode switch');
        } catch (err) {
          if (err instanceof CredentialModeSwitchBusyError) {
            return this.failOrDeferSessionRunning(schedule, ctx, sessionId, isHeartbeat);
          }
          throw err;
        }
        reusedLiveSession = false;
        this.deps.logger.info?.('[runner] closed live session after credential mode switch', {
          sessionId,
          agentKind: liveSession.agentKind,
          currentProviderId,
          nextProviderId,
          fromModel: liveSession.model,
          toModel: model,
        });
      }
    }
    // The worktree path can also await filesystem work, so cancellation may
    // have arrived after the preceding guard.  Never create a late session.
    throwIfFireAborted(ctx.signal, 'session creation');
    let session: Awaited<ReturnType<Maker['createSession']>>;
    try {
      session = await this.deps.maker.createSession({
        id: sessionId,
        agentKind: effectiveAgentKind,
        workingDir,
        model,
        effort: reconciledEffort,
        fastMode,
        permissionMode,
        title: isHeartbeat ? undefined : `[Schedule] ${schedule.name}`,
        resumeSessionId,
        providerId: createProviderId ?? undefined,
      });
    } catch (err) {
      if (err instanceof CredentialModeSwitchBusyError) {
        // fresh Codex 也共用本地 credential mode，撞上其它本地 Codex turn 时按撞忙处理。
        return this.failOrDeferSessionRunning(schedule, ctx, sessionId, true);
      }
      throw err;
    }
    // 收尾包装(fire 的 finally)据此决定是否关闭:仅本次 fire 新建的 ephemeral 会话
    // (非 heartbeat、非持续会话)在 run 终态后关。必须在 createSession 成功后立刻
    // 登记,后续任何 throw 都能被收尾。
    holder.sessionId = session.id;
    holder.keepAlive = isHeartbeat || !!schedule.persistentSession;

    // 4.4.1 heartbeat 模型 / effort 同步：schedule 上的选择与绑定 session 当前值
    // 不一致时，把改动推给 session 运行时。必须显式 setModel / setEffort ——
    // maker.createSession 对进程内仍活着的 session 直接复用并忽略 opts.model /
    // opts.effort（maker.ts activeSessions 分支），不调这里下一 turn 仍会跑旧值。
    // 失败仅 warn（capability 不支持 / session 异常），本次 fire 继续。但落库要按
    // 路径区分：fresh spawn 时 opts 已生效, setModel / setEffort 只是幂等兜底, 失败
    // 不影响实际运行值, 照常落库；复用路径 setModel / setEffort 是唯一生效通道,
    // 失败时运行时仍是旧值, 必须跳过对应字段落库 —— 否则 meta 与运行时不一致,
    // 且下次 fire 读到 meta == schedule 会判定"无变化"不再重试, 错误被永久固化。
    const heartbeatModelChanged = isHeartbeat && model !== heartbeatModel;
    let modelSwitchApplied = true;
    if (heartbeatModelChanged) {
      try {
        await session.setModel(model);
      } catch (err) {
        if (reusedLiveSession) modelSwitchApplied = false;
        this.deps.logger.warn?.('[runner] heartbeat setModel failed (non-fatal)', err);
      }
    }
    // runtimeModel:本次实际会运行的模型 —— effort 必须按它 clamp。**复用会话一律以 live
    // `session.model`(handle 值)为准**,而非 getSessionMeta 快照:
    //  · setModel 成功 → handle 已是新模型;
    //  · setModel 失败(Claude 未改)→ handle 仍是旧模型 = 仍在跑的模型;
    //  · Codex setModel 在 await 前就先改了 handle.model,"失败"时其实已在新模型上 —— 只有读
    //    handle 才拿到真相(PR #479 review「Use the actual live model after failed Codex switches」);
    //  · follow-model(schedule.model 留空,不 setModel)→ handle 是用户在聊天里最新切到的模型。
    // 快照(model / heartbeatModel)在以上任一场景都可能与实际在跑的模型不符,故复用一律用
    // session.model。fresh spawn 无既有 handle,用本次 createSession 的 model。
    const runtimeModel = reusedLiveSession ? session.model : model;
    // follow-effort:schedule.effort 留空 = "沿用会话当前 effort"。此时待落档的**输入**是会话
    // 当前 effort(heartbeatEffort)而非 undefined —— 否则「只换 model、不改 effort」换到不支持
    // 当前档的模型时,reconcile(undefined) 返回 undefined、heartbeatEffortChanged=false,会话仍带
    // 旧的 max 跑到新的 capped 模型被上游拒(PR #479 review「Clamp followed effort when switching models」)。
    const desiredEffort = schedule.effort ? schedule.effort : heartbeatEffort;
    // runtimeModel===model 且未走 follow(desiredEffort===schedule.effort)时直接复用上方
    // createSession 已算好的 reconciledEffort,不重复 lookup / 不重复打 reconcile 日志。
    const runtimeReconciledEffort =
      runtimeModel === model && desiredEffort === schedule.effort
        ? reconciledEffort
        : this.reconcileEffortForModel(effectiveAgentKind, runtimeModel, desiredEffort, schedule.id);
    // heartbeatEffort 为对比基线:仅当 clamp 结果与会话当前档不同才 setEffort(follow-effort 且模型
    // 支持当前档 → 相等 → 不动;换到 capped 模型 → clamp 出更低档 → 触发同步)。
    const heartbeatEffortChanged =
      isHeartbeat && !!runtimeReconciledEffort && runtimeReconciledEffort !== heartbeatEffort;
    let effortSwitchApplied = true;
    if (heartbeatEffortChanged) {
      try {
        await session.setEffort(runtimeReconciledEffort as Effort);
      } catch (err) {
        // setEffort 失败时是否跳过落库,取决于它是不是本次「唯一生效通道」:
        //  · 复用会话:createSession 忽略 opts,setEffort 是唯一通道;
        //  · 冷 resume / fresh 但 follow-effort:createSession 收到的是 reconciledEffort(基于
        //    schedule.effort,follow 时为空 → undefined),真正要落的 runtimeReconciledEffort 是沿用
        //    并 clamp 后的值,与 createSession 拿到的不同 → 也只能靠 setEffort 落地。
        // 这两种情况失败 = 没生效,必须跳过落库让下次 fire 重试;否则 DB 记了没生效的档、下次判定
        // "已同步"不再重试(PR #479 review「Skip persisting followed effort when fresh sync fails」)。
        // 仅当 fresh 且要落的档 == createSession 已应用的档时,setEffort 只是幂等兜底,失败可照常落库。
        if (reusedLiveSession || runtimeReconciledEffort !== reconciledEffort) effortSwitchApplied = false;
        this.deps.logger.warn?.('[runner] heartbeat setEffort failed (non-fatal)', err);
      }
    }

    // 4.4.2 per-session 来源(供应商)注入。语义与 model 对称、但更简单 —— provider 走
    // 独立的内存 store(session-provider-store),不依赖 session 是否复用,写入即对下一个
    // 请求生效,故无需 fresh/reuse 落库区分。
    //   - schedule.providerId 显式设置 → 任务级选择永远优先,setSessionProvider 覆盖。
    //   - heartbeat 且留空 → 沿用绑定会话的来源:hydrate 只在内存无条目时写,**不覆盖**
    //     用户在聊天里刚切的更新值(runner 绕过了 register 的 hydrate funnel,冷 resume
    //     时内存为空,这一步把 DB 里的 provider_id 补回来 → honor 聊天所选来源)。
    //   - 非 heartbeat 且留空 → fresh session 保持默认(null)→ 原生默认路由,不动它。
    // null 的字节级不变性见 session-provider-store 契约;空值全程不进新分支(no-break)。
    if (explicitProviderId) {
      setSessionProvider(session.id, explicitProviderId);
    } else if (isHeartbeat) {
      hydrateSessionProvider(session.id, heartbeatProviderId);
    }

    // 4.5 wire 到 IPC 转发链路 —— 让 session 的事件 / 状态 / interaction 请求广播到
    // renderer。renderer 的 makerChatStore 全局 listen 'maker:event'，会把 user prompt /
    // assistant text / tool_use / tool_result 等落库到 messages 表。
    // 不 wire → renderer 收不到事件 → messages 永远空（修复 Phase 6 之前 bug：
    // 调度跑出来的 session 在 UI 里一片空白，msg_count=0，但 schedule_runs.status=success）。
    // wireSessionToIpc 内部按 session.id 幂等，并发 fire 同 session 不会重复挂。
    wireSessionToIpc(session);

    // 4.5.0 abort listener:scheduler 在 user delete/pause 时会 abort ctx.signal,
    // runner 这里收到后立刻 session.abort() —— SDK 抛 AbortError → 下面 turnFinished
    // 的 onEvent 'error' 触发 reject → fire 整体走 catch 路径,engine 那侧识别 wasAborted。
    // session.abort 幂等;listener 用 { once: true } + 提前 short-circuit aborted 兜底。
    const onAbort = (): void => {
      this.deps.logger.info?.(
        `[runner] ctx.signal aborted, calling session.abort() for ${session.id}`,
      );
      cancelReleasedOutput(session.id);
      void session.abort().catch((err) => {
        this.deps.logger.warn?.('[runner] session.abort failed', err);
      });
    };
    if (ctx.signal.aborted) {
      onAbort();
    } else {
      ctx.signal.addEventListener('abort', onAbort, { once: true });
    }

    // 4.5.1 修正 sessions 行的 permission_mode + effort/source/workspace_kind 列。
    // 这一步必须早于 session-bound 广播：renderer 收到 session-bound 会立刻刷新
    // sidebar，如果此时 source 仍是 DesktopSessionStorage.create() 写入的 'desktop'，
    // 新自动化会话会在 message count 落库前被误判成普通草稿，短暂或持续显示在项目外。
    //
    // 背景：apps/desktop/src/main/maker-host/session-storage.ts:60-61 的
    // DesktopSessionStorage.create() **硬编码** permissionMode:'ask' / effort:'high'，
    // 不读入参（SessionMeta 接口本身不含这两字段，Phase 1 设计为运行时透传给 SDK，
    // 不归 maker-core 持久化）。runner 在 main 进程没有 sessionService，
    // 直接走 drizzle 同表 update（实现细节见 runners/_shared.ts）。
    await backfillSessionMeta(
      this.deps.getDb(),
      session.id,
      {
        // 复用路径 setEffort 失败时跳过落库 —— 保留旧 meta.effort, 下次 fire
        // heartbeatEffortChanged 仍为 true 会重试同步（4.4.1 注释的固化问题）。
        // 落 runtimeReconciledEffort（按实际运行模型 clamp 后的值),session 行 effort 反映真跑的档,
        // 不落超额的原始配置,也不落「为一个没切成功的模型 clamp 出来的」错档(PR #479 review)。
        effort: effortSwitchApplied ? runtimeReconciledEffort : undefined,
        // heartbeat 模型被 schedule.model 覆盖时落库 —— chat UI picker 与
        // 下次 fire 读到的 meta.model 必须跟实际运行一致（4.4.1 已 setModel）。
        // 同 effort: 复用路径 setModel 失败时跳过, 留给下次 fire 重试。
        model: heartbeatModelChanged && modelSwitchApplied ? model : undefined,
        // 任务级显式选了来源时落 sessions.provider_id —— 让聊天里打开这个会话时
        // 来源 picker 与下次 fire / 冷 resume 的路由一致(register hydrate funnel 读它)。
        // 留空(沿用默认 / 沿用会话)时不写,保留会话自己的 provider_id 不动(no-break)。
        providerId: explicitProviderId ?? undefined,
        // 回退分配了对话工作区的会话按 'dialogue' 落库 —— 侧边栏才会归入
        // "对话"分组(覆盖存量 workspaceKind='project' 但无目录的旧任务)。
        workspaceKind: !isHeartbeat
          ? (isDialogueTarget ? 'dialogue' : schedule.workspaceKind)
          : undefined,
        source: !isHeartbeat ? 'scheduler' : undefined,
      },
      this.deps.logger,
    );

    // 4.5.2 上报 sessionId 给 scheduler，让 schedule_runs.sessionId 在 run 还在 running
    // 状态时就落库。配合 session-bound 事件让 RunHistoryPane 上的 "Open session" 按钮
    // 即时可用 —— 不必等 turnFinished 才能点开看进度。
    // 不阻塞 send 流程：失败只 warn，scheduler 那侧 buildOnSessionBound 内部也已 try/catch。
    try {
      await ctx.onSessionBound?.(session.id);
    } catch (err) {
      this.deps.logger.warn?.('[runner] onSessionBound failed (non-fatal)', err);
    }

    // 4.5.3 持续会话首次绑定：!isHeartbeat 才走（heartbeat 路径本来就在用同一 session）。
    // 把本次新建的 sessionId 回写到 schedule.targetSessionId,下次 fire 直接 heartbeat resume。
    // 失败仅 warn,不影响本次 fire；下次 fire 会再尝试绑定。
    if (!isHeartbeat && schedule.persistentSession && this.scheduler) {
      try {
        await this.scheduler.update(schedule.id, { targetSessionId: session.id });
      } catch (err) {
        this.deps.logger.warn?.('[runner] persistentSession bind failed (non-fatal)', err);
      }
    }

    // 5. 一次性 listener + 收集 assistant 最终文本(排队派发路径复用,实现与
    // 语义说明见 createTurnCompletionWaiter)。
    const waiter = this.createTurnCompletionWaiter(session);
    const turnFinished = waiter.turnFinished;

    // 6. send 并在 onAccepted 中落库 user prompt（不要 close session）。
    // onAccepted 失败表示产品层输入没有完成接受，必须按 pre-dispatch failure 收口，
    // 不继续等待 terminal event，避免无人值守 run 永久挂起。
    // 静默运行:成功 run 默认已由 scheduler 标记为静默;这里只给 agent 一条隐藏协议,
    // 告知"有事才主动上报"。落库仍保留用户原始 prompt,避免运行历史暴露工具协议。
    const promptToSend = schedule.silentWhenIdle
      ? `${schedule.prompt}${buildSilentRunInstruction()}`
      : schedule.prompt;
    let sendError: string | undefined;
    const sendContext = buildSchedulerSendContext(schedule, ctx, session.id);
    const sendLogBase = {
      kind: 'session-dispatch',
      owner: 'scheduler-host',
      entrypoint: 'scheduler-host.runner.fire',
      sessionId: session.id,
      agentKind: effectiveAgentKind,
      action: 'send-user-prompt',
      context: sendContext,
    } as const;
    // 自动任务来源:既透传给 session.send(让 maker 把它打到本轮每个
    // AgentEvent.turnOrigin,供 IM 转播识别自动 turn),也落进 user 消息的
    // agentMeta(renderer 据此渲染"由自动化任务发送"标签)。同一份,保持一致。
    const origin = {
      kind: 'scheduler',
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      runId: ctx.runId,
    } as const;
    let baselineStarted = false;
    let turnAccepted = false;
    try {
      // 落库放在 onAccepted(dispatch 前)是**刻意**的:落库失败即判 send 失败
      // (SchedulerOnAcceptedError → failed run),且错误信息脱敏(不泄露 prompt 原文),
      // 不让 agent 在"用户消息没存下"的情况下空跑。
      // 已知取舍(PR #129 review Thread F,经产品确认接受):在
      // 「session.ts:137 isTurnRunning 检查时 turn 未跑、紧接着 handle.send 又 reject
      // SESSION_RUNNING」这个 µs 级竞态窗口里,onAccepted 已落库但本轮被顺延,会留下
      // 一条 agent 实际没收到的孤儿 scheduler 消息(顺延重试再落一条)。触发面极窄——
      // 常见心跳撞忙都走 B1 活跃礼让(在 send 之前 defer、不落库)或 137-guard(在
      // onAccepted 之前抛、不落库),都不会留孤儿;故接受现状不额外硬化。
      // session-agent-switch:本路径直发 session.send(不经 makerSendTransaction),
      // 交接注入要自己接——切换后首条消息若是定时任务触发,新引擎同样需要交接
      // 上下文,否则零上下文裸跑(2026-07-20 审计)。落库仍是 prompt 原文。
      const pendingHandoff = await agentHandoffPending.peek(session.id);
      const outgoingMessage = pendingHandoff
        ? prependHandoffToUserMessage({ type: 'user', content: promptToSend }, pendingHandoff)
        : { type: 'user' as const, content: promptToSend };
      // session.abort() is best-effort when no turn has started yet.  The
      // explicit guard prevents a cancellation racing the setup above from
      // dispatching a new agent turn.
      throwIfFireAborted(ctx.signal, 'agent turn dispatch');
      const sendResult = await session.send(outgoingMessage as never, {
        origin,
        planMode: false,
        onAccepted: async () => {
          turnAccepted = true;
          // turn 已被会话接受 → 此刻才落定 sessionId → 本轮 runId 反向映射(供按
          // session 静默解析)。在 send 被接受这一刻写,被 SESSION_RUNNING 拒的并发 run
          // 不会走到这里,因此不会覆盖/带走仍在执行的活跃 run 的映射(scheduler.ts P2)。
          ctx.onTurnActive?.(session.id);
          noteSilentStopUserSend(session.id);
          try {
            await createMessage(session.id, {
              clientId: randomUUID(),
              role: 'user',
              content: schedule.prompt,
              agentMeta: { origin },
            });
          } catch (err) {
            throw new SchedulerOnAcceptedError(err);
          }
          if (this.deps.beforeDispatchUserTurn) {
            await this.deps.beforeDispatchUserTurn(session.id);
            baselineStarted = true;
          }
          // bump userSendAt:侧栏排序主键已切到 userSendAt ?? updatedAt,自动化任务
          // fire 属"这个会话有了新一轮输入",与用户按下发送同权重,让 fire 出来的会话
          // 即时冒到列表顶(否则已被用户发过消息、userSendAt 非空的绑定会话会被冻结在
          // 旧时刻顶不上来)。fire-and-forget:失败只 warn,不阻塞本轮 run —— 它只是排序
          // 元数据,落库失败最多让本次 fire 的会话晚一拍冒头,不影响 agent 执行。
          // 用 ctx.firedAt 对齐本轮 run.firedAt,顺延重试时也稳定。
          void touchUserSendInDb(session.id, ctx.firedAt).catch((err) => {
            this.deps.logger.warn?.('[runner] touchUserSend failed', {
              scheduleId: schedule.id,
              sessionId: session.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        },
      });
      if (pendingHandoff && sendResult.accepted) {
        agentHandoffPending.consume(session.id);
      }
      // Session.send may report a cancelled-before-dispatch outcome instead of
      // throwing.  Once the fire is aborted, preserve the abort path so the
      // scheduler does not emit a spurious failure notification.  Consume a
      // handoff first when the turn was accepted, so an aborted accepted send
      // cannot replay the same handoff on the next fire.
      throwIfFireAborted(ctx.signal, 'agent turn dispatch');
      const outcome = toDesktopSessionDispatchOutcome(sendResult, {
        source: 'scheduler-runner',
        context: sendContext,
      });
      if (!outcome.dispatched) {
        if (baselineStarted) {
          this.deps.onUndispatchedUserTurn?.(session.id);
          baselineStarted = false;
        }
        sendError = formatSchedulerSendError(sendContext, outcome.reason);
        this.deps.logger.warn?.('[runner] session send failed before dispatch', {
          ...sendLogBase,
          source: outcome.source,
          reason: outcome.reason,
        });
      } else {
        baselineStarted = false;
      }
    } catch (err) {
      if (baselineStarted) {
        this.deps.onUndispatchedUserTurn?.(session.id);
        baselineStarted = false;
      }
      if (ctx.signal.aborted) {
        waiter.stopListening();
        ctx.signal.removeEventListener('abort', onAbort);
        if (turnAccepted && !isHeartbeat && !schedule.persistentSession) {
          holder.closeOnAbort = true;
        }
        throw err;
      }
      const normalized = normalizeSchedulerSendError(err);
      // B2 撞忙顺延:仅 heartbeat(复用 session)场景 —— session 正跑别的 turn
      // (用户远程控制 / 上轮心跳未完)→ 不记失败,顺延重排。非 heartbeat 是新建
      // session,SESSION_RUNNING 属异常,维持原 failed(可见)。先就近摘掉本轮挂
      // 的 listener(turnFinished + abort),否则它们持有 session 引用阻止 GC。
      if (isHeartbeat && normalized.reason === 'SESSION_RUNNING' && this.canDefer(schedule)) {
        waiter.stopListening();
        ctx.signal.removeEventListener('abort', onAbort);
        return this.deferFire(schedule, session.id, 'session-running');
      }
      sendError = formatSchedulerSendError(sendContext, normalized.reason);
      this.deps.logger.warn?.('[runner] session send failed before dispatch', {
        ...sendLogBase,
        source: normalized.source,
        reason: normalized.reason,
        error: normalized.error,
      });
    }

    // 7. 等 turn end，组装 run，主动 notify
    let runError: string | undefined = sendError;
    if (!sendError) {
      try {
        await turnFinished;
      } catch (err) {
        runError = err instanceof Error ? err.message : String(err);
        if (ctx.signal.aborted && turnAccepted && !isHeartbeat && !schedule.persistentSession) {
          holder.closeOnAbort = true;
        }
      }
    } else {
      waiter.stopListening();
    }

    // 清理 abort listener —— { once: true } 在 abort 触发时已自动 remove,但若 fire
    // 正常结束(没 abort),listener 仍持有 session 引用,会阻止 GC。手动摘干净。
    ctx.signal.removeEventListener('abort', onAbort);

    return this.finalizeRun(schedule, ctx, session.id, runError, waiter.getAssistantText());
  }

  /**
   * 心跳撞忙的排队派发路径:把心跳 prompt 作为排队消息入 coordinator 队列
   * (会话 UI 可见、可删除),等 drain 派发(onAccepted)后沿用与直发路径相同的
   * turn 结果捕获 / 通知链路。前置条件:isHeartbeat、绑定会话存在且未归档、
   * schedulerQueue 已注入、无同 schedule 的既有排队项。
   *
   * 与直发路径的刻意差异:
   *   - user 消息落库由 coordinator drain 完成(persistedContent=原始 prompt,
   *     agentMeta.origin 经 send 事务合入),runner 不再自己 createMessage;
   *   - git 基线钩子(beforeDispatchUserTurn)由 coordinator 的同名 dep 在派发时
   *     触发(两者都指向 gitSnapshotCoordinator.onTurnStart),runner 不重复调;
   *   - schedule.model / effort / providerId 与会话当前值的同步跳过本轮(会话
   *     正忙,setModel 会撞运行中的 turn);下次空闲直发会照常同步,只影响
   *     "任务改了模型且恰好每轮都撞忙"的边角,日志留痕。
   */
  /**
   * 同任务已有排队/派发/待重试的心跳(手动"立即运行"撞上等待中的排队项、崩溃
   * 恢复快照残留)→ 不重复入队。recurring 顺延重试;一次性任务记可见失败,
   * 让用户看到并可稍后手动重试。
   */
  private async settleDuplicateQueuedFire(
    schedule: Schedule,
    ctx: FireContext,
    sessionId: string,
  ): Promise<FireResult> {
    if (this.canDefer(schedule)) {
      return this.deferFire(schedule, sessionId, 'already-queued');
    }
    const errMsg = formatSchedulerSendError(
      buildSchedulerSendContext(schedule, ctx, sessionId),
      'HEARTBEAT_ALREADY_QUEUED',
    );
    await this.notifyFailureSilent(schedule, ctx, errMsg);
    throw new Error(errMsg);
  }

  /**
   * issue #456:按所选模型自报的 supported efforts 把 effort clamp 到最高兼容档 ——
   * 定时任务 fire 的**直发 / 排队两条路径共用**,未门控入口在发到运行时前做与交互式
   * 同口径的 reconcile。模型已声明支持的档原样保留(不降级 —— 保 #352);efforts / effort
   * 空则透传;capability lookup 失败回退原 effort、不阻断无人值守运行。
   *
   * 口径依据:agent 运行时自身也用 `capabilities.availableModels.find(m => m.id === model)`
   * 解析 effort(见 claude-code sdkEffortForModel),这里查的是同一张按 model id 去重的能力
   * 表(base-agent mergeCapabilityList 对同 id 只留一条),clamp 结果与运行时实际门控一致 ——
   * provider / 来源不改变某 model id 的 effort 阶梯,故按 model id 查即可。
   */
  private reconcileEffortForModel(
    agentKind: AgentKind,
    model: string,
    effort: string | null | undefined,
    scheduleId: string,
  ): Effort | undefined {
    let reconciled = (effort ?? undefined) as Effort | undefined;
    try {
      const descriptor = this.deps.maker
        .getCapabilities(agentKind)
        .availableModels.find((m) => m.id === model);
      reconciled = (clampEffortToSupported(effort, descriptor?.efforts) ?? undefined) as
        | Effort
        | undefined;
      if (effort && reconciled !== effort) {
        this.deps.logger.info?.('[runner] effort reconciled to model capability', {
          scheduleId,
          model,
          agent: agentKind,
          from: effort,
          to: reconciled,
        });
      }
    } catch (err) {
      this.deps.logger.warn?.('[runner] effort reconcile skipped (non-fatal)', err);
    }
    return reconciled;
  }

  private async fireHeartbeatViaQueue(
    schedule: Schedule,
    ctx: FireContext,
    sessionId: string,
    /** 绑定会话的当前路由基线(meta.model / meta.effort / sessions.provider_id)。 */
    routingBaseline: { model?: string; effort?: string; providerId: string | null },
  ): Promise<FireResult> {
    const sq = this.deps.schedulerQueue;
    if (!sq) throw new Error('fireHeartbeatViaQueue requires schedulerQueue dep');
    const promptToSend = schedule.silentWhenIdle
      ? `${schedule.prompt}${buildSilentRunInstruction()}`
      : schedule.prompt;
    const origin = {
      kind: 'scheduler',
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      runId: ctx.runId,
    } as const;

    // "Open session" 尽早可用(sessionId 已知,无需等派发)。
    try {
      await ctx.onSessionBound?.(sessionId);
    } catch (err) {
      this.deps.logger.warn?.('[runner] onSessionBound failed (non-fatal)', err);
    }

    // 派发三通道:accepted(继续等 turn)/ discarded(排队项被删 → aborted)/
    // rollback(派发已 accept 但未成为运行 turn → failed)。waiter 在 onAccepted
    // 回调内同步挂上 —— 该回调运行于 session.send 的 onAccepted 链路,此刻 turn
    // 尚未 dispatch,监听不会漏事件;等 dispatchGate 的微任务续体也先于任何
    // agent 子进程 I/O 事件执行。
    // 用对象槽位而非裸 let:赋值发生在 enqueuePrompt 的 onAccepted 回调里,
    // TS 控制流分析看不到,裸 let 会被收窄成 null/never。
    const waiterSlot: { current: TurnCompletionWaiter | null } = { current: null };
    let dispatched = false;
    let settleDispatch!: () => void;
    let failDispatch!: (err: Error) => void;
    const dispatchGate = new Promise<void>((resolve, reject) => {
      settleDispatch = resolve;
      failDispatch = reject;
    });
    void dispatchGate.catch(() => undefined);
    // accepted 之后的失败通道(rollback):dispatchGate 已 resolve,只能经此中断等待。
    let failAfterAccept!: (err: Error) => void;
    const postAcceptFailed = new Promise<never>((_, reject) => {
      failAfterAccept = reject;
    });
    void postAcceptFailed.catch(() => undefined);

    const enqueueResult = await sq.enqueuePrompt({
      sessionId,
      text: promptToSend,
      persistedContent: schedule.prompt,
      origin,
      onAccepted: async () => {
        dispatched = true;
        const live = this.deps.maker.getSession(sessionId);
        // abort 撞上"项已转 activeTurn、尚未 accept"的派发窗口时,removeQueuedPrompt
        // 是 no-op、coordinator 会继续把 turn 发出去 —— 这里在 accept 时刻补杀:
        // run 已按 aborted 收口(onAbort 已 failDispatch),刚起步的 turn 立即中断,
        // 不让已暂停/删除的任务在会话里继续执行(PR #972 review P2)。
        if (ctx.signal.aborted) {
          if (live) {
            cancelReleasedOutput(sessionId);
            void live.abort().catch((err) => {
              this.deps.logger.warn?.('[runner] late-dispatch abort failed', err);
            });
          }
          return;
        }
        // 任务编辑器里选的 model/effort/来源在排队派发时刻热同步到会话(此回调
        // 运行于 vendor dispatch 之前,setModel 对本 turn 生效)—— 对齐直发路径
        // 的 4.4.1/4.4.2 语义,不让"任务改了模型且每轮都撞忙"的用户被静默忽略
        // (PR #972 review P2)。凭证形态需要切换的场景无法热切,跳过并留日志。
        if (live) {
          await this.applyQueuedHeartbeatRouting(schedule, live, routingBaseline).catch((err) => {
            this.deps.logger.warn?.('[runner] queued heartbeat routing sync failed (non-fatal)', err);
          });
        }
        if (live) waiterSlot.current = this.createTurnCompletionWaiter(live);
        // 与直发路径 onAccepted 的簿记对齐(落库/基线钩子除外,见方法头注释)。
        ctx.onTurnActive?.(sessionId);
        noteSilentStopUserSend(sessionId);
        void touchUserSendInDb(sessionId, ctx.firedAt).catch((err) => {
          this.deps.logger.warn?.('[runner] touchUserSend failed', {
            scheduleId: schedule.id,
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        settleDispatch();
      },
      onAcceptedRollback: () => {
        const err = new Error('queued heartbeat dispatch rolled back after accept');
        failAfterAccept(err);
        failDispatch(err);
      },
      onDiscarded: () => {
        // 排队项未派发即被移除(用户删队列行 / stop 清队列 / pause-delete 撤项)
        // → run 按 aborted 收尾(引擎按 /abort/i 识别错误文案)。
        failDispatch(new Error('queued heartbeat prompt removed before dispatch (aborted)'));
      },
    });
    if ('retry' in enqueueResult) {
      // 崩溃恢复快照尚未成功读回 → 持久化去重做不了,顺延本次 fire(90s 后重试,
      // 届时恢复多半已完成);一次性任务无法顺延,按可见失败收口。
      if (this.canDefer(schedule)) {
        return this.deferFire(schedule, sessionId, 'queue-restore-pending');
      }
      const errMsg = formatSchedulerSendError(
        buildSchedulerSendContext(schedule, ctx, sessionId),
        'QUEUE_RESTORE_PENDING',
      );
      await this.notifyFailureSilent(schedule, ctx, errMsg);
      throw new Error(errMsg);
    }
    if ('duplicate' in enqueueResult) {
      // 权威去重命中(恢复快照读回后发现同任务项)。
      return this.settleDuplicateQueuedFire(schedule, ctx, sessionId);
    }
    const { clientId } = enqueueResult;
    this.deps.logger.info?.('[runner] heartbeat prompt queued behind busy session', {
      scheduleId: schedule.id,
      runId: ctx.runId,
      sessionId,
      clientId,
    });

    // pause/delete abort:等待期撤掉队列项并**直接**解锁派发等待 —— 不依赖
    // removeQueuedPrompt 触发 onDiscarded(项若已转入 activeTurn/recovery,remove
    // 是 no-op,不会有回调);已派发则中断 live turn(与直发路径语义一致)。
    // failDispatch 对已 settle 的 promise 是 no-op,双通道安全。
    const onAbort = (): void => {
      this.deps.logger.info?.(
        `[runner] ctx.signal aborted while heartbeat queued, cleaning up for ${sessionId}`,
      );
      sq.removeQueuedPrompt(sessionId, clientId);
      if (dispatched) {
        const live = this.deps.maker.getSession(sessionId);
        if (live) {
          cancelReleasedOutput(sessionId);
          void live.abort().catch((err) => {
            this.deps.logger.warn?.('[runner] session.abort failed', err);
          });
        }
      } else {
        failDispatch(new Error('queued heartbeat aborted by schedule pause/delete'));
      }
    };
    if (ctx.signal.aborted) {
      onAbort();
    } else {
      ctx.signal.addEventListener('abort', onAbort, { once: true });
    }

    // 派发等待存活探测:coordinator 存在不经 onDiscarded 的静默放弃路径(Stop 竞态
    // 把项转入 active-turn recovery 后,用户新输入把 recovery 顶掉 / 清会话等),
    // 不探测的话 dispatchGate 永不 settle,run 永久挂 running(review P1)。探测按
    // clientId 查 pendingQueue / activeTurn / recovery,任一在即视为存活(可重试
    // recovery 仍可能被用户 Retry 重新派发,我们注册的 accepted 回调依然生效)。
    const trackPoll = setInterval(() => {
      if (dispatched) return;
      if (!sq.isPromptTracked(sessionId, clientId)) {
        failDispatch(
          new Error('queued heartbeat prompt was dropped before dispatch (queue cleared or recovery abandoned)'),
        );
      }
    }, QUEUED_DISPATCH_TRACK_POLL_MS);
    trackPoll.unref?.();

    try {
      await dispatchGate;
    } catch (err) {
      clearInterval(trackPoll);
      ctx.signal.removeEventListener('abort', onAbort);
      throw err instanceof Error ? err : new Error(String(err));
    }
    clearInterval(trackPoll);

    let runError: string | undefined;
    let assistantText = '';
    const activeWaiter = waiterSlot.current;
    if (!activeWaiter) {
      // onAccepted 时 live session 意外不可得(理论不可达:drain 刚在同一会话上
      // 完成 send accept)。按失败收尾,不让 run 永久挂起。
      runError = 'queued heartbeat dispatched but live session unavailable for result capture';
    } else {
      try {
        await Promise.race([activeWaiter.turnFinished, postAcceptFailed]);
      } catch (err) {
        runError = err instanceof Error ? err.message : String(err);
      } finally {
        activeWaiter.stopListening();
      }
      assistantText = activeWaiter.getAssistantText();
    }
    ctx.signal.removeEventListener('abort', onAbort);
    return this.finalizeRun(schedule, ctx, sessionId, runError, assistantText);
  }

  /**
   * 排队派发时刻的路由热同步:schedule 显式设置的 model / effort / 来源(供应商)
   * 优先于绑定会话当前值(与直发路径 4.4.1/4.4.2 同语义);留空沿用会话当前值。
   * 凭证形态需要关会话重建的组合(shouldCloseSessionForCredentialSwitch)无法在
   * 派发时刻热切 —— 跳过本轮同步,沿用会话当前路由,下次空闲直发照常收敛。
   * setModel / setEffort 成功才落库 meta,失败保留旧值让下轮重试(与直发路径的
   * 复用会话语义一致)。
   */
  private async applyQueuedHeartbeatRouting(
    schedule: Schedule,
    live: NonNullable<ReturnType<Maker['getSession']>>,
    baseline: { model?: string; effort?: string; providerId: string | null },
  ): Promise<void> {
    const explicitModel = schedule.model?.trim() ? schedule.model : undefined;
    const targetModel =
      explicitModel ?? (baseline.model?.trim() ? baseline.model : defaultModelFor(schedule.agentKind));
    const explicitProviderId = schedule.providerId?.trim() ? schedule.providerId.trim() : null;
    const currentProviderId = getSessionProvider(live.id) ?? baseline.providerId;
    const nextProviderId = explicitProviderId ?? currentProviderId;
    if (
      shouldCloseSessionForCredentialSwitch({
        agentKind: live.agentKind,
        remoteHostId: live.remoteHostId,
        currentProviderId,
        nextProviderId,
        currentModel: live.model,
        nextModel: targetModel,
        currentCodexProxyActive: live.codexProxyActive,
      })
    ) {
      this.deps.logger.info?.(
        '[runner] queued heartbeat routing needs credential mode switch; keeping session routing this round',
        { scheduleId: schedule.id, sessionId: live.id, fromModel: live.model, toModel: targetModel },
      );
      return;
    }
    // 与 live.model(随 setModel 实时更新)比较而非 fire 时刻的 baseline:排队
    // 等待期间用户可能在聊天里切了模型,schedule 显式选择必须仍以派发时刻的
    // 真实运行值为基准判断是否需要覆盖(review P2)。effort 无 live getter,
    // 仍以 baseline 判断(setEffort 幂等,误判多调一次无害)。
    const modelChanged = explicitModel !== undefined && targetModel !== live.model;
    let modelApplied = true;
    if (modelChanged) {
      try {
        await live.setModel(targetModel);
      } catch (err) {
        modelApplied = false;
        this.deps.logger.warn?.('[runner] queued heartbeat setModel failed (non-fatal)', err);
      }
    }
    // issue #456:排队派发路径与直发路径同口径 —— 按**实际会运行的模型**能力把 effort clamp
    // 到最高兼容档再 setEffort / 落库。忙会话(心跳撞正在跑的 turn)最常走这条排队分支,而
    // 直发路径的 reconcile 在 fireHeartbeatViaQueue return 之后才执行、覆盖不到这里;不 clamp
    // 就会把模型不支持的档(gpt-5.5 + max/ultra)原样透给上游被拒 —— 正是 #456 要消除的回归。
    // runtimeModel:只有「显式改 model 且 setModel 成功」时 turn 才跑在 targetModel;follow-session
    // (无显式 model,不调 setModel)或 setModel 失败时都跑在 live.model —— 后者在排队等待期间可能
    // 已被用户在聊天里改过,必须按它 clamp,否则用 enqueue 时的陈旧 targetModel 会张冠李戴
    // (PR #479 review:follow-session 用 live.model / setModel 失败用 live.model 两条)。
    const runtimeModel = modelChanged && modelApplied ? targetModel : live.model;
    // 只 reconcile schedule **显式配置**的 effort。follow-effort(schedule.effort 留空)不在排队路径
    // clamp:baseline.effort 是 enqueue 时刻的快照,排队等待期间用户可能已在聊天里改过 effort,拿旧
    // 快照 clamp 后 setEffort 会覆盖用户的新选择;而运行时无 live effort getter、拿不到当前真实值 ——
    // 遵循「follow 且当前值不可知 → 不动 effort」(PR #479 review「Re-read effort before following
    // queued sessions」)。显式 effort 才是权威意图,按实际运行模型 clamp 后下发。
    const reconciledEffort = this.reconcileEffortForModel(
      live.agentKind,
      runtimeModel,
      schedule.effort,
      schedule.id,
    );
    // 显式 effort 存在即下发,不靠 `!== baseline.effort` 判断:baseline.effort 是 enqueue 时刻快照,
    // 且上一次 fire 可能已把它 backfill 成 clamp 后的值 —— 若据此判"未变"而 skip,当用户在排队期间
    // 把 live effort 调低时,这一 turn 会跑用户的低档而非 schedule 的显式档。setEffort 幂等,显式档
    // 每次派发都重申一遍无害(PR #479 review「Reapply explicit queued effort after clamping」)。
    // follow-effort 时 reconciledEffort 为 undefined(上面只喂 schedule.effort),自然 skip。
    const effortChanged = !!reconciledEffort;
    let effortApplied = true;
    if (effortChanged) {
      try {
        await live.setEffort(reconciledEffort as Effort);
      } catch (err) {
        effortApplied = false;
        this.deps.logger.warn?.('[runner] queued heartbeat setEffort failed (non-fatal)', err);
      }
    }
    if (explicitProviderId) {
      setSessionProvider(live.id, explicitProviderId);
    }
    if ((modelChanged && modelApplied) || (effortChanged && effortApplied) || explicitProviderId) {
      await backfillSessionMeta(
        this.deps.getDb(),
        live.id,
        {
          model: modelChanged && modelApplied ? targetModel : undefined,
          effort: effortChanged && effortApplied ? reconciledEffort : undefined,
          providerId: explicitProviderId ?? undefined,
        },
        this.deps.logger,
      );
    }
  }

  /**
   * run 收尾共用段(直发 / 排队派发两路径共用):组装 finalRun、静默判定、
   * notifier 通知,失败以 throw 上抛给引擎标记 failed/aborted。
   */
  private async finalizeRun(
    schedule: Schedule,
    ctx: FireContext,
    sessionId: string,
    runError: string | undefined,
    assistantText: string,
  ): Promise<FireResult> {
    const finalRun: ScheduleRun = {
      id: ctx.runId,
      scheduleId: schedule.id,
      sessionId,
      firedAt: ctx.firedAt,
      finishedAt: Date.now(),
      status: runError ? 'failed' : 'success',
      errorMsg: runError,
      // 仅 success 时落库 — 失败 run 的部分输出意义不大,errorMsg 已经覆盖原因
      resultText: !runError && assistantText ? assistantText : undefined,
    };
    // 静默 run:静默运行默认静默;若 agent 经 schedule_notify_current_run 主动上报,
    // scheduler.isRunSilenced 会变回 false,这里照常通知。
    // success 时跳过桌面/飞书通知(引擎落库会同时置 readAt,小红点也不亮)。
    // 失败不豁免 —— 异常必须可见,通知照发(fail-safe)。
    const silenced =
      finalRun.status === 'success' && !!this.scheduler?.isRunSilenced(ctx.runId);
    if (silenced) {
      this.deps.logger.info?.('[runner] run silenced; skipping completion notification', {
        scheduleId: schedule.id,
        runId: ctx.runId,
      });
    } else {
      try {
        await this.deps.notifier.notify(schedule, finalRun);
      } catch (err) {
        // 即便 Notifier 实现违规 throw，runner 也要兜住 —— 通知不能阻塞 run 结果上报
        this.deps.logger.warn?.('notifier.notify threw (should not happen)', err);
      }
    }
    if (runError) throw new Error(runError);
    return { sessionId, resultText: assistantText || undefined };
  }

  /**
   * turn 完成等待器:一次性 listener + 收集 assistant 最终文本。
   * 与飞书 runAgentTurn.handleTextEvent 同源语义:
   *   - text 事件 isFinal=true → 替换 buffer 为 canonical final text
   *   - text 事件 isFinal=false → 追加 delta
   * done 时 buffer 即这一轮的最终输出(与飞书正常对话气泡显示同源),
   * 用于 schedule 完成通知 / 历史回顾。
   *
   * 后台 subagent 感知:agent 派了后台任务(agent_task_update status=running)时,
   * 主 turn 的 done 只是"等待中"的中间态 —— subagent 完成后 SDK 会自动续 turn 产出
   * 真正的最终 summary。因此 done 时若仍有在途任务,不定格、继续听,直到某个 done
   * 到来时在途任务集合为空才收尾(text 的 isFinal 替换语义保证 buffer 最终是最后
   * 一个 turn 的 canonical 文本)。异常保护见 BG_TASK_IDLE_FALLBACK_MS。
   */
  private createTurnCompletionWaiter(
    session: Pick<Awaited<ReturnType<Maker['createSession']>>, 'id' | 'onEvent' | 'abort'>,
  ): TurnCompletionWaiter {
    let assistantText = '';
    let stopped = false;
    let stopListeningTurn: (() => void) | undefined;
    const turnFinished = new Promise<void>((resolve, reject) => {
      /** 在途后台任务 id 集合(running 加入,completed/failed/stopped 移除)。 */
      const runningBgTasks = new Set<string>();
      /** 已收到过 done 但因在途任务未收尾 —— 此状态下任何事件都会刷新兜底计时。 */
      let waitingForBgTasks = false;
      let bgFallbackTimer: NodeJS.Timeout | undefined;
      let pendingSettleUnsub: (() => void) | undefined;
      const clearBgFallbackTimer = (): void => {
        if (bgFallbackTimer) {
          clearTimeout(bgFallbackTimer);
          bgFallbackTimer = undefined;
        }
      };
      const finish = (): void => {
        clearBgFallbackTimer();
        pendingSettleUnsub?.();
        pendingSettleUnsub = undefined;
        off();
        stopListeningTurn = undefined;
        resolve();
      };
      const armBgFallbackTimer = (): void => {
        clearBgFallbackTimer();
        bgFallbackTimer = setTimeout(() => {
          this.deps.logger.warn?.(
            '[runner] background task events went silent; finalizing run with current buffer',
            { sessionId: session.id, pendingTasks: [...runningBgTasks] },
          );
          finish();
        }, BG_TASK_IDLE_FALLBACK_MS);
        bgFallbackTimer.unref?.();
      };
      const off = onReleasedAgentEvent(session, (ev: AgentEvent) => {
        // 等待后台任务期间,任何事件都说明会话还活着 → 刷新兜底计时
        if (waitingForBgTasks) armBgFallbackTimer();
        if (ev.type === 'agent_task_update') {
          const data = ev.data as { taskId?: string; status?: string } | null;
          if (data && typeof data.taskId === 'string') {
            if (data.status === 'running') runningBgTasks.add(data.taskId);
            else runningBgTasks.delete(data.taskId);
          }
          return;
        }
        if (ev.type === 'text') {
          const data = ev.data as { text?: string; isFinal?: boolean } | null;
          if (data && typeof data.text === 'string') {
            if (data.isFinal) assistantText = data.text;
            else assistantText += data.text;
          }
          return;
        }
        if (ev.type === 'done') {
          // silent-stop:上游空内容消息静默收尾,main 守卫会在 1.5s 后自动续跑
          // (或弹耗尽横幅)。不 finish——等续跑 turn 的 done 或守卫 settle 通知。
          // settle 通知覆盖守卫决策为非续跑的所有路径(skip/exhausted/send 失败),
          // 否则 turnFinished 永不 resolve,run 永久挂起。
          if ((ev.data as { silentStop?: boolean } | null | undefined)?.silentStop === true) {
            this.deps.logger.info?.(
              '[runner] silent-stop done deferred; waiting for auto-resume or settled',
              { sessionId: session.id },
            );
            pendingSettleUnsub?.();
            pendingSettleUnsub = onSilentStopSettled(session.id, (_sid, reason) => {
              pendingSettleUnsub?.();
              pendingSettleUnsub = undefined;
              if (reason === 'exhausted') {
                clearBgFallbackTimer();
                off();
                stopListeningTurn = undefined;
                reject(new Error('silent-stop auto-resume exhausted'));
              } else {
                finish();
              }
            });
            return;
          }
          if (runningBgTasks.size > 0) {
            // 主 turn 结束但后台 subagent 还在跑 —— 不定格,等续 turn 的 done
            waitingForBgTasks = true;
            armBgFallbackTimer();
            this.deps.logger.info?.(
              '[runner] turn done with background tasks in flight; deferring run finalization',
              { sessionId: session.id, pendingTasks: [...runningBgTasks] },
            );
            return;
          }
          finish();
        } else if (isTerminalAgentErrorEvent(ev)) {
          clearBgFallbackTimer();
          off();
          stopListeningTurn = undefined;
          reject(new Error(extractErr(ev.data)));
        }
      });
      stopListeningTurn = (): void => {
        clearBgFallbackTimer();
        pendingSettleUnsub?.();
        pendingSettleUnsub = undefined;
        off();
      };
    });
    void turnFinished.catch(() => undefined);
    return {
      turnFinished,
      stopListening: (): void => {
        if (stopped) return;
        stopped = true;
        stopListeningTurn?.();
        stopListeningTurn = undefined;
      },
      getAssistantText: (): string => assistantText,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async notifyFailureSilent(
    schedule: Schedule,
    ctx: FireContext,
    errMsg: string,
  ): Promise<void> {
    const fauxRun: ScheduleRun = {
      id: ctx.runId,
      scheduleId: schedule.id,
      firedAt: ctx.firedAt,
      finishedAt: Date.now(),
      status: 'failed',
      errorMsg: errMsg,
    };
    try {
      await this.deps.notifier.notify(schedule, fauxRun);
    } catch {
      /* notifier 已做兜底，再炸只能 swallow */
    }
  }
}

/**
 * 静默运行任务在每次 fire 时由 runner 追加到模型输入末尾的隐藏协议。UI / DB
 * 仍展示用户原始 prompt。注意:这是 per-fire user message suffix,不是系统提示词
 * (不进 system 段,不影响 prompt cache 前缀)。
 */
export function buildSilentRunInstruction(): string {
  return [
    '\n\n---\n[Silent scheduled run]',
    'Successful runs do not notify by default. If this run needs user attention, call cindy_scheduler call_tool({ name: "schedule_notify_current_run", args: {} }).',
  ].join('');
}

function extractErr(data: unknown): string {
  if (data && typeof data === 'object' && 'message' in data) {
    return String((data as { message: unknown }).message);
  }
  return String(data);
}

/**
 * Stops a cancelled run at a side-effect boundary. Scheduler derives the final
 * run status from the signal; this guard prevents late session or turn creation
 * after a delete/pause won the race.
 */
type FireAbortStage =
  | 'runner entry'
  | 'workspace allocation'
  | 'session creation'
  | 'agent turn dispatch'
  | 'credential switch setup'
  | 'credential mode switch';

function throwIfFireAborted(signal: AbortSignal, stage: FireAbortStage): void {
  if (signal.aborted) {
    throw new Error(`schedule fire aborted before ${stage}`);
  }
}

/**
 * fire → fireInner 之间传递「本次 fire 新建了哪个会话、要不要保活」的载体。
 * fireInner 在 createSession 成功后写入;fire 的 finally 读它做 ephemeral 收尾。
 * 用 per-call 对象而非实例字段:并发 fire(多任务同 tick 触发)互不串扰。
 */
interface EphemeralSessionHolder {
  sessionId?: string;
  /** force cleanup when an accepted ephemeral turn is aborted mid-dispatch */
  closeOnAbort?: boolean;
  worktreeSessionId?: string;
  /** true = heartbeat 复用会话或持续会话,收尾时不关闭。 */
  keepAlive?: boolean;
}

class SchedulerOnAcceptedError extends Error {
  readonly sanitizedCause: SanitizedSendOutcomeError;

  constructor(cause: unknown) {
    super('scheduler onAccepted rejected');
    this.name = 'SchedulerOnAcceptedError';
    this.sanitizedCause = sanitizeSendOutcomeError(cause);
  }
}

function buildSchedulerSendContext(
  schedule: Schedule,
  ctx: FireContext,
  sessionId: string,
): string {
  return [
    'scheduler-host.runner.fire',
    `scheduleId=${schedule.id}`,
    `runId=${ctx.runId}`,
    `sessionId=${sessionId}`,
    'action=send-user-prompt',
  ].join(' ');
}

function formatSchedulerSendError(context: string, reason: string): string {
  return `Session send failed before dispatch: ${context} (${reason})`;
}

function normalizeSchedulerSendError(err: unknown): {
  source: string;
  reason: string;
  error: SanitizedSendOutcomeError;
} {
  if (err instanceof SchedulerOnAcceptedError) {
    return {
      source: 'onAccepted',
      reason: 'onAccepted-rejected',
      error: err.sanitizedCause,
    };
  }
  const error = sanitizeSendOutcomeError(err);
  if (isSessionRunningSendError(err, error)) {
    return {
      source: 'session-state',
      reason: 'SESSION_RUNNING',
      error,
    };
  }
  return {
    source: 'session.send',
    reason: error.safeMessage ?? error.errorName ?? error.errorKind ?? 'unknown',
    error,
  };
}

function isSessionRunningSendError(
  err: unknown,
  error: SanitizedSendOutcomeError,
): boolean {
  if (error.errorCode === 'SESSION_RUNNING') return true;
  return err instanceof Error && err.message.startsWith('SESSION_RUNNING:');
}
