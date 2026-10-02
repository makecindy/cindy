/**
 * 伙伴工作台的存储,记在伙伴自己的家 `<ownerRoot>/bots/<botId>/workbench.json`:
 * - `directories`:主人交给伙伴的项目目录(授权范围);
 * - `tasks`:伙伴读过候选任务后写下的判断(人话标题、没做完 / 聊过没下文 / 做完、下一步)。
 *
 * 条目的运行状态不落盘:它们是宿主从已有任务、后台任务和自动化现算出来的投影
 * (见 `shared/botWorkbench.ts`)。旧版本在同一个文件里存过伙伴写的卡片
 * (`cards` / `updatedAt`),读取时直接忽略,下次写入时不再带上,不报错。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { BrowserWindow } from 'electron';

import {
  BOT_WORKBENCH_MAX_DIRECTORIES,
  WORKBENCH_JUDGMENT_NEXT_MAX,
  WORKBENCH_JUDGMENT_TITLE_MAX,
  WORKBENCH_MAX_JUDGMENTS,
  WORKBENCH_REF_MAX,
  type BotWorkbench,
  type BotWorkbenchDirectory,
  type WorkbenchTaskJudgment,
} from '../../shared/botWorkbench.js';
import { botProfileDir } from './botProfileFolder.js';
import { MAKER_PUSH } from './channels.js';
import { createLogger } from '../logger.js';

const log = createLogger('bot-workbench');
const WORKBENCH_FILE = 'workbench.json';

interface StoredDirectory {
  path: string;
  addedAt: string;
}

interface StoredWorkbench {
  directories: StoredDirectory[];
  tasks: Record<string, WorkbenchTaskJudgment>;
}

const VERDICTS = new Set(['unfinished', 'idea', 'done']);

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function normalizeJudgment(raw: unknown): WorkbenchTaskJudgment | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  const title = boundedText(entry.title, WORKBENCH_JUDGMENT_TITLE_MAX);
  if (!title || typeof entry.verdict !== 'string' || !VERDICTS.has(entry.verdict)) return null;
  if (typeof entry.project !== 'string' || !path.isAbsolute(entry.project)) return null;
  return {
    title,
    verdict: entry.verdict as WorkbenchTaskJudgment['verdict'],
    next: boundedText(entry.next, WORKBENCH_JUDGMENT_NEXT_MAX),
    project: entry.project,
    ...(typeof entry.ref === 'string' && entry.ref.trim() ? { ref: entry.ref.trim().slice(0, WORKBENCH_REF_MAX) } : {}),
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date(0).toISOString(),
  };
}

/**
 * 判断上限 200 条:超出时先淘汰最旧的 done,再淘汰最旧的其它判断。
 */
export function boundJudgments(
  tasks: Record<string, WorkbenchTaskJudgment>,
  max = WORKBENCH_MAX_JUDGMENTS,
): Record<string, WorkbenchTaskJudgment> {
  const entries = Object.entries(tasks);
  if (entries.length <= max) return tasks;
  const byAge = (a: [string, WorkbenchTaskJudgment], b: [string, WorkbenchTaskJudgment]) =>
    Date.parse(a[1].updatedAt) - Date.parse(b[1].updatedAt) || a[0].localeCompare(b[0]);
  const evictOrder = [
    ...entries.filter(([, value]) => value.verdict === 'done').sort(byAge),
    ...entries.filter(([, value]) => value.verdict !== 'done').sort(byAge),
  ];
  const drop = new Set(evictOrder.slice(0, entries.length - max).map(([key]) => key));
  return Object.fromEntries(entries.filter(([key]) => !drop.has(key)));
}

function normalizeTasks(raw: unknown): Record<string, WorkbenchTaskJudgment> {
  const out: Record<string, WorkbenchTaskJudgment> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || key.length > 256) continue;
    const judgment = normalizeJudgment(value);
    if (judgment) out[key] = judgment;
  }
  return boundJudgments(out);
}

