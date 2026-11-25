/**
 * What a plugin engine is told about Cindy before the first message of a new conversation.
 *
 * Plugin engines get no Cindy system prompt (docs/plans/acp-plugin-bridge.md), so without this
 * they cannot know which plugins and Skills the user installed: the built-in engines learn the
 * plugin roster from their system prompt and the Skills from their native Skill loading. The
 * user chose (2026-11-24) to send only these two lists, nothing else from the system prompt.
 */

/** The Cindy MCP server that carries the installed-plugin gateway (ghost_list / ghost_info / ghost_call). */
export const CINDY_PLUGIN_GATEWAY_MCP_SERVER = 'cindy';

/** A Skill the task can use, as the host discovered it for the built-in Pi engine. */
export interface PluginEngineBriefingSkill {
  name: string;
  description?: string;
  /** The Skill's SKILL.md on the computer the agent runs on. */
  path?: string;
  /** Found in the task's project (`repo`) or for every task (`user`); only the `/` menu reads it. */
  scope?: 'user' | 'repo';
}

const SKILL_LIST_MAX_ITEMS = 120;
const SKILL_DESCRIPTION_MAX_CHARS = 280;
const SKILL_LIST_CHAR_BUDGET = 24_000;

const SKILL_LIST_INTRO = [
  'Cindy Skills available in this task. A Skill is a packaged set of instructions the user or Cindy set up for a kind of task.',
  'When a request matches a Skill, read its SKILL.md with your file tools before you start, and follow it.',
  'Read only the Skills that apply. Names prefixed `cindy-plugin-` come from installed Cindy plugins; their tools are reached through the plugin gateway.',
].join(' ');

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** The Skill list as one text block; empty when there is no Skill with a readable file. */
export function formatPluginEngineSkillList(skills: readonly PluginEngineBriefingSkill[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const skill of [...skills].sort((a, b) => a.name.localeCompare(b.name))) {
    const name = oneLine(skill.name);
    const file = skill.path?.trim();
    if (!name || !file || seen.has(file)) continue;
    seen.add(file);
    const description = skill.description ? oneLine(skill.description).slice(0, SKILL_DESCRIPTION_MAX_CHARS) : '';
    lines.push(`- ${name}${description ? `: ${description}` : ''} (${JSON.stringify(file)})`);
    if (lines.length >= SKILL_LIST_MAX_ITEMS) break;
  }
  const render = (): string => ['<cindy-skills>', SKILL_LIST_INTRO, ...lines, '</cindy-skills>'].join('\n');
  while (lines.length > 0 && render().length > SKILL_LIST_CHAR_BUDGET) lines.pop();
  return lines.length > 0 ? render() : '';
}

export interface PluginEngineCapabilityBriefingInput {
  /** The host's installed-plugin roster, the same text the built-in engines get. */
  pluginRoster: string;
  skills: readonly PluginEngineBriefingSkill[];
}

/**
 * The capability part of the briefing, given the MCP servers the agent actually accepted. The
 * roster only helps through the plugin gateway, so it is left out when the agent did not take
 * that server (no HTTP MCP, or the bridge was unavailable).
 */
export function renderPluginEngineCapabilityBriefing(
  input: PluginEngineCapabilityBriefingInput,
  acceptedMcpServers: readonly string[],
): string {
  return [
    acceptedMcpServers.includes(CINDY_PLUGIN_GATEWAY_MCP_SERVER) ? input.pluginRoster.trim() : '',
    formatPluginEngineSkillList(input.skills),
  ].filter(Boolean).join('\n\n');
}
