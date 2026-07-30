// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CindyAuthClient, reduceAuthFlow, type AuthFlowState } from '@cindy/auth-client';
import { createScenarioFetch } from '@cindy/auth-client/fixtures';

/**
 * 协议同意链路专测(consent PR):
 * - radio 未勾选 → 任一个人登录入口(手机号/Apple/游客)先弹同意弹窗,不派发;
 * - 同意 = 自动勾选 + 续接原登录链路;不同意 = 关弹窗留在登录页;
 * - 企业 SSO 入口全豁免;
 * - 协议链接(主界面行 + 弹窗内)经 openExternal 打开区域分流 URL(测试构建 = cn)。
 */

const loginHook = vi.hoisted(() => ({
  value: {
    isLoading: false,
    errorCode: null as string | null,
    loginState: null as unknown,
    dispatch: vi.fn(async () => true),
    clearError: vi.fn(),
  },
}));

// 协议文案 key 还原为真实 tagged 文案(链接段解析依赖标记),其余 key 原样返回
const CONSENT_TEXT: Record<string, string> = {
  'login.consentStatement': '我已阅读并同意 <terms>服务条款</terms> 和 <privacy>隐私协议</privacy>',
  'login.consentDialog.body':
    '已阅读并同意 Cindy 的以下协议：<terms>服务条款</terms>、<privacy>隐私协议</privacy>',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => CONSENT_TEXT[key] ?? key }),
}));
vi.mock('../../../../shared/brandRegion', () => ({
  CURRENT_CINDY_REGION: 'cn',
  CURRENT_APP_ID: 'com.xd.cindycn',
}));
vi.mock('@/hooks/useLogin', () => ({ useLogin: () => loginHook.value }));
vi.mock('@/components/title-bar/WindowControls', () => ({ WindowControls: () => null }));

import { LoginPage } from '../LoginPage';
import { parseLegalSegments } from '../LoginControls';
import { LEGAL_LINKS } from '../../../../shared/legalLinks';

const CN_TERMS_URL = 'https://protocol.xd.cn/cindy/agreement.html';
const CN_PRIVACY_URL = 'https://protocol.xd.cn/cindy/privacy-1.0.html';

async function identifierState(scenario: string): Promise<AuthFlowState> {
  const client = new CindyAuthClient({
    baseUrl: 'https://auth.scenario.invalid',
    region: 'cn',
    deviceId: 'consent-harness',
    clientType: 'desktop',
    fetch: createScenarioFetch(scenario, { region: 'cn' })!,
  });
  const providers = await client.getProviders();
  return reduceAuthFlow(null, { type: 'providers-loaded', providers });
}

function mount(state: AuthFlowState | null, extra?: Partial<typeof loginHook.value>) {
  loginHook.value = {
    isLoading: false,
    errorCode: null,
    loginState: state,
    dispatch: vi.fn(async () => true),
    clearError: vi.fn(),
    ...extra,
  };
  return render(<LoginPage />);
}

const openExternal = vi.fn(async () => ({ success: true }));
const authEnterLocal = vi.fn(async () => ({ mode: 'local' }));
// 协议门放行时会把「已同意」落到 main(TapDB 采集的前置条件,见
// main/analytics-settings-store.ts)。它是 fire-and-forget,不参与登录派发时序。
const acceptPrivacyConsent = vi.fn(async () => ({
  privacyConsentAccepted: true,
  analyticsEnabled: true,
  allowed: true,
}));

