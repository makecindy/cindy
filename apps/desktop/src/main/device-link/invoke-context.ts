/**
 * device-link invoke context.
 *
 * 被控端通过 dispatchLocalInvoke 复用本机 IPC handler。handler 需要知道当前调用
 * 是否来自 device-link 时，不能依赖 renderer 传入的 opts；这里用 async context
 * 给主进程内部做可信来源标记。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { sanitizeSourceName, type MessageSourceDevice } from '@cindy/maker-shared/message-source';

import { isDesktopPlatform, isMobilePlatform } from './controllerPlatform';
import * as subscriptions from './subscriptions.js';
import type { SharedTaskPeerCapture } from './sharedTaskDispatch.js';

export interface DeviceLinkInvokeContext {
  controllerDeviceId: string;
  channel: string;
  /** Host-verified sharedTask identity and revocation fence; never populated from wire args. */
  sharedTask?: SharedTaskPeerCapture;
  /** Shared only within this invoke; an admitted native mutation must finish or roll back. */
  sharedTaskSetting?: { admitted: boolean };
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
  /**
   * 被控端当时可见的控制端展示名快照(presence / 目录权威名优先,其次控制帧自报名)。
   * 只用于来源展示与发给模型的设备说明,不参与任何判定。
   */
  controllerName?: string;
  /** Captured before asynchronous dispatch checks; cannot mutate a replacement subscription. */
  historyView?: ReturnType<typeof subscriptions.prepareHistoryView>;
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
 * 当前 invoke 的远程设备来源,供 IPC 边界盖章到队列项 / 直连 sendOpts(`sourceDevice`)。
 *
 * 只认同账号控制端:共享任务访客(context.sharedTask)不是「用户在另一台设备上」,
 * 返回 undefined。平台未知同样返回 undefined(fail closed,与 isMobilePlatform 同口径)。
 * 本机 renderer 没有 context → undefined,本机输入因此不带设备来源。
 * **只用于归属展示与设备说明,不是权限判据。**
 */
export function readDeviceLinkInvokeSourceDevice(): MessageSourceDevice | undefined {
  const context = storage.getStore();
  if (!context || context.sharedTask) return undefined;
  const platform = isMobilePlatform(context.controllerPlatform)
    ? 'mobile'
    : isDesktopPlatform(context.controllerPlatform)
      ? 'desktop'
      : undefined;
  if (!platform || !context.controllerDeviceId) return undefined;
  const name = sanitizeSourceName(context.controllerName);
  return { deviceId: context.controllerDeviceId, platform, ...(name ? { name } : {}) };
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
