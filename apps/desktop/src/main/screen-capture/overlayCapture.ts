import { BrowserWindow, desktopCapturer, ipcMain, screen } from 'electron';
import path from 'node:path';

import {
  SCREEN_CAPTURE_OVERLAY_CONTENT_READY_CHANNEL,
  SCREEN_CAPTURE_OVERLAY_INIT_CHANNEL,
  SCREEN_CAPTURE_OVERLAY_READY_CHANNEL,
  SCREEN_CAPTURE_OVERLAY_RESULT_CHANNEL,
  type ScreenCaptureOverlayInitPayload,
  type ScreenCaptureOverlayPalette,
  type ScreenCaptureOverlayRect,
  type ScreenCaptureOverlayResult,
} from '../../shared/screenCapture.js';
import { createLogger } from '../logger.js';
import { buildRegionCaptureOverlayHtml } from './overlayHtml.js';

/**
 * win/linux 区域截图: desktopCapturer 冻结光标所在显示器 → 全屏覆盖层窗口
 * 展示冻结帧 → 用户拖框 → main 按 scaleFactor 裁剪 PNG。
 *
 * 覆盖层是 main 自生成 HTML(overlayHtml, data: URL 加载) + 专用最小 preload
 * (regionCaptureOverlayPreload, 只暴露 ready/init/result), 不加载主 renderer
 * bundle 也不承载主窗口 bridge —— 一次性选区窗口按最小权限隔离(review P1)。
 *
 * darwin 不走本路径(系统 screencapture -i 体验更好且免自绘)。多显示器:
 * v1 只截光标所在显示器。Wayland 下 desktopCapturer 经 xdg-desktop-portal,
 * 系统可能先弹一次共享授权。
 */

const logger = createLogger('screen-capture-overlay');

/** 小于该 DIP 尺寸的"选区"按误点取消处理(与拖拽抖动区分)。 */
const MIN_SELECTION_DIP = 3;

interface OverlayCaptureOutcome {
  cancelled: boolean;
  data?: Buffer;
}

/** 覆盖层是纯本地工具窗口, 拒绝一切导航/弹窗。 */
function lockDownOverlayNavigation(overlay: BrowserWindow): void {
  overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  overlay.webContents.on('will-navigate', (event) => event.preventDefault());
}

/**
 * overlay → main 的选区结果运行时校验。IPC 不保留 TS 类型约束, 且本监听器
 * 在 ipcMain.on 里同步执行 —— 未捕获异常会被 lifecycle 视为 fatal 退出应用,
 * 必须先校验结构与有限数值再做任何算术/裁剪(review P1)。
 */
function parseOverlayResult(value: unknown): ScreenCaptureOverlayResult | null {
  if (!value || typeof value !== 'object') return null;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'cancel') return { kind: 'cancel' };
  if (kind !== 'select') return null;
  const rect = (value as { rect?: unknown }).rect;
  if (!rect || typeof rect !== 'object') return null;
  const { x, y, width, height } = rect as Record<string, unknown>;
  const nums = [x, y, width, height];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return {
    kind: 'select',
    rect: { x, y, width, height } as ScreenCaptureOverlayRect,
  };
}

