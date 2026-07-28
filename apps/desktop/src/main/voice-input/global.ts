import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  screen,
  shell,
  systemPreferences,
} from 'electron';
import type { Display, NativeImage, Point, Rectangle, WebContents } from 'electron';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import {
  inspectExternalEditedInsertedText,
  type DictationDictionaryAdviceInput,
} from '@cindy/voice-input-core';

import { createLogger } from '../logger.js';
import { scheduleMainAppPresenceRestore } from '../appPresence.js';
import { openMainWindowVoiceSettings } from '../deepLink.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { prewarmVoiceInputProvider } from './index.js';
import {
  VOICE_INPUT_DICTIONARY_LEARNING_TRACK_TIMEOUT_MS,
} from '../../shared/voiceInputDictionaryLearning.js';
import {
  voiceInputShortcutNeedsMacNativeListener,
  type VoiceInputSettings,
  type VoiceInputShortcut,
} from '../../shared/voiceInputData.js';
import {
  MacModifierShortcutListener,
  getMacInputMonitoringPermissionSnapshot,
  requestMacInputMonitoringPermission,
  type MacInputMonitoringPermissionSnapshot,
} from './MacModifierShortcutListener.js';
import {
  resolveDraggedOverlayBounds,
  resolveOverlayInitialBounds,
  type OverlayPlacementDisplay,
} from './overlayPlacement.js';
import { voiceInputOverlayPositionStore } from './overlayPositionStore.js';
import { voiceInputDataStore } from './VoiceInputDataStore.js';
import { installWindowHiddenBroadcast } from '../windowHiddenBroadcast.js';

const log = createLogger('voice-input-global');
type GlobalVoiceInputShortcutPhase = 'start' | 'tap' | 'end';

const modifierShortcutRecordingWebContentsIds = new Set<number>();
const activeInlineVoiceInputWebContentsIds = new Set<number>();

const macModifierShortcutListener = new MacModifierShortcutListener({
  onTrigger: (phase) => {
    log.debug('native global shortcut triggered', { phase });
    if (phase === 'tap') {
      handleGlobalVoiceInputShortcutTap();
    } else if (phase === 'start') {
      handleGlobalVoiceInputShortcut('start');
    } else {
      handleGlobalVoiceInputShortcutSubmit();
    }
  },
  onKeys: (keys) => {
    for (const webContentsId of Array.from(modifierShortcutRecordingWebContentsIds)) {
      const window = BrowserWindow.getAllWindows()
        .find((candidate) => !candidate.isDestroyed() && candidate.webContents.id === webContentsId);
      if (!window) {
        modifierShortcutRecordingWebContentsIds.delete(webContentsId);
        continue;
      }
      window.webContents.send('voice-input:modifier-shortcut-keys', { keys });
    }
  },
});

type VoiceInputGlobalResult =
  | { ok: true }
  | { ok: false; error: string; errorCode?: VoiceInputGlobalErrorCode };

type VoiceInputSettingsUpdateResult =
  | { ok: true; settings: VoiceInputSettings }
  | { ok: false; error: string; errorCode?: VoiceInputGlobalErrorCode };

type VoiceInputGlobalErrorCode = 'empty' | 'unavailable' | 'unconfirmed' | 'permission' | 'failed';

export type VoiceInputPermissionSnapshot =
  | { ok: true; status: string }
  | { ok: false; status: string; error: string };

type ClipboardSnapshot = {
  formats: string[];
  text: string;
  html: string;
  rtf: string;
  bookmark: { title: string; url: string } | null;
  image: NativeImage | null;
  buffers: Array<{ format: string; buffer: Buffer }>;
};

type MacPasteTarget = {
  processName: string;
  bundleId: string;
  pid?: number;
};

// Surrounding text around the user's cursor in the originally-focused element.
// Captured at overlay-show time (alongside the paste target) so the refiner can
// see the same kind of context that ChatInput's in-app dictation already
// provides. Without it, the global overlay path refines on dictation history
// alone — proper nouns, "the same X you mentioned", etc. all degrade.
type MacPasteContext = {
  selectionBefore: string;
  selectedText: string;
  selectionAfter: string;
  fullFieldContent?: string | null;
  fullFieldContentTruncated?: boolean;
  totalChars?: number;
  selectionLocation?: number | null;
  selectionLength?: number | null;
  focusedRole?: string;
  contextSource?: string;
};

type MacTextInsertionHelperResult = {
  ok?: boolean;
  target?: MacPasteTarget;
  context?: MacPasteContext;
  method?: string;
  timings?: Record<string, number>;
  status?: string;
  outcome?: 'verified_success' | 'verified_failure' | 'unconfirmed' | string;
  reason?: string;
  error?: string | null;
  targetApp?: string;
  targetBundleId?: string;
  targetPid?: number;
  commandIssued?: boolean;
  commandTargetApp?: string;
  commandTargetBundleId?: string;
  providerRequested?: boolean;
  requestedTypes?: string[];
  restoredClipboard?: boolean;
  focusedRole?: string;
  beforeChars?: number;
  afterChars?: number;
  beforeSelectedRange?: string;
  afterSelectedRange?: string;
  beforeNumberOfCharacters?: number;
  afterNumberOfCharacters?: number;
  enhancedAxAttempted?: boolean;
  enhancedAxHelped?: boolean;
};

const OVERLAY_QUERY = 'view=voice-input-overlay';
const OVERLAY_CARD_WIDTH = 496;
const OVERLAY_CARD_ESTIMATED_HEIGHT = 132;
// The renderer uses the same transparent outer padding around the card. This
// gives the CSS shadow room to fade before it reaches the transparent
// BrowserWindow edge; otherwise macOS shows a hard rectangular cutoff.
const OVERLAY_SHADOW_PADDING = 52;
const OVERLAY_WIDTH = OVERLAY_CARD_WIDTH + OVERLAY_SHADOW_PADDING * 2;
const OVERLAY_HEIGHT = OVERLAY_CARD_ESTIMATED_HEIGHT + OVERLAY_SHADOW_PADDING * 2;
const OVERLAY_VERTICAL_PLACEMENT = 0.86;
const OVERLAY_EDGE_PADDING = 24;
// 拖动时卡片中心距 workArea 水平中线小于该值即吸附到水平居中（灵动岛式，
// 第一版只做 X 轴中线吸附，不做四边吸附）。
const OVERLAY_SNAP_THRESHOLD_X = 48;
const DICTIONARY_TOAST_QUERY = 'view=voice-input-dictionary-toast';
const DICTIONARY_TOAST_CARD_WIDTH = 360;
const DICTIONARY_TOAST_CARD_ESTIMATED_HEIGHT = 68;
const DICTIONARY_TOAST_SHADOW_PADDING = 34;
const DICTIONARY_TOAST_WIDTH = DICTIONARY_TOAST_CARD_WIDTH + DICTIONARY_TOAST_SHADOW_PADDING * 2;
const DICTIONARY_TOAST_HEIGHT = DICTIONARY_TOAST_CARD_ESTIMATED_HEIGHT + DICTIONARY_TOAST_SHADOW_PADDING * 2;
const DICTIONARY_TOAST_DURATION_MS = 5000;
const MAC_ACCESSIBILITY_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const MAC_INPUT_MONITORING_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent';
// Defensive caps on toast payload size: entries are passed through the
// renderer URL query (see createDictionaryToastWindow), so a misbehaving
// caller could otherwise blow past Windows URL/file-path limits. UI only
// ever shows the first 3 terms + a count, so 10 is generous.
const DICTIONARY_TOAST_MAX_ENTRIES = 10;
const DICTIONARY_TOAST_MAX_TERM_CHARS = 120;
const OVERLAY_IDLE_BOUNDS: Rectangle = {
  x: -32000,
  y: -32000,
  width: OVERLAY_WIDTH,
  height: OVERLAY_HEIGHT,
};
const MAC_CORE_EDITING_SHORTCUTS = new Set(['KeyA', 'KeyC', 'KeyV', 'KeyX', 'KeyZ', 'Comma']);
const DEFAULT_COMMAND_TIMEOUT_MS = 2500;
const MAC_TEXT_INSERTION_HELPER_PASTE_TIMEOUT_MS = 5000;
const CLIPBOARD_RESTORE_DELAY_MS = 600;
const OVERLAY_CANCEL_ACCELERATOR = 'Escape';
const PASTE_DEBUG_TAG = '[global-paste-debug]';
// Explicit dev diagnostics for tuning external dictionary learning. This
// intentionally includes captured text, so it is limited to dev builds and
// never emitted from packaged builds.
const EXTERNAL_DICTIONARY_TEXT_DEBUG = !app.isPackaged;
const MAC_TEXT_INSERTION_HELPER_RESOURCE = path.join('tools', 'voice-input', 'xdt-macos-text-insertion-helper');
const MAC_TEXT_INSERTION_HELPER_SOURCE_RELATIVE = path.join('native', 'voice-input', 'macos-text-insertion-helper.swift');

let registered = false;
let registeredAccelerator: string | null = null;
let registeredShortcut: VoiceInputShortcut | null = null;
let registeredNativeShortcutLabel: string | null = null;
let registeredNativeShortcutKey: string | null = null;
let overlayCancelRegistered = false;
let overlayWindow: BrowserWindow | null = null;
let overlayLoaded = false;
let overlayPresentationActive = false;
let pendingOverlayStart: { shortcutInvokedAt: number } | null = null;
let pendingModifierOverlaySubmit = false;
let pendingModifierOverlaySuppressNextTap = false;
let pendingModifierOverlaySuppressNextRelease = false;
let overlayPasteTarget: MacPasteTarget | null = null;
let overlayPasteTargetPromise: Promise<MacPasteTarget | null> | null = null;
// Cached alongside overlayPasteTarget: surrounding text around the user's
// cursor in the originally-focused element. Read by the voice-input:start
// handler to inject into refinementContext when the start payload itself
// has no selection fields (i.e. global overlay path, not in-app ChatInput).
let overlayPasteContext: MacPasteContext | null = null;
let cachedInputMonitoringPermission: MacInputMonitoringPermissionSnapshot | null = null;
let dictionaryToastWindow: BrowserWindow | null = null;
let dictionaryToastCloseTimer: NodeJS.Timeout | null = null;
// 浮窗自定义拖动会话：renderer 只报告手势相位（start / move tick / end），
// 坐标一律由 main 从 screen.getCursorScreenPoint() 读取（DIP 坐标系），
// 避免 renderer screenX/screenY 在 Windows 缩放下的坐标系不一致问题。
let overlayDragSession: { startBounds: Rectangle; startCursor: Point } | null = null;

type ExternalDictionaryLearningWatch = {
  id: string;
  target: MacPasteTarget;
  context: MacPasteContext | null;
  insertedText: string;
  rawTranscriptText?: string;
  createdAt: number;
  lastActivityAt: number;
  timers: NodeJS.Timeout[];
  completed: boolean;
  inspecting: boolean;
  pendingEdit?: {
    editedText: string;
    detectedAt: number;
    reason: string;
  };
};

export type DictionaryToastEntryPayload = {
  entryId: string;
  term: string;
};

const EXTERNAL_DICTIONARY_LEARNING_POLL_DELAYS_MS = [2500, 6500, 14000];
// Base probes catch the common "edit shortly after paste" path. Once an edit is
// observed, mirror Typeless' strategy: keep watching and reset a single 15s
// timeout whenever the edited text changes. The advisor sees the final snapshot
// after the user stops editing, not IME/composition intermediates.
const EXTERNAL_DICTIONARY_LEARNING_TRACK_TIMEOUT_MS = VOICE_INPUT_DICTIONARY_LEARNING_TRACK_TIMEOUT_MS;
const EXTERNAL_DICTIONARY_LEARNING_IDLE_POLL_MS = 1000;
const EXTERNAL_DICTIONARY_LEARNING_TRANSIENT_SKIP_REASONS = new Set([
  'empty_window',
  'empty_edited_text',
  'unchanged',
  'inserted_text_still_present',
]);
const EXTERNAL_DICTIONARY_LEARNING_PENDING_FINALIZE_REASONS = new Set([
  'capture_missing_context',
  'empty_window',
  'empty_edited_text',
]);
let externalDictionaryLearningWatch: ExternalDictionaryLearningWatch | null = null;
const FOCUSED_WINDOW_SHORTCUT_CLAIM_TIMEOUT_MS = 120;
let focusedWindowShortcutClaimSeq = 0;
let pendingFocusedWindowShortcutClaim: {
  id: string;
  webContentsId: number;
  timer: ReturnType<typeof setTimeout>;
  modifierEndQueued?: boolean;
  modifierTapQueued?: boolean;
} | null = null;

/**
 * Pre-create the overlay BrowserWindow + renderer at idle time so the first
 * global shortcut press does not pay the BrowserWindow / React / i18n cold
 * start cost. The hidden window is kept in an explicit idle presentation state;
 * otherwise macOS can restore it when the app is activated by unrelated menu
 * shortcuts such as Cmd+,.
 */
export function prewarmGlobalVoiceInputOverlay(): void {
  const shortcutLabel = registeredAccelerator ?? registeredNativeShortcutLabel;
  if (!shortcutLabel) return;
  if (getOverlayWindow()) return;
  const window = createOverlayWindow(Date.now());
  setOverlayIdlePresentationState(window);
  log.info('global overlay prewarmed', {
    shortcut: shortcutLabel,
    windowId: window.id,
  });
}

