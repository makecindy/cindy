// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as QRCode from 'qrcode';

import { useFeishuBotRegistration } from '@/hooks/useFeishuBotRegistration';
import { FeishuBotSection } from '../FeishuBotSection';

const translate = (key: string) => key;
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));
vi.mock('qrcode', () => ({ toDataURL: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn() }),
}));
vi.mock('../ImDefaultSettingsSection', () => ({ ImDefaultSettingsSection: () => null }));
vi.mock('../FeishuBotNotificationSection', () => ({ FeishuBotNotificationSection: () => null }));
vi.mock('../ImChannelSettingsCard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ImChannelSettingsCard')>()),
  useImChannelSettingsSummary: () => [null, vi.fn()],
}));

type RegistrationStatus = Parameters<
  Parameters<Window['electronAPI']['feishuBot']['onRegistrationStatus']>[0]
>[0];

function installApi() {
  const listeners = new Set<(status: RegistrationStatus) => void>();
  const api = {
    getState: vi.fn(async (): ReturnType<Window['electronAPI']['feishuBot']['getState']> => ({
      service: 'feishu',
      status: 'idle',
      appId: null,
      appSecret: null,
      hasSecret: false,
      ownerOpenId: null,
      lifecycleAnnouncement: true,
    })),
    onStatusChange: vi.fn(() => () => {}),
    onRegistrationStatus: vi.fn((listener: (status: RegistrationStatus) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    registrationBegin: vi.fn(async () => ({
      ok: true,
      verificationUrl: 'https://open.feishu.cn/page/cli?user_code=TEST-ONLY',
      userCode: 'TEST-ONLY',
      expiresIn: 30,
      runId: 7,
    })),
    registrationCancel: vi.fn(async () => ({ ok: true })),
  };
  const openExternal = vi.fn();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { feishuBot: api, openExternal },
  });
  return {
    api,
    openExternal,
    emit(status: RegistrationStatus) {
      for (const listener of listeners) listener(status);
    },
  };
}

