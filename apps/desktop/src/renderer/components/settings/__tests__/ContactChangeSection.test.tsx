// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果:设置页 ContactChangeSection;用户看到入口、分步弹窗与错误提示,
 *   main 收到的验证码与新联系方式。
 * - 规则依据:换绑必须先验当前联系方式再验新联系方式;票据失效要回到第一步。
 * - 现有覆盖缺口:新组件,无相邻测试。
 * - 最小失败输入:确认时 main 返回 CONTACT_CHANGE_TICKET_INVALID。
 * - tier:unit(jsdom,IPC 以内存 stub 代替)。
 * - 实测耗时:单独运行约 2 秒。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  value: { user: { id: 'membership-id' } as { id: string } | null, mode: 'cloud' },
}));
const toastSuccess = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.target ? `${key}:${String(options.target)}` : key,
  }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => auth.value,
}));

vi.mock('@/lib/toast', () => ({ toast: { success: toastSuccess, error: vi.fn() } }));

vi.mock('@/components/ui/confirm-dialog', () => ({
  ConfirmDialog: (props: {
    open: boolean;
    title: string;
    description?: string;
    content?: React.ReactNode;
    confirmText: string;
    confirmDisabled?: boolean;
    loading?: boolean;
    onConfirm?: () => void;
  }) =>
    props.open ? (
      <div role="dialog" aria-label={props.title}>
        <p>{props.description}</p>
        {props.content}
        <button
          type="button"
          disabled={props.loading || props.confirmDisabled}
          onClick={props.onConfirm}
        >
          {props.confirmText}
        </button>
      </div>
    ) : null,
}));

import { ContactChangeSection } from '../ContactChangeSection';

const api = {
  authGetContactChangeAvailability: vi.fn(),
  authRequestContactChangeCurrentCode: vi.fn(),
  authVerifyContactChangeCurrentCode: vi.fn(),
  authRequestContactChangeNewCode: vi.fn(),
  authConfirmContactChange: vi.fn(),
  authCancelContactChange: vi.fn(),
};

async function enterCode(code: string) {
  fireEvent.change(await screen.findByLabelText('settings.contactChange.codeLabel'), {
    target: { value: code },
  });
}

describe('ContactChangeSection', () => {
  beforeEach(() => {
    auth.value = { user: { id: 'membership-id' }, mode: 'cloud' };
    api.authGetContactChangeAvailability.mockResolvedValue({ available: true, type: 'phone' });
    api.authRequestContactChangeCurrentCode.mockResolvedValue({
      success: true,
      value: { channel: 'sms', maskedTarget: '+8613****55' },
    });
    api.authVerifyContactChangeCurrentCode.mockResolvedValue({ success: true, value: { type: 'phone' } });
    api.authRequestContactChangeNewCode.mockResolvedValue({ success: true, value: null });
    api.authConfirmContactChange.mockResolvedValue({
      success: true,
      value: { type: 'phone', maskedValue: '+8613****66' },
    });
    api.authCancelContactChange.mockResolvedValue(undefined);
    Object.assign(window, { electronAPI: api });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders nothing when the account cannot change its sign-in contact', async () => {
    api.authGetContactChangeAvailability.mockResolvedValue({ available: false, type: null });
    const { container } = render(<ContactChangeSection />);
    await waitFor(() => expect(api.authGetContactChangeAvailability).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('verifies the current phone before sending a code to the new one', async () => {
    render(<ContactChangeSection />);
    fireEvent.click(await screen.findByText('settings.contactChange.phone.change'));

    fireEvent.click(screen.getByText('settings.contactChange.sendCode'));
    expect(await screen.findByText('settings.contactChange.codeSent:+8613****55')).toBeTruthy();
    await enterCode('123456');
    fireEvent.click(screen.getByText('settings.contactChange.next'));

    fireEvent.change(await screen.findByLabelText('settings.contactChange.phone.inputLabel'), {
      target: { value: '13700006666' },
    });
    fireEvent.click(screen.getByText('settings.contactChange.sendCode'));
    expect(await screen.findByText('settings.contactChange.codeSent:13700006666')).toBeTruthy();
    await enterCode('654321');
    fireEvent.click(await screen.findByText('settings.contactChange.confirm'));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('settings.contactChange.phone.success:+8613****66'),
    );
    expect(api.authVerifyContactChangeCurrentCode).toHaveBeenCalledWith('123456');
    expect(api.authRequestContactChangeNewCode).toHaveBeenCalledWith('13700006666');
    expect(api.authConfirmContactChange).toHaveBeenCalledWith({ value: '13700006666', code: '654321' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('returns to the first step when the change ticket has expired', async () => {
    api.authRequestContactChangeNewCode.mockResolvedValue({
      success: false,
      code: 'CONTACT_CHANGE_TICKET_INVALID',
    });
    render(<ContactChangeSection />);
    fireEvent.click(await screen.findByText('settings.contactChange.phone.change'));
    fireEvent.click(screen.getByText('settings.contactChange.sendCode'));
    await enterCode('123456');
    fireEvent.click(await screen.findByText('settings.contactChange.next'));
    fireEvent.change(await screen.findByLabelText('settings.contactChange.phone.inputLabel'), {
      target: { value: '13700006666' },
    });
    fireEvent.click(screen.getByText('settings.contactChange.sendCode'));

    expect(
      await screen.findByText('settings.contactChange.errors.CONTACT_CHANGE_TICKET_INVALID'),
    ).toBeTruthy();
    expect(screen.getByText('settings.contactChange.phone.introDescription')).toBeTruthy();
    expect(screen.queryByLabelText('settings.contactChange.phone.inputLabel')).toBeNull();
  });

  it('lets the user pick another number when the new one is already taken', async () => {
    api.authConfirmContactChange
      .mockResolvedValueOnce({ success: false, code: 'CONTACT_TAKEN' })
      .mockResolvedValueOnce({ success: true, value: { type: 'phone', maskedValue: '+8613****77' } });
    render(<ContactChangeSection />);
    fireEvent.click(await screen.findByText('settings.contactChange.phone.change'));
    fireEvent.click(screen.getByText('settings.contactChange.sendCode'));
    await enterCode('123456');
    fireEvent.click(await screen.findByText('settings.contactChange.next'));
    fireEvent.change(await screen.findByLabelText('settings.contactChange.phone.inputLabel'), {
      target: { value: '13700006666' },
    });
    fireEvent.click(screen.getByText('settings.contactChange.sendCode'));
    await enterCode('654321');
    fireEvent.click(await screen.findByText('settings.contactChange.confirm'));

    // 已被占用：回到输入新手机号，保留刚才的输入并提示原因，不必重新验证当前手机号。
    expect(await screen.findByText('settings.contactChange.errors.CONTACT_TAKEN')).toBeTruthy();
    const input = screen.getByLabelText('settings.contactChange.phone.inputLabel') as HTMLInputElement;
    expect(input.value).toBe('13700006666');

    fireEvent.change(input, { target: { value: '13700007777' } });
    fireEvent.click(screen.getByText('settings.contactChange.sendCode'));
    await enterCode('112233');
    fireEvent.click(await screen.findByText('settings.contactChange.confirm'));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('settings.contactChange.phone.success:+8613****77'),
    );
    expect(api.authVerifyContactChangeCurrentCode).toHaveBeenCalledTimes(1);
    expect(api.authRequestContactChangeNewCode).toHaveBeenLastCalledWith('13700007777');
    expect(api.authConfirmContactChange).toHaveBeenLastCalledWith({ value: '13700007777', code: '112233' });
  });
});
