import type { BotProfile } from './botStore';

/** Hermes keeps the row pulse intentionally short; durable state lives elsewhere. */
export const BOT_ACTIVE_WINDOW_MS = 90_000;

function finiteTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Recency used for roster ordering. A new profile may lead until another Bot speaks. */
export function botRosterActivityAt(bot: BotProfile): number {
  return Math.max(
    finiteTimestamp(bot.createdAt),
    finiteTimestamp(bot.lastMessageAt),
    ...bot.sessions.map((session) => finiteTimestamp(session.updatedAt)),
  );
}

/**
 * Active-now is deliberately ephemeral: a live turn, a recent canonical message,
 * or a recent Bot worker. Profile creation alone must never pretend the Bot ran.
 */
export function isBotActiveNow(
  bot: BotProfile,
  input: { working: boolean; now?: number },
): boolean {
  if (input.working) return true;
  const now = input.now ?? Date.now();
  const recentActivityAt = Math.max(
    finiteTimestamp(bot.lastMessageAt),
    ...bot.sessions
      .filter((session) => session.kind === 'worker')
      .map((session) => finiteTimestamp(session.updatedAt)),
  );
  return recentActivityAt > 0 && now - recentActivityAt < BOT_ACTIVE_WINDOW_MS;
}

export function sortBotRoster(bots: readonly BotProfile[]): BotProfile[] {
  return [...bots].sort((left, right) => {
    const leftPinned = finiteTimestamp(left.pinnedAt) > 0 ? 1 : 0;
    const rightPinned = finiteTimestamp(right.pinnedAt) > 0 ? 1 : 0;
    if (leftPinned !== rightPinned) return rightPinned - leftPinned;
    const activity = botRosterActivityAt(right) - botRosterActivityAt(left);
    return activity || left.id.localeCompare(right.id);
  });
}

export function filterBotRoster(
  bots: readonly BotProfile[],
  rawQuery: string,
): BotProfile[] {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return [...bots];
  return bots.filter((bot) =>
    [bot.name, bot.description, ...bot.skills]
      .filter(Boolean)
      .some((value) => value.toLocaleLowerCase().includes(query)),
  );
}

export function partitionBotRoster(
  bots: readonly BotProfile[],
  input: { query: string; showHidden: boolean },
): {
  visible: BotProfile[];
  hidden: BotProfile[];
  showHiddenSection: boolean;
  showHiddenRows: boolean;
} {
  const sorted = sortBotRoster(bots);
  const visible = filterBotRoster(
    sorted.filter((bot) => !bot.hiddenAt),
    input.query,
  );
  const hidden = filterBotRoster(
    sorted.filter((bot) => !!bot.hiddenAt),
    input.query,
  );
  const searching = input.query.trim().length > 0;
  return {
    visible,
    hidden,
    showHiddenSection: hidden.length > 0,
    showHiddenRows: input.showHidden || searching,
  };
}
