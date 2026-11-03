/**
 * sidebarTabWindow —— 判断当前 renderer 是否运行在「右侧栏单页签独立窗口」里。
 *
 * 弹出窗口由 main/sidebar-tab-window/window.ts 用启动参数
 * `?sidebarWindow=1&sidebarTabWindow=1` 打开:`sidebarWindow=1` 让它沿用整栏子窗口
 * 的全部「我不是主窗」语义(isSidebarWindow:登录 / 环境检查 / 不可导航主路由等),
 * `sidebarTabWindow=1` 再把 renderer 入口分流到 SidebarTabWindowLayout(只挂一个页签)。
 *
 * 与 sidebarWindow.ts 同款:单次读取启动 URL,值在窗口生命周期内不变。
 */
export function isSidebarTabWindow(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('sidebarTabWindow') === '1';
  } catch {
    return false;
  }
}
