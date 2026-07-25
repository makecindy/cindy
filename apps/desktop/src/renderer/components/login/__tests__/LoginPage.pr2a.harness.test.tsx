// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CindyAuthClient,
  reduceAuthFlow,
  type AuthFlowState,
  type VerificationKind,
} from '@cindy/auth-client';
import { createScenarioFetch } from '@cindy/auth-client/fixtures';

/**
 * PR2a harness 场景驱动渲染单测(implementation-plan Step 3 + 附录 A)。
 *
 * 与 PR1 harness 同构:真实 CindyAuthClient + scenario fetch → reduceAuthFlow
 * 得 AuthFlowState → mock useLogin 注入。本文件承载 state-manifest pr2a slice
 * 状态行(state/style 维)的 tests 映射锚;copy 维(19 错误码表)在
 * LoginPage.errorCopy.harness.test.tsx(真 i18next 实例,文案 verbatim 断言)。
 *
 * t mock 带参数回显(`key#<param>`),便于断言倒计时秒数/插值目标——PR1 文件的
 * 纯 key mock 保持不动,两文件互不影响。
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

function scenarioClient(scenario: string, region: 'cn' | 'global' = 'cn') {
  return new CindyAuthClient({
    baseUrl: 'https://auth.scenario.invalid',
    region,
    deviceId: 'pr2a-harness',
    clientType: 'desktop',
    fetch: createScenarioFetch(scenario, { region })!,
  });
}

async function methodChoiceState(scenario: string, email = 'user@example-corp.com') {
  const methods = await scenarioClient(scenario).discover(email);
  return reduceAuthFlow(null, { type: 'discovery-loaded', email, methods });
}

async function verificationState(
  kind: VerificationKind = 'email',
  identifier = 'user@example-corp.com',
) {
  // 真实 requestCode 走 scenario fetch(前置成功),状态经真实 reducer 投影
  await scenarioClient('providers:both').requestCode(kind, identifier);
  return reduceAuthFlow(null, { type: 'code-requested', kind, identifier });
}

async function outcomeState(scenario: string) {
  const outcome = await scenarioClient(scenario).verifyCode(
    'email',
    'user@example-corp.com',
    '123456',
  );
  return reduceAuthFlow(null, { type: 'outcome', outcome });
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
  vi.useRealTimers();
});

/* ── window chrome 已移除(2026-07-22 用户拍板对齐 PR #104 纯平白底 + 无窗框描边) ── */
describe('window-chrome (removed, PR #104 对齐)', () => {
  it('窗框双描边 overlay 已移除:内外描边节点均不渲染;拖拽条独立层保留', async () => {
    mount(await methodChoiceState('sso:single'));
    // 撤 wave4 窗框双描边:两层描边 overlay 不再渲染(和 PR #104 无描边一致)
    expect(screen.queryByTestId('login-window-border-outer')).toBeNull();
    expect(screen.queryByTestId('login-window-border-inner')).toBeNull();
    // 拖拽条 overlay 与窗框描边无关,继续独立层 46px 不占文档流(附录 C §1.4 条4)
    const dragBar = screen.getByTestId('login-drag-bar');
    expect(dragBar.style.height).toBe('46px');
    expect(dragBar.className).toContain('absolute');
  });
});

/* ── method-choice 三变体(demo 呈现仲裁) ── */
describe('method-choice', () => {
  it('单 connection:企业行 158 + 个人行 278,副标题带邮箱与企业', async () => {
    mount(await methodChoiceState('sso:single'));
    expect(screen.getByTestId('login-panel-method-choice')).toBeTruthy();
    const sso = screen.getByTestId('login-method-sso-scenario-conn-1');
    expect(sso.style.top).toBe('158px');
    expect(sso.textContent).toContain('login.enterpriseLogin');
    expect(sso.textContent).toContain('login.enterpriseVia#Example SSO');
    const personal = screen.getByTestId('login-method-personal');
    expect(personal.style.top).toBe('278px');
    expect(personal.textContent).toContain('login.personalLogin');
    expect(personal.textContent).toContain('login.personalDesc');
    expect(screen.getByTestId('login-back-button')).toBeTruthy();
  });

  it('多 connection:双企业行 158/278,个人行按 demo 仲裁抑制(440 面板仅容两行)', async () => {
    mount(await methodChoiceState('sso:multi'));
    expect(screen.getByTestId('login-method-sso-scenario-conn-1').style.top).toBe('158px');
    expect(screen.getByTestId('login-method-sso-scenario-conn-2').style.top).toBe('278px');
    expect(screen.getByTestId('login-method-sso-scenario-conn-2').textContent).toContain(
      'login.enterpriseVia#Example SAML',
    );
    // demo methodChoicePanel:multi 时 emailCode 行恒不渲染(y=398+100 溢出面板)
    expect(screen.queryByTestId('login-method-personal')).toBeNull();
  });

  it('纯个人邮箱(无 SSO):单个人行 158,副标题=邮箱本身,无企业句无 hint', async () => {
    mount(await methodChoiceState('providers:both', 'personal@example.com'));
    const personal = screen.getByTestId('login-method-personal');
    expect(personal.style.top).toBe('158px');
    expect(screen.queryAllByTestId(/login-method-sso-/).length).toBe(0);
    expect(screen.getByText('personal@example.com')).toBeTruthy();
    expect(screen.queryByTestId('login-sso-required-hint')).toBeNull();
  });

  it('ssoRequired:强制 SSO 提示 380 位 countdown 样式,个人行抑制', async () => {
    mount(await methodChoiceState('sso:required'));
    const hint = screen.getByTestId('login-sso-required-hint');
    expect(hint.textContent).toBe('login.ssoRequired');
    expect(hint.style.top).toBe('380px');
    expect(hint.getAttribute('style')).toContain('var(--login-control-placeholder)');
    expect(screen.queryByTestId('login-method-personal')).toBeNull();
  });
});

