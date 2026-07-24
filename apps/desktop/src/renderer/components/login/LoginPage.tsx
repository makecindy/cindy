import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { AccountDeletionStatus, SocialProvider, VerificationKind } from '@cindy/auth-client';
import { isValidEmail } from '@cindy/auth-client';

import { cn } from '@/lib/utils';
import { WindowControls } from '@/components/title-bar/WindowControls';
import { useLogin } from '@/hooks/useLogin';
import { endLoginFirstLaunchLightGate, loginFirstLaunchLightActive } from '@/hooks/useTheme';
import { LOGIN_HANDOFF_TIMINGS, useLoginHandoff } from '@/contexts/LoginHandoffContext';

import { useIsDarkMode } from '@/components/markdown/useIsDarkMode';

import appleIcon from '@/assets/login/icons/apple.svg';
import appleIconDark from '@/assets/login/icons/apple-dark.svg';
import googleIcon from '@/assets/login/icons/google.svg';
import wechatIcon from '@/assets/login/icons/wechat.svg';
import ssoIcon from '@/assets/login/icons/sso.svg';
import ssoIconDark from '@/assets/login/icons/sso-dark.svg';
import guestIcon from '@/assets/login/icons/guest.svg';
import guestIconDark from '@/assets/login/icons/guest-dark.svg';

import { LoginStage } from './LoginStage';
import {
  LoginBackButton,
  LoginConsentDialog,
  LoginConsentRow,
  LoginErrorText,
  LoginInput,
  LoginLoadingRing,
  LoginMethodRow,
  LoginPanel,
  LoginPrimaryButton,
  LoginSocialButton,
  LoginSocialRow,
  LoginTextLink,
  LoginTitleBlock,
} from './LoginControls';
import { useResendCountdown } from './useResendCountdown';
import { CURRENT_CINDY_REGION } from '../../../shared/brandRegion';
import { LEGAL_LINKS } from '../../../shared/legalLinks';
import { resolveIdentifierMethod } from '../../../shared/loginIdentifierMethod';
import {
  DRAG_BAR_HEIGHT,
  LOADING_RING,
  LOGIN_COLORS,
  LOGIN_LOCAL_MODE,
  TEXT_LINK,
} from './loginDesignTokens';
import { canResumePendingConsent, makeConsentStamp, type ConsentStamp } from './consentGate';

/**
 * LoginPage — 桌面登录(wave4 白底体系 + figma §4 组件库)。
 *
 * 呈现层职责:凭证/票据全在 main(useLogin dispatch IPC),本组件只做视图状态机
 * 渲染与本地格式校验。覆盖全部登录步骤:identifier 主视图 / ssoOrgMode 子视图
 * (含 sso-org-list = method-choice 的 SSO 入口来源变体)/ method-choice /
 * verification-code / account-selection / binding / preparing / error,以及
 * 协议同意链路(radio + 拦截弹窗)与游客入口。倒计时契约、Text_link 全态、
 * 错误码映射均已落地(历史施工批次见 git log,不再在注释中引用)。
 */
