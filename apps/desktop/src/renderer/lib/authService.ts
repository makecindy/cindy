import type { AuthFlowState } from '@cindy/auth-client';
import type {
  DesktopAccountDeletionAvailabilityResult,
  DesktopAccountDeletionChallenge,
  DesktopAccountDeletionChallengeResult,
  DesktopAccountDeletionConfirmInput,
  DesktopAccountDeletionConfirmResult,
  DesktopAccountDeletionStatusResult,
  DesktopAccountSwitcherSnapshot,
  DesktopLoginAction,
  DesktopLoginActionResult,
} from '../../shared/authIpc';
export type { DesktopSavedAccount } from '../../shared/authIpc';
import type { Effort } from '@/lib/userPreferences.types';
import { createLogger } from '@/lib/logger';

/** Renderer-safe projection of the authenticated auth-server membership. */
// role 已随 /api/user/me、/api/me 退役；isCanary 改由 main 进程从专用
// feature-flags 端点读取，并作为 AuthState 独立字段投影，不进入 renderer User。
export interface User {
  id: string;
  name: string;
  avatar: string | null;
  email: string | null;
  defaultModel: string;
  defaultEffort: Effort;
  membershipKind: 'personal' | 'org';
  membershipRole: 'owner' | 'admin' | 'member';
  orgId: string | null;
  orgName: string | null;
  /** 组织稳定标识(access token orgSlug claim,main 出口解码注入);个人身份或旧 token 为 null。 */
  orgSlug: string | null;
  /** 企业 logo(auth console 组织设置上传);个人身份或未设置为 null。 */
  orgLogoUrl: string | null;
  passportId: string;
}

export interface AuthState {
  user: User | null;
  mode: 'signed-out' | 'local' | 'cloud';
  dataOwnerId: string | null;
  ownerGeneration: number;
  /** Main marks the transient signed-out projection while an owner boundary is pending. */
  ownerBoundaryPending?: boolean;
  canEnterApp: boolean;
  isAuthenticated: boolean;
  isCanary: boolean;
  deviceId: string;
  hasAccountDeletionReceipt: boolean;
  accountDeletionRestored: boolean;
  /** 持久凭证库(safeStorage)连续多个刷新周期不可用(#1687);恢复后自动回 false。 */
  credentialStoreUnavailable: boolean;
}

export type AuthStateSource = 'initialize' | 'push' | 'snapshot';

export interface AuthStateObserver {
  getSnapshot(): AuthState | null;
  onAuthStateChange(callback: (state: AuthState, source: AuthStateSource) => void): () => void;
}

export interface AuthService extends AuthStateObserver {
  initialize(): Promise<AuthState>;
  getLoginState(): Promise<DesktopLoginActionResult>;
  dispatchLoginAction(action: DesktopLoginAction): Promise<DesktopLoginActionResult>;
  logout(): Promise<void>;
  listAccounts(): Promise<DesktopAccountSwitcherSnapshot>;
  syncAccounts(): Promise<DesktopAccountSwitcherSnapshot>;
  switchAccount(accountKey: string): Promise<void>;
  beginAddAccount(): Promise<DesktopLoginActionResult>;
  cancelAddAccount(): Promise<void>;
  enterLocalMode(): Promise<AuthState>;
  exitLocalMode(): Promise<AuthState>;
  getAccountDeletionAvailability(): Promise<DesktopAccountDeletionAvailabilityResult>;
  requestAccountDeletionChallenge(): Promise<DesktopAccountDeletionChallengeResult>;
  confirmAccountDeletion(input: DesktopAccountDeletionConfirmInput): Promise<DesktopAccountDeletionConfirmResult>;
  getAccountDeletionStatus(): Promise<DesktopAccountDeletionStatusResult>;
  clearAccountDeletionReceipt(): Promise<void>;
  consumeAccountDeletionRestoredNotice(): Promise<boolean>;
  dispose(): void;
}

const log = createLogger('auth-service');
let rendererService: AuthService | null = null;

function normalizeAuthState(raw: Awaited<ReturnType<typeof window.electronAPI.authInitialize>>): AuthState {
  return {
    user: raw.user as User | null,
    mode: raw.mode,
    dataOwnerId: raw.dataOwnerId,
    ownerGeneration: raw.ownerGeneration,
    ownerBoundaryPending: raw.ownerBoundaryPending === true,
    canEnterApp: raw.canEnterApp,
    isAuthenticated: raw.isAuthenticated,
    isCanary: raw.isCanary === true,
    deviceId: raw.deviceId,
    hasAccountDeletionReceipt: raw.hasAccountDeletionReceipt === true,
    accountDeletionRestored: raw.accountDeletionRestored === true,
    credentialStoreUnavailable: raw.credentialStoreUnavailable === true,
  };
}

