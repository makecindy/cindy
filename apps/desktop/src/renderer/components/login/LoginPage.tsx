import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type {
  AccountDeletionStatus,
  CaptchaConfig,
  SocialProvider,
  VerificationKind,
} from '@cindy/auth-client';
import { captchaRequiredActionForVerificationKind, isValidEmail } from '@cindy/auth-client';

import { cn } from '@/lib/utils';
import { createLogger } from '@/lib/logger';
import { setLoginEmailCaptchaGate } from '@/lib/loginCaptchaGate';
import { WindowControls } from '@/components/title-bar/WindowControls';
import { ChromeIconButton } from '@/components/title-bar/ChromeIconButton';
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

import { LoginStage } from './LoginStage';
import { LoginCaptchaOverlay } from './LoginCaptchaOverlay';
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
  LoginSkipEntry,
  LoginSocialButton,
  LoginSocialRow,
  LoginSsoOrgHistoryList,
  LoginTextLink,
  LoginTitleBlock,
  ssoOrgHistoryOptionId,
} from './LoginControls';
import { useResendCountdown } from './useResendCountdown';
import { CURRENT_CINDY_REGION } from '../../../shared/brandRegion';
import { shouldLabelRegion } from '../../../shared/regionCode';
import { LEGAL_LINKS } from '../../../shared/legalLinks';
import { resolveIdentifierMethod } from '../../../shared/loginIdentifierMethod';
import {
  DRAG_BAR_HEIGHT,
  LOADING_RING,
  LOGIN_COLORS,
  LOGIN_DELETION_BUBBLE,
  LOGIN_LOCAL_MODE,
  SSO_ORG_HINT,
} from './loginDesignTokens';
import { PANEL_FIXED_SCALE } from './loginScale';
import { canResumePendingConsent, makeConsentStamp, type ConsentStamp } from './consentGate';
import { getSsoOrgHistory } from '@/state/ssoOrgHistory';

/**
 * 标题旁区域徽标的 i18n key(2026-07-27 拍板)。
 *
 * **global 故意缺席**:Cindy 是「天生全球」的产品,默认版本不需要给自己贴标签
 * 证明是全球版——只有为特定法规单独构建的版本才被标注(不对称命名)。旧实现给
 * global 挂 "Global" 徽标,读出来反而是「存在一个本土主场版、这是它的出口型号」,
 * 与叙事相反。cn / dev 仍标注:两者连的都不是 global 端点(cn 走国内端点、dev
 * 走独立 dev 端点),登录页是用户确认自己连向哪个后端的位置;dev 另有并存场景
 * ——CindyDev 保持独立可执行名,可与正式包同机共存。⚠️ 别把 cn 的理由写成
 * 「区分同机双装的 cn / global」:2026-07-26 起两者可执行名同为 Cindy、安装
 * 目录与快捷方式同名互抢,该双装场景已明确放弃支持(见 brandIdentity.ts 的
 * executableNameByRegion doc)。
 *
 * 值为五语同文的区域代号(与旧 login.globalRegion 一致:区域标识不翻译),仍走
 * i18n 以便日后改判为「中国大陆版」这类可译文案时不必回改组件。
 *
 * ⚠️ 本表只负责「哪个区域用哪个 i18n key」。**「标不标」不由本表决定**——那是
 * `shared/regionCode.ts` 的 `CINDY_REGION_CODE` 一处说了算(issue 反馈链路、侧栏
 * 版本行同源),消费处统一过 `shouldLabelRegion()`。否则改了 shared 映射、登录页
 * 这张表没跟上,徽标就会与其它界面报出不同的区域身份而没有任何信号。两者的对齐
 * (有代号的区域必须有 key、不标的区域不得有 key)由
 * `renderer/__tests__/regionCode.consistency.test.ts` 断言。
 */
const REGION_PILL_KEY: Partial<Record<typeof CURRENT_CINDY_REGION, string>> = {
  cn: 'login.regionPill.cn',
  dev: 'login.regionPill.dev',
};

const log = createLogger('LoginPage');
const AccountSwitcherDialog = lazy(() =>
  import('@/components/sidebar/AccountSwitcherDialog').then((module) => ({
    default: module.AccountSwitcherDialog,
  })),
);

/**
 * LoginPage — 桌面登录(wave4 白底体系 + figma §4 组件库)。
 *
 * 呈现层职责:凭证/票据全在 main(useLogin dispatch IPC),本组件只做视图状态机
 * 渲染与本地格式校验。覆盖全部登录步骤:identifier 主视图 / ssoOrgMode 子视图
 * (含 sso-org-list = method-choice 的 SSO 入口来源变体)/ method-choice /
 * verification-code / account-selection / binding / preparing / error,以及
 * 协议同意链路(radio + 拦截弹窗)与面板内「跳过登录」入口。倒计时契约、
 * Text_link 全态、错误码映射均已落地(历史施工批次见 git log,不再在注释中引用)。
 */
