/**
 * The single source of truth for a *newly created* teammate's action permission.
 *
 * Product ruling (Chris, 2026-08-18): "全部权限默认不开（莫名其妙）" — a teammate
 * that has to ask before every step is not a teammate. New teammates are created
 * hands-on ("动手做事" chip on) and the risk is expressed *after the fact* by the
 * ⚠ badge next to the name, not by an up-front gate.
 *
 * Kept in its own leaf module on purpose:
 *  - `botStore.ts` uses it for the create default, and
 *  - `botTemplates.ts` (loaded by plain-Node tooling that cannot resolve the
 *    renderer's bundled assets) uses it for its template capabilities.
 * A shared constant is the only way both layers can state the same default
 * without one of them silently drifting.
 *
 * `normalizeBotPermissions` deliberately keeps `'ask'` as the fallback for an
 * unknown/absent value: that mirrors the main-side projection in
 * `main/localDb/ipc/bots.ts`, so an already-stored profile never gains trust
 * just because the new-teammate default changed.
 */
export type BotPermissionMode = 'ask' | 'trusted';

/** Default for teammates created from now on. */
export const NEW_BOT_DEFAULT_PERMISSIONS: BotPermissionMode = 'trusted';

/** Read an existing profile's permission mode; unknown values stay conservative. */
export function normalizeBotPermissions(value: unknown): BotPermissionMode {
  return value === 'trusted' ? 'trusted' : 'ask';
}

/** Whether a teammate is allowed to act without asking first (drives the ⚠ badge). */
export function isBotTrusted(
  capabilities: { permissions?: unknown } | null | undefined,
): boolean {
  return normalizeBotPermissions(capabilities?.permissions) === 'trusted';
}
