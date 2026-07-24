// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const setValue = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useUserPrompt', () => ({
  useUserPrompt: () => ({ value: '', setValue }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { UserPromptSection } from '../UserPromptSection';

describe('UserPromptSection placeholder', () => {
  it('uses the settings placeholder token with a visibly empty treatment', () => {
    render(<UserPromptSection />);

    const textarea = screen.getByRole('textbox', {
      name: 'settings.personalization.ariaLabel',
    });
    expect(textarea.className).toContain('placeholder:text-[var(--settings-input-placeholder)]');
    expect(textarea.className).toContain('placeholder:font-normal');
    expect(textarea.className).toContain('placeholder:opacity-45');
  });

  it('审核期间继续编辑时不让旧快照覆盖新草稿', async () => {
    let resolveReview!: (decision: 'allow') => void;
    const reviewUserPrompt = vi.fn(() => new Promise<'allow'>((resolve) => {
      resolveReview = resolve;
    }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { contentModeration: { reviewUserPrompt } },
    });
    setValue.mockClear();

    render(<UserPromptSection />);
    const textarea = screen.getByRole('textbox', {
      name: 'settings.personalization.ariaLabel',
    });
    fireEvent.change(textarea, { target: { value: 'first draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.personalization.save' }));
    expect(reviewUserPrompt).toHaveBeenCalledWith('first draft');

    fireEvent.change(textarea, { target: { value: 'newer draft' } });
    await act(async () => resolveReview('allow'));

    expect(setValue).not.toHaveBeenCalled();
    expect((textarea as HTMLTextAreaElement).value).toBe('newer draft');
  });
});
