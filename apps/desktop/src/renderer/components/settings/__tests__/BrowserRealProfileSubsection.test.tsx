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
  it('toggles on from off', () => {
    const onToggle = vi.fn();
    render(
      <BrowserRealProfileSubsection
        enabled={false}
        pending={false}
        onToggle={onToggle}
      />,
    );
    fireEvent.click(screen.getByRole('switch'));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('blocks the switch while a change is pending', () => {
    render(<BrowserRealProfileSubsection enabled pending onToggle={vi.fn()} />);
    expect(screen.getByRole('switch')).toHaveProperty('disabled', true);
  });
});
