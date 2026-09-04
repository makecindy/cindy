/**
 * wecomBot 工作目录 IPC 的**固定 channel 注册层** — 业务体在
 * shared/channelWorkingDirIpc 工厂(渠道差异经 updateFailedCode/channelLabel
 * 显式注入, generation 三处校验与日志脱敏都在那里), 这里只保留企微自己的
 * channel 名与可信 sender 边界, 便于免 Electron 的注册级测试。channel 刻意
 * 不做成可配置: 每个渠道一份注册, 不产生通用注册器。
 */

import type { ChannelWorkingDirIpcHandlers } from '../shared/channelWorkingDirIpc';

/** ipcMain.handle 的最小投影 — 测试注入 fake, 不拉起 Electron。 */
export interface IpcHandleSink {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): unknown;
}

/**
 * 注册三个 wecomBot 工作目录 channel。**可信 sender 校验先于一切业务体**
 * (读设置 / 开弹窗 / 重置) — 这条安全边界由 workingDirIpc.test 的回归用例
 * 锁住, 不许静默回退。
 */
export function registerWecomWorkingDirIpc(options: {
  ipc: IpcHandleSink;
  handlers: ChannelWorkingDirIpcHandlers;
  /** main/im/index.ts 注入 assertTrustedAppRendererEvent。 */
  assertTrustedEvent(event: unknown): void;
}): void {
  const { ipc, handlers, assertTrustedEvent } = options;
  ipc.handle('wecomBot:get-channel-settings', (event) => {
    assertTrustedEvent(event);
    return handlers.getChannelSettings();
  });
  ipc.handle('wecomBot:choose-working-directory', (event) => {
    assertTrustedEvent(event);
    return handlers.chooseWorkingDirectory((event as { sender: unknown }).sender);
  });
  ipc.handle('wecomBot:reset-working-directory', (event) => {
    assertTrustedEvent(event);
    return handlers.resetWorkingDir();
  });
}
