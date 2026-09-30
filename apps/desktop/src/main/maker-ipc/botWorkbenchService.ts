/**
 * 伙伴工作台的存储:主人交给伙伴的项目目录,记在伙伴自己的家
 * `<ownerRoot>/bots/<botId>/workbench.json` 的 `directories` 里。
 *
 * 工作台上的任务格不落盘:它们是宿主从已有任务、后台任务和自动化现算出来的投影
 * (见 `shared/botWorkbench.ts`)。旧版本在同一个文件里存过伙伴写的卡片
 * (`cards` / `updatedAt`),读取时直接忽略,下次写入时不再带上,不报错。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { BrowserWindow } from 'electron';

import {
  BOT_WORKBENCH_MAX_DIRECTORIES,
  type BotWorkbench,
  type BotWorkbenchDirectory,
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
  return { directories: normalizeDirectories((raw as { directories?: unknown }).directories) };
}

function workbenchPath(userDataDir: string, botId: string): string {
  return path.join(botProfileDir(userDataDir, botId), WORKBENCH_FILE);
}

async function readStored(userDataDir: string, botId: string): Promise<StoredWorkbench> {
  const empty: StoredWorkbench = { directories: [] };
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
  await fs.writeFile(temp, `${JSON.stringify({ directories: stored.directories }, null, 2)}\n`, 'utf8');
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
  void run.finally(() => {
    if (writeChains.get(key) === run) writeChains.delete(key);
  });
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
  return { directories: await Promise.all(stored.directories.map(describeDirectory)) };
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
    const next = { directories: [{ path: resolved, addedAt: now.toISOString() }, ...rest] };
    return { next, result: { ok: true } };
  });
}

export async function removeBotWorkbenchDirectory(userDataDir: string, botId: string, dirPath: string): Promise<void> {
  await mutate(userDataDir, botId, (stored) => ({
    next: { directories: stored.directories.filter((dir) => dir.path !== dirPath) },
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
