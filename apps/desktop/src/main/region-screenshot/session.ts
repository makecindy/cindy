import {
  clipboard,
  nativeImage,
  screen,
  systemPreferences,
  type Display,
  type NativeImage,
  type WebContents,
} from 'electron';
import { randomUUID } from 'node:crypto';

import { createLogger } from '../logger';
import { getResolvedMainLocale } from '../i18n';
import { acquireOverlayEscape } from '../overlayEscape';
import { throwIpcError } from '../utils/ipcValidate';
import { recordingControlsBounds, scrollCaptureLayout, scrollPreviewBounds, validRecordingBytes, type ScrollCaptureLayout, type RegionCaptureBegin, type RegionCaptureFrame, type RegionCaptureMode } from '../../shared/regionCapture';
import { captureLiveRegion, RegionVideoCapture } from './liveCapture';
import { saveRegionRecording } from './save';
import {
  intersectRegion,
  isRegionScreenshotAction,
  normalizeRegionSelection,
  regionChromeArea,
  regionSelectionToImageCrop,
  REGION_SCREENSHOT_CHANNEL,
  validateRegionBitmap,
  type RegionRect,
  type RegionScreenshotAction,
  type RegionScreenshotBegin,
  type RegionScreenshotBitmap,
  type RegionScreenshotWindow,
  type RegionScreenshotHit,
} from '../../shared/regionScreenshot';
import { hideScreenshotOverlay, showScreenshotOverlay, type OverlayPool, type OverlayWindow } from './overlays';
import type { SnapshotHelper, SnapshotWindow } from './snapshotHost';

const log = createLogger('region-screenshot:session');

/** 未绘制的浮层最多等这么久，超时隐藏并退出，不能强行展示黑屏。 */
const REVEAL_FALLBACK_MS = 1500;
const MAX_COLOR_TEXT = 64;

export interface DisplayCapture {
  display: Display;
  /** 定格原图 (desktopCapturer 缩略图), 浮层显示与最终导出的唯一来源。 */
  image: NativeImage;
}

export interface RegionScreenshotResult {
  ownerScope?: string;
  action: RegionScreenshotAction;
  image: NativeImage;
  display: Display;
  /** 选区 (显示器内 DIP)。 */
  selection: RegionRect;
}

interface Member {
  overlay: OverlayWindow;
  capture: DisplayCapture;
  painted: boolean;
}

export interface RegionScreenshotSessionDeps {
  pool: OverlayPool;
  captures: readonly DisplayCapture[];
  helper: SnapshotHelper;
  /** 定格时的窗口列表 (识别程序的坐标系), 下标即页面看到的窗口 id。 */
  windows: readonly SnapshotWindow[];
  lastRegions: ReadonlyMap<number, RegionRect>;
  /** macOS: 每块显示器顶部被刘海占用的高度 (DIP), 按 Display.id。 */
  topInsets?: ReadonlyMap<number, number>;
  onResult: (result: RegionScreenshotResult) => void;
  openEditor?: (image: RegionScreenshotBitmap, display: Display, selection: RegionRect) => boolean;
  openRecording?: (bytes: Uint8Array<ArrayBuffer>, format: 'webm' | 'gif', display: Display) => boolean;
  onClosed: () => void;
}

/** 识别程序的矩形 → 全局 DIP。Windows 程序按物理像素回报, macOS 已是 DIP。 */
function toGlobalDip([left, top, right, bottom]: SnapshotWindow['rect']): RegionRect {
  const rect = { x: left, y: top, width: right - left, height: bottom - top };
  return process.platform === 'win32' ? screen.screenToDipRect(null, rect) : rect;
}

function toLocal(rect: RegionRect, display: Display): RegionRect {
  return { ...rect, x: rect.x - display.bounds.x, y: rect.y - display.bounds.y };
}

/**
 * 一次框选截图: 每块已定格的显示器借用一个预热浮层, 用户在其中一块上完成选区与
 * 标注后, 页面把最终图交回来, 会话结束后隐藏并销毁浮层, 再执行动作。一次性对象。
 */
