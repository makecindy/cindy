import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import ts from 'typescript';
import * as loginLayout from '../loginSkinLayout';
import { isCompleteCnPhone, sanitizeCnPhoneInput, toCnE164, CN_PHONE_PREFIX } from '../cnPhone';
import { isValidEmail } from '@cindy/auth-client';
import { canResumePendingConsent, makeConsentStamp } from '../consentGate';

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

function makeClient(scenario: string, region: AuthRegion = 'cn') {
  return new CindyAuthClient({
    baseUrl: 'https://auth.scenario.invalid',
    region,
    deviceId: 'pr4a-harness-device',
    clientType: 'mobile',
    fetch: createScenarioFetch(scenario, { region }),
  });
}

const loginTree = ts.createSourceFile('login.tsx', loginSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const renderCallbacks = new Map<string, string>();
function readRenderCallbacks(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text.startsWith('render') && node.initializer && ts.isArrowFunction(node.initializer)) {
    renderCallbacks.set(node.name.text, ts.transpileModule('const render = ' + node.initializer.getText(loginTree), {
      compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
    }).outputText);
  }
  ts.forEachChild(node, readRenderCallbacks);
}
readRenderCallbacks(loginTree);
function productionRender(name: string, state: any, overrides: Record<string, unknown> = {}) {
  const components = Object.fromEntries(['LoginPanel', 'LoginTitleBlock', 'LoginPrimaryButton', 'LoginSkinPhoneInput', 'LoginSkinInput', 'LoginSocialRow', 'LoginSocialButton', 'LoginSocialGlyph', 'AppleLogoGlyph', 'LoginErrorText', 'LoginTextLinkSlot', 'LoginSsoOrgHistoryList', 'LoginMethodRow', 'LoginTextAction', 'LoginResendCountdown', 'LoginLoadingRing', 'CodeInput'].map((key) => [key, key]));
  const bindings = { React, ...loginLayout, ...components, isValidEmail, CN_PHONE_PREFIX, isCompleteCnPhone, sanitizeCnPhoneInput, toCnE164,
    auth: { loginState: state, isBusy: false, dispatchLoginAction: vi.fn(async () => undefined), clearAuthError: vi.fn() },
    loginText: (key: string) => key, authErrorText: (code: string) => code,
    identifierKind: 'phone', identifier: '13800000000', identifierFormatError: null, disabled: false, error: null,
    backNode: null, errorNode: null, accountRecoveryNode: null, resendDeadline: null, ssoOrgMode: false, ssoOrg: '', ssoOrgHistory: [], ssoOrgHistoryOpen: false,
    socialProviderModes: new Map([['apple', 'native'], ['google', 'browser']]),
    requireConsent: vi.fn((action: () => void) => action()), Platform: { OS: 'android' },
    LoginConsentRow: 'LoginConsentRow', consentAccepted: false, setConsentAccepted: vi.fn(), openLegalLink: vi.fn(),
    getSsoOrgHistorySnapshot: () => [], ssoOrgEditedRef: { current: false },
    verificationCode: '', bindingContact: '', bindingCode: '', ssoVerificationCode: '', styles: {},
    socialLabel: (provider: string) => provider, socialButtonTestId: (provider: string) => provider,
    setIdentifier: vi.fn(), setIdentifierFormatError: vi.fn(), setVerificationCode: vi.fn(), setBindingContact: vi.fn(), setBindingCode: vi.fn(),
    setSsoOrgMode: vi.fn(), setSsoOrg: vi.fn(), setSsoOrgHistoryOpen: vi.fn(), setSsoOrgHistory: vi.fn(),
    ...overrides };
  const compiled = renderCallbacks.get(name);
  if (!compiled) throw new Error('Missing production login renderer: ' + name);
  const render = new Function(...Object.keys(bindings), compiled + '\nreturn render;')(...Object.values(bindings));
  return { tree: render(), bindings };
}
function control(tree: any, id: string): any {
  if (!tree || typeof tree !== 'object') return undefined;
  if (Array.isArray(tree)) return tree.map((child) => control(child, id)).find(Boolean);
  if (tree.props?.testID === id) return tree.props;
  return control(tree.props?.children, id);
}

