// @vitest-environment jsdom

import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '../../../themes/colors';
import { builtinThemes } from '../../../themes/registry';
import { resolveThemeValue } from '../../../themes/theme-service';
import type { Theme } from '../../../themes/types';
import { SegmentedControl } from '../segmented-control';

afterEach(cleanup);

const options = [
  { value: 'sidebar', label: 'Sidebar' },
  { value: 'external', label: 'External' },
] as const;

function Example({
  initial = 'sidebar',
  disabled = false,
}: {
  initial?: string | null;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <SegmentedControl
      aria-label="Browser"
      value={value}
      options={options}
      onValueChange={setValue}
      disabled={disabled}
    />
  );
}

describe('Settings segmented control', () => {
  it('keeps one selection and one Tab entry while pointer and keyboard select options', () => {
    render(<Example />);
    const [sidebar, external] = screen.getAllByRole('radio');
    expect(sidebar.getAttribute('aria-checked')).toBe('true');
    expect(sidebar.tabIndex).toBe(0);
    expect(external.tabIndex).toBe(-1);
    fireEvent.click(external);
    expect(external.getAttribute('aria-checked')).toBe('true');
    expect(sidebar.getAttribute('aria-checked')).toBe('false');
    fireEvent.keyDown(external, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(sidebar);
    expect(sidebar.getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(sidebar, { key: 'End' });
    expect(document.activeElement).toBe(external);
    fireEvent.keyDown(external, { key: 'Home' });
    expect(document.activeElement).toBe(sidebar);
  });

  it('does not invent a matching preset but remains keyboard reachable', () => {
    render(<Example initial={null} />);
    const radios = screen.getAllByRole('radio');
    expect(radios.every((radio) => radio.getAttribute('aria-checked') === 'false')).toBe(true);
    expect(radios[0].tabIndex).toBe(0);
    fireEvent.keyDown(radios[0], { key: 'ArrowDown' });
    expect(radios[1].getAttribute('aria-checked')).toBe('true');
  });

  it('keeps disabled selection visible without invoking persistence', () => {
    const onValueChange = vi.fn();
    render(
      <SegmentedControl
        aria-label="Browser"
        value="sidebar"
        options={options}
        disabled
        onValueChange={onValueChange}
      />,
    );
    const radios = screen.getAllByRole('radio');
    expect(radios.every((radio) => (radio as HTMLButtonElement).disabled)).toBe(true);
    fireEvent.click(radios[1]);
    fireEvent.keyDown(radios[0], { key: 'ArrowRight' });
    expect(onValueChange).not.toHaveBeenCalled();
    expect(radios[0].getAttribute('aria-checked')).toBe('true');
  });
});

function resolveColor(theme: Theme, id: string): string {
  const value = resolveThemeValue(theme, id);
  if (!value) throw new Error(`Missing ${id}`);
  const alias = /^var\(--([\w-]+)\)$/.exec(value);
  return alias ? resolveColor(theme, alias[1]) : value;
}

// The approved alpha is scoped to the track; theme aliases still resolve for older themes.
describe.each([
  ['cindy-light', 'rgba(0, 0, 0, 0.06)', '#FDFDF8', '#F0F0EB'],
  ['cindy-dark', 'rgba(0, 0, 0, 0.25)', '#353535', '#3B3B3B'],
])('%s segmented palette', (themeId, track, fill, border) => {
  it('resolves the approved component-local colors', () => {
    const theme = builtinThemes[themeId];
    expect(resolveColor(theme, 'segmented-track')).toBe(track);
    expect(resolveColor(theme, 'segmented-selected-bg')).toBe(fill);
    expect(resolveColor(theme, 'segmented-selected-border')).toBe(border);
    expect(resolveColor(theme, 'segmented-selected-shadow')).toContain('0 3px 8px');
  });
});

describe('Segmented edge cases', () => {
  it('skips disabled options, preserves tab semantics and honors RTL', () => {
    const change = vi.fn();
    render(
      <SegmentedControl
        role="tablist"
        aria-label="Runtime"
        value="a"
        onValueChange={change}
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B', disabled: true },
          { value: 'c', label: 'C' },
        ]}
      />,
    );
    const tabs = screen.getAllByRole('tab');
    tabs[0].style.direction = 'rtl';
    fireEvent.keyDown(tabs[0], { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(tabs[2]);
    expect(change).toHaveBeenLastCalledWith('c');
    expect(tabs[0].getAttribute('aria-selected')).toBe('true'); // controlled: caller has not accepted yet
    fireEvent.click(tabs[1]);
    expect(change).toHaveBeenCalledTimes(1);
  });

  it('uses an enabled entry when the selected value is disabled or removed', () => {
    const change = vi.fn();
    const { rerender } = render(
      <SegmentedControl
        aria-label="Effort"
        value="a"
        onValueChange={change}
        options={[
          { value: 'a', label: 'A', disabled: true },
          { value: 'b', label: 'B' },
        ]}
      />,
    );
    expect(screen.getByRole('radio', { name: 'B' }).tabIndex).toBe(0);
    rerender(
      <SegmentedControl
        aria-label="Effort"
        value="a"
        onValueChange={change}
        options={[{ value: 'b', label: 'B' }]}
      />,
    );
    expect(screen.getByRole('radio').tabIndex).toBe(0);
    expect(screen.getByRole('radio').getAttribute('aria-checked')).toBe('false');
    expect(change).not.toHaveBeenCalled();
  });

  it('keeps composer mouse focus and supports explicit reselect callbacks', () => {
    const change = vi.fn();
    render(
      <>
        <input aria-label="Composer" />
        <SegmentedControl
          aria-label="Mode"
          value="a"
          preserveMouseFocus
          options={[{ value: 'a', label: 'A' }]}
          onValueChange={change}
        />
      </>,
    );
    const composer = screen.getByRole('textbox');
    composer.focus();
    expect(fireEvent.mouseDown(screen.getByRole('radio'))).toBe(false);
    fireEvent.click(screen.getByRole('radio'));
    expect(document.activeElement).toBe(composer);
    expect(change).toHaveBeenCalledWith('a');
  });
});
