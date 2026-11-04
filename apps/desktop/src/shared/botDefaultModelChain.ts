import { resolveNewMakerDefaultTuple } from './newMakerDefaultTuple.js';
import type { BotModelRoute } from './botModelChain.js';

/** Use the product recommendation, independently of the new-task composer.
 * Explicit global/per-teammate choices are resolved by the caller. Never add
 * automatic fallback candidates to an uncustomized teammate default.
 */
export function defaultBotModelChain(
  args: Parameters<typeof resolveNewMakerDefaultTuple>[0],
): BotModelRoute[] {
  const primary = resolveNewMakerDefaultTuple(args);
  return primary && primary.vendor !== 'zcode' ? [{
    harness: primary.vendor === 'cc' ? 'claude' : primary.vendor,
    providerId: primary.providerId,
    model: primary.model,
    effort: primary.effort ?? '',
    fastMode: false,
  }] : [];
}
