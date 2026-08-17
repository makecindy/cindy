/**
 * secondary-windows —— 「在新窗口打开」会话多开功能的主进程侧。
 *
 * 对标 Codex 的多开:右键会话「在新窗口打开」→ 新建一个**完整 MainLayout 窗口**,
 * 启动即定位到该 session。每个窗口都是独立、完整的应用窗口(可拖动 / 触发系统贴边
 * 分屏),用户可以四角各钉一个会话同时盯多个 agent。
 *
 * 为什么这么简单:agent 事件早已通过 maker:event 广播给**所有** BrowserWindow
 * (见 maker-ipc/register.ts),新开的窗口加载同一 renderer 即自动同步消息流。所以
 * 多开本身基本是免费的 —— 本模块只负责"按启动参数建一个完整窗口"。
 *
 * 窗口里的标题栏窗口控件(min/max/close)复用主窗那套 TitleBar/WindowControls,
 * 配合 bootstrap-electron 里 window-minimize/maximize/close 改为按 event.sender
 * 解析目标窗口(主窗 close=app.quit、副窗 close=只关自己)。副窗启动参数带
 * `?secondaryWindow=1`,renderer 据此默认折叠侧栏 + 关闭走"只关本窗"语义。
 */

import { BrowserWindow, app, nativeTheme, screen, shell } from 'electron';
import path from 'node:path';
import { BRAND_NAME } from '@cindy/maker-shared/branding';

import { createLogger } from './logger.js';
import { installNewMakerWindowShortcut } from './app-shortcuts/new-maker-window-shortcut.js';
import { isAppContentWindow, markAppContentWindow } from './windowFocusClassifier.js';
import {
  isPointInsideAnyWindow,
  resolveWindowBoundsNearPoint,
  type ScreenPoint,
} from './windowBounds.js';
import { readWindowBehaviorSettings } from './window-behavior-settings-store.js';
import { resolveVibrancyConfig, type WindowsBackdropMaterial } from './vibrancyConfig.js';
import { installSelectionContextMenu } from './selection-context-menu.js';
import { applyAppearanceToWindow } from './appearance-settings-ipc.js';

const log = createLogger('secondary-windows');

// E4D:副窗 vibrancy 同主窗(lead 裁决副窗同处理)。持有副窗 set 供 applyVibrancyToSecondaryWindows 遍历。
const secondaryWindows = new Set<BrowserWindow>();

// 副窗相对主窗右下错开的像素,让用户一眼看出弹出了新窗(而非严丝合缝盖住主窗)。
const OFFSET_PX = 30;

// http(s) 外链一律丢给系统浏览器,与主窗 createWindow 的 will-navigate /
// setWindowOpenHandler 守卫保持一致(dev server origin 视为内部允许导航)。
// 导出供其它子窗口(right-sidebar-window)复用同一守卫。
export function installExternalLinkGuards(win: BrowserWindow): void {
  const devOrigin = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin
    : null;
  const isInternalUrl = (url: string): boolean => {
    if (!devOrigin) return false;
    try {
      return new URL(url).origin === devOrigin;
    } catch {
      return false;
    }
  };
  win.webContents.on('will-navigate', (event, url) => {
    if (isInternalUrl(url)) return;
    try {
      const protocol = new URL(url).protocol;
      if (protocol === 'http:' || protocol === 'https:') {
        event.preventDefault();
        void shell.openExternal(url);
      }
    } catch {
      // malformed URL — 不拦截
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternalUrl(url)) return { action: 'allow' };
    try {
      const protocol = new URL(url).protocol;
      if (protocol === 'http:' || protocol === 'https:') {
        void shell.openExternal(url);
      }
    } catch {
      // ignore
    }
    return { action: 'deny' };
  });
}

/**
 * 新开一个完整应用窗口并定位到指定 session。
 * @param mainWindow 主窗口,用来取当前 bounds 作为新窗初始大小(右下错开);可为 null。
 */
