/** Env var that enables client mode; the value is the loopback base URL. */
export const HOST_DELEGATION_ENV = 'CINDY_HOST_API';

/**
 * What this desktop process runs, as its `.dev-instances` record states it (`runtime`). `client`
 * exactly when resolveHostDelegation (host-delegation.ts) enables client mode: the variable is set
 * and not blank. A client never assembles its own runtime or opens the profile database; when the
 * client configuration is incomplete, resolveHostDelegation throws while bootstrap-electron loads
 * and the process exits, so no `client` record belongs to a desktop running its own runtime.
 */
export type DesktopRuntimeKind = 'client' | 'embedded';

export function desktopRuntimeKind(env: NodeJS.ProcessEnv): DesktopRuntimeKind {
  return env[HOST_DELEGATION_ENV]?.trim() ? 'client' : 'embedded';
}
