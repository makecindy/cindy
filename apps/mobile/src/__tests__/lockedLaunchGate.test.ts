// @vitest-environment jsdom
// 测试价值
// - 生产入口与可观察结果：useLockedLaunchGate 决定登录与连接这棵树何时挂载。锁屏时被通知按钮从后台拉起的 App
//   读不出钥匙串，一旦照常启动，读不到的设备 ID 与登录会被当成新装机或未登录。
// - 规则依据：docs/product-rules/notification-actions.md「后台与凭证」。
// - 现有覆盖缺口：此前 App 只会被用户亲手打开，没有「后台 + 锁屏」启动。
// - 最小失败输入：启动时不在前台且钥匙串不可读。
// - tier：unit，替身替换系统状态与钥匙串。
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  appState: 'background',
  onAppState: null as null | ((next: string) => void),
  readable: false,
  onResponse: null as null | ((response: unknown) => void),
  handled: [] as Array<[unknown, unknown]>,
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: {
    get currentState() { return state.appState; },
    addEventListener: (_event: string, listener: (next: string) => void) => {
      state.onAppState = listener;
      return { remove() { state.onAppState = null; } };
    },
  },
}));
vi.mock('@/auth/deviceId', () => ({ isCredentialStoreReadable: async () => state.readable }));
vi.mock('@/notifications/nativeNotifications', () => ({ default: {
  addNotificationResponseReceivedListener: (listener: (response: unknown) => void) => {
    state.onResponse = listener;
    return { remove() { state.onResponse = null; } };
  },
  getLastNotificationResponseAsync: async () => null,
} }));
vi.mock('@/notifications/notificationActionRunner', () => ({
  handleNotificationActionResponse: (response: unknown, opts: unknown) => { state.handled.push([response, opts]); return true; },
}));

import { useLockedLaunchGate } from '@/notifications/lockedLaunchGate';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let unmount = () => {};
async function mount() {
  const seen: boolean[] = [];
  const root = createRoot(document.createElement('div'));
  unmount = () => act(() => root.unmount());
  await act(async () => { root.render(createElement(() => { seen.push(useLockedLaunchGate()); return null; })); });
  return seen;
}
afterEach(() => { unmount(); state.handled.length = 0; });

it('holds the tree on a locked phone, reports a pressed button as undelivered, and opens when the app comes to the front', async () => {
  state.appState = 'background';
  state.readable = false;
  const seen = await mount();
  expect(seen.at(-1)).toBe(false);

  const press = { actionIdentifier: 'approve' };
  state.onResponse?.(press);
  expect(state.handled).toEqual([[press, { canRun: false }]]);

  await act(async () => { state.onAppState?.('active'); });
  expect(seen.at(-1)).toBe(true);
  // From here the signed-in tree owns notification responses.
  expect(state.onResponse).toBeNull();
});

it('does not wait on an unlocked phone or when the app is already in front', async () => {
  state.appState = 'background';
  state.readable = true;
  expect((await mount()).at(-1)).toBe(true);
  unmount();

  state.appState = 'active';
  state.readable = false;
  expect(await mount()).toEqual([true]);
});
