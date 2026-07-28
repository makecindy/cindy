import * as WebBrowser from 'expo-web-browser';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState, Linking } from 'react-native';
import {
  AuthApiError,
  CindyAuthClient,
  reduceAuthFlow,
  ssoOrgDiscoveryToMethods,
  type AuthFlowState,
  type AuthMembership,
  type AccountDeletionAvailability,
  type AccountDeletionChallenge,
  type AccountDeletionStatus,
  type LoginOutcome,
  type SocialProvider,
  type VerificationKind,
} from '@cindy/auth-client';
// dev-only 登录 scenario harness(implementation-plan Step 0 WHAT4):
// 生产构建由 metro resolveRequest 把整模块替换为空 stub(metro.config.js),
// 运行时另有 __DEV__ guard 双保险。
import { resolveLoginScenarioFetch } from '@cindy/auth-client/fixtures';

import {
  apiFetchRaw,
  ApiError,
  registerAccountUnavailableHandler,
  type ApiFetchOptions,
} from '@/api/client';
import {
  AUTH_API_BASE_URL,
  AUTH_REGION,
  IS_OTA_SELFHOST,
  MOBILE_VISUAL_MOCK_ENABLED,
  MOBILE_REDIRECT_URL,
  OAUTH_BROKER_API_BASE_URL,
} from '@/config/env';
import { syncCanaryChannelAfterAuth } from '@/auth/canaryChannelSync';
import { ensureDeviceId } from '@/auth/deviceId';
import { isAccessTokenExpiring } from '@/auth/jwt';
import { getAuthLocale } from '@/auth/loginMessages';
import { acquireNativeSocialCredential } from '@/auth/nativeSocial';
import {
  matchesOAuthCallbackUrl,
  parseOAuthCallbackUrl,
} from '@/auth/oauthCallback';
import { createPkcePair, createState } from '@/auth/pkce';
import { mergeMembershipWithExisting } from '@/auth/profileMerge';
import {
  deleteSecureItem,
  getSecureItem,
  setSecureItem,
} from '@/auth/secureStorage';
import { clearTapdbUser, setTapdbUser, stopMobileTapdbReporting } from '@/analytics/mobileTapdb';
import {
  clearAnalyticsConsent,
  migrateExistingLoginAsConsented,
} from '@/analytics/analyticsConsentStore';
import { unregisterPushTokenBestEffort } from '@/notifications/pushNotifications';
import { resetAgentCapabilitiesCache } from '@/session/agentCapabilitiesCache';
import { resetComposerPaletteCache } from '@/session/composerPaletteCache';
import { clearCachedHomeListSnapshot } from '@/session/mobileHomeListCache';
import { clearCachedSessionMessages } from '@/session/mobileSessionMessageCache';
import { clearAllMobileVoiceCredentials } from '@/session/mobileVoiceCredentialStore';
import {
  clearAllMobileVoiceDictionaryCaches,
  setMobileVoiceDictionaryAccountScope,
} from '@/session/mobileVoiceDictionaryCache';
import { clearAllMobileVoiceInputHistories } from '@/session/mobileVoiceHistoryStore';
import { visualMockApiFetch, visualMockUser } from '@/debug/visualMock';
import {
  clearCanaryChannel,
  syncCanaryChannel,
} from '@/update/canaryChannelStore';

WebBrowser.maybeCompleteAuthSession();

const REFRESH_TOKEN_KEY = 'cindy.mobile.auth.refreshToken';
const LEGACY_ACCOUNT_REFRESH_TOKEN_KEY =
  'cindy.mobile.auth.accountRefreshToken';
const LEGACY_REFRESH_TOKEN_KEY = 'xdt.mobile.refreshToken';
const USER_PROFILE_KEY = 'cindy.mobile.auth.userProfile';
const LEGACY_USER_PROFILE_KEY = 'xdt.mobile.userProfile';
const PENDING_OAUTH_KEY = 'cindy.mobile.auth.pendingOAuth';
const ACCOUNT_DELETION_RECEIPT_KEY =
  'cindy.mobile.auth.accountDeletionReceipt';
const LEGACY_PENDING_OAUTH_KEY = 'xdt.mobile.pendingOAuth';
const PENDING_OAUTH_MAX_AGE_MS = 10 * 60 * 1000;
const AUTH_STARTUP_GATE_TIMEOUT_MS = 20 * 1000;
// 2026-07 产品 /api/user/me 退役:身份完全以 auth-server membership 为准,
// 原产品增强字段(role/isCanary/feishuId)一并下线(与 desktop 同步)。
export interface MobileUser {
  id: string;
  name: string;
  avatar: string | null;
  email: string | null;
  defaultModel: string;
  defaultEffort: string;
  membershipKind: 'personal' | 'org';
  membershipRole: 'owner' | 'admin' | 'member';
  orgId: string | null;
  orgName: string | null;
  passportId: string;
}

export type MobileLoginAction =
  | { type: 'reset' }
  | { type: 'discover'; email: string }
  | { type: 'discover-sso-org'; org: string }
  | { type: 'request-code'; kind: VerificationKind; identifier: string }
  | {
      type: 'verify-code';
      kind: VerificationKind;
      identifier: string;
      code: string;
    }
  | { type: 'start-sso'; connectionId: string; label: string }
  | { type: 'native-social'; provider: SocialProvider }
  | { type: 'select-account'; accountId: string }
  | { type: 'request-sso-verification-code' }
  | { type: 'verify-sso-verification'; code: string }
  | { type: 'request-binding-code'; contact: string }
  | { type: 'verify-binding'; contact: string; code: string };

interface PendingOAuth {
  codeVerifier: string;
  deviceId: string;
  state: string;
  createdAt: number;
  label: string;
}

