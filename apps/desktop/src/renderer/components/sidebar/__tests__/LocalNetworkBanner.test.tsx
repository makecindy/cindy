// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果：LocalNetworkBanner 组件；只在缺本地网络许可且确实拖慢自己设备时提醒，
 *   「开启」走 localNetwork.request，关闭后只有新证据（新的只走中转的设备、再次开启被控）才重新出现。
 * - Bug／规则依据：2026-11-22 两台同局域网 Mac 都没有本地网络许可，连接长期只走中转且没有任何提示。
 * - 现有覆盖缺口：新组件。
 * - 最小失败输入：access=denied 且 reminder=relayOnly；关闭后同一设备集合再次推送；新增一台设备。
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

import { LocalNetworkBanner } from '../LocalNetworkBanner';

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
  window.localStorage.clear();
});

describe('LocalNetworkBanner', () => {
  it('stays hidden when access is granted or there is nothing slowed down', async () => {
    const api = installApi({ access: 'granted', reminder: null });
    render(<LocalNetworkBanner isCollapsed={false} />);
    await waitFor(() => expect(window.electronAPI.localNetwork.status).toHaveBeenCalled());
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

  it('shows the control reminder again for a later opt-in even after an earlier dismissal', async () => {
    const api = installApi({ access: 'denied', reminder: { reason: 'controlEnabled', at: 1 } });
    render(<LocalNetworkBanner isCollapsed={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'sidebar.localNetwork.dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();
    api.push({ access: 'denied', reminder: { reason: 'controlEnabled', at: 2 } });
    expect(screen.getByText('sidebar.localNetwork.controlEnabled')).toBeTruthy();
  });
});
