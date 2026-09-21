import { promises as fs } from 'node:fs';
import path from 'node:path';

import matter from 'gray-matter';

import type { PinnedSkillInvocation } from '../base-agent.js';

const MAX_PINNED_SKILL_BYTES = 512 * 1024;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Expand a Host-attested Skill from its exact file before Claude's name-only
 * slash-command resolver can choose a colliding project or user Skill.
 *
 * The command envelope mirrors Claude Code's native prompt-command transcript
 * shape, so the task still appears and behaves like the user's original
 * `/name args` invocation. Only the instruction source changes: it comes from
 * the path that Main attested for this exact turn.
 */
export async function preparePinnedClaudeSkillInvocation(
  input: string,
  pinned: PinnedSkillInvocation,
): Promise<string> {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(pinned.name)) {
    throw new Error('Pinned Claude Skill has an invalid name.');
  }
  if (!path.isAbsolute(pinned.path) || path.basename(pinned.path).toLowerCase() !== 'skill.md') {
    throw new Error('Pinned Claude Skill must reference an absolute SKILL.md path.');
  }

  const invocation = new RegExp(
    `^/(?:skill:)?${escapeRegExp(pinned.name)}(?:\\s+([\\s\\S]*))?$`,
    'i',
  ).exec(input.trim());
  if (!invocation) {
    throw new Error('Pinned Claude Skill does not match the user invocation.');
  }

  const handle = await fs.open(pinned.path, 'r');
  let raw: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_PINNED_SKILL_BYTES) {
      throw new Error('Pinned Claude Skill file is missing or too large.');
    }
    raw = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }

  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(raw);
  } catch {
    throw new Error('Pinned Claude Skill has invalid frontmatter.');
  }
  const frontmatterName = parsed.data?.name;
  if (
    typeof frontmatterName !== 'string'
    || frontmatterName.trim().toLowerCase() !== pinned.name.toLowerCase()
    || !parsed.content.trim()
  ) {
    throw new Error('Pinned Claude Skill metadata does not match the attested Skill.');
  }

  const args = (invocation[1] ?? '').trim();
  return [
    `<command-name>${pinned.name}</command-name>`,
    `<command-message>/${pinned.name}</command-message>`,
    ...(args ? [`<command-args>${args}</command-args>`] : []),
    '',
    parsed.content.trim(),
  ].join('\n');
}
