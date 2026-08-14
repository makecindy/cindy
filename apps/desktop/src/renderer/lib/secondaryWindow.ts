/**
 * secondaryWindow —— 判断当前 renderer 是否运行在「在新窗口打开」开出来的副窗口里。
 *
 * 副窗口由 main/secondary-windows.ts 用启动参数 `?secondaryWindow=1` 打开(查询参数
 * 在 hash 之前,不影响 hash router 路由)。副窗口据此:
 *   - 默认折叠侧栏(MainLayout getInitialCollapsed)
 *   - 关闭按钮走"只关本窗"语义、跳过主窗那套退出确认(WindowControls)
 *
 * 单次读取启动 URL 即可,值在窗口生命周期内不变。
 */
export function isSecondaryWindow(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('secondaryWindow') === '1';
  } catch {
    return false;
  }
}

/**
 * 副窗口启动时要定位到的 sessionId(由 main/secondary-windows.ts 写进启动参数
 * `?bootSession=<id>`，可选 `?bootDevice=<id>`)。SecondaryWindowBootGate 读它,经
 * resolveSessionRoute 解析
 * 出 canonical route(普通 / Orca lead / worker)后再 navigate,避免 main 端写死
 * 单 session 路由导致 Orca 会话退化成单栏。
 *
 * 与 isSecondaryWindow 同样只读一次启动 URL,值在窗口生命周期内不变。
 */
export function getBootSessionId(): string | null {
  try {
    const id = new URLSearchParams(window.location.search).get('bootSession');
    return id && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** Device-link origin carried by a task drag into a secondary window. */
export function getBootDeviceId(): string | null {
  try {
    const id = new URLSearchParams(window.location.search).get('bootDevice');
    return id && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}
