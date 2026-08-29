// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
    'aria-label': ariaLabel,
  }: {
    checked: boolean;
    disabled: boolean;
    onCheckedChange: (next: boolean) => void;
    'aria-label': string;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));

import { BrowserRealProfileSubsection } from '../BrowserRealProfileSubsection';

afterEach(cleanup);

describe('BrowserRealProfileSubsection', () => {
  it('explains that the sidebar backend cannot use copied logins', () => {
    render(
      <BrowserRealProfileSubsection
        enabled={false}
        pending={false}
        available={false}
        onToggle={vi.fn()}
      />,
    );
    expect(
      screen.getByText('settings.computerUse.realProfile.unavailableEmbedded'),
    ).toBeTruthy();
    expect(screen.getByRole('switch')).toHaveProperty('disabled', true);
  });

  it('toggles on when the external backend is active', () => {
    const onToggle = vi.fn();
    render(
      <BrowserRealProfileSubsection
        enabled={false}
        pending={false}
        available
        onToggle={onToggle}
      />,
    );
    fireEvent.click(screen.getByRole('switch'));
    expect(onToggle).toHaveBeenCalledWith(true);
  });
});
