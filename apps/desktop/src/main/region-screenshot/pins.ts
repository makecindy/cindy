import {
  clipboard,
  ipcMain,
  Menu,
  screen,
  type BrowserWindow,
  type IpcMainEvent,
  type NativeImage,
  type Rectangle,
} from 'electron';

import { createLogger } from '../logger';
import { activeOwnerScopeKey } from '../appSessionState';
import { getResolvedMainLocale, t } from '../i18n';
import {
  REGION_SCREENSHOT_PIN_CHANNEL as C,
  REGION_SCREENSHOT_PIN_COMMANDS,
  type RegionScreenshotPinCommand,
  type RegionScreenshotPinInit,
  type RegionScreenshotPinState,
} from '../../shared/regionScreenshot';
import { handOffScreenshotToTask } from './compose';
import { createScreenshotPageWindow } from './pageWindow';
import { saveScreenshotImage } from './save';

const log = createLogger('region-screenshot:pins');

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 1.1;
const MIN_OPACITY = 0.2;
const OPACITY_STEP = 0.1;
/** 同时存在的贴图上限; 超出时关闭最早的一张。 */
const MAX_PINS = 32;

interface Pin {
  ownerScope: string;
  window: BrowserWindow;
  image: NativeImage;
  /** 首次显示的位置 (全局 DIP), 即截图时选区所在处。 */
  initialBounds: Rectangle;
  /** 原始大小 (DIP)。 */
  base: { width: number; height: number };
  zoom: number;
  opacity: number;
  passThrough: boolean;
  drag: { cursor: Electron.Point; position: [number, number] } | null;
}

/**
 * 贴图: 把截图钉在屏幕最上层。每张贴图一个独立窗口, 关闭即销毁 —— 这是按内容
 * 多实例、内容关掉即结束的窗口 (同右侧栏页签弹出窗口), 不做隐藏复用; 页面在图
 * 绘制完成后才显示。所有 IPC 按 sender 反查贴图, 页面不能指定别的贴图。
 * 2026-10-26 用户选择按需建窗：不常驻备用 renderer，接受首次贴图的加载时间；
 * 这仅豁免 §3.1 的预热条款，仍保留首帧握手、来源校验和失败关闭。
 */
const pins = new Map<number, Pin>();
let ipcRegistered = false;

function pinFor(event: IpcMainEvent): Pin | null {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return null;
  const pin = pins.get(event.sender.id);
  return pin && !pin.window.isDestroyed() ? pin : null;
}

function sendState(pin: Pin): void {
  const state: RegionScreenshotPinState = {
    opacity: pin.opacity,
    passThrough: pin.passThrough,
    zoom: pin.zoom,
  };
  if (!pin.window.isDestroyed()) pin.window.webContents.send(C.STATE, state);
}

export function openPin(image: NativeImage, bounds: Rectangle, ownerScope = activeOwnerScopeKey()): void {
  // A stitched image can be much taller than the original selection. Fit its
  // actual aspect ratio into the target screen, without changing the pixels.
  const size = image.getSize();
  const area = screen.getDisplayMatching(bounds).workArea;
  const ratio = Math.min(bounds.width / size.width, area.width / size.width, area.height / size.height);
  const width = Math.max(1, Math.round(size.width * ratio));
  const height = Math.max(1, Math.round(size.height * ratio));
  bounds = { width, height,
    x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))),
  };
  if (pins.size >= MAX_PINS) {
    const oldest = pins.values().next().value;
    if (oldest && !oldest.window.isDestroyed()) oldest.window.close();
  }
  const window = createScreenshotPageWindow({
    preload: 'regionScreenshotPinPreload.js',
    query: 'regionScreenshotPin',
    ...bounds,
    resizable: false,
    hasShadow: true,
    alwaysOnTop: true,
    // 图绘制前的底色; 窗口在图绘制完成后才显示。
    backgroundColor: '#000000',
  });
  window.setAlwaysOnTop(true, 'floating');
  const pin: Pin = {
    ownerScope,
    window,
    image,
    initialBounds: bounds,
    base: { width: bounds.width, height: bounds.height },
    zoom: 1,
    opacity: 1,
    passThrough: false,
    drag: null,
  };
  const id = window.webContents.id;
  pins.set(id, pin);
  window.on('closed', () => pins.delete(id));
  window.webContents.on('render-process-gone', () => {
    if (!window.isDestroyed()) window.destroy();
  });
  // 没有内容的窗口不能显示成黑块；失败只关闭这张贴图。
  const fallback = setTimeout(() => { if (!window.isDestroyed()) window.destroy(); }, 3000);
  window.once('show', () => clearTimeout(fallback));
  window.once('closed', () => clearTimeout(fallback));
  window.on('unresponsive', () => { if (!window.isDestroyed()) window.destroy(); });
}

