import {
  app,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  screen,
  shell,
  systemPreferences,
  type Display,
} from 'electron';

import { createLogger } from '../logger';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState';
import { t } from '../i18n';
import type { SupportedLocale } from '../../shared/locale';
import {
  getAppShortcutStore,
  setGlobalShortcutRegistrationFailures,
  subscribeAppShortcutRecording,
} from '../app-shortcuts';
import { enumerateDesktopSources } from '../remote-desktop/captureSource';
import { MAC_SCREEN_RECORDING_SETTINGS_URL } from '../computer-permission-guide/request';
import { comboToElectronAccelerator } from '../../shared/appShortcuts';
import {
  isRegionScreenshotAiAction,
  REGION_SCREENSHOT_CHANNEL as C,
  type RegionRect,
  type RegionScreenshotAction,
} from '../../shared/regionScreenshot';
import { handOffScreenshotToTask, registerScreenshotComposeIpc } from './compose';
import { OverlayPool } from './overlays';
import { ScreenshotEditor } from './editor';
import { RecordingPreview } from './recordingPreview';
import { closeAllPins, openPin, registerPinIpc } from './pins';
import { saveScreenshotImage } from './save';
import {
  RegionScreenshotSession,
  type RegionScreenshotResult,
} from './session';
import { SnapshotHelper, type SnapshotWindow } from './snapshotHost';
import { captureScreenshotDisplays } from './liveCapture';
import { REGION_CAPTURE_CHANNEL as LIVE } from '../../shared/regionCapture';
import { registerRecordingAudioIpc } from './recordingAudio';

/**
 * 全局框选截图: 用户在「键盘快捷键」里可改的 region-screenshot 快捷键 →
 * 定格所有显示器 (同时拍下窗口列表) → 每块屏一个按需创建、隐藏复用的框选浮层 → 选区、标注后
 * 复制 / 保存 / 贴图, 或交给 Cindy 新任务 (问 / 翻译 / 解释 / 提取文字)。
 *
 * 只在 macOS / Windows 启用 (registry 的 platforms 决定)。快捷键在设置页录制
 * 期间暂时注销, 让录制能收到当前组合; 注册失败 (多为被其它应用占用) 上报给
 * app-shortcuts, 设置页在该行提示。
 */

const log = createLogger('region-screenshot');
const SHORTCUT_ID = 'region-screenshot' as const;
const CAPTURE_TIMEOUT_MS = 5000;

let initialized = false;
let registeredAccelerator: string | null = null;
let recording = false;
let starting = false;
let active: RegionScreenshotSession | null = null;
const pool = new OverlayPool();
const recordingPreview = new RecordingPreview();
const editor = new ScreenshotEditor((result) => {
  lastRegions.set(result.display.id, result.selection);
  void runAction(result);
});
/** 每块显示器上一次截图的选区 (DIP), 供「重复上次区域」; 只在本次运行内记住。 */
const lastRegions = new Map<number, RegionRect>();
const disposers: Array<() => void> = [];

export function setRegionScreenshotLocale(locale: SupportedLocale): void {
  editor.setLocale(locale);
  active?.setLocale(locale);
}

export function initRegionScreenshot(): void {
  if (initialized) return;
  initialized = true;
  registerIpc();
  editor.registerIpc();
  recordingPreview.registerIpc();
  registerPinIpc();
  registerScreenshotComposeIpc();
  pool.setGoneHandler((overlay) => {
    if (active?.owns(overlay)) active.close();
  });
  disposers.push(getAppShortcutStore().subscribe(syncShortcut));
  disposers.push(
    subscribeAppShortcutRecording((isRecording) => {
      recording = isRecording;
      syncShortcut();
    }),
  );
  const onDisplaysChanged = () => {
    active?.close();
    pool.reset();
  };
  screen.on('display-added', onDisplaysChanged);
  screen.on('display-removed', onDisplaysChanged);
  const onMetricsChanged = (_event: Electron.Event, _display: Display, metrics: string[]) => {
    if (metrics.some((metric) => ['bounds', 'scaleFactor', 'rotation'].includes(metric))) onDisplaysChanged();
  };
  screen.on('display-metrics-changed', onMetricsChanged);
  disposers.push(() => {
    screen.removeListener('display-added', onDisplaysChanged);
    screen.removeListener('display-removed', onDisplaysChanged);
    screen.removeListener('display-metrics-changed', onMetricsChanged);
  });
  syncShortcut();
}

