import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { cindyHandheld, type HandheldVoiceKeyPhase } from '../../modules/cindy-handheld/src';

/*
 * 掌机模式(Android 游戏掌机 / 寨机):本机偏好 + 手柄语音键的页面分发。
 *
 * 偏好属于这台设备而不是账号,存一份 AsyncStorage;原生侧(cindy-handheld)负责按键拦截、
 * 焦点框、摇杆滚动与换屏,这里只决定开关、语音键和是否放到副屏,并把语音键的
 * start / end 分发给当前聚焦的页面。
 */

const STORAGE_KEY = 'cindy.mobile.handheld.v1';

/** Android KeyEvent 键码(KEYCODE_BUTTON_*)。 */
export const HANDHELD_KEY_CODES = {
  A: 96,
  B: 97,
  X: 99,
  Y: 100,
  L1: 102,
  R1: 103,
  L2: 104,
  R2: 105,
  THUMBL: 106,
  THUMBR: 107,
  START: 108,
  SELECT: 109,
} as const;

export const DEFAULT_HANDHELD_VOICE_KEY = HANDHELD_KEY_CODES.X;

/** 设置页可直接选的语音键,按掌机上常见的顺序排列。 */
export const HANDHELD_VOICE_KEY_OPTIONS: readonly number[] = [
  HANDHELD_KEY_CODES.X,
  HANDHELD_KEY_CODES.Y,
  HANDHELD_KEY_CODES.L2,
  HANDHELD_KEY_CODES.R2,
  HANDHELD_KEY_CODES.THUMBL,
  HANDHELD_KEY_CODES.THUMBR,
  HANDHELD_KEY_CODES.SELECT,
  HANDHELD_KEY_CODES.START,
  HANDHELD_KEY_CODES.L1,
  HANDHELD_KEY_CODES.R1,
  HANDHELD_KEY_CODES.A,
  HANDHELD_KEY_CODES.B,
];

const KEY_LABELS: Record<number, string> = {
  96: 'A',
  97: 'B',
  98: 'C',
  99: 'X',
  100: 'Y',
  101: 'Z',
  102: 'L1',
  103: 'R1',
  104: 'L2',
  105: 'R2',
  106: 'L3',
  107: 'R3',
  108: 'Start',
  109: 'Select',
  110: 'Mode',
};

/** 键码的显示名;录入到的少见键(BUTTON_1…)退回 Android 的 KEYCODE_ 名去前缀。 */
export function handheldKeyLabel(keyCode: number, nativeName?: string): string {
  const known = KEY_LABELS[keyCode];
  if (known) return known;
  if (nativeName) return nativeName.replace(/^KEYCODE_(BUTTON_)?/, '');
  return String(keyCode);
}

export type HandheldModeSettings = {
  enabled: boolean;
  voiceKeyCode: number;
  /** 键码不在 KEY_LABELS 里时,录入那一刻原生给的名字,供显示。 */
  voiceKeyName?: string;
  /** 开启时把 Cindy 放到副屏(双屏掌机的下屏);没有副屏时无效果。 */
  useSecondaryDisplay: boolean;
};

export const DEFAULT_HANDHELD_SETTINGS: HandheldModeSettings = {
  enabled: false,
  voiceKeyCode: DEFAULT_HANDHELD_VOICE_KEY,
  useSecondaryDisplay: true,
};

export function isHandheldModeSupported(): boolean {
  return Platform.OS === 'android' && !!cindyHandheld?.available;
}

export function parseHandheldSettings(raw: string | null): HandheldModeSettings {
  if (!raw) return DEFAULT_HANDHELD_SETTINGS;
  try {
    const value = JSON.parse(raw) as Partial<HandheldModeSettings>;
    const voiceKeyCode = typeof value.voiceKeyCode === 'number' && Number.isInteger(value.voiceKeyCode) && value.voiceKeyCode > 0
      ? value.voiceKeyCode
      : DEFAULT_HANDHELD_VOICE_KEY;
    return {
      enabled: value.enabled === true,
      voiceKeyCode,
      ...(typeof value.voiceKeyName === 'string' && value.voiceKeyName ? { voiceKeyName: value.voiceKeyName } : {}),
      useSecondaryDisplay: value.useSecondaryDisplay !== false,
    };
  } catch {
    return DEFAULT_HANDHELD_SETTINGS;
  }
}

