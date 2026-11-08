/**
 * A teammate's linked projects, stored in its home as `workbench.json` → `directories` (the file
 * name is kept from the V1 workbench). Projects are context only, never task responsibility.
 * `tasks` holds V1 workbench judgments that nothing reads any more: it is passed through unchanged
 * so an older computer sharing this home (or the cloud copy) keeps them.
 * Cloud handoff retains directory device identity and never opens another computer's paths.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BotLinkedProject } from '../../shared/botWorkbench.js';
import { isWindowsPathLike, normalizeWorkingDirForStorage } from '../../shared/workingDir.js';

import { BrowserWindow } from 'electron';

import { botProfileDir } from './botProfileFolder.js';
import { MAKER_PUSH } from './channels.js';
import { createLogger } from '../logger.js';

const log = createLogger('bot-linked-projects');
const STORE_FILE = 'workbench.json';
/** Guard on the number of stored directories (same as the V1 store). */
export const MAX_LINKED_PROJECTS = 50;
/** Guard on passed-through V1 judgments (same bound as the V1 store). */
const MAX_PASSED_TASKS = 200;

/** Opaque V1 judgments keyed by task id. */
type PassedTasks = Record<string, unknown>;

interface StoredProjects {
  directories: BotLinkedProject[];
  tasks: PassedTasks;
}

function normalizeDirectories(raw: unknown): BotLinkedProject[] {
  const out: BotLinkedProject[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (out.length >= MAX_LINKED_PROJECTS) break;
    if (!entry || typeof entry !== 'object') continue;
    const dir = entry as { path?: unknown; addedAt?: unknown; deviceId?: unknown };
    const deviceId = typeof dir.deviceId === 'string' && dir.deviceId && dir.deviceId.length <= 200 ? dir.deviceId : undefined;
    // Another computer's path may use another platform's form; it is only carried, never opened here.
    const valid = typeof dir.path === 'string' && (deviceId ? !!dir.path.trim() && dir.path.length <= 4096 : path.isAbsolute(dir.path));
    const key = `${deviceId ?? ''}\0${String(dir.path)}`;
    if (!valid || seen.has(key)) continue;
    seen.add(key);
    out.push({ path: dir.path as string, addedAt: typeof dir.addedAt === 'string' ? dir.addedAt : new Date(0).toISOString(),
      ...(deviceId ? { deviceId } : {}) });
  }
  return out;
}

/** Plain-object entries only; everything else is dropped, values are kept as written. */
function passTasks(raw: unknown): PassedTasks {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const entries = Object.entries(raw as Record<string, unknown>)
    .filter(([key, value]) => key && key.length <= 256 && !!value && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(entries.slice(-MAX_PASSED_TASKS));
}

/** Bounded normalization after reading: malformed entries are dropped, nothing on disk is trusted. */
export function normalizeLinkedProjectStore(raw: unknown): StoredProjects | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as { directories?: unknown; tasks?: unknown };
  return { directories: normalizeDirectories(record.directories), tasks: passTasks(record.tasks) };
}

function storePath(userDataDir: string, botId: string): string {
  return path.join(botProfileDir(userDataDir, botId), STORE_FILE);
}

