import os from 'node:os';
import path from 'node:path';
import { Dirent, promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../shared/ghost';

import {
  CODEX_LEGACY_CODEX_SKILLS_LINK_NAME,
  CODEX_SHARED_AGENTS_SKILLS_LINK_NAME,
  codexDisabledSkillPathsForOwner,
  codexGlobalSkillsPaths,
  prepareCodexGlobalSkillsLinks,
  readCodexAgentsProjectionIdentity,
} from '../maker-host/codex-global-skills';

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-global-skills-'));
  tmpDirs.push(dir);
  return dir;
}

async function writeSkill(skillsDir: string, name: string): Promise<void> {
  const skillDir = path.join(skillsDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test skill\n---\n\nbody\n`,
    'utf8',
  );
}

async function writeInstalledGhostSkill(
  ownerRoot: string,
  ghostId: string,
  item: { dir: string; name: string },
  repositoryName: 'cindy-brain' | 'brain' = 'cindy-brain',
): Promise<string> {
  const ghostDir = path.join(ownerRoot, repositoryName, ghostId);
  const skillDir = path.join(ghostDir, ...item.dir.split('/'));
  await writeSkill(path.dirname(skillDir), path.basename(skillDir));
  await fs.writeFile(
    path.join(ghostDir, 'ghost.json'),
    JSON.stringify({
      schemaVersion: 2,
      id: ghostId,
      name: ghostId,
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: ['skill'],
      skill: {
        items: [{ ...item, description: 'test skill' }],
      },
    }),
    'utf8',
  );
  return skillDir;
}

async function writeApprovedGhostSkills(
  ownerRoot: string,
  ghostId: string,
  items: ReadonlyArray<{ dir: string; name: string }>,
  revision = '00000000-0000-4000-8000-000000000001',
): Promise<{ ghost: InstalledGhost; skillDirs: Map<string, string> }> {
  const approvedSkillRoot = path.join(
    ownerRoot,
    'ghost-install-state',
    'skill-snapshots',
    ghostId,
    revision,
  );
  const skillDirs = new Map<string, string>();
  for (const item of items) {
    const skillDir = path.join(approvedSkillRoot, ...item.dir.split('/'));
    await writeSkill(path.dirname(skillDir), path.basename(skillDir));
    skillDirs.set(item.name, skillDir);
  }
  return {
    ghost: {
      manifest: {
        schemaVersion: 2,
        id: ghostId,
        name: ghostId,
        version: '1.0.0',
        kind: 'chip',
        entry: 'main.js',
        slots: ['skill'],
        skill: {
          items: items.map((item) => ({ ...item, description: 'test skill' })),
        },
      },
      dir: path.join(ownerRoot, 'cindy-brain', ghostId),
      enabled: true,
      approval: { state: 'approved', revision },
      approvedSkillRoot,
    },
    skillDirs,
  };
}

function approvedGhostSkills(
  ghosts: readonly InstalledGhost[],
  validateApprovedSkillSnapshot: (ghost: InstalledGhost) => Promise<boolean> = async () => true,
) {
  return { ghosts, validateApprovedSkillSnapshot };
}

async function sameRealPath(a: string, b: string): Promise<boolean> {
  const [ra, rb] = await Promise.all([fs.realpath(a), fs.realpath(b)]);
  const normalize = (value: string) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(ra) === normalize(rb);
}

async function linkDirectory(target: string, link: string): Promise<void> {
  await fs.mkdir(path.dirname(link), { recursive: true });
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

afterEach(async () => {
  const dirs = tmpDirs;
  tmpDirs = [];
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('prepareCodexGlobalSkillsLinks', () => {
  it('disables foreign Ghost paths reported through Codex native global discovery', async () => {
    const root = await makeTmpDir();
    const agentsSkills = path.join(root, 'home', '.agents', 'skills');
    const ownerARoot = path.join(root, 'user-data', 'owners', 'owner-a');
    const ownerBRoot = path.join(root, 'user-data', 'owners', 'owner-b');
    const ownerAApproved = await writeApprovedGhostSkills(ownerARoot, 'ghost-a', [
      { dir: 'skills/profile-a', name: 'profile-a' },
    ]);
    const ownerBApproved = await writeApprovedGhostSkills(ownerBRoot, 'ghost-b', [
      { dir: 'skills/profile-b', name: 'profile-b' },
    ]);
    const ownerASkill = ownerAApproved.skillDirs.get('profile-a')!;
    const ownerBSkill = ownerBApproved.skillDirs.get('profile-b')!;
    const ownerALegacySkill = path.join(ownerARoot, 'brain', 'ghost-old', 'skills', 'legacy-a');
    const ownerANonstandardSkill = path.join(
      ownerARoot,
      'cindy-brain',
      'ghost-custom',
      'agent-skills',
      'custom-a',
    );
    const ownerALink = path.join(agentsSkills, 'ghost-a--profile-a');
    const ownerBLink = path.join(agentsSkills, 'ghost-b--profile-b');
    const ownerALegacyLink = path.join(agentsSkills, 'ghost-old--legacy-a');
    const ownerANonstandardLink = path.join(agentsSkills, 'ghost-custom--custom-a');
    const globalSkill = path.join(agentsSkills, 'humanizer-zh');

    await writeSkill(path.dirname(ownerALegacySkill), path.basename(ownerALegacySkill));
    await writeSkill(path.dirname(ownerANonstandardSkill), path.basename(ownerANonstandardSkill));
    await writeSkill(agentsSkills, 'humanizer-zh');
    await linkDirectory(ownerASkill, ownerALink);
    await linkDirectory(ownerBSkill, ownerBLink);
    await linkDirectory(ownerALegacySkill, ownerALegacyLink);
    await linkDirectory(ownerANonstandardSkill, ownerANonstandardLink);

    const reportedSkills = [
      { path: path.join(ownerALink, 'SKILL.md') },
      { path: path.join(ownerBLink, 'SKILL.md') },
      { path: path.join(ownerALegacyLink, 'SKILL.md') },
      { path: path.join(ownerANonstandardLink, 'SKILL.md') },
      { path: path.join(globalSkill, 'SKILL.md') },
    ];
    await expect(
      codexDisabledSkillPathsForOwner(reportedSkills, {
        ownerRoot: ownerBRoot,
        approvedGhostSkills: approvedGhostSkills([ownerBApproved.ghost]),
      }),
    ).resolves.toEqual(
      [ownerALink, ownerALegacyLink, ownerANonstandardLink]
        .map((link) => path.join(link, 'SKILL.md'))
        .sort(),
    );
    await expect(codexDisabledSkillPathsForOwner(reportedSkills)).resolves.toEqual(
      [ownerALink, ownerALegacyLink, ownerANonstandardLink, ownerBLink]
        .map((link) => path.join(link, 'SKILL.md'))
        .sort(),
    );
  });

  it('quarantines deferred Ghost links from verified shared legacy roots', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    const userDataRoot = path.join(root, 'user-data');
    const ownerRoot = path.join(userDataRoot, 'owners', 'owner-b');
    const legacyCindySkill = path.join(
      userDataRoot,
      'cindy-brain',
      'ghost-a',
      'skills',
      'profile-a',
    );
    const legacyBrainSkill = path.join(userDataRoot, 'brain', 'ghost-b', 'skills', 'profile-b');
    const unrelatedBrainSkill = path.join(root, 'work', 'brain', 'acme', 'deploy');
    const unrelatedCindySkill = path.join(
      root,
      'other-user-data',
      'cindy-brain',
      'ghost-c',
      'skills',
      'outside',
    );
    const legacyCindyLink = path.join(agentsSkills, 'ghost-a--profile-a');
    const legacyBrainLink = path.join(agentsSkills, 'ghost-b--profile-b');
    const unrelatedBrainLink = path.join(agentsSkills, 'acme--deploy');
    const unrelatedCindyLink = path.join(agentsSkills, 'ghost-c--outside');

    await fs.mkdir(ownerRoot, { recursive: true });
    for (const skillDir of [
      legacyCindySkill,
      legacyBrainSkill,
      unrelatedBrainSkill,
      unrelatedCindySkill,
    ]) {
      await writeSkill(path.dirname(skillDir), path.basename(skillDir));
    }
    await linkDirectory(legacyCindySkill, legacyCindyLink);
    await linkDirectory(legacyBrainSkill, legacyBrainLink);
    await linkDirectory(unrelatedBrainSkill, unrelatedBrainLink);
    await linkDirectory(unrelatedCindySkill, unrelatedCindyLink);

    const reportedSkills = [
      legacyCindyLink,
      legacyBrainLink,
      unrelatedBrainLink,
      unrelatedCindyLink,
    ].map((link) => ({ path: path.join(link, 'SKILL.md') }));
    await expect(codexDisabledSkillPathsForOwner(reportedSkills, { ownerRoot })).resolves.toEqual(
      [legacyCindyLink, legacyBrainLink].map((link) => path.join(link, 'SKILL.md')).sort(),
    );

    const result = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir, ownerRoot });
    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    expect(result.warnings).toEqual([]);
    for (const linkName of ['ghost-a--profile-a', 'ghost-b--profile-b']) {
      await expect(
        fs.lstat(path.join(paths.sharedAgentsSkillsLink, linkName)),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
    expect(
      await sameRealPath(
        path.join(paths.sharedAgentsSkillsLink, 'acme--deploy'),
        unrelatedBrainSkill,
      ),
    ).toBe(true);
    expect(
      await sameRealPath(
        path.join(paths.sharedAgentsSkillsLink, 'ghost-c--outside'),
        unrelatedCindySkill,
      ),
    ).toBe(true);
  });

  it('keeps ordinary global Skills whose paths merely contain a brain segment', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    const ownerARoot = path.join(root, 'user-data', 'owners', 'owner-a');
    const ownerBRoot = path.join(root, 'user-data', 'owners', 'owner-b');
    const ownerASkill = await writeInstalledGhostSkill(ownerARoot, 'ghost-a', {
      dir: 'skills/profile-a',
      name: 'profile-a',
    });
    const ordinarySkill = path.join(root, 'work', 'brain', 'acme', 'deploy');
    const ownerALink = path.join(agentsSkills, 'ghost-a--profile-a');
    const ordinaryLink = path.join(agentsSkills, 'acme--deploy');
    await writeSkill(path.dirname(ordinarySkill), path.basename(ordinarySkill));
    await linkDirectory(ownerASkill, ownerALink);
    await linkDirectory(ordinarySkill, ordinaryLink);

    const reportedSkills = [ownerALink, ordinaryLink].map((link) => ({
      path: path.join(link, 'SKILL.md'),
    }));
    await expect(
      codexDisabledSkillPathsForOwner(reportedSkills, { ownerRoot: ownerBRoot }),
    ).resolves.toEqual([path.join(ownerALink, 'SKILL.md')]);

    const result = await prepareCodexGlobalSkillsLinks(codexHome, {
      homeDir,
      ownerRoot: ownerBRoot,
    });
    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    expect(result.warnings).toEqual([]);
    expect(
      await sameRealPath(path.join(paths.sharedAgentsSkillsLink, 'acme--deploy'), ordinarySkill),
    ).toBe(true);
    await expect(
      fs.lstat(path.join(paths.sharedAgentsSkillsLink, 'ghost-a--profile-a')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps ordinary global Skills that mimic an approval snapshot outside Cindy owners root', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    const ownerRoot = path.join(root, 'user-data', 'owners', 'owner-a');
    const ordinarySkill = path.join(
      root,
      'work',
      'owners',
      'vendor',
      'ghost-install-state',
      'skill-snapshots',
      'acme',
      'revision',
      'deploy',
    );
    const ordinaryLink = path.join(agentsSkills, 'acme--deploy');
    await writeSkill(path.dirname(ordinarySkill), path.basename(ordinarySkill));
    await linkDirectory(ordinarySkill, ordinaryLink);

    await expect(
      codexDisabledSkillPathsForOwner([{ path: path.join(ordinaryLink, 'SKILL.md') }], {
        ownerRoot,
      }),
    ).resolves.toEqual([]);

    const result = await prepareCodexGlobalSkillsLinks(codexHome, {
      homeDir,
      ownerRoot,
    });
    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    expect(result.warnings).toEqual([]);
    expect(
      await sameRealPath(path.join(paths.sharedAgentsSkillsLink, 'acme--deploy'), ordinarySkill),
    ).toBe(true);
  });

  it('keeps ordinary global Skills that mimic an owner-scoped legacy path outside Cindy owners root', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    const ownerRoot = path.join(root, 'user-data', 'owners', 'owner-a');
    const ordinarySkill = path.join(
      root,
      'work',
      'owners',
      'vendor',
      'cindy-brain',
      'acme',
      'deploy',
    );
    const ordinaryLink = path.join(agentsSkills, 'acme--deploy');
    await writeSkill(path.dirname(ordinarySkill), path.basename(ordinarySkill));
    await linkDirectory(ordinarySkill, ordinaryLink);

    await expect(
      codexDisabledSkillPathsForOwner([{ path: path.join(ordinaryLink, 'SKILL.md') }], {
        ownerRoot,
      }),
    ).resolves.toEqual([]);

    const result = await prepareCodexGlobalSkillsLinks(codexHome, {
      homeDir,
      ownerRoot,
    });
    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    expect(result.warnings).toEqual([]);
    expect(
      await sameRealPath(path.join(paths.sharedAgentsSkillsLink, 'acme--deploy'), ordinarySkill),
    ).toBe(true);
  });

  it('keeps owner isolation for receipt-backed approval-snapshot links', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    const ownerARoot = path.join(root, 'user-data', 'owners', 'owner-a');
    const ownerBRoot = path.join(root, 'user-data', 'owners', 'owner-b');
    const ownerAApproved = await writeApprovedGhostSkills(ownerARoot, 'ghost-a', [
      { dir: 'agent-skills/profile-a', name: 'profile-a' },
    ]);
    const ownerBApproved = await writeApprovedGhostSkills(ownerBRoot, 'ghost-b', [
      { dir: 'agent-skills/profile-b', name: 'profile-b' },
    ]);
    const ownerASkill = ownerAApproved.skillDirs.get('profile-a')!;
    const ownerBSkill = ownerBApproved.skillDirs.get('profile-b')!;
    const ownerALink = path.join(agentsSkills, 'ghost-a--profile-a');
    const ownerBLink = path.join(agentsSkills, 'ghost-b--profile-b');
    await writeSkill(agentsSkills, 'humanizer-zh');
    await linkDirectory(ownerASkill, ownerALink);
    await linkDirectory(ownerBSkill, ownerBLink);

    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    const result = await prepareCodexGlobalSkillsLinks(codexHome, {
      homeDir,
      ownerRoot: ownerBRoot,
      approvedGhostSkills: approvedGhostSkills([ownerBApproved.ghost]),
    });

    expect(result.warnings).toEqual([]);
    await expect(
      fs.lstat(path.join(paths.sharedAgentsSkillsLink, 'ghost-a--profile-a')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      await sameRealPath(
        path.join(paths.sharedAgentsSkillsLink, 'ghost-b--profile-b'),
        ownerBSkill,
      ),
    ).toBe(true);
    expect(
      await sameRealPath(
        path.join(paths.sharedAgentsSkillsLink, 'humanizer-zh'),
        path.join(agentsSkills, 'humanizer-zh'),
      ),
    ).toBe(true);

    await expect(
      codexDisabledSkillPathsForOwner(
        [ownerALink, ownerBLink].map((link) => ({ path: path.join(link, 'SKILL.md') })),
        {
          ownerRoot: ownerBRoot,
          approvedGhostSkills: approvedGhostSkills([ownerBApproved.ghost]),
        },
      ),
    ).resolves.toEqual([path.join(ownerALink, 'SKILL.md')]);
  });

  it('ignores unrelated ancestor directories containing a managed-link separator', async () => {
    const root = await makeTmpDir();
    const misleadingHome = path.join(root, 'home--not-a-ghost-link');
    const agentsSkills = path.join(misleadingHome, '.agents', 'skills');
    const ownerARoot = path.join(root, 'user-data', 'owners', 'owner-a');
    const ownerBRoot = path.join(root, 'user-data', 'owners', 'owner-b');
    const ownerASkill = path.join(
      ownerARoot,
      'cindy-brain',
      'ghost-a',
      'agent-skills',
      'profile-a',
    );
    const ownerALink = path.join(agentsSkills, 'ghost-a--profile-a');
    const projectedOwnerALink = path.join(
      misleadingHome,
      'codex-home',
      'skills',
      CODEX_SHARED_AGENTS_SKILLS_LINK_NAME,
      'ghost-a--profile-a',
    );
    await writeSkill(path.dirname(ownerASkill), path.basename(ownerASkill));
    await linkDirectory(ownerASkill, ownerALink);
    await linkDirectory(ownerASkill, projectedOwnerALink);

    await expect(
      codexDisabledSkillPathsForOwner(
        [ownerALink, projectedOwnerALink].map((link) => ({
          path: path.join(link, 'SKILL.md'),
        })),
        { ownerRoot: ownerBRoot },
      ),
    ).resolves.toEqual(
      [ownerALink, projectedOwnerALink].map((link) => path.join(link, 'SKILL.md')).sort(),
    );
  });

  it('allows only approved snapshots and disables mutable install-tree targets', async () => {
    const root = await makeTmpDir();
    const agentsSkills = path.join(root, 'home', '.agents', 'skills');
    const ownerRoot = path.join(root, 'user-data', 'owners', 'owner-a');
    const activeSkill = await writeInstalledGhostSkill(ownerRoot, 'active-ghost', {
      dir: 'skills/active',
      name: 'active',
    });
    const legacySkill = await writeInstalledGhostSkill(
      ownerRoot,
      'legacy-ghost',
      { dir: 'skills/legacy', name: 'legacy' },
      'brain',
    );
    const approved = await writeApprovedGhostSkills(ownerRoot, 'approved-ghost', [
      { dir: 'skills/approved', name: 'approved' },
    ]);
    const approvedSkill = approved.skillDirs.get('approved')!;
    const activeLink = path.join(agentsSkills, 'active-ghost--active');
    const legacyLink = path.join(agentsSkills, 'legacy-ghost--legacy');
    const approvedLink = path.join(agentsSkills, 'approved-ghost--approved');

    await linkDirectory(activeSkill, activeLink);
    await linkDirectory(legacySkill, legacyLink);
    await linkDirectory(approvedSkill, approvedLink);

    await expect(
      codexDisabledSkillPathsForOwner(
        [activeLink, legacyLink, approvedLink].map((link) => ({
          path: path.join(link, 'SKILL.md'),
        })),
        {
          ownerRoot,
          approvedGhostSkills: approvedGhostSkills([approved.ghost]),
        },
      ),
    ).resolves.toEqual([activeLink, legacyLink].map((link) => path.join(link, 'SKILL.md')).sort());
  });

  it('drops a disabled-path result when the owner changes during snapshot validation', async () => {
    const root = await makeTmpDir();
    const agentsSkills = path.join(root, 'home', '.agents', 'skills');
    const ownerRoot = path.join(root, 'user-data', 'owners', 'owner-a');
    const approved = await writeApprovedGhostSkills(ownerRoot, 'approved-ghost', [
      { dir: 'skills/approved', name: 'approved' },
    ]);
    const approvedSkill = approved.skillDirs.get('approved')!;
    const approvedLink = path.join(agentsSkills, 'approved-ghost--approved');
    await linkDirectory(approvedSkill, approvedLink);
    let stable = true;

    await expect(
      codexDisabledSkillPathsForOwner([{ path: path.join(approvedLink, 'SKILL.md') }], {
        ownerRoot,
        approvedGhostSkills: approvedGhostSkills([approved.ghost], async () => {
          stable = false;
          return true;
        }),
        assertOwnerStable: () => {
          if (!stable) throw new Error('owner changed during skill filtering');
        },
      }),
    ).rejects.toThrow('owner changed during skill filtering');
  });

  it('upgrades the legacy shared-root bridge to an owner-filtered projection', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    const ownerARoot = path.join(root, 'user-data', 'owners', 'owner-a');
    const ownerBRoot = path.join(root, 'user-data', 'owners', 'owner-b');
    const ownerAApproved = await writeApprovedGhostSkills(ownerARoot, 'ghost-a', [
      { dir: 'skills/profile-a', name: 'profile-a' },
    ]);
    const ownerBApproved = await writeApprovedGhostSkills(ownerBRoot, 'ghost-b', [
      { dir: 'skills/profile-b', name: 'profile-b' },
    ]);
    const ownerASkill = ownerAApproved.skillDirs.get('profile-a')!;
    const ownerBSkill = ownerBApproved.skillDirs.get('profile-b')!;
    const ownerALink = path.join(agentsSkills, 'ghost-a--profile-a');
    const ownerBLink = path.join(agentsSkills, 'ghost-b--profile-b');

    await writeSkill(agentsSkills, 'user-global');
    await linkDirectory(ownerASkill, ownerALink);
    await linkDirectory(ownerBSkill, ownerBLink);

    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    await linkDirectory(agentsSkills, paths.sharedAgentsSkillsLink);

    const result = await prepareCodexGlobalSkillsLinks(codexHome, {
      homeDir,
      ownerRoot: ownerARoot,
      approvedGhostSkills: approvedGhostSkills([ownerAApproved.ghost]),
    });

    expect(result.warnings).toEqual([]);
    expect(await sameRealPath(paths.sharedAgentsSkillsLink, agentsSkills)).toBe(false);
    expect(await sameRealPath(path.join(paths.sharedAgentsSkillsLink, 'user-global'), path.join(agentsSkills, 'user-global'))).toBe(true);
    expect(await sameRealPath(path.join(paths.sharedAgentsSkillsLink, 'ghost-a--profile-a'), ownerASkill)).toBe(true);
    await expect(fs.lstat(path.join(paths.sharedAgentsSkillsLink, 'ghost-b--profile-b'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await sameRealPath(ownerALink, ownerASkill)).toBe(true);
    expect(await sameRealPath(ownerBLink, ownerBSkill)).toBe(true);
  });

  it('rebuilds the projection on owner switch without deleting either owner source', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    const ownerARoot = path.join(root, 'user-data', 'owners', 'owner-a');
    const ownerBRoot = path.join(root, 'user-data', 'owners', 'owner-b');
    const ownerAApproved = await writeApprovedGhostSkills(ownerARoot, 'ghost-a', [
      { dir: 'skills/profile-a', name: 'profile-a' },
    ]);
    const ownerBApproved = await writeApprovedGhostSkills(ownerBRoot, 'ghost-b', [
      { dir: 'skills/profile-b', name: 'profile-b' },
    ]);
    const ownerASkill = ownerAApproved.skillDirs.get('profile-a')!;
    const ownerBSkill = ownerBApproved.skillDirs.get('profile-b')!;
    const ownerALink = path.join(agentsSkills, 'ghost-a--profile-a');
    const ownerBLink = path.join(agentsSkills, 'ghost-b--profile-b');

    await writeSkill(agentsSkills, 'user-global');
    await linkDirectory(ownerASkill, ownerALink);
    await linkDirectory(ownerBSkill, ownerBLink);

    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    await prepareCodexGlobalSkillsLinks(codexHome, {
      homeDir,
      ownerRoot: ownerARoot,
      approvedGhostSkills: approvedGhostSkills([ownerAApproved.ghost]),
    });
    const projectionA = await fs.realpath(paths.sharedAgentsSkillsLink);
    expect(await sameRealPath(path.join(projectionA, 'ghost-a--profile-a'), ownerASkill)).toBe(true);

    await prepareCodexGlobalSkillsLinks(codexHome, {
      homeDir,
      ownerRoot: ownerBRoot,
      approvedGhostSkills: approvedGhostSkills([ownerBApproved.ghost]),
    });
    const projectionB = await fs.realpath(paths.sharedAgentsSkillsLink);
    expect(projectionB).not.toBe(projectionA);
    await expect(fs.lstat(path.join(projectionB, 'ghost-a--profile-a'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await sameRealPath(path.join(projectionB, 'ghost-b--profile-b'), ownerBSkill)).toBe(true);
    await expect(fs.lstat(projectionA)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await sameRealPath(ownerALink, ownerASkill)).toBe(true);
    expect(await sameRealPath(ownerBLink, ownerBSkill)).toBe(true);

    const repeated = await prepareCodexGlobalSkillsLinks(codexHome, {
      homeDir,
      ownerRoot: ownerBRoot,
      approvedGhostSkills: approvedGhostSkills([ownerBApproved.ghost]),
    });
    expect(repeated.changed).toBe(false);
  });

  it('repairs a corrupted content-addressed projection and invalidates cached Skills', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    const ownerRoot = path.join(root, 'user-data', 'owners', 'owner-a');
    const approved = await writeApprovedGhostSkills(ownerRoot, 'ghost-a', [
      { dir: 'skills/profile-a', name: 'profile-a' },
    ]);
    const approvedSkill = approved.skillDirs.get('profile-a')!;
    const wrongTarget = path.join(root, 'wrong-target');
    await writeSkill(agentsSkills, 'user-global');
    await writeSkill(path.dirname(wrongTarget), path.basename(wrongTarget));

    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    const initial = await prepareCodexGlobalSkillsLinks(codexHome, {
      homeDir,
      ownerRoot,
      approvedGhostSkills: approvedGhostSkills([approved.ghost]),
    });
    await expect(readCodexAgentsProjectionIdentity(codexHome, homeDir)).resolves.toBe(
      initial.agentsProjectionIdentity,
    );
    const projectionDir = await fs.realpath(paths.sharedAgentsSkillsLink);

    await fs.rm(path.join(projectionDir, 'ghost-a--profile-a'), {
      recursive: true,
      force: true,
    });
    await fs.rm(path.join(projectionDir, 'user-global'), { recursive: true, force: true });
    await linkDirectory(wrongTarget, path.join(projectionDir, 'user-global'));
    await fs.mkdir(path.join(projectionDir, 'unexpected'));

    const repaired = await prepareCodexGlobalSkillsLinks(codexHome, {
      homeDir,
      ownerRoot,
      approvedGhostSkills: approvedGhostSkills([approved.ghost]),
    });

    expect(repaired.warnings).toEqual([]);
    expect(repaired.changed).toBe(true);
    expect(repaired.agentsProjectionIdentity).not.toBe(initial.agentsProjectionIdentity);
    await expect(readCodexAgentsProjectionIdentity(codexHome, homeDir)).resolves.toBe(
      repaired.agentsProjectionIdentity,
    );
    expect(await fs.realpath(paths.sharedAgentsSkillsLink)).toBe(projectionDir);
    expect(
      await sameRealPath(path.join(projectionDir, 'ghost-a--profile-a'), approvedSkill),
    ).toBe(true);
    expect(
      await sameRealPath(
        path.join(projectionDir, 'user-global'),
        path.join(agentsSkills, 'user-global'),
      ),
    ).toBe(true);
    await expect(fs.lstat(path.join(projectionDir, 'unexpected'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rebuilds the projection when a new approved revision adds a Ghost Skill', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    const ownerRoot = path.join(root, 'user-data', 'owners', 'owner-b');
    const firstItem = { dir: 'agent-skills/first', name: 'first' };
    const secondItem = { dir: 'agent-skills/second', name: 'second' };
    const firstApproval = await writeApprovedGhostSkills(
      ownerRoot,
      'same-ghost',
      [firstItem],
      '00000000-0000-4000-8000-000000000001',
    );
    const firstSkill = firstApproval.skillDirs.get('first')!;
    await writeSkill(agentsSkills, 'user-global');

    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    const initial = await prepareCodexGlobalSkillsLinks(codexHome, {
      homeDir,
      ownerRoot,
      approvedGhostSkills: approvedGhostSkills([firstApproval.ghost]),
    });
    expect(initial.warnings).toEqual([]);
    expect(
      await sameRealPath(
        path.join(paths.sharedAgentsSkillsLink, 'same-ghost--first'),
        firstSkill,
      ),
    ).toBe(true);
    await expect(
      fs.lstat(path.join(paths.sharedAgentsSkillsLink, 'same-ghost--second')),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const secondApproval = await writeApprovedGhostSkills(
      ownerRoot,
      'same-ghost',
      [firstItem, secondItem],
      '00000000-0000-4000-8000-000000000002',
    );
    const secondSkill = secondApproval.skillDirs.get('second')!;

    const refreshed = await prepareCodexGlobalSkillsLinks(codexHome, {
      homeDir,
      ownerRoot,
      approvedGhostSkills: approvedGhostSkills([secondApproval.ghost]),
    });
    expect(refreshed.warnings).toEqual([]);
    expect(
      await sameRealPath(
        path.join(paths.sharedAgentsSkillsLink, 'same-ghost--second'),
        secondSkill,
      ),
    ).toBe(true);
  });

  it('uses lstat when an unknown d_type hides another Profile shared symlink', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    const ownerARoot = path.join(root, 'user-data', 'owners', 'owner-a');
    const ownerBRoot = path.join(root, 'user-data', 'owners', 'owner-b');
    const item = { dir: 'agent-skills/shared', name: 'shared' };
    const ownerAApproved = await writeApprovedGhostSkills(ownerARoot, 'same-ghost', [item]);
    const ownerBApproved = await writeApprovedGhostSkills(ownerBRoot, 'same-ghost', [item]);
    const ownerASkill = ownerAApproved.skillDirs.get('shared')!;
    const ownerBSkill = ownerBApproved.skillDirs.get('shared')!;
    const sharedLink = path.join(agentsSkills, 'same-ghost--shared');
    await linkDirectory(ownerASkill, sharedLink);

    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    const direntSymlinkType = vi.spyOn(Dirent.prototype, 'isSymbolicLink').mockReturnValue(false);
    let result: Awaited<ReturnType<typeof prepareCodexGlobalSkillsLinks>>;
    try {
      result = await prepareCodexGlobalSkillsLinks(codexHome, {
        homeDir,
        ownerRoot: ownerBRoot,
        approvedGhostSkills: approvedGhostSkills([ownerBApproved.ghost]),
      });
    } finally {
      direntSymlinkType.mockRestore();
    }

    expect(result.warnings).toEqual([]);
    expect(await sameRealPath(sharedLink, ownerASkill)).toBe(true);
    expect(
      await sameRealPath(
        path.join(paths.sharedAgentsSkillsLink, 'same-ghost--shared'),
        ownerBSkill,
      ),
    ).toBe(true);
  });

  it('does not project an approved snapshot when the receipt hash validation fails', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const ownerRoot = path.join(root, 'user-data', 'owners', 'owner-a');
    const approved = await writeApprovedGhostSkills(ownerRoot, 'tampered-ghost', [
      { dir: 'agent-skills/tampered', name: 'tampered' },
    ]);
    await writeSkill(path.join(homeDir, '.agents', 'skills'), 'user-global');
    let validationCalls = 0;

    const result = await prepareCodexGlobalSkillsLinks(codexHome, {
      homeDir,
      ownerRoot,
      approvedGhostSkills: approvedGhostSkills([approved.ghost], async () => {
        validationCalls += 1;
        return false;
      }),
    });
    const paths = codexGlobalSkillsPaths(codexHome, homeDir);

    expect(result.warnings).toEqual([]);
    expect(validationCalls).toBe(1);
    await expect(
      fs.lstat(path.join(paths.sharedAgentsSkillsLink, 'tampered-ghost--tampered')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not project installed Ghost Skills with untrusted or inconsistent SKILL.md', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    const ownerRoot = path.join(root, 'user-data', 'owners', 'owner-a');
    const inconsistentItem = { dir: 'agent-skills/inconsistent', name: 'inconsistent' };
    const oversizedItem = { dir: 'agent-skills/oversized', name: 'oversized' };
    const inconsistentSkill = await writeInstalledGhostSkill(
      ownerRoot,
      'inconsistent-ghost',
      inconsistentItem,
    );
    const oversizedSkill = await writeInstalledGhostSkill(
      ownerRoot,
      'oversized-ghost',
      oversizedItem,
    );
    await fs.writeFile(
      path.join(inconsistentSkill, 'SKILL.md'),
      '---\nname: tampered\ndescription: test skill\n---\n\nbody\n',
      'utf8',
    );
    await fs.appendFile(path.join(oversizedSkill, 'SKILL.md'), 'x'.repeat(64 * 1024), 'utf8');
    const inconsistentLink = path.join(agentsSkills, 'inconsistent-ghost--inconsistent');
    const oversizedLink = path.join(agentsSkills, 'oversized-ghost--oversized');
    await linkDirectory(inconsistentSkill, inconsistentLink);
    await linkDirectory(oversizedSkill, oversizedLink);

    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    const result = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir, ownerRoot });

    expect(result.warnings).toEqual([]);
    await expect(
      fs.lstat(path.join(paths.sharedAgentsSkillsLink, 'inconsistent-ghost--inconsistent')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.lstat(path.join(paths.sharedAgentsSkillsLink, 'oversized-ghost--oversized')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await sameRealPath(inconsistentLink, inconsistentSkill)).toBe(true);
    expect(await sameRealPath(oversizedLink, oversizedSkill)).toBe(true);
    await expect(
      codexDisabledSkillPathsForOwner(
        [inconsistentLink, oversizedLink].map((link) => ({
          path: path.join(link, 'SKILL.md'),
        })),
        { ownerRoot },
      ),
    ).resolves.toEqual(
      [inconsistentLink, oversizedLink].map((link) => path.join(link, 'SKILL.md')).sort(),
    );
  });

  it('does not fall back to either mutable install root when receipts are absent', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    const ownerRoot = path.join(root, 'user-data', 'owners', 'owner-a');
    const activeItem = { dir: 'agent-skills/active', name: 'active' };
    const legacyItem = { dir: 'agent-skills/legacy', name: 'legacy' };
    await writeInstalledGhostSkill(ownerRoot, 'active-ghost', activeItem);
    await writeInstalledGhostSkill(ownerRoot, 'legacy-ghost', legacyItem, 'brain');
    await writeSkill(agentsSkills, 'user-global');

    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    const result = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir, ownerRoot });

    expect(result.warnings).toEqual([]);
    await expect(
      fs.lstat(path.join(paths.sharedAgentsSkillsLink, 'active-ghost--active')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.lstat(path.join(paths.sharedAgentsSkillsLink, 'legacy-ghost--legacy')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps legacy-only installs fail-closed until receipt migration succeeds', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    const ownerRoot = path.join(root, 'user-data', 'owners', 'owner-a');
    const item = { dir: 'agent-skills/legacy', name: 'legacy' };
    await writeInstalledGhostSkill(ownerRoot, 'legacy-ghost', item, 'brain');
    await writeSkill(agentsSkills, 'user-global');

    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    const result = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir, ownerRoot });

    expect(result.warnings).toEqual([]);
    await expect(
      fs.lstat(path.join(paths.sharedAgentsSkillsLink, 'legacy-ghost--legacy')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('links legacy Codex skills and projects shared agent skills under custom CODEX_HOME', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const legacySkills = path.join(homeDir, '.codex', 'skills');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    await writeSkill(legacySkills, 'legacy-skill');
    await writeSkill(agentsSkills, 'shared-skill');

    const result = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });
    const paths = codexGlobalSkillsPaths(codexHome, homeDir);

    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(path.basename(paths.legacyCodexSkillsLink)).toBe(CODEX_LEGACY_CODEX_SKILLS_LINK_NAME);
    expect(path.basename(paths.sharedAgentsSkillsLink)).toBe(CODEX_SHARED_AGENTS_SKILLS_LINK_NAME);
    expect(await sameRealPath(paths.legacyCodexSkillsLink, legacySkills)).toBe(true);
    expect(await sameRealPath(paths.sharedAgentsSkillsLink, agentsSkills)).toBe(false);
    expect(await sameRealPath(path.join(paths.sharedAgentsSkillsLink, 'shared-skill'), path.join(agentsSkills, 'shared-skill'))).toBe(true);
  });

  it('skips missing source roots without failing the scan-entry setup', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const legacySkills = path.join(homeDir, '.codex', 'skills');
    await writeSkill(legacySkills, 'legacy-skill');

    const result = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });
    const paths = codexGlobalSkillsPaths(codexHome, homeDir);

    expect(await sameRealPath(paths.legacyCodexSkillsLink, legacySkills)).toBe(true);
    expect(result.sources.find((source) => source.name === 'codex')?.status).toMatch(/linked|kept/);
    expect(result.sources.find((source) => source.name === 'agents')?.status).toBe('missing');
  });

  it('removes a stale managed link when its source root disappears', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const legacySkills = path.join(homeDir, '.codex', 'skills');
    await writeSkill(legacySkills, 'legacy-skill');

    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });
    expect(await sameRealPath(paths.legacyCodexSkillsLink, legacySkills)).toBe(true);

    await fs.rm(legacySkills, { recursive: true, force: true });
    const result = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });

    expect(result.sources.find((source) => source.name === 'codex')?.status).toBe('missing');
    await expect(fs.lstat(paths.legacyCodexSkillsLink)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not replace a non-managed directory at a source link path', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const legacySkills = path.join(homeDir, '.codex', 'skills');
    await writeSkill(legacySkills, 'legacy-skill');

    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    const conflictingDir = paths.legacyCodexSkillsLink;
    await fs.mkdir(conflictingDir, { recursive: true });
    await fs.writeFile(path.join(conflictingDir, 'keep.txt'), 'do not remove', 'utf8');

    const result = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });

    expect(result.sources.find((source) => source.name === 'codex')?.status).toBe('conflict');
    await expect(fs.readFile(path.join(conflictingDir, 'keep.txt'), 'utf8')).resolves.toBe('do not remove');
    expect(result.warnings.some((warning) => warning.includes('cannot link Codex codex skills'))).toBe(true);
  });

  it('removes the old aggregate scan link without deleting non-managed files', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const legacySkills = path.join(homeDir, '.codex', 'skills');
    await writeSkill(legacySkills, 'legacy-skill');

    const oldAggregateDir = path.join(codexHome, 'global_skills');
    const oldScanEntry = path.join(codexHome, 'skills', 'xdt-global');
    await fs.mkdir(path.join(codexHome, 'skills'), { recursive: true });
    await fs.mkdir(oldAggregateDir, { recursive: true });
    await fs.symlink(oldAggregateDir, oldScanEntry, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.writeFile(path.join(oldAggregateDir, 'keep.txt'), 'do not remove', 'utf8');

    await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });
    const paths = codexGlobalSkillsPaths(codexHome, homeDir);

    await expect(fs.lstat(oldScanEntry)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(oldAggregateDir, 'keep.txt'), 'utf8')).resolves.toBe('do not remove');
    expect(await sameRealPath(paths.legacyCodexSkillsLink, legacySkills)).toBe(true);
  });
});