describe('Feishu bot authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(QRCode.toDataURL).mockResolvedValue('data:image/png;base64,test-only');
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('authorizes from Settings by QR or link and shows the saved binding on success', async () => {
    const { api, openExternal, emit } = installApi();
    await act(async () => {
      render(<FeishuBotSection expanded onToggle={() => {}} />);
    });
    expect(screen.queryByRole('textbox')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'settings.feishuBot.qr.begin' }));
    });
    expect(api.registrationBegin).toHaveBeenCalledWith('feishu');
    expect(screen.getByAltText('settings.feishuBot.qr.qrAlt').getAttribute('src')).toBe(
      'data:image/png;base64,test-only',
    );
    fireEvent.click(screen.getByRole('button', { name: 'settings.feishuBot.qr.openLink' }));
    expect(openExternal).toHaveBeenCalledWith(
      'https://open.feishu.cn/page/cli?user_code=TEST-ONLY',
    );
    api.getState.mockResolvedValueOnce({
      service: 'feishu',
      status: 'connected',
      appId: 'cli_test_authorized',
      appSecret: null,
      hasSecret: true,
      ownerOpenId: 'ou_test_owner',
      lifecycleAnnouncement: true,
    });
    await act(async () => {
      emit({
        status: 'success',
        runId: 7,
        appId: 'cli_test_authorized',
        ownerOpenId: 'ou_test_owner',
        verdict: 'connected',
      });
    });
    expect(screen.getByText('settings.feishuBot.connected.heading')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'settings.feishuBot.qr.openLink' })).toBeNull();
    expect(api.registrationCancel).not.toHaveBeenCalled();
  });

  it('starts the selected Lark service and discards authorization when the settings panel closes', async () => {
    const { api } = installApi();
    let view: ReturnType<typeof render>;
    await act(async () => {
      view = render(<FeishuBotSection expanded onToggle={() => {}} />);
    });
    fireEvent.click(screen.getByRole('radio', { name: 'settings.feishuBot.services.lark' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'settings.feishuBot.qr.begin' }));
    });
    expect(api.registrationBegin).toHaveBeenCalledWith('lark');
    view!.unmount();
    expect(api.registrationCancel).toHaveBeenCalledOnce();
  });

  it('ignores a previous begin response after cancellation and a new attempt', async () => {
    const { api } = installApi();
    let resolveFirst: (value: Awaited<ReturnType<typeof api.registrationBegin>>) => void = () => {};
    api.registrationBegin.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const hook = renderHook(() => useFeishuBotRegistration());
    let firstAttempt: Promise<void>;
    act(() => {
      firstAttempt = hook.result.current.beginRegistration();
    });
    await act(async () => {
      await hook.result.current.cancelRegistration();
    });
    await act(async () => {
      await hook.result.current.beginRegistration();
    });
    await act(async () => {
      resolveFirst({
        ok: true,
        verificationUrl: 'https://open.feishu.cn/old',
        userCode: 'OLD',
        expiresIn: 1,
        runId: 7,
      });
      await firstAttempt;
    });
    expect(hook.result.current.phase).toBe('qr');
    expect(hook.result.current.userCode).toBe('TEST-ONLY');
  });

  it('invalidates a pending QR render when the service changes', async () => {
    const { api, emit } = installApi();
    let resolveQr: (value: string) => void = () => {};
    vi.mocked(QRCode.toDataURL).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveQr = resolve;
        }),
    );
    const hook = renderHook(({ service }) => useFeishuBotRegistration(service), {
      initialProps: { service: 'feishu' as 'feishu' | 'lark' },
    });
    let pending: Promise<void>;
    await act(async () => {
      pending = hook.result.current.beginRegistration();
    });
    hook.rerender({ service: 'lark' });
    await act(async () => {
      resolveQr('data:image/png;base64,old');
      await pending;
      emit({ status: 'error', runId: 7, error: 'old authorization' });
    });
    expect(hook.result.current.phase).toBe('idle');
    expect(hook.result.current.qrDataUrl).toBeNull();
    expect(api.registrationCancel).toHaveBeenCalledOnce();
  });

  it('keeps a success received during QR generation from reopening the old QR', async () => {
    const { emit } = installApi();
    let resolveQr: (value: string) => void = () => {};
    vi.mocked(QRCode.toDataURL).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveQr = resolve;
        }),
    );
    const hook = renderHook(() => useFeishuBotRegistration());
    let pending: Promise<void>;
    await act(async () => {
      pending = hook.result.current.beginRegistration();
    });
    await act(async () => {
      emit({ status: 'success', runId: 7, verdict: 'connected' });
      resolveQr('data:image/png;base64,old');
      await pending;
    });
    expect(hook.result.current.phase).toBe('success');
    expect(hook.result.current.qrDataUrl).toBeNull();
  });

  it('hides the QR when the countdown ends without cancelling the in-flight poll', async () => {
    vi.useFakeTimers();
    const { api } = installApi();
    const hook = renderHook(() => useFeishuBotRegistration());
    await act(async () => {
      await hook.result.current.beginRegistration();
    });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(hook.result.current.phase).toBe('expired');
    // 倒计时只收起二维码：用户可能刚好在最后一刻完成授权，发一次
    // registrationCancel 会作废 main 侧那一轮，把已批准的凭证丢掉。
    expect(api.registrationCancel).not.toHaveBeenCalled();
  });

  it('accepts a late success after the countdown ended because the poll was not cancelled', async () => {
    vi.useFakeTimers();
    const { api, emit } = installApi();
    const hook = renderHook(() => useFeishuBotRegistration());
    await act(async () => {
      await hook.result.current.beginRegistration();
    });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(hook.result.current.phase).toBe('expired');
    act(() => {
      emit({ status: 'success', runId: 7, verdict: 'connected' });
    });
    expect(hook.result.current.phase).toBe('success');
    expect(api.registrationCancel).not.toHaveBeenCalled();
  });

  it('ignores a result from an earlier round so it cannot interrupt the current one', async () => {
    const { api, emit } = installApi();
    let resolveFirst: (value: Awaited<ReturnType<typeof api.registrationBegin>>) => void = () => {};
    api.registrationBegin.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const hook = renderHook(() => useFeishuBotRegistration());
    let firstAttempt: Promise<void>;
    act(() => {
      firstAttempt = hook.result.current.beginRegistration();
    });
    await act(async () => {
      await hook.result.current.cancelRegistration();
    });
    api.registrationBegin.mockResolvedValueOnce({
      ok: true,
      verificationUrl: 'https://open.feishu.cn/page/cli?user_code=NEW',
      userCode: 'NEW',
      expiresIn: 30,
      runId: 8,
    });
    await act(async () => {
      await hook.result.current.beginRegistration();
    });
    expect(hook.result.current.phase).toBe('qr');
    expect(hook.result.current.userCode).toBe('NEW');
    await act(async () => {
      // 第一轮的收尾结果: 轮次已过期，不能当成当前轮的结果。
      emit({ status: 'success', runId: 7, verdict: 'connected' });
      resolveFirst({
        ok: true,
        verificationUrl: 'https://open.feishu.cn/page/cli?user_code=OLD',
        userCode: 'OLD',
        expiresIn: 30,
        runId: 7,
      });
      await firstAttempt;
    });
    expect(hook.result.current.phase).toBe('qr');
    expect(hook.result.current.userCode).toBe('NEW');
  });

  it('shows authorization failures and offers a new authorization', async () => {
    const { emit } = installApi();
    await act(async () => {
      render(<FeishuBotSection expanded onToggle={() => {}} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'settings.feishuBot.qr.begin' }));
    });
    act(() => {
      emit({ status: 'error', runId: 7, error: 'Authorization denied' });
    });
    expect(screen.getByRole('alert').textContent).toBe('Authorization denied');
    expect(screen.getByRole('button', { name: 'settings.feishuBot.qr.retry' })).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
