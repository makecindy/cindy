/**
 * A message that starts with `/<skill>` asks for a Cindy Skill (docs/plans/acp-plugin-bridge.md
 * 「斜杠调用 Skill」). Plugin engines have no Cindy Skill loading, so `/name` would reach them as
 * plain text. Expand it the way the built-in Pi engine expands `/skill:name`: the Skill's
 * instructions inline, then the rest of the user's text. Deciding which Skill applies stays in code;
 * the agent does not have to find and read the file itself.
 */

import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { leadingSlashInvocation } from '@cindy/maker-shared';
import type { PluginEngineBriefingSkill } from './briefing.js';

/** Same ceiling as the pinned Claude Skill read; a larger SKILL.md is left to the agent. */
const MAX_SKILL_FILE_BYTES = 512 * 1024;

/**
 * Hidden runtime prefixes another engine's palette may have written in front of the name
 * (`/skill:git` for Pi, `/cindy:learn` and `/cindy-plugin-<id>:pr` for Claude Code).
 */
const RUNTIME_PREFIX_RE = /^(?:skill|cindy|cindy-plugin-[^\s:/]+):(?=\S+$)/i;

const FRONTMATTER_RE = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** The Skill a leading `/token` names: the exact name first, then without a runtime prefix. */
export function findInvokedSkill(
  text: string,
  skills: readonly PluginEngineBriefingSkill[],
): { skill: PluginEngineBriefingSkill; args: string } | undefined {
  const leading = leadingSlashInvocation(text);
  if (!leading) return undefined;
  const candidates = [leading.name];
  const prefix = RUNTIME_PREFIX_RE.exec(leading.name)?.[0];
  if (prefix) candidates.push(leading.name.slice(prefix.length));
  for (const name of candidates) {
    const wanted = name.toLowerCase();
    // List order decides between same-named Skills, as Pi takes its first match.
    const skill = skills.find((item) => item.path && item.name.trim().toLowerCase() === wanted);
    if (skill) return { skill, args: text.slice(leading.end).trim() };
  }
  return undefined;
}

async function readSkillBody(file: string): Promise<string | null> {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_SKILL_FILE_BYTES) return null;
    const body = (await handle.readFile('utf8')).replace(FRONTMATTER_RE, '').trim();
    return body || null;
  } finally {
    await handle.close();
  }
}

/**
 * The message text the plugin engine receives, or null to send it unchanged (no leading `/`, no
 * matching Skill, or the Skill could not be read). Never throws: a failed lookup only means the
 * agent gets the user's words as they are.
 */
export async function expandPluginEngineSkillInvocation(
  text: string,
  listSkills: () => Promise<readonly PluginEngineBriefingSkill[]>,
  onError?: (message: string) => void,
): Promise<string | null> {
  if (!leadingSlashInvocation(text)) return null;
  try {
    const hit = findInvokedSkill(text, await listSkills());
    if (!hit?.skill.path) return null;
    const location = hit.skill.path;
    const body = await readSkillBody(location);
    if (!body) return null;
    // Pi's own `/skill:` envelope, so a Skill reads the same on every engine.
    const block = `<skill name="${hit.skill.name.trim()}" location="${location}">\nReferences are relative to ${dirname(location)}.\n\n${body}\n</skill>`;
    return hit.args ? `${block}\n\n${hit.args}` : block;
  } catch (error) {
    onError?.(error instanceof Error ? error.message : String(error));
    return null;
  }
}
