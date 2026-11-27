// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果：LocalNetworkBanner 与 LocalNetworkPermission 组件；只在缺本地网络许可且确实拖慢自己设备时提醒，
 *   「开启」先触发原生弹窗（不抢焦点跳系统设置），仍未获准时才提供「打开系统设置」「在访达中显示当前 App」与「在新窗口打开」，
 *   关闭后只有新证据（新的只走中转的设备、再次开启被控）才重新出现。
 * - Bug／规则依据：2026-11-22 两台同局域网 Mac 都没有本地网络许可，连接长期只走中转；
 *   2026-11-26 macOS 27.3 实测系统设置深链落到隐私首页且不支持拖入，需明确分步引导与访达定位当前 App。
 * - 现有覆盖缺口：此前未覆盖两步授权状态（prompted → openedSettings → separateWindowRetry）与访达定位按钮。
 * - 最小失败输入：access=denied 且 reminder=relayOnly、带 appBundlePath；两步点击仍 denied；关闭后同一设备集合再次推送；
 *   新增一台设备；关闭 controlEnabled 后同批设备转为 relayOnly；窗口隐藏后停止轮询。
 * - tier：unit（jsdom，注入 electronAPI，无真实等待）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalNetworkRequestOptions, LocalNetworkState } from '../../../../shared/localNetwork';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}));
vi.mock('@/hooks/useUpdateStatus', () => ({ useUpdateStatus: () => ({ status: 'idle' }) }));
vi.mock('@/hooks/useUpdateBannerDismiss', () => ({
  useUpdateBannerDismiss: () => ({ dismissed: false }),
}));
const windowHidden = vi.hoisted(() => ({ value: false }));
vi.mock('@/lib/hiddenAnimationGate', () => ({ isWindowHidden: () => windowHidden.value }));

import { LocalNetworkBanner } from '../LocalNetworkBanner';
import { LocalNetworkPermission } from '../../settings/LocalNetworkPermission';

function installApi(
  initial: LocalNetworkState,
  onRequest?: (options?: LocalNetworkRequestOptions) => Promise<LocalNetworkState>,
) {
  let push: ((state: LocalNetworkState) => void) | null = null;
  const request = vi.fn(
    onRequest ?? (async (): Promise<LocalNetworkState> => ({ access: 'granted', reminder: null })),
  );
  const showItemInFolder = vi.fn(async () => ({ success: true }));
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'darwin',
      showItemInFolder,
      localNetwork: {
        status: vi.fn(async () => initial),
        request,
        onChanged: (callback: (state: LocalNetworkState) => void) => {
          push = callback;
          return () => {
            push = null;
          };
        },
      },
    },
  });
  return { request, showItemInFolder, push: (state: LocalNetworkState) => act(() => push?.(state)) };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  windowHidden.value = false;
  window.localStorage.clear();
});

