import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Maker } from '@cindy/maker-core';
import { scanAllSkills } from '../../skillhub/scanner';

vi.mock('../../skillhub/registry', () => ({
  registryService: { listAllInstalls: vi.fn(async () => []), getInstall: vi.fn(async () => null) },
}));

import {
  activeCindyBuiltInAgentSkills,
  BUILT_IN_SKILLS_BUNDLE_VERSION,
  builtInSkillDescriptors,
  markCindyBuiltInAgentSkills,
  prepareBuiltInSkills,
  refreshBuiltInClaudeSkillLinks,
  resolveBundledSystemSkillsRoot,
} from '../built-in-skills';

const roots: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-built-in-skills-'));
  roots.push(root);
  const bundledRoot = path.join(root, 'resources', 'system-skills');
  const source = path.join(bundledRoot, 'cindy-skill-creator');
  const learnSource = path.join(bundledRoot, 'learn');
  const userDataDir = path.join(root, 'user-data');
  const appDataDir = path.join(root, 'app-data');
  const homeDir = path.join(root, 'home');
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  fs.mkdirSync(learnSource, { recursive: true });
  fs.writeFileSync(
    path.join(source, 'SKILL.md'),
    '---\nname: cindy-skill-creator\ndescription: Create Skills\n---\n\n# Creator\n',
  );
  fs.writeFileSync(path.join(source, 'scripts', 'validate.py'), 'print("ok")\n');
  fs.writeFileSync(
    path.join(learnSource, 'SKILL.md'),
    '---\nname: learn\ndescription: Start Cindy Learn\n---\n\n# Learn\n',
  );
  const withSharedMutation = async <T>(
    _names: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> => operation();
  const replaceDirectoryEntryAtomically = process.platform === 'win32'
    ? async (replacement: string, destination: string) => {
      // Unit-test adapter only. The native helper has a dedicated Windows smoke
      // test; keep these filesystem fixtures independent from Electron's app stub.
      const previousTarget = await fs.promises.readlink(destination);
      await fs.promises.unlink(destination);
      try {
        await fs.promises.rename(replacement, destination);
      } catch (error) {
        await fs.promises.symlink(previousTarget, destination, 'junction');
        throw error;
      }
    }
    : undefined;
  return {
    bundledRoot,
    source,
    userDataDir,
    appDataDir,
    homeDir,
    withSharedMutation,
    ...(replaceDirectoryEntryAtomically ? { replaceDirectoryEntryAtomically } : {}),
  };
}

