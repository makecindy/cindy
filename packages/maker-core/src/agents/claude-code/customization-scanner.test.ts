import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { scanClaudeRuntimeSkills } from './customization-scanner.js';

const roots: string[] = [];

function writeSkill(root: string, name: string): string {
  const skillDir = path.join(root, 'skills', name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name}\n---\n`,
  );
  return skillDir;
}

function writeCommand(root: string, name: string): string {
  const command = path.join(root, 'commands', `${name}.md`);
  fs.mkdirSync(path.dirname(command), { recursive: true });
  fs.writeFileSync(command, `---\ndescription: ${name}\n---\n`);
  return command;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('scanClaudeRuntimeSkills', () => {
  it('uses the child runtime config directory for global Skills', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-runtime-skills-'));
    roots.push(root);
    const home = path.join(root, 'home');
    const isolatedConfig = path.join(root, 'user-data', 'claude-home');
    const workingDir = path.join(root, 'project');
    fs.mkdirSync(path.join(workingDir, '.git'), { recursive: true });
    writeSkill(path.join(home, '.claude'), 'default-home');
    const isolatedSkill = writeSkill(isolatedConfig, 'isolated-home');
    const projectSkill = writeSkill(path.join(workingDir, '.claude'), 'project-skill');
    vi.spyOn(os, 'homedir').mockReturnValue(home);

    const result = await scanClaudeRuntimeSkills(workingDir, isolatedConfig);

    expect(result.items.map((item) => item.name)).toEqual([
      'isolated-home',
      'project-skill',
    ]);
    expect(result.items.map((item) => item.absolutePath)).toEqual([
      isolatedSkill,
      fs.realpathSync(projectSkill),
    ]);
  });

  it('includes ancestor project Skills through the nearest Git boundary', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-runtime-ancestors-'));
    roots.push(root);
    const isolatedConfig = path.join(root, 'claude-home');
    const repository = path.join(root, 'repository');
    const workingDir = path.join(repository, 'packages', 'app');
    fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
    fs.mkdirSync(workingDir, { recursive: true });
    const globalLearn = writeSkill(isolatedConfig, 'learn');
    const repositoryLearn = writeSkill(path.join(repository, '.claude'), 'learn');
    const outsideLearn = writeSkill(path.join(root, '.claude'), 'outside');

    const result = await scanClaudeRuntimeSkills(workingDir, isolatedConfig);

    expect(result.items.filter((item) => item.name === 'learn').map((item) => item.absolutePath)).toEqual([
      globalLearn,
      fs.realpathSync(repositoryLearn),
    ]);
    expect(result.items.map((item) => item.absolutePath)).not.toContain(fs.realpathSync(outsideLearn));
  });

  it('includes legacy commands that compete in the runtime slash-command namespace', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-runtime-commands-'));
    roots.push(root);
    const isolatedConfig = path.join(root, 'claude-home');
    const repository = path.join(root, 'repository');
    const workingDir = path.join(repository, 'packages', 'app');
    fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
    fs.mkdirSync(workingDir, { recursive: true });
    const globalLearnSkill = writeSkill(isolatedConfig, 'learn');
    const globalLearnCommand = writeCommand(isolatedConfig, 'learn');
    const repositoryLearnCommand = writeCommand(path.join(repository, '.claude'), 'learn');
    const outsideLearnCommand = writeCommand(path.join(root, '.claude'), 'outside');

    const result = await scanClaudeRuntimeSkills(workingDir, isolatedConfig);

    expect(result.items.filter((item) => item.name === 'learn').map((item) => ({
      kind: item.kind,
      path: item.absolutePath,
    }))).toEqual([
      { kind: 'skill', path: globalLearnSkill },
      { kind: 'command', path: globalLearnCommand },
      { kind: 'command', path: fs.realpathSync(repositoryLearnCommand) },
    ]);
    expect(result.items.map((item) => item.absolutePath)).not.toContain(outsideLearnCommand);
  });
});