export interface AuthContextValue {
  initialized: boolean;
  isBusy: boolean;
  isAuthenticated: boolean;
  user: MobileUser | null;
  deviceId: string | null;
  loginState: AuthFlowState | null;
  authError: string | null;
  accountDeletionReceipt: string | null;
  accountDeletionRestored: boolean;
  clearAuthError(): void;
  consumeAccountDeletionRestored(): void;
  dispatchLoginAction(action: MobileLoginAction): Promise<boolean>;
  completeOAuthCallback(callbackUrl: string): Promise<void>;
  logout(): Promise<void>;
  /** 认证服务已明确拒绝当前会话时，单飞执行完整本地退登。 */
  terminateSession(reason?: 'ACCOUNT_UNAVAILABLE'): Promise<void>;
  getAccountDeletionAvailability(): Promise<AccountDeletionAvailability>;
  requestAccountDeletionChallenge(): Promise<AccountDeletionChallenge>;
  confirmAccountDeletion(input: {
    challengeId: string;
    receiptToken: string;
    code: string;
  }): Promise<AccountDeletionStatus>;
  getAccountDeletionStatus(): Promise<AccountDeletionStatus | null>;
  clearAccountDeletionReceipt(): Promise<void>;
  getAccessToken(): Promise<string | null>;
  refreshAccessToken(): Promise<string | null>;
  apiFetch<T>(path: string, opts: Omit<ApiFetchOptions, 'token'>): Promise<T>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Owns auth-server credentials and login tickets for the mobile process. */
export function AuthProvider({ children }: { children: ReactNode }) {
  if (MOBILE_VISUAL_MOCK_ENABLED) {
    const value: AuthContextValue = {
      initialized: true,
      isBusy: false,
      isAuthenticated: true,
      user: visualMockUser,
      deviceId: 'visual-mock-phone',
      loginState: null,
      authError: null,
      accountDeletionReceipt: null,
      accountDeletionRestored: false,
      clearAuthError: () => undefined,
      consumeAccountDeletionRestored: () => undefined,
      dispatchLoginAction: async () => true,
      completeOAuthCallback: async () => undefined,
      logout: async () => undefined,
      terminateSession: async () => undefined,
      getAccountDeletionAvailability: async () => ({
        available: true,
        verification: {
          channel: 'email',
          maskedTarget: 'c***@example.com',
        },
        manualAppleRevocationRequired: false,
      }),
      requestAccountDeletionChallenge: async () => ({
        challengeId: 'visual-mock-challenge',
        receiptToken: 'visual-mock-receipt',
        channel: 'email',
        maskedTarget: 'c***@example.com',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }),
      confirmAccountDeletion: async () => ({
        status: 'pending',
        requestedAt: new Date().toISOString(),
        deleteAfter: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      }),
      getAccountDeletionStatus: async () => null,
      clearAccountDeletionReceipt: async () => undefined,
      getAccessToken: async () => 'visual-mock-token',
      refreshAccessToken: async () => 'visual-mock-token',
      apiFetch: visualMockApiFetch,
    };
    return (
      <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
    );
  }

  const [initialized, setInitialized] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const accessTokenRef = useRef<string | null>(null);
  // Account token 只在本次登录的 Membership 选择阶段存活；成功兑换
  // resource token 后清空，不写 SecureStore、不续期、不参与业务请求或登出。
  const pendingAccountTokenRef = useRef<string | null>(null);
  const [user, setUser] = useState<MobileUser | null>(null);
  const userRef = useRef<MobileUser | null>(null);
  const [loginState, setLoginState] = useState<AuthFlowState | null>(null);
  const loginStateRef = useRef<AuthFlowState | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [accountDeletionReceipt, setAccountDeletionReceipt] = useState<
    string | null
  >(null);
  const [accountDeletionRestored, setAccountDeletionRestored] =
    useState(false);
  const pendingLoginTicketRef = useRef<string | null>(null);
  const pendingBindTicketRef = useRef<string | null>(null);
  const pendingSsoVerificationTicketRef = useRef<string | null>(null);
  const pendingAccountDeletionRestoredRef = useRef(false);
  const loginActionInFlightRef = useRef<Promise<boolean> | null>(null);
  const browserCompletionRef = useRef<Promise<void> | null>(null);
  // auth-server rotates refresh tokens, so every caller must share one request.
  const refreshInFlightRef = useRef<Promise<string | null> | null>(null);
  const terminalLogoutInFlightRef = useRef<Promise<void> | null>(null);
  // refresh 定义早于完整清理函数；运行时通过 ref 调用本次 render 的最新实现。
  const terminateSessionImplRef = useRef<
    (reason?: 'ACCOUNT_UNAVAILABLE') => Promise<void>
  >(async () => undefined);
  // Logout bumps this generation so a late refresh cannot resurrect the session.
  const authGenerationRef = useRef(0);
  // SecureStore operations are asynchronous. Serialize mutations so logout always
  // wins over a refresh/login write that was already inside the native storage call.
  const refreshTokenMutationRef = useRef<Promise<void>>(Promise.resolve());
  const userProfileMutationRef = useRef<Promise<void>>(Promise.resolve());
  const accountDeletionReceiptMutationRef = useRef<Promise<void>>(
    Promise.resolve(),
  );

  /** 登录态落地后异步刷新灰度标记；失败保留旧值，迟到响应按 auth generation 丢弃。 */
  const scheduleCanaryChannelSync = useCallback(
    (token: string, expectedAuthGeneration: number) => {
      // EAS/TestFlight 仍走 Expo 官方更新通道，不参与自建线 canary flag 请求；
      // 这样自建灰度新增的状态机不会改变 EAS 登录/发版流程。
      if (!IS_OTA_SELFHOST) return;
      void syncCanaryChannelAfterAuth(
        { token, expectedAuthGeneration },
        {
          fetchFeatureFlags: (accessToken) =>
            apiFetchRaw('/api/user/feature-flags', {
              baseUrl: OAUTH_BROKER_API_BASE_URL,
              token: accessToken,
            }),
          readCurrentAuthGeneration: () => authGenerationRef.current,
          persistFlag: syncCanaryChannel,
        },
      ).catch(() => undefined);
    },
    [],
  );

  const serializeRefreshTokenMutation = useCallback(
    <T,>(operation: () => Promise<T>): Promise<T> => {
      const run = refreshTokenMutationRef.current.then(operation, operation);
      refreshTokenMutationRef.current = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    [],
  );

  const serializeUserProfileMutation = useCallback(
    <T,>(operation: () => Promise<T>): Promise<T> => {
      const run = userProfileMutationRef.current.then(operation, operation);
      userProfileMutationRef.current = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    [],
  );

  const persistAccountDeletionReceipt = useCallback(
    async (receiptToken: string | null): Promise<void> => {
      const operation = async () => {
        if (receiptToken) {
          await setSecureItem(ACCOUNT_DELETION_RECEIPT_KEY, receiptToken);
        } else {
          await deleteSecureItem(ACCOUNT_DELETION_RECEIPT_KEY).catch(
            () => undefined,
          );
        }
        setAccountDeletionReceipt(receiptToken);
      };
      const run = accountDeletionReceiptMutationRef.current.then(
        operation,
        operation,
      );
      accountDeletionReceiptMutationRef.current = run.then(
        () => undefined,
        () => undefined,
      );
      await run;
    },
    [],
  );

  const updateLoginState = useCallback((next: AuthFlowState | null) => {
    loginStateRef.current = next;
    setLoginState(next);
  }, []);

  const setToken = useCallback((token: string | null) => {
    accessTokenRef.current = token;
    setAccessToken(token);
  }, []);

  // 用户资料的唯一写入口:同步 state + 持久化快照。快照让弱网冷启动能先以
  // 缓存资料恢复“已登录”视图,token 由后台刷新补齐。
  const applyUser = useCallback(
    (next: MobileUser | null) => {
      userRef.current = next;
      setUser(next);
      void serializeUserProfileMutation(() => writeCachedUserProfile(next));
    },
    [serializeUserProfileMutation],
  );

  const clearAuthError = useCallback(() => setAuthError(null), []);
  const consumeAccountDeletionRestored = useCallback(
    () => setAccountDeletionRestored(false),
    [],
  );

  const loadMe = useCallback(
    async (
      token: string,
      did: string,
      expectedGeneration = authGenerationRef.current,
    ): Promise<void> => {
      // 2026-07 起只拉 auth-server 身份(产品 /api/user/me 已退役)。
      const identityResult = await authClientFor(did)
        .getMe(token)
        .then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        );
      if (authGenerationRef.current !== expectedGeneration) return;

      if (identityResult.status === 'fulfilled') {
        const next = mergeMembershipWithExisting(
          identityResult.value.membership,
          userRef.current,
          identityResult.value.passportId,
        );
        applyUser(next);
      } else if (isAccountUnavailableAuthError(identityResult.error)) {
        await terminateSessionImplRef.current('ACCOUNT_UNAVAILABLE');
      }
    },
    [applyUser],
  );

  const acceptOutcome = useCallback(
    async (outcome: LoginOutcome, did: string): Promise<void> => {
      await deleteSecureItem(PENDING_OAUTH_KEY).catch(() => undefined);
      if (outcome.status === 'ok' || outcome.status === 'select_account') {
        // 成功登录后，当前会话已明确属于本次登录的 passport。无论是否恢复了
        // 注销中的账号，都不能继续保留此前其他账号留下的查询 receipt。
        await persistAccountDeletionReceipt(null);
      }

      pendingAccountTokenRef.current =
        outcome.status === 'select_account'
          ? (outcome.accountToken ?? null)
          : null;

      if (outcome.status === 'select_account') {
        pendingAccountDeletionRestoredRef.current =
          pendingAccountDeletionRestoredRef.current ||
          outcome.accountDeletionRestored === true;
        pendingLoginTicketRef.current = outcome.loginTicket;
        pendingBindTicketRef.current = null;
        pendingSsoVerificationTicketRef.current = null;
        updateLoginState(
          reduceAuthFlow(loginStateRef.current, { type: 'outcome', outcome }),
        );
        return;
      }
      if (outcome.status === 'binding_required') {
        pendingAccountDeletionRestoredRef.current = false;
        pendingBindTicketRef.current = outcome.bindTicket;
        pendingLoginTicketRef.current = null;
        pendingSsoVerificationTicketRef.current = null;
        updateLoginState(
          reduceAuthFlow(loginStateRef.current, { type: 'outcome', outcome }),
        );
        return;
      }
      if (outcome.status === 'sso_verification_required') {
        pendingAccountDeletionRestoredRef.current = false;
        pendingSsoVerificationTicketRef.current = outcome.verificationTicket;
        pendingLoginTicketRef.current = null;
        pendingBindTicketRef.current = null;
        updateLoginState(
          reduceAuthFlow(loginStateRef.current, { type: 'outcome', outcome }),
        );
        return;
      }

      const deletionWasRestored =
        outcome.accountDeletionRestored === true ||
        pendingAccountDeletionRestoredRef.current;
      pendingAccountDeletionRestoredRef.current = false;
      const generation = ++authGenerationRef.current;
      refreshInFlightRef.current = null;
      const persisted = await serializeRefreshTokenMutation(async () => {
        if (authGenerationRef.current !== generation) return false;
        await setSecureItem(REFRESH_TOKEN_KEY, outcome.refreshToken);
        return authGenerationRef.current === generation;
      });
      if (!persisted) throw authCodeError('AUTH_FLOW_SUPERSEDED');
      if (authGenerationRef.current !== generation)
        throw authCodeError('AUTH_FLOW_SUPERSEDED');

      pendingLoginTicketRef.current = null;
      pendingBindTicketRef.current = null;
      pendingSsoVerificationTicketRef.current = null;
      setToken(outcome.accessToken);
      applyUser(
        mergeMembershipWithExisting(outcome.membership, userRef.current),
      );
      scheduleCanaryChannelSync(outcome.accessToken, generation);
      updateLoginState(
        reduceAuthFlow(loginStateRef.current, { type: 'outcome', outcome }),
      );
      // 只有 resource token、用户资料与 refresh token 全部落地后才发布恢复提示。
      setAccountDeletionRestored(deletionWasRestored);
      // Identity is already durable. Product preferences/profile hydration is best effort
      // and must not turn a successful login into an error on a transient downstream outage.
      void loadMe(outcome.accessToken, did, generation).catch(() => undefined);
    },
    [
      applyUser,
      loadMe,
      persistAccountDeletionReceipt,
      scheduleCanaryChannelSync,
      serializeRefreshTokenMutation,
      setToken,
      updateLoginState,
    ],
  );

  const refresh = useCallback(
    (knownDeviceId?: string): Promise<string | null> => {
      if (refreshInFlightRef.current) return refreshInFlightRef.current;
      const generation = authGenerationRef.current;
      let run: Promise<string | null>;
      const clearIfCurrent = () => {
        if (refreshInFlightRef.current === run)
          refreshInFlightRef.current = null;
      };
      run = (async () => {
        const did =
          knownDeviceId ?? deviceIdRef.current ?? (await ensureDeviceId());
        deviceIdRef.current = did;
        const refreshToken = await serializeRefreshTokenMutation(() =>
          getSecureItem(REFRESH_TOKEN_KEY).catch(() => null),
        );
        if (!refreshToken) {
          await clearCanaryChannel().catch(() => undefined);
          return null;
        }
        try {
          const pair = await authClientFor(did).refresh(refreshToken);
          if (authGenerationRef.current !== generation) return null;
          const persisted = await serializeRefreshTokenMutation(async () => {
            if (authGenerationRef.current !== generation) return false;
            await setSecureItem(REFRESH_TOKEN_KEY, pair.refreshToken);
            return authGenerationRef.current === generation;
          });
          if (!persisted) return null;
          if (authGenerationRef.current !== generation) return null;
          setToken(pair.accessToken);
          applyUser(
            mergeMembershipWithExisting(pair.membership, userRef.current),
          );
          scheduleCanaryChannelSync(pair.accessToken, generation);
          void loadMe(pair.accessToken, did, generation).catch(() => undefined);
          return pair.accessToken;
        } catch (error) {
          if (authGenerationRef.current !== generation) return null;
          if (isRejectedRefresh(error)) {
            await terminateSessionImplRef.current();
            return null;
          }
          throw error;
        }
      })();
      refreshInFlightRef.current = run;
      run.then(clearIfCurrent, clearIfCurrent);
      return run;
    },
    [
      applyUser,
      loadMe,
      scheduleCanaryChannelSync,
      serializeRefreshTokenMutation,
      setToken,
    ],
  );

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setIsBusy(true);
      try {
        const did = await ensureDeviceId();
        if (cancelled) return;
        deviceIdRef.current = did;
        setDeviceId(did);
        // Old Feishu refresh tokens are not valid in auth-server. Purge them explicitly
        // instead of sending them to the new endpoint or restoring an unrelated profile.
        await Promise.all([
          // 早期测试版曾持久化 account refresh token；现在仅保留登录期内存 token。
          deleteSecureItem(LEGACY_ACCOUNT_REFRESH_TOKEN_KEY).catch(
            () => undefined,
          ),
          deleteSecureItem(LEGACY_REFRESH_TOKEN_KEY).catch(() => undefined),
          deleteSecureItem(LEGACY_PENDING_OAUTH_KEY).catch(() => undefined),
          deleteSecureItem(LEGACY_USER_PROFILE_KEY).catch(() => undefined),
          // 手机语音已只保留官方托管路径:清掉旧版本留下的桌面穿透凭据、
          // 服务模式开关与 BYOK LiteLLM key,防止桌面 key 继续躺在 secure storage。
          clearAllMobileVoiceCredentials().catch(() => undefined),
        ]);
        const [storedRefreshToken, cachedUser, storedDeletionReceipt] =
          await Promise.all([
          getSecureItem(REFRESH_TOKEN_KEY).catch(() => null),
          readCachedUserProfile(),
          getSecureItem(ACCOUNT_DELETION_RECEIPT_KEY).catch(() => null),
        ]);
        if (storedDeletionReceipt) {
          setAccountDeletionReceipt(storedDeletionReceipt);
        }
        // 弱网冷启动:先用本地会话痕迹恢复已登录视图,再走网络刷新。
        if (storedRefreshToken && cachedUser) {
          userRef.current = cachedUser;
          setUser(cachedUser);
        }
        if (!storedRefreshToken)
          await deleteSecureItem(USER_PROFILE_KEY).catch(() => undefined);
        try {
          await awaitAuthStartupGate(
            refresh(did),
            AUTH_STARTUP_GATE_TIMEOUT_MS,
          );
        } catch {
          // transient:保留降级会话,由下方自愈 effect 自动补刷 token。
        }
        // 使用统计同意闸的一次性存量迁移。放在这里而不是下面的 tapdb effect 里,
        // 有两个原因:
        //  1. 判定必须等 refresh 结束——只看 effect 首次触发时的 user,会漏掉
        //     「有 refresh token 但本地 profile 缺失、靠 refresh 才拿回用户」的
        //     存量用户,他们的迁移窗口会被提前关死。
        //  2. 必须 await。迁移写 AsyncStorage 是异步的,而 effect 里的
        //     setTapdbUser() 是 fire-and-forget:两者并发时后者几乎必然读到
        //     consent:false 拿到 not_consented,且此后不再重试,整次启动都不上报。
        // 迁移只认冷启动恢复出来的登录态:登录页的协议门豁免企业 SSO,那些用户
        // 从没点过「同意」,不能被这里推定。
        if (!cancelled && userRef.current) {
          await migrateExistingLoginAsConsented().catch(() => undefined);
        }
      } finally {
        if (!cancelled) {
          setIsBusy(false);
          setInitialized(true);
        }
      }
    };
    // v6.3:initialize 链外层兜底 catch——ensureDeviceId / 存储异常穿出时归一未登录,
    // 避免 unhandled rejection;finally 已保证 initialized/isBusy 收敛,此处只清残留会话。
    void run().catch((error) => {
      console.warn('[auth] initialize failed; normalized to signed-out', error);
      if (cancelled) return;
      userRef.current = null;
      setUser(null);
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // 降级会话自愈:有缓存用户但尚未取得 access token 时,以退避节奏和回前台时机重试。
  useEffect(() => {
    if (!initialized || !user || accessToken) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const scheduleNext = () => {
      if (cancelled) return;
      attempt += 1;
      const delay = Math.min(5_000 * 2 ** attempt, 60_000);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void tryRefresh(), delay);
    };
    const tryRefresh = async () => {
      if (cancelled) return;
      try {
        const token = await refresh();
        if (cancelled) return;
        if (token) return;
        let storedRefreshToken: string | null;
        try {
          storedRefreshToken = await getSecureItem(REFRESH_TOKEN_KEY);
        } catch {
          scheduleNext();
          return;
        }
        if (cancelled) return;
        if (!storedRefreshToken) {
          applyUser(null);
          return;
        }
        scheduleNext();
      } catch {
        scheduleNext();
      }
    };
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void tryRefresh();
    });
    void tryRefresh();
    return () => {
      cancelled = true;
      subscription.remove();
      if (timer) clearTimeout(timer);
    };
  }, [accessToken, applyUser, initialized, refresh, user]);

