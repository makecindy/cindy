// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LanguageSectionView } from '../LanguageSection';

vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const menu = () => {
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'settings.language.ariaLabel' }), {
    key: 'ArrowDown',
  });
  return screen
    .getAllByRole('option')
    .map((option) => option.textContent?.replace('settings.language.options.', ''));
};

it('offers only the languages its target can save', () => {
  render(
    <LanguageSectionView
      locale="ja"
      onChange={vi.fn()}
      locales={['system', 'zh-CN', 'zh-TW', 'en', 'ja', 'ko']}
    />,
  );
  expect(menu()).toEqual(['system', 'en', 'zh-CN', 'zh-TW', 'ja', 'ko']);
});

it('keeps every language and the classical entry without a limit', () => {
  render(<LanguageSectionView locale="system" onChange={vi.fn()} />);
  expect(menu()).toEqual([
    'system',
    'en',
    'zh-CN',
    'zh-TW',
    'ja',
    'ko',
    'es',
    'fr',
    'de',
    'pt-PT',
    'pt-BR',
    'classical',
  ]);
});