export class RegionScreenshotSession {
  readonly token = randomUUID();
  private readonly members = new Map<number, Member>();
  private closed = false;
  private handedToEditor = false;
  private exporting = false;
  private videoCapture: RegionVideoCapture | null = null;
  private recordingControls: RegionRect | null = null;
  private draggingControls = false;
  private live: { member: Member; selection: RegionRect; mode: RegionCaptureMode; sampling: boolean; lastSample: number; editing: boolean; layout: ScrollCaptureLayout | null; automatic: boolean; target: SnapshotWindow | null; targetResolved: boolean; ignoring: boolean; previewHeight: number } | null = null;
  private scrollPointerTimer: ReturnType<typeof setInterval> | null = null;
  private revealTimer: ReturnType<typeof setTimeout> | null = null;
  private releaseEscapeShortcut: (() => void) | null = null;
  private readonly onDisplaysChanged = () => {
    log.info('displays changed during screenshot, cancelling');
    this.close();
  };
  private readonly onDisplayMetricsChanged = (
    _event: Electron.Event,
    _display: Display,
    metrics: string[],
  ) => {
    if (metrics.some((metric) => ['bounds', 'scaleFactor', 'rotation'].includes(metric)))
      this.onDisplaysChanged();
  };

  constructor(private readonly deps: RegionScreenshotSessionDeps) {}

  get isClosed(): boolean {
    return this.closed;
  }

  get hasEditor(): boolean { return this.handedToEditor; }

  /** 打开浮层; 一块屏都没准备好时返回 false 并结束会话。 */
  async open(): Promise<boolean> {
    screen.on('display-added', this.onDisplaysChanged);
    screen.on('display-removed', this.onDisplaysChanged);
    screen.on('display-metrics-changed', this.onDisplayMetricsChanged);
    const locale = getResolvedMainLocale();
    const cursor = screen.getCursorScreenPoint();
    // Start all cold shells together: one slow display must not defer creation
    // (or restart the timeout budget) of every subsequent display. Keep capture
    // order when registering members, and retain the all-screens geometry barrier.
    const prepared = await Promise.all(this.deps.captures.map(async (capture) => {
      if (this.closed) return null;
      const overlay = this.deps.pool.ensure(capture.display);
      if (!overlay || !(await this.deps.pool.waitForShell(overlay))) return null;
      return { overlay, capture };
    }));
    if (this.closed) return false;
    for (const member of prepared) {
      if (!member || member.overlay.window.isDestroyed()) continue;
      const { overlay, capture } = member;
      this.members.set(overlay.window.webContents.id, { overlay, capture, painted: false });
    }
    if (this.members.size === 0) {
      log.warn('no overlay became ready');
      this.close();
      return false;
    }
    // 先以全透明显示: 页面在可见状态下才会合成新画面, 画完 (PAINTED) 再显示,
    // 避免闪出上一次截图残留的合成帧或底色。
    for (const { overlay, capture } of this.members.values()) {
      const { window } = overlay;
      window.setOpacity(0);
      window.setBounds(capture.display.bounds, false);
      showScreenshotOverlay(window);
      // 混合 DPI 下首次定位可能按错误的缩放落位, 显示后按显示器 bounds 再校正一次。
      window.setBounds(capture.display.bounds, false);
    }
    this.revealTimer = setTimeout(() => this.reveal(), REVEAL_FALLBACK_MS);
    this.holdEscape();
    // 所有屏幕的位置稳定后才发送画面。否则快的 renderer 会在另一块屏还等
    // SHELL_READY 时提前 PAINTED / reveal，随后又被隐藏、定位，造成整屏跳动。
    for (const { overlay, capture } of this.members.values()) {
      overlay.window.webContents.send(
        REGION_SCREENSHOT_CHANNEL.BEGIN,
        this.beginPayload(capture, locale, cursor),
      );
    }
    return true;
  }

  private holdEscape(): void {
    if (this.closed || this.releaseEscapeShortcut) return;
    // 整次截图持有 Esc，优先于语音浮层；即使 renderer 失效仍可退出。
    try {
      this.releaseEscapeShortcut = acquireOverlayEscape(() => {
        const focused = [...this.members.values()].find(
          ({ overlay }) => !overlay.window.isDestroyed() && overlay.window.isFocused(),
        );
        if (!focused) {
          this.close();
          return;
        }
        // OS 按键只注册一次，聚焦浮层时把 Esc 交给原有编辑/菜单处理；
        // 无焦点时直接退出，renderer 卡死由窗口 unresponsive 路径结束。
        focused.overlay.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        focused.overlay.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      }, 10);
    } catch (error) {
      log.warn('temporary Escape registration failed', { error });
    }
  }