export function stopRegionScreenshot(): void {
  for (const dispose of disposers.splice(0)) dispose();
  if (registeredAccelerator) globalShortcut.unregister(registeredAccelerator);
  registeredAccelerator = null;
  active?.close();
  pool.destroyAll();
  editor.dispose();
  recordingPreview.dispose();
  closeAllPins();
}

function desiredAccelerator(): string | null {
  const combo = getAppShortcutStore().getEffectiveCombos(SHORTCUT_ID)[0];
  return combo ? comboToElectronAccelerator(combo, process.platform) : null;
}

function syncShortcut(): void {
  if (!initialized) return;
  const desired = recording ? null : desiredAccelerator();
  if (desired === registeredAccelerator) return;
  if (registeredAccelerator) globalShortcut.unregister(registeredAccelerator);
  registeredAccelerator = null;
  // 录制期间只是暂时让出按键, 不改变「是否被占用」的提示。
  if (recording) return;
  if (!desired) {
    setGlobalShortcutRegistrationFailures([]);
    return;
  }
  let ok = false;
  try {
    ok = globalShortcut.register(desired, () => {
      void startRegionScreenshot();
    });
  } catch (error) {
    log.warn('screenshot shortcut registration threw', { accelerator: desired, error });
  }
  if (ok) {
    registeredAccelerator = desired;
    setGlobalShortcutRegistrationFailures([]);
  } else {
    log.warn('screenshot shortcut is unavailable', { accelerator: desired });
    setGlobalShortcutRegistrationFailures([SHORTCUT_ID]);
  }
}

