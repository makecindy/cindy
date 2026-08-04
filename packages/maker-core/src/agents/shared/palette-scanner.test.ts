import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { scanClaudeSlashCommands, scanWorkspaceFileResources } from './palette-scanner.js';

describe('scanWorkspaceFileResources', () => {
  it('finds deep queried documents after the unfiltered cap would truncate', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-palette-'));

    for (let i = 0; i < 5; i += 1) {
      await mkdir(path.join(root, `aaa-${i}`));
      await writeFile(path.join(root, `aaa-${i}`, `noise-${i}.md`), `noise ${i}`);
    }

    const productDir = path.join(root, 'zzz', 'taptap-product');
    await mkdir(productDir, { recursive: true });
    await writeFile(path.join(productDir, 'prd.md'), '# PRD');

    const unfiltered = await scanWorkspaceFileResources(root, 3);
    expect(unfiltered.truncated).toBe(true);
    expect(unfiltered.items.some((item) => item.relPath === 'zzz/taptap-product/prd.md')).toBe(false);

    const filtered = await scanWorkspaceFileResources(root, 3, { query: 'taptap-product' });
    expect(filtered.items.some((item) => item.relPath === 'zzz/taptap-product')).toBe(true);
    expect(filtered.items.some((item) => item.relPath === 'zzz/taptap-product/prd.md')).toBe(true);
  });
});

describe('scanClaudeSlashCommands', () => {
  it('lists global Claude commands and skills without a working directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-palette-'));
    const home = path.join(root, 'home');
    const commandsDir = path.join(home, '.claude', 'commands');
    const skillDir = path.join(home, '.claude', 'skills', 'global-only');

    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    try {
      await mkdir(commandsDir, { recursive: true });
      await mkdir(skillDir, { recursive: true });
      await writeFile(path.join(commandsDir, 'global-command.md'), '# Global command\n', 'utf8');
      await writeFile(
        path.join(skillDir, 'SKILL.md'),
        '---\ndescription: available without a project\n---\n\nbody\n',
        'utf8',
      );

      const commands = await scanClaudeSlashCommands();

      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'global-command',
          source: 'user',
          scope: 'global',
        }),
        expect.objectContaining({
          name: 'global-only',
          description: 'available without a project',
          source: 'skill',
          scope: 'global',
        }),
      ]));
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('includes skill directories that are symlinked into the global Claude skills root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-palette-'));
    const home = path.join(root, 'home');
    const workingDir = path.join(root, 'work');
    const targetSkill = path.join(root, 'shared-skills', 'shared-global');
    const linkedSkill = path.join(home, '.claude', 'skills', 'shared-global');

    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    try {
      await mkdir(targetSkill, { recursive: true });
      await mkdir(path.dirname(linkedSkill), { recursive: true });
      await mkdir(workingDir, { recursive: true });
      await writeFile(
        path.join(targetSkill, 'SKILL.md'),
        '---\ndescription: shared skill\n---\n\nbody\n',
        'utf8',
      );
      await symlink(targetSkill, linkedSkill, process.platform === 'win32' ? 'junction' : 'dir');

      const commands = await scanClaudeSlashCommands(workingDir);

      expect(commands).toContainEqual(expect.objectContaining({
        name: 'shared-global',
        description: 'shared skill',
        source: 'skill',
        scope: 'global',
      }));
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('parses YAML block-scalar descriptions with chomping indicators (>- / |-)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-palette-'));
    const home = path.join(root, 'home');
    const workingDir = path.join(root, 'work');
    const skillsDir = path.join(workingDir, '.claude', 'skills');

    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    try {
      await mkdir(workingDir, { recursive: true });
      await mkdir(path.join(skillsDir, 'folded'), { recursive: true });
      await writeFile(
        path.join(skillsDir, 'folded', 'SKILL.md'),
        '---\nname: folded\ndescription: >-\n  first folded line\n  second folded line\nversion: 1.0.0\n---\n\nbody\n',
        'utf8',
      );
      await mkdir(path.join(skillsDir, 'literal'), { recursive: true });
      await writeFile(
        path.join(skillsDir, 'literal', 'SKILL.md'),
        '---\ndescription: |-\n  literal line one\n  literal line two\n---\n\nbody\n',
        'utf8',
      );

      const commands = await scanClaudeSlashCommands(workingDir);

      expect(commands).toContainEqual(expect.objectContaining({
        name: 'folded',
        description: 'first folded line second folded line',
      }));
      expect(commands).toContainEqual(expect.objectContaining({
        name: 'literal',
        description: 'literal line one\nliteral line two',
      }));
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
});
