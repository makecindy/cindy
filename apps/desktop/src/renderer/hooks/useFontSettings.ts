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
  UI_TEXT_TOKEN_SIZES,
  SCALED_TAILWIND_TOKENS,
  TAILWIND_LINE_HEIGHTS,
} from '../styles/generated/token-mappings';

import {
  APPEARANCE_LIMITS,
  DEFAULT_APPEARANCE_SETTINGS,
  clampAppearanceCodeSize,
  clampAppearanceTerminalSize,
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

interface ConfigurableFontSettings extends FontSettings {
  terminalFamily: string;
  terminalSize: number;
}

interface FontSettingsContextValue extends ConfigurableFontSettings {
  setUiFamily: (family: string) => void;
  setCodeFamily: (family: string) => void;
  setUiSize: (size: number) => void;
  setCodeSize: (size: number) => void;
  setTerminalFamily: (family: string) => void;
  setTerminalSize: (size: number) => void;
  resetUiFamily: () => void;
  resetCodeFamily: () => void;
  resetUiSize: () => void;
  resetCodeSize: () => void;
  resetTerminalFamily: () => void;
  resetTerminalSize: () => void;
}

export const DEFAULT_UI_FONT_SIZE = DEFAULT_APPEARANCE_SETTINGS.uiSize;
export const DEFAULT_CODE_FONT_SIZE = DEFAULT_APPEARANCE_SETTINGS.codeSize;
export const DEFAULT_TERMINAL_FONT_SIZE = DEFAULT_APPEARANCE_SETTINGS.terminalSize;
const MIN_UI_FONT_SIZE = APPEARANCE_LIMITS.uiSize.min;
const MIN_FONT_SIZE = APPEARANCE_LIMITS.codeSize.min;
const MAX_FONT_SIZE = APPEARANCE_LIMITS.codeSize.max;

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

  for (const [tokenSize, base] of Object.entries(UI_TEXT_TOKEN_SIZES)) {
    set(`--text-${tokenSize}`, `${Math.round(base * scale)}px`);
  }
  for (const [token, base] of Object.entries(SCALED_TAILWIND_TOKENS)) {
    set(`--text-${token}`, `${Math.round(base * scale)}px`);
  }
  for (const [token, base] of Object.entries(TAILWIND_LINE_HEIGHTS)) {
    set(`--text-${token}-line-height`, `${Math.round(base * scale)}px`);
  }
}

export function FontSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<ConfigurableFontSettings>(() => {
    const initial = getInitialAppearanceSettings();
    return {
      uiFamily: initial.uiFamily,
      codeFamily: initial.codeFamily,
      uiSize: initial.uiSize,
      codeSize: initial.codeSize,
      terminalFamily: initial.terminalFamily,
      terminalSize: initial.terminalSize,
    };
  });
  const settingsRef = useRef(settings);
  const confirmedSettingsRef = useRef(settings);
  const pendingWritesRef = useRef<Array<{ id: number; patch: Partial<ConfigurableFontSettings> }>>(
    [],
  );
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const nextRequestIdRef = useRef(0);

  const { uiFamily, codeFamily, uiSize, codeSize } = settings;
  useEffect(() => {
    // Terminal appearance is applied to xterm only, never to the global UI/code tokens.
    applyFontSettings({ uiFamily, codeFamily, uiSize, codeSize });
  }, [uiFamily, codeFamily, uiSize, codeSize]);

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
        terminalFamily: normalized.terminalFamily,
        terminalSize: normalized.terminalSize,
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

  const patch = useCallback((next: Partial<ConfigurableFontSettings>) => {
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
  const setTerminalFamily = useCallback(
    (family: string) => patch({ terminalFamily: normalizeFamily(family) }),
    [patch],
  );
  const setTerminalSize = useCallback(
    (size: number) => patch({ terminalSize: clampAppearanceTerminalSize(size) }),
    [patch],
  );
  const resetTerminalFamily = useCallback(() => setTerminalFamily(''), [setTerminalFamily]);
  const resetTerminalSize = useCallback(
    () => setTerminalSize(DEFAULT_TERMINAL_FONT_SIZE),
    [setTerminalSize],
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
      setTerminalFamily,
      setTerminalSize,
      resetUiFamily,
      resetCodeFamily,
      resetUiSize,
      resetCodeSize,
      resetTerminalFamily,
      resetTerminalSize,
    }),
    [
      resetCodeFamily,
      resetCodeSize,
      resetTerminalFamily,
      resetTerminalSize,
      resetUiFamily,
      resetUiSize,
      setCodeFamily,
      setCodeSize,
      setTerminalFamily,
      setTerminalSize,
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