export function isGlobalVoiceInputOverlayVisible(): boolean {
  return Boolean(overlayPresentationActive && getOverlayWindow()?.isVisible());
}

/**
 * Snapshot of the AX text surroundings captured when the overlay was last
 * shown, or null if the focused element didn't expose AX text state (e.g.
 * non-text role, AX not trusted, or capture failed). Mostly used internally;
 * external callers should prefer `awaitGlobalOverlayPasteContext` so the
 * in-flight capture is given a chance to settle.
 */
export function getGlobalOverlayPasteContext(): MacPasteContext | null {
  return overlayPasteContext;
}

/**
 * Same as getGlobalOverlayPasteContext, but waits up to `timeoutMs` for an
 * in-flight capture to finish first. Capture is fired off when the overlay
 * is shown (~200-500ms before the renderer's voice-input:start IPC arrives),
 * so on a slow Mac the capture promise can still be unresolved at start time
 * and a sync read returns null. Await with a tight cap so a misbehaving
 * helper doesn't stall the start path.
 */
export async function awaitGlobalOverlayPasteContext(
  options?: { timeoutMs?: number },
): Promise<MacPasteContext | null> {
  if (overlayPasteContext) return overlayPasteContext;
  if (!overlayPasteTargetPromise) return null;
  const timeoutMs = options?.timeoutMs ?? 800;
  await Promise.race([
    overlayPasteTargetPromise.catch(() => null),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  return overlayPasteContext;
}

/**
 * True when the given sender is the global voice-input overlay's webContents.
 * Used by voice-input:start to decide whether the AX paste context cached in
 * this module belongs to the caller — ChatInput dictation on the main window
 * has its own selection state and must NOT pick up overlay context that was
 * left behind by a previous global paste.
 */
export function isGlobalVoiceInputOverlaySender(sender: Electron.WebContents): boolean {
  const window = getOverlayWindow();
  if (!window || window.isDestroyed()) return false;
  return window.webContents === sender;
}

export function getVoiceInputAccessibilityPermissionSnapshot(): VoiceInputPermissionSnapshot {
  if (process.platform !== 'darwin') {
    return { ok: true, status: 'not-required' };
  }
  const granted = systemPreferences.isTrustedAccessibilityClient(false);
  if (granted) {
    return { ok: true, status: 'granted' };
  }
  return {
    ok: false,
    status: 'denied',
    error: 'Accessibility permission is required for automatic voice input.',
  };
}

export function getVoiceInputInputMonitoringPermissionCachedSnapshot(): VoiceInputPermissionSnapshot {
  if (process.platform !== 'darwin') {
    return { ok: true, status: 'not-required' };
  }
  return cachedInputMonitoringPermission ?? {
    ok: false,
    status: 'unknown',
    error: 'Input Monitoring permission status has not been checked yet.',
  };
}

export async function refreshVoiceInputInputMonitoringPermissionSnapshot(): Promise<VoiceInputPermissionSnapshot> {
  cachedInputMonitoringPermission = await getMacInputMonitoringPermissionSnapshot();
  return cachedInputMonitoringPermission;
}

export function registerActiveInlineVoiceInputWebContents(sender: WebContents): void {
  if (isGlobalVoiceInputOverlaySender(sender)) return;
  if (activeInlineVoiceInputWebContentsIds.has(sender.id)) return;
  activeInlineVoiceInputWebContentsIds.add(sender.id);
  sender.once('destroyed', () => {
    activeInlineVoiceInputWebContentsIds.delete(sender.id);
  });
}

export function unregisterActiveInlineVoiceInputWebContents(webContentsId: number): void {
  activeInlineVoiceInputWebContentsIds.delete(webContentsId);
}

export function registerGlobalVoiceInputIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle(
    'voice-input:global-shortcut:set',
    async (_event, shortcut: VoiceInputShortcut | null | undefined): Promise<VoiceInputGlobalResult> => {
      return setVoiceInputGlobalShortcut(shortcut ?? null);
    },
  );

  ipcMain.handle(
    'voice-input:settings:update-shortcut',
    async (_event, shortcut: VoiceInputShortcut | null | undefined): Promise<VoiceInputSettingsUpdateResult> => {
      const nextShortcut = shortcut ?? null;
      const registration = await setVoiceInputGlobalShortcut(nextShortcut);
      if (!registration.ok) return registration;
      return {
        ok: true,
        settings: voiceInputDataStore.updateSettings({ shortcut: nextShortcut }),
      };
    },
  );

  ipcMain.handle(
    'voice-input:modifier-shortcut-recording:start',
    async (event): Promise<VoiceInputGlobalResult> => {
      if (process.platform !== 'darwin') {
        return { ok: false, error: 'Modifier shortcut recording is only available on macOS.' };
      }
      modifierShortcutRecordingWebContentsIds.add(event.sender.id);
      event.sender.once('destroyed', () => {
        modifierShortcutRecordingWebContentsIds.delete(event.sender.id);
        if (modifierShortcutRecordingWebContentsIds.size === 0) {
          macModifierShortcutListener.stopKeyCapture();
        }
      });
      const result = await macModifierShortcutListener.startKeyCapture();
      if (!result.ok) {
        modifierShortcutRecordingWebContentsIds.delete(event.sender.id);
      }
      return result;
    },
  );

  ipcMain.handle(
    'voice-input:modifier-shortcut-recording:stop',
    (event): VoiceInputGlobalResult => {
      modifierShortcutRecordingWebContentsIds.delete(event.sender.id);
      if (modifierShortcutRecordingWebContentsIds.size === 0) {
        macModifierShortcutListener.stopKeyCapture();
      }
      return { ok: true };
    },
  );

  ipcMain.handle(
    'voice-input:global-paste',
    async (_event, payload: { text?: string; rawTranscriptText?: string } | undefined): Promise<VoiceInputGlobalResult> => {
      const text = payload?.text ?? '';
      const rawTranscriptText = payload?.rawTranscriptText?.trim() || undefined;
      if (!text.trim()) {
        return {
          ok: false,
          error: 'No voice input text to paste.',
          errorCode: 'empty',
        };
      }
      log.debug(PASTE_DEBUG_TAG, 'ipc paste request', {
        chars: text.length,
        overlayOpen: Boolean(getOverlayWindow()),
        capturedTarget: describePasteTarget(overlayPasteTarget),
        hasPendingTargetCapture: Boolean(overlayPasteTargetPromise),
      });
      try {
        await pasteTextToFocusedTarget(text, rawTranscriptText);
        return { ok: true };
      } catch (error) {
        const presentation = getPasteErrorPresentation(error);
        log.warn('paste failed', {
          error: presentation.message,
          errorCode: presentation.code,
          detail: presentation.detail,
        });
        return {
          ok: false,
          error: presentation.message,
          errorCode: presentation.code,
        };
      }
    },
  );

  ipcMain.handle(
    'voice-input:global-overlay-close',
    async (_event, options: { preservePasteTarget?: boolean } | undefined): Promise<{ ok: true }> => {
      const preservePasteTarget = Boolean(options?.preservePasteTarget);
      log.debug('global overlay close requested', {
        overlayVisible: Boolean(getOverlayWindow()?.isVisible()),
        preservePasteTarget,
      });
      await hideOverlayWindow({ preservePasteTarget });
      return { ok: true };
    },
  );

  ipcMain.handle('voice-input:global-overlay-show-passive', (): VoiceInputGlobalResult => {
    const window = getOverlayWindow();
    log.debug('global overlay passive show requested', {
      overlayVisible: Boolean(window?.isVisible()),
    });
    if (!window) return { ok: false, error: 'Voice input overlay is not available.' };
    showPassiveOverlayWindow(window);
    return { ok: true };
  });

  ipcMain.handle(
    'voice-input:open-settings',
    async (event, tab: unknown): Promise<{ ok: true }> => {
      const window = getOverlayWindow();
      if (!window || event.sender !== window.webContents) {
        throwIpcError(
          'PERMISSION_DENIED',
          'Voice input settings can only be opened from the global overlay.',
        );
      }
      if (tab !== 'voice-input' && tab !== 'providers') {
        throwIpcError('INVALID_PARAMS', 'Unsupported voice input settings tab.');
      }
      await hideOverlayWindow({ restorePasteTarget: false });
      openMainWindowVoiceSettings(tab);
      return { ok: true };
    },
  );

  // ── 浮窗自定义拖动（renderer 手势 + main setBounds）───────────────────
  // 窗口保持 movable: false（透明无边框跨 App 面板走原生 drag region 有
  // Windows 鼠标事件历史坑），拖动由 renderer 捕获 pointer 手势后经这三个
  // fire-and-forget 通道驱动 main 移动窗口。move tick 在 renderer 侧按
  // requestAnimationFrame 节流；main 每 tick 从拖动起点无状态重算（clamp +
  // 中线吸附都在 resolveDraggedOverlayBounds 纯函数里），不写盘。
  ipcMain.on('voice-input:global-overlay-drag-start', (event) => {
    const window = getOverlayWindow();
    if (!window || event.sender !== window.webContents) return;
    overlayDragSession = {
      startBounds: window.getBounds(),
      startCursor: screen.getCursorScreenPoint(),
    };
  });

  ipcMain.on('voice-input:global-overlay-drag-move', (event) => {
    const window = getOverlayWindow();
    if (!window || event.sender !== window.webContents) return;
    const session = overlayDragSession;
    if (!session) return;
    window.setBounds(resolveDraggedOverlayBounds({
      startBounds: session.startBounds,
      startCursor: session.startCursor,
      cursor: screen.getCursorScreenPoint(),
      displays: getOverlayPlacementDisplays(),
      contentInset: OVERLAY_SHADOW_PADDING,
      edgePadding: OVERLAY_EDGE_PADDING,
      snapThresholdX: OVERLAY_SNAP_THRESHOLD_X,
    }));
  });

  ipcMain.on('voice-input:global-overlay-drag-end', (event) => {
    const window = getOverlayWindow();
    if (!window || event.sender !== window.webContents) return;
    if (!overlayDragSession) return;
    overlayDragSession = null;
    // 只在真实拖动结束时落盘（renderer 侧超过阈值才会发 end），下次打开
    // 走 positionOverlayWindow 的记忆优先路径。
    const bounds = window.getBounds();
    const display = screen.getDisplayMatching(bounds);
    voiceInputOverlayPositionStore.save({
      x: bounds.x,
      y: bounds.y,
      displayId: display?.id,
      updatedAt: Date.now(),
    });
    log.debug('global overlay drag position saved', { x: bounds.x, y: bounds.y });
  });

  ipcMain.handle('voice-input:global-overlay-position-reset', (event): { ok: true } => {
    const window = getOverlayWindow();
    if (window && event.sender === window.webContents) {
      overlayDragSession = null;
      voiceInputOverlayPositionStore.clear();
      const cursorPoint = screen.getCursorScreenPoint();
      const display = screen.getDisplayNearestPoint(cursorPoint);
      window.setBounds(computeOverlayBounds(display));
      log.debug('global overlay position reset to default');
    }
    return { ok: true };
  });

  ipcMain.on('voice-input:global-shortcut-claim', (event, payload: { id?: unknown } | undefined) => {
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const pending = pendingFocusedWindowShortcutClaim;
    if (!pending || pending.id !== id || pending.webContentsId !== event.sender.id) return;
    clearTimeout(pending.timer);
    pendingFocusedWindowShortcutClaim = null;
    const queuedPhase = pending.modifierEndQueued
      ? 'end'
      : pending.modifierTapQueued
        ? 'tap'
        : null;
    if (queuedPhase) {
      setImmediate(() => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('voice-input:global-shortcut-trigger', { phase: queuedPhase });
        }
      });
    }
    log.debug('focused window claimed global shortcut', { id });
  });

  ipcMain.handle('voice-input:open-accessibility-settings', async (): Promise<VoiceInputGlobalResult> => {
    if (process.platform !== 'darwin') {
      return {
        ok: false,
        error: 'Accessibility settings are only available on macOS.',
        errorCode: 'unavailable',
      };
    }
    try {
      systemPreferences.isTrustedAccessibilityClient(true);
      await shell.openExternal(MAC_ACCESSIBILITY_SETTINGS_URL);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        errorCode: 'failed',
      };
    }
  });

  ipcMain.handle('voice-input:open-input-monitoring-settings', async (): Promise<VoiceInputGlobalResult> => {
    if (process.platform !== 'darwin') {
      return {
        ok: false,
        error: 'Input Monitoring settings are only available on macOS.',
        errorCode: 'unavailable',
      };
    }
    try {
      cachedInputMonitoringPermission = await requestMacInputMonitoringPermission();
      await shell.openExternal(MAC_INPUT_MONITORING_SETTINGS_URL);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        errorCode: 'failed',
      };
    }
  });

  ipcMain.handle(
    'voice-input:dictionary-toast-show',
    (_event, payload: unknown): { ok: true } | { ok: false; error: string } => {
      const entries = normalizeDictionaryToastEntries(payload);
      if (entries.length === 0) return { ok: false, error: 'Dictionary toast payload is incomplete.' };
      showDictionaryToastWindow({ entries });
      return { ok: true };
    },
  );

  ipcMain.handle('voice-input:dictionary-toast-close', (): { ok: true } => {
    closeDictionaryToastWindow();
    return { ok: true };
  });

  ipcMain.on('voice-input:global-overlay-ready', (event) => {
    const window = getOverlayWindow();
    if (!window || event.sender !== window.webContents) return;
    overlayLoaded = true;
    log.debug('global overlay renderer ready');
    if (!pendingOverlayStart) {
      // The overlay renderer can emit ready more than once around startup/HMR.
      // Only park the cached window when it is genuinely idle. During an
      // explicit shortcut activation startLoadedOverlaySession marks the
      // presentation active before asking the renderer to start, so a duplicate
      // ready event cannot hide the first visible overlay.
      if (!overlayPresentationActive && !window.isVisible()) {
        setOverlayIdlePresentationState(window);
      }
      return;
    }
    const start = pendingOverlayStart;
    pendingOverlayStart = null;
    startLoadedOverlaySession(window, start.shortcutInvokedAt);
  });

  ipcMain.handle('voice-input:global-restore-target-focus', async (): Promise<VoiceInputGlobalResult> => {
    try {
      const target = await resolveOverlayPasteTarget();
      log.debug(PASTE_DEBUG_TAG, 'restore target focus requested', {
        target: describePasteTarget(target),
      });
      await focusMacPasteTarget(target);
      return { ok: true };
    } catch (error) {
      const presentation = getPasteErrorPresentation(error);
      log.warn('restore paste target focus failed', {
        error: presentation.message,
        errorCode: presentation.code,
        detail: presentation.detail,
      });
      return {
        ok: false,
        error: presentation.message,
        errorCode: presentation.code,
      };
    }
  });

  app.once('will-quit', () => {
    if (registeredAccelerator) {
      globalShortcut.unregister(registeredAccelerator);
      registeredAccelerator = null;
    }
    registeredShortcut = null;
    registeredNativeShortcutLabel = null;
    registeredNativeShortcutKey = null;
    macModifierShortcutListener.stop();
    unregisterOverlayCancelShortcut();
    destroyOverlayWindow();
  });
}