export function LoginPage() {
  const {
    isLoading,
    errorCode,
    loginState,
    hasAccountDeletionReceipt = false,
    getAccountDeletionStatus,
    clearAccountDeletionReceipt,
    dispatch,
    clearError,
  } = useLogin();
  const { t } = useTranslation();
  const handoff = useLoginHandoff();

  // 主题跟随(DESIGN.md §16.5):首次打开 Cindy → 亮色登录界面(默认);第二次起
  // → 跟随用户上一次使用的主题。首启亮色门在 bootstrap 已生效(品牌舞台首帧即
  // 亮色,无暗→亮闪变),此处只负责登录页卸载(登录完成/离开)时结束门并恢复
  // 存储主题解析,不改用户 theme 偏好。
  useEffect(() => {
    if (!loginFirstLaunchLightActive()) return;
    return () => {
      endLoginFirstLaunchLightGate();
    };
  }, []);
  const isMac = window.electronAPI?.platform === 'darwin';
  const [localModePending, setLocalModePending] = useState(false);

  const openLocalMode = async () => {
    if (isLoading || localModePending || !window.electronAPI?.authEnterLocal) return;
    setLocalModePending(true);
    try {
      await window.electronAPI.authEnterLocal();
      // The auth state event normally redirects through GuestRoute. Keep the
      // transition deterministic when the IPC response wins that race.
      window.location.hash = '#/';
    } finally {
      setLocalModePending(false);
    }
  };

  // 企业 SSO 入口子视图:在 identifier 步骤内输入组织标识(本地展示态,不进 main)。
  // 需先于 bottomReserve 计算声明——协议行只在 identifier 主视图渲染,sso-org 子视图隐藏。
  const [ssoOrgMode, setSsoOrgMode] = useState(false);

  /* ── 协议同意链路(consent PR):radio 状态 + 未勾选拦截弹窗 + 同意后续接。
     过门点(产品拍板 2026-07-24 二次):手机号提交、邮箱提交(discover 前)、
     method-choice 个人行发码、社交圆钮(Apple/Google/未来微信)、游客——个人
     登录一律先同意协议再发起,包括仅触发方式查询的 email discover(拍板压过
     审查侧「discover 无副作用可放行」的建议)。豁免仅限显式企业 SSO 入口:
     SSO 圆钮、组织标识提交、method-choice sso 行。pending 动作只存 renderer
     本地(不进 main loginFlowState;规则 9:分支全部代码状态机化)。 ── */
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [consentDialogOpen, setConsentDialogOpen] = useState(false);
  // pending 带开门时刻快照,同意时复验防陈旧续接(codex 审查 P1;consentGate 单测)
  const pendingConsentAction = useRef<{
    action: () => void;
    stamp: ConsentStamp;
  } | null>(null);

  const requireConsent = (action: () => void) => {
    if (consentAccepted) {
      action();
      return;
    }
    pendingConsentAction.current = {
      action,
      stamp: makeConsentStamp(loginState?.step, isLoading, loginState?.step === 'completed'),
    };
    setConsentDialogOpen(true);
  };
  const agreeConsent = () => {
    // 同意 = 自动勾选 radio + 续接用户刚才点的那条登录链路(产品拍板)
    setConsentAccepted(true);
    setConsentDialogOpen(false);
    const pending = pendingConsentAction.current;
    pendingConsentAction.current = null;
    if (!pending) return;
    // 复验:弹窗期间 auth 状态被异步推进(登录完成/步骤切换/in-flight)则丢弃动作
    const current = makeConsentStamp(loginState?.step, isLoading, loginState?.step === 'completed');
    if (canResumePendingConsent(pending.stamp, current)) pending.action();
  };
  const dismissConsent = () => {
    // 不同意 = 退回登录页,radio 保持未勾选
    pendingConsentAction.current = null;
    setConsentDialogOpen(false);
  };
  // 弹窗打开期间登录上下文漂移(完成/步骤切换)→ 自动收窗弃 pending
  useEffect(() => {
    if (!consentDialogOpen) return;
    const pending = pendingConsentAction.current;
    const step = loginState?.step ?? 'unknown';
    if (step === 'completed' || (pending && step !== pending.stamp.step)) {
      pendingConsentAction.current = null;
      setConsentDialogOpen(false);
    }
  }, [consentDialogOpen, loginState?.step]);
  const openLegalLink = (kind: 'terms' | 'privacy') => {
    // 链接经系统默认浏览器打开(shell:open-external 只放行 http(s),未登录可用);
    // URL 按构建区域分流(国内 protocol.xd.cn / 国际 protocol.xd.com)。
    // 吞掉 IPC 失败(与移动端 Linking.openURL(...).catch 同口径),避免未处理 rejection
    void window.electronAPI
      ?.openExternal?.(kind === 'terms' ? LEGAL_LINKS.termsOfService : LEGAL_LINKS.privacyPolicy)
      .catch(() => undefined);
  };

  // handoff「面板已挂载」信号(未登录分支进 panel 步的前置锚,Step 3b WHAT2);
  // 卸载(路由离开 /login)时回报,品牌 overlay 据此卸载。
  const { reportLoginPanelMounted, reportLoginPanelUnmounted } = handoff;
  useEffect(() => {
    reportLoginPanelMounted();
    return () => reportLoginPanelUnmounted();
  }, [reportLoginPanelMounted, reportLoginPanelUnmounted]);
  // 游客入口已移入第三方圆钮行(identifier 视图人形圆钮);footer 仅保留 error 步
  // 的「跳过登录」逃生入口——登录服务不可用时用户仍能进入本地模式(既有产品保证)。
  const showLocalModeFooter = loginState?.step === 'error';
  // 面板底部预留恒取全流程最大值(footer 124;协议行 48 被其覆盖):step 切换时
  // 面板/品牌层零跳位(规则 7,codex 审查 P1)。browser-redirect/completed 维持 0,
  // 与迁移前 main 口径一致(该两步由品牌 overlay/跳转态接管)。
  const panelBottomReserve =
    loginState?.step === 'browser-redirect' || loginState?.step === 'completed'
      ? 0
      : LOGIN_LOCAL_MODE.reservedHeight;
  const { reportPanelBottomReserve } = handoff;
  useLayoutEffect(() => {
    reportPanelBottomReserve(panelBottomReserve);
  }, [panelBottomReserve, reportPanelBottomReserve]);
  useLayoutEffect(() => {
    return () => reportPanelBottomReserve(null);
  }, [reportPanelBottomReserve]);
  const isGlobalBuild = import.meta.env.VITE_CINDY_AUTH_REGION === 'global';
  // identifier 形态 = 构建区域确定性推导(用户拍板 2026-07-21:手机/邮箱分区互斥,
  // 双 tab 切换移除);providers 仅兜底区域首选方式未下发的场景。
  const identifierKind: VerificationKind = useMemo(
    () =>
      loginState?.step === 'identifier'
        ? resolveIdentifierMethod(CURRENT_CINDY_REGION, loginState.providers)
        : isGlobalBuild
          ? 'email'
          : 'phone',
    [loginState, isGlobalBuild],
  );
  const [identifier, setIdentifier] = useState('');
  // identifier 本地格式校验错误(设计稿 347:1727:非法邮箱/手机号 → 输入框红边 +
  // 底部红字「请输入正确邮箱」/「请输入正确手机号」)。提交前本地拦截、不发 discover
  // (规则 9:能代码化的格式校验不甩给 server 往返);与 server errorCode 互斥展示
  // (本地错误优先),输入变更即清除。null = 无本地格式错误。
  const [identifierFormatError, setIdentifierFormatError] = useState<VerificationKind | null>(null);
  const [ssoOrg, setSsoOrg] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [ssoVerificationCode, setSsoVerificationCode] = useState('');
  const [bindingContact, setBindingContact] = useState('');
  const [bindingCode, setBindingCode] = useState('');
  // 42s 重发倒计时(Step 3a):起算=request-code 成功返回,离开验证码步清理
  const { remaining: resendRemaining, arm: armResendCountdown } = useResendCountdown(
    loginState?.step === 'verification-code',
  );
  const [accountDeletionStatus, setAccountDeletionStatus] = useState<AccountDeletionStatus | null>(
    null,
  );

  useEffect(() => {
    if (!hasAccountDeletionReceipt || !getAccountDeletionStatus || !clearAccountDeletionReceipt) {
      setAccountDeletionStatus(null);
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const scheduleNext = () => {
      if (!disposed) timer = setTimeout(() => void poll(), 30_000);
    };
    const poll = async () => {
      const result = await getAccountDeletionStatus().catch(() => null);
      if (!result) {
        scheduleNext();
        return;
      }
      if (disposed) return;
      if (!result.success) {
        if (result.code === 'ACCOUNT_DELETION_RECEIPT_INVALID') {
          await clearAccountDeletionReceipt().catch(() => undefined);
          if (!disposed) setAccountDeletionStatus(null);
          return;
        }
        // Contract drift is not a retryable network failure. Preserve the
        // receipt for a later app mount, but stop this page's polling loop.
        if (result.code === 'INVALID_RESPONSE') {
          setAccountDeletionStatus(null);
          return;
        }
        scheduleNext();
        return;
      }
      const status = result.value;
      if (!status) {
        await clearAccountDeletionReceipt().catch(() => undefined);
        setAccountDeletionStatus(null);
        return;
      }
      if (status.status === 'cancelled') {
        await clearAccountDeletionReceipt().catch(() => undefined);
        if (!disposed) setAccountDeletionStatus(null);
        return;
      }
      setAccountDeletionStatus(status);
      if (status.status !== 'completed') scheduleNext();
    };

    void poll();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [clearAccountDeletionReceipt, getAccountDeletionStatus, hasAccountDeletionReceipt]);

  useEffect(() => {
    if (loginState?.step !== 'identifier') return;
    setSsoOrgMode(false);
    setVerificationCode('');
    setSsoVerificationCode('');
    setBindingContact('');
    setBindingCode('');
    setIdentifierFormatError(null);
  }, [loginState?.step]);

  const errorMessage = useMemo(() => {
    if (!errorCode) return null;
    return t(`login.errors.${errorCode}`, {
      defaultValue: t('login.errors.fallback'),
    });
  }, [errorCode, t]);

  const reset = () => {
    clearError();
    setIdentifierFormatError(null);
    void dispatch({ type: 'reset' });
  };

  // request-code 类动作统一走这里:成功返回时刻 = 倒计时起算点(Step 3a);
  // 失败(含重发失败)不 arm → 保持当前 deadline。
  const dispatchRequestCode = async (kind: VerificationKind, value: string) => {
    const ok = await dispatch({ type: 'request-code', kind, identifier: value });
    if (ok) armResendCountdown();
  };

  const submitIdentifier = (event: FormEvent) => {
    event.preventDefault();
    const value = identifier.trim();
    if (!value) return;
    if (identifierKind === 'email') {
      // 非法邮箱格式本地拦截 → 红边 + 红字「请输入正确邮箱」(设计稿 347:1727),
      // 不发 discover(避免明显非法值走一次 server 往返)。
      if (!isValidEmail(value)) {
        clearError();
        setIdentifierFormatError('email');
        return;
      }
      setIdentifierFormatError(null);
      // 邮箱提交先过协议门(产品拍板 2026-07-24 二次:手机号/邮箱提交一律先弹协议
      // 弹窗,压过审查侧「discover 纯查询可放行」的建议;显式企业 SSO 入口仍豁免)
      requireConsent(() => void dispatch({ type: 'discover', email: value }));
    } else {
      // 手机号:桌面不做客户端 +86/号段校验(#223 仅移动端做 cnPhone 本地拦截),
      // 输入原样透传服务端 request-code,由服务端校验号段合法性。
      setIdentifierFormatError(null);
      requireConsent(() => void dispatchRequestCode('phone', value));
    }
  };

  const submitSsoOrg = (event: FormEvent) => {
    event.preventDefault();
    const value = ssoOrg.trim();
    if (!value) return;
    void dispatch({ type: 'discover-sso-org', org: value });
  };

  /* ── identifier 主视图(680×560 组:面板 + 第三方圆钮行) ── */
  const renderIdentifier = () => {
    if (!loginState || loginState.step !== 'identifier') return null;
    const providers = loginState.providers;
    if (ssoOrgMode) return renderSsoOrg();
    return (
      <>
        <LoginPanel testId="login-panel-identifier">
          {/* noValidate:关掉浏览器对 type="email" 的原生约束校验气泡(英文系统提示,
              不受主题控制),改由下方本地校验渲染设计稿定义的红边+红字错误态。 */}
          <form onSubmit={submitIdentifier} noValidate>
            <LoginTitleBlock
              title={t('login.title')}
              subtitle={t('login.subtitle')}
              globalPill={isGlobalBuild ? t('login.globalRegion') : undefined}
            />
            <LoginInput
              autoFocus
              disabled={isLoading}
              type={identifierKind === 'email' ? 'email' : 'tel'}
              autoComplete={identifierKind === 'email' ? 'email' : 'tel'}
              value={identifier}
              // 手机形态:桌面不做客户端 +86/号段清洗(#223 仅移动端做 cnPhone),
              // 输入原样受控;输入变更即清除本地格式错误态(用户开始修正邮箱
              // 时红边/红字随之消失)。
              onChange={(next) => {
                if (identifierFormatError) setIdentifierFormatError(null);
                setIdentifier(next);
              }}
              placeholder={t(
                identifierKind === 'email' ? 'login.emailPlaceholder' : 'login.phonePlaceholder',
              )}
              error={!!errorCode || identifierFormatError != null}
            />
            <LoginPrimaryButton
              type="submit"
              disabled={!identifier.trim()}
              loading={isLoading}
              testId="login-continue-button"
            >
              {isLoading ? t('login.working') : t('login.continue')}
            </LoginPrimaryButton>
            {/* 本地格式错误优先展示(设计稿「请输入正确邮箱/手机号」),否则回退 server 错误码文案 */}
            {(identifierFormatError || errorMessage) && (
              <LoginErrorText>
                {identifierFormatError
                  ? t(
                      identifierFormatError === 'email'
                        ? 'login.invalidEmail'
                        : 'login.invalidPhone',
                    )
                  : errorMessage}
              </LoginErrorText>
            )}
          </form>
        </LoginPanel>
        <LoginSocialRow count={providers.social.length + 2}>
          {providers.social.map((provider) => (
            <LoginSocialButton
              key={provider}
              testId={`login-social-${provider}`}
              label={t('login.socialButton', { provider: t(`login.social.${provider}`) })}
              isLoading={isLoading}
              // Apple 圆钮走 ADR 官方配色(亮黑圆白标/暗白圆黑标,无描边;Guideline 4)
              variant={provider === 'apple' ? 'apple' : 'default'}
              onClick={() => {
                // SC-SOC-7: in-flight(isLoading)期间 no-op 防重复发起;行为层 guard,
                // 零视觉变化(圆钮已无 disabled 态 per §10 拍板,不回填 disabled 视觉)。
                if (isLoading) return;
                // 社交属个人登录链路,过协议门;同意后续接本次 start-browser
                requireConsent(
                  () =>
                    void dispatch({
                      type: 'start-browser',
                      kind: 'social',
                      providerOrConnectionId: provider,
                      label: t(`login.social.${provider}`),
                    }),
                );
              }}
            >
              <SocialProviderIcon provider={provider} />
            </LoginSocialButton>
          ))}
          {/* 企业 SSO = 行内最后一颗圆钮(329:243;取代旧文字链入口) */}
          <LoginSocialButton
            testId="login-social-sso"
            label={t('login.ssoEntry')}
            isLoading={isLoading}
            onClick={() => {
              // SC-SOC-7: in-flight 期间 no-op(行为层 guard,无 disabled 视觉回填)。
              // 企业 SSO 豁免协议门(产品拍板),不过 requireConsent。
              if (isLoading) return;
              clearError();
              setSsoOrgMode(true);
            }}
          >
            <SsoGlyph />
          </LoginSocialButton>
          {/* 游客登录 = 行内最后一颗人形圆钮(figma 379:680 mdi:user),接既有
              local mode;属个人链路,过协议门(同意后直接进主界面,产品拍板)。 */}
          <LoginSocialButton
            testId="login-social-guest"
            label={t('login.localModeEntry')}
            isLoading={isLoading || localModePending}
            onClick={() => {
              if (isLoading || localModePending) return;
              requireConsent(() => void openLocalMode());
            }}
          >
            <GuestGlyph />
          </LoginSocialButton>
        </LoginSocialRow>
        {/* 协议同意行(figma 600:660:圆钮行下方 22 设计px,组坐标 y=582;
            渲染门 = 所在 identifier 主视图分支,面板底部预留恒定已含其区间) */}
        <LoginConsentRow
          checked={consentAccepted}
          onToggle={() => setConsentAccepted((prev) => !prev)}
          statement={t('login.consentStatement')}
          onOpenTerms={() => openLegalLink('terms')}
          onOpenPrivacy={() => openLegalLink('privacy')}
        />
      </>
    );
  };

  /* ── 企业 SSO 入口子视图(sso-org empty/filled;680×440) ── */
  const renderSsoOrg = () => (
    <LoginPanel testId="login-panel-sso-org">
      <form onSubmit={submitSsoOrg} noValidate>
        <LoginBackButton
          disabled={isLoading}
          label={t('login.back')}
          onClick={() => {
            clearError();
            setSsoOrgMode(false);
          }}
        />
        <LoginTitleBlock title={t('login.ssoOrgTitle')} subtitle={t('login.ssoOrgSubtitle')} />
        <LoginInput
          autoFocus
          disabled={isLoading}
          maxLength={253}
          autoComplete="off"
          value={ssoOrg}
          onChange={setSsoOrg}
          placeholder={t('login.ssoOrgPlaceholder')}
          error={!!errorCode}
          testId="login-sso-org-input"
        />
        {/* 帮助行(demo ssoOrgPanel:text-link 位、无下划线、次级色) */}
        <span
          className="absolute flex items-center justify-center"
          style={{
            left: TEXT_LINK.x,
            top: TEXT_LINK.y,
            width: TEXT_LINK.width,
            height: 36,
            fontSize: TEXT_LINK.fontSize,
            color: LOGIN_COLORS.secondaryText,
          }}
        >
          {t('login.ssoOrgHint')}
        </span>
        <LoginPrimaryButton
          type="submit"
          disabled={!ssoOrg.trim()}
          loading={isLoading}
          testId="login-sso-org-continue"
        >
          {isLoading ? t('login.working') : t('login.continue')}
        </LoginPrimaryButton>
        {errorMessage && <LoginErrorText>{errorMessage}</LoginErrorText>}
      </form>
    </LoginPanel>
  );

  /* ── method-choice(含 sso-org-list 来源变体) ── */
  const renderMethodChoice = () => {
    if (loginState?.step !== 'method-choice') return null;
    const ssoMethods = loginState.methods.filter((method) => method.type === 'sso');
    // demo 呈现仲裁(methodChoicePanel):多 connection(≥2)时抑制个人行——
    // 面板 440 高只容两行(158/278),第三行 y=398+100 会溢出;ssoRequired 同样抑制。
    const emailAllowed =
      loginState.methods.some((method) => method.type === 'email_code') &&
      !ssoMethods.some((method) => method.ssoRequired) &&
      ssoMethods.length <= 1 &&
      !!loginState.email;
    const orgName = ssoMethods[0]?.orgName;
    // sso-org 入口来源(无邮箱上下文)行起点 148,邮箱 discovery 来源 158(demo 呈现仲裁)
    const fromSsoOrg = !loginState.email;
    const firstRowTop = fromSsoOrg ? 148 : 158;
    const rowStep = 120;
    const subtitle = orgName
      ? loginState.email
        ? t('login.orgDetected', { email: loginState.email, org: orgName })
        : t('login.ssoOrgDetected', { org: orgName })
      : loginState.email;
    return (
      <LoginPanel testId="login-panel-method-choice">
        <LoginBackButton disabled={isLoading} label={t('login.back')} onClick={reset} />
        <LoginTitleBlock title={t('login.chooseMethod')} subtitle={subtitle} />
        {ssoMethods.map((method, index) => (
          <LoginMethodRow
            key={method.connectionId}
            testId={`login-method-sso-${method.connectionId}`}
            top={firstRowTop + index * rowStep}
            disabled={isLoading}
            title={t('login.enterpriseLogin')}
            subtitle={t('login.enterpriseVia', { name: method.connectionName || method.orgName })}
            onClick={() =>
              void dispatch({
                type: 'start-browser',
                kind: 'sso',
                providerOrConnectionId: method.connectionId,
                label: method.connectionName,
              })
            }
          />
        ))}
        {emailAllowed && (
          <LoginMethodRow
            testId="login-method-personal"
            icon="person"
            top={firstRowTop + ssoMethods.length * rowStep}
            disabled={isLoading}
            title={t('login.personalLogin')}
            subtitle={t('login.personalDesc')}
            // 个人邮箱发码 = 个人链路实际发起点,在此过协议门(discover 已放行,
            // 保证企业用户经 discover→SSO 全程无门)
            onClick={() =>
              requireConsent(() => void dispatchRequestCode('email', loginState.email))
            }
          />
        )}
        {ssoMethods.some((method) => method.ssoRequired) && (
          <LoginTextLink variant="countdown" top={380} testId="login-sso-required-hint">
            {t('login.ssoRequired')}
          </LoginTextLink>
        )}
      </LoginPanel>
    );
  };

  /* ── verification-code(42s 重发倒计时 = 绝对 deadline 模型,双端同契约) ── */
  const renderVerification = () => {
    if (loginState?.step !== 'verification-code') return null;
    const submit = (event: FormEvent) => {
      event.preventDefault();
      if (verificationCode.length !== 6) return;
      void dispatch({
        type: 'verify-code',
        kind: loginState.kind,
        identifier: loginState.identifier,
        code: verificationCode,
      });
    };
    return (
      <LoginPanel testId="login-panel-verification">
        <form onSubmit={submit} noValidate>
          <LoginBackButton disabled={isLoading} label={t('login.back')} onClick={reset} />
          <LoginTitleBlock
            title={t('login.enterCode')}
            subtitle={t('login.codeSentTo', { identifier: loginState.identifier })}
          />
          <LoginInput
            autoFocus
            center
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            disabled={isLoading}
            value={verificationCode}
            onChange={(next) => setVerificationCode(next.replace(/\D/g, ''))}
            placeholder={t('login.codePlaceholder')}
            error={!!errorCode}
          />
          {resendRemaining > 0 ? (
            // 倒计时态(247:1614):#D4D4D4 无 underline 不可交互;文案随 tick 重算
            <LoginTextLink variant="countdown" testId="login-resend-countdown">
              {t('login.resendCountdown', { n: resendRemaining })}
            </LoginTextLink>
          ) : (
            // 重发链接(247:1612;hover 358:792/pressed U-9);成功重置 deadline,失败保持
            <LoginTextLink
              disabled={isLoading}
              testId="login-resend-link"
              onClick={() => void dispatchRequestCode(loginState.kind, loginState.identifier)}
            >
              {t('login.resendCode')}
            </LoginTextLink>
          )}
          <LoginPrimaryButton
            type="submit"
            disabled={verificationCode.length !== 6}
            loading={isLoading}
          >
            {isLoading ? t('login.verifying') : t('login.signIn')}
          </LoginPrimaryButton>
          {errorMessage && <LoginErrorText>{errorMessage}</LoginErrorText>}
        </form>
      </LoginPanel>
    );
  };

  /* ── account-selection(行样式复用方式行) ── */
  const renderAccountSelection = () => {
    if (loginState?.step !== 'account-selection') return null;
    return (
      <LoginPanel testId="login-panel-account-selection">
        <LoginBackButton disabled={isLoading} label={t('login.back')} onClick={reset} />
        <LoginTitleBlock
          title={t('login.chooseAccount')}
          subtitle={t('login.chooseAccountSubtitle')}
        />
        {/* demo accountPanel 呈现仲裁:行 148/268(step 120),左 icon 统一企业默认形
            (demo 两行均未传 icon 变体);副行 = 企业 meta / 个人身份 */}
        {loginState.accounts.map((account, index) => (
          <LoginMethodRow
            key={account.id}
            top={148 + index * 120}
            disabled={isLoading}
            title={account.displayName}
            subtitle={
              account.kind === 'org'
                ? account.orgName || account.email || ''
                : t('login.personalAccount')
            }
            logoUrl={account.kind === 'org' ? (account.orgLogoUrl ?? null) : null}
            onClick={() => void dispatch({ type: 'select-account', accountId: account.id })}
          />
        ))}
      </LoginPanel>
    );
  };

  /* ── sso-verification(验证企业联系方式;复用 verification-code 屏的皮;
     无倒计时——重发常驻可点,不套 resendRemaining 契约;主按钮 completeSignIn) ── */
  const renderSsoVerification = () => {
    if (loginState?.step !== 'sso-verification') return null;
    const verify = (event: FormEvent) => {
      event.preventDefault();
      if (ssoVerificationCode.length !== 6) return;
      void dispatch({
        type: 'verify-sso-verification',
        code: ssoVerificationCode,
      });
    };
    return (
      <LoginPanel testId="login-panel-sso-verification">
        <form onSubmit={verify} noValidate>
          <LoginBackButton disabled={isLoading} label={t('login.cancel')} onClick={reset} />
          <LoginTitleBlock
            title={t('login.ssoVerificationTitle')}
            subtitle={t('login.ssoVerificationSubtitle', { target: loginState.targetMasked })}
          />
          {!loginState.codeRequested ? (
            <LoginPrimaryButton
              disabled={isLoading}
              loading={isLoading}
              onClick={() => void dispatch({ type: 'request-sso-verification-code' })}
              testId="login-sso-verification-send"
            >
              {isLoading ? t('login.working') : t('login.sendCode')}
            </LoginPrimaryButton>
          ) : (
            <>
              <LoginInput
                autoFocus
                center
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                disabled={isLoading}
                value={ssoVerificationCode}
                onChange={(next) => setSsoVerificationCode(next.replace(/\D/g, ''))}
                placeholder={t('login.codePlaceholder')}
                error={!!errorCode}
              />
              {/* 无倒计时:重发常驻可点(照 origin/main sso-verification 实现,与
                  verification-code 屏的 resendRemaining 契约不同——SSO 验证码无冷却) */}
              <LoginTextLink
                disabled={isLoading}
                testId="login-sso-verification-resend"
                onClick={() => void dispatch({ type: 'request-sso-verification-code' })}
              >
                {t('login.resendCode')}
              </LoginTextLink>
              <LoginPrimaryButton
                type="submit"
                disabled={ssoVerificationCode.length !== 6}
                loading={isLoading}
              >
                {isLoading ? t('login.verifying') : t('login.completeSignIn')}
              </LoginPrimaryButton>
            </>
          )}
          {errorMessage && <LoginErrorText>{errorMessage}</LoginErrorText>}
        </form>
      </LoginPanel>
    );
  };

  /* ── binding 两阶段 ── */
  const renderBinding = () => {
    if (loginState?.step !== 'binding') return null;
    const contact = loginState.contact ?? bindingContact;
    const request = (event: FormEvent) => {
      event.preventDefault();
      if (!bindingContact.trim()) return;
      void dispatch({ type: 'request-binding-code', contact: bindingContact.trim() });
    };
    const verify = (event: FormEvent) => {
      event.preventDefault();
      if (!contact || bindingCode.length !== 6) return;
      void dispatch({ type: 'verify-binding', contact, code: bindingCode });
    };
    return (
      <LoginPanel testId="login-panel-binding">
        {/* noValidate:同 identifier,关掉 type="email" 绑定输入的原生校验气泡 */}
        <form onSubmit={loginState.codeRequested ? verify : request} noValidate>
          <LoginBackButton disabled={isLoading} label={t('login.cancel')} onClick={reset} />
          <LoginTitleBlock
            title={t(`login.binding.${loginState.bindType}Title`)}
            subtitle={t(`login.binding.${loginState.bindType}Subtitle`)}
          />
          {!loginState.codeRequested ? (
            <>
              <LoginInput
                autoFocus
                type={loginState.bindType === 'email' ? 'email' : 'tel'}
                autoComplete={loginState.bindType === 'email' ? 'email' : 'tel'}
                disabled={isLoading}
                value={bindingContact}
                onChange={setBindingContact}
                placeholder={t(
                  loginState.bindType === 'email'
                    ? 'login.emailPlaceholder'
                    : 'login.phonePlaceholder',
                )}
                error={!!errorCode}
              />
              <LoginPrimaryButton
                type="submit"
                disabled={!bindingContact.trim()}
                loading={isLoading}
              >
                {isLoading ? t('login.working') : t('login.sendCode')}
              </LoginPrimaryButton>
            </>
          ) : (
            <>
              <LoginInput
                autoFocus
                center
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                disabled={isLoading}
                value={bindingCode}
                onChange={(next) => setBindingCode(next.replace(/\D/g, ''))}
                placeholder={t('login.codePlaceholder')}
                error={!!errorCode}
              />
              {/* demo bindingPanel code 子态:countdown 样式「验证码已发送至 X」;
                  无重发钮(照现网,Step 3 WHAT1) */}
              <LoginTextLink variant="countdown" testId="login-binding-sent-to">
                {t('login.codeSentTo', { identifier: contact })}
              </LoginTextLink>
              <LoginPrimaryButton
                type="submit"
                disabled={bindingCode.length !== 6}
                loading={isLoading}
              >
                {isLoading ? t('login.verifying') : t('login.completeSignIn')}
              </LoginPrimaryButton>
            </>
          )}
          {errorMessage && <LoginErrorText>{errorMessage}</LoginErrorText>}
        </form>
      </LoginPanel>
    );
  };

  const renderContent = (): { node: ReactNode; ssoOrgGroupY: boolean } => {
    // preparing 伪态(loginState 尚未就绪;figma 5.2 准备态:loading 64 @(308,193))
    if (!loginState) {
      return {
        ssoOrgGroupY: false,
        node: (
          <LoginPanel testId="login-panel-preparing">
            <LoginTitleBlock title={t('login.preparing')} subtitle={t('login.preparingSubtitle')} />
            <LoginLoadingRing y={LOADING_RING.yPreparing} label={t('login.working')} />
          </LoginPanel>
        ),
      };
    }
    if (loginState.step === 'error') {
      return {
        ssoOrgGroupY: false,
        node: (
          <LoginPanel testId="login-panel-error">
            <LoginTitleBlock title={t('login.unavailable')} subtitle={t('login.errors.fallback')} />
            <LoginPrimaryButton
              disabled={isLoading}
              loading={isLoading}
              onClick={reset}
              testId="login-error-retry"
            >
              {isLoading ? t('login.working') : t('login.retry')}
            </LoginPrimaryButton>
            <LoginErrorText>
              {t(`login.errors.${loginState.code}`, { defaultValue: t('login.errors.fallback') })}
            </LoginErrorText>
          </LoginPanel>
        ),
      };
    }
    if (loginState.step === 'browser-redirect') {
      return {
        ssoOrgGroupY: false,
        node: (
          <LoginPanel testId="login-panel-browser-redirect">
            <LoginTitleBlock title={t('login.browserWaiting')} subtitle={loginState.label} />
            <LoginLoadingRing y={LOADING_RING.yBrowser} label={t('login.working')} />
            <LoginPrimaryButton onClick={() => void dispatch({ type: 'cancel-browser' })}>
              {t('login.cancel')}
            </LoginPrimaryButton>
          </LoginPanel>
        ),
      };
    }
    if (loginState.step === 'completed') return { node: null, ssoOrgGroupY: false };
    return {
      ssoOrgGroupY: loginState.step === 'identifier' && ssoOrgMode,
      node:
        renderIdentifier() ??
        renderMethodChoice() ??
        renderVerification() ??
        renderAccountSelection() ??
        renderSsoVerification() ??
        renderBinding(),
    };
  };

  const { node, ssoOrgGroupY } = renderContent();
  if (loginState?.step === 'completed') return null;

  // handoff 面板入场(demo 步骤 4:opacity 0→1 + 自下而上 20px,420ms
  // cubic-bezier(.35,.1,.25,1));panelRevealed 前完全隐藏且不吃点击,
  // 播放期外(回访 /login、无 Provider 单测)直落终态无过渡。
  const panelHidden = !handoff.panelRevealed;
  const groupStyle: CSSProperties = {
    opacity: panelHidden ? 0 : 1,
    transform: panelHidden
      ? `translateY(${LOGIN_HANDOFF_TIMINGS.panelRisePx}px)`
      : 'translateY(0px)',
    pointerEvents: panelHidden ? 'none' : undefined,
    transition: handoff.isPlaying
      ? `opacity ${LOGIN_HANDOFF_TIMINGS.panelMs}ms ${LOGIN_HANDOFF_TIMINGS.panelEasing}, transform ${LOGIN_HANDOFF_TIMINGS.panelMs}ms ${LOGIN_HANDOFF_TIMINGS.panelEasing}`
      : undefined,
  };
  const localModeFooter = showLocalModeFooter ? (
    <>
      <button
        data-testid="login-local-mode"
        type="button"
        disabled={localModePending || isLoading}
        onClick={() => requireConsent(() => void openLocalMode())}
        aria-describedby="login-local-mode-description"
        className="select-none rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-6 py-2.5 text-13 font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)] disabled:cursor-not-allowed disabled:opacity-60"
        style={{ minHeight: 40 }}
      >
        {localModePending ? t('login.localModeOpening') : t('login.localModeEntry')}
      </button>
      <span
        id="login-local-mode-description"
        className="mt-2 line-clamp-2 max-w-full text-12 text-[var(--text-secondary)]"
        style={{ lineHeight: `${LOGIN_LOCAL_MODE.descriptionLineHeight}px` }}
      >
        {t('login.localModeDescription')}
      </span>
    </>
  ) : null;

  return (
    // 根级 z-[9990] 建立 LoginPage 自己的 stacking context:整体压过品牌 overlay
    // (LoginBrandStage z-[9980])、低于 SplashScreen(z-[9999]);内部 stage(z-auto)
    // / 窗框描边(z-30)/ 拖拽条(z-40)相对层序固定(handoff 合流时序依赖此序)。
    <div className="relative z-[9990] min-h-screen">
      <LoginStage
        ssoOrgGroupY={ssoOrgGroupY}
        groupStyle={groupStyle}
        footer={localModeFooter}
        bottomReserve={panelBottomReserve}
      >
        {accountDeletionStatus && (
          <AccountDeletionStatusPanel
            status={accountDeletionStatus}
            onDismiss={
              accountDeletionStatus.status === 'completed'
                ? () => {
                    void clearAccountDeletionReceipt?.().catch(() => undefined);
                    setAccountDeletionStatus(null);
                  }
                : undefined
            }
          />
        )}
        {node}
      </LoginStage>
      {/* 顶部 46px 拖拽条 overlay(附录 C §1.4 条4:独立层不占文档流;返回钮在
          面板区 y≫46px 不被遮挡;Win 控件 no-drag)。窗框双描边 chrome overlay 已于
          2026-07-22 随 PR #104 对齐(纯平白底 + 无窗框描边)移除 */}
      <div
        data-testid="login-drag-bar"
        className="absolute left-0 top-0 z-40 flex w-full items-center justify-end"
        style={{ height: DRAG_BAR_HEIGHT, WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {!isMac && (
          <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <WindowControls />
          </div>
        )}
      </div>
      {/* 服务条款和隐私协议确认弹窗(figma 602:822/602:1249):个人登录链路在
          radio 未勾选时统一拦截;同意=勾选并续接,不同意=留在登录页。
          z-50 盖过 stage 与拖拽条(根 z-[9990] stacking context 内)。 */}
      {consentDialogOpen && (
        <LoginConsentDialog
          title={t('login.consentDialog.title')}
          body={t('login.consentDialog.body')}
          agreeLabel={t('login.consentDialog.agree')}
          disagreeLabel={t('login.consentDialog.disagree')}
          onAgree={agreeConsent}
          onDisagree={dismissConsent}
          onOpenTerms={() => openLegalLink('terms')}
          onOpenPrivacy={() => openLegalLink('privacy')}
        />
      )}
    </div>
  );
}

/**
 * 第三方圆钮图标(§4.5 icon 48×48;figma 现导矢量,登记见 asset-manifest.md):
 * Apple 247:1692 / Google 247:1714 / WeChat 247:1724(服务端 providers.social
 * 驱动显隐,资产备好、无返回不渲染——design §5)/ SSO 329:248。
 */
// Apple 为单色图标,随圆钮底反相(亮色深圆白标 / 暗色白圆 #2A2828 深标,
// figma white apple 489:676 核验);Google/WeChat 厂商品牌色跨模式不变。
const SOCIAL_ICON_SRC: Record<SocialProvider, { light: string; dark: string }> = {
  apple: { light: appleIcon, dark: appleIconDark },
  google: { light: googleIcon, dark: googleIcon },
  wechat: { light: wechatIcon, dark: wechatIcon },
};

function SocialProviderIcon({ provider }: { provider: SocialProvider }) {
  const isDark = useIsDarkMode();
  return (
    <img
      src={SOCIAL_ICON_SRC[provider][isDark ? 'dark' : 'light']}
      alt=""
      aria-hidden
      draggable={false}
      className="h-full w-full object-contain"
    />
  );
}

function AccountDeletionStatusPanel({
  status,
  onDismiss,
}: {
  status: AccountDeletionStatus;
  onDismiss?: () => void;
}) {
  const { t } = useTranslation();
  const titleKey =
    status.status === 'pending'
      ? 'accountDeletion.status.pendingTitle'
      : status.status === 'processing'
        ? 'accountDeletion.status.processingTitle'
        : 'accountDeletion.status.completedTitle';
  const copyKey =
    status.status === 'pending'
      ? 'accountDeletion.status.pendingCopy'
      : status.status === 'processing'
        ? 'accountDeletion.status.processingCopy'
        : 'accountDeletion.status.completedCopy';

  return (
    <section
      aria-label={t(titleKey)}
      className="mb-5 w-full rounded-xl border border-[var(--border-default)] bg-[var(--surface-chip)] px-4 py-3"
    >
      <h2 className="text-14 font-medium text-[var(--text-primary)]">{t(titleKey)}</h2>
      <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
        {t(copyKey, {
          date: formatAccountDeletionDate(status.deleteAfter),
        })}
      </p>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className={cn(
            'mt-2 rounded-full px-2 py-1 text-12 text-[var(--text-secondary)]',
            'transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
          )}
        >
          {t('accountDeletion.status.dismissButton')}
        </button>
      )}
    </section>
  );
}

function formatAccountDeletionDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

function SsoGlyph() {
  const isDark = useIsDarkMode();
  return (
    <img
      src={isDark ? ssoIconDark : ssoIcon}
      alt=""
      aria-hidden
      draggable={false}
      className="h-full w-full object-contain"
    />
  );
}

// 游客人形图标(figma 379:753 mdi:user):单色随圆钮底反相(亮色深圆浅标 #EEEEEE /
// 暗色白圆墨标 #2A2828),与 Apple 单色图标同规则。
function GuestGlyph() {
  const isDark = useIsDarkMode();
  return (
    <img
      src={isDark ? guestIconDark : guestIcon}
      alt=""
      aria-hidden
      draggable={false}
      className="h-full w-full object-contain"
    />
  );
}
