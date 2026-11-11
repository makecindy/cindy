import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { ControlResult } from '@cindy/mcps';
import { isIpcErrorCode } from '../shared/ipc-errors.js';
import { workingDirEquals } from '../shared/workingDir.js';
import type { PreparedProjectFromTask, ProjectsRootState } from '../shared/projectsRoot.js';
import { createLogger } from './logger.js';
import { throwIpcError } from './utils/ipcValidate.js';

const log = createLogger('create-project-from-task');

// Windows rules apply everywhere: project folders are often synced between computers.
const INVALID_NAME_CHAR = /[<>:"/\\|?*\u0000-\u001f]/;
const INVALID_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const MAX_NAME_LENGTH = 120;

export function validateProjectFolderName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (
    !name ||
    name.length > MAX_NAME_LENGTH ||
    name === '.' ||
    name === '..' ||
    INVALID_NAME_CHAR.test(name) ||
    /[. ]$/.test(name) ||
    WINDOWS_RESERVED_NAME.test(name)
  ) {
    throwIpcError('INVALID_PARAMS', 'Invalid project folder name.');
  }
  return name;
}

/** A starting point for the name field; empty when the title cannot become a folder name. */
export function suggestProjectFolderName(title: string | null): string {
  const name = (title ?? '')
    .replace(INVALID_NAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/, '');
  return name && !WINDOWS_RESERVED_NAME.test(name) ? name : '';
}

async function moveEntry(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }
  try {
    await fs.cp(from, to, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
  } catch (error) {
    await fs.rm(to, { recursive: true, force: true });
    throw error;
  }
  // The copy is complete; a leftover source entry is harmless, failing now would lose the copy.
  await fs.rm(from, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) => {
    log.warn('moved entry left a source copy behind', { code: error.code });
  });
}

/** Best effort: an entry that cannot move back stays in the target and is logged. */
async function restoreEntries(from: string, to: string, names: readonly string[]): Promise<void> {
  for (const name of [...names].reverse()) {
    await moveEntry(path.join(from, name), path.join(to, name)).catch((error: NodeJS.ErrnoException) => {
      log.warn('could not move an entry back after a failed project creation', { code: error.code });
    });
  }
}

/** Moves every entry; on failure puts back what already moved and rethrows. */
async function moveEntries(source: string, target: string): Promise<string[]> {
  const moved: string[] = [];
  try {
    for (const name of await fs.readdir(source)) {
      await moveEntry(path.join(source, name), path.join(target, name));
      moved.push(name);
    }
  } catch (error) {
    await restoreEntries(target, source, moved);
    throw error;
  }
  return moved;
}

function unwrap<T extends object>(result: ControlResult<T, string>): T {
  if (result.ok) return result;
  throwIpcError(isIpcErrorCode(result.errorCode) ? result.errorCode : 'INTERNAL', result.message);
}

export interface TaskForProjectCreation {
  title: string | null;
  workingDir: string | null;
  workspaceKind: string | null;
}

export interface CreateProjectFromTaskDeps {
  withTaskLock<T>(sessionId: string, run: () => Promise<T>): Promise<T>;
  readTask(sessionId: string): Promise<TaskForProjectCreation>;
  /** The same eligibility checks as every other task move. */
  assertMovable(sessionId: string): Promise<void>;
  isManagedDialogueWorkspace(workingDir: string): boolean;
  validateProjectDirectory(directory: string): Promise<ControlResult<{ workingDir: string }, string>>;
  registerProject(sessionId: string, directory: string): Promise<ControlResult<{ workingDir: string }, string>>;
  hideProject(directory: string): Promise<void>;
  moveTask(sessionId: string, directory: string): Promise<ControlResult<object, string>>;
}

/**
 * Check → create folder → move managed dialogue files → register → move the task.
 * Any failure after the folder exists puts the files back and removes the folder,
 * so the task and its files never end up in different places.
 */
