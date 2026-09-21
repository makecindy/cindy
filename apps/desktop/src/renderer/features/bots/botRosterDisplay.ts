import type { BotProfile } from './botStore';

/** Keep unnamed and identically named hosts distinguishable without changing routing IDs. */
export function botDeviceLabel(
  device: { deviceId: string; name: string },
  devices: readonly { deviceId: string; name: string }[],
): string {
  const name = device.name.trim();
  if (!name) return device.deviceId;
  const duplicate = devices.some(
    (other) => other.deviceId !== device.deviceId
      && other.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
  );
  return duplicate ? `${name} (${device.deviceId})` : name;
}

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