/** Only a missing file is empty; an unreadable or damaged one throws. */
async function readStoredStrict(userDataDir: string, botId: string): Promise<StoredProjects> {
  let raw: string;
  try {
    raw = await fs.readFile(storePath(userDataDir, botId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { directories: [], tasks: {} };
    throw error;
  }
  const stored = normalizeLinkedProjectStore(JSON.parse(raw));
  if (!stored) throw new Error('WORKBENCH_UNREADABLE');
  return stored;
}

async function writeStored(userDataDir: string, botId: string, stored: StoredProjects, guard?: () => void): Promise<void> {
  const target = storePath(userDataDir, botId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    guard?.();
    await fs.writeFile(
      temp,
      `${JSON.stringify({ directories: stored.directories, tasks: stored.tasks }, null, 2)}\n`,
      'utf8',
    );
    guard?.();
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

/** Read-modify-write is serialized per teammate, so concurrent cloud merges never overwrite each other. */
const writeChains = new Map<string, Promise<unknown>>();
function mutate<T>(
  userDataDir: string,
  botId: string,
  change: (stored: StoredProjects) => { next: StoredProjects; result: T },
  guard?: () => void,
): Promise<T> {
  const key = `${userDataDir}\0${botId}`;
  const run = (writeChains.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      guard?.();
      const stored = await readStoredStrict(userDataDir, botId);
      guard?.();
      const { next, result } = change(stored);
      await writeStored(userDataDir, botId, next, guard);
      return result;
    });
  writeChains.set(key, run);
  // The derived finally promise inherits run's rejection: cleanup still runs and the rejection is
  // absorbed here (callers already got the original run's failure).
  void run.finally(() => {
    if (writeChains.get(key) === run) writeChains.delete(key);
  }).catch(() => undefined);
  return run;
}

export async function readBotLinkedProjects(userDataDir: string, botId: string): Promise<BotLinkedProject[]> {
  return (await readStoredStrict(userDataDir, botId)).directories;
}

/** Links refer to individual directories, not the repository's sidebar grouping. */
export function linkedProjectDirectoryKey(directory: string): string {
  const normalized = normalizeWorkingDirForStorage(directory) ?? directory;
  return process.platform === 'win32' && isWindowsPathLike(normalized) ? normalized.toLowerCase() : normalized;
}

export async function setBotLinkedProject(
  userDataDir: string, botId: string, project: Pick<BotLinkedProject, 'path' | 'deviceId'>,
  linked: boolean, guard: () => void,
): Promise<void> {
  if (!normalizeDirectories([project]).length) throw new Error('INVALID_PROJECT');
  await mutate(userDataDir, botId, stored => {
    const same = (entry: BotLinkedProject) => entry.deviceId === project.deviceId && (project.deviceId
      ? entry.path === project.path
      : linkedProjectDirectoryKey(entry.path) === linkedProjectDirectoryKey(project.path));
    const exists = stored.directories.some(same);
    if (linked && !exists && stored.directories.length >= MAX_LINKED_PROJECTS) throw new Error('PROJECT_LIMIT');
    const directories = linked
      ? exists ? stored.directories : [...stored.directories, { ...project, addedAt: new Date().toISOString() }]
      : stored.directories.filter(entry => !same(entry));
    return { next: { ...stored, directories }, result: undefined };
  }, guard);
  guard();
  broadcastBotLinkedProjectsChanged(botId);
}

/** V1 judgments that mean the same on any computer (pull requests, issues, ideas). */
const PORTABLE_TASK = /^(pr|issue|idea):/;

/**
 * The store as it travels with the companion (cloud-companions.md §2, `companion.workbench.v1`):
 * every folder with the computer it is on, and the portable V1 judgments unchanged.
 */
export async function readCompanionWorkbench(userDataDir: string, botId: string, selfDeviceId: string): Promise<{
  directories: Array<{ path: string; addedAt: string; deviceId: string }>;
  tasks: PassedTasks;
}> {
  // Strict: a damaged file must not read as "no projects" (the cloud copy would be tombstoned).
  const stored = await readStoredStrict(userDataDir, botId);
  return {
    directories: stored.directories.map((dir) => ({ path: dir.path, addedAt: dir.addedAt, deviceId: dir.deviceId ?? selfDeviceId })),
    tasks: Object.fromEntries(Object.entries(stored.tasks).filter(([key]) => PORTABLE_TASK.test(key))),
  };
}

/**
 * The companion moved here: the folders and portable judgments from the cloud join what is here;
 * the cloud wins. With `replace` (this computer synced them before) they take the place of what
 * is here; judgments that never travel stay. Project content is read on demand, never during handoff.
 */
export async function mergeCompanionWorkbench(userDataDir: string, botId: string, selfDeviceId: string, cloud: unknown,
  options: { replace?: boolean } = {}): Promise<void> {
  const value = cloud && typeof cloud === 'object' ? cloud as { directories?: unknown; tasks?: unknown } : {};
  const incoming = normalizeDirectories((Array.isArray(value.directories) ? value.directories : []).map((dir) => {
    const entry = dir && typeof dir === 'object' ? dir as Record<string, unknown> : {};
    return { ...entry, deviceId: entry.deviceId === selfDeviceId ? undefined : entry.deviceId };
  }));
  const tasks = Object.fromEntries(Object.entries(passTasks(value.tasks)).filter(([key]) => PORTABLE_TASK.test(key)));
  await mutate(userDataDir, botId, (stored) => {
    const key = (dir: BotLinkedProject) => `${dir.deviceId ?? ''}\0${dir.path}`;
    if (options.replace) {
      const local = Object.fromEntries(Object.entries(stored.tasks).filter(([taskId]) => !PORTABLE_TASK.test(taskId)));
      return { next: { directories: incoming.slice(0, MAX_LINKED_PROJECTS), tasks: passTasks({ ...local, ...tasks }) }, result: undefined };
    }
    const known = new Set(stored.directories.map(key));
    const directories = [...stored.directories, ...incoming.filter((dir) => !known.has(key(dir)))].slice(0, MAX_LINKED_PROJECTS);
    return { next: { directories, tasks: passTasks({ ...stored.tasks, ...tasks }) }, result: undefined };
  });
  broadcastBotLinkedProjectsChanged(botId);
}

/**
 * Linked projects or "opened by this teammate" records changed. The channel name is kept from the
 * V1 workbench (`maker:bot-workbench:changed`); the renderer re-reads follow scopes on it.
 */
export function broadcastBotLinkedProjectsChanged(botId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(MAKER_PUSH.BOT_WORKBENCH_CHANGED, { botId });
    } catch (error) {
      log.warn('Bot linked projects broadcast failed', { error: String(error) });
    }
  }
}
