import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-skill-preferences-'));
vi.mock('electron', () => ({ app: { getPath: () => root } }));
vi.mock('../../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
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