describe('LocalNetworkBanner', () => {
  it('stays hidden when access is granted or there is nothing slowed down', async () => {
    const api = installApi({ access: 'granted', reminder: null });
    render(<LocalNetworkBanner isCollapsed={false} />);
    // The always-mounted sidebar must never probe by itself: a probe is what makes macOS prompt.
    await waitFor(() => expect(window.electronAPI.localNetwork.status).toHaveBeenCalledWith({ probe: false }));
    expect(screen.queryByRole('status')).toBeNull();
    api.push({ access: 'denied', reminder: null });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('asks for access, and after dismissal returns only for a new relay-only device', async () => {
    const api = installApi({ access: 'denied', reminder: { reason: 'relayOnly', deviceIds: ['studio'] } });
    render(<LocalNetworkBanner isCollapsed={false} />);
    expect(await screen.findByText('sidebar.localNetwork.relayOnly')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'sidebar.localNetwork.allow' }));
    await waitFor(() => expect(api.request).toHaveBeenCalledTimes(1));
    expect(api.request).toHaveBeenCalledWith();
    expect(screen.queryByRole('status')).toBeNull();

    api.push({ access: 'denied', reminder: { reason: 'relayOnly', deviceIds: ['studio'] } });
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.localNetwork.dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();
    api.push({ access: 'denied', reminder: { reason: 'relayOnly', deviceIds: ['studio'] } });
    expect(screen.queryByRole('status')).toBeNull();

    api.push({ access: 'denied', reminder: { reason: 'relayOnly', deviceIds: ['studio', 'phone'] } });
    expect(screen.getByText('sidebar.localNetwork.relayOnly')).toBeTruthy();
  });

  it('guides through prompt -> System Settings -> Finder reveal and separate-window retry when still denied', async () => {
    const appBundlePath = '/Users/me/Applications/Cindy Personal.app';
    const base: LocalNetworkState = {
      access: 'denied',
      reminder: { reason: 'relayOnly', deviceIds: ['studio'] },
      appBundlePath,
      settingsOpenStage: 'none',
    };
    const api = installApi(base, async (options) => ({
      ...base,
      settingsOpenStage: options?.separateWindow
        ? 'separate'
        : options?.openSettings
          ? 'standard'
          : 'none',
    }));

    render(<LocalNetworkBanner isCollapsed={false} />);
    expect(await screen.findByText('sidebar.localNetwork.relayOnly')).toBeTruthy();

    // Step 1: click Allow -> probes for OS prompt, shows promptedHint + Open System Settings button.
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.localNetwork.allow' }));
    expect(await screen.findByText('settings.devices.localNetwork.promptedHint')).toBeTruthy();
    expect(api.request).toHaveBeenNthCalledWith(1);

    // Step 2: click Open System Settings -> opens standard settings, reveals Finder button + separate-window retry.
    fireEvent.click(screen.getByRole('button', { name: 'remoteDesktop.openPermissionSettings' }));
    expect(await screen.findByText('settings.devices.localNetwork.settingsHint')).toBeTruthy();
    expect(api.request).toHaveBeenNthCalledWith(2, { openSettings: true });

    const revealBtn = screen.getByRole('button', { name: /remoteDesktop\.revealCurrentApp/ });
    fireEvent.click(revealBtn);
    await waitFor(() => expect(api.showItemInFolder).toHaveBeenCalledWith({ filePath: appBundlePath }));

    // Step 3: retry opens a fresh System Settings window.
    fireEvent.click(screen.getByRole('button', { name: 'remoteDesktop.openPermissionInNewWindow' }));
    await waitFor(() =>
      expect(api.request).toHaveBeenNthCalledWith(3, { openSettings: true, separateWindow: true }),
    );
  });

  it('shows the control reminder again for a later opt-in, but not when it merely turns into relay-only', async () => {
    const api = installApi({ access: 'denied', reminder: { reason: 'controlEnabled', at: 1, deviceIds: ['studio'] } });
    render(<LocalNetworkBanner isCollapsed={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'sidebar.localNetwork.dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();
    // Ten minutes later Main reports the same devices as relay-only (review r4655121858).
    api.push({ access: 'denied', reminder: { reason: 'relayOnly', deviceIds: ['studio'] } });
    expect(screen.queryByRole('status')).toBeNull();
    api.push({ access: 'denied', reminder: { reason: 'controlEnabled', at: 2, deviceIds: ['studio'] } });
    expect(screen.getByText('sidebar.localNetwork.controlEnabled')).toBeTruthy();
  });

  it('probes on focus only while the card is on screen', async () => {
    installApi({ access: 'denied', reminder: { reason: 'relayOnly', deviceIds: ['studio'] } });
    const status = window.electronAPI.localNetwork.status as ReturnType<typeof vi.fn>;
    render(<LocalNetworkBanner isCollapsed={false} />);
    await screen.findByText('sidebar.localNetwork.relayOnly');
    act(() => window.dispatchEvent(new Event('focus')));
    expect(status).toHaveBeenLastCalledWith({ probe: true });

    // Dismissed: the reminder is still in Main's state, but nothing is on screen (review r4655121845).
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.localNetwork.dismiss' }));
    act(() => window.dispatchEvent(new Event('focus')));
    expect(status).toHaveBeenLastCalledWith({ probe: false });
  });
});

describe('LocalNetworkPermission', () => {
  // Review r4655241779: with throttling off a minimized window keeps visibilityState 'visible'.
  it('stops probing while the window is hidden even if the document still reports visible', async () => {
    vi.useFakeTimers();
    installApi({ access: 'denied', reminder: null });
    const status = window.electronAPI.localNetwork.status as ReturnType<typeof vi.fn>;
    render(<LocalNetworkPermission />);
    await act(async () => {});
    const initial = status.mock.calls.length;
    await act(async () => vi.advanceTimersByTime(1500));
    expect(status.mock.calls.length).toBe(initial + 1);

    windowHidden.value = true;
    await act(async () => vi.advanceTimersByTime(4500));
    expect(status.mock.calls.length).toBe(initial + 1);
  });

  it('reveals the current app in Finder after opening System Settings', async () => {
    const appBundlePath = '/Applications/Cindy.app';
    const base: LocalNetworkState = {
      access: 'denied',
      reminder: null,
      appBundlePath,
      settingsOpenStage: 'none',
    };
    const api = installApi(base, async (options) => ({
      ...base,
      settingsOpenStage: options?.openSettings ? 'standard' : 'none',
    }));
    render(<LocalNetworkPermission />);
    expect(await screen.findByText('settings.devices.localNetwork.deniedHint')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /sidebar\.localNetwork\.allow/ }));
    expect(await screen.findByText('settings.devices.localNetwork.promptedHint')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /remoteDesktop\.openPermissionSettings/ }));
    expect(await screen.findByText('settings.devices.localNetwork.settingsHint')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /remoteDesktop\.revealCurrentApp/ }));
    await waitFor(() => expect(api.showItemInFolder).toHaveBeenCalledWith({ filePath: appBundlePath }));
  });
});
