import * as WebBrowser from 'expo-web-browser';
import { requireNativeModule } from 'expo-modules-core';
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
import { AppState, Keyboard, Linking, Platform } from 'react-native';
import {
  AuthApiError,
  CAPTCHA_CHALLENGE_PAGE_PATH,
  CindyAuthClient,
  accountVaultKey,
  passportVaultKey,
  captchaRequiredActionForVerificationKind,
  discoverSsoOrgRealm,
  parseAccountDeletionReceiptRecord,
  parseAuthSessionRecord,
  reduceAuthFlow,
  serializeAccountDeletionReceiptRecord,
  soleAutoStartSsoMethod,
  soleLoginMethod,
  ssoOrgDiscoveryToMethods,
  serializeAuthSessionRecord,
  type AuthFlowState,
  type AuthRegion,
  type AuthSessionRecord,
  type AuthMembership,
  type AccountDeletionAvailability,
  type AccountDeletionChallenge,
  type AccountDeletionStatus,
  type CaptchaConfig,
  type LoginOutcome,
  type SocialProvider,
  type SsoOrgDiscovery,
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
  activateMobileSessionRealm,
  BUILD_AUTH_REGION,
  getMobileEndpointForRealm,
  getMobileEndpointRealmConfig,
  IS_OTA_SELFHOST,
  loadMobileEndpointsForRealm,
  MOBILE_VISUAL_MOCK_ENABLED,
  MOBILE_REDIRECT_URL,
  OAUTH_BROKER_API_BASE_URL,
  resetMobileSessionRealm,
} from '@/config/env';
import { syncCanaryChannelAfterAuth } from '@/auth/canaryChannelSync';
import { ensureDeviceId, hasStoredDeviceId } from '@/auth/deviceId';
import { decodeJwtOrgSlug, isAccessTokenExpiring } from '@/auth/jwt';
import {
  maybeEnableNonXdOrgBetaDefault,
  maybeEnableXdOrgBetaDefault,
  shouldAttemptOrgBetaDefault,
} from '@/auth/xdOrgBetaDefault';
import { getAuthLocale, getLoginLanguage } from '@/auth/loginMessages';
import { acquireNativeSocialCredential } from '@/auth/nativeSocial';
import { rememberSsoOrgIdentifier } from '@/auth/ssoOrgHistory';
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
import {
  clearMobileLoginCredentialsForLogout,
  commitMobileLoginSessions,
  commitMobileRuntimeResourceSession,
  commitMobileSavedAccountActivation,
  listMobileSavedAccounts,
  mutateMobileAccountVault,
  patchMobileAccountMetadata,
  readMobileAccountVault,
  reconcileMobileActiveAuthSession,
  rememberMobilePassportSession,
  rememberMobileResourceSession,
  removeMobileResourceSessionIfCurrent,
  removeMobilePassportSessionIfCurrent,
  replaceMobileResourceSessionIfCurrent,
  replaceMobilePassportSessionIfCurrent,
  removeMobilePassport,
  type MobileSavedAccount,
} from '@/auth/mobileAccountVault';
import {
  clearTapdbUser,
  setTapdbUser,
  stopMobileTapdbReporting,
} from '@/analytics/mobileTapdb';
import {
  clearAnalyticsConsent,
  migrateExistingLoginAsConsented,
} from '@/analytics/analyticsConsentStore';
import { unregisterPushTokenBestEffort } from '@/notifications/pushNotifications';
import { resetAgentCapabilitiesCache } from '@/session/agentCapabilitiesCache';
import { resetComposerPaletteCache } from '@/session/composerPaletteCache';
import { clearCachedHomeListSnapshot } from '@/session/mobileHomeListCache';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
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
import {
  prepareBetaChannelForDevice,
  enableUncustomizedBetaChannel,
  readBetaChannelState,
} from '@/update/betaChannelStore';
import { probeBetaChannel } from '@/update/fetchLatestRelease';

WebBrowser.maybeCompleteAuthSession();

const AUTH_SESSION_KEY = 'cindy.mobile.auth.session.v1';
const LEGACY_RESOURCE_REFRESH_TOKEN_KEY = 'cindy.mobile.auth.refreshToken';
const LEGACY_ACCOUNT_REFRESH_TOKEN_KEY =
  'cindy.mobile.auth.accountRefreshToken';
const LEGACY_REFRESH_TOKEN_KEY = 'xdt.mobile.refreshToken';
const USER_PROFILE_KEY = 'cindy.mobile.auth.userProfile';
const LEGACY_USER_PROFILE_KEY = 'xdt.mobile.userProfile';
const PENDING_OAUTH_KEY = 'cindy.mobile.auth.pendingOAuth';
const ACCOUNT_DELETION_RECEIPT_KEY = 'cindy.mobile.auth.accountDeletionReceipt';
const LEGACY_PENDING_OAUTH_KEY = 'xdt.mobile.pendingOAuth';
const PENDING_OAUTH_MAX_AGE_MS = 10 * 60 * 1000;
const AUTH_STARTUP_GATE_TIMEOUT_MS = 20 * 1000;
type MobilePassportRefreshPair = Awaited<ReturnType<CindyAuthClient['refreshAccount']>>;
const mobilePassportRefreshFlights = new Map<string, Promise<MobilePassportRefreshPair>>();

/**
 * Passport refresh tokens are rotating, non-replayable credentials. Keep the
 * network request and replacement write single-flight per Passport so sync and
 * an explicit account switch can never consume the same generation twice.
 */
async function refreshMobilePassportSingleFlight(
  client: CindyAuthClient,
  realm: AuthRegion,
  passportId: string,
): Promise<MobilePassportRefreshPair> {
  const key = passportVaultKey(realm, passportId);
  const existing = mobilePassportRefreshFlights.get(key);
  if (existing) return existing;

  const flight = (async () => {
    const current = (await readMobileAccountVault()).passports[key];
    if (!current) throw authCodeError('SAVED_ACCOUNT_REAUTH_REQUIRED');
    try {
      const pair = await client.refreshAccount(current.accountRefreshToken);
      const replacementStored = await replaceMobilePassportSessionIfCurrent({
        realm,
        passportId,
        expectedAccountRefreshToken: current.accountRefreshToken,
        accountRefreshToken: pair.accountRefreshToken,
        memberships: current.memberships,
      });
      if (!replacementStored) throw authCodeError('AUTH_FLOW_SUPERSEDED');
      return pair;
    } catch (error) {
      // A migrated vault or reset deviceId can make this process foreign to a
      // Passport that remains valid on its original device. Preserve it just
      // like the Resource refresh path does.
      if (error instanceof AuthApiError && error.code === 'DEVICE_MISMATCH') {
        throw error;
      }
      if (isDefinitivePassportSessionError(error)) {
        await removeMobilePassportSessionIfCurrent(
          realm,
          passportId,
          current.accountRefreshToken,
        );
      }
      throw error;
    }
  })();
  mobilePassportRefreshFlights.set(key, flight);
  try {
    return await flight;
  } finally {
    if (mobilePassportRefreshFlights.get(key) === flight) {
      mobilePassportRefreshFlights.delete(key);
    }
  }
}

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
  orgLogoUrl: string | null;
  passportId: string;
}

interface CachedUserProfile {
  accountKey: string | null;
  user: MobileUser;
}

interface CachedUserProfileRecord {
  version: 1;
  accountKey: string;
  user: MobileUser;
}

