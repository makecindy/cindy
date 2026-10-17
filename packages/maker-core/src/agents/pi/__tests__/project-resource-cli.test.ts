import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertPiSpawnArgvFitsPlatform,
  collectPiProjectResourceCliPaths,
  comparePiResourcePaths,
  estimateSpawnArgvLength,
  filterPiProjectCliSkills,
  PI_POSIX_SPAWN_ARGV_BUDGET,
  PI_WINDOWS_SPAWN_ARGV_BUDGET,
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

  it('collects nested namespace skills and prunes generated trees', () => {
    const repo = makeRepo();
    const piNested = path.join(repo, '.pi', 'skills', '@scope', 'pi-nested');
    const agentsNested = path.join(repo, '.agents', 'skills', '@scope', 'agents-nested');
    const tooDeep = path.join(repo, '.pi', 'skills', '@scope', 'group', 'too-deep');
    const pruned = path.join(repo, '.pi', 'skills', 'dist', 'hidden');
    for (const skillDir of [piNested, agentsNested, tooDeep, pruned]) {
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(path.join(skillDir, 'SKILL.md'), '# nested\n');
    }

    const collected = collectPiProjectResourceCliPaths(repo);

    expect(collected.skills).toEqual([
      realpathSync(agentsNested),
      realpathSync(piNested),
    ].sort((a, b) => a.localeCompare(b)));
    expect(collected.skills).not.toContain(realpathSync(tooDeep));
  });

  it('skips escaped symlinks and settings files', () => {
    const repo = makeRepo();
    const outside = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-cli-out-')));
    try {
      mkdirSync(path.join(outside, 'evil-skill'));
      writeFileSync(path.join(outside, 'evil-skill', 'SKILL.md'), '# evil\n');
      mkdirSync(path.join(repo, '.pi', 'skills'), { recursive: true });
      symlinkSync(path.join(outside, 'evil-skill'), path.join(repo, '.pi', 'skills', 'escaped'), process.platform === 'win32' ? 'junction' : 'dir');
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

  it('keeps a direct Skill whose folder name matches a pruned directory', () => {
    const repo = makeRepo();
    const directDist = path.join(repo, '.pi', 'skills', 'dist');
    const nested = path.join(repo, '.pi', 'skills', 'node_modules', 'ignored');
    for (const skillDir of [directDist, nested]) {
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(path.join(skillDir, 'SKILL.md'), '# direct\n');
    }

    expect(collectPiProjectResourceCliPaths(repo).skills).toEqual([realpathSync(directDist)]);
  });

  it('does not walk a symlinked namespace inside the repo', () => {
    const repo = makeRepo();
    const externalNamespace = path.join(repo, 'external-ns');
    const nestedSkill = path.join(externalNamespace, 'nested');
    mkdirSync(nestedSkill, { recursive: true });
    writeFileSync(path.join(nestedSkill, 'SKILL.md'), '# linked\n');
    const link = path.join(repo, '.pi', 'skills', 'linked-ns');
    mkdirSync(path.dirname(link), { recursive: true });
    try {
      symlinkSync(externalNamespace, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }

    expect(collectPiProjectResourceCliPaths(repo).skills).toEqual([]);
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

describe('pi project resource path order and spawn argv budget', () => {
  it('orders paths by code units so locale cannot change Skill precedence', () => {
    expect(['b', 'A'].sort(comparePiResourcePaths)).toEqual(['A', 'b']);
  });

  it('rejects an oversized Windows command line before spawn', () => {
    const args = Array.from(
      { length: 400 },
      (_, index) => `C:\\Users\\very\\long\\cindy\\project\\.pi\\skills\\skill-${String(index).padStart(3, '0')}\\with\\nested\\folders`,
    );
    expect(estimateSpawnArgvLength(args)).toBeGreaterThan(PI_WINDOWS_SPAWN_ARGV_BUDGET);
    expect(estimateSpawnArgvLength(args)).toBeLessThan(PI_POSIX_SPAWN_ARGV_BUDGET);
    expect(() => assertPiSpawnArgvFitsPlatform(args, 'win32')).toThrow(/too many Pi skills/);
    expect(() => assertPiSpawnArgvFitsPlatform(args, 'darwin')).not.toThrow();
  });

  it('rejects an oversized POSIX command line before spawn', () => {
    const args = Array.from(
      { length: 2_000 },
      (_, index) => `/Users/very/long/cindy/project/.pi/skills/skill-${String(index).padStart(4, '0')}/with/nested/folders`,
    );
    expect(estimateSpawnArgvLength(args)).toBeGreaterThan(PI_POSIX_SPAWN_ARGV_BUDGET);
    expect(() => assertPiSpawnArgvFitsPlatform(args, 'darwin')).toThrow(/too many Pi skills/);
    expect(() => assertPiSpawnArgvFitsPlatform(args, 'linux')).toThrow(/too many Pi skills/);
  });
});
