// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PluginOauthDeviceCode } from '../components/new-chat/PluginOauthDeviceCode';
import type { PluginOauthDeviceCodeView } from '../../shared/pluginOauthDeviceCode';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  toast: vi.fn(),
  t: (key: string, args?: Record<string, string>) => key + (args?.time ?? ''),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: mocks.toast } }));
const prefix = 'newChat.pluginSetup.deviceCode.';
const target = {
  deviceId: 'device-test',
  ghostId: 'cindy-github',
  requestId: 'card-test',
  actionId: 'connect',
};
const ready = (): PluginOauthDeviceCodeView => ({
  phase: 'ready',
  userCode: 'TEST-CODE',
  verificationHost: 'github.com',
  copiedAt: Date.now(),
  expiresAt: Date.now() + 30_000,
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  vi.clearAllMocks();
  mocks.api.mockResolvedValue(ready());
  window.electronAPI = {
    maker: { pluginOauthDeviceCode: mocks.api },
  } as unknown as typeof window.electronAPI;
});
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});
const settle = () =>
  act(async () => {
    await Promise.resolve();
  });

it('shows the ephemeral code, copy reminder and repeat actions without submitting material to any API', async () => {
  render(<PluginOauthDeviceCode target={target} active />);
  await settle();
  expect(screen.getByText('TEST-CODE')).toBeTruthy();
  expect(screen.getByText(prefix + 'copiedHint')).toBeTruthy();
  expect(mocks.toast).toHaveBeenCalledWith(prefix + 'copiedHint', { duration: 5000 });
  for (let i = 0; i < 2; i++) {
    fireEvent.click(screen.getByRole('button', { name: prefix + 'copyAgain' }));
    await settle();
  }
  fireEvent.click(screen.getByRole('button', { name: prefix + 'reopen' }));
  await settle();
  expect(mocks.api.mock.calls.map((c) => c[0])).toEqual([
    { ...target, operation: 'read' },
    { ...target, operation: 'copy' },
    { ...target, operation: 'copy' },
    { ...target, operation: 'reopen' },
  ]);
  expect(JSON.stringify(mocks.api.mock.calls)).not.toContain('TEST-CODE');
  expect(JSON.stringify(mocks.toast.mock.calls)).not.toContain('TEST-CODE');
  expect(localStorage.length).toBe(0);
});

it('clears at expiry even while the next read is stalled and does not leave copy/reopen enabled', async () => {
  render(<PluginOauthDeviceCode target={target} active />);
  await settle();
  mocks.api.mockImplementation(() => new Promise(() => {}));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_001);
  });
  expect(screen.queryByText('TEST-CODE')).toBeNull();
  expect(screen.getByText(prefix + 'expired')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});

it.each(['completed', 'expired', 'ended'] as const)(
  'clears the code after Main reports %s',
  async (phase) => {
    render(<PluginOauthDeviceCode target={target} active />);
    await settle();
    mocks.api.mockResolvedValue({ phase });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    expect(screen.queryByText('TEST-CODE')).toBeNull();
    expect(screen.getByText(prefix + phase)).toBeTruthy();
  },
);

it('removes the old code immediately on card replacement and ignores its late copy response', async () => {
  const view = render(<PluginOauthDeviceCode target={target} active />);
  await settle();
  let resolve!: (v: PluginOauthDeviceCodeView) => void;
  mocks.api.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: prefix + 'copyAgain' }));
  mocks.api.mockResolvedValue(null);
  view.rerender(<PluginOauthDeviceCode target={{ ...target, requestId: 'new-card' }} active />);
  expect(screen.queryByText('TEST-CODE')).toBeNull();
  await act(async () => {
    resolve(ready());
  });
  expect(screen.queryByText('TEST-CODE')).toBeNull();
});

it('hides the code immediately when cancelled, without persisting it for a later mount', async () => {
  const view = render(<PluginOauthDeviceCode target={target} active />);
  await settle();
  view.rerender(<PluginOauthDeviceCode target={target} active={false} />);
  expect(screen.queryByText('TEST-CODE')).toBeNull();
  expect(localStorage.length).toBe(0);
});

it('keeps the code visible after a clipboard error and allows another attempt', async () => {
  render(<PluginOauthDeviceCode target={target} active />);
  await settle();
  mocks.api.mockRejectedValueOnce(new Error('unavailable'));
  fireEvent.click(screen.getByRole('button', { name: prefix + 'copyAgain' }));
  await settle();
  expect(screen.getByRole('alert').textContent).toBe(prefix + 'actionFailed');
  expect(screen.getByText('TEST-CODE')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: prefix + 'copyAgain' }));
  await settle();
  expect(screen.queryByRole('alert')).toBeNull();
});