beforeEach(() => {
  openExternal.mockClear();
  authEnterLocal.mockClear();
  acceptPrivacyConsent.mockClear();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { platform: 'darwin', openExternal, authEnterLocal, acceptPrivacyConsent },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/* ── parseLegalSegments:i18n 单 key 词序无关拆段(规则 9 代码确定性) ── */
describe('parseLegalSegments', () => {
  it('zh 语序:前缀文本 + 两个链接段 + 连接词', () => {
    expect(
      parseLegalSegments('我已阅读并同意 <terms>服务条款</terms> 和 <privacy>隐私协议</privacy>'),
    ).toEqual([
      { kind: 'text', text: '我已阅读并同意 ' },
      { kind: 'terms', text: '服务条款' },
      { kind: 'text', text: ' 和 ' },
      { kind: 'privacy', text: '隐私协议' },
    ]);
  });

  it('ja 语序:链接前置 + 尾缀文本(单 key 保住各语言词序)', () => {
    expect(
      parseLegalSegments(
        '<terms>利用規約</terms>と<privacy>プライバシーポリシー</privacy>を読み、同意します',
      ),
    ).toEqual([
      { kind: 'terms', text: '利用規約' },
      { kind: 'text', text: 'と' },
      { kind: 'privacy', text: 'プライバシーポリシー' },
      { kind: 'text', text: 'を読み、同意します' },
    ]);
  });

  it('无标记文本原样单段透传(t mock 回落 key 时不崩)', () => {
    expect(parseLegalSegments('login.consentStatement')).toEqual([
      { kind: 'text', text: 'login.consentStatement' },
    ]);
  });
});

/* ── 主界面协议行 ── */
describe('协议同意行', () => {
  it('radio 点击切换勾选态(aria-checked),再点取消', async () => {
    mount(await identifierState('providers:cn-social'));
    const radio = screen.getByTestId('login-consent-radio');
    expect(radio.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(radio);
    expect(radio.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(radio);
    expect(radio.getAttribute('aria-checked')).toBe('false');
  });

  it('行内「服务条款」「隐私协议」链接 → openExternal 打开国内区 URL,且不切换 radio', async () => {
    mount(await identifierState('providers:cn-social'));
    fireEvent.click(screen.getByTestId('login-consent-terms-link'));
    expect(openExternal).toHaveBeenCalledWith(CN_TERMS_URL);
    fireEvent.click(screen.getByTestId('login-consent-privacy-link'));
    expect(openExternal).toHaveBeenCalledWith(CN_PRIVACY_URL);
    // 链接点击不影响勾选态、不弹同意弹窗
    expect(screen.getByTestId('login-consent-radio').getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByTestId('login-consent-dialog')).toBeNull();
    // 区域分流单点:测试构建 = cn(未注入 VITE_CINDY_AUTH_REGION)
    expect(LEGAL_LINKS.termsOfService).toBe(CN_TERMS_URL);
    expect(LEGAL_LINKS.privacyPolicy).toBe(CN_PRIVACY_URL);
  });
});

/* ── 未勾选拦截 → 同意续接 / 不同意退回 ── */
describe('consent guard(未勾选拦截个人登录链路)', () => {
  it('未勾选点 Apple → 弹同意弹窗且不派发;点同意 → 自动勾选 + 续接 start-browser(apple)', async () => {
    mount(await identifierState('providers:cn-social'));
    fireEvent.click(screen.getByTestId('login-social-apple'));
    expect(screen.getByTestId('login-consent-dialog')).toBeTruthy();
    expect(loginHook.value.dispatch).not.toHaveBeenCalled();
    // 弹窗打开焦点落「同意」主按钮(DESIGN.md §14.2)
    expect(document.activeElement).toBe(screen.getByTestId('login-consent-agree'));
    fireEvent.click(screen.getByTestId('login-consent-agree'));
    expect(screen.queryByTestId('login-consent-dialog')).toBeNull();
    expect(screen.getByTestId('login-consent-radio').getAttribute('aria-checked')).toBe('true');
    expect(loginHook.value.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'start-browser',
        kind: 'social',
        providerOrConnectionId: 'apple',
      }),
    );
  });

  it('未勾选点 Apple → 点不同意 → 关弹窗、不派发、radio 保持未勾选;pending 不残留', async () => {
    mount(await identifierState('providers:cn-social'));
    fireEvent.click(screen.getByTestId('login-social-apple'));
    fireEvent.click(screen.getByTestId('login-consent-disagree'));
    expect(screen.queryByTestId('login-consent-dialog')).toBeNull();
    expect(loginHook.value.dispatch).not.toHaveBeenCalled();
    expect(screen.getByTestId('login-consent-radio').getAttribute('aria-checked')).toBe('false');
    // 不同意后手动勾选 radio 不得续接此前 pending 的登录动作
    fireEvent.click(screen.getByTestId('login-consent-radio'));
    expect(loginHook.value.dispatch).not.toHaveBeenCalled();
  });

  it('已勾选后点 Apple → 直接派发,无弹窗', async () => {
    mount(await identifierState('providers:cn-social'));
    fireEvent.click(screen.getByTestId('login-consent-radio'));
    fireEvent.click(screen.getByTestId('login-social-apple'));
    expect(screen.queryByTestId('login-consent-dialog')).toBeNull();
    expect(loginHook.value.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'start-browser', providerOrConnectionId: 'apple' }),
    );
  });

  it('国内手机号提交未勾选 → 弹窗;同意 → 续接 request-code', async () => {
    mount(await identifierState('providers:cn-social'));
    fireEvent.change(screen.getByTestId('login-input'), { target: { value: '13800138000' } });
    fireEvent.click(screen.getByTestId('login-continue-button'));
    expect(screen.getByTestId('login-consent-dialog')).toBeTruthy();
    expect(loginHook.value.dispatch).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByTestId('login-consent-agree'));
    });
    expect(loginHook.value.dispatch).toHaveBeenCalledWith({
      type: 'request-code',
      kind: 'phone',
      identifier: '13800138000',
    });
  });

  // 2026-07-27 拍板(推翻同年 07-24「游客也先过协议门」):跳过登录不创建账号、不上报
  // 数据,radio 未勾选也直接进本地模式,不弹协议弹窗。旧游客圆钮入口已删除。
  it('「跳过登录」未勾选也豁免协议门 → 无弹窗,直接进入本地模式(authEnterLocal)', async () => {
    mount(await identifierState('providers:cn-social'));
    expect(screen.getByTestId('login-consent-radio').getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      fireEvent.click(screen.getByTestId('login-skip-entry'));
    });
    expect(screen.queryByTestId('login-consent-dialog')).toBeNull();
    expect(authEnterLocal).toHaveBeenCalledTimes(1);
  });

  it('「跳过登录」不写入「已同意隐私政策」记录(未明示同意 → 采集闸保持关闭)', async () => {
    mount(await identifierState('providers:cn-social'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('login-skip-entry'));
    });
    expect(acceptPrivacyConsent).not.toHaveBeenCalled();
  });

  it('旧游客圆钮入口已删除(圆钮行不再渲染 login-social-guest)', async () => {
    mount(await identifierState('providers:cn-social'));
    expect(screen.queryByTestId('login-social-guest')).toBeNull();
  });

  it('企业 SSO 入口豁免:未勾选点 SSO 圆钮 → 直接进组织标识子视图,无弹窗', async () => {
    mount(await identifierState('providers:cn-social'));
    fireEvent.click(screen.getByTestId('login-social-sso'));
    expect(screen.queryByTestId('login-consent-dialog')).toBeNull();
    expect(screen.getByTestId('login-panel-sso-org')).toBeTruthy();
    // sso-org 子视图不渲染协议行(协议门只属个人链路)
    expect(screen.queryByTestId('login-consent-row')).toBeNull();
  });
});

