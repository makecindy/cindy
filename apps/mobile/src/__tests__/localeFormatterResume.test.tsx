// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { clearSessionListCollator, compareSessionListStrings } from '@cindy/maker-shared/session-list';

const native = vi.hoisted(() => ({ listener: null as null | ((state: string) => void), remove: vi.fn() }));
vi.mock('react-native', () => ({ AppState: { addEventListener: (_event: string, listener: typeof native.listener) => {
  native.listener = listener;
  return { remove: native.remove };
} } }));
vi.mock('@/i18n/appLanguage', () => ({ setManualLocaleOverride: vi.fn() }));
vi.mock('@/i18n/index', () => ({ detectSystemLocale: () => 'en', i18n: { changeLanguage: vi.fn() } }));
vi.mock('@/i18n/languagePreferenceStore', () => ({ readLanguagePreference: async () => 'system', saveLanguagePreference: vi.fn() }));
import { LocaleProvider } from '@/i18n/useLocale';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('reuses the system collator until foreground return, then picks up the new region', async () => {
  clearSessionListCollator();
  const OriginalCollator = Intl.Collator;
  let systemLocale = 'en';
  const constructor = vi.spyOn(Intl, 'Collator').mockImplementation(() => new OriginalCollator(systemLocale));
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<LocaleProvider><span /></LocaleProvider>));
    expect(compareSessionListStrings('ä', 'z')).toBeLessThan(0);
    for (let i = 0; i < 1000; i++) compareSessionListStrings('a', 'b');
    expect(constructor).toHaveBeenCalledTimes(1);
    act(() => native.listener?.('background'));
    systemLocale = 'sv';
    expect(compareSessionListStrings('ä', 'z')).toBeLessThan(0);
    act(() => native.listener?.('active'));
    expect(compareSessionListStrings('ä', 'z')).toBeGreaterThan(0);
    compareSessionListStrings('a', 'b');
    expect(constructor).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    constructor.mockRestore();
    clearSessionListCollator();
  }
  expect(native.remove).toHaveBeenCalledOnce();
});
