import type { Schedule, ScheduleRun, ListFilter } from '../types.js';

export interface ScheduleStorage {
  list(filter?: ListFilter): Promise<Schedule[]>;
  listActive(): Promise<Schedule[]>;
  get(id: string): Promise<Schedule | null>;
  insert(schedule: Schedule): Promise<Schedule>;
  update(id: string, patch: Partial<Schedule>): Promise<Schedule | null>;
  delete(id: string): Promise<void>;

  /**
   * 跨进程"认领"一次到点触发(多个 app 实例——如 dev / release 双开——共用同一
   * DB 时的互斥核心)。实现必须是**单条原子 compare-and-swap**:仅当该 schedule
   * 仍为 active 且 nextFireAt 仍等于 expectedNextFireAt(调用方内存里看到的值)
   * 时,把 nextFireAt 置空并返回更新后的行;否则(已被另一实例认领 / 已被改期 /
   * 已暂停删除)不做任何修改并返回 null,调用方据此放弃本次触发。
   * 认领后的 nextFireAt 由引擎在 run 结束时按 recurring 语义重排;进程中途崩溃
   * 留下的空 nextFireAt 由僵尸 run 清扫后的归一逻辑重新排期。
   */
  claimDueFire(id: string, expectedNextFireAt: number): Promise<Schedule | null>;

  /**
   * 原子认领一次自动触发并写入对应的 running run。多实例启动归一会用
   * running run 判断 nextFireAt=NULL 是否代表"另一个实例正在执行";因此
   * claim 与 running 行必须同事务可见,不能先清 nextFireAt 再晚些 insertRun。
   * 实现同时把 schedules.activeClaimRunId 写成 run.id 作为"这条 running run
   * 是自动 claim owner"的标记;手动 runNow 可更新 lastFiredAt,但不能覆盖 claim
   * 标记。自动 claim 不能提前写 lastFiredAt,否则崩溃的一次性任务会被当成已消费。
   */
  claimDueFireAndInsertRun(
    id: string,
    expectedNextFireAt: number,
    run: ScheduleRun,
  ): Promise<Schedule | null>;

  /**
   * Return IDs for currently running rows on one schedule. Startup and stale-run
   * cleanup use this only for legacy rows that predate activeClaimRunId.
   */
  listRunningRunIds(scheduleId: string): Promise<string[]>;

  /**
   * Complete a deferred automatic claim in one conditional write. The update must
   * only clear the active claim marker that belongs to `claimRunId`.
   */
  rescheduleDeferredAutomaticClaim(
    id: string,
    claimRunId: string,
    retryAt: number,
  ): Promise<Schedule | null>;

  /**
   * Complete an automatic claim while only allowing `claimRunId` to clear the
   * active claim marker or publish a new nextFireAt. Terminal timing/status
   * fields may still land for a stale owner so one-shot runs are not revived by
   * a concurrent stale-claim replan.
   */
  completeAutomaticClaim(
    id: string,
    claimRunId: string,
    firedAt: number,
    patch: Partial<Pick<Schedule, 'lastFinishedAt' | 'nextFireAt' | 'status'>>,
  ): Promise<Schedule | null>;

  /**
   * Normalize an active schedule whose automatic claim marker is still the same
   * orphan candidate observed by the scheduler. The implementation must be a
   * compare-and-swap so a finishing owner cannot interleave between the startup
   * running-row check and the re-arm write.
   */
  normalizeOrphanedAutomaticClaim(
    id: string,
    expectedActiveClaimRunId: string | undefined,
    nextFireAt: number,
  ): Promise<Schedule | null>;

  /**
   * Finish a deferred runNow while atomically preserving a live automatic claim
   * if one appeared after runNow read the schedule snapshot. `deferredFiredAt`
   * is the optimistic manual timestamp written by this deferred run; restore the
   * snapshot only while lastFiredAt still equals that value.
   */
  deferRunNowWithLiveClaimGuard(
    id: string,
    previousLastFiredAt: number | undefined,
    deferredFiredAt: number,
    retryAt: number,
  ): Promise<Schedule | null>;

