// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createXboxGamepadDefaultLayout } from '../../../../shared/xboxGamepad';
import { PlayStationGamepadLayout } from '../PlayStationGamepadLayout';
import type { XboxGamepadEditablePart, XboxGamepadKeyHint } from '../XboxGamepadLayout';

function hintFor(part: XboxGamepadEditablePart): XboxGamepadKeyHint {
  return { legend: part };
}

describe('PlayStationGamepadLayout', () => {
  it('puts the d-pad above the left stick', () => {
    render(
      <PlayStationGamepadLayout
        layout={createXboxGamepadDefaultLayout()}
        hintFor={hintFor}
        onEdit={vi.fn()}
        preview={null}
        labels={{ leftStick: '左摇杆', rightStick: '右摇杆' }}
      />,
    );
    expect(screen.getByTestId('playstation-gamepad-layout')).toBeTruthy();
    expect(screen.getByTestId('playstation-gamepad-stick-left')).toBeTruthy();
    expect(screen.getByTestId('playstation-gamepad-dpad')).toBeTruthy();
    expect(screen.getByTestId('playstation-gamepad-face')).toBeTruthy();
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
    const onEdit = vi.fn();
    render(
      <PlayStationGamepadLayout
        layout={createXboxGamepadDefaultLayout()}
        hintFor={hintFor}
        onEdit={onEdit}
        preview={null}
        labels={{ leftStick: '左摇杆', rightStick: '右摇杆' }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'a' }));
    expect(onEdit).toHaveBeenCalledWith('a');
  });
});
