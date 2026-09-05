/**
 * New companions require confirmation. Full access is an explicit user choice
 * through the standard permission chip in the companion's canonical task.
 * Existing profiles retain their stored choice; missing values remain ask.
 */
export type BotPermissionMode = 'ask' | 'trusted';

/** Default for teammates created from now on. */
export const NEW_BOT_DEFAULT_PERMISSIONS: BotPermissionMode = 'ask';

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
