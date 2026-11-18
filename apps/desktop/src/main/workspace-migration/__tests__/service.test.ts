/**
 * Test value (#10568): production request/startup/guard APIs, real isolated file trees.
 * Previous folder/runtime tests never moved a workspace across a durable cutover.
 * Minimum failures: live requester, occupied target, old logical script path, missing disk,
 * and a process dying after the original directory was renamed. Unit tier; no subprocess/DB.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertWorkspaceMoveReady,
  cancelWorkspaceMove,
  previewWorkspaceMove,
  recoverWorkspaceMovesAtStartup,
  requestWorkspaceMove,
  workspaceMoveStatus,
} from '../service.js';
import { copyTree, directoryIdentity, inspectTree } from '../tree.js';

let temporary: string;
let owner: string;
let source: string;
let target: string;
const bot = 'bot-test';
const current = () => {};

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-workspace-move-'));
  owner = path.join(temporary, 'profile', 'owners', 'test-owner');
  source = path.join(owner, 'bots', bot, 'workspace');
  target = path.join(temporary, 'data-disk', 'buddy');
  await fs.mkdir(path.join(source, '.cindy', 'memory'), { recursive: true });
  await fs.mkdir(path.dirname(target));
  await fs.writeFile(path.join(source, 'script.js'), 'original-script');
  await fs.writeFile(path.join(source, '.cindy', 'memory', 'fts.db'), 'database-and-wal-sample');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(temporary, { recursive: true, force: true });
});

async function receipt() {
  const [name] = (await fs.readdir(path.join(owner, 'workspace-migrations'))).filter((value) =>
    value.endsWith('.json'),
  );
  const file = path.join(owner, 'workspace-migrations', name);
  return { file, value: JSON.parse(await fs.readFile(file, 'utf8')) };
}

/** Model a persisted intent from an exited host; no module reload or real process is needed. */
async function previousProcess(update: Record<string, unknown> = {}) {
  const { file, value } = await receipt();
  Object.assign(value, { processToken: 'previous-host-process', pid: 2147483000 }, update);
  await fs.writeFile(file, JSON.stringify(value));
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  return value;
}

