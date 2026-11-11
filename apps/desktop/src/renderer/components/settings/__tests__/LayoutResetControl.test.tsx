// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LayoutResetControl } from '../LayoutResetControl';

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: toastSuccess, error: toastError },
}));

describe('LayoutResetControl', () => {
  const reset = vi.fn<() => Promise<{ layout: unknown; persisted: boolean }>>();

  beforeEach(() => {
    vi.clearAllMocks();
    reset.mockResolvedValue({ layout: {}, persisted: true });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { layout: { reset } },
    });
  });

  it('从正式设置入口调用 main 布局重置并反馈成功', async () => {
    render(<LayoutResetControl />);

    fireEvent.click(screen.getByRole('button', { name: 'settings.appearance.layout.reset' }));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('settings.appearance.layout.resetSuccess'),
    );
    expect(reset).toHaveBeenCalledOnce();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('main 应用布局但写盘失败时给出错误反馈', async () => {
    reset.mockResolvedValueOnce({ layout: {}, persisted: false });
    render(<LayoutResetControl />);

    fireEvent.click(screen.getByRole('button', { name: 'settings.appearance.layout.reset' }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('settings.appearance.layout.resetFailed'),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('main IPC 拒绝时恢复按钮并给出错误反馈', async () => {
    reset.mockRejectedValueOnce(new Error('layout IPC unavailable'));
    render(<LayoutResetControl />);

    const button = screen.getByRole('button', { name: 'settings.appearance.layout.reset' });
    fireEvent.click(button);

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('settings.appearance.layout.resetFailed'),
    );
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});
