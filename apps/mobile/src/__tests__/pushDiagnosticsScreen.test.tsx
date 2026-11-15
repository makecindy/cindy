// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), copy: vi.fn(), state: { currentState: 'active', listener: null as null | ((state: string) => void) } }));
vi.mock('react-native', () => ({ AppState: { get currentState() { return mocks.state.currentState; }, addEventListener: (_: string, cb: (state: string) => void) => { mocks.state.listener = cb; return { remove: () => { mocks.state.listener = null; } }; } }, StyleSheet: { create: (s: unknown) => s }, View: ({ children }: any) => <div>{children}</div> }));
vi.mock('expo-router', () => ({ useFocusEffect: (cb: () => void) => React.useEffect(cb, [cb]) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: mocks.copy }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (s: string) => s }) }));
vi.mock('@/components/AppText', () => ({ Text: ({ children, testID }: any) => <span data-testid={testID}>{children}</span> }));
vi.mock('@/session/SettingsGroupRows', () => ({ SettingsGroup: ({ children, messages }: any) => <div>{children}{messages.filter(Boolean).map((m: any) => <span key={m.text}>{m.text}</span>)}</div>, ActionInfoRow: ({ label, onPress, disabled }: any) => <button disabled={disabled} onClick={onPress}>{label}</button>, InfoRow: ({ value }: any) => <span>{value}</span> }));
vi.mock('@/theme', () => ({ useThemedStyles: () => ({ tokenArea: {}, token: {} }) }));
vi.mock('@/notifications/pushDiagnostics', () => ({ readIosPushDiagnostic: mocks.read }));
import { PushDiagnosticsGroup } from '@/settings/PushDiagnosticsGroup';
const result = { token: 'a'.repeat(64), bundleId: 'com.example.app', build: '42', environment: 'development', permission: 'granted', alerts: true, lockScreen: true, notificationCenter: true };
beforeEach(() => { vi.resetAllMocks(); mocks.state.currentState = 'active'; mocks.read.mockResolvedValue(result); });
afterEach(cleanup);
const read = () => fireEvent.click(screen.getByText('settings.pushDiagnostics.read'));
it('reads only on explicit tap and copies only on a second explicit tap', async () => {
  render(<PushDiagnosticsGroup />); expect(mocks.read).not.toHaveBeenCalled();
  read(); await screen.findByTestId('settings.pushDiagnostics.token'); expect(mocks.copy).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('settings.pushDiagnostics.copy')); await waitFor(() => expect(mocks.copy).toHaveBeenCalledWith(result.token));
  fireEvent.click(screen.getByText('settings.pushDiagnostics.hide')); expect(screen.queryByTestId('settings.pushDiagnostics.token')).toBeNull();
});
it('clears token on background and never restores it on resume', async () => {
  render(<PushDiagnosticsGroup />); read(); await screen.findByTestId('settings.pushDiagnostics.token');
  act(() => { mocks.state.currentState = 'background'; mocks.state.listener?.('background'); });
  expect(screen.queryByTestId('settings.pushDiagnostics.token')).toBeNull();
  act(() => { mocks.state.currentState = 'active'; mocks.state.listener?.('active'); });
  expect(screen.queryByTestId('settings.pushDiagnostics.token')).toBeNull(); expect(mocks.read).toHaveBeenCalledTimes(1);
});
it('discards native results arriving after backgrounding', async () => {
  let resolve!: (v: typeof result) => void; mocks.read.mockImplementation(() => new Promise(r => { resolve = r; }));
  render(<PushDiagnosticsGroup />); read();
  act(() => { mocks.state.currentState = 'background'; mocks.state.listener?.('background'); });
  await act(async () => { resolve(result); });
  expect(screen.queryByTestId('settings.pushDiagnostics.token')).toBeNull();
});
it('invalidates outstanding reads on navigation and opens a fresh empty screen', async () => {
  let resolve!: (v: typeof result) => void; mocks.read.mockImplementation(() => new Promise(r => { resolve = r; }));
  const view = render(<PushDiagnosticsGroup />); read(); const isCurrent = mocks.read.mock.calls[0][0];
  view.unmount(); expect(isCurrent()).toBe(false);
  await act(async () => { resolve(result); }); render(<PushDiagnosticsGroup />);
  expect(screen.queryByTestId('settings.pushDiagnostics.token')).toBeNull();
});
