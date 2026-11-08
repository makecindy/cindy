import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { SkillIndex, type SkillEntry, type SkillIndexSnapshot } from './index.js';
import { createSkillEmbeddingAdapter } from './embedding.js';

export interface LibrarySource { name: string; path: string }
export interface LibraryConfig {
  version: 1;
  sources: LibrarySource[];
  embedding?: { baseUrl: string; model: string; apiKeyEnv: string; dimensions?: number };
}

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', '.runtime-skills']);

/** Registered roots own the catalog. A Skill folder is a leaf; its resources are not more Skills. */
export async function discoverSkills(sources: readonly LibrarySource[]): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = [];
  const visited = new Set<string>();
  async function visit(directory: string, source: string): Promise<void> {
    const real = await fs.realpath(directory);
    const identity = process.platform === 'win32' ? real.toLowerCase() : real;
    if (visited.has(identity)) return;
    visited.add(identity);
    const children = await fs.readdir(real, { withFileTypes: true });
    const skill = children.find(child => child.name === 'SKILL.md' || child.name === 'skill.md');
    if (skill) {
      const filePath = path.join(real, skill.name);
      const raw = (await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
      if (!/^---\r?\n/.test(raw)) throw new Error(`${filePath}: expected YAML Skill frontmatter`);
      const { data } = matter(raw);
      if (typeof data.name !== 'string' || typeof data.description !== 'string') {
        throw new Error(`${filePath}: name and description must be strings`);
      }
      const strings = (value: unknown): string[] => Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string') : [];
      entries.push({
        id: createHash('sha256').update(identity).digest('hex').slice(0, 24),
        name: data.name, description: data.description, filePath, source,
        aliases: strings(data.metadata?.aliases), tags: strings(data.metadata?.tags),
      });
      return;
    }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (IGNORED_DIRECTORIES.has(child.name) || child.name.startsWith('.')) continue;
      const childPath = path.join(real, child.name);
      if (child.isDirectory() || (child.isSymbolicLink() && (await fs.stat(childPath)).isDirectory())) {
        await visit(childPath, source);
      }
    }
  }
  for (const source of sources) await visit(source.path, source.name);
  return entries;
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const staging = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(staging, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(staging, file);
  } finally {
    await fs.rm(staging, { force: true });
  }
}

export async function readConfig(library: string): Promise<LibraryConfig> {
  const config: LibraryConfig = JSON.parse(await fs.readFile(path.join(library, 'library.json'), 'utf8'));
  if (config.version !== 1 || !Array.isArray(config.sources)) throw new Error('Unsupported Skill library configuration');
  return config;
}

export async function loadIndex(library: string): Promise<SkillIndex> {
  const snapshot: SkillIndexSnapshot = JSON.parse(await fs.readFile(path.join(library, 'index.json'), 'utf8'));
  return new SkillIndex(snapshot);
}

export async function syncLibrary(library: string) {
  const config = await readConfig(library);
  let index: SkillIndex;
  try { index = await loadIndex(library); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    index = new SkillIndex();
  }
  const changes = index.sync(await discoverSkills(config.sources));
  const vectors = config.embedding
    ? await index.buildVectors(createSkillEmbeddingAdapter(config.embedding)) : undefined;
  await writeJson(path.join(library, 'index.json'), index.snapshot());
  return { ...changes, skills: index.snapshot().entries.length, ...(vectors ? { vectors } : {}) };
}

export interface SkillReadOptions { offset?: number; chars?: number; expectedSha256?: string }

/** Read only the selected original. Relative references retain their original resource root. */
export async function readSkill(index: SkillIndex, id: string, options: SkillReadOptions = {}) {
  const entry = index.resolve(id);
  if (!entry) throw new Error(`Unknown Skill id: ${id}. Search the library first.`);
  const offset = options.offset ?? 0;
  const chars = options.chars ?? 6000;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(chars) || chars < 1 || chars > 24000) {
    throw new Error('offset must be a non-negative integer; chars must be 1..24000');
  }
  const raw = await fs.readFile(entry.filePath);
  const sha256 = createHash('sha256').update(raw).digest('hex');
  if (offset > 0 && !options.expectedSha256) throw new Error('Continuing a Skill requires --sha256 from the previous page');
  if (options.expectedSha256 && options.expectedSha256 !== sha256) throw new Error('Skill changed; read again from offset 0');
  const body = raw.toString('utf8').replace(/^\uFEFF/, '');
  if (offset > body.length) throw new Error('offset exceeds the Skill length');
  const end = Math.min(body.length, offset + chars);
  return {
    id, filePath: entry.filePath, resourceRoot: path.dirname(entry.filePath),
    sha256, offset, totalChars: body.length, content: body.slice(offset, end),
    eof: end === body.length, ...(end < body.length ? { nextOffset: end } : {}),
  };
}

/** A constant-size gateway: no catalog entries or credentials are included in the Skill. */
export function discoverySkill(library: string, executable: string, name = 'cindy-skill-library'): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new Error('Use a lowercase hyphenated Skill name (max 64 characters)');
  return [
    '---', `name: ${name}`,
    'description: Find relevant methods in your local Skill library at the start of a task. Search by the task, then read the selected original Skills and use their resources.',
    '---', '', '# Local Skill library', '',
    'At the start of a task, search this library using the user\'s goal before choosing a method. Search again when a new part of the task needs different expertise.',
    'Run the Node CLI using the following executable and arguments. Preserve paths as individual arguments using your shell\'s quoting rules:', '',
    `- Executable: ${JSON.stringify(executable)}`,
    `- Search arguments: ${JSON.stringify(['search', '--library', library, '--query', '<task description>'])}`,
    `- Read arguments: ${JSON.stringify(['read', '--library', library, '--id', '<id from search>'])}`, '',
    'Use the executable with Node.js. The index stays on disk; do not read index.json, library.json, or every Skill description into context.',
    'Search returns only a few candidates. Choose the relevant ones and read their complete SKILL.md. Follow nextOffset with --offset and --sha256 until eof is true. Resolve references, scripts and assets from the returned resourceRoot.',
    'Names, descriptions and scores help select a Skill; they do not replace its instructions. Load only references needed for the current task. If no method applies, continue the task normally.',
    'When the user adds or edits library Skills, run this CLI with sync --library and the same library path. Search uses the last synchronized index.', '',
  ].join('\n');
}
