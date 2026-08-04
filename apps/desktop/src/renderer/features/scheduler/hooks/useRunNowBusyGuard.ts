/**
 * useRunNowBusyGuard — runNow「派发窗口」busy 守卫
 * ---------------------------------------------------------------------------
 * 为什么存在：`schedule.runNow` 的 IPC(`window.electronAPI.maker.schedule.runNow`)
 * 要等 `runner.fire` 把整个 run 跑完才 resolve。对持续会话 / 长任务而言这可能是几分钟,
 * 甚至永不结束。如果把「立即运行」按钮的 disabled 绑定到该 promise 的生命周期(在
 * `finally` 里才解除 busy),按钮会在整个 run 期间卡在 disabled ——
 * 行按钮更糟：`disabled:opacity-50` 特异性高于 hover 才显示的 `opacity-0`,会让按钮在行
 * 未 hover 时也停在半透明,表现为用户反馈的「点击运行后按钮变半透明、不可点、且再也不消失」。
 *
 * 正确语义：busy 只需覆盖「点击 → run 真正 fire」这段**派发窗口**,防止首帧 setState
 * 重渲染前的双击 / 并发点击把同一 schedule 双发。一旦 run 已 fire,`runNow` 是 force-fire、
 * 本就允许并发,不该再锁按钮。
 *
 * 实现：
 *   - `begin(id)`：同步门控。已在派发窗口内返回 false(调用方据此忽略本次点击)。
 *   - 订阅 scheduler 事件：`runNowInner` 在 `await runner.fire` **之前**就 emit `'fired'`,
 *     所以点击后极短时间内 `'fired'` 到达即 release;任一终态(`completed` / `failed` /
 *     `deferred` / `skipped`)同样 release,兜住不经 `'fired'` 的分支。
 *   - `release(id)`：供「fire 前就抛错」(如 schedule 不存在,不会 emit `'fired'`)的本地兜底。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SchedulerEvent } from '@cindy/maker-scheduler';
import { isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';

export interface RunNowBusyGuard {
  /** 当前处于派发窗口内的 scheduleId 集合;驱动按钮 disabled。 */
  busyIds: ReadonlySet<string>;
  /** 进入派发窗口。已 busy 返回 false(应忽略本次触发),否则标记 busy 并返回 true。 */
  begin: (scheduleId: string) => boolean;
  /** 手动退出派发窗口(fire 前抛错的兜底;正常路径由 'fired' 事件自动 release)。 */
  release: (scheduleId: string) => void;
}

export function useRunNowBusyGuard(): RunNowBusyGuard {
  // ref 做同步真值(begin 立即可见,防首帧双击);state 仅用于驱动下游 UI 重渲染。
  const ref = useRef<Set<string>>(new Set());
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());

  const begin = useCallback((scheduleId: string): boolean => {
    if (ref.current.has(scheduleId)) return false;
    ref.current.add(scheduleId);
    setBusyIds(new Set(ref.current));
    return true;
  }, []);

  const release = useCallback((scheduleId: string) => {
    if (ref.current.delete(scheduleId)) {
      setBusyIds(new Set(ref.current));
    }
  }, []);

  // 'fired'(run 已派发)或任一终态到达即释放对应 schedule 的守卫 —— 不等 run 跑完。
  // 已知行为（两种场景，均因 runNow 是 force-fire/允许并发而影响有限）：
  // 场景 A：cron 定时触发与用户点击并发——用户刚点击（begin 已标记 busy），cron 恰好为同
  //   一 scheduleId 触发并 emit 'fired'，guard 提前 release，允许用户在第一次 runNow IPC
  //   途中发起第二次点击。
  // 场景 B：旧 run 的终态事件与新点击并发——同一 scheduleId 有旧 run 仍在运行，旧 run 的
  //   终态事件（completed/failed 等）在新点击的 runNow IPC 尚未收到 'fired' 前到达，guard
  //   提前 release。此时用户若再点击是第二次独立有意操作，不构成同一次意图双发问题。
  // 两种场景都属可接受的已知行为。
  useEffect(() => {
    const off = window.electronAPI.maker.schedule.onEvent((raw, ownerStamp) => {
      if (!isDataOwnerPushCurrent(ownerStamp)) return;
      const ev = raw as SchedulerEvent;
      if (
        ev.type === 'fired' ||
        ev.type === 'completed' ||
        ev.type === 'failed' ||
        ev.type === 'deferred' ||
        ev.type === 'skipped'
      ) {
        release(ev.scheduleId);
      }
    });
    return off;
  }, [release]);

  return { busyIds, begin, release };
}
