/**
 * Teammate system Skills (cindy-bots-runtime.md §6「伙伴技能分层」): host-maintained abilities outside the
 * always-on core. Each teammate may turn one off; off removes its prompt text, its tools and its
 * background work together. Stored as `capabilities.systemSkillsOff`; absent means every one is on,
 * so profiles written before this field keep their behaviour.
 *
 * The ids mirror `TEAMMATE_SYSTEM_SKILL_IDS` in `@cindy/mcps` (main asserts they match); renderer
 * code cannot import that package.
 */
import { readBotProjectMode } from './botProjectMode.js';

/** A stored `'todo'` or `'follow'` (removed V1 Skills) is ignored when read. */
export const BOT_SYSTEM_SKILL_IDS = ['routine'] as const;

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

/**
 * The ids in effect for a profile. A project-mode teammate (V2) manages automations with the
 * ordinary scheduler, so its own routine Skill is off; built-in routines keep running.
 */
/** A V2 teammate has no system Skills: ordinary automations, tasks and project files do that work. */
const PROJECT_MODE_SYSTEM_SKILL_IDS: readonly BotSystemSkillId[] = [];

/** The system Skills that exist for this teammate at all. */
export function botSystemSkillIdsFor(config: Record<string, unknown> | { projectMode?: unknown }): readonly BotSystemSkillId[] {
  return readBotProjectMode(config) ? PROJECT_MODE_SYSTEM_SKILL_IDS : BOT_SYSTEM_SKILL_IDS;
}

export function effectiveBotSystemSkillsOff(config: Record<string, unknown> | { projectMode?: unknown; systemSkillsOff?: unknown }): BotSystemSkillId[] {
  const off = readBotSystemSkillsOff('systemSkillsOff' in config ? config.systemSkillsOff : undefined);
  const present = botSystemSkillIdsFor(config);
  return BOT_SYSTEM_SKILL_IDS.filter((id) => off.includes(id) || !present.includes(id));
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