function show(pin: Pin): void {
  const bounds = pin.initialBounds;
  const { window } = pin;
  if (window.isDestroyed() || window.isVisible()) return;
  window.showInactive();
  // 混合 DPI 下首次定位可能按错误的缩放落位, 显示后再校正一次。
  window.setBounds(bounds, false);
}

export function closeAllPins(): void {
  for (const pin of [...pins.values()]) {
    if (!pin.window.isDestroyed()) pin.window.close();
  }
}

function setZoom(pin: Pin, zoom: number, anchor?: { x: number; y: number }): void {
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  const bounds = pin.window.getBounds();
  const width = Math.max(8, Math.round(pin.base.width * next));
  const height = Math.max(8, Math.round(pin.base.height * next));
  const ax = anchor ? anchor.x : bounds.width / 2;
  const ay = anchor ? anchor.y : bounds.height / 2;
  pin.zoom = next;
  pin.window.setBounds({
    x: Math.round(bounds.x + ax - (ax * width) / bounds.width),
    y: Math.round(bounds.y + ay - (ay * height) / bounds.height),
    width,
    height,
  });
  sendState(pin);
}

function setOpacity(pin: Pin, opacity: number): void {
  pin.opacity = Math.round(Math.min(1, Math.max(MIN_OPACITY, opacity)) * 10) / 10;
  pin.window.setOpacity(pin.opacity);
  sendState(pin);
}

function setPassThrough(pin: Pin, passThrough: boolean): void {
  pin.passThrough = passThrough;
  // 穿透时仍转发指针移动, 页面才能在指针停到「恢复」按钮上时把点击要回来。
  if (passThrough) pin.window.setIgnoreMouseEvents(true, { forward: true });
  else pin.window.setIgnoreMouseEvents(false);
  sendState(pin);
}

function runCommand(pin: Pin, command: RegionScreenshotPinCommand): void {
  switch (command) {
    case 'copy':
      clipboard.writeImage(pin.image);
      return;
    case 'save':
      void saveScreenshotImage(pin.image);
      return;
    case 'ask':
      void handOffScreenshotToTask(pin.image, 'ask', pin.ownerScope).catch((error: unknown) => {
        log.warn('pin hand-off failed', { error });
      });
      return;
    case 'close':
      pin.window.close();
      return;
    case 'unlock':
      setPassThrough(pin, false);
      return;
    case 'zoom-reset':
      setZoom(pin, 1);
      return;
  }
}

