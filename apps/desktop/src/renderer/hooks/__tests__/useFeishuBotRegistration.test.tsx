// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFeishuBotRegistration } from '../useFeishuBotRegistration';

const { toDataURL } = vi.hoisted(() => ({
  toDataURL: vi.fn(async () => 'data:image/png;base64,feishu-qr'),
}));

vi.mock('qrcode', () => ({ toDataURL }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

type RegistrationListener = (payload: {
  status: 'pending' | 'success' | 'expired' | 'cancelled' | 'error';
  verdict?: 'connected' | 'conflict' | 'error' | 'pending';
  error?: string;
}) => void;

function installFeishuApi() {
  const listeners = new Set<RegistrationListener>();
  const api = {
    registrationBegin: vi.fn(),
    registrationCancel: vi.fn(async () => ({ ok: true as const })),
    onRegistrationStatus: vi.fn((listener: RegistrationListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  (window as unknown as { electronAPI: { feishuBot: typeof api } }).electronAPI = {
    feishuBot: api,
  };
  return { api, listeners };
}

describe('useFeishuBotRegistration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    toDataURL.mockResolvedValue('data:image/png;base64,feishu-qr');
  });

  it('generates a QR code for the selected service', async () => {
    const { api } = installFeishuApi();
    api.registrationBegin.mockResolvedValue({
      ok: true,
      userCode: 'ABCD-1234',
      verificationUrl: 'https://open.larksuite.com/page/cli?user_code=ABCD-1234',
      expiresIn: 300,
      interval: 5,
    });
    const { result } = renderHook(() => useFeishuBotRegistration('lark'));

    await act(async () => {
      await result.current.beginRegistration();
    });

    expect(api.registrationBegin).toHaveBeenCalledWith('lark');
    expect(toDataURL).toHaveBeenCalledWith(
      'https://open.larksuite.com/page/cli?user_code=ABCD-1234',
      expect.objectContaining({ margin: 1, width: 180 }),
    );
    expect(result.current.phase).toBe('qr');
    expect(result.current.userCode).toBe('ABCD-1234');
    expect(result.current.qrDataUrl).toBe('data:image/png;base64,feishu-qr');
  });

  it('moves to success when main reports the created bot connected', async () => {
    const { api, listeners } = installFeishuApi();
    api.registrationBegin.mockResolvedValue({
      ok: true,
      verificationUrl: 'https://open.feishu.cn/page/cli?user_code=ABCD',
      expiresIn: 300,
      interval: 5,
    });
    const { result } = renderHook(() => useFeishuBotRegistration('feishu'));

    await act(async () => {
      await result.current.beginRegistration();
    });
    act(() => {
      for (const listener of listeners) {
        listener({ status: 'success', verdict: 'connected' });
      }
    });

    await waitFor(() => expect(result.current.phase).toBe('success'));
  });

  it('cancels the main-side run when the service is switched', async () => {
    const { api } = installFeishuApi();
    api.registrationBegin.mockResolvedValue({
      ok: true,
      verificationUrl: 'https://open.feishu.cn/page/cli?user_code=ABCD',
      expiresIn: 300,
      interval: 5,
    });
    const { result, rerender } = renderHook(
      ({ service }: { service: 'feishu' | 'lark' }) => useFeishuBotRegistration(service),
      { initialProps: { service: 'feishu' as 'feishu' | 'lark' } },
    );
    await act(async () => {
      await result.current.beginRegistration();
    });
    expect(result.current.phase).toBe('qr');

    rerender({ service: 'lark' });

    // 只清本地状态的话, main 侧的轮询跑完仍会把原服务的凭证存下来。
    expect(api.registrationCancel).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('idle');
    expect(result.current.qrDataUrl).toBeNull();
  });

  it('drops the QR and the terminal status of a superseded run', async () => {
    const { api, listeners } = installFeishuApi();
    let resolveBegin: (value: unknown) => void = () => {};
    api.registrationBegin.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveBegin = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      ({ service }: { service: 'feishu' | 'lark' }) => useFeishuBotRegistration(service),
      { initialProps: { service: 'feishu' as 'feishu' | 'lark' } },
    );
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.beginRegistration();
    });

    rerender({ service: 'lark' });
    await act(async () => {
      resolveBegin({
        ok: true,
        verificationUrl: 'https://open.feishu.cn/page/cli?user_code=ABCD',
        expiresIn: 300,
        interval: 5,
      });
      await pending;
    });

    expect(result.current.phase).toBe('idle');
    expect(result.current.qrDataUrl).toBeNull();

    act(() => {
      for (const listener of listeners) listener({ status: 'success', verdict: 'connected' });
    });
    expect(result.current.phase).toBe('idle');
  });

  it('shows an error when registration cannot start', async () => {
    const { api } = installFeishuApi();
    api.registrationBegin.mockResolvedValue({ ok: false, error: 'network down' });
    const { result } = renderHook(() => useFeishuBotRegistration('feishu'));

    await act(async () => {
      await result.current.beginRegistration();
    });

    expect(result.current.phase).toBe('error');
    expect(result.current.errorMessage).toBe('network down');
  });
});
