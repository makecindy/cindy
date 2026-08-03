/**
 * device-link invoke context.
 *
 * 被控端通过 dispatchLocalInvoke 复用本机 IPC handler。handler 需要知道当前调用
 * 是否来自 device-link 时，不能依赖 renderer 传入的 opts；这里用 async context
 * 给主进程内部做可信来源标记。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { isMobilePlatform } from './controllerPlatform';

export interface DeviceLinkInvokeContext {
  controllerDeviceId: string;
  channel: string;
  /**
   * 控制端平台(presence 登记的 `PresenceSnapshot.platform`);未登记时 undefined。
   *
   * 与 controllerDeviceId 一样属于**被控端自己盖的章** —— controllerDeviceId 来自
   * server 填的 `env.src`(客户端传入值会被覆盖,见 device-link-protocol 的 Envelope
   * 注释),platform 则由本机 presence 缓存按该 id 查出。控制端在线上帧里自报的任何
   * 字段(如 sendOpts)都不参与,所以不可伪造。
   */
  controllerPlatform?: string;
}

const storage = new AsyncLocalStorage<DeviceLinkInvokeContext>();

export function runDeviceLinkInvokeContext<T>(
  context: DeviceLinkInvokeContext,
  fn: () => T,
): T {
  return storage.run(context, fn);
}

export function getDeviceLinkInvokeContext(): DeviceLinkInvokeContext | null {
  return storage.getStore() ?? null;
}

export function isDeviceLinkInvoke(): boolean {
  return storage.getStore() !== undefined;
}

/**
 * 当前调用是否来自**手机**控制端。
 *
 * 本机 renderer 自己发的 invoke 不在 store 里 → false;另一台桌面作控制端 → platform
 * 是 `darwin`/`win32`/`linux` → false;presence 还没到、platform 未知 → 同样 false
 * (fail-closed,见 controllerPlatform.isMobilePlatform 的说明)。
 *
 * ⚠️ 只在**同一条 await 链**上有效。排队路径(maker:input:enqueue → coordinator 队列
 * → drain 派发)在 drain 时已脱离本上下文,读不到来源;那条路要覆盖需要把来源盖章在
 * 入队项上透传到 drain,属独立改动。
 */
export function isMobileControllerInvoke(): boolean {
  return isMobilePlatform(storage.getStore()?.controllerPlatform);
}