describe('offline workspace relocation', () => {
  it('preserves relative links within the tree and the referent of relative links outside it', async ({
    skip,
  }) => {
    const outside = path.join(temporary, 'shared-skill');
    await fs.mkdir(outside);
    await fs.mkdir(path.join(source, 'assets'));
    await fs.writeFile(path.join(outside, 'SKILL.md'), 'shared');
    await fs.writeFile(path.join(source, 'assets', 'note.txt'), 'inside');
    try {
      // Capability probe: Windows directory symlinks may need Developer Mode.
      await fs.symlink('assets', path.join(source, 'internal-link'), 'dir');
      await fs.symlink(path.relative(source, outside), path.join(source, 'external-link'), 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        skip();
        return;
      }
      throw error;
    }
    await requestWorkspaceMove(owner, bot, target, current);
    await previousProcess();
    await recoverWorkspaceMovesAtStartup(owner, true);
    expect((await workspaceMoveStatus(owner, bot)).phase).toBe('completed');
    expect(await fs.realpath(path.join(target, 'internal-link'))).toBe(
      await fs.realpath(path.join(target, 'assets')),
    );
    expect(await fs.realpath(path.join(target, 'external-link'))).toBe(await fs.realpath(outside));
    expect(path.isAbsolute(await fs.readlink(path.join(target, 'external-link')))).toBe(true);
    expect(await fs.readFile(path.join(source, 'internal-link', 'note.txt'), 'utf8')).toBe(
      'inside',
    );
  });

  it('defers the live caller, then verifies and moves contents with the original logical path intact', async () => {
    const homeMemory = path.join(path.dirname(source), 'memories');
    await fs.mkdir(homeMemory);
    await fs.writeFile(path.join(homeMemory, 'USER.md'), 'V1 archive stays home');
    const skills = path.join(temporary, 'skills');
    await fs.mkdir(skills);
    await fs.writeFile(path.join(skills, 'SKILL.md'), 'shared-skill');
    await fs.symlink(
      skills,
      path.join(source, 'skills'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const before = await previewWorkspaceMove(owner, bot, target);
    expect(before).toMatchObject({ execution: 'next-host-start', files: 2, links: 1 });
    await requestWorkspaceMove(owner, bot, target, current);
    await recoverWorkspaceMovesAtStartup(owner, true);
    expect((await workspaceMoveStatus(owner, bot)).phase).toBe('pending');
    expect(await fs.lstat(source).then((value) => value.isDirectory())).toBe(true);
    await previousProcess();
    await recoverWorkspaceMovesAtStartup(owner, true);
    expect((await workspaceMoveStatus(owner, bot)).error).toBeUndefined();
    expect(await workspaceMoveStatus(owner, bot)).toMatchObject({
      phase: 'completed',
      backupRemaining: false,
    });
    expect(await fs.realpath(source)).toBe(await fs.realpath(target));
    expect(await fs.readFile(path.join(source, 'script.js'), 'utf8')).toBe('original-script');
    expect(await fs.readFile(path.join(source, '.cindy', 'memory', 'fts.db'), 'utf8')).toBe(
      'database-and-wal-sample',
    );
    expect(await fs.realpath(path.join(source, 'skills'))).toBe(await fs.realpath(skills));
    await fs.writeFile(path.join(source, 'later.txt'), 'buddy-after-restart');
    expect(await fs.readFile(path.join(target, 'later.txt'), 'utf8')).toBe('buddy-after-restart');
    expect(await fs.readFile(path.join(homeMemory, 'USER.md'), 'utf8')).toBe(
      'V1 archive stays home',
    );
    await expect(assertWorkspaceMoveReady(owner, bot)).resolves.toBeUndefined();
    await recoverWorkspaceMovesAtStartup(owner, true);
    expect(await fs.readFile(path.join(target, 'later.txt'), 'utf8')).toBe('buddy-after-restart');
    await fs.rename(target, `${target}-unmounted`);
    await expect(assertWorkspaceMoveReady(owner, bot)).rejects.toThrow(
      'MOVED_WORKSPACE_UNAVAILABLE',
    );
    expect((await workspaceMoveStatus(owner, bot)).workspaceAvailable).toBe(false);
  });

  it('never overwrites a target created after the request and keeps the original usable', async () => {
    await requestWorkspaceMove(owner, bot, target, current);
    await previousProcess();
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'keep.txt'), 'existing-user-data');
    await recoverWorkspaceMovesAtStartup(owner, true);
    expect(await workspaceMoveStatus(owner, bot)).toMatchObject({
      phase: 'failed',
      error: 'TARGET_EXISTS',
    });
    expect(await fs.readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('existing-user-data');
    expect(await fs.readFile(path.join(source, 'script.js'), 'utf8')).toBe('original-script');
    await expect(assertWorkspaceMoveReady(owner, bot)).resolves.toBeUndefined();
    const newTarget = path.join(path.dirname(target), 'retry');
    await requestWorkspaceMove(owner, bot, newTarget, current);
    await previousProcess();
    await recoverWorkspaceMovesAtStartup(owner, true);
    expect(await fs.realpath(source)).toBe(await fs.realpath(newTarget));
  });

  it('restores the original after an interrupted rename instead of creating an empty workspace', async () => {
    await requestWorkspaceMove(owner, bot, target, current);
    const status = await workspaceMoveStatus(owner, bot);
    const digest = (await inspectTree(source)).digest;
    await copyTree(source, target);
    const targetIdentity = await directoryIdentity(target);
    await fs.rename(source, status.backup!);
    await previousProcess({ phase: 'switching', digest, targetIdentity });
    await expect(assertWorkspaceMoveReady(owner, bot)).rejects.toThrow(
      'WORKSPACE_MOVE_RECOVERY_REQUIRED',
    );
    await recoverWorkspaceMovesAtStartup(owner, true);
    expect((await workspaceMoveStatus(owner, bot)).phase).toBe('failed');
    expect(await fs.readFile(path.join(source, 'script.js'), 'utf8')).toBe('original-script');
    expect(await fs.readFile(path.join(target, 'script.js'), 'utf8')).toBe('original-script');
  });

  it('recognizes a committed link after a crash and preserves later destination writes', async () => {
    await requestWorkspaceMove(owner, bot, target, current);
    const status = await workspaceMoveStatus(owner, bot);
    await copyTree(source, target);
    const targetIdentity = await directoryIdentity(target);
    const digest = (await inspectTree(source)).digest;
    await fs.rename(source, status.backup!);
    await fs.symlink(target, source, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.writeFile(path.join(target, 'later.txt'), 'keep-new-data');
    await previousProcess({ phase: 'switching', targetIdentity, digest });
    await recoverWorkspaceMovesAtStartup(owner, true);
    expect((await workspaceMoveStatus(owner, bot)).phase).toBe('completed');
    expect(await fs.readFile(path.join(source, 'later.txt'), 'utf8')).toBe('keep-new-data');
    expect(await workspaceMoveStatus(owner, bot)).toMatchObject({
      backupRemaining: true,
      error: 'MOVED_BACKUP_RETAINED_FOR_REVIEW',
    });
  });

  it('restores the original if the destination disappeared during an interrupted cutover', async () => {
    await requestWorkspaceMove(owner, bot, target, current);
    const status = await workspaceMoveStatus(owner, bot);
    await copyTree(source, target);
    const targetIdentity = await directoryIdentity(target);
    await fs.rename(source, status.backup!);
    await fs.symlink(target, source, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.rename(target, `${target}-unmounted`);
    await previousProcess({ phase: 'linked', targetIdentity });
    await recoverWorkspaceMovesAtStartup(owner, true);
    expect(await fs.lstat(source).then((value) => value.isDirectory())).toBe(true);
    expect(await fs.readFile(path.join(source, 'script.js'), 'utf8')).toBe('original-script');
  });

  it('retains the source and reports failure if copying or link creation is unavailable', async () => {
    await requestWorkspaceMove(owner, bot, target, current);
    await previousProcess();
    vi.spyOn(fs, 'symlink').mockRejectedValueOnce(
      Object.assign(new Error('EPERM'), { code: 'EPERM' }),
    );
    await recoverWorkspaceMovesAtStartup(owner, true);
    expect(await workspaceMoveStatus(owner, bot)).toMatchObject({
      phase: 'failed',
      error: 'EPERM',
    });
    expect(await fs.readFile(path.join(source, 'script.js'), 'utf8')).toBe('original-script');
    expect(await fs.readFile(path.join(target, 'script.js'), 'utf8')).toBe('original-script');
  });

  it('resumes an interrupted copy without overwriting matching files or extra target data', async () => {
    await requestWorkspaceMove(owner, bot, target, current);
    await fs.mkdir(target);
    await fs.copyFile(path.join(source, 'script.js'), path.join(target, 'script.js'));
    const targetIdentity = await directoryIdentity(target);
    await previousProcess({ phase: 'copying', targetIdentity });
    await recoverWorkspaceMovesAtStartup(owner, true);
    expect(await workspaceMoveStatus(owner, bot)).toMatchObject({
      phase: 'completed',
      backupRemaining: false,
    });
    expect(await fs.readFile(path.join(source, '.cindy', 'memory', 'fts.db'), 'utf8')).toBe(
      'database-and-wal-sample',
    );
  });

  it('retains an incomplete destination file and keeps its recovery path when a new target is requested', async () => {
    await requestWorkspaceMove(owner, bot, target, current);
    const original = (await receipt()).value;
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'script.js'), 'partial-copy');
    await previousProcess({ phase: 'copying', targetIdentity: await directoryIdentity(target) });
    await recoverWorkspaceMovesAtStartup(owner, true);
    expect(await workspaceMoveStatus(owner, bot)).toMatchObject({
      phase: 'failed',
      error: 'TARGET_CONTENT_CHANGED',
    });
    expect(await fs.readFile(path.join(target, 'script.js'), 'utf8')).toBe('partial-copy');
    expect(await fs.readFile(path.join(source, 'script.js'), 'utf8')).toBe('original-script');
    const next = await requestWorkspaceMove(
      owner,
      bot,
      path.join(path.dirname(target), 'new-target'),
      current,
    );
    const archived = JSON.parse(
      await fs.readFile(path.join(next.historyDirectory, `${original.id}.json`), 'utf8'),
    );
    expect(archived).toMatchObject({ target: original.target, phase: 'failed' });
  });

  it('rejects overlapping destinations, live startup readers, and changed authorization', async () => {
    await expect(previewWorkspaceMove(owner, bot, path.join(source, 'nested'))).rejects.toThrow(
      'TARGET_OVERLAPS_CINDY_DATA',
    );
    await expect(
      requestWorkspaceMove(owner, bot, target, () => {
        throw new Error('owner changed');
      }),
    ).rejects.toThrow('owner changed');
    expect((await workspaceMoveStatus(owner, bot)).phase).toBe('none');
    await requestWorkspaceMove(owner, bot, target, current);
    await previousProcess();
    await expect(recoverWorkspaceMovesAtStartup(owner, false)).rejects.toThrow(
      'WORKSPACE_MOVE_REQUIRES_EXCLUSIVE_STARTUP',
    );
    expect((await workspaceMoveStatus(owner, bot)).phase).toBe('pending');
    await cancelWorkspaceMove(owner, bot, current);
    await recoverWorkspaceMovesAtStartup(owner, true);
    expect((await workspaceMoveStatus(owner, bot)).phase).toBe('cancelled');
    expect(await fs.readFile(path.join(source, 'script.js'), 'utf8')).toBe('original-script');
  });

  it('does not register an aborted request or delete late external changes in the backup', async () => {
    await expect(
      requestWorkspaceMove(owner, bot, target, current, AbortSignal.abort()),
    ).rejects.toThrow();
    expect((await workspaceMoveStatus(owner, bot)).phase).toBe('none');
    await requestWorkspaceMove(owner, bot, target, current);
    const status = await workspaceMoveStatus(owner, bot);
    const digest = (await inspectTree(source)).digest;
    await copyTree(source, target);
    const targetIdentity = await directoryIdentity(target);
    await fs.rename(source, status.backup!);
    await fs.symlink(target, source, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.writeFile(path.join(status.backup!, 'external.txt'), 'late-user-data');
    await previousProcess({ phase: 'linked', targetIdentity, digest });
    await recoverWorkspaceMovesAtStartup(owner, true);
    expect(await workspaceMoveStatus(owner, bot)).toMatchObject({
      phase: 'completed',
      error: 'MOVED_BACKUP_RETAINED_FOR_REVIEW',
      backupRemaining: true,
    });
    await recoverWorkspaceMovesAtStartup(owner, true);
    expect(await fs.readFile(path.join(status.backup!, 'external.txt'), 'utf8')).toBe(
      'late-user-data',
    );
  });
});