async function setVoiceInputGlobalShortcut(shortcut: VoiceInputShortcut | null): Promise<VoiceInputGlobalResult> {
  if (process.platform === 'linux' && shortcut) {
    return {
      ok: false,
      error: 'Linux first release does not support global voice input shortcuts.',
      errorCode: 'unavailable',
    };
  }

  if (!shortcut) {
    if (registeredAccelerator) {
      globalShortcut.unregister(registeredAccelerator);
      registeredAccelerator = null;
    }
    registeredShortcut = null;
    registeredNativeShortcutLabel = null;
    registeredNativeShortcutKey = null;
    macModifierShortcutListener.stop();
    destroyOverlayWindow();
    log.info('global shortcut disabled');
    return { ok: true };
  }

  if (voiceInputShortcutNeedsMacNativeListener(shortcut, process.platform)) {
    if (process.platform !== 'darwin') {
      return { ok: false, error: 'Function/modifier voice input shortcuts are only available on macOS.' };
    }
    const nativeShortcutKey = stableVoiceInputShortcutKey(shortcut);
    if (registeredNativeShortcutKey === nativeShortcutKey && macModifierShortcutListener.isRunning()) {
      return { ok: true };
    }
    const result = await macModifierShortcutListener.setShortcut(shortcut);
    if (!result.ok) {
      if (registeredShortcut && voiceInputShortcutNeedsMacNativeListener(registeredShortcut, process.platform)) {
        await macModifierShortcutListener.setShortcut(registeredShortcut);
      }
      log.warn('native global shortcut registration failed', {
        code: shortcut.code,
        modifiers: shortcut.modifiers,
        error: result.error,
      });
      return result;
    }
    if (registeredAccelerator) {
      globalShortcut.unregister(registeredAccelerator);
      registeredAccelerator = null;
    }
    registeredShortcut = shortcut;
    registeredNativeShortcutLabel = getNativeShortcutLogLabel(shortcut);
    registeredNativeShortcutKey = nativeShortcutKey;
    log.info('native global shortcut registered', {
      code: shortcut.code,
      modifiers: shortcut.modifiers,
      trigger: shortcut.trigger,
    });
    void prewarmVoiceInputProvider();
    setTimeout(() => prewarmGlobalVoiceInputOverlay(), 1500);
    return { ok: true };
  }

  const accelerator = toElectronAccelerator(shortcut);
  if (!accelerator) {
    return { ok: false, error: 'Unsupported voice input shortcut.' };
  }
  if (isReservedGlobalShortcut(shortcut)) {
    return { ok: false, error: 'This shortcut conflicts with a system or common editing shortcut.' };
  }
  if (registeredAccelerator === accelerator) {
    return { ok: true };
  }
  const ok = globalShortcut.register(accelerator, handleGlobalVoiceInputShortcut);
  if (!ok) {
    log.warn('global shortcut registration failed', { accelerator });
    return { ok: false, error: `Global shortcut is already in use: ${accelerator}` };
  }

  if (registeredAccelerator && registeredAccelerator !== accelerator) {
    globalShortcut.unregister(registeredAccelerator);
  }
  registeredAccelerator = accelerator;
  registeredShortcut = shortcut;
  registeredNativeShortcutLabel = null;
  registeredNativeShortcutKey = null;
  macModifierShortcutListener.stop();
  log.info('global shortcut registered', { accelerator });
  // First-press warmup: read auth.json now so the very first shortcut press
  // does not pay for it on the critical path.
  void prewarmVoiceInputProvider();
  // Pre-create only a hidden idle overlay. It preserves the latency win without
  // letting app activation restore the overlay for normal menu shortcuts.
  setTimeout(() => prewarmGlobalVoiceInputOverlay(), 1500);
  return { ok: true };
}

function stableVoiceInputShortcutKey(shortcut: VoiceInputShortcut): string {
  const { modifiers } = shortcut;
  return [
    shortcut.trigger,
    shortcut.code,
    shortcut.key,
    modifiers.meta ? '1' : '0',
    modifiers.ctrl ? '1' : '0',
    modifiers.alt ? '1' : '0',
    modifiers.shift ? '1' : '0',
    modifiers.fn ? '1' : '0',
  ].join('|');
}

function handleGlobalVoiceInputShortcut(phase?: Extract<GlobalVoiceInputShortcutPhase, 'start'>): void {
  const invokedAt = Date.now();
  const overlay = getOverlayWindow();
  const overlayOpen = Boolean(overlay && overlayPresentationActive && overlay.isVisible());
  log.debug('global shortcut invoked', {
    overlayOpen,
    overlayVisible: Boolean(overlay?.isVisible()),
    appFocused: Boolean(BrowserWindow.getFocusedWindow()),
  });
  if (overlay && overlayPresentationActive && overlay.isVisible()) {
    if (phase === 'start') {
      pendingModifierOverlaySuppressNextTap = false;
      pendingModifierOverlaySuppressNextRelease = true;
    }
    overlay.webContents.send('voice-input:global-overlay-command', { type: 'submit' });
    return;
  }
  if (overlay && overlay.isVisible()) {
    setOverlayIdlePresentationState(overlay);
  }

  if (sendShortcutToActiveInlineVoiceInput(phase)) return;

  // Warm the provider auth path the moment the shortcut is detected. The
  // overlay/renderer takes ~100ms to ask for `voice-input:start`; doing the
  // disk read + token parse now overlaps that window so the WebSocket dial
  // finds the token already hot in memory.
  void prewarmVoiceInputProvider();

  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (focusedWindow) {
    sendShortcutToFocusedWindowOrFallback(focusedWindow, invokedAt, phase);
    return;
  }

  if (phase === 'start') {
    pendingModifierOverlaySuppressNextTap = true;
  }
  void showOverlayWindow(invokedAt);
}

function handleGlobalVoiceInputShortcutTap(): void {
  if (pendingFocusedWindowShortcutClaim) {
    pendingFocusedWindowShortcutClaim.modifierTapQueued = true;
    return;
  }
  if (pendingModifierOverlaySuppressNextRelease) {
    pendingModifierOverlaySuppressNextRelease = false;
    pendingModifierOverlaySuppressNextTap = false;
    return;
  }
  if (pendingModifierOverlaySuppressNextTap) {
    pendingModifierOverlaySuppressNextTap = false;
    return;
  }
  if (sendShortcutToActiveInlineVoiceInput('tap')) return;
  const overlay = getOverlayWindow();
  if (overlay && overlayPresentationActive && overlay.isVisible()) {
    overlay.webContents.send('voice-input:global-overlay-command', { type: 'submit' });
    return;
  }
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (focusedWindow) {
    focusedWindow.webContents.send('voice-input:global-shortcut-trigger', { phase: 'tap' });
  }
}

function handleGlobalVoiceInputShortcutSubmit(): void {
  if (pendingModifierOverlaySuppressNextRelease) {
    pendingModifierOverlaySuppressNextRelease = false;
    pendingModifierOverlaySuppressNextTap = false;
    return;
  }
  pendingModifierOverlaySuppressNextTap = false;
  if (sendShortcutToActiveInlineVoiceInput('end')) return;
  const overlay = getOverlayWindow();
  if (overlay && overlayPresentationActive) {
    overlay.webContents.send('voice-input:global-overlay-command', { type: 'submit' });
    return;
  }
  if (pendingOverlayStart) {
    pendingModifierOverlaySubmit = true;
    return;
  }
  if (pendingFocusedWindowShortcutClaim) {
    pendingFocusedWindowShortcutClaim.modifierEndQueued = true;
    return;
  }

  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (focusedWindow) {
    focusedWindow.webContents.send('voice-input:global-shortcut-trigger', { phase: 'end' });
  }
}

function sendShortcutToFocusedWindowOrFallback(
  focusedWindow: BrowserWindow,
  invokedAt: number,
  phase?: Extract<GlobalVoiceInputShortcutPhase, 'start'>,
): void {
  const id = `${invokedAt}-${++focusedWindowShortcutClaimSeq}`;
  if (pendingFocusedWindowShortcutClaim) {
    if (pendingFocusedWindowShortcutClaim.modifierEndQueued) {
      pendingModifierOverlaySubmit = true;
    }
    clearTimeout(pendingFocusedWindowShortcutClaim.timer);
    pendingFocusedWindowShortcutClaim = null;
  }

  // The main chat composer is the only in-app surface with inline dictation.
  // Give the focused renderer one event-loop turn to claim the shortcut when
  // that composer owns it; otherwise fall back to the global overlay so
  // Settings, dialogs, search boxes, and future text inputs inside the app get
  // the same voice-input method as external apps.
  const timer = setTimeout(() => {
    const pending = pendingFocusedWindowShortcutClaim;
    if (pending?.id !== id) return;
    if (pending.modifierEndQueued) {
      pendingModifierOverlaySubmit = true;
    }
    if (phase === 'start') {
      pendingModifierOverlaySuppressNextTap = !pending.modifierTapQueued && !pending.modifierEndQueued;
    }
    pendingFocusedWindowShortcutClaim = null;
    void showOverlayWindow(invokedAt);
  }, FOCUSED_WINDOW_SHORTCUT_CLAIM_TIMEOUT_MS);
  pendingFocusedWindowShortcutClaim = {
    id,
    webContentsId: focusedWindow.webContents.id,
    timer,
  };
  focusedWindow.webContents.send('voice-input:global-shortcut-trigger', { id, phase });
}

function sendShortcutToActiveInlineVoiceInput(phase?: GlobalVoiceInputShortcutPhase): boolean {
  for (const webContentsId of Array.from(activeInlineVoiceInputWebContentsIds)) {
    const window = BrowserWindow.getAllWindows()
      .find((candidate) => !candidate.isDestroyed() && candidate.webContents.id === webContentsId);
    if (!window || window.webContents.isDestroyed()) {
      activeInlineVoiceInputWebContentsIds.delete(webContentsId);
      continue;
    }
    log.debug('routing global shortcut to active inline voice input', {
      webContentsId,
      phase,
    });
    const shouldRestoreFocus = BrowserWindow.getFocusedWindow()?.webContents.id !== webContentsId;
    window.webContents.send('voice-input:global-shortcut-trigger', { phase });
    if (shouldRestoreFocus) {
      focusActiveInlineVoiceInputWindow(window);
    }
    return true;
  }
  return false;
}

function focusActiveInlineVoiceInputWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  if (window.isMinimized()) {
    window.restore();
  }
  const wasAlwaysOnTop = window.isAlwaysOnTop();
  if (process.platform === 'win32') {
    window.setAlwaysOnTop(true);
  }
  window.show();
  if (process.platform === 'darwin') {
    app.focus({ steal: true });
  }
  window.focus();
  if (process.platform === 'win32' && !wasAlwaysOnTop) {
    window.setAlwaysOnTop(false);
  }
}

function getOverlayWindow(): BrowserWindow | null {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    overlayWindow = null;
    overlayLoaded = false;
    return null;
  }
  return overlayWindow;
}

function getDictionaryToastWindow(): BrowserWindow | null {
  if (!dictionaryToastWindow || dictionaryToastWindow.isDestroyed()) {
    dictionaryToastWindow = null;
    return null;
  }
  return dictionaryToastWindow;
}

function closeDictionaryToastWindow(): void {
  if (dictionaryToastCloseTimer) {
    clearTimeout(dictionaryToastCloseTimer);
    dictionaryToastCloseTimer = null;
  }
  const window = getDictionaryToastWindow();
  dictionaryToastWindow = null;
  if (!window) return;
  window.destroy();
}

