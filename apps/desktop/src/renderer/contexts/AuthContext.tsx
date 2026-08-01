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
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { clearWorkersCache } from '@/features/cc-agent/hooks/useWorkers';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import {
  createAuthService,
  type AuthService,
  type AuthState,
  type AuthFlowState,
  type DesktopLoginAction,
  type DesktopLoginActionResult,
  type User,
} from '@/lib/authService';
import { setCurrentUserName } from '@/lib/makerChatStore';
import { isSecondaryWindow } from '@/lib/secondaryWindow';
import { setUserPromptOwner } from '@/lib/userPromptStore';
import { bootstrapMemorySettingsFromMain, setMemorySettingsOwner } from '@/lib/memorySettingsStore';
import { sessionsStore } from '@/lib/sessionsStore';
import { isSidebarWindow } from '@/lib/sidebarWindow';
import { isGhostPanelWindow } from '@/lib/ghostPanelWindow';
import { setNewMakerDraftOwner } from '@/state/newMakerDraft';
import { setComposerDraftOwner } from '@/lib/composerDraftStore';
import { setPendingHandoffOwner } from '@/state/pendingFirstMessage';
import { setDataOwnerGeneration } from './dataOwnerGeneration';

/**
 * 登录态上下文：user / isAuthenticated / isCanary / deviceId 全部来自 main 的
 * authManager 推送（auth:state-change）与 initialize() 返回值。
 *
 * 注意：本项目的 `AuthProvider` 在 `App.tsx` 中位于 `RouterProvider` **之外**，
 * 因此此处不能用 `useNavigate()`——需要路由分发的逻辑（localDb 就绪门）下沉到
 * 路由层的 `<LocalDbGate />` 包装组件。
 */
export interface AuthContextValue {
  user: User | null;
  mode: 'signed-out' | 'local' | 'cloud';
  dataOwnerId: string | null;
  canEnterApp: boolean;
  isAuthenticated: boolean;
  /** 当前账号是否加入 Canary 发布通道。 */
  isCanary: boolean;
  isInitializing: boolean;
  /** SkillHub 跨设备识别：本机 deviceId（machineIdSync），登录前后都有值；初始化前为 null */
  deviceId: string | null;
  /** Renderer-safe login screen state; auth tickets remain in main. */
  loginState: AuthFlowState | null;
  loadLoginState: () => Promise<DesktopLoginActionResult>;
  dispatchLoginAction: (action: DesktopLoginAction) => Promise<DesktopLoginActionResult>;
  logout: () => Promise<void>;
  enterLocalMode: () => Promise<void>;
  exitLocalMode: () => Promise<void>;
  hasAccountDeletionReceipt: boolean;
  accountDeletionRestored: boolean;
  getAccountDeletionAvailability: ReturnType<typeof createAuthService>['getAccountDeletionAvailability'];
  requestAccountDeletionChallenge: ReturnType<typeof createAuthService>['requestAccountDeletionChallenge'];
  confirmAccountDeletion: ReturnType<typeof createAuthService>['confirmAccountDeletion'];
  getAccountDeletionStatus: ReturnType<typeof createAuthService>['getAccountDeletionStatus'];
  clearAccountDeletionReceipt: ReturnType<typeof createAuthService>['clearAccountDeletionReceipt'];
  consumeAccountDeletionRestoredNotice: ReturnType<typeof createAuthService>['consumeAccountDeletionRestoredNotice'];
}

const AuthContext = createContext<AuthContextValue | null>(null);

