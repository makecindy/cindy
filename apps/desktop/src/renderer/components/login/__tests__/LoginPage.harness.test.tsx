// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import {
  CindyAuthClient,
  reduceAuthFlow,
  ssoOrgDiscoveryToMethods,
  type AuthFlowState,
} from '@cindy/auth-client';
import { createScenarioFetch } from '@cindy/auth-client/fixtures';

/**
 * PR1 harness 场景驱动渲染单测(implementation-plan Step 2 WHAT3 + 附录 A)。
 *
 * 状态构造走全真链:真实 CindyAuthClient + 附录 A scenario fetch(zod schema
 * 全真)→ reduceAuthFlow 得到 AuthFlowState,再经 mock useLogin 注入渲染层
 * (renderer 单测无 main 进程,注入点与现网一致:loginState 即 AuthFlowState)。
 * 同文件承载 state-manifest pr1 slice 的 tests 映射锚(测试名 = manifest testId)。
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
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../../shared/brandRegion', () => ({
  CURRENT_CINDY_REGION: 'cn',
  CURRENT_APP_ID: 'com.xd.cindycn',
}));
vi.mock('@/hooks/useLogin', () => ({ useLogin: () => loginHook.value }));
vi.mock('@/components/title-bar/WindowControls', () => ({ WindowControls: () => null }));

import { LoginPage } from '../LoginPage';
import { LoginBrandStage } from '../LoginBrandStage';
import { desktopScale, sloganShiftX } from '../loginScale';

function scenarioClient(scenario: string, region: 'cn' | 'global' = 'cn') {
  return new CindyAuthClient({
    baseUrl: 'https://auth.scenario.invalid',
    region,
    deviceId: 'pr1-harness',
    clientType: 'desktop',
    fetch: createScenarioFetch(scenario, { region })!,
  });
}

async function identifierState(scenario: string, region: 'cn' | 'global' = 'cn') {
  const providers = await scenarioClient(scenario, region).getProviders();
  return reduceAuthFlow(null, { type: 'providers-loaded', providers });
}

async function methodChoiceState(scenario: string, email = 'user@example-corp.com') {
  const client = scenarioClient(scenario);
  const methods = await client.discover(email);
  return reduceAuthFlow(null, { type: 'discovery-loaded', email, methods });
}

async function ssoOrgListState(org = 'example-corp') {
  const client = scenarioClient('sso:single');
  const discovery = await client.discoverSsoOrg(org);
  // sso-org 入口路径无邮箱上下文(LoginPage renderMethodChoice fromSsoOrg 分支)
  return reduceAuthFlow(null, {
    type: 'discovery-loaded',
    email: '',
    methods: ssoOrgDiscoveryToMethods(discovery),
  });
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
  // PR2b 所有权拆分:品牌视觉层(背景/立绘/字标/Slogan)迁入 LoginBrandStage
  // (App 级 overlay 唯一渲染者),harness 按 App 实际组合渲染两者——
  // wave4 视觉五维断言目标不变,testId 与几何期望逐字保留。
  return render(
    <>
      <LoginBrandStage />
      <LoginPage />
    </>,
  );
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
});

/* ── wave4 视觉五维(brand-background / panel-border / wordmark / slogan) ── */
describe('wave4 stage 视觉', () => {
  it('brand-background 纯平白底(消费 login-bg-base,无渐变;2026-07-22 对齐 PR #104,viewport 锚定)', async () => {
    mount(await identifierState('providers:both'));
    const root = screen.getByTestId('login-stage-root');
    const bg = root.firstElementChild as HTMLElement;
    expect(bg.style.backgroundColor).toContain('var(--login-bg-base)');
    // 2026-07-22 用户拍板对齐 PR #104:撤 wave4 双红渐变,背景纯平不含任何 gradient
    expect(bg.style.backgroundImage).not.toContain('gradient');
    // 背景层挂在 stage 之外的 viewport 层(inset-0),非 1819×2098 画布内
    expect(bg.className).toContain('inset-0');
  });

  it('登录面板带 wave4 1px inside 描边 token(368:1383)', async () => {
    mount(await identifierState('providers:both'));
    const panel = screen.getByTestId('login-panel-identifier');
    expect(panel.style.boxShadow).toContain('inset 0 0 0 1px var(--login-panel-border)');
    expect(panel.style.borderRadius).toBe('36px');
    expect(panel.style.width).toBe('680px');
    expect(panel.style.height).toBe('440px');
  });

  it('字标为 wave4 黑红版内层几何 423×145 @(698,1046)(368:1381)', async () => {
    mount(await identifierState('providers:both'));
    const wordmark = document.querySelector('img[src*="wordmark"]') as HTMLImageElement;
    expect(wordmark).toBeTruthy();
    expect(wordmark.style.left).toBe('698px');
    expect(wordmark.style.top).toBe('1046px');
    expect(wordmark.style.width).toBe('423px');
    expect(wordmark.style.height).toBe('145px');
  });

  it('SLOGAN 为 #2A2828 矢量版资产,几何 453.22×129.12 @(1194,866)(368:1394)', async () => {
    mount(await identifierState('providers:both'));
    const slogan = screen.getByTestId('login-slogan') as HTMLImageElement;
    expect(slogan.src).toContain('slogan');
    expect(slogan.style.left).toBe('1194px');
    expect(slogan.style.top).toBe('866px');
    expect(slogan.style.width).toBe('453.22px');
    expect(slogan.style.height).toBe('129.12px');
  });

  it('slogan 窄窗左移只平移不缩放(demo applyDesktopScale 公式)', () => {
    const { scale } = desktopScale(560, 800);
    const shift = sloganShiftX(560, scale);
    expect(shift).toBeLessThan(0);
    expect(sloganShiftX(1920, desktopScale(1920, 800).scale)).toBe(0);
  });
});

