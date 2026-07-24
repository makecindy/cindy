/**
 * LocaleProvider / useLocale —— 显示语言偏好 + 实际生效语言(镜像 desktop hooks/useLocale)。
 *
 * 与 desktop 的差异:
 * - 持久化走 AsyncStorage(languagePreferenceStore),读出是异步的:Provider 先以
 *   系统语言渲染首帧(与 i18n init 值一致),挂载后读出 override 再切换。启动期
 *   有 StartupSplashOverlay 顶着,切换不产生可见闪变。
 * - 除 i18next 外还要同步 appLanguage 的手动 override 桥,让手写 catalog
 *   (loginMessages 等)与 i18next 消费方看到同一个生效语言。
 *
 * 不做系统语言运行时监听:用户改系统语言后冷启动生效,与现有 catalog 行为一致。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { setManualLocaleOverride } from './appLanguage';
import { i18n, detectSystemLocale, type LocalePreference, type SupportedLocale } from './index';
import {
  readLanguagePreference,
  saveLanguagePreference,
} from './languagePreferenceStore';

interface LocaleContextValue {
  /** 用户的偏好选择(含 'system')。 */
  locale: LocalePreference;
  /** 实际生效的语言('system' 已解析为系统语言)。 */
  effectiveLocale: SupportedLocale;
  /** 设置偏好 —— 持久化 override、刷 i18next、同步手写 catalog 桥。 */
  setLocale: (next: LocalePreference) => void;
}

const LocaleContext = createContext<LocaleContextValue | undefined>(undefined);

function effectiveOf(pref: LocalePreference): SupportedLocale {
  return pref === 'system' ? detectSystemLocale() : pref;
}

function applyLocale(pref: LocalePreference): SupportedLocale {
  const effective = effectiveOf(pref);
  // i18next 同步资源 + 同步 init,changeLanguage 立即生效。
  void i18n.changeLanguage(effective);
  setManualLocaleOverride(pref === 'system' ? null : pref);
  return effective;
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<LocalePreference>('system');
  const [effectiveLocale, setEffectiveLocale] = useState<SupportedLocale>(detectSystemLocale);
  // 用户已手动选择过语言时置位:挂载期的异步读回不得覆盖更晚的手动选择。
  const userChoseRef = useRef(false);

  // 挂载后恢复持久化的 override;读出前按系统语言渲染(与 i18n init 值一致,
  // 未设置 override 的用户全程无切换)。
  useEffect(() => {
    let cancelled = false;
    void readLanguagePreference().then((pref) => {
      if (cancelled || userChoseRef.current || pref === 'system') return;
      setLocaleState(pref);
      setEffectiveLocale(applyLocale(pref));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setLocale = useCallback((next: LocalePreference) => {
    userChoseRef.current = true;
    setLocaleState(next);
    // 持久化失败不影响当前会话切换('system' = 删除 override)。
    void saveLanguagePreference(next);
    setEffectiveLocale(applyLocale(next));
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, effectiveLocale, setLocale }),
    [locale, effectiveLocale, setLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (ctx === undefined) {
    throw new Error('useLocale must be used within a LocaleProvider');
  }
  return ctx;
}