function registerIpc(): void {
  registerRecordingAudioIpc();
  ipcMain.handle(LIVE.AUDIO_START, (event, token: unknown, options: unknown) => active?.startAudio(event.sender, event.senderFrame, token, options) ?? 'audioFailed');
  ipcMain.handle(LIVE.AUDIO_READ, (event, token: unknown) => active?.readAudio(event.sender, event.senderFrame, token));
  ipcMain.handle(LIVE.AUDIO_STOP, (event, token: unknown) => active?.stopAudio(event.sender, event.senderFrame, token));
  ipcMain.handle(LIVE.CONTROLS, (event, token: unknown, expanded: unknown, point: unknown, dragging: unknown) => active?.updateRecordingControls(event.sender, event.senderFrame, token, expanded, point, dragging) ?? null);
  ipcMain.handle(LIVE.PREVIEW, (event, token: unknown, bytes: unknown, format: unknown) => active?.previewRecording(event.sender, event.senderFrame, token, bytes, format) ?? false);
  ipcMain.handle(LIVE.AUTO_SCROLL, (event, token: unknown, enabled: unknown) => active?.autoScroll(event.sender, event.senderFrame, token, enabled) ?? false);
  ipcMain.handle(LIVE.START, (event, token: unknown, mode: unknown, selection: unknown) => active?.startLive(event.sender, event.senderFrame, token, mode, selection) ?? null);
  ipcMain.handle(LIVE.FRAME, (event, token: unknown, keys: unknown, previewHeight: unknown) => active?.liveFrame(event.sender, event.senderFrame, token, keys, previewHeight) ?? null);
  ipcMain.handle(LIVE.SAVE, (event, token: unknown, bytes: unknown, format: unknown) => active?.saveRecording(event.sender, event.senderFrame, token, bytes, format) ?? false);
  ipcMain.handle(LIVE.EDIT, (event, token: unknown, image: unknown) => active?.restoreEditor(event.sender, event.senderFrame, token, image) ?? false);
  ipcMain.handle(LIVE.HOLD, (event, token: unknown) => active?.holdCapture(event.sender, event.senderFrame, token));
  // 所有通道都按 sender 反查浮层, 再由当前会话核对 token; 无会话或来源不符一律忽略。
  ipcMain.on(C.SHELL_READY, (event) => pool.markShellReady(event.sender, event.senderFrame));
  ipcMain.on(C.PAINTED, (event, token: unknown) =>
    active?.painted(event.sender, event.senderFrame, token),
  );
  ipcMain.on(C.FOCUSED, (event, token: unknown) =>
    active?.focused(event.sender, event.senderFrame, token),
  );
  ipcMain.on(C.SELECTION_START, (event, token: unknown) =>
    active?.selectionStarted(event.sender, event.senderFrame, token),
  );
  ipcMain.on(C.COPY_TEXT, (event, token: unknown, text: unknown) =>
    active?.copyText(event.sender, event.senderFrame, token, text),
  );
  ipcMain.on(C.CANCEL, (event, token: unknown) =>
    active?.cancel(event.sender, event.senderFrame, token),
  );
  ipcMain.on(C.ABANDON, (event) => {
    const overlay = pool.forContents(event.sender);
    if (!overlay || !active?.owns(overlay) || event.senderFrame !== event.sender.mainFrame) return;
    active.abandon(event.sender, event.senderFrame);
    pool.discard(overlay);
  });
  ipcMain.handle(
    C.ELEMENTS_AT,
    (event, token: unknown, windowId: unknown, x: unknown, y: unknown) =>
      active?.elementsAt(event.sender, event.senderFrame, token, windowId, x, y) ?? null,
  );
  ipcMain.handle(
    C.EXPORT,
    (event, token: unknown, payload: unknown) =>
      active?.export(event.sender, event.senderFrame, token, payload) ?? false,
  );
  ipcMain.handle(C.SET_TRANSLATION_LANGUAGE, (event, token: unknown, value: unknown) =>
    active?.setTranslationLanguage(event.sender, event.senderFrame, token, value) ?? false);
}