  // 存量同意迁移已在冷启动流程里 await 完成(见上方 initialize),这里只负责绑定
  // 账号标识 —— initialized 变 true 时迁移必然已经落盘。
  useEffect(() => {
    if (!initialized) return;
    if (user?.id) void setTapdbUser(user.id);
    else void clearTapdbUser();
  }, [initialized, user?.id]);

  // 词典缓存的落盘键按账号分区。登出清理是尽力而为的(索引可能读不出来),分区让
  // 「没删干净」不再等于「下个账号能读到上个账号的词条并发给润色模型」。
  useEffect(() => {
    setMobileVoiceDictionaryAccountScope(user?.id ?? '');
  }, [user?.id]);

  const completeOAuthCallback = useCallback(
    (callbackUrl: string): Promise<void> => {
      if (browserCompletionRef.current) return browserCompletionRef.current;
      const run = (async () => {
        setIsBusy(true);
        try {
          if (!matchesOAuthCallbackUrl(callbackUrl, MOBILE_REDIRECT_URL)) {
            throw authCodeError('INVALID_AUTH_CODE');
          }
          const pending = await readPendingOAuth();
          const callback = parseOAuthCallbackUrl(callbackUrl);
          if (callback.state !== pending.state)
            throw authCodeError('STATE_MISMATCH');
          const outcome = await authClientFor(
            pending.deviceId,
          ).exchangeAuthorizationCode(callback.code, pending.codeVerifier);
          deviceIdRef.current = pending.deviceId;
          setDeviceId(pending.deviceId);
          await acceptOutcome(outcome, pending.deviceId);
          setAuthError(null);
        } catch (error) {
          const code = authErrorCode(error);
          if (code === 'INVALID_AUTH_CODE') {
            await deleteSecureItem(PENDING_OAUTH_KEY).catch(() => undefined);
            updateLoginState(null);
          }
          setAuthError(code);
          throw error;
        } finally {
          setIsBusy(false);
        }
      })();
      browserCompletionRef.current = run;
      run.then(
        () => {
          if (browserCompletionRef.current === run)
            browserCompletionRef.current = null;
        },
        () => {
          if (browserCompletionRef.current === run)
            browserCompletionRef.current = null;
        },
      );
      return run;
    },
    [acceptOutcome, updateLoginState],
  );

