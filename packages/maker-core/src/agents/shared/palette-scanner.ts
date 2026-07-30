import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  AgentSlashCommand,
  AtResourceItem,
  ScanAtResourcesResult,
} from '../../types/palette.js';

const MAX_SCAN_ITEMS = 2_000;
const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  'target',
  'build',
  'dist',
  'out',
  '.next',
  '.turbo',
  '.vite',
]);

function clampCap(cap: number | undefined): number {
  return Math.max(0, Math.min(cap ?? MAX_SCAN_ITEMS, MAX_SCAN_ITEMS));
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function toPosixRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

function normalizeQuery(query: string | undefined): string {
  return query?.trim().toLowerCase() ?? '';
}

function fuzzyInOrder(hay: string, needle: string): boolean {
  if (!needle) return true;
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
}

function matchesResourceQuery(name: string, relPath: string, query: string): boolean {
  if (!query) return true;
  const nameLower = name.toLowerCase();
  const relLower = relPath.toLowerCase();
  return (
    nameLower.includes(query) ||
    relLower.includes(query) ||
    fuzzyInOrder(nameLower, query) ||
    fuzzyInOrder(relLower, query)
  );
}

function stripYamlQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function extractDescriptionFromFrontmatter(raw: string): string | undefined {
  if (!raw.startsWith('---')) return undefined;
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return undefined;

  const endIdx = lines.findIndex((line, idx) => idx > 0 && line.trim() === '---');
  if (endIdx < 0) return undefined;
  const fmLines = lines.slice(1, endIdx);
  for (let i = 0; i < fmLines.length; i += 1) {
    const match = fmLines[i]?.match(/^description\s*:\s*(.*)$/);
    if (!match) continue;

    const value = match[1]?.trim() ?? '';
    // YAML block scalar — `|` / `>` with optional chomping indicator (`-` / `+`),
    // e.g. `description: >-`. Without the `[+-]?` part, `>-` fell through to the
    // plain-value branch and the literal string ">-" showed up in the palette
    // tooltip.
    if (/^[|>][+-]?$/.test(value)) {
      const block: string[] = [];
      for (let j = i + 1; j < fmLines.length; j += 1) {
        const line = fmLines[j] ?? '';
        if (/^\S/.test(line) && line.includes(':')) break;
        if (line.trim()) block.push(line.trim());
      }
      const desc = block.join(value.startsWith('>') ? ' ' : '\n').trim();
      return desc ? desc.slice(0, 200) : undefined;
    }

    const desc = stripYamlQuotes(value);
    return desc ? desc.slice(0, 200) : undefined;
  }
  return undefined;
}

function extractDescription(raw: string): string | undefined {
  const frontmatterDesc = extractDescriptionFromFrontmatter(raw);
  if (frontmatterDesc) return frontmatterDesc;

  const bodyStart = raw.startsWith('---')
    ? raw.indexOf('\n---', 3)
    : -1;
  const body = bodyStart >= 0 ? raw.slice(bodyStart + 4) : raw;
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#') && line !== '---');
  return firstLine?.slice(0, 200);
}

async function readMarkdownDescription(filePath: string): Promise<string | undefined> {
  try {
    return extractDescription(await fs.readFile(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

export async function scanWorkspaceFileResources(
  workingDir: string,
  cap?: number,
  opts?: { skipRelDirs?: Iterable<string>; query?: string },
): Promise<ScanAtResourcesResult> {
  const max = clampCap(cap);
  const query = normalizeQuery(opts?.query);
  if (!workingDir || !path.isAbsolute(workingDir) || !(await isDirectory(workingDir))) {
    throw new Error('workingDir not found');
  }
  if (max === 0) return { items: [], truncated: true };

  const skipRelDirs = new Set(opts?.skipRelDirs ?? []);
  const items: AtResourceItem[] = [];
  const queue: string[] = [workingDir];
  let truncated = false;

  while (queue.length > 0 && items.length < max) {
    const cur = queue.shift()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const ent of entries) {
      if (items.length >= max) {
        truncated = true;
        break;
      }
      if (ent.name.startsWith('.') && ent.name !== '.claude') continue;

      const abs = path.join(cur, ent.name);
      const rel = toPosixRel(workingDir, abs);
      if (ent.isDirectory()) {
        if (IGNORE_DIRS.has(ent.name) || skipRelDirs.has(rel)) continue;
        if (matchesResourceQuery(ent.name, rel, query)) {
          items.push({ type: 'dir', name: ent.name, relPath: rel });
        }
        queue.push(abs);
      } else if (ent.isFile()) {
        if (matchesResourceQuery(ent.name, rel, query)) {
          items.push({ type: 'file', name: ent.name, relPath: rel });
        }
      }
    }
  }

  if (items.length >= max && queue.length > 0) truncated = true;
  return { items, truncated };
}

export async function scanClaudeAgentResources(
  workingDir: string,
  cap?: number,
  query?: string,
): Promise<ScanAtResourcesResult> {
  const max = clampCap(cap);
  const normalizedQuery = normalizeQuery(query);
  if (!workingDir || !path.isAbsolute(workingDir) || !(await isDirectory(workingDir))) {
    return { items: [], truncated: false };
  }
  if (max === 0) return { items: [], truncated: true };

  const agentsDir = path.join(workingDir, '.claude', 'agents');
  if (!(await isDirectory(agentsDir))) return { items: [], truncated: false };

  const items: AtResourceItem[] = [];
  let truncated = false;
  try {
    const entries = (await fs.readdir(agentsDir, { withFileTypes: true }))
      .filter((ent) => ent.isFile() && ent.name.endsWith('.md'))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (items.length >= max) {
        truncated = true;
        break;
      }
      const name = ent.name.replace(/\.md$/, '');
      const relPath = path.posix.join('.claude', 'agents', ent.name);
      if (!matchesResourceQuery(name, relPath, normalizedQuery)) continue;
      items.push({
        type: 'agent',
        name,
        relPath,
        description: await readMarkdownDescription(path.join(agentsDir, ent.name)),
      });
    }
  } catch {
    return { items: [], truncated: false };
  }
  return { items, truncated };
}

export async function scanClaudeAtResources(
  workingDir: string,
  cap?: number,
  query?: string,
): Promise<ScanAtResourcesResult> {
  const max = clampCap(cap);
  const agents = await scanClaudeAgentResources(workingDir, max, query);
  if (agents.items.length >= max) {
    return { items: agents.items, truncated: true };
  }
  const common = await scanWorkspaceFileResources(workingDir, max - agents.items.length, {
    skipRelDirs: ['.claude/agents'],
    query,
  });
  return {
    items: [...agents.items, ...common.items],
    truncated: agents.truncated || common.truncated,
  };
}

async function scanClaudeCommandFiles(
  dirPath: string,
  scope: 'global' | 'project',
): Promise<AgentSlashCommand[]> {
  if (!(await isDirectory(dirPath))) return [];
  const results: AgentSlashCommand[] = [];
  const entries = (await fs.readdir(dirPath, { withFileTypes: true }))
    .filter((ent) => ent.isFile() && ent.name.endsWith('.md'))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const ent of entries) {
    results.push({
      name: ent.name.replace(/\.md$/, ''),
      description: await readMarkdownDescription(path.join(dirPath, ent.name)),
      source: 'user',
      path: path.join(dirPath, ent.name),
      scope,
    });
  }
  return results;
}

async function scanClaudeSkillDirs(
  dirPath: string,
  scope: 'global' | 'project',
): Promise<AgentSlashCommand[]> {
  if (!(await isDirectory(dirPath))) return [];
  const results: AgentSlashCommand[] = [];
  const entries = (await fs.readdir(dirPath, { withFileTypes: true }))
    .filter((ent) => (ent.isDirectory() || ent.isSymbolicLink()) && !ent.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const ent of entries) {
    const subDir = path.join(dirPath, ent.name);
    const skillFile = (await Promise.all(
      ['SKILL.md', 'skill.md'].map(async (name) => ({
        name,
        exists: await fs.stat(path.join(subDir, name)).then((stat) => stat.isFile()).catch(() => false),
      })),
    )).find((entry) => entry.exists)?.name;
    if (!skillFile) continue;

    const skillPath = path.join(subDir, skillFile);
    results.push({
      name: ent.name,
      description: await readMarkdownDescription(skillPath),
      source: 'skill',
      path: skillPath,
      scope,
    });
  }
  return results;
}

export async function scanClaudeSlashCommands(workingDir?: string): Promise<AgentSlashCommand[]> {
  const home = os.homedir();
  const merged = new Map<string, AgentSlashCommand>();
  const discovered = [
    ...(await scanClaudeCommandFiles(path.join(home, '.claude', 'commands'), 'global')),
    ...(await scanClaudeSkillDirs(path.join(home, '.claude', 'skills'), 'global')),
  ];
  if (workingDir && path.isAbsolute(workingDir) && await isDirectory(workingDir)) {
    discovered.push(
      ...(await scanClaudeCommandFiles(path.join(workingDir, '.claude', 'commands'), 'project')),
      ...(await scanClaudeSkillDirs(path.join(workingDir, '.claude', 'skills'), 'project')),
    );
  }

  for (const cmd of discovered) {
    merged.set(cmd.name, cmd);
  }
  return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
}