/* ── identifier 态系(附录 A providers 行) ── */
describe('identifier 态(附录 A providers 场景)', () => {
  it('providers:both → 无 tabs,区域定形态(测试构建=cn 默认→手机;2026-07-21 分区互斥拍板)', async () => {
    mount(await identifierState('providers:both'));
    expect(screen.queryByTestId('login-id-tabs')).toBeNull();
    expect((screen.getByTestId('login-input') as HTMLInputElement).placeholder).toBe(
      'login.phonePlaceholder',
    );
    expect(screen.getByTestId('login-continue-button')).toBeTruthy();
    expect(screen.getByTestId('login-social-row')).toBeTruthy();
  });

  it('identifier 视图:协议行挂在登录组内(y=582),游客圆钮取代 footer 入口', async () => {
    mount(await identifierState('providers:both'));
    // 协议同意行(consent PR):登录组坐标 y=582(圆钮行下方 22 设计px),radio 初始未勾选
    const row = screen.getByTestId('login-consent-row');
    expect(screen.getByTestId('login-group').contains(row)).toBe(true);
    expect(row.style.top).toBe('582px');
    expect(screen.getByTestId('login-consent-radio').getAttribute('aria-checked')).toBe('false');
    // 游客入口 = 社交行最后一颗人形圆钮;identifier 步不再渲染 footer(仅 error 步保留逃生入口)
    const socialRow = screen.getByTestId('login-social-row');
    expect(socialRow.lastElementChild).toBe(screen.getByTestId('login-social-guest'));
    expect(screen.queryByTestId('login-stage-footer')).toBeNull();
    expect(screen.queryByTestId('login-local-mode')).toBeNull();
  });

  it('providers:phone-only → 无 tabs,placeholder 为手机号', async () => {
    mount(await identifierState('providers:phone-only'));
    expect(screen.queryByTestId('login-id-tabs')).toBeNull();
    expect((screen.getByTestId('login-input') as HTMLInputElement).placeholder).toBe(
      'login.phonePlaceholder',
    );
  });

  it('providers:email-only → 无 tabs,placeholder 为邮箱', async () => {
    mount(await identifierState('providers:email-only'));
    expect(screen.queryByTestId('login-id-tabs')).toBeNull();
    expect((screen.getByTestId('login-input') as HTMLInputElement).placeholder).toBe(
      'login.emailPlaceholder',
    );
  });

  it('providers:cn-social → 圆钮行 = Apple + SSO + 游客(游客恒为行内最后一颗,SSO 次末)', async () => {
    mount(await identifierState('providers:cn-social'));
    const row = screen.getByTestId('login-social-row');
    expect(screen.getByTestId('login-social-apple')).toBeTruthy();
    expect(screen.queryByTestId('login-social-google')).toBeNull();
    // consent PR:游客人形圆钮追加为行内最后一颗(figma 600:655 顺序 Apple→SSO→游客)
    expect(row.lastElementChild).toBe(screen.getByTestId('login-social-guest'));
    expect(row.children[row.children.length - 2]).toBe(screen.getByTestId('login-social-sso'));
  });

  it('providers:global-social → 圆钮行 = Apple + Google + SSO,region=global(不冒充构建区域)', async () => {
    const state = await identifierState('providers:global-social', 'global');
    expect(state.step === 'identifier' && state.providers.region).toBe('global');
    mount(state);
    expect(screen.getByTestId('login-social-apple')).toBeTruthy();
    expect(screen.getByTestId('login-social-google')).toBeTruthy();
    expect(screen.getByTestId('login-social-sso')).toBeTruthy();
  });

  it('输入框状态视觉:default 细体/filled 粗体 active 边/error 边(figma §4.1)', async () => {
    mount(await identifierState('providers:both'));
    const input = screen.getByTestId('login-input') as HTMLInputElement;
    // autoFocus → focus 态即 Bold(§4.1 focus/Activate);blur 且空值 → 回落 default 细体
    fireEvent.blur(input);
    expect(input.style.fontWeight).toBe('400');
    expect(input.getAttribute('style') ?? '').toContain('--login-control-border');
    cleanup();
    // filled:受控 value 非空 → Bold + active 边
    const filledState = await identifierState('providers:both');
    mount(filledState);
    const input2 = screen.getByTestId('login-input') as HTMLInputElement;
    // 桌面手机形态不做客户端 +86/号段清洗(#223 仅移动端做 cnPhone 本地拦截),
    // 输入原样受控;filled 视觉断言用数字号码。
    fireEvent.change(input2, { target: { value: '13800138000' } });
    expect(input2.style.fontWeight).toBe('700');
    expect(input2.getAttribute('style') ?? '').toContain('--login-control-border-active');
    cleanup();
    // error:errorCode 注入 → error 边
    mount(await identifierState('providers:both'), { errorCode: 'INVALID_PARAMS' });
    const input3 = screen.getByTestId('login-input') as HTMLInputElement;
    expect(input3.getAttribute('style') ?? '').toContain('--login-error-fg');
    expect(screen.getByTestId('login-error-text')).toBeTruthy();
  });
});