const log = createLogger('AuthContext');

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [mode, setMode] = useState<'signed-out' | 'local' | 'cloud'>('signed-out');
  const [dataOwnerId, setDataOwnerId] = useState<string | null>(null);
  const [canEnterApp, setCanEnterApp] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isCanary, setIsCanary] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [hasAccountDeletionReceipt, setHasAccountDeletionReceipt] = useState(false);
  const [accountDeletionRestored, setAccountDeletionRestored] = useState(false);
  const [loginState, setLoginState] = useState<AuthFlowState | null>(null);
  const { confirm } = useConfirmDialog();
  const { t } = useTranslation();

  const authServiceRef = useRef<AuthService | null>(null);
  if (authServiceRef.current === null) {
    authServiceRef.current = createAuthService();
  }

  const activeUserIdRef = useRef<string | null>(null);
  const activeDataOwnerIdRef = useRef<string | null>(null);
  const authStateVersionRef = useRef(0);

  /**
   * 身份即 auth-server membership(产品 role 水合已随 /api/me 退役,2026-07)。
   * 这里只负责账号切换时清 renderer 会话快照,防旧账号的在途响应/挂载态泄漏。
   */
  const applyIncomingUser = useCallback((incoming: User) => {
    if (activeUserIdRef.current !== incoming.id) {
      sessionsStore.reset();
    }
    activeUserIdRef.current = incoming.id;
    setUser(incoming);
  }, []);

  const applyIncomingState = useCallback(
    (state: AuthState) => {
      const ownerChanged = activeDataOwnerIdRef.current !== state.dataOwnerId;
      setDataOwnerGeneration(state.dataOwnerId);
      if (ownerChanged) {
        sessionsStore.reset();
        clearWorkersCache();
      }
      activeDataOwnerIdRef.current = state.dataOwnerId;
      setNewMakerDraftOwner(state.dataOwnerId);
      setComposerDraftOwner(state.dataOwnerId);
      setPendingHandoffOwner(state.dataOwnerId);
      setUserPromptOwner(state.dataOwnerId);
      if (ownerChanged) {
        setMemorySettingsOwner(state.dataOwnerId);
        void bootstrapMemorySettingsFromMain();
      }
      setMode(state.mode);
      setDataOwnerId(state.dataOwnerId);
      setCanEnterApp(state.canEnterApp);
      setIsAuthenticated(state.isAuthenticated);
      setIsCanary(state.isCanary);
      setDeviceId(state.deviceId);
      setHasAccountDeletionReceipt(state.hasAccountDeletionReceipt);
      setAccountDeletionRestored(state.accountDeletionRestored);
      if (state.user) {
        setLoginState(null);
        if (ownerChanged) {
          activeUserIdRef.current = state.user.id;
          setUser(state.user);
        } else {
          applyIncomingUser(state.user);
        }
      } else {
        activeUserIdRef.current = null;
        setUser(null);
        // Both signed-out and local sessions have no Cindy user. Clear any
        // in-progress SSO/OTP step so returning to /login always starts fresh.
        setLoginState(null);
      }
    },
    [applyIncomingUser],
  );
  useEffect(() => {
    const service = authServiceRef.current!;
    const initializeVersion = authStateVersionRef.current;

    const unsubscribe = service.onAuthStateChange((state: AuthState) => {
      authStateVersionRef.current += 1;
      applyIncomingState(state);
      setHasAccountDeletionReceipt(state.hasAccountDeletionReceipt);
      setAccountDeletionRestored(state.accountDeletionRestored);
    });

    void service
      .initialize()
      .then(async (state) => {
        // A pushed auth event is newer than this initialize response.
        if (authStateVersionRef.current !== initializeVersion) return;
        applyIncomingState(state);
        setHasAccountDeletionReceipt(state.hasAccountDeletionReceipt);
        setAccountDeletionRestored(state.accountDeletionRestored);
      })
      .catch((error: unknown) => {
        // 初始化异常归一未登录(implementation-plan Step 3b v6.3):此前该链仅
        // then/finally,真实 reject 会产生 unhandled rejection 且 auth 快照悬空。
        // 统一 logger 记录 + 清为 unauthenticated snapshot,不新增视觉分支
        // (handoff 走正常 unauthenticated 冷启动)。
        log.error('auth initialize failed, fall back to unauthenticated', error);
        // 推送事件比本次 initialize 响应新时不覆盖(与 then 分支同守卫)。
        if (authStateVersionRef.current !== initializeVersion) return;
        setIsAuthenticated(false);
        setIsCanary(false);
        setCanEnterApp(false);
        setMode('signed-out');
        setDataOwnerId(null);
        setDataOwnerGeneration(null);
        activeDataOwnerIdRef.current = null;
        activeUserIdRef.current = null;
        setLoginState(null);
        clearWorkersCache();
        setUser(null);
      })
      .finally(() => setIsInitializing(false));

    return () => {
      unsubscribe();
      service.dispose();
    };
  }, [applyIncomingState]);

  useEffect(() => {
    if (!isAuthenticated || !accountDeletionRestored) return;
    setAccountDeletionRestored(false);
    if (isSecondaryWindow() || isSidebarWindow() || isGhostPanelWindow()) return;
    let disposed = false;
    void authServiceRef
      .current!.consumeAccountDeletionRestoredNotice()
      .then((shouldShow) => {
        if (!disposed && shouldShow) {
          toast.success(t('accountDeletion.restoredNotice'), { duration: 5000 });
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [accountDeletionRestored, isAuthenticated, t]);

  useEffect(() => {
    let handling = false;
    return window.electronAPI.onAuthSessionExpired((payload) => {
      if (handling) return;
      handling = true;
      // Invalidate in-flight remote sends before the confirmation dialog resolves.
      setDataOwnerGeneration(null);
      // main 只给客户端内部分类(不透传服务端原文),按 reason 选本地化文案,
      // 让用户区分「被顶下线 / 凭证被外部实例清除 / 自然过期 / 账号不可用」。
      const descriptionKey =
        payload.reason && payload.reason !== 'unknown' && payload.reason !== 'expired'
          ? `logic.confirm.sessionExpiredReason.${payload.reason}`
          : 'logic.confirm.sessionExpiredDescription';
      void confirm({
        title: t('logic.confirm.sessionExpiredTitle'),
        description: payload.message || t(descriptionKey),
        confirmText: t('logic.confirm.sessionExpiredConfirm'),
        showCancel: false,
      }).then(() => {
        activeUserIdRef.current = null;
        sessionsStore.reset();
        clearWorkersCache();
        setUser(null);
        setMode('signed-out');
        setDataOwnerId(null);
        activeDataOwnerIdRef.current = null;
        setCanEnterApp(false);
        setIsAuthenticated(false);
        setIsCanary(false);
        setLoginState(null);
        handling = false;
      });
    });
  }, [confirm, t]);

  const loadLoginState = useCallback(async (): Promise<DesktopLoginActionResult> => {
    const result = await authServiceRef.current!.getLoginState();
    setLoginState(result.state);
    return result;
  }, []);

  const dispatchLoginAction = useCallback(
    async (action: DesktopLoginAction): Promise<DesktopLoginActionResult> => {
      // Main keeps the browser request open until its loopback callback arrives,
      // so project the waiting screen immediately to expose the cancel action.
      if (action.type === 'start-browser') {
        setLoginState({ step: 'browser-redirect', label: action.label });
      }
      const result = await authServiceRef.current!.dispatchLoginAction(action);
      setLoginState(result.state);
      return result;
    },
    [],
  );

  const logout = useCallback(async () => {
    setDataOwnerGeneration(null);
    await authServiceRef.current!.logout();
    sessionsStore.reset();
    clearWorkersCache();
  }, []);

  const enterLocalMode = useCallback(async () => {
    setDataOwnerGeneration(null);
    const state = await authServiceRef.current!.enterLocalMode();
    setDataOwnerGeneration(state.dataOwnerId);
    setComposerDraftOwner(state.dataOwnerId);
    setPendingHandoffOwner(state.dataOwnerId);
    setMode(state.mode);
    setDataOwnerId(state.dataOwnerId);
    setCanEnterApp(state.canEnterApp);
    setIsAuthenticated(state.isAuthenticated);
    setUser(state.user);
  }, []);

  const exitLocalMode = useCallback(async () => {
    setDataOwnerGeneration(null);
    const state = await authServiceRef.current!.exitLocalMode();
    setDataOwnerGeneration(state.dataOwnerId);
    setComposerDraftOwner(state.dataOwnerId);
    setPendingHandoffOwner(state.dataOwnerId);
    setMode(state.mode);
    setDataOwnerId(state.dataOwnerId);
    setCanEnterApp(state.canEnterApp);
    setIsAuthenticated(state.isAuthenticated);
    setUser(state.user);
  }, []);

  const getAccountDeletionAvailability = useCallback(
    () => authServiceRef.current!.getAccountDeletionAvailability(),
    [],
  );

  const requestAccountDeletionChallenge = useCallback(async () => {
    const result = await authServiceRef.current!.requestAccountDeletionChallenge();
    if (result.success) setHasAccountDeletionReceipt(true);
    return result;
  }, []);

  const confirmAccountDeletion = useCallback(
    (input: { challengeId: string; code: string }) =>
      authServiceRef.current!.confirmAccountDeletion(input),
    [],
  );

  const getAccountDeletionStatus = useCallback(
    () => authServiceRef.current!.getAccountDeletionStatus(),
    [],
  );

  const clearAccountDeletionReceipt = useCallback(async () => {
    await authServiceRef.current!.clearAccountDeletionReceipt();
    setHasAccountDeletionReceipt(false);
  }, []);

  const consumeAccountDeletionRestoredNotice = useCallback(
    () => authServiceRef.current!.consumeAccountDeletionRestoredNotice(),
    [],
  );

  // 同步用户名到 makerChatStore 模块级 cache — dispatchToSdk 把它透传给 maker.send
  // 让 turn-start status 文案带 "<userName> Just Wait ..." (登出 / 切账号自动清空)。
  useEffect(() => {
    setCurrentUserName(user?.name);
  }, [user?.name]);

  const value = useMemo(
    () => ({
      user,
      mode,
      dataOwnerId,
      canEnterApp,
      isAuthenticated,
      isCanary,
      isInitializing,
      deviceId,
      loginState,
      loadLoginState,
      dispatchLoginAction,
      logout,
      enterLocalMode,
      exitLocalMode,
      hasAccountDeletionReceipt,
      accountDeletionRestored,
      getAccountDeletionAvailability,
      requestAccountDeletionChallenge,
      confirmAccountDeletion,
      getAccountDeletionStatus,
      clearAccountDeletionReceipt,
      consumeAccountDeletionRestoredNotice,
    }),
    [
      user,
      mode,
      dataOwnerId,
      canEnterApp,
      isAuthenticated,
      isCanary,
      isInitializing,
      deviceId,
      loginState,
      loadLoginState,
      dispatchLoginAction,
      logout,
      enterLocalMode,
      exitLocalMode,
      hasAccountDeletionReceipt,
      accountDeletionRestored,
      getAccountDeletionAvailability,
      requestAccountDeletionChallenge,
      confirmAccountDeletion,
      getAccountDeletionStatus,
      clearAccountDeletionReceipt,
      consumeAccountDeletionRestoredNotice,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
