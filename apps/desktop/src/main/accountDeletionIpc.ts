/**
 * accountDeletionIpc.ts — desktop account-deletion IPC business handlers.
 *
 * Electron registration is only an adapter. This module validates untrusted
 * confirmation input, preserves auth-server error codes for localized UI, and
 * guarantees that a confirmed deletion tears down the account boundary before
 * clearing the initiating desktop's local session.
 */

import {
  AuthApiError,
  type AccountDeletionAvailability,
  type AccountDeletionStatus,
} from '@cindy/auth-client';

import {
  parseDesktopAccountDeletionConfirmInput,
  type DesktopAccountDeletionAvailabilityResult,
  type DesktopAccountDeletionChallenge,
  type DesktopAccountDeletionChallengeResult,
  type DesktopAccountDeletionConfirmResult,
  type DesktopAccountDeletionStatusResult,
} from '../shared/authIpc';

/** Injected account lifecycle operations owned by authManager/bootstrap. */
export interface AccountDeletionIpcDeps {
  getAvailability(): Promise<AccountDeletionAvailability>;
  requestChallenge(): Promise<DesktopAccountDeletionChallenge>;
  confirm(input: { challengeId: string; code: string }): Promise<AccountDeletionStatus>;
  getStatus(): Promise<AccountDeletionStatus | null>;
  clearReceipt(): void;
  consumeRestoredNotice(): boolean;
  isConfirmedLocalSessionCurrent(): boolean;
  beginAccountBoundary(): () => void;
  teardownAccountBoundary(): Promise<void>;
  clearLocalSession(): boolean;
  logWarn(message: string, error?: unknown): void;
}

/** Handler surface registered one-for-one on auth:account-deletion:* channels. */
export interface AccountDeletionIpcHandlers {
  getAvailability(): Promise<DesktopAccountDeletionAvailabilityResult>;
  requestChallenge(): Promise<DesktopAccountDeletionChallengeResult>;
  confirm(rawInput: unknown): Promise<DesktopAccountDeletionConfirmResult>;
  getStatus(): Promise<DesktopAccountDeletionStatusResult>;
  clearReceipt(): void;
  consumeRestoredNotice(): boolean;
}

function failureCode(error: unknown): string {
  return error instanceof AuthApiError ? error.code : 'AUTH_REQUEST_FAILED';
}

/**
 * Build dependency-injected handlers so lifecycle ordering can be tested
 * without starting Electron or opening a real account database.
 */
export function createAccountDeletionIpcHandlers(
  deps: AccountDeletionIpcDeps,
): AccountDeletionIpcHandlers {
  let challengeInFlight: Promise<DesktopAccountDeletionChallengeResult> | null = null;
  let confirmInFlight: Promise<DesktopAccountDeletionConfirmResult> | null = null;

  return {
    async getAvailability() {
      try {
        return { success: true, value: await deps.getAvailability() };
      } catch (error) {
        return { success: false, code: failureCode(error) };
      }
    },

    async requestChallenge() {
      if (challengeInFlight) return challengeInFlight;
      const operation = (async (): Promise<DesktopAccountDeletionChallengeResult> => {
        try {
          return { success: true, value: await deps.requestChallenge() };
        } catch (error) {
          return { success: false, code: failureCode(error) };
        }
      })();
      challengeInFlight = operation;
      try {
        return await operation;
      } finally {
        if (challengeInFlight === operation) challengeInFlight = null;
      }
    },

    async confirm(rawInput) {
      const input = parseDesktopAccountDeletionConfirmInput(rawInput);
      if (!input) return { success: false, code: 'INVALID_PARAMS' };
      if (confirmInFlight) return confirmInFlight;

      const operation = (async (): Promise<DesktopAccountDeletionConfirmResult> => {
        let status: AccountDeletionStatus;
        try {
          status = await deps.confirm(input);
        } catch (error) {
          return { success: false, code: failureCode(error) };
        }

        // The server has accepted deletion and revoked refresh credentials.
        // A newer login must never be torn down by this late response.
        if (!deps.isConfirmedLocalSessionCurrent()) {
          deps.logWarn(
            'account deletion confirmed after local auth identity changed; skip teardown',
          );
          return { success: true, value: status };
        }

        // Hold the owner boundary across both teardown and the session commit.
        // Otherwise a new owner-bound mutation can start after teardown's
        // waitForIdle and race with clearLocalSession switching the namespace.
        const releaseBoundary = deps.beginAccountBoundary();
        try {
          // Teardown failures are non-fatal here: keeping the initiator logged in
          // would be more misleading and less safe than completing local logout.
          try {
            await deps.teardownAccountBoundary();
          } catch (error) {
            deps.logWarn('account boundary teardown after deletion failed (non-fatal)', error);
          }
          if (!deps.clearLocalSession()) {
            deps.logWarn('local auth identity changed during account deletion teardown; skip clear');
          }
        } finally {
          releaseBoundary();
        }
        return { success: true, value: status };
      })();

      confirmInFlight = operation;
      try {
        return await operation;
      } finally {
        if (confirmInFlight === operation) confirmInFlight = null;
      }
    },

    async getStatus() {
      try {
        return { success: true, value: await deps.getStatus() };
      } catch (error) {
        return { success: false, code: failureCode(error) };
      }
    },

    clearReceipt() {
      deps.clearReceipt();
    },

    consumeRestoredNotice() {
      return deps.consumeRestoredNotice();
    },
  };
}
