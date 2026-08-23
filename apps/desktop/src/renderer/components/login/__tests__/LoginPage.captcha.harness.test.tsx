// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CindyAuthClient,
  reduceAuthFlow,
  type AuthFlowState,
  type CaptchaRequiredAction,
  type VerificationKind,
} from '@cindy/auth-client';
import { createScenarioFetch } from '@cindy/auth-client/fixtures';

/**
 * 登录人机验证(captcha)harness 测试:
 *  - providers:email-captcha 场景驱动「providers 主动触发」路径——重发前
 *    overlay 先出现,webview 回传 token 后 dispatch body 才带 captchaToken;
 *  - phone_request_code 预接线：服务端未来下发即可启用短信发码闸;
 *  - 取消 = 不派发、不报错;
 *  - CAPTCHA_REQUIRED 错误驱动兜底(providers 无 captcha 字段时服务端刚开开关)
 *    自动出题一次后原参重试;
 *  - parseLoginCaptchaResult 的 hash 契约解析。
 *
 * webview 在 jsdom 中是未知元素:组件经 addEventListener 挂事件,测试直接
 * dispatchEvent 一个带 url 的 did-navigate-in-page 事件模拟挑战页回传。
 */

const loginHook = vi.hoisted(() => ({
  value: {
    isLoading: false,
    errorCode: null as string | null,
    loginState: null as unknown,
    dispatch: vi.fn(async () => true),
    dispatchWithResult: vi.fn(async () => ({ success: true, code: null as string | null })),
    clearError: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}));
vi.mock('@/hooks/useLogin', () => ({ useLogin: () => loginHook.value }));
vi.mock('@/components/title-bar/WindowControls', () => ({ WindowControls: () => null }));
// 重发倒计时置零:本文件测的是发码前的 captcha 闸,identifier → verification-code
// 的 step 迁移会武装 42s 倒计时,把重发链接换成倒计时文案,先掐掉。
vi.mock('../useResendCountdown', () => ({
  useResendCountdown: () => ({ remaining: 0, arm: vi.fn() }),
}));

import { LoginPage } from '../LoginPage';
import { parseLoginCaptchaResult } from '../LoginCaptchaOverlay';
import { getLoginEmailCaptchaGate } from '@/lib/loginCaptchaGate';

const CHALLENGE_BASE = 'https://auth.scenario.invalid/captcha/turnstile';

function scenarioClient(scenario: string) {
  return new CindyAuthClient({
    baseUrl: 'https://auth.scenario.invalid',
    region: 'global',
    deviceId: 'captcha-harness',
    clientType: 'desktop',
    fetch: createScenarioFetch(scenario, { region: 'global' })!,
  });
}

/** identifier(带 captcha providers)→ verification-code:重发链路的现网状态序列。 */
async function statesFor(
  scenario: string,
  kind: VerificationKind = 'email',
  requiredFor?: CaptchaRequiredAction[],
): Promise<{
  identifier: AuthFlowState;
  verification: AuthFlowState;
}> {
  const parsedProviders = await scenarioClient(scenario).getProviders();
  const providers =
    parsedProviders.captcha && requiredFor
      ? {
          ...parsedProviders,
          captcha: { ...parsedProviders.captcha, requiredFor },
        }
      : parsedProviders;
  const identifierValue = kind === 'email' ? 'user@example.com' : '+8613800138000';
  const identifier = reduceAuthFlow(null, { type: 'providers-loaded', providers });
  const verification = reduceAuthFlow(identifier, {
    type: 'code-requested',
    kind,
    identifier: identifierValue,
  });
  return { identifier, verification };
}

function mount(state: AuthFlowState) {
  loginHook.value = {
    isLoading: false,
    errorCode: null,
    loginState: state,
    dispatch: vi.fn(async () => true),
    dispatchWithResult: vi.fn(async () => ({ success: true, code: null as string | null })),
    clearError: vi.fn(),
  };
  return render(<LoginPage />);
}

function setState(rerender: (ui: React.ReactElement) => void, state: AuthFlowState) {
  loginHook.value = { ...loginHook.value, loginState: state };
  rerender(<LoginPage />);
}

/** 模拟挑战页把结果写进 location.hash(桌面回传通道)。 */
async function emitCaptchaResult(fragment: string) {
  // overlay 先提交、webview 再由 effect append；Windows CI 上两步可能跨 tick。
  const webview = await waitFor(() => {
    const candidate = document.querySelector('webview');
    expect(candidate, 'captcha webview 应已挂载').not.toBeNull();
    return candidate!;
  });
  const event = new Event('did-navigate-in-page');
  Object.defineProperty(event, 'url', { value: `${CHALLENGE_BASE}#${fragment}` });
  webview.dispatchEvent(event);
}

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'darwin',
      acceptPrivacyConsent: async () => ({ allowed: true }),
      authGetCaptchaChallengeUrl: async () => CHALLENGE_BASE,
    },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LoginPage captcha 前置闸(providers 主动触发)', () => {
  it('重发前先出题,token 回传后 dispatch body 携带 captchaToken', async () => {
    const { identifier, verification } = await statesFor('providers:email-captcha');
    const { rerender } = mount(identifier); // identifier 步落 captchaConfigRef
    setState(rerender, verification);

    fireEvent.click(screen.getByText('login.resendCode'));
    await screen.findByTestId('login-captcha-overlay');
    // overlay 打开时不应已派发
    expect(loginHook.value.dispatchWithResult).not.toHaveBeenCalled();

    await emitCaptchaResult('cindy-captcha=ok.scenario-captcha-token');
    await waitFor(() =>
      expect(loginHook.value.dispatchWithResult).toHaveBeenCalledWith({
        type: 'request-code',
        kind: 'email',
        identifier: 'user@example.com',
        captchaToken: 'scenario-captcha-token',
      }),
    );
    // 结果回传后 overlay 关闭
    await waitFor(() =>
      expect(screen.queryByTestId('login-captcha-overlay')).toBeNull(),
    );
  });

  it('服务端未来仅下发 phone_request_code 即可启用短信发码闸', async () => {
    const { identifier, verification } = await statesFor('providers:email-captcha', 'phone', [
      'phone_request_code',
    ]);
    const { rerender } = mount(identifier);
    setState(rerender, verification);

    fireEvent.click(screen.getByText('login.resendCode'));
    await screen.findByTestId('login-captcha-overlay');
    expect(loginHook.value.dispatchWithResult).not.toHaveBeenCalled();
    await waitFor(() => {
      const src = document.querySelector('webview')?.getAttribute('src');
      expect(src).toBeTruthy();
      expect(new URL(src!).searchParams.get('action')).toBe('phone_request_code');
    });

    await emitCaptchaResult('cindy-captcha=ok.phone-captcha-token');
    await waitFor(() =>
      expect(loginHook.value.dispatchWithResult).toHaveBeenCalledWith({
        type: 'request-code',
        kind: 'phone',
        identifier: '+8613800138000',
        captchaToken: 'phone-captcha-token',
      }),
    );
  });

  it('挑战打开时聚焦主要 WebView 交互，而不是默认聚焦取消', async () => {
    const { identifier, verification } = await statesFor('providers:email-captcha');
    const { rerender } = mount(identifier);
    setState(rerender, verification);

    fireEvent.click(screen.getByText('login.resendCode'));
    await screen.findByTestId('login-captcha-overlay');

    await waitFor(() => expect(document.activeElement?.tagName).toBe('WEBVIEW'));
    expect(document.activeElement).not.toBe(screen.getByTestId('login-captcha-cancel'));

    fireEvent.click(screen.getByTestId('login-captcha-cancel'));
  });

  it('取消与失败后的重试操作都有键盘可见焦点样式', async () => {
    const { identifier, verification } = await statesFor('providers:email-captcha');
    const { rerender } = mount(identifier);
    setState(rerender, verification);

    fireEvent.click(screen.getByText('login.resendCode'));
    await screen.findByTestId('login-captcha-overlay');
    const cancel = screen.getByTestId('login-captcha-cancel');
    expect(cancel.classList.contains('focus-visible:ring-2')).toBe(true);
    expect(cancel.classList.contains('focus-visible:ring-[var(--focus-ring-soft)]')).toBe(true);

    await emitCaptchaResult('cindy-captcha=err.expired');
    const retry = await screen.findByTestId('login-captcha-retry');
    expect(retry.classList.contains('focus-visible:ring-2')).toBe(true);
    expect(retry.classList.contains('focus-visible:ring-[var(--focus-ring-soft)]')).toBe(true);
  });

  it('guest 内 Esc 的固定取消 hash 会关闭挑战且不派发发码', async () => {
    const { identifier, verification } = await statesFor('providers:email-captcha');
    const { rerender } = mount(identifier);
    setState(rerender, verification);

    fireEvent.click(screen.getByText('login.resendCode'));
    await screen.findByTestId('login-captcha-overlay');
    await emitCaptchaResult('cindy-captcha=err.cancelled');

    await waitFor(() =>
      expect(screen.queryByTestId('login-captcha-overlay')).toBeNull(),
    );
    expect(loginHook.value.dispatchWithResult).not.toHaveBeenCalled();
  });

  it('取消挑战 = 不派发、overlay 关闭、无错误注入', async () => {
    const { identifier, verification } = await statesFor('providers:email-captcha');
    const { rerender } = mount(identifier);
    setState(rerender, verification);

    fireEvent.click(screen.getByText('login.resendCode'));
    await screen.findByTestId('login-captcha-overlay');
    fireEvent.click(screen.getByTestId('login-captcha-cancel'));

    await waitFor(() =>
      expect(screen.queryByTestId('login-captcha-overlay')).toBeNull(),
    );
    expect(loginHook.value.dispatchWithResult).not.toHaveBeenCalled();
  });

  it('providers 无 captcha 时不出题,直接派发(cn/未启用回归)', async () => {
    const { identifier, verification } = await statesFor('providers:email-only');
    const { rerender } = mount(identifier);
    setState(rerender, verification);

    fireEvent.click(screen.getByText('login.resendCode'));
    await waitFor(() =>
      expect(loginHook.value.dispatchWithResult).toHaveBeenCalledWith({
        type: 'request-code',
        kind: 'email',
        identifier: 'user@example.com',
        captchaToken: undefined,
      }),
    );
    expect(screen.queryByTestId('login-captcha-overlay')).toBeNull();
  });

  it('AuthContext 自动发码链的闸(loginCaptchaGate):挂载即注册,需要时出题拿 token', async () => {
    const { identifier } = await statesFor('providers:email-captcha');
    mount(identifier);
    const gate = getLoginEmailCaptchaGate();
    expect(gate, 'LoginPage 挂载后闸必须已注册').not.toBeNull();

    const pending = gate!();
    await screen.findByTestId('login-captcha-overlay');
    await emitCaptchaResult('cindy-captcha=ok.gate-token');
    await expect(pending).resolves.toBe('gate-token');
  });

  it('快速重复触发只保留一个挑战,后续调用取消且不会覆盖首个 resolver', async () => {
    const { identifier } = await statesFor('providers:email-captcha');
    mount(identifier);
    const gate = getLoginEmailCaptchaGate();
    expect(gate).not.toBeNull();

    const first = gate!();
    const duplicate = gate!();
    await expect(duplicate).resolves.toBeNull();
    await screen.findByTestId('login-captcha-overlay');
    // overlay 先提交，WebView 再由 effect 插入；Windows CI 上两步可能跨 tick。
    await waitFor(() => expect(document.querySelectorAll('webview')).toHaveLength(1));

    await emitCaptchaResult('cindy-captcha=ok.single-flight-token');
    await expect(first).resolves.toBe('single-flight-token');
  });

  it('AuthContext 自动发码链的闸:providers 无 captcha 时直接放行(undefined)', async () => {
    const { identifier } = await statesFor('providers:email-only');
    mount(identifier);
    const gate = getLoginEmailCaptchaGate();
    expect(gate).not.toBeNull();
    await expect(gate!()).resolves.toBeUndefined();
    expect(screen.queryByTestId('login-captcha-overlay')).toBeNull();
  });

  it('identifier 提交的 discover 兜底:自动链吃到 CAPTCHA_REQUIRED 后出题重发发码', async () => {
    // providers 不带 captcha(providers 缓存旧于服务端开关):自动链不带 token
    // 发码,错误码从 discover 动作冒泡回 submitEmailDiscover。
    const { identifier } = await statesFor('providers:email-only');
    mount(identifier);
    loginHook.value.dispatchWithResult
      .mockResolvedValueOnce({ success: false, code: 'CAPTCHA_REQUIRED' })
      .mockResolvedValueOnce({ success: true, code: null });

    // 先勾协议 radio 再提交(identifier 提交过 requireConsent 门)
    fireEvent.click(screen.getByTestId('login-consent-radio'));
    fireEvent.change(screen.getByTestId('login-input'), {
      target: { value: 'user@example.com' },
    });
    fireEvent.click(screen.getByTestId('login-continue-button'));

    await screen.findByTestId('login-captcha-overlay');
    expect(loginHook.value.dispatchWithResult).toHaveBeenCalledTimes(1);
    expect(loginHook.value.dispatchWithResult).toHaveBeenNthCalledWith(1, {
      type: 'discover',
      email: 'user@example.com',
    });

    await emitCaptchaResult('cindy-captcha=ok.discover-fallback-token');
    await waitFor(() => expect(loginHook.value.dispatchWithResult).toHaveBeenCalledTimes(2));
    expect(loginHook.value.dispatchWithResult).toHaveBeenNthCalledWith(2, {
      type: 'request-code',
      kind: 'email',
      identifier: 'user@example.com',
      captchaToken: 'discover-fallback-token',
    });
  });

  it('CAPTCHA_REQUIRED 错误驱动兜底:自动出题一次后原参重试', async () => {
    // providers 不带 captcha(模拟服务端刚开开关、客户端 providers 缓存过旧)
    const { identifier, verification } = await statesFor('providers:email-only');
    const { rerender } = mount(identifier);
    setState(rerender, verification);
    loginHook.value.dispatchWithResult
      .mockResolvedValueOnce({ success: false, code: 'CAPTCHA_REQUIRED' })
      .mockResolvedValueOnce({ success: true, code: null });

    fireEvent.click(screen.getByText('login.resendCode'));
    await screen.findByTestId('login-captcha-overlay');
    await emitCaptchaResult('cindy-captcha=ok.fallback-token');

    await waitFor(() => expect(loginHook.value.dispatchWithResult).toHaveBeenCalledTimes(2));
    expect(loginHook.value.dispatchWithResult).toHaveBeenNthCalledWith(2, {
      type: 'request-code',
      kind: 'email',
      identifier: 'user@example.com',
      captchaToken: 'fallback-token',
    });
  });
});

