// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CindyAuthClient, reduceAuthFlow, type AuthFlowState } from '@cindy/auth-client';
import { createScenarioFetch } from '@cindy/auth-client/fixtures';

/**
 * Global(国际区)构建变体的登录皮回归。
 *
 * 为什么单开一份:仓内其余登录单测一律把构建区域 mock 成 `cn`
 * (`LoginPage.harness.test.tsx` / `LoginPage.consent.test.tsx` /
 * `LoginPage.pr2a.harness.test.tsx` 的 `CURRENT_CINDY_REGION: 'cn'`),
 * `providers:global-social` 场景只换服务端 provider 组合、不冒充构建区域。
 * 本文件把 `CURRENT_CINDY_REGION` 与 `VITE_CINDY_AUTH_REGION` 双双置为 global,
 * 锁住「登录面板改版四件事(面板 500 / 删游客圆钮 / 面板内跳过登录 / 跳过免协议门)
 * 在国际区同样生效」——即区域分支只影响 identifier 形态、区域徽标、协议 URL
 * 与服务端 social 组合,不影响面板几何与本地模式入口。
 */

const loginHook = vi.hoisted(() => ({
  value: {
    isLoading: false,
    errorCode: null as string | null,
    loginState: null as unknown,
    dispatch: vi.fn(async () => true),
    dispatchWithResult: vi.fn(async () => ({ success: true, code: null })),
    clearError: vi.fn(),
  },
}));

// 协议文案 key 还原为真实 tagged 文案(链接段解析依赖标记),其余 key 原样返回
const CONSENT_TEXT: Record<string, string> = {
  'login.consentStatement':
    'I have read and agree to the <terms>Terms</terms> and <privacy>Privacy</privacy>',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => CONSENT_TEXT[key] ?? key }),
}));
// 构建区域 = global(LEGAL_LINKS 亦随之解析为 protocol.xd.com 系)
vi.mock('../../../../shared/brandRegion', () => ({
  CURRENT_CINDY_REGION: 'global',
  CURRENT_APP_ID: 'com.xd.cindy',
}));
vi.mock('@/hooks/useLogin', () => ({ useLogin: () => loginHook.value }));
vi.mock('@/components/title-bar/WindowControls', () => ({ WindowControls: () => null }));

import { LoginPage } from '../LoginPage';

const GLOBAL_TERMS_URL = 'https://protocol.xd.com/cindy/agreement-1.0.html';
const GLOBAL_PRIVACY_URL = 'https://protocol.xd.com/cindy/privacy.html';

