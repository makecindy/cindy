import { resolveNewMakerDefaultTuples } from './newMakerDefaultTuple.js';
import { BOT_MODEL_CHAIN_MAX, type BotModelRoute } from './botModelChain.js';

/** Adapt the client's ordered defaults to Bot routes without another selection policy. */
export function defaultBotModelChain(
  args: Parameters<typeof resolveNewMakerDefaultTuples>[0],
): BotModelRoute[] {
  return resolveNewMakerDefaultTuples(args).slice(0, BOT_MODEL_CHAIN_MAX).map((tuple) => ({
    harness: tuple.vendor === 'cc' ? 'claude' : tuple.vendor,
    providerId: tuple.providerId,
    model: tuple.model,
    effort: tuple.effort ?? '',
    fastMode: false,
  }));
}
