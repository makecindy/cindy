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

import { useLegalTermsGateBlocking } from '../legalTermsGateState';
import { LegalTermsUpdateGate } from '../LegalTermsUpdateGate';

function GateBlockingProbe() {
  return <span data-testid="gate-blocking">{String(useLegalTermsGateBlocking())}</span>;
}
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
    const dialog = await screen.findByTestId('legal-terms-update-dialog');
    expect(dialog.textContent).toContain('legalTermsUpdate.title');

    fireEvent.click(screen.getByText('legalTermsUpdate.agree'));
    await act(async () => {});

    expect(electronAPI.acceptLegalTermsUpdate).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('legal-terms-update-dialog')).toBeNull();
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('logs out when the user does not agree', async () => {
    render(<LegalTermsUpdateGate />);
    await screen.findByTestId('legal-terms-update-dialog');

    fireEvent.click(screen.getByText('legalTermsUpdate.disagree'));
    await act(async () => {});

    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(electronAPI.acceptLegalTermsUpdate).not.toHaveBeenCalled();
  });

  it('opens the updated terms in the browser', async () => {
    render(<LegalTermsUpdateGate />);
    await screen.findByTestId('legal-terms-update-dialog');

    fireEvent.click(screen.getByText('服务条款'));
    expect(electronAPI.openExternal).toHaveBeenCalledWith(LEGAL_LINKS.termsOfService);
  });

  // 另一个窗口里点了同意:设置广播到达后本窗口也收起。
  it('closes when another window records the agreement', async () => {
    render(<LegalTermsUpdateGate />);
    await screen.findByTestId('legal-terms-update-dialog');

    act(() => broadcast?.(payload(false)));
    expect(screen.queryByTestId('legal-terms-update-dialog')).toBeNull();
  });

  // 弹窗只挡住鼠标与焦点不够:全局快捷键在 window 捕获阶段只看交互锁。
  it('holds the app interaction lock while open and releases it after agreeing', async () => {
    render(<LegalTermsUpdateGate />);
    await screen.findByTestId('legal-terms-update-dialog');
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

    expect(screen.queryByTestId('legal-terms-update-dialog')).toBeNull();
    expect(isAppInteractionLocked()).toBe(false);
  });

  // 依据:已恢复的终端 / 浏览器 / 插件不能抢在确认弹窗出现前被操作;查询悬而不决时不能永久锁住。
  it('swallows input with an invisible blocker until the terms status arrives', async () => {
    let resolve: (value: ReturnType<typeof payload>) => void = () => {};
    electronAPI.getAnalyticsSettings.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<LegalTermsUpdateGate />);

    const pending = screen.getByTestId('legal-terms-update-pending');
    expect(document.activeElement).toBe(pending);
    expect(isAppInteractionLocked()).toBe(true);

    await act(async () => resolve(payload(false)));
    expect(screen.queryByTestId('legal-terms-update-pending')).toBeNull();
    expect(screen.queryByTestId('legal-terms-update-dialog')).toBeNull();
    expect(isAppInteractionLocked()).toBe(false);
  });

  // 依据:透明遮挡层换成确认弹窗时,焦点不能在两者之间回到被盖住的控件。
  it('keeps focus contained when the loading blocker is replaced by the dialog', async () => {
    const background = document.createElement('div');
    const input = document.createElement('input');
    background.appendChild(input);
    document.body.appendChild(background);
    input.focus();
    let resolve: (value: ReturnType<typeof payload>) => void = () => {};
    electronAPI.getAnalyticsSettings.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<LegalTermsUpdateGate />);
    expect(document.activeElement).not.toBe(input);

    await act(async () => resolve(payload(true)));

    expect(screen.getByTestId('legal-terms-update-dialog')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByTestId('legal-terms-update-agree'));
    expect(background.inert).toBe(true);
    background.remove();
  });

  it('gives up waiting after a timeout and leaves the app usable', async () => {
    vi.useFakeTimers();
    try {
      electronAPI.getAnalyticsSettings.mockReturnValue(new Promise(() => {}));
      render(<LegalTermsUpdateGate />);
      expect(screen.getByTestId('legal-terms-update-pending')).toBeTruthy();

      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      expect(screen.queryByTestId('legal-terms-update-pending')).toBeNull();
      expect(isAppInteractionLocked()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not hold back organization accounts while loading', async () => {
    auth.user = { membershipKind: 'org' };
    electronAPI.getAnalyticsSettings.mockReturnValue(new Promise(() => {}));
    render(<LegalTermsUpdateGate />);
    expect(screen.queryByTestId('legal-terms-update-pending')).toBeNull();
  });

  // 依据:更新说明等自动弹出的 Radix 弹窗会抢焦点却画在协议遮罩下面,协议确认期间必须暂缓。
  it('tells other auto-opening dialogs to wait while the gate blocks, and releases them after agreeing', async () => {
    render(
      <>
        <LegalTermsUpdateGate />
        <GateBlockingProbe />
      </>,
    );
    await screen.findByTestId('legal-terms-update-dialog');
    expect(screen.getByTestId('gate-blocking').textContent).toBe('true');

    fireEvent.click(screen.getByText('legalTermsUpdate.agree'));
    await act(async () => {});
    expect(screen.getByTestId('gate-blocking').textContent).toBe('false');
  });

  // 依据:任何来源的弹窗(App 级 IPC 宿主、插件等)在确认期间挂到 body 下,都不能抢走焦点或让
  // 「同意」不可用;确认后它们恢复可用。集中处理,不依赖每个宿主各自暂缓。
  it('keeps dialogs that appear later underneath and inert, and restores them after agreeing', async () => {
    render(<LegalTermsUpdateGate />);
    await screen.findByTestId('legal-terms-update-dialog');

    const lateDialog = document.createElement('div');
    const lateButton = document.createElement('button');
    lateButton.textContent = 'late dialog';
    lateDialog.appendChild(lateButton);
    await act(async () => {
      document.body.appendChild(lateDialog);
    });
    expect(lateDialog.inert).toBe(true);

    lateButton.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(document.activeElement).toBe(screen.getByTestId('legal-terms-update-agree'));

    fireEvent.click(screen.getByText('legalTermsUpdate.agree'));
    await act(async () => {});
    expect(lateDialog.inert).toBe(false);
    lateDialog.remove();
  });

  it('treats Escape as not agreeing', async () => {
    render(<LegalTermsUpdateGate />);
    const dialog = await screen.findByTestId('legal-terms-update-dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await act(async () => {});
    expect(auth.logout).toHaveBeenCalledTimes(1);
  });

  it('never shows in local mode (skip login)', async () => {
    auth.mode = 'local';
    render(<LegalTermsUpdateGate />);
    await act(async () => {});

    expect(screen.queryByTestId('legal-terms-update-dialog')).toBeNull();
  });

  it('stays hidden for users already on the current terms', async () => {
    electronAPI.getAnalyticsSettings.mockResolvedValue(payload(false));
    render(<LegalTermsUpdateGate />);
    await act(async () => {});

    expect(screen.queryByTestId('legal-terms-update-dialog')).toBeNull();
  });
});
