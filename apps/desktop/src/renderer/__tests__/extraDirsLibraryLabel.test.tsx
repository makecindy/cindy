// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AtMentionPanel } from '../components/new-chat/AtMentionPanel';
import en from '../i18n/locales/en/common.json';
import ja from '../i18n/locales/ja/common.json';
import ko from '../i18n/locales/ko/common.json';
import zhCN from '../i18n/locales/zh-CN/common.json';
import zhTW from '../i18n/locales/zh-TW/common.json';

const translations = [
  ['en', 'Mivo Library (Read-Only)'],
  ['zh-TW', 'Mivo 作品庫（唯讀）'],
  ['ja', 'Mivo ライブラリ（読み取り専用）'],
  ['ko', 'Mivo 라이브러리(읽기 전용)'],
  ['zh-CN', 'Mivo 作品库（只读）'],
] as const;
const resources = {
  en: { common: en },
  ja: { common: ja },
  ko: { common: ko },
  'zh-CN': { common: zhCN },
  'zh-TW': { common: zhTW },
};

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * #5929: real AtMentionPanel + locale resources, without mocking translation or Tip.
 * Existing quota/path tests cannot observe localized rows or mounted language changes;
 * the menu highlight tests replace useTranslation. Unit/jsdom is needed for this DOM
 * behavior; the minimum failure is one library slot rendered in English.
 */
describe('library reference directory labels', () => {
  it.each([false, true])('updates row and tooltip language with embedded=%s', async (embedded) => {
    const i18n = createInstance();
    await i18n.use(initReactI18next).init({
      lng: 'en',
      fallbackLng: 'en',
      defaultNS: 'common',
      resources,
      interpolation: { escapeValue: false },
    });
    const onRemove = vi.fn();
    // Logical fixture paths: exercise both the system-slot marker and Windows basename.
    const ordinaryDir = 'D:\\reference\\reports\\';
    render(
      <I18nextProvider i18n={i18n}>
        <AtMentionPanel
          embedded={embedded}
          query=""
          state={{ kind: 'ready', items: [], truncated: false }}
          entries={[]}
          focusedIndex={-1}
          onFocusedIndexChange={() => {}}
          onSelect={() => {}}
          onClose={() => {}}
          onRetry={() => {}}
          referenceDirs={{ dirs: ['cindy-library:/fixture/mivo', ordinaryDir], onRemove }}
        />
      </I18nextProvider>,
    );

    for (const [locale, expected] of [...translations, translations[0]]) {
      await act(async () => {
        await i18n.changeLanguage(locale);
      });
      const label = screen.getByText(expected, { selector: 'span' });
      // Inspect each locale itself, so English fallback cannot hide a missing resource.
      expect(i18n.getResource(locale, 'common', 'extraDirs.libraryReadOnlyLabel')).toBe(expected);
      const row = label.closest<HTMLElement>('[data-menu-row]')!;
      expect(within(row).queryByRole('button')).toBeNull();
      fireEvent.focus(label);
      expect((await screen.findByRole('tooltip')).textContent).toBe(expected);
      fireEvent.blur(label);
    }

    const ordinaryLabel = screen.getByText('reports', { selector: 'span' });
    fireEvent.focus(ordinaryLabel);
    expect((await screen.findByRole('tooltip')).textContent).toBe(ordinaryDir);
    fireEvent.blur(ordinaryLabel);
    fireEvent.click(
      within(ordinaryLabel.closest<HTMLElement>('[data-menu-row]')!).getByRole('button'),
    );
    expect(onRemove).toHaveBeenCalledWith(ordinaryDir);
  });
});
