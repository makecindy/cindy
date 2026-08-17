/**
 * resourceUsageWindow —— 判断当前 renderer 是否运行在资源用量独立子窗口里。
 *
 * main/resource-usage-window/window.ts 在启动 URL 上带
 * `?resourceUsageWindow=1`，hash 固定 `/resource-usage-window`。窗口身份在
 * renderer 生命周期内不变，用于跳过主窗口 Splash / env check / 退出流程。
 */
export function isResourceUsageWindow(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('resourceUsageWindow') === '1';
  } catch {
    return false;
  }
}
