// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 协议更新确认弹窗(LegalTermsUpdateGate)。依据:产品要求「已登录的老用户必须同意更新后的
 * 协议才能继续使用;新用户、本地模式不受影响」。是否需要确认由 main 判定
 * (legalTermsUpdateRequired,见 analyticsSettingsService.test.ts),这里验证 renderer 只在
 * 个人账号登录时弹出、同意后收起、不同意则退出登录。
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === 'legalTermsUpdate.body'
        ? 'Cindy 的<terms>服务条款</terms>和<privacy>隐私协议</privacy>已更新,请阅读并同意后继续使用。'
        : key,
  }),
}));
vi.mock('../../../../shared/brandRegion', () => ({
  CURRENT_CINDY_REGION: 'cn',
  CURRENT_APP_ID: 'com.xd.cindycn',
}));

const auth = vi.hoisted(() => ({
  mode: 'cloud' as 'signed-out' | 'local' | 'cloud',
  user: { membershipKind: 'personal' as 'personal' | 'org' } as { membershipKind: 'personal' | 'org' } | null,
  logout: vi.fn(async () => undefined),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));

import { isAppInteractionLocked } from '@/lib/appInteractionLock';

import { LegalTermsUpdateGate } from '../LegalTermsUpdateGate';
import { LEGAL_LINKS } from '../../../../shared/legalLinks';

function payload(legalTermsUpdateRequired: boolean) {
  return {
    privacyConsentAccepted: true,
    analyticsEnabled: true,
    analyticsEnabledCustomized: false,
    allowed: false,
    legalTermsUpdateRequired,
  };
}

let broadcast: ((value: ReturnType<typeof payload>) => void) | null = null;
const electronAPI = {
  getAnalyticsSettings: vi.fn(async () => payload(true)),
  onAnalyticsSettingsChange: vi.fn((callback: (value: ReturnType<typeof payload>) => void) => {
    broadcast = callback;
    return () => {
      broadcast = null;
    };
  }),
  acceptLegalTermsUpdate: vi.fn(async () => payload(false)),
  openExternal: vi.fn(async () => ({ success: true })),
};

beforeEach(() => {
  auth.mode = 'cloud';
  auth.user = { membershipKind: 'personal' };
  electronAPI.getAnalyticsSettings.mockResolvedValue(payload(true));
  Object.assign(window, { electronAPI });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LegalTermsUpdateGate', () => {
  it('blocks a signed-in user who agreed to the old terms until they agree', async () => {
    render(<LegalTermsUpdateGate />);
    const dialog = await screen.findByTestId('login-consent-dialog');
    expect(dialog.textContent).toContain('legalTermsUpdate.title');

    fireEvent.click(screen.getByText('legalTermsUpdate.agree'));
    await act(async () => {});

    expect(electronAPI.acceptLegalTermsUpdate).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('login-consent-dialog')).toBeNull();
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('logs out when the user does not agree', async () => {
    render(<LegalTermsUpdateGate />);
    await screen.findByTestId('login-consent-dialog');

    fireEvent.click(screen.getByText('legalTermsUpdate.disagree'));
    await act(async () => {});

    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(electronAPI.acceptLegalTermsUpdate).not.toHaveBeenCalled();
  });

  it('opens the updated terms in the browser', async () => {
    render(<LegalTermsUpdateGate />);
    await screen.findByTestId('login-consent-dialog');

    fireEvent.click(screen.getByText('服务条款'));
    expect(electronAPI.openExternal).toHaveBeenCalledWith(LEGAL_LINKS.termsOfService);
  });

  // 另一个窗口里点了同意:设置广播到达后本窗口也收起。
  it('closes when another window records the agreement', async () => {
    render(<LegalTermsUpdateGate />);
    await screen.findByTestId('login-consent-dialog');

    act(() => broadcast?.(payload(false)));
    expect(screen.queryByTestId('login-consent-dialog')).toBeNull();
  });

  // 弹窗只挡住鼠标与焦点不够:全局快捷键在 window 捕获阶段只看交互锁。
  it('holds the app interaction lock while open and releases it after agreeing', async () => {
    render(<LegalTermsUpdateGate />);
    await screen.findByTestId('login-consent-dialog');
    expect(isAppInteractionLocked()).toBe(true);

    fireEvent.click(screen.getByText('legalTermsUpdate.agree'));
    await act(async () => {});
    expect(isAppInteractionLocked()).toBe(false);
  });

  // 企业组织账号(SSO)被登录页协议门豁免;设备上的旧同意记录(如升级前跳过登录留下的)
  // 不能让它被拦住。
  it('never shows for an organization (enterprise SSO) account', async () => {
    auth.user = { membershipKind: 'org' };
    render(<LegalTermsUpdateGate />);
    await act(async () => {});

    expect(screen.queryByTestId('login-consent-dialog')).toBeNull();
    expect(isAppInteractionLocked()).toBe(false);
  });

  it('never shows in local mode (skip login)', async () => {
    auth.mode = 'local';
    render(<LegalTermsUpdateGate />);
    await act(async () => {});

    expect(screen.queryByTestId('login-consent-dialog')).toBeNull();
  });

  it('stays hidden for users already on the current terms', async () => {
    electronAPI.getAnalyticsSettings.mockResolvedValue(payload(false));
    render(<LegalTermsUpdateGate />);
    await act(async () => {});

    expect(screen.queryByTestId('login-consent-dialog')).toBeNull();
  });
});
