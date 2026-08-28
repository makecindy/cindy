/**
 * launchAtLogin —— 开机自启动的登录项管理与「自启时收起到托盘」的判定。
 *
 * ## 为什么用 argv 标记而不是 Electron 的 wasOpenedAtLogin
 *
 * `app.getLoginItemSettings().wasOpenedAtLogin` 只在 macOS 上有值,Windows 上
 * 恒为 false(Electron 文档明确标注 macOS only)。所以注册登录项时我们自己
 * 追加 `--opened-at-login`,启动时从 argv 判定本次是否来自登录项——这条路径
 * 两个平台同构,也不依赖 Electron 未来是否补齐该字段。
 *
 * 标记参数只加在登录项的命令行里:用户从开始菜单、桌面快捷方式或命令行手动
 * 启动时 argv 里没有它,窗口照常显示。
 *
 * ## 为什么不自己写注册表
 *
 * `app.setLoginItemSettings()` 在 Windows 上写 HKCU\...\CurrentVersion\Run,
 * 并且带上正确的可执行文件路径与工作目录。手写注册表容易漏掉 Squirrel/NSIS
 * 安装布局下的 Update.exe 间接层,升级后路径失效;更常见的用户错误是把
 * Cindy.exe 复制进启动目录——脱离安装目录后 Electron 找不到 icudtl.dat 等
 * 运行时文件,启动直接崩(见 issue #3568)。交给 Electron 处理这些细节。
 */

/** 登录项命令行里的自启动标记。 */
export const OPENED_AT_LOGIN_FLAG = '--opened-at-login';

/** Electron `app` 的登录项相关子集,便于单测替身。 */
export interface LoginItemApp {
  getLoginItemSettings(): { openAtLogin: boolean };
  setLoginItemSettings(settings: {
    openAtLogin: boolean;
    args?: string[];
    enabled?: boolean;
  }): void;
}

/** 本次进程是否由登录项拉起。 */
export function wasOpenedAtLogin(argv: readonly string[]): boolean {
  return argv.includes(OPENED_AT_LOGIN_FLAG);
}

/**
 * 决定主窗口首帧是否跳过 show。
 *
 * 四个条件全部成立才隐藏——任一不成立都必须正常显示窗口:
 *  - 平台是 Windows(托盘常驻语义与 macOS 的 Dock 不同,该功能只做 Windows);
 *  - 本次是登录项拉起(用户手动双击图标时必须弹窗,否则会以为没启动成功);
 *  - 用户开了 startInTrayOnLogin;
 *  - 托盘图标确实创建成功。
 *
 * ⚠️ 最后一条是安全边界,不能省。`ensureWindowsTray()` 会因为图标资源缺失等
 * 原因失败并返回 false;那时若仍跳过 show,用户既没有窗口也没有托盘图标,
 * 只剩任务管理器可用。宁可多显示一个窗口,也不能让应用变成不可操作的幽灵
 * 进程。调用方必须把 ensureTray 的真实返回值传进来,不要传常量 true。
 */
export function shouldStartHiddenInTray(input: {
  platform: NodeJS.Platform;
  argv: readonly string[];
  startInTrayOnLogin: boolean;
  ensureTray: () => boolean;
}): boolean {
  if (input.platform !== 'win32') return false;
  if (!wasOpenedAtLogin(input.argv)) return false;
  if (!input.startInTrayOnLogin) return false;
  // 放在最后:前三条都不满足时不该有建托盘的副作用。
  return input.ensureTray();
}

/** 读取系统登录项的当前状态。查询失败按「未启用」处理。 */
export function readLaunchAtLogin(app: LoginItemApp): boolean {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

/**
 * 写入系统登录项。返回写入后重新查询到的事实状态,便于调用方回传给 renderer
 * 做乐观更新的纠偏——用户可能没有权限改登录项,那时 UI 要退回真实值。
 */
export function writeLaunchAtLogin(app: LoginItemApp, openAtLogin: boolean): boolean {
  app.setLoginItemSettings({
    openAtLogin,
    // 关闭时也要传 args:Electron 用 (path, args) 一起定位既有登录项,漏传会
    // 留下一条我们再也匹配不到的孤儿项,用户看起来"关不掉"。
    args: [OPENED_AT_LOGIN_FLAG],
    enabled: openAtLogin,
  });
  return readLaunchAtLogin(app);
}