export function LoginPage({
  intent = 'sign-in',
  onClose,
}: {
  intent?: 'sign-in' | 'add-account';
  onClose?: () => void;
}) {
  // AddAccountLoginPage owns initialization: a second load would race its flow reset.
  const {
    isLoading,
    errorCode,
    loginState,
    hasAccountDeletionReceipt = false,
    getAccountDeletionStatus,
    clearAccountDeletionReceipt,
    listAccounts,
    dispatch,
    dispatchWithResult,
    clearError,
    enterLocalMode,
  } = useLogin({ autoLoad: intent !== 'add-account' });
  const { t } = useTranslation();
  const handoff = useLoginHandoff();
  const isAddAccount = intent === 'add-account';
  const accountSwitcherTriggerRef = useRef<HTMLButtonElement>(null);
  const [accountSwitcherOpen, setAccountSwitcherOpen] = useState(false);
  const [hasSavedAccounts, setHasSavedAccounts] = useState(false);

  useEffect(() => {
    if (isAddAccount || !listAccounts) {
      setHasSavedAccounts(false);
      return;
    }
    let active = true;
    void listAccounts()
      .then((snapshot) => {
        if (active) setHasSavedAccounts(snapshot.accounts.length > 0);
      })
      .catch(() => {
        if (active) setHasSavedAccounts(false);
      });
    return () => {
      active = false;
    };
  }, [isAddAccount, listAccounts]);

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
  /* 会话切换进行中的**真值来源**。`localModePending` state 只用于按钮 disabled 视觉;
     guard 一律读这个 ref —— 点击可能落在 setState 与 re-render 之间,那时事件处理器
     闭包里的 state 还是旧的 false,ref 不受渲染时机影响。 */
  const localModePendingRef = useRef(false);
  const markLocalModeTransition = (pending: boolean) => {
    localModePendingRef.current = pending;
    setLocalModePending(pending);
  };

  /**
   * 进入未登录状态(「跳过登录」入口 + error 步逃生入口共用)。
   *
   * **过协议门**(产品拍板 2026-07-29,推翻同年 07-27「跳过登录免协议门」):跳过登录
   * 虽然不创建账号,用户仍在使用 Cindy 客户端,因此与个人账号登录同口径——radio
   * 未勾选时先弹协议弹窗,同意后才进主界面。调用方一律用
   * `requireConsent(..., { deferConsentPersist: true })` 包裹:同意记录由**本函数**
   * 在会话切过去之后落,不能由 requireConsent 提前落(竞态原因见那里的注释)。
   */
  const openLocalMode = async () => {
    if (isLoading || localModePendingRef.current || !enterLocalMode) return;
    markLocalModeTransition(true);
    try {
      // 必须走 AuthContext.enterLocalMode():它调同一条 IPC,并用返回值立刻改
      // mode / canEnterApp。登录页自己调 authEnterLocal 只改主进程会话,界面
      // 仍当自己没进来;广播一旦没赶上,再点一次也不会重播,登录页就钉死。
      // GuestRoute 看到 mode === 'local' 后自己切走,不要在这里改 hash——
      // canEnterApp 还是 false 时冲进受保护路由会被踢回 /login。
      await enterLocalMode();
      // 顺序是硬要求:先 enter-local(main 侧 isLocalMode() 转真)再落同意,这样
      // acceptPrivacyConsent 广播出来的 allowed 恒为 false,TapDB 不会被拉起来发
      // device_login。反过来会开出一个真实的上报窗口(codex 审查 P1,#907)。
      persistPrivacyConsent();
    } catch (error) {
      // 两个调用点都是 requireConsent(() => void openLocalMode()):抛出去没人接,
      // 会变成 unhandled rejection。IPC 失败(main 未就绪/通道异常)时停在登录页
      // 就是正确兜底——用户可重试或改走正常登录;这里只记日志,不自造错误 UI
      // (登录页的 errorCode 归 main 的 loginFlowState 所有,renderer 不旁路写)。
      log.error('enter not-signed-in session failed', error);
    } finally {
      markLocalModeTransition(false);
    }
  };

  // 企业 SSO 入口子视图:在 identifier 步骤内输入组织标识(本地展示态,不进 main)。
  // 需先于 bottomReserve 计算声明——协议行只在 identifier 主视图渲染,sso-org 子视图隐藏。
  const [ssoOrgMode, setSsoOrgMode] = useState(false);
  const realmConfirmation = loginState?.step === 'realm-confirmation' ? loginState : null;

  /* ── 协议同意链路(consent PR):radio 状态 + 未勾选拦截弹窗 + 同意后续接。
     过门点(产品拍板 2026-07-24 二次):手机号提交、邮箱提交(discover 前)、
     method-choice 个人行发码、社交圆钮(Apple/Google/未来微信),以及**跳过登录**
     (面板内文字按钮 + error 步逃生入口;2026-07-29 拍板恢复,推翻 07-27 的免门
     结论,见 openLocalMode)——个人链路一律先同意协议再发起,包括仅触发方式
     查询的 email discover(拍板压过审查侧「discover 无副作用可放行」的建议)。
     豁免仅限显式企业 SSO 入口(SSO 圆钮、组织标识提交、method-choice sso 行)。
     pending 动作只存 renderer 本地(不进 main loginFlowState;规则 9:分支全部
     代码状态机化)。 ── */
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [consentDialogOpen, setConsentDialogOpen] = useState(false);
  // pending 带开门时刻快照,同意时复验防陈旧续接(codex 审查 P1;consentGate 单测)
  const pendingConsentAction = useRef<{
    action: () => void;
    stamp: ConsentStamp;
    // true = 同意时不在弹窗回调里落同意记录,由 action 自己落(见 requireConsent)
    deferConsentPersist: boolean;
  } | null>(null);

  /* 把「用户明示同意《隐私政策》」这个事实落到 main。
     它是 TapDB 采集的前置条件(见 main/analytics-settings-store.ts):没有这条
     记录,统计 SDK 一个字节都不会发。写在**放行时刻**而不是勾 radio 时刻——
     勾了又取消不算同意,同意并继续使用才算。幂等,失败不阻断登录(闸保持关闭)。 */
  const persistPrivacyConsent = () => {
    // 记录同意**绝不能挡住登录链路**:preload 面缺失、IPC 未就绪都可能让这里抛。
    // 失败时闸保持关闭(= 不采集),这是安全的一侧。
    try {
      void window.electronAPI.acceptPrivacyConsent().catch(() => undefined);
    } catch {
      // no-op
    }
  };

  /**
   * @param options.deferConsentPersist
   *   true = 本次放行**不**在这里落同意记录,交给 action 自己在恰当时刻落。
   *   目前只有跳过登录用它,原因是一条真实竞态(codex 审查 P1,#907):
   *   `acceptPrivacyConsent` 的 IPC handler 会同步 broadcastSettingsChange(),而
   *   `allowed = isAnalyticsAllowed() && !authManager.isLocalMode()`。若在
   *   `auth:enter-local` 之前落同意,那一刻 isLocalMode() 还是 false → 广播
   *   allowed:true → renderer 的 tapdbClient 立即 initSdk()(isInitDeviceLogin
   *   会当场发出 device_login),等 enter-local 完成再广播 allowed:false 已经晚了。
   *   于是「未登录态不上报」这条承诺在正式包上会被破一个窗口。让 openLocalMode
   *   先切会话、再落同意即可关掉这个窗口(此时 allowed 恒为 false)。
   */
  const requireConsent = (action: () => void, options?: { deferConsentPersist?: boolean }) => {
    /* 会话切换进行中一律不接新的过门动作(codex 审查 P1 第二条,#907)。
       `auth:enter-local` 的 handler 要 await waitForSessionInvalidation() 与
       teardownAuthAccountBoundary(),这是一个真实可观测的窗口;窗口里 isLoading
       仍为 false(enter-local 不走 loginFlow),而弹窗已关、consentAccepted 已为 true,
       于是邮箱 / 社交等入口仍可点 —— 它们走的是 deferConsentPersist=false 分支,会在
       main 还没转成 local 时立刻 persist,再次把 allowed:true 广播给 TapDB。
       在这里单点收口而不是给每个控件补 disabled:窗口通常只有几十毫秒,给全部控件
       加 disabled 视觉会换来一次可见闪变(§规则 7:无视觉跳变),而行为层 guard 已经
       杜绝了 persist 与派发 —— 会话都在切了,任何登录动作本来就该作废。 */
    if (localModePendingRef.current) return;
    const deferConsentPersist = options?.deferConsentPersist === true;
    if (consentAccepted) {
      if (!deferConsentPersist) persistPrivacyConsent();
      action();
      return;
    }
    pendingConsentAction.current = {
      action,
      stamp: makeConsentStamp(loginState?.step, isLoading, loginState?.step === 'completed'),
      deferConsentPersist,
    };
    setConsentDialogOpen(true);
  };
  const agreeConsent = () => {
    // 同意 = 自动勾选 radio + 续接用户刚才点的那条登录链路(产品拍板)
    setConsentAccepted(true);
    setConsentDialogOpen(false);
    const pending = pendingConsentAction.current;
    pendingConsentAction.current = null;
    // 点了弹窗上的「同意」即为明示同意,与下面 pending 是否还能续接无关——唯一例外
    // 是 deferConsentPersist 的链路(跳过登录):它必须等会话切过去再落,否则会开出
    // 上面注释里的上报窗口。代价是 pending 因状态漂移被丢弃时这次同意不落盘,
    // 属安全一侧(漏记 = 不采集),且 radio 已勾选,下次任一过门入口会补上。
    if (!pending?.deferConsentPersist) persistPrivacyConsent();
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
  // 「跳过登录」常驻入口在面板内(identifier 视图 SKIP_ENTRY 文字链);footer 仅保留
  // error 步的逃生入口——登录服务不可用时用户仍能进入本地模式(既有产品保证)。
  const showLocalModeFooter = !isAddAccount && loginState?.step === 'error';
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
  // 徽标读 CURRENT_CINDY_REGION 而非上面的 env 字面比较:未注入区域的本地 dev
  // 构建经 resolveCindyRegion 落到默认 global,正确地不挂徽标(而非误挂 Dev)。
  // 「标不标」过 shouldLabelRegion(shared 单点,与侧栏 / issue 链路同源),本组件的
  // REGION_PILL_KEY 只回答「用哪个 key」——两层分开,shared 映射改了这里不会静默漂移。
  const regionPillKey = shouldLabelRegion(CURRENT_CINDY_REGION)
    ? REGION_PILL_KEY[CURRENT_CINDY_REGION]
    : undefined;
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
  const [ssoOrgHistory, setSsoOrgHistory] = useState(() => getSsoOrgHistory());
  const [ssoOrg, setSsoOrg] = useState(() => ssoOrgHistory[0] ?? '');
  const [ssoOrgHistoryOpen, setSsoOrgHistoryOpen] = useState(false);
  const [ssoOrgHistoryActiveIndex, setSsoOrgHistoryActiveIndex] = useState(-1);
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
    if (
      isAddAccount ||
      !hasAccountDeletionReceipt ||
      !getAccountDeletionStatus ||
      !clearAccountDeletionReceipt
    ) {
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
  }, [
    clearAccountDeletionReceipt,
    getAccountDeletionStatus,
    hasAccountDeletionReceipt,
    isAddAccount,
  ]);

  useEffect(() => {
    if (loginState?.step !== 'identifier') return;
    setSsoOrgMode(false);
    setVerificationCode('');
    setSsoVerificationCode('');
    setBindingContact('');
    setBindingCode('');
    setIdentifierFormatError(null);
  }, [loginState?.step]);

  // 进入 verification-code 即起算 42s(含 AuthContext 自动发码、手机号提交)。
  // 只认运行中的 step 沿,不认首帧注入(harness 直接挂验证码页仍保持可点重发)。
  // 已在验证码页的重发成功仍走 dispatchRequestCode 的 arm。
  const previousLoginStepRef = useRef(loginState?.step);
  useEffect(() => {
    const previous = previousLoginStepRef.current;
    const step = loginState?.step;
    previousLoginStepRef.current = step;
    if (step === 'verification-code' && previous !== 'verification-code' && previous != null) {
      armResendCountdown();
    }
  }, [loginState?.step, armResendCountdown]);

  const errorMessage = useMemo(() => {
    if (!errorCode) return null;
    return t(`login.errors.${errorCode}`, {
      defaultValue: t('login.errors.fallback'),
    });
  }, [errorCode, t]);

  const reset = () => {
    // error 步的「重试」与 back 都走这里,而 error 步同时挂着跳过登录逃生入口:
    // 会话已经在切了就别再把状态机拨回去(同 requireConsent 里那道 guard 的理由)。
    if (localModePendingRef.current) return;
    clearError();
    setIdentifierFormatError(null);
    void dispatch({ type: 'reset' });
  };

  /* ── 人机验证前置闸(邮箱/短信发码防批量注册)──
     providers.captcha 只随 identifier/realm-confirmation 步的 state 下发,而发码
     动作发生在后续步骤(method-choice 个人行 / 验证码页重发),进 ref 存续——
     登录流必经 identifier,ref 必然先就位。cn 构建 / 服务端未开启时字段缺席,
     整条闸是 no-op；当前服务端只下发邮箱动作，未来下发短信动作即可启用。 */
  const captchaConfigRef = useRef<CaptchaConfig | null>(null);
  useEffect(() => {
    if (loginState?.step === 'identifier' || loginState?.step === 'realm-confirmation') {
      captchaConfigRef.current = loginState.providers.captcha ?? null;
    }
  }, [loginState]);
  const [captchaChallenge, setCaptchaChallenge] = useState<{
    baseUrl: string;
    resolve: (token: string | null) => void;
  } | null>(null);
  // 挑战创建必须单飞：React 提交 overlay 前的快速重复触发不能覆盖 resolver。
  // 后续并发调用按取消处理，避免同一枚单次 token 被两个发码请求重复消费。
  const captchaChallengePendingRef = useRef(false);
  /** 打开挑战 overlay 并等结果:token = 通过;null = 用户取消或挑战页地址不可得。 */
  const obtainCaptchaToken = async (kind: VerificationKind): Promise<string | null> => {
    if (captchaChallengePendingRef.current) return null;
    captchaChallengePendingRef.current = true;
    try {
      let baseUrl: string;
      try {
        baseUrl = await window.electronAPI.authGetCaptchaChallengeUrl();
        const target = new URL(baseUrl);
        target.searchParams.set('action', captchaRequiredActionForVerificationKind(kind));
        baseUrl = target.toString();
      } catch (error) {
        // IPC 面缺失/异常:视同取消(不发码,用户可重试);错误细节只进日志。
        log.error('resolve captcha challenge url failed', error);
        return null;
      }
      return await new Promise((resolve) => {
        setCaptchaChallenge({
          baseUrl,
          resolve: (token) => {
            setCaptchaChallenge(null);
            resolve(token);
          },
        });
      });
    } finally {
      captchaChallengePendingRef.current = false;
    }
  };
  const captchaRequiredFor = (kind: VerificationKind) =>
    captchaConfigRef.current?.requiredFor.includes(
      captchaRequiredActionForVerificationKind(kind),
    ) === true;

  // AuthContext「唯一邮箱方式自动发码」快捷链的前置闸:那条链不经过下面的
  // dispatchRequestCode,借用本组件的挑战 overlay。latest-ref 模式:注册一次,
  // 回调恒取最新一帧的闸函数。
  const captchaGateRef = useRef<() => Promise<string | null | undefined>>(() =>
    Promise.resolve(undefined),
  );
  captchaGateRef.current = () =>
    captchaRequiredFor('email') ? obtainCaptchaToken('email') : Promise.resolve(undefined);
  useEffect(() => {
    setLoginEmailCaptchaGate(() => captchaGateRef.current());
    return () => setLoginEmailCaptchaGate(null);
  }, []);

  /**
   * 邮箱 identifier 提交:discover(AuthContext 可能内联自动发码)+ captcha
   * 错误兜底。providers 缓存旧于服务端开关时,自动链的闸拿不到 captcha 配置、
   * 不带 token 发码吃到 CAPTCHA_REQUIRED——在此出题后带 token 直接重发发码
   * (成功即进输码页,倒计时由 step 沿 effect 起算)。
   */
  const submitEmailDiscover = async (email: string) => {
    const result = await dispatchWithResult({ type: 'discover', email });
    if (
      result.success ||
      (result.code !== 'CAPTCHA_REQUIRED' && result.code !== 'CAPTCHA_INVALID')
    ) {
      return;
    }
    const token = await obtainCaptchaToken('email');
    if (token === null) return;
    await dispatchWithResult({
      type: 'request-code',
      kind: 'email',
      identifier: email,
      captchaToken: token,
    });
  };

  // request-code 类动作统一走这里:成功返回时刻 = 倒计时起算点(Step 3a);
  // 失败(含重发失败)不 arm → 保持当前 deadline。
  const dispatchRequestCode = async (kind: VerificationKind, value: string) => {
    let captchaToken: string | undefined;
    if (captchaRequiredFor(kind)) {
      const token = await obtainCaptchaToken(kind);
      if (token === null) return; // 取消:不发码、不 arm、不报错
      captchaToken = token;
    }
    let result = await dispatchWithResult({
      type: 'request-code',
      kind,
      identifier: value,
      captchaToken,
    });
    // 错误驱动兜底(providers 缓存旧于服务端开关,或 token 恰好过期):
    // 重新出题一次后原参重试,仅一次防循环。
    if (
      !result.success &&
      (result.code === 'CAPTCHA_REQUIRED' || result.code === 'CAPTCHA_INVALID')
    ) {
      const retryToken = await obtainCaptchaToken(kind);
      if (retryToken === null) return;
      result = await dispatchWithResult({
        type: 'request-code',
        kind,
        identifier: value,
        captchaToken: retryToken,
      });
    }
    if (result.success) armResendCountdown();
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
      requireConsent(() => void submitEmailDiscover(value));
    } else {
      // 手机号:桌面不做客户端 +86/号段校验(#223 仅移动端做 cnPhone 本地拦截),
      // 输入原样透传服务端 request-code,由服务端校验号段合法性。
      setIdentifierFormatError(null);
      requireConsent(() => void dispatchRequestCode('phone', value));
    }
  };

  const submitSsoOrg = (event: FormEvent) => {
    event.preventDefault();
    // 企业 SSO 豁免协议门,所以拿不到 requireConsent 里那道会话切换 guard;它会真的
    // 派发,切换期间必须自己挡住(否则 main 会同时处理 enter-local 与 SSO 登录)。
    if (localModePendingRef.current) return;
    const value = ssoOrg.trim();
    if (!value) return;
    setSsoOrgHistoryOpen(false);
    setSsoOrgHistoryActiveIndex(-1);
    // 组织区域先静默发现；仅当结果与安装包区域不一致时，main 状态机进入
    // realm-confirmation，由下方弹窗在继续 SSO 前向用户确认。
    void dispatch({ type: 'discover-sso-org', org: value }).finally(() => {
      setSsoOrgHistory(getSsoOrgHistory());
    });
  };

  const openSsoOrgHistory = () => {
    if (ssoOrgHistory.length <= 1) return;
    setSsoOrgHistoryOpen(true);
    setSsoOrgHistoryActiveIndex(-1);
  };

  const selectSsoOrgHistory = (entry: string) => {
    setSsoOrg(entry);
    setSsoOrgHistoryOpen(false);
    setSsoOrgHistoryActiveIndex(-1);
    clearError();
  };

  const handleSsoOrgHistoryKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (ssoOrgHistory.length <= 1) return;
    if (event.key === 'Escape') {
      setSsoOrgHistoryOpen(false);
      setSsoOrgHistoryActiveIndex(-1);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setSsoOrgHistoryOpen(true);
      setSsoOrgHistoryActiveIndex((current) => {
        if (event.key === 'ArrowDown') {
          return current < ssoOrgHistory.length - 1 ? current + 1 : 0;
        }
        return current > 0 ? current - 1 : ssoOrgHistory.length - 1;
      });
      return;
    }
    if (event.key === 'Enter' && ssoOrgHistoryOpen && ssoOrgHistoryActiveIndex >= 0) {
      event.preventDefault();
      const selected = ssoOrgHistory[ssoOrgHistoryActiveIndex];
      if (selected) selectSsoOrgHistory(selected);
    }
  };

  /* ── identifier 主视图(680×620 组:面板 680×500 + 第三方圆钮行) ── */
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
              regionPill={regionPillKey ? t(regionPillKey) : undefined}
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
          {/* 「跳过登录」= 面板内文字按钮(新稿 705:1068 容器 680×60 @y430,取代旧游客
              圆钮;LoginSkipEntry ≠ LoginTextLink,见该组件注释):接既有 local mode
              链路,过协议门(2026-07-29 拍板)。槽位在 error_text(380..430)之下、
              与其首尾相接,两者同时可见互不重叠;error 出现不推移本入口(均 absolute)。 */}
          {!isAddAccount ? (
            <LoginSkipEntry
              testId="login-skip-entry"
              disabled={isLoading || localModePending}
              onClick={() =>
                requireConsent(() => void openLocalMode(), { deferConsentPersist: true })
              }
            >
              {t('login.localModeEntry')}
            </LoginSkipEntry>
          ) : null}
        </LoginPanel>
        <LoginSocialRow count={providers.social.length + 1}>
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
              // 企业 SSO 豁免协议门(产品拍板),不过 requireConsent —— 所以会话切换
              // 期间要自己挡:那道 guard 在 requireConsent 里,这条路径绕过了它。
              if (isLoading || localModePendingRef.current) return;
              clearError();
              const nextHistory = getSsoOrgHistory();
              setSsoOrgHistory(nextHistory);
              if (!ssoOrg.trim()) setSsoOrg(nextHistory[0] ?? '');
              setSsoOrgHistoryOpen(false);
              setSsoOrgHistoryActiveIndex(-1);
              setSsoOrgMode(true);
            }}
          >
            <SsoGlyph />
          </LoginSocialButton>
        </LoginSocialRow>
        {/* 协议同意行(figma 700:807:圆钮行下方 22 设计px,组坐标 y=642;
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

  /* ── 企业 SSO 入口子视图(sso-org empty/filled;面板 680×500,无跳过入口) ── */
  const renderSsoOrg = () => (
    <>
      <LoginPanel testId="login-panel-sso-org">
        <form onSubmit={submitSsoOrg} noValidate>
          <LoginBackButton
            disabled={isLoading}
            label={t('login.back')}
            onClick={() => {
              clearError();
              setSsoOrgHistoryOpen(false);
              setSsoOrgHistoryActiveIndex(-1);
              setSsoOrgMode(false);
            }}
          />
          <LoginTitleBlock title={t('login.ssoOrgTitle')} subtitle={t('login.ssoOrgSubtitle')} />
          <LoginInput
            autoFocus={ssoOrgHistory.length <= 1}
            disabled={isLoading}
            maxLength={253}
            autoComplete="off"
            value={ssoOrg}
            onChange={(value) => {
              setSsoOrg(value);
              setSsoOrgHistoryActiveIndex(-1);
            }}
            onFocus={openSsoOrgHistory}
            onClick={openSsoOrgHistory}
            onBlur={() => {
              setSsoOrgHistoryOpen(false);
              setSsoOrgHistoryActiveIndex(-1);
            }}
            onKeyDown={handleSsoOrgHistoryKeyDown}
            role="combobox"
            ariaControls="login-sso-org-history-list"
            ariaExpanded={ssoOrgHistoryOpen}
            ariaActiveDescendant={
              ssoOrgHistoryOpen && ssoOrgHistoryActiveIndex >= 0
                ? ssoOrgHistoryOptionId(ssoOrgHistoryActiveIndex)
                : undefined
            }
            placeholder={t('login.ssoOrgPlaceholder')}
            error={!!errorCode}
            testId="login-sso-org-input"
          />
          {/* 帮助行(无下划线、次级色;顶对齐 ≤2 行,DESIGN.md §16.2 折行分级 2) */}
          <span
            className="absolute line-clamp-2 text-center"
            style={{
              left: SSO_ORG_HINT.x,
              top: SSO_ORG_HINT.y,
              width: SSO_ORG_HINT.width,
              height: SSO_ORG_HINT.lineHeight * SSO_ORG_HINT.maxLines,
              lineHeight: `${SSO_ORG_HINT.lineHeight}px`,
              fontSize: SSO_ORG_HINT.fontSize,
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
      {ssoOrgHistoryOpen && ssoOrgHistory.length > 1 && (
        <LoginSsoOrgHistoryList
          entries={ssoOrgHistory}
          value={ssoOrg}
          activeIndex={ssoOrgHistoryActiveIndex}
          onActiveIndexChange={setSsoOrgHistoryActiveIndex}
          onSelect={selectSsoOrgHistory}
          listId="login-sso-org-history-list"
        />
      )}
    </>
  );

  /* ── method-choice(含 sso-org-list 来源变体) ── */
  const renderMethodChoice = () => {
    if (loginState?.step !== 'method-choice') return null;
    const ssoMethods = loginState.methods.filter((method) => method.type === 'sso');
    // demo 呈现仲裁(methodChoicePanel):多 connection(≥2)时抑制个人行——方式行
    // 只排两行(158/278),第三行 y=398 底边会贴到面板底;ssoRequired 同样抑制。
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
  const accountSwitcherEntry =
    !isAddAccount && hasSavedAccounts && loginState?.step !== 'browser-redirect' ? (
      <button
        ref={accountSwitcherTriggerRef}
        data-testid="login-account-switcher"
        type="button"
        onClick={() => setAccountSwitcherOpen(true)}
        className="select-none rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-6 py-2.5 text-13 font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
        style={{ minHeight: 40 }}
      >
        {t('sidebar.accountSwitcher.title')}
      </button>
    ) : null;
  const loginFooter =
    showLocalModeFooter || accountSwitcherEntry ? (
      <>
        <div className="flex items-center justify-center gap-3">
          {accountSwitcherEntry}
          {showLocalModeFooter ? (
            <button
              data-testid="login-local-mode"
              type="button"
              disabled={localModePending || isLoading}
              // error 步逃生入口与面板内文字按钮同口径:过协议门(2026-07-29 拍板)
              onClick={() =>
                requireConsent(() => void openLocalMode(), { deferConsentPersist: true })
              }
              aria-describedby="login-local-mode-description"
              className="select-none rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-6 py-2.5 text-13 font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)] disabled:cursor-not-allowed disabled:opacity-60"
              style={{ minHeight: 40 }}
            >
              {localModePending ? t('login.localModeOpening') : t('login.localModeEntry')}
            </button>
          ) : null}
        </div>
        {showLocalModeFooter ? (
          <span
            id="login-local-mode-description"
            className="mt-2 line-clamp-2 max-w-full text-12 text-[var(--text-secondary)]"
            style={{ lineHeight: `${LOGIN_LOCAL_MODE.descriptionLineHeight}px` }}
          >
            {t('login.localModeDescription')}
          </span>
        ) : null}
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
        footer={loginFooter}
        bottomReserve={panelBottomReserve}
      >
        {node}
      </LoginStage>
      {accountSwitcherOpen ? (
        <Suspense fallback={null}>
          <AccountSwitcherDialog
            open
            onOpenChange={setAccountSwitcherOpen}
            onAddAccount={() => {
              setAccountSwitcherOpen(false);
              reset();
            }}
            triggerRef={accountSwitcherTriggerRef}
          />
        </Suspense>
      ) : null}
      {/* 注销状态提示气泡(figma 678:1075「注销状态」组件集):浮层——不占文档流、
          不推挤下方内容,z-30 盖过 stage 全部内容(低于拖拽条 z-40 与协议弹窗 z-50);
          窗口顶 72px 恒定、水平窗口居中、宽 670 恒定,均不随 loginScale 缩放。
          显隐与面板入场同节奏(只淡入,不参与位移)。 */}
      {!isAddAccount && accountDeletionStatus && (
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
          style={{
            opacity: panelHidden ? 0 : 1,
            pointerEvents: panelHidden ? 'none' : undefined,
            transition: handoff.isPlaying
              ? `opacity ${LOGIN_HANDOFF_TIMINGS.panelMs}ms ${LOGIN_HANDOFF_TIMINGS.panelEasing}`
              : undefined,
          }}
        />
      )}
      {/* 顶部 46px 拖拽条 overlay(附录 C §1.4 条4:独立层不占文档流;返回钮在
          面板区 y≫46px 不被遮挡;Win 控件 no-drag)。窗框双描边 chrome overlay 已于
          2026-07-22 随 PR #104 对齐(纯平白底 + 无窗框描边)移除 */}
      <div
        data-testid="login-drag-bar"
        className="absolute left-0 top-0 z-40 flex w-full items-center justify-end"
        style={{ height: DRAG_BAR_HEIGHT, WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {(isAddAccount && onClose) || !isMac ? (
          <div
            className="flex h-full items-center"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            {isAddAccount && onClose ? (
              <ChromeIconButton
                data-testid="add-account-close"
                className={isMac ? 'mr-2' : 'mr-1'}
                aria-label={t('sidebar.accountSwitcher.close')}
                tooltip={t('sidebar.accountSwitcher.close')}
                tooltipSide="bottom"
                onClick={onClose}
              >
                <X size={14} aria-hidden="true" />
              </ChromeIconButton>
            ) : null}
            {!isMac ? <WindowControls /> : null}
          </div>
        ) : null}
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
      {realmConfirmation && (
        <LoginConsentDialog
          title={t('login.realmConsent.title')}
          body={t(
            realmConfirmation.targetRegion === 'cn'
              ? 'login.realmConsent.bodyCn'
              : 'login.realmConsent.bodyGlobal',
          )}
          agreeLabel={t('login.realmConsent.agree')}
          disagreeLabel={t('login.realmConsent.disagree')}
          onAgree={() => void dispatch({ type: 'confirm-sso-realm' })}
          onDisagree={() => void dispatch({ type: 'cancel-sso-realm' })}
          onOpenTerms={() => undefined}
          onOpenPrivacy={() => undefined}
        />
      )}
      {/* 人机验证挑战层(global 邮箱发码前置闸):独立分区 webview 装载
          auth-server 托管的 Turnstile 页,结果经 resolve 回到 dispatchRequestCode。 */}
      {captchaChallenge && (
        <LoginCaptchaOverlay
          challengeBaseUrl={captchaChallenge.baseUrl}
          onResult={captchaChallenge.resolve}
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

/**
 * 注销状态提示气泡(figma 678:1075「注销状态」组件集)。
 *
 * 浮层组件——absolute 定位、不占布局流、盖在登录页一切元素(立绘/字标/面板/社交行)之上。
 * 几何**全部用设计单位书写**(`LOGIN_DELETION_BUBBLE`,1819×2098 的 2x 稿),由外层
 * wrapper 施加与登录组同一个 `PANEL_FIXED_SCALE`(=0.5)缩放 —— 与 LoginStage 对面板的
 * 做法一致,故 Figma 数值可逐字落码:屏幕上宽 335 / 顶距 36 CSS px,与面板 340 基本同宽。
 * (2026-07-26 修正:初版把设计单位当 CSS px 用,气泡在屏幕上宽了整一倍。)
 *
 * 排版全居中,标题与正文同字号(20/23 设计单位)仅以颜色区分(标题 login-control-text /
 * 正文 login-secondary-text);间距 标题↔正文 5、正文↔「我知道了」22、「我知道了」↔气泡底
 * 20(= 下 padding,文案拉长不变)。「我知道了」为下划线文字链,上下各 11 设计单位 padding
 * 撑热区、等量负 margin 抵消视觉间距(缩放后约 22 CSS px 高,桌面鼠标指针足够;
 * 触摸端的 ≥44 物理热区由 mobile 侧 hitSlop 负责)。
 * 状态:pending/processing 无按钮、completed 带「我知道了」;颜色全走 token
 * (气泡底 login-deletion-bubble-bg、描边 login-deletion-bubble-border,固定亮/暗值)。
 */
function AccountDeletionStatusPanel({
  status,
  onDismiss,
  style,
}: {
  status: AccountDeletionStatus;
  onDismiss?: () => void;
  /** 浮层显隐(handoff 合流:与面板入场同节奏,只淡入不透明、不参与位移)。 */
  style?: CSSProperties;
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

  const B = LOGIN_DELETION_BUBBLE;
  return (
    // 定位 + 缩放层(同 LoginStage 对面板的做法):transformOrigin 取 top center,
    // 使 `translateX(-50%) scale(k)` 的可视框以 left:50% 为中心、顶边落在 top 值上。
    // 宽度写设计单位,窄窗时按「可视宽 ≤ 100vw-24」反算(可视宽 = 设计宽 × k)。
    <div
      data-testid="login-deletion-bubble-scale"
      className="absolute left-1/2 z-30"
      style={{
        top: B.top * PANEL_FIXED_SCALE,
        width: B.width,
        // 窄窗钳制:可视宽 = 设计宽 × k,要求可视宽 ≤ 100vw-24 → 设计宽上限按 1/k 反算
        maxWidth: `calc(${100 / PANEL_FIXED_SCALE}vw - ${24 / PANEL_FIXED_SCALE}px)`,
        transform: `translateX(-50%) scale(${PANEL_FIXED_SCALE})`,
        transformOrigin: 'top center',
        opacity: style?.opacity,
        pointerEvents: style?.pointerEvents,
        transition: style?.transition,
      }}
    >
      <section
        aria-label={t(titleKey)}
        className="w-full break-words border border-[var(--login-deletion-bubble-border)] bg-[var(--login-deletion-bubble-bg)] text-center"
        style={{
          borderRadius: B.radius,
          padding: B.padding,
          // 描边保持 1 物理 px(DESIGN.md §16.4):wrapper 的 scale 会把 1px 缩成
          // 0.5px(DPR=1 下变虚/消失),按 1/k 设计单位补偿,缩放后恰为 1 CSS px
          borderWidth: 1 / PANEL_FIXED_SCALE,
        }}
      >
        <h2
          className="font-normal text-[var(--login-control-text)]"
          style={{ fontSize: B.font, lineHeight: `${B.lineHeight}px` }}
        >
          {t(titleKey)}
        </h2>
        <p
          className="font-normal text-[var(--login-secondary-text)]"
          style={{
            fontSize: B.font,
            lineHeight: `${B.lineHeight}px`,
            marginTop: B.titleBodyGap,
          }}
        >
          {t(copyKey, {
            date: formatAccountDeletionDate(status.deleteAfter),
          })}
        </p>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className={cn(
              'border-0 bg-transparent font-normal text-[var(--login-control-text)] underline',
              'hover:enabled:[color:var(--login-link-hover)] active:enabled:[color:var(--login-link-pressed)]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
            )}
            style={{
              fontSize: B.font,
              lineHeight: `${B.lineHeight}px`,
              // 热区:上下各 linkHitPadding 撑开,等量负 margin 抵消,
              // 视觉间距仍是 上 bodyLinkGap / 下 padding
              marginTop: B.bodyLinkGap - B.linkHitPadding,
              marginBottom: -B.linkHitPadding,
              paddingTop: B.linkHitPadding,
              paddingBottom: B.linkHitPadding,
              paddingLeft: B.padding,
              paddingRight: B.padding,
            }}
          >
            {t('accountDeletion.status.dismissButton')}
          </button>
        )}
      </section>
    </div>
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
