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
import type { Display, IpcMainInvokeEvent, NativeImage, Point, Rectangle, WebContents } from 'electron';
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
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
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
  computeOverlayPositionRatio,
  isBoundsCenterOnDisplay,
  normalizeFocusedWindowFrame,
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
/**
 * 正在录制快捷键的 renderer —— 与上面那个「keys 转发名单」是两件事。
 *
 * 转发名单在 capture 起不来时会被清掉（起不来就没有 keys 可转发），但**录制框还开着**：
 * 缺监听权限时用户照样在录裸修饰键。拿转发名单当「有没有在录制」用，就会在这种状态下判成
 * 「没在录」，于是兜底恢复把已保存的全局快捷键装回去 —— 用户按键试录会真的触发语音输入。
 *
 * 所以录制会话单独记账：只在显式 stop 或 renderer 销毁时才移除。
 */
const modifierShortcutRecordingSessionIds = new Set<number>();
const activeInlineVoiceInputWebContentsIds = new Set<number>();

/**
 * 有任何窗口的快捷键录制框开着时，全局快捷键的**新激活**一律丢弃。
 *
 * 录制期由 renderer 主动挂起（suspend）是第一道；这条是投递层的兜底，因为「注册」和「录制」
 * 在多窗口下必然会有交叠：两个设置页可以同时开着录制框，一边提交的那一刻另一边还在录。把危险
 * 堵在投递而不是堵在注册，就不必为了避开交叠去推迟注册 —— 推迟会让注册失败（比如 F16 被别的
 * 应用占了）没法在提交时报给用户，界面和存盘留着一个永远不生效的快捷键。
 *
 * 转发给录制页的 keys 不受影响：录制本身就靠它。
 *
 * `end` 是例外，必须照常投递：按住说话的会话可能在录制框打开**之前**就已经 start 了，而挂起
 * （或替换）listener 会调 endActiveTriggerIfNeeded() 补发一次 end。把这个 end 也丢掉，那个
 * 会话就永远停不下来 —— listener 已经停了，它还在录。所以只挡新激活（start / tap）。
 *
 * 但「照常投递」要按**配对**来判，不是按「此刻还在不在录制」，见 nativeActivationStartDelivered。
 */
function hasActiveShortcutRecordingSession(): boolean {
  return modifierShortcutRecordingSessionIds.size > 0;
}

/**
 * 上一次 native 激活的 start 有没有真的投递到下游。
 *
 * listener 的 triggered / end 是它自己的内部时序，与这里的投递层抑制无关：被上面那条守卫挡掉的
 * start，用户按住超过阈值再松手时照样会给出一条 end（endActiveTriggerIfNeeded 补发的那条同理）。
 * 而 end 在下游就是「停止并提交」—— 一个正在跑的 inline 语音输入会话会被这条**没有配对 start**
 * 的 end 直接提交掉，而用户只是按了一下本该被吞掉的键。
 *
 * 所以 end 的投递条件是「配对的 start 投递过没有」。这也覆盖了录制框已经关掉、end 才姗姗来迟的
 * 情形 —— 那时录制守卫早就不生效了，只有配对关系还算数。
 */
let nativeActivationStartDelivered = false;

