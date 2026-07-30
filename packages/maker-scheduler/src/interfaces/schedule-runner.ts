import type { PreRunHookRunResult, RunStatus, Schedule } from '../types.js';

export interface ChildRunInput {
  sessionId?: string;
  status: RunStatus;
  resultText?: string;
  errorMsg?: string;
}

export interface FireContext {
  runId: string;
  firedAt: number;
  /**
   * 由 Scheduler 创建并 own 的 AbortSignal。当用户在 UI 上 delete/pause 这条 schedule 时,
   * Scheduler 会对所有 in-flight 的 runner.fire() 触发 abort。
   *
   * Runner 约定:
   * - 监听 signal.aborted / addEventListener('abort', ...),收到后立刻让底层 agent 停止
   *   (主 runner: Session.abort();多 session runner: 当前 issue 的 session.abort() + 跳过剩余)。
   * - 因 abort 而退出的 fire 应抛出 DOMException('aborted', 'AbortError') 或 message 含
   *   "abort"/"aborted" 的 Error,Scheduler 据此把对应 run 行标 status='aborted'。
   * - 即便不响应 abort,Scheduler 也只等 5s,过期后 schedule 还是会被 delete/pause —— 但
   *   in-flight session 会继续烧 token,所以 runner 必须接 abort。
   */
  signal: AbortSignal;
  /**
   * Runner 拿到 sessionId 时主动上报（在 fire() 完成前）。Scheduler 注入实现，
   * 内部会立刻 UPDATE schedule_runs.sessionId 并 emit 'session-bound' 事件。
   *
   * 对接规则：
   * - 拿到一个有效（非空）sessionId 后**尽快**调一次；可以多次调，幂等。
   * - 回调会写存储 + emit 事件，**可能抛异常**，runner 自己包 try/catch（不要让它
   *   传染上来打断 fire 主流程）。
   * - 旧实现不传也兼容（optional），那就退回到原行为：completion 时一次性写 sessionId。
   */
  onSessionBound?: (sessionId: string) => Promise<void> | void;
  /**
   * Runner 在本轮 turn **被会话接受后**（send 被 accept、即将真正执行）调一次,
   * 上报承载本轮的 sessionId。Scheduler 注入实现,据此落定 sessionId → 本轮 runId
   * 的反向映射,供"按调用方 session 静默本轮"使用。
   *
   * 与 onSessionBound 的区别 / 为什么单独一个回调:
   * - onSessionBound 在 send **之前**就调(为了让 UI 的 "Open session" 尽早可用)。
   * - 反向映射若也在 send 之前写,则同一 session 上重叠的两个 run（in-flight 时又被
   *   runNow / 另一 schedule 撞同 session）里,后一个 run 会在自己的 send 真正被接受前
   *   就覆盖映射;而它的 send 若被 SESSION_RUNNING 拒,其清理又会把映射删掉,导致仍在
   *   执行的前一个 run 调静默时解析不到自己（codex review P2）。
   * - 因此映射只在"turn 已被接受"这一刻写:被拒的 run 永不写、永不污染活跃 run。
   * - optional;runner 不调则反向映射不落定,"按 session 静默本轮"解析落空(MCP 工具
   *   退回到显式 runId 路径),不影响其它流程。
   */
  onTurnActive?: (sessionId: string) => void;
  /**
   * 多 session runner 为每个子任务创建独立 run 记录。
   * 每条 child run 拥有独立 sessionId，UI 各自显示 "Open session"。
   * 引擎注入实现，runner 只需提供子任务结果数据。
   */
  createChildRun?: (input: ChildRunInput) => Promise<string>;
  /**
   * 前置检查结束后立即持久化结果。检查发生在 session / agent 创建之前，不能等
   * fire() 返回后再保存，否则 fail-closed 的抛错路径会丢失诊断信息。
   */
  onPreRunHookCompleted?: (result: PreRunHookRunResult) => Promise<void> | void;
  /**
   * Runner 进入「纯等待」状态时上报。目前唯一的纯等待场景:心跳 prompt 撞上正忙的
   * 目标会话被排进队列,等会话空闲后派发 —— 此刻没有 agent 子进程、没有 MCP 注册、
   * 不烧 token。
   *
   * Scheduler 据此把该 run 的 phase 切到 'queued' 并**从并发闸门计数里摘出去**:
   * 并发上限防的是"同时跑太多 agent",纯等待占着配额毫无收益,反而会让一个卡住的
   * 会话拖死整个调度器(2026-07-29 实事故,见 ScheduleRunPhase 注释)。
   *
   * 必须与 endQueueWait 配对;optional,runner 不调则退回旧行为(排队期间照旧占槽)。
   */
  onQueueWaitStart?: () => void;
  /**
   * 结束纯等待。**必须**在每条离开等待的路径上调用一次(派发被接受 / 撤项 / 失败 /
   * abort),否则该 run 会永远被算作"不占槽"。
   *
   * @param reclaimSlot true = 本轮要继续执行,需要重新占回执行槽;
   *                    false = 本轮不再执行(撤项 / 失败 / abort),只复位记账。
   * @returns reclaimSlot=true 时:false 表示**当前没有空槽**。此时调用方必须在
   *          vendor dispatch **之前**中断本轮(撤项 + 按顺延收口),不得继续执行 ——
   *          让出的槽位早已被 tick 补上新任务,继续执行就会突破 maxConcurrentRuns,
   *          把当初防 OOM 的闸门架空(review #944 第二、三轮)。
   *          reclaimSlot=false 时返回值无意义(恒 true)。
   */
  endQueueWait?: (reclaimSlot: boolean) => boolean;
  /**
   * Runner 每次真的把一条通知投进 notifier 后上报投了哪一类。Scheduler 只用它回答
   * 一个问题:卡死守卫把本轮记成 failed 时,**还需不需要补一条失败通知**。
   *
   * 为什么不能靠"runner 有没有抛错"推断(review #944 第五轮 P1):守卫的 abort 可能
   * 落在前置检查脚本、workspace / session 创建这类 setup await 上,runner 会在走到
   * 任何 notifier 调用之前就抛出 —— 有 runError 却一条通知都没发。按旧判据(有错
   * 即视为已通知)会静默吞掉唯一的失败提醒,配了桌面 / 飞书通知的用户什么都收不到。
   *
   * 补发判据是"runner 没投过 **failure**",而不是"没投过任何通知":runner 无错返回
   * (abort 只 drain 出一个普通 done)时它投的是**成功**通知,与本轮记为 failed 矛盾,
   * 必须补一条失败通知纠正(第三轮已确立的语义)。
   *
   * optional;runner 不实现则退回"总是补发" —— 宁可重复一条,不可静默(失败必须可见)。
   */
  onRunnerNotified?: (kind: 'success' | 'failure') => void;
  /**
   * Runner 收到任何一次执行进展信号（会话事件）时打点。Scheduler 用它做卡死判定:
   * 「多久没有新反馈」而不是「总共跑了多久」—— 后者会误砍真在干活的长任务。
   *
   * 调用要求:热路径,实现必须廉价(引擎侧只写一个时间戳,不落库不广播)。
   * optional;runner 不调则退回按 run 起始时间判定,长跑任务会被误判为卡死,
   * 因此新 runner 都应该接。
   */
  onProgress?: () => void;
}

