/**
 * Teammate system Skills (cindy-bots-runtime.md §6「伙伴技能分层」): host-maintained abilities outside the
 * always-on core. Each teammate may turn one off; off removes its prompt text, its tools and its
 * background work together. Stored as `capabilities.systemSkillsOff`; absent means every one is on,
 * so profiles written before this field keep their behaviour.
 *
 * The ids mirror `TEAMMATE_SYSTEM_SKILL_IDS` in `@cindy/mcps` (main asserts they match); renderer
 * code cannot import that package.
 */
export const BOT_SYSTEM_SKILL_IDS = ['todo', 'routine', 'follow'] as const;

/** vendorOptions key carrying the tools a teammate's turned-off system Skills deny (Pi bridge listing). */
export const BOT_DENIED_TOOLS_VENDOR_KEY = 'cindyBotDeniedTools';

export type BotSystemSkillId = (typeof BOT_SYSTEM_SKILL_IDS)[number];

export function isBotSystemSkillId(value: unknown): value is BotSystemSkillId {
  return typeof value === 'string' && (BOT_SYSTEM_SKILL_IDS as readonly string[]).includes(value);
}

/** The turned-off ids from a stored value; unknown entries are dropped, order follows the catalog. */
export function readBotSystemSkillsOff(raw: unknown): BotSystemSkillId[] {
  if (!Array.isArray(raw)) return [];
  return BOT_SYSTEM_SKILL_IDS.filter((id) => raw.includes(id));
}

export function isBotSystemSkillOn(capabilities: { systemSkillsOff?: unknown } | null | undefined, id: BotSystemSkillId): boolean {
  return !readBotSystemSkillsOff(capabilities?.systemSkillsOff).includes(id);
}

/** The stored list after turning one system Skill on or off. */
export function withBotSystemSkill(raw: unknown, id: BotSystemSkillId, on: boolean): BotSystemSkillId[] {
  const off = new Set(readBotSystemSkillsOff(raw));
  if (on) off.delete(id);
  else off.add(id);
  return BOT_SYSTEM_SKILL_IDS.filter((item) => off.has(item));
}
