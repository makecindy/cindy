// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import { CindyAuthClient, reduceAuthFlow, type AuthFlowState } from '@cindy/auth-client';
import { createScenarioFetch } from '@cindy/auth-client/fixtures';

import zhCN from '../../../i18n/locales/zh-CN/common.json';

/**
 * PR2a 错误码文案表(state-manifest desktop.error-copy.* 20 行):
 * 18 具名码 → `login.errors.<CODE>` 现网 i18n verbatim;UNKNOWN_CODE(未注册
 * wire code)与 LOGIN_BUSY(无专属 key 代表项)→ fallback「登录失败,请稍后重试」。
 *
 * 全真链:错误码经 scenario `error:verify-code:<CODE>` 由真实 CindyAuthClient
 * 抛出(AuthError.code 提取),文案经真 i18next 实例(真 zh-CN common.json)
 * 渲染,LoginErrorText 断言与 JSON 逐字相等——不 mock 翻译层。
 */

const loginHook = vi.hoisted(() => ({
  value: {
    isLoading: false,
    errorCode: null as string | null,
    retryAt: undefined as number | undefined,
    loginState: null as unknown,
    dispatch: vi.fn(async () => true),
    dispatchWithResult: vi.fn(async () => ({ success: true, code: null })),
    clearError: vi.fn(),
  },
}));

vi.mock('@/hooks/useLogin', () => ({ useLogin: () => loginHook.value }));
vi.mock('@/components/title-bar/WindowControls', () => ({ WindowControls: () => null }));

import { LoginPage } from '../LoginPage';

const NAMED_CODES = [
  'AUTH_SERVICE_UNAVAILABLE',
  'AUTH_REQUEST_FAILED',
  'NETWORK_ERROR',
  'REQUEST_TIMEOUT',
  'INVALID_PARAMS',
  'INVALID_CODE',
  'CODE_ATTEMPTS_EXCEEDED',
  'RATE_LIMITED',
  'CAPTCHA_REQUIRED',
  'CAPTCHA_INVALID',
  'CAPTCHA_UNAVAILABLE',
  'SSO_LOGIN_REQUIRED',
  'ORG_SSO_NOT_FOUND',
  'SOCIAL_TOKEN_INVALID',
  'SOCIAL_PROVIDER_DISABLED',
  'USER_CANCELLED',
  'STATE_MISMATCH',
  'INVALID_AUTH_CODE',
  'INVALID_LOGIN_TICKET',
  'INVALID_BIND_TICKET',
  'REGION_MISMATCH',
] as const;
const FALLBACK_CODES = ['UNKNOWN_CODE', 'LOGIN_BUSY'] as const;

const zhErrors = zhCN.login.errors as Record<string, string>;

/** 真实 client 走 scenario error fetch,把 wire 错误码原样抛出后提取。 */
async function wireErrorCode(code: string): Promise<string> {
  const client = new CindyAuthClient({
    baseUrl: 'https://auth.scenario.invalid',
    region: 'cn',
    deviceId: 'pr2a-error-copy',
    clientType: 'desktop',
    fetch: createScenarioFetch(`error:verify-code:${code}`, { region: 'cn' })!,
  });
  try {
    await client.verifyCode('email', 'user@example.com', '123456');
  } catch (error) {
    return (error as { code: string }).code;
  }
  throw new Error(`scenario error:verify-code:${code} 未抛错`);
}

let identifierState: AuthFlowState;

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    lng: 'zh-CN',
    fallbackLng: false,
    ns: ['common'],
    defaultNS: 'common',
    interpolation: { escapeValue: false },
    resources: { 'zh-CN': { common: zhCN } },
  });
  const providers = await new CindyAuthClient({
    baseUrl: 'https://auth.scenario.invalid',
    region: 'cn',
    deviceId: 'pr2a-error-copy',
    clientType: 'desktop',
    fetch: createScenarioFetch('providers:both', { region: 'cn' })!,
  }).getProviders();
  identifierState = reduceAuthFlow(null, { type: 'providers-loaded', providers });
});