  // SSO returns through cindycn://auth or cindy://auth. The pending PKCE verifier
  // lives in SecureStore so a browser-triggered app restart can still finish safely.
  useEffect(() => {
    const handleDeepLink = (url: string | null) => {
      if (!url || !matchesOAuthCallbackUrl(url, MOBILE_REDIRECT_URL)) return;
      void completeOAuthCallback(url).catch(() => undefined);
    };
    const subscription = Linking.addEventListener('url', ({ url }) =>
      handleDeepLink(url),
    );
    void Linking.getInitialURL()
      .then(handleDeepLink)
      .catch(() => undefined);
    return () => subscription.remove();
  }, [completeOAuthCallback]);

  const dispatchLoginAction = useCallback(
    (action: MobileLoginAction): Promise<boolean> => {
      if (loginActionInFlightRef.current) return loginActionInFlightRef.current;
      let run: Promise<boolean>;
      const clearIfCurrent = () => {
        if (loginActionInFlightRef.current === run)
          loginActionInFlightRef.current = null;
      };
      run = (async () => {
        setIsBusy(true);
        setAuthError(null);
        try {
          const did = deviceIdRef.current ?? (await ensureDeviceId());
          deviceIdRef.current = did;
          setDeviceId(did);
          const client = authClientFor(did);

          if (action.type === 'reset') {
            pendingAccountTokenRef.current = null;
            pendingLoginTicketRef.current = null;
            pendingBindTicketRef.current = null;
            pendingSsoVerificationTicketRef.current = null;
            pendingAccountDeletionRestoredRef.current = false;
            setAccountDeletionRestored(false);
            await deleteSecureItem(PENDING_OAUTH_KEY).catch(() => undefined);
            const providers = await client.getProviders();
            updateLoginState(
              reduceAuthFlow(loginStateRef.current, {
                type: 'providers-loaded',
                providers,
              }),
            );
            return true;
          }
          if (action.type === 'discover') {
            const email = action.email.trim().toLowerCase();
            const methods = await client.discover(email);
            updateLoginState(
              reduceAuthFlow(loginStateRef.current, {
                type: 'discovery-loaded',
                email,
                methods,
              }),
            );
            return true;
          }
          // 企业 SSO 入口（按组织 ID/slug/已验证域名）：结果映射进 method-choice，
          // 复用连接选择 UI 与 start-sso 流程。
          if (action.type === 'discover-sso-org') {
            const discovery = await client.discoverSsoOrg(
              action.org.trim().toLowerCase(),
            );
            updateLoginState(
              reduceAuthFlow(loginStateRef.current, {
                type: 'discovery-loaded',
                email: '',
                methods: ssoOrgDiscoveryToMethods(discovery),
              }),
            );
            return true;
          }
          if (action.type === 'request-code') {
            const identifier = action.identifier.trim();
            await client.requestCode(action.kind, identifier);
            updateLoginState(
              reduceAuthFlow(loginStateRef.current, {
                type: 'code-requested',
                kind: action.kind,
                identifier,
              }),
            );
            return true;
          }
          if (action.type === 'verify-code') {
            await acceptOutcome(
              await client.verifyCode(
                action.kind,
                action.identifier.trim(),
                action.code,
              ),
              did,
            );
            return true;
          }
          if (action.type === 'native-social') {
            const credential = await acquireNativeSocialCredential(
              action.provider,
            );
            await acceptOutcome(
              await client.exchangeNativeSocial(action.provider, credential),
              did,
            );
            return true;
          }
          if (action.type === 'start-sso') {
            const previousState = loginStateRef.current;
            const { codeVerifier, codeChallenge } = await createPkcePair();
            const state = createState();
            await setSecureItem(
              PENDING_OAUTH_KEY,
              JSON.stringify({
                codeVerifier,
                deviceId: did,
                state,
                createdAt: Date.now(),
                label: action.label,
              } satisfies PendingOAuth),
            );
            updateLoginState(
              reduceAuthFlow(previousState, {
                type: 'browser-started',
                label: action.label,
              }),
            );
            const authUrl = client.buildAuthorizeUrl({
              kind: 'sso',
              providerOrConnectionId: action.connectionId,
              redirectUri: MOBILE_REDIRECT_URL,
              codeChallenge,
              state,
            });
            const result = await WebBrowser.openAuthSessionAsync(
              authUrl,
              MOBILE_REDIRECT_URL,
            );
            if (result.type === 'success') {
              await completeOAuthCallback(result.url);
              return true;
            }
            await deleteSecureItem(PENDING_OAUTH_KEY).catch(() => undefined);
            updateLoginState(previousState);
            throw authCodeError('USER_CANCELLED');
          }
          if (action.type === 'select-account') {
            const accountToken = pendingAccountTokenRef.current;
            if (accountToken) {
              const pair = await client.exchangeAccountMembership(
                accountToken,
                action.accountId,
              );
              pendingAccountTokenRef.current = null;
              await acceptOutcome({ status: 'ok', ...pair }, did);
              return true;
            }
            const ticket = pendingLoginTicketRef.current;
            if (!ticket) throw authCodeError('INVALID_LOGIN_TICKET');
            await acceptOutcome(
              await client.selectAccount(ticket, action.accountId),
              did,
            );
            return true;
          }

          if (action.type === 'request-sso-verification-code') {
            const ticket = pendingSsoVerificationTicketRef.current;
            const state = loginStateRef.current;
            if (!ticket || state?.step !== 'sso-verification') {
              throw authCodeError('INVALID_SSO_VERIFICATION_TICKET');
            }
            await client.requestSsoVerificationCode(ticket);
            updateLoginState(
              reduceAuthFlow(state, {
                type: 'sso-verification-code-requested',
                channel: state.channel,
                targetMasked: state.targetMasked,
              }),
            );
            return true;
          }

          if (action.type === 'verify-sso-verification') {
            const ticket = pendingSsoVerificationTicketRef.current;
            if (!ticket || loginStateRef.current?.step !== 'sso-verification') {
              throw authCodeError('INVALID_SSO_VERIFICATION_TICKET');
            }
            await acceptOutcome(
              await client.verifySsoVerification(ticket, action.code),
              did,
            );
            return true;
          }

          const bindTicket = pendingBindTicketRef.current;
          const state = loginStateRef.current;
          if (!bindTicket || state?.step !== 'binding')
            throw authCodeError('INVALID_BIND_TICKET');
          if (action.type === 'request-binding-code') {
            const contact = action.contact.trim();
            await client.requestBindingCode(
              bindTicket,
              state.bindType,
              contact,
            );
            updateLoginState(
              reduceAuthFlow(state, {
                type: 'binding-code-requested',
                bindType: state.bindType,
                contact,
              }),
            );
            return true;
          }
          await acceptOutcome(
            await client.verifyBinding(
              bindTicket,
              state.bindType,
              action.contact.trim(),
              action.code,
            ),
            did,
          );
          return true;
        } catch (error) {
          const code = authErrorCode(error);
          if (
            code === 'INVALID_LOGIN_TICKET' ||
            code === 'INVALID_BIND_TICKET' ||
            code === 'INVALID_SSO_VERIFICATION_TICKET' ||
            code === 'INVALID_TOKEN' ||
            code === 'TOKEN_EXPIRED' ||
            code === 'AUTH_FLOW_SUPERSEDED'
          ) {
            pendingAccountTokenRef.current = null;
            pendingLoginTicketRef.current = null;
            pendingBindTicketRef.current = null;
            pendingSsoVerificationTicketRef.current = null;
            pendingAccountDeletionRestoredRef.current = false;
            setAccountDeletionRestored(false);
            updateLoginState(null);
          }
          setAuthError(code);
          return false;
        } finally {
          setIsBusy(false);
        }
      })();
      loginActionInFlightRef.current = run;
      run.then(clearIfCurrent, clearIfCurrent);
      return run;
    },
    [acceptOutcome, completeOAuthCallback, updateLoginState],
  );

