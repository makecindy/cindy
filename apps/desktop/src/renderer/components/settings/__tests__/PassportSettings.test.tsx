// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PassportState } from '../../../../shared/passport';
import { PassportEntry, PassportSettings } from '../PassportSettings';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe('Passport accessory settings', () => {
  let state: PassportState;
  let api: { getState: ReturnType<typeof vi.fn>; setEnabled: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    state = { supported: true, enabled: false, connected: false, voice: 'idle', devices: [], bluetooth: 5 };
    api = {
      getState: vi.fn(async () => ({ ...state })),
      setEnabled: vi.fn(async (enabled: boolean | null) => { state.enabled = enabled === true; }),
      connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
    };
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { passport: api } });
  });
  afterEach(() => { cleanup(); Reflect.deleteProperty(window, 'electronAPI'); });

  it('opens from a described accessory row with current connection status', async () => {
    state.enabled = true; state.connected = true;
    const open = vi.fn();
    render(<PassportEntry onOpen={open} />);
    await screen.findByText('settings.passport.connected');
    expect(screen.getByText('settings.passport.entryDescription')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'settings.passport.title' }));
    expect(open).toHaveBeenCalledOnce();
  });
  it('keeps enable, reset and back actions working in the new layout', async () => {
    const back = vi.fn();
    render(<PassportSettings onBack={back} />);
    const toggle = screen.getByRole('switch', { name: 'settings.passport.enabled' });
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    await act(async () => { fireEvent.click(toggle); });
    expect(api.setEnabled).toHaveBeenCalledWith(true);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'settings.passport.reset' })); });
    expect(api.setEnabled).toHaveBeenCalledWith(null);
    fireEvent.click(screen.getByRole('button', { name: 'settings.passport.back' }));
    expect(back).toHaveBeenCalledOnce();
  });
  it('connects the selected device and keeps disconnect available', async () => {
    state.enabled = true; state.devices = ['device-one', 'device-two'];
    render(<PassportSettings onBack={() => {}} />);
    const buttons = await screen.findAllByRole('button', { name: 'settings.passport.connect' });
    await act(async () => { fireEvent.click(buttons[1]); });
    expect(api.connect).toHaveBeenCalledWith('device-two');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'settings.passport.disconnect' })); });
    expect(api.disconnect).toHaveBeenCalledOnce();
  });
  it('disables settings on unsupported platforms', async () => {
    state.supported = false;
    render(<PassportSettings onBack={() => {}} />);
    await screen.findByText('settings.passport.unsupported');
    expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'settings.passport.reset' }).hasAttribute('disabled')).toBe(true);
  });
});
