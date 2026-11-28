import { ServerApiError } from "../serverApiClient.js";
import type { AuthRecoveryRequest } from "./auth-recovery.js";

export interface InstanceLoginRecoveryDependencies {
  /** The runtime durably holds this request's credential and is authenticated with it. */
  loginRecovered(requestId: string, refreshToken: string): boolean;
  recoverLogin(input: AuthRecoveryRequest, registrationLost: boolean): Promise<void>;
  /** Device Link removed this device (4410) and it has not registered again yet. */
  registrationLost(): boolean;
  /** Ask Device Link to take this removed device back and reconnect (device-link rejoinThisDevice). */
  rejoin(): Promise<unknown>;
  /** Reconnect only; Device Link without /rejoin accepts the explicit login's own access token. */
  reconnect(): void;
  warn(code: string): void;
}

function failureCode(error: unknown): string {
  if (error instanceof ServerApiError) return `HTTP_${error.statusCode}`;
  return error instanceof Error && /^[A-Z_]{3,64}$/.test(error.message) ? error.message : "UNKNOWN";
}

/**
 * Handlers for the Pod-local CIS login control. The owner's explicit login through CIS is their
 * decision to take a removed device back, so recovery is not applied until this device is
 * registered again: CIS keeps delivering the same login, and each later delivery only retries the
 * rejoin, never spending the grant a second time.
 */
export function instanceLoginRecoveryHandlers(dependencies: InstanceLoginRecoveryDependencies) {
  const rejoin = async () => {
    try {
      await dependencies.rejoin();
    } catch (error) {
      dependencies.warn(failureCode(error));
      dependencies.reconnect();
    }
  };
  return {
    async recover(input: AuthRecoveryRequest): Promise<void> {
      const registrationLost = dependencies.registrationLost();
      if (!dependencies.loginRecovered(input.requestId, input.refreshToken))
        await dependencies.recoverLogin(input, registrationLost);
      if (registrationLost) await rejoin();
    },
    recovered(input: AuthRecoveryRequest): boolean {
      return dependencies.loginRecovered(input.requestId, input.refreshToken) && !dependencies.registrationLost();
    },
  };
}
