/**
 * 语音快捷键行上「监听权限」徽章的显示判定。
 *
 * 抽成纯函数是为了能被真正测到：这个条件决定用户在未授权时**能不能找到授权入口**，
 * 一旦收窄错就会退回「要授权得先设快捷键、设快捷键得先授权」的死锁，而那正是这条
 * 链路最初的 bug。
 */

export type InputMonitoringBadgeVisibilityInput = {
  /** Linux 首版不支持全局快捷键，整行都不显示。 */
  supportsGlobalShortcut: boolean;
  /** 已保存的快捷键是否需要原生监听器（裸修饰键 / 带 Fn 的组合）。 */
  shortcutNeedsPermission: boolean;
  /**
   * 录制期是否因缺权限拿不到 Fn 上报。Fn 不经 DOM 派发，未授权时录不进去、也就存不
   * 下来，所以不能只看已保存的快捷键——否则想改用 Fn 的用户永远等不到徽章出现。
   */
  fnRecordingBlocked: boolean;
  /** 权限快照状态；非 macOS 为 'not-required'。 */
  permissionStatus: string;
};

export function shouldShowInputMonitoringBadge(
  input: InputMonitoringBadgeVisibilityInput,
): boolean {
  if (!input.supportsGlobalShortcut) return false;
  // 非 macOS 压根不需要这个权限，显示只会造成困惑。
  if (input.permissionStatus === 'not-required') return false;
  return input.shortcutNeedsPermission || input.fnRecordingBlocked;
}