describe('parseLoginCaptchaResult(挑战页 hash 回传契约)', () => {
  it('解析 ok/err,拒绝越界与非本契约 URL', () => {
    expect(
      parseLoginCaptchaResult(
        `${CHALLENGE_BASE}#cindy-captcha=ok.abc%2B123`,
        CHALLENGE_BASE,
      ),
    ).toEqual({ status: 'ok', token: 'abc+123' });
    expect(
      parseLoginCaptchaResult(
        `${CHALLENGE_BASE}#cindy-captcha=err.expired`,
        CHALLENGE_BASE,
      ),
    ).toEqual({
      status: 'err',
      code: 'expired',
    });
    // 越界 token(>2048)拒
    expect(
      parseLoginCaptchaResult(
        `${CHALLENGE_BASE}#cindy-captcha=ok.${'a'.repeat(2049)}`,
        CHALLENGE_BASE,
      ),
    ).toBeNull();
    // 空 token / 非法编码 / 无关 hash / 非 URL
    expect(
      parseLoginCaptchaResult(`${CHALLENGE_BASE}#cindy-captcha=ok.`, CHALLENGE_BASE),
    ).toBeNull();
    expect(
      parseLoginCaptchaResult(`${CHALLENGE_BASE}#cindy-captcha=ok.%E0%A4%A`, CHALLENGE_BASE),
    ).toBeNull();
    expect(parseLoginCaptchaResult(`${CHALLENGE_BASE}#other`, CHALLENGE_BASE)).toBeNull();
    expect(parseLoginCaptchaResult('not-a-url', CHALLENGE_BASE)).toBeNull();
    expect(
      parseLoginCaptchaResult(
        'https://evil.example.com/captcha/turnstile#cindy-captcha=ok.forged',
        CHALLENGE_BASE,
      ),
    ).toBeNull();
    expect(
      parseLoginCaptchaResult(
        'https://auth.scenario.invalid/redirected#cindy-captcha=ok.forged',
        CHALLENGE_BASE,
      ),
    ).toBeNull();
    // 异常错误码收敛为 unknown
    expect(
      parseLoginCaptchaResult(`${CHALLENGE_BASE}#cindy-captcha=err.<script>`, CHALLENGE_BASE),
    ).toEqual({ status: 'err', code: 'unknown' });
  });
});