export interface FireResult {
  sessionId: string;
  /**
   * Agent 这一轮 turn 的最终文本（可选）。runner 可选地填入；engine 在
   * success 分支会一并 update 到 schedule_runs.result_text。
   */
  resultText?: string;
  /**
   * true = 本轮未真正执行,而是顺延(目标 session 正忙 / 用户正在远程控制礼让)。
   * engine 据此:撤销本轮预插的 running run(不留可见记录)、不 emit
   * completed/failed(不亮红点不通知)、不写 lastFiredAt(没真跑),只把
   * nextFireAt 短延 deferRetryMs 后重试。详见 scheduler.fireOne。
   */
  deferred?: boolean;
  /**
   * 顺延时距今多久后重试(ms)。engine 设 nextFireAt = finishedAt + deferRetryMs。
   * deferred=true 时必填(否则 nextFireAt 不前移会导致下个 tick 立刻再触发的忙循环)。
   */
  deferRetryMs?: number;
  /**
   * true = 本轮被前置检查脚本(preRunHook exit 2)拦截跳过:runner 未启动 agent、
   * 未消耗 token。engine 据此:把预插的 running run 改成 status='skipped'(带
   * readAt,生而已读、不通知不亮红点)、emit 'skipped' 事件,并**照常**按 recurring
   * 语义重排下一次触发(与 deferred 的短延重试不同——跳过就是这一轮的最终结果)。
   * sessionId 在跳过时为空串：本轮不创建或更新会话，跳过原因通过 resultText 保存。
   * resultText 可携带跳过原因摘要(脚本 stdout),落进 run 记录供历史回顾。
   */
  skipped?: boolean;
}

export interface ScheduleRunner {
  fire(schedule: Schedule, ctx: FireContext): Promise<FireResult>;
}
