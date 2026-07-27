// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CindyAuthClient, reduceAuthFlow, type AuthFlowState } from '@cindy/auth-client';
import { createScenarioFetch } from '@cindy/auth-client/fixtures';

/**
 * identifier 本地格式校验错误态(设计稿 347:1727,2026-07-22 MT 补齐)。
 *
 * 验证「非法邮箱/手机号提交 → 设计稿定义的红边 + 底部红字,且不发 discover/
 * request-code」这条本地即时校验链,以及输入变更即清除错误态。
 * 形态与 pr2a harness 同构:真实 CindyAuthClient + scenario fetch → reduceAuthFlow
 * 投影出 identifier 态 → mock useLogin 注入;t 用 key-echo(无参回显 key 本身),
 * 故错误文案断言直接锚定 i18n key(login.invalidEmail / login.invalidPhone)。
 * providers 开关位强制 email-only / phone-only 以确定性钉住 identifierKind,
 * 不依赖构建区域(resolveIdentifierMethod:首选缺失时落到另一侧单形态)。
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

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (!params) return key;
      const shown = ['n', 'identifier', 'name', 'org', 'email', 'provider']
        .filter((p) => p in params)
        .map((p) => String(params[p]));
      return shown.length ? `${key}#${shown.join('|')}` : key;
    },
  }),
}));
vi.mock('@/hooks/useLogin', () => ({ useLogin: () => loginHook.value }));
vi.mock('@/components/title-bar/WindowControls', () => ({ WindowControls: () => null }));

import { LoginPage } from '../LoginPage';

let emailOnlyState: AuthFlowState;
let phoneOnlyState: AuthFlowState;

beforeAll(async () => {
  const providers = await new CindyAuthClient({
    baseUrl: 'https://auth.scenario.invalid',
    region: 'cn',
    deviceId: 'identifier-format-harness',
    clientType: 'desktop',
    fetch: createScenarioFetch('providers:both', { region: 'cn' })!,
  }).getProviders();
  // 强制单形态:providers 缺失首选侧时 resolveIdentifierMethod 落到另一侧,
  // 与构建区域无关地钉住 email / phone identifierKind。
  emailOnlyState = reduceAuthFlow(null, {
    type: 'providers-loaded',
    providers: { ...providers, email: true, phone: false },
  });
  phoneOnlyState = reduceAuthFlow(null, {
    type: 'providers-loaded',
    providers: { ...providers, email: false, phone: true },
  });
});

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    // acceptPrivacyConsent:协议门放行时记录「已同意」(TapDB 采集的前置条件)。
    // fire-and-forget,不参与登录派发时序。
    value: { platform: 'darwin', acceptPrivacyConsent: async () => ({ allowed: true }) },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount(state: AuthFlowState) {
  loginHook.value = {
    isLoading: false,
    errorCode: null,
    loginState: state,
    dispatch: vi.fn(async () => true),
    clearError: vi.fn(),
  };
  return render(<LoginPage />);
}

describe('identifier 本地格式校验错误态(设计稿 347:1727)', () => {
  it('非法邮箱提交 → 红字「请输入正确邮箱」+ 输入框 error 边,且不发 discover', () => {
    mount(emailOnlyState);
    fireEvent.change(screen.getByTestId('login-input'), {
      target: { value: '2222@' },
    });
    fireEvent.click(screen.getByTestId('login-continue-button'));
    const errorText = screen.getByTestId('login-error-text');
    expect(errorText.textContent).toBe('login.invalidEmail');
    expect(errorText.getAttribute('style')).toContain('var(--login-error-fg)');
    expect(screen.getByTestId('login-input').getAttribute('style')).toContain(
      'var(--login-error-fg)',
    );
    expect(loginHook.value.dispatch).not.toHaveBeenCalled();
  });

  it('合法邮箱提交 → 发 discover,无本地错误文案', () => {
    mount(emailOnlyState);
    // consent PR:个人链路先过协议门,勾选 radio 后提交直接派发
    fireEvent.click(screen.getByTestId('login-consent-radio'));
    fireEvent.change(screen.getByTestId('login-input'), {
      target: { value: 'user@example.com' },
    });
    fireEvent.click(screen.getByTestId('login-continue-button'));
    expect(loginHook.value.dispatch).toHaveBeenCalledWith({
      type: 'discover',
      email: 'user@example.com',
    });
    expect(screen.queryByTestId('login-error-text')).toBeNull();
  });

  it('手机号提交 → 直接透传 request-code,无客户端 +86/号段校验(对齐 #223:仅移动端做 cnPhone)', () => {
    mount(phoneOnlyState);
    // consent PR:先勾选协议 radio 再提交
    fireEvent.click(screen.getByTestId('login-consent-radio'));
    fireEvent.change(screen.getByTestId('login-input'), {
      target: { value: '12345' },
    });
    fireEvent.click(screen.getByTestId('login-continue-button'));
    // 桌面不再做 cnPhone 本地拦截:任意输入原样透传服务端,无红边红字
    expect(loginHook.value.dispatch).toHaveBeenCalledWith({
      type: 'request-code',
      kind: 'phone',
      identifier: '12345',
    });
    expect(screen.queryByTestId('login-error-text')).toBeNull();
  });

  it('错误态在输入变更后清除(重新输入即消失)', () => {
    mount(emailOnlyState);
    const input = screen.getByTestId('login-input');
    fireEvent.change(input, { target: { value: '2222@' } });
    fireEvent.click(screen.getByTestId('login-continue-button'));
    expect(screen.getByTestId('login-error-text').textContent).toBe('login.invalidEmail');
    // 重新编辑输入 → 本地错误态清除
    fireEvent.change(screen.getByTestId('login-input'), {
      target: { value: 'user@example.co' },
    });
    expect(screen.queryByTestId('login-error-text')).toBeNull();
  });
});
