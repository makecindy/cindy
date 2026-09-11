/** The current Cindy default route, captured when generating or refining a partner. */
export interface BotCreationRequest {
  prompt: string;
  token?: string;
  name?: string;
  description?: string;
  modelRoute: {
    agentKind: 'claude-code' | 'codex' | 'pi';
    providerId: string | null;
    model: string;
  };
}

/** Only editable, user-facing fields cross the draft boundary. */
export interface BotCreationDraft {
  token: string;
  name: string;
  description: string;
  skills: string[];
}

export function normalizeBotName(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase();
}

export function availableBotName(name: string, names: readonly string[]): string {
  const used = new Set(names.map(normalizeBotName));
  const base = name.trim();
  if (!used.has(normalizeBotName(base))) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base} ${suffix}`;
    if (!used.has(normalizeBotName(candidate))) return candidate;
  }
}

/** Display-only disambiguation for legacy duplicates; never rename or merge stored profiles. */
export function botRosterLabel(
  bot: { id: string; name: string },
  roster: readonly { id: string; name: string; createdAt: number }[],
): string {
  const matches = roster
    .filter((item) => normalizeBotName(item.name) === normalizeBotName(bot.name))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return matches.length > 1
    ? `${bot.name} · ${matches.findIndex((item) => item.id === bot.id) + 1}`
    : bot.name;
}
