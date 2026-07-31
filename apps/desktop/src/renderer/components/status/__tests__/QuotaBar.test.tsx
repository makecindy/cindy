// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { QuotaBar, quotaSeverity } from '../QuotaBar';

describe('QuotaBar', () => {
  it.each([
    { usedPercent: -5, expected: '0' },
    { usedPercent: 250, expected: '100' },
    { usedPercent: Number.NaN, expected: '0' },
  ])('clamps $usedPercent to aria-valuenow=$expected', ({ usedPercent, expected }) => {
    const { getByRole } = render(<QuotaBar usedPercent={usedPercent} />);

    expect(getByRole('progressbar').getAttribute('aria-valuenow')).toBe(expected);
  });

  it.each([
    { usedPercent: 70, expected: 'normal' },
    { usedPercent: 71, expected: 'warn' },
    { usedPercent: 89.9, expected: 'warn' },
    { usedPercent: 90, expected: 'crit' },
    { usedPercent: 100, expected: 'crit' },
  ])('renders $usedPercent as $expected severity', ({ usedPercent, expected }) => {
    const { getByRole } = render(<QuotaBar usedPercent={usedPercent} />);

    expect(getByRole('progressbar').getAttribute('data-severity')).toBe(expected);
  });

  it.each([
    { usedPercent: 70, expected: 'normal' },
    { usedPercent: 71, expected: 'warn' },
    { usedPercent: 89.9, expected: 'warn' },
    { usedPercent: 90, expected: 'crit' },
    { usedPercent: 100, expected: 'crit' },
  ] as const)('derives $usedPercent as $expected severity', ({ usedPercent, expected }) => {
    expect(quotaSeverity(usedPercent)).toBe(expected);
  });

  it('renders distinct regular and mini size classes', () => {
    const { getByRole, rerender } = render(<QuotaBar usedPercent={1} />);
    const regular = getByRole('progressbar');

    expect(regular.classList.contains('h-[7px]')).toBe(true);
    expect(regular.classList.contains('w-full')).toBe(true);
    expect(regular.firstElementChild?.classList.contains('min-w-[7px]')).toBe(true);

    rerender(<QuotaBar usedPercent={1} size="mini" />);
    const mini = getByRole('progressbar');

    expect(mini.classList.contains('h-[5px]')).toBe(true);
    expect(mini.classList.contains('w-[32px]')).toBe(true);
    expect(mini.classList.contains('inline-flex')).toBe(true);
    expect(mini.firstElementChild?.classList.contains('min-w-[4px]')).toBe(true);
  });

  it('exposes the progressbar role and rounded aria values', () => {
    const { getByRole } = render(<QuotaBar usedPercent={42.6} />);
    const progressbar = getByRole('progressbar');

    expect(progressbar.getAttribute('aria-valuemin')).toBe('0');
    expect(progressbar.getAttribute('aria-valuemax')).toBe('100');
    expect(progressbar.getAttribute('aria-valuenow')).toBe('43');
  });
});
