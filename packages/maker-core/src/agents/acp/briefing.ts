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

const BUILTIN_PLUGIN_ENGINE_SLASH_COMMANDS: ReadonlySet<string> = new Set([
  'boost',
  'browser',
  'clear',
  'cmd',
  'compact',
  'goal',
  'grill-me',
  'learn',
  'mr',
  'plan',
  'pr',
  'review',
  'schedule',
  'swarm',
  'teamwork',
]);

const HANDOFF_TERMINATORS = [
  "== End of handoff note; the user's new message follows ==",
  "== End of rebuild note; the user's new message follows ==",
  "== End of fork note; the user's new message follows ==",
  '== 交接说明结束,以下是用户的新消息 ==',
  '== 上下文重建说明结束,以下是用户的新消息 ==',
] as const;

function isAsciiAlpha(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isCommandIdentChar(code: number): boolean {
  return isAsciiAlpha(code) || isAsciiDigit(code) || code === 45 /* '-' */ || code === 95 /* '_' */;
}

function isBlockedBeforeSlash(code: number): boolean {
  // Reject URLs, closing XML tags, scoped packages, CLI flags, ratios and file paths.
  return (
    isCommandIdentChar(code) ||
    code === 64 /* '@' */ ||
    code === 46 /* '.' */ ||
    code === 126 /* '~' */ ||
    code === 60 /* '<' */ ||
    code === 61 /* '=' */ ||
    code === 58 /* ':' */ ||
    code === 47 /* '/' */ ||
    code === 92 /* '\\' */
  );
}

function isBlockedAfterCommand(code: number): boolean {
  return (
    isCommandIdentChar(code) ||
    code === 47 /* '/' */ ||
    code === 92 /* '\\' */ ||
    code === 58 /* ':' */
  );
}

function isWordOrDigit(code: number): boolean {
  return isAsciiAlpha(code) || isAsciiDigit(code) || code === 95 /* '_' */;
}

/**
 * True when the user's text begins with a standalone `/command` (and not a multi-segment path
 * such as `/tmp/build.log`), so host briefings and wire notes do not displace it from index 0.
 */
export function isLeadingSlashCommand(text: string): boolean {
  return /^\s*\/[A-Za-z][A-Za-z0-9_-]*(?::[A-Za-z][A-Za-z0-9_-]*)?(?:\s|$)/.test(text);
}

/** Collects lowercase Skill names and post-`:` short names that an ACP harness may match as `/name`. */
export function collectPluginEngineSkillNames(skills: readonly PluginEngineBriefingSkill[]): string[] {
  const names = new Set<string>();
  for (const skill of skills) {
    const name = oneLine(skill.name).replace(/^\/+/, '').toLowerCase();
    if (!name) continue;
    names.add(name);
    const colon = name.indexOf(':');
    if (colon > 0 && colon < name.length - 1) names.add(name.slice(colon + 1));
  }
  return [...names];
}

/**
 * Strips the leading `/` from standalone `/command` mentions inside host-assembled non-user text.
 *
 * Some ACP harnesses (for example Antigravity `agy acp`) scan the full `session/prompt` text for
 * `/command` tokens and activate slash-command workflows even when the token came from Cindy's
 * capability briefing, handoff replay or wire notes rather than the user's own message.
 */
export function defusePluginEngineSlashMentions(
  text: string,
  extraCommands?: Iterable<string>,
): string {
  if (!text.includes('/')) return text;
  let known = BUILTIN_PLUGIN_ENGINE_SLASH_COMMANDS;
  if (extraCommands) {
    const merged = new Set(BUILTIN_PLUGIN_ENGINE_SLASH_COMMANDS);
    for (const raw of extraCommands) {
      const normalized = raw.trim().replace(/^\/+/, '').toLowerCase();
      if (!normalized) continue;
      merged.add(normalized);
      const colon = normalized.indexOf(':');
      if (colon > 0 && colon < normalized.length - 1) {
        merged.add(normalized.slice(colon + 1));
      }
    }
    known = merged;
  }

  let out = '';
  let lastCopied = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) !== 47 /* '/' */) continue;
    if (i > 0 && isBlockedBeforeSlash(text.charCodeAt(i - 1))) continue;
    const start = i + 1;
    if (start >= text.length || !isAsciiAlpha(text.charCodeAt(start))) continue;

    let cursor = start + 1;
    while (cursor < text.length && isCommandIdentChar(text.charCodeAt(cursor))) cursor += 1;

    let hasNamespace = false;
    if (
      cursor < text.length &&
      text.charCodeAt(cursor) === 58 /* ':' */ &&
      cursor + 1 < text.length &&
      isAsciiAlpha(text.charCodeAt(cursor + 1))
    ) {
      hasNamespace = true;
      cursor += 2;
      while (cursor < text.length && isCommandIdentChar(text.charCodeAt(cursor))) cursor += 1;
    }

    if (cursor < text.length) {
      const next = text.charCodeAt(cursor);
      if (isBlockedAfterCommand(next)) continue;
      if (next === 46 /* '.' */ && cursor + 1 < text.length && isWordOrDigit(text.charCodeAt(cursor + 1))) {
        continue;
      }
    }

    const token = text.slice(start, cursor);
    if (!hasNamespace && !known.has(token.toLowerCase())) continue;

    out += text.slice(lastCopied, i) + token;
    lastCopied = cursor;
    i = cursor - 1;
  }

  return lastCopied === 0 ? text : out + text.slice(lastCopied);
}

