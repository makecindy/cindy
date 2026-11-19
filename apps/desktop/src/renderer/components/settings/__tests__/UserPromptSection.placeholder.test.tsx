// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useUserPrompt', () => ({
  useUserPrompt: () => ({ value: '', setValue: vi.fn() }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn() },
}));

import appI18n from 'i18next';
import { UserPromptSection } from '../UserPromptSection';

describe('UserPromptSection placeholder', () => {
  it('uses the settings placeholder token with a visibly empty treatment', () => {
    render(<UserPromptSection />);

    const textarea = screen.getByRole('textbox', {
      name: 'settings.personalization.ariaLabel',
    });
    expect(textarea.className).toContain('placeholder:text-[var(--settings-input-placeholder)]');
    expect(textarea.className).toContain('placeholder:font-normal');
    // 占位档本身已是最淡的文字档(DESIGN.md §10 规则 6),再叠透明度会淡到看不见。
    expect(textarea.className).not.toMatch(/placeholder:opacity-/);
  });
});

it('updates the counter locale without changing the draft length', () => {
  const original = appI18n.language;
  try {
    appI18n.language = 'en';
    const view = render(<UserPromptSection />);
    const counter = () => view.container.querySelector('[aria-live="polite"]')!.textContent;
    const english = counter();
    appI18n.language = 'de';
    view.rerender(<UserPromptSection />);
    expect(counter()).not.toBe(english);
  } finally { appI18n.language = original; }
});