/* ── ssoOrgMode 子视图(sso-org empty/filled/list) ── */
describe('ssoOrgMode 子视图', () => {
  it('sso-org 空态:圆钮行 SSO 进入,企业 ID 输入 + 继续禁用 + 帮助行', async () => {
    mount(await identifierState('providers:both'));
    fireEvent.click(screen.getByTestId('login-social-sso'));
    expect(screen.getByTestId('login-panel-sso-org')).toBeTruthy();
    expect(screen.getByText('login.ssoOrgTitle')).toBeTruthy();
    const input = screen.getByTestId('login-sso-org-input') as HTMLInputElement;
    expect(input.placeholder).toBe('login.ssoOrgPlaceholder');
    expect((screen.getByTestId('login-sso-org-continue') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('login.ssoOrgHint')).toBeTruthy();
  });

  it('sso-org 填写态:输入企业 ID 后继续可用,提交派发 discover-sso-org', async () => {
    mount(await identifierState('providers:both'));
    fireEvent.click(screen.getByTestId('login-social-sso'));
    const input = screen.getByTestId('login-sso-org-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'example-corp' } });
    const continueBtn = screen.getByTestId('login-sso-org-continue') as HTMLButtonElement;
    expect(continueBtn.disabled).toBe(false);
    fireEvent.click(continueBtn);
    expect(loginHook.value.dispatch).toHaveBeenCalledWith({
      type: 'discover-sso-org',
      org: 'example-corp',
    });
  });

  it('sso-org 连接列表态:单 connection 方式行 @148 + ssoOrgDetected 副标题', async () => {
    mount(await ssoOrgListState());
    const panel = screen.getByTestId('login-panel-method-choice');
    expect(panel).toBeTruthy();
    expect(screen.getByText('login.ssoOrgDetected')).toBeTruthy();
    const rows = panel.querySelectorAll('[data-testid^="login-method-sso-"]');
    expect(rows.length).toBe(1);
    expect((rows[0] as HTMLElement).style.top).toBe('148px');
    expect(screen.getByText('login.enterpriseLogin')).toBeTruthy();
  });
});

/* ── method-choice(附录 A sso 场景;方式行精修归 PR2a) ── */
describe('method-choice(附录 A sso 场景)', () => {
  it('sso:single → 单 connection 企业行 + 个人身份行', async () => {
    mount(await methodChoiceState('sso:single'));
    const panel = screen.getByTestId('login-panel-method-choice');
    expect(panel.querySelectorAll('[data-testid^="login-method-sso-"]').length).toBe(1);
    expect(screen.getByTestId('login-method-personal')).toBeTruthy();
  });

  it('sso:multi → 多 connection 行', async () => {
    mount(await methodChoiceState('sso:multi'));
    const panel = screen.getByTestId('login-panel-method-choice');
    expect(
      panel.querySelectorAll('[data-testid^="login-method-sso-"]').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('sso:required → 显示「该企业要求通过 SSO 登录」且无个人身份行', async () => {
    mount(await methodChoiceState('sso:required'));
    expect(screen.getByText('login.ssoRequired')).toBeTruthy();
    expect(screen.queryByTestId('login-method-personal')).toBeNull();
  });
});

/* ── preparing 伪态 ── */
describe('preparing 伪态', () => {
  it('loginState 未就绪 → preparing 面板 + 64 loading 环 @(308,193)', () => {
    mount(null);
    expect(screen.getByTestId('login-panel-preparing')).toBeTruthy();
    expect(screen.getByText('login.preparing')).toBeTruthy();
    expect(screen.getByText('login.preparingSubtitle')).toBeTruthy();
    const ring = screen.getByRole('status', { name: 'login.working' });
    expect(ring.className).toContain('animate-spin');
    expect(ring.style.left).toBe('308px');
    expect(ring.style.top).toBe('193px');
  });
});

/* ── SC-SOC-7:圆钮 in-flight 防重复点击 guard(行为层,零视觉变化;§10 拍板砍视觉态不砍防重复行为) ── */
describe('SC-SOC-7 圆钮 in-flight guard', () => {
  it('isLoading=true 时点 Apple 圆钮 → 不派发 start-browser(no-op,防重复发起)', async () => {
    mount(await identifierState('providers:cn-social'), { isLoading: true });
    fireEvent.click(screen.getByTestId('login-social-apple'));
    expect(loginHook.value.dispatch).not.toHaveBeenCalled();
  });

  it('isLoading=false 且已勾选协议时点 Apple 圆钮 → 正常派发 start-browser(social, apple)', async () => {
    mount(await identifierState('providers:cn-social'), { isLoading: false });
    // consent PR:个人链路先过协议门,勾选 radio 后点击直接派发(未勾选路径见 consent 专测)
    fireEvent.click(screen.getByTestId('login-consent-radio'));
    fireEvent.click(screen.getByTestId('login-social-apple'));
    expect(loginHook.value.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'start-browser',
        kind: 'social',
        providerOrConnectionId: 'apple',
      }),
    );
  });

  it('isLoading=true 时点 SSO 圆钮 → 不进入 ssoOrgMode、不 clearError(no-op)', async () => {
    mount(await identifierState('providers:cn-social'), { isLoading: true });
    fireEvent.click(screen.getByTestId('login-social-sso'));
    expect(screen.queryByTestId('login-panel-sso-org')).toBeNull();
    expect(loginHook.value.clearError).not.toHaveBeenCalled();
  });
});