export async function createProjectFromTask(
  deps: CreateProjectFromTaskDeps,
  input: { sessionId: string; name: string; parentDir: string; createParent: boolean },
): Promise<{ workingDir: string; movedEntries: number }> {
  const name = validateProjectFolderName(input.name);
  return deps.withTaskLock(input.sessionId, async () => {
    await deps.assertMovable(input.sessionId);
    const task = await deps.readTask(input.sessionId);
    const source =
      task.workspaceKind === 'dialogue' && task.workingDir && deps.isManagedDialogueWorkspace(task.workingDir)
        ? task.workingDir
        : null;
    if (input.createParent) await fs.mkdir(input.parentDir, { recursive: true });
    const target = path.join(input.parentDir, name);
    try {
      await fs.mkdir(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throwIpcError('ALREADY_EXISTS', 'A folder with this name already exists.');
      if (code === 'ENOENT') throwIpcError('PRECONDITION_FAILED', 'The project location is unavailable.');
      throw error;
    }
    let moved: string[] = [];
    let registered: string | null = null;
    let movingTask = false;
    try {
      const { workingDir } = unwrap(await deps.validateProjectDirectory(target));
      if (source) moved = await moveEntries(source, target);
      registered = unwrap(await deps.registerProject(input.sessionId, workingDir)).workingDir;
      movingTask = true;
      unwrap(await deps.moveTask(input.sessionId, registered));
      return { workingDir: registered, movedEntries: moved.length };
    } catch (error) {
      if (movingTask && registered) {
        // A failed move may already be committed (e.g. the account changed right after the
        // write). Only roll back when the task is known to still point at its old directory.
        const directory = registered;
        const committed = await deps.readTask(input.sessionId).then(
          (task) => workingDirEquals(task.workingDir, directory),
          () => null,
        );
        if (committed === true) return { workingDir: directory, movedEntries: moved.length };
        if (committed === null) {
          log.warn('task move outcome unknown; keeping files in the new project folder');
          throw error;
        }
      }
      if (source) await restoreEntries(target, source, moved);
      if (registered) {
        await deps.hideProject(registered).catch((hideError: unknown) => {
          log.warn('could not remove the project after a failed creation', { error: String(hideError) });
        });
      }
      await fs.rmdir(target).catch(() => undefined);
      throw error;
    }
  });
}

/** IPC bodies. Locations come only from the resolved root or this process's own picker. */
export function createProjectFromTaskHandlers(deps: {
  service: CreateProjectFromTaskDeps;
  resolveRoot(): Promise<ProjectsRootState>;
  chooseDirectory(): Promise<string | null>;
  writeRoot(directory: string): Promise<void>;
}) {
  const pickedDirectories = new Set<string>();
  const sessionIdOf = (value: unknown) => {
    if (typeof value !== 'string' || !value || value.length > 256) {
      throwIpcError('INVALID_PARAMS', 'sessionId must be a task id.');
    }
    return value;
  };
  return {
    prepare: async (sessionId: unknown): Promise<PreparedProjectFromTask> => {
      const id = sessionIdOf(sessionId);
      const [task, root] = await Promise.all([deps.service.readTask(id), deps.resolveRoot()]);
      return {
        suggestedName: suggestProjectFolderName(task.title),
        root,
        movesFiles:
          task.workspaceKind === 'dialogue' &&
          !!task.workingDir &&
          deps.service.isManagedDialogueWorkspace(task.workingDir),
      };
    },
    chooseParent: async (): Promise<string | null> => {
      const selected = await deps.chooseDirectory();
      if (selected) pickedDirectories.add(path.normalize(selected));
      return selected ? path.normalize(selected) : null;
    },
    create: async (input: unknown) => {
      const value = (input ?? {}) as Record<string, unknown>;
      const sessionId = sessionIdOf(value.sessionId);
      if (typeof value.parentDir !== 'string') throwIpcError('INVALID_PARAMS', 'parentDir is required.');
      const parentDir = path.normalize(value.parentDir);
      const root = await deps.resolveRoot();
      const isRoot = parentDir === path.normalize(root.path);
      if (!isRoot && !pickedDirectories.has(parentDir)) {
        throwIpcError('INVALID_PARAMS', 'Choose the project location with the folder picker.');
      }
      const result = await createProjectFromTask(deps.service, {
        sessionId,
        name: typeof value.name === 'string' ? value.name : '',
        parentDir,
        // Only ~/Projects is created on demand; a missing chosen folder may be an unmounted drive.
        createParent: isRoot && root.source === 'default',
      });
      if (value.remember === true && !(isRoot && root.source === 'setting')) {
        // The project already exists; a failed preference write must not report the creation as failed.
        await deps.writeRoot(parentDir).catch((error: unknown) => {
          log.warn('could not save the projects root after creating a project', { error: String(error) });
        });
      }
      return result;
    },
  };
}