async function startRegionScreenshot(): Promise<void> {
  if (isAppSessionBoundaryPending()) return;
  const ownerScope = activeOwnerScopeKey();
  if (active || starting) return;
  if (pool.isDisabled) {
    void dialog.showMessageBox({ type: 'warning', message: t('regionScreenshot.captureFailed'), noLink: true });
    return;
  }
  starting = true;
  const startedAt = Date.now();
  let helper: SnapshotHelper | null = null;
  let abandoned = false;
  try {
    if (process.platform === 'darwin' && !(await ensureMacScreenRecordingPermission())) return;
    // 首次开发编译不阻塞截图，本次降级为手动框选；不拿迟到的窗口列表匹配旧定格画面。
    const helperReady = SnapshotHelper.start(false).then((value) => {
      if (abandoned) value.dispose();
      else helper = value;
      return value;
    });
    let snapshotMs = 0;
    let captureMs = 0;
    const snapshot = helperReady.then(async (h) => {
      const result = {
        windows: await h.windows(),
        frontmostPid: await h.frontmostPid(),
        topInsets: await h.screenInsets(),
      };
      snapshotMs = Date.now() - startedAt;
      return result;
    });
    const displays = screen.getAllDisplays();
    const [capture, snap] = await Promise.all([
      helperReady.then(async (h) => {
        const result = await captureScreenshotDisplays(displays, h);
        captureMs = Date.now() - startedAt;
        return result;
      }),
      snapshot.catch(() => ({ windows: [] as SnapshotWindow[], frontmostPid: null, topInsets: new Map<number, number>() })),
    ]);
    const { captures, backend } = capture;
    helper = await helperReady;
    if (isAppSessionBoundaryPending() || ownerScope !== activeOwnerScopeKey()) return;
    const capturedAt = Date.now();
    if (captures.length === 0) {
      log.warn('no display could be captured');
      void dialog.showMessageBox({ type: 'warning', message: t('regionScreenshot.captureFailed'), noLink: true });
      return;
    }
    const sessionHelper = helper;
    let result: RegionScreenshotResult | null = null;
    const session = new RegionScreenshotSession({
      pool,
      captures,
      helper: sessionHelper,
      windows: snap.windows,
      topInsets: snap.topInsets,
      lastRegions,
      onRevealed: () => log.info('screenshot visible', {
        totalMs: Date.now() - startedAt, captureMs, snapshotMs, backend,
        displayCount: captures.length,
      }),
      openEditor: (image, display, selection) => editor.open(image, display, selection, ownerScope),
      openRecording: (bytes, format, display) => recordingPreview.open(bytes, format, display, ownerScope),
      onResult: (value) => {
        result = value;
        lastRegions.set(value.display.id, value.selection);
        void runAction({ ...value, ownerScope });
      },
      onClosed: () => {
        if (active === session) active = null;
        // export() 先结束会话再回传结果, 等这一轮同步代码走完再决定焦点去向。
        queueMicrotask(() => {
          const action = (result as RegionScreenshotResult | null)?.action ?? null;
          if (snap.frontmostPid !== null && !session.hasEditor && !takesFocus(action)) {
            void sessionHelper.activate(snap.frontmostPid).finally(() => sessionHelper.dispose());
          } else {
            sessionHelper.dispose();
          }
        });
      },
    });
    active = session;
    helper = null;
    const opened = await session.open();
    log.info('screenshot opened', {
      opened,
      captureMs: capturedAt - startedAt,
      snapshotMs,
      backend,
      openMs: Date.now() - capturedAt,
      windows: snap.windows.length,
    });
  } catch (error) {
    log.warn('region screenshot failed', { error });
    active?.close();
  } finally {
    abandoned = true;
    helper?.dispose();
    starting = false;
  }
}

/** 这些动作之后焦点本该留在 Cindy (主窗口 / 保存框), 不还给截图前的应用。 */
function takesFocus(action: RegionScreenshotAction | null): boolean {
  return action === 'save' || isRegionScreenshotAiAction(action);
}

async function runAction({ action, image, display, selection, ownerScope, translationLanguage }: RegionScreenshotResult) {
  try {
    if (action === 'copy') {
      clipboard.writeImage(image);
    } else if (action === 'save') {
      await saveScreenshotImage(image);
    } else if (action === 'pin') {
      openPin(image, {
        x: Math.round(display.bounds.x + selection.x),
        y: Math.round(display.bounds.y + selection.y),
        width: Math.max(1, Math.round(selection.width)),
        height: Math.max(1, Math.round(selection.height)),
      }, ownerScope);
    } else {
      await handOffScreenshotToTask(image, action, ownerScope, translationLanguage);
    }
  } catch (error) {
    log.warn('screenshot action failed', { action, error });
  }
}

/**
 * Electron 在 macOS 上只区分已授权 / 未授权。未授权时先枚举一次屏幕源, 让
 * Cindy 出现在系统的屏幕录制列表里 (首次还会弹出系统询问), 再说明去哪里开启。
 */
async function ensureMacScreenRecordingPermission(): Promise<boolean> {
  if (systemPreferences.getMediaAccessStatus('screen') === 'granted') return true;
  await enumerateDesktopSources(
    () => desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }),
    CAPTURE_TIMEOUT_MS,
  ).catch(() => undefined);
  if (systemPreferences.getMediaAccessStatus('screen') === 'granted') return true;
  app.focus({ steal: true });
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: t('regionScreenshot.permission.title'),
    detail: t('regionScreenshot.permission.detail'),
    buttons: [t('regionScreenshot.permission.openSettings'), t('regionScreenshot.permission.later')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response === 0) await shell.openExternal(MAC_SCREEN_RECORDING_SETTINGS_URL);
  return false;
}