export async function captureRegionViaOverlay(
  timeoutMs: number,
  hintText: string,
  palette: ScreenCaptureOverlayPalette,
): Promise<OverlayCaptureOutcome> {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const scaleFactor = display.scaleFactor || 1;
  const pixelSize = {
    width: Math.round(display.size.width * scaleFactor),
    height: Math.round(display.size.height * scaleFactor),
  };
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: pixelSize,
  });
  // 帧源必须能可靠对应到覆盖层所在显示器: display_id 匹配, 或"唯一源且物理
  // 显示器也唯一"(此时源只可能是这块屏)。仅凭 sources.length === 1 不够:
  // 多屏 Wayland/合并桌面后端可能只回一个空 display_id 的源, 它可以是 portal
  // 选中的另一块屏或整张虚拟桌面 —— 覆盖层在 A 屏展示 B 屏(或拉伸的合并)
  // 内容会让用户在不知情中附上非预期画面。无法可靠映射时不猜, 宁可失败走
  // renderer 的失败提示(review P1 两轮)。
  const matched = sources.find((s) => s.display_id === String(display.id)) ?? null;
  const source =
    matched ??
    (sources.length === 1 && screen.getAllDisplays().length === 1 ? sources[0] : null);
  if (!source) {
    throw new Error('cannot match a capture source to the active display');
  }
  const frame = source.thumbnail ?? null;
  if (!frame || frame.isEmpty()) {
    throw new Error('desktopCapturer returned no usable screen frame');
  }
  // Electron 不保证缩略图采用请求的 thumbnailSize —— 裁剪换算一律按"实际帧
  // 尺寸 / 显示器 DIP 尺寸"的横纵比例(下方 onResult), 不能固定用 scaleFactor。
  // 宽高比对不上说明帧根本不是这块屏(portal 回了别的屏/合并桌面), 拒绝,
  // 否则选区与附件内容会错位(review P1)。
  const frameSize = frame.getSize();
  const displayAspect = display.size.width / display.size.height;
  if (
    frameSize.width <= 0 ||
    frameSize.height <= 0 ||
    Math.abs(frameSize.width / frameSize.height - displayAspect) / displayAspect > 0.02
  ) {
    throw new Error('captured frame aspect ratio does not match the active display');
  }
  const scaleX = frameSize.width / display.size.width;
  const scaleY = frameSize.height / display.size.height;

  const overlay = new BrowserWindow({
    ...display.bounds,
    frame: false,
    transparent: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: true,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'regionCaptureOverlayPreload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      plugins: false,
      navigateOnDragDrop: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  lockDownOverlayNavigation(overlay);

  try {
    return await new Promise<OverlayCaptureOutcome>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const onResult = (event: Electron.IpcMainEvent, rawResult: unknown) => {
        // 只认覆盖层窗口本体; 其它 renderer 无法伪造选区结果。
        if (overlay.isDestroyed() || event.sender.id !== overlay.webContents.id) return;
        const result = parseOverlayResult(rawResult);
        if (!result || result.kind !== 'select') {
          // 取消, 或非法 payload(被注入的覆盖层已不可信)→ 一律安全拒绝。
          settle(() => resolve({ cancelled: true }));
          return;
        }
        const rect = result.rect;
        // DIP rect → 像素: 按实际帧与显示器的横纵比例分别换算(见上方 scaleX/Y
        // 注释), 再夹取到帧内。
        const px = {
          x: Math.max(0, Math.round(rect.x * scaleX)),
          y: Math.max(0, Math.round(rect.y * scaleY)),
          width: Math.round(rect.width * scaleX),
          height: Math.round(rect.height * scaleY),
        };
        px.width = Math.min(px.width, frameSize.width - px.x);
        px.height = Math.min(px.height, frameSize.height - px.y);
        if (
          rect.width < MIN_SELECTION_DIP ||
          rect.height < MIN_SELECTION_DIP ||
          px.width <= 0 ||
          px.height <= 0
        ) {
          settle(() => resolve({ cancelled: true }));
          return;
        }
        settle(() => resolve({ cancelled: false, data: frame.crop(px).toPNG() }));
      };

      const onClosed = () => settle(() => resolve({ cancelled: true }));
      // 一次性覆盖层 renderer 崩溃/无响应必须立即收口(review P2): 显示前崩溃
      // 会让 captureInFlight 静默挡掉后续截图直到总超时, 显示后崩溃则全屏
      // 置顶冻结画面一直遮住桌面。按真实失败 reject → 外层转稳定 IPC 错误
      // (固定消息) → renderer 失败提示; finally 统一销毁窗口。
      const onRendererGone = (_event: unknown, details: { reason?: string }) => {
        logger.warn('overlay renderer gone', { reason: details?.reason });
        settle(() => reject(new Error('overlay renderer gone')));
      };
      const onUnresponsive = () => {
        logger.warn('overlay renderer unresponsive');
        settle(() => reject(new Error('overlay renderer unresponsive')));
      };
      const timer = setTimeout(
        () => settle(() => resolve({ cancelled: true })),
        timeoutMs,
      );

      // 冻结帧等覆盖层脚本 announceReady 后再发 —— 避免加载完成与监听注册
      // 之间的发送竞态(先发必丢)。
      const onReady = (event: Electron.IpcMainEvent) => {
        if (settled || overlay.isDestroyed()) return;
        if (event.sender.id !== overlay.webContents.id) return;
        const payload: ScreenCaptureOverlayInitPayload = {
          imageDataUrl: frame.toDataURL(),
          displaySize: { width: display.size.width, height: display.size.height },
        };
        overlay.webContents.send(SCREEN_CAPTURE_OVERLAY_INIT_CHANNEL, payload);
      };

      // show() 等冻结帧 <img> 解码完成(loadURL resolve 只代表 HTML 加载完,
      // init 经 IPC 送达 + 大分辨率帧解码都在其后) —— 否则全屏置顶窗口先以
      // 纯黑出现, 用户可能在看不到屏幕内容时就开始选区(review P2)。解码
      // 失败由覆盖层报 cancel, 一直不就绪则由总超时兜底取消。
      const onContentReady = (event: Electron.IpcMainEvent) => {
        if (settled || overlay.isDestroyed()) return;
        if (event.sender.id !== overlay.webContents.id) return;
        overlay.show();
        overlay.focus();
      };

      const cleanup = () => {
        clearTimeout(timer);
        ipcMain.removeListener(SCREEN_CAPTURE_OVERLAY_RESULT_CHANNEL, onResult);
        ipcMain.removeListener(SCREEN_CAPTURE_OVERLAY_READY_CHANNEL, onReady);
        ipcMain.removeListener(SCREEN_CAPTURE_OVERLAY_CONTENT_READY_CHANNEL, onContentReady);
        overlay.removeListener('closed', onClosed);
        overlay.webContents.removeListener('render-process-gone', onRendererGone);
        overlay.webContents.removeListener('unresponsive', onUnresponsive);
      };

      ipcMain.on(SCREEN_CAPTURE_OVERLAY_RESULT_CHANNEL, onResult);
      ipcMain.on(SCREEN_CAPTURE_OVERLAY_READY_CHANNEL, onReady);
      ipcMain.on(SCREEN_CAPTURE_OVERLAY_CONTENT_READY_CHANNEL, onContentReady);
      overlay.on('closed', onClosed);
      overlay.webContents.on('render-process-gone', onRendererGone);
      overlay.webContents.on('unresponsive', onUnresponsive);

      const html = buildRegionCaptureOverlayHtml(hintText, palette);
      overlay
        .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
        .catch((err) => {
          logger.warn('overlay load failed', { err: String(err) });
          settle(() => reject(err instanceof Error ? err : new Error(String(err))));
        });
    });
  } finally {
    if (!overlay.isDestroyed()) overlay.destroy();
  }
}