type SettingsSnapshot = { hydrated: boolean; settings: HandheldModeSettings };

let snapshot: SettingsSnapshot = { hydrated: false, settings: DEFAULT_HANDHELD_SETTINGS };
let hydration: Promise<void> | null = null;
const settingsListeners = new Set<() => void>();

function emitSettings(next: SettingsSnapshot) {
  snapshot = next;
  for (const listener of settingsListeners) listener();
}

export function getHandheldSettingsSnapshot(): SettingsSnapshot {
  return snapshot;
}

export function subscribeHandheldSettings(listener: () => void): () => void {
  settingsListeners.add(listener);
  return () => settingsListeners.delete(listener);
}

export function hydrateHandheldSettings(): Promise<void> {
  if (!isHandheldModeSupported()) return Promise.resolve();
  hydration ??= AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      // 读取期间用户已改过设置时以用户这次的为准。
      if (!snapshot.hydrated) emitSettings({ hydrated: true, settings: parseHandheldSettings(raw) });
    })
    .catch(() => {
      if (!snapshot.hydrated) emitSettings({ hydrated: true, settings: DEFAULT_HANDHELD_SETTINGS });
    });
  return hydration;
}

/** 立即生效并落盘;写盘失败抛给调用方提示,内存里的选择保持(本次运行仍有效)。 */
export async function updateHandheldSettings(patch: Partial<HandheldModeSettings>): Promise<void> {
  const settings = { ...snapshot.settings, ...patch };
  if (patch.voiceKeyCode !== undefined && patch.voiceKeyName === undefined) delete settings.voiceKeyName;
  emitSettings({ hydrated: true, settings });
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function useHandheldSettings(): SettingsSnapshot {
  return useSyncExternalStore(subscribeHandheldSettings, getHandheldSettingsSnapshot, getHandheldSettingsSnapshot);
}

// ── 语音键分发 ────────────────────────────────────────────────────────────
//
// 只有栈顶(最近聚焦)的页面收到语音键。按住期间换页(首页长按 → 打开新建页)时,
// 新页面一注册就补发 start,松手的 end 也交给它,从而做到「任何页长按 X 都能说话」。

export type HandheldVoiceKeyHandler = {
  start(): void;
  end(): void;
};

const voiceHandlers: HandheldVoiceKeyHandler[] = [];
let voiceHeld = false;
let voiceOwner: HandheldVoiceKeyHandler | null = null;

export function registerHandheldVoiceKeyHandler(handler: HandheldVoiceKeyHandler): () => void {
  voiceHandlers.push(handler);
  if (voiceHeld && voiceOwner !== handler) {
    voiceOwner = handler;
    handler.start();
  }
  return () => {
    const index = voiceHandlers.lastIndexOf(handler);
    if (index >= 0) voiceHandlers.splice(index, 1);
    if (voiceOwner === handler) voiceOwner = null;
  };
}

export function dispatchHandheldVoiceKey(phase: HandheldVoiceKeyPhase): void {
  if (phase === 'start') {
    voiceHeld = true;
    voiceOwner = voiceHandlers[voiceHandlers.length - 1] ?? null;
    voiceOwner?.start();
    return;
  }
  if (phase === 'tap') return;
  // end / cancel:都按松手收尾,已说的内容保留在输入框里。
  voiceHeld = false;
  const owner = voiceOwner;
  voiceOwner = null;
  owner?.end();
}

/** 页面聚焦期间接收手柄语音键。handlers 每次渲染更新,不需要稳定引用。 */
export function useHandheldVoiceKey(handlers: HandheldVoiceKeyHandler, enabled = true): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  useFocusEffect(useCallback(() => {
    if (!enabled || !isHandheldModeSupported()) return undefined;
    return registerHandheldVoiceKeyHandler({
      start: () => handlersRef.current.start(),
      end: () => handlersRef.current.end(),
    });
  }, [enabled]));
}

/** 测试用:清空分发状态。 */
export function resetHandheldVoiceKeyForTests(): void {
  voiceHandlers.length = 0;
  voiceHeld = false;
  voiceOwner = null;
  snapshot = { hydrated: false, settings: DEFAULT_HANDHELD_SETTINGS };
  hydration = null;
}
