/**
 * 侧栏任务上报（Work Louder 设备键位）的纯逻辑。
 *
 * 单独成模块有两个原因：
 * - 标题要在发出去之前按设备上限截断：主进程按同一上限校验，超长标题不是「丢这一条」，
 *   而是让**整份**任务列表被拒收 —— 一条超长标题就让其余任务都发不上去，设备键位全空。
 * - 上报内容会被反复重算（侧栏 DOM 每变一次就重算一次），所以要按内容去重；发布失败
 *   也不能因此反复重发，否则同一个 IPC 错误会被一次次抛出来（#9403：切换任务时每次
 *   都刷一串 `task title is too long`）。
 */
import {
  capWorkLouderTaskTitle,
  type WorkLouderCodexPublishedTask,
} from '../../../../shared/workLouderCodex';

/**
 * 上报入口。返回 Promise 表示已经发出；返回 undefined 表示这条通道根本不存在
 * （没接设备 / 当前平台没有这个集成），这时没有可失败的东西，直接记为「已处理」。
 */
export type SidebarTaskPublishFn = (
  tasks: WorkLouderCodexPublishedTask[],
) => Promise<unknown> | undefined;

/** 发布失败后的冷却：同一份内容最多每 30 秒重试一次，别把侧栏变成错误日志发生器。 */
export const SIDEBAR_TASK_RETRY_MS = 30_000;

export interface SidebarTaskPublisher {
  /** 上报这份任务行；内容没变时不打扰主进程。 */
  publish(tasks: WorkLouderCodexPublishedTask[]): void;
}

export function createSidebarTaskPublisher(deps: {
  publish: SidebarTaskPublishFn;
  /** 当前时间（毫秒）；测试注入固定时钟。 */
  now?: () => number;
}): SidebarTaskPublisher {
  const now = deps.now ?? Date.now;
  /** 最近一次「已经处理过」的内容指纹。 */
  let lastKey = '';
  /** 最近一次处理是否失败（失败才允许冷却后重试）。 */
  let lastFailed = false;
  let lastFailedAt = 0;
  /** 只认最后一次尝试的结果：更早的 promise 回来时不覆盖新状态。 */
  let attempt = 0;
  return {
    publish(tasks) {
      const capped = tasks.map((task) => ({
        ...task,
        title: task.title == null ? null : capWorkLouderTaskTitle(task.title),
      }));
      const key = JSON.stringify(capped);
      if (key === lastKey) {
        // 成功过就不再打扰主进程。
        if (!lastFailed) return;
        // 失败过也要等冷却结束：不能每次 DOM 变动都把同一个错误再抛一遍。
        if (now() - lastFailedAt < SIDEBAR_TASK_RETRY_MS) return;
      }
      const current = (attempt += 1);
      let result: Promise<unknown> | undefined;
      try {
        result = deps.publish(capped);
      } catch {
        lastKey = key;
        lastFailed = true;
        lastFailedAt = now();
        return;
      }
      // 通道不存在：没有可失败的东西，记为已处理，别让每次 DOM 变动都重算一遍。
      if (result === undefined) {
        lastKey = key;
        lastFailed = false;
        return;
      }
      lastKey = key;
      void result.then(
        () => {
          if (current === attempt) lastFailed = false;
        },
        () => {
          if (current === attempt) {
            lastFailed = true;
            lastFailedAt = now();
          }
        },
      );
    },
  };
}