const macModifierShortcutListener = new MacModifierShortcutListener({
  onTrigger: (phase) => {
    if (phase !== 'end' && hasActiveShortcutRecordingSession()) {
      // 挡掉 start 就等于这次激活在下游不存在，它后面那条配对的 end 也必须一起挡掉。
      if (phase === 'start') nativeActivationStartDelivered = false;
      log.debug('ignoring native global shortcut activation while recording', { phase });
      return;
    }
    if (phase === 'end' && !nativeActivationStartDelivered) {
      log.debug('ignoring native global shortcut end without a delivered start');
      return;
    }
    // tap 没有配对的 end；end 到这里就算消费掉了。两种都把配对状态清干净。
    nativeActivationStartDelivered = phase === 'start';
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
  // `pendingInputMonitoring` = 设置已存下来，但 macOS 监听权限还没给，所以快捷键暂不生效。
  // 这不是失败：不把用户的选择存住，设置页那个「去授权」入口就永远出不来（它的显示条件
  // 依赖已保存的 shortcut），用户会被锁在「要授权得先设快捷键、设快捷键得先授权」里。
  | { ok: true; settings: VoiceInputSettings; pendingInputMonitoring?: boolean }
  | { ok: false; error: string; errorCode?: VoiceInputGlobalErrorCode };

type VoiceInputGlobalErrorCode =
  | 'empty'
  | 'unavailable'
  | 'unconfirmed'
  | 'permission'
  | 'failed'
  /**
   * 这次调用在启动 listener 期间被更晚的一轮顶掉了。既不是故障也不该清理状态，
   * renderer 收到后静默丢弃即可——真正的结果由顶掉它的那一轮给出。
   */
  | 'superseded';

export type VoiceInputPermissionSnapshot =
  | { ok: true; status: string }
  | { ok: false; status: string; error: string };

/**
 * 请求监听权限的结果。只回状态枚举、不回 error 字符串：真故障已经在 handler 里抛成
 * 统一 IPC 错误，而 helper 的原始 error 含内部绝对路径，不能过桥（见
 * `docs/dev-rules/electron-security-and-process-boundaries.md` §5）。
 */
type VoiceInputInputMonitoringRequestResult = { ok: true; status: string };

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
  /** 流式进度行的事件名；命令的最终结果行没有这个字段。 */
  event?: string;
  /** 前台窗口 frame（DIP 屏幕坐标），进度行与最终结果行都会带。 */
  frame?: unknown;
  frameSource?: string;
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
// 多屏下等待「前台窗口在哪块屏」的上限。超时就用鼠标所在屏，宁可判定退化
// 也不让浮窗出现明显延迟；答案迟到时不再挪窗，避免可见的跨屏跳动。
const OVERLAY_FOCUSED_DISPLAY_DEADLINE_MS = 90;
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
// 最近一次「浮窗真正呈现在哪」的 bounds。浮窗 hide 后会被停到屏幕外，实时
// bounds 不能当锚点，全局浮窗路径的词典 toast 靠这份记录跟到同一块屏、同一位置。
let lastPresentedOverlayBounds: Rectangle | null = null;
// 从「发布证据」交棒给「显示 toast」的锚点队列，一次性消费。
//
// 快照是在粘贴开始前拍的（见 pasteTextToFocusedTarget）：那才是产生这条听写的浮窗
// 现场。之后的粘贴 await、延迟轮询、模型往返期间用户都可能开新会话，锚点必须跟着
// 来源会话走，并在显示时用呈现代次复核，否则旧会话的 toast 会盖在新浮窗上。
//
// 为什么不需要给每条证据编 ID：锚点的身份就是它的呈现代次。代次变过的锚点对任何
// 请求都无效（那正是「期间又开过浮窗」），所以取用时直接丢弃过期的、拿代次仍匹配
// 的那个——见 takeOverlayDictionaryToastAnchor()。
const pendingDictionaryToastAnchors: DictionaryToastAnchor[] = [];
// 队列只用于「刚发布、还没出 toast」的证据。renderer 侧若因功能开关未发起 advisor，
// 对应锚点不会被取走，所以设上限丢最旧，避免无界增长。
const DICTIONARY_TOAST_ANCHOR_MAX_ENTRIES = 8;
// 浮窗呈现代次。焦点屏查询是异步的，它的回调必须能认出「这次呈现还算不算数」：
// 会话被取消（hide / 复位到 idle）或已经开始了新一次呈现时，迟到的回调不得再
// 定位或显示窗口——浮窗是缓存复用的，hide 并不销毁它，只靠 isDestroyed() 判断
// 会让已取消的浮窗重新出现。
let overlayPresentationSeq = 0;
// 多屏下浮窗会先等最多 90ms 的焦点屏答案再显示。这段窗口里呈现已经开始（麦克风
// 在录）但窗口还不可见，所以「浮窗是否已打开」不能只看 isVisible()：否则等待期
// 内再按一次快捷键不会走提交分支，而是又开一次呈现，用户那一下就丢了。
let overlayPresentationAwaitingShow = false;

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
  /**
   * 这次听写的浮窗现场，建 watch 时（刚粘贴完、浮窗刚收起）就拍下来。
   * watch 会延迟轮询几十秒，期间用户可能已经在另一块屏开了新一次浮窗，所以锚点
   * 必须跟着 watch 走，不能等发布证据时再去读进程级的「最近一次浮窗位置」。
   */
  toastAnchor: DictionaryToastAnchor | null;
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

/** 一次浮窗听写的「现场」：浮窗当时的位置 + 当时的呈现代次。 */
export type DictionaryToastAnchor = {
  bounds: Rectangle;
  presentationSeq: number;
};

type DictionaryToastPayload = {
  entries: DictionaryToastEntryPayload[];
  /**
   * 非 null = 该 toast 来自全局浮窗听写，且已绑定产生它的那次浮窗现场，
   * 显示时贴着那个位置出现（仍要过呈现代次与屏幕存在性复核）。
   */
  anchor: DictionaryToastAnchor | null;
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
  return isOverlayPresentationOpen(getOverlayWindow());
}

/**
 * 一次浮窗呈现是否处于「已打开」状态：呈现生效，且窗口已可见或正等着显示。
 * 快捷键的提交分支、Dock 激活让位判断都必须用这个，而不是裸 isVisible()。
 */
function isOverlayPresentationOpen(overlay: BrowserWindow | null): boolean {
  if (!overlay || overlay.isDestroyed()) return false;
  if (!overlayPresentationActive) return false;
  return overlay.isVisible() || overlayPresentationAwaitingShow;
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

/**
 * 交给 renderer 的统一失败文案。listener 自己的 error 可能是 swiftc stderr、
 * `Modifier shortcut listener source missing at <绝对路径>` 或 `spawn <绝对路径> ENOENT`,
 * 都带内部路径，按 electron-security §5 不能原样过桥；细节只进主进程日志。
 */
const MAC_NATIVE_LISTENER_FAILURE_MESSAGE = 'Could not start the voice input shortcut listener.';

type MacNativeListenerStartResult =
  | { ok: true }
  | { ok: false; error: string; superseded?: true };

/**
 * 包一层 try/catch 再调 listener。
 *
 * setShortcut / startKeyCapture 不只会返回 { ok: false }，还会**抛**：dev 下
 * resolveMacModifierShortcutListenerBinary 在源码缺失时直接 throw，swiftc 失败时
 * execFile 的 reject 会带 stderr，而 startChildProcess 里那个 await 没有 try/catch。
 * 不接住的话 IPC handler 直接 reject，原始消息（含内部绝对路径）会过桥给 renderer，
 * 而且调用方精心分好的 errorCode 分支根本走不到。
 */
/**
 * 被顶掉的那一轮 capture 启动，顺着「接手链」等出一个确定结果。
 *
 * 为什么需要：两个窗口的录制框可以同时开着。A 的 startKeyCapture 还没 spawn 时 B 又来一次，A 就
 * 拿到 superseded。原来到这里就返回了，理由是「更晚那轮在负责」—— 但那只在 B **成功**时成立。
 * B 失败或被取消时，A 仍留在转发名单里、只拿到一个 renderer 会静默丢弃的 superseded：没有 helper
 * 给它送 Fn，界面上既没有「需要监听权限」的说明、也没有故障提示。那正是本 PR 要消灭的那种沉默。
 *
 * 判据只读共享状态，不猜：在飞的启动就等它；没有在飞的就看此刻是否真的就绪。
 */
const MAX_SUPERSEDED_START_HANDOFFS = 5;

async function resolveSupersededRecordingStart(
  superseded: MacNativeListenerStartResult,
): Promise<MacNativeListenerStartResult> {
  for (let handoff = 0; handoff < MAX_SUPERSEDED_START_HANDOFFS; handoff += 1) {
    const pending = macModifierShortcutListener.pendingStartResult();
    if (!pending) {
      // 没有在飞的启动了：接手那轮已经落定。就绪 = 有 helper 在监听，这个录制框照样收得到 keys。
      if (macModifierShortcutListener.isReady()) return { ok: true };
      return { ok: false, error: 'Modifier shortcut listener did not start.' };
    }
    let result: MacNativeListenerStartResult;
    try {
      result = await pending;
    } catch (error) {
      // 解析/编译 helper 抛出来的（dev 下 swiftc 失败）。当成故障往下走，让调用方去分类。
      log.warn('shared listener start threw while a superseded recorder was waiting', {
        error: stringifyError(error),
      });
      return { ok: false, error: MAC_NATIVE_LISTENER_FAILURE_MESSAGE };
    }
    // 接手那轮自己又被顶掉了：跟着下一轮继续等。代次只增不减，所以这个循环必然推进。
    if (result.ok || !result.superseded) return result;
  }
  log.warn('gave up following superseded listener start handoffs');
  return superseded;
}

async function startMacNativeListener(
  start: () => Promise<MacNativeListenerStartResult>,
): Promise<MacNativeListenerStartResult> {
  try {
    return await start();
  } catch (error) {
    log.warn('native shortcut listener threw while starting', { error: stringifyError(error) });
    return { ok: false, error: MAC_NATIVE_LISTENER_FAILURE_MESSAGE };
  }
}

/**
 * 判定 native listener 起不来是「缺监听权限」还是别的故障。
 *
 * 两者必须分开：缺权限是可引导的正常状态（存下设置、请用户授权），而 swiftc 编译失败、
 * 二进制缺失、启动超时是真故障（不该把设置存成「待授权」骗用户）。listener 自己的
 * `ListenerStartResult` 只有一句 error 字符串，分不出来，所以这里补查一次权限。
 *
 * 用 preflight（`CGPreflightListenEventAccess`）而不是 request：它只查不弹窗，放在失败
 * 路径上不会给用户额外的系统弹窗。只有明确 denied 才算权限问题——status 为 unknown 时
 * 说明连权限都没查出来（helper 本身有问题），归 failed 更诚实。
 */
async function classifyMacNativeListenerFailure(): Promise<VoiceInputGlobalErrorCode> {
  if (process.platform !== 'darwin') return 'failed';
  const snapshot = await refreshVoiceInputInputMonitoringPermissionSnapshot();
  return snapshot.ok || snapshot.status !== 'denied' ? 'failed' : 'permission';
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

export type GlobalVoiceInputIpcDeps = {
  /** 主窗口访问器。 */
  getMainWindow: () => BrowserWindow | null;
  /**
   * 是不是「Open in New Window」开出来的会话副窗口。
   *
   * 副窗口跑的是同一套路由，设置页在里面照样打得开，所以弹系统授权窗那两条 IPC 必须认它 ——
   * 否则用户在副窗口里点授权入口只会得到失败，存盘后的自动请求也会静默失效。
   *
   * 用这个而不是 appContentWindows：那个 WeakSet 还包含右侧栏与 Ghost 面板，它们不承载
   * 路由、也就不该拿到弹系统授权窗的能力。
   */
  isSecondaryAppWindow: (win: BrowserWindow) => boolean;
};

/**
 * 把「会弹 macOS 输入监控授权窗」的两条 IPC 锁到**当前聚焦的应用外壳窗口**的顶层 frame。
 *
 * 三层判据，每层挡的是不同的东西：
 *
 * 1. `assertTrustedAppRendererEvent` —— senderFrame 必须是顶层 frame 且 URL 属于 Cindy
 *    自有 renderer，挡掉子 frame / WebView / 导航到别处的页面。
 * 2. 必须是**承载应用外壳（router / MainLayout）的窗口**：主窗口，或 secondary-windows
 *    登记的会话副窗口。不能只用 appContentWindows —— 那个注册表还含右侧栏与 Ghost 面板，
 *    后者装的是插件内容，信任级别与我们自己的外壳完全不同，却同样带着完整 preload。
 *    也不能只认主窗口：设置页在会话副窗口里照样打得开（`/settings` 与 `/cc-agent` 是同一
 *    个 router 下的兄弟路由），只认主窗口会让用户在副窗口里点授权入口直接失败。
 * 3. 必须是**当前聚焦的**那个窗口。这一层针对的正是「外壳窗口里的会话内容被 XSS 拿下」：
 *    窗口身份挡不住它（主窗口同样承载会话内容），但后台/被遮住的窗口凭此再也弹不出系统权限
 *    窗——而合法路径（点徽章、录完快捷键）永远发生在用户正看着的那个窗口里。这是在 Electron
 *    不向 ipcMain 暴露 user-activation 的前提下，最接近「必须由用户手势触发」的判据；仓库里
 *    已有同类先例（windowFocusClassifier 的 isFocusedAppContentWindow）。
 *
 * 能查的就这些：路由 / 页面无从可靠断言（hash 路由随手就能改），所以措辞和日志都只说窗口，
 * 不说「设置页」——写成设置页会让日志读起来像做了更强的检查（对齐 billing 的口径）。
 */
function appShellTopLevelSenderWindow(
  event: IpcMainInvokeEvent,
  deps: GlobalVoiceInputIpcDeps,
): BrowserWindow | null {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  // 必须是某个窗口自己的顶层 webContents + 顶层 frame，而不是它内嵌的什么东西。
  const isWindowTopLevelSender = Boolean(
    senderWindow &&
    !senderWindow.isDestroyed() &&
    event.sender === senderWindow.webContents &&
    event.senderFrame === senderWindow.webContents.mainFrame,
  );
  if (!senderWindow || !isWindowTopLevelSender) return null;
  const mainWindow = deps.getMainWindow();
  const isMainWindow = Boolean(mainWindow && !mainWindow.isDestroyed() && senderWindow === mainWindow);
  if (!isMainWindow && !deps.isSecondaryAppWindow(senderWindow)) return null;
  return senderWindow;
}

/**
 * 把录制期那两条**会改动全局监听状态**的 IPC 锁到应用外壳窗口的顶层 frame。
 *
 * 不要求聚焦（那是弹系统授权窗才需要的第三层）。这里挡的是**信任级别**：右侧栏与 Ghost 面板
 * 同样带着完整 preload，但 Ghost 面板装的是插件内容。少了这道闸，那种 renderer 一次调用就能：
 *
 * - `setGlobalShortcut(null, { suspend: true })` —— 把自己登记成「正在录制」。这个登记只在它
 *   自己发 stop 或窗口销毁时才摘掉，期间快捷键被注销、触发被丢弃、同步与兜底恢复都会被
 *   「录制中」守卫拒掉：一次调用就能让语音快捷键在那个窗口的整个生命周期里失效。
 * - `startModifierShortcutRecording()` —— 把自己登记进 keys 转发名单。而 helper 的 keys 事件
 *   不止修饰键：非修饰键会以 `KeyCode:<n>` 一起发出来（helper 的 handleNonModifierKey），
 *   也就是一路系统级按键流。这条比上面那条严重得多。
 *
 * 为什么这里不要求聚焦：合法录制确实发生在聚焦窗口里，但把聚焦也算进来会让「系统授权窗关闭后
 * 焦点异步回到窗口」这类时序把 Fn capture 静默挡掉（用户只看到录制框对 Fn 没反应）。而对
 * 「外壳窗口内容被 XSS 拿下」这一档威胁，聚焦在这里也换不来什么：那种 renderer 本来就能直接
 * 调 update-shortcut 把快捷键改掉。收益在于挡住低信任 renderer，那部分与聚焦无关。
 */
function assertVoiceShortcutRecordingSender(
  event: IpcMainInvokeEvent,
  deps: GlobalVoiceInputIpcDeps,
): void {
  assertTrustedAppRendererEvent(event);
  if (appShellTopLevelSenderWindow(event, deps) === null) {
    throwIpcError(
      'PERMISSION_DENIED',
      'Shortcut recording is only available to app shell windows',
    );
  }
}

function assertVoiceSettingsWindowSender(
  event: IpcMainInvokeEvent,
  deps: GlobalVoiceInputIpcDeps,
): void {
  // 先过通用闸：它额外校验 senderFrame 是顶层 frame 且 URL 属于 Cindy 自有 renderer，
  // 挡掉子 frame / WebView / 导航到别处的页面。下面再收窄到承载应用外壳的窗口。
  assertTrustedAppRendererEvent(event);
  const senderWindow = appShellTopLevelSenderWindow(event, deps);
  if (senderWindow === null || !senderWindow.isFocused()) {
    // 与本模块其它 throwIpcError 一致用英文：这句是给日志/调试看的，renderer 侧要展示
    // 时走 code → i18n 映射，不消费这里的原文。
    //
    // 措辞只说「应用外壳窗口」、不说「设置页」：闸能校验的就是窗口与顶层 frame，路由/页面
    // 无从可靠断言，写成设置页会让日志读起来像做了更强的检查（对齐 billing 的口径）。
    throwIpcError(
      'PERMISSION_DENIED',
      'Input Monitoring permission is only available to the focused app shell window',
    );
  }
}

/**
 * 快捷键变更的串行队列。
 *
 * 两个变更 handler 内部都有多个 await（起 helper、失败后补查权限），而 Electron 不替我们
 * 排队；录制按钮在第一次提交 await 期间仍可点，所以两次提交真的能交错。交错之后旧的那次
 * 会拿着过时的选择继续往下走：注销掉新那次刚注册成功的 accelerator，再把自己存盘覆盖掉
 * 用户最新的选择——用户看到的是「我明明改成了 F16，怎么变回右 Option 且什么都不响应」。
 *
 * 串行化让「最后提交的赢」成为确定行为。相比给每次变更编代次再让旧的中途放弃，这里不需要
 * 判断「放弃到哪一步算干净」：每次变更都在前一次完整收尾后才开始，没有中间态可踩。
 */
let shortcutMutationChain: Promise<unknown> = Promise.resolve();

function queueShortcutMutation<T>(task: () => Promise<T>): Promise<T> {
  const run = shortcutMutationChain.then(task, task);
  // 链上存的是吞掉异常的版本：某次变更抛了不该让后面所有变更跟着 reject。异常本身照常
  // 交给它自己的调用方。
  shortcutMutationChain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * 「待授权」快捷键的兜底恢复：用户在设置页外拿到监听权限后，把它重新注册上。
 *
 * 为什么必须放在 main：原来这条恢复挂在设置页的权限 effect 上，而设置页是条件渲染的 ——
 * 用户切走 tab（甚至关掉设置页）再去系统设置里打开开关，那个 effect 压根不会跑，快捷键就
 * 一直不生效，直到他再进一次语音输入 tab 或重启 Cindy。而我们给用户的说法是「授权后自动
 * 生效」，所以这条恢复不能依赖某个界面还开着。
 *
 * 用 preflight（只查不弹窗）判断，且只在明确 granted 时才起 helper —— 不会给用户凭空多出
 * 一个系统弹窗。
 */
const PENDING_SHORTCUT_RECOVERY_MIN_INTERVAL_MS = 5_000;
let lastPendingShortcutRecoveryAt = 0;
let pendingShortcutRecoveryRunning = false;

/**
 * 兜底恢复此刻该做什么。
 *
 * 预筛和队列内都调它，**队列内那次才是判据**：preflight 与队列排队都要 await，那段时间里
 * 用户可能已经改了快捷键、也可能已经开始录制。所有条件都收在这个函数里，就不会出现「预筛
 * 查了、队列内漏查」的偏差。
 *
 * `wait-for-pending-start` 是必要的第三态：`isRunning()` 在 spawn 之后立刻为 true，**早于**
 * helper 报 ready。启动期间来一次聚焦，只看 isRunning 会判成「已经在跑、没事可做」直接返回；
 * 而那次启动随后可能超时或起来就退（它的调用方只写一行日志），于是快捷键一直不生效、连那条
 * 可行动的提示都不会有 —— 要等下一个 focus 事件。所以这里排个尾跑，等那次启动落定再看。
 */
type PendingShortcutRecoveryTarget =
  | { kind: 'nothing-to-do' }
  | { kind: 'wait-for-pending-start' }
  | { kind: 'register'; shortcut: VoiceInputShortcut };

function pendingNativeShortcutRecoveryTarget(): PendingShortcutRecoveryTarget {
  // 录制期间全局快捷键是刻意挂起的，这里注册会把它顶回来：用户正在按键试录就会真的触发
  // 一次语音输入，并发的 listener 启动还会把 Fn capture 顶掉。
  if (modifierShortcutRecordingSessionIds.size > 0) return { kind: 'nothing-to-do' };
  const shortcut = voiceInputDataStore.getSettings().shortcut;
  if (!shortcut || !voiceInputShortcutNeedsMacNativeListener(shortcut, process.platform)) {
    return { kind: 'nothing-to-do' };
  }
  if (macModifierShortcutListener.isRunning()) {
    const shortcutKey = stableVoiceInputShortcutKey(shortcut);
    // 已经为这个快捷键注册成功、helper 也**报过 ready**：真的没事可做。
    //
    // 必须看 ready 而不只看 isRunning：helper 退出后 scheduleRestart 会起一个替补，那段时间
    // isRunning 已是 true、而 registeredNativeShortcutKey 还是旧的（重启不经过 setShortcut），
    // 只看这两个就会把「替补正在起」误判成一切正常。替补及其重试全失败时只写日志，这次聚焦
    // 恢复又被丢掉，快捷键就一直不生效、也没有提示。
    if (registeredNativeShortcutKey === shortcutKey) {
      return macModifierShortcutListener.isReady()
        ? { kind: 'nothing-to-do' }
        : { kind: 'wait-for-pending-start' };
    }
    // 一个字都还没登记 = 有一次启动正在飞（见上）。并发再起一次没意义，等它落定。
    if (registeredNativeShortcutKey === null) return { kind: 'wait-for-pending-start' };
    // 登记的是另一个快捷键（存盘已经变了）：存盘才是权威，直接重注册。
  }
  return { kind: 'register', shortcut };
}

/**
 * 「自动恢复失败」的待通知状态。
 *
 * 只推不记状态是不行的：恢复可能发生在 MainLayout 还没挂载的时候（登录门、数据库门还在
 * 前面），此时 fan-out 没有订阅者，这一推就没了。所以状态留在 main，由 renderer 挂载后
 * 主动 consume —— **状态在被真正取走时才清**，推送只是「已经挂着的 renderer 早点收到」。
 *
 * 一次 App 运行只提示一次（consume 后清零、后续失败不再置位）：触发点是窗口聚焦，helper
 * 真坏掉会每次切回来都失败一遍，反复弹同一条只会变成骚扰 —— 用户此刻并没有在做这件事。
 */
let pendingShortcutRecoveryFailure = false;
/**
 * 已经取过这条通知的 renderer。
 *
 * 不能取一次就全局清掉：每个应用窗口（含会话副窗口）都挂着 MainLayout，都会来取。谁先到谁
 * 拿走的话，一个在后台、被挡住的副窗口就可能吞掉这唯一一次提示，用户正看着的窗口反而拿到
 * `{ failed: false }` —— 那条提示就等于没有。按 renderer 记账：每个窗口最多提示一次，用户
 * 看着哪个窗口都能看到，也不会在同一个窗口里被弹第二次。
 */
const shortcutRecoveryFailureConsumers = new Set<number>();

/**
 * 清掉待通知状态。
 *
 * 除了「恢复成功」，**用户自己改了快捷键**同样要清：他把快捷键换成 F16 或干脆清空之后，兜底
 * 恢复再也不会跑（没有需要监听权限的快捷键了），这条失败就永远挂着 —— 此后每开一个应用外壳
 * 窗口都会取到它，弹一条「重启 Cindy 再试」，而当前快捷键其实工作正常或已被关掉。
 *
 * 连消费账本一起清：清完之后若又失败，那是一件新事，每个窗口都值得再被提示一次。
 */
function clearPendingShortcutRecoveryFailure(): void {
  if (!pendingShortcutRecoveryFailure && shortcutRecoveryFailureConsumers.size === 0) return;
  pendingShortcutRecoveryFailure = false;
  shortcutRecoveryFailureConsumers.clear();
}

function notifyPendingShortcutRecoveryFailed(): void {
  pendingShortcutRecoveryFailure = true;
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      window.webContents.send('voice-input:shortcut-recovery-failed');
    } catch {
      /* renderer 已销毁 */
    }
  }
}

let pendingShortcutRecoveryRetryTimer: NodeJS.Timeout | null = null;

function schedulePendingShortcutRecoveryRetry(delayMs: number): void {
  // 已经排了就不再叠：尾跑只需要一个。
  if (pendingShortcutRecoveryRetryTimer) return;
  pendingShortcutRecoveryRetryTimer = setTimeout(() => {
    pendingShortcutRecoveryRetryTimer = null;
    void recoverPendingNativeShortcutRegistration();
  }, Math.max(0, delayMs));
}

async function recoverPendingNativeShortcutRegistration(): Promise<void> {
  if (process.platform !== 'darwin') return;
  if (pendingShortcutRecoveryRunning) {
    // 同限流那条的道理：在飞的那次可能刚好在用户点开开关**之前**读到了 denied，而这次聚焦
    // 正是他授权完切回来的那一次。丢掉就没有下一次了（应用此后一直在前台）。排个尾跑，
    // 等在飞那次收尾、限流窗口也过去之后再查一遍。
    schedulePendingShortcutRecoveryRetry(PENDING_SHORTCUT_RECOVERY_MIN_INTERVAL_MS);
    return;
  }
  // 这里只是「值不值得往下走」的预筛。真正要注册的那个必须在队列里现读，见下。
  const target = pendingNativeShortcutRecoveryTarget();
  if (target.kind === 'nothing-to-do') return;
  if (target.kind === 'wait-for-pending-start') {
    schedulePendingShortcutRecoveryRetry(PENDING_SHORTCUT_RECOVERY_MIN_INTERVAL_MS);
    return;
  }
  // preflight 每次都要起一个 helper 进程，而窗口聚焦事件很密集，必须限流。
  const now = Date.now();
  if (now - lastPendingShortcutRecoveryAt < PENDING_SHORTCUT_RECOVERY_MIN_INTERVAL_MS) {
    // 但不能就这么丢掉：这次聚焦可能正是「用户刚授权完切回来」的那一次，而应用此后就一直
    // 在前台，不会再有第二个 focus 事件 —— 快捷键会一直不生效，直到他切走再切回或重启。
    // 所以补一个尾跑，等限流窗口过去再试一次。
    schedulePendingShortcutRecoveryRetry(PENDING_SHORTCUT_RECOVERY_MIN_INTERVAL_MS - (now - lastPendingShortcutRecoveryAt));
    return;
  }
  lastPendingShortcutRecoveryAt = now;
  pendingShortcutRecoveryRunning = true;
  try {
    const snapshot = await refreshVoiceInputInputMonitoringPermissionSnapshot();
    // 连权限状态都查不出来（unknown）= helper 本身有问题：preflight 走的就是同一个 helper，
    // 二进制缺失、spawn 失败、swiftc 编译失败都落在这里。这是真故障，不是「还没授权」——
    // 与 classifyMacNativeListenerFailure 的 denied / unknown 分界保持一致。
    //
    // 少了这条：用户在设置页之外授权完，快捷键起不来且**一句提示都没有**（下面那条通知只在
    // preflight 成功后才够得着），而「待授权」说明又随权限转已授权一起消失了。
    if (!snapshot.ok && snapshot.status !== 'denied') {
      // 发这条通知之前必须重新看一眼该恢复什么：preflight 那次 await 期间用户完全可能把快捷键
      // 换成 F16 或干脆清掉（那次成功的 update-shortcut 已经清掉过期失败态了）。无条件发就会
      // 凭一个已经不存在的目标重新造出一条「重启 Cindy 再试」，而当前快捷键其实工作正常。
      const revalidated = pendingNativeShortcutRecoveryTarget();
      if (revalidated.kind === 'wait-for-pending-start') {
        // 有一次启动正在飞：它可能成功（那就什么都不用报），也可能超时/起来就退（它的调用方
        // 只写一行日志）。两种都不该在这里下结论，排个尾跑等它落定 —— 与预筛那条同一个处理。
        schedulePendingShortcutRecoveryRetry(PENDING_SHORTCUT_RECOVERY_MIN_INTERVAL_MS);
        return;
      }
      if (revalidated.kind !== 'register') {
        log.debug('pending native shortcut recovery target changed while checking permission');
        return;
      }
      log.warn('pending native shortcut recovery failed: permission status unavailable', {
        status: snapshot.status,
      });
      notifyPendingShortcutRecoveryFailed();
      return;
    }
    // denied = 用户还没在系统设置里打开，正常等待，不提示。
    if (!snapshot.ok || snapshot.status !== 'granted') return;
    // 快捷键在队列里现读、现校验：preflight 那次 await 期间用户完全可能改成别的（比如
    // F16）。用 await 之前抓的那份，就会在用户的新变更之后把旧的修饰键注册回去 ——
    // 存盘和界面停在 F16，实际生效的却是旧那个。
    const result = await queueShortcutMutation(async () => {
      const queued = pendingNativeShortcutRecoveryTarget();
      if (queued.kind !== 'register') return null;
      return setVoiceInputGlobalShortcut(queued.shortcut);
    });
    if (!result) {
      log.debug('pending native shortcut recovery skipped: settings changed while checking permission');
      return;
    }
    if (result.ok) {
      log.info('pending native shortcut re-registered after permission was granted');
      clearPendingShortcutRecoveryFailure();
      return;
    }
    if (result.errorCode === 'superseded') return;
    // 'permission' = 授权在 preflight 之后、注册完成之前又被撤了。那仍然是「等授权」这个正常
    // 状态：此刻能修好它的只有重新授权，而 listenerUnavailable 让用户去重启 Cindy —— 指错了
    // 方向，而且这条通知一旦记下来，之后新开的窗口还会重复这个错误建议。与 preflight 读到
    // denied 那条路一视同仁：静默等授权，待授权说明与徽章会把状态和入口摆在那。
    if (result.errorCode === 'permission') {
      log.info('pending native shortcut still awaiting Input Monitoring after a granted preflight');
      return;
    }
    log.warn('pending native shortcut recovery failed', { errorCode: result.errorCode });
    // 这条恢复存在的前提就是设置页不在（它的 toast 也就不在），只写日志等于用户被告知
    // 「授权后自动生效」之后什么都没发生、也无处得知。推给常挂载的 renderer 去提示。
    notifyPendingShortcutRecoveryFailed();
  } catch (error) {
    log.warn('pending native shortcut recovery threw', { error: stringifyError(error) });
  } finally {
    pendingShortcutRecoveryRunning = false;
  }
}

/**
 * 登记「这个 renderer 正在录制快捷键」。
 *
 * 两个入口都调它：显式挂起（录制真正的起点）与 recording:start（capture 尝试）。销毁清理挂在
 * 这里，所以哪个先到都不会漏 —— 录制框关掉不发 stop 就崩了的窗口也会被收掉。
 */
function markModifierShortcutRecordingSession(sender: WebContents): void {
  if (modifierShortcutRecordingSessionIds.has(sender.id)) return;
  modifierShortcutRecordingSessionIds.add(sender.id);
  sender.once('destroyed', () => {
    modifierShortcutRecordingSessionIds.delete(sender.id);
  });
}

export function registerGlobalVoiceInputIpc(deps: GlobalVoiceInputIpcDeps): void {
  if (registered) return;
  registered = true;

  // 从系统设置切回 Cindy 就会走到这里 —— 这正是用户刚打开开关的那一刻，且与设置页开着
  // 没关系。设置页自己那条权限 effect 保留：它还负责录制期只补 Fn capture 那条路。
  app.on('browser-window-focus', () => {
    void recoverPendingNativeShortcutRegistration();
  });

  /**
   * 这条 channel 只有两种正当用途：**挂起**（录制期，显式带 options.suspend）和**让运行期
   * 对上存盘**（录制结束恢复、授权后重新注册、renderer 收到设置变更后的回声）。
   *
   * 所以：带 suspend 的请求直接放行；不带的一律与当前存盘比对，不一致就是过时的回声，丢掉。
   *
   * 为什么需要这道闸：`useVoiceInputSettings` 里有个 effect，settings.shortcut 一变就调
   * syncVoiceInputGlobalShortcut(settings.shortcut) —— 每个挂载着它的窗口都会回声一次。
   * 两次提交交错时，先落地那次会广播**旧**快捷键（清空提交广播的就是 null），某个后台窗口
   * （渲染被节流，effect 跑得晚）的回声就可能排在更晚那次提交之后，把旧的重新注册上、或者
   * 把新注册好的直接关掉：存盘和界面显示新的，实际生效的却不是。
   *
   * null 必须一起校验 —— 只放行非 null 的话，「清空快捷键」那次的 null 回声照样能迟到落地。
   * 这也是为什么挂起要显式带 intent：它传的 null 恰恰故意与存盘不同，靠值本身分不出来。
   */
  ipcMain.handle(
    'voice-input:global-shortcut:set',
    async (
      event,
      shortcut: VoiceInputShortcut | null | undefined,
      options?: { suspend?: true },
    ): Promise<VoiceInputGlobalResult> => {
      const nextShortcut = shortcut ?? null;
      const suspending = options?.suspend === true;
      // 显式挂起就等于「这个 renderer 的录制开始了」——在入队之前就登记。
      //
      // 录制 effect 是先等挂起返回、再发 recording:start 的（顺序反过来的话，挂起里的
      // listener.stop() 会把 capture 刚起的 helper 一起杀掉）。那两步之间有个窗口：兜底
      // 恢复排在挂起之后执行时，录制会话还没登记，于是它照常把已保存的快捷键注册上；随后
      // startKeyCapture 看见 child 已在跑就直接返回成功、不会清掉那个 shortcut —— 用户在
      // 录制框里按键会真的触发一次语音输入。用挂起这个 intent 当会话起点，窗口就消失了。
      //
      // 登记之前先校验 sender：这个登记会让快捷键在该窗口的整个生命周期里失效，是低信任
      // renderer 一次调用就能造成的持久影响。**只校验挂起**——不带 suspend 的同步是
      // 「让运行期对上存盘」的回声，每个挂载 useVoiceInputSettings 的窗口（含右侧栏里的
      // ChatInput、overlay）都会发，且已经按存盘值校验过、落不下任何新状态。
      if (suspending) {
        assertVoiceShortcutRecordingSender(event, deps);
        markModifierShortcutRecordingSession(event.sender);
      }
      return queueShortcutMutation(async () => {
        if (!suspending) {
          const storedShortcut = voiceInputDataStore.getSettings().shortcut;
          // 用已有的 stableVoiceInputShortcutKey 比对：它把 trigger / code / key / 五个
          // modifier 全铺进去，就是一个快捷键的完整身份，比 JSON 串比较更不受字段顺序影响。
          const storedKey = storedShortcut ? stableVoiceInputShortcutKey(storedShortcut) : null;
          const nextKey = nextShortcut ? stableVoiceInputShortcutKey(nextShortcut) : null;
          if (storedKey !== nextKey) {
            log.debug('ignoring stale global shortcut sync', { code: nextShortcut?.code ?? null });
            return { ok: true };
          }
          // 录制期间是刻意挂起的。别的窗口的回声在这时把它装回来，用户按键试录就会真的
          // 触发一次语音输入 —— 与兜底恢复那条守卫同理。
          if (modifierShortcutRecordingSessionIds.size > 0) {
            log.debug('ignoring global shortcut sync while a recording is in progress');
            return { ok: true };
          }
        }
        const result = await setVoiceInputGlobalShortcut(nextShortcut);
        // 与存盘一致的同步注册成功 = 快捷键此刻是活的（或用户本来就清空了），之前那条「自动
        // 恢复失败」就过期了。挂起不算：那是录制期的临时状态，失败态还得留着。
        //
        // 少了这步：早期一次瞬时 helper 故障之后，即便后来注册成功了，此后每开一个应用外壳
        // 窗口都会取到那条陈旧失败、弹一次「重启 Cindy 再试」。
        if (!suspending && result.ok) clearPendingShortcutRecoveryFailure();
        return result;
      });
    },
  );

  ipcMain.handle(
    'voice-input:settings:update-shortcut',
    async (_event, shortcut: VoiceInputShortcut | null | undefined): Promise<VoiceInputSettingsUpdateResult> => {
      return queueShortcutMutation(async () => {
        const nextShortcut = shortcut ?? null;
        const registration = await setVoiceInputGlobalShortcut(nextShortcut);
        // 只缺监听权限时仍然存盘：用户的选择要留住，快捷键等授权后自动生效（设置页在
        // 权限转为已授权时会重新 sync）。真故障（冲突、不支持、helper 坏了）照旧不存。
        if (!registration.ok && registration.errorCode !== 'permission') return registration;
        if (!registration.ok) {
          // 存盘意味着「当前快捷键就是这个新的、只是等授权」，所以旧的必须当场停掉。
          //
          // setVoiceInputGlobalShortcut 注销旧 accelerator 只发生在成功路径上，缺权限时
          // 它在那之前就返回了。少了这步：原本绑 F16，改成右 Option 而权限被拒 → 设置页
          // 显示「右 Option 待授权」，但按 F16 这一整个会话里仍会触发语音输入。
          //
          // 交给 setVoiceInputGlobalShortcut(null) 统一收口，别在这里手抠 registered*
          // 那几个模块级变量：注销 accelerator、清 native 状态、停 helper 三件事都在那条
          // 已有路径里，重抄一遍迟早漏一样。
          await setVoiceInputGlobalShortcut(null);
        }
        // 用户自己定下了新状态（注册成功 / 换成不需要权限的快捷键 / 清空），之前那条「自动
        // 恢复失败」就过期了：留着只会让之后新开的窗口弹一条与当前状态无关的故障提示。
        clearPendingShortcutRecoveryFailure();
        return {
          ok: true,
          settings: voiceInputDataStore.updateSettings({ shortcut: nextShortcut }),
          ...(registration.ok ? {} : { pendingInputMonitoring: true }),
        };
      });
    },
  );

  ipcMain.handle(
    'voice-input:modifier-shortcut-recording:start',
    async (event): Promise<VoiceInputGlobalResult> => {
      // 授权先于一切：这条 IPC 会把 sender 登记进 keys 转发名单，而转发出去的不止修饰键
      // （helper 对非修饰键发 `KeyCode:<n>`），等于一路系统级按键流。平台判断放在它后面。
      assertVoiceShortcutRecordingSender(event, deps);
      if (process.platform !== 'darwin') {
        return { ok: false, error: 'Modifier shortcut recording is only available on macOS.' };
      }
      modifierShortcutRecordingWebContentsIds.add(event.sender.id);
      // 录制会话在**尝试之前**就登记：capture 起不起来都不影响「用户正在录」这个事实。
      // （显式挂起时其实已经登记过了，这里幂等补一次，不依赖调用顺序。）
      markModifierShortcutRecordingSession(event.sender);
      event.sender.once('destroyed', () => {
        modifierShortcutRecordingWebContentsIds.delete(event.sender.id);
        if (modifierShortcutRecordingWebContentsIds.size === 0) {
          macModifierShortcutListener.stopKeyCapture();
        }
      });
      // 走 startMacNativeListener：startKeyCapture 也会抛（helper 源码缺失 / swiftc
      // 失败）。不接住的话下面的清理与 errorCode 分类都跑不到，本 renderer 会留在
      // 转发名单里、原始路径还会过桥给它。
      const started = await startMacNativeListener(() => macModifierShortcutListener.startKeyCapture());
      // 被更晚的一轮顶掉时不能就此收工：helper 是共享的，接手那一轮的落点就是这个录制框的落点。
      // 接手成功 → 这里也算成功（名单没动过，keys 照样送到）；接手失败 → 这个录制框同样需要
      // 知道，否则它收不到 Fn 却一句解释都没有（renderer 对 'superseded' 是静默丢弃的）。
      const result = !started.ok && started.superseded
        ? await resolveSupersededRecordingStart(started)
        : started;
      if (!result.ok && result.superseded) {
        // 顺着接手链也没等出确定结果（罕见：连着好几轮互相顶）。维持原来的静默语义，且绝不动
        // 名单 —— 录制登记按 sender id 记账，同一个设置页连续两轮录制用的是同一个 id，在这里
        // 删就等于把新一轮刚登记的那条删掉，helper 起来了却没人收 keys。
        return { ok: false, error: result.error, errorCode: 'superseded' };
      }
      if (!result.ok) {
        modifierShortcutRecordingWebContentsIds.delete(event.sender.id);
        // 录制期的 key capture 只服务 Fn 检测（macOS 不把 Fn 派发成普通 DOM keydown）。
        // 起不来时 renderer 要靠 errorCode 区分「缺权限所以 Fn 录不了」和真故障，
        // 前者不该当成错误弹出来——裸修饰键走 DOM 事件，此时照样能正常录。
        return {
          ok: false,
          error: MAC_NATIVE_LISTENER_FAILURE_MESSAGE,
          errorCode: await classifyMacNativeListenerFailure(),
        };
      }
      return result;
    },
  );

  ipcMain.handle(
    'voice-input:modifier-shortcut-recording:stop',
    (event): VoiceInputGlobalResult => {
      modifierShortcutRecordingWebContentsIds.delete(event.sender.id);
      modifierShortcutRecordingSessionIds.delete(event.sender.id);
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
    lastPresentedOverlayBounds = bounds;
    voiceInputOverlayPositionStore.save({
      x: bounds.x,
      y: bounds.y,
      displayId: display?.id,
      // 同时存屏内相对比例：显示器重排后绝对坐标会失效，比例仍能还原用户
      // 当时把浮窗放在这块屏的哪个位置。
      ...(display ? computeOverlayPositionRatio(bounds, display.workArea) : {}),
      updatedAt: Date.now(),
    });
    log.debug('global overlay drag position saved', { x: bounds.x, y: bounds.y });
  });

  ipcMain.handle('voice-input:global-overlay-position-reset', (event): { ok: true } => {
    const window = getOverlayWindow();
    if (window && event.sender === window.webContents) {
      overlayDragSession = null;
      voiceInputOverlayPositionStore.clear();
      // 复位到「浮窗当前所在这块屏」的默认位置：双击复位时浮窗已经在用户眼前，
      // 不该因为鼠标所在屏判定跑到另一块屏上去。
      const display = screen.getDisplayMatching(window.getBounds());
      const bounds = computeOverlayBounds(display);
      lastPresentedOverlayBounds = bounds;
      window.setBounds(bounds);
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

  /**
   * renderer 挂载后来取「有没有一条自动恢复失败要提示」。
   *
   * 有它才能保证不漏：失败可能发生在 MainLayout 挂载之前（登录门 / 数据库门还在前面），
   * 那时推送没有订阅者。状态留在 main、按 renderer 记账，所以推送丢了也补得回来。
   *
   * 按 renderer 而不是全局记一次：每个应用窗口（含会话副窗口）都挂着 MainLayout，都会来取。
   * 全局清的话，一个后台副窗口就可能吞掉这唯一一次提示。
   *
   * 闸用通用的可信 renderer 校验（不是应用外壳窗口那道收窄闸）：这条只读一个布尔、不触发
   * 任何系统弹窗。
   */
  ipcMain.handle('voice-input:consume-shortcut-recovery-failure', (event): { failed: boolean } => {
    assertTrustedAppRendererEvent(event);
    if (!pendingShortcutRecoveryFailure) return { failed: false };
    const senderId = event.sender.id;
    if (shortcutRecoveryFailureConsumers.has(senderId)) return { failed: false };
    shortcutRecoveryFailureConsumers.add(senderId);
    event.sender.once('destroyed', () => {
      shortcutRecoveryFailureConsumers.delete(senderId);
    });
    return { failed: true };
  });

  ipcMain.handle('voice-input:open-input-monitoring-settings', async (event): Promise<VoiceInputGlobalResult> => {
    // 同下面的 request handler：这条也会触发 CGRequestListenEventAccess 弹系统授权窗，
    // 攻击面完全相同，所以一并上闸——只给新 handler 加等于没关洞。
    assertVoiceSettingsWindowSender(event, deps);
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

  // 与上面 open-input-monitoring-settings 的区别：这条只弹系统授权请求，不顺手打开
  // 「系统设置」面板。用户刚设完快捷键时该请求授权，但把设置面板怼到脸上就太重了——
  // CGRequestListenEventAccess 弹的窗自带「打开系统设置」按钮，想去自己会点。
  //
  // 这是特权动作（会弹系统级授权窗），所以：
  // - 必须过 sender 闸，并且收窄到主窗口顶层 frame。语音浮窗、词典 toast、右侧栏窗口、
  //   Ghost 面板装的都是同一份 preload；后两者还会 markAppContentWindow，所以只过
  //   assertTrustedAppRendererEvent 仍然放得进来。见
  //   assertVoiceSettingsWindowSender 的注释。
  // - 失败走 throwIpcError 而不是 return { ok: false }：这是动作型 handler，renderer
  //   不需要失败时的结构化 fallback（它随后会重新查权限），按 IPC 错误协议应当抛。
  ipcMain.handle(
    'voice-input:request-input-monitoring-permission',
    async (event): Promise<VoiceInputInputMonitoringRequestResult> => {
      assertVoiceSettingsWindowSender(event, deps);
      if (process.platform !== 'darwin') {
        throwIpcError('UNSUPPORTED_CAPABILITY', 'Input Monitoring permission is only required on macOS.');
      }
      const snapshot = await requestMacInputMonitoringPermission();
      cachedInputMonitoringPermission = snapshot;
      // denied 是正常结果（用户还没在系统设置里打开），不是故障；只有连权限状态都问不出来
      // 才是真故障——helper 编译/spawn 失败时它的 error 里带 swiftc / execFile 的内部
      // 绝对路径，不能原样回传 renderer，只留在日志里。
      if (!snapshot.ok && snapshot.status !== 'denied') {
        log.warn('input monitoring permission request failed', {
          status: snapshot.status,
          error: snapshot.error,
        });
        throwIpcError('INTERNAL', 'Could not request the Input Monitoring permission.');
      }
      return { ok: true, status: snapshot.status };
    },
  );

  ipcMain.handle(
    'voice-input:dictionary-toast-show',
    (_event, payload: unknown): { ok: true } | { ok: false; error: string } => {
      const entries = normalizeDictionaryToastEntries(payload);
      if (entries.length === 0) return { ok: false, error: 'Dictionary toast payload is incomplete.' };
      // Renderer 侧（应用内听写）触发的 toast 与全局浮窗位置无关。
      showDictionaryToastWindow({ entries, anchor: null });
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

/**
 * 停掉 native 快捷键监听 —— 但还有窗口在录制时，只放弃快捷键、保住 capture。
 *
 * 同一个 helper 既服务常驻监听也服务录制页的 Fn 检测。两个设置页同时开着录制框时，一边提交
 * F16（或清空快捷键）会走到 stop()，把另一边的 keys 来源一起杀掉：那个窗口的录制框还开着，
 * 却再也收不到 Fn，只能关掉重开。判据用转发名单而不是录制会话集合 —— 需要 helper 的正是
 * 「capture 真的起来了」的那些窗口。
 */
function stopNativeShortcutListenerPreservingCapture(): void {
  if (modifierShortcutRecordingWebContentsIds.size > 0) {
    macModifierShortcutListener.releaseShortcutKeepingCapture();
    return;
  }
  macModifierShortcutListener.stop();
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
    stopNativeShortcutListenerPreservingCapture();
    destroyOverlayWindow();
    log.info('global shortcut disabled');
    return { ok: true };
  }

  if (voiceInputShortcutNeedsMacNativeListener(shortcut, process.platform)) {
    if (process.platform !== 'darwin') {
      return { ok: false, error: 'Function/modifier voice input shortcuts are only available on macOS.' };
    }
    const nativeShortcutKey = stableVoiceInputShortcutKey(shortcut);
    // 复用已注册的那次要求**已就绪**,不是「进程在跑」。scheduleRestart 起的替补不经过
    // setShortcut,所以 registeredNativeShortcutKey 一直是旧值:替补还没报 ready 时用 isRunning
    // 判断就会在这里返回成功,而此刻没人在监听。两处后果:
    //
    // - 调用方(renderer)被告知快捷键是活的;
    // - handler 会据此 clearPendingShortcutRecoveryFailure() 把持久失败态清掉。而替补及其重试
    //   全失败时只写日志、**不会**重新发布失败态(scheduleRestart 耗尽重试那一支),于是快捷键
    //   静静地不工作,唯一能提示用户的那条通知也被提前擦掉了。
    //
    // 落到这里之后走 setShortcut:child 还在但没就绪时它会等那次启动的真实落点
    // （MacModifierShortcutListener.awaitInFlightChild）,所以这里不会凭空多 spawn 一个 helper。
    // 兜底恢复的 pendingNativeShortcutRecoveryTarget 用的也是 isReady,两条路口径至此一致。
    if (registeredNativeShortcutKey === nativeShortcutKey && macModifierShortcutListener.isReady()) {
      return { ok: true };
    }
    const result = await startMacNativeListener(() => macModifierShortcutListener.setShortcut(shortcut));
    if (!result.ok && result.superseded) {
      // 被更晚的一轮顶掉：那一轮才决定最终注册结果，这里既不回滚（会踩掉它刚建立的
      // 状态）也不报故障（这次调用已经过时）。调用方按 'superseded' 静默丢弃即可。
      log.debug('native global shortcut registration superseded', { code: shortcut.code });
      return { ok: false, error: result.error, errorCode: 'superseded' };
    }
    if (!result.ok) {
      // 先落成局部常量：registeredShortcut 是模块级 let，装进闭包后 TS 不再认那层
      // narrowing（延迟执行期间它可能被改），语义上回滚也该锁定进入分支时的那一个。
      const previousShortcut = registeredShortcut;
      if (previousShortcut && voiceInputShortcutNeedsMacNativeListener(previousShortcut, process.platform)) {
        // 回滚同样可能抛（helper 已经坏掉），不能让它把整个 handler 掀了。
        const restored = await startMacNativeListener(
          () => macModifierShortcutListener.setShortcut(previousShortcut),
        );
        // 回滚目标与本次请求是**同一个**快捷键时（对得上存盘的同步就是这种：previousShortcut
        // 正是用户当前那个），这次「回滚」其实是同键重试。它成功了就意味着请求的快捷键此刻真的
        // 在监听，再报失败会让调用方不去清持久失败态、界面还弹一句「重启 Cindy 再试」——而快捷键
        // 本身是好的。
        //
        // 只在 key 相同时这样收：真回滚到**另一个**快捷键时，用户请求的那个确实没注册上，必须
        // 照旧报失败，否则他会以为换成功了。
        if (restored.ok && stableVoiceInputShortcutKey(previousShortcut) === nativeShortcutKey) {
          log.info('native global shortcut recovered by retrying the same shortcut', {
            code: shortcut.code,
          });
          // 这一路不重跑 prewarm：那是首次注册时做的事，同键重试没有新东西要预热。
          registeredShortcut = shortcut;
          registeredNativeShortcutLabel = getNativeShortcutLogLabel(shortcut);
          registeredNativeShortcutKey = nativeShortcutKey;
          return { ok: true };
        }
      }
      const errorCode = await classifyMacNativeListenerFailure();
      log.warn('native global shortcut registration failed', {
        code: shortcut.code,
        modifiers: shortcut.modifiers,
        error: result.error,
        errorCode,
      });
      // 原始 error 只进日志：它可能是 swiftc stderr 或 `spawn <绝对路径> ENOENT`，
      // 带着 helper 源码/二进制的内部路径，不能过 IPC 边界。
      return { ok: false, error: MAC_NATIVE_LISTENER_FAILURE_MESSAGE, errorCode };
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
  stopNativeShortcutListenerPreservingCapture();
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
  // Electron accelerator 那条路的同一道兜底（native 那条在 onTrigger 里挡）。
  if (hasActiveShortcutRecordingSession()) {
    log.debug('ignoring global shortcut trigger while recording');
    return;
  }
  const invokedAt = Date.now();
  const overlay = getOverlayWindow();
  const overlayOpen = isOverlayPresentationOpen(overlay);
  log.debug('global shortcut invoked', {
    overlayOpen,
    overlayVisible: Boolean(overlay?.isVisible()),
    overlayAwaitingShow: overlayPresentationAwaitingShow,
    appFocused: Boolean(BrowserWindow.getFocusedWindow()),
  });
  if (overlay && overlayOpen) {
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
  if (overlay && isOverlayPresentationOpen(overlay)) {
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
  // 同 setOverlayIdlePresentationState：作废本次呈现，pending 的异步定位回调失效。
  overlayPresentationSeq += 1;
  overlayPresentationAwaitingShow = false;
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
  // 作废本次呈现：pending 的焦点屏回调据此放弃定位与显示。
  overlayPresentationSeq += 1;
  overlayPresentationAwaitingShow = false;
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
  // 第一个条件是原有行为（窗口已可见就提交）；第二个补上「呈现已开始、正等着
  // 显示」这段窗口，否则等待期内的第二次按键会再开一次呈现，renderer 收到重复
  // start 会忽略，用户那一下等于丢了。
  if (existing && (existing.isVisible() || isOverlayPresentationOpen(existing))) {
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
  // 建窗时的 bounds 只是占位：真正的定位在 positionOverlayWindow 里按焦点屏做。
  const bounds = computeOverlayBounds(getCursorDisplay());
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

function showDictionaryToastWindow(payload: DictionaryToastPayload): void {
  // 有浮窗正在呈现（用户正在录音）时不弹 toast。toast 是 alwaysOnTop 的，且它的默认
  // 位置就是浮窗的默认位置——旧会话的建议迟到时退回默认位置，恰好会盖住正在录音的
  // 新浮窗五秒。词条本身已经落库，这个提示不重要到值得挡住用户的操作界面。
  if (isOverlayPresentationOpen(getOverlayWindow())) {
    log.debug('dictionary toast suppressed: overlay presentation is open', {
      entries: payload.entries.length,
    });
    return;
  }
  closeDictionaryToastWindow();
  const window = createDictionaryToastWindow(payload);
  dictionaryToastWindow = window;
  dictionaryToastCloseTimer = setTimeout(() => {
    closeDictionaryToastWindow();
  }, DICTIONARY_TOAST_DURATION_MS);
}

/**
 * `anchor` 只应由全局浮窗那条听写链路传（用 `takeOverlayDictionaryToastAnchor()`
 * 在请求到达时取得）。应用内听写不传：它的 toast 不能借用浮窗位置，用户可能在另一
 * 块屏的 Cindy 窗口里操作，甚至浮窗那块屏早已拔掉。
 */
export function showVoiceInputDictionaryToast(
  entries: DictionaryToastEntryPayload[],
  options?: { anchor?: DictionaryToastAnchor | null },
): void {
  if (entries.length === 0) return;
  showDictionaryToastWindow({
    entries,
    anchor: options?.anchor ?? null,
  });
}

function createDictionaryToastWindow(payload: DictionaryToastPayload): BrowserWindow {
  const bounds = computeDictionaryToastBounds(
    resolveDictionaryToastAnchorBounds(payload.anchor),
  );
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

  const presentationSeq = ++overlayPresentationSeq;
  // Startup ordering is intentional:
  // 1. Capture the paste target before showing the overlay. 这一次调用同时带回
  //    前台窗口 frame，焦点屏由它派生——和 target 同一次 frontmostApplication
  //    读取，不会出现「浮窗开在 A 屏、粘贴却进了 B 屏的 App」。
  // 2. Tell the renderer to start microphone capture as soon as it is ready.
  // 3. Show the overlay on the next tick so UI display no longer gates mic start.
  //
  // frame 走流式：helper 读到就单独吐一行，不必等后面的 AX 上下文采集，所以 90ms 的
  // 选屏截止时间才有意义。helper 会吐两条——先是便宜有界的 CGWindowList（z-order
  // 近似，一定赶得上截止线），再是权威但可能超时的 AX kAXFocusedWindow。这里保留
  // 「当前最好的一条」，AX 到了就立刻放行，没到就用已经到手的近似值。
  //
  // 要不要采集 frame 在 spawn 之前就定：单屏（或非 macOS）下答案改变不了落屏结果，
  // 就不让 helper 去读——AX 慢的目标 App 里那几次读取会白白推迟粘贴目标采集。
  let bestFocusedWindowFrame: Rectangle | null = null;
  let hasAuthoritativeFrame = false;
  let resolvePreferredFrame: () => void = () => {};
  const preferredFrameArrived = new Promise<void>((resolve) => {
    resolvePreferredFrame = resolve;
  });
  const wantsFocusedDisplay = shouldResolveFocusedDisplay();
  const captureOverlayPromise = captureMacPasteTarget(
    wantsFocusedDisplay
      ? {
        onFocusedWindowFrame: (frame, source) => {
          if (!frame || hasAuthoritativeFrame) return;
          bestFocusedWindowFrame = frame;
          if (source !== 'ax') return;
          // AX 是权威答案，到了就不再等，也不再被后续行覆盖。
          hasAuthoritativeFrame = true;
          resolvePreferredFrame();
        },
      }
      : undefined,
  );
  // 兜底：helper 一条 frame 都没吐（AX 与 CGWindowList 都没结果）、走了 osascript
  // 回退，或整个 capture 失败时，用最终结果收敛，别让选屏一直等到截止线。
  void captureOverlayPromise
    .then((captured) => {
      if (!hasAuthoritativeFrame && captured?.frame) bestFocusedWindowFrame = captured.frame;
      resolvePreferredFrame();
    })
    .catch(() => resolvePreferredFrame());
  const focusedDisplayQuery = wantsFocusedDisplay
    ? startFocusedDisplayQuery(preferredFrameArrived, () => bestFocusedWindowFrame)
    : null;
  positionOverlayWindow(window);
  prepareOverlayForDisplay(window);

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
      // 同 show()：这条延迟提交也必须绑定呈现代次。窗口是跨会话复用的，
      // overlayPresentationActive 是进程级状态，取消后紧接着重启会让它重新为
      // true，届时旧会话的回调会把刚开始录音的新会话直接提交掉。
      if (!isCurrentOverlayPresentation(window, presentationSeq)) {
        log.debug('pending modifier submit dropped: presentation no longer current');
        return;
      }
      window.webContents.send('voice-input:global-overlay-command', { type: 'submit' });
    });
  }
  const show = (): void => {
    // 两条路径（单屏的 setImmediate、多屏的等待回调）都要过这道校验：显示总是
    // 延后至少一个 tick，期间用户可能已经取消。取消只让缓存窗口进 idle、不销毁，
    // 所以只查 isDestroyed() 会让已取消的浮窗重新出现。
    if (!isCurrentOverlayPresentation(window, presentationSeq)) {
      log.debug('global overlay show skipped: presentation no longer current');
      return;
    }
    log.debug('global overlay ready to show', {
      elapsedSinceShortcutMs: Date.now() - shortcutInvokedAt,
    });
    overlayPresentationAwaitingShow = false;
    window.showInactive();
    // showInactive preserves the user's focused app, but some Electron/macOS
    // combinations can still perturb app-level presence. Restore immediately
    // after showing without focusing the main app.
    scheduleMainAppPresenceRestore('global-voice-overlay-shown');
  };
  if (!focusedDisplayQuery) {
    setImmediate(show);
    return;
  }
  // 多屏：先等一小会儿焦点屏答案，拿到就在显示前重新定位。窗口此刻还没可见，
  // 所以重定位不会被看成跳动；超时则维持鼠标所在屏的定位直接显示。
  // 这段等待期里呈现已经算「打开」（麦克风在录），见 overlayPresentationAwaitingShow。
  overlayPresentationAwaitingShow = true;
  void focusedDisplayQuery.then((focusedDisplay) => {
    if (!isCurrentOverlayPresentation(window, presentationSeq)) {
      // 等待期间用户取消了浮窗、或者已经开始了新一次呈现：这次的答案作废。
      log.debug('focused display result dropped: overlay presentation no longer current');
      return;
    }
    if (focusedDisplay) positionOverlayWindow(window, focusedDisplay);
    show();
  });
}

/** 判断一次异步定位结果是否还属于「当前这次浮窗呈现」。 */
function isCurrentOverlayPresentation(window: BrowserWindow, presentationSeq: number): boolean {
  return overlayPresentationSeq === presentationSeq
    && overlayPresentationActive
    && overlayWindow === window
    && !window.isDestroyed();
}

function showPassiveOverlayWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  // 被动呈现走的是「启动失败 / 粘贴失败后把浮窗重新亮出来」，属于同一次会话的延续，
  // 必须留在它刚才所在的位置：这时重新按鼠标所在屏定位，会让错误提示从用户正在用的
  // 那块屏跳到鼠标那块屏。浮窗 hide 后被停到屏幕外，所以用最近一次实际呈现的 bounds，
  // 那块屏已经不存在时才退回默认定位。
  const previousBounds = lastPresentedOverlayBounds;
  if (previousBounds && isBoundsCenterOnDisplay(previousBounds, getOverlayPlacementDisplays())) {
    window.setBounds(previousBounds);
  } else {
    positionOverlayWindow(window);
  }
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

/**
 * 把浮窗定位到焦点屏。`display` 省略时退回鼠标所在屏。
 *
 * 屏内位置沿用「记忆优先」：用户拖动过就用保存位置（clamp 进可见区域），
 * 保存位置在别的屏上时按相对比例迁移过来，从未拖动过则用该屏默认位置。
 */
function positionOverlayWindow(window: BrowserWindow, display = getCursorDisplay()): void {
  const displays = getOverlayPlacementDisplays();
  const bounds = resolveOverlayInitialBounds({
    savedPosition: voiceInputOverlayPositionStore.read(),
    displays,
    activeDisplay: displays.find((candidate) => candidate.id === display.id) ?? null,
    size: { width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT },
    contentInset: OVERLAY_SHADOW_PADDING,
    edgePadding: OVERLAY_EDGE_PADDING,
    fallbackBounds: computeOverlayBounds(display),
  });
  lastPresentedOverlayBounds = bounds;
  window.setBounds(bounds);
}

function getCursorDisplay(): Display {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

/**
 * 是否值得去问「前台窗口在哪块屏」。false 时既不采集 frame 也不推迟显示，直接用
 * 鼠标所在屏：
 * - 只有一块屏时答案唯一；
 * - 非 macOS 平台没有可用的低成本前台窗口查询（Electron 只能看自己的窗口），
 *   Windows 一律按鼠标所在屏判定。
 */
function shouldResolveFocusedDisplay(): boolean {
  if (process.platform !== 'darwin') return false;
  return screen.getAllDisplays().length > 1;
}

/**
 * 把前台窗口 frame 换算成「焦点屏」，并给它加显示截止时间。
 *
 * `preferredFrameArrived` 在权威答案（AX kAXFocusedWindow）到达、或 capture 整体
 * 收敛时兑现；截止线到了就用 `readBestFrame()` 当时已有的最好答案（通常是先到的
 * CGWindowList 近似值），而不是干脆放弃——放弃就退回鼠标所在屏，恰恰是本功能要修的
 * 那个错。两者都没有才返回 null。
 *
 * 注意鼠标所在屏和键盘焦点所在屏可以不同：鼠标停在 A 屏、正在 B 屏的编辑器里打字时，
 * 粘贴目标在 B 屏，浮窗也应该开在 B 屏，所以这里优先认前台窗口。
 */
function startFocusedDisplayQuery(
  preferredFrameArrived: Promise<void>,
  readBestFrame: () => Rectangle | null,
): Promise<Display | null> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const settle = (timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      const frame = readBestFrame();
      if (!frame) {
        log.debug('focused display unresolved, falling back to cursor display', {
          elapsedMs: Date.now() - startedAt,
          timedOut,
        });
        resolve(null);
        return;
      }
      // getDisplayMatching 按重叠面积选屏，跨屏摆放的窗口也能落到主要那块。
      const display = screen.getDisplayMatching(frame);
      log.debug('focused display resolved', {
        elapsedMs: Date.now() - startedAt,
        displayId: display?.id,
        // true = 没等到 AX 权威答案，用的是先到的近似 frame。
        timedOut,
      });
      resolve(display ?? null);
    };
    const timer = setTimeout(() => settle(true), OVERLAY_FOCUSED_DISPLAY_DEADLINE_MS);
    void preferredFrameArrived
      .catch(() => undefined)
      .then(() => {
        clearTimeout(timer);
        settle(false);
      });
  });
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

/**
 * 全局浮窗听写的词典 toast 贴着「产生它的那次浮窗所在的位置」出现。浮窗 hide 后会
 * 被停到屏幕外的 OVERLAY_IDLE_BOUNDS，实时 bounds 不能当锚点，所以用粘贴前拍下、
 * 请求到达时按序绑定的快照（见 pendingDictionaryToastAnchors）。
 *
 * 三个条件都满足才用它，否则退回鼠标所在屏的默认位置：
 * - 调用方是全局浮窗链路并带来了自己那次会话的锚点（应用内听写不传）；
 * - 呈现代次没变——变了说明期间又开过浮窗，这条 toast 会盖在新浮窗上；
 * - 锚点中心仍落在某块现存屏幕上——否则外接屏拔掉后 toast 会整个落到屏幕外。
 *
 * 注意「退回默认位置」本身不足以避免遮挡：默认位置就是浮窗的默认位置。真正在录音
 * 时的遮挡由 showDictionaryToastWindow() 的「有浮窗呈现就不弹」拦掉。
 */
function resolveDictionaryToastAnchorBounds(anchor: DictionaryToastAnchor | null): Rectangle {
  if (!anchor) return computeOverlayBounds(getCursorDisplay());
  if (anchor.presentationSeq === overlayPresentationSeq
    && isBoundsCenterOnDisplay(anchor.bounds, getOverlayPlacementDisplays())) {
    return anchor.bounds;
  }
  log.debug('dictionary toast anchor dropped', {
    staleSession: anchor.presentationSeq !== overlayPresentationSeq,
  });
  return computeOverlayBounds(getCursorDisplay());
}

function computeDictionaryToastBounds(overlayBounds: Rectangle): Rectangle {
  return {
    x: Math.round(overlayBounds.x + (overlayBounds.width - DICTIONARY_TOAST_WIDTH) / 2),
    y: Math.round(overlayBounds.y + (overlayBounds.height - DICTIONARY_TOAST_HEIGHT) / 2),
    width: DICTIONARY_TOAST_WIDTH,
    height: DICTIONARY_TOAST_HEIGHT,
  };
}

async function pasteTextToFocusedTarget(text: string, rawTranscriptText?: string): Promise<void> {
  // 词典 toast 锚点必须在这里、任何 await 之前拍：renderer 已经把浮窗收起并让粘贴
  // 在后台跑，用户完全可以在 pasteTextToMacTarget() 返回前开下一次会话。等到建 watch
  // 时再读 lastPresentedOverlayBounds / 呈现代次，拿到的就是新会话的现场了。
  const toastAnchor = captureOverlayToastAnchor();
  const pasteTarget = await resolveOverlayPasteTarget();
  log.debug(PASTE_DEBUG_TAG, 'paste start', {
    chars: text.length,
    rawTranscriptChars: rawTranscriptText?.length ?? 0,
    target: describePasteTarget(pasteTarget),
  });
  if (process.platform === 'darwin') {
    await pasteTextToMacTarget(text, pasteTarget);
    scheduleExternalDictionaryLearningWatch(text, rawTranscriptText, pasteTarget, overlayPasteContext, toastAnchor);
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
  /**
   * 前台窗口 frame（DIP 屏幕坐标），来自与 target 同一次 helper 调用、同一次
   * frontmostApplication 读取，所以「浮窗开在哪块屏」与「粘贴进哪个 App」不会
   * 各自认到不同的前台 App。osascript 兜底路径拿不到 frame。
   */
  frame: Rectangle | null;
};

/**
 * `onFocusedWindowFrame` 会在 helper 吐出前台窗口 frame 行时立刻回调——远早于整个
 * capture 完成（AX 上下文采集在 Chromium 系编辑器里可能要几百毫秒）。浮窗选屏只等
 * 这些行，所以不能等最终结果。
 *
 * helper 会吐两条：`window-list`（便宜有界的 z-order 近似）和 `ax`（权威的
 * kAXFocusedWindow，可能超时）。`source` 原样透传，由调用方决定取舍。
 */
async function captureMacPasteTarget(
  options?: { onFocusedWindowFrame?: (frame: Rectangle | null, source: string) => void },
): Promise<CapturedOverlayTarget | null> {
  if (process.platform !== 'darwin') return null;
  const onFocusedWindowFrame = options?.onFocusedWindowFrame;
  try {
    // 只有真要用 frame 时才让 helper 去读它：AX 慢的目标 App 里 focusedWindow /
    // position / size 三次请求各自可能吃满 200ms messaging timeout，而单屏下这个答案
    // 根本改变不了落屏结果，白白推迟粘贴目标采集。
    const args = ['--command', 'capture-target'];
    if (onFocusedWindowFrame) args.push('--with-focused-frame');
    const helperResult = await runMacTextInsertionHelper(args, {
      onProgress: onFocusedWindowFrame
        ? (event) => {
          if (event.event !== 'focused-window-frame') return;
          onFocusedWindowFrame(
            normalizeFocusedWindowFrame(event.frame),
            typeof event.frameSource === 'string' ? event.frameSource : 'unknown',
          );
        }
        : undefined,
    });
    if (helperResult.ok && helperResult.target?.processName) {
      const frame = normalizeFocusedWindowFrame(helperResult.frame);
      log.debug(PASTE_DEBUG_TAG, 'capture target result (native)', {
        target: describePasteTarget(helperResult.target),
        context: summarizePasteContext(helperResult.context),
        enhancedAxAttempted: Boolean(helperResult.enhancedAxAttempted),
        enhancedAxHelped: Boolean(helperResult.enhancedAxHelped),
        hasFocusedWindowFrame: Boolean(frame),
        frameSource: helperResult.frameSource,
      });
      return {
        target: helperResult.target,
        context: helperResult.context ?? null,
        frame,
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
      // osascript 只报前台 App，不报窗口几何：焦点屏退回鼠标所在屏。
      frame: null,
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
  toastAnchor: DictionaryToastAnchor | null,
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
    toastAnchor,
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
  }, watch.toastAnchor);
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
      // 词典学习只关心文本上下文，不需要窗口几何（浮窗此时早已关掉）。
      frame: null,
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
  toastAnchor: DictionaryToastAnchor | null,
): void {
  const window = getOverlayWindow();
  if (!window || window.isDestroyed()) return;
  // 锚点是粘贴开始前拍的（那才是这条证据对应的浮窗现场），这里排进队列，等这条
  // 证据的建议请求到达 main 时按到达顺序取走。几何值不进 IPC payload：证据要经
  // renderer 往返，renderer 传回的坐标属于不可信输入。
  if (toastAnchor) {
    pendingDictionaryToastAnchors.push(toastAnchor);
    while (pendingDictionaryToastAnchors.length > DICTIONARY_TOAST_ANCHOR_MAX_ENTRIES) {
      pendingDictionaryToastAnchors.shift();
    }
  }
  window.webContents.send('voice-input:dictionary-learning-evidence', { evidence });
}

/** 拍下「当前这次浮窗现场」，供之后给它的词典 toast 定位。 */
function captureOverlayToastAnchor(): DictionaryToastAnchor | null {
  if (!lastPresentedOverlayBounds) return null;
  return { bounds: lastPresentedOverlayBounds, presentationSeq: overlayPresentationSeq };
}

/**
 * 取走属于「当前这次浮窗呈现」的 toast 锚点，绑定给这一次词典建议请求。
 *
 * 身份靠呈现代次，不靠队列位置：代次已经变过的锚点无论给谁都过不了
 * resolveDictionaryToastAnchorBounds() 的复核（那正是「期间又开过浮窗」的定义），
 * 所以这里遇到就直接丢弃，继续找代次仍匹配的那个。这样两种情况都不会错位：
 * - 旧会话的建议迟到（此时已开过新浮窗）→ 它的锚点已过期，取不到，走默认位置；
 * - renderer 因功能开关没发起请求，锚点留在队列里 → 下次请求会把它当过期丢掉，
 *   拿到自己那份，不会一直错位一格。
 *
 * 必须在请求刚到达、任何 await 之前调用（代次此刻才代表这次请求的来源会话）。
 * 应用内听写不要调用它。
 */
export function takeOverlayDictionaryToastAnchor(): DictionaryToastAnchor | null {
  while (pendingDictionaryToastAnchors.length > 0) {
    const candidate = pendingDictionaryToastAnchors.shift();
    if (candidate && candidate.presentationSeq === overlayPresentationSeq) return candidate;
  }
  return null;
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

/**
 * helper 可以在最终结果之前先流式吐出若干「进度行」（每行一个 JSON，带 `event`
 * 字段），最后一行才是命令结果。`onProgress` 会在进度行到达时同步回调；只有传了
 * 它才走 spawn 逐行读取，其余调用保持原来的 execFile 缓冲路径。
 */
async function runMacTextInsertionHelper(
  args: string[],
  options?: {
    input?: string;
    timeoutMs?: number;
    onProgress?: (event: MacTextInsertionHelperResult) => void;
  },
): Promise<MacTextInsertionHelperResult> {
  const helperPath = await resolveMacTextInsertionHelperPath();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const stdout = options?.onProgress
    ? await spawnHelperWithProgressPromise(helperPath, args, timeoutMs, options.onProgress)
    : await execFilePromise(helperPath, args, 'Could not run macOS text insertion helper.', {
      timeoutMs,
      input: options?.input,
    });
  try {
    return parseMacTextInsertionHelperResult(stdout);
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

/** 取 stdout 的最后一行 JSON 作为命令结果（前面的行是流式进度事件）。 */
export function parseMacTextInsertionHelperResult(stdout: string): MacTextInsertionHelperResult {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1];
  if (lastLine === undefined) throw new Error('Empty helper response');
  return JSON.parse(lastLine) as MacTextInsertionHelperResult;
}

/**
 * spawn helper 并逐行解析 stdout：非最后一行的 JSON 交给 onProgress，完整 stdout
 * 仍然返回给调用方按最后一行取结果。只有需要「结果之前先拿到中间事件」的调用会
 * 走这里（目前只有 capture-target 的前台窗口 frame）。
 */
function spawnHelperWithProgressPromise(
  command: string,
  args: string[],
  timeoutMs: number,
  onProgress: (event: MacTextInsertionHelperResult) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let pending = '';
    let stderr = '';
    let settled = false;

    const settle = (run: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run();
    };
    const timer = setTimeout(() => {
      settle(() => {
        child.kill('SIGTERM');
        reject(new PasteCommandError(
          'Could not run macOS text insertion helper.',
          `Helper timed out after ${timeoutMs}ms.`,
        ));
      });
    }, timeoutMs);

    // setEncoding 必须在这里显式设：否则每个 Buffer 各自 toString()，一个跨 chunk
    // 边界被切开的多字节 UTF-8 字符会两边各变成替换字符。AX 上下文里全是中文这类
    // 非 ASCII 文本，而最终 JSON 仍能解析成功，损坏会静默流进 refine 与词典学习。
    // 设了编码后由流内部的 StringDecoder 跨 chunk 保留半个字符。
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    // 每收到一个完整换行就尝试解析：带 event 字段的是进度事件，最后一行结果不在
    // 这里派发（由调用方从完整 stdout 取）。解析失败的行直接忽略——stdout 可能
    // 含用户输入框文本，不进日志。
    child.stdout.on('data', (text: string) => {
      stdout += text;
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as MacTextInsertionHelperResult & { event?: string };
          if (parsed.event) onProgress(parsed);
        } catch {
          // 半行 / 非 JSON 输出：忽略，最终结果仍按最后一行解析。
        }
      }
    });
    child.stderr.on('data', (text: string) => {
      stderr += text;
    });
    child.on('error', (error) => {
      settle(() => reject(new PasteCommandError(
        'Could not run macOS text insertion helper.',
        error.message,
      )));
    });
    child.on('close', (code) => {
      settle(() => {
        if (code === 0) {
          resolve(stdout);
          return;
        }
        reject(new PasteCommandError(
          'Could not run macOS text insertion helper.',
          stderr.trim() || `Helper exited with code ${code}.`,
        ));
      });
    });
  });
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
