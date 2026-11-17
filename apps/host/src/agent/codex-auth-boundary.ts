import { MAKER_PUSH } from '../../../desktop/src/main/maker-ipc/channels.js';

type CredentialScope = 'instance-isolated' | 'system-shared' | 'unknown';

/**
 * The desktop's three Codex auth-boundary hooks (maker-host/index.ts), step for step:
 * desktopCodexAuthAdapter.setOnLogoutSuccess, setOnLoginSuccess and
 * setOnInvalidatedBroadcast. Their model auto-refresh cooldown and backfill resets have
 * no Host counterpart: the Host refreshes model lists when providers are listed and
 * before each start (release table, section two).
 */
export function createCodexAuthBoundary(ports: {
  /** Retire every local Codex host holding this profile's login (forceDisposeLocalHostForAuthChange). */
  retireLocalHosts(reason: string): Promise<void>;
  clearProxyAuthInjection(): void;
  publishRuntimeRoute(): void | Promise<void>;
  clearBridgeCredentialCache(): void;
  invalidatePiEnvironment(): void;
  publish(channel: string, payload: unknown): void;
  warn(message: string, fields: Record<string, unknown>): void;
}) {
  return {
    /** setOnLogoutSuccess; the desktop's invalidation runs it through logout() as well. */
    async afterLogout(): Promise<void> {
      await ports.retireLocalHosts('Codex auth logout');
      ports.clearProxyAuthInjection();
      await ports.publishRuntimeRoute();
      ports.invalidatePiEnvironment();
    },
    /** setOnLoginSuccess. */
    async afterLogin(): Promise<void> {
      ports.clearBridgeCredentialCache();
      await ports.retireLocalHosts('Codex auth login');
      await ports.publishRuntimeRoute();
      ports.invalidatePiEnvironment();
    },
    /** setOnInvalidatedBroadcast. */
    async afterInvalidation(reason: string, credentialScope: CredentialScope): Promise<void> {
      try {
        await ports.retireLocalHosts(`Codex credential invalidated: ${reason}`);
        ports.clearBridgeCredentialCache();
      } catch (error) {
        // The prompt to sign in again must still reach the agents.
        ports.warn('Codex invalidation catalog cleanup failed', { error: error instanceof Error ? error.message : String(error) });
      }
      ports.publish(MAKER_PUSH.AUTH_STATE_CHANGED, { agentKind: 'codex', authenticated: false, errorReason: reason, credentialScope });
      ports.invalidatePiEnvironment();
    },
  };
}