async function globalIdentifierState(scenario = 'providers:global-social'): Promise<AuthFlowState> {
  const client = new CindyAuthClient({
    baseUrl: 'https://auth.scenario.invalid',
    region: 'global',
    deviceId: 'region-harness',
    clientType: 'desktop',
    fetch: createScenarioFetch(scenario, { region: 'global' })!,
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
    dispatchWithResult: vi.fn(async () => ({ success: true, code: null })),
    clearError: vi.fn(),
    ...extra,
  };
  return render(<LoginPage />);
}

const openExternal = vi.fn(async () => ({ success: true }));
const authEnterLocal = vi.fn(async () => ({ mode: 'local' }));
const acceptPrivacyConsent = vi.fn(async () => ({
  privacyConsentAccepted: true,
  analyticsEnabled: true,
  allowed: true,
}));

beforeEach(() => {
  // isGlobalBuild 在渲染时读 import.meta.env,必须在 render 前置好
  vi.stubEnv('VITE_CINDY_AUTH_REGION', 'global');
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
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('Global 构建变体:登录改版四件事同样生效', () => {
  it('确实处于 Global 变体(不挂区域徽标 + 邮箱 identifier + 协议链接走 protocol.xd.com)', async () => {
    mount(await globalIdentifierState());
    // global 构建不挂徽标(#554 起的产品叙事硬规则,DESIGN.md §16.3:不得回退);
    // cn / dev 才标注。徽标的三档区域映射本身由 LoginPage.regionPill.test 覆盖,
    // 这里只用「无徽标」为 global 变体做一处正向确认。
    expect(screen.queryByTestId('login-region-pill')).toBeNull();
    expect((screen.getByTestId('login-input') as HTMLInputElement).placeholder).toBe(
      'login.emailPlaceholder',
    );
    fireEvent.click(screen.getByTestId('login-consent-terms-link'));
    expect(openExternal).toHaveBeenCalledWith(GLOBAL_TERMS_URL);
    fireEvent.click(screen.getByTestId('login-consent-privacy-link'));
    expect(openExternal).toHaveBeenCalledWith(GLOBAL_PRIVACY_URL);
  });

  it('面板 680×500,「跳过登录」文字按钮在面板内 680×60 槽 @y430(24px 下划线 #6F6F6F)', async () => {
    mount(await globalIdentifierState());
    const panel = screen.getByTestId('login-panel-identifier');
    expect(panel.style.width).toBe('680px');
    expect(panel.style.height).toBe('500px');
    const slot = screen.getByTestId('login-skip-entry-slot');
    const skip = screen.getByTestId('login-skip-entry');
    expect(panel.contains(slot)).toBe(true);
    expect(slot.style.left).toBe('0px');
    expect(slot.style.top).toBe('430px');
    expect(slot.style.width).toBe('680px');
    expect(slot.style.height).toBe('60px');
    expect(skip.style.fontSize).toBe('24px');
    expect(skip.className).toContain('underline');
    // 颜色与热区口径在 Global 变体同样生效(用户拍板 2026-07-27)
    expect(skip.getAttribute('style') ?? '').toContain('--login-secondary-text');
    expect(slot.style.pointerEvents).toBe('none');
    expect(skip.style.paddingLeft).toBe('30px');
    expect(skip.style.paddingRight).toBe('30px');
  });

  it('圆钮行 = Apple + Google + SSO 三颗(游客圆钮已删,count 随 providers 动态)', async () => {
    mount(await globalIdentifierState());
    const row = screen.getByTestId('login-social-row');
    expect(screen.queryByTestId('login-social-guest')).toBeNull();
    expect(row.children.length).toBe(3);
    expect(row.firstElementChild).toBe(screen.getByTestId('login-social-apple'));
    expect(row.children[1]).toBe(screen.getByTestId('login-social-google'));
    expect(row.lastElementChild).toBe(screen.getByTestId('login-social-sso'));
    // 协议行随面板增高整体下移到组坐标 y=642
    expect(screen.getByTestId('login-consent-row').style.top).toBe('642px');
  });

  // 2026-07-29 拍板:跳过登录恢复过协议门(Global 构建同口径,不按区域分流)
  it('未勾选点「跳过登录」→ 先弹协议弹窗;同意后进本地模式并写同意记录', async () => {
    mount(await globalIdentifierState());
    expect(screen.getByTestId('login-consent-radio').getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      fireEvent.click(screen.getByTestId('login-skip-entry'));
    });
    expect(screen.getByTestId('login-consent-dialog')).toBeTruthy();
    expect(authEnterLocal).not.toHaveBeenCalled();
    expect(acceptPrivacyConsent).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByTestId('login-consent-agree'));
    });
    expect(authEnterLocal).toHaveBeenCalledTimes(1);
    expect(acceptPrivacyConsent).toHaveBeenCalled();
  });

  it('其它个人登录链路的协议门未被误摘:未勾选点 Apple 圆钮仍先弹协议弹窗', async () => {
    mount(await globalIdentifierState());
    fireEvent.click(screen.getByTestId('login-social-apple'));
    expect(screen.getByTestId('login-consent-dialog')).toBeTruthy();
    expect(loginHook.value.dispatch).not.toHaveBeenCalled();
  });
});