function normalizeDirectories(raw: unknown): StoredDirectory[] {
  const out: StoredDirectory[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (out.length >= BOT_WORKBENCH_MAX_DIRECTORIES) break;
    if (!entry || typeof entry !== 'object') continue;
    const dir = entry as { path?: unknown; addedAt?: unknown };
    if (typeof dir.path !== 'string' || !path.isAbsolute(dir.path) || seen.has(dir.path)) continue;
    seen.add(dir.path);
    out.push({ path: dir.path, addedAt: typeof dir.addedAt === 'string' ? dir.addedAt : new Date(0).toISOString() });
  }
  return out;
}

/** 读盘后的有界规整:丢掉畸形条目与旧版卡片字段,不信任磁盘上的任何字段。 */
export function normalizeWorkbench(raw: unknown): StoredWorkbench | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as { directories?: unknown; tasks?: unknown };
  return { directories: normalizeDirectories(record.directories), tasks: normalizeTasks(record.tasks) };
}

function workbenchPath(userDataDir: string, botId: string): string {
  return path.join(botProfileDir(userDataDir, botId), WORKBENCH_FILE);
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

async function writeStored(userDataDir: string, botId: string, stored: StoredWorkbench): Promise<void> {
  const target = workbenchPath(userDataDir, botId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(
    temp,
    `${JSON.stringify({ directories: stored.directories, tasks: stored.tasks }, null, 2)}\n`,
    'utf8',
  );
  await fs.rename(temp, target);
}

/** 同一伙伴的读改写串行,并发的添加 / 移除互不覆盖。 */
const writeChains = new Map<string, Promise<unknown>>();
function mutate<T>(
  userDataDir: string,
  botId: string,
  change: (stored: StoredWorkbench) => { next: StoredWorkbench; result: T },
): Promise<T> {
  const key = `${userDataDir}\0${botId}`;
  const run = (writeChains.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const { next, result } = change(await readStored(userDataDir, botId));
      await writeStored(userDataDir, botId, next);
      return result;
    });
  writeChains.set(key, run);
  // finally 派生的 promise 会继承 run 的 rejection 且无人接住 —— 磁盘错误/
  // 写入中途 bot home 被删时升级为进程级 unhandledRejection。cleanup 照跑,
  // rejection 在此吸收(调用方已拿到原始 run 的失败)。
  void run.finally(() => {
    if (writeChains.get(key) === run) writeChains.delete(key);
  }).catch(() => undefined);
  return run;
}

async function describeDirectory(dir: StoredDirectory): Promise<BotWorkbenchDirectory> {
  let exists = false;
  try {
    exists = (await fs.stat(dir.path)).isDirectory();
  } catch {
    exists = false;
  }
  return { path: dir.path, name: path.basename(dir.path) || dir.path, addedAt: dir.addedAt, exists };
}

export async function readBotWorkbench(userDataDir: string, botId: string): Promise<BotWorkbench> {
  const stored = await readStored(userDataDir, botId);
  return {
    directories: await Promise.all(stored.directories.map(describeDirectory)),
    tasks: stored.tasks,
  };
}

/** 工具读取用:已接手项目与判断,不做文件系统探测。 */
export async function readBotWorkbenchState(
  userDataDir: string,
  botId: string,
): Promise<{ directories: string[]; tasks: Record<string, WorkbenchTaskJudgment> }> {
  const stored = await readStored(userDataDir, botId);
  return { directories: stored.directories.map((dir) => dir.path), tasks: stored.tasks };
}

/** 整条替换一件任务的判断(上限与淘汰见 `boundJudgments`)。 */
export async function setBotWorkbenchJudgment(
  userDataDir: string,
  botId: string,
  taskId: string,
  judgment: Omit<WorkbenchTaskJudgment, 'updatedAt'>,
  now: Date = new Date(),
): Promise<WorkbenchTaskJudgment> {
  const saved: WorkbenchTaskJudgment = { ...judgment, updatedAt: now.toISOString() };
  const normalized = normalizeJudgment(saved);
  if (!normalized) throw new Error('Invalid workbench judgment');
  return mutate(userDataDir, botId, (stored) => ({
    next: { ...stored, tasks: boundJudgments({ ...stored.tasks, [taskId]: normalized }) },
    result: normalized,
  }));
}

/** 条目转成伙伴的后台任务后删掉它的判断(之后它就是普通的「你交代的」格子)。 */
export async function deleteBotWorkbenchJudgment(userDataDir: string, botId: string, taskId: string): Promise<void> {
  await mutate(userDataDir, botId, (stored) => {
    if (!stored.tasks[taskId]) return { next: stored, result: undefined };
    const rest = { ...stored.tasks };
    delete rest[taskId];
    return { next: { ...stored, tasks: rest }, result: undefined };
  });
}

/** 外部会话导入成 Cindy 任务后,把判断改挂到新的 session id。 */
export async function rekeyBotWorkbenchJudgment(
  userDataDir: string,
  botId: string,
  fromTaskId: string,
  toTaskId: string,
): Promise<void> {
  await mutate(userDataDir, botId, (stored) => {
    const judgment = stored.tasks[fromTaskId];
    if (!judgment || fromTaskId === toTaskId) return { next: stored, result: undefined };
    const rest = { ...stored.tasks };
    delete rest[fromTaskId];
    return { next: { ...stored, tasks: { ...rest, [toTaskId]: judgment } }, result: undefined };
  });
}

/** 只要路径的已接手项目列表(授权校验用,不做文件系统探测)。 */
export async function readBotWorkbenchDirectoryPaths(userDataDir: string, botId: string): Promise<string[]> {
  return (await readStored(userDataDir, botId)).directories.map((dir) => dir.path);
}

export type DirectoryChangeResult = { ok: true } | { ok: false; errorCode: 'NOT_A_DIRECTORY' | 'TOO_MANY' };

export async function addBotWorkbenchDirectory(
  userDataDir: string,
  botId: string,
  dirPath: string,
  now: Date = new Date(),
): Promise<DirectoryChangeResult> {
  const resolved = path.resolve(dirPath);
  try {
    if (!(await fs.stat(resolved)).isDirectory()) return { ok: false, errorCode: 'NOT_A_DIRECTORY' };
  } catch {
    return { ok: false, errorCode: 'NOT_A_DIRECTORY' };
  }
  return mutate<DirectoryChangeResult>(userDataDir, botId, (stored) => {
    const rest = stored.directories.filter((dir) => dir.path !== resolved);
    if (rest.length >= BOT_WORKBENCH_MAX_DIRECTORIES) {
      return { next: stored, result: { ok: false, errorCode: 'TOO_MANY' } };
    }
    // 最近交代的项目排最前。
    const next = { ...stored, directories: [{ path: resolved, addedAt: now.toISOString() }, ...rest] };
    return { next, result: { ok: true } };
  });
}

export async function removeBotWorkbenchDirectory(userDataDir: string, botId: string, dirPath: string): Promise<void> {
  // 与 add 同口径归一:add 存的是 path.resolve 后的路径, remove 若按原始串比较,
  // 等价但写法不同的路径(尾分隔符、./、../ 段)会静默漏删, 且广播后 UI 里项目
  // 仍在。resolve 后比较。
  const resolved = path.resolve(dirPath);
  await mutate(userDataDir, botId, (stored) => ({
    next: { ...stored, directories: stored.directories.filter((dir) => dir.path !== resolved) },
    result: undefined,
  }));
}

export function broadcastBotWorkbenchChanged(botId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(MAKER_PUSH.BOT_WORKBENCH_CHANGED, { botId });
    } catch (error) {
      log.warn('Bot workbench broadcast failed', { error: String(error) });
    }
  }
}
