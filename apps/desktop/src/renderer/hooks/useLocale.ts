/**
 * useLocale —— 显示语言偏好 + 实际生效语言。
 *
 * 设计上和 useTheme 镜像：
 *   - 偏好持久化在 localStorage (key='language')，不经 server。
 *   - 'system' = 运行时跟 OS 走，由 main 进程读取 OS 首选语言列表并解析。
 *   - 切换语言时同步 i18next.changeLanguage 触发 react-i18next 重渲染，
 *     同步 <html lang="...">，并通知 main 刷新 macOS 原生菜单文案。
 *
 * 不做 OS 语言运行时监听。用户改了系统语言后需要重启应用，这是 Electron 通用行为。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { createElement } from 'react';

import {
  i18n,
  type LocalePreference,
  type SupportedLocale,
} from '@/i18n';
import type { ClassicalReplyStyleId } from '@cindy/maker-shared/classical-reply';
import {
  readStoredClassicalStyle,
  readStoredLocale,
  writeStoredClassicalStyle,
  writeStoredLocale,
  effectiveOf,
  getEffectiveLocale,
} from '@/lib/localePreference';

interface LocaleContextValue {
  /** 用户的偏好选择 (含 'system')。 */
  locale: LocalePreference;
  /** 实际生效的语言 ('system' 已解析为 OS 语言)。 */
  effectiveLocale: SupportedLocale;
  /** 设置偏好 —— 持久化到 localStorage、刷 i18next、刷 <html lang>。 */
  setLocale: (next: LocalePreference) => void;
  /** 古典界面（文言）下 AI 作答的输出风格。 */
  classicalStyle: ClassicalReplyStyleId;
  setClassicalStyle: (next: ClassicalReplyStyleId) => void;
}

const LocaleContext = createContext<LocaleContextValue | undefined>(undefined);

function syncApplicationMenuLocale(loc: SupportedLocale): void {
  if (typeof window === 'undefined') return;
  void window.electronAPI?.setApplicationMenuLocale?.(loc).catch(() => {
    /* Native app menu is macOS-only; renderer locale still updates normally. */
  });
}

function syncClassicalStyle(style: ClassicalReplyStyleId): void {
  if (typeof window === 'undefined') return;
  void window.electronAPI?.setClassicalReplyStyle?.(style).catch(() => {
    /* Older hosts ignore it; replies then keep the default classical style. */
  });
}

function applyLocale(loc: SupportedLocale): void {
  // i18next 自带 isInitialized 检查；同步资源 + 同步 init 下永远是 true。
  void i18n.changeLanguage(loc);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = loc;
  }
  syncApplicationMenuLocale(loc);
}

/**
 * Apply the persisted locale before the first React render.
 *
 * Lightweight windows render their error boundary outside the provider tree;
 * initializing i18next synchronously here keeps even an early render failure
 * in the user's selected language.
 */
export function bootstrapInitialLocale(): SupportedLocale {
  const effectiveLocale = getEffectiveLocale();
  applyLocale(effectiveLocale);
  return effectiveLocale;
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<LocalePreference>(readStoredLocale);
  const [effectiveLocale, setEffectiveLocale] = useState<SupportedLocale>(getEffectiveLocale);
  const [classicalStyle, setClassicalStyleState] = useState<ClassicalReplyStyleId>(readStoredClassicalStyle);

  const setClassicalStyle = useCallback((next: ClassicalReplyStyleId) => {
    setClassicalStyleState(next);
    writeStoredClassicalStyle(next);
  }, []);

  // Main builds each turn's reply note, so it keeps the current style too.
  useEffect(() => {
    syncClassicalStyle(classicalStyle);
  }, [classicalStyle]);

  const setLocale = useCallback((next: LocalePreference) => {
    setLocaleState(next);
    writeStoredLocale(next);
    const eff = effectiveOf(next);
    setEffectiveLocale(eff);
    applyLocale(eff);
  }, []);

  // 首次 mount 时确保 i18next + <html lang> 与 state 一致 (state 来自 localStorage,
  // 而 i18n.init 默认用的是 DEFAULT_LOCALE，两者可能不同)。
  // 仅 mount 一次：locale 后续变化都走 setLocale 路径。
  useEffect(() => {
    applyLocale(effectiveLocale);
  }, [effectiveLocale]);

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, effectiveLocale, setLocale, classicalStyle, setClassicalStyle }),
    [locale, effectiveLocale, setLocale, classicalStyle, setClassicalStyle],
  );

  return createElement(LocaleContext.Provider, { value }, children);
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (ctx === undefined) {
    throw new Error('useLocale must be used within a LocaleProvider');
  }
  return ctx;
}