  private beginPayload(
    capture: DisplayCapture,
    locale: string,
    cursor: Electron.Point,
  ): RegionScreenshotBegin {
    const { display, image } = capture;
    const local = { x: cursor.x - display.bounds.x, y: cursor.y - display.bounds.y };
    const cursorOnDisplay =
      local.x >= 0 &&
      local.y >= 0 &&
      local.x < display.bounds.width &&
      local.y < display.bounds.height;
    const size = image.getSize();
    const viewport = { width: display.bounds.width, height: display.bounds.height };
    const windows: RegionScreenshotWindow[] = [];
    this.deps.windows.forEach((window, id) => {
      const rect = intersectRegion(toLocal(toGlobalDip(window.rect), display), viewport);
      if (rect) windows.push({ id, rect,
        ...(window.snapRects ? { snapRects: window.snapRects
          .map((region) => intersectRegion(toLocal(toGlobalDip(region), display), viewport))
          .filter((region): region is RegionRect => region !== null) } : {}),
      });
    });
    const bitmap = image.toBitmap();
    return {
      token: this.token,
      locale,
      viewport,
      scaleFactor: display.scaleFactor,
      frame: {
        width: size.width,
        height: size.height,
        data: new Uint8Array(
          bitmap.buffer,
          bitmap.byteOffset,
          bitmap.byteLength,
        ) as Uint8Array<ArrayBuffer>,
      },
      windows,
      lastRegion: this.deps.lastRegions.get(display.id) ?? null,
      cursor: cursorOnDisplay ? local : null,
      safeArea: this.chromeArea(display),
    };
  }

  /** 界面元素 (工具条、预览、控制条) 可用的区域: 避开菜单栏、刘海与 Dock / 任务栏。 */
  private chromeArea(display: Display): RegionRect {
    return regionChromeArea(display.bounds, display.workArea ?? display.bounds, this.deps.topInsets?.get(display.id) ?? 0);
  }

  /** 只认本次会话借用的浮层顶层 frame, 且 token 必须是本次会话的。 */
  private member(
    sender: WebContents,
    frame: Electron.WebFrameMain | null,
    token: unknown,
  ): Member | null {
    if (this.closed || token !== this.token) return null;
    const member = this.members.get(sender.id);
    if (!member || member.overlay.window.isDestroyed()) return null;
    if (!frame || frame !== sender.mainFrame) return null;
    return member;
  }

  owns(overlay: OverlayWindow): boolean {
    return [...this.members.values()].some((m) => m.overlay === overlay);
  }

  painted(sender: WebContents, frame: Electron.WebFrameMain | null, token: unknown): void {
    const member = this.member(sender, frame, token);
    if (!member) return;
    member.painted = true;
    if (this.live?.editing && this.live.member === member) {
      member.overlay.window.setOpacity(1);
      member.overlay.window.focus();
      return;
    }
    if ([...this.members.values()].every((m) => m.painted)) this.reveal();
  }

  focused(sender: WebContents, frame: Electron.WebFrameMain | null, token: unknown): void {
    if (!this.member(sender, frame, token)) return;
  }

  selectionStarted(sender: WebContents, frame: Electron.WebFrameMain | null, token: unknown): void {
    const member = this.member(sender, frame, token);
    if (!member) return;
    // 一次只截一块屏: 在这块屏开始框选时清掉其它屏上的选区。
    for (const other of this.members.values()) {
      if (other !== member && !other.overlay.window.isDestroyed()) {
        other.overlay.window.webContents.send(REGION_SCREENSHOT_CHANNEL.CLEAR);
      }
    }
  }

