// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import {
  CindyAuthClient,
  reduceAuthFlow,
  ssoOrgDiscoveryToMethods,
  type AuthFlowState,
} from '@cindy/auth-client';
import { createScenarioFetch } from '@cindy/auth-client/fixtures';
import { __testing as ssoOrgHistoryTesting } from '@/state/ssoOrgHistory';

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
    dispatchWithResult: vi.fn(async () => ({ success: true, code: null })),
    clearError: vi.fn(),
  },
}));
const scrollIntoViewMock = vi.hoisted(() => vi.fn());

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

async function realmConfirmationState(targetRegion: 'cn' | 'global') {
  const identifier = await identifierState('providers:both');
  if (identifier.step !== 'identifier') throw new Error('expected identifier');
  const client = scenarioClient('sso:single', targetRegion);
  const discovery = await client.discoverSsoOrg('example-corp');
  return reduceAuthFlow(identifier, {
    type: 'realm-switch-required',
    targetRegion,
    providers: identifier.providers,
    methods: ssoOrgDiscoveryToMethods(discovery),
  });
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
  window.localStorage.clear();
  ssoOrgHistoryTesting.reset();
  scrollIntoViewMock.mockClear();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoViewMock,
  });
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
    // 面板 440 → 500(新稿 700:791):增高 60 = 面板内「跳过登录」容器高
    expect(panel.style.height).toBe('500px');
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

  it('identifier 视图:协议行挂在登录组内(y=642),「跳过登录」文字链在面板内 y=430', async () => {
    mount(await identifierState('providers:both'));
    // 协议同意行(consent PR):登录组坐标 y=642(面板 500 后圆钮行下方 22 设计px),radio 初始未勾选
    const row = screen.getByTestId('login-consent-row');
    expect(screen.getByTestId('login-group').contains(row)).toBe(true);
    expect(row.style.top).toBe('642px');
    expect(screen.getByTestId('login-consent-radio').getAttribute('aria-checked')).toBe('false');
    // 「跳过登录」= 面板内文字按钮(新稿 705:1068 布局槽 680×60 @y430,文本 24px 下划线),
    // 取代旧游客圆钮。槽负责居中定位,按钮承接点击(热区断言见下一条用例)。
    const slot = screen.getByTestId('login-skip-entry-slot');
    const skip = screen.getByTestId('login-skip-entry');
    expect(screen.getByTestId('login-panel-identifier').contains(slot)).toBe(true);
    expect(slot.contains(skip)).toBe(true);
    expect(slot.style.left).toBe('0px');
    expect(slot.style.top).toBe('430px');
    expect(slot.style.width).toBe('680px');
    expect(slot.style.height).toBe('60px');
    expect(skip.style.fontSize).toBe('24px');
    expect(skip.className).toContain('underline');
    // 圆钮行不再有游客圆钮;identifier 步不渲染 footer(仅 error 步保留逃生入口)
    expect(screen.queryByTestId('login-social-guest')).toBeNull();
    expect(screen.queryByTestId('login-stage-footer')).toBeNull();
    expect(screen.queryByTestId('login-local-mode')).toBeNull();
  });

  it('「跳过登录」槽与错误提示槽首尾相接且不重叠(error 出现不推移跳过入口)', async () => {
    mount(await identifierState('providers:both'), { errorCode: 'NETWORK_ERROR' });
    const error = screen.getByTestId('login-error-text');
    const slot = screen.getByTestId('login-skip-entry-slot');
    // error_text 680×50 @y380(新稿 705:1067)→ 底 430 = 跳过槽顶,零重叠
    expect(error.style.top).toBe('380px');
    expect(error.style.height).toBe('50px');
    expect(slot.style.top).toBe('430px');
    expect(parseFloat(error.style.top) + parseFloat(error.style.height)).toBe(
      parseFloat(slot.style.top),
    );
  });

  it('「跳过登录」= 文字按钮:统一 #6F6F6F 不随 hover/pressed 变色(用户拍板 2026-07-27)', async () => {
    mount(await identifierState('providers:both'));
    const skip = screen.getByTestId('login-skip-entry');
    // 颜色走 --login-secondary-text(双模同值 #6F6F6F),不是 link 族 --login-link-text
    const style = skip.getAttribute('style') ?? '';
    expect(style).toContain('--login-secondary-text');
    expect(style).not.toContain('--login-link-text');
    // 文字按钮 ≠ 文字链接:不带 link 族 hover/pressed 变色类
    expect(skip.className).not.toContain('--login-link-hover');
    expect(skip.className).not.toContain('--login-link-pressed');
    // 反馈只保留下划线 + 指针形状
    expect(skip.className).toContain('underline');
    expect(skip.className).toContain('cursor-pointer');
  });

  it('「跳过登录」热区 = 文字宽 + 左右各 30 设计px,680×60 容器本身不可点', async () => {
    mount(await identifierState('providers:both'));
    const slot = screen.getByTestId('login-skip-entry-slot');
    const skip = screen.getByTestId('login-skip-entry');
    // 容器只做居中布局,不接点击
    expect(slot.style.pointerEvents).toBe('none');
    expect(slot.className).toContain('justify-center');
    // 按钮承接点击:宽度不写死(shrink-to-fit 随语言),靠左右 padding 30 扩热区,高占满槽
    expect(skip.style.pointerEvents).toBe('auto');
    expect(skip.style.width).toBe('');
    expect(skip.style.paddingLeft).toBe('30px');
    expect(skip.style.paddingRight).toBe('30px');
    expect(skip.style.height).toBe('60px');
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

  it('providers:cn-social → 圆钮行 = Apple + SSO(SSO 恒为行内最后一颗,游客圆钮已删)', async () => {
    mount(await identifierState('providers:cn-social'));
    const row = screen.getByTestId('login-social-row');
    expect(screen.getByTestId('login-social-apple')).toBeTruthy();
    expect(screen.queryByTestId('login-social-google')).toBeNull();
    // 新稿(700:796)圆钮行只剩 Apple + SSO 两颗:游客圆钮由面板内「跳过登录」文字链取代
    expect(row.children.length).toBe(2);
    expect(row.firstElementChild).toBe(screen.getByTestId('login-social-apple'));
    expect(row.lastElementChild).toBe(screen.getByTestId('login-social-sso'));
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
    expect(document.activeElement).toBe(input);
    expect((screen.getByTestId('login-sso-org-continue') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('login.ssoOrgHint')).toBeTruthy();
  });

  it('sso-org 填写态:直接派发 discover-sso-org，不在查询前弹确认', async () => {
    mount(await identifierState('providers:both'));
    fireEvent.click(screen.getByTestId('login-social-sso'));
    const input = screen.getByTestId('login-sso-org-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'example-corp' } });
    const continueBtn = screen.getByTestId('login-sso-org-continue') as HTMLButtonElement;
    expect(continueBtn.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(continueBtn);
    });
    expect(loginHook.value.dispatch).toHaveBeenCalledWith({
      type: 'discover-sso-org',
      org: 'example-corp',
    });
    expect(screen.queryByText('login.realmConsent.title')).toBeNull();
  });

  it('单条成功历史进入 SSO 子视图时直接回填', async () => {
    window.localStorage.setItem(
      ssoOrgHistoryTesting.storageKey,
      JSON.stringify({ version: 1, entries: ['remembered-corp'] }),
    );
    ssoOrgHistoryTesting.reset();
    mount(await identifierState('providers:both'));
    fireEvent.click(screen.getByTestId('login-social-sso'));
    expect((screen.getByTestId('login-sso-org-input') as HTMLInputElement).value).toBe(
      'remembered-corp',
    );
    expect(screen.queryByTestId('login-sso-org-history-list')).toBeNull();
  });

  it('多条成功历史默认折叠，激活输入框后展示列表并支持选择', async () => {
    window.localStorage.setItem(
      ssoOrgHistoryTesting.storageKey,
      JSON.stringify({
        version: 1,
        entries: ['recent-corp', 'older.example'],
      }),
    );
    ssoOrgHistoryTesting.reset();
    mount(await identifierState('providers:both'));
    fireEvent.click(screen.getByTestId('login-social-sso'));
    const input = screen.getByTestId('login-sso-org-input') as HTMLInputElement;
    expect(input.value).toBe('recent-corp');
    expect(document.activeElement).not.toBe(input);
    expect(screen.queryByTestId('login-sso-org-history-list')).toBeNull();
    fireEvent.focus(input);
    const historyList = screen.getByTestId('login-sso-org-history-list');
    const panel = screen.getByTestId('login-panel-sso-org');
    expect(panel.contains(historyList)).toBe(false);
    expect(Number.parseFloat(historyList.style.left)).toBe(
      Number.parseFloat(input.style.left),
    );
    expect(Number.parseFloat(historyList.style.width)).toBe(
      Number.parseFloat(input.style.width),
    );
    expect(Number.parseFloat(historyList.style.top)).toBe(
      Number.parseFloat(input.style.top) + Number.parseFloat(input.style.height) + 8,
    );
    expect(
      Number.parseFloat(historyList.style.top) + Number.parseFloat(historyList.style.maxHeight),
    ).toBeLessThanOrEqual(
      Number.parseFloat(panel.style.height),
    );
    expect(historyList.className).toContain('overflow-y-auto');
    expect(historyList.className).toContain('[scrollbar-width:none]');
    expect(historyList.className).toContain('[&::-webkit-scrollbar]:hidden');
    fireEvent.click(screen.getByTestId('login-sso-org-history-option-1'));
    expect(input.value).toBe('older.example');
    expect(screen.queryByTestId('login-sso-org-history-list')).toBeNull();
  });

  it('action 结束后刷新 AuthContext 在 discovery 成功点写入的历史', async () => {
    const dispatch = vi.fn(async () => {
      window.localStorage.setItem(
        ssoOrgHistoryTesting.storageKey,
        JSON.stringify({
          version: 1,
          entries: ['Example-Corp', 'older-corp'],
        }),
      );
      return false;
    });
    mount(await identifierState('providers:both'), { dispatch });
    fireEvent.click(screen.getByTestId('login-social-sso'));
    fireEvent.change(screen.getByTestId('login-sso-org-input'), {
      target: { value: 'Example-Corp' },
    });
    fireEvent.click(screen.getByTestId('login-sso-org-continue'));
    await waitFor(() => {
      fireEvent.focus(screen.getByTestId('login-sso-org-input'));
      expect(screen.getByTestId('login-sso-org-history-option-0').textContent).toBe(
        'Example-Corp',
      );
    });
  });

  it('多条历史支持方向键选择、保持高亮项可见并用 Escape 关闭', async () => {
    window.localStorage.setItem(
      ssoOrgHistoryTesting.storageKey,
      JSON.stringify({
        version: 1,
        entries: ['recent-corp', 'older.example', 'third-corp', 'fourth-corp'],
      }),
    );
    ssoOrgHistoryTesting.reset();
    mount(await identifierState('providers:both'));
    fireEvent.click(screen.getByTestId('login-social-sso'));
    const input = screen.getByTestId('login-sso-org-input') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(scrollIntoViewMock).toHaveBeenLastCalledWith({ block: 'nearest' });
    expect(scrollIntoViewMock.mock.instances.at(-1)).toBe(
      screen.getByTestId('login-sso-org-history-option-2'),
    );
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('third-corp');
    fireEvent.focus(input);
    expect(screen.getByTestId('login-sso-org-history-list')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('login-sso-org-history-list')).toBeNull();
  });

  it('组织区域与安装区域不一致时才显示确认，确认或取消走独立 action', async () => {
    mount(await realmConfirmationState('global'));
    expect(screen.getByText('login.realmConsent.title')).toBeTruthy();
    const bodyText = screen.getByText('login.realmConsent.bodyGlobal');
    const body = bodyText.closest('#login-consent-dialog-body') as HTMLElement;
    expect(body).toBeTruthy();
    expect(body.style.fontSize).toBe('26px');
    expect(body.style.lineHeight).toBe('40px');
    expect(body.style.color).toBe('var(--login-secondary-text)');
    expect(body.className).toContain('whitespace-pre-line');

    fireEvent.click(screen.getByText('login.realmConsent.agree'));
    expect(loginHook.value.dispatch).toHaveBeenCalledWith({
      type: 'confirm-sso-realm',
    });

    fireEvent.click(screen.getByText('login.realmConsent.disagree'));
    expect(loginHook.value.dispatch).toHaveBeenCalledWith({
      type: 'cancel-sso-realm',
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
