import { IPC_CHANNELS } from '@cindy/cindy-ipc';

/**
 * windowBehavior — 窗口交互行为相关的 IPC 通道 & 常量。
 *
 * 承载后台窗口点击行为和 Windows 主窗口关闭行为。
 *
 * Windows 上此开关由 renderer 层的 `swallowActivationClick.ts` 用 localStorage
 * 同步读取,toggle 即时生效。macOS 上因为等效能力(`acceptFirstMouse: false`)
 * 是 Electron BrowserWindow 的构造参数、只在窗口创建时读一次,renderer 更新
 * 后需要主进程 persist 到 userData,下次启动才生效——所以 renderer 每次改动
 * 都会通过下面这个 channel 通知 main 落盘,而 main 在创建主窗口时会读回。
 */

export const WINDOW_BEHAVIOR_SET_SWALLOW_ACTIVATION_CLICK_CHANNEL =
  IPC_CHANNELS.WINDOW_BEHAVIOR.SET_SWALLOW_ACTIVATION_CLICK;

export type WindowsCloseBehavior = 'quit' | 'tray';

export const WINDOW_BEHAVIOR_GET_WINDOWS_CLOSE_BEHAVIOR_CHANNEL =
  IPC_CHANNELS.WINDOW_BEHAVIOR.GET_WINDOWS_CLOSE_BEHAVIOR;
export const WINDOW_BEHAVIOR_SET_WINDOWS_CLOSE_BEHAVIOR_CHANNEL =
  IPC_CHANNELS.WINDOW_BEHAVIOR.SET_WINDOWS_CLOSE_BEHAVIOR;
export const WINDOW_BEHAVIOR_WINDOWS_CLOSE_BEHAVIOR_REQUESTED_CHANNEL =
  IPC_CHANNELS.WINDOW_BEHAVIOR.WINDOWS_CLOSE_BEHAVIOR_REQUESTED;
export const WINDOW_BEHAVIOR_WINDOWS_CLOSE_BEHAVIOR_SHOWN_CHANNEL =
  IPC_CHANNELS.WINDOW_BEHAVIOR.WINDOWS_CLOSE_BEHAVIOR_SHOWN;

export function isWindowsCloseBehavior(value: unknown): value is WindowsCloseBehavior {
  return value === 'quit' || value === 'tray';
}