/**
 * Defuses `/command` mentions inside a host handoff/rebuild prefix while leaving the user's
 * trailing message after the handoff terminator untouched.
 */
export function defusePluginEngineHandoffPrefix(
  text: string,
  extraCommands?: Iterable<string>,
): string {
  let bestIdx = -1;
  let bestEnd = -1;
  for (const marker of HANDOFF_TERMINATORS) {
    const idx = text.indexOf(marker);
    if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) {
      bestIdx = idx;
      bestEnd = idx + marker.length;
    }
  }
  if (bestEnd < 0) return text;
  const prefix = text.slice(0, bestEnd);
  const defused = defusePluginEngineSlashMentions(prefix, extraCommands);
  return defused === prefix ? text : defused + text.slice(bestEnd);
}

export type PluginEngineWireMessage =
  | string
  | { type: 'user'; content: string | Array<{ type: string; [k: string]: unknown }> };

/**
 * Defuses `/command` mentions in host wire notes added around `userMessage` while preserving
 * `userMessage` itself byte-for-byte.
 */
export function defusePluginEngineWireEnvelope(
  outgoing: PluginEngineWireMessage,
  userMessage: PluginEngineWireMessage,
  extraCommands?: Iterable<string>,
): PluginEngineWireMessage {
  if (outgoing === userMessage) return outgoing;
  const defuseBeforeTail = (full: string, tail: string): string => {
    if (!full.endsWith(tail) || full.length === tail.length) return full;
    const prefix = full.slice(0, full.length - tail.length);
    const defused = defusePluginEngineSlashMentions(prefix, extraCommands);
    return defused === prefix ? full : defused + tail;
  };
  if (typeof outgoing === 'string') {
    return typeof userMessage === 'string' ? defuseBeforeTail(outgoing, userMessage) : outgoing;
  }
  const userContent = typeof userMessage === 'string' ? userMessage : userMessage.content;
  if (typeof outgoing.content === 'string') {
    if (typeof userContent !== 'string') return outgoing;
    const next = defuseBeforeTail(outgoing.content, userContent);
    return next === outgoing.content ? outgoing : { ...outgoing, content: next };
  }
  if (Array.isArray(userContent)) {
    const userBlocks = new Set<unknown>(userContent);
    let changed = false;
    const content = outgoing.content.map((block) => {
      if (userBlocks.has(block) || block.type !== 'text' || typeof block.text !== 'string') return block;
      const text = defusePluginEngineSlashMentions(block.text, extraCommands);
      if (text === block.text) return block;
      changed = true;
      return { ...block, text };
    });
    return changed ? { ...outgoing, content } : outgoing;
  }
  let userTailPreserved = false;
  let changed = false;
  const content = [...outgoing.content];
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const block = content[i]!;
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    if (!userTailPreserved && block.text.endsWith(userContent)) {
      userTailPreserved = true;
      const text = defuseBeforeTail(block.text, userContent);
      if (text !== block.text) {
        content[i] = { ...block, text };
        changed = true;
      }
      continue;
    }
    const text = defusePluginEngineSlashMentions(block.text, extraCommands);
    if (text !== block.text) {
      content[i] = { ...block, text };
      changed = true;
    }
  }
  return changed ? { ...outgoing, content } : outgoing;
}

/** The Skill list as one text block; empty when there is no Skill with a readable file. */
export function formatPluginEngineSkillList(skills: readonly PluginEngineBriefingSkill[]): string {
  const skillNames = collectPluginEngineSkillNames(skills);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const skill of [...skills].sort((a, b) => a.name.localeCompare(b.name))) {
    const name = oneLine(skill.name);
    const file = skill.path?.trim();
    if (!name || !file || seen.has(file)) continue;
    seen.add(file);
    const rawDescription = skill.description
      ? defusePluginEngineSlashMentions(oneLine(skill.description), skillNames)
      : '';
    const description = rawDescription
      ? defusePluginEngineSlashMentions(rawDescription.slice(0, SKILL_DESCRIPTION_MAX_CHARS), skillNames)
      : '';
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
  const skillNames = collectPluginEngineSkillNames(input.skills);
  return [
    acceptedMcpServers.includes(CINDY_PLUGIN_GATEWAY_MCP_SERVER)
      ? defusePluginEngineSlashMentions(input.pluginRoster.trim(), skillNames)
      : '',
    formatPluginEngineSkillList(input.skills),
  ].filter(Boolean).join('\n\n');
}
