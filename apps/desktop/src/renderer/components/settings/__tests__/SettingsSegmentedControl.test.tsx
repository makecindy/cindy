// @vitest-environment jsdom

import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '../../../themes/colors';
import { builtinThemes } from '../../../themes/registry';
import { resolveThemeValue } from '../../../themes/theme-service';
import type { Theme } from '../../../themes/types';
import { SettingsSegmentedControl } from '../SettingsSegmentedControl';

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
    <SettingsSegmentedControl
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
      <SettingsSegmentedControl
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
    expect(radios[1].className).toContain('enabled:hover:');
  });
});

function resolveColor(theme: Theme, id: string): string {
  const value = resolveThemeValue(theme, id);
  if (!value) throw new Error(`Missing ${id}`);
  const alias = /^var\(--([\w-]+)\)$/.exec(value);
  return alias ? resolveColor(theme, alias[1]) : value;
}

function consumedColor(element: HTMLElement, prefix: string, theme: Theme): string {
  const expression = [...element.classList].find((item) => item.startsWith(`${prefix}[var(--`));
  const id = expression?.match(/var\(--([\w-]+)\)/)?.[1];
  if (!id) throw new Error(`Missing ${prefix} binding`);
  return resolveColor(theme, id);
}

describe.each(['cindy-light', 'cindy-dark'])('%s card selection', (themeId) => {
  it('uses a raised selection and persistent border against the chip track', () => {
    render(<Example />);
    const theme = builtinThemes[themeId];
    const selected = screen.getByRole('radio', { checked: true });
    const fill = consumedColor(selected, 'bg-', theme);
    const card = resolveColor(theme, 'settings-theme-card-bg');
    expect(fill).toBe(resolveColor(theme, 'surface-elevated'));
    expect(consumedColor(screen.getByRole('radiogroup'), 'bg-', theme)).toBe(
      resolveColor(theme, 'surface-chip'),
    );
    expect(consumedColor(selected, 'border-', theme)).not.toBe(card);
    expect(fill).not.toBe(resolveColor(theme, 'chat-input-chip-bg'));
    expect(consumedColor(selected, 'border-', theme)).not.toBe(fill);
    expect(consumedColor(selected, 'text-', theme)).not.toBe(fill);
  });
});