  const clearLocalSession = useCallback(async () => {
    // 任何登录态清除路径(logout / terminateSession / 账号注销 / ACCOUNT_UNAVAILABLE)
    // 都先 best-effort 注销移动推送 token —— 只挂在 logout 会漏掉终止路径,设备会
    // 继续收到旧账号的任务通知。token 此刻可能已失效(账号不可用),失败静默,
    // 残留由 server 侧 APNs 410 回收与换账号重注册的让位逻辑兜底。
    await unregisterPushTokenBestEffort(accessTokenRef.current);
    authGenerationRef.current += 1;
    refreshInFlightRef.current = null;
    setToken(null);
    applyUser(null);
    updateLoginState(null);
    setAccountDeletionRestored(false);
    pendingAccountTokenRef.current = null;
    pendingLoginTicketRef.current = null;
    pendingBindTicketRef.current = null;
    pendingSsoVerificationTicketRef.current = null;
    pendingAccountDeletionRestoredRef.current = false;
    // 覆盖历史穿透凭据、服务模式与 BYOK key 三类存量存储键(功能已删除)。
    await clearAllMobileVoiceCredentials().catch(() => undefined);
    await clearAllMobileVoiceInputHistories().catch(() => undefined);
    // 词典缓存按 host 设备分区、不含账号身份:同一台电脑在两个账号下是同一个
    // deviceId,不清就会让下一个账号读到上一个账号的词条并发给润色模型。
    await clearAllMobileVoiceDictionaryCaches().catch(() => undefined);
    await clearCachedSessionMessages().catch(() => undefined);
    // 首页设备+会话快照与消息缓存一样属于账号数据,登出必须清掉。
    await clearCachedHomeListSnapshot().catch(() => undefined);
    resetComposerPaletteCache();
    resetAgentCapabilitiesCache();
    await clearCanaryChannel().catch(() => undefined);
    // 使用统计的同意记录也随登出清除。手机端没有游客模式:登出后 NavigationGate 会
    // 把所有路由重定向到 /login,设置页里的统计开关从此不可达。保留同意会让用户处在
    // 「还在被统计、却再也关不掉」的状态;清掉之后,下次登录会重新过登录页的协议门。
    await stopMobileTapdbReporting().catch(() => undefined);
    await clearAnalyticsConsent().catch(() => undefined);
    await serializeRefreshTokenMutation(() =>
      deleteSecureItem(REFRESH_TOKEN_KEY).catch(() => undefined),
    );
    await Promise.all([
      serializeUserProfileMutation(() =>
        deleteSecureItem(USER_PROFILE_KEY).catch(() => undefined),
      ),
      deleteSecureItem(LEGACY_REFRESH_TOKEN_KEY).catch(() => undefined),
      deleteSecureItem(LEGACY_ACCOUNT_REFRESH_TOKEN_KEY).catch(() => undefined),
      deleteSecureItem(PENDING_OAUTH_KEY).catch(() => undefined),
      deleteSecureItem(LEGACY_PENDING_OAUTH_KEY).catch(() => undefined),
      deleteSecureItem(LEGACY_USER_PROFILE_KEY).catch(() => undefined),
    ]);
  }, [
    applyUser,
    serializeRefreshTokenMutation,
    serializeUserProfileMutation,
    setToken,
    updateLoginState,
  ]);