function popupMenu(pin: Pin): void {
  const opacityItems = [1, 0.8, 0.6, 0.4].map((value) => ({
    label: `${Math.round(value * 100)}%`,
    type: 'radio' as const,
    checked: Math.abs(pin.opacity - value) < 0.05,
    click: () => setOpacity(pin, value),
  }));
  const menu = Menu.buildFromTemplate([
    { label: t('regionScreenshot.pin.copy'), accelerator: 'CmdOrCtrl+C', click: () => runCommand(pin, 'copy') },
    { label: t('regionScreenshot.pin.save'), accelerator: 'CmdOrCtrl+S', click: () => runCommand(pin, 'save') },
    { label: t('regionScreenshot.pin.ask'), click: () => runCommand(pin, 'ask') },
    { type: 'separator' },
    { label: t('regionScreenshot.pin.opacity'), submenu: opacityItems },
    {
      label: t('regionScreenshot.pin.originalSize'),
      accelerator: '0',
      enabled: pin.zoom !== 1,
      click: () => runCommand(pin, 'zoom-reset'),
    },
    {
      label: t('regionScreenshot.pin.passThrough'),
      type: 'checkbox',
      checked: pin.passThrough,
      click: () => setPassThrough(pin, !pin.passThrough),
    },
    { type: 'separator' },
    { label: t('regionScreenshot.pin.close'), accelerator: 'Esc', click: () => runCommand(pin, 'close') },
    { label: t('regionScreenshot.pin.closeAll'), click: closeAllPins },
  ]);
  menu.popup({ window: pin.window });
}

const finiteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export function registerPinIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.on(C.SHELL_READY, (event) => {
    const pin = pinFor(event);
    if (!pin) return;
    const size = pin.image.getSize();
    const bitmap = pin.image.toBitmap();
    const init: RegionScreenshotPinInit = {
      locale: getResolvedMainLocale(),
      image: {
        width: size.width,
        height: size.height,
        data: new Uint8Array(bitmap.buffer, bitmap.byteOffset, bitmap.byteLength) as Uint8Array<ArrayBuffer>,
      },
    };
    event.sender.send(C.INIT, init);
    sendState(pin);
  });
  ipcMain.on(C.PAINTED, (event) => {
    const pin = pinFor(event);
    if (pin) show(pin);
  });
  ipcMain.on(C.DRAG_START, (event) => {
    const pin = pinFor(event);
    if (!pin) return;
    const [x, y] = pin.window.getPosition();
    pin.drag = { cursor: screen.getCursorScreenPoint(), position: [x, y] };
  });
  ipcMain.on(C.DRAG_MOVE, (event) => {
    const pin = pinFor(event);
    if (!pin?.drag) return;
    const cursor = screen.getCursorScreenPoint();
    pin.window.setPosition(
      Math.round(pin.drag.position[0] + cursor.x - pin.drag.cursor.x),
      Math.round(pin.drag.position[1] + cursor.y - pin.drag.cursor.y),
    );
  });
  ipcMain.on(C.ZOOM, (event, steps: unknown, x: unknown, y: unknown) => {
    const pin = pinFor(event);
    if (!pin || !finiteNumber(steps) || !finiteNumber(x) || !finiteNumber(y)) return;
    const clamped = Math.max(-5, Math.min(5, steps));
    setZoom(pin, pin.zoom * ZOOM_STEP ** clamped, { x, y });
  });
  ipcMain.on(C.OPACITY, (event, steps: unknown) => {
    const pin = pinFor(event);
    if (!pin || !finiteNumber(steps)) return;
    setOpacity(pin, pin.opacity + OPACITY_STEP * Math.max(-5, Math.min(5, steps)));
  });
  ipcMain.on(C.MENU, (event) => {
    const pin = pinFor(event);
    if (pin) popupMenu(pin);
  });
  ipcMain.on(C.COMMAND, (event, command: unknown) => {
    const pin = pinFor(event);
    if (!pin || !(REGION_SCREENSHOT_PIN_COMMANDS as readonly unknown[]).includes(command)) return;
    runCommand(pin, command as RegionScreenshotPinCommand);
  });
  ipcMain.on(C.UNLOCK_HOVER, (event, hovering: unknown) => {
    const pin = pinFor(event);
    if (!pin?.passThrough) return;
    if (hovering === true) pin.window.setIgnoreMouseEvents(false);
    else pin.window.setIgnoreMouseEvents(true, { forward: true });
  });
}
