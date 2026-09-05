import path from 'node:path';

import type { RemoteAgentFileOps } from '../base-agent.js';
import type { AgentSkillCommand, ListAgentSkillsResult } from '../../types/palette.js';

const SKILL_READ_LIMIT = 1_048_576;

function stripYamlQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) return trimmed.slice(1, -1).trim();
  return trimmed;
}

function descriptionFromMarkdown(raw: string): string | undefined {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end > 0) {
      for (let index = 1; index < end; index += 1) {
        const match = lines[index]?.match(/^description\s*:\s*(.*)$/);
        if (!match) continue;
        const value = match[1]?.trim() ?? '';
        if (/^[|>][+-]?$/.test(value)) {
          const block: string[] = [];
          for (let cursor = index + 1; cursor < end; cursor += 1) {
            const line = lines[cursor] ?? '';
            if (/^\S/.test(line) && line.includes(':')) break;
            if (line.trim()) block.push(line.trim());
          }
          const text = block.join(value.startsWith('>') ? ' ' : '\n').trim();
          return text ? text.slice(0, 200) : undefined;
        }
        const text = stripYamlQuotes(value);
        return text ? text.slice(0, 200) : undefined;
      }
    }
  }
  return lines
    .map((line) => line.trim())
    .find((line) => line && line !== '---' && !line.startsWith('#'))
    ?.slice(0, 200);
}

async function readDescription(fileOps: RemoteAgentFileOps, file: string): Promise<string | undefined> {
  try {
    return descriptionFromMarkdown(await fileOps.readFile(file, SKILL_READ_LIMIT));
  } catch {
    return undefined;
  }
}

async function existingSkillFile(
  fileOps: RemoteAgentFileOps,
  directory: string,
): Promise<string | null> {
  for (const name of ['SKILL.md', 'skill.md']) {
    const candidate = path.posix.join(directory, name);
    if ((await fileOps.stat(candidate))?.isFile) return candidate;
  }
  return null;
}

async function scanSkillDirectories(input: {
  fileOps: RemoteAgentFileOps;
  root: string;
  scope: 'global' | 'project' | 'user' | 'repo';
  runtimeCommandPrefix?: string;
}): Promise<AgentSkillCommand[]> {
  const names = (await input.fileOps.listDir(input.root))
    .filter((name) => name && !name.startsWith('.') && !name.includes('/'))
    .sort((a, b) => a.localeCompare(b));
  const found: AgentSkillCommand[] = [];
  for (const name of names) {
    const skillFile = await existingSkillFile(input.fileOps, path.posix.join(input.root, name));
    if (!skillFile) continue;
    found.push({
      kind: 'agent-skill',
      name,
      description: await readDescription(input.fileOps, skillFile),
      source: 'skill',
      path: skillFile,
      scope: input.scope,
      enabled: true,
      ...(input.runtimeCommandPrefix
        ? { runtimeCommandName: `${input.runtimeCommandPrefix}${name}` }
        : {}),
    });
  }
  return found;
}

async function scanClaudeCommands(
  fileOps: RemoteAgentFileOps,
  root: string,
  scope: 'global' | 'project',
): Promise<AgentSkillCommand[]> {
  const names = (await fileOps.listDir(root))
    .filter((name) => name.endsWith('.md') && !name.startsWith('.') && !name.includes('/'))
    .sort((a, b) => a.localeCompare(b));
  const found: AgentSkillCommand[] = [];
  for (const fileName of names) {
    const file = path.posix.join(root, fileName);
    if (!(await fileOps.stat(file))?.isFile) continue;
    found.push({
      kind: 'agent-skill',
      name: fileName.slice(0, -3),
      description: await readDescription(fileOps, file),
      source: 'user',
      path: file,
      scope,
      enabled: true,
    });
  }
  return found;
}

export async function scanRemoteClaudeSkills(input: {
  fileOps: RemoteAgentFileOps;
  workingDir?: string;
}): Promise<ListAgentSkillsResult> {
  const merged = new Map<string, AgentSkillCommand>();
  const sources = [
    ...(await scanClaudeCommands(input.fileOps, '$HOME/.claude/commands', 'global')),
    ...(await scanSkillDirectories({
      fileOps: input.fileOps,
      root: '$HOME/.claude/skills',
      scope: 'global',
    })),
  ];
  if (input.workingDir && path.posix.isAbsolute(input.workingDir)) {
    sources.push(
      ...(await scanClaudeCommands(
        input.fileOps,
        path.posix.join(input.workingDir, '.claude/commands'),
        'project',
      )),
      ...(await scanSkillDirectories({
        fileOps: input.fileOps,
        root: path.posix.join(input.workingDir, '.claude/skills'),
        scope: 'project',
      })),
    );
  }
  for (const skill of sources) merged.set(skill.name, skill);
  return { skills: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

export async function scanRemotePiSkills(input: {
  fileOps: RemoteAgentFileOps;
  workingDir?: string;
}): Promise<ListAgentSkillsResult> {
  const sources: AgentSkillCommand[] = await scanSkillDirectories({
    fileOps: input.fileOps,
    root: '$HOME/.agents/skills',
    scope: 'user',
    runtimeCommandPrefix: 'skill:',
  });
  if (input.workingDir && path.posix.isAbsolute(input.workingDir)) {
    let current = path.posix.resolve(input.workingDir);
    sources.push(...await scanSkillDirectories({
      fileOps: input.fileOps,
      root: path.posix.join(current, '.pi/skills'),
      scope: 'repo',
      runtimeCommandPrefix: 'skill:',
    }));
    while (true) {
      sources.push(...await scanSkillDirectories({
        fileOps: input.fileOps,
        root: path.posix.join(current, '.agents/skills'),
        scope: 'repo',
        runtimeCommandPrefix: 'skill:',
      }));
      if (await input.fileOps.stat(path.posix.join(current, '.git'))) break;
      const parent = path.posix.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  const deduped = new Map<string, AgentSkillCommand>();
  for (const skill of sources) deduped.set(`${skill.scope}\0${skill.path}`, skill);
  return { skills: [...deduped.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}
