// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import '@/i18n';
import i18n from '@/i18n';
import { PluginSetupPrompt } from '../components/new-chat/PluginSetupPrompt';
import type { PendingPluginSetup } from '../lib/makerChatStore';

const api = vi.fn();
const command = vi.fn();
const pending: PendingPluginSetup = {
  requestId: 'card-test',
  revision: 1,
  remoteOauth: true,
  ghost: { id: 'test-plugin', name: 'Example plugin' },
  steps: [
    {
      id: 'account',
      groupId: 'account',
      groupMode: 'any_of',
      title: 'Connect account',
      description: '',
      phase: 'waiting_external',
      action: { id: 'connect', kind: 'oauth_connect' },
    },
  ],
};
const target = {
  deviceId: 'remote-test',
  ghostId: 'test-plugin',
  requestId: 'card-test',
  actionId: 'connect',
};
const props = {
  pending,
  remote: true,
  remoteDeviceId: target.deviceId,
  viewerState: 'expanded' as const,
  onViewerStateChange: vi.fn(),
  onCommand: command,
  commandInFlight: {
    requestId: pending.requestId,
    action: 'run_action' as const,
    actionId: 'connect',
  },
};
const settle = () =>
  act(async () => {
    await Promise.resolve();
  });
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  vi.clearAllMocks();
  await i18n.changeLanguage('en');
  window.electronAPI = {
    maker: { pluginOauthDeviceCode: api },
  } as unknown as typeof window.electronAPI;
  api.mockResolvedValue({ phase: 'browser', expiresAt: 61_000 });
});
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each([false, true])(
  'reopens the same authorization and allows cancellation while the bridge is pending (compact=%s)',
  async (compact) => {
    render(<PluginSetupPrompt {...props} compact={compact} />);
    await settle();
    expect(screen.getByRole('heading', { name: 'Waiting for browser authorization' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reopen Authorization Page' }));
    await settle();
    expect(api).toHaveBeenCalledWith({ ...target, operation: 'reopen' });
    expect(command).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(command).toHaveBeenCalledExactlyOnceWith('card-test', 'cancel');
  },
);

it('adds only the code content and keeps the same heading and footer for device authorization', async () => {
  api.mockResolvedValue({
    phase: 'ready',
    userCode: 'TEST-CODE',
    verificationHost: 'example.com',
    expiresAt: 61_000,
    copiedAt: 1000,
  });
  render(<PluginSetupPrompt {...props} />);
  await settle();
  expect(screen.getByRole('heading', { name: 'Waiting for browser authorization' })).toBeTruthy();
  expect(screen.getByText('TEST-CODE')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /copy/i }));
  await settle();
  expect(api).toHaveBeenCalledWith({ ...target, operation: 'copy' });
  expect(JSON.stringify(api.mock.calls)).not.toContain('TEST-CODE');
  expect(screen.getAllByRole('button', { name: 'Reopen Authorization Page' })).toHaveLength(1);
});

it('keeps ended, expired and cancelled distinct and never retries until the previous command finishes', async () => {
  api.mockResolvedValue({ phase: 'ended' });
  const r = render(<PluginSetupPrompt {...props} />);
  await settle();
  expect(screen.getByRole('heading', { name: 'Authorization ended' })).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Reconnect' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  r.rerender(<PluginSetupPrompt {...props} commandInFlight={null} />);
  expect((screen.getByRole('button', { name: 'Reconnect' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  r.rerender(
    <PluginSetupPrompt
      {...props}
      commandInFlight={null}
      pending={{ ...pending, steps: [{ ...pending.steps[0], phase: 'failed' }] }}
    />,
  );
  await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
  expect(command).toHaveBeenCalledWith('card-test', 'run_action', 'connect');
  api.mockResolvedValue({ phase: 'expired' });
  r.rerender(<PluginSetupPrompt {...props} />);
  await settle();
  expect(screen.getByRole('heading', { name: 'Authorization expired' })).toBeTruthy();
  r.rerender(
    <PluginSetupPrompt
      {...props}
      commandInFlight={null}
      pending={{ ...pending, steps: [{ ...pending.steps[0], phase: 'cancelled' }] }}
    />,
  );
  expect(screen.getByRole('heading', { name: 'Connection cancelled' })).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});

it('removes private code as soon as cancellation starts and ignores a late response', async () => {
  const ready = {
    phase: 'ready',
    userCode: 'TEST-CODE',
    verificationHost: 'example.com',
    expiresAt: 61_000,
    copiedAt: 1000,
  };
  api.mockResolvedValue(ready);
  const r = render(<PluginSetupPrompt {...props} />);
  await settle();
  let finish!: (value: unknown) => void;
  api.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: /copy/i }));
  r.rerender(
    <PluginSetupPrompt {...props} commandInFlight={{ requestId: 'card-test', action: 'cancel' }} />,
  );
  expect(screen.queryByText('TEST-CODE')).toBeNull();
  await act(async () => {
    finish(ready);
  });
  expect(screen.queryByText('TEST-CODE')).toBeNull();
});

it('distinguishes opening the browser from verifying an authorization result', async () => {
  api.mockResolvedValue(null);
  const r = render(
    <PluginSetupPrompt
      {...props}
      pending={{ ...pending, steps: [{ ...pending.steps[0], phase: 'pending' }] }}
    />,
  );
  await settle();
  expect(screen.getByRole('heading', { name: 'Opening authorization page' })).toBeTruthy();
  r.rerender(
    <PluginSetupPrompt
      {...props}
      pending={{ ...pending, steps: [{ ...pending.steps[0], phase: 'verifying' }] }}
    />,
  );
  expect(screen.getByRole('heading', { name: 'Confirming authorization' })).toBeTruthy();
});


it.each([false, true])('shows a persistent failure only for the current remote card (compact=%s)', async (compact) => {
  api.mockResolvedValue(null);
  const current = { ...pending, steps: [{ ...pending.steps[0], phase: 'pending' as const }] };
  const error = { requestId: pending.requestId, revision: pending.revision, code: 'REMOTE_UNSUPPORTED' as const };
  const r = render(<PluginSetupPrompt {...props} compact={compact} pending={current} commandInFlight={null} commandError={error} />);
  await settle();
  expect(screen.getByRole('alert').textContent).toContain('Update it and try again');
  fireEvent.click(screen.getByRole('button', { name: 'Connect account' }));
  expect(command).toHaveBeenCalledWith('card-test', 'run_action', 'connect');
  r.rerender(<PluginSetupPrompt {...props} compact={compact} pending={current} commandError={error} />);
  expect(screen.queryByRole('alert')).toBeNull();
  r.rerender(<PluginSetupPrompt {...props} pending={{ ...current, revision: 2 }} commandInFlight={null} commandError={error} />);
  expect(screen.queryByRole('alert')).toBeNull();
  r.rerender(<PluginSetupPrompt {...props} pending={{ ...current, requestId: 'another-card' }} commandInFlight={null} commandError={error} />);
  expect(screen.queryByRole('alert')).toBeNull();
  r.rerender(<PluginSetupPrompt {...props} pending={current} remote={false} commandInFlight={null} commandError={error} />);
  expect(screen.queryByRole('alert')).toBeNull();
});
