import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Maker } from '@cindy/maker-core';

const { project, listAllInstalls, readDisabled } = vi.hoisted(() => ({
  project: vi.fn(), listAllInstalls: vi.fn(), readDisabled: vi.fn(() => []),
}));
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));
vi.mock('../customizationScanHost', () => ({ projectSkillList: project }));
vi.mock('../registry', () => ({ registryService: { listAllInstalls } }));
vi.mock('../activationPreferences', () => ({ readDisabledSkillPathsForListing: readDisabled, renameSkillWithActivation: vi.fn() }));
vi.mock('../registryReconciliation', () => ({ reconcileScannedInstall: () => { throw new Error('Scan must not maintain installs'); } }));
import { scanAllSkills } from '../scanner';

describe('Main scan isolation', () => {
  it('passes offline registry paths to the bounded projection without touching them on Main', async () => {
    const offline = path.join(os.tmpdir(), 'offline-volume', '.agents', 'skills', 'offline');
    const record = { skillName: 'offline', installPath: offline, entry: { version: '1' } };
    listAllInstalls.mockResolvedValue([record]);
    const error = { message: '[pi] Customization scan timed out' };
    const listed = { items: [], errors: [error] };
    const maker = { listCustomizations: vi.fn(async () => listed) } as unknown as Maker;
    const expected = { skills: [], sources: [{ kind: 'skill', scope: 'global', path: '', status: { state: 'error', message: error.message } }] };
    project.mockResolvedValue(expected);
    const realpath = vi.spyOn(fs, 'realpathSync').mockImplementation(() => { throw new Error('Main must not resolve paths'); });
    try {
      expect(await scanAllSkills({}, maker)).toBe(expected);
      expect(listAllInstalls).toHaveBeenCalledExactlyOnceWith({ readOnly: true });
      expect(project).toHaveBeenCalledWith(expect.objectContaining({ listed, registryEntries: [record] }));
      expect(realpath).not.toHaveBeenCalled();
    } finally { realpath.mockRestore(); }
  });
});
