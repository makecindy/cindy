// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => children,
}));

import { DefaultOverrideControls } from '../DefaultOverrideControls';

describe('DefaultOverrideControls', () => {
  it('keeps the customized status and restore action from shrinking or wrapping', () => {
    const onReset = vi.fn();
    render(<DefaultOverrideControls isCustomized onReset={onReset} />);

    const badge = screen.getByText('settings.defaults.customizedBadge');
    const controls = badge.parentElement;

    expect(controls?.className).toContain('shrink-0');
    expect(badge.className).toContain('whitespace-nowrap');

    fireEvent.click(screen.getByRole('button', { name: 'settings.defaults.restore' }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('does not render controls when the setting is not customized', () => {
    render(<DefaultOverrideControls isCustomized={false} onReset={vi.fn()} />);

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps a disabled reset button visible when requested', () => {
    render(<DefaultOverrideControls isCustomized={false} alwaysVisible onReset={vi.fn()} />);

    expect(
      (screen.getByRole('button', { name: 'settings.defaults.restore' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByText('settings.defaults.customizedBadge')).toBeNull();
  });
});
