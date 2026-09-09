import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  CindyAuthClient,
  reduceAuthFlow,
  ssoOrgDiscoveryToMethods,
  type AuthFlowState,
  type AuthRegion,
} from '@cindy/auth-client';
import { createScenarioFetch } from '@cindy/auth-client/fixtures';
import {
  LOGIN_CONTROL,
  LOGIN_SSO_ORG_HISTORY,
} from '../loginSkinLayout';
import { loginSizes } from '../../theme/tokens';

/**
 * PR4a 全登录态测试(SC-1 harness 真链 + SC-7 slice pr4a 状态行)。
 *
 * 形态 = 仓内既有双轨:
 *  - 状态构造走 harness 真链:真实 CindyAuthClient + createScenarioFetch
 *    (zod/错误归一全真)→ reduceAuthFlow 纯投影出 AuthFlowState,断言 step/字段;
 *  - 渲染层接线走读源码断言(login.tsx 依赖 expo/RN 运行时,node vitest 不加载),
 *    核对各状态分支消费新皮肤组件、testID 与 dispatch 措辞 verbatim 保留。
 */
vi.mock('expo-localization', () => ({
  getLocales: () => [{ languageTag: 'zh-CN' }],
}));

const loginSource = readFileSync(
  resolve(process.cwd(), 'app/(auth)/login.tsx'),
  'utf8',
);
const controlsSource = readFileSync(
  resolve(process.cwd(), 'src/components/LoginSkinControls.tsx'),
  'utf8',
);

function makeClient(scenario: string, region: AuthRegion = 'cn') {
  return new CindyAuthClient({
    baseUrl: 'https://auth.scenario.invalid',
    region,
    deviceId: 'pr4a-harness-device',
    clientType: 'mobile',
    fetch: createScenarioFetch(scenario, { region }),
  });
}

