import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-skill-preferences-'));
vi.mock('electron', () => ({ app: { getPath: () => root } }));
vi.mock('../../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
beforeAll(async () => {
  const bundledRoot = path.join(root, 'bundled');
  for (const name of ['cindy-skill-creator', 'learn']) {
    fs.mkdirSync(path.join(bundledRoot, name), { recursive: true });
    fs.writeFileSync(path.join(bundledRoot, name, 'SKILL.md'), `# ${name}\n`);
  }
  const { prepareBuiltInSkills } = await import('../../maker-host/built-in-skills');
  const result = await prepareBuiltInSkills({
    userDataDir: root, appDataDir: root, homeDir: path.join(root, 'fixture-home'), bundledRoot,
    withSharedMutation: async (_names, operation) => operation(),
  });
  expect(result.projectionSafe).toBe(true);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('Skill activation preferences', () => {
  it('clears only captured disabled intent, preserving later toggles and unrelated paths', async () => {
    const prefs = await import('../activationPreferences');
    const source = path.join(root, 'intent-source');
    const other = path.join(root, 'intent-other');
    await prefs.setCindySkillEnabled(source, false);
    const snapshot = prefs.snapshotSkillActivation(source)!;
    await prefs.setCindySkillEnabled(source, true);
    await prefs.setCindySkillEnabled(source, false);
    await prefs.setCindySkillEnabled(other, false);
    await prefs.clearSkillActivationSnapshot(snapshot, () => true);
    expect(prefs.isCindySkillEnabled(source)).toBe(false);
    const current = prefs.snapshotSkillActivation(source)!;
    await prefs.clearSkillActivationSnapshot(current, () => true);
    expect(prefs.isCindySkillEnabled(source)).toBe(true);
    expect(prefs.isCindySkillEnabled(other)).toBe(false);
    await prefs.setCindySkillEnabled(other, true);
  });

  it('defaults to native behavior, persists only disabled paths, and preserves concurrent changes', async () => {
    const { isCindySkillEnabled, setCindySkillEnabled, readDisabledSkillPaths, skillActivationKey } = await import('../activationPreferences');
    const a = path.join(root, 'project-a', 'skill');
    const b = path.join(root, 'project-b', 'skill');
    expect(isCindySkillEnabled(a)).toBe(true);
    await Promise.all([setCindySkillEnabled(a, false), setCindySkillEnabled(b, false)]);
    expect(new Set(readDisabledSkillPaths())).toEqual(new Set([skillActivationKey(a), skillActivationKey(b)]));
    await setCindySkillEnabled(a, true);
    expect(isCindySkillEnabled(a)).toBe(true);
    expect(isCindySkillEnabled(b)).toBe(false);
    await expect(setCindySkillEnabled(a, false, () => false)).rejects.toThrow('context changed');
    expect(isCindySkillEnabled(a)).toBe(true);
    vi.resetModules();
    const reloaded = await import('../activationPreferences');
    expect(reloaded.isCindySkillEnabled(b)).toBe(false);
    await reloaded.setCindySkillEnabled(b, true);
    expect(reloaded.readDisabledSkillPaths()).toEqual([]);
  });
  it('reports the built-in Learn Skill activation state from its stable identity', async () => {
    const prefs = await import('../activationPreferences');
    const descriptors = (await import('../../maker-host/built-in-skills')).builtInSkillDescriptors(root, root);
    const learn = descriptors.find((descriptor) => descriptor.name === 'learn')!;
    expect(prefs.isCindyLearnSkillEnabled()).toBe(true);
    await prefs.setCindySkillEnabled(learn.absolutePath, false);
    expect(prefs.isCindyLearnSkillEnabled()).toBe(false);
    await prefs.setCindySkillEnabled(learn.absolutePath, true);
    expect(prefs.isCindyLearnSkillEnabled()).toBe(true);
  });
  it('keeps built-in activation intent across immutable bundle revisions', async () => {
    const prefs = await import('../activationPreferences');
    const versions = path.join(root, 'Cindy', 'shared-system-skills', '.versions');
    const oldSkill = path.join(
      versions,
      'v6-0123456789abcdef-11111111-1111-1111-1111-111111111111',
      'learn',
    );
    const newSkill = path.join(
      versions,
      'v7-fedcba9876543210-22222222-2222-2222-2222-222222222222',
      'learn',
    );
    fs.mkdirSync(oldSkill, { recursive: true });
    fs.mkdirSync(newSkill, { recursive: true });

    expect(prefs.skillActivationKey(oldSkill)).toBe(prefs.skillActivationKey(newSkill));
    await prefs.setCindySkillEnabled(oldSkill, false);
    expect(prefs.isCindySkillEnabled(newSkill)).toBe(false);
    await prefs.setCindySkillEnabled(newSkill, true);
  });
  it('does not canonicalize a user-owned directory that resembles a built-in version', async () => {
    const prefs = await import('../activationPreferences');
    const versions = path.join(root, 'project', '.versions');
    const oldSkill = path.join(
      versions,
      'v6-0123456789abcdef-11111111-1111-1111-1111-111111111111',
      'learn',
    );
    const newSkill = path.join(
      versions,
      'v7-fedcba9876543210-22222222-2222-2222-2222-222222222222',
      'learn',
    );
    fs.mkdirSync(oldSkill, { recursive: true });
    fs.mkdirSync(newSkill, { recursive: true });

    expect(prefs.skillActivationKey(oldSkill)).not.toBe(prefs.skillActivationKey(newSkill));
  });
  it('also disables native runtime projections when the Cindy built-in Skill is disabled', async () => {
    const prefs = await import('../activationPreferences');
    const descriptor = (await import('../../maker-host/built-in-skills')).builtInSkillDescriptors(root, root)[0]!;
    fs.mkdirSync(descriptor.absolutePath, { recursive: true });
    fs.mkdirSync(path.dirname(descriptor.nativeClaudePath), { recursive: true });
    fs.rmSync(descriptor.nativeClaudePath, { recursive: true, force: true });
    fs.symlinkSync(
      descriptor.absolutePath,
      descriptor.nativeClaudePath,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await prefs.setCindySkillEnabled(descriptor.absolutePath, false);
    expect(prefs.readDisabledSkillPaths()).toEqual(expect.arrayContaining([
      prefs.skillActivationKey(descriptor.absolutePath),
      descriptor.nativeClaudePath,
    ]));
    await prefs.setCindySkillEnabled(descriptor.absolutePath, true);
  });
  it('does not disable a user-owned native projection with the built-in toggle', async () => {
    const prefs = await import('../activationPreferences');
    const descriptor = (await import('../../maker-host/built-in-skills')).builtInSkillDescriptors(root, root)[0]!;
    const userSkill = path.join(root, 'user-owned-cindy-skill-creator');
    fs.mkdirSync(descriptor.absolutePath, { recursive: true });
    fs.mkdirSync(userSkill, { recursive: true });
    fs.writeFileSync(path.join(userSkill, 'SKILL.md'), '# User owned\n');
    fs.rmSync(descriptor.nativeClaudePath, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(descriptor.nativeClaudePath), { recursive: true });
    fs.symlinkSync(
      userSkill,
      descriptor.nativeClaudePath,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await prefs.setCindySkillEnabled(descriptor.absolutePath, false);
    expect(prefs.readDisabledSkillPaths()).not.toContain(descriptor.nativeClaudePath);
    await prefs.setCindySkillEnabled(descriptor.absolutePath, true);
  });
  it('persists lexical aliases across restart, bypasses wide Pi scans, and drops retargeted aliases', async () => {
    const prefs = await import('../activationPreferences');
    const source = path.join(root, 'external');
    const other = path.join(root, 'other');
    const discovery = path.join(root, '.agents', 'skills');
    const alias = path.join(discovery, 'z-alias');
    fs.mkdirSync(source);
    fs.mkdirSync(other);
    fs.mkdirSync(discovery, { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), 'fixture');
    fs.symlinkSync(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await prefs.setCindySkillEnabled(source, false, () => true, [alias]);
    vi.resetModules();
    const reloaded = await import('../activationPreferences');
    const { piDisabledDiscoveryPaths, applyPiDisabledSkillSettings } = await import(
      '../../../../../../packages/maker-core/src/agents/pi/skill-activation');
    const close = vi.fn();
    const scan = vi.spyOn(fs, 'opendirSync').mockReturnValue({
      readSync: () => ({ name: '.irrelevant' }), closeSync: close,
    } as unknown as fs.Dir);
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      const disabled = piDisabledDiscoveryPaths(reloaded.readDisabledSkillPaths(), [discovery]);
      const settings = applyPiDisabledSkillSettings({}, disabled);
      expect(settings.skills).toContain(`-${alias}`);
      expect(close).toHaveBeenCalled();
    } finally { scan.mockRestore(); clock.mockRestore(); }
    fs.unlinkSync(alias);
    fs.symlinkSync(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(reloaded.readDisabledSkillPaths()).not.toContain(alias);
    expect(reloaded.isCindySkillEnabled(other)).toBe(true);
    fs.unlinkSync(alias);
    fs.symlinkSync(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await reloaded.setCindySkillEnabled(source, true);
    expect(reloaded.readDisabledSkillPaths()).not.toContain(alias);
    expect(reloaded.isCindySkillEnabled(source)).toBe(true);
  });

  it.each(['success', 'enabled-source', 'backup-cleanup-failure', 'content-failure', 'preference-failure', 'owner-changed', 'shared-busy'])('migrates disabled state with a local rename (%s)', async (scenario) => {
    const { renameLocalSkill } = await import('../scanner');
    const { setCindySkillEnabled, readDisabledSkillPaths, skillActivationKey } = await import('../activationPreferences');
    const source = path.join(root, scenario, '.agents', 'skills', 'old-name');
    const destination = path.join(path.dirname(source), 'new-name');
    const content = '---\nname: old-name\n---\nOriginal content\n';
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), content);
    await setCindySkillEnabled(scenario === 'enabled-source' ? destination : source, false);
    const before = [...readDisabledSkillPaths()];
    const oldKey = skillActivationKey(source);
    const { acquireSharedSkillMutationLease } = await import('../sharedMutationLease');
    const externalLease = scenario === 'shared-busy' ? await acquireSharedSkillMutationLease(['old-name']) : null;
    const realRename = fs.renameSync;
    const realUnlink = fs.unlinkSync;
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
      if (scenario === 'backup-cleanup-failure' && String(file).startsWith(path.join(destination, 'SKILL.md.xdt-rename-'))) {
        throw Object.assign(new Error('simulated locked backup'), { code: 'EPERM' });
      }
      return realUnlink(file);
    });
    let injected = false;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!injected && ((scenario === 'content-failure' && String(to) === path.join(destination, 'SKILL.md'))
        || (scenario === 'preference-failure' && String(to).endsWith('activation-preferences.json')))) {
        injected = true;
        throw new Error('simulated write failure');
      }
      return realRename(from, to);
    });
    try {
      const result = await renameLocalSkill({ absolutePath: source, newName: 'new-name' }, () => scenario !== 'owner-changed');
      if (scenario === 'success' || scenario === 'enabled-source' || scenario === 'backup-cleanup-failure') {
        expect(result).toEqual({ success: true, newAbsolutePath: destination });
        expect(readDisabledSkillPaths()).not.toContain(oldKey);
        if (scenario !== 'enabled-source') expect(readDisabledSkillPaths()).toContain(skillActivationKey(destination));
        else expect(readDisabledSkillPaths()).not.toContain(skillActivationKey(destination));
        expect(fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8')).toContain('name: new-name');
        if (scenario === 'backup-cleanup-failure') {
          const backup = fs.readdirSync(destination).find((name) => name.startsWith('SKILL.md.xdt-rename-'))!;
          expect(backup).toBeTruthy();
          expect(fs.readFileSync(path.join(destination, backup), 'utf8')).toBe(content);
          const { listSkillFolderChildren, readSkillRawFile } = await import('../scanner');
          const { computeFolderHashDetailed } = await import('../folderHash');
          const { pack } = await import('../zipPacker');
          const { writeSnapshot, getSnapshotPath } = await import('../snapshot');
          const { default: JSZip } = await import('jszip');
          const visible = await listSkillFolderChildren({ dirPath: destination });
          expect(visible).toEqual({ success: true, entries: [{ name: 'SKILL.md', kind: 'file' }] });
          expect((await readSkillRawFile({ filePath: path.join(destination, backup) })).success).toBe(false);
          const hash = await computeFolderHashDetailed(destination);
          expect(hash.manifest.map((file) => file.path)).toEqual(['SKILL.md']);
          const packed = await pack(destination);
          expect(packed.manifest.files.map((file) => file.relPath)).toEqual(['SKILL.md']);
          const zip = await JSZip.loadAsync(packed.buffer);
          expect(Object.keys(zip.files)).toEqual(['SKILL.md']);
          expect(await zip.file('SKILL.md')!.async('string')).toContain('name: new-name');
          await writeSnapshot(destination, 'cleanup-failure');
          expect(fs.readdirSync(getSnapshotPath('cleanup-failure'))).toEqual(['SKILL.md']);
          realUnlink(path.join(destination, backup));
          expect((await computeFolderHashDetailed(destination)).hash).toBe(hash.hash);
          expect((await pack(destination)).sha256).toBe(packed.sha256);
        }
      } else {
        expect(injected).toBe(scenario !== 'owner-changed' && scenario !== 'shared-busy');
        expect(result.success).toBe(false);
        expect(fs.existsSync(destination)).toBe(false);
        expect(fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8')).toBe(content);
        expect(readDisabledSkillPaths()).toEqual(before);
      }
    } finally { spy.mockRestore(); unlinkSpy.mockRestore(); await externalLease?.(); }
  });

});
