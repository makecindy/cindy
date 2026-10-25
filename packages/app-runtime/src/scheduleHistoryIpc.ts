import { MAKER_INVOKE, MAKER_PUSH } from "@cindy/maker-shared/maker-channels";
import { requireString } from "@cindy/remote-agent/ipcValidate";
import type { Scheduler } from "@cindy/maker-scheduler";
import type { createScheduleStorage } from "./scheduleStorage.js";
import type { IpcHandlerRegistry } from "./ipcHandlerRegistry.js";
type Storage = InstanceType<
  ReturnType<typeof createScheduleStorage>["DrizzleScheduleStorage"]
>;
export function registerScheduleHistoryIpc(host: {
  ipcMain: IpcHandlerRegistry;
  withScheduler<T>(
    action: (host: { storage: Storage; scheduler: Scheduler }) => Promise<T>,
  ): Promise<T>;
  broadcast(channel: string, payload: unknown): void;
}) {
  const { ipcMain, withScheduler, broadcast } = host;
  ipcMain.handle(
    MAKER_INVOKE.SCHEDULE_LIST_RUNS,
    async (_e, scheduleId: unknown, limit: unknown) => {
      const id = requireString(scheduleId, "scheduleId");
      const lim =
        typeof limit === "number" && Number.isFinite(limit) ? limit : undefined;
      return withScheduler(({ scheduler }) => scheduler.listRuns(id, lim));
    },
  );

  // 一并回传引擎的 in-flight runId 快照:renderer 的通知抑制标记要靠它区分「DB 里查不到
  // 这条 run」的两种含义 —— 已结束并被清理,还是自删除场景下行已消失却仍在跑(见
  // scheduler.listInflightRunIds 的注释)。runId 本身不是特权数据(renderer 的标记里就
  // 存着它)。
  //
  // 注意这**不是**原子快照:两次读之间隔着 DB 查询的 await,run 恰好在那个窗口内结束时
  // 会出现「行还是 running、controller 已注销」。消费方(reconcileRunMarkers)能识别这种
  // 不一致并安排一次重查,所以这里不为它忙等重采样。
  ipcMain.handle(MAKER_INVOKE.SCHEDULE_LIST_SIDEBAR_INDEX_RUNS, async () =>
    withScheduler(async ({ storage, scheduler }) => ({
      runs: await storage.listSidebarIndexRuns(),
      inflightRunIds: scheduler.listInflightRunIds(),
      inflightPolicies: scheduler.listInflightRunPolicies(),
    })),
  );

  ipcMain.handle(MAKER_INVOKE.SCHEDULE_LIST_COST_SUMMARIES, async () => []);

  ipcMain.handle(
    MAKER_INVOKE.SCHEDULE_DELETE_RUN,
    async (_e, runId: unknown) => {
      const id = requireString(runId, "runId");
      return withScheduler(({ scheduler }) => scheduler.deleteRun(id));
    },
  );

  // Renderer 在 delete/pause 前查 in-flight 数量 —— >0 时弹合并文案的二次确认
  // ("该自动化有 N 次执行正在进行,...是否继续?")。本接口同步返回内存 Map 大小,
  // 不查 DB,几乎无延迟。
  ipcMain.handle(
    MAKER_INVOKE.SCHEDULE_GET_INFLIGHT_COUNT,
    async (_e, id: unknown) => {
      const scheduleId = requireString(id, "id");
      return withScheduler(({ scheduler }) =>
        Promise.resolve(scheduler.getInflightCount(scheduleId)),
      );
    },
  );

  // Renderer 首次进入页面时补取一次运行快照，避免错过更早广播的 runtime-state。
  ipcMain.handle(MAKER_INVOKE.SCHEDULE_GET_RUNTIME_STATE, async () =>
    withScheduler(({ scheduler }) =>
      Promise.resolve(scheduler.getRuntimeSnapshot()),
    ),
  );

  ipcMain.handle(MAKER_INVOKE.SCHEDULE_GET_UNREAD_COUNT, async () =>
    withScheduler(({ storage }) => storage.getUnreadRunCount()),
  );

  ipcMain.handle(MAKER_INVOKE.SCHEDULE_MARK_ALL_RUNS_READ, async () =>
    withScheduler(async ({ storage }) => {
      const updated = await storage.markAllUnreadRuns();
      // 仅在有真实更新时广播,避免 no-op 也触发下游 refetch。
      // 广播 'all-read' 而非 'read' —— 后者要求带 scheduleId,这里是全局清。
      if (updated > 0) {
        broadcast(MAKER_PUSH.SCHEDULE_EVENT, { type: "all-read" });
      }
      return updated;
    }),
  );

  ipcMain.handle(
    MAKER_INVOKE.SCHEDULE_MARK_RUN_READ,
    async (_e, runId: unknown) => {
      const id = requireString(runId, "runId");
      return withScheduler(async ({ storage }) => {
        const scheduleId = await storage.markRunRead(id);
        // markRunRead 已自带 "已读 / 非终态 / 不存在" 三种 no-op 短路;
        // 拿到 scheduleId 才广播 —— 让 useRuns 拉到带 readAt 的新 row、badge hook 重算总数。
        if (scheduleId) {
          broadcast(MAKER_PUSH.SCHEDULE_EVENT, { type: "read", scheduleId });
        }
      });
    },
  );

  ipcMain.handle(
    MAKER_INVOKE.SCHEDULE_MARK_SCHEDULE_RUNS_READ,
    async (_e, scheduleId: unknown) => {
      const id = requireString(scheduleId, "scheduleId");
      return withScheduler(async ({ storage }) => {
        const updated = await storage.markAllRunsRead(id);
        // 仅在有真实更新时广播,避免 no-op 也触发下游 refetch。
        if (updated > 0) {
          broadcast(MAKER_PUSH.SCHEDULE_EVENT, {
            type: "read",
            scheduleId: id,
          });
        }
        return updated;
      });
    },
  );
}