type HideOverlayWindowOptions = {
  preservePasteTarget?: boolean;
  restorePasteTarget?: boolean;
};

export function shouldRestoreOverlayPasteTarget(
  options: HideOverlayWindowOptions | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return !options?.preservePasteTarget && options?.restorePasteTarget !== false && platform === 'darwin';
}

async function hideOverlayWindow(options?: HideOverlayWindowOptions): Promise<void> {
  // Windows: destroy and recreate on the next show. Hiding +
  // showInactive() of a transparent / frameless / focusable:false /
  // alwaysOnTop BrowserWindow leaves it in a state where its own
  // buttons stop receiving mouse events from the 2nd appearance onward.
  // Trade the cached-renderer perf for input correctness; on Windows the
  // paste-target capture is a darwin-only no-op so there is no
  // preservePasteTarget contract to honor here. macOS keeps the cached
  // renderer warm; close/cancel resets native presentation state instead of
  // destroying the window so the next shortcut stays fast.
  if (process.platform === 'win32') {
    destroyOverlayWindow();
    return;
  }

  const window = getOverlayWindow();
  const preservePasteTarget = Boolean(options?.preservePasteTarget);
  // Snapshot the target BEFORE clearing the cache below so the focus restore
  // path (cancel-like close) can hand focus back to whatever app the user
  // originally invoked the overlay from.
  //
  // Skip on the paste path (preservePasteTarget=true): the Swift helper owns
  // focus during paste, and waiting on osascript here would just add ~150-300ms
  // of dead time before the overlay disappears. Settings navigation also opts
  // out explicitly: Cindy is the new target, so restoring the old app after
  // opening Settings would immediately put the requested page in background.
  const shouldRestorePasteTarget = shouldRestoreOverlayPasteTarget(options);
  const targetForFocusRestore = shouldRestorePasteTarget
    ? overlayPasteTarget
    : null;
  if (!preservePasteTarget) {
    overlayPasteTarget = null;
    overlayPasteContext = null;
    overlayPasteTargetPromise = null;
  }
  pendingOverlayStart = null;
  pendingModifierOverlaySubmit = false;
  pendingModifierOverlaySuppressNextTap = false;
  pendingModifierOverlaySuppressNextRelease = false;
  // 拖动进行中被隐藏（Esc / 提交）时放弃本次拖动，不落盘部分位置。
  overlayDragSession = null;
  unregisterOverlayCancelShortcut();
  if (!window) return;
  if (window.isVisible()) {
    window.hide();
  }
  setOverlayIdlePresentationState(window);
  if (shouldRestorePasteTarget && targetForFocusRestore?.processName) {
    // Manual close/cancel must make the panel disappear immediately. Restore
    // the original target asynchronously so a slow AX/osascript round-trip
    // cannot make the overlay feel stuck.
    void focusMacPasteTarget(targetForFocusRestore).catch((error) => {
      log.debug('focus restore after overlay close failed (ignored)', {
        target: describePasteTarget(targetForFocusRestore),
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  // Keep the renderer warm between global dictation runs, but reset the native
  // panel presentation after hiding. This preserves the close/cancel fix
  // (stale active/focus state is cleared) without throwing away the prewarmed
  // BrowserWindow/React/i18n path.
  scheduleMainAppPresenceRestore('global-voice-overlay-hidden');
}

function destroyOverlayWindow(): void {
  const window = getOverlayWindow();
  overlayWindow = null;
  overlayLoaded = false;
  overlayPresentationActive = false;
  pendingOverlayStart = null;
  pendingModifierOverlaySubmit = false;
  pendingModifierOverlaySuppressNextTap = false;
  pendingModifierOverlaySuppressNextRelease = false;
  overlayPasteTarget = null;
  overlayPasteContext = null;
  overlayPasteTargetPromise = null;
  overlayDragSession = null;
  cancelExternalDictionaryLearningWatch();
  unregisterOverlayCancelShortcut();
  if (!window) return;
  window.destroy();
}

function setOverlayIdlePresentationState(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  overlayPresentationActive = false;
  // `show: false` at BrowserWindow construction is not enough on macOS: a
  // prewarmed native window can still be unhidden when the app is activated by
  // a normal menu shortcut such as Cmd+,. Park the warm cache outside visible
  // screen space and make it transparent so even a native AppKit unhide cannot
  // surface it to the user. Explicit voice-input display always repositions and
  // restores opacity before showInactive().
  window.setOpacity(0);
  window.hide();
  window.setBounds(OVERLAY_IDLE_BOUNDS);
  window.setAlwaysOnTop(false);
  // The cached overlay is an input-method panel, not an app document window.
  // Keep Windows out of the taskbar while idle. On macOS, skipTaskbar can
  // perturb app-level Dock presence, so appPresence.ts owns that invariant and
  // the idle overlay is hidden via bounds/opacity/focusability instead.
  if (process.platform !== 'darwin') {
    window.setSkipTaskbar(true);
    return;
  }
  window.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true });
  window.setHiddenInMissionControl(true);
  window.setFocusable(false);
}

function prepareOverlayForDisplay(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  overlayPresentationActive = true;
  window.setOpacity(1);
  if (process.platform !== 'darwin') return;
  window.setHiddenInMissionControl(false);
  window.setFocusable(true);
}

function cancelExternalDictionaryLearningWatch(): void {
  const watch = externalDictionaryLearningWatch;
  externalDictionaryLearningWatch = null;
  watch?.timers.forEach((timer) => clearTimeout(timer));
}

function registerOverlayCancelShortcut(): void {
  if (overlayCancelRegistered) return;
  const ok = globalShortcut.register(OVERLAY_CANCEL_ACCELERATOR, () => {
    const overlay = getOverlayWindow();
    if (!overlay) return;
    overlay.webContents.send('voice-input:global-overlay-command', { type: 'cancel' });
  });
  if (!ok) {
    log.warn('overlay cancel shortcut registration failed', { accelerator: OVERLAY_CANCEL_ACCELERATOR });
    return;
  }
  overlayCancelRegistered = true;
}

function unregisterOverlayCancelShortcut(): void {
  if (!overlayCancelRegistered) return;
  globalShortcut.unregister(OVERLAY_CANCEL_ACCELERATOR);
  overlayCancelRegistered = false;
}

async function showOverlayWindow(shortcutInvokedAt = Date.now()): Promise<void> {
  const existing = getOverlayWindow();
  if (existing?.isVisible()) {
    existing.webContents.send('voice-input:global-overlay-command', { type: 'submit' });
    return;
  }

  log.debug('global overlay show requested', {
    elapsedSinceShortcutMs: Date.now() - shortcutInvokedAt,
  });

  const window = existing ?? createOverlayWindow(shortcutInvokedAt);
  pendingOverlayStart = { shortcutInvokedAt };
  if (overlayLoaded) {
    pendingOverlayStart = null;
    startLoadedOverlaySession(window, shortcutInvokedAt);
  }
}

function createOverlayWindow(shortcutInvokedAt: number): BrowserWindow {
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const bounds = computeOverlayBounds(display);
  // The global voice overlay behaves like an input-method candidate panel:
  // visible above other apps, not part of normal app switching, and not allowed
  // to take over the text field that will receive the paste.
  //
  // Keep platform responsibilities separate:
  // - This BrowserWindow config only describes the temporary overlay.
  // - appPresence.ts owns the invariant that the primary app remains visible in
  //   the macOS Dock / Windows taskbar.
  // - Paste target focus is restored later by explicit paste-target logic, not
  //   by activating this overlay or the main app.
  const window = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Platform presence is guarded centrally in appPresence.ts. On Windows the
    // overlay is taskbar-hidden. On macOS skipTaskbar is avoided because Dock
    // visibility is process-level; idle visibility is handled by parking the
    // cached window off-screen and making it non-focusable.
    skipTaskbar: process.platform !== 'darwin',
    hiddenInMissionControl: process.platform === 'darwin',
    show: false,
    // The cached hidden overlay must be non-focusable while idle. We switch it
    // to focusable only for explicit overlay display so macOS menu activation
    // cannot restore a stale hidden overlay.
    focusable: false,
    acceptFirstMouse: true,
    // Create the cached window as a plain hidden window. The floating /
    // all-workspaces presentation is applied only in the explicit show path.
    //
    // Do not use the macOS "panel" window type here. In Electron/macOS this can
    // transiently push the whole process into an accessory-like activation state,
    // making the Dock icon disappear until appPresence.ts restores it.
    alwaysOnTop: false,
    // The overlay draws its own card shadow in renderer CSS. Native window
    // shadow is based on the full transparent BrowserWindow bounds, which
    // creates a visible stray outline below the actual card on macOS.
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // The overlay is intentionally non-activating. Keep its renderer on the
      // foreground scheduling path so microphone callbacks are not delayed.
      backgroundThrottling: false,
    },
  });

  overlayWindow = window;
  overlayLoaded = false;
  // 浮窗建窗即 backgroundThrottling:false(保住麦克风回调调度),它的 Renderer 也装了
  // 装饰动画闸门(index.tsx 顶层安装,浮窗视图同样经过),但节流关闭会让 visibilityState
  // 恒为 visible。浮窗 hide 后窗口是缓存复用的、Renderer 仍活着,不广播的话 mic 波形
  // 这类常驻动画会在看不见的时候继续跑。
  installWindowHiddenBroadcast(window);
  window.on('show', () => {
    if (!overlayPresentationActive) {
      setImmediate(() => {
        if (!window.isDestroyed() && !overlayPresentationActive) {
          setOverlayIdlePresentationState(window);
        }
      });
    }
  });
  window.once('closed', () => {
    if (overlayWindow === window) overlayWindow = null;
    overlayLoaded = false;
    pendingOverlayStart = null;
    overlayPasteTarget = null;
    overlayPasteContext = null;
    overlayPasteTargetPromise = null;
    unregisterOverlayCancelShortcut();
    // A non-activating overlay must not leave the whole app in tool/background
    // presence. Restore after close, when paste/focus work is no longer in the
    // critical path.
    scheduleMainAppPresenceRestore('global-voice-overlay-closed');
  });
  window.webContents.once('did-finish-load', () => {
    log.debug('global overlay renderer loaded', {
      elapsedSinceShortcutMs: Date.now() - shortcutInvokedAt,
    });
  });
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const url = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    url.search = OVERLAY_QUERY;
    window.loadURL(url.toString());
  } else {
    window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      { query: { view: 'voice-input-overlay' } },
    );
  }
  return window;
}

function normalizeDictionaryToastEntries(payload: unknown): DictionaryToastEntryPayload[] {
  if (!payload || typeof payload !== 'object') return [];
  const candidate = payload as {
    entryId?: unknown;
    term?: unknown;
    entries?: unknown;
  };
  const rawEntries = Array.isArray(candidate.entries)
    ? candidate.entries
    : [{ entryId: candidate.entryId, term: candidate.term }];
  const seenIds = new Set<string>();
  return rawEntries
    .map((rawEntry) => {
      if (!rawEntry || typeof rawEntry !== 'object') return null;
      const entry = rawEntry as { entryId?: unknown; term?: unknown };
      const entryId = typeof entry.entryId === 'string' ? entry.entryId.trim() : '';
      const term = typeof entry.term === 'string'
        ? entry.term.trim().slice(0, DICTIONARY_TOAST_MAX_TERM_CHARS)
        : '';
      if (!entryId || !term || seenIds.has(entryId)) return null;
      seenIds.add(entryId);
      return { entryId, term };
    })
    .filter((entry): entry is DictionaryToastEntryPayload => Boolean(entry))
    .slice(0, DICTIONARY_TOAST_MAX_ENTRIES);
}

function showDictionaryToastWindow(payload: { entries: DictionaryToastEntryPayload[] }): void {
  closeDictionaryToastWindow();
  const window = createDictionaryToastWindow(payload);
  dictionaryToastWindow = window;
  dictionaryToastCloseTimer = setTimeout(() => {
    closeDictionaryToastWindow();
  }, DICTIONARY_TOAST_DURATION_MS);
}

export function showVoiceInputDictionaryToast(entries: DictionaryToastEntryPayload[]): void {
  if (entries.length === 0) return;
  showDictionaryToastWindow({ entries });
}

function createDictionaryToastWindow(payload: { entries: DictionaryToastEntryPayload[] }): BrowserWindow {
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const bounds = computeDictionaryToastBounds(display);
  const window = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: process.platform !== 'darwin',
    show: false,
    focusable: true,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  window.once('closed', () => {
    if (dictionaryToastWindow === window) dictionaryToastWindow = null;
    if (dictionaryToastCloseTimer) {
      clearTimeout(dictionaryToastCloseTimer);
      dictionaryToastCloseTimer = null;
    }
    scheduleMainAppPresenceRestore('voice-dictionary-toast-closed');
  });
  window.webContents.once('did-finish-load', () => {
    if (window.isDestroyed()) return;
    window.setAlwaysOnTop(true, 'floating');
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: process.platform === 'darwin',
    });
    window.showInactive();
    scheduleMainAppPresenceRestore('voice-dictionary-toast-shown');
  });

  // 词典 toast 同样 backgroundThrottling:false 且加载主 renderer 入口(index.html
  // ?view=voice-input-dictionary-toast),顶层已安装装饰动画闸门 —— 不广播的话
  // hide(如 Cmd+H)后 visibilityState 恒为 visible,闸门静默失效。
  installWindowHiddenBroadcast(window);

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const url = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    url.search = DICTIONARY_TOAST_QUERY;
    url.searchParams.set('entries', JSON.stringify(payload.entries));
    window.loadURL(url.toString());
  } else {
    window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      {
        query: {
          view: 'voice-input-dictionary-toast',
          entries: JSON.stringify(payload.entries),
        },
      },
    );
  }
  return window;
}

