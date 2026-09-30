import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BOT_SKILL_MAX_DESCRIPTION_CHARS,
  BOT_SKILL_MAX_NAME_CHARS,
  type BotSkillSummary,
} from './botSkillStore.js';

/** A startup/output byte budget, never a limit on stored or discoverable Skills. */
export const BOT_SKILL_RUNTIME_INDEX_BYTES = 16 * 1024;

export function botSkillRuntimeSummary(item: BotSkillSummary):
  Pick<BotSkillSummary, 'slug' | 'name' | 'description' | 'updatedAt' | 'enabled'>
  & Partial<Pick<BotSkillSummary, 'filePath' | 'bodyStartLine'>> {
  return {
    slug: item.slug,
    name: item.name.slice(0, BOT_SKILL_MAX_NAME_CHARS),
    description: item.description.slice(0, BOT_SKILL_MAX_DESCRIPTION_CHARS),
    updatedAt: item.updatedAt.slice(0, 64),
    ...(item.enabled === false ? { enabled: false as const } : { filePath: item.filePath, bodyStartLine: item.bodyStartLine }),
  };
}

/**
 * All three harnesses consume this same projection. Small shelves retain native
 * mounts. Large shelves (or headers) mount one discovery Skill instead of passing
 * every path on argv / injecting every raw YAML description into the prompt.
 * Originals and relative resources stay in place; nothing is truncated on disk.
 */
export async function projectBotSkillMounts(root: string, skills: Iterable<BotSkillSummary> | AsyncIterable<BotSkillSummary>) {
  const pluginRoot = path.join(root, '.runtime-skills');
  const catalogPath = path.join(pluginRoot, 'catalog.jsonl');
  const hadCatalog = !!await fs.stat(catalogPath).catch(() => null);
  const temporary = `${catalogPath}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let chunk = '';
  let bytes = 0;
  let direct = true;
  let small: BotSkillSummary[] = [];
  const write = async (item: BotSkillSummary) => {
    if (!handle) {
      await fs.mkdir(pluginRoot, { recursive: true });
      handle = await fs.open(temporary, 'wx', 0o600);
    }
    chunk += `${JSON.stringify(botSkillRuntimeSummary(item))}\n`;
    if (Buffer.byteLength(chunk) >= 64 * 1024) {
      await handle.writeFile(chunk);
      chunk = '';
    }
  };
  try {
    // Refresh even an empty catalog when a formerly large shelf shrinks.
    if (hadCatalog) handle = await fs.open(temporary, 'wx', 0o600);
    for await (const item of skills) {
      if (direct) {
        bytes += item.frontmatterBytes + Buffer.byteLength(JSON.stringify(botSkillRuntimeSummary(item)));
        direct = bytes <= BOT_SKILL_RUNTIME_INDEX_BYTES && !item.requiresDiscovery
          && item.name.length <= BOT_SKILL_MAX_NAME_CHARS
          && item.description.length <= BOT_SKILL_MAX_DESCRIPTION_CHARS;
        if (direct) small.push(item);
        else {
          if (!hadCatalog) for (const previous of small) await write(previous);
          small = [];
        }
      }
      if (!direct || hadCatalog) await write(item);
    }
    if (handle) {
      if (chunk) await handle.writeFile(chunk);
      await handle.close(); handle = undefined;
      await fs.rename(temporary, catalogPath);
    }
  } finally {
    try { await handle?.close(); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  if (direct) return {
    pluginRoot: root,
    // Only the byte-bounded native prefix is sorted/retained in memory.
    skills: small.sort((a, b) => a.name.localeCompare(b.name)).map(item => ({
      name: item.name, description: item.description, path: item.dirPath, filePath: item.filePath,
    })),
  };

  const name = 'personal-skill-library';
  const description = 'Search your complete personal Skill library before choosing how to do a task. Read the matching original Skill and use its resources on demand; the library includes all enabled personal Skills.';
  const skillPath = path.join(pluginRoot, 'skills', name);
  const filePath = path.join(skillPath, 'SKILL.md');
  const source = [
    '---', `name: ${name}`, `description: ${JSON.stringify(description)}`, '---', '',
    'Your complete enabled personal Skill library is available here; it is not a missing or disabled capability.',
    `Catalog: ${JSON.stringify(catalogPath)} (JSON Lines, one Skill per line).`,
    'Before doing a task, search this catalog for relevant names/descriptions with your native file/search tools. Read only matching lines or a small page, never the entire catalog.',
    'If available, list_teammate_skills(query=keywords) also searches full original metadata. Follow nextOffset to continue a page; an empty first page is not the complete library.',
    'For a match, read its original filePath starting at bodyStartLine, in bounded chunks, then follow that Skill. Resolve all relative resource/script paths against the directory containing that original file, not this discovery Skill directory.',
    'Catalog names/descriptions are short previews. Full original metadata, instructions and resources remain at filePath; search original Skill files if the preview is insufficient. Load only the Skill(s) needed for the current work.',
    'Disabled Skills are excluded from this catalog. Do not enable or execute them through discovery.', '',
  ].join('\n');
  const manifestPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
  await fs.mkdir(skillPath, { recursive: true });
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });

  for (const [target, content] of [
    [filePath, source],
    [manifestPath, JSON.stringify({ name, version: '1.0.0', description })],
  ]) {
    if (await fs.readFile(target, 'utf8').catch(() => null) === content) continue;
    const staging = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(staging, content, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(staging, target);
    } finally { await fs.rm(staging, { force: true }); }
  }
  return { pluginRoot, skills: [{ name, description, path: skillPath, filePath }] };
}