/* ── verification-code 三态 + 倒计时接线(Step 3a) ── */
describe('verification-code', () => {
  it('empty:输入空 → 登录钮 disabled;phone 提交成功后入场即带 42s 倒计时', async () => {
    vi.useFakeTimers();
    // 全链时序:identifier(phone)提交 request-code 成功 → arm → 状态切 verification
    const providers = await scenarioClient('providers:both').getProviders();
    const identifierState = reduceAuthFlow(null, { type: 'providers-loaded', providers });
    const view = mount(identifierState);
    // tabs 已随分区互斥拍板(2026-07-21)移除:测试构建区域=cn,providers:both 直落手机形态
    // consent PR:先勾选协议 radio,提交才会派发 request-code(未勾选路径见 consent 专测)
    fireEvent.click(screen.getByTestId('login-consent-radio'));
    fireEvent.change(screen.getByTestId('login-input'), { target: { value: '13800138000' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('login-continue-button'));
    });
    loginHook.value = {
      ...loginHook.value,
      loginState: reduceAuthFlow(null, {
        type: 'code-requested',
        kind: 'phone',
        identifier: '13800138000',
      }),
    };
    view.rerender(<LoginPage />);

    expect((screen.getByTestId('login-input') as HTMLInputElement).value).toBe('');
    expect(screen.getByText('login.signIn').closest('button')?.disabled).toBe(true);
    // 倒计时首帧 42(247:1614 样式:placeholder 色无 underline 不可交互)
    const countdown = screen.getByTestId('login-resend-countdown');
    expect(countdown.textContent).toBe('login.resendCountdown#42');
    expect(countdown.getAttribute('style')).toContain('var(--login-control-placeholder)');
    expect(countdown.className).not.toContain('underline');
    // tick 后逐秒重算;到 0 切重发链接
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByTestId('login-resend-countdown').textContent).toBe(
      'login.resendCountdown#41',
    );
    act(() => vi.advanceTimersByTime(41_000));
    expect(screen.queryByTestId('login-resend-countdown')).toBeNull();
    expect(screen.getByTestId('login-resend-link')).toBeTruthy();
  });

  it('filled:6 位验证码 → 登录钮 enabled;重发链接为 underline 墨色 Text_link', async () => {
    mount(await verificationState());
    fireEvent.change(screen.getByTestId('login-input'), { target: { value: '123456' } });
    expect(screen.getByText('login.signIn').closest('button')?.disabled).toBe(false);
    const link = screen.getByTestId('login-resend-link');
    expect(link.className).toContain('underline');
    expect(link.getAttribute('style')).toContain('var(--login-link-text)');
    // hover/pressed 色态经 CSS 类走 token(U-9:underline/字号/字重不变)
    expect(link.className).toContain('var(--login-link-hover)');
    expect(link.className).toContain('var(--login-link-pressed)');
  });

  it('loading:isLoading → verifying 文案 + spinner wrapper 动画 + 钮 disabled', async () => {
    const state = await verificationState();
    mount(state, { isLoading: true });
    fireEvent.change(screen.getByTestId('login-input'), { target: { value: '123456' } });
    expect(screen.getByText('login.verifying')).toBeTruthy();
    const spin = screen.getByRole('status');
    expect(spin.className).toContain('animate-spin');
    expect(spin.className).toContain('motion-reduce:animate-none');
  });

  it('重发成功重置 / 失败保持(dispatch 返回值驱动 arm)', async () => {
    vi.useFakeTimers();
    const dispatch = vi.fn(async () => true);
    mount(await verificationState(), { dispatch });
    // 初始无倒计时(直接注入态未经历 request-code) → 链接可点
    await act(async () => {
      fireEvent.click(screen.getByTestId('login-resend-link'));
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'request-code', kind: 'email' }),
    );
    expect(screen.getByTestId('login-resend-countdown').textContent).toBe(
      'login.resendCountdown#42',
    );
    // 走到 0 → 再点一次但失败:不 arm,链接保持
    act(() => vi.advanceTimersByTime(42_000));
    dispatch.mockResolvedValueOnce(false);
    await act(async () => {
      fireEvent.click(screen.getByTestId('login-resend-link'));
    });
    expect(screen.queryByTestId('login-resend-countdown')).toBeNull();
    expect(screen.getByTestId('login-resend-link')).toBeTruthy();
  });
});