function startLoadedOverlaySession(window: BrowserWindow, shortcutInvokedAt: number): void {
  if (window.isDestroyed()) return;

  positionOverlayWindow(window);
  prepareOverlayForDisplay(window);

  // Startup ordering is intentional:
  // 1. Capture the paste target before showing the overlay.
  // 2. Tell the renderer to start microphone capture as soon as it is ready.
  // 3. Show the overlay on the next tick so UI display no longer gates mic start.
  const captureOverlayPromise = captureMacPasteTarget();
  overlayPasteTarget = null;
  overlayPasteContext = null;
  overlayPasteTargetPromise = captureOverlayPromise.then((captured) => captured?.target ?? null);
  void captureOverlayPromise
    .then((captured) => {
      if (overlayWindow !== window || window.isDestroyed()) return;
      overlayPasteTarget = captured?.target ?? null;
      overlayPasteContext = captured?.context ?? null;
      overlayPasteTargetPromise = null;
      log.debug(PASTE_DEBUG_TAG, 'captured target for overlay', {
        target: describePasteTarget(overlayPasteTarget),
        context: summarizePasteContext(overlayPasteContext),
      });
    })
    .catch((error) => {
      if (overlayWindow !== window || window.isDestroyed()) return;
      overlayPasteTargetPromise = null;
      log.warn('capture paste target failed', { error: stringifyError(error) });
    });

  registerOverlayCancelShortcut();
  window.setAlwaysOnTop(true, 'floating');
  // macOS transforms the whole process type by default when changing
  // all-workspaces visibility, which briefly removes the app from the Dock.
  // The main app must remain a normal Dock app, so the overlay opts out of that
  // transform and appPresence.ts remains the backstop if a future Electron
  // version changes this behavior.
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: process.platform === 'darwin',
  });
  window.webContents.send('voice-input:global-overlay-command', { type: 'start' });
  if (pendingModifierOverlaySubmit) {
    pendingModifierOverlaySubmit = false;
    setImmediate(() => {
      if (!window.isDestroyed() && overlayPresentationActive) {
        window.webContents.send('voice-input:global-overlay-command', { type: 'submit' });
      }
    });
  }
  setImmediate(() => {
    if (window.isDestroyed()) return;
    log.debug('global overlay ready to show', {
      elapsedSinceShortcutMs: Date.now() - shortcutInvokedAt,
    });
    window.showInactive();
    // showInactive preserves the user's focused app, but some Electron/macOS
    // combinations can still perturb app-level presence. Restore immediately
    // after showing without focusing the main app.
    scheduleMainAppPresenceRestore('global-voice-overlay-shown');
  });
}

function showPassiveOverlayWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  positionOverlayWindow(window);
  registerOverlayCancelShortcut();
  window.setAlwaysOnTop(true, 'floating');
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: process.platform === 'darwin',
  });
  prepareOverlayForDisplay(window);
  window.showInactive();
  scheduleMainAppPresenceRestore('global-voice-overlay-passive-shown');
}

function positionOverlayWindow(window: BrowserWindow): void {
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  // 记忆优先：用户拖动过就用保存位置（clamp 进现存屏幕可见区域），保存
  // 位置所在屏幕已不存在或从未拖动过则回退鼠标所在屏幕的默认位置。
  window.setBounds(resolveOverlayInitialBounds({
    savedPosition: voiceInputOverlayPositionStore.read(),
    displays: getOverlayPlacementDisplays(),
    size: { width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT },
    contentInset: OVERLAY_SHADOW_PADDING,
    edgePadding: OVERLAY_EDGE_PADDING,
    fallbackBounds: computeOverlayBounds(display),
  }));
}

function getOverlayPlacementDisplays(): OverlayPlacementDisplay[] {
  return screen.getAllDisplays().map((display) => ({
    id: display.id,
    workArea: display.workArea,
  }));
}

function computeOverlayBounds(display: Display): Rectangle {
  const x = Math.round(display.workArea.x + (display.workArea.width - OVERLAY_WIDTH) / 2);
  // Place the global dictation panel at 86% of the active screen's usable
  // height. A proportional position keeps it visually balanced across laptop
  // and external displays, unlike a fixed top offset.
  const availableHeight = Math.max(0, display.workArea.height - OVERLAY_HEIGHT);
  const preferredY = display.workArea.y + Math.round(availableHeight * OVERLAY_VERTICAL_PLACEMENT);
  const minY = display.workArea.y + OVERLAY_EDGE_PADDING;
  const maxY = display.workArea.y + display.workArea.height - OVERLAY_HEIGHT - OVERLAY_EDGE_PADDING;
  const y = Math.min(Math.max(preferredY, minY), Math.max(minY, maxY));
  return { x, y, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT };
}

function computeDictionaryToastBounds(display: Display): Rectangle {
  const overlayBounds = computeOverlayBounds(display);
  return {
    x: Math.round(overlayBounds.x + (overlayBounds.width - DICTIONARY_TOAST_WIDTH) / 2),
    y: Math.round(overlayBounds.y + (overlayBounds.height - DICTIONARY_TOAST_HEIGHT) / 2),
    width: DICTIONARY_TOAST_WIDTH,
    height: DICTIONARY_TOAST_HEIGHT,
  };
}

async function pasteTextToFocusedTarget(text: string, rawTranscriptText?: string): Promise<void> {
  const pasteTarget = await resolveOverlayPasteTarget();
  log.debug(PASTE_DEBUG_TAG, 'paste start', {
    chars: text.length,
    rawTranscriptChars: rawTranscriptText?.length ?? 0,
    target: describePasteTarget(pasteTarget),
  });
  if (process.platform === 'darwin') {
    await pasteTextToMacTarget(text, pasteTarget);
    scheduleExternalDictionaryLearningWatch(text, rawTranscriptText, pasteTarget, overlayPasteContext);
    return;
  }

  const snapshot = captureClipboardSnapshot();
  clipboard.writeText(text);
  const pasteStartedAt = Date.now();
  try {
    await simulatePasteShortcut();
  } catch (pasteError) {
    // Failure path restores synchronously. The +600ms delay used on success
    // exists so target apps can finish async clipboard reads after Ctrl+V —
    // there is no such reader after a failed paste. Keeping the delay races
    // the renderer copy-fallback button: that button rewrites the same voice
    // text to the clipboard, the scheduled restore then sees
    // readText === expectedTemporaryText, assumes "still our temp text" and
    // overwrites the user's freshly copied text with the snapshot. Tombstone
    // when snapshot is null, mirroring the darwin helper-failure path.
    if (snapshot) {
      restoreClipboardSnapshot(snapshot, text);
    } else {
      try {
        if (clipboard.readText('clipboard') === text) {
          clipboard.clear('clipboard');
          log.warn('cleared clipboard after non-darwin paste failure with no snapshot', {
            chars: text.length,
          });
        }
      } catch (clipboardError) {
        log.warn('clipboard tombstone after paste failure failed', {
          error: stringifyError(clipboardError),
        });
      }
    }
    throw pasteError;
  }
  log.info('pasted global voice input text', {
    chars: text.length,
    platform: process.platform,
    commandIssued: true,
    verified: false,
    elapsedMs: Date.now() - pasteStartedAt,
  });
  scheduleClipboardRestore(snapshot, text);
}

async function pasteTextToMacTarget(text: string, pasteTarget: MacPasteTarget | null): Promise<void> {
  if (!pasteTarget?.processName) {
    throw new PasteCommandError(
      'Could not paste into the current app.',
      'Could not identify the target app for voice input paste.',
      'unavailable',
    );
  }

  // macOS global dictation must preserve the user's clipboard while still
  // knowing whether the target really consumed our text. The Swift helper owns
  // that critical section: save clipboard -> lazy pasteboard item -> restore
  // focus -> Cmd+V -> AX before/after classification -> restore clipboard.
  // `unconfirmed` means the target consumed our pasteboard item but exposed no
  // post-paste AX text state. That is not strong enough for a "verified" label,
  // but it is also too strong to show a user-facing failure after text appears.
  const startedAt = Date.now();
  let result: MacTextInsertionHelperResult;
  try {
    result = await runMacTextInsertionHelper([
      '--command',
      'paste-verified',
      ...macTextInsertionTargetArgs(pasteTarget),
    ], {
      input: text,
      timeoutMs: MAC_TEXT_INSERTION_HELPER_PASTE_TIMEOUT_MS,
    });
  } catch (helperError) {
    // The helper was killed (timeout / SIGTERM) or otherwise failed before it
    // could run originalPasteboard.restore(). Clipboard is most likely sitting
    // with the user's voice text — leaking that into the next Cmd+V or share
    // action is both a privacy regression and a "wait what did I just paste"
    // moment. Clear it ONLY if it still equals the text we wrote, so we don't
    // wipe whatever the user copied between the failed paste and now.
    //
    // We can't fully restore the user's prior clipboard from main: the helper
    // is the only side that captured the rich snapshot (image / RTF / file
    // refs). Best we can do without a TS-side parallel snapshot is leave the
    // clipboard empty rather than contaminated.
    try {
      if (clipboard.readText('clipboard') === text) {
        clipboard.clear('clipboard');
        log.warn('cleared clipboard after paste helper failure to avoid voice-text leak', {
          chars: text.length,
        });
      }
    } catch (clipboardError) {
      log.warn('clipboard tombstone after paste helper failure failed', {
        error: stringifyError(clipboardError),
      });
    }
    throw helperError;
  }
  log.info('native global voice input paste result', {
    chars: text.length,
    target: describePasteTarget(pasteTarget),
    outcome: result.outcome,
    reason: result.reason,
    method: result.method,
    timings: result.timings,
    commandIssued: result.commandIssued,
    commandTargetApp: result.commandTargetApp,
    commandTargetBundleId: result.commandTargetBundleId,
    providerRequested: result.providerRequested,
    requestedTypes: result.requestedTypes,
    restoredClipboard: result.restoredClipboard,
    focusedRole: result.focusedRole,
    beforeChars: result.beforeChars,
    afterChars: result.afterChars,
    beforeSelectedRange: result.beforeSelectedRange,
    afterSelectedRange: result.afterSelectedRange,
    beforeNumberOfCharacters: result.beforeNumberOfCharacters,
    afterNumberOfCharacters: result.afterNumberOfCharacters,
    enhancedAxAttempted: result.enhancedAxAttempted,
    enhancedAxHelped: result.enhancedAxHelped,
    error: result.error,
    elapsedMs: Date.now() - startedAt,
  });

  if (result.outcome === 'verified_success' && result.ok === true) {
    return;
  }

  if (isMacAccessibilityPermissionError(result.reason) || isMacAccessibilityPermissionError(result.error)) {
    throw new PasteCommandError(
      'Accessibility permission is required for automatic input.',
      result.reason || result.error || 'Accessibility permission is not granted.',
      'permission',
    );
  }

  // Accept-unconfirmed has two channels:
  //
  // 1. Text-role focused element: the helper saw an AXTextArea/AXTextField
  //    take focus before/after paste but couldn't prove a length change
  //    (e.g. Electron contenteditable replaces draft on Cmd+V; some apps
  //    refresh AX state asynchronously). High-confidence success.
  //
  // 2. AX-blind consumer: focusedRole is null because the target hosts web
  //    content (browsers, plus newer Electron apps like Claude for Desktop /
  //    Cursor / Notion where Chromium's web-content AX tree is gated behind
  //    AT software and stays off by default). We can't prove the paste landed
  //    in an input, but the pasteboard provider was actually queried, which
  //    is the strongest non-OCR evidence macOS gives us. The product call
  //    here is to trust providerRequested over the bundle-id allowlist:
  //    false-failing every paste into Claude/Cursor/etc. is a much louder
  //    regression than the inverse (text was actually dropped because focus
  //    sat on a non-input element — user notices immediately and retries).
  //    AX_BLIND_BROWSER_BUNDLE_IDS is kept only so the accept log can tag
  //    the well-known browser case for analytics.
  //
  // Anything else falls through to PasteCommandError so the renderer's copy
  // fallback UI surfaces — that is the safe path when we genuinely don't
  // know what happened.
  const targetBundleId = result.commandTargetBundleId ?? pasteTarget?.bundleId ?? null;
  const acceptedAsTextRole =
    result.outcome === 'unconfirmed' &&
    result.commandIssued === true &&
    result.providerRequested === true &&
    isTextFocusedRole(result.focusedRole);
  const acceptedAsAxBlindConsumer =
    result.outcome === 'unconfirmed' &&
    result.commandIssued === true &&
    result.providerRequested === true &&
    result.focusedRole == null;
  if (acceptedAsTextRole || acceptedAsAxBlindConsumer) {
    const axBlindFlavor = isAxBlindBrowserBundleId(targetBundleId)
      ? 'ax-blind-browser'
      : 'ax-blind-consumer';
    log.warn('native global voice input paste accepted without AX verification', {
      chars: text.length,
      target: describePasteTarget(pasteTarget),
      reason: result.reason,
      focusedRole: result.focusedRole,
      acceptReason: acceptedAsTextRole ? 'text-role-focus' : axBlindFlavor,
      commandTargetApp: result.commandTargetApp,
      commandTargetBundleId: result.commandTargetBundleId,
      requestedTypes: result.requestedTypes,
    });
    return;
  }

  const message =
    result.outcome === 'unconfirmed'
      ? 'Could not confirm automatic input.'
      : 'Could not paste into the current app.';
  throw new PasteCommandError(
    message,
    result.reason || result.error || 'Automatic paste did not complete.',
    result.outcome === 'unconfirmed' ? 'unconfirmed' : 'unavailable',
  );
}

