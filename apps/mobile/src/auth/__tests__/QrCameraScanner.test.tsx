// @vitest-environment jsdom
/*
 * 测试价值(扫码页进入即开相机)
 * - 生产入口与可观察结果:真实 QrCameraScanner 在不同相机权限下渲染什么、何时请求权限。
 * - 规则依据:扫码登录只需「打开扫码页 → 对准电脑上的码」,不应要求先点「允许使用相机」
 *   (2026-11-27 产品确认);系统不再弹窗时引导去系统设置。
 * - 现有覆盖缺口:没有用例覆盖相机权限分支。
 * - 最小失败输入:权限未决定时不自动请求(要用户先点按钮);拒绝后反复自动弹窗;
 *   从系统设置授权回来仍停在授权提示。
 * - tier:unit(jsdom + mock expo-camera / react-native 边界)。
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

type Permission = { granted: boolean; canAskAgain: boolean };

const h = vi.hoisted(() => ({
  initial: { granted: false, canAskAgain: true } as Permission,
  afterRequest: { granted: true, canAskAgain: true } as Permission,
  afterGet: { granted: false, canAskAgain: false } as Permission,
  requests: 0,
  appState: new Set<(state: string) => void>(),
}));

vi.mock('expo-camera', async () => {
  const React = await import('react');
  return {
    CameraView: () => <div data-testid="qrScan.camera" />,
    useCameraPermissions: () => {
      const [permission, setPermission] = React.useState<Permission | null>(h.initial);
      return [
        permission,
        async () => {
          h.requests += 1;
          setPermission(h.afterRequest);
          return h.afterRequest;
        },
        async () => {
          setPermission(h.afterGet);
          return h.afterGet;
        },
      ];
    },
  };
});
vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) => <div data-testid={testID}>{children}</div>,
  StyleSheet: { create: (value: unknown) => value, absoluteFill: {}, hairlineWidth: 1 },
  Linking: { openSettings: vi.fn(async () => undefined) },
  AppState: {
    addEventListener: (_: string, listener: (state: string) => void) => {
      h.appState.add(listener);
      return { remove: () => h.appState.delete(listener) };
    },
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/theme', () => ({ useThemedStyles: () => ({}) }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock('@/components/MobilePrimitives', () => ({
  MainWindowActionButton: ({ action }: { action: { label: string; testID: string } }) =>
    <button data-testid={action.testID}>{action.label}</button>,
}));

import QrCameraScanner from '../QrCameraScanner';

async function mount() {
  await act(async () => {
    render(<QrCameraScanner paused={false} onScanned={() => {}} />);
  });
}

beforeEach(() => {
  h.requests = 0;
  h.appState.clear();
});
afterEach(cleanup);

it('asks for the camera on open and starts scanning without a tap', async () => {
  h.initial = { granted: false, canAskAgain: true };
  h.afterRequest = { granted: true, canAskAgain: true };
  await mount();
  expect(h.requests).toBe(1);
  expect(screen.getByTestId('qrScan.camera')).toBeTruthy();
  expect(screen.queryByTestId('qrScan.grantCamera')).toBeNull();
});

it('points to system settings when the system will not ask again, and starts after returning with access', async () => {
  h.initial = { granted: false, canAskAgain: false };
  h.afterGet = { granted: true, canAskAgain: false };
  await mount();
  expect(h.requests).toBe(0);
  expect(screen.getByTestId('qrScan.openSettings')).toBeTruthy();
  await act(async () => {
    for (const listener of h.appState) listener('active');
  });
  expect(screen.getByTestId('qrScan.camera')).toBeTruthy();
});

it('asks only once when the user declines but the system could ask again', async () => {
  h.initial = { granted: false, canAskAgain: true };
  h.afterRequest = { granted: false, canAskAgain: true };
  await mount();
  expect(h.requests).toBe(1);
  expect(screen.getByTestId('qrScan.grantCamera')).toBeTruthy();
  expect(screen.queryByTestId('qrScan.camera')).toBeNull();
});
