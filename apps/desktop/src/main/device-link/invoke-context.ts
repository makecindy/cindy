/**
 * device-link invoke context.
 *
 * 被控端通过 dispatchLocalInvoke 复用本机 IPC handler。handler 需要知道当前调用
 * 是否来自 device-link 时，不能依赖 renderer 传入的 opts；这里用 async context
 * 给主进程内部做可信来源标记。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { isMobilePlatform } from './controllerPlatform';
import * as subscriptions from './subscriptions.js';

export interface DeviceLinkInvokeContext {
  controllerDeviceId: string;
  channel: string;
  /**
   * 控制端平台(presence 登记的 `PresenceSnapshot.platform`);未登记时 undefined。
   *
   * ⚠️ **只用于体验分流,不是安全 / 鉴权 / 权限边界**(review 修正)。两个字段的可信度
   * 不同,不要混为一谈:
   *  - `controllerDeviceId` 来自 server 填的 `env.src`(客户端传入值会被覆盖,见
   *    device-link-protocol 的 Envelope 注释),有服务端背书;
   *  - `controllerPlatform` 则是**对端设备在 hello 帧里自报**的值
   *    (`HelloPayload.platform`,client→server),经 relay 的 presence 广播进本机缓存。
   *    本仓没有任何服务端校验或覆盖逻辑,所以一台改过的同账号已配对设备可以声称
   *    自己是 `ios`。
   *
   * 它比控制端在每次 invoke 的 args / sendOpts 里现报要稳(不随单次调用摆动、由 presence
   * 统一维护),这就够用来决定"要不要多追加一段体验说明";但**不得**据它放行权限、
   * 跳过校验或做任何安全判定。
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
 * 当前调用是否来自**手机**控制端 —— **体验分流用,不是安全判据**(见
 * DeviceLinkInvokeContext.controllerPlatform 的说明)。
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

/**
 * 查询当前可信 device-link 控制端在 link-open / subscribe 中声明的能力。
 * 本地 IPC、缺少上下文或未知控制端均 fail closed。
 */
export function deviceLinkInvokeControllerSupports(capability: string): boolean {
  const context = storage.getStore();
  return (
    context !== undefined &&
    subscriptions.controllerSupports(context.controllerDeviceId, capability)
  );
}
