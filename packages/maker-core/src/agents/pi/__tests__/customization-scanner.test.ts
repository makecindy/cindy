import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildPiSources, scanPiCustomizations } from '../customization-scanner.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-customizations-'));
  roots.push(root);
  return root;
}

function writeSkill(root: string, relativeDir: string, name: string): string {
  const skillDir = path.join(root, relativeDir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} description\n---\n# ${name}\n`,
  );
  return skillDir;
}

function canonical(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function projectItems(result: Awaited<ReturnType<typeof scanPiCustomizations>>) {
  return result.items.filter((item) => item.scope === 'repo');
}

describe('scanPiCustomizations', () => {
  it('keeps only the shared user skill root', () => {
    const userSources = buildPiSources([]).filter((source) => source.scope === 'user');

    expect(userSources.map((source) => source.dir)).toEqual([
      path.join(homedir(), '.agents', 'skills'),
    ]);
    expect(userSources.some((source) => source.dir.includes(path.join('.pi', 'agent')))).toBe(false);
  });

  it('discovers .pi/skills and .agents/skills through the nearest Git root', async () => {
    const root = tempRoot();
    const repo = path.join(root, 'repo');
    const cwd = path.join(repo, 'packages', 'app');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const piSkill = writeSkill(cwd, path.join('.pi', 'skills'), 'pi-project');
    const localShared = writeSkill(cwd, path.join('.agents', 'skills'), 'local-shared');
    const ancestorShared = writeSkill(repo, path.join('.agents', 'skills'), 'ancestor-shared');
    writeSkill(root, path.join('.agents', 'skills'), 'above-repo');
    writeSkill(cwd, path.join('.pi', 'agent', 'skills'), 'legacy-path');

    const result = await scanPiCustomizations({ workingDirs: [cwd] });
    const items = projectItems(result);

    expect(items.map((item) => canonical(item.absolutePath))).toEqual(expect.arrayContaining([
      canonical(piSkill),
      canonical(localShared),
      canonical(ancestorShared),
    ]));
    expect(items.map((item) => item.name)).not.toContain('above-repo');
    expect(items.map((item) => item.name)).not.toContain('legacy-path');
    expect(items.every((item) => item.runtimeStatus === 'discovered')).toBe(true);
    expect(items.every((item) => item.workingDir === canonical(cwd))).toBe(true);
  });

  it('stops ancestor discovery at a nested repository root', async () => {
    const root = tempRoot();
    const outer = path.join(root, 'outer');
    const nested = path.join(outer, 'nested');
    const cwd = path.join(nested, 'src');
    mkdirSync(path.join(outer, '.git'), { recursive: true });
    mkdirSync(path.join(nested, '.git'), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeSkill(outer, path.join('.agents', 'skills'), 'outer-skill');
    writeSkill(nested, path.join('.agents', 'skills'), 'nested-skill');

    const result = await scanPiCustomizations({ workingDirs: [cwd] });
    const names = projectItems(result).map((item) => item.name);

    expect(names).toContain('nested-skill');
    expect(names).not.toContain('outer-skill');
  });

  it('treats a worktree-style .git file as the repository boundary', async () => {
    const root = tempRoot();
    const repo = path.join(root, 'worktree');
    const cwd = path.join(repo, 'src');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(path.join(repo, '.git'), 'gitdir: /tmp/example-git-dir\n');
    writeSkill(repo, path.join('.agents', 'skills'), 'worktree-skill');
    writeSkill(root, path.join('.agents', 'skills'), 'above-worktree');

    const result = await scanPiCustomizations({ workingDirs: [cwd] });
    const names = projectItems(result).map((item) => item.name);

    expect(names).toContain('worktree-skill');
    expect(names).not.toContain('above-worktree');
  });

  it('scans only the working directory .agents path outside Git repositories', async () => {
    const root = tempRoot();
    const cwd = path.join(root, 'parent', 'cwd');
    mkdirSync(cwd, { recursive: true });
    writeSkill(root, path.join('parent', '.agents', 'skills'), 'parent-skill');
    writeSkill(cwd, path.join('.agents', 'skills'), 'cwd-skill');

    const result = await scanPiCustomizations({ workingDirs: [cwd] });
    const names = projectItems(result).map((item) => item.name);

    expect(names).toContain('cwd-skill');
    expect(names).not.toContain('parent-skill');
  });

  it('handles a Git root working directory and missing skill directories', async () => {
    const root = tempRoot();
    const repo = path.join(root, 'repo');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    writeSkill(repo, path.join('.agents', 'skills'), 'root-skill');

    const result = await scanPiCustomizations({ workingDirs: [repo] });

    expect(projectItems(result).filter((item) => item.name === 'root-skill')).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  it('returns an empty project result when every project skill directory is missing', async () => {
    const root = tempRoot();
    const repo = path.join(root, 'repo');
    const cwd = path.join(repo, 'src');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    mkdirSync(cwd, { recursive: true });

    const result = await scanPiCustomizations({ workingDirs: [cwd] });

    expect(projectItems(result)).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('keeps same-name skills from distinct project sources', async () => {
    const root = tempRoot();
    const repo = path.join(root, 'repo');
    const cwd = path.join(repo, 'src');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const first = writeSkill(repo, path.join('.agents', 'skills'), 'duplicate');
    const second = writeSkill(cwd, path.join('.pi', 'skills'), 'duplicate');

    const result = await scanPiCustomizations({ workingDirs: [cwd] });
    const duplicates = projectItems(result).filter((item) => item.name === 'duplicate');

    expect(duplicates.map((item) => canonical(item.absolutePath))).toEqual(
      [canonical(first), canonical(second)].sort(),
    );
  });

  it.skipIf(process.platform === 'win32')('resolves a symlinked working directory before finding the Git root', async () => {
    const root = tempRoot();
    const repo = path.join(root, 'repo');
    const physicalCwd = path.join(repo, 'src');
    const linkedCwd = path.join(root, 'linked-cwd');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    mkdirSync(physicalCwd, { recursive: true });
    symlinkSync(physicalCwd, linkedCwd, 'dir');
    writeSkill(repo, path.join('.agents', 'skills'), 'repo-skill');

    const result = await scanPiCustomizations({ workingDirs: [linkedCwd] });
    const found = projectItems(result).find((item) => item.name === 'repo-skill');

    expect(found?.workingDir).toBe(canonical(physicalCwd));
  });
});
