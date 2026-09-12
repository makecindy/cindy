// @vitest-environment jsdom
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FailedScheduleNotice } from '@/session/FailedScheduleNotice';
const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => { storage.set(key, value); }),
} }));
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const view = (tag: string) => ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => createElement(tag, { onClick: onPress }, children);
  return { View: view('div'), Text: view('span'), Pressable: view('button'), StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 } };
});
vi.mock('@/components/AppText', async () => ({ Text: (await import('react-native')).Text }));
vi.mock('lucide-react-native', () => ({ CircleAlert: () => null, X: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/theme', async () => {
  const { lightColors } = await import('@/theme/tokens');
  return { useTheme: () => ({ colors: lightColors }), useThemedStyles: (make: (colors: typeof lightColors) => unknown) => make(lightColors) };
});
let root: Root;
let host: HTMLDivElement;
const run = { runId: 'run1', firedAt: 10 };
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  storage.clear(); host = document.createElement('div'); root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));
async function show(source = 'owner/host/task', value = run) {
  await act(async () => root.render(<FailedScheduleNotice key={source} source={source} run={value} />));
}
it('shows a rate-limit explanation and a working history action', async () => {
  const onViewHistory = vi.fn();
  await act(async () => root.render(<FailedScheduleNotice source="owner/device/task"
    run={{ ...run, failureKind: 'rate-limit', scheduleId: 'schedule' }} onViewHistory={onViewHistory} />));
  expect(host.textContent).toContain('session.failedScheduleNotice.rateLimited');
  await act(async () => host.querySelector('button')!.click());
  expect(onViewHistory).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('session.failedScheduleNotice.rateLimited');
});
it('keeps dismissal local and shows a newer failed run', async () => {
  await show(); expect(host.querySelector('button')).not.toBeNull();
  await act(async () => host.querySelector('button')!.click());
  expect(host.textContent).toBe('');
  await act(async () => root.render(null)); await show(); expect(host.textContent).toBe('');
  await show('owner/host/task', { runId: 'run2', firedAt: 11 }); expect(host.querySelector('button')).not.toBeNull();
});
it('does not share dismissal across accounts, devices or tasks', async () => {
  await show(); await act(async () => host.querySelector('button')!.click());
  for (const source of ['other/host/task', 'owner/other/task', 'owner/host/other']) {
    await show(source); expect(host.querySelector('button')).not.toBeNull();
  }
});

it('discards an old account preference read after switching source', async () => {
  let finish!: (value: string) => void;
  vi.mocked(AsyncStorage.getItem).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await show('old/host/task');
  expect(host.textContent).toBe('');
  await show('new/host/task');
  await act(async () => finish(JSON.stringify(run)));
  expect(host.querySelector('button')).not.toBeNull();
});
it('can close for the current view even if preference storage fails', async () => {
  vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('storage unavailable'));
  await show();
  await act(async () => host.querySelector('button')!.click());
  expect(host.textContent).toBe('');
});
