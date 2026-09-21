// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  InputDeviceConnectionStatus,
  inputDeviceConnectionTone,
  resolveInputDeviceStatusKey,
} from '../InputDeviceConnectionStatus';

describe('InputDeviceConnectionStatus', () => {
  it('renders the same status-dot + label for every device', () => {
    const { container } = render(
      <InputDeviceConnectionStatus label="未检测到" tone="neutral" compact />,
    );

    expect(screen.getByText('未检测到')).toBeTruthy();
    expect(container.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });

  it('uses Off for every unused accessory, and Not detected only after it is enabled', () => {
    expect(
      resolveInputDeviceStatusKey({ enabled: false, present: false, connectionStatus: 'not-detected' }),
    ).toBe('disabled');
    expect(
      resolveInputDeviceStatusKey({ enabled: false, present: null, connectionStatus: 'connecting' }),
    ).toBe('disabled');
    expect(
      resolveInputDeviceStatusKey({ enabled: true, present: false, connectionStatus: 'not-detected' }),
    ).toBe('not-detected');
    expect(
      resolveInputDeviceStatusKey({ enabled: false, present: true, connectionStatus: 'connected' }),
    ).toBe('disabled');
    expect(
      resolveInputDeviceStatusKey({ enabled: true, present: true, connectionStatus: 'connected' }),
    ).toBe('connected');
    expect(inputDeviceConnectionTone({ status: 'disabled', present: true })).toBe('connected');
    expect(inputDeviceConnectionTone({ status: 'disabled', present: false })).toBe('neutral');
    expect(inputDeviceConnectionTone({ status: 'not-detected', present: false })).toBe('neutral');
    expect(
      resolveInputDeviceStatusKey({ enabled: true, present: false, connectionStatus: 'error' }),
    ).toBe('error');
    expect(
      resolveInputDeviceStatusKey({ enabled: true, present: false, connectionStatus: 'unavailable' }),
    ).toBe('unavailable');
  });
});
