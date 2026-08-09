import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  APPEARANCE_LIMITS,
  DEFAULT_APPEARANCE_SETTINGS,
  clampAppearanceCodeSize,
  clampAppearanceUiSize,
  normalizeAppearanceSettings,
  type AppearanceSettings,
} from '@/../shared/appearanceSettings';

export interface FontSettings {
  uiFamily: string;
  codeFamily: string;
  uiSize: number;
  codeSize: number;
}

interface FontSettingsContextValue extends FontSettings {
  setUiFamily: (family: string) => void;
  setCodeFamily: (family: string) => void;
  setUiSize: (size: number) => void;
  setCodeSize: (size: number) => void;
  resetUiFamily: () => void;
  resetCodeFamily: () => void;
  resetUiSize: () => void;
  resetCodeSize: () => void;
}

export const DEFAULT_UI_FONT_SIZE = DEFAULT_APPEARANCE_SETTINGS.uiSize;
export const DEFAULT_CODE_FONT_SIZE = DEFAULT_APPEARANCE_SETTINGS.codeSize;
const MIN_UI_FONT_SIZE = APPEARANCE_LIMITS.uiSize.min;
const MIN_FONT_SIZE = APPEARANCE_LIMITS.codeSize.min;
const MAX_FONT_SIZE = APPEARANCE_LIMITS.codeSize.max;

// DESIGN.md §3 numeric 字号白名单的运行时镜像；applyFontSettings 会按
// 用户 UI 字号缩放覆写 globals.css 的静态默认值。
const UI_TEXT_TOKEN_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20, 24, 28] as const;

const SCALED_TAILWIND_TOKENS = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  '2xl': 24,
  '3xl': 30,
  '4xl': 36,
  '5xl': 48,
} as const;

const TAILWIND_LINE_HEIGHTS = {
  xs: 16,
  sm: 20,
  base: 24,
  lg: 28,
  xl: 28,
  '2xl': 32,
  '3xl': 36,
  '4xl': 40,
  '5xl': 48,
} as const;

const FontSettingsContext = createContext<FontSettingsContextValue | undefined>(undefined);

export function clampFontSize(value: number, fallback = DEFAULT_CODE_FONT_SIZE): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(value)));
}

export function clampUiFontSize(value: number, fallback = DEFAULT_UI_FONT_SIZE): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(APPEARANCE_LIMITS.uiSize.max, Math.max(MIN_UI_FONT_SIZE, Math.round(value)));
}

function normalizeFamily(value: string): string {
  return value.trim().slice(0, 256);
}

function getBridge(): typeof window.electronAPI.appearanceSettings | null {
  return window.electronAPI?.appearanceSettings ?? null;
}

export function getInitialAppearanceSettings(): AppearanceSettings {
  const snapshot = getBridge()?.getSync?.();
  return normalizeAppearanceSettings(snapshot ?? DEFAULT_APPEARANCE_SETTINGS);
}

export function getInitialFontSettings(): FontSettings {
  const settings = getInitialAppearanceSettings();
  return {
    uiFamily: settings.uiFamily,
    codeFamily: settings.codeFamily,
    uiSize: settings.uiSize,
    codeSize: settings.codeSize,
  };
}

export function applyFontSettings(settings: FontSettings): void {
  const root = document.documentElement;
  const uiFamily = normalizeFamily(settings.uiFamily);
  const codeFamily = normalizeFamily(settings.codeFamily);
  const uiSize = clampUiFontSize(settings.uiSize);
  const codeSize = clampFontSize(settings.codeSize);
  const scale = uiSize / DEFAULT_UI_FONT_SIZE;
  const targets = [root, document.body].filter(Boolean);

  const set = (name: string, value: string) => {
    for (const target of targets) target.style.setProperty(name, value);
  };

  for (const target of targets) {
    if (uiFamily) {
      target.style.setProperty('--app-font-ui', `${uiFamily}, var(--app-font-ui-default)`);
    } else {
      target.style.removeProperty('--app-font-ui');
    }
    if (codeFamily) {
      target.style.setProperty('--app-font-code', `${codeFamily}, var(--app-font-code-default)`);
    } else {
      target.style.removeProperty('--app-font-code');
    }
  }
  set('--app-code-font-size', `${codeSize}px`);
  set('--app-ui-font-size', `${uiSize}px`);

  for (const tokenSize of UI_TEXT_TOKEN_SIZES) {
    set(`--text-${tokenSize}`, `${Math.round(tokenSize * scale)}px`);
  }
  for (const [token, base] of Object.entries(SCALED_TAILWIND_TOKENS)) {
    set(`--text-${token}`, `${Math.round(base * scale)}px`);
  }
  for (const [token, base] of Object.entries(TAILWIND_LINE_HEIGHTS)) {
    set(`--text-${token}-line-height`, `${Math.round(base * scale)}px`);
  }
}

