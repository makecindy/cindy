/**
 * Application menu commands —— main 进程 build 菜单时 click handler 派发的指令,
 * 经 IPC channel 'app-menu:command' 送到 renderer, 由 MainLayout 的
 * onApplicationMenuCommand 监听处理。
 *
 * 单一事实来源: 此处的 const 数组同时供 main/preload/renderer 三端复用,
 *   - main: 派发指令字面量必须存在于此数组 (TS 推导兜底)
 *   - preload: isApplicationMenuCommand 做 runtime 白名单, 防止主进程被注入意外
 *     字符串穿透到 renderer (设计性安全边界, 不是冗余)
 *   - renderer: ElectronAPI.onApplicationMenuCommand 回调签名
 *
 * 新增命令时只改这里一处, 三端的类型与运行时校验自动跟随。
 */
export const APPLICATION_MENU_COMMANDS = [
  'open-about',
  'open-settings',
  'check-for-updates',
  'open-release-notes',
  'open-help',
  'open-issues',
  'open-agent-island-settings',
  'toggle-agent-island-sound',
  'new-maker',
  'new-maker-shortcut',
  'toggle-sidebar',
  // webview guest 内按 capture-region 快捷键时由 main(webview-security)转发,
  // 复用本 channel 送达 MainLayout 的全局区域截图入口。
  'capture-region',
] as const;

export type ApplicationMenuCommand = (typeof APPLICATION_MENU_COMMANDS)[number];

/** Mouse menu clicks keep the semantic New Maker action; only its accelerator is contextual. */
export function resolveNewMakerMenuCommand(
  triggeredByAccelerator: boolean | undefined,
): Extract<ApplicationMenuCommand, 'new-maker' | 'new-maker-shortcut'> {
  return triggeredByAccelerator ? 'new-maker-shortcut' : 'new-maker';
}

export function isApplicationMenuCommand(value: unknown): value is ApplicationMenuCommand {
  return (
    typeof value === 'string' &&
    (APPLICATION_MENU_COMMANDS as readonly string[]).includes(value)
  );
}
