// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudProviderAuthorization } from '../CloudProviderAuthorization';
import { createTrialCloudSettingsClient } from '../trialClient';
vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => true) }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(cleanup);
function setup() {
  Object.assign(window, {
    electronAPI: new Proxy(
      {},
      {
        get() {
          throw Error('LOCAL_API_FORBIDDEN');
        },
      },
    ),
  });
  const client = createTrialCloudSettingsClient();
  const manage = vi.spyOn(client, 'manage');
  const props = { client, online: true, active: true, name: 'Cloud trial', trial: true };
  const rendered = render(<CloudProviderAuthorization {...props} />);
  return { client, manage, props, ...rendered };
}
const authorize = async () => {
  fireEvent.click(
    await screen.findByRole('button', { name: 'settings.providers.button.authorize' }),
  );
};
describe('cloud-native authorization UI', () => {
  it('uses the native device-code card and verifies connected state after completion without local IPC', async () => {
    const f = setup();
    await authorize();
    expect(await screen.findByText('DEMO-2026')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /openVerificationPage/ }));
    fireEvent.click(screen.getByRole('button', { name: 'cloudSettings.authTrialComplete' }));
    expect(await screen.findByText('settings.providers.pill.connected')).toBeTruthy();
    expect(f.manage.mock.calls.filter(([c]) => c.operation === 'run')).toHaveLength(1);
    expect(f.manage.mock.calls.at(-1)?.[0].operation).toBe('list');
  });
  it('cancels and rereads the actual connection without claiming a disconnect', async () => {
    const f = setup();
    await authorize();
    await screen.findByText('DEMO-2026');
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.button.cancel' }));
    await waitFor(() => expect(screen.queryByText('DEMO-2026')).toBeNull());
    expect(screen.queryByText('settings.providers.pill.connected')).toBeNull();
    expect(
      await screen.findByRole('button', { name: 'settings.providers.button.authorize' }),
    ).toBeTruthy();
    expect(f.manage.mock.calls.some(([c]) => c.operation === 'cancel')).toBe(true);
  });
  it('removes temporary authorization material when the target goes offline', async () => {
    const f = setup();
    await authorize();
    await screen.findByText('DEMO-2026');
    f.rerender(<CloudProviderAuthorization {...f.props} online={false} />);
    expect(screen.queryByText('DEMO-2026')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'settings.providers.button.cancel' }).matches(':disabled'),
    ).toBe(true);
  });
  it('does not repeat a login on an unknown transport result', async () => {
    const f = setup();
    f.manage.mockRestore();
    const original = f.client.manage!.bind(f.client);
    const spy = vi.spyOn(f.client, 'manage').mockImplementation(async (command) => {
      const result = await original(command);
      if (command.operation === 'run') throw Error('LOST_REPLY');
      return result;
    });
    await authorize();
    // Read back on its own from the operation 2 s later (no 「检查授权状态」 button):
    // the device code it already started shows, and the login is not started again.
    expect(await screen.findByText('DEMO-2026', undefined, { timeout: 4_000 })).toBeTruthy();
    expect(spy.mock.calls.some(([c]) => c.operation === 'status')).toBe(true);
    expect(spy.mock.calls.filter(([c]) => c.operation === 'run')).toHaveLength(1);
  }, 10_000);
});