describe('production login state renderers', () => {
  it.each(['phone', 'email', 'apple', 'google', 'sso'])('routes the actual %s entry through its consent authority', (entry) => {
    const requireConsent = vi.fn();
    const state = { step: 'identifier', providers: { social: ['apple', 'google'], phone: true, email: true } };
    const rendered = productionRender('renderIdentifier', state, { requireConsent, identifierKind: entry === 'email' ? 'email' : 'phone', identifier: entry === 'email' ? 'user@example.invalid' : '13800000000' });
    if (entry === 'phone' || entry === 'email') control(rendered.tree, 'login.continueButton').onPress();
    else control(rendered.tree, entry === 'sso' ? 'login.ssoEntryButton' : 'login.' + entry + 'Button').onPress();
    expect(rendered.bindings.auth.dispatchLoginAction).not.toHaveBeenCalled();
    if (entry === 'sso') {
      expect(requireConsent).not.toHaveBeenCalled();
      expect(rendered.bindings.setSsoOrgMode).toHaveBeenCalledWith(true);
    } else expect(requireConsent).toHaveBeenCalledOnce();
  });

  // This is the actual gate from the page, including its stale-auth stamp check.
  it.each(['agree', 'dismiss', 'context-changed'])('continues only the still-authorized consent action: %s', (finish) => {
    const names = new Set(['requireConsent', 'agreeConsent', 'dismissConsent']);
    const fragments: string[] = [];
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.has(node.name.text) && node.initializer) fragments.push('const ' + node.name.text + ' = ' + node.initializer.getText(loginTree) + ';');
      ts.forEachChild(node, visit);
    }
    visit(loginTree);
    const auth = { loginState: { step: 'identifier' }, isBusy: false, isAuthenticated: false };
    const bindings = { consentAccepted: false, pendingConsentAction: { current: null }, auth, additionalAccount: false, makeConsentStamp, canResumePendingConsent,
      Keyboard: { dismiss: vi.fn() }, setConsentDialogOpen: vi.fn(), setConsentAccepted: vi.fn(), persistPrivacyConsent: vi.fn() };
    const code = ts.transpileModule(fragments.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const gate = new Function(...Object.keys(bindings), code + '\nreturn {requireConsent, agreeConsent, dismissConsent};')(...Object.values(bindings));
    const action = vi.fn();
    gate.requireConsent(action);
    expect(bindings.Keyboard.dismiss).toHaveBeenCalledOnce();
    expect(action).not.toHaveBeenCalled();
    if (finish === 'context-changed') auth.loginState.step = 'completed';
    if (finish === 'dismiss') gate.dismissConsent(); else gate.agreeConsent();
    expect(action).toHaveBeenCalledTimes(finish === 'agree' ? 1 : 0);
    expect(bindings.pendingConsentAction.current).toBeNull();
    expect(bindings.setConsentDialogOpen).toHaveBeenLastCalledWith(false);
  });

  it('enforces phone validation and E.164 dispatch through the actual submit handler', () => {
    const state = { step: 'identifier', providers: { social: [], phone: true, email: true } };
    const invalid = productionRender('renderIdentifier', state, { identifier: '12' });
    control(invalid.tree, 'login.identifierInput').onSubmitEditing();
    expect(invalid.bindings.auth.dispatchLoginAction).not.toHaveBeenCalled();
    expect(invalid.bindings.setIdentifierFormatError).toHaveBeenCalledWith('phone');
    const valid = productionRender('renderIdentifier', state);
    control(valid.tree, 'login.identifierInput').onSubmitEditing();
    expect(valid.bindings.requireConsent).toHaveBeenCalledTimes(1);
    expect(valid.bindings.auth.dispatchLoginAction).toHaveBeenCalledWith({ type: 'request-code', kind: 'phone', identifier: '+8613800000000' });
  });

  it.each(['', '123456'])('only enables verification with a complete code %j', (verificationCode) => {
    const rendered = productionRender('renderVerification', { step: 'verification-code', kind: 'phone', identifier: '+8613800000000' }, { verificationCode });
    const submit = control(rendered.tree, 'login.verifyButton');
    expect(submit.disabled).toBe(verificationCode.length !== 6);
    submit.onPress();
    if (verificationCode.length === 6) expect(rendered.bindings.auth.dispatchLoginAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'verify-code', code: verificationCode }));
    else expect(rendered.bindings.auth.dispatchLoginAction).not.toHaveBeenCalled();
  });

  it('renders the correct binding control for each authoritative substate', () => {
    const contact = productionRender('renderBinding', { step: 'binding', bindType: 'phone', codeRequested: false });
    expect(control(contact.tree, 'login.bindingContactInput')).toBeDefined();
    expect(control(contact.tree, 'login.bindingSendButton').disabled).toBe(true);
    expect(control(contact.tree, 'login.bindingVerifyButton')).toBeUndefined();
    const code = productionRender('renderBinding', { step: 'binding', bindType: 'email', codeRequested: true, contact: 'a@example.invalid' });
    expect(control(code.tree, 'login.bindingVerifyButton')).toBeDefined();
    expect(control(code.tree, 'login.bindingSendButton')).toBeUndefined();
  });
});

describe('loginSkin 全登录态(harness 真链 + 渲染层接线)', () => {

  it('identifier:providers 真链加载→identifier 步骤,区域定形态(无 tabs)/输入/主按钮/圆钮行接线', async () => {
    const client = makeClient('providers:both');
    const providers = await client.getProviders();
    const state = reduceAuthFlow(null, { type: 'providers-loaded', providers });
    expect(state).toMatchObject({ step: 'identifier' });
    expect(providers.email).toBe(true);
    expect(providers.phone).toBe(true);
  });

  it('identifier-input:输入 focus/filled 切 controlBorderActive 边与 Bold 墨字(figma §4.1)', async () => {
    // global 圆钮组合真链兜底:providers 行为不因 region 漂移
    const providers = await makeClient(
      'providers:global-social',
      'global',
    ).getProviders();
    expect(providers.social).toEqual(['apple', 'google']);
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
  });

  it('browser-redirect:browser-started→panel + 64 loading 环 + 取消', () => {
    const state = reduceAuthFlow(null, {
      type: 'browser-started',
      label: 'Example SSO',
    });
    expect(state).toEqual({ step: 'browser-redirect', label: 'Example SSO' });
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
  });

  it('completed:outcome ok 真链→completed 瞬态,面板留空品牌保持', async () => {
    const client = makeClient('providers:both');
    const outcome = await client.verifyCode('phone', '13800000000', '123456');
    expect(outcome.status).toBe('ok');
    const state = reduceAuthFlow(null, { type: 'outcome', outcome });
    if (state.step !== 'completed') throw new Error('expected completed');
    expect(state.membership.displayName).toBe('Scenario User');
  });
});