/** One Main projection per renderer. Components only own their subscriptions. */
export function createAuthService(): AuthService {
  if (rendererService) return rendererService;
  const listeners = new Set<(state: AuthState, source: AuthStateSource) => void>();
  let snapshot: AuthState | null = null;
  let initializeTask: Promise<AuthState> | null = null;
  let version = 0;
  let disposed = false;
  const accept = (raw: Parameters<typeof normalizeAuthState>[0], source: 'push' | 'initialize') => {
    const state = normalizeAuthState(raw);
    if (disposed) return state;
    snapshot = state;
    version += 1;
    log.info('accepted auth state', {
      source,
      mode: state.mode,
      pending: state.ownerBoundaryPending,
      generation: state.ownerGeneration,
    });
    listeners.forEach((listener) => listener(state, source));
    return state;
  };
  const unsubscribeIpc = window.electronAPI.onAuthStateChange((rawState) => {
    accept(rawState, 'push');
  });

  rendererService = {
    initialize(): Promise<AuthState> {
      if (!initializeTask) {
        const startVersion = version;
        const startedAt = performance.now();
        log.info('initialize requested');
        initializeTask = (async () => {
          const raw = await window.electronAPI.authInitialize();
          if (version !== startVersion && snapshot) {
            log.info('discarded stale initialize response');
            return snapshot;
          }
          log.info('initialize returned', { elapsedMs: Math.round(performance.now() - startedAt) });
          return accept(raw, 'initialize');
        })();
      }
      // Remounts read the current projection, including recovery after an earlier failure.
      return initializeTask.then(
        (state) => snapshot ?? state,
        (error: unknown) => {
          if (snapshot) return snapshot;
          throw error;
        },
      );
    },

    getSnapshot() {
      return snapshot;
    },

    getLoginState(): Promise<DesktopLoginActionResult> {
      return window.electronAPI.authGetLoginState();
    },

    dispatchLoginAction(action: DesktopLoginAction): Promise<DesktopLoginActionResult> {
      return window.electronAPI.authDispatchLoginAction(action);
    },

    async logout(): Promise<void> {
      await window.electronAPI.authLogout();
    },

    listAccounts() {
      return window.electronAPI.authListAccounts();
    },

    syncAccounts() {
      return window.electronAPI.authSyncAccounts();
    },

    switchAccount(accountKey) {
      return window.electronAPI.authSwitchAccount(accountKey);
    },

    beginAddAccount() {
      return window.electronAPI.authBeginAddAccount();
    },

    cancelAddAccount() {
      return window.electronAPI.authCancelAddAccount();
    },

    async enterLocalMode(): Promise<AuthState> {
      return window.electronAPI.authEnterLocal() as Promise<AuthState>;
    },

    async exitLocalMode(): Promise<AuthState> {
      return window.electronAPI.authExitLocal() as Promise<AuthState>;
    },

    getAccountDeletionAvailability() {
      return window.electronAPI.authGetAccountDeletionAvailability();
    },
    requestAccountDeletionChallenge() {
      return window.electronAPI.authRequestAccountDeletionChallenge();
    },
    confirmAccountDeletion(input) {
      return window.electronAPI.authConfirmAccountDeletion(input);
    },
    getAccountDeletionStatus() {
      return window.electronAPI.authGetAccountDeletionStatus();
    },
    clearAccountDeletionReceipt() {
      return window.electronAPI.authClearAccountDeletionReceipt();
    },
    consumeAccountDeletionRestoredNotice() {
      return window.electronAPI.authConsumeAccountDeletionRestoredNotice();
    },

    onAuthStateChange(callback: (state: AuthState, source: AuthStateSource) => void): () => void {
      listeners.add(callback);
      if (snapshot) callback(snapshot, 'snapshot');
      return () => listeners.delete(callback);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribeIpc();
      listeners.clear();
      rendererService = null;
    },
  };
  return rendererService;
}

export type {
  AuthFlowState,
  DesktopAccountDeletionChallenge,
  DesktopAccountSwitcherSnapshot,
  DesktopLoginAction,
  DesktopLoginActionResult,
};