beforeEach(() => {
  loginHook.value.errorCode = null;
  loginHook.value.retryAt = undefined;
  loginHook.value.dispatch = vi.fn(async () => true);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { platform: 'darwin', openLogsDir: vi.fn(async () => ({ success: true })) },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mountWithError(code: string) {
  loginHook.value = {
    isLoading: false,
    errorCode: code,
    retryAt: undefined,
    loginState: identifierState,
    dispatch: vi.fn(async () => true),
    dispatchWithResult: vi.fn(async () => ({ success: true, code: null })),
    clearError: vi.fn(),
  };
  return render(<LoginPage />);
}

describe('error-copy 桌面 19 码表 + 兜底(现网 i18n verbatim,#D91F37 族)', () => {
  it.each([
    ['verification-code', 'login-back-button'],
    ['verification-code', 'login-credential-recheck'],
    ['binding-contact', 'login-back-button'],
    ['binding-contact', 'login-credential-recheck'],
    ['binding-code', 'login-back-button'],
    ['binding-code', 'login-credential-recheck'],
  ])('returns from a rate limit to the unchanged %s form via %s', (step, entry) => {
    const state =
      step === 'verification-code'
        ? { step, kind: 'email', identifier: 'person@example.com' }
        : {
            step: 'binding',
            bindType: 'email',
            codeRequested: step === 'binding-code',
            contact: step === 'binding-code' ? 'person@example.com' : undefined,
          };
    loginHook.value.loginState = state;
    loginHook.value.clearError = vi.fn(() => {
      loginHook.value.errorCode = null;
      loginHook.value.retryAt = undefined;
    });
    const view = render(<LoginPage />);
    const value = step === 'binding-contact' ? 'person@example.com' : '123456';
    fireEvent.change(screen.getByTestId('login-input'), { target: { value } });
    loginHook.value.errorCode = 'RATE_LIMITED';
    loginHook.value.retryAt = Date.now() + 120_000;
    view.rerender(<LoginPage />);
    fireEvent.click(screen.getByTestId(entry));
    expect(loginHook.value.clearError).toHaveBeenCalledOnce();
    expect(loginHook.value.dispatch).not.toHaveBeenCalled();
    expect(loginHook.value.loginState).toBe(state);
    view.rerender(<LoginPage />);
    const input = screen.getByTestId('login-input') as HTMLInputElement;
    expect(input.value).toBe(value);
    fireEvent.submit(input.closest('form')!);
    expect(loginHook.value.dispatch).toHaveBeenCalledWith(
      step === 'verification-code'
        ? { type: 'verify-code', kind: 'email', identifier: 'person@example.com', code: value }
        : step === 'binding-code'
          ? { type: 'verify-binding', contact: 'person@example.com', code: value }
          : { type: 'request-binding-code', contact: value },
    );
  });

  it('still resets when rate-limited initialization has no form to resume', () => {
    loginHook.value.errorCode = 'RATE_LIMITED';
    loginHook.value.loginState = { step: 'error', code: 'RATE_LIMITED', recoverTo: 'identifier' };
    render(<LoginPage />);
    fireEvent.click(screen.getByTestId('login-credential-recheck'));
    expect(loginHook.value.dispatch).toHaveBeenCalledWith({ type: 'reset' });
  });

  it('distinguishes rate limits, shows the server deadline and offers private logs', async () => {
    const view = mountWithError('RATE_LIMITED');
    expect(screen.getByText(zhCN.login.rateLimit.unknownWait)).toBeTruthy();
    const retryAt = Date.now() + 120_000;
    loginHook.value.retryAt = retryAt;
    view.rerender(<LoginPage />);
    expect(
      screen.getByText(
        i18next.t('login.rateLimit.retryAt', {
          time: new Date(retryAt).toLocaleString('zh-CN'),
        }),
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId('login-error-retry'));
    expect(screen.getByText(zhCN.login.rateLimit.support)).toBeTruthy();
    expect(screen.queryByText(zhCN.credentialStore.dialog.stepRestartMac)).toBeNull();
    fireEvent.click(screen.getByText(zhCN.credentialStore.dialog.openLogs));
    await waitFor(() => expect(window.electronAPI.openLogsDir).toHaveBeenCalledOnce());
  });

  it('preserves the local-mode guard across remounts with no hook-local error', () => {
    loginHook.value.errorCode = null;
    loginHook.value.loginState = {
      step: 'error',
      code: 'CREDENTIAL_STORE_UNAVAILABLE',
      recoverTo: 'identifier',
    };
    const first = render(<LoginPage />);
    expect(screen.queryByTestId('login-local-mode')).toBeNull();
    first.unmount();
    const second = render(<LoginPage />);
    expect(screen.queryByTestId('login-local-mode')).toBeNull();
    second.unmount();
    loginHook.value.loginState = { step: 'error', code: 'NETWORK_ERROR', recoverTo: 'identifier' };
    render(<LoginPage />);
    expect(screen.getByTestId('login-local-mode')).toBeTruthy();
  });
  it.each(['BROWSER_OPEN_FAILED', 'BROWSER_OPEN_TIMEOUT'])(
    'shows actionable local error %s',
    (code) => {
      mountWithError(code);
      expect(screen.getByTestId('login-error-text').textContent).toBe(zhErrors[code]);
      expect(zhErrors[code]).not.toBe(zhErrors.fallback);
    },
  );
  it('explains preserved sign-in and offers recovery when the saved credentials cannot be read', () => {
    loginHook.value.loginState = {
      step: 'error',
      code: 'CREDENTIAL_STORE_UNAVAILABLE',
      recoverTo: 'identifier',
    };
    render(<LoginPage />);
    expect(screen.getByText(zhCN.login.savedLoginPreserved)).toBeTruthy();
    expect(screen.getByText(zhCN.credentialStore.dialog.title)).toBeTruthy();
    expect(screen.getByTestId('login-error-text').textContent).toBe(
      zhErrors.CREDENTIAL_STORE_UNAVAILABLE,
    );
    fireEvent.click(screen.getByTestId('login-error-retry'));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(loginHook.value.dispatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: zhCN.credentialStore.dialog.confirm }));
    fireEvent.click(screen.getByTestId('login-credential-recheck'));
    expect(loginHook.value.dispatch).toHaveBeenCalledWith({ type: 'reset' });
  });

  it('replaces the verification form with help even for a hook-local storage error', () => {
    mountWithError('CREDENTIAL_STORE_UNAVAILABLE');
    expect(screen.getByTestId('login-panel-error')).toBeTruthy();
    expect(screen.queryByTestId('login-input')).toBeNull();
    expect(screen.queryByTestId('login-local-mode')).toBeNull();
  });

  it.each(['darwin', 'win32', 'linux'])(
    'provides platform-specific help and a private diagnostic exit on %s',
    async (platform) => {
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        value: {
          platform,
          openLogsDir: vi.fn(async () => ({ success: true })),
        },
      });
      mountWithError('CREDENTIAL_STORE_UNAVAILABLE');
      fireEvent.click(screen.getByTestId('login-error-retry'));
      const copy = zhCN.credentialStore.dialog;
      expect(Boolean(screen.queryByText(copy.stepMacKeychain))).toBe(platform === 'darwin');
      expect(Boolean(screen.queryByText(copy.stepLinuxKeyring))).toBe(platform === 'linux');
      expect(
        screen.getByText(platform === 'darwin' ? copy.stepRestartMac : copy.stepRestart),
      ).toBeTruthy();
      expect(screen.getByText(copy.stepSupport)).toBeTruthy();
      expect(screen.getByText(copy.preserveData)).toBeTruthy();
      expect(screen.getByText('CREDENTIAL_STORE_UNAVAILABLE')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: copy.openLogs }));
      await waitFor(() => expect(window.electronAPI.openLogsDir).toHaveBeenCalledTimes(1));
      expect(screen.getByRole('alertdialog')).toBeTruthy();
    },
  );

  it.each(['reject', 'result'])(
    'keeps useful guidance if opening logs fails via %s',
    async (failure) => {
      vi.mocked(window.electronAPI.openLogsDir).mockImplementation(async () => {
        if (failure === 'reject') throw new Error('private path must not be shown');
        return { success: false, error: 'private path must not be shown' };
      });
      mountWithError('CREDENTIAL_STORE_UNAVAILABLE');
      fireEvent.click(screen.getByTestId('login-error-retry'));
      fireEvent.click(screen.getByRole('button', { name: zhCN.credentialStore.dialog.openLogs }));
      expect(await screen.findByText(zhCN.credentialStore.dialog.logsFailed)).toBeTruthy();
      expect(screen.queryByText('private path must not be shown')).toBeNull();
    },
  );

  for (const code of NAMED_CODES) {
    it(`error-copy ${code} 文案 verbatim`, async () => {
      expect(zhErrors[code], `zh-CN 缺 login.errors.${code}`).toBeTruthy();
      const wire = await wireErrorCode(code);
      expect(wire).toBe(code); // 真实 client 原样透传 wire code
      mountWithError(wire);
      const errorText = screen.getByTestId('login-error-text');
      expect(errorText.textContent).toBe(zhErrors[code]);
      expect(errorText.getAttribute('style')).toContain('var(--login-error-fg)');
    });
  }

  for (const code of FALLBACK_CODES) {
    it(`error-copy ${code} 落兜底文案(登录失败,请稍后重试)`, async () => {
      expect(zhErrors[code]).toBeUndefined(); // 无专属 key 才走兜底
      const wire = await wireErrorCode(code);
      expect(wire).toBe(code);
      mountWithError(wire);
      expect(screen.getByTestId('login-error-text').textContent).toBe(zhErrors.fallback);
    });
  }

  it('error-copy 视觉切换:错误态输入框边框转 error 色(§4.1 error 态)', async () => {
    mountWithError('INVALID_CODE');
    const input = screen.getByTestId('login-input');
    expect(input.getAttribute('style')).toContain('var(--login-error-fg)');
  });
});