export function openSessionInNewWindow(
  sessionId: string,
  mainWindow: BrowserWindow | null,
  deviceId?: string | null,
  anchorPoint?: ScreenPoint,
): void {
  const createdAt = performance.now();
  // frame 配置复刻主窗(bootstrap-electron.ts createWindow): Mac 隐藏标题栏留红绿灯,
  // Windows 无边框 + 自绘标题栏。
  const platformOptions =
    process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 12, y: 16 } }
      : { frame: false };
  const bgColor = nativeTheme.shouldUseDarkColors ? '#1f1f1e' : '#f8f8f6';

  const base = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null;
  const requestedSize = base
    ? { width: base.width, height: base.height }
    : { width: 1280, height: 800 };
  const bounds = anchorPoint
    ? resolveWindowBoundsNearPoint(
        anchorPoint,
        requestedSize,
        screen.getDisplayNearestPoint(anchorPoint).workArea,
      )
    : base
      ? { x: base.x + OFFSET_PX, y: base.y + OFFSET_PX, ...requestedSize }
      : requestedSize;

  // 副窗同样读一次 window-behavior 设置,和主窗保持 acceptFirstMouse 一致——否则
  // macOS 上用户关掉开关重启后, 主窗一次点击透传但副窗仍被 Electron 默认 false
  // 吞掉, 同 app 内两类窗口体验不一致。
  const swallowActivationClick = readWindowBehaviorSettings().swallowActivationClick;

  const win = new BrowserWindow({
    ...bounds,
    minWidth: 800,
    minHeight: 600,
    title: BRAND_NAME,
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.join(__dirname, '../../resources/icon.png'),
    autoHideMenuBar: true,
    show: false,
    backgroundColor: bgColor,
    acceptFirstMouse: !swallowActivationClick,
    ...platformOptions,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false,
      // A task drag that misses a renderer drop target must never navigate the
      // application window to the dragged plain-text fallback.
      navigateOnDragDrop: false,
    },
  });
  markAppContentWindow(win);
  applyAppearanceToWindow(win);
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return;
    applyAppearanceToWindow(win);
  });
  installNewMakerWindowShortcut(win);
  installSelectionContextMenu(win);
  // E4D:副窗加入 set,供 vibrancy 动态开关;关闭时移除。
  secondaryWindows.add(win);
  win.once('closed', () => {
    secondaryWindows.delete(win);
  });

  installExternalLinkGuards(win);

  let shown = false;
  const showWindow = (trigger: 'did-finish-load' | 'ready-to-show'): void => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
    log.info('secondary window visible', {
      sessionId,
      trigger,
      elapsedMs: Math.round(performance.now() - createdAt),
    });
  };
  // The boot gate intentionally resolves the session route after the document
  // loads. Showing at did-finish-load lets the user see that the new window
  // was created while that async route/database work continues; ready-to-show
  // remains a fallback for platforms that do not emit the load event first.
  win.webContents.once('did-finish-load', () => showWindow('did-finish-load'));
  win.once('ready-to-show', () => showWindow('ready-to-show'));

  // 副窗启动参数:
  //   ?secondaryWindow=1   —— renderer 据此默认折叠侧栏 + 关闭只关本窗
  //   ?bootSession=<id>    —— 要定位到的 sessionId
  //   ?bootDevice=<id>     —— device-link 远程任务的归属设备(可选)
  // hash 固定落到中性的 /cc-agent/boot 网关路由(SecondaryWindowBootGate):由它
  // 在 renderer 侧调 resolveSessionRoute 解析出 canonical route(普通 / Orca lead /
  // worker)再 navigate。main 端**不**写死 /cc-agent/<id> —— 否则 Orca lead/worker
  // 会退化成单栏(main 不该复刻角色查询,角色路由解析单一来源留在 renderer)。
  const hash = '/cc-agent/boot';
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const url = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    url.searchParams.set('secondaryWindow', '1');
    url.searchParams.set('bootSession', sessionId);
    if (deviceId) url.searchParams.set('bootDevice', deviceId);
    url.hash = hash;
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), {
      query: {
        secondaryWindow: '1',
        bootSession: sessionId,
        ...(deviceId ? { bootDevice: deviceId } : {}),
      },
      hash,
    });
  }

  log.info('opened session in new window', { sessionId });
}

/**
 * Open a task only when the native drag ended outside every Cindy app window.
 * The cursor is queried in main so renderer coordinates cannot drift across
 * displays or browser zoom, and existing Cindy windows remain valid targets.
 */
export function openSessionInNewWindowIfDroppedOutside(
  sessionId: string,
  mainWindow: BrowserWindow | null,
  sourceWindow: BrowserWindow | null,
  deviceId?: string | null,
): boolean {
  const point = screen.getCursorScreenPoint();
  const appWindowBounds = BrowserWindow.getAllWindows()
    .filter((win) => isAppContentWindow(win) && win.isVisible() && !win.isMinimized())
    .map((win) => win.getBounds());
  if (isPointInsideAnyWindow(point, appWindowBounds)) return false;

  openSessionInNewWindow(sessionId, sourceWindow ?? mainWindow, deviceId, point);
  return true;
}

// E4D 毛玻璃(lead 裁决副窗同处理):遍历副窗 set,用同 resolveVibrancyConfig 映射
/**
 * 是不是本模块开出来的会话副窗口。
 *
 * 给 main 侧那些「只想放行承载应用外壳(router / MainLayout)的窗口」的闸用：副窗口跑的是
 * 同一套路由,设置页在里面照样打得开;而 appContentWindows 那个 WeakSet 还包含右侧栏、
 * Ghost 面板 —— 它们不承载路由,不该拿到这类能力。
 */
export function isSecondaryAppWindow(win: BrowserWindow | null | undefined): boolean {
  return Boolean(win && !win.isDestroyed() && secondaryWindows.has(win));
}

// 开关 vibrancy(仅 CINDY 透壁纸)。副窗 renderer 首帧/切 family 时 IPC theme:apply-vibrancy
// → main applyWindowVibrancy → 调主窗 + 本函数(副窗)。
export function applyVibrancyToSecondaryWindows(familyId: string, isDark: boolean): void {
  for (const win of secondaryWindows) {
    if (win.isDestroyed()) continue;
    const config = resolveVibrancyConfig(familyId, isDark, process.platform);
    if (process.platform === 'darwin') {
      win.setVibrancy(config.vibrancy as 'under-window' | null);
    }
    // Windows 11:副窗口与主窗口一致地应用 acrylic/mica 材质;切回非 CINDY family 时
    // config.backgroundMaterial 为 'none',显式复位,避免会话副窗口残留上一次的毛玻璃材质。
    if (process.platform === 'win32' && config.backgroundMaterial) {
      const withMaterial = win as typeof win & {
        setBackgroundMaterial?: (material: WindowsBackdropMaterial) => void;
      };
      withMaterial.setBackgroundMaterial?.(config.backgroundMaterial);
    }
    win.setBackgroundColor(config.backgroundColor);
  }
}