export function FontSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<FontSettings>(getInitialFontSettings);
  const settingsRef = useRef(settings);
  const confirmedSettingsRef = useRef(settings);
  const pendingWritesRef = useRef<Array<{ id: number; patch: Partial<FontSettings> }>>([]);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const nextRequestIdRef = useRef(0);

  useEffect(() => {
    applyFontSettings(settings);
  }, [settings]);

  useEffect(() => {
    const bridge = getBridge();
    if (!bridge?.onChanged) return;
    return bridge.onChanged((next: AppearanceSettings) => {
      const normalized = normalizeAppearanceSettings(next);
      const confirmed = {
        uiFamily: normalized.uiFamily,
        codeFamily: normalized.codeFamily,
        uiSize: normalized.uiSize,
        codeSize: normalized.codeSize,
      };
      confirmedSettingsRef.current = confirmed;
      const optimistic = pendingWritesRef.current.reduce(
        (current, pending) => ({ ...current, ...pending.patch }),
        confirmed,
      );
      settingsRef.current = optimistic;
      setSettings(optimistic);
    });
  }, []);

  const patch = useCallback((next: Partial<FontSettings>) => {
    const previous = settingsRef.current;
    const merged = { ...previous, ...next };
    const bridge = getBridge();
    if (!bridge) {
      settingsRef.current = merged;
      setSettings(merged);
      return;
    }
    const requestId = nextRequestIdRef.current + 1;
    nextRequestIdRef.current = requestId;
    pendingWritesRef.current.push({ id: requestId, patch: next });
    settingsRef.current = merged;
    setSettings(merged);
    writeQueueRef.current = writeQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        try {
          await bridge.setPatch(next);
          pendingWritesRef.current = pendingWritesRef.current.filter(
            (pending) => pending.id !== requestId,
          );
        } catch (error: unknown) {
          window.electronAPI?.logToMain?.(
            'error',
            'renderer/appearance-settings',
            `appearance settings write failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          pendingWritesRef.current = pendingWritesRef.current.filter(
            (pending) => pending.id !== requestId,
          );
          const optimistic = pendingWritesRef.current.reduce(
            (current, pending) => ({ ...current, ...pending.patch }),
            confirmedSettingsRef.current,
          );
          settingsRef.current = optimistic;
          setSettings(optimistic);
        }
      });
  }, []);

  const setUiFamily = useCallback(
    (family: string) => patch({ uiFamily: normalizeFamily(family) }),
    [patch],
  );
  const setCodeFamily = useCallback(
    (family: string) => patch({ codeFamily: normalizeFamily(family) }),
    [patch],
  );
  const setUiSize = useCallback(
    (size: number) => patch({ uiSize: clampAppearanceUiSize(size) }),
    [patch],
  );
  const setCodeSize = useCallback(
    (size: number) => patch({ codeSize: clampAppearanceCodeSize(size) }),
    [patch],
  );
  const resetUiFamily = useCallback(() => setUiFamily(''), [setUiFamily]);
  const resetCodeFamily = useCallback(() => setCodeFamily(''), [setCodeFamily]);
  const resetUiSize = useCallback(() => setUiSize(DEFAULT_UI_FONT_SIZE), [setUiSize]);
  const resetCodeSize = useCallback(() => setCodeSize(DEFAULT_CODE_FONT_SIZE), [setCodeSize]);

  const value = useMemo<FontSettingsContextValue>(
    () => ({
      ...settings,
      setUiFamily,
      setCodeFamily,
      setUiSize,
      setCodeSize,
      resetUiFamily,
      resetCodeFamily,
      resetUiSize,
      resetCodeSize,
    }),
    [
      resetCodeFamily,
      resetCodeSize,
      resetUiFamily,
      resetUiSize,
      setCodeFamily,
      setCodeSize,
      setUiFamily,
      setUiSize,
      settings,
    ],
  );

  return createElement(FontSettingsContext.Provider, { value }, children);
}

export function useFontSettings(): FontSettingsContextValue {
  const context = useContext(FontSettingsContext);
  if (context === undefined) {
    throw new Error('useFontSettings must be used within a FontSettingsProvider');
  }
  return context;
}