describe('loginSkin 全登录态(harness 真链 + 渲染层接线)', () => {
  it('keeps retained accounts reachable after the active session expires', () => {
    expect(loginSource).toContain(
      "import { AccountSwitcherSheet } from '@/session/AccountSwitcherSheet';",
    );
    expect(loginSource).toContain(
      'void auth.syncSavedAccounts().catch(() => undefined);',
    );
    expect(loginSource).toContain('auth.savedAccounts.length > 0');
    expect(loginSource).toContain('testID="login.accountSwitcher"');
    expect(loginSource).toContain("label={t('devices.list.accounts.title')}");
    expect(loginSource).toContain('<AccountSwitcherSheet');
    expect(loginSource).toContain('hasRunningTasks={hasRunningTasks}');
    expect(loginSource).toContain('remoteSessionStore.isSessionRunning(session.id)');
  });

  it('identifier:providers 真链加载→identifier 步骤,区域定形态(无 tabs)/输入/主按钮/圆钮行接线', async () => {
    const client = makeClient('providers:both');
    const providers = await client.getProviders();
    const state = reduceAuthFlow(null, { type: 'providers-loaded', providers });
    expect(state).toMatchObject({ step: 'identifier' });
    expect(providers.email).toBe(true);
    expect(providers.phone).toBe(true);
    // 渲染层:皮肤组件 + 既有 testID verbatim。
    // 双 tab 已按用户拍板(2026-07-21 分区互斥)移除:形态由构建区域确定性推导。
    expect(loginSource).not.toContain('LoginIdTabs');
    expect(loginSource).toContain(
      'resolveIdentifierMethod(AUTH_REGION, auth.loginState.providers)',
    );
    expect(loginSource).toContain('testID="login.identifierInput"');
    expect(loginSource).toContain('testID="login.continueButton"');
    expect(loginSource).toContain('testID="login.ssoEntryButton"');
    // Apple 圆钮(当前平台有可用路径时)计入行 count:apple 1 + nonAppleProviders + SSO 1
    expect(loginSource).toContain("socialProviders.includes('apple') ? 1 : 0");
    expect(loginSource).toContain('nonAppleProviders.length');
    expect(loginSource).toContain(
      "void auth.dispatchLoginAction({ type: 'discover', email: value })",
    );
  });

  it('identifier-phone:+86 固定前缀 + 11 位大陆手机号门槛 + E.164 提交', () => {
    expect(loginSource).toContain('<LoginSkinPhoneInput');
    expect(loginSource).toContain('prefix={CN_PHONE_PREFIX}');
    expect(loginSource).toContain('setIdentifier(sanitizeCnPhoneInput(text))');
    // 号段不合法本地拦截:2026-07-22 MT 起改为设计稿定义的红字错误态
    // (setIdentifierFormatError('phone') 后 return,不再静默 return),
    // 门槛判定 !isCompleteCnPhone(identifier) 与 E.164 提交保持不变。
    expect(loginSource).toContain('if (!isCompleteCnPhone(identifier)) {');
    expect(loginSource).toContain("setIdentifierFormatError('phone');");
    expect(loginSource).toContain('identifier: toCnE164(identifier),');
    expect(loginSource).toContain('!isCompleteCnPhone(identifier)');
    expect(controlsSource).toContain(
      'testID={testID ? `${testID}.shell` : undefined}',
    );
    expect(controlsSource).toContain('style={styles.phonePrefix}');
  });

  it('identifier-input:输入 focus/filled 切 controlBorderActive 边与 Bold 墨字(figma §4.1)', async () => {
    // global 圆钮组合真链兜底:providers 行为不因 region 漂移
    const providers = await makeClient(
      'providers:global-social',
      'global',
    ).getProviders();
    expect(providers.social).toEqual(['apple', 'google']);
    expect(controlsSource).toContain('const active = focused || filled;');
    expect(controlsSource).toContain('colors.login.controlBorderActive');
    expect(controlsSource).toContain(
      'active ? fontWeight.bold : fontWeight.regular',
    );
    expect(controlsSource).toContain('colors.login.controlPlaceholder');
    expect(controlsSource).toContain('colors.login.loginError');
  });

  it('method-choice:sso:single 真链→企业/个人双行,dispatch 措辞 verbatim', async () => {
    const client = makeClient('sso:single', 'global');
    const methods = await client.discover('user@example.com');
    const state = reduceAuthFlow(null, {
      type: 'discovery-loaded',
      email: 'user@example.com',
      methods,
    });
    expect(state.step).toBe('method-choice');
    if (state.step !== 'method-choice') throw new Error('unreachable');
    expect(state.methods.filter((m) => m.type === 'sso')).toHaveLength(1);
    expect(state.methods.some((m) => m.type === 'email_code')).toBe(true);
    expect(loginSource).toContain('<LoginMethodRow');
    expect(loginSource).toContain(
      'testID={`login.sso.${method.connectionId}`}',
    );
    expect(loginSource).toContain('testID="login.emailCodeButton"');
    expect(loginSource).toContain("type: 'start-sso',");
    expect(loginSource).toContain(
      'label: method.connectionName || method.orgName,',
    );
  });

  it('method-choice-multi:sso:multi 真链→多 connection 单行「以企业身份登录 · <name>」保留', async () => {
    const client = makeClient('sso:multi', 'global');
    const methods = await client.discover('user@example.com');
    const state = reduceAuthFlow(null, {
      type: 'discovery-loaded',
      email: 'user@example.com',
      methods,
    });
    if (state.step !== 'method-choice')
      throw new Error('expected method-choice');
    expect(state.methods.filter((m) => m.type === 'sso')).toHaveLength(2);
    // 多 connection 时标题拼接措辞 verbatim(单行,不拆副行)
    expect(loginSource).toContain(
      "`${loginText('enterpriseLogin')} · ${method.connectionName || method.orgName}`",
    );
  });

  it('method-choice-personal:纯邮箱 discovery→emailCode 主行(无 SSO 上下文)', async () => {
    const client = makeClient('providers:both');
    const methods = await client.discover('personal@example.com');
    const state = reduceAuthFlow(null, {
      type: 'discovery-loaded',
      email: 'personal@example.com',
      methods,
    });
    if (state.step !== 'method-choice')
      throw new Error('expected method-choice');
    expect(state.methods).toEqual([{ type: 'email_code' }]);
    // 无 SSO 时按钮文案退回「发送邮箱验证码」,个人身份措辞仅在有 SSO 时出现
    expect(loginSource).toContain(
      "ssoMethods.length > 0 ? 'personalLogin' : 'emailCode'",
    );
    expect(loginSource).toContain('icon="person"');
  });

  it('sso-org-empty:企业 ID 子视图空态接线(placeholder/hint/返回)', () => {
    expect(loginSource).toContain('testID="login.ssoOrgInput"');
    expect(loginSource).toContain('hydrateSsoOrgHistory()');
    expect(loginSource).toContain('<LoginSsoOrgHistoryList');
    expect(loginSource).toContain('accessibilityRole="combobox"');
    expect(loginSource).not.toContain('setSsoOrgHistoryOpen(history.length > 1)');
    expect(loginSource).not.toContain('setSsoOrgHistoryOpen(ssoOrgHistory.length > 1)');
    expect(loginSource).toContain("loginText('ssoOrgTitle')");
    expect(loginSource).toContain("loginText('ssoOrgPlaceholder')");
    expect(loginSource).toContain("loginText('ssoOrgHint')");
    expect(LOGIN_SSO_ORG_HISTORY.y).toBe(
      LOGIN_CONTROL.inputY + LOGIN_CONTROL.height + 8,
    );
    expect(
      LOGIN_SSO_ORG_HISTORY.y + LOGIN_SSO_ORG_HISTORY.maxHeight,
    ).toBeLessThanOrEqual(loginSizes.panelHeight);
    expect(controlsSource).toContain('showsVerticalScrollIndicator={false}');
    // 返回钮:子视图退回首屏输入(不整体 reset)
    expect(loginSource).toContain('setSsoOrgMode(false);');
  });

  it('sso-org-filled:企业 ID 直接发现，仅在状态机判定跨区后确认', () => {
    expect(loginSource).toContain("type: 'discover-sso-org'");
    expect(loginSource).toContain(
      'setSsoOrgHistory(getSsoOrgHistorySnapshot())',
    );
    expect(loginSource).toContain("auth.loginState?.step === 'realm-confirmation'");
    expect(loginSource).toContain("type: 'confirm-sso-realm'");
    expect(loginSource).toContain("type: 'cancel-sso-realm'");
    expect(loginSource).not.toContain('crossRegionConsent');
    expect(loginSource).toContain('testID="login.ssoOrgContinueButton"');
    expect(loginSource).toContain('disabled={disabled || !ssoOrg.trim()}');
  });

  it('sso-org-list:discoverSsoOrg 真链→method-choice(无邮箱上下文,行起点 148)', async () => {
    const client = makeClient('sso:multi', 'global');
    const discovery = await client.discoverSsoOrg('example-org');
    const methods = ssoOrgDiscoveryToMethods(discovery);
    expect(methods).toHaveLength(2);
    const state = reduceAuthFlow(null, {
      type: 'discovery-loaded',
      email: '',
      methods,
    });
    expect(state.step).toBe('method-choice');
    // 无邮箱上下文:副标题走 ssoOrgDetected,行起点用 sso-org 档(148)
    expect(loginSource).toContain(
      "loginText('ssoOrgDetected').replace('{org}', orgName)",
    );
    expect(loginSource).toContain('LOGIN_METHOD_ROW.firstRowTopSsoOrg');
  });

  it('verification-code-empty:request-code 真链→步骤态,居中验证码输入接线', async () => {
    const client = makeClient('providers:both');
    await client.requestCode('phone', '13800000000'); // 真链 200 {status:sent}
    const state = reduceAuthFlow(null, {
      type: 'code-requested',
      kind: 'phone',
      identifier: '13800000000',
    });
    expect(state).toEqual({
      step: 'verification-code',
      kind: 'phone',
      identifier: '13800000000',
    });
    expect(loginSource).toContain('testID="login.codeInput"');
    expect(loginSource).toContain('center');
    expect(loginSource).toContain(
      "`${loginText('codeSentTo')} ${state.identifier}`",
    );
  });

  it('verification-code-filled:6 位门槛与登录钮接线(login.verifyButton)', () => {
    expect(loginSource).toContain('if (verificationCode.length !== 6) return;');
    expect(loginSource).toContain(
      'disabled={disabled || verificationCode.length !== 6}',
    );
    expect(loginSource).toContain('testID="login.verifyButton"');
    expect(loginSource).toContain("type: 'verify-code',");
  });

  it('verification-code-loading:主按钮 busy spinner = 外层 Animated 旋转 + 静态 SVG', () => {
    expect(loginSource).toContain('busy={auth.isBusy}');
    // 仓规 7 RN 对应:useNativeDriver transform 循环,SVG 图形静止,仅 busy 期挂载
    expect(controlsSource).toContain('useNativeDriver: true');
    expect(controlsSource).toContain('Animated.loop(');
    expect(controlsSource).toContain('<LoginSpinnerGlyph');
    expect(controlsSource).toContain('{busy ? (');
  });

  it('account-selection:outcome:select-account 真链→双身份列表,方式行渲染', async () => {
    const client = makeClient('outcome:select-account');
    const outcome = await client.verifyCode(
      'email',
      'user@example.com',
      '123456',
    );
    expect(outcome.status).toBe('select_account');
    const state = reduceAuthFlow(null, { type: 'outcome', outcome });
    if (state.step !== 'account-selection')
      throw new Error('expected account-selection');
    expect(state.accounts).toHaveLength(2);
    expect(state.accounts.map((a) => a.kind)).toEqual(['personal', 'org']);
    expect(loginSource).toContain('testID={`login.account.${account.id}`}');
    expect(loginSource).toContain(
      "account.kind === 'org' ? 'enterprise' : 'person'",
    );
    expect(loginSource).toContain(
      "account.orgName || account.email || loginText('personalAccount')",
    );
  });

  it('binding-contact:outcome:binding-phone 真链→绑定阶段一(输入+发送)', async () => {
    const client = makeClient('outcome:binding-phone');
    const outcome = await client.verifyCode('phone', '13800000000', '123456');
    expect(outcome).toMatchObject({
      status: 'binding_required',
      bindType: 'phone',
    });
    const state = reduceAuthFlow(null, { type: 'outcome', outcome });
    expect(state).toMatchObject({
      step: 'binding',
      bindType: 'phone',
      codeRequested: false,
    });
    expect(loginSource).toContain('testID="login.bindingContactInput"');
    expect(loginSource).toContain('testID="login.bindingSendButton"');
    expect(loginSource).toContain("type: 'request-binding-code',");
  });

  it('binding-phone:+86 固定前缀与登录首屏同规则,11 位完整后才可发送验证码', () => {
    expect(loginSource).toContain('const contactReady = isEmail');
    expect(loginSource).toContain(': isCompleteCnPhone(bindingContact);');
    expect(loginSource).toContain(
      'contact: isEmail ? bindingContact : toCnE164(bindingContact),',
    );
    expect(loginSource).toContain(
      'setBindingContact(sanitizeCnPhoneInput(text))',
    );
    expect(loginSource).toContain('disabled={disabled || !contactReady}');
  });

  it('binding-code:binding-code-requested→阶段二(验证码+「登录」钮)', async () => {
    const client = makeClient('outcome:binding-email');
    const outcome = await client.verifyCode(
      'email',
      'user@example.com',
      '123456',
    );
    let state: AuthFlowState = reduceAuthFlow(null, {
      type: 'outcome',
      outcome,
    });
    state = reduceAuthFlow(state, {
      type: 'binding-code-requested',
      bindType: 'email',
      contact: 'real@example.com',
    });
    expect(state).toEqual({
      step: 'binding',
      bindType: 'email',
      codeRequested: true,
      contact: 'real@example.com',
    });
    expect(loginSource).toContain('testID="login.bindingVerifyButton"');
    // 阶段二按钮文案保留「登录」(signIn key)
    expect(loginSource).toContain("type: 'verify-binding',");
  });

  it('browser-redirect:browser-started→panel + 64 loading 环 + 取消', () => {
    const state = reduceAuthFlow(null, {
      type: 'browser-started',
      label: 'Example SSO',
    });
    expect(state).toEqual({ step: 'browser-redirect', label: 'Example SSO' });
    expect(loginSource).toContain('<LoginLoadingRing');
    expect(loginSource).toContain('LOGIN_LOADING_RING.yBrowser');
    expect(loginSource).toContain('testID="login.cancelBrowserButton"');
    expect(loginSource).toContain(
      "`${state.label} · ${loginText('browserSubtitle')}`",
    );
  });

  it('preparing:auth 未初始化伪态 loading 环接线(64 @(308,193))', () => {
    expect(loginSource).toContain('renderPreparing');
    expect(loginSource).toContain('LOGIN_LOADING_RING.yPreparing');
    expect(loginSource).toContain('testID="login.panel.preparing"');
  });

  it('error:failed→error 步骤,retry + authErrorText 兜底接线', () => {
    const state = reduceAuthFlow(null, {
      type: 'failed',
      code: 'NETWORK_ERROR',
      recoverTo: 'identifier',
    });
    expect(state).toEqual({
      step: 'error',
      code: 'NETWORK_ERROR',
      recoverTo: 'identifier',
    });
    expect(loginSource).toContain('testID="login.panel.error"');
    expect(loginSource).toContain('testID="login.errorRetryButton"');
    expect(loginSource).toContain(
      "authErrorText(state.code) ?? loginText('errorFallback')",
    );
    expect(loginSource).toContain('testID="login.error"');
  });

  it('completed:outcome ok 真链→completed 瞬态,面板留空品牌保持', async () => {
    const client = makeClient('providers:both');
    const outcome = await client.verifyCode('phone', '13800000000', '123456');
    expect(outcome.status).toBe('ok');
    const state = reduceAuthFlow(null, { type: 'outcome', outcome });
    if (state.step !== 'completed') throw new Error('expected completed');
    expect(state.membership.displayName).toBe('Scenario User');
    expect(loginSource).toContain("auth.loginState?.step === 'completed'");
    expect(loginSource).toContain('? null');
  });

  it('no-loginstate:兜底单按钮 默认/busy 双格接线(login.retryButton)', () => {
    expect(loginSource).toContain('testID="login.retryButton"');
    expect(loginSource).toContain(
      "label={auth.isBusy ? loginText('working') : loginText('continue')}",
    );
    expect(loginSource).toContain('testID="login.panel.noLoginState"');
    // 状态机行为零改动:reset 重新拉起
    expect(loginSource).toContain(
      "void auth.dispatchLoginAction({ type: 'reset' });",
    );
  });

  it('SC-SOC-7:圆钮 onPress in-flight guard — disabled 时 no-op,非 disabled 正常派发(行为层,零视觉变化)', () => {
    // 用户拍板(§10)砍的是 disabled/loading 视觉态,不是防重复提交行为;按规则 9
    // 在调用点 handler 拦,复用既有 disabled 变量(auth.isBusy||!initialized||configIssues)。
    // 零视觉变化:无 disabled attr/className/StateOverlay 视觉回填;in-flight 仅加
    // accessibilityState.busy 无障碍语义(非视觉,对齐桌面 aria-disabled;见 LoginSkinButton),
    // 不传原生 disabled——视觉/交互态不变。
    // 渲染层读源码断言(login.tsx 依赖 expo/RN,node vitest 不加载,沿用仓内既有模式)。
    // 1. in-flight guard 存在:两个圆钮 onPress 各一(social + ssoEntry),≥2 处
    // FRAGILE:源码字面匹配——重排版空格仍匹配(\s* 容差),但变量改名(disabled→别的)或
    // 改写为 if-block 会假失败;改 onPress guard 时同步更新此正则,或抽成纯函数测行为。
    const guardMatches = loginSource.match(/if\s*\(\s*disabled\s*\)\s*return\s*;/g) ?? [];
    expect(guardMatches.length).toBeGreaterThanOrEqual(2);
    // 2. 非 in-flight 派发路径保留:iOS native + Global Android browser。
    expect(loginSource).toMatch(/type:\s*'native-social',\s*provider/);
    expect(loginSource).toContain("type: 'start-social-browser'");
    // 3. SSO 非 in-flight 路径保留(clearAuthError + setSsoOrgMode)
    expect(loginSource).toContain('auth.clearAuthError();');
    expect(loginSource).toContain('setSsoOrgMode(true);');
  });
});
