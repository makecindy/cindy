/**
 * windowBehavior — 窗口交互行为相关的 IPC 通道 & 常量。
 *
 * 承载后台窗口点击行为、Windows 主窗口关闭行为,以及开机自启动与自启时的
 * 窗口呈现方式。
 *
 * Windows 上此开关由 renderer 层的 `swallowActivationClick.ts` 用 localStorage
 * 同步读取,toggle 即时生效。macOS 上因为等效能力(`acceptFirstMouse: false`)
 * 是 Electron BrowserWindow 的构造参数、只在窗口创建时读一次,renderer 更新
 * 后需要主进程 persist 到 userData,下次启动才生效——所以 renderer 每次改动
 * 都会通过下面这个 channel 通知 main 落盘,而 main 在创建主窗口时会读回。
 */

export const WINDOW_BEHAVIOR_SET_SWALLOW_ACTIVATION_CLICK_CHANNEL =
  'window-behavior:set-swallow-activation-click';

export type WindowsCloseBehavior = 'quit' | 'tray';

export const WINDOW_BEHAVIOR_GET_WINDOWS_CLOSE_BEHAVIOR_CHANNEL =
  'window-behavior:get-windows-close-behavior';
export const WINDOW_BEHAVIOR_SET_WINDOWS_CLOSE_BEHAVIOR_CHANNEL =
  'window-behavior:set-windows-close-behavior';
export const WINDOW_BEHAVIOR_WINDOWS_CLOSE_BEHAVIOR_REQUESTED_CHANNEL =
  'window-behavior:windows-close-behavior-requested';
export const WINDOW_BEHAVIOR_WINDOWS_CLOSE_BEHAVIOR_SHOWN_CHANNEL =
  'window-behavior:windows-close-behavior-shown';

export function isWindowsCloseBehavior(value: unknown): value is WindowsCloseBehavior {
  return value === 'quit' || value === 'tray';
}

/**
 * 开机自启动状态。`launchAtLogin` 是系统登录项的事实状态(由 main 侧向
 * Electron 查询,不自行持久化——用户可能在系统设置或任务管理器里改掉它);
 * `startInTrayOnLogin` 是我们自己的偏好,记在 window-behavior-settings.json。
 *
 * 两者独立:关掉自启动不清除 startInTrayOnLogin,用户重新打开自启动时保留
 * 原来的选择。
 */
export interface LaunchAtLoginState {
  launchAtLogin: boolean;
  startInTrayOnLogin: boolean;
}

export const WINDOW_BEHAVIOR_GET_LAUNCH_AT_LOGIN_CHANNEL =
  'window-behavior:get-launch-at-login';
export const WINDOW_BEHAVIOR_SET_LAUNCH_AT_LOGIN_CHANNEL =
  'window-behavior:set-launch-at-login';
export const WINDOW_BEHAVIOR_SET_START_IN_TRAY_ON_LOGIN_CHANNEL =
  'window-behavior:set-start-in-tray-on-login';
