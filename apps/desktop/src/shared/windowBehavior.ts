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
  'window-behavior:set-swallow-activation-click';

export type WindowsCloseBehavior = 'quit' | 'tray';
export type LinuxCloseBehavior = 'quit' | 'minimize';

export const WINDOW_BEHAVIOR_GET_WINDOWS_CLOSE_BEHAVIOR_CHANNEL =
  'window-behavior:get-windows-close-behavior';
export const WINDOW_BEHAVIOR_SET_WINDOWS_CLOSE_BEHAVIOR_CHANNEL =
  'window-behavior:set-windows-close-behavior';
export const WINDOW_BEHAVIOR_WINDOWS_CLOSE_BEHAVIOR_REQUESTED_CHANNEL =
  'window-behavior:windows-close-behavior-requested';
export const WINDOW_BEHAVIOR_WINDOWS_CLOSE_BEHAVIOR_SHOWN_CHANNEL =
  'window-behavior:windows-close-behavior-shown';
export const WINDOW_BEHAVIOR_GET_LINUX_CLOSE_BEHAVIOR_CHANNEL =
  'window-behavior:get-linux-close-behavior';
export const WINDOW_BEHAVIOR_SET_LINUX_CLOSE_BEHAVIOR_CHANNEL =
  'window-behavior:set-linux-close-behavior';
export const WINDOW_BEHAVIOR_LINUX_CLOSE_BEHAVIOR_REQUESTED_CHANNEL =
  'window-behavior:linux-close-behavior-requested';
export const WINDOW_BEHAVIOR_LINUX_CLOSE_BEHAVIOR_SHOWN_CHANNEL =
  'window-behavior:linux-close-behavior-shown';

/**
 * Title-bar X of the main window asks main to quit. Main reads the busy state itself and, in
 * the same call, either starts quitting or records that the renderer must confirm. Registered
 * with the window IPC at startup, so it answers during splash/login (no Maker yet = idle).
 */
export const WINDOW_BEHAVIOR_REQUEST_QUIT_CHANNEL = 'window-behavior:request-quit';

/**
 * The user's answer (boolean) in the title-bar quit confirmation. Main quits on `true` without
 * asking again only if it recorded that confirmation for this renderer; otherwise it runs its
 * own native confirmation.
 */
export const WINDOW_BEHAVIOR_RESOLVE_QUIT_CONFIRMATION_CHANNEL =
  'window-behavior:resolve-quit-confirmation';

/**
 * Main's reply to the title-bar quit channels: `quitting` (show the closing state), `confirm`
 * (show the in-app confirmation) or `none` (nothing to show; main kept the app running or
 * applied another close behavior).
 */
export type TitleBarQuitOutcome = 'quitting' | 'confirm' | 'none';

export function isWindowsCloseBehavior(value: unknown): value is WindowsCloseBehavior {
  return value === 'quit' || value === 'tray';
}

export function isLinuxCloseBehavior(value: unknown): value is LinuxCloseBehavior {
  return value === 'quit' || value === 'minimize';
}
