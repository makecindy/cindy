import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  collectPiProjectResourceCliPaths,
  filterPiProjectCliSkills,
  piProjectResourceCliArgs,
} from '../project-resource-cli.js';

describe('collectPiProjectResourceCliPaths', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function makeRepo(): string {
    root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-cli-')));
    mkdirSync(path.join(root, '.git'));
    return root;
  }

  it('collects in-repo skills, prompts and extensions', () => {
    const repo = makeRepo();
    const skillDir = path.join(repo, '.pi', 'skills', 'demo');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), '# demo\n');
    const agentsSkill = path.join(repo, '.agents', 'skills', 'repo-skill');
    mkdirSync(agentsSkill, { recursive: true });
    writeFileSync(path.join(agentsSkill, 'SKILL.md'), '# repo\n');
    mkdirSync(path.join(repo, '.pi', 'prompts'), { recursive: true });
    writeFileSync(path.join(repo, '.pi', 'prompts', 'review.md'), '# review\n');
    mkdirSync(path.join(repo, '.pi', 'extensions'), { recursive: true });
    writeFileSync(path.join(repo, '.pi', 'extensions', 'hook.ts'), 'export default () => {};\n');
    mkdirSync(path.join(repo, '.pi', 'extensions', 'nested'));
    writeFileSync(path.join(repo, '.pi', 'extensions', 'nested', 'index.ts'), 'export default () => {};\n');

    const collected = collectPiProjectResourceCliPaths(repo);
    expect(collected.skills).toEqual([
      realpathSync(agentsSkill),
      realpathSync(skillDir),
    ].sort((a, b) => a.localeCompare(b)));
    expect(collected.promptTemplates).toEqual([realpathSync(path.join(repo, '.pi', 'prompts', 'review.md'))]);
    expect(collected.extensions).toEqual([
      realpathSync(path.join(repo, '.pi', 'extensions', 'hook.ts')),
      realpathSync(path.join(repo, '.pi', 'extensions', 'nested', 'index.ts')),
    ].sort((a, b) => a.localeCompare(b)));
    expect(piProjectResourceCliArgs(collected)).toEqual([
      ...collected.skills.flatMap((skillPath) => ['--skill', skillPath]),
      '--prompt-template', collected.promptTemplates[0],
      ...collected.extensions.flatMap((extensionPath) => ['--extension', extensionPath]),
    ]);
  });

  it('collects skills whose entry file is skill.md', () => {
    const repo = makeRepo();
    const skillDir = path.join(repo, '.pi', 'skills', 'lower');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'skill.md'), '# lower\n');
    expect(collectPiProjectResourceCliPaths(repo).skills).toEqual([realpathSync(skillDir)]);
  });

  it('skips escaped symlinks and settings files', () => {
    const repo = makeRepo();
    const outside = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-cli-out-')));
    try {
      mkdirSync(path.join(outside, 'evil-skill'));
      writeFileSync(path.join(outside, 'evil-skill', 'SKILL.md'), '# evil\n');
      mkdirSync(path.join(repo, '.pi', 'skills'), { recursive: true });
      symlinkSync(path.join(outside, 'evil-skill'), path.join(repo, '.pi', 'skills', 'escaped'));
      mkdirSync(path.join(repo, '.pi'), { recursive: true });
      writeFileSync(path.join(repo, '.pi', 'settings.json'), '{"compaction":{"enabled":false}}\n');

      const collected = collectPiProjectResourceCliPaths(repo);
      expect(collected.skills).toEqual([]);
      expect(collected.promptTemplates).toEqual([]);
      expect(collected.extensions).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not walk .agents/skills past the nearest git root', () => {
    const repo = makeRepo();
    const nested = path.join(repo, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    mkdirSync(path.join(nested, '.git'));
    const outerSkill = path.join(repo, '.agents', 'skills', 'outer');
    mkdirSync(outerSkill, { recursive: true });
    writeFileSync(path.join(outerSkill, 'SKILL.md'), '# outer\n');
    const innerSkill = path.join(nested, '.pi', 'skills', 'inner');
    mkdirSync(innerSkill, { recursive: true });
    writeFileSync(path.join(innerSkill, 'SKILL.md'), '# inner\n');

    expect(collectPiProjectResourceCliPaths(nested).skills).toEqual([realpathSync(innerSkill)]);
  });

  it('filters disabled skill directories', () => {
    const repo = makeRepo();
    const skillDir = path.join(repo, '.pi', 'skills', 'demo');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), '# demo\n');
    const realSkill = realpathSync(skillDir);
    expect(filterPiProjectCliSkills([realSkill], [path.join(realSkill, 'SKILL.md')])).toEqual([]);
    expect(filterPiProjectCliSkills([realSkill], [])).toEqual([realSkill]);
  });
});