function scheduleClipboardRestore(snapshot: ClipboardSnapshot | null, expectedTemporaryText: string): void {
  if (!snapshot) return;
  // macOS paste is asynchronous from the target app's point of view. Even after
  // the paste command returns, the target app may still be about to read the
  // clipboard. Restore later, and do it off the UI-critical paste path so the
  // overlay can close as soon as paste has been issued.
  log.debug(PASTE_DEBUG_TAG, 'clipboard restore scheduled', {
    delayMs: CLIPBOARD_RESTORE_DELAY_MS,
  });
  setTimeout(() => {
    restoreClipboardSnapshot(snapshot, expectedTemporaryText);
  }, CLIPBOARD_RESTORE_DELAY_MS);
}

type CapturedOverlayTarget = {
  target: MacPasteTarget;
  context: MacPasteContext | null;
};

async function captureMacPasteTarget(): Promise<CapturedOverlayTarget | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const helperResult = await runMacTextInsertionHelper(['--command', 'capture-target']);
    if (helperResult.ok && helperResult.target?.processName) {
      log.debug(PASTE_DEBUG_TAG, 'capture target result (native)', {
        target: describePasteTarget(helperResult.target),
        context: summarizePasteContext(helperResult.context),
        enhancedAxAttempted: Boolean(helperResult.enhancedAxAttempted),
        enhancedAxHelped: Boolean(helperResult.enhancedAxHelped),
      });
      return {
        target: helperResult.target,
        context: helperResult.context ?? null,
      };
    }
  } catch (error) {
    log.debug(PASTE_DEBUG_TAG, 'native capture target unavailable, falling back to osascript', {
      error: getPasteErrorDetail(error),
    });
  }
  // osascript fallback: target only, no AX context. The helper is the only
  // path that knows how to read AXValue / AXSelectedTextRange — refiner just
  // gets fewer cues here, same as before this feature existed.
  try {
    const stdout = await execFilePromise(
      '/usr/bin/osascript',
      [
        '-e',
        [
          'tell application "System Events"',
          'set frontApp to first application process whose frontmost is true',
          'set frontName to name of frontApp',
          'set frontBundleId to ""',
          'try',
          'set frontBundleId to bundle identifier of frontApp',
          'end try',
          'set frontPid to unix id of frontApp',
          'return frontName & linefeed & frontBundleId & linefeed & frontPid',
          'end tell',
        ].join('\n'),
      ],
      'Could not capture focused app for voice input paste.',
    );
    const [processName, bundleId, pidValue] = stdout.trim().split(/\r?\n/);
    if (!processName) return null;
    const pid = parseOptionalInteger(pidValue);
    log.debug(PASTE_DEBUG_TAG, 'capture target result', {
      processName,
      bundleId: bundleId || '<empty>',
      pid,
    });
    return {
      target: { processName, bundleId: bundleId ?? '', pid },
      context: null,
    };
  } catch (error) {
    log.warn('capture paste target failed', { error: stringifyError(error) });
    return null;
  }
}

function scheduleExternalDictionaryLearningWatch(
  insertedText: string,
  rawTranscriptText: string | undefined,
  target: MacPasteTarget | null,
  context: MacPasteContext | null,
): void {
  if (process.platform !== 'darwin') return;
  cancelExternalDictionaryLearningWatch();
  if (!target?.processName || !insertedText.trim()) {
    log.debug('external dictionary learning watch not scheduled', {
      reason: !target?.processName
        ? 'missing_target'
        : 'empty_inserted_text',
      target: describePasteTarget(target),
      insertedChars: insertedText.length,
      context: summarizePasteContext(context),
      ...externalDictionaryLearningTextDebug({
        insertedText,
        originalContext: context,
      }),
    });
    return;
  }
  const watchContext = normalizeInitialDictionaryLearningContext(context, insertedText);

  const now = Date.now();
  const watch: ExternalDictionaryLearningWatch = {
    id: `external-dict-${now}-${Math.random().toString(36).slice(2)}`,
    target,
    context: watchContext,
    insertedText,
    rawTranscriptText,
    createdAt: now,
    lastActivityAt: now,
    timers: [],
    completed: false,
    inspecting: false,
  };
  externalDictionaryLearningWatch = watch;
  EXTERNAL_DICTIONARY_LEARNING_POLL_DELAYS_MS.forEach((delayMs) => {
    scheduleExternalDictionaryLearningPoll(watch, delayMs);
  });
  log.debug('external dictionary learning watch scheduled', {
    target: describePasteTarget(target),
    insertedChars: insertedText.length,
    rawTranscriptChars: rawTranscriptText?.length ?? 0,
    pollDelaysMs: EXTERNAL_DICTIONARY_LEARNING_POLL_DELAYS_MS,
    trackTimeoutMs: EXTERNAL_DICTIONARY_LEARNING_TRACK_TIMEOUT_MS,
    baselineMode: watchContext ? 'pre_paste_context' : 'await_post_paste_context',
    ...externalDictionaryLearningTextDebug({
      insertedText,
      originalContext: watchContext,
    }),
  });
}

function normalizeInitialDictionaryLearningContext(
  context: MacPasteContext | null,
  insertedText: string,
): MacPasteContext | null {
  if (!context) return null;
  const baseline = deriveInsertedTextBaselineContext(context, insertedText);
  if (baseline) return baseline;
  if (!isTextFocusedRole(context.focusedRole)) return null;
  const hasCursorRange =
    Number.isFinite(context.selectionLocation) &&
    Number.isFinite(context.selectionLength);
  const hasSideAnchor = Boolean(context.selectionBefore || context.selectionAfter);
  return hasCursorRange || hasSideAnchor ? context : null;
}

function deriveInsertedTextBaselineContext(
  context: MacPasteContext | null,
  insertedText: string,
): MacPasteContext | null {
  const fullFieldContent = context?.fullFieldContent;
  if (!fullFieldContent || !insertedText) return null;
  const index = fullFieldContent.lastIndexOf(insertedText);
  if (index < 0) return null;
  return {
    ...context,
    selectionBefore: fullFieldContent.slice(0, index),
    selectedText: insertedText,
    selectionAfter: fullFieldContent.slice(index + insertedText.length),
    selectionLocation: index,
    selectionLength: insertedText.length,
  };
}

function scheduleExternalDictionaryLearningPoll(
  watch: ExternalDictionaryLearningWatch,
  delayMs: number,
): void {
  const timer = setTimeout(() => {
    watch.timers = watch.timers.filter((item) => item !== timer);
    void inspectExternalDictionaryLearningWatch(watch);
  }, delayMs);
  watch.timers.push(timer);
}

function continueExternalDictionaryLearningWatch(
  watch: ExternalDictionaryLearningWatch,
  reason: string,
): boolean {
  if (watch.completed || externalDictionaryLearningWatch !== watch) return false;
  const now = Date.now();
  const elapsedMs = now - watch.createdAt;
  const idleMs = now - watch.lastActivityAt;
  if (idleMs >= EXTERNAL_DICTIONARY_LEARNING_TRACK_TIMEOUT_MS) {
    if (finalizePendingExternalDictionaryLearningEdit(watch, 'track_timeout')) {
      return false;
    }
    log.debug('external dictionary learning watch expired', {
      reason,
      target: describePasteTarget(watch.target),
      elapsedMs,
      idleMs,
      trackTimeoutMs: EXTERNAL_DICTIONARY_LEARNING_TRACK_TIMEOUT_MS,
    });
    cancelExternalDictionaryLearningWatch();
    return false;
  }
  const delayMs = Math.min(
    EXTERNAL_DICTIONARY_LEARNING_IDLE_POLL_MS,
    EXTERNAL_DICTIONARY_LEARNING_TRACK_TIMEOUT_MS - idleMs,
  );
  scheduleExternalDictionaryLearningPoll(watch, delayMs);
  return true;
}

async function inspectExternalDictionaryLearningWatch(
  watch: ExternalDictionaryLearningWatch,
): Promise<void> {
  if (watch.completed || externalDictionaryLearningWatch !== watch || watch.inspecting) return;
  // Base polls and stability re-checks can land in the same macrotask window.
  // Keep one AX capture/classification in flight so a single user edit cannot
  // publish duplicate dictionary-learning evidence or spend duplicate LLM calls.
  watch.inspecting = true;
  try {
    const captured = await captureMacPasteTargetForLearning(watch.target);
    if (watch.completed || externalDictionaryLearningWatch !== watch) return;
    if (!captured?.context) {
      if (finalizePendingExternalDictionaryLearningEdit(watch, 'capture_missing_context')) {
        return;
      }
      logExternalDictionaryLearningPollSkipped(watch, 'capture_missing_context', {
        currentContext: null,
      });
      continueExternalDictionaryLearningWatch(watch, 'capture_missing_context');
      return;
    }

    if (!watch.context) {
      const baselineContext = deriveInsertedTextBaselineContext(captured.context, watch.insertedText);
      if (!baselineContext) {
        logExternalDictionaryLearningPollSkipped(watch, 'awaiting_inserted_text_baseline', {
          currentContext: summarizePasteContext(captured.context),
        }, {
          currentContext: captured.context,
        });
        continueExternalDictionaryLearningWatch(watch, 'awaiting_inserted_text_baseline');
        return;
      }
      watch.context = baselineContext;
      watch.lastActivityAt = Date.now();
      log.debug('external dictionary learning baseline captured after paste', {
        target: describePasteTarget(watch.target),
        insertedChars: watch.insertedText.length,
        elapsedMs: Date.now() - watch.createdAt,
        context: summarizePasteContext(baselineContext),
      });
      continueExternalDictionaryLearningWatch(watch, 'baseline_captured');
      return;
    }

    const editResult = inspectExternalEditedInsertedText({
      originalContext: watch.context,
      currentContext: captured.context,
      insertedText: watch.insertedText,
    });
    if (!editResult.ok || !editResult.editedText) {
      if (EXTERNAL_DICTIONARY_LEARNING_PENDING_FINALIZE_REASONS.has(editResult.reason)) {
        if (finalizePendingExternalDictionaryLearningEdit(watch, editResult.reason, captured.context)) {
          return;
        }
      } else {
        if (watch.pendingEdit) {
          watch.lastActivityAt = Date.now();
        }
        watch.pendingEdit = undefined;
      }
      logExternalDictionaryLearningPollSkipped(watch, editResult.reason, {
        currentContext: summarizePasteContext(captured.context),
        expectedWindowChars: editResult.expectedWindowChars,
        currentWindowChars: editResult.currentWindowChars,
        insertedChars: editResult.insertedChars,
        leftAnchorChars: editResult.leftAnchorChars,
        rightAnchorChars: editResult.rightAnchorChars,
      }, {
        currentContext: captured.context,
      });
      if (EXTERNAL_DICTIONARY_LEARNING_TRANSIENT_SKIP_REASONS.has(editResult.reason)) {
        continueExternalDictionaryLearningWatch(watch, editResult.reason);
      }
      return;
    }
    const editedText = editResult.editedText;
    if (editedText === watch.insertedText) {
      if (watch.pendingEdit) {
        watch.lastActivityAt = Date.now();
      }
      watch.pendingEdit = undefined;
      logExternalDictionaryLearningPollSkipped(watch, 'edited_same_as_inserted', {
        currentContext: summarizePasteContext(captured.context),
        editedChars: editedText.length,
      }, {
        currentContext: captured.context,
        editedText,
      });
      continueExternalDictionaryLearningWatch(watch, 'edited_same_as_inserted');
      return;
    }

    const now = Date.now();
    const pending = watch.pendingEdit;
    if (!pending || pending.editedText !== editedText) {
      watch.lastActivityAt = now;
      watch.pendingEdit = {
        editedText,
        detectedAt: now,
        reason: editResult.reason,
      };
      continueExternalDictionaryLearningWatch(watch, editResult.reason);
      log.debug('external dictionary learning edit activity observed', {
        target: describePasteTarget(watch.target),
        insertedChars: watch.insertedText.length,
        editedChars: editedText.length,
        reason: editResult.reason,
        trackTimeoutMs: EXTERNAL_DICTIONARY_LEARNING_TRACK_TIMEOUT_MS,
        elapsedMs: now - watch.createdAt,
        ...externalDictionaryLearningTextDebug({
          insertedText: watch.insertedText,
          editedText,
          originalContext: watch.context,
          currentContext: captured.context,
        }),
      });
      return;
    }

    log.debug('external dictionary learning edit unchanged, waiting for track timeout', {
      target: describePasteTarget(watch.target),
      insertedChars: watch.insertedText.length,
      rawTranscriptChars: watch.rawTranscriptText?.length ?? 0,
      editedChars: editedText.length,
      idleMs: now - watch.lastActivityAt,
      trackTimeoutMs: EXTERNAL_DICTIONARY_LEARNING_TRACK_TIMEOUT_MS,
      elapsedMs: Date.now() - watch.createdAt,
      ...externalDictionaryLearningTextDebug({
        insertedText: watch.insertedText,
        editedText,
        originalContext: watch.context,
        currentContext: captured.context,
      }),
    });
    continueExternalDictionaryLearningWatch(watch, 'pending_edit_unchanged');
  } finally {
    if (!watch.completed && externalDictionaryLearningWatch === watch) {
      watch.inspecting = false;
    }
  }
}

