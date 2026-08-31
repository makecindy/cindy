// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  createXboxGamepadDefaultLayout,
  type XboxGamepadPreviewInput,
} from '../../../../shared/xboxGamepad';
import {
  XboxGamepadLayout,
  type XboxGamepadEditablePart,
  type XboxGamepadKeyHint,
} from '../XboxGamepadLayout';

const LABELS = { leftStick: '左摇杆', rightStick: '右摇杆' };

function hintFor(part: XboxGamepadEditablePart): XboxGamepadKeyHint {
  return { legend: part };
}

function renderPad(preview: XboxGamepadPreviewInput | null = null) {
  const onEdit = vi.fn();
  render(
    <XboxGamepadLayout
      layout={createXboxGamepadDefaultLayout()}
      hintFor={hintFor}
      onEdit={onEdit}
      preview={preview}
      labels={LABELS}
    />,
  );
  return onEdit;
}

describe('XboxGamepadLayout', () => {
  it('draws an Xbox Series pad: left stick above d-pad, ABXY above right stick', () => {
    renderPad();
    expect(screen.getByTestId('xbox-gamepad-layout')).toBeTruthy();
    expect(screen.getByTestId('xbox-gamepad-stick-left')).toBeTruthy();
    expect(screen.getByTestId('xbox-gamepad-stick-right')).toBeTruthy();
    expect(screen.getByTestId('xbox-gamepad-dpad')).toBeTruthy();
    expect(screen.getByTestId('xbox-gamepad-face')).toBeTruthy();
    for (const part of [
      'a',
      'b',
      'x',
      'y',
      'lb',
      'rb',
      'lt',
      'rt',
      'view',
      'menu',
      'xbox',
    ] as const) {
      expect(screen.getByRole('button', { name: part })).toBeTruthy();
    }
  });

  it('opens the matching control when a face button is clicked', () => {
    const onEdit = renderPad();
    fireEvent.click(screen.getByRole('button', { name: 'a' }));
    expect(onEdit).toHaveBeenCalledWith('a');
  });

  it('draws Nintendo face letters on the Switch variant', () => {
    render(
      <XboxGamepadLayout
        layout={createXboxGamepadDefaultLayout()}
        hintFor={hintFor}
        onEdit={vi.fn()}
        preview={null}
        labels={LABELS}
        variant="nintendo"
      />,
    );
    expect(screen.getByTestId('switch-gamepad-layout')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'a' })).toBeTruthy();
  });

  it('marks a pressed physical button', () => {
    const preview = {
      family: 'xbox' as const,
      buttons: { a: true },
      sticks: { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } },
      triggers: { lt: 0, rt: 0 },
    } as XboxGamepadPreviewInput;
    renderPad(preview);
    expect(screen.getByRole('button', { name: 'a' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'b' }).getAttribute('aria-pressed')).toBe('false');
  });
});
