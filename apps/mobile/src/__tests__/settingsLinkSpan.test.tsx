// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SettingsLinkSpan } from '../session/SettingsLinkSpan';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), push: vi.fn(), alert: vi.fn() }));
vi.mock('react-native', () => ({ Alert: { alert: mocks.alert } }));
vi.mock('@/components/AppText', () => ({ Text: ({ onPress, children }: { onPress: () => void; children: string }) => createElement('button', { onClick: onPress }, children) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: mocks.invoke, readDeviceList: async () => ({ devices: [{ deviceId: 'studio', name: 'Studio' }] }) }) }));
vi.mock('@/utils/useGuardedPush', () => ({ useGuardedPush: () => mocks.push }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function mount() { render(<SettingsLinkSpan target={{ tab: 'appearance', deviceId: 'studio' }} label="Open Studio settings" />); }
// Unit: a mobile link must preserve its source computer and not open a viewer on old-host failure.
it('opens the remote screen after that computer confirms settings navigation', async () => {
  mocks.invoke.mockResolvedValue({ ok: true, deviceId: 'studio' });
  mount();
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith({ pathname: '/devices/desktop/[deviceId]', params: { deviceId: 'studio', name: 'Studio' } }));
  expect(mocks.invoke).toHaveBeenCalledWith('studio', 'maker:settings:navigate', [{ tab: 'appearance', deviceId: 'studio' }]);
});
it('keeps the task visible and explains an unsupported or offline target', async () => {
  mocks.invoke.mockRejectedValue(new Error('CHANNEL_NOT_ALLOWED'));
  mount();
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() => expect(mocks.alert).toHaveBeenCalledWith('settings.navigation.unavailable'));
  expect(mocks.push).not.toHaveBeenCalled();
});