  const terminateSession = useCallback(
    (reason?: 'ACCOUNT_UNAVAILABLE'): Promise<void> => {
      if (reason) setAuthError(reason);
      const existing = terminalLogoutInFlightRef.current;
      if (existing) return existing;

      let run: Promise<void>;
      const clearIfCurrent = () => {
        if (terminalLogoutInFlightRef.current === run) {
          terminalLogoutInFlightRef.current = null;
        }
      };
      run = clearLocalSession();
      terminalLogoutInFlightRef.current = run;
      run.then(clearIfCurrent, clearIfCurrent);
      return run;
    },
    [clearLocalSession],
  );
  terminateSessionImplRef.current = terminateSession;

  useEffect(
    () =>
      registerAccountUnavailableHandler(() =>
        terminateSession('ACCOUNT_UNAVAILABLE'),
      ),
    [terminateSession],
  );

  const logout = useCallback(async () => {
    const token = accessTokenRef.current;
    const did = deviceIdRef.current;
    // 移动推送 token 的注销收口在 clearLocalSession(覆盖 logout 与全部终止路径)。
    // 普通登出代表放弃尚未确认的 challenge；确认注销走 clearLocalSession 直达，
    // 不调用本函数，因此已确认请求的 receipt 仍会保留供登录页查询。
    await persistAccountDeletionReceipt(null);
    await clearLocalSession();
    if (token && did)
      await authClientFor(did)
        .logout(token)
        .catch(() => undefined);
  }, [clearLocalSession, persistAccountDeletionReceipt]);

