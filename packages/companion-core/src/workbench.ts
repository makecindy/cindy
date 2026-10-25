/**
 * The original workbench file keeps linked project references and legacy Todo judgments.
 * Projects are context only; task responsibility lives in task-responsibility.v1.json.
 * Cloud handoff retains directory device identity and never opens another computer's paths.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
export interface BotLinkedProject { path: string; addedAt: string; deviceId?: string }

import {
  boundLegacyJudgments,
  LEGACY_MAX_DIRECTORIES,
  normalizeLegacyJudgments,
  type LegacyWorkbenchJudgment,
} from './workbenchLegacy.js';
const WORKBENCH_FILE = 'workbench.json';

type StoredDirectory = BotLinkedProject;

interface StoredWorkbench {
  directories: StoredDirectory[];
  tasks: Record<string, LegacyWorkbenchJudgment>;
}

function normalizeDirectories(raw: unknown): StoredDirectory[] {
  const out: StoredDirectory[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (out.length >= LEGACY_MAX_DIRECTORIES) break;
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

/** 读盘后的有界规整:丢掉畸形条目,不信任磁盘上的任何字段。 */
export function normalizeWorkbench(raw: unknown): StoredWorkbench | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as { directories?: unknown; tasks?: unknown };
  return { directories: normalizeDirectories(record.directories), tasks: normalizeLegacyJudgments(record.tasks) };
}

