/**
 * invoke-registry —— 全局捕获 ipcMain.handle,建立 channel → handler 映射,
 * 供 device-link 被控端把远程 invoke dispatch 到本机既有 handler。
 *
 * 为什么 monkey-patch:全仓 300+ 处 ipcMain.handle 散落 40+ 文件,逐个改造成
 * 可注入 registry 不现实且 diff 巨大(规则 3 surgical)。这里在**任何 handler
 * 注册之前**(main/index.ts 最早期)替换 ipcMain.handle:记录映射后转调原实现,
 * 对所有注册点零侵入、行为零变化。
 *
 * dispatchLocalInvoke 用一个合成的 IpcMainInvokeEvent 调 handler——device-link
 * allowlist 已剔除一切依赖 event.sender / 窗口的 channel(见 allowlist.ts 准入判据),
 * 故合成 event 的 sender 等字段为占位即可。
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { createLogger } from '../logger';
import { IPC_CHANNELS } from '@cindy/cindy-ipc';

const log = createLogger('device-link-invoke-registry');

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const handlers = new Map<string, InvokeHandler>();
let installed = false;

/** 启动期至少应捕获到的 handler 数下限——低于此值说明 patch 装晚了,告警便于排查 */
const MIN_EXPECTED_HANDLERS = 50;

/**
 * 关键哨兵 channel:这些必须被捕获,否则远程控制核心链路(新建/发消息/列会话)直接失效。
 * 比单纯的数量阈值更能定位「patch 装晚了」——数量可能因后续增删而漂移,哨兵语义稳定。
 */
const SENTINEL_CHANNELS: readonly string[] = [
  IPC_CHANNELS.MAKER_INVOKE.CREATE_SESSION,
  IPC_CHANNELS.MAKER_INVOKE.SEND,
  IPC_CHANNELS.LOCAL_DB.SESSIONS_LIST,
];

/**
 * 安装 ipcMain.handle 捕获包装。必须在任何 ipcMain.handle 调用之前执行一次
 * (main/index.ts 入口最早期)。幂等:重复调用忽略。
 */
export function installInvokeCapture(): void {
  if (installed) return;
  installed = true;

  const original = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = ((channel: string, listener: InvokeHandler) => {
    handlers.set(channel, listener);
    return original(channel, listener);
  }) as typeof ipcMain.handle;

  // removeHandler 也同步清映射,避免重注册后映射指向旧 handler
  const originalRemove = ipcMain.removeHandler.bind(ipcMain);
  ipcMain.removeHandler = ((channel: string) => {
    handlers.delete(channel);
    return originalRemove(channel);
  }) as typeof ipcMain.removeHandler;

  log.info('ipcMain.handle capture installed');
}

/** 启动完成后调用,断言捕获符合预期(装晚了会缺哨兵 channel / 数量显著偏低) */
export function assertCaptureHealthy(): void {
  const missing = SENTINEL_CHANNELS.filter((c) => !handlers.has(c));
  if (missing.length > 0) {
    // 哨兵缺失 = 几乎可以确定 patch 装晚了:这些核心 channel 的远程 dispatch 会直接坏掉
    log.error(
      `invoke capture missing critical channels: ${missing.join(', ')} — ` +
        'installInvokeCapture ran too late; remote control dispatch is broken for these',
    );
  }
  if (handlers.size < MIN_EXPECTED_HANDLERS) {
    log.warn(
      `invoke capture only saw ${handlers.size} handlers (expected >= ${MIN_EXPECTED_HANDLERS}); ` +
        'installInvokeCapture may have run too late — remote control dispatch will be incomplete',
    );
  } else if (missing.length === 0) {
    log.info(`invoke capture healthy: ${handlers.size} handlers registered`);
  }
}

/**
 * 用合成 event dispatch 到本机 handler。handler 不存在 / 已注销时抛错,
 * 由调用方(dispatch.ts)转成 invoke-result 的 error 回传控制端。
 */
export async function dispatchLocalInvoke(channel: string, args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`[NOT_FOUND] no local IPC handler for channel '${channel}'`);
  }
  const syntheticEvent = {
    // device-link allowlist 已排除所有依赖 sender / 窗口的 channel,占位即可
    sender: undefined,
    frameId: -1,
    processId: -1,
  } as unknown as IpcMainInvokeEvent;
  return await handler(syntheticEvent, ...args);
}

export const __testing = {
  reset(): void {
    handlers.clear();
    installed = false;
  },
  register(channel: string, handler: InvokeHandler): void {
    handlers.set(channel, handler);
  },
  size: () => handlers.size,
};
