// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果：LocalNetworkBanner 组件；只在缺本地网络许可且确实拖慢自己设备时提醒，
 *   「开启」走 localNetwork.request，关闭后只有新证据（新的只走中转的设备、再次开启被控）才重新出现。
 * - Bug／规则依据：2026-11-22 两台同局域网 Mac 都没有本地网络许可，连接长期只走中转且没有任何提示。
 * - 现有覆盖缺口：新组件。
 * - 最小失败输入：access=denied 且 reminder=relayOnly；关闭后同一设备集合再次推送；新增一台设备；
 *   关闭 controlEnabled 后同批设备转为 relayOnly；关闭后窗口获得焦点。
 * - tier：unit（jsdom，注入 electronAPI，无真实等待）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalNetworkState } from '../../../../shared/localNetwork';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useUpdateStatus', () => ({ useUpdateStatus: () => ({ status: 'idle' }) }));
vi.mock('@/hooks/useUpdateBannerDismiss', () => ({
  useUpdateBannerDismiss: () => ({ dismissed: false }),
}));
const windowHidden = vi.hoisted(() => ({ value: false }));
vi.mock('@/lib/hiddenAnimationGate', () => ({ isWindowHidden: () => windowHidden.value }));

import { LocalNetworkBanner } from '../LocalNetworkBanner';
import { LocalNetworkPermission } from '../../settings/LocalNetworkPermission';

function installApi(initial: LocalNetworkState) {
  let push: ((state: LocalNetworkState) => void) | null = null;
  const request = vi.fn(async (): Promise<LocalNetworkState> => ({ access: 'granted', reminder: null }));
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'darwin',
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
  return { request, push: (state: LocalNetworkState) => act(() => push?.(state)) };
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
    expect(screen.queryByRole('status')).toBeNull();

    api.push({ access: 'denied', reminder: { reason: 'relayOnly', deviceIds: ['studio'] } });
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.localNetwork.dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();
    api.push({ access: 'denied', reminder: { reason: 'relayOnly', deviceIds: ['studio'] } });
    expect(screen.queryByRole('status')).toBeNull();

    api.push({ access: 'denied', reminder: { reason: 'relayOnly', deviceIds: ['studio', 'phone'] } });
    expect(screen.getByText('sidebar.localNetwork.relayOnly')).toBeTruthy();
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

describe('LocalNetworkPermission polling', () => {
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
});