function finalizePendingExternalDictionaryLearningEdit(
  watch: ExternalDictionaryLearningWatch,
  triggerReason: string,
  currentContext?: MacPasteContext | null,
): boolean {
  const pending = watch.pendingEdit;
  if (!pending || !watch.context || watch.completed || externalDictionaryLearningWatch !== watch) {
    return false;
  }
  const originalContext = watch.context;
  watch.completed = true;
  cancelExternalDictionaryLearningWatch();
  publishExternalDictionaryLearningEvidence({
    source: 'external_overlay',
    rawTranscriptText: watch.rawTranscriptText,
    beforeText: watch.insertedText,
    afterText: pending.editedText,
    context: {
      activeApp: watch.target.processName,
      selectionBefore: originalContext.selectionBefore,
      selectedText: originalContext.selectedText,
      selectionAfter: originalContext.selectionAfter,
    },
  });
  log.debug('external dictionary learning pending evidence finalized', {
    target: describePasteTarget(watch.target),
    triggerReason,
    originalReason: pending.reason,
    insertedChars: watch.insertedText.length,
    rawTranscriptChars: watch.rawTranscriptText?.length ?? 0,
    editedChars: pending.editedText.length,
    idleMs: Date.now() - watch.lastActivityAt,
    trackTimeoutMs: EXTERNAL_DICTIONARY_LEARNING_TRACK_TIMEOUT_MS,
    elapsedMs: Date.now() - watch.createdAt,
    ...externalDictionaryLearningTextDebug({
      insertedText: watch.insertedText,
      editedText: pending.editedText,
      originalContext,
      currentContext,
    }),
  });
  return true;
}

async function captureMacPasteTargetForLearning(
  expectedTarget: MacPasteTarget,
): Promise<CapturedOverlayTarget | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const helperResult = await runMacTextInsertionHelper(['--command', 'capture-target']);
    if (!helperResult.ok || !helperResult.target?.processName || !helperResult.context) {
      log.debug('external dictionary learning capture missing context', {
        expected: describePasteTarget(expectedTarget),
        helperOk: Boolean(helperResult.ok),
        hasTarget: Boolean(helperResult.target?.processName),
        hasContext: Boolean(helperResult.context),
        context: summarizePasteContext(helperResult.context),
        enhancedAxAttempted: Boolean(helperResult.enhancedAxAttempted),
        enhancedAxHelped: Boolean(helperResult.enhancedAxHelped),
        outcome: helperResult.outcome ?? null,
        reason: helperResult.reason ?? null,
        error: helperResult.error ?? null,
      });
      return null;
    }
    if (!isSameMacPasteTarget(helperResult.target, expectedTarget)) {
      log.debug('external dictionary learning skipped: frontmost target changed', {
        expected: describePasteTarget(expectedTarget),
        actual: describePasteTarget(helperResult.target),
        context: summarizePasteContext(helperResult.context),
        enhancedAxAttempted: Boolean(helperResult.enhancedAxAttempted),
        enhancedAxHelped: Boolean(helperResult.enhancedAxHelped),
      });
      return null;
    }
    log.debug('external dictionary learning capture result', {
      target: describePasteTarget(helperResult.target),
      context: summarizePasteContext(helperResult.context),
      enhancedAxAttempted: Boolean(helperResult.enhancedAxAttempted),
      enhancedAxHelped: Boolean(helperResult.enhancedAxHelped),
    });
    return {
      target: helperResult.target,
      context: helperResult.context,
    };
  } catch (error) {
    log.debug('external dictionary learning capture failed', {
      target: describePasteTarget(expectedTarget),
      error: getPasteErrorDetail(error),
    });
    return null;
  }
}

function logExternalDictionaryLearningPollSkipped(
  watch: ExternalDictionaryLearningWatch,
  reason: string,
  details?: Record<string, unknown>,
  debugText?: {
    currentContext?: MacPasteContext | null;
    editedText?: string;
  },
): void {
  log.debug('external dictionary learning poll skipped', {
    reason,
    target: describePasteTarget(watch.target),
    originalContext: summarizePasteContext(watch.context),
    insertedChars: watch.insertedText.length,
    elapsedMs: Date.now() - watch.createdAt,
    ...details,
    ...externalDictionaryLearningTextDebug({
      insertedText: watch.insertedText,
      editedText: debugText?.editedText,
      originalContext: watch.context,
      currentContext: debugText?.currentContext,
    }),
  });
}

function isSameMacPasteTarget(lhs: MacPasteTarget, rhs: MacPasteTarget): boolean {
  if (lhs.pid !== undefined && rhs.pid !== undefined) return lhs.pid === rhs.pid;
  if (lhs.bundleId && rhs.bundleId) return lhs.bundleId === rhs.bundleId;
  return Boolean(lhs.processName && rhs.processName && lhs.processName === rhs.processName);
}

function publishExternalDictionaryLearningEvidence(
  evidence: Pick<DictationDictionaryAdviceInput, 'source' | 'rawTranscriptText' | 'beforeText' | 'afterText' | 'context'>,
): void {
  const window = getOverlayWindow();
  if (!window || window.isDestroyed()) return;
  window.webContents.send('voice-input:dictionary-learning-evidence', { evidence });
}

// Length-only summary for normal diagnostics. Full text debug is isolated in
// externalDictionaryLearningTextDebug() and gated to dev builds while the
// automatic dictionary learner is being tuned.
function summarizePasteContext(context: MacPasteContext | null | undefined): Record<string, number | string | null> | null {
  if (!context) return null;
  return {
    selectionBeforeChars: context.selectionBefore?.length ?? 0,
    selectedTextChars: context.selectedText?.length ?? 0,
    selectionAfterChars: context.selectionAfter?.length ?? 0,
    fullFieldContentChars: context.fullFieldContent?.length ?? 0,
    fullFieldContentTruncated: context.fullFieldContentTruncated === true ? 'true' : 'false',
    totalChars: context.totalChars ?? 0,
    selectionLocation: context.selectionLocation ?? null,
    selectionLength: context.selectionLength ?? null,
    focusedRole: context.focusedRole ?? null,
    contextSource: context.contextSource ?? null,
  };
}

function externalDictionaryLearningTextDebug(input: {
  insertedText?: string;
  editedText?: string;
  originalContext?: MacPasteContext | null;
  currentContext?: MacPasteContext | null;
}): Record<string, unknown> {
  if (!EXTERNAL_DICTIONARY_TEXT_DEBUG) return {};
  return {
    debugText: {
      insertedText: input.insertedText ?? null,
      editedText: input.editedText ?? null,
      originalContext: pasteContextText(input.originalContext),
      currentContext: pasteContextText(input.currentContext),
    },
  };
}

function pasteContextText(context: MacPasteContext | null | undefined): Record<string, string | null> | null {
  if (!context) return null;
  return {
    selectionBefore: context.selectionBefore ?? '',
    selectedText: context.selectedText ?? '',
    selectionAfter: context.selectionAfter ?? '',
    fullFieldContent: context.fullFieldContent ?? null,
    focusedRole: context.focusedRole ?? null,
    contextSource: context.contextSource ?? null,
  };
}

async function resolveOverlayPasteTarget(): Promise<MacPasteTarget | null> {
  if (process.platform !== 'darwin') return null;
  if (overlayPasteTarget) {
    log.debug(PASTE_DEBUG_TAG, 'resolve target from cache', {
      target: describePasteTarget(overlayPasteTarget),
    });
    return overlayPasteTarget;
  }
  if (!overlayPasteTargetPromise) {
    log.debug(PASTE_DEBUG_TAG, 'resolve target missing promise');
    return null;
  }
  try {
    overlayPasteTarget = await overlayPasteTargetPromise;
    log.debug(PASTE_DEBUG_TAG, 'resolve target from promise', {
      target: describePasteTarget(overlayPasteTarget),
    });
    return overlayPasteTarget;
  } catch (error) {
    log.warn('resolve paste target failed', { error: stringifyError(error) });
    return null;
  }
}

function macTextInsertionTargetArgs(pasteTarget: MacPasteTarget): string[] {
  const args: string[] = [];
  if (pasteTarget.pid !== undefined) {
    args.push('--target-pid', String(pasteTarget.pid));
  }
  args.push('--target-bundle-id', pasteTarget.bundleId ?? '');
  args.push('--target-name', pasteTarget.processName ?? '');
  return args;
}

async function runMacTextInsertionHelper(
  args: string[],
  options?: { input?: string; timeoutMs?: number },
): Promise<MacTextInsertionHelperResult> {
  const helperPath = await resolveMacTextInsertionHelperPath();
  const stdout = await execFilePromise(helperPath, args, 'Could not run macOS text insertion helper.', {
    timeoutMs: options?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    input: options?.input,
  });
  try {
    return JSON.parse(stdout) as MacTextInsertionHelperResult;
  } catch (error) {
    // Don't include stdout in the error message: the helper may have printed
    // partial JSON or debug output containing AX-captured surrounding text from
    // the user's focused field, which would then end up in our log files.
    // We log byte length and the parse error only.
    throw new PasteCommandError(
      'Could not run macOS text insertion helper.',
      `Invalid helper response: ${error instanceof Error ? error.message : String(error)}. Stdout bytes: ${stdout.length}.`,
    );
  }
}

let macTextInsertionHelperPathPromise: Promise<string> | null = null;

function resolveMacTextInsertionHelperPath(): Promise<string> {
  if (macTextInsertionHelperPathPromise) return macTextInsertionHelperPathPromise;
  macTextInsertionHelperPathPromise = (async () => {
    const packagedPath = path.join(process.resourcesPath, MAC_TEXT_INSERTION_HELPER_RESOURCE);
    if (fs.existsSync(packagedPath)) return packagedPath;
    await buildDevMacTextInsertionHelper();
    return getMacTextInsertionHelperDevBinary();
  })().catch((error) => {
    macTextInsertionHelperPathPromise = null;
    throw error;
  });
  return macTextInsertionHelperPathPromise;
}

async function buildDevMacTextInsertionHelper(): Promise<void> {
  const source = resolveDevMacTextInsertionHelperSource();
  const binary = getMacTextInsertionHelperDevBinary();
  if (!fs.existsSync(source)) {
    throw new PasteCommandError(
      'Could not run macOS text insertion helper.',
      `Helper source missing at ${source}`,
    );
  }
  if (fs.existsSync(binary)) {
    const sourceMtimeMs = fs.statSync(source).mtimeMs;
    const binaryMtimeMs = fs.statSync(binary).mtimeMs;
    if (binaryMtimeMs >= sourceMtimeMs) return;
  }
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  await execFilePromise(
    'swiftc',
    [source, '-o', binary],
    'Could not build macOS text insertion helper.',
    { timeoutMs: 10_000 },
  );
  fs.chmodSync(binary, 0o755);
  log.info('built dev macOS text insertion helper', {
    path: binary,
  });
}

function resolveDevMacTextInsertionHelperSource(): string {
  const appPathSource = path.join(app.getAppPath(), MAC_TEXT_INSERTION_HELPER_SOURCE_RELATIVE);
  if (fs.existsSync(appPathSource)) return appPathSource;
  return path.join(__dirname, '..', '..', MAC_TEXT_INSERTION_HELPER_SOURCE_RELATIVE);
}

function getMacTextInsertionHelperDevBinary(): string {
  return path.join(app.getPath('userData'), 'voice-input', 'xdt-macos-text-insertion-helper');
}

async function focusMacPasteTarget(pasteTarget: MacPasteTarget | null | undefined): Promise<void> {
  if (process.platform !== 'darwin') return;
  if (!pasteTarget?.processName) {
    throw new Error('Could not identify the target app for voice input paste.');
  }
  const stdout = await execFilePromise(
    '/usr/bin/osascript',
    [
      '-e',
      [
        'on run argv',
        'set targetBundleId to item 1 of argv',
        'set targetName to item 2 of argv',
        'tell application "System Events"',
        'if targetBundleId is not "" then',
        'try',
        'set frontmost of first application process whose bundle identifier is targetBundleId to true',
        'end try',
        'end if',
        'if targetName is not "" then',
        'try',
        'set frontmost of first application process whose name is targetName to true',
        'end try',
        'end if',
        'delay 0.03',
        'set frontApp to first application process whose frontmost is true',
        'set frontName to name of frontApp',
        'return frontName',
        'end tell',
        'end run',
      ].join('\n'),
      pasteTarget.bundleId,
      pasteTarget.processName,
    ],
    'Could not restore focus to the target app.',
  );
  log.debug(PASTE_DEBUG_TAG, 'restore target focus result', {
    target: describePasteTarget(pasteTarget),
    frontApp: stdout.trim() || '<empty>',
  });
}

