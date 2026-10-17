/**
 * partner-bridge/runtime.ts
 * ---------------------------------------------------------------------------
 * 依赖倒置的接线点:maker-ipc/register.ts 只负责把注入面放进来(setPartnerBridgeDeps),
 * 启停交给 bootstrap 的 app 生命周期(start / stop)。
 *
 * 为什么不在 register 里直接启动 register 发生在 splash 之后、登录之前,而端点
 * 文件与 owner 无关(服务只对本机同用户开放),放 bootstrap 能保证:
 *   1. before-quit 一定有机会收连接、删掉端点文件;
 *   2. 依赖还没接线时(早期启动、单测)不会起一个空服务。
 */

import { startPartnerBridge, type PartnerBridgeHandle } from './index.js';
import type { PartnerBridgeDeps } from './types.js';

let depsRef: PartnerBridgeDeps | null = null;
let handle: PartnerBridgeHandle | null = null;

/** maker-ipc 侧接线(幂等:重复调用以后来的为准,便于账号切换后重接)。 */
export function setPartnerBridgeDeps(deps: PartnerBridgeDeps): void {
  depsRef = deps;
}

export async function startPartnerBridgeRuntime(endpointDir: string): Promise<PartnerBridgeHandle | null> {
  if (!depsRef || handle) return handle;
  handle = await startPartnerBridge({ deps: depsRef, endpointDir });
  return handle;
}

export async function stopPartnerBridgeRuntime(): Promise<void> {
  const current = handle;
  handle = null;
  if (!current) return;
  try {
    await current.shutdown();
  } catch {
    /* 退出路径上的清理失败不再抛 */
  }
}

export const __testing = {
  reset(): void {
    depsRef = null;
    handle = null;
  },
  hasDeps(): boolean {
    return depsRef !== null;
  },
};
