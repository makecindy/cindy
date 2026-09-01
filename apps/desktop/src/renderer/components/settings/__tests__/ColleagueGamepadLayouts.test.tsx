// @vitest-environment jsdom

import type { ComponentType } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createXboxGamepadDefaultLayout } from '../../../../shared/xboxGamepad';
import { GenericGamepadLayout } from '../GenericGamepadLayout';
import { JoyConGamepadLayout } from '../JoyConGamepadLayout';
import { SwitchProGamepadLayout } from '../SwitchProGamepadLayout';
import type {
  XboxGamepadEditablePart,
  XboxGamepadKeyHint,
  XboxGamepadLayoutProps,
} from '../XboxGamepadLayout';

function hintFor(part: XboxGamepadEditablePart): XboxGamepadKeyHint {
  return { legend: part };
}

const labels = { leftStick: '左摇杆', rightStick: '右摇杆' };

const CONTROLS = ['a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'view', 'menu', 'xbox'] as const;

function renderLayout(Layout: ComponentType<XboxGamepadLayoutProps>, onEdit = vi.fn()) {
  render(
    <Layout
      layout={createXboxGamepadDefaultLayout()}
      hintFor={hintFor}
      onEdit={onEdit}
      preview={null}
      labels={labels}
    />,
  );
  return onEdit;
}

describe('colleague gamepad layouts', () => {
  it.each([
    ['Switch Pro', SwitchProGamepadLayout, 'switch-pro-gamepad-layout', CONTROLS],
    ['Joy-Con', JoyConGamepadLayout, 'joycon-gamepad-layout', CONTROLS],
    [
      'Ultimate C1',
      GenericGamepadLayout,
      'generic-gamepad-layout',
      CONTROLS.filter((part) => part !== 'xbox'),
    ],
  ] as const)('exposes every bindable control on %s', (_name, Layout, testId, parts) => {
    renderLayout(Layout);
    expect(screen.getByTestId(testId)).toBeTruthy();
    for (const part of parts) {
      expect(screen.getByRole('button', { name: part })).toBeTruthy();
    }
    if (Layout === GenericGamepadLayout) {
      expect(screen.queryByRole('button', { name: 'xbox' })).toBeNull();
    }
  });

  it('opens the matching Nintendo face binding when the physical B (bottom) is clicked', () => {
    const onEdit = renderLayout(SwitchProGamepadLayout);
    fireEvent.click(screen.getByRole('button', { name: 'a' }));
    expect(onEdit).toHaveBeenCalledWith('a');
  });

  it('opens the matching Xbox face binding on Ultimate C1', () => {
    const onEdit = renderLayout(GenericGamepadLayout);
    fireEvent.click(screen.getByRole('button', { name: 'a' }));
    expect(onEdit).toHaveBeenCalledWith('a');
  });
});
