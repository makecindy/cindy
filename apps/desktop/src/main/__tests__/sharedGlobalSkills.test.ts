import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  prepareSharedGlobalSkillLinks,
  prepareSharedProjectSkillLinks,
  projectWorkingDirFromSkillPath,
  sharedGlobalSkillsPaths,
  sharedProjectSkillsPaths,
} from '../maker-host/shared-global-skills';

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-global-skills-'));
  tmpDirs.push(dir);
  return dir;
}

async function writeSkill(skillsDir: string, name: string): Promise<string> {
  const skillDir = path.join(skillsDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test skill\n---\n\nbody\n`,
    'utf8',
  );
  return skillDir;
}

async function sameRealPath(a: string, b: string): Promise<boolean> {
  const [ra, rb] = await Promise.all([fs.realpath(a), fs.realpath(b)]);
  const normalize = (value: string) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(ra) === normalize(rb);
}

afterEach(async () => {
  const dirs = tmpDirs;
  tmpDirs = [];
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('prepareSharedGlobalSkillLinks', () => {
  it('links existing Claude skills into the shared skills root for Codex visibility', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const claudeSkill = await writeSkill(paths.claudeSkillsDir, 'claude-only');

    const result = await prepareSharedGlobalSkillLinks({ homeDir });

    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(await sameRealPath(path.join(paths.sharedSkillsDir, 'claude-only'), claudeSkill)).toBe(true);
  });

  it('stops before the next shared-root write when the owner changes mid-fanout', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    await writeSkill(paths.claudeSkillsDir, 'a-first');
    await writeSkill(paths.claudeSkillsDir, 'b-second');

    let ownerStable = true;
    const realSymlink = fs.symlink;
    const symlinkSpy = vi.spyOn(fs, 'symlink').mockImplementation(async (...args) => {
      await realSymlink(...args);
      ownerStable = false;
    });
    try {
      await expect(
        prepareSharedGlobalSkillLinks({
          homeDir,
          assertOwnerStable: () => {
            if (!ownerStable) throw new Error('owner changed');
          },
        }),
      ).rejects.toThrow('owner changed');
    } finally {
      symlinkSpy.mockRestore();
    }

    expect(await sameRealPath(
      path.join(paths.sharedSkillsDir, 'a-first'),
      path.join(paths.claudeSkillsDir, 'a-first'),
    )).toBe(true);
    await expect(fs.lstat(path.join(paths.sharedSkillsDir, 'b-second'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('links shared skills into Claude skills so Claude Code can load them', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const sharedSkill = await writeSkill(paths.sharedSkillsDir, 'shared-only');

    const result = await prepareSharedGlobalSkillLinks({ homeDir });

    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(await sameRealPath(path.join(paths.claudeSkillsDir, 'shared-only'), sharedSkill)).toBe(true);
  });

  it('links existing Codex skills into Claude without creating a shared duplicate', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const codexSkill = await writeSkill(paths.codexSkillsDir, 'codex-only');

    await prepareSharedGlobalSkillLinks({ homeDir });
    const secondResult = await prepareSharedGlobalSkillLinks({ homeDir });

    expect(secondResult.changed).toBe(false);
    expect(secondResult.warnings).toEqual([]);
    expect(await sameRealPath(path.join(paths.claudeSkillsDir, 'codex-only'), codexSkill)).toBe(true);
    await expect(fs.lstat(path.join(paths.sharedSkillsDir, 'codex-only'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not overwrite conflicting real skill directories', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const sharedSkill = await writeSkill(paths.sharedSkillsDir, 'duplicate');
    const claudeSkill = await writeSkill(paths.claudeSkillsDir, 'duplicate');

    const result = await prepareSharedGlobalSkillLinks({ homeDir });

    expect(result.warnings.some((warning) => warning.includes('duplicate'))).toBe(true);
    expect(await sameRealPath(path.join(paths.sharedSkillsDir, 'duplicate'), sharedSkill)).toBe(true);
    expect(await sameRealPath(path.join(paths.claudeSkillsDir, 'duplicate'), claudeSkill)).toBe(true);
    expect(await sameRealPath(path.join(paths.sharedSkillsDir, 'duplicate'), path.join(paths.claudeSkillsDir, 'duplicate'))).toBe(false);
  });

  it('does not overwrite user-owned symlinks that point elsewhere', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const sharedSkill = await writeSkill(paths.sharedSkillsDir, 'user-link');
    const externalSkill = await writeSkill(path.join(root, 'external-skills'), 'user-link');
    const claudeLink = path.join(paths.claudeSkillsDir, 'user-link');
    await fs.mkdir(paths.claudeSkillsDir, { recursive: true });
    await fs.symlink(externalSkill, claudeLink, process.platform === 'win32' ? 'junction' : 'dir');

    const result = await prepareSharedGlobalSkillLinks({ homeDir });

    expect(result.warnings.some((warning) => warning.includes('user-link'))).toBe(true);
    expect(await sameRealPath(claudeLink, externalSkill)).toBe(true);
    expect(await sameRealPath(claudeLink, sharedSkill)).toBe(false);
  });

  it('cleans up broken managed links after the source skill is removed', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const claudeSkill = await writeSkill(paths.claudeSkillsDir, 'removed-later');

    await prepareSharedGlobalSkillLinks({ homeDir });
    expect(await sameRealPath(path.join(paths.sharedSkillsDir, 'removed-later'), claudeSkill)).toBe(true);

    await fs.rm(claudeSkill, { recursive: true, force: true });
    const result = await prepareSharedGlobalSkillLinks({ homeDir });

    expect(result.changed).toBe(true);
    await expect(fs.lstat(path.join(paths.sharedSkillsDir, 'removed-later'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('prepareSharedProjectSkillLinks', () => {
  it('exposes a legacy Claude project skill to Codex without copying it', async () => {
    const workingDir = await makeTmpDir();
    const paths = sharedProjectSkillsPaths(workingDir);
    const claudeSkill = await writeSkill(paths.claudeSkillsDir, 'legacy');

    const result = await prepareSharedProjectSkillLinks({ workingDir });
    const sharedLink = path.join(paths.sharedSkillsDir, 'legacy');

    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect((await fs.lstat(sharedLink)).isSymbolicLink()).toBe(true);
    expect(await sameRealPath(sharedLink, claudeSkill)).toBe(true);
    if (process.platform !== 'win32') {
      expect(path.isAbsolute(await fs.readlink(sharedLink))).toBe(false);
    }
  });

  it('exposes a canonical shared project skill to Claude without copying it', async () => {
    const workingDir = await makeTmpDir();
    const paths = sharedProjectSkillsPaths(workingDir);
    const sharedSkill = await writeSkill(paths.sharedSkillsDir, 'shared');

    const result = await prepareSharedProjectSkillLinks({ workingDir });
    const claudeLink = path.join(paths.claudeSkillsDir, 'shared');

    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect((await fs.lstat(claudeLink)).isSymbolicLink()).toBe(true);
    expect(await sameRealPath(claudeLink, sharedSkill)).toBe(true);
  });

  it('does not create empty discovery roots when the project has no skills', async () => {
    const workingDir = await makeTmpDir();
    const paths = sharedProjectSkillsPaths(workingDir);

    const result = await prepareSharedProjectSkillLinks({ workingDir });

    expect(result).toMatchObject({ changed: false, actions: [], warnings: [] });
    await expect(fs.lstat(paths.sharedSkillsDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(paths.claudeSkillsDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps conflicting real project skills on both sides', async () => {
    const workingDir = await makeTmpDir();
    const paths = sharedProjectSkillsPaths(workingDir);
    const sharedSkill = await writeSkill(paths.sharedSkillsDir, 'duplicate');
    const claudeSkill = await writeSkill(paths.claudeSkillsDir, 'duplicate');

    const result = await prepareSharedProjectSkillLinks({ workingDir });

    expect(result.warnings.some((warning) => warning.includes('duplicate'))).toBe(true);
    expect(await sameRealPath(path.join(paths.sharedSkillsDir, 'duplicate'), sharedSkill)).toBe(true);
    expect(await sameRealPath(path.join(paths.claudeSkillsDir, 'duplicate'), claudeSkill)).toBe(true);
    expect(await sameRealPath(sharedSkill, claudeSkill)).toBe(false);
  });

  it('repairs a broken absolute project link after the checkout moves', async () => {
    const root = await makeTmpDir();
    const oldWorkingDir = path.join(root, 'old-checkout');
    const workingDir = path.join(root, 'moved-checkout');
    const oldPaths = sharedProjectSkillsPaths(oldWorkingDir);
    const paths = sharedProjectSkillsPaths(workingDir);
    const claudeSkill = await writeSkill(paths.claudeSkillsDir, 'moved-skill');
    const staleSharedLink = path.join(paths.sharedSkillsDir, 'moved-skill');
    await fs.mkdir(paths.sharedSkillsDir, { recursive: true });
    await fs.symlink(
      path.join(oldPaths.claudeSkillsDir, 'moved-skill'),
      staleSharedLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await prepareSharedProjectSkillLinks({ workingDir });

    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(await sameRealPath(staleSharedLink, claudeSkill)).toBe(true);
  });

  it('does not replace an unrelated broken project skill symlink', async () => {
    const root = await makeTmpDir();
    const workingDir = path.join(root, 'checkout');
    const paths = sharedProjectSkillsPaths(workingDir);
    await writeSkill(paths.claudeSkillsDir, 'user-link');
    const userLink = path.join(paths.sharedSkillsDir, 'user-link');
    const externalTarget = path.join(root, 'removed-external-skills', 'user-link');
    await fs.mkdir(paths.sharedSkillsDir, { recursive: true });
    await fs.symlink(
      externalTarget,
      userLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await prepareSharedProjectSkillLinks({ workingDir });

    expect(result.changed).toBe(false);
    expect(result.warnings.some((warning) => warning.includes('user-link'))).toBe(true);
    expect(await fs.readlink(userLink)).toBe(externalTarget);
  });
});

describe('projectWorkingDirFromSkillPath', () => {
  it('accepts only direct project skill discovery children', () => {
    const projectRoot = path.resolve(path.sep, 'projects', 'demo');
    expect(
      projectWorkingDirFromSkillPath(
        path.join(projectRoot, '.agents', 'skills', 'my-skill'),
      ),
    ).toBe(projectRoot);
    expect(
      projectWorkingDirFromSkillPath(
        path.join(projectRoot, '.claude', 'skills', 'my-skill'),
      ),
    ).toBe(projectRoot);
    expect(projectWorkingDirFromSkillPath(path.join(projectRoot, 'skills', 'my-skill')))
      .toBeNull();
  });
});