  const getAccessToken = useCallback(async () => {
    const cached = accessTokenRef.current;
    if (cached && !isAccessTokenExpiring(cached)) return cached;
    return refresh();
  }, [refresh]);

  /** Keep direct authenticated auth-client calls on the same terminal boundary. */
  const runProtectedAuthRequest = useCallback(
    async <T,>(request: () => Promise<T>): Promise<T> => {
      try {
        return await request();
      } catch (error) {
        if (isAccountUnavailableAuthError(error)) {
          await terminateSession('ACCOUNT_UNAVAILABLE');
        }
        throw error;
      }
    },
    [terminateSession],
  );

  const getAccountDeletionAvailability = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) throw authCodeError('UNAUTHENTICATED');
    const did = deviceIdRef.current ?? (await ensureDeviceId());
    deviceIdRef.current = did;
    return runProtectedAuthRequest(() =>
      authClientFor(did).getAccountDeletionAvailability(token),
    );
  }, [getAccessToken, runProtectedAuthRequest]);

  const requestAccountDeletionChallenge = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) throw authCodeError('UNAUTHENTICATED');
    const did = deviceIdRef.current ?? (await ensureDeviceId());
    deviceIdRef.current = did;
    const challenge = await runProtectedAuthRequest(() =>
      authClientFor(did).requestAccountDeletionChallenge(token),
    );
    // 先持久化查询凭证，再把 challenge 交给 UI。即使确认成功后的响应丢失，
    // 下一次冷启动仍能查询注销状态。
    await persistAccountDeletionReceipt(challenge.receiptToken);
    return challenge;
  }, [getAccessToken, persistAccountDeletionReceipt, runProtectedAuthRequest]);

  const confirmAccountDeletion = useCallback(
    async (input: {
      challengeId: string;
      receiptToken: string;
      code: string;
    }): Promise<AccountDeletionStatus> => {
      const token = await getAccessToken();
      if (!token) throw authCodeError('UNAUTHENTICATED');
      const did = deviceIdRef.current ?? (await ensureDeviceId());
      deviceIdRef.current = did;
      const client = authClientFor(did);
      let status: AccountDeletionStatus;
      try {
        status = await runProtectedAuthRequest(() =>
          client.confirmAccountDeletion(token, {
            ...input,
            acknowledged: true,
          }),
        );
      } catch (cause) {
        const ambiguous =
          cause instanceof AuthApiError &&
          ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INVALID_RESPONSE'].includes(
            cause.code,
          );
        if (!ambiguous) throw cause;
        // confirm 可能已提交但响应丢失；receipt 查询把不确定结果收敛为成功或原错误。
        const recovered = await client
          .getAccountDeletionStatus(input.receiptToken)
          .catch(() => null);
        if (!recovered || recovered.status === 'cancelled') throw cause;
        status = recovered;
      }
      // confirm 已在服务端撤销 refresh token；当前客户端只做本地
      // 清理，不再调用普通 logout，以免覆盖或依赖已撤销的会话。receipt 已在
      // challenge 返回前持久化，不做可能阻断本地登出的冗余二次写入。
      await clearLocalSession();
      return status;
    },
    [clearLocalSession, getAccessToken, runProtectedAuthRequest],
  );

  const getAccountDeletionStatus = useCallback(async () => {
    const receiptToken = accountDeletionReceipt;
    if (!receiptToken) return null;
    const did = deviceIdRef.current ?? (await ensureDeviceId());
    deviceIdRef.current = did;
    return authClientFor(did).getAccountDeletionStatus(receiptToken);
  }, [accountDeletionReceipt]);

  const clearAccountDeletionReceipt = useCallback(
    () => persistAccountDeletionReceipt(null),
    [persistAccountDeletionReceipt],
  );

  // 带 Bearer + 401 自动 refresh 的业务请求封装;目标服务由调用方经
  // opts.baseUrl 显式指定(老主 server xdt-api 已退役,没有默认业务 server)。
  const apiFetch = useCallback(
    async <T,>(
      path: string,
      opts: Omit<ApiFetchOptions, 'token'>,
    ): Promise<T> => {
      const token = await getAccessToken();
      if (!token) throw new Error('UNAUTHENTICATED');
      try {
        return await apiFetchRaw<T>(path, { ...opts, token });
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) throw error;
        if (error.code === 'ACCOUNT_UNAVAILABLE') {
          if (userRef.current) {
            await terminateSession('ACCOUNT_UNAVAILABLE');
          }
          throw error;
        }
        if (!isRefreshableUnauthorizedCode(error.code)) throw error;

        const fresh = await refresh();
        if (!fresh) {
          if (userRef.current) await terminateSession();
          throw error;
        }
        try {
          return await apiFetchRaw<T>(path, { ...opts, token: fresh });
        } catch (retryError) {
          if (
            retryError instanceof ApiError &&
            retryError.status === 401 &&
            (retryError.code === 'ACCOUNT_UNAVAILABLE' ||
              isRefreshableUnauthorizedCode(retryError.code))
          ) {
            if (userRef.current) {
              await terminateSession(
                retryError.code === 'ACCOUNT_UNAVAILABLE'
                  ? 'ACCOUNT_UNAVAILABLE'
                  : undefined,
              );
            }
          }
          throw retryError;
        }
      }
    },
    [getAccessToken, refresh, terminateSession],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      initialized,
      isBusy,
      // 以 user 为准:弱网冷启动 token 可能尚未刷到,但会话仍可降级恢复。
      isAuthenticated: user !== null,
      user,
      deviceId,
      loginState,
      authError,
      accountDeletionReceipt,
      accountDeletionRestored,
      clearAuthError,
      consumeAccountDeletionRestored,
      dispatchLoginAction,
      completeOAuthCallback,
      logout,
      terminateSession,
      getAccountDeletionAvailability,
      requestAccountDeletionChallenge,
      confirmAccountDeletion,
      getAccountDeletionStatus,
      clearAccountDeletionReceipt,
      getAccessToken,
      refreshAccessToken: refresh,
      apiFetch,
    }),
    [
      apiFetch,
      accountDeletionReceipt,
      accountDeletionRestored,
      authError,
      clearAccountDeletionReceipt,
      clearAuthError,
      completeOAuthCallback,
      confirmAccountDeletion,
      consumeAccountDeletionRestored,
      deviceId,
      dispatchLoginAction,
      getAccessToken,
      getAccountDeletionAvailability,
      getAccountDeletionStatus,
      refresh,
      initialized,
      isBusy,
      loginState,
      logout,
      requestAccountDeletionChallenge,
      terminateSession,
      user,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}