  /**
   * Pause a schedule while atomically preserving a live automatic claim if its
   * activeClaimRunId points at a running row at the moment the pause commits.
   */
  pauseWithLiveClaimGuard(
    id: string,
    updatedAt: number,
  ): Promise<Schedule | null>;

  /**
   * Resume a schedule while atomically preserving a live automatic claim if its
   * activeClaimRunId still points at a running row. This prevents a remote owner
   * completing between a separate hasRunningRuns() read and the resume update.
   */
  resumeWithLiveClaimGuard(
    id: string,
    updatedAt: number,
    nextFireAt: number,
  ): Promise<Schedule | null>;

  insertRun(run: ScheduleRun): Promise<ScheduleRun>;
  updateRun(id: string, patch: Partial<ScheduleRun>): Promise<ScheduleRun | null>;
  listRuns(scheduleId: string, limit?: number): Promise<ScheduleRun[]>;
  /** Returns the deleted run for callers that want to know its scheduleId, or null if not found. */
  deleteRun(id: string): Promise<ScheduleRun | null>;

  /**
   * 僵尸 run 清理：把**心跳已过期**的 'running' run 改写为 'interrupted'。
   * 触发场景：app 在 run 跑到一半时被关闭/崩溃，进程被杀但 DB 行未走完
   * fireOne 的 finally 分支，残留 status='running'。Scheduler.start() 与
   * 运行期周期清扫都调本方法。
   *
   * 多实例共库安全约束（实现必须遵守）：
   *   - 只回收 `COALESCE(heartbeatAt, firedAt) < staleBefore` 的行——心跳仍新鲜
   *     说明另一个活实例正在执行，绝不能标 interrupted（会在对方 UI 里制造
   *     假失败红点 + errorMsg 残留）。
   *   - `excludeRunIds`（本进程 in-flight 的 runId）无条件跳过，作为"自己绝不
   *     清自己"的兜底——即使本进程心跳续期因挂起/卡顿而停摆。
   *   - `legacyStaleBefore` 控制 heartbeatAt 为 NULL 的行（老版本实例写入，它
   *     活着也永远不会续心跳）的独立过期窗口：设了 → NULL 行仅在
   *     `firedAt < legacyStaleBefore` 时回收（运行期清扫用远大于心跳窗口的阈值，
   *     避免把跨版本双开时对方正在跑的 run 误判成僵尸，同时保证真僵尸有界回收，
   *     不会永久卡死 busy probe——见 RUN_LEGACY_STALE_MS）；不设 → NULL 行按
   *     firedAt 与 `staleBefore` 兜底判定（启动清理，与老版本"启动收尸"对齐）。
   *   - 改写必须在 UPDATE 的 WHERE 里重查 status='running' + 过期条件（不能只凭
   *     先前 SELECT 的快照），避免与 owner 实例的正常收口写入竞态时把已完成的
   *     run 改回 interrupted。
   * 返回受影响 run 所属的 scheduleId 列表（已去重），调用方据此广播事件刷 UI。
   */
  markRunningAsInterrupted(
    staleBefore: number,
    excludeRunIds?: readonly string[],
    opts?: { legacyStaleBefore?: number },
  ): Promise<string[]>;

  /**
   * 为本进程 in-flight 的 run 续心跳（幂等，只动仍是 'running' 的行）。
   * 执行实例周期性调用；见 ScheduleRun.heartbeatAt。
   */
  touchRunHeartbeats(runIds: readonly string[], heartbeatAt: number): Promise<void>;

  /**
   * 是否存在 status='running' 的 run 行；传 scheduleId 则只查该 schedule 名下。
   * 清扫善后的"是否仍有活 run"不变量必须用本方法（无上限、按状态过滤），
   * 不能用 listRuns 的历史展示查询——它带条数上限，活跃 claim run 被更新的
   * runNow/终态行挤出窗口时会漏判（codex review P2）。
   */
  hasRunningRuns(scheduleId?: string, opts?: { runId?: string }): Promise<boolean>;
}
