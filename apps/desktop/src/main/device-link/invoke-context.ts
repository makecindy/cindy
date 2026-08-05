/**
 * device-link invoke context.
 *
 * 被控端通过 dispatchLocalInvoke 复用本机 IPC handler。handler 需要知道当前调用
 * 是否来自 device-link 时，不能依赖 renderer 传入的 opts；这里用 async context
 * 给主进程内部做可信来源标记。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface DeviceLinkInvokeContext {
  controllerDeviceId: string;
  channel: string;
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