export type MobileLoginAction =
  | { type: 'reset' }
  | { type: 'discover'; email: string }
  | { type: 'discover-sso-org'; org: string }
  | { type: 'confirm-sso-realm' }
  | { type: 'cancel-sso-realm' }
  | { type: 'request-code'; kind: VerificationKind; identifier: string }
  | {
      type: 'verify-code';
      kind: VerificationKind;
      identifier: string;
      code: string;
    }
  | { type: 'start-sso'; connectionId: string; label: string }
  | {
      type: 'start-social-browser';
      provider: SocialProvider;
      label: string;
    }
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
  realm: AuthRegion;
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
  accountGeneration: number;
  savedAccounts: MobileSavedAccount[];
  accountsLoading: boolean;
  accountsError: string | null;
  clearAuthError(): void;
  consumeAccountDeletionRestored(): void;
  dispatchLoginAction(action: MobileLoginAction): Promise<boolean>;
  /**
   * 登录人机验证挑战(global 邮箱发码前置闸):非空时登录页渲染 WebView Modal
   * 装载该托管挑战页;结果经 resolveCaptchaChallenge 回到挂起的发码动作
   * (token = 通过,null = 用户取消/挑战失败)。
   */
  captchaChallenge: { url: string } | null;
  resolveCaptchaChallenge(token: string | null): void;
  completeOAuthCallback(callbackUrl: string): Promise<void>;
  syncSavedAccounts(): Promise<void>;
  switchAccount(accountKey: string): Promise<void>;
  beginAddAccount(): Promise<void>;
  cancelAddAccount(): Promise<void>;
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
      accountGeneration: 0,
      savedAccounts: [],
      accountsLoading: false,
      accountsError: null,
      clearAuthError: () => undefined,
      consumeAccountDeletionRestored: () => undefined,
      dispatchLoginAction: async () => true,
      captchaChallenge: null,
      resolveCaptchaChallenge: () => undefined,
      completeOAuthCallback: async () => undefined,
      syncSavedAccounts: async () => undefined,
      switchAccount: async () => undefined,
      beginAddAccount: async () => undefined,
      cancelAddAccount: async () => undefined,
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
  const pendingAccountRefreshTokenRef = useRef<string | null>(null);
  const pendingAccountMembershipsRef = useRef<AuthMembership[]>([]);
  const additionalLoginRef = useRef(false);
  const [accountGeneration, setAccountGeneration] = useState(0);
  const [savedAccounts, setSavedAccounts] = useState<MobileSavedAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [user, setUser] = useState<MobileUser | null>(null);
  const userRef = useRef<MobileUser | null>(null);
  // 跨区缓存会话在所属 realm 清单尚未就绪时保持未认证，但仍需后台重试，
  // 不能复用只由 user 驱动的弱网自愈条件。
  const [deferredSessionRecovery, setDeferredSessionRecovery] = useState(false);
  const [loginState, setLoginState] = useState<AuthFlowState | null>(null);
  const loginStateRef = useRef<AuthFlowState | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [accountDeletionReceipt, setAccountDeletionReceipt] = useState<
    string | null
  >(null);
  const accountDeletionReceiptRef = useRef<string | null>(null);
  const [accountDeletionRestored, setAccountDeletionRestored] = useState(false);
  const pendingLoginTicketRef = useRef<string | null>(null);
  const pendingBindTicketRef = useRef<string | null>(null);
  const pendingSsoVerificationTicketRef = useRef<string | null>(null);
  const activeAuthRealmRef = useRef<AuthRegion>(BUILD_AUTH_REGION);
  const pendingAuthRealmRef = useRef<AuthRegion | null>(null);
  const accountDeletionReceiptRealmRef = useRef<AuthRegion | null>(null);
  const pendingAccountDeletionRestoredRef = useRef(false);
  const loginActionInFlightRef = useRef<Promise<boolean> | null>(null);
  const loginActionInFlightEpochRef = useRef<number | null>(null);
  const browserCompletionRef = useRef<Promise<void> | null>(null);
  const browserCompletionEpochRef = useRef<number | null>(null);
  // 独立于 authGeneration：关闭“添加账号”只应让该登录流失效，不能让当前
  // 已登录账号的 refresh/runtime 一并过期。
  const loginFlowEpochRef = useRef(0);
  // auth-server rotates refresh tokens, so every caller must share one request.
  const refreshInFlightRef = useRef<Promise<string | null> | null>(null);
  const terminalLogoutInFlightRef = useRef<Promise<void> | null>(null);
  // refresh 定义早于完整清理函数；运行时通过 ref 调用本次 render 的最新实现。
  const terminateSessionImplRef = useRef<
    (reason?: 'ACCOUNT_UNAVAILABLE') => Promise<void>
  >(async () => undefined);
  // Logout bumps this generation so a late refresh cannot resurrect the session.
  const authGenerationRef = useRef(0);
  // 用户主动开始新登录后，旧的弱网会话不得再通过定时/前台恢复抢回界面。
  const sessionRecoverySuspendedRef = useRef(false);
  // SecureStore operations are asynchronous. Serialize mutations so logout always
  // wins over a refresh/login write that was already inside the native storage call.
  const refreshTokenMutationRef = useRef<Promise<void>>(Promise.resolve());
  const userProfileMutationRef = useRef<Promise<void>>(Promise.resolve());
  const accountDeletionReceiptMutationRef = useRef<Promise<void>>(
    Promise.resolve(),
  );
  // OAuth deep link、常规登录和冷启动恢复可并发到达。第一次调用必须在创建
  // device ID 前记录新旧设备状态；后续调用复用同一次 beta 偏好迁移。
  const betaChannelPreparationRef = useRef<Promise<string> | null>(null);

  const suspendSessionRecoveryForLogin = useCallback(() => {
    if (sessionRecoverySuspendedRef.current) return;
    sessionRecoverySuspendedRef.current = true;
    if (additionalLoginRef.current) {
      setDeferredSessionRecovery(false);
      return;
    }
    setMobileAuthOwner(null);
    setAccountGeneration((value) => value + 1);
    authGenerationRef.current += 1;
    refreshInFlightRef.current = null;
    setDeferredSessionRecovery(false);
  }, []);

  const assertLoginFlowCurrent = useCallback((expectedEpoch: number) => {
    if (loginFlowEpochRef.current === expectedEpoch) return;
    throw authCodeError('AUTH_FLOW_SUPERSEDED');
  }, []);

  const prepareBetaChannelForCurrentDevice = useCallback((): Promise<string> => {
    const existing = betaChannelPreparationRef.current;
    if (existing) return existing;
    const run = (async () => {
      const hadExistingDeviceId = await hasStoredDeviceId();
      const did = await ensureDeviceId();
      // beta 偏好存储异常不能拖垮认证启动；失败时 store 保持 migration hold，
      // 只会保守地不自动开 beta。
      await prepareBetaChannelForDevice({ hadExistingDeviceId }).catch(
        () => undefined,
      );
      return did;
    })();
    betaChannelPreparationRef.current = run;
    run.catch(() => {
      if (betaChannelPreparationRef.current === run)
        betaChannelPreparationRef.current = null;
    });
    return run;
  }, []);

  const orgBetaDefaultDeps = useCallback(
    (expectedAuthGeneration: number, expectedUserId: string) => ({
      readCurrentAuthIdentity: () => ({
        authGeneration: authGenerationRef.current,
        userId: userRef.current?.id ?? null,
      }),
      readChannelState: readBetaChannelState,
      probeBetaManifest: () =>
        probeBetaChannel(Platform.OS === 'android' ? 'android' : 'ios'),
      enableBeta: () =>
        enableUncustomizedBetaChannel(
          () =>
            authGenerationRef.current === expectedAuthGeneration &&
            userRef.current?.id === expectedUserId,
        ),
    }),
    [],
  );

  /** 登录态落地后为 xd 组织尝试打开设备级 beta；不阻塞主界面。 */
  const scheduleXdOrgBetaDefault = useCallback(
    (token: string, expectedAuthGeneration: number) => {
      if (!IS_OTA_SELFHOST) return;
      const currentUser = userRef.current;
      if (!currentUser) return;
      const expectedUserId = currentUser.id;
      void (async () => {
        await prepareBetaChannelForCurrentDevice();
        await maybeEnableXdOrgBetaDefault(
          {
            expectedAuthGeneration,
            expectedUserId,
            user: {
              membershipKind: currentUser.membershipKind,
              orgSlug: decodeJwtOrgSlug(token),
              orgName: currentUser.orgName,
            },
          },
          orgBetaDefaultDeps(expectedAuthGeneration, expectedUserId),
        );
      })().catch(() => undefined);
    },
    [orgBetaDefaultDeps, prepareBetaChannelForCurrentDevice],
  );

  /** feature-flags 返回后，仅为非 xd 组织尝试打开设备级 beta。 */
  const scheduleNonXdOrgBetaDefault = useCallback(
    (
      token: string,
      expectedAuthGeneration: number,
      defaultEnableBeta?: boolean,
    ) => {
      if (!IS_OTA_SELFHOST || defaultEnableBeta !== true) return;
      const currentUser = userRef.current;
      if (!currentUser) return;
      const expectedUserId = currentUser.id;
      const request = {
        expectedAuthGeneration,
        expectedUserId,
        user: {
          membershipKind: currentUser.membershipKind,
          orgSlug: decodeJwtOrgSlug(token),
          orgName: currentUser.orgName,
        },
      } as const;
      if (
        shouldAttemptOrgBetaDefault({
          user: request.user,
          defaultEnableBeta,
        }) !== 'flag-enable'
      ) {
        return;
      }
      void (async () => {
        await prepareBetaChannelForCurrentDevice();
        await maybeEnableNonXdOrgBetaDefault(
          request,
          orgBetaDefaultDeps(expectedAuthGeneration, expectedUserId),
        );
      })().catch(() => undefined);
    },
    [orgBetaDefaultDeps, prepareBetaChannelForCurrentDevice],
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
      )
        .then((outcome) => {
          scheduleNonXdOrgBetaDefault(
            token,
            expectedAuthGeneration,
            outcome.defaultEnableBeta,
          );
        })
        .catch(() => undefined);
    },
    [scheduleNonXdOrgBetaDefault],
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
    async (
      receiptToken: string | null,
      realm = activeAuthRealmRef.current,
    ): Promise<void> => {
      const operation = async () => {
        if (receiptToken) {
          await setSecureItem(
            ACCOUNT_DELETION_RECEIPT_KEY,
            serializeAccountDeletionReceiptRecord(realm, receiptToken),
          );
          accountDeletionReceiptRef.current = receiptToken;
          accountDeletionReceiptRealmRef.current = realm;
        } else {
          // Explicit receipt clearing must reject on storage failure instead
          // of updating only the in-memory projection.
          await deleteSecureItem(ACCOUNT_DELETION_RECEIPT_KEY);
          accountDeletionReceiptRef.current = null;
          accountDeletionReceiptRealmRef.current = null;
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

  const commitWithClearedAccountDeletionReceipt = useCallback(
    (commit: () => void): Promise<void> => {
      const operation = async (): Promise<void> => {
        const previousRaw = await getSecureItem(
          ACCOUNT_DELETION_RECEIPT_KEY,
        );
        const previousToken = accountDeletionReceiptRef.current;
        const previousRealm = accountDeletionReceiptRealmRef.current;
        await deleteSecureItem(ACCOUNT_DELETION_RECEIPT_KEY);
        try {
          // Deliberately synchronous: after the post-delete cancellation
          // checks pass, no event-loop turn may reopen the cancellation window
          // before the new owner is published.
          commit();
          accountDeletionReceiptRef.current = null;
          accountDeletionReceiptRealmRef.current = null;
          setAccountDeletionReceipt(null);
        } catch (error) {
          // Add Account can be cancelled while SecureStore is deleting the
          // previous owner's receipt. Restore the exact opaque record before
          // releasing the receipt queue so cancellation cannot consume it.
          if (previousRaw === null) {
            await deleteSecureItem(ACCOUNT_DELETION_RECEIPT_KEY);
          } else {
            await setSecureItem(ACCOUNT_DELETION_RECEIPT_KEY, previousRaw);
          }
          accountDeletionReceiptRef.current = previousToken;
          accountDeletionReceiptRealmRef.current = previousRealm;
          setAccountDeletionReceipt(previousToken);
          throw error;
        }
      };
      const run = accountDeletionReceiptMutationRef.current.then(
        operation,
        operation,
      );
      accountDeletionReceiptMutationRef.current = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    [],
  );

  /* ── 登录人机验证(Turnstile 托管挑战页,按 requiredFor 控制邮箱/短信发码)── */
  const captchaConfigRef = useRef<CaptchaConfig | null>(null);
  const [captchaChallenge, setCaptchaChallenge] = useState<{ url: string } | null>(null);
  const captchaResolveRef = useRef<((token: string | null) => void) | null>(null);

  const updateLoginState = useCallback((next: AuthFlowState | null) => {
    // providers.captcha 只随 identifier/realm-confirmation 步下发,发码动作发生在
    // 后续步骤,进 ref 存续(登录流必经 identifier,ref 必然先就位);cn 构建 /
    // 服务端未开启时字段缺席,captcha 闸整体 no-op。
    if (next?.step === 'identifier' || next?.step === 'realm-confirmation') {
      captchaConfigRef.current = next.providers.captcha ?? null;
    }
    loginStateRef.current = next;
    setLoginState(next);
  }, []);

  /** 登录页 WebView Modal 的结果回传口(token = 通过,null = 取消/失败)。 */
  const resolveCaptchaChallenge = useCallback((token: string | null) => {
    const resolve = captchaResolveRef.current;
    captchaResolveRef.current = null;
    setCaptchaChallenge(null);
    resolve?.(token);
  }, []);

  /** 出题并等结果。有效登录主题由 ThemeOverrideProvider 内的 WebView 补入 URL。 */
  const runCaptchaChallenge = useCallback((kind: VerificationKind): Promise<string | null> => {
    let base = getMobileEndpointForRealm(BUILD_AUTH_REGION, 'authApiBaseUrl');
    while (base.endsWith('/')) base = base.slice(0, -1);
    const action = captchaRequiredActionForVerificationKind(kind);
    const url = `${base}${CAPTCHA_CHALLENGE_PAGE_PATH}?action=${encodeURIComponent(action)}&lang=${encodeURIComponent(getLoginLanguage())}`;
    return new Promise<string | null>((resolve) => {
      // 单飞:dispatchLoginAction 本身串行,这里不会出现并发挑战。
      captchaResolveRef.current = resolve;
      // 验证码浮层不是原生 Modal，也不做键盘避让；先收键盘，避免 iOS 小屏上
      // 挑战内容与取消动作被仍聚焦的 identifier 输入框键盘遮挡。
      Keyboard.dismiss();
      setCaptchaChallenge({ url });
    });
  }, []);

  /** 按发码类型执行前置闸:未启用 → 放行;启用 → 出题;取消 → 不发码。 */
  const ensureCaptchaGate = useCallback(
    async (
      kind: VerificationKind,
    ): Promise<
      { proceed: true; captchaToken?: string } | { proceed: false }
    > => {
      if (
        captchaConfigRef.current?.requiredFor.includes(
          captchaRequiredActionForVerificationKind(kind),
        ) !== true
      ) {
        return { proceed: true };
      }
      const token = await runCaptchaChallenge(kind);
      return token === null
        ? { proceed: false }
        : { proceed: true, captchaToken: token };
    },
    [runCaptchaChallenge],
  );

  /**
   * 发验证码 + 错误驱动兜底:服务端返回 CAPTCHA_REQUIRED/CAPTCHA_INVALID
   * (providers 缓存旧于服务端开关,或 token 恰好过期)时重新出题一次后重试,
   * 仅一次防循环;重试被取消或再失败则抛原错误走统一错误链路。
   */
  const requestCodeWithCaptchaFallback = useCallback(
    async (
      did: string,
      kind: VerificationKind,
      identifier: string,
      captchaToken: string | undefined,
    ): Promise<void> => {
      try {
        await authClientFor(did, BUILD_AUTH_REGION).requestCode(
          kind,
          identifier,
          {
            captchaToken,
          },
        );
      } catch (error) {
        const code = authErrorCode(error);
        if (code !== 'CAPTCHA_REQUIRED' && code !== 'CAPTCHA_INVALID')
          throw error;
        const retryToken = await runCaptchaChallenge(kind);
        if (retryToken === null) throw error;
        await authClientFor(did, BUILD_AUTH_REGION).requestCode(
          kind,
          identifier,
          {
            captchaToken: retryToken,
          },
        );
      }
    },
    [runCaptchaChallenge],
  );

  const setToken = useCallback((token: string | null) => {
    accessTokenRef.current = token;
    setAccessToken(token);
  }, []);

  // 用户资料的唯一写入口:同步 state + 持久化快照。快照让弱网冷启动能先以
  // 缓存资料恢复“已登录”视图,token 由后台刷新补齐。
  const applyUser = useCallback(
    (next: MobileUser | null) => {
      const profileAccountKey = next
        ? accountVaultKey(activeAuthRealmRef.current, next.id)
        : null;
      setDeferredSessionRecovery(false);
      setMobileAuthOwner(next?.id);
      userRef.current = next;
      setUser(next);
      void serializeUserProfileMutation(() =>
        writeCachedUserProfile(next, profileAccountKey),
      );
    },
    [serializeUserProfileMutation],
  );

  const refreshSavedAccountsSnapshot = useCallback(async () => {
    const vault = await readMobileAccountVault();
    const runtimeActiveAccountKey = userRef.current
      ? accountVaultKey(activeAuthRealmRef.current, userRef.current.id)
      : null;
    setSavedAccounts(listMobileSavedAccounts(vault, runtimeActiveAccountKey));
  }, []);

  const refreshSavedAccountsSnapshotBestEffort = useCallback((): void => {
    void refreshSavedAccountsSnapshot().catch(() => undefined);
  }, [refreshSavedAccountsSnapshot]);

  const clearAccountScopedRuntimeForSwitch = useCallback(async () => {
    setMobileAuthOwner(null);
    await Promise.all([
      unregisterPushTokenBestEffort(
        accessTokenRef.current,
        activeAuthRealmRef.current,
      ),
      clearAllMobileVoiceCredentials().catch(() => undefined),
      clearAllMobileVoiceInputHistories().catch(() => undefined),
      clearAllMobileVoiceDictionaryCaches().catch(() => undefined),
      clearCachedSessionMessages().catch(() => undefined),
      clearCachedHomeListSnapshot().catch(() => undefined),
    ]);
    resetComposerPaletteCache();
    resetAgentCapabilitiesCache();
  }, []);

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
      const identityResult = await authClientFor(
        did,
        activeAuthRealmRef.current,
      )
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
        void patchMobileAccountMetadata({
          realm: activeAuthRealmRef.current,
          passportId: identityResult.value.passportId,
          memberships: identityResult.value.identities,
        })
          .then(refreshSavedAccountsSnapshot)
          .catch(() => undefined);
      } else if (isAccountUnavailableAuthError(identityResult.error)) {
        await terminateSessionImplRef.current('ACCOUNT_UNAVAILABLE');
      }
    },
    [applyUser, refreshSavedAccountsSnapshot],
  );

  const acceptOutcome = useCallback(
    async (
      outcome: LoginOutcome,
      did: string,
      expectedLoginFlowEpoch = loginFlowEpochRef.current,
    ): Promise<void> => {
      await deleteSecureItem(PENDING_OAUTH_KEY).catch(() => undefined);
      assertLoginFlowCurrent(expectedLoginFlowEpoch);

      pendingAccountTokenRef.current =
        outcome.status === 'select_account'
          ? (outcome.accountToken ?? null)
          : null;
      if (outcome.status === 'select_account') {
        pendingAccountRefreshTokenRef.current =
          outcome.accountRefreshToken ?? null;
        pendingAccountMembershipsRef.current = outcome.accounts;
      } else if (outcome.status === 'ok' && outcome.accountRefreshToken) {
        pendingAccountRefreshTokenRef.current = outcome.accountRefreshToken;
        pendingAccountMembershipsRef.current = [outcome.membership];
      }

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
      const committedRealm = pendingAuthRealmRef.current ?? BUILD_AUTH_REGION;
      const pendingMembership = pendingAccountMembershipsRef.current.find(
        (membership) => membership.id === outcome.membership.id,
      );
      const passportId =
        outcome.membership.passportId ??
        pendingMembership?.passportId ??
        (userRef.current?.id === outcome.membership.id
          ? userRef.current.passportId
          : '');
      const accountRefreshToken = pendingAccountRefreshTokenRef.current;
      const loginMemberships =
        pendingAccountMembershipsRef.current.length > 0
          ? pendingAccountMembershipsRef.current
          : [outcome.membership];
      const previousRealm = activeAuthRealmRef.current;
      const replacesActiveSession =
        userRef.current !== null &&
        (previousRealm !== committedRealm ||
          userRef.current?.id !== outcome.membership.id);
      const generation = ++authGenerationRef.current;
      refreshInFlightRef.current = null;
      let runtimeCleanupStarted = false;
      const persisted = await serializeRefreshTokenMutation(async () => {
        if (
          authGenerationRef.current !== generation ||
          loginFlowEpochRef.current !== expectedLoginFlowEpoch
        ) {
          return false;
        }
        const previousPersistedSessionRaw = await getSecureItem(AUTH_SESSION_KEY);
        try {
          await commitMobileLoginSessions(
            {
              pair: outcome,
              realm: committedRealm,
              passportId: passportId || undefined,
              accountRefreshToken,
              memberships: loginMemberships,
            },
            async () => {
              assertLoginFlowCurrent(expectedLoginFlowEpoch);
              await writePersistedAuthSession(
                outcome.refreshToken,
                committedRealm,
              );
              if (authGenerationRef.current !== generation) {
                throw authCodeError('AUTH_FLOW_SUPERSEDED');
              }
              assertLoginFlowCurrent(expectedLoginFlowEpoch);
              if (replacesActiveSession) {
                runtimeCleanupStarted = true;
                await clearAccountScopedRuntimeForSwitch();
                if (authGenerationRef.current !== generation) {
                  throw authCodeError('AUTH_FLOW_SUPERSEDED');
                }
                assertLoginFlowCurrent(expectedLoginFlowEpoch);
              }

              await commitWithClearedAccountDeletionReceipt(() => {
                if (authGenerationRef.current !== generation) {
                  throw authCodeError('AUTH_FLOW_SUPERSEDED');
                }
                assertLoginFlowCurrent(expectedLoginFlowEpoch);

                // Receipt deletion and owner publication are one transaction.
                // The receipt helper restores the opaque record if Add Account
                // was cancelled while SecureStore was deleting it.
                pendingAccountDeletionRestoredRef.current = false;
                activateMobileSessionRealm(committedRealm);
                activeAuthRealmRef.current = committedRealm;
                pendingLoginTicketRef.current = null;
                pendingAccountTokenRef.current = null;
                pendingAccountRefreshTokenRef.current = null;
                pendingAccountMembershipsRef.current = [];
                pendingBindTicketRef.current = null;
                pendingSsoVerificationTicketRef.current = null;
                pendingAuthRealmRef.current = null;
                setToken(outcome.accessToken);
                applyUser(
                  mergeMembershipWithExisting(
                    outcome.membership,
                    userRef.current,
                    passportId || undefined,
                  ),
                );
                additionalLoginRef.current = false;
                sessionRecoverySuspendedRef.current = false;
                setAccountGeneration((value) => value + 1);
                updateLoginState(
                  reduceAuthFlow(loginStateRef.current, {
                    type: 'outcome',
                    outcome,
                  }),
                );
                // 只有 resource token、用户资料与 refresh token 全部落地后才发布恢复提示。
                setAccountDeletionRestored(deletionWasRestored);
              });
            },
          );
          return true;
        } catch (error) {
          await restorePersistedAuthSessionRaw(previousPersistedSessionRaw);
          if (
            runtimeCleanupStarted &&
            authGenerationRef.current === generation
          ) {
            // Runtime cleanup is rebuildable rather than durable. If the login
            // is cancelled while push/cache cleanup is in flight, republish the
            // old owner and advance its generation after cleanup settles so
            // account-scoped effects reconnect from the restored session.
            activateMobileSessionRealm(previousRealm);
            setMobileAuthOwner(userRef.current?.id ?? null);
            setAccountGeneration((value) => value + 1);
          }
          throw error;
        }
      });
      if (!persisted) throw authCodeError('AUTH_FLOW_SUPERSEDED');
      refreshSavedAccountsSnapshotBestEffort();
      void clearCanaryChannel().catch(() => undefined);
      scheduleCanaryChannelSync(outcome.accessToken, generation);
      scheduleXdOrgBetaDefault(outcome.accessToken, generation);
      // Identity is already durable. Product preferences/profile hydration is best effort
      // and must not turn a successful login into an error on a transient downstream outage.
      void loadMe(outcome.accessToken, did, generation).catch(() => undefined);
    },
    [
      applyUser,
      assertLoginFlowCurrent,
      clearAccountScopedRuntimeForSwitch,
      commitWithClearedAccountDeletionReceipt,
      loadMe,
      scheduleCanaryChannelSync,
      scheduleXdOrgBetaDefault,
      refreshSavedAccountsSnapshotBestEffort,
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
        const reconciledAuth = await serializeRefreshTokenMutation(() =>
          reconcileMobileActiveAuthSession({
            readPersistedSession: readPersistedAuthSessionStrict,
            writePersistedSession: writePersistedAuthSession,
            clearPersistedSession: () => deleteSecureItem(AUTH_SESSION_KEY),
          }),
        ).catch(() => null);
        if (!reconciledAuth) return null;
        const persistedVault = reconciledAuth.vault;
        const activeResourceAtStart = persistedVault?.activeAccountKey
          ? {
              accountKey: persistedVault.activeAccountKey,
              resource:
                persistedVault.resources[persistedVault.activeAccountKey],
            }
          : null;
        if (typeof persistedVault?.signedOutAt === 'number') {
          await clearCanaryChannel().catch(() => undefined);
          return null;
        }
        const refreshCandidates = reconciledAuth.refreshCandidates;
        if (authGenerationRef.current !== generation) return null;
        if (refreshCandidates.length === 0) {
          await clearCanaryChannel().catch(() => undefined);
          return null;
        }
        let selectedSession: AuthSessionRecord | null = null;
        let selectedPair: Awaited<ReturnType<CindyAuthClient['refresh']>> | null = null;
        let selectedPassportId: string | undefined;
        const rejectedRefreshTokens: string[] = [];
        try {
          for (const [index, candidate] of refreshCandidates.entries()) {
            let pair: Awaited<ReturnType<CindyAuthClient['refresh']>>;
            try {
              await loadMobileEndpointsForRealm(candidate.realm);
              if (authGenerationRef.current !== generation) return null;
              pair = await authClientFor(did, candidate.realm).refresh(
                candidate.refreshToken,
              );
            } catch (candidateError) {
              const rejected = isRejectedRefresh(candidateError);
              const deviceMismatch =
                candidateError instanceof AuthApiError &&
                candidateError.code === 'DEVICE_MISMATCH';
              if (rejected && !deviceMismatch) {
                rejectedRefreshTokens.push(candidate.refreshToken);
              }
              if (
                !rejected ||
                deviceMismatch ||
                index === refreshCandidates.length - 1
              ) {
                throw candidateError;
              }
              continue;
            }

            if (authGenerationRef.current !== generation) return null;
            const candidateAccountKey = accountVaultKey(
              candidate.realm,
              pair.membership.id,
            );
            const passportId =
              pair.membership.passportId ??
              persistedVault.resources[candidateAccountKey]?.metadata
                .passportId ??
              (userRef.current?.id === pair.membership.id
                ? userRef.current.passportId
                : undefined);
            const resourceCommit = await serializeRefreshTokenMutation(
              async () => {
                if (authGenerationRef.current !== generation) return 'stale';
                if (!passportId) {
                  if (
                    persistedVault.activeAccountKey &&
                    persistedVault.activeAccountKey !== candidateAccountKey
                  ) {
                    return 'inactive';
                  }
                  await writePersistedAuthSession(
                    pair.refreshToken,
                    candidate.realm,
                  );
                  return authGenerationRef.current === generation
                    ? 'active'
                    : 'stale';
                }
                return commitMobileRuntimeResourceSession({
                  expectedRefreshToken: candidate.refreshToken,
                  compatibilityRefreshTokens: refreshCandidates
                    .filter(
                      (refreshCandidate) =>
                        refreshCandidate.realm === candidate.realm,
                    )
                    .map(
                      (refreshCandidate) => refreshCandidate.refreshToken,
                    ),
                  pair,
                  realm: candidate.realm,
                  passportId,
                  validateBeforeWrite: () => {
                    if (authGenerationRef.current !== generation) {
                      throw authCodeError('AUTH_FLOW_SUPERSEDED');
                    }
                  },
                  afterPersist: async () => {
                    if (authGenerationRef.current !== generation) {
                      throw authCodeError('AUTH_FLOW_SUPERSEDED');
                    }
                    await writePersistedAuthSession(
                      pair.refreshToken,
                      candidate.realm,
                    );
                    if (authGenerationRef.current !== generation) {
                      throw authCodeError('AUTH_FLOW_SUPERSEDED');
                    }
                  },
                });
              },
            );
            if (resourceCommit === 'stale') return null;
            if (resourceCommit === 'inactive') {
              // A successful refresh rotates the token even when this is only
              // the stale compatibility account. Its replacement is durable;
              // continue until the vault's active account wins the CAS.
              refreshSavedAccountsSnapshotBestEffort();
              continue;
            }
            selectedSession = candidate;
            selectedPair = pair;
            selectedPassportId = passportId;
            break;
          }
          if (!selectedSession || !selectedPair) return null;
          const session = selectedSession;
          const pair = selectedPair;
          const passportId = selectedPassportId;
          activateMobileSessionRealm(session.realm);
          activeAuthRealmRef.current = session.realm;
          if (authGenerationRef.current !== generation) return null;
          setToken(pair.accessToken);
          applyUser(
            mergeMembershipWithExisting(
              pair.membership,
              userRef.current,
              passportId,
            ),
          );
          refreshSavedAccountsSnapshotBestEffort();
          scheduleCanaryChannelSync(pair.accessToken, generation);
          scheduleXdOrgBetaDefault(pair.accessToken, generation);
          void loadMe(pair.accessToken, did, generation).catch(
            () => undefined,
          );
          return pair.accessToken;
        } catch (error) {
          if (authGenerationRef.current !== generation) return null;
          if (isRejectedRefresh(error)) {
            const rejectedAccountKey =
              activeResourceAtStart?.resource &&
              rejectedRefreshTokens.includes(
                activeResourceAtStart.resource.refreshToken,
              )
                ? activeResourceAtStart.accountKey
                : null;
            if (
              rejectedAccountKey &&
              !(
                error instanceof AuthApiError &&
                error.code === 'DEVICE_MISMATCH'
              )
            ) {
              try {
                const removal = await removeMobileResourceSessionIfCurrent({
                  accountKey: rejectedAccountKey,
                  expectedRefreshToken:
                    activeResourceAtStart!.resource!.refreshToken,
                  validateBeforeWrite: () => {
                    if (authGenerationRef.current !== generation) {
                      throw authCodeError('AUTH_FLOW_SUPERSEDED');
                    }
                  },
                });
                if (removal !== 'removed') return null;
              } catch (removalError) {
                if (authGenerationRef.current !== generation) return null;
                throw removalError;
              }
              refreshSavedAccountsSnapshotBestEffort();
            }
            if (authGenerationRef.current !== generation) return null;
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
      refreshSavedAccountsSnapshotBestEffort,
      scheduleCanaryChannelSync,
      scheduleXdOrgBetaDefault,
      serializeRefreshTokenMutation,
      setToken,
    ],
  );

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setIsBusy(true);
      try {
        const did = await prepareBetaChannelForCurrentDevice();
        if (cancelled || sessionRecoverySuspendedRef.current) return;
        deviceIdRef.current = did;
        setDeviceId(did);
        await refreshSavedAccountsSnapshot().catch(() => undefined);
        const persistedAccountVault = await readMobileAccountVault().catch(
          () => null,
        );
        const signedOutTombstone =
          typeof persistedAccountVault?.signedOutAt === 'number';
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
        let storedSession = signedOutTombstone
          ? null
          : await readPersistedAuthSession();
        if (signedOutTombstone) {
          // Logout writes the empty-vault tombstone before deleting the
          // compatibility session key. If the process stopped between those
          // writes, the tombstone remains authoritative on the next launch.
          await serializeRefreshTokenMutation(() =>
            deleteSecureItem(AUTH_SESSION_KEY).catch(() => undefined),
          );
          await deleteSecureItem(LEGACY_RESOURCE_REFRESH_TOKEN_KEY).catch(
            () => undefined,
          );
        } else if (!storedSession) {
          const legacyToken = await getSecureItem(
            LEGACY_RESOURCE_REFRESH_TOKEN_KEY,
          ).catch(() => null);
          if (legacyToken) {
            await writePersistedAuthSession(legacyToken, BUILD_AUTH_REGION);
            await deleteSecureItem(LEGACY_RESOURCE_REFRESH_TOKEN_KEY).catch(
              () => undefined,
            );
            storedSession = {
              version: 1,
              realm: BUILD_AUTH_REGION,
              refreshToken: legacyToken,
            };
          }
        }
        const [cachedProfile, storedDeletionReceiptRaw] = await Promise.all([
          readCachedUserProfile(),
          getSecureItem(ACCOUNT_DELETION_RECEIPT_KEY).catch(() => null),
        ]);
        const cachedUser = cachedProfile?.user ?? null;
        const storedDeletionReceipt =
          parseAccountDeletionReceiptRecord(storedDeletionReceiptRaw) ??
          (storedDeletionReceiptRaw &&
          !storedDeletionReceiptRaw.trimStart().startsWith('{')
            ? {
                version: 1 as const,
                realm: BUILD_AUTH_REGION,
                receiptToken: storedDeletionReceiptRaw,
              }
            : null);
        if (storedDeletionReceipt) {
          accountDeletionReceiptRef.current =
            storedDeletionReceipt.receiptToken;
          accountDeletionReceiptRealmRef.current = storedDeletionReceipt.realm;
          setAccountDeletionReceipt(storedDeletionReceipt.receiptToken);
          // Older builds stored only the opaque receipt; migrate it atomically
          // with the deterministic build-region interpretation.
          if (!parseAccountDeletionReceiptRecord(storedDeletionReceiptRaw)) {
            await setSecureItem(
              ACCOUNT_DELETION_RECEIPT_KEY,
              serializeAccountDeletionReceiptRecord(
                storedDeletionReceipt.realm,
                storedDeletionReceipt.receiptToken,
              ),
            );
          }
        }
        // 弱网冷启动只有在会话所属 realm 的业务端点已整体激活后，才发布缓存用户。
        // 构建 realm 命中启动缓存，不增加网络依赖；跨区清单不可用时保持未认证，
        // 防止业务调用先捕获构建区 URL、随后 refresh 又把对端 token 发给该 URL。
        const cachedAccountKey =
          storedSession && cachedUser
            ? accountVaultKey(storedSession.realm, cachedUser.id)
            : null;
        const cachedProfileMatchesActiveAccount =
          cachedAccountKey !== null &&
          persistedAccountVault?.activeAccountKey === cachedAccountKey &&
          (cachedProfile?.accountKey === cachedAccountKey ||
            cachedProfile?.accountKey === null);
        if (storedSession && cachedUser && cachedProfileMatchesActiveAccount) {
          try {
            await loadMobileEndpointsForRealm(storedSession.realm);
            if (cancelled) return;
            activateMobileSessionRealm(storedSession.realm);
            activeAuthRealmRef.current = storedSession.realm;
            userRef.current = cachedUser;
            setMobileAuthOwner(cachedUser.id);
            setUser(cachedUser);
            if (cachedProfile.accountKey === null) {
              void serializeUserProfileMutation(() =>
                writeCachedUserProfile(cachedUser, cachedAccountKey),
              );
            }
          } catch {
            if (!cancelled) setDeferredSessionRecovery(true);
          }
        }
        if (!storedSession)
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
      setMobileAuthOwner(null);
      setUser(null);
    });
    return () => {
      cancelled = true;
    };
  }, [
    prepareBetaChannelForCurrentDevice,
    refresh,
    refreshSavedAccountsSnapshot,
    serializeRefreshTokenMutation,
  ]);

  // 降级会话自愈:已安全发布的缓存用户，或因跨区清单失败而延迟发布的会话，
  // 都以退避节奏和回前台时机重试。
  useEffect(() => {
    const hasRecoverableSession =
      user !== null || deferredSessionRecovery;
    if (
      !initialized ||
      accessToken ||
      !hasRecoverableSession ||
      sessionRecoverySuspendedRef.current
    )
      return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const scheduleNext = () => {
      if (cancelled || sessionRecoverySuspendedRef.current) return;
      attempt += 1;
      const delay = Math.min(5_000 * 2 ** attempt, 60_000);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void tryRefresh(), delay);
    };
    const tryRefresh = async () => {
      if (cancelled || sessionRecoverySuspendedRef.current) return;
      try {
        const token = await refresh();
        if (cancelled || sessionRecoverySuspendedRef.current) return;
        if (token) return;
        let storedSession: AuthSessionRecord | null;
        try {
          storedSession = await readPersistedAuthSession();
        } catch {
          scheduleNext();
          return;
        }
        if (cancelled || sessionRecoverySuspendedRef.current) return;
        if (!storedSession) {
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
  }, [
    accessToken,
    applyUser,
    deferredSessionRecovery,
    initialized,
    refresh,
    user,
  ]);

  // 存量同意迁移已在冷启动流程里 await 完成(见上方 initialize),这里只负责绑定
  // 账号标识 —— initialized 变 true 时迁移必然已经落盘。
  useEffect(() => {
    if (!initialized) return;
    if (user?.id) {
      void setTapdbUser(user.id);
      // THEMIS 安全 SDK 上报绑定用户 ID(构建期注入原生模块,缺模块时静默降级)。
      // 用 requireNativeModule 而非 require('xdt-themis'):前者是 expo-modules-core
      // 的运行时查找(不受 Metro 静态解析影响),模块缺失时抛出可捕获的错误。
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call,@typescript-eslint/no-unsafe-member-access
        requireNativeModule('XdtThemis').addCustomField('playerinfo', String(user.id));
      } catch {
        // xdt-themis is build-time injected; absent in dev / unconfigured regions.
      }
    } else {
      void clearTapdbUser();
      // 登出时清除 THEMIS 用户绑定,避免崩溃/强杀上报误归于上一个账号。
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call,@typescript-eslint/no-unsafe-member-access
        requireNativeModule('XdtThemis').addCustomField('playerinfo', '');
      } catch {
        // xdt-themis is build-time injected; absent in dev / unconfigured regions.
      }
    }
  }, [initialized, user?.id]);

  // 词典缓存的落盘键按账号分区。登出清理是尽力而为的(索引可能读不出来),分区让
  // 「没删干净」不再等于「下个账号能读到上个账号的词条并发给润色模型」。
  useEffect(() => {
    setMobileVoiceDictionaryAccountScope(user?.id ?? '');
  }, [user?.id]);

  const completeOAuthCallback = useCallback(
    (
      callbackUrl: string,
      expectedLoginFlowEpoch = loginFlowEpochRef.current,
    ): Promise<void> => {
      if (
        browserCompletionRef.current &&
        browserCompletionEpochRef.current === expectedLoginFlowEpoch
      ) {
        return browserCompletionRef.current;
      }
      suspendSessionRecoveryForLogin();
      const run = (async () => {
        setIsBusy(true);
        try {
          if (!matchesOAuthCallbackUrl(callbackUrl, MOBILE_REDIRECT_URL)) {
            throw authCodeError('INVALID_AUTH_CODE');
          }
          const pending = await readPendingOAuth();
          assertLoginFlowCurrent(expectedLoginFlowEpoch);
          const callback = parseOAuthCallbackUrl(callbackUrl);
          if (callback.state !== pending.state)
            throw authCodeError('STATE_MISMATCH');
          try {
            await loadMobileEndpointsForRealm(pending.realm);
          } catch {
            throw new AuthApiError(
              'ORG_REALM_UNAVAILABLE',
              503,
              'Unable to load the enterprise auth region manifest',
            );
          }
          assertLoginFlowCurrent(expectedLoginFlowEpoch);
          pendingAuthRealmRef.current = pending.realm;
          const outcome = await authClientFor(
            pending.deviceId,
            pending.realm,
          ).exchangeAuthorizationCode(callback.code, pending.codeVerifier);
          assertLoginFlowCurrent(expectedLoginFlowEpoch);
          deviceIdRef.current = pending.deviceId;
          setDeviceId(pending.deviceId);
          await acceptOutcome(
            outcome,
            pending.deviceId,
            expectedLoginFlowEpoch,
          );
          setAuthError(null);
        } catch (error) {
          if (loginFlowEpochRef.current !== expectedLoginFlowEpoch) throw error;
          const code = authErrorCode(error);
          if (code === 'INVALID_AUTH_CODE') {
            await deleteSecureItem(PENDING_OAUTH_KEY).catch(() => undefined);
            pendingAuthRealmRef.current = null;
            if (!additionalLoginRef.current) resetMobileSessionRealm();
            updateLoginState(null);
          }
          setAuthError(code);
          throw error;
        } finally {
          if (loginFlowEpochRef.current === expectedLoginFlowEpoch) {
            setIsBusy(false);
          }
        }
      })();
      browserCompletionRef.current = run;
      browserCompletionEpochRef.current = expectedLoginFlowEpoch;
      run.then(
        () => {
          if (browserCompletionRef.current === run) {
            browserCompletionRef.current = null;
            browserCompletionEpochRef.current = null;
          }
        },
        () => {
          if (browserCompletionRef.current === run) {
            browserCompletionRef.current = null;
            browserCompletionEpochRef.current = null;
          }
        },
      );
      return run;
    },
    [
      acceptOutcome,
      assertLoginFlowCurrent,
      suspendSessionRecoveryForLogin,
      updateLoginState,
    ],
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
      const expectedLoginFlowEpoch = loginFlowEpochRef.current;
      suspendSessionRecoveryForLogin();
      if (
        loginActionInFlightRef.current &&
        loginActionInFlightEpochRef.current === expectedLoginFlowEpoch
      ) {
        return loginActionInFlightRef.current;
      }
      let run: Promise<boolean>;
      const clearIfCurrent = () => {
        if (loginActionInFlightRef.current === run) {
          loginActionInFlightRef.current = null;
          loginActionInFlightEpochRef.current = null;
        }
      };
      run = (async () => {
        setIsBusy(true);
        setAuthError(null);
        try {
          const did =
            deviceIdRef.current ?? (await prepareBetaChannelForCurrentDevice());
          assertLoginFlowCurrent(expectedLoginFlowEpoch);
          deviceIdRef.current = did;
          setDeviceId(did);
          const startsBuildRealmFlow =
            action.type === 'discover' ||
            action.type === 'request-code' ||
            action.type === 'verify-code' ||
            action.type === 'start-social-browser' ||
            action.type === 'native-social';
          if (startsBuildRealmFlow) {
            pendingAuthRealmRef.current = null;
            if (!additionalLoginRef.current) resetMobileSessionRealm();
          }
          const loginRealm = pendingAuthRealmRef.current ?? BUILD_AUTH_REGION;
          const client = authClientFor(did, loginRealm);
          const startBrowserAuthorization = async (input: {
            previousState: AuthFlowState;
            kind: 'social' | 'sso';
            providerOrConnectionId: string;
            label: string;
          }): Promise<boolean> => {
            const { codeVerifier, codeChallenge } = await createPkcePair();
            assertLoginFlowCurrent(expectedLoginFlowEpoch);
            const state = createState();
            await setSecureItem(
              PENDING_OAUTH_KEY,
              JSON.stringify({
                codeVerifier,
                deviceId: did,
                state,
                createdAt: Date.now(),
                label: input.label,
                realm: loginRealm,
              } satisfies PendingOAuth),
            );
            assertLoginFlowCurrent(expectedLoginFlowEpoch);
            updateLoginState(
              reduceAuthFlow(input.previousState, {
                type: 'browser-started',
                label: input.label,
              }),
            );
            const authUrl = client.buildAuthorizeUrl({
              kind: input.kind,
              providerOrConnectionId: input.providerOrConnectionId,
              redirectUri: MOBILE_REDIRECT_URL,
              codeChallenge,
              state,
            });
            const result = await WebBrowser.openAuthSessionAsync(
              authUrl,
              MOBILE_REDIRECT_URL,
            );
            assertLoginFlowCurrent(expectedLoginFlowEpoch);
            if (result.type === 'success') {
              await completeOAuthCallback(result.url, expectedLoginFlowEpoch);
              return true;
            }
            await deleteSecureItem(PENDING_OAUTH_KEY).catch(() => undefined);
            assertLoginFlowCurrent(expectedLoginFlowEpoch);
            pendingAuthRealmRef.current = null;
            updateLoginState(null);
            throw authCodeError('USER_CANCELLED');
          };

          if (action.type === 'reset') {
            pendingAccountTokenRef.current = null;
            pendingAccountRefreshTokenRef.current = null;
            pendingAccountMembershipsRef.current = [];
            pendingLoginTicketRef.current = null;
            pendingBindTicketRef.current = null;
            pendingSsoVerificationTicketRef.current = null;
            pendingAuthRealmRef.current = null;
            if (!additionalLoginRef.current) resetMobileSessionRealm();
            pendingAccountDeletionRestoredRef.current = false;
            setAccountDeletionRestored(false);
            await deleteSecureItem(PENDING_OAUTH_KEY).catch(() => undefined);
            assertLoginFlowCurrent(expectedLoginFlowEpoch);
            const providers = await authClientFor(
              did,
              BUILD_AUTH_REGION,
            ).getProviders();
            assertLoginFlowCurrent(expectedLoginFlowEpoch);
            updateLoginState(
              reduceAuthFlow(loginStateRef.current, {
                type: 'providers-loaded',
                providers,
              }),
            );
            return true;
          }
          if (action.type === 'confirm-sso-realm') {
            const confirmation = loginStateRef.current;
            if (
              confirmation?.step !== 'realm-confirmation' ||
              pendingAuthRealmRef.current !== confirmation.targetRegion
            ) {
              throw authCodeError('INVALID_AUTH_ACTION');
            }
            const sole = soleAutoStartSsoMethod(confirmation.methods);
            if (sole) {
              return startBrowserAuthorization({
                previousState: confirmation,
                kind: 'sso',
                providerOrConnectionId: sole.connectionId,
                label: sole.connectionName || sole.orgName,
              });
            }
            updateLoginState(
              reduceAuthFlow(confirmation, {
                type: 'discovery-loaded',
                email: '',
                methods: confirmation.methods,
              }),
            );
            return true;
          }
          if (action.type === 'cancel-sso-realm') {
            const confirmation = loginStateRef.current;
            if (confirmation?.step !== 'realm-confirmation') {
              throw authCodeError('INVALID_AUTH_ACTION');
            }
            pendingAuthRealmRef.current = null;
            if (!additionalLoginRef.current) resetMobileSessionRealm();
            updateLoginState(
              reduceAuthFlow(confirmation, {
                type: 'providers-loaded',
                providers: confirmation.providers,
              }),
            );
            return true;
          }
          if (action.type === 'discover') {
            const email = action.email.trim().toLowerCase();
            const methods = await authClientFor(
              did,
              BUILD_AUTH_REGION,
            ).discover(email);
            assertLoginFlowCurrent(expectedLoginFlowEpoch);
            const currentState = loginStateRef.current;
            const sole = soleLoginMethod(methods);
            if (sole?.type === 'sso' && currentState) {
              return startBrowserAuthorization({
                previousState: currentState,
                kind: 'sso',
                providerOrConnectionId: sole.connectionId,
                label: sole.connectionName || sole.orgName,
              });
            }
            if (sole?.type === 'email_code') {
              // 人机验证前置闸(覆盖 discovery→发码的自动串发路径):取消则不
              // 串发,落 method-choice,用户可从个人行再次发起(会重新过闸)。
              const gate = await ensureCaptchaGate('email');
              assertLoginFlowCurrent(expectedLoginFlowEpoch);
              if (!gate.proceed) {
                updateLoginState(
                  reduceAuthFlow(currentState, {
                    type: 'discovery-loaded',
                    email,
                    methods,
                  }),
                );
                return true;
              }
              await requestCodeWithCaptchaFallback(
                did,
                'email',
                email,
                gate.captchaToken,
              );
              assertLoginFlowCurrent(expectedLoginFlowEpoch);
              updateLoginState(
                reduceAuthFlow(currentState, {
                  type: 'code-requested',
                  kind: 'email',
                  identifier: email,
                }),
              );
              return true;
            }
            updateLoginState(
              reduceAuthFlow(currentState, {
                type: 'discovery-loaded',
                email,
                methods,
              }),
            );
            return true;
          }
          // 企业 SSO 入口（按组织 ID/slug/已验证域名）：唯一连接直接进浏览器；
          // 多连接才映射进 method-choice，复用连接选择 UI 与 start-sso 流程。
          if (action.type === 'discover-sso-org') {
            const org = action.org.trim().toLowerCase();
            // 新的一次组织发现不得复用上一轮成功结果；只有本轮双区判定成功后
            // 才重新冻结 pending realm。
            pendingAuthRealmRef.current = null;
            const realmConfig = getMobileEndpointRealmConfig();
            let discovery: SsoOrgDiscovery;
            if (
              realmConfig.crossRealmOrgLoginEnabled &&
              realmConfig.realmManifestBaseUrls
            ) {
              try {
                await Promise.all([
                  loadMobileEndpointsForRealm('cn'),
                  loadMobileEndpointsForRealm('global'),
                ]);
                assertLoginFlowCurrent(expectedLoginFlowEpoch);
              } catch {
                throw new AuthApiError(
                  'ORG_REALM_UNAVAILABLE',
                  503,
                  'Unable to load both enterprise auth region manifests',
                );
              }
              const selected = await discoverSsoOrgRealm(org, {
                cn: authClientFor(did, 'cn'),
                global: authClientFor(did, 'global'),
              });
              assertLoginFlowCurrent(expectedLoginFlowEpoch);
              pendingAuthRealmRef.current = selected.region;
              discovery = selected.discovery;
            } else {
              pendingAuthRealmRef.current = BUILD_AUTH_REGION;
              discovery = await authClientFor(
                did,
                BUILD_AUTH_REGION,
              ).discoverSsoOrg(org);
              assertLoginFlowCurrent(expectedLoginFlowEpoch);
            }
            const methods = ssoOrgDiscoveryToMethods(discovery);
            // A sole same-region connection auto-starts browser authorization
            // below. Persist the successful discovery first so cancel/timeout
            // does not lose a valid organization identifier.
            await rememberSsoOrgIdentifier(action.org);
            assertLoginFlowCurrent(expectedLoginFlowEpoch);
            const currentState = loginStateRef.current;
            if (discovery.region !== BUILD_AUTH_REGION) {
              if (currentState?.step !== 'identifier') {
                throw authCodeError('INVALID_AUTH_ACTION');
              }
              updateLoginState(
                reduceAuthFlow(currentState, {
                  type: 'realm-switch-required',
                  targetRegion: discovery.region,
                  providers: currentState.providers,
                  methods,
                }),
              );
            } else {
              const sole = soleAutoStartSsoMethod(methods);
              if (sole && currentState) {
                return startBrowserAuthorization({
                  previousState: currentState,
                  kind: 'sso',
                  providerOrConnectionId: sole.connectionId,
                  label: sole.connectionName || sole.orgName,
                });
              }
              updateLoginState(
                reduceAuthFlow(currentState, {
                  type: 'discovery-loaded',
                  email: '',
                  methods,
                }),
              );
            }
            return true;
          }
          if (action.type === 'request-code') {
            const identifier = action.identifier.trim();
            const gate = await ensureCaptchaGate(action.kind);
            assertLoginFlowCurrent(expectedLoginFlowEpoch);
            // 取消:不发码、不改状态、不报错(用户可再点发送/重发)。
            if (!gate.proceed) return false;
            await requestCodeWithCaptchaFallback(
              did,
              action.kind,
              identifier,
              gate.captchaToken,
            );
            assertLoginFlowCurrent(expectedLoginFlowEpoch);
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
              await authClientFor(did, BUILD_AUTH_REGION).verifyCode(
                action.kind,
                action.identifier.trim(),
                action.code,
              ),
              did,
              expectedLoginFlowEpoch,
            );
            return true;
          }
          if (action.type === 'native-social') {
            const credential = await acquireNativeSocialCredential(
              action.provider,
            );
            assertLoginFlowCurrent(expectedLoginFlowEpoch);
            await acceptOutcome(
              await authClientFor(did, BUILD_AUTH_REGION).exchangeNativeSocial(
                action.provider,
                credential,
              ),
              did,
              expectedLoginFlowEpoch,
            );
            return true;
          }
          if (action.type === 'start-social-browser') {
            const previousState = loginStateRef.current;
            if (
              previousState?.step !== 'identifier' ||
              !previousState.providers.social.includes(action.provider)
            ) {
              throw authCodeError('SOCIAL_PROVIDER_UNAVAILABLE');
            }
            return startBrowserAuthorization({
              previousState,
              kind: 'social',
              providerOrConnectionId: action.provider,
              label: action.label,
            });
          }
          if (action.type === 'start-sso') {
            const previousState = loginStateRef.current;
            if (
              previousState?.step !== 'method-choice' ||
              !previousState.methods.some(
                (method) =>
                  method.type === 'sso' &&
                  method.connectionId === action.connectionId,
              )
            ) {
              throw authCodeError('INVALID_AUTH_ACTION');
            }
            return startBrowserAuthorization({
              previousState,
              kind: 'sso',
              providerOrConnectionId: action.connectionId,
              label: action.label,
            });
          }
          if (action.type === 'select-account') {
            const accountToken = pendingAccountTokenRef.current;
            if (accountToken) {
              const pair = await client.exchangeAccountMembership(
                accountToken,
                action.accountId,
              );
              assertLoginFlowCurrent(expectedLoginFlowEpoch);
              pendingAccountTokenRef.current = null;
              await acceptOutcome(
                { status: 'ok', ...pair },
                did,
                expectedLoginFlowEpoch,
              );
              return true;
            }
            const ticket = pendingLoginTicketRef.current;
            if (!ticket) throw authCodeError('INVALID_LOGIN_TICKET');
            await acceptOutcome(
              await client.selectAccount(ticket, action.accountId),
              did,
              expectedLoginFlowEpoch,
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
            assertLoginFlowCurrent(expectedLoginFlowEpoch);
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
              expectedLoginFlowEpoch,
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
            assertLoginFlowCurrent(expectedLoginFlowEpoch);
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
            expectedLoginFlowEpoch,
          );
          return true;
        } catch (error) {
          if (loginFlowEpochRef.current !== expectedLoginFlowEpoch) return false;
          const code = authErrorCode(error);
          if (
            code === 'INVALID_LOGIN_TICKET' ||
            code === 'INVALID_BIND_TICKET' ||
            code === 'INVALID_SSO_VERIFICATION_TICKET' ||
            code === 'INVALID_TOKEN' ||
            code === 'TOKEN_EXPIRED' ||
            code === 'AUTH_FLOW_SUPERSEDED' ||
            code === 'USER_CANCELLED'
          ) {
            pendingAccountTokenRef.current = null;
            pendingAccountRefreshTokenRef.current = null;
            pendingAccountMembershipsRef.current = [];
            pendingLoginTicketRef.current = null;
            pendingBindTicketRef.current = null;
            pendingSsoVerificationTicketRef.current = null;
            pendingAuthRealmRef.current = null;
            pendingAccountDeletionRestoredRef.current = false;
            setAccountDeletionRestored(false);
            updateLoginState(null);
          }
          setAuthError(code);
          return false;
        } finally {
          if (loginFlowEpochRef.current === expectedLoginFlowEpoch) {
            setIsBusy(false);
          }
        }
      })();
      loginActionInFlightRef.current = run;
      loginActionInFlightEpochRef.current = expectedLoginFlowEpoch;
      run.then(clearIfCurrent, clearIfCurrent);
      return run;
    },
    [
      acceptOutcome,
      assertLoginFlowCurrent,
      completeOAuthCallback,
      ensureCaptchaGate,
      requestCodeWithCaptchaFallback,
      prepareBetaChannelForCurrentDevice,
      suspendSessionRecoveryForLogin,
      updateLoginState,
    ],
  );

  const syncSavedAccounts = useCallback(async (): Promise<void> => {
    const generation = authGenerationRef.current;
    setAccountsLoading(true);
    setAccountsError(null);
    try {
      const did = deviceIdRef.current ?? (await ensureDeviceId());
      deviceIdRef.current = did;
      try {
        await refresh(did);
      } catch {
        // Keep the cached list on transient refresh failures.
      }
      const vault = await readMobileAccountVault();
      let firstTransientError: string | null = null;
      for (const passport of Object.values(vault.passports)) {
        try {
          await loadMobileEndpointsForRealm(passport.realm);
          const client = authClientFor(did, passport.realm);
          const pair = await refreshMobilePassportSingleFlight(
            client,
            passport.realm,
            passport.passportId,
          );
          if (authGenerationRef.current !== generation) return;
          const memberships = await client.getAccountMemberships(
            pair.accountToken,
          );
          if (authGenerationRef.current !== generation) return;
          await replaceMobilePassportSessionIfCurrent({
            realm: passport.realm,
            passportId: passport.passportId,
            expectedAccountRefreshToken: pair.accountRefreshToken,
            accountRefreshToken: pair.accountRefreshToken,
            memberships,
          });
        } catch (error) {
          if (authGenerationRef.current !== generation) return;
          if (!isDefinitivePassportSessionError(error)) {
            firstTransientError ??= authErrorCode(error);
          }
        }
      }
      await refreshSavedAccountsSnapshot();
      setAccountsError(firstTransientError);
    } catch (error) {
      // SecureStore/device-id/vault failures happen outside the per-Passport loop too.
      // Normalize them into the sheet's existing error projection so a fire-and-forget
      // refresh never reaches React Native's global unhandled-rejection handler.
      if (authGenerationRef.current === generation) {
        setAccountsError(authErrorCode(error));
      }
    } finally {
      if (authGenerationRef.current === generation) setAccountsLoading(false);
    }
  }, [refresh, refreshSavedAccountsSnapshot]);

  const switchAccount = useCallback(
    async (accountKey: string): Promise<void> => {
      const generationAtStart = authGenerationRef.current;
      const initialVault = await readMobileAccountVault();
      const runtimeActiveAccountKey = userRef.current
        ? accountVaultKey(activeAuthRealmRef.current, userRef.current.id)
        : null;
      if (runtimeActiveAccountKey === accountKey) return;
      const resource = initialVault.resources[accountKey];
      let metadata = resource?.metadata ?? null;
      let realm = resource?.realm ?? null;
      if (!metadata || !realm) {
        for (const passport of Object.values(initialVault.passports)) {
          const candidate = passport.memberships.find(
            (membership) =>
              accountVaultKey(passport.realm, membership.membershipId) === accountKey,
          );
          if (!candidate) continue;
          metadata = candidate;
          realm = passport.realm;
          break;
        }
      }
      if (!metadata || !realm) throw authCodeError('SAVED_ACCOUNT_NOT_FOUND');

      setAccountsLoading(true);
      setAccountsError(null);
      try {
        const did = deviceIdRef.current ?? (await ensureDeviceId());
        deviceIdRef.current = did;
        await loadMobileEndpointsForRealm(realm);
        const client = authClientFor(did, realm);
        let pair: Awaited<ReturnType<CindyAuthClient['refresh']>> | null = null;
        let resourcePairStored = false;
        if (resource) {
          try {
            const refreshed = await client.refresh(resource.refreshToken);
            if (refreshed.membership.id !== metadata.membershipId) {
              throw authCodeError('SAVED_ACCOUNT_MISMATCH');
            }
            const replacement = await replaceMobileResourceSessionIfCurrent({
              accountKey,
              expectedRefreshToken: resource.refreshToken,
              pair: refreshed,
              realm,
              passportId: metadata.passportId,
              validateBeforeWrite: () => {
                if (authGenerationRef.current !== generationAtStart) {
                  throw authCodeError('AUTH_FLOW_SUPERSEDED');
                }
              },
            });
            if (replacement !== 'stored') {
              throw authCodeError('AUTH_FLOW_SUPERSEDED');
            }
            pair = refreshed;
            resourcePairStored = true;
          } catch (error) {
            if (
              !isDefinitiveSavedSessionError(error) ||
              !(error instanceof AuthApiError)
            ) {
              throw error;
            }
            // A device mismatch does not prove that the token is invalid for
            // the device which owns the encrypted vault.
            if (error.code === 'DEVICE_MISMATCH') throw error;
            const removal = await removeMobileResourceSessionIfCurrent({
              accountKey,
              expectedRefreshToken: resource.refreshToken,
              validateBeforeWrite: () => {
                if (authGenerationRef.current !== generationAtStart) {
                  throw authCodeError('AUTH_FLOW_SUPERSEDED');
                }
              },
            });
            if (removal === 'stale') {
              throw authCodeError('AUTH_FLOW_SUPERSEDED');
            }
          }
        }

        if (!pair) {
          const passport = initialVault.passports[
            passportVaultKey(realm, metadata.passportId)
          ];
          if (!passport) throw authCodeError('SAVED_ACCOUNT_REAUTH_REQUIRED');
          const accountPair = await refreshMobilePassportSingleFlight(
            client,
            realm,
            metadata.passportId,
          );
          if (authGenerationRef.current !== generationAtStart) {
            throw authCodeError('AUTH_FLOW_SUPERSEDED');
          }
          const memberships = await client.getAccountMemberships(
            accountPair.accountToken,
          );
          if (authGenerationRef.current !== generationAtStart) {
            throw authCodeError('AUTH_FLOW_SUPERSEDED');
          }
          const metadataStored = await replaceMobilePassportSessionIfCurrent({
            realm,
            passportId: metadata.passportId,
            expectedAccountRefreshToken: accountPair.accountRefreshToken,
            accountRefreshToken: accountPair.accountRefreshToken,
            memberships,
          });
          if (!metadataStored) throw authCodeError('AUTH_FLOW_SUPERSEDED');
          const selected = memberships.find(
            (membership) => membership.id === metadata.membershipId,
          );
          if (!selected) throw authCodeError('MEMBERSHIP_DISABLED');
          pair = await client.exchangeAccountMembership(
            accountPair.accountToken,
            selected.id,
          );
        }

        if (pair.membership.id !== metadata.membershipId) {
          throw authCodeError('SAVED_ACCOUNT_MISMATCH');
        }
        if (authGenerationRef.current !== generationAtStart) {
          throw authCodeError('AUTH_FLOW_SUPERSEDED');
        }
        if (!resourcePairStored) {
          await rememberMobileResourceSession(
            pair,
            realm,
            metadata.passportId,
            false,
            () => {
              if (authGenerationRef.current !== generationAtStart) {
                throw authCodeError('AUTH_FLOW_SUPERSEDED');
              }
            },
          );
        }
        if (
          pair.membership.kind === 'personal' &&
          realm !== BUILD_AUTH_REGION
        ) {
          throw authCodeError('REGION_MISMATCH');
        }

        const generation = ++authGenerationRef.current;
        refreshInFlightRef.current = null;
        const previousRealm = activeAuthRealmRef.current;
        let runtimeCleanupStarted = false;
        try {
          await serializeRefreshTokenMutation(async () => {
            if (authGenerationRef.current !== generation) {
              throw authCodeError('AUTH_FLOW_SUPERSEDED');
            }
            // Capture the latest durable session only after entering the same
            // queue used by refresh rotation. A switch that started from T0
            // must roll back to a concurrently persisted T1, never its stale
            // initial vault snapshot.
            const previousSessionRaw = await getSecureItem(AUTH_SESSION_KEY);
            try {
              await commitMobileSavedAccountActivation(
                accountKey,
                async () => {
                  await writePersistedAuthSession(pair!.refreshToken, realm!);
                  if (authGenerationRef.current !== generation) {
                    throw authCodeError('AUTH_FLOW_SUPERSEDED');
                  }
                  runtimeCleanupStarted = true;
                  await clearAccountScopedRuntimeForSwitch();
                  if (authGenerationRef.current !== generation) {
                    throw authCodeError('AUTH_FLOW_SUPERSEDED');
                  }

                  await commitWithClearedAccountDeletionReceipt(() => {
                    if (authGenerationRef.current !== generation) {
                      throw authCodeError('AUTH_FLOW_SUPERSEDED');
                    }
                    pendingAccountDeletionRestoredRef.current = false;
                    setAccountDeletionRestored(false);

                    // Publish the new owner synchronously while the vault and
                    // receipt transactions are both still owned.
                    activateMobileSessionRealm(realm!);
                    activeAuthRealmRef.current = realm!;
                    pendingAuthRealmRef.current = null;
                    setToken(pair!.accessToken);
                    applyUser(
                      mergeMembershipWithExisting(
                        pair!.membership,
                        null,
                        metadata.passportId,
                      ),
                    );
                    sessionRecoverySuspendedRef.current = false;
                    updateLoginState(null);
                    setAccountGeneration((value) => value + 1);
                  });
                },
              );
            } catch (error) {
              await restorePersistedAuthSessionRaw(previousSessionRaw);
              if (
                runtimeCleanupStarted &&
                authGenerationRef.current === generation
              ) {
                activateMobileSessionRealm(previousRealm);
                setMobileAuthOwner(userRef.current?.id ?? null);
                setAccountGeneration((value) => value + 1);
              }
              throw error;
            }
          });
        } catch (error) {
          setMobileAuthOwner(userRef.current?.id ?? null);
          throw error;
        }

        refreshSavedAccountsSnapshotBestEffort();
        void clearCanaryChannel().catch(() => undefined);
        scheduleCanaryChannelSync(pair.accessToken, generation);
        scheduleXdOrgBetaDefault(pair.accessToken, generation);
        void loadMe(pair.accessToken, did, generation).catch(() => undefined);
      } catch (error) {
        setAccountsError(authErrorCode(error));
        await refreshSavedAccountsSnapshot().catch(() => undefined);
        throw error;
      } finally {
        setAccountsLoading(false);
      }
    },
    [
      applyUser,
      clearAccountScopedRuntimeForSwitch,
      commitWithClearedAccountDeletionReceipt,
      loadMe,
      refreshSavedAccountsSnapshot,
      refreshSavedAccountsSnapshotBestEffort,
      scheduleCanaryChannelSync,
      scheduleXdOrgBetaDefault,
      serializeRefreshTokenMutation,
      setToken,
      updateLoginState,
    ],
  );

  const beginAddAccount = useCallback(async (): Promise<void> => {
    loginFlowEpochRef.current += 1;
    additionalLoginRef.current = true;
    sessionRecoverySuspendedRef.current = false;
    updateLoginState(null);
    setAuthError(null);
    await dispatchLoginAction({ type: 'reset' });
  }, [dispatchLoginAction, updateLoginState]);

  const cancelAddAccount = useCallback(async (): Promise<void> => {
    loginFlowEpochRef.current += 1;
    setIsBusy(false);
    pendingAccountTokenRef.current = null;
    pendingAccountRefreshTokenRef.current = null;
    pendingAccountMembershipsRef.current = [];
    pendingLoginTicketRef.current = null;
    pendingBindTicketRef.current = null;
    pendingSsoVerificationTicketRef.current = null;
    pendingAuthRealmRef.current = null;
    pendingAccountDeletionRestoredRef.current = false;
    additionalLoginRef.current = false;
    sessionRecoverySuspendedRef.current = false;
    await deleteSecureItem(PENDING_OAUTH_KEY).catch(() => undefined);
    activateMobileSessionRealm(activeAuthRealmRef.current);
    setMobileAuthOwner(userRef.current?.id ?? null);
    updateLoginState(null);
    setAuthError(null);
  }, [updateLoginState]);

  const clearLocalSession = useCallback(async (
    options: { persistedAuthAlreadyCleared?: boolean } = {},
  ) => {
    // 任何登录态清除路径(logout / terminateSession / 账号注销 / ACCOUNT_UNAVAILABLE)
    // 都先 best-effort 注销移动推送 token —— 只挂在 logout 会漏掉终止路径,设备会
    // 继续收到旧账号的任务通知。token 此刻可能已失效(账号不可用),失败静默,
    // 残留由 server 侧 APNs 410 回收与换账号重注册的让位逻辑兜底。
    // Invalidate in-flight remote creates before any async logout cleanup begins.
    setMobileAuthOwner(null);
    setAccountGeneration((value) => value + 1);
    // 同步失效认证代次，必须早于第一个 await。否则推送 token 注销的网络等待窗口内，
    // 迟到的 canary / XD beta 探测仍会把旧账号结果写回本地。
    authGenerationRef.current += 1;
    refreshInFlightRef.current = null;
    await unregisterPushTokenBestEffort(
      accessTokenRef.current,
      activeAuthRealmRef.current,
    );
    setToken(null);
    applyUser(null);
    updateLoginState(null);
    setAccountDeletionRestored(false);
    pendingAccountTokenRef.current = null;
    pendingAccountRefreshTokenRef.current = null;
    pendingAccountMembershipsRef.current = [];
    additionalLoginRef.current = false;
    pendingLoginTicketRef.current = null;
    pendingBindTicketRef.current = null;
    pendingSsoVerificationTicketRef.current = null;
    pendingAuthRealmRef.current = null;
    activeAuthRealmRef.current = BUILD_AUTH_REGION;
    resetMobileSessionRealm();
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
    if (!options.persistedAuthAlreadyCleared) {
      await serializeRefreshTokenMutation(() =>
        deleteSecureItem(AUTH_SESSION_KEY).catch(() => undefined),
      );
    }
    await Promise.all([
      serializeUserProfileMutation(() =>
        deleteSecureItem(USER_PROFILE_KEY).catch(() => undefined),
      ),
      deleteSecureItem(LEGACY_REFRESH_TOKEN_KEY).catch(() => undefined),
      deleteSecureItem(LEGACY_RESOURCE_REFRESH_TOKEN_KEY).catch(
        () => undefined,
      ),
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
    // Invalidate refresh/login continuations before the first storage await;
    // the UI remains signed in until the durable credential transaction wins.
    authGenerationRef.current += 1;
    refreshInFlightRef.current = null;
    const token = accessTokenRef.current;
    const did = deviceIdRef.current;
    const realm = activeAuthRealmRef.current;
    const vault = await readMobileAccountVault().catch(() => null);
    // 移动推送 token 的注销收口在 clearLocalSession(覆盖 logout 与全部终止路径)。
    // 普通登出代表放弃尚未确认的 challenge；确认注销走 clearLocalSession 直达，
    // 不调用本函数，因此已确认请求的 receipt 仍会保留供登录页查询。
    await serializeRefreshTokenMutation(() =>
      clearMobileLoginCredentialsForLogout({
        readSessionRaw: () => getSecureItem(AUTH_SESSION_KEY),
        clearSession: () => deleteSecureItem(AUTH_SESSION_KEY),
        restoreSessionRaw: restorePersistedAuthSessionRaw,
        // Keep the receipt behind the same refresh → vault → receipt lock
        // order used by login. The helper restores the compatibility session
        // and vault before releasing either queue if this deletion fails.
        clearReceipt: () => persistAccountDeletionReceipt(null),
      }),
    );
    await clearLocalSession({ persistedAuthAlreadyCleared: true });
    setSavedAccounts([]);
    if (!did) return;
    const revocations: Promise<unknown>[] = [];
    if (token) {
      revocations.push(
        authClientFor(did, realm).logout(token).catch(() => undefined),
      );
    }
    if (vault) {
      for (const resource of Object.values(vault.resources)) {
        revocations.push(
          (async () => {
            await loadMobileEndpointsForRealm(resource.realm);
            const client = authClientFor(did, resource.realm);
            const pair = await client.refresh(resource.refreshToken);
            await client.logout(pair.accessToken);
          })().catch(() => undefined),
        );
      }
      for (const passport of Object.values(vault.passports)) {
        revocations.push(
          (async () => {
            await loadMobileEndpointsForRealm(passport.realm);
            const client = authClientFor(did, passport.realm);
            const pair = await client.refreshAccount(
              passport.accountRefreshToken,
            );
            await client.logoutAccount(pair.accountToken);
          })().catch(() => undefined),
        );
      }
    }
    await Promise.allSettled(revocations);
  }, [
    clearLocalSession,
    persistAccountDeletionReceipt,
    serializeRefreshTokenMutation,
  ]);

  const getAccessToken = useCallback(async () => {
    const cached = accessTokenRef.current;
    if (cached && !isAccessTokenExpiring(cached)) return cached;
    return refresh();
  }, [refresh]);

  /** Keep direct authenticated auth-client calls on the same terminal boundary. */
  const runProtectedAuthRequest = useCallback(
    async <T,>(
      request: () => Promise<T>,
      expectedAuthGeneration: number,
    ): Promise<T> => {
      try {
        return await request();
      } catch (error) {
        if (
          isAccountUnavailableAuthError(error) &&
          authGenerationRef.current === expectedAuthGeneration
        ) {
          await terminateSession('ACCOUNT_UNAVAILABLE');
        }
        throw error;
      }
    },
    [terminateSession],
  );

  const getAccountDeletionAvailability = useCallback(async () => {
    const expectedGeneration = authGenerationRef.current;
    const expectedRealm = activeAuthRealmRef.current;
    const token = await getAccessToken();
    if (!token) throw authCodeError('UNAUTHENTICATED');
    if (authGenerationRef.current !== expectedGeneration) {
      throw authCodeError('AUTH_FLOW_SUPERSEDED');
    }
    const did = deviceIdRef.current ?? (await ensureDeviceId());
    deviceIdRef.current = did;
    if (authGenerationRef.current !== expectedGeneration) {
      throw authCodeError('AUTH_FLOW_SUPERSEDED');
    }
    const availability = await runProtectedAuthRequest(
      () =>
        authClientFor(did, expectedRealm).getAccountDeletionAvailability(
          token,
        ),
      expectedGeneration,
    );
    if (authGenerationRef.current !== expectedGeneration) {
      throw authCodeError('AUTH_FLOW_SUPERSEDED');
    }
    return availability;
  }, [getAccessToken, runProtectedAuthRequest]);

  const requestAccountDeletionChallenge = useCallback(async () => {
    const expectedGeneration = authGenerationRef.current;
    const expectedRealm = activeAuthRealmRef.current;
    const expectedPassportId = userRef.current?.passportId ?? '';
    if (!expectedPassportId) throw authCodeError('UNAUTHENTICATED');
    const token = await getAccessToken();
    if (!token) throw authCodeError('UNAUTHENTICATED');
    if (authGenerationRef.current !== expectedGeneration) {
      throw authCodeError('AUTH_FLOW_SUPERSEDED');
    }
    const did = deviceIdRef.current ?? (await ensureDeviceId());
    deviceIdRef.current = did;
    if (authGenerationRef.current !== expectedGeneration) {
      throw authCodeError('AUTH_FLOW_SUPERSEDED');
    }
    const challenge = await runProtectedAuthRequest(
      () =>
        authClientFor(did, expectedRealm).requestAccountDeletionChallenge(
          token,
        ),
      expectedGeneration,
    );
    // 先持久化查询凭证，再把 challenge 交给 UI。即使确认成功后的响应丢失，
    // 下一次冷启动仍能查询注销状态。账号切换也使用 refresh-token 队列，
    // 因此 owner 校验与 receipt 写入之间不会插入另一个账号的提交。
    await serializeRefreshTokenMutation(async () => {
      if (
        authGenerationRef.current !== expectedGeneration ||
        activeAuthRealmRef.current !== expectedRealm ||
        userRef.current?.passportId !== expectedPassportId
      ) {
        throw authCodeError('AUTH_FLOW_SUPERSEDED');
      }
      await persistAccountDeletionReceipt(
        challenge.receiptToken,
        expectedRealm,
      );
    });
    return challenge;
  }, [
    getAccessToken,
    persistAccountDeletionReceipt,
    runProtectedAuthRequest,
    serializeRefreshTokenMutation,
  ]);

  const confirmAccountDeletion = useCallback(
    async (input: {
      challengeId: string;
      receiptToken: string;
      code: string;
    }): Promise<AccountDeletionStatus> => {
      const deletionGeneration = authGenerationRef.current;
      const deletedRealm = activeAuthRealmRef.current;
      const deletedPassportId = userRef.current?.passportId ?? '';
      if (!deletedPassportId) throw authCodeError('UNAUTHENTICATED');
      const token = await getAccessToken();
      if (!token) throw authCodeError('UNAUTHENTICATED');
      if (authGenerationRef.current !== deletionGeneration) {
        throw authCodeError('AUTH_FLOW_SUPERSEDED');
      }
      const did = deviceIdRef.current ?? (await ensureDeviceId());
      deviceIdRef.current = did;
      if (authGenerationRef.current !== deletionGeneration) {
        throw authCodeError('AUTH_FLOW_SUPERSEDED');
      }
      const client = authClientFor(did, deletedRealm);
      let status: AccountDeletionStatus;
      try {
        status = await runProtectedAuthRequest(
          () =>
            client.confirmAccountDeletion(token, {
              ...input,
              acknowledged: true,
            }),
          deletionGeneration,
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
      await serializeRefreshTokenMutation(async () => {
        const deletedOwnerIsCurrent =
          activeAuthRealmRef.current === deletedRealm &&
          userRef.current?.passportId === deletedPassportId;
        if (deletedOwnerIsCurrent) {
          // Account switching uses this same queue. Keep it owned through the
          // owner check, vault cleanup and runtime clear so a newly selected
          // account can never be cleared by this older deletion response.
          try {
            await removeMobilePassport(deletedRealm, deletedPassportId);
          } finally {
            await deleteSecureItem(AUTH_SESSION_KEY).catch(() => undefined);
            await clearLocalSession({ persistedAuthAlreadyCleared: true });
          }
          return;
        }
        await removeMobilePassport(deletedRealm, deletedPassportId);
      });
      refreshSavedAccountsSnapshotBestEffort();
      return status;
    },
    [
      clearLocalSession,
      getAccessToken,
      refreshSavedAccountsSnapshotBestEffort,
      runProtectedAuthRequest,
      serializeRefreshTokenMutation,
    ],
  );

  const getAccountDeletionStatus = useCallback(async () => {
    const receiptToken = accountDeletionReceipt;
    const realm = accountDeletionReceiptRealmRef.current;
    if (!receiptToken || !realm) return null;
    const did = deviceIdRef.current ?? (await ensureDeviceId());
    deviceIdRef.current = did;
    await loadMobileEndpointsForRealm(realm);
    return authClientFor(did, realm).getAccountDeletionStatus(receiptToken);
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
      accountGeneration,
      savedAccounts,
      accountsLoading,
      accountsError,
      clearAuthError,
      consumeAccountDeletionRestored,
      dispatchLoginAction,
      captchaChallenge,
      resolveCaptchaChallenge,
      completeOAuthCallback,
      syncSavedAccounts,
      switchAccount,
      beginAddAccount,
      cancelAddAccount,
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
      accountGeneration,
      accountDeletionReceipt,
      accountDeletionRestored,
      accountsError,
      accountsLoading,
      authError,
      captchaChallenge,
      clearAccountDeletionReceipt,
      clearAuthError,
      beginAddAccount,
      cancelAddAccount,
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
      resolveCaptchaChallenge,
      savedAccounts,
      switchAccount,
      syncSavedAccounts,
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

function authClientFor(
  deviceId: string,
  region: AuthRegion = BUILD_AUTH_REGION,
): CindyAuthClient {
  // auth 协议只有 cn/global 两条线；dev 构建语义归 cn 系，实际基址仍来自
  // 已解析的 endpoint manifest。
  // 登录 scenario harness 注入点(仅 client 构造参数;implementation-plan Step 0
  // WHAT4)。guard:__DEV__ + EXPO_PUBLIC_LOGIN_SCENARIO(值域见附录 A);
  // 生产构建由 metro resolveRequest 把 fixtures 整模块替换为空 stub 双保险。
  const scenarioFetch = resolveLoginScenarioFetch({
    devModeActive: __DEV__,
    scenario: process.env.EXPO_PUBLIC_LOGIN_SCENARIO,
    region,
  });
  return new CindyAuthClient({
    baseUrl: getMobileEndpointForRealm(region, 'authApiBaseUrl'),
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

function isDefinitiveSavedSessionError(error: unknown): boolean {
  return (
    error instanceof AuthApiError &&
    (error.statusCode === 401 ||
      [
        'INVALID_REFRESH_TOKEN',
        'REFRESH_TOKEN_EXPIRED',
        'DEVICE_MISMATCH',
        'ACCOUNT_UNAVAILABLE',
        'MEMBERSHIP_DISABLED',
      ].includes(error.code))
  );
}

function isDefinitivePassportSessionError(error: unknown): boolean {
  return (
    error instanceof AuthApiError &&
    (error.statusCode === 401 ||
      [
        'INVALID_REFRESH_TOKEN',
        'REFRESH_TOKEN_EXPIRED',
        'DEVICE_MISMATCH',
        'ACCOUNT_UNAVAILABLE',
      ].includes(error.code)) &&
    error.code !== 'MEMBERSHIP_DISABLED'
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

async function readPersistedAuthSession(): Promise<AuthSessionRecord | null> {
  return readPersistedAuthSessionStrict().catch(() => null);
}

async function readPersistedAuthSessionStrict(): Promise<AuthSessionRecord | null> {
  return parseAuthSessionRecord(await getSecureItem(AUTH_SESSION_KEY));
}

async function writePersistedAuthSession(
  refreshToken: string,
  realm: AuthRegion,
): Promise<void> {
  await setSecureItem(
    AUTH_SESSION_KEY,
    serializeAuthSessionRecord(realm, refreshToken),
  );
}

async function restorePersistedAuthSessionRaw(raw: string | null): Promise<void> {
  if (raw === null) {
    await deleteSecureItem(AUTH_SESSION_KEY);
  } else {
    await setSecureItem(AUTH_SESSION_KEY, raw);
  }
}

function parseCachedMobileUser(value: unknown): MobileUser | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parsed = value as Partial<MobileUser>;
  if (
    typeof parsed.id !== 'string' ||
    typeof parsed.name !== 'string' ||
    (parsed.membershipKind !== 'personal' && parsed.membershipKind !== 'org')
  )
    return null;
  return {
    ...(parsed as MobileUser),
    orgLogoUrl:
      typeof parsed.orgLogoUrl === 'string' ? parsed.orgLogoUrl : null,
  };
}

async function readCachedUserProfile(): Promise<CachedUserProfile | null> {
  try {
    const raw = await getSecureItem(USER_PROFILE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Partial<CachedUserProfileRecord>;
      if (record.version === 1 && typeof record.accountKey === 'string') {
        const user = parseCachedMobileUser(record.user);
        return user ? { accountKey: record.accountKey, user } : null;
      }
    }
    const legacyUser = parseCachedMobileUser(parsed);
    return legacyUser ? { accountKey: null, user: legacyUser } : null;
  } catch {
    return null;
  }
}

async function writeCachedUserProfile(
  user: MobileUser | null,
  accountKey: string | null,
): Promise<void> {
  try {
    if (user && accountKey) {
      const record: CachedUserProfileRecord = { version: 1, accountKey, user };
      await setSecureItem(USER_PROFILE_KEY, JSON.stringify(record));
    } else {
      await deleteSecureItem(USER_PROFILE_KEY);
    }
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
    typeof parsed.label !== 'string' ||
    (parsed.realm !== 'cn' && parsed.realm !== 'global')
  )
    throw authCodeError('INVALID_AUTH_CODE');
  if (Date.now() - parsed.createdAt > PENDING_OAUTH_MAX_AGE_MS) {
    await deleteSecureItem(PENDING_OAUTH_KEY).catch(() => undefined);
    throw authCodeError('INVALID_AUTH_CODE');
  }
  return parsed as PendingOAuth;
}
