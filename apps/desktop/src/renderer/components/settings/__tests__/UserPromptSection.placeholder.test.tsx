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
});
