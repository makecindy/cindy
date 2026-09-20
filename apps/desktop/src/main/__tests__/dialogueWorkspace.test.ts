import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let userDataDir = '';

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected app path: ${name}`);
      return userDataDir;
    },
  },
}));

vi.mock('../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(userDataDir, ...parts),
  activeOwnerScopeKey: () => userDataDir,
}));

vi.mock('../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));

describe('dialogue workspace directory', () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-dialogues-'));
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it('uses local calendar buckets under app userData/dialogues', async () => {
    const {
      buildDialogueWorkspaceDir,
      dialogueWorkspaceDayKey,
      dialogueWorkspaceRootDir,
    } = await import('../localDb/dialogueWorkspace');
    const now = new Date(2026, 4, 20, 12, 0, 0).getTime();

    expect(dialogueWorkspaceDayKey(now)).toBe('2026-05-20');
    expect(dialogueWorkspaceRootDir()).toBe(path.join(userDataDir, 'dialogues'));
    expect(buildDialogueWorkspaceDir('session-1', now)).toBe(
      path.join(userDataDir, 'dialogues', '2026-05-20', 'session-1'),
    );
  });

  it('creates the managed dialogue directory when requested', async () => {
    const { ensureDialogueWorkspaceDir } = await import('../localDb/dialogueWorkspace');
    const now = new Date(2026, 4, 20, 12, 0, 0).getTime();

    const dir = ensureDialogueWorkspaceDir('session-2', now);

    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(dir).toBe(path.join(userDataDir, 'dialogues', '2026-05-20', 'session-2'));
  });

  it('switches only new allocations, retains every old root on reset and across reloads', async () => {
    const { ensureDialogueWorkspaceDir, isManagedDialogueWorkspace } = await import('../localDb/dialogueWorkspace');
    const { writeDialogueWorkspaceDirectory, readDialogueWorkspaceSettings } = await import('../dialogue-workspace-settings');
    const now = new Date(2026, 8, 18, 12).getTime();
    const oldDir = ensureDialogueWorkspaceDir('old', now);
    fs.writeFileSync(path.join(oldDir, 'work.txt'), 'keep me');
    const custom = path.join(userDataDir, 'external', 'dialogues');
    fs.mkdirSync(custom, { recursive: true });
    await writeDialogueWorkspaceDirectory(custom);
    const customDir = ensureDialogueWorkspaceDir('new', now);
    expect(customDir).toBe(path.join(custom, '2026-09-18', 'new'));
    await writeDialogueWorkspaceDirectory(path.join(userDataDir, 'another'));
    await writeDialogueWorkspaceDirectory(null);
    expect(readDialogueWorkspaceSettings()).toEqual({
      directory: path.join(userDataDir, 'dialogues'), isCustomized: false,
    });
    expect(fs.readFileSync(path.join(oldDir, 'work.txt'), 'utf8')).toBe('keep me');
    expect(fs.existsSync(customDir)).toBe(true);
    expect(isManagedDialogueWorkspace(oldDir)).toBe(true);
    expect(isManagedDialogueWorkspace(customDir)).toBe(true);
    expect(isManagedDialogueWorkspace(path.join(custom + '-project', '2026-09-18', 'new'))).toBe(false);
    const saved = JSON.parse(fs.readFileSync(path.join(userDataDir, 'dialogue-workspace-settings.json'), 'utf8'));
    expect(saved).not.toHaveProperty('directory');
    vi.resetModules();
    const reloaded = await import('../localDb/dialogueWorkspace');
    expect(reloaded.isManagedDialogueWorkspace(customDir)).toBe(true);
    expect(reloaded.dialogueWorkspaceRootDir()).toBe(path.join(userDataDir, 'dialogues'));
  });

  it('keeps settings and recognized roots isolated when the owner changes', async () => {
    const { writeDialogueWorkspaceDirectory } = await import('../dialogue-workspace-settings');
    const { dialogueWorkspaceRootDir, dialogueWorkspaceRoots } = await import('../localDb/dialogueWorkspace');
    const firstOwner = userDataDir;
    const custom = path.join(firstOwner, 'custom');
    await writeDialogueWorkspaceDirectory(custom);
    try {
      userDataDir = path.join(firstOwner, 'second-owner');
      expect(dialogueWorkspaceRootDir()).toBe(path.join(userDataDir, 'dialogues'));
      expect(dialogueWorkspaceRoots()).not.toContain(custom);
    } finally {
      userDataDir = firstOwner;
    }
    expect(dialogueWorkspaceRootDir()).toBe(custom);
  });

  it('fails without recreating an offline custom root and resumes after it returns', async () => {
    const { ensureDialogueWorkspaceDir } = await import('../localDb/dialogueWorkspace');
    const { writeDialogueWorkspaceDirectory, readDialogueWorkspaceSettings } = await import('../dialogue-workspace-settings');
    const mount = path.join(userDataDir, 'volume');
    const detached = path.join(userDataDir, 'detached');
    const custom = path.join(mount, 'dialogues', 'owner-a');
    fs.mkdirSync(custom, { recursive: true });
    await writeDialogueWorkspaceDirectory(custom);
    const now = new Date(2026, 8, 18, 12).getTime();
    const oldDir = ensureDialogueWorkspaceDir('existing', now);
    fs.writeFileSync(path.join(oldDir, 'keep.txt'), 'keep');
    fs.renameSync(mount, detached);
    fs.mkdirSync(mount);
    expect(() => ensureDialogueWorkspaceDir('new', now)).toThrow();
    expect(fs.readdirSync(mount)).toEqual([]);
    expect(readDialogueWorkspaceSettings()).toEqual({ directory: custom, isCustomized: true });
    fs.rmdirSync(mount);
    fs.renameSync(detached, mount);
    expect(ensureDialogueWorkspaceDir('existing', now)).toBe(oldDir);
    expect(fs.readFileSync(path.join(oldDir, 'keep.txt'), 'utf8')).toBe('keep');
    expect(fs.statSync(ensureDialogueWorkspaceDir('new', now)).isDirectory()).toBe(true);
  });

  it('does not recreate the custom root if it disappears after creating the day bucket', async () => {
    const { ensureDialogueWorkspaceDir } = await import('../localDb/dialogueWorkspace');
    const { writeDialogueWorkspaceDirectory } = await import('../dialogue-workspace-settings');
    const custom = path.join(userDataDir, 'custom');
    fs.mkdirSync(custom);
    await writeDialogueWorkspaceDirectory(custom);
    const mkdirSync = fs.mkdirSync.bind(fs);
    const spy = vi.spyOn(fs, 'mkdirSync').mockImplementation(((...args: Parameters<typeof fs.mkdirSync>) => {
      const result = mkdirSync(...args);
      fs.renameSync(custom, path.join(userDataDir, 'detached'));
      return result;
    }) as typeof fs.mkdirSync);
    try {
      expect(() => ensureDialogueWorkspaceDir('new', Date.now())).toThrow();
      expect(fs.existsSync(custom)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it.each(['ordinary', 'unrestored-worktree'] as const)('keeps %s recovery on the owner default root when the custom volume is offline', async (mode) => {
    const { ensureDialogueWorkspaceDir, dialogueWorkspaceRoots } = await import('../localDb/dialogueWorkspace');
    const { writeDialogueWorkspaceDirectory, readDialogueWorkspaceSettings } = await import('../dialogue-workspace-settings');
    const { allocateDialogueRecoveryWorkspace } = await import('../maker-ipc/dialogueRecoveryWorkspace');
    const { createWorkingDirectoryRecovery } = await import('../maker-ipc/workingDirectoryRecovery');
    const mount = path.join(userDataDir, 'volume');
    const custom = path.join(mount, 'dialogues', 'owner-a');
    await writeDialogueWorkspaceDirectory(custom);
    const original = path.join(custom, '2026-09-18', 'disconnected');
    const unaffected = path.join(userDataDir, 'other-project');
    fs.mkdirSync(unaffected);
    const recovery = createWorkingDirectoryRecovery({
      stat: async (dir) => {
        if (dir.startsWith(mount) && !fs.existsSync(mount)) {
          throw Object.assign(new Error('offline'), { code: 'EIO' });
        }
        return fs.promises.stat(dir);
      },
      mkdir: fs.promises.mkdir,
    }, allocateDialogueRecoveryWorkspace);
    await recovery.observe('unaffected', unaffected);
    expect(await recovery.recover('disconnected', original, null, [], mode)).toBe(true);
    const fallback = recovery.resolve('disconnected', original);
    expect(path.relative(path.join(userDataDir, 'dialogues'), fallback).startsWith('..')).toBe(false);
    expect(fs.statSync(fallback).isDirectory()).toBe(true);
    expect(dialogueWorkspaceRoots()).toContain(path.join(userDataDir, 'dialogues'));
    expect(recovery.peek('disconnected')).toContain('not been restored or copied');
    expect(recovery.peek('disconnected')).toContain(JSON.stringify(fallback));
    expect(recovery.resolve('unaffected', unaffected)).toBe(unaffected);
    expect(recovery.peek('unaffected')).toBeNull();
    expect(fs.existsSync(mount)).toBe(false);
    expect(readDialogueWorkspaceSettings()).toEqual({ directory: custom, isCustomized: true });
    expect(() => ensureDialogueWorkspaceDir('new-offline', Date.now())).toThrow();
    fs.writeFileSync(path.join(fallback, 'keep.txt'), 'keep');
    fs.mkdirSync(custom, { recursive: true });
    expect(await recovery.recover('disconnected', original, null, [], mode)).toBe(true);
    expect(recovery.resolve('disconnected', original)).toBe(fallback);
    expect(fs.readFileSync(path.join(fallback, 'keep.txt'), 'utf8')).toBe('keep');
    expect(ensureDialogueWorkspaceDir('new-online', Date.now()).startsWith(custom + path.sep)).toBe(true);
    const firstOwner = userDataDir;
    try {
      userDataDir = path.join(firstOwner, 'second-owner');
      const otherOwnerFallback = await allocateDialogueRecoveryWorkspace('disconnected', original, mode);
      expect(otherOwnerFallback.startsWith(path.join(userDataDir, 'dialogues') + path.sep)).toBe(true);
      expect(otherOwnerFallback).not.toBe(fallback);
    } finally {
      userDataDir = firstOwner;
    }
  });

  it('rejects invalid paths and preserves unreadable settings on writes', async () => {
    const { writeDialogueWorkspaceDirectory } = await import('../dialogue-workspace-settings');
    await expect(writeDialogueWorkspaceDirectory('relative')).rejects.toThrow();
    await expect(writeDialogueWorkspaceDirectory(path.join(userDataDir, 'bad') + '\0')).rejects.toThrow();
    const file = path.join(userDataDir, 'dialogue-workspace-settings.json');
    fs.writeFileSync(file, '{broken');
    await expect(writeDialogueWorkspaceDirectory(path.join(userDataDir, 'custom'))).rejects.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
  });

  it.each([false, true])('reuses ordinary recovery files across a next-day restart without mixing bindings (reconnected: %s)', async (reconnected) => {
    const { writeDialogueWorkspaceDirectory } = await import('../dialogue-workspace-settings');
    const custom = path.join(userDataDir, 'offline', 'dialogues', 'owner-a');
    const original = path.join(custom, '2026-09-18', 'task');
    await writeDialogueWorkspaceDirectory(custom);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 8, 18, 23, 50));
      const firstModule = await import('../maker-ipc/dialogueRecoveryWorkspace');
      const { createWorkingDirectoryRecovery } = await import('../maker-ipc/workingDirectoryRecovery');
      const first = createWorkingDirectoryRecovery({ ...fs.promises, requiredRoot: firstModule.requiredDialogueRecoveryRoot, findFallback: firstModule.findDialogueRecoveryWorkspace }, firstModule.allocateDialogueRecoveryWorkspace);
      expect(await first.recover('task', original)).toBe(true);
      const fallback = first.resolve('task', original);
      fs.writeFileSync(path.join(fallback, 'work.txt'), 'recover this');
      if (reconnected) {
        fs.mkdirSync(original, { recursive: true });
        fs.writeFileSync(path.join(original, 'original.txt'), 'original work');
      }
      vi.setSystemTime(new Date(2026, 8, 19, 10));
      vi.resetModules();
      const restartedModule = await import('../maker-ipc/dialogueRecoveryWorkspace');
      const restartedRecovery = await import('../maker-ipc/workingDirectoryRecovery');
      const restarted = restartedRecovery.createWorkingDirectoryRecovery({ ...fs.promises, requiredRoot: restartedModule.requiredDialogueRecoveryRoot, findFallback: restartedModule.findDialogueRecoveryWorkspace }, restartedModule.allocateDialogueRecoveryWorkspace);
      expect(await restarted.recover('task', original)).toBe(true);
      expect(restarted.resolve('task', original)).toBe(fallback);
      expect(fs.readFileSync(path.join(fallback, 'work.txt'), 'utf8')).toBe('recover this');
      expect(restarted.peek('task')).toContain('previously selected');
      expect(fs.existsSync(custom)).toBe(reconnected);
      if (reconnected) {
        expect(fs.readFileSync(path.join(original, 'original.txt'), 'utf8')).toBe('original work');
        expect(fs.existsSync(path.join(original, 'work.txt'))).toBe(false);
      }
      expect(await restartedModule.findDialogueRecoveryWorkspace('other-task', original)).toBeUndefined();
      expect(await restartedModule.findDialogueRecoveryWorkspace('task', original + '-other')).toBeUndefined();
      const previousOwner = userDataDir;
      userDataDir = path.join(previousOwner, 'other-owner');
      try {
        expect(await restartedModule.findDialogueRecoveryWorkspace('task', original)).toBeUndefined();
        expect(fs.existsSync(userDataDir)).toBe(false);
      } finally {
        userDataDir = previousOwner;
      }
      const { isManagedDialogueWorkspace } = await import('../localDb/dialogueWorkspace');
      expect(isManagedDialogueWorkspace(fallback)).toBe(true);
      expect(isManagedDialogueWorkspace(path.join(fallback, 'child'))).toBe(false);
      expect(isManagedDialogueWorkspace(path.join(userDataDir, 'dialogues', 'dialogue-recovery', 'project'))).toBe(false);
      expect(await restartedModule.allocateDialogueRecoveryWorkspace('other-task', original, 'ordinary')).not.toBe(fallback);
      expect(await restartedModule.allocateDialogueRecoveryWorkspace('task', original + '-other', 'ordinary')).not.toBe(fallback);
      expect(await restartedModule.allocateDialogueRecoveryWorkspace('task', original, 'unrestored-worktree')).not.toBe(fallback);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])('does not recreate a disconnected custom root after restart (historical: %s)', async (historical) => {
    const { writeDialogueWorkspaceDirectory } = await import('../dialogue-workspace-settings');
    const mount = path.join(userDataDir, 'volume');
    const custom = path.join(mount, 'dialogues', 'owner-a');
    const original = path.join(custom, '2026-09-18', 'old-task');
    fs.mkdirSync(original, { recursive: true });
    fs.writeFileSync(path.join(original, 'keep.txt'), 'keep');
    await writeDialogueWorkspaceDirectory(custom);
    if (historical) await writeDialogueWorkspaceDirectory(null);
    fs.renameSync(mount, path.join(userDataDir, 'detached'));
    fs.mkdirSync(mount);
    vi.resetModules();
    const { allocateDialogueRecoveryWorkspace, requiredDialogueRecoveryRoot } = await import('../maker-ipc/dialogueRecoveryWorkspace');
    const { createWorkingDirectoryRecovery } = await import('../maker-ipc/workingDirectoryRecovery');
    const recovery = createWorkingDirectoryRecovery({ ...fs.promises, requiredRoot: requiredDialogueRecoveryRoot }, allocateDialogueRecoveryWorkspace);
    // A fresh recovery instance has never observed the old filesystem's device ID.
    expect(requiredDialogueRecoveryRoot(original)).toBe(custom);
    expect(await recovery.recover('old-task', original)).toBe(true);
    expect(fs.readdirSync(mount)).toEqual([]);
    const fallback = recovery.resolve('old-task', original);
    expect(fallback.startsWith(path.join(userDataDir, 'dialogues') + path.sep)).toBe(true);
    expect(fs.statSync(fallback).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(userDataDir, 'detached', 'dialogues', 'owner-a', '2026-09-18', 'old-task', 'keep.txt'), 'utf8')).toBe('keep');
    expect(requiredDialogueRecoveryRoot(path.join(userDataDir, 'dialogues', '2026-09-18', 'default'))).toBeUndefined();
    expect(requiredDialogueRecoveryRoot(custom + '-project')).toBeUndefined();
    fs.rmdirSync(mount);
    fs.renameSync(path.join(userDataDir, 'detached'), mount);
    const missingTask = path.join(custom, '2026-09-18', 'missing-task');
    expect(await recovery.recover('missing-task', missingTask)).toBe(true);
    expect(recovery.resolve('missing-task', missingTask)).toBe(missingTask);
    expect(fs.statSync(missingTask).isDirectory()).toBe(true);
  });
});
