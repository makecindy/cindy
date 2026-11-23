// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：DeviceIdentityConflictRow(「我的设备」本机卡片)与 DeviceIdentityConflictNotice
 *   (主窗口提醒)；用户看到的按钮 / 提示，以及是否真的发出「换身份」请求。
 * - Bug／规则依据：2026-11-23 两台 Windows 共用 MachineGuid；用户要求只有出问题的电脑才提示，
 *   且换身份必须由用户确认后才发生。
 * - 现有覆盖缺口：remoteControlDevicesDeepLink.test.tsx 把 MyDevicesPanel 整个替身掉，不渲染本机卡片。
 * - 最小失败输入：没有冲突时出现按钮；或用户在确认框里取消后仍发出请求。
 * - tier：unit(jsdom，preload 与确认框为内存替身)。
 * - 单独成文件：仓内没有渲染这两个组件的测试文件，jsdom 也不能并进主进程那份 node 环境的判定测试。
 * - 实测耗时：约 2.8 秒(pnpm --dir apps/desktop exec vitest run 本文件)。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, vars?: { name?: string }) => (vars?.name ? `${key}:${vars.name}` : key) }),
}));
const { confirm, toast } = vi.hoisted(() => ({
  confirm: vi.fn(),
  toast: {
    warning: vi.fn<(message: string, options?: Record<string, unknown>) => string>(() => 'conflict-toast'),
    dismiss: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm }) }));
vi.mock('@/lib/toast', () => ({ toast }));

import { DeviceIdentityConflictNotice, DeviceIdentityConflictRow } from '../DeviceIdentityConflict';
import type { DeviceLinkIdentityConflict } from '../../../../shared/deviceLinkIpc';

const conflict: DeviceLinkIdentityConflict = { otherDeviceName: 'A-AAA-14', detectedAt: 1, replaceBlockedBy: null };
let push: ((payload: { conflict: DeviceLinkIdentityConflict | null }) => void) | null = null;
const replaceDeviceIdentity = vi.fn();

beforeEach(() => {
  push = null;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    deviceLink: {
      getState: vi.fn(async () => ({ identityConflict: null })),
      onIdentityConflict: (cb: typeof push) => { push = cb; return () => { push = null; }; },
      replaceDeviceIdentity,
    },
  };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('DeviceIdentityConflictRow', () => {
  it('shows nothing without a confirmed conflict and only a hint while a self-hosted relay blocks the change', () => {
    const { container, rerender } = render(<DeviceIdentityConflictRow conflict={null} />);
    expect(container.innerHTML).toBe('');
    rerender(<DeviceIdentityConflictRow conflict={{ ...conflict, replaceBlockedBy: 'self-hosted-relay' }} />);
    expect(screen.getByText('settings.devices.identityConflict.blockedSelfHostedRelay:A-AAA-14')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('changes the identity only after the user confirms', async () => {
    render(<DeviceIdentityConflictRow conflict={conflict} />);
    const button = screen.getByRole('button', { name: 'settings.devices.identityConflict.replace' });

    confirm.mockResolvedValueOnce(false);
    fireEvent.click(button);
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(replaceDeviceIdentity).not.toHaveBeenCalled();

    confirm.mockResolvedValueOnce(true);
    replaceDeviceIdentity.mockRejectedValueOnce(new Error('PRECONDITION_FAILED'));
    fireEvent.click(button);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('settings.devices.identityConflict.failed'));
    expect(replaceDeviceIdentity).toHaveBeenCalledTimes(1);
  });
});

describe('DeviceIdentityConflictNotice', () => {
  it('reminds once per conflict and withdraws the reminder when the conflict ends', async () => {
    render(<MemoryRouter><DeviceIdentityConflictNotice /></MemoryRouter>);
    await waitFor(() => expect(push).not.toBeNull());
    expect(toast.warning).not.toHaveBeenCalled();

    act(() => push!({ conflict }));
    act(() => push!({ conflict: { ...conflict } }));
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning.mock.calls[0]?.[1]).toMatchObject({ duration: 0, title: 'settings.devices.identityConflict.toastTitle:A-AAA-14' });

    act(() => push!({ conflict: null }));
    expect(toast.dismiss).toHaveBeenCalledWith('conflict-toast');
  });
});
