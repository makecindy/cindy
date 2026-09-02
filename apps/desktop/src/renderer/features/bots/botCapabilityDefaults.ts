/**
 * The single source of truth for a *newly created* teammate's action permission.
 *
 * Product ruling (Chris, 2026-08-18): "全部权限默认不开（莫名其妙）" — a teammate
 * that has to ask before every step is not a teammate. New teammates are created
 * hands-on, and the level stays adjustable from the permission chip in that
 * teammate's own chat — 裁决 2026-08-19:那是它唯一的控制点。
 *
 * 名字旁那颗 ⚠ 徽标(BotTrustedBadge)与判定函数 isBotTrusted() 已于 2026-08-19
 * 删除:侧栏与设置页头部都不再挂它(2026-08-18 裁决),留着就是零引用的幽灵物。
 *
 * Kept in its own leaf module on purpose: `botStore.ts` uses it for the create
 * default, so a shared constant is the only way both call sites can state the
 * same default without one of them silently drifting.
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

/**
 * Was this memory record planted at join time by a machine-generated seed
 * (as opposed to something the user wrote)? Only the AI-draft creation path
 * ever produced these — its numbered `start-<n>` slugs are the sole surviving
 * signature now that both memory-seed producers (the template gallery and the
 * AI-draft flow) are gone. Historical rows from either producer keep reading
 * correctly through this pattern; no new bot can add to the set today.
 */
const GENERATED_SEED_SLUG_PATTERN = /^start-[1-9]\d*$/;

export function isBotSeedMemorySlug(slug: string): boolean {
  return GENERATED_SEED_SLUG_PATTERN.test(slug);
}