/** Both hosts keep the same file format and merge behavior; only paths and push delivery differ. */
export function createBotWorkbenchStore(deps: {
  profileDir(userDataDir: string, botId: string): string;
  directoryKey(directory: string): string;
  changed(botId: string): void;
  logger: { warn(message: string, detail?: Record<string, unknown>): void };
}) {
  const log = deps.logger;
function workbenchPath(userDataDir: string, botId: string): string {
  return path.join(deps.profileDir(userDataDir, botId), WORKBENCH_FILE);
}

/** Only a missing file is an empty workbench; an unreadable or damaged one throws. */
async function readStoredStrict(userDataDir: string, botId: string): Promise<StoredWorkbench> {
  let raw: string;
  try {
    raw = await fs.readFile(workbenchPath(userDataDir, botId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { directories: [], tasks: {} };
    throw error;
  }
  const stored = normalizeWorkbench(JSON.parse(raw));
  if (!stored) throw new Error('WORKBENCH_UNREADABLE');
  return stored;
}

async function readStored(userDataDir: string, botId: string): Promise<StoredWorkbench> {
  const empty: StoredWorkbench = { directories: [], tasks: {} };
  try {
    const raw = await fs.readFile(workbenchPath(userDataDir, botId), 'utf8');
    return normalizeWorkbench(JSON.parse(raw)) ?? empty;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('Bot workbench read failed', { botId, error: String(error) });
    }
    return empty;
  }
}

async function writeStored(userDataDir: string, botId: string, stored: StoredWorkbench, guard?: () => void): Promise<void> {
  const target = workbenchPath(userDataDir, botId);
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

/** 同一伙伴的读改写串行,并发的搬家合并互不覆盖。 */
const writeChains = new Map<string, Promise<unknown>>();
function mutate<T>(
  userDataDir: string,
  botId: string,
  change: (stored: StoredWorkbench) => { next: StoredWorkbench; result: T },
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
  // finally 派生的 promise 会继承 run 的 rejection 且无人接住:cleanup 照跑,rejection 在此吸收
  // (调用方已拿到原始 run 的失败)。
  void run.finally(() => {
    if (writeChains.get(key) === run) writeChains.delete(key);
  }).catch(() => undefined);
  return run;
}

/** Existing associations remain in the original file and travel with the companion. */
async function readBotLinkedProjects(userDataDir: string, botId: string): Promise<BotLinkedProject[]> {
  return (await readStoredStrict(userDataDir, botId)).directories;
}

async function setBotLinkedProject(
  userDataDir: string, botId: string, project: Pick<BotLinkedProject, 'path' | 'deviceId'>,
  linked: boolean, guard: () => void,
): Promise<void> {
  if (!normalizeDirectories([project]).length) throw new Error('INVALID_PROJECT');
  await mutate(userDataDir, botId, stored => {
    const same = (entry: BotLinkedProject) => entry.deviceId === project.deviceId && (project.deviceId
      ? entry.path === project.path
      : deps.directoryKey(entry.path) === deps.directoryKey(project.path));
    const exists = stored.directories.some(same);
    if (linked && !exists && stored.directories.length >= LEGACY_MAX_DIRECTORIES) throw new Error('PROJECT_LIMIT');
    const directories = linked
      ? exists ? stored.directories : [...stored.directories, { ...project, addedAt: new Date().toISOString() }]
      : stored.directories.filter(entry => !same(entry));
    return { next: { ...stored, directories }, result: undefined };
  }, guard);
  guard();
  deps.changed(botId);
}

// Project links and legacy judgments do not grant responsibility for any task.

/** 旧判断:伙伴 Todo 的兼容导入来源。只读,不做文件系统探测。 */
async function readLegacyWorkbenchJudgments(
  userDataDir: string,
  botId: string,
): Promise<Record<string, LegacyWorkbenchJudgment>> {
  return (await readStored(userDataDir, botId)).tasks;
}

/** Task judgments that mean the same on any computer (pull requests, issues, ideas). */
const PORTABLE_JUDGMENT = /^(pr|issue|idea):/;

/**
 * The legacy workbench as it travels with the companion (cloud-companions.md §2): every folder
 * with the computer it is on, and the portable judgments. The same references are used by linked-project settings.
 */
async function readCompanionWorkbench(userDataDir: string, botId: string, selfDeviceId: string): Promise<{
  directories: Array<{ path: string; addedAt: string; deviceId: string }>;
  tasks: Record<string, LegacyWorkbenchJudgment>;
}> {
  // Strict: a damaged file must not read as "no workbench" (the cloud copy would be tombstoned).
  const stored = await readStoredStrict(userDataDir, botId);
  return {
    directories: stored.directories.map((dir) => ({ path: dir.path, addedAt: dir.addedAt, deviceId: dir.deviceId ?? selfDeviceId })),
    tasks: Object.fromEntries(Object.entries(stored.tasks).filter(([key]) => PORTABLE_JUDGMENT.test(key))),
  };
}

/**
 * The companion moved here: the legacy folders and portable judgments from the cloud join what is
 * here; the cloud wins. With `replace` (this computer synced them before) they take the place of
 * what is here; judgments that never travel stay. Project content is read on demand, never during handoff.
 */
async function mergeCompanionWorkbench(userDataDir: string, botId: string, selfDeviceId: string, cloud: unknown,
  options: { replace?: boolean } = {}): Promise<void> {
  const value = cloud && typeof cloud === 'object' ? cloud as { directories?: unknown; tasks?: unknown } : {};
  const incoming = normalizeDirectories((Array.isArray(value.directories) ? value.directories : []).map((dir) => {
    const entry = dir && typeof dir === 'object' ? dir as Record<string, unknown> : {};
    return { ...entry, deviceId: entry.deviceId === selfDeviceId ? undefined : entry.deviceId };
  }));
  const tasks = Object.fromEntries(Object.entries(normalizeLegacyJudgments(value.tasks)).filter(([key]) => PORTABLE_JUDGMENT.test(key)));
  await mutate(userDataDir, botId, (stored) => {
    const key = (dir: StoredDirectory) => `${dir.deviceId ?? ''}\0${dir.path}`;
    if (options.replace) {
      const local = Object.fromEntries(Object.entries(stored.tasks).filter(([taskId]) => !PORTABLE_JUDGMENT.test(taskId)));
      return { next: { directories: incoming.slice(0, LEGACY_MAX_DIRECTORIES), tasks: boundLegacyJudgments({ ...local, ...tasks }) }, result: undefined };
    }
    const known = new Set(stored.directories.map(key));
    const directories = [...stored.directories, ...incoming.filter((dir) => !known.has(key(dir)))].slice(0, LEGACY_MAX_DIRECTORIES);
    return { next: { directories, tasks: boundLegacyJudgments({ ...stored.tasks, ...tasks }) }, result: undefined };
  });
  deps.changed(botId);
}

return { readBotLinkedProjects, setBotLinkedProject, readLegacyWorkbenchJudgments, readCompanionWorkbench, mergeCompanionWorkbench };
}
