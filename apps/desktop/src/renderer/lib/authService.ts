import type { AuthFlowState } from '@cindy/auth-client';
import type {
  DesktopAccountDeletionAvailabilityResult,
  DesktopAccountDeletionChallenge,
  DesktopAccountDeletionChallengeResult,
  DesktopAccountDeletionConfirmInput,
  DesktopAccountDeletionConfirmResult,
  DesktopAccountDeletionStatusResult,
  DesktopLoginAction,
  DesktopLoginActionResult,
} from '../../shared/authIpc';
import type { Effort } from '@/lib/userPreferences.types';

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
  canEnterApp: boolean;
  isAuthenticated: boolean;
  isCanary: boolean;
  deviceId: string;
  hasAccountDeletionReceipt: boolean;
  accountDeletionRestored: boolean;
}

export interface AuthService {
  initialize(): Promise<AuthState>;
  getLoginState(): Promise<DesktopLoginActionResult>;
  dispatchLoginAction(action: DesktopLoginAction): Promise<DesktopLoginActionResult>;
  logout(): Promise<void>;
  enterLocalMode(): Promise<AuthState>;
  exitLocalMode(): Promise<AuthState>;
  getAccountDeletionAvailability(): Promise<DesktopAccountDeletionAvailabilityResult>;
  requestAccountDeletionChallenge(): Promise<DesktopAccountDeletionChallengeResult>;
  confirmAccountDeletion(input: DesktopAccountDeletionConfirmInput): Promise<DesktopAccountDeletionConfirmResult>;
  getAccountDeletionStatus(): Promise<DesktopAccountDeletionStatusResult>;
  clearAccountDeletionReceipt(): Promise<void>;
  consumeAccountDeletionRestoredNotice(): Promise<boolean>;
  onAuthStateChange(callback: (state: AuthState) => void): () => void;
  dispose(): void;
}

/** Thin IPC wrapper. Tokens and transient login tickets never enter the renderer. */
export function createAuthService(): AuthService {
  const listeners = new Set<(state: AuthState) => void>();
  const unsubscribeIpc = window.electronAPI.onAuthStateChange((rawState) => {
    const normalized: AuthState = {
      user: rawState.user as User | null,
      mode: rawState.mode,
      dataOwnerId: rawState.dataOwnerId,
      ownerGeneration: rawState.ownerGeneration,
      canEnterApp: rawState.canEnterApp,
      isAuthenticated: rawState.isAuthenticated,
      isCanary: rawState.isCanary === true,
      deviceId: rawState.deviceId,
      hasAccountDeletionReceipt: rawState.hasAccountDeletionReceipt === true,
      accountDeletionRestored: rawState.accountDeletionRestored === true,
    };
    listeners.forEach((listener) => listener(normalized));
  });

  return {
    async initialize(): Promise<AuthState> {
      const raw = await window.electronAPI.authInitialize();
      return {
        user: raw.user as User | null,
        mode: raw.mode,
        dataOwnerId: raw.dataOwnerId,
        ownerGeneration: raw.ownerGeneration,
        canEnterApp: raw.canEnterApp,
        isAuthenticated: raw.isAuthenticated,
        isCanary: raw.isCanary === true,
        deviceId: raw.deviceId,
        hasAccountDeletionReceipt: raw.hasAccountDeletionReceipt === true,
        accountDeletionRestored: raw.accountDeletionRestored === true,
      };
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

    onAuthStateChange(callback: (state: AuthState) => void): () => void {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },

    dispose(): void {
      unsubscribeIpc();
      listeners.clear();
    },
  };
}

export type {
  AuthFlowState,
  DesktopAccountDeletionChallenge,
  DesktopLoginAction,
  DesktopLoginActionResult,
};
