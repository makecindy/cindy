// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Switch } from '../switch';

function renderSwitch(): { track: HTMLElement; thumb: HTMLElement } {
  render(<Switch aria-label="Background updates" />);
  const track = screen.getByRole('switch', { name: 'Background updates' });
  return { track, thumb: track.firstElementChild as HTMLElement };
}

describe('Switch', () => {
  afterEach(cleanup);

  it('uses dedicated semantic tokens for both track states and the thumb', () => {
    const { track, thumb } = renderSwitch();
    expect(track.className).toContain('data-[state=unchecked]:bg-[var(--switch-track-off)]');
    expect(thumb.className).toContain('data-[state=unchecked]:bg-[var(--switch-thumb-off)]');
    expect(track.className).toContain('data-[state=checked]:bg-[var(--switch-track-on)]');
  });

  it('keeps the thumb flat and clearly mutes the disabled state', () => {
    const { track, thumb } = renderSwitch();
    // §6 零阴影哲学:滑块不得带任何投影(2026-08-05 用户裁决,试过可见投影后显式否决)
    expect(thumb.className).not.toContain('shadow');
    // 禁用态两级弱化必须走皮肤可覆盖的 token,不得回退硬编码 opacity(定值见 colors.ts)
    expect(track.className).toContain('disabled:opacity-[var(--switch-disabled-opacity)]');
    expect(thumb.className).toContain('data-[disabled]:opacity-[var(--switch-disabled-thumb-opacity)]');
  });
});
