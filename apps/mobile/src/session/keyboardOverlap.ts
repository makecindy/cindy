import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform, type KeyboardMetrics } from 'react-native';
import { isDockedKeyboard } from '@/auth/loginKeyboardAvoidance';

type Viewport = { width: number; height: number };

/**
 * iOS 键盘在窗口底部实际遮挡的高度，输入卡片与浮动输入框（新建任务页）共用这一判据。
 *
 * iPhone Duo（iOS 27）从远程桌面返回进入画中画后，系统发来的键盘坐标会改按另一块
 * 屏幕的坐标系（如 274×154 落在 466×678 的右下角，或整宽却悬在屏幕中间），而键盘实际
 * 仍停靠在窗口底部；画中画结束、切后台都不会恢复，直到 App 冷启动。原生侧没有可靠的
 * 替代来源（keyboardLayoutGuide 同样失效），这里沿用同宽度下最近一次正常的高度。
 */
export function iosKeyboardOverlap(frame: KeyboardMetrics, viewport: Viewport): number {
  if (isImplausibleIPhoneKeyboardFrame(frame, viewport)) return fallbackKeyboardHeight(viewport);
  return isDockedKeyboard({ x: frame.screenX, y: frame.screenY, ...frame }, viewport.width)
    && frame.screenY + frame.height >= viewport.height
    ? Math.max(0, Math.min(frame.height, viewport.height - frame.screenY))
    : 0;
}

/**
 * iPhone 没有悬浮 / 分离键盘：显示中的键盘若不是整宽、或没贴住窗口底边，就是系统给错的坐标。
 * 交互式下拉时底边会越过窗口底，不算异常。iPad 的悬浮键盘保持原有判定。
 */
export function isImplausibleIPhoneKeyboardFrame(frame: KeyboardMetrics, viewport: Viewport) {
  return Platform.OS === 'ios' && (Platform as { isPad?: boolean }).isPad !== true
    && (Math.abs(frame.width - viewport.width) > 1 || frame.screenY + frame.height < viewport.height - 1);
}

/**
 * 每个窗口宽度见过的最高完整停靠（底边贴住窗口底）键盘高度，跨冷启动保存在本机：
 * 冷启动后直接进远程桌面时内存里还没有正常键盘。取最高而不是最近一次：键盘高度随输入法、
 * 候选栏变化，偏矮会盖住输入框。转屏途中的过渡帧由调用方排除（见 useMobileKeyboardState），
 * 否则一次过高的过渡帧会让之后一直抬得过高。
 */
const DOCKED_KEYBOARD_HEIGHTS_KEY = 'cindy.mobile.keyboard-docked-height.v2';
const dockedKeyboardHeights = new Map<number, number>();
let dockedKeyboardHeightsLoaded = false;
const hydrationListeners = new Set<() => void>();

/**
 * 本机记录是异步读出的：读完前遇到异常坐标只能先用估算，读完若记录更高，已显示的键盘占位
 * 必须重算，否则会一直停在估算值直到下一次键盘事件。读取改变了任何高度时通知订阅者。
 */
export function subscribeDockedKeyboardHeights(listener: () => void) {
  hydrationListeners.add(listener);
  return () => { hydrationListeners.delete(listener); };
}

export function __resetDockedKeyboardHeightsForTest() {
  dockedKeyboardHeights.clear();
  dockedKeyboardHeightsLoaded = false;
}

export function loadDockedKeyboardHeights() {
  if (dockedKeyboardHeightsLoaded || Platform.OS !== 'ios') return;
  dockedKeyboardHeightsLoaded = true;
  void AsyncStorage.getItem(DOCKED_KEYBOARD_HEIGHTS_KEY)
    .then((raw) => {
      const saved: unknown = raw ? JSON.parse(raw) : null;
      if (!saved || typeof saved !== 'object') return;
      let changed = false;
      for (const [width, height] of Object.entries(saved)) {
        const key = Number(width);
        if (Number.isFinite(key) && typeof height === 'number' && height > (dockedKeyboardHeights.get(key) ?? 0)) {
          dockedKeyboardHeights.set(key, height);
          changed = true;
        }
      }
      if (changed) for (const listener of [...hydrationListeners]) listener();
    })
    .catch(() => {});
}

/** 只记录整宽且底边贴住窗口底的正常键盘。 */
export function rememberDockedKeyboard(frame: KeyboardMetrics, viewport: Viewport) {
  if (Platform.OS !== 'ios' || frame.height <= 0 || isImplausibleIPhoneKeyboardFrame(frame, viewport)
    || Math.abs(frame.screenY + frame.height - viewport.height) > 1) return;
  const key = Math.round(viewport.width);
  const value = Math.round(frame.height);
  if ((dockedKeyboardHeights.get(key) ?? 0) >= value) return;
  dockedKeyboardHeights.set(key, value);
  void AsyncStorage.setItem(DOCKED_KEYBOARD_HEIGHTS_KEY, JSON.stringify(Object.fromEntries(dockedKeyboardHeights)))
    .catch(() => {});
}

export function hasRememberedKeyboardHeight(viewport: Viewport) {
  return dockedKeyboardHeights.has(Math.round(viewport.width));
}

/**
 * 沿用高度取「见过的最高」与「按窗口比例估算」中较大者，宁可略高也不盖住输入框：只见过
 * 较矮的键盘（如无候选栏的英文键盘）时，换成中文候选栏仍不会盖住。估算：竖屏约占窗口
 * 高度 38%（Duo 实测 362/951）；横屏 Duo 是分体键盘约 39%（264/669），普通 iPhone 横屏约 209pt。
 */
export function fallbackKeyboardHeight(viewport: Viewport) {
  const estimate = Math.round(viewport.width < viewport.height
    ? viewport.height * 0.38
    : Math.max(viewport.height * 0.42, 220));
  return Math.max(estimate, dockedKeyboardHeights.get(Math.round(viewport.width)) ?? 0);
}