function captureClipboardSnapshot(): ClipboardSnapshot | null {
  try {
    const formats = clipboard.availableFormats('clipboard');
    const image = clipboard.readImage('clipboard');
    const bookmark = readClipboardBookmark();
    return {
      formats,
      text: clipboard.readText('clipboard'),
      html: clipboard.readHTML('clipboard'),
      rtf: clipboard.readRTF('clipboard'),
      bookmark,
      image: image.isEmpty() ? null : image,
      // Electron's typed clipboard helpers do not cover file references and
      // app-specific pasteboard payloads. Keeping the raw format buffers lets
      // us restore those formats when the platform clipboard implementation
      // supports them, while the common fields above remain the reliable
      // fallback for text/html/rtf/image/bookmark content.
      buffers: formats
        .map((format) => readClipboardBuffer(format))
        .filter((entry): entry is { format: string; buffer: Buffer } => Boolean(entry)),
    };
  } catch (error) {
    log.warn('clipboard snapshot failed before global paste', { error: stringifyError(error) });
    return null;
  }
}

function readClipboardBookmark(): { title: string; url: string } | null {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return null;
  try {
    const bookmark = clipboard.readBookmark();
    return bookmark.title || bookmark.url ? bookmark : null;
  } catch {
    return null;
  }
}

function readClipboardBuffer(format: string): { format: string; buffer: Buffer } | null {
  try {
    const buffer = clipboard.readBuffer(format);
    return buffer.byteLength > 0 ? { format, buffer: Buffer.from(buffer) } : null;
  } catch {
    return null;
  }
}

function restoreClipboardSnapshot(snapshot: ClipboardSnapshot | null, expectedTemporaryText: string): void {
  if (!snapshot) return;
  try {
    if (clipboard.readText('clipboard') !== expectedTemporaryText) {
      log.info('skip clipboard restore because clipboard changed after global paste');
      return;
    }

    clipboard.clear('clipboard');
    if (shouldPreferRawClipboardRestore(snapshot)) {
      if (!restoreRawClipboardFormats(snapshot)) {
        restoreCommonClipboardFormats(snapshot);
      }
      return;
    }
    if (!restoreCommonClipboardFormats(snapshot)) {
      restoreRawClipboardFormats(snapshot);
    }
  } catch (error) {
    log.warn('clipboard restore failed after global paste', { error: stringifyError(error) });
  }
}

function restoreRawClipboardFormats(snapshot: ClipboardSnapshot): boolean {
  let restored = false;
  for (const { format, buffer } of snapshot.buffers) {
    try {
      clipboard.writeBuffer(format, buffer, 'clipboard');
      restored = true;
    } catch {
      // Some native pasteboard formats are read-only through Electron.
    }
  }
  return restored;
}

function shouldPreferRawClipboardRestore(snapshot: ClipboardSnapshot): boolean {
  if (snapshot.buffers.length === 0) return false;
  if (!snapshot.text && !snapshot.html && !snapshot.rtf && !snapshot.image && !snapshot.bookmark) return true;
  return snapshot.formats.some((format) => {
    const normalized = format.toLowerCase();
    return normalized.includes('file') || normalized.includes('filename');
  });
}

function restoreCommonClipboardFormats(snapshot: ClipboardSnapshot): boolean {
  const data: Parameters<typeof clipboard.write>[0] = {};
  if (snapshot.text) data.text = snapshot.text;
  if (snapshot.html) data.html = snapshot.html;
  if (snapshot.rtf) data.rtf = snapshot.rtf;
  if (snapshot.image) data.image = snapshot.image;
  if (snapshot.bookmark?.url) {
    data.text = data.text || snapshot.bookmark.url;
    data.bookmark = snapshot.bookmark.title || snapshot.bookmark.url;
  }

  if (Object.keys(data).length > 0) {
    clipboard.write(data, 'clipboard');
    return true;
  }
  if (snapshot.formats.length === 0) {
    clipboard.clear('clipboard');
    return true;
  }
  return false;
}

async function simulatePasteShortcut(): Promise<void> {
  switch (process.platform) {
    case 'darwin':
      throw new Error('macOS global paste must use the native verification helper.');
    case 'win32':
      await execFilePromise('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^v")',
      ]);
      return;
    case 'linux':
      await execFilePromise('xdotool', ['key', 'ctrl+v']);
      return;
    default:
      throw new Error(`Global paste is not supported on ${process.platform}.`);
  }
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function describePasteTarget(target: MacPasteTarget | null | undefined): Record<string, string> | null {
  if (!target) return null;
  return {
    processName: target.processName || '<empty>',
    bundleId: target.bundleId || '<empty>',
  };
}

// Mirrors the Swift helper's isTextRole allowlist. AXSecureTextField is
// intentionally excluded for the same secure-field reason (passwords land
// there). Keep these two lists in sync — a role accepted here that the
// helper would reject means we'd bless an "unconfirmed" paste that the
// helper itself thinks went into a non-text element.
function isTextFocusedRole(role: string | null | undefined): boolean {
  return role === 'AXTextArea' || role === 'AXTextField';
}

// Apps where macOS top-level AX cannot see the focused element when the user
// is in WEB CONTENT. Chrome/Edge/Arc/etc. run the renderer in a separate
// process; AXFocusedUIElement on the browser app returns nothing for web
// inputs unless VoiceOver is forced on. The helper's `before`/`after`
// snapshots come up `focusedRole: null, beforeChars: null` for both:
//
//   (a) user is in a web <input>/<textarea>/contenteditable — paste WILL land
//   (b) user has no input focused at all — paste will be silently dropped
//
// We can't tell (a) from (b) from AX alone. (a) is the overwhelming common
// case (Gmail, ChatGPT, Slack web, Claude.ai, Notion, Linear...), so the
// product call here is to ACCEPT unconfirmed pastes for these bundleIds when
// the pasteboard provider was queried — at the cost of silently dropping
// (b). The user will notice (b) immediately ("text didn't appear") and can
// retry; conversely false-failing (a) on every Chrome paste is a much louder
// regression. Native macOS apps stay strict (require text role) because
// their AX is not blind in the same way.
//
// Add bundleIds here when a browser-class app exhibits the same AX-blindness
// pattern. Don't add Electron apps unless you've actually verified they show
// `focusedRole: null` for their input fields — most Electron apps expose
// AXTextField correctly via Chromium's accessibility tree.
const AX_BLIND_BROWSER_BUNDLE_IDS = new Set([
  'com.google.Chrome',
  'com.google.Chrome.canary',
  'com.google.Chrome.beta',
  'com.google.Chrome.dev',
  'com.apple.Safari',
  'com.apple.SafariTechnologyPreview',
  'com.microsoft.edgemac',
  'com.microsoft.edgemac.Beta',
  'com.microsoft.edgemac.Dev',
  'com.microsoft.edgemac.Canary',
  'company.thebrowser.Browser', // Arc
  'company.thebrowser.dia',     // Dia
  'org.mozilla.firefox',
  'org.mozilla.firefoxdeveloperedition',
  'com.brave.Browser',
  'com.brave.Browser.beta',
  'com.brave.Browser.nightly',
  'com.vivaldi.Vivaldi',
  'com.operasoftware.Opera',
]);

function isAxBlindBrowserBundleId(bundleId: string | null | undefined): boolean {
  return Boolean(bundleId && AX_BLIND_BROWSER_BUNDLE_IDS.has(bundleId));
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function execFilePromise(
  command: string,
  args: string[],
  fallbackMessage?: string,
  options?: { timeoutMs?: number; input?: string },
): Promise<string> {
  if (options?.input !== undefined) {
    return spawnWithInputPromise(command, args, options.input, fallbackMessage, options.timeoutMs);
  }
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: options?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr?.toString().trim();
        reject(new PasteCommandError(fallbackMessage ?? 'Command failed.', detail || error.message));
        return;
      }
      resolve(stdout?.toString() ?? '');
    });
  });
}

function spawnWithInputPromise(
  command: string,
  args: string[],
  input: string,
  fallbackMessage?: string,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new PasteCommandError(fallbackMessage ?? 'Command timed out.', `Command timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new PasteCommandError(fallbackMessage ?? 'Command failed.', error.message));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      if (code !== 0) {
        reject(new PasteCommandError(fallbackMessage ?? 'Command failed.', stderr || `Command exited with code ${code}.`));
        return;
      }
      resolve(stdout);
    });
    child.stdin.end(input, 'utf8');
  });
}

class PasteCommandError extends Error {
  constructor(
    message: string,
    readonly detail: string,
    readonly code: VoiceInputGlobalErrorCode = 'failed',
  ) {
    super(message);
    this.name = 'PasteCommandError';
  }
}

function getPasteErrorPresentation(error: unknown): {
  message: string;
  detail: string;
  code: VoiceInputGlobalErrorCode;
} {
  if (error instanceof PasteCommandError) {
    return {
      message: error.message,
      detail: error.detail,
      code: error.code,
    };
  }
  if (error instanceof Error) {
    if (error.message.includes('Paste is disabled in ')) {
      return {
        message: 'Paste is not available in the current app.',
        detail: error.message,
        code: 'unavailable',
      };
    }
    return {
      message: error.message,
      detail: error.message,
      code: 'failed',
    };
  }
  return {
    message: String(error),
    detail: String(error),
    code: 'failed',
  };
}

function isMacAccessibilityPermissionError(value: string | null | undefined): boolean {
  if (!value) return false;
  return value.toLowerCase().includes('accessibility permission is not granted');
}

function getPasteErrorDetail(error: unknown): string {
  if (error instanceof PasteCommandError) return error.detail;
  if (error instanceof Error) return error.message;
  return String(error);
}

function isReservedGlobalShortcut(shortcut: VoiceInputShortcut): boolean {
  if (process.platform === 'darwin') {
    const onlyCommand = shortcut.modifiers.meta &&
      !shortcut.modifiers.ctrl &&
      !shortcut.modifiers.alt &&
      !shortcut.modifiers.shift;
    const commandShift = shortcut.modifiers.meta &&
      shortcut.modifiers.shift &&
      !shortcut.modifiers.ctrl &&
      !shortcut.modifiers.alt;
    if (onlyCommand && MAC_CORE_EDITING_SHORTCUTS.has(shortcut.code)) return true;
    if (commandShift && shortcut.code === 'KeyZ') return true;
    return false;
  }
  if (process.platform === 'win32') {
    return isWindowsReservedGlobalShortcut(shortcut);
  }
  return false;
}

function isWindowsReservedGlobalShortcut(shortcut: VoiceInputShortcut): boolean {
  const code = shortcut.code;
  const ctrlOnly = shortcut.modifiers.ctrl &&
    !shortcut.modifiers.alt &&
    !shortcut.modifiers.shift &&
    !shortcut.modifiers.meta;
  const altOnly = shortcut.modifiers.alt &&
    !shortcut.modifiers.ctrl &&
    !shortcut.modifiers.shift &&
    !shortcut.modifiers.meta;
  const ctrlAlt = shortcut.modifiers.ctrl &&
    shortcut.modifiers.alt &&
    !shortcut.modifiers.shift &&
    !shortcut.modifiers.meta;

  if (ctrlOnly && code === 'Space') return true;
  if (altOnly && new Set(['Tab', 'F4', 'Escape']).has(code)) return true;
  if (ctrlAlt && code === 'Delete') return true;
  return shortcut.modifiers.meta;
}

function toElectronAccelerator(shortcut: VoiceInputShortcut): string | null {
  if (shortcut.modifiers.fn) return null;
  const key = toAcceleratorKey(shortcut);
  if (!key) return null;

  const modifiers: string[] = [];
  if (shortcut.modifiers.ctrl) modifiers.push('Ctrl');
  if (shortcut.modifiers.alt) modifiers.push('Alt');
  if (shortcut.modifiers.shift) modifiers.push('Shift');
  if (shortcut.modifiers.meta) modifiers.push(process.platform === 'darwin' ? 'Command' : 'Super');
  return [...modifiers, key].join('+');
}

function getNativeShortcutLogLabel(shortcut: VoiceInputShortcut): string {
  const modifiers = [
    shortcut.modifiers.fn ? 'Fn' : '',
    shortcut.modifiers.ctrl ? 'Ctrl' : '',
    shortcut.modifiers.alt ? 'Alt' : '',
    shortcut.modifiers.shift ? 'Shift' : '',
    shortcut.modifiers.meta ? 'Meta' : '',
  ].filter(Boolean);
  return [shortcut.trigger === 'modifier' ? 'modifier' : 'keyboard', ...modifiers, shortcut.code].join('+');
}

function toAcceleratorKey(shortcut: VoiceInputShortcut): string | null {
  const { code, key } = shortcut;
  const keyFromCode = code.match(/^Key([A-Z])$/)?.[1] ?? code.match(/^Digit([0-9])$/)?.[1];
  if (keyFromCode) return keyFromCode;
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) return code;

  const mapped = KEY_CODE_TO_ACCELERATOR[code];
  if (mapped) return mapped;
  if (key && key.length === 1 && /^[A-Za-z0-9]$/.test(key)) return key.toUpperCase();
  return null;
}

const KEY_CODE_TO_ACCELERATOR: Record<string, string> = {
  Backspace: 'Backspace',
  Delete: 'Delete',
  Enter: 'Enter',
  Escape: 'Esc',
  Space: 'Space',
  Tab: 'Tab',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
};