function authClientFor(deviceId: string): CindyAuthClient {
  // auth 协议只有 cn/global 两条线;dev 目标行为语义归 cn 系(实际连的
  // dev-auth 服务器由 AUTH_API_BASE_URL 决定,与线别参数正交)。
  const region = AUTH_REGION === 'global' ? 'global' : 'cn';
  // 登录 scenario harness 注入点(仅 client 构造参数;implementation-plan Step 0
  // WHAT4)。guard:__DEV__ + EXPO_PUBLIC_LOGIN_SCENARIO(值域见附录 A);
  // 生产构建由 metro resolveRequest 把 fixtures 整模块替换为空 stub 双保险。
  const scenarioFetch = resolveLoginScenarioFetch({
    devModeActive: __DEV__,
    scenario: process.env.EXPO_PUBLIC_LOGIN_SCENARIO,
    region,
  });
  return new CindyAuthClient({
    baseUrl: AUTH_API_BASE_URL,
    region,
    deviceId,
    clientType: 'mobile',
    locale: getAuthLocale(),
    fetch: scenarioFetch ?? (async (input, init) => fetch(input, init)),
  });
}

// mapMembershipToMobileUser / mergeMembershipWithExisting
// 已抽至 @/auth/profileMerge(纯函数,便于单测)。

/** Unblocks initial rendering without aborting a rotating refresh-token request. */
function awaitAuthStartupGate<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, timeoutMs);
    operation.then(
      (value) => {
        if (timedOut) return;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (timedOut) return;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isRejectedRefresh(error: unknown): boolean {
  return (
    error instanceof AuthApiError &&
    (error.statusCode === 401 ||
      error.code.includes('REFRESH_TOKEN') ||
      error.code === 'MEMBERSHIP_DISABLED')
  );
}

function isAccountUnavailableAuthError(error: unknown): boolean {
  return (
    error instanceof AuthApiError &&
    error.statusCode === 401 &&
    error.code === 'ACCOUNT_UNAVAILABLE'
  );
}

/** Returns whether a resource-server 401 may be recovered by refreshing once. */
function isRefreshableUnauthorizedCode(code: string): boolean {
  return (
    code === 'TOKEN_EXPIRED' ||
    code === 'INVALID_TOKEN' ||
    code === 'UNAUTHORIZED' ||
    code === 'HTTP_401'
  );
}

function authErrorCode(error: unknown): string {
  if (error instanceof AuthApiError) return error.code;
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      if (
        [
          'ERR_REQUEST_CANCELED',
          'ERR_WECHAT_CANCELLED',
          'SIGN_IN_CANCELLED',
        ].includes(code)
      ) {
        return 'USER_CANCELLED';
      }
      return code;
    }
  }
  if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message))
    return error.message;
  return 'AUTH_REQUEST_FAILED';
}

function authCodeError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

async function readCachedUserProfile(): Promise<MobileUser | null> {
  try {
    const raw = await getSecureItem(USER_PROFILE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MobileUser>;
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.name !== 'string' ||
      (parsed.membershipKind !== 'personal' && parsed.membershipKind !== 'org')
    )
      return null;
    return parsed as MobileUser;
  } catch {
    return null;
  }
}

async function writeCachedUserProfile(user: MobileUser | null): Promise<void> {
  try {
    if (user) await setSecureItem(USER_PROFILE_KEY, JSON.stringify(user));
    else await deleteSecureItem(USER_PROFILE_KEY);
  } catch {
    // Snapshot persistence is best effort and never blocks the auth flow.
  }
}

async function readPendingOAuth(): Promise<PendingOAuth> {
  const raw = await getSecureItem(PENDING_OAUTH_KEY);
  if (!raw) throw authCodeError('INVALID_AUTH_CODE');
  let parsed: Partial<PendingOAuth>;
  try {
    parsed = JSON.parse(raw) as Partial<PendingOAuth>;
  } catch {
    throw authCodeError('INVALID_AUTH_CODE');
  }
  if (
    typeof parsed.codeVerifier !== 'string' ||
    typeof parsed.deviceId !== 'string' ||
    typeof parsed.state !== 'string' ||
    typeof parsed.createdAt !== 'number' ||
    typeof parsed.label !== 'string'
  )
    throw authCodeError('INVALID_AUTH_CODE');
  if (Date.now() - parsed.createdAt > PENDING_OAUTH_MAX_AGE_MS) {
    await deleteSecureItem(PENDING_OAUTH_KEY).catch(() => undefined);
    throw authCodeError('INVALID_AUTH_CODE');
  }
  return parsed as PendingOAuth;
}
