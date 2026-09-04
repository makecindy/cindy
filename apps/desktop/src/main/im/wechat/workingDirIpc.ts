/**
 * wechatBot 工作目录 IPC 的**固定 channel 注册层** — 业务体在
 * shared/channelWorkingDirIpc 工厂(与企微同构: generation 三处校验、两段式
 * 提交、日志脱敏), 这里只保留个人微信自己的 channel 名与可信 sender 边界。
 * channel 刻意不做成可配置: 每个渠道一份注册, 不产生通用注册器。
 */

import type { ChannelWorkingDirIpcHandlers } from '../shared/channelWorkingDirIpc';

/** ipcMain.handle 的最小投影 — 测试注入 fake, 不拉起 Electron。 */
export interface IpcHandleSink {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): unknown;
}

/**
 * 注册三个 wechatBot 工作目录 channel。**可信 sender 校验先于一切业务体**
 * (读设置 / 开弹窗 / 重置) — 与企微同一条安全边界, 不许静默回退。
 */
export function registerWechatWorkingDirIpc(options: {
  ipc: IpcHandleSink;
  handlers: ChannelWorkingDirIpcHandlers;
  /** main/im/index.ts 注入 assertTrustedAppRendererEvent。 */
  assertTrustedEvent(event: unknown): void;
}): void {
  const { ipc, handlers, assertTrustedEvent } = options;
  ipc.handle('wechatBot:get-channel-settings', (event) => {
    assertTrustedEvent(event);
    return handlers.getChannelSettings();
  });
  ipc.handle('wechatBot:choose-working-directory', (event) => {
    assertTrustedEvent(event);
    return handlers.chooseWorkingDirectory((event as { sender: unknown }).sender);
  });
  ipc.handle('wechatBot:reset-working-directory', (event) => {
    assertTrustedEvent(event);
    return handlers.resetWorkingDir();
  });
}
