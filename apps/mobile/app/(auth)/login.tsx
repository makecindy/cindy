import { Stack } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Animated, Easing, Keyboard, Linking, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AccountDeletionStatus, SocialProvider, VerificationKind } from '@cindy/auth-client';

import { useAuth } from '@/auth/AuthContext';
import { LoginCaptchaWebView } from '@/auth/LoginCaptchaWebView';
import { useLoginFirstLaunchLight } from '@/auth/loginFirstLaunchGate';
import { resolveStartupSplashHandoff } from '@/auth/startupSplashContinuity';
import {
  CN_PHONE_PREFIX,
  isCompleteCnPhone,
  sanitizeCnPhoneInput,
  toCnE164,
} from '@/auth/cnPhone';
import { AuthApiError, isValidEmail } from '@cindy/auth-client';
import { authErrorText, getAuthLocale, loginText } from '@/auth/loginMessages';
import { canResumePendingConsent, makeConsentStamp, type ConsentStamp } from '@/auth/consentGate';
import { acceptPrivacyConsent } from '@/analytics/analyticsConsentStore';
import { initMobileTapdb } from '@/analytics/mobileTapdb';
import { isNativeSocialProviderSupported } from '@/auth/nativeSocial';
import {
  resolveMobileSocialLoginMode,
  type MobileSocialLoginMode,
} from '@/auth/mobileSocialLoginMode';
import { Text, TextInput } from '@/components/AppText';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import {
  LOGIN_HANDOFF_EASING,
  LOGIN_HANDOFF_TIMING,
  loginHandoffPanelDelayMs,
  type LoginHandoffPhase,
} from '@/auth/loginHandoff';
import { computeLoginKeyboardShift } from '@/auth/loginKeyboardAvoidance';
import { useLoginHandoffOptional } from '@/auth/MobileLoginHandoffContext';
import {
  createResendDeadline,
  LOGIN_CONSENT_ROW,
  LOGIN_CONTROL,
  LOGIN_DELETION_BUBBLE,
  LOGIN_ERROR_TEXT,
  LOGIN_GROUP,
  LOGIN_LOADING_RING,
  LOGIN_METHOD_ROW,
  LOGIN_SSO_ORG_HINT_TOP,
  LOGIN_SUBTITLE,
  LOGIN_TITLE,
  resolveDeletionBubbleFrame,
  resolveDeletionBubbleLinkHitSlop,
  type LoginDeletionBubbleFrame,
  type LoginSurfaceMode,
} from '@/auth/loginSkinLayout';
import { LEGAL_LINKS } from '@/config/legalLinks';
import { useLoginKeyboardRect } from '@/session/useMobileKeyboardState';
import {
  LoginBackButton,
  LoginConsentDialog,
  LoginConsentRow,
  LoginErrorText,
  LoginLoadingRing,
  LoginMethodRow,
  LoginPanel,
  LoginPrimaryButton,
  LoginResendCountdown,
  LoginSkinInput,
  LoginSkinPhoneInput,
  LoginSocialButton,
  LoginSocialGlyph,
  LoginSocialRow,
  LoginTextLinkSlot,
  LoginTitleBlock,
  AppleLogoGlyph,
} from '@/components/LoginSkinControls';
import {
  MobileLoginHandoffStage,
  useLoginSurface,
} from '@/components/MobileLoginHandoffStage';
import { AUTH_REGION, BUILD_AUTH_REGION, getMobileConfigIssues } from '@/config/env';
import { resolveIdentifierMethod } from '@/auth/loginIdentifierMethod';
import { fontWeight, lineHeight, loginPalettes, loginSizes, radius, spacing, typeScale } from '@/theme/tokens';

/**
 * Auth-server login presentation(PR4a 全登录态皮肤化,implementation-plan Step 5 WHAT3)。
 * Credentials and tickets remain in AuthContext——本次仅换渲染层:
 * 状态机分支 / dispatchLoginAction 调用 / testID / 双端差异措辞全部 verbatim 保留;
 * 布局改为 MobileLoginHandoffStage(背景+品牌)+ 750 stage 坐标的 Log_in 组
 * (x=35,loginY,680×560,figma §5.1 移动帧;键盘位移归 PR4b)。
 */