  async elementsAt(
    sender: WebContents,
    frame: Electron.WebFrameMain | null,
    token: unknown,
    windowId: unknown,
    x: unknown,
    y: unknown,
  ): Promise<RegionScreenshotHit | null> {
    const member = this.member(sender, frame, token);
    if (!member || !Number.isInteger(windowId)) return null;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x + y)) return null;
    if (!this.deps.windows[windowId as number]) return null;
    const { display } = member.capture;
    if (x < 0 || y < 0 || x >= display.bounds.width || y >= display.bounds.height) return null;
    const global = { x: x + display.bounds.x, y: y + display.bounds.y };
    const point = process.platform === 'win32' ? screen.dipToScreenPoint(global) : global;
    const excluded = process.platform === 'darwin'
      ? [...this.members.values()].filter(({ overlay }) => !overlay.window.isDestroyed())
        .map(({ overlay }) => Number(overlay.window.getMediaSourceId().split(':')[1]))
        .filter((id) => Number.isSafeInteger(id) && id > 0)
      : [];
    const window = await this.deps.helper.windowAt(this.deps.windows, point.x, point.y, excluded);
    if (this.closed) return null;
    if (!window) return { window: null, rects: [] };
    const hit = await this.deps.helper.elements(window, point.x, point.y);
    if (this.closed) return null;
    return {
      window: { id: this.deps.windows.indexOf(window), rect: toLocal(toGlobalDip(window.rect), display) },
      rects: hit.rects.map((rect) => toLocal(toGlobalDip(rect), display)),
      ...(hit.preferredRect ? { preferredRect: toLocal(toGlobalDip(hit.preferredRect), display) } : {}),
    };
  }

  copyText(
    sender: WebContents,
    frame: Electron.WebFrameMain | null,
    token: unknown,
    text: unknown,
  ) {
    if (!this.member(sender, frame, token)) return;
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_COLOR_TEXT) return;
    clipboard.writeText(text);
  }

  cancel(sender: WebContents, frame: Electron.WebFrameMain | null, token: unknown): void {
    if (this.member(sender, frame, token)) this.close();
  }

  startLive(sender: WebContents, frame: Electron.WebFrameMain | null, token: unknown, mode: unknown, rawSelection: unknown): RegionCaptureBegin | null {
    const member = this.member(sender, frame, token);
    if (!member || this.live || this.exporting || typeof mode !== 'string' || !['scroll', 'video', 'gif'].includes(mode)) return null;
    const { display, image } = member.capture;
    const selection = normalizeRegionSelection(rawSelection, display.bounds, display.scaleFactor);
    if (!selection || selection.width < 32 || selection.height < 32) return null;
    const area = this.chromeArea(display);
    const layout = mode === 'scroll' ? scrollCaptureLayout(selection, display.bounds, area) : null;
    const controls = mode === 'scroll' ? null : recordingControlsBounds(selection, display.bounds, false, undefined, area);
    if (!layout && !controls) return null;
    const size = image.getSize();
    const mapping = regionSelectionToImageCrop(selection, display.bounds, size, display.scaleFactor);
    if (!mapping) return null;
    const crop = image.crop(mapping.crop).resize(mapping.output);
    const croppedSize = crop.getSize();
    if (croppedSize.width * croppedSize.height > 32_000_000) return null;
    const center = { x: display.bounds.x + selection.x + selection.width / 2, y: display.bounds.y + selection.y + selection.height / 2 };
    const physical = process.platform === 'win32' ? screen.dipToScreenPoint(center) : center;
    const target = this.deps.windows.find(({ rect }) => physical.x >= rect[0] && physical.x < rect[2] && physical.y >= rect[1] && physical.y < rect[3]) ?? null;
    this.live = { member, selection, mode: mode as RegionCaptureMode, sampling: false, lastSample: 0, editing: false, layout, automatic: false, target, targetResolved: process.platform !== 'darwin', ignoring: false, previewHeight: layout ? Math.min(layout.preview.height, Math.ceil(croppedSize.height * layout.preview.width / croppedSize.width)) : 0 };
    for (const other of this.members.values()) {
      if (other === member) continue;
      hideScreenshotOverlay(other.overlay.window);
    }
    this.recordingControls = controls;
    // Keep the visible panel's geometry and stacking unchanged. On macOS blur()
    // orders it out and back, causing a full-screen flash at the live handoff.
    // The nonactivating panel already leaves the captured app in the foreground;
    // hit-testing below returns pointer input outside the controls to that app.
    if (process.platform !== 'darwin') member.overlay.window.blur();
    this.updateScrollHitTest();
    this.scrollPointerTimer = setInterval(() => this.updateScrollHitTest(), 30);
    return { mode: mode as RegionCaptureMode, selection, first: { ...croppedSize, data: new Uint8Array(crop.toBitmap()) }, ...(layout ? { scrollLayout: layout } : {}), ...(controls ? { recordingLayout: { viewport: display.bounds, controls, area } } : {}) };
  }

  updateRecordingControls(sender: WebContents, frame: Electron.WebFrameMain | null, token: unknown, expanded: unknown, point: unknown, dragging: unknown): RegionRect | null {
    const member = this.member(sender, frame, token), live = this.live;
    if (!member || !live || live.member !== member || live.mode === 'scroll' || typeof expanded !== 'boolean' || typeof dragging !== 'boolean') return null;
    let position: { x: number; y: number } | undefined;
    if (point !== undefined) {
      if (!point || typeof point !== 'object') return null;
      const { x, y } = point as Record<string, unknown>;
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
      position = { x, y };
    }
    const { display } = member.capture;
    const controls = recordingControlsBounds(live.selection, display.bounds, expanded, position, this.chromeArea(display));
    if (!controls) return null;
    this.recordingControls = controls;
    this.draggingControls = dragging;
    this.updateScrollHitTest();
    return controls;
  }

  previewRecording(sender: WebContents, frame: Electron.WebFrameMain | null, token: unknown, bytes: unknown, format: unknown): boolean {
    const member = this.member(sender, frame, token), live = this.live;
    if (!member || !live || live.member !== member || this.exporting || live.mode === 'scroll') return false;
    const expected = live.mode === 'gif' ? 'gif' : 'webm';
    if (format !== expected || !validRecordingBytes(bytes, format)) return false;
    if (!this.deps.openRecording?.(new Uint8Array(bytes), expected, member.capture.display)) return false;
    this.handedToEditor = true;
    this.close();
    return true;
  }

  private updateScrollHitTest(): void {
    const live = this.live;
    if (!live || (!live.layout && !this.recordingControls) || live.editing || live.sampling || this.closed) return;
    const point = screen.getCursorScreenPoint();
    const { bounds } = live.member.capture.display;
    const x = point.x - bounds.x, y = point.y - bounds.y;
    const areas = live.layout ? [scrollPreviewBounds(live.layout, live.previewHeight), live.layout.auto, live.layout.actions] : [this.recordingControls!];
    const interactive = this.draggingControls || areas.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
    if (live.ignoring === !interactive) return;
    live.ignoring = !interactive;
    live.member.overlay.window.setIgnoreMouseEvents(!interactive, { forward: true });
  }

  /** `'accessibility'`: macOS 未授权辅助功能, 已弹出系统询问 (可直接打开系统设置)。 */
  autoScroll(sender: WebContents, frame: Electron.WebFrameMain | null, token: unknown, enabled: unknown): boolean | 'accessibility' {
    const member = this.member(sender, frame, token);
    const live = this.live;
    if (!member || !live || live.member !== member || live.mode !== 'scroll' || live.editing || this.exporting || typeof enabled !== 'boolean') return false;
    if (enabled && !live.target) return false;
    // 自动滚动向源应用投递滚轮事件, macOS 需要辅助功能权限; 没有时说明原因而不是静默失败。
    if (enabled && process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
      systemPreferences.isTrustedAccessibilityClient(true);
      return 'accessibility';
    }
    live.automatic = enabled;
    return true;
  }

  private stopScrolling(): void {
    if (this.scrollPointerTimer) clearInterval(this.scrollPointerTimer);
    this.scrollPointerTimer = null;
    if (this.live) {
      this.live.automatic = false;
      if (!this.live.member.overlay.window.isDestroyed()) this.live.member.overlay.window.setIgnoreMouseEvents(false);
    }
  }

  async liveFrame(sender: WebContents, frame: Electron.WebFrameMain | null, token: unknown, showKeys: unknown, previewHeight?: unknown): Promise<RegionCaptureFrame | null> {
    const member = this.member(sender, frame, token);
    const live = this.live;
    if (!member || !live || live.member !== member || live.editing || live.sampling || this.exporting || Date.now() - live.lastSample < 80) return null;
    // The visual preview grows with the image; only its visible bounds take input.
    if (live.layout && typeof previewHeight === 'number' && Number.isFinite(previewHeight)) live.previewHeight = Math.max(1, Math.min(live.layout.preview.height, Math.ceil(previewHeight)));
    live.sampling = true;
    live.lastSample = Date.now();
    try {
      const [image, keys] = await Promise.all([
        live.mode === 'scroll'
          ? captureLiveRegion(member.capture.display, live.selection, live.mode, this.deps.helper)
          : (this.videoCapture ??= new RegionVideoCapture(this.deps.helper)).frame(member.capture.display, live.selection, live.mode),
        showKeys === true && live.mode !== 'scroll' ? this.deps.helper.keys() : Promise.resolve([]),
      ]);
      if (this.closed || this.live !== live || live.editing) return null;
      if (live.automatic && live.target) {
        const { display } = member.capture;
        const center = { x: display.bounds.x + live.selection.x + live.selection.width / 2, y: display.bounds.y + live.selection.y + live.selection.height / 2 };
        const point = process.platform === 'win32' ? screen.dipToScreenPoint(center) : center;
        // Let native hit-testing see the source, including when Stop is hovered.
        member.overlay.window.setIgnoreMouseEvents(true, { forward: true });
        live.ignoring = true;
        if (!live.targetResolved) {
          const target = await this.deps.helper.scrollTarget(this.deps.windows, Math.round(point.x), Math.round(point.y));
          if (this.closed || this.live !== live || live.editing) return null;
          if (target) {
            live.target = target;
            live.targetResolved = true;
          } else {
            live.automatic = false;
          }
        }
        // Stop may arrive while the native input target is being resolved.
        if (live.automatic) {
          const ok = await this.deps.helper.scroll(live.target, Math.round(point.x), Math.round(point.y), -Math.max(1, Math.min(120, Math.floor(live.selection.height / 5))));
          if (this.closed || this.live !== live || live.editing) return null;
          if (!ok) live.automatic = false;
        }
        this.updateScrollHitTest();
      }
      const point = screen.getCursorScreenPoint();
      const x = point.x - member.capture.display.bounds.x - live.selection.x;
      const y = point.y - member.capture.display.bounds.y - live.selection.y;
      return { image, keys, autoScrolling: live.automatic, cursor: x >= 0 && y >= 0 && x < live.selection.width && y < live.selection.height ? { x: x * image.width / live.selection.width, y: y * image.height / live.selection.height } : null };
    } catch {
      throwIpcError('INTERNAL', 'Screen capture failed');
    } finally { live.sampling = false; this.updateScrollHitTest(); }
  }

  restoreEditor(sender: WebContents, frame: Electron.WebFrameMain | null, token: unknown, rawImage: unknown): boolean {
    const member = this.member(sender, frame, token);
    if (!member || !this.live || this.live.member !== member || this.live.mode !== 'scroll' || this.live.editing || this.exporting) return false;
    const image = validateRegionBitmap(rawImage, {
      width: Math.ceil(this.live.selection.width * member.capture.display.scaleFactor) + 2,
      height: 32768,
    });
    if (!image || image.width * image.height > 32_000_000) return false;
    if (!this.deps.openEditor?.(image, member.capture.display, this.live.selection)) return false;
    this.handedToEditor = true;
    this.close();
    return true;
  }

  holdCapture(sender: WebContents, frame: Electron.WebFrameMain | null, token: unknown): void {
    const member = this.member(sender, frame, token);
    if (member && this.live?.member === member) {
      this.live.automatic = false;
      this.videoCapture?.stop();
    }
  }

  async saveRecording(sender: WebContents, frame: Electron.WebFrameMain | null, token: unknown, bytes: unknown, format: unknown): Promise<boolean> {
    const member = this.member(sender, frame, token);
    if (!member || !this.live || this.live.member !== member || this.exporting) return false;
    const expected = this.live.mode === 'gif' ? 'gif' : this.live.mode === 'video' ? 'webm' : null;
    if (!expected || format !== expected || !validRecordingBytes(bytes, format)) return false;
    this.exporting = true;
    // Let the native save dialog own Escape; cancelling it must retain the finished clip.
    this.releaseEscape();
    try { return await saveRegionRecording(bytes, expected); }
    finally { this.exporting = false; this.holdEscape(); }
  }

  /** 浮层页面丢了会话状态 (重新加载 / 重新挂载): 不再能正常交互, 直接结束整次截图。 */
  abandon(sender: WebContents, frame: Electron.WebFrameMain | null): void {
    if (this.closed || !frame || frame !== sender.mainFrame) return;
    if (!this.members.has(sender.id)) return;
    log.warn('overlay lost its session state, closing screenshot');
    this.close();
  }

  /** 校验页面导出的最终图, 结束会话后交给调用方执行动作。非法 payload 返回 false。 */
  export(
    sender: WebContents,
    frame: Electron.WebFrameMain | null,
    token: unknown,
    raw: unknown,
  ): boolean {
    const member = this.member(sender, frame, token);
    if (!member || this.exporting || !raw || typeof raw !== 'object') return false;
    const { action, selection: rawSelection, image: rawImage } = raw as Record<string, unknown>;
    if (!isRegionScreenshotAction(action)) return false;
    const { display } = member.capture;
    const { width, height } = display.bounds;
    const selection = normalizeRegionSelection(
      rawSelection,
      { width, height },
      display.scaleFactor,
    );
    if (!selection) return false;
    // 导出图是选区的物理像素; 混合 DPI 下定格图可能比物理分辨率大, 上限取两者较大值。
    const frameSize = member.capture.image.getSize();
    const limit = {
      width: Math.ceil(Math.max(width * display.scaleFactor, frameSize.width)) + 2,
      height: Math.ceil(Math.max(height * display.scaleFactor, frameSize.height)) + 2,
    };
    const isLong = this.live?.mode === 'scroll' && this.live.member === member;
    const bitmap = validateRegionBitmap(rawImage, isLong ? { width: limit.width, height: 32768 } : limit);
    if (!bitmap) return false;
    if (bitmap.width * bitmap.height > 32_000_000) return false;
    const image = nativeImage.createFromBitmap(
      Buffer.from(bitmap.data.buffer, bitmap.data.byteOffset, bitmap.data.byteLength),
      // 此对象保存物理像素。窗口 DIP 尺寸由 selection 独立携带，不能把图片再标成
      // 2x 表示，否则 getSize() 与 toBitmap() 的尺寸不一致，贴图会构造失败。
      { width: bitmap.width, height: bitmap.height, scaleFactor: 1 },
    );
    if (image.isEmpty()) return false;
    this.exporting = true;
    log.info('screenshot exported', { action, width: bitmap.width, height: bitmap.height });
    this.close();
    this.deps.onResult({ action, image, display, selection });
    return true;
  }

  private reveal(): void {
    if (this.closed) return;
    if (this.revealTimer) {
      clearTimeout(this.revealTimer);
      this.revealTimer = null;
    }
    // 超时仍未绘制定格画面的屏不能显示 (只会是一整块黑屏, 还可能收不到按键):
    // 隐藏这块屏的浮层; 一块都没画好就直接结束截图。
    for (const [id, member] of [...this.members]) {
      if (member.painted) continue;
      log.warn('overlay did not paint in time; hiding it', {
        displayId: member.capture.display.id,
      });
      if (!member.overlay.window.isDestroyed()) {
        member.overlay.window.webContents.send(REGION_SCREENSHOT_CHANNEL.END);
      }
      this.deps.pool.retire(member.overlay);
      this.members.delete(id);
    }
    if (this.members.size === 0) {
      this.close();
      return;
    }
    const cursor = screen.getCursorScreenPoint();
    let target: Member | null = null;
    for (const member of this.members.values()) {
      const { window } = member.overlay;
      if (window.isDestroyed()) continue;
      window.setOpacity(1);
      const { bounds } = member.capture.display;
      if (
        cursor.x >= bounds.x &&
        cursor.x < bounds.x + bounds.width &&
        cursor.y >= bounds.y &&
        cursor.y < bounds.y + bounds.height
      ) {
        target = member;
      }
    }
    // 光标所在屏的浮层拿键盘焦点 (标注文字、快捷键都要)。macOS 浮层是不激活应用的
    // 面板: 截图前的应用保持前台, 菜单栏不切换, 滚动截图时触控板滚动照常交给它。
    const window = (target ?? [...this.members.values()][0])?.overlay.window;
    if (!window || window.isDestroyed()) return;
    window.focus();
  }

  private releaseEscape(): void {
    this.releaseEscapeShortcut?.();
    this.releaseEscapeShortcut = null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopScrolling();
    this.videoCapture?.stop();
    this.videoCapture = null;
    this.live = null;
    if (this.revealTimer) clearTimeout(this.revealTimer);
    this.releaseEscape();
    screen.removeListener('display-added', this.onDisplaysChanged);
    screen.removeListener('display-removed', this.onDisplaysChanged);
    screen.removeListener('display-metrics-changed', this.onDisplayMetricsChanged);
    for (const { overlay } of this.members.values()) {
      const { window } = overlay;
      if (!window.isDestroyed()) window.webContents.send(REGION_SCREENSHOT_CHANNEL.END);
      this.deps.pool.retire(overlay);
    }
    this.members.clear();
    this.deps.onClosed();
  }
}
