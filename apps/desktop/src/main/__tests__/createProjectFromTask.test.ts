import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));

import {
  createProjectFromTask,
  createProjectFromTaskHandlers,
  type CreateProjectFromTaskDeps,
} from '../createProjectFromTask.js';
import type { ProjectsRootState } from '../../shared/projectsRoot.js';

// Rule (#8259): one host transaction for "New project…" — check, create the folder,
// move the managed dialogue files, register, move the task — and never leave the task
// and its files in different places. Unit with a real temp filesystem; the DB-backed
// steps are injected exactly where production wires them.
describe('createProjectFromTask', () => {
  let base: string;
  let dialogue: string;
  let projects: string;
  let deps: CreateProjectFromTaskDeps & { [K in keyof CreateProjectFromTaskDeps]: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'cindy-project-from-task-'));
    dialogue = path.join(base, 'dialogues', '2026-10-31', 'task-1');
    projects = path.join(base, 'projects');
    await mkdir(path.join(dialogue, 'docs'), { recursive: true });
    await mkdir(projects);
    await writeFile(path.join(dialogue, 'design.md'), 'plan');
    await writeFile(path.join(dialogue, 'docs', 'notes.md'), 'notes');
    deps = {
      withTaskLock: vi.fn((_id: string, run: () => Promise<unknown>) => run()),
      readTask: vi.fn(async () => ({ title: 'Plan', workingDir: dialogue, workspaceKind: 'dialogue' })),
      assertMovable: vi.fn(async () => undefined),
      isManagedDialogueWorkspace: vi.fn((dir: string) => dir === dialogue),
      validateProjectDirectory: vi.fn(async (workingDir: string) => ({ ok: true as const, workingDir })),
      registerProject: vi.fn(async (_id: string, workingDir: string) => ({ ok: true as const, workingDir })),
      hideProject: vi.fn(async () => undefined),
      moveTask: vi.fn(async () => ({ ok: true as const })),
    } as never;
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });
  const create = (name = 'my-app') =>
    createProjectFromTask(deps, { sessionId: 'task-1', name, parentDir: projects, createParent: false });

  it('moves every dialogue entry into the new folder, then registers and moves the task there', async () => {
    const target = path.join(projects, 'my-app');
    expect(await create()).toEqual({ workingDir: target, movedEntries: 2 });
    expect(await readFile(path.join(target, 'docs', 'notes.md'), 'utf8')).toBe('notes');
    expect(await readdir(dialogue)).toEqual([]);
    expect(deps.registerProject).toHaveBeenCalledWith('task-1', target);
    expect(deps.moveTask).toHaveBeenCalledWith('task-1', target);
  });

  it('puts the files back and removes the folder when the final task move fails', async () => {
    deps.moveTask.mockResolvedValue({ ok: false, errorCode: 'PRECONDITION_FAILED', message: 'running' });
    await expect(create()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await readdir(dialogue)).sort()).toEqual(['design.md', 'docs']);
    await expect(stat(path.join(projects, 'my-app'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(deps.hideProject).toHaveBeenCalledWith(path.join(projects, 'my-app'));
  });

  // Review (#8339): the task move can commit and then fail its post-write account check.
  // Rolling the files back then would split the task from its files.
  it.each([
    ['already committed', async () => ({ title: 'Plan', workingDir: path.join(projects, 'my-app'), workspaceKind: 'project' }), 'resolves'],
    ['unknown after an account change', async () => { throw Object.assign(new Error('[NOT_FOUND] gone'), { code: 'NOT_FOUND' }); }, 'rejects'],
  ] as const)('keeps the files in the new folder when a failed move is %s', async (_case, reread, outcome) => {
    deps.moveTask.mockResolvedValue({ ok: false, errorCode: 'PRECONDITION_FAILED', message: 'account changed' });
    deps.readTask.mockImplementationOnce(async () => ({ title: 'Plan', workingDir: dialogue, workspaceKind: 'dialogue' }));
    deps.readTask.mockImplementationOnce(reread);
    if (outcome === 'resolves') await expect(create()).resolves.toMatchObject({ movedEntries: 2 });
    else await expect(create()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await readdir(path.join(projects, 'my-app'))).sort()).toEqual(['design.md', 'docs']);
    expect(deps.hideProject).not.toHaveBeenCalled();
  });

  it.each([
    ['an existing folder', async () => mkdir(path.join(projects, 'my-app')), 'ALREADY_EXISTS'],
    ['a task that cannot move', async () => {
      deps.assertMovable.mockRejectedValue(Object.assign(new Error('[PRECONDITION_FAILED] IM'), { code: 'PRECONDITION_FAILED' }));
    }, 'PRECONDITION_FAILED'],
  ])('leaves the files untouched for %s', async (_case, arrange, code) => {
    await arrange();
    await expect(create()).rejects.toMatchObject({ code });
    expect((await readdir(dialogue)).sort()).toEqual(['design.md', 'docs']);
    expect(deps.registerProject).not.toHaveBeenCalled();
  });

  it('rejects folder names that are invalid on any platform before touching the disk', async () => {
    for (const name of ['', 'a/b', 'CON', 'trailing.', '..']) {
      await expect(create(name)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    }
    expect(deps.withTaskLock).not.toHaveBeenCalled();
  });

  // Security boundary: the renderer may only choose the suggested root or a folder
  // returned by Main's own picker; only that choice is ever stored as the root.
  it('accepts only the suggested root or a picker-approved location, and stores it when asked', async () => {
    const picked = path.join(base, 'picked');
    await mkdir(picked);
    const root: ProjectsRootState = { path: path.join(base, 'Projects'), source: 'default', exists: false };
    const writeRoot = vi.fn(async () => undefined);
    const handlers = createProjectFromTaskHandlers({
      service: deps,
      resolveRoot: async () => root,
      chooseDirectory: async () => picked,
      writeRoot,
    });
    await expect(
      handlers.create({ sessionId: 'task-1', name: 'a', parentDir: path.join(base, 'other'), remember: true }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(deps.withTaskLock).not.toHaveBeenCalled();

    await handlers.create({ sessionId: 'task-1', name: 'from-root', parentDir: root.path, remember: false });
    expect((await stat(path.join(root.path, 'from-root'))).isDirectory()).toBe(true);
    expect(writeRoot).not.toHaveBeenCalled();

    await handlers.chooseParent();
    await handlers.create({ sessionId: 'task-1', name: 'from-picker', parentDir: picked, remember: true });
    expect(writeRoot).toHaveBeenCalledWith(picked);
  });
});