/* ── 弹窗自身 ── */
describe('同意弹窗', () => {
  it('弹窗内「服务条款」「隐私协议」链接 → openExternal 区域 URL,弹窗保持打开', async () => {
    mount(await identifierState('providers:cn-social'));
    fireEvent.click(screen.getByTestId('login-social-apple'));
    fireEvent.click(screen.getByTestId('login-consent-dialog-terms-link'));
    expect(openExternal).toHaveBeenCalledWith(CN_TERMS_URL);
    fireEvent.click(screen.getByTestId('login-consent-dialog-privacy-link'));
    expect(openExternal).toHaveBeenCalledWith(CN_PRIVACY_URL);
    expect(screen.getByTestId('login-consent-dialog')).toBeTruthy();
  });

  it('Esc = 不同意(关弹窗、不派发)', async () => {
    mount(await identifierState('providers:cn-social'));
    fireEvent.click(screen.getByTestId('login-social-apple'));
    fireEvent.keyDown(screen.getByTestId('login-consent-dialog'), { key: 'Escape' });
    expect(screen.queryByTestId('login-consent-dialog')).toBeNull();
    expect(loginHook.value.dispatch).not.toHaveBeenCalled();
  });

  it('弹窗双钮走 token:同意 = primary 族,不同意 = secondary 族(wave5 双色小按钮)', async () => {
    mount(await identifierState('providers:cn-social'));
    fireEvent.click(screen.getByTestId('login-social-apple'));
    const agree = screen.getByTestId('login-consent-agree');
    const disagree = screen.getByTestId('login-consent-disagree');
    expect(agree.getAttribute('style')).toContain('var(--login-primary-button-bg)');
    expect(disagree.getAttribute('style')).toContain('var(--login-secondary-button-bg)');
    expect(disagree.getAttribute('style')).toContain('var(--login-secondary-button-text)');
  });
});
