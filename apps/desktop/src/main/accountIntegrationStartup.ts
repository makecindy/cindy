import type { Logger } from './logger';

export interface AccountIntegrationStartupDeps {
  isOwnerCurrent(ownerId: string): boolean;
  startHookControlAccount(): void;
  startImConnection(): void;
  log: Pick<Logger, 'warn'>;
}

/**
 * Start every account-scoped ingress after the current owner's DbClient is
 * ready. Each integration is optional and isolated: one damaged configuration
 * must not prevent the other transport, or the rest of DB-ready startup, from
 * becoming available.
 */
export function startAccountIntegrationsAfterOwnerDbReady(
  ownerId: string,
  deps: AccountIntegrationStartupDeps,
): boolean {
  // onReady performs other asynchronous account initialization before it
  // reaches this point. Logout or account replacement can finish while one of
  // those awaits is pending, so reject the stale callback immediately before
  // it can bring an old owner's transports back online.
  if (!deps.isOwnerCurrent(ownerId)) return false;

  const integrations = [
    ['hook-control', deps.startHookControlAccount],
    ['feishu-im', deps.startImConnection],
  ] as const;

  for (const [name, start] of integrations) {
    try {
      start();
    } catch (err) {
      deps.log.warn(`${name} activation after owner DB ready failed (non-fatal)`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return true;
}