export default function LoginScreen() {
  // 订阅语言变化:本屏文案走 loginText()(非响应式),useTranslation 保证
  // 手动语言 override 恢复/切换时本屏跟着重渲(P2-a:不依赖 auth 重渲兜底)。
  useTranslation();
  const auth = useAuth();
  const stage = useLoginSurface();
  const insets = useSafeAreaInsets();
  // 舞台有效主题(首启亮色门可强制 light,与系统主题可能不一致):状态栏样式
  // 必须跟舞台而不是系统,经 screen option 走 VC-based 通道(见 _layout 注释)。
  const { mode: systemTheme } = useTheme();
  const firstLaunchGate = useLoginFirstLaunchLight();
  const stageTheme =
    resolveStartupSplashHandoff(firstLaunchGate, systemTheme).targetTheme ??
    systemTheme;
  const handoff = useLoginHandoffOptional();
  const handoffDispatch = handoff?.dispatch;
  // readiness 锚之一(v6.3):登录面板已挂载(防面板未挂载先播 panel 步)
  useEffect(() => {
    handoffDispatch?.({ type: 'panel-mounted' });
  }, [handoffDispatch]);
  const handoffPhase: LoginHandoffPhase = handoff?.state.phase ?? 'done';
  const initializedLoginRef = useRef(false);
  // identifier 形态 = 构建区域确定性推导(用户拍板 2026-07-21:手机/邮箱分区互斥,
  // 双 tab 切换移除);providers 仅兜底区域首选方式未下发的场景。
  const identifierKind: VerificationKind = useMemo(
    () =>
      auth.loginState?.step === 'identifier'
        ? resolveIdentifierMethod(AUTH_REGION, auth.loginState.providers)
        : AUTH_REGION === 'global'
          ? 'email'
          : 'phone',
    [auth.loginState],
  );
  const [identifier, setIdentifier] = useState('');
  // identifier 本地格式校验错误(设计稿 347:1727:非法邮箱/手机号 → 输入框红边 +
  // 底部红字「请输入正确邮箱」/「请输入正确手机号」)。提交前本地拦截、不 dispatch
  // (规则 9;与桌面 LoginPage 同源语义),与 server authError 互斥展示(本地优先),
  // 输入变更即清除。null = 无本地格式错误。
  const [identifierFormatError, setIdentifierFormatError] =
    useState<VerificationKind | null>(null);
  // 企业 SSO 入口子视图:在 identifier 步骤内输入组织标识(本地展示态)
  const [ssoOrgMode, setSsoOrgMode] = useState(false);
  const [ssoOrg, setSsoOrg] = useState('');
  const realmConfirmation =
    auth.loginState?.step === 'realm-confirmation'
      ? auth.loginState
      : null;
  /* ── 协议同意链路(consent PR,与桌面 LoginPage 同源语义):radio 状态 +
     未勾选拦截弹窗 + 同意后续接。过门点(产品拍板 2026-07-24 二次):手机号提交、
     邮箱提交(discover 前)、method-choice 个人行发码、社交圆钮(Apple/Google/
     未来微信)——个人登录一律先同意再发起,含仅触发方式查询的 email discover
     (拍板压过审查侧「无副作用可放行」建议)。豁免仅限显式企业 SSO 入口。
     手机端无游客登录(远程连接客户端必须有账号,产品拍板 2026-07-24)。
     pending 动作只存本组件(不进 AuthContext 状态机;仓规 9)。 ── */
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [consentDialogOpen, setConsentDialogOpen] = useState(false);
  // pending 带开门时刻快照(stamp),同意时复验防陈旧续接(codex 审查 P1;consentGate 单测覆盖)
  const pendingConsentAction = useRef<{
    action: () => void;
    stamp: ConsentStamp;
  } | null>(null);
  /* 把「用户明示同意《隐私政策》」这个事实落到本机。它是 TapDB 采集的前置条件
     (见 src/analytics/analyticsConsentStore.ts):没有这条记录,统计 SDK 根本不会
     初始化。写在**放行时刻**而不是勾 radio 时刻——勾了又取消不算同意,同意并继续
     使用才算。幂等,失败不阻断登录(闸保持关闭)。 */
  const persistPrivacyConsent = () => {
    void acceptPrivacyConsent()
      // 同意即可开始统计,不必等到登录成功——「未登录用户的启动与留存」本来就是
      // 这份埋点要回答的问题。冷启动那次 initMobileTapdb 当时被同意闸挡住了,
      // 这里补一次。
      .then(() => initMobileTapdb())
      .catch(() => undefined);
  };

  const requireConsent = (action: () => void) => {
    if (consentAccepted) {
      persistPrivacyConsent();
      action();
      return;
    }
    // 弹窗非原生 Modal、不参与键盘避让:从输入框 onSubmitEditing 进来时先收键盘,
    // 否则小屏上「同意」钮会被键盘盖住(codex 审查 P1)
    Keyboard.dismiss();
    pendingConsentAction.current = {
      action,
      stamp: makeConsentStamp(auth.loginState?.step, auth.isBusy, auth.isAuthenticated),
    };
    setConsentDialogOpen(true);
  };
  const agreeConsent = () => {
    // 同意 = 自动勾选 radio + 续接用户刚才点的那条登录链路(产品拍板)
    setConsentAccepted(true);
    setConsentDialogOpen(false);
    // 点了弹窗上的「同意」即为明示同意,与下面 pending 是否还能续接无关。
    persistPrivacyConsent();
    const pending = pendingConsentAction.current;
    pendingConsentAction.current = null;
    if (!pending) return;
    // 复验:弹窗期间认证状态被异步推进(深链回调/另一路完成/步骤切换)则丢弃动作
    const current = makeConsentStamp(auth.loginState?.step, auth.isBusy, auth.isAuthenticated);
    if (canResumePendingConsent(pending.stamp, current)) pending.action();
  };
  const dismissConsent = () => {
    // 不同意 = 退回登录页,radio 保持未勾选
    pendingConsentAction.current = null;
    setConsentDialogOpen(false);
  };
  // 弹窗打开期间登录上下文漂移(认证完成/步骤切换)→ 自动收窗弃 pending,
  // 避免用户对着一个已失效来源视图的弹窗做决定
  useEffect(() => {
    if (!consentDialogOpen) return;
    const pending = pendingConsentAction.current;
    const current = makeConsentStamp(auth.loginState?.step, auth.isBusy, auth.isAuthenticated);
    if (auth.isAuthenticated || (pending && current.step !== pending.stamp.step)) {
      pendingConsentAction.current = null;
      setConsentDialogOpen(false);
    }
  }, [consentDialogOpen, auth.isAuthenticated, auth.isBusy, auth.loginState?.step]);
  const openLegalLink = (kind: 'terms' | 'privacy') => {
    // 系统默认浏览器打开(settings.tsx 同款 Linking 模式);URL 按构建区域分流
    void Linking.openURL(
      kind === 'terms' ? LEGAL_LINKS.termsOfService : LEGAL_LINKS.privacyPolicy,
    ).catch(() => undefined);
  };
  const [verificationCode, setVerificationCode] = useState('');
  const [ssoVerificationCode, setSsoVerificationCode] = useState('');
  const [bindingContact, setBindingContact] = useState('');
  const [bindingCode, setBindingCode] = useState('');
  // 42s 重发倒计时(Step 3a 契约):绝对 deadline,进入 verification-code 步骤
  // (= request-code 成功返回)起算;重发成功重置、失败保持;离开步骤清空。
  const [resendDeadline, setResendDeadline] = useState<number | null>(null);
  const [accountDeletionStatus, setAccountDeletionStatus] =
    useState<AccountDeletionStatus | null>(null);
  const styles = useThemedStyles(makeStyles);
  const configIssues = getMobileConfigIssues();
  const disabled = auth.isBusy || !auth.initialized || configIssues.length > 0;

  useEffect(() => {
    if (
      !auth.initialized ||
      auth.isAuthenticated ||
      initializedLoginRef.current
    )
      return;
    initializedLoginRef.current = true;
    void auth.dispatchLoginAction({ type: 'reset' });
  }, [auth]);

  useEffect(() => {
    if (auth.loginState?.step !== 'identifier') return;
    setSsoOrgMode(false);
    setVerificationCode('');
    setSsoVerificationCode('');
    setBindingContact('');
    setBindingCode('');
    setIdentifierFormatError(null);
  }, [auth.loginState]);

  // 倒计时起算/清理:进入 verification-code(request-code 成功)即重置 deadline;
  // 离开该步骤置 null(unmount 时组件内部 interval 一并清理)。
  const verificationIdentity =
    auth.loginState?.step === 'verification-code'
      ? `${auth.loginState.kind}:${auth.loginState.identifier}`
      : null;
  useEffect(() => {
    setResendDeadline(
      verificationIdentity == null ? null : createResendDeadline(Date.now()),
    );
  }, [verificationIdentity]);

  useEffect(() => {
    if (
      !auth.initialized ||
      auth.isAuthenticated ||
      !auth.accountDeletionReceipt
    ) {
      setAccountDeletionStatus(null);
      return;
    }
    let cancelled = false;
    let polling = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stopPolling = () => {
      polling = false;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    const refreshStatus = async () => {
      if (!polling) return;
      try {
        const status = await auth.getAccountDeletionStatus();
        if (cancelled || !status) return;
        if (status.status === 'cancelled') {
          stopPolling();
          await auth.clearAccountDeletionReceipt();
          if (!cancelled) setAccountDeletionStatus(null);
          return;
        }
        setAccountDeletionStatus(status);
        if (status.status === 'completed') stopPolling();
      } catch (cause) {
        if (
          cause instanceof AuthApiError &&
          cause.code === 'ACCOUNT_DELETION_RECEIPT_INVALID'
        ) {
          stopPolling();
          await auth.clearAccountDeletionReceipt();
        } else if (
          cause instanceof AuthApiError &&
          cause.code === 'INVALID_RESPONSE'
        ) {
          // 契约漂移不是可重试网络错误：停止本次页面轮询，但保留 receipt，避免
          // 丢失唯一查询能力；下次挂载仍可在服务端恢复后重试。
          stopPolling();
          if (!cancelled) setAccountDeletionStatus(null);
        }
      }
    };
    void refreshStatus();
    timer = setInterval(() => void refreshStatus(), 30_000);
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [
    auth.accountDeletionReceipt,
    auth.clearAccountDeletionReceipt,
    auth.getAccountDeletionStatus,
    auth.initialized,
    auth.isAuthenticated,
  ]);

  const reset = () => {
    auth.clearAuthError();
    setIdentifierFormatError(null);
    void auth.dispatchLoginAction({ type: 'reset' });
  };

  // 返回按钮改为面板内左上角(figma §4.6 @(20,20)):首屏(identifier)无返回;
  // SSO 组织标识 子视图退回首屏输入;其余步骤(选方式/验证码/选身份/绑定)整体重置。
  const step = auth.loginState?.step;
  const backAction =
    step === 'identifier'
      ? ssoOrgMode
        ? () => {
            auth.clearAuthError();
            setSsoOrgMode(false);
          }
        : null
      : step && step !== 'browser-redirect' && step !== 'completed'
        ? reset
        : null;

  const error = authErrorText(auth.authError);
  const errorNode = error ? (
    <LoginErrorText testID="login.error">{error}</LoginErrorText>
  ) : null;
  const backNode = backAction ? (
    <LoginBackButton
      disabled={auth.isBusy}
      label={loginText('back')}
      onPress={backAction}
      testID="login.backButton"
    />
  ) : null;

  const renderIdentifier = () => {
    const state = auth.loginState;
    if (state?.step !== 'identifier') return null;
    const providers = state.providers;
    const socialProviderModes = new Map<SocialProvider, MobileSocialLoginMode>();
    for (const provider of providers.social) {
      const mode = resolveMobileSocialLoginMode({
        provider,
        region: BUILD_AUTH_REGION,
        platform: Platform.OS,
        nativeSupported: isNativeSocialProviderSupported(provider),
      });
      if (mode) socialProviderModes.set(provider, mode);
    }
    const socialProviders = providers.social.filter((provider) =>
      socialProviderModes.has(provider),
    );
    // Apple 保持官方 Logo-only 样式:iOS 走原生凭据,Global Android
    // 走系统浏览器 PKCE;其余(Google/微信/SSO)保留原有圆钮。
    const nonAppleProviders = socialProviders.filter(
      // type guard 收窄为 Google/微信(SSO 由行内末位单独渲染),与 LoginSocialGlyph
      // 收窄后的 provider 类型对齐;Apple 走圆钮行第一颗(AppleLogoGlyph,variant='apple')。
      (provider): provider is Exclude<SocialProvider, 'apple'> =>
        provider !== 'apple',
    );
    if (ssoOrgMode) {
      const submitSsoOrg = () => {
        const value = ssoOrg.trim();
        if (!value) return;
        // 先静默发现组织区域；只有跨出安装包区域时 AuthContext 才进入
        // realm-confirmation，并由页面底部弹窗在继续 SSO 前确认。
        void auth.dispatchLoginAction({
          type: 'discover-sso-org',
          org: value,
        });
      };
      return (
        <LoginPanel testID="login.panel.ssoOrg">
          {backNode}
          <LoginTitleBlock
            title={loginText('ssoOrgTitle')}
            subtitle={loginText('ssoOrgSubtitle')}
          />
          <LoginSkinInput
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect={false}
            editable={!disabled}
            error={!!error}
            maxLength={253}
            onChangeText={setSsoOrg}
            onSubmitEditing={submitSsoOrg}
            placeholder={loginText('ssoOrgPlaceholder')}
            returnKeyType="go"
            testID="login.ssoOrgInput"
            value={ssoOrg}
          />
          <LoginTextLinkSlot
            align="top"
            tone="secondary"
            top={LOGIN_SSO_ORG_HINT_TOP}
          >
            {loginText('ssoOrgHint')}
          </LoginTextLinkSlot>
          <LoginPrimaryButton
            busy={auth.isBusy}
            disabled={disabled || !ssoOrg.trim()}
            label={loginText('continue')}
            onPress={submitSsoOrg}
            testID="login.ssoOrgContinueButton"
          />
          {errorNode}
        </LoginPanel>
      );
    }
    const submit = () => {
      if (identifierKind === 'email') {
        const value = identifier.trim();
        if (!value) return;
        // 非法邮箱格式本地拦截 → 红边 + 红字「请输入正确邮箱」(设计稿 347:1727),
        // 不 dispatch discover(与桌面 LoginPage 同源)。
        if (!isValidEmail(value)) {
          auth.clearAuthError();
          setIdentifierFormatError('email');
          return;
        }
        setIdentifierFormatError(null);
        // 邮箱提交先过协议门(产品拍板 2026-07-24 二次:手机号/邮箱提交一律先弹
        // 协议弹窗,压过审查侧「discover 纯查询可放行」建议;显式 SSO 入口仍豁免)
        requireConsent(() =>
          void auth.dispatchLoginAction({ type: 'discover', email: value }),
        );
      } else {
        // 手机号登录只支持中国大陆号码:UI 固定 +86,输入框只存本地号,提交时拼回完整号码。
        // 号段不合法本地拦截并提示「请输入正确手机号」(设计稿同款红边+红字)。
        if (!isCompleteCnPhone(identifier)) {
          auth.clearAuthError();
          setIdentifierFormatError('phone');
          return;
        }
        setIdentifierFormatError(null);
        requireConsent(() =>
          void auth.dispatchLoginAction({
            type: 'request-code',
            kind: 'phone',
            identifier: toCnE164(identifier),
          }),
        );
      }
    };
    // 本地格式错误优先展示(设计稿「请输入正确邮箱/手机号」),否则回退 server 错误文案。
    const formatErrorText = identifierFormatError
      ? loginText(identifierFormatError === 'email' ? 'invalidEmail' : 'invalidPhone')
      : null;
    const identifierHasError = !!error || identifierFormatError != null;
    const identifierErrorNode = formatErrorText ? (
      <LoginErrorText testID="login.error">{formatErrorText}</LoginErrorText>
    ) : (
      errorNode
    );
    return (
      <>
        <LoginPanel testID="login.panel.identifier">
          <LoginTitleBlock
            title={loginText('title')}
            titleTestID="login.title"
          />
          {identifierKind === 'phone' ? (
            <LoginSkinPhoneInput
              autoComplete="tel"
              editable={!disabled}
              error={identifierHasError}
              keyboardType="phone-pad"
              onChangeText={(text) => {
                if (identifierFormatError) setIdentifierFormatError(null);
                setIdentifier(sanitizeCnPhoneInput(text));
              }}
              onSubmitEditing={submit}
              placeholder={loginText('phonePlaceholder')}
              prefix={CN_PHONE_PREFIX}
              returnKeyType="go"
              testID="login.identifierInput"
              value={identifier}
            />
          ) : (
            <LoginSkinInput
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
              editable={!disabled}
              error={identifierHasError}
              keyboardType="email-address"
              onChangeText={(text) => {
                if (identifierFormatError) setIdentifierFormatError(null);
                setIdentifier(text);
              }}
              onSubmitEditing={submit}
              placeholder={loginText('emailPlaceholder')}
              returnKeyType="go"
              testID="login.identifierInput"
              value={identifier}
            />
          )}
          <LoginPrimaryButton
            busy={auth.isBusy}
            disabled={
              disabled ||
              (identifierKind === 'phone'
                ? !isCompleteCnPhone(identifier)
                : !identifier.trim())
            }
            label={loginText('continue')}
            onPress={submit}
            testID="login.continueButton"
          />
          {identifierErrorNode}
        </LoginPanel>
        {/* Apple 入口为圆钮行第一颗:iOS 走原生 Sign in with Apple,
            Global Android 复用系统浏览器 PKCE。圆钮底色用 ADR 官方 Black/White 配色(appleCircleBg)、
            logo 用官方 Logo-only artwork(AppleLogoGlyph,path 逐字节原样未改)、无描边。
            HIG 允许 logo-only 自定义按钮(圆形),artwork 来自 Apple Design Resources。 */}
        <LoginSocialRow
          count={
            (socialProviders.includes('apple') ? 1 : 0) +
            nonAppleProviders.length +
            1
          }
        >
          {socialProviders.includes('apple') ? (
            <LoginSocialButton
              key="apple"
              label={loginText('apple')}
              busy={auth.isBusy}
              variant="apple"
              onPress={() => {
                // SC-SOC-7: in-flight 期间 no-op(行为层 guard,无 disabled 视觉回填)。
                if (disabled) return;
                // Apple 属个人登录链路,过协议门(未勾选先弹协议弹窗,同意后续接当前平台路径)
                requireConsent(() => {
                  const mode = socialProviderModes.get('apple');
                  if (mode === 'browser') {
                    void auth.dispatchLoginAction({
                      type: 'start-social-browser',
                      provider: 'apple',
                      label: loginText('apple'),
                    });
                    return;
                  }
                  void auth.dispatchLoginAction({
                    type: 'native-social',
                    provider: 'apple',
                  });
                });
              }}
              testID="login.appleButton"
            >
              <AppleLogoGlyph />
            </LoginSocialButton>
          ) : null}
          {nonAppleProviders.map((provider) => (
            <LoginSocialButton
              key={provider}
              label={socialLabel(provider)}
              busy={auth.isBusy}
              onPress={() => {
                // SC-SOC-7: in-flight(disabled)期间 no-op 防重复发起;行为层 guard,
                // 零视觉变化(圆钮已无 disabled 态 per §10 拍板,不回填 disabled 视觉)。
                if (disabled) return;
                // Google/微信属个人登录链路,过协议门;同意后续接本次 native-social
                requireConsent(() =>
                  void auth.dispatchLoginAction({
                    type: 'native-social',
                    provider,
                  }),
                );
              }}
              // 对象展开保持 testID: 键形态(mobileAuthServerLogin 守护测试锚定该字面)
              {...{ testID: `login.${provider}Button` }}
            >
              <LoginSocialGlyph provider={provider} />
            </LoginSocialButton>
          ))}
          {/* 企业 SSO 入口:输入组织标识 发起单点登录(国内版隐藏邮箱后企业用户的登录路径)。
              企业 SSO 豁免协议门(产品拍板),不过 requireConsent。 */}
          <LoginSocialButton
            label={loginText('ssoEntry')}
            busy={auth.isBusy}
            onPress={() => {
              // SC-SOC-7: in-flight 期间 no-op(行为层 guard,无 disabled 视觉回填)。
              if (disabled) return;
              auth.clearAuthError();
              setSsoOrgMode(true);
            }}
            testID="login.ssoEntryButton"
          >
            <LoginSocialGlyph provider="sso" />
          </LoginSocialButton>
        </LoginSocialRow>
        {/* 协议同意行(figma 600:660:圆钮行下方 22 设计px,组坐标 y=582;
            渲染门 = 所在 identifier 主视图分支,流程底边恒 622 已含其区间) */}
        <LoginConsentRow
          checked={consentAccepted}
          onToggle={() => setConsentAccepted((prev) => !prev)}
          statement={loginText('consentStatement')}
          onOpenTerms={() => openLegalLink('terms')}
          onOpenPrivacy={() => openLegalLink('privacy')}
        />
      </>
    );
  };

  const renderMethodChoice = () => {
    const state = auth.loginState;
    if (state?.step !== 'method-choice') return null;
    const ssoMethods = state.methods.filter((method) => method.type === 'sso');
    const emailAllowed =
      state.methods.some((method) => method.type === 'email_code') &&
      !ssoMethods.some((method) => method.ssoRequired);
    // 命中企业域名时按 console 同款框架提示「企业身份 / 个人身份」;无 SSO 时保持纯邮箱确认
    const orgName = ssoMethods[0]?.orgName;
    // sso-org 入口来源(无邮箱上下文)行起点 148,邮箱 discovery 来源 158(demo 呈现仲裁)
    const firstRowTop = state.email
      ? LOGIN_METHOD_ROW.firstRowTopDefault
      : LOGIN_METHOD_ROW.firstRowTopSsoOrg;
    return (
      <LoginPanel testID="login.panel.methodChoice">
        {backNode}
        <LoginTitleBlock
          title={loginText('chooseMethod')}
          subtitle={
            orgName
              ? state.email
                ? loginText('orgDetected')
                    .replace('{org}', orgName)
                    .replace('{email}', state.email)
                : // 企业 SSO 入口路径没有邮箱上下文,只提示命中的企业
                  loginText('ssoOrgDetected').replace('{org}', orgName)
              : state.email
          }
        />
        {ssoMethods.map((method, index) => (
          <LoginMethodRow
            disabled={disabled}
            key={method.connectionId}
            onPress={() =>
              void auth.dispatchLoginAction({
                type: 'start-sso',
                connectionId: method.connectionId,
                label: method.connectionName || method.orgName,
              })
            }
            testID={`login.sso.${method.connectionId}`}
            title={
              ssoMethods.length > 1
                ? `${loginText('enterpriseLogin')} · ${method.connectionName || method.orgName}`
                : loginText('enterpriseLogin')
            }
            top={firstRowTop + index * LOGIN_METHOD_ROW.rowStep}
          />
        ))}
        {emailAllowed ? (
          <LoginMethodRow
            disabled={disabled}
            icon="person"
            // 个人邮箱发码 = 个人链路实际发起点,在此过协议门(discover 已放行,
            // 保证企业用户经 discover→SSO 全程无门)
            onPress={() =>
              requireConsent(() =>
                void auth.dispatchLoginAction({
                  type: 'request-code',
                  kind: 'email',
                  identifier: state.email,
                }),
              )
            }
            testID="login.emailCodeButton"
            title={loginText(
              ssoMethods.length > 0 ? 'personalLogin' : 'emailCode',
            )}
            top={firstRowTop + ssoMethods.length * LOGIN_METHOD_ROW.rowStep}
          />
        ) : null}
        {ssoMethods.some((method) => method.ssoRequired) ? (
          <LoginTextLinkSlot top={380}>{loginText('ssoRequired')}</LoginTextLinkSlot>
        ) : null}
        {errorNode}
      </LoginPanel>
    );
  };

  const renderVerification = () => {
    const state = auth.loginState;
    if (state?.step !== 'verification-code') return null;
    const verify = () => {
      if (verificationCode.length !== 6) return;
      void auth.dispatchLoginAction({
        type: 'verify-code',
        kind: state.kind,
        identifier: state.identifier,
        code: verificationCode,
      });
    };
    // 重发:成功(dispatch 返回 true)重置 deadline,失败保持当前 deadline(Step 3a)
    const resend = async () => {
      const ok = await auth.dispatchLoginAction({
        type: 'request-code',
        kind: state.kind,
        identifier: state.identifier,
      });
      if (ok) setResendDeadline(createResendDeadline(Date.now()));
    };
    return (
      <LoginPanel testID="login.panel.verification">
        {backNode}
        <LoginTitleBlock
          title={loginText('enterCode')}
          subtitle={`${loginText('codeSentTo')} ${state.identifier}`}
        />
        <CodeInput
          disabled={disabled}
          error={!!error}
          onChange={setVerificationCode}
          onSubmit={verify}
          value={verificationCode}
        />
        <LoginResendCountdown
          countdownTemplate={loginText('resendCountdown')}
          deadline={resendDeadline}
          disabled={disabled}
          onResend={() => void resend()}
          resendLabel={loginText('resendCode')}
          testID="login.resendButton"
        />
        <LoginPrimaryButton
          busy={auth.isBusy}
          disabled={disabled || verificationCode.length !== 6}
          label={loginText('signIn')}
          onPress={verify}
          testID="login.verifyButton"
        />
        {errorNode}
      </LoginPanel>
    );
  };

  const renderAccountSelection = () => {
    const state = auth.loginState;
    if (state?.step !== 'account-selection') return null;
    return (
      <LoginPanel testID="login.panel.accountSelection">
        {backNode}
        <LoginTitleBlock
          title={loginText('chooseAccount')}
          subtitle={loginText('chooseAccountSubtitle')}
        />
        {state.accounts.map((account, index) => (
          <LoginMethodRow
            accessibilityLabel={account.displayName}
            disabled={disabled}
            icon={account.kind === 'org' ? 'enterprise' : 'person'}
            key={account.id}
            onPress={() =>
              void auth.dispatchLoginAction({
                type: 'select-account',
                accountId: account.id,
              })
            }
            subtitle={
              account.orgName || account.email || loginText('personalAccount')
            }
            testID={`login.account.${account.id}`}
            title={account.displayName}
            top={
              LOGIN_METHOD_ROW.firstRowTopSsoOrg +
              index * LOGIN_METHOD_ROW.rowStep
            }
          />
        ))}
        {errorNode}
      </LoginPanel>
    );
  };

  const renderSsoVerification = () => {
    const state = auth.loginState;
    if (state?.step !== 'sso-verification') return null;
    const verify = () => {
      if (ssoVerificationCode.length !== 6) return;
      void auth.dispatchLoginAction({
        type: 'verify-sso-verification',
        code: ssoVerificationCode,
      });
    };
    const resend = () => {
      void auth.dispatchLoginAction({ type: 'request-sso-verification-code' });
    };
    return (
      <LoginPanel testID="login.panel.sso-verification">
        {backNode}
        <LoginTitleBlock
          title={loginText('ssoVerificationTitle')}
          subtitle={loginText('ssoVerificationSubtitle').replace(
            '{target}',
            state.targetMasked,
          )}
        />
        {!state.codeRequested ? (
          <LoginPrimaryButton
            busy={auth.isBusy}
            disabled={disabled}
            label={loginText('sendCode')}
            onPress={() =>
              void auth.dispatchLoginAction({ type: 'request-sso-verification-code' })
            }
            testID="login.ssoVerificationSendButton"
          />
        ) : (
          <>
            <CodeInput
              disabled={disabled}
              error={!!error}
              onChange={setSsoVerificationCode}
              onSubmit={verify}
              value={ssoVerificationCode}
            />
            {/* 无倒计时:deadline=null → 重发常驻可点(照 origin/main sso-verification,
                与 verification-code 屏的 resendDeadline 契约不同——SSO 验证码无冷却) */}
            <LoginResendCountdown
              countdownTemplate={loginText('resendCountdown')}
              deadline={null}
              disabled={disabled}
              onResend={resend}
              resendLabel={loginText('resendCode')}
              testID="login.ssoVerificationResendButton"
            />
            {/* GAP7:SSO 验证主按钮文案跨端有意差异——mobile 用 signIn(登录)、
                desktop 用 completeSignIn(完成登录),不统一;勿改文案。 */}
            <LoginPrimaryButton
              busy={auth.isBusy}
              disabled={disabled || ssoVerificationCode.length !== 6}
              label={loginText('signIn')}
              onPress={verify}
              testID="login.ssoVerificationVerifyButton"
            />
          </>
        )}
        {errorNode}
      </LoginPanel>
    );
  };

  const renderBinding = () => {
    const state = auth.loginState;
    if (state?.step !== 'binding') return null;
    const isEmail = state.bindType === 'email';
    // 绑定手机号与登录同规则:只支持中国大陆号码,输入框存本地号,提交拼回 +86。
    const contact =
      state.contact ?? (isEmail ? bindingContact : toCnE164(bindingContact));
    const contactReady = isEmail
      ? Boolean(bindingContact.trim())
      : isCompleteCnPhone(bindingContact);
    const request = () => {
      if (!contactReady) return;
      void auth.dispatchLoginAction({
        type: 'request-binding-code',
        contact: isEmail ? bindingContact : toCnE164(bindingContact),
      });
    };
    const verify = () => {
      if (!contact || bindingCode.length !== 6) return;
      void auth.dispatchLoginAction({
        type: 'verify-binding',
        contact,
        code: bindingCode,
      });
    };
    return (
      <LoginPanel testID="login.panel.binding">
        {backNode}
        <LoginTitleBlock
          title={loginText(isEmail ? 'bindEmailTitle' : 'bindPhoneTitle')}
          subtitle={loginText(
            isEmail ? 'bindEmailSubtitle' : 'bindPhoneSubtitle',
          )}
        />
        {!state.codeRequested ? (
          <>
            {isEmail ? (
              <LoginSkinInput
                autoCapitalize="none"
                autoComplete="email"
                autoCorrect={false}
                editable={!disabled}
                error={!!error}
                keyboardType="email-address"
                onChangeText={setBindingContact}
                onSubmitEditing={request}
                placeholder={loginText('emailPlaceholder')}
                returnKeyType="go"
                testID="login.bindingContactInput"
                value={bindingContact}
              />
            ) : (
              <LoginSkinPhoneInput
                autoComplete="tel"
                editable={!disabled}
                error={!!error}
                keyboardType="phone-pad"
                onChangeText={(text) =>
                  setBindingContact(sanitizeCnPhoneInput(text))
                }
                onSubmitEditing={request}
                placeholder={loginText('phonePlaceholder')}
                prefix={CN_PHONE_PREFIX}
                returnKeyType="go"
                testID="login.bindingContactInput"
                value={bindingContact}
              />
            )}
            <LoginPrimaryButton
              busy={auth.isBusy}
              disabled={disabled || !contactReady}
              label={loginText('sendCode')}
              onPress={request}
              testID="login.bindingSendButton"
            />
          </>
        ) : (
          <>
            <LoginTextLinkSlot>{contact}</LoginTextLinkSlot>
            <CodeInput
              disabled={disabled}
              error={!!error}
              onChange={setBindingCode}
              onSubmit={verify}
              value={bindingCode}
            />
            <LoginPrimaryButton
              busy={auth.isBusy}
              disabled={disabled || bindingCode.length !== 6}
              label={loginText('signIn')}
              onPress={verify}
              testID="login.bindingVerifyButton"
            />
          </>
        )}
        {errorNode}
      </LoginPanel>
    );
  };

  /** browser-redirect:panel + 64 loading 环(figma §5.2 y=158)+ 取消。 */
  const renderBrowserRedirect = () => {
    const state = auth.loginState;
    if (state?.step !== 'browser-redirect') return null;
    return (
      <LoginPanel testID="login.panel.browserRedirect">
        <LoginTitleBlock
          title={loginText('browserTitle')}
          subtitle={`${state.label} · ${loginText('browserSubtitle')}`}
        />
        <LoginLoadingRing
          label={loginText('working')}
          y={LOGIN_LOADING_RING.yBrowser}
        />
        <LoginPrimaryButton
          disabled={auth.isBusy}
          label={loginText('cancel')}
          onPress={reset}
          testID="login.cancelBrowserButton"
        />
      </LoginPanel>
    );
  };

  /** error 步骤:全屏面板 + 重试(文案走 authErrorText / errorFallback 兜底)。 */
  const renderErrorStep = () => {
    const state = auth.loginState;
    if (state?.step !== 'error') return null;
    return (
      <LoginPanel testID="login.panel.error">
        <LoginTitleBlock title={loginText('title')} />
        <LoginPrimaryButton
          busy={auth.isBusy}
          disabled={auth.isBusy}
          label={loginText('retry')}
          onPress={reset}
          testID="login.errorRetryButton"
        />
        <LoginErrorText testID="login.error">
          {authErrorText(state.code) ?? loginText('errorFallback')}
        </LoginErrorText>
      </LoginPanel>
    );
  };

  /** config issue 面板(闸门态,样式走 loginError 族;messageKey → 5 语)。 */
  const renderConfigIssues = () => {
    if (configIssues.length === 0) return null;
    return (
      <LoginPanel testID="login.configPanel">
        <LoginTitleBlock title={loginText('configTitle')} />
        <View style={configIssueStyles.list}>
          {configIssues.map((issue) => (
            <Text key={issue.key} style={configIssueStyles.line}>
              {issue.key}: {loginText(issue.messageKey)}
            </Text>
          ))}
        </View>
      </LoginPanel>
    );
  };

  /** preparing 伪态:auth 尚未初始化(loginState 未就绪),figma §5.2 loading 64 @(308,193)。 */
  const renderPreparing = () => {
    if (auth.loginState || auth.initialized || configIssues.length > 0)
      return null;
    return (
      <LoginPanel testID="login.panel.preparing">
        <LoginTitleBlock title={loginText('title')} />
        <LoginLoadingRing
          label={loginText('working')}
          y={LOGIN_LOADING_RING.yPreparing}
        />
      </LoginPanel>
    );
  };

  /** 无 loginState 兜底单按钮态(默认/busy 双格;reset 重新拉起状态机)。 */
  const renderNoLoginState = () => {
    if (auth.loginState || !auth.initialized || configIssues.length > 0)
      return null;
    return (
      <LoginPanel testID="login.panel.noLoginState">
        <LoginTitleBlock title={loginText('title')} />
        <LoginPrimaryButton
          busy={auth.isBusy}
          disabled={!auth.initialized}
          label={auth.isBusy ? loginText('working') : loginText('continue')}
          onPress={reset}
          testID="login.retryButton"
        />
        {errorNode}
      </LoginPanel>
    );
  };

  // completed:瞬态,品牌 stage 保持、面板留空(NavigationGate 随即跳转首页)
  const stateContent =
    auth.loginState?.step === 'completed'
      ? null
      : configIssues.length > 0
        ? renderConfigIssues()
        : (renderIdentifier() ??
          renderMethodChoice() ??
          renderVerification() ??
          renderAccountSelection() ??
          renderSsoVerification() ??
          renderBinding() ??
          renderBrowserRedirect() ??
          renderErrorStep() ??
          renderPreparing() ??
          renderNoLoginState());

  // Log_in 组落位:x/y = surface.loginX/loginY(stage 设计 px)→ 物理 px;
  // 组内容缩放 = stage.scale × loginGroupScale(§3.6 pad 构图 0.794117 / 0.655357,
  // 手机 1)。Safe Area:背景 edge-to-edge(stage 宿主不裁),功能区保持 insets 内——
  // 组底边越过 bottom inset 时整组按差值上移(附录 C §3.4 工程定案)。
  const groupScale = stage.scale * stage.loginGroupScale;
  const groupLeftPx = stage.offsetX + stage.loginX * stage.scale;
  const groupTopPxRaw = stage.offsetY + stage.loginY * stage.scale;
  const bottomLimitPx = stage.viewportHeight - insets.bottom;
  // consent PR:identifier 主视图下方多出协议行(行底 622 超出组高 560 共 62 设计px)。
  // 流程底边全步骤恒取 622(含协议行的最低内容):一防步骤切换时 lift 释放产生
  // 整组纵向跳变(规则 7,codex 审查 P1),二让下方外层/内层容器 bounds 恒包住
  // 协议行——RN(尤其 Android)对父 bounds 外子节点不派发触摸,协议行必须在界内。
  const flowBottomDesignPx = loginSizes.flowHeight + LOGIN_CONSENT_ROW.bottomOverflow;
  const liftPx = Math.max(
    0,
    groupTopPxRaw + flowBottomDesignPx * groupScale - bottomLimitPx,
  );
  const groupTopPx = Math.max(0, groupTopPxRaw - liftPx);

  // 键盘契约(Step 5b.1,方案 B):唯一位移源 = 自定义 translate。
  // v5 冻结测量拓扑:基线只在下方「外层未变换测量 wrapper」上 measureInWindow
  // (天然不含 translate);键盘事件 / viewport 变化(Android resize)后重测,
  // 基线随 resize 更新 → 位移只计一次,无系统/自定义双算。
  const keyboard = useLoginKeyboardRect();
  const outerGroupRef = useRef<View>(null);
  const [groupBaseline, setGroupBaseline] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const measureBaseline = useCallback(() => {
    outerGroupRef.current?.measureInWindow((x, y) => {
      setGroupBaseline((prev) =>
        prev != null && prev.x === x && prev.y === y ? prev : { x, y },
      );
    });
  }, []);
  useEffect(() => {
    measureBaseline();
  }, [
    measureBaseline,
    keyboard.visible,
    keyboard.rect,
    stage.viewportWidth,
    stage.viewportHeight,
  ]);
  // 全高(键盘未显示时的 viewportHeight):Android edge-to-edge 下键盘以 insets 处理、
  // viewport 不缩窗,需独立跟踪全高以算「全高 - 键盘高 - 系统栏底」键盘顶(见
  // loginKeyboardAvoidance computeDockedKeyboardTop)。取 max 抗缩窗/旋转噪声。
  const [fullViewportHeight, setFullViewportHeight] = useState(stage.viewportHeight);
  useEffect(() => {
    setFullViewportHeight((prev) =>
      stage.viewportHeight > prev ? stage.viewportHeight : prev,
    );
  }, [stage.viewportHeight]);
  const shiftResult = useMemo(() => {
    if (groupBaseline == null) {
      return { shift: 0, mode: 'hidden' as const };
    }
    return computeLoginKeyboardShift({
      platform: Platform.OS === 'android' ? 'android' : 'ios',
      visible: keyboard.visible,
      keyboard: keyboard.rect,
      // 停靠贴附锚 = 面板底(Step 5b.1:panelBottom + 10 - keyboardTop)
      panelBottomY: groupBaseline.y + loginSizes.panelHeight * groupScale,
      // 悬浮相交判定锚 = 当前输入框 ∪ 主按钮(U-8b;输入框顶到主按钮底)
      controlsUnion: {
        x: groupBaseline.x + LOGIN_CONTROL.x * groupScale,
        y: groupBaseline.y + LOGIN_CONTROL.inputY * groupScale,
        width: LOGIN_CONTROL.width * groupScale,
        height:
          (LOGIN_CONTROL.buttonY +
            LOGIN_CONTROL.height -
            LOGIN_CONTROL.inputY) *
          groupScale,
      },
      viewportWidth: stage.viewportWidth,
      viewportHeight: stage.viewportHeight,
      safeTop: insets.top,
      fullViewportHeight,
      systemBarBottom: insets.bottom,
    });
  }, [
    groupBaseline,
    keyboard,
    groupScale,
    stage.viewportWidth,
    stage.viewportHeight,
    insets.top,
    fullViewportHeight,
    insets.bottom,
  ]);
  const keyboardShift = shiftResult.shift;

  // handoff 面板入场(demo:300+moveMs 起步,自下而上 20px + 渐显 420ms;
  // reduced-motion/已登录直入由 Provider 收敛为 done,此处直落终态)
  const panelEntrance = usePanelEntrance(handoffPhase, stage.mode, stage.scale);

  // 注销提示气泡(figma 678:1075):登录屏根容器 absolute 浮层,viewport 物理坐标,
  // 不随键盘位移、不参与 stage 缩放;渲染序在登录组之后 = 盖过立绘/字标/面板/社交行,
  // 协议弹窗仍在更上层(modal 拦截优先)。
  const deletionBubbleFrame = accountDeletionStatus
    ? resolveDeletionBubbleFrame(stage, insets.top)
    : null;
  // 气泡对读屏隐藏的条件:① 协议弹窗打开(气泡是弹窗兄弟浮层,不隐藏则 TalkBack 可
  // 穿透读到文案、completed 态还能激活「我知道了」);② 入场未完成(opacity/pointerEvents
  // 只管渲染与命中,读屏仍会念出不可见的注销状态)。iOS 走 accessibilityElementsHidden、
  // Android 走 importantForAccessibility,两端都要给(PR #464 codex)。
  const realmConsentOpen = realmConfirmation !== null;
  const captchaChallengeOpen = auth.captchaChallenge !== null;
  const deletionBubbleA11yHidden =
    consentDialogOpen || realmConsentOpen || captchaChallengeOpen || handoffPhase !== 'done';

  return (
    <MobileLoginHandoffStage
      keyboardShiftPx={keyboardShift}
      testID="login.screen"
    >
      {/* 渲染为 null,仅把状态栏样式写进本屏 screen options。iOS 专用:
          Android 由舞台内组件式 StatusBar 控制,不走 RNS 双轨 */}
      {Platform.OS === 'ios' ? (
        <Stack.Screen
          options={{
            statusBarStyle: stageTheme === 'dark' ? 'light' : 'dark',
          }}
        />
      ) : null}
      {/* 外层未变换测量 wrapper(v5 冻结拓扑):持布局基线,不参与任何 translate */}
      <View
        collapsable={false}
        // Android 读屏:弹窗打开时隐藏背景登录组(accessibilityViewIsModal 仅 iOS
        // 生效;codex 审查 P2)。iOS 忽略此属性,无副作用。
        importantForAccessibility={
          consentDialogOpen || realmConsentOpen || captchaChallengeOpen
            ? 'no-hide-descendants'
            : 'auto'
        }
        onLayout={measureBaseline}
        ref={outerGroupRef}
        style={{
          // 恒含协议行区间(622 设计px):协议行必须在父 bounds 内才可命中(见 flowBottomDesignPx 注)
          height: flowBottomDesignPx * groupScale,
          left: groupLeftPx,
          position: 'absolute',
          top: groupTopPx,
          width: LOGIN_GROUP.width * groupScale,
        }}
      >
        {/* 内层 translate 容器:键盘位移唯一施加处(方案 B) */}
        <View style={{ flex: 1, transform: [{ translateY: -keyboardShift }] }}>
          <Animated.View
            style={{
              flex: 1,
              opacity: panelEntrance.opacity,
              transform: [{ translateY: panelEntrance.translateY }],
            }}
          >
            {/* 内层 680 宽设计 px 坐标系,整层 transform 缩放(demo loginGroup 同构);
                高度恒 622(组 560 + 协议行 overflow 62),保证协议行在 bounds 内可命中 */}
            <View
              style={{
                height: flowBottomDesignPx,
                left: 0,
                position: 'absolute',
                top: 0,
                transform: [{ scale: groupScale }],
                transformOrigin: 'top left',
                width: LOGIN_GROUP.width,
              }}
            >
              {stateContent}
            </View>
          </Animated.View>
        </View>
      </View>
      {accountDeletionStatus && deletionBubbleFrame ? (
        // 入场门(PR #464 review,与桌面同口径):opacity 结构性跟随面板入场的
        // Animated 值(splash=0 → handoff 渐显 → done=1,同一 usePanelEntrance 输出,
        // 不新造状态机);pointerEvents 仅 done 放行——入场完成前气泡不可见也不可点。
        <Animated.View
          // 读屏隔离(见 deletionBubbleA11yHidden 注):iOS + Android 双端属性都给,
          // 覆盖「协议弹窗打开」与「入场未完成」两种不该被念出的时刻。
          accessibilityElementsHidden={deletionBubbleA11yHidden}
          importantForAccessibility={
            deletionBubbleA11yHidden ? 'no-hide-descendants' : 'auto'
          }
          // box-none 而非 auto:包装层铺满全屏(absoluteFill),RN 下全屏 View 即使透明
          // 也会吃掉命中区、挡住下方登录组的输入框/按钮/社交入口(web 的穿透直觉不适用)。
          // box-none = 自身不作触摸目标、子节点(气泡)照常可点(Greptile 审查 P1)。
          pointerEvents={handoffPhase === 'done' ? 'box-none' : 'none'}
          style={[StyleSheet.absoluteFill, { opacity: panelEntrance.opacity }]}
        >
          <AccountDeletionStatusPanel
            frame={deletionBubbleFrame}
            onDismiss={
              accountDeletionStatus.status === 'completed'
                ? () => void auth.clearAccountDeletionReceipt()
                : undefined
            }
            status={accountDeletionStatus}
          />
        </Animated.View>
      ) : null}
      {/* 服务条款和隐私协议确认弹窗(figma 602:822/602:1249):个人登录链路在
          radio 未勾选时统一拦截;同意=勾选并续接,不同意=留在登录页。stage 内
          全屏遮罩(继承首启亮色门主题上下文),zIndex 盖过登录组。 */}
      {consentDialogOpen ? (
        <LoginConsentDialog
          scale={groupScale}
          title={loginText('consentDialogTitle')}
          body={loginText('consentDialogBody')}
          agreeLabel={loginText('consentAgree')}
          disagreeLabel={loginText('consentDisagree')}
          onAgree={agreeConsent}
          onDisagree={dismissConsent}
          onOpenTerms={() => openLegalLink('terms')}
          onOpenPrivacy={() => openLegalLink('privacy')}
        />
      ) : null}
      {realmConfirmation ? (
        <LoginConsentDialog
          scale={groupScale}
          title={loginText('realmConsentTitle')}
          body={loginText(
            realmConfirmation.targetRegion === 'cn'
              ? 'realmConsentBodyCn'
              : 'realmConsentBodyGlobal',
          )}
          agreeLabel={loginText('realmConsentAgree')}
          disagreeLabel={loginText('realmConsentDisagree')}
          onAgree={() =>
            void auth.dispatchLoginAction({ type: 'confirm-sso-realm' })
          }
          onDisagree={() =>
            void auth.dispatchLoginAction({ type: 'cancel-sso-realm' })
          }
          onOpenTerms={() => undefined}
          onOpenPrivacy={() => undefined}
        />
      ) : null}
      {/* 人机验证挑战层(global 邮箱发码前置闸):incognito WebView 装载
          auth-server 托管的 Turnstile 页,结果回 AuthContext 挂起的发码动作。 */}
      {auth.captchaChallenge ? (
        <LoginCaptchaWebView
          url={auth.captchaChallenge.url}
          onResult={auth.resolveCaptchaChallenge}
        />
      ) : null}
    </MobileLoginHandoffStage>
  );
}

/**
 * handoff 面板入场动画(demo splashHandoff:登录 UI 在立绘/字标落定后马上出现——
 * 自下而上 20px + 渐显,420ms cubic-bezier(.35,.1,.25,1);起步 = 300 + moveMs,
 * iPad 横屏 moveMs=0)。transform/opacity + useNativeDriver(compositor-only)。
 */
function usePanelEntrance(
  phase: LoginHandoffPhase,
  mode: LoginSurfaceMode,
  stageScale: number,
) {
  const opacity = useRef(new Animated.Value(phase === 'done' ? 1 : 0)).current;
  const rise = useRef(new Animated.Value(phase === 'done' ? 0 : 1)).current;
  useEffect(() => {
    if (phase === 'handoff') {
      const easing = Easing.bezier(
        LOGIN_HANDOFF_EASING.panelIn[0],
        LOGIN_HANDOFF_EASING.panelIn[1],
        LOGIN_HANDOFF_EASING.panelIn[2],
        LOGIN_HANDOFF_EASING.panelIn[3],
      );
      Animated.sequence([
        Animated.delay(loginHandoffPanelDelayMs(mode)),
        Animated.parallel([
          Animated.timing(opacity, {
            toValue: 1,
            duration: LOGIN_HANDOFF_TIMING.panelInMs,
            easing,
            useNativeDriver: true,
          }),
          Animated.timing(rise, {
            toValue: 0,
            duration: LOGIN_HANDOFF_TIMING.panelInMs,
            easing,
            useNativeDriver: true,
          }),
        ]),
      ]).start();
      return;
    }
    if (phase === 'done') {
      opacity.setValue(1);
      rise.setValue(0);
      return;
    }
    opacity.setValue(0);
    rise.setValue(1);
  }, [phase, mode, opacity, rise]);
  // 20 设计 px 自下而上(stage 坐标 → 物理 px 随 stage.scale)
  const translateY = rise.interpolate({
    inputRange: [0, 1],
    outputRange: [0, LOGIN_HANDOFF_TIMING.panelInOffsetPx * stageScale],
  });
  return { opacity, translateY };
}

/**
 * 注销状态提示气泡(figma 678:1075「注销状态」组件集)。
 *
 * 浮层:落位与宽度由 `resolveDeletionBubbleFrame` 给出(物理 pt),内部几何(圆角 /
 * padding / 字号 / 行高 / 间距)是 **stage 设计单位**,与登录组同乘 `frame.scale`
 * 折算成物理 pt——故 figma 数值可逐字落码,气泡与登录面板保持设计稿里的比例关系。
 * (2026-07-26 修正:初版把设计单位当物理 pt 用、宽度写死 335,比例失真。)
 * 描边保持 1pt 物理细线;高度由内容撑开,禁止固定高;无图标 / 阴影 / 动画。
 */
function AccountDeletionStatusPanel({
  frame,
  onDismiss,
  status,
}: {
  frame: LoginDeletionBubbleFrame;
  onDismiss?: () => void;
  status: AccountDeletionStatus;
}) {
  const styles = useThemedStyles(makeStyles);
  const pending = status.status === 'pending';
  const scaled = (designUnits: number) => designUnits * frame.scale;
  const B = LOGIN_DELETION_BUBBLE;
  return (
    <View
      style={[
        styles.deletionBubble,
        {
          borderRadius: scaled(B.radius),
          left: frame.left,
          padding: scaled(B.padding),
          top: frame.top,
          width: frame.width,
        },
      ]}
      testID="login.accountDeletionStatus"
    >
      <Text
        style={[
          styles.deletionBubbleTitle,
          { fontSize: scaled(B.font), lineHeight: scaled(B.lineHeight) },
        ]}
      >
        {pending
          ? loginText('accountDeletionPendingTitle')
          : status.status === 'processing'
            ? loginText('accountDeletionProcessingTitle')
            : loginText('accountDeletionCompletedTitle')}
      </Text>
      <Text
        style={[
          styles.deletionBubbleCopy,
          {
            fontSize: scaled(B.font),
            lineHeight: scaled(B.lineHeight),
            marginTop: scaled(B.titleBodyGap),
          },
        ]}
      >
        {pending
          ? loginText('accountDeletionPendingCopy').replace(
              '{date}',
              formatAccountDeletionDate(status.deleteAfter),
            )
          : status.status === 'processing'
            ? loginText('accountDeletionProcessingCopy')
            : loginText('accountDeletionCompletedCopy')}
      </Text>
      {onDismiss ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={resolveDeletionBubbleLinkHitSlop(frame.scale)}
          onPress={onDismiss}
          style={[styles.deletionBubbleLink, { marginTop: scaled(B.bodyLinkGap) }]}
          testID="login.accountDeletionDismissButton"
        >
          <Text
            style={[
              styles.deletionBubbleLinkText,
              { fontSize: scaled(B.font), lineHeight: scaled(B.lineHeight) },
            ]}
          >
            {loginText('accountDeletionDismiss')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function formatAccountDeletionDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(getAuthLocale(), {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

function socialLabel(provider: SocialProvider): string {
  return loginText(provider);
}

/** 验证码输入(figma §4.2 居中变体;verification 与 binding 阶段二共用,testID 沿旧)。 */
function CodeInput({
  disabled,
  error,
  onChange,
  onSubmit,
  value,
}: {
  disabled: boolean;
  error?: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  value: string;
}) {
  return (
    <LoginSkinInput
      autoComplete="one-time-code"
      center
      editable={!disabled}
      error={error}
      keyboardType="number-pad"
      maxLength={6}
      onChangeText={(next) => onChange(next.replace(/\D/g, ''))}
      onSubmitEditing={onSubmit}
      placeholder={loginText('codePlaceholder')}
      returnKeyType="done"
      testID="login.codeInput"
      value={value}
    />
  );
}

/** config issue 列表样式(loginError 族;绝对定位落在副标题至输入区之间)。 */
const configIssueStyles = {
  list: {
    gap: 10,
    left: LOGIN_SUBTITLE.x,
    position: 'absolute' as const,
    top: LOGIN_TITLE.y + LOGIN_TITLE.height + 40,
    width: LOGIN_SUBTITLE.width,
  },
  line: {
    // loginError 语义豁免跨模式同值(#D91F37),静态样式取 light 侧即可
    color: loginPalettes.light.loginError,
    fontSize: LOGIN_ERROR_TEXT.font,
    fontWeight: fontWeight.regular,
    textAlign: 'center' as const,
  },
} as const;

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    flex: { flex: 1 },
    safeArea: {
      backgroundColor: colors.surface,
      flex: 1,
    },
    scrollContent: {
      flexGrow: 1,
      gap: spacing.xl,
      paddingHorizontal: spacing.xl,
      paddingVertical: spacing.xxl,
    },
    topBar: {
      justifyContent: 'center',
      minHeight: 44,
      paddingHorizontal: spacing.xl,
    },
    brandBlock: { gap: spacing.sm },
    brandRow: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    product: {
      color: colors.textTertiary,
      fontSize: typeScale.caption,
      fontWeight: fontWeight.semibold,
      textTransform: 'uppercase',
    },
    title: {
      color: colors.textPrimary,
      fontSize: typeScale.hero,
      fontWeight: fontWeight.bold,
    },
    card: {
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      gap: spacing.md,
      padding: spacing.lg,
    },
    // 注销提示气泡(figma 678:1075):不透明底 + 1px 描边(浮层盖立绘,必须不透明);
    // 与缩放相关的几何(圆角/padding/字号/行高/间距)在组件内按 frame.scale 行内折算,
    // left/top/width 由 resolveDeletionBubbleFrame 注入;描边保持 1pt 物理细线
    // (设计 1 单位折算后不足半点,会在部分密度下消失);无图标/阴影/动画,高度内容撑开。
    deletionBubble: {
      backgroundColor: colors.login.deletionBubbleBg,
      borderColor: colors.login.deletionBubbleBorder,
      borderWidth: LOGIN_DELETION_BUBBLE.borderWidth,
      position: 'absolute',
    },
    deletionBubbleTitle: {
      color: colors.login.controlText,
      fontWeight: fontWeight.regular,
      textAlign: 'center',
    },
    deletionBubbleCopy: {
      color: colors.login.secondaryText,
      fontWeight: fontWeight.regular,
      textAlign: 'center',
    },
    deletionBubbleLink: {
      alignSelf: 'center',
    },
    deletionBubbleLinkText: {
      color: colors.login.controlText,
      fontWeight: fontWeight.regular,
      textAlign: 'center',
      textDecorationLine: 'underline',
    },
    stepHeader: { gap: spacing.xs, marginBottom: spacing.xs },
    stepTitle: {
      color: colors.textPrimary,
      fontSize: typeScale.title,
      fontWeight: fontWeight.semibold,
    },
    stepSubtitle: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
    },
    segmented: {
      backgroundColor: colors.surfaceChip,
      borderRadius: radius.pill,
      flexDirection: 'row',
      padding: spacing.xs,
    },
    segment: {
      alignItems: 'center',
      borderRadius: radius.pill,
      flex: 1,
      flexDirection: 'row',
      gap: spacing.xs,
      justifyContent: 'center',
      minHeight: 36,
    },
    segmentSelected: { backgroundColor: colors.surfaceElevated },
    segmentText: {
      color: colors.textPrimary,
      fontSize: typeScale.footnote,
      fontWeight: fontWeight.medium,
    },
    input: {
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      color: colors.textPrimary,
      fontSize: typeScale.body,
      minHeight: 48,
      paddingHorizontal: spacing.lg,
    },
    phoneRow: {
      alignItems: 'center',
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: spacing.xs,
      minHeight: 48,
      paddingHorizontal: spacing.lg,
    },
    phonePrefix: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
    },
    phoneRowInput: {
      color: colors.textPrimary,
      flex: 1,
      fontSize: typeScale.body,
      minHeight: 48,
      paddingVertical: 0,
    },
    codeInput: {
      fontWeight: fontWeight.semibold,
      letterSpacing: spacing.sm,
      textAlign: 'center',
    },
    helper: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      textAlign: 'center',
    },
    error: {
      borderColor: colors.errorBorder,
      borderRadius: radius.control,
      borderWidth: StyleSheet.hairlineWidth,
      color: colors.errorText,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      padding: spacing.md,
    },
    configPanel: {
      borderColor: colors.borderStrong,
      borderRadius: radius.control,
      borderWidth: StyleSheet.hairlineWidth,
      gap: spacing.xs,
      padding: spacing.md,
    },
    configTitle: {
      color: colors.textPrimary,
      fontSize: typeScale.footnote,
      fontWeight: fontWeight.semibold,
    },
    configCopy: {
      color: colors.textSecondary,
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
    },
    divider: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.sm,
      marginVertical: spacing.xs,
    },
    dividerLine: {
      backgroundColor: colors.border,
      flex: 1,
      height: StyleSheet.hairlineWidth,
    },
    dividerText: { color: colors.textTertiary, fontSize: typeScale.caption },
    backButton: {
      alignItems: 'center',
      alignSelf: 'flex-start',
      flexDirection: 'row',
      gap: spacing.xs,
      minHeight: 36,
    },
    backText: { color: colors.textSecondary, fontSize: typeScale.footnote },
    accountRow: {
      alignItems: 'center',
      borderColor: colors.border,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: spacing.md,
      minHeight: 60,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    accountCopy: { flex: 1, minWidth: 0 },
    accountTitle: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
    },
    accountSubtitle: {
      color: colors.textSecondary,
      fontSize: typeScale.caption,
    },
    pressed: { opacity: 0.72 },
  });