async function prepareAndProjectBuiltInSkills(
  input: ReturnType<typeof fixture> & { bundleVersion?: number },
) {
  return prepareBuiltInSkills(input);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('built-in Skills', () => {
  it('materializes immutable versioned bytes and exposes the active version', async () => {
    const input = fixture();
    const first = await prepareAndProjectBuiltInSkills(input);
    const descriptor = builtInSkillDescriptors(input.userDataDir, input.appDataDir)[0]!;
    const root = path.join(input.appDataDir, 'Cindy', 'shared-system-skills');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, '.cindy-system-skills.json'), 'utf8'),
    );
    const link = path.join(input.homeDir, '.agents', 'skills', 'cindy-skill-creator');
    expect(first.changed).toBe(true);
    expect(first.warnings).toEqual([]);
    expect(manifest).toMatchObject({
      schemaVersion: 3,
      bundleVersion: BUILT_IN_SKILLS_BUNDLE_VERSION,
    });
    expect(descriptor.absolutePath).toBe(
      path.join(root, '.active', 'cindy-skill-creator'),
    );
    const firstImmutablePath = fs.realpathSync(descriptor.absolutePath);
    expect(firstImmutablePath).toBe(
      fs.realpathSync(path.join(root, '.versions', manifest.activeBundle, 'cindy-skill-creator')),
    );
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(descriptor.absolutePath));
    expect(fs.realpathSync(descriptor.nativeClaudePath)).toBe(
      fs.realpathSync(descriptor.absolutePath),
    );
    expect(fs.readFileSync(path.join(descriptor.absolutePath, 'SKILL.md'), 'utf8')).toContain(
      '# Creator',
    );
    const learnDescriptor = first.descriptors.find((item) => item.name === 'learn')!;
    expect(fs.realpathSync(path.join(input.homeDir, '.agents', 'skills', 'learn'))).toBe(
      fs.realpathSync(learnDescriptor.absolutePath),
    );
    expect(fs.readFileSync(path.join(learnDescriptor.absolutePath, 'SKILL.md'), 'utf8')).toContain(
      '# Learn',
    );

    const second = await prepareAndProjectBuiltInSkills(input);
    expect(second.changed).toBe(false);

    fs.writeFileSync(path.join(descriptor.absolutePath, 'SKILL.md'), '# Tampered\n');
    const repaired = await prepareAndProjectBuiltInSkills(input);
    const repairedDescriptor = repaired.descriptors.find(
      (item) => item.name === 'cindy-skill-creator',
    )!;
    expect(repaired.changed).toBe(true);
    expect(repairedDescriptor.absolutePath).toBe(descriptor.absolutePath);
    expect(fs.realpathSync(repairedDescriptor.absolutePath)).not.toBe(firstImmutablePath);
    expect(fs.readFileSync(path.join(repairedDescriptor.absolutePath, 'SKILL.md'), 'utf8')).toContain(
      '# Creator',
    );
    expect(fs.existsSync(path.join(firstImmutablePath, 'SKILL.md'))).toBe(true);

    fs.appendFileSync(path.join(input.source, 'SKILL.md'), '\nUpdated\n');
    const updated = await prepareAndProjectBuiltInSkills({
      ...input,
      bundleVersion: BUILT_IN_SKILLS_BUNDLE_VERSION + 1,
    });
    expect(updated.changed).toBe(true);
    const updatedDescriptor = updated.descriptors.find(
      (item) => item.name === 'cindy-skill-creator',
    )!;
    expect(fs.readFileSync(path.join(updatedDescriptor.absolutePath, 'SKILL.md'), 'utf8')).toContain(
      'Updated',
    );
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(updatedDescriptor.absolutePath));
  });

  it('does not let an older or conflicting bundle overwrite newer shared bytes', async () => {
    const input = fixture();
    fs.appendFileSync(path.join(input.source, 'SKILL.md'), '\nNewer bundle\n');
    const newer = await prepareBuiltInSkills({ ...input, bundleVersion: 2 });
    const descriptor = newer.descriptors[0]!;
    const installed = fs.readFileSync(path.join(descriptor.absolutePath, 'SKILL.md'), 'utf8');

    fs.writeFileSync(
      path.join(input.source, 'SKILL.md'),
      '---\nname: cindy-skill-creator\ndescription: Old bundle\n---\n\n# Old\n',
    );
    const older = await prepareBuiltInSkills({ ...input, bundleVersion: 1 });
    expect(fs.readFileSync(path.join(descriptor.absolutePath, 'SKILL.md'), 'utf8')).toBe(installed);
    expect(older.warnings.join('\n')).toContain('only carries older bundle 1');

    const conflicting = await prepareBuiltInSkills({ ...input, bundleVersion: 2 });
    expect(fs.readFileSync(path.join(descriptor.absolutePath, 'SKILL.md'), 'utf8')).toBe(installed);
    expect(conflicting.warnings.join('\n')).toContain('bundle version 2 was reused');
  });

  it('fails closed when an existing bundle manifest is corrupt', async () => {
    const input = fixture();
    const newer = await prepareBuiltInSkills({ ...input, bundleVersion: 5 });
    const descriptor = newer.descriptors[0]!;
    const manifestPath = path.join(input.appDataDir, 'Cindy', 'shared-system-skills', '.cindy-system-skills.json');
    const installed = fs.readFileSync(path.join(descriptor.absolutePath, 'SKILL.md'), 'utf8');
    fs.writeFileSync(manifestPath, '{ invalid json');
    fs.writeFileSync(
      path.join(input.source, 'SKILL.md'),
      '---\nname: cindy-skill-creator\ndescription: Old bundle\n---\n\n# Old\n',
    );

    const older = await prepareBuiltInSkills({ ...input, bundleVersion: 4 });

    expect(fs.readFileSync(path.join(descriptor.absolutePath, 'SKILL.md'), 'utf8')).toBe(installed);
    expect(older.changed).toBe(false);
    expect(older.projectionSafe).toBe(false);
    expect(older.warnings.join('\n')).toContain('manifest is unavailable');
  });

  it('preserves existing projections when a manifest has a corrupt shape', async () => {
    const input = fixture();
    await prepareAndProjectBuiltInSkills(input);
    const sharedLink = path.join(input.homeDir, '.agents', 'skills', 'cindy-skill-creator');
    const claudeLink = path.join(input.userDataDir, 'claude-home', 'skills', 'cindy-skill-creator');
    const sharedTarget = fs.realpathSync(sharedLink);
    const claudeTarget = fs.realpathSync(claudeLink);
    const manifestPath = path.join(
      input.appDataDir,
      'Cindy',
      'shared-system-skills',
      '.cindy-system-skills.json',
    );
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 3,
      bundleVersion: BUILT_IN_SKILLS_BUNDLE_VERSION,
      fingerprints: {},
      activeBundle: 'damaged',
    }));

    const failed = await prepareAndProjectBuiltInSkills(input);

    expect(failed.projectionSafe).toBe(false);
    expect(failed.warnings.join('\n')).toContain('manifest is unavailable');
    expect(fs.realpathSync(sharedLink)).toBe(sharedTarget);
    expect(fs.realpathSync(claudeLink)).toBe(claudeTarget);
  });

  it('does not infer a first install when the manifest is missing beside existing Skills', async () => {
    const input = fixture();
    const newer = await prepareBuiltInSkills({ ...input, bundleVersion: 5 });
    const descriptor = newer.descriptors[0]!;
    const manifestPath = path.join(input.appDataDir, 'Cindy', 'shared-system-skills', '.cindy-system-skills.json');
    const installed = fs.readFileSync(path.join(descriptor.absolutePath, 'SKILL.md'), 'utf8');
    fs.unlinkSync(manifestPath);

    const retried = await prepareBuiltInSkills({ ...input, bundleVersion: 4 });

    expect(fs.readFileSync(path.join(descriptor.absolutePath, 'SKILL.md'), 'utf8')).toBe(installed);
    expect(retried.changed).toBe(false);
    expect(retried.warnings.join('\n')).toContain('manifest is unavailable');
  });

  it('restores the atomic manifest backup before applying version ordering', async () => {
    const input = fixture();
    const newer = await prepareBuiltInSkills({ ...input, bundleVersion: 5 });
    const descriptor = newer.descriptors[0]!;
    const manifestPath = path.join(input.appDataDir, 'Cindy', 'shared-system-skills', '.cindy-system-skills.json');
    const installed = fs.readFileSync(path.join(descriptor.absolutePath, 'SKILL.md'), 'utf8');
    fs.renameSync(manifestPath, `${manifestPath}.bak`);
    fs.writeFileSync(
      path.join(input.source, 'SKILL.md'),
      '---\nname: cindy-skill-creator\ndescription: Old bundle\n---\n\n# Old\n',
    );

    const older = await prepareBuiltInSkills({ ...input, bundleVersion: 4 });

    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(fs.existsSync(`${manifestPath}.bak`)).toBe(false);
    expect(fs.readFileSync(path.join(descriptor.absolutePath, 'SKILL.md'), 'utf8')).toBe(installed);
    expect(older.warnings.join('\n')).toContain('only carries older bundle 4');
  });

  it('advances the bundle version only after every Skill is ready and retries partial upgrades', async () => {
    const input = fixture();
    await prepareBuiltInSkills(input);
    fs.appendFileSync(path.join(input.source, 'SKILL.md'), '\nCreator v2\n');
    fs.writeFileSync(path.join(input.bundledRoot, 'learn', 'SKILL.md'), 'Learn v2\n');
    fs.renameSync(
      path.join(input.bundledRoot, 'learn', 'SKILL.md'),
      path.join(input.bundledRoot, 'learn', 'SKILL.md.missing'),
    );

    const partial = await prepareBuiltInSkills({
      ...input,
      bundleVersion: BUILT_IN_SKILLS_BUNDLE_VERSION + 1,
    });
    const manifestPath = path.join(input.appDataDir, 'Cindy', 'shared-system-skills', '.cindy-system-skills.json');
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).bundleVersion).toBe(
      BUILT_IN_SKILLS_BUNDLE_VERSION,
    );
    expect(partial.warnings.join('\n')).toContain('missing SKILL.md');
    expect(
      fs.readFileSync(path.join(partial.descriptors[0]!.absolutePath, 'SKILL.md'), 'utf8'),
    ).not.toContain('Creator v2');

    fs.renameSync(
      path.join(input.bundledRoot, 'learn', 'SKILL.md.missing'),
      path.join(input.bundledRoot, 'learn', 'SKILL.md'),
    );
    const retried = await prepareBuiltInSkills({
      ...input,
      bundleVersion: BUILT_IN_SKILLS_BUNDLE_VERSION + 1,
    });
    expect(retried.warnings).toEqual([]);
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).bundleVersion).toBe(
      BUILT_IN_SKILLS_BUNDLE_VERSION + 1,
    );
    expect(
      fs.readFileSync(
        path.join(
          retried.descriptors.find((descriptor) => descriptor.name === 'learn')!.absolutePath,
          'SKILL.md',
        ),
        'utf8',
      ),
    ).toBe('Learn v2\n');
  });

  it('keeps the active bundle readable when publishing a new version directory fails', async () => {
    const input = fixture();
    const initial = await prepareBuiltInSkills(input);
    const creator = initial.descriptors.find((descriptor) => descriptor.name === 'cindy-skill-creator')!;
    const learn = initial.descriptors.find((descriptor) => descriptor.name === 'learn')!;
    const root = path.join(input.appDataDir, 'Cindy', 'shared-system-skills');
    const manifestPath = path.join(root, '.cindy-system-skills.json');
    const initialManifest = fs.readFileSync(manifestPath, 'utf8');
    const initialActiveBundle = JSON.parse(initialManifest).activeBundle as string;
    const initialCreator = fs.readFileSync(path.join(creator.absolutePath, 'SKILL.md'), 'utf8');
    const initialLearn = fs.readFileSync(path.join(learn.absolutePath, 'SKILL.md'), 'utf8');
    fs.appendFileSync(path.join(input.source, 'SKILL.md'), '\nCreator v2\n');
    fs.writeFileSync(path.join(input.bundledRoot, 'learn', 'SKILL.md'), 'Learn v2\n');

    const versionsRoot = path.join(root, '.versions');
    const originalRename = fs.promises.rename.bind(fs.promises);
    let activeBundleWasReadable = false;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      if (
        path.dirname(String(source)) === versionsRoot &&
        path.basename(String(source)).endsWith('.pending') &&
        path.dirname(String(destination)) === versionsRoot
      ) {
        activeBundleWasReadable = fs.existsSync(path.join(creator.absolutePath, 'SKILL.md'));
        throw new Error('blocked version publish');
      }
      await originalRename(source, destination);
    });

    const failed = await prepareBuiltInSkills({
      ...input,
      bundleVersion: BUILT_IN_SKILLS_BUNDLE_VERSION + 1,
    });

    expect(failed.changed).toBe(false);
    expect(failed.warnings.join('\n')).toContain('blocked version publish');
    expect(activeBundleWasReadable).toBe(true);
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(initialManifest);
    expect(fs.readFileSync(path.join(creator.absolutePath, 'SKILL.md'), 'utf8')).toBe(initialCreator);
    expect(fs.readFileSync(path.join(learn.absolutePath, 'SKILL.md'), 'utf8')).toBe(initialLearn);
    expect(fs.readdirSync(versionsRoot)).toEqual([initialActiveBundle]);
  });

  it('keeps the previous version active when the manifest pointer switch fails', async () => {
    const input = fixture();
    const initial = await prepareBuiltInSkills(input);
    const creator = initial.descriptors.find((descriptor) => descriptor.name === 'cindy-skill-creator')!;
    const root = path.join(input.appDataDir, 'Cindy', 'shared-system-skills');
    const versionsRoot = path.join(root, '.versions');
    const manifestPath = path.join(root, '.cindy-system-skills.json');
    const initialManifest = fs.readFileSync(manifestPath, 'utf8');
    const initialActiveBundle = JSON.parse(initialManifest).activeBundle as string;
    fs.appendFileSync(path.join(input.source, 'SKILL.md'), '\nCreator v2\n');

    const originalRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (String(destination) === manifestPath && String(source).endsWith('.tmp')) {
        throw new Error('blocked manifest switch');
      }
      originalRename(source, destination);
    });

    const failed = await prepareBuiltInSkills({
      ...input,
      bundleVersion: BUILT_IN_SKILLS_BUNDLE_VERSION + 1,
    });

    expect(failed.changed).toBe(false);
    expect(failed.warnings.join('\n')).toContain('blocked manifest switch');
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(initialManifest);
    expect(fs.readFileSync(path.join(creator.absolutePath, 'SKILL.md'), 'utf8')).not.toContain(
      'Creator v2',
    );
    expect(failed.descriptors[0]!.absolutePath).toBe(creator.absolutePath);
    expect(fs.readdirSync(versionsRoot)).toEqual([initialActiveBundle]);
  });

  it('keeps every managed projection on one stable target across bundle upgrades', async () => {
    const input = fixture();
    const initial = await prepareBuiltInSkills(input);
    const root = path.join(input.appDataDir, 'Cindy', 'shared-system-skills');
    const initialCreator = initial.descriptors.find(
      (descriptor) => descriptor.name === 'cindy-skill-creator',
    )!;
    const initialLearn = initial.descriptors.find((descriptor) => descriptor.name === 'learn')!;
    const creatorLink = path.join(input.homeDir, '.agents', 'skills', 'cindy-skill-creator');
    const learnLink = path.join(input.homeDir, '.agents', 'skills', 'learn');
    const nativeCreatorLink = initialCreator.nativeClaudePath;
    const nativeLearnLink = initialLearn.nativeClaudePath;
    const initialCreatorBytes = fs.realpathSync(initialCreator.absolutePath);
    const initialLearnBytes = fs.realpathSync(initialLearn.absolutePath);
    const projectionTargets = new Map([
      [creatorLink, fs.readlinkSync(creatorLink)],
      [learnLink, fs.readlinkSync(learnLink)],
      [nativeCreatorLink, fs.readlinkSync(nativeCreatorLink)],
      [nativeLearnLink, fs.readlinkSync(nativeLearnLink)],
    ]);
    fs.appendFileSync(path.join(input.source, 'SKILL.md'), '\nCreator v2\n');
    fs.appendFileSync(path.join(input.bundledRoot, 'learn', 'SKILL.md'), '\nLearn v2\n');

    const updated = await prepareBuiltInSkills({
      ...input,
      bundleVersion: BUILT_IN_SKILLS_BUNDLE_VERSION + 1,
    });

    expect(updated.warnings).toEqual([]);
    expect(updated.projectionSafe).toBe(true);
    for (const [linkPath, target] of projectionTargets) {
      expect(fs.readlinkSync(linkPath)).toBe(target);
    }
    expect(fs.readlinkSync(creatorLink)).toBe(path.join(root, '.active', 'cindy-skill-creator'));
    expect(fs.realpathSync(creatorLink)).not.toBe(initialCreatorBytes);
    expect(fs.realpathSync(learnLink)).not.toBe(initialLearnBytes);
    expect(fs.realpathSync(nativeCreatorLink)).toBe(fs.realpathSync(creatorLink));
    expect(fs.realpathSync(nativeLearnLink)).toBe(fs.realpathSync(learnLink));
  });

  it('finishes a committed active-pointer switch after an interrupted upgrade', async () => {
    const input = fixture();
    const initial = await prepareBuiltInSkills(input);
    const root = path.join(input.appDataDir, 'Cindy', 'shared-system-skills');
    const activePath = path.join(root, '.active');
    const oldActiveTarget = fs.readlinkSync(activePath);
    const oldCreatorBytes = fs.realpathSync(initial.descriptors[0]!.absolutePath);
    fs.appendFileSync(path.join(input.source, 'SKILL.md'), '\nCreator v2\n');

    const upgraded = await prepareBuiltInSkills({
      ...input,
      bundleVersion: BUILT_IN_SKILLS_BUNDLE_VERSION + 1,
    });
    const committedCreatorBytes = fs.realpathSync(upgraded.descriptors[0]!.absolutePath);
    expect(committedCreatorBytes).not.toBe(oldCreatorBytes);

    // Simulate termination after the manifest commit but before .active moved.
    fs.unlinkSync(activePath);
    fs.symlinkSync(oldActiveTarget, activePath, process.platform === 'win32' ? 'junction' : 'dir');
    const sharedLink = path.join(input.homeDir, '.agents', 'skills', 'cindy-skill-creator');
    expect(fs.realpathSync(sharedLink)).toBe(oldCreatorBytes);

    const recovered = await prepareBuiltInSkills({
      ...input,
      bundleVersion: BUILT_IN_SKILLS_BUNDLE_VERSION + 1,
    });

    expect(recovered.changed).toBe(true);
    expect(recovered.projectionSafe).toBe(true);
    expect(recovered.warnings).toEqual([]);
    expect(fs.realpathSync(sharedLink)).toBe(committedCreatorBytes);
  });

  it('repairs a committed active pointer redirected outside the managed versions directory', async () => {
    const input = fixture();
    const initial = await prepareBuiltInSkills(input);
    const root = path.join(input.appDataDir, 'Cindy', 'shared-system-skills');
    const activePath = path.join(root, '.active');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, '.cindy-system-skills.json'), 'utf8'),
    );
    const committedRoot = path.join(root, '.versions', manifest.activeBundle);
    const redirectedRoot = path.join(input.appDataDir, 'redirected-system-skills');
    const redirectedCreator = path.join(redirectedRoot, 'cindy-skill-creator');
    fs.mkdirSync(redirectedCreator, { recursive: true });
    fs.writeFileSync(path.join(redirectedCreator, 'SKILL.md'), '# Redirected\n');
    fs.unlinkSync(activePath);
    fs.symlinkSync(redirectedRoot, activePath, process.platform === 'win32' ? 'junction' : 'dir');
    const sharedLink = path.join(input.homeDir, '.agents', 'skills', 'cindy-skill-creator');
    expect(fs.realpathSync(sharedLink)).toBe(fs.realpathSync(redirectedCreator));

    const recovered = await prepareBuiltInSkills(input);

    expect(recovered.changed).toBe(true);
    expect(recovered.projectionSafe).toBe(true);
    expect(recovered.warnings).toEqual([]);
    expect(fs.realpathSync(activePath)).toBe(fs.realpathSync(committedRoot));
    expect(fs.realpathSync(sharedLink)).toBe(fs.realpathSync(initial.descriptors[0]!.absolutePath));
    expect(fs.readFileSync(path.join(redirectedCreator, 'SKILL.md'), 'utf8')).toBe(
      '# Redirected\n',
    );
  });

  it.each(['directory', 'outside-link', 'wrong-bundle', 'modified-content', 'missing-manifest', 'linked-bundle'])(
    'withholds official identity from %s even after successful preparation',
    async (damage) => {
      const input = fixture();
      const prepared = await prepareBuiltInSkills(input);
      const root = path.join(input.appDataDir, 'Cindy', 'shared-system-skills');
      const active = path.join(root, '.active');
      const target = fs.realpathSync(active);
      const skillPath = path.join(active, 'cindy-skill-creator');
      expect(prepared.projectionSafe).toBe(true);
      expect(builtInSkillDescriptors(input.userDataDir, input.appDataDir)).toHaveLength(2);
      if (damage === 'modified-content') {
        fs.appendFileSync(path.join(skillPath, 'SKILL.md'), '\nChanged');
      } else if (damage === 'missing-manifest') {
        fs.unlinkSync(path.join(root, '.cindy-system-skills.json'));
      } else if (damage === 'linked-bundle') {
        const outside = path.join(input.homeDir, 'substituted-bundle');
        fs.renameSync(target, outside);
        fs.symlinkSync(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
      } else {
        fs.unlinkSync(active);
        const replacement = damage === 'directory' ? active
          : damage === 'outside-link' ? path.join(input.homeDir, 'outside-bundle')
            : path.join(root, '.versions', 'v10-0123456789abcdef-11111111-1111-1111-1111-111111111111');
        fs.cpSync(target, replacement, { recursive: true });
        if (damage !== 'directory') {
          fs.symlinkSync(replacement, active, process.platform === 'win32' ? 'junction' : 'dir');
        }
      }
      const descriptors = builtInSkillDescriptors(input.userDataDir, input.appDataDir);
      expect(descriptors).toEqual([]);
      const [command] = markCindyBuiltInAgentSkills([{
        kind: 'agent-skill', name: 'cindy-skill-creator', source: 'skill',
        path: path.join(skillPath, 'SKILL.md'), scope: 'user', enabled: true, builtIn: true,
      }], descriptors);
      expect(command?.builtIn).toBeUndefined();
      const maker = { listCustomizations: async () => ({ errors: [], items: [{
        engine: 'codex', kind: 'skill', scope: 'user', name: 'cindy-skill-creator',
        absolutePath: skillPath, mdPath: path.join(skillPath, 'SKILL.md'), files: [],
      }] }) } as unknown as Maker;
      const scanned = await scanAllSkills({}, maker, [], descriptors);
      expect(scanned.skills).toHaveLength(1);
      expect(scanned.skills[0]?.builtIn).not.toBe(true);
    },
  );

  it('does not overwrite a non-link active pointer placeholder', async () => {
    const input = fixture();
    await prepareBuiltInSkills(input);
    const root = path.join(input.appDataDir, 'Cindy', 'shared-system-skills');
    const activePath = path.join(root, '.active');
    fs.unlinkSync(activePath);
    fs.mkdirSync(path.join(activePath, 'cindy-skill-creator'), { recursive: true });
    fs.writeFileSync(
      path.join(activePath, 'cindy-skill-creator', 'SKILL.md'),
      '# User placeholder\n',
    );

    const failed = await prepareBuiltInSkills(input);

    expect(failed.changed).toBe(false);
    expect(failed.projectionSafe).toBe(false);
    expect(failed.descriptors).toEqual([]);
    expect(failed.warnings.join('\n')).toContain('active pointer is not a link');
    expect(fs.lstatSync(activePath).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(activePath, 'cindy-skill-creator', 'SKILL.md'), 'utf8')).toBe(
      '# User placeholder\n',
    );
  });

  it('restores the previous manifest and active pointer when publication fails', async () => {
    const input = fixture();
    const initial = await prepareBuiltInSkills(input);
    const root = path.join(input.appDataDir, 'Cindy', 'shared-system-skills');
    const manifestPath = path.join(root, '.cindy-system-skills.json');
    const activePath = path.join(root, '.active');
    const initialManifest = fs.readFileSync(manifestPath, 'utf8');
    const initialActiveTarget = fs.readlinkSync(activePath);
    const initialCreatorBytes = fs.realpathSync(initial.descriptors[0]!.absolutePath);
    fs.appendFileSync(path.join(input.source, 'SKILL.md'), '\nCreator v2\n');

    const failed = await prepareBuiltInSkills({
      ...input,
      bundleVersion: BUILT_IN_SKILLS_BUNDLE_VERSION + 1,
      replaceDirectoryEntryAtomically: async (replacement, destination) => {
        expect(replacement).toContain('.active.next-');
        expect(destination).toBe(activePath);
        expect(fs.existsSync(activePath)).toBe(true);
        throw new Error('blocked active pointer switch');
      },
    });

    expect(failed.projectionSafe).toBe(true);
    expect(failed.warnings.join('\n')).toContain('blocked active pointer switch');
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(initialManifest);
    expect(fs.readlinkSync(activePath)).toBe(initialActiveTarget);
    expect(fs.realpathSync(initial.descriptors[0]!.absolutePath)).toBe(initialCreatorBytes);
    expect(fs.readdirSync(path.join(root, '.versions'))).toEqual([
      JSON.parse(initialManifest).activeBundle,
    ]);
  });

  it('repairs projections left on an unpublished bundle before another activation', async () => {
    const input = fixture();
    const initial = await prepareBuiltInSkills(input);
    const root = path.join(input.appDataDir, 'Cindy', 'shared-system-skills');
    const orphanBundle = 'v10-aaaaaaaaaaaaaaaa-00000000-0000-0000-0000-000000000000';
    const orphanRoot = path.join(root, '.versions', orphanBundle);
    // Copy the immutable bundle, not its .active junction/symlink. The orphan
    // must be a separate directory, including on Windows without symlink rights.
    const bundleRoot = fs.realpathSync(path.dirname(initial.descriptors[0]!.absolutePath));
    fs.cpSync(bundleRoot, orphanRoot, {
      recursive: true,
      dereference: true,
    });
    expect(fs.lstatSync(orphanRoot).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(orphanRoot).isDirectory()).toBe(true);
    expect(fs.realpathSync(orphanRoot)).not.toBe(bundleRoot);
    const creatorLink = path.join(input.homeDir, '.agents', 'skills', 'cindy-skill-creator');
    fs.unlinkSync(creatorLink);
    fs.symlinkSync(
      path.join(orphanRoot, 'cindy-skill-creator'),
      creatorLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(fs.realpathSync(creatorLink)).not.toBe(
      fs.realpathSync(initial.descriptors[0]!.absolutePath),
    );

    const repaired = await prepareBuiltInSkills(input);

    expect(repaired.projectionSafe).toBe(true);
    expect(fs.realpathSync(creatorLink)).toBe(
      fs.realpathSync(initial.descriptors[0]!.absolutePath),
    );
  });

  it('migrates direct current-version links onto the stable active path', async () => {
    const input = fixture();
    const initial = await prepareBuiltInSkills(input);
    const root = path.join(input.appDataDir, 'Cindy', 'shared-system-skills');
    const descriptor = initial.descriptors[0]!;
    const immutableTarget = fs.realpathSync(descriptor.absolutePath);
    const sharedLink = path.join(input.homeDir, '.agents', 'skills', descriptor.name);
    fs.unlinkSync(sharedLink);
    fs.symlinkSync(
      immutableTarget,
      sharedLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const migrated = await prepareBuiltInSkills(input);

    expect(fs.readlinkSync(sharedLink)).toBe(path.join(root, '.active', descriptor.name));
    expect(fs.realpathSync(sharedLink)).toBe(immutableTarget);
    expect(migrated.changed).toBe(true);
    expect(migrated.warnings).toEqual([]);
  });

  it('removes first-install projections when no bundle was ever activated', async () => {
    const input = fixture();
    const root = path.join(input.appDataDir, 'Cindy', 'shared-system-skills');
    const orphanBundle = 'v8-bbbbbbbbbbbbbbbb-00000000-0000-0000-0000-000000000000';
    const orphanRoot = path.join(root, '.versions', orphanBundle);
    const sharedLink = path.join(input.homeDir, '.agents', 'skills', 'cindy-skill-creator');
    const nativeLink = path.join(input.userDataDir, 'claude-home', 'skills', 'cindy-skill-creator');
    fs.mkdirSync(path.join(orphanRoot, 'cindy-skill-creator'), { recursive: true });
    fs.writeFileSync(
      path.join(orphanRoot, 'cindy-skill-creator', 'SKILL.md'),
      '# Unpublished\n',
    );
    fs.mkdirSync(path.dirname(sharedLink), { recursive: true });
    fs.mkdirSync(path.dirname(nativeLink), { recursive: true });
    fs.symlinkSync(
      path.join(orphanRoot, 'cindy-skill-creator'),
      sharedLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    fs.symlinkSync(sharedLink, nativeLink, process.platform === 'win32' ? 'junction' : 'dir');
    fs.writeFileSync(
      path.join(root, '.cindy-system-skills.json'),
      `${JSON.stringify({ schemaVersion: 2, bundleVersion: 0, fingerprints: {} })}\n`,
    );
    fs.renameSync(
      path.join(input.bundledRoot, 'learn', 'SKILL.md'),
      path.join(input.bundledRoot, 'learn', 'SKILL.md.missing'),
    );

    const recovered = await prepareBuiltInSkills(input);

    expect(recovered.projectionSafe).toBe(false);
    expect(recovered.warnings.join('\n')).toContain('missing SKILL.md');
    expect(fs.existsSync(sharedLink)).toBe(false);
    expect(fs.existsSync(nativeLink)).toBe(false);
    expect(JSON.parse(fs.readFileSync(
      path.join(root, '.cindy-system-skills.json'),
      'utf8',
    ))).toEqual({ schemaVersion: 2, bundleVersion: 0, fingerprints: {} });
  });

  it('creates a durable empty manifest before publishing the first version', async () => {
    const input = fixture();
    const root = path.join(input.appDataDir, 'Cindy', 'shared-system-skills');
    const manifestPath = path.join(root, '.cindy-system-skills.json');
    const originalRename = fs.renameSync.bind(fs);
    let manifestWrites = 0;
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (String(destination) === manifestPath && String(source).endsWith('.tmp')) {
        manifestWrites += 1;
        if (manifestWrites === 2) throw new Error('blocked first activation');
      }
      originalRename(source, destination);
    });

    const failed = await prepareBuiltInSkills(input);

    expect(failed.changed).toBe(false);
    expect(failed.warnings.join('\n')).toContain('blocked first activation');
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))).toEqual({
      schemaVersion: 2,
      bundleVersion: 0,
      fingerprints: {},
    });

    rename.mockRestore();
    const retried = await prepareBuiltInSkills(input);
    expect(retried.changed).toBe(true);
    expect(retried.warnings).toEqual([]);
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))).toMatchObject({
      schemaVersion: 3,
      bundleVersion: BUILT_IN_SKILLS_BUNDLE_VERSION,
    });
  });

  it('keeps a user-owned same-name Skill while retaining the Cindy copy', async () => {
    const input = fixture();
    const userSkill = path.join(input.homeDir, '.agents', 'skills', 'cindy-skill-creator');
    fs.mkdirSync(userSkill, { recursive: true });
    fs.writeFileSync(path.join(userSkill, 'SKILL.md'), '# User copy\n');

    const result = await prepareAndProjectBuiltInSkills(input);
    expect(fs.readFileSync(path.join(userSkill, 'SKILL.md'), 'utf8')).toBe('# User copy\n');
    expect(fs.existsSync(path.join(result.descriptors[0]!.absolutePath, 'SKILL.md'))).toBe(true);
    expect(fs.realpathSync(result.descriptors[0]!.nativeClaudePath)).toBe(
      fs.realpathSync(userSkill),
    );
    expect(result.warnings.join('\n')).toContain('already owned by the user');
  });

  it('keeps every profile on one stable shared copy', async () => {
    const input = fixture();
    const first = await prepareAndProjectBuiltInSkills(input);
    const sharedDescriptor = first.descriptors[0]!;
    const link = path.join(input.homeDir, '.agents', 'skills', 'cindy-skill-creator');
    const nextUserDataDir = path.join(path.dirname(input.userDataDir), 'next-user-data');

    const next = await prepareAndProjectBuiltInSkills({ ...input, userDataDir: nextUserDataDir });
    const nextDescriptor = next.descriptors[0]!;

    expect(next.warnings).toEqual([]);
    expect(next.changed).toBe(true);
    expect(nextDescriptor.absolutePath).toBe(sharedDescriptor.absolutePath);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(sharedDescriptor.absolutePath));
    expect(fs.realpathSync(nextDescriptor.nativeClaudePath)).toBe(fs.realpathSync(link));
  });

  it('repairs a broken link left by an earlier Cindy profile', async () => {
    const input = fixture();
    const oldProfile = path.join(input.appDataDir, 'CindyDev-dev2-old-checkout');
    const oldTarget = path.join(oldProfile, 'system-skills', 'cindy-skill-creator');
    const link = path.join(input.homeDir, '.agents', 'skills', 'cindy-skill-creator');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(oldTarget, link, process.platform === 'win32' ? 'junction' : 'dir');

    const result = await prepareAndProjectBuiltInSkills(input);

    expect(result.warnings).toEqual([]);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(result.descriptors[0]!.absolutePath));
  });

  it('does not mutate shared Skill paths when the cross-process lease is unavailable', async () => {
    const input = fixture();
    const result = await prepareBuiltInSkills({
      ...input,
      withSharedMutation: async () => undefined,
    });

    expect(result.changed).toBe(false);
    expect(result.warnings.join('\n')).toContain('another Skill mutation is in progress');
    expect(result.descriptors).toEqual([]);
    expect(fs.existsSync(path.join(input.appDataDir, 'Cindy', 'shared-system-skills', '.active'))).toBe(false);
    expect(fs.existsSync(path.join(input.homeDir, '.agents', 'skills', 'cindy-skill-creator'))).toBe(false);
  });

  it('does not activate app-owned bytes until home and Claude projections are ready', async () => {
    const input = fixture();
    const result = await prepareBuiltInSkills(input);

    expect(fs.existsSync(result.descriptors[0]!.absolutePath)).toBe(true);
    expect(fs.realpathSync(path.join(
      input.homeDir,
      '.agents',
      'skills',
      'cindy-skill-creator',
    ))).toBe(fs.realpathSync(result.descriptors[0]!.absolutePath));
    expect(fs.realpathSync(result.descriptors[0]!.nativeClaudePath)).toBe(
      fs.realpathSync(result.descriptors[0]!.absolutePath),
    );
  });

  it('waits a bounded interval for another profile to finish materialization', async () => {
    const input = fixture();
    let waitMs: number | undefined;
    const result = await prepareBuiltInSkills({
      ...input,
      withSharedMutation: async (_names, operation, options) => {
        waitMs = options?.waitMs;
        return operation();
      },
    });

    expect(waitMs).toBe(5_000);
    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(result.descriptors[0]!.absolutePath)).toBe(true);
  });

  it('keeps a user-owned same-name symlink', async () => {
    const input = fixture();
    const userSource = path.join(path.dirname(input.homeDir), 'user-skill');
    const userSkill = path.join(input.homeDir, '.agents', 'skills', 'cindy-skill-creator');
    fs.mkdirSync(userSource, { recursive: true });
    fs.mkdirSync(path.dirname(userSkill), { recursive: true });
    fs.writeFileSync(path.join(userSource, 'SKILL.md'), '# User symlink copy\n');
    fs.symlinkSync(userSource, userSkill, process.platform === 'win32' ? 'junction' : 'dir');

    const result = await prepareAndProjectBuiltInSkills(input);

    expect(fs.realpathSync(userSkill)).toBe(fs.realpathSync(userSource));
    expect(result.warnings.join('\n')).toContain('already owned by the user');
  });

  it('keeps a user-owned Skill in the isolated Claude config directory', async () => {
    const input = fixture();
    const nativeClaudePath = path.join(input.userDataDir, 'claude-home', 'skills', 'cindy-skill-creator');
    fs.mkdirSync(nativeClaudePath, { recursive: true });
    fs.writeFileSync(path.join(nativeClaudePath, 'SKILL.md'), '# Claude user copy\n');

    const result = await prepareAndProjectBuiltInSkills(input);
    expect(fs.readFileSync(path.join(nativeClaudePath, 'SKILL.md'), 'utf8')).toBe(
      '# Claude user copy\n',
    );
    expect(result.warnings.join('\n')).toContain('already owned by the user');
  });

  it('refreshes the isolated Claude runtime when the palette winner changes', async () => {
    const input = fixture();
    const first = await prepareAndProjectBuiltInSkills(input);
    const descriptor = first.descriptors.find((item) => item.name === 'learn')!;
    const sharedSkill = path.join(input.homeDir, '.agents', 'skills', 'learn');
    expect(fs.realpathSync(descriptor.nativeClaudePath)).toBe(fs.realpathSync(sharedSkill));

    const claudePaletteSkill = path.join(input.homeDir, '.claude', 'skills', 'learn');
    fs.mkdirSync(claudePaletteSkill, { recursive: true });
    fs.writeFileSync(path.join(claudePaletteSkill, 'SKILL.md'), '# User Claude Learn\n');

    const updated = await refreshBuiltInClaudeSkillLinks({
      ...input,
      descriptors: first.descriptors,
    });

    expect(updated.warnings).toEqual([]);
    expect(fs.realpathSync(sharedSkill)).toBe(fs.realpathSync(descriptor.absolutePath));
    expect(fs.realpathSync(descriptor.nativeClaudePath)).toBe(
      fs.realpathSync(claudePaletteSkill),
    );

    fs.rmSync(claudePaletteSkill, { recursive: true, force: true });
    const restored = await refreshBuiltInClaudeSkillLinks({
      ...input,
      descriptors: first.descriptors,
    });

    expect(restored.warnings).toEqual([]);
    expect(fs.realpathSync(descriptor.nativeClaudePath)).toBe(fs.realpathSync(sharedSkill));
  });

  it('attests only commands backed by the materialized Cindy copy', async () => {
    const input = fixture();
    const { descriptors } = await prepareBuiltInSkills(input);
    const bundledSkill = path.join(descriptors[0]!.absolutePath, 'SKILL.md');
    const userCopy = path.join(input.homeDir, 'user-copy', 'SKILL.md');
    fs.mkdirSync(path.dirname(userCopy), { recursive: true });
    fs.writeFileSync(userCopy, '# User copy\n');

    const [official, spoofed] = markCindyBuiltInAgentSkills([
      {
        kind: 'agent-skill', name: 'cindy-skill-creator', source: 'skill',
        path: bundledSkill, scope: 'user', enabled: true,
      },
      {
        kind: 'agent-skill', name: 'cindy-skill-creator', source: 'skill',
        description: 'Create or update a Cindy Skill', path: userCopy,
        scope: 'user', enabled: true, builtIn: true,
      },
    ], descriptors);

    expect(official?.builtIn).toBe(true);
    expect(spoofed?.builtIn).toBeUndefined();
  });

  it('removes disabled Cindy built-ins from the Agent roster without hiding user collisions', async () => {
    const input = fixture();
    const { descriptors } = await prepareBuiltInSkills(input);
    const descriptor = descriptors[0]!;
    const userCopy = path.join(input.homeDir, 'user-copy', 'SKILL.md');
    fs.mkdirSync(path.dirname(userCopy), { recursive: true });
    fs.writeFileSync(userCopy, '# User copy\n');

    const skills = activeCindyBuiltInAgentSkills([
      {
        kind: 'agent-skill', name: descriptor.name, source: 'skill',
        path: path.join(descriptor.absolutePath, 'SKILL.md'), scope: 'user', enabled: true,
      },
      {
        kind: 'agent-skill', name: descriptor.name, source: 'skill',
        path: userCopy, scope: 'user', enabled: true,
      },
    ], descriptors, (source) => source !== descriptor.absolutePath);

    expect(skills).toHaveLength(1);
    expect(skills[0]?.path).toBe(userCopy);
    expect(skills[0]?.builtIn).toBeUndefined();
  });

  it('resolves source and packaged resource roots', () => {
    expect(
      resolveBundledSystemSkillsRoot({
        isPackaged: false,
        appPath: '/repo/apps/desktop',
        resourcesPath: '/app/resources',
      }),
    ).toBe(path.join('/repo/apps/desktop', 'resources', 'system-skills'));
    expect(
      resolveBundledSystemSkillsRoot({
        isPackaged: true,
        appPath: '/repo/apps/desktop',
        resourcesPath: '/app/resources',
      }),
    ).toBe(path.join('/app/resources', 'system-skills'));
  });
});
