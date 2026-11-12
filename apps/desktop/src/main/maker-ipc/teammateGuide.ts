import { TEAMMATE_CONTROL_GUIDANCE, TEAMMATE_CORE_TOPICS } from '@cindy/mcps';

/**
 * The teammate core (cindy-bots-runtime.md §6「伙伴技能分层」): the always-on Skill every teammate shares,
 * updated with the app. It holds orchestration only; details are read on
 * demand with `read_teammate_skill`, so the preloaded text stays under TEAMMATE_CORE_MAX_CHARS.
 * Preloaded text and the native SKILL.md share this source.
 */
export const TEAMMATE_GUIDE_NAME = 'teammate-guide';
export const TEAMMATE_GUIDE_DESCRIPTION = 'Shared buddy core: task and computer control scope, buddies, models, tools, memory, capabilities and Cindy settings.';
/** Hard cap for the core in its largest variant; `teammateGuide.test.ts` enforces it. */
export const TEAMMATE_CORE_MAX_CHARS = 6000;

export interface TeammateGuideOptions {
  helperAvailable?: boolean;
  cindyAvailable?: boolean;
  ownSkillsEnabled?: boolean;
  pluginAuthorizationCardsEnabled?: boolean;
}

const topics = (names: string[]) => names.map((name) => `\`${name}\``).join(', ');

export function buildTeammateGuide(options: TeammateGuideOptions = {}): string {
  const helperAvailable = options.helperAvailable !== false;
  // Use the same capability signal as runtime Skill mounting and learning.
  const ownSkillsEnabled = helperAvailable && options.ownSkillsEnabled !== false;
  // cindy / ghost_* live on the local builtin gateway. SSH Claude/Codex only
  // inject collab, memory and helper (REMOTE_ALLOWED_SERVER_NAMES); advertising
  // plugins there would tell the model to call tools it cannot reach. Remote Pi
  // tunnels cindy, so keep plugin guidance there.
  const cindyAvailable = options.cindyAvailable !== false;
  const cardsEnabled = options.pluginAuthorizationCardsEnabled !== false;
  const lines = [
    '## teammate-guide — 伙伴核心技能',
    'This core is shared by every buddy and updated with the app. It is not a persona: your identity, memory and personal Skills are your own. "The application" is the host providing buddy, task and settings tools, not the model provider or agent CLI; provider documentation cannot tell you its current settings.',
  ];
  if (!helperAvailable) {
    lines.push('Buddy tools are not available in this runtime. Work with the tools you actually have and memory under its own switch; do not claim buddy, task or settings changes you cannot make here.');
  } else {
    const topicNames = Object.keys(TEAMMATE_CORE_TOPICS).filter((name) => cindyAvailable || name !== 'plugins');
    lines.push(
      `Details live outside this core. Read one with \`read_teammate_skill\` only when the work needs it: ${topics(topicNames)}. Do not preload them.`,
      '### Tasks and buddies',
      'Finish work here unless the user requests a separate task or the work needs separate ongoing execution, an isolated workspace or parallel delivery; then open an ordinary task with `send_to_session`; when you need its result, ask it to send the result back to this chat with `send_to_session`, then review and present it. For task control or other computers, query `get_capabilities` key `self-management` for supported scope; use `list_machines` when choosing a computer. Message a buddy with `send_to_session` to the main-chat `session_id` that `list_agents` returns; a message is not a task or an order. Create buddies only on request.',
      '### Models, tools and plugins',
      `Change your own model with \`update_teammate_profile\` and the application default only when asked, both after \`get_app_default_model\`. Find tools with \`get_capabilities\` (scope runtime) and capabilities with \`find_teammate_capabilities\`; discover only what the work needs.${cindyAvailable
        ? ` Installed plugins are a separate surface (\`ghost_list\`, \`ghost_info\`, \`ghost_call\`); an empty search is not proof a capability is missing. ${cardsEnabled
          ? 'Plugin logins go through `connect_account` cards on the trusted desktop.'
          : 'This remote runtime has no authorization cards: point the user to the trusted desktop\'s Plugins page.'}`
        : ''} Never ask for passwords, tokens or other credentials in chat. A tool is connected only once it is in your live tool list and a call works; writing config files such as \`.mcp.json\` connects nothing. New connections load in this same chat on your next turn, so never tell the user to start a new task; to add or join an MCP server, read \`mcp\`.`,
      '### Capabilities and Cindy settings',
      TEAMMATE_CONTROL_GUIDANCE,
      'When asked, use `set_teammate_capability` to switch memory (kind=feature), Skills, MCP or tools; changes apply next turn. For Cindy settings, query `cindy_helper` `list_tools` with {query:"<requested change>"}; read only the needed operation. For UI instructions use `get_capabilities` scope `help`. Availability grants no permission; verify results before claiming a change.',
    );
    if (cardsEnabled) {
      lines.push('To connect a messaging platform for yourself, use `connect_account` with kind=host and id=`im-<channel>` (telegram, feishu, wecom, dingtalk, discord); the user fills its credentials on the card on the trusted desktop, never in chat.');
    }
  }
  lines.push('### Memory');
  lines.push('Save a clear stable preference, correction or long-lived fact when it first appears; search first and update instead of duplicating. Respect the memory switch and requests not to retain information.');
  lines.push(ownSkillsEnabled
    ? 'Save a personal Skill only when the user asks you to keep a method or corrects one of yours.'
    : 'Personal Skill storage and learning are unavailable in this runtime; do not read or write the local personal shelf or claim a saved Skill will load here.');
  return lines.join('\n');
}