/* ── account-selection / binding / browser-redirect / error / completed ── */
describe('account-selection', () => {
  it('outcome select_account → 双身份行 148/268(demo 行样式,左 icon 企业默认形)', async () => {
    mount(await outcomeState('outcome:select-account'));
    expect(screen.getByTestId('login-panel-account-selection')).toBeTruthy();
    const rows = screen.getAllByTestId('login-method-row');
    expect(rows.length).toBe(2);
    expect(rows[0].style.top).toBe('148px');
    expect(rows[1].style.top).toBe('268px');
    expect(rows[0].textContent).toContain('Scenario User');
    expect(rows[0].textContent).toContain('login.personalAccount');
    expect(rows[1].textContent).toContain('Scenario Org User');
    expect(rows[1].textContent).toContain('Example Org');
  });
});

describe('binding', () => {
  it('contact 子态:bindType 标题 + 联系方式输入 + 发送验证码钮', async () => {
    mount(await outcomeState('outcome:binding-phone'));
    expect(screen.getByTestId('login-panel-binding')).toBeTruthy();
    expect(screen.getByText('login.binding.phoneTitle')).toBeTruthy();
    expect(screen.getByText('login.binding.phoneSubtitle')).toBeTruthy();
    const button = screen.getByText('login.sendCode').closest('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('login-input'), { target: { value: '13800138000' } });
    expect(button.disabled).toBe(false);
  });

  it('code 子态:居中验证码输入 + codeSentTo 提示(countdown 样式)+ 完成登录钮,无重发钮(照现网)', async () => {
    const contactState = reduceAuthFlow(null, {
      type: 'binding-code-requested',
      bindType: 'email',
      contact: 'bind@example.com',
    });
    mount(contactState);
    expect(screen.getByText('login.binding.emailTitle')).toBeTruthy();
    const sentTo = screen.getByTestId('login-binding-sent-to');
    expect(sentTo.textContent).toBe('login.codeSentTo#bind@example.com');
    expect(sentTo.getAttribute('style')).toContain('var(--login-control-placeholder)');
    expect(screen.queryByTestId('login-resend-link')).toBeNull();
    const button = screen.getByText('login.completeSignIn').closest('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('login-input'), { target: { value: '654321' } });
    expect(button.disabled).toBe(false);
  });
});

describe('browser-redirect / error / completed', () => {
  it('browser-redirect:等待标题 + label 副标题 + 64 环@158 + 取消钮', () => {
    mount(reduceAuthFlow(null, { type: 'browser-started', label: 'Example SSO' }));
    expect(screen.getByText('login.browserWaiting')).toBeTruthy();
    expect(screen.getByText('Example SSO')).toBeTruthy();
    const ring = screen.getByRole('status');
    expect(ring.style.top).toBe('158px');
    expect(ring.style.width).toBe('64px');
    expect(screen.getByText('login.cancel')).toBeTruthy();
  });

  it('error 全屏态:暂时无法登录 + 重试钮 + 错误码文案位(380)', () => {
    mount(
      reduceAuthFlow(null, {
        type: 'failed',
        code: 'AUTH_SERVICE_UNAVAILABLE',
        recoverTo: 'identifier',
      }),
    );
    expect(screen.getByText('login.unavailable')).toBeTruthy();
    expect(screen.getByTestId('login-error-retry')).toBeTruthy();
    const errorText = screen.getByTestId('login-error-text');
    expect(errorText.style.top).toBe('380px');
    expect(errorText.getAttribute('style')).toContain('var(--login-error-fg)');
  });

  it('completed:LoginPage return null(路由切主界面,demo completedPanel 仅示意)', async () => {
    const { container } = mount(await outcomeState('providers:both'));
    expect(container.innerHTML).toBe('');
  });
});
