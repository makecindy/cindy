/**
 * useLocale —— 显示语言偏好 + 实际生效语言。
 *
 * 设计上和 useTheme 镜像：
 *   - 偏好保存在本机桌面资料目录，并同步旧版 localStorage。
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
import {
  classicalReplyStyleContextOf,
  defaultClassicalReplyStyleFor,
  type ClassicalReplyStyleContext,
  type ClassicalReplyStyleId,
} from '@cindy/maker-shared/classical-reply';
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
  /** 用户主动选择并保存偏好。 */
  setLocale: (next: LocalePreference) => boolean | Promise<boolean>;
  /** 主进程广播只更新当前窗口的显示。 */
  setDisplayLocale: (next: SupportedLocale) => void;
  /** AI 作答文风（文言、唐诗……）；现代中文界面下也可选，默认照常作答。 */
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
  // 目标语言包已加载时立即切换；否则先按需加载，加载完成才切换并触发重渲染。
  void i18n.changeLanguage(loc);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = loc;
  }
}

/**
 * Apply the persisted locale before the first React render.
 *
 * Lightweight windows render their error boundary outside the provider tree.
 * The renderer dispatcher (index.tsx) waits for `i18nReady` before loading any
 * window, so the selected language is already loaded here and applying it is
 * synchronous; even an early render failure stays in the user's language.
 */
export function bootstrapInitialLocale(): SupportedLocale {
  const effectiveLocale = getEffectiveLocale();
  applyLocale(effectiveLocale);
  return effectiveLocale;
}

export function LocaleProvider({ children, syncHostOnMount = false }: { children: ReactNode; syncHostOnMount?: boolean }) {
  const [locale, setLocaleState] = useState<LocalePreference>(readStoredLocale);
  const [effectiveLocale, setEffectiveLocale] = useState<SupportedLocale>(getEffectiveLocale);
  // 文言界面与简体 / 繁體中文界面的文风分开记忆:在文言界面选的唐诗不带进现代中文界面，
  // 每个语境各自从未选状态起步(默认见 defaultClassicalReplyStyleFor)。
  const [storedStyles, setStoredStyles] = useState<Record<ClassicalReplyStyleContext, ClassicalReplyStyleId | null>>(() => ({
    classical: readStoredClassicalStyle('classical'),
    modern: readStoredClassicalStyle('modern'),
  }));
  const styleContext = classicalReplyStyleContextOf(effectiveLocale);
  const classicalStyle = storedStyles[styleContext] ?? defaultClassicalReplyStyleFor(effectiveLocale);

  const setClassicalStyle = useCallback(
    (next: ClassicalReplyStyleId) => {
      setStoredStyles((prev) => ({ ...prev, [styleContext]: next }));
      writeStoredClassicalStyle(styleContext, next);
    },
    [styleContext],
  );

  // Main builds each turn's reply note, so it keeps the current style too.
  useEffect(() => {
    syncClassicalStyle(classicalStyle);
  }, [classicalStyle]);

  const setLocale = useCallback((next: LocalePreference) => {
    const apply = (saved: boolean) => {
      if (saved || !window.electronAPI?.saveDisplayLanguage) {
        setLocaleState(next);
        const effective = effectiveOf(next);
        setEffectiveLocale(effective);
        syncApplicationMenuLocale(effective);
      }
      return saved;
    };
    const saved = writeStoredLocale(next);
    return typeof saved === 'boolean' ? apply(saved) : saved.then(apply);
  }, []);

  useEffect(() => {
    applyLocale(effectiveLocale);
  }, [effectiveLocale]);

  // The primary window initializes the host. A prewarmed window only follows it.
  useEffect(() => {
    if (syncHostOnMount) syncApplicationMenuLocale(getEffectiveLocale());
  }, [syncHostOnMount]);

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, effectiveLocale, setLocale, setDisplayLocale: setEffectiveLocale, classicalStyle, setClassicalStyle }),
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
