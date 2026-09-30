/**
 * 伙伴工作台:伙伴经 `update_workbench` 写入的卡片,存放在伙伴自己的家
 * `<ownerRoot>/bots/<botId>/workbench.json`。
 *
 * 卡片只是展示数据,每次整体替换;格式校验在工具层完成,这里再做一次有界裁剪,
 * 防止旧文件或手工改动把渲染层撑坏。主人交给伙伴的工作目录也记在这里,
 * 与卡片分开维护:伙伴重写卡片不会丢目录,主人加目录也不会动卡片。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { BrowserWindow } from 'electron';
import { and, eq } from 'drizzle-orm';

import type { WorkbenchCardWire } from '@cindy/mcps';

import type {
  BotWorkbench,
  BotWorkbenchCard,
  BotWorkbenchDirectory,
  BotWorkbenchRow,
} from '../../shared/botWorkbench.js';
import { runGit } from '../git-review/gitRunner.js';
import { botProfileDir } from './botProfileFolder.js';
import { MAKER_PUSH } from './channels.js';
import { getDbClient } from '../localDb/client/current.js';
import { botProfiles, botSessionLinks, sessions } from '../localDb/schema.js';
import {
  activeOwnerScopeKey,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import { createLogger } from '../logger.js';

const log = createLogger('bot-workbench');
const WORKBENCH_FILE = 'workbench.json';
/** 单次写入最多 4 张(工具层限制);多个工作来源合计最多保留 8 张。 */
const MAX_CARDS = 8;
const MAX_ROWS = 5;
const MAX_DIRECTORIES = 6;
const GIT_TIMEOUT_MS = 3_000;

type Failure = { ok: false; errorCode: string; message: string };

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

interface StoredDirectory {
  path: string;
  addedAt: string;
}

interface StoredWorkbench {
  cards: BotWorkbenchCard[];
  updatedAt: string | null;
  directories: StoredDirectory[];
}

function normalizeCards(rawCards: unknown): BotWorkbenchCard[] {
  const cards: BotWorkbenchCard[] = [];
  for (const rawCard of Array.isArray(rawCards) ? rawCards : []) {
    if (cards.length >= MAX_CARDS) break;
    if (!rawCard || typeof rawCard !== 'object') continue;
    const card = rawCard as { title?: unknown; source?: unknown; rows?: unknown };
    const title = text(card.title, 12);
    if (!title) continue;
    const rows: BotWorkbenchRow[] = [];
    for (const rawRow of Array.isArray(card.rows) ? card.rows : []) {
      if (rows.length >= MAX_ROWS) break;
      if (!rawRow || typeof rawRow !== 'object') continue;
      const row = rawRow as Record<string, unknown>;
      const rowTitle = text(row.title, 60);
      if (!rowTitle) continue;
      const rawAction = row.action as { label?: unknown; message?: unknown } | undefined;
      const label = rawAction ? text(rawAction.label, 8) : undefined;
      const message = rawAction ? text(rawAction.message, 500) : undefined;
      rows.push({
        title: rowTitle,
        ...(text(row.detail, 80) ? { detail: text(row.detail, 80) } : {}),
        ...(row.flag === true ? { flag: true } : {}),
        ...(label && message ? { action: { label, message } } : text(row.status, 12) ? { status: text(row.status, 12) } : {}),
      });
    }
    cards.push({ title, ...(text(card.source, 24) ? { source: text(card.source, 24) } : {}), rows });
  }
  return cards;
}

function normalizeDirectories(raw: unknown): StoredDirectory[] {
  const out: StoredDirectory[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (out.length >= MAX_DIRECTORIES) break;
    if (!entry || typeof entry !== 'object') continue;
    const dir = entry as { path?: unknown; addedAt?: unknown };
    if (typeof dir.path !== 'string' || !path.isAbsolute(dir.path) || seen.has(dir.path)) continue;
    seen.add(dir.path);
    out.push({ path: dir.path, addedAt: typeof dir.addedAt === 'string' ? dir.addedAt : new Date(0).toISOString() });
  }
  return out;
}

/** 渲染前的有界规整:丢掉畸形条目,不信任磁盘上的任何字段。 */
export function normalizeWorkbench(raw: unknown): StoredWorkbench | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as { cards?: unknown; updatedAt?: unknown; directories?: unknown };
  return {
    cards: normalizeCards(record.cards),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
    directories: normalizeDirectories(record.directories),
  };
}

function workbenchPath(userDataDir: string, botId: string): string {
  return path.join(botProfileDir(userDataDir, botId), WORKBENCH_FILE);
}

async function readStored(userDataDir: string, botId: string): Promise<StoredWorkbench> {
  const empty: StoredWorkbench = { cards: [], updatedAt: null, directories: [] };
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
  await fs.writeFile(temp, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
  await fs.rename(temp, target);
}

/** 卡片(模型写)与目录(主人加)写同一个文件:同一伙伴的读改写串行,互不覆盖。 */
const writeChains = new Map<string, Promise<unknown>>();
function mutate<T>(
  userDataDir: string,
  botId: string,
  change: (stored: StoredWorkbench) => Promise<{ next: StoredWorkbench; result: T }> | { next: StoredWorkbench; result: T },
): Promise<T> {
  const key = `${userDataDir}\0${botId}`;
  const run = (writeChains.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const { next, result } = await change(await readStored(userDataDir, botId));
      await writeStored(userDataDir, botId, next);
      return result;
    });
  writeChains.set(key, run);
  void run.finally(() => {
    if (writeChains.get(key) === run) writeChains.delete(key);
  });
  return run;
}

async function gitText(cwd: string, args: string[]): Promise<string | null> {
  try {
    const result = await runGit(args, { cwd, timeoutMs: GIT_TIMEOUT_MS, maxStdoutBytes: 2 * 1024 * 1024 });
    return result.stdout;
  } catch {
    return null;
  }
}

/** 目录事实:只读、限时,读不到就少显示一项,绝不阻塞整个工作台。 */
async function describeDirectory(dir: StoredDirectory): Promise<BotWorkbenchDirectory> {
  const base: BotWorkbenchDirectory = {
    path: dir.path,
    name: path.basename(dir.path) || dir.path,
    addedAt: dir.addedAt,
    exists: false,
  };
  try {
    if (!(await fs.stat(dir.path)).isDirectory()) return base;
  } catch {
    return base;
  }
  const inside = await gitText(dir.path, ['rev-parse', '--is-inside-work-tree']);
  if (inside?.trim() !== 'true') return { ...base, exists: true };
  const [branch, status, last] = await Promise.all([
    gitText(dir.path, ['rev-parse', '--abbrev-ref', 'HEAD']),
    gitText(dir.path, ['status', '--porcelain', '-z']),
    gitText(dir.path, ['log', '-1', '--format=%s%x00%cI']),
  ]);
  const [subject, at] = (last ?? '').trim().split('\0');
  return {
    ...base,
    exists: true,
    git: {
      branch: branch?.trim() && branch.trim() !== 'HEAD' ? branch.trim() : null,
      changes: status ? status.split('\0').filter((entry) => /^.. /.test(entry)).length : 0,
      ...(subject && at ? { lastCommit: { subject: subject.slice(0, 120), at } } : {}),
    },
  };
}

export async function readBotWorkbench(userDataDir: string, botId: string): Promise<BotWorkbench> {
  const stored = await readStored(userDataDir, botId);
  return {
    cards: stored.cards,
    updatedAt: stored.updatedAt,
    directories: await Promise.all(stored.directories.map(describeDirectory)),
  };
}

export async function writeBotWorkbench(
  userDataDir: string,
  botId: string,
  cards: WorkbenchCardWire[],
  now: Date = new Date(),
): Promise<{ cards: BotWorkbenchCard[]; updatedAt: string }> {
  const updatedAt = now.toISOString();
  return mutate(userDataDir, botId, (stored) => {
    // 按工作来源替换:伙伴更新「星落美术」的卡片,不该冲掉它给「Filo」整理的卡片。
    // 空数组仍表示清空全部。
    const incoming = normalizeCards(cards);
    const replaced = new Set(incoming.map((card) => card.source ?? ''));
    const kept = incoming.length === 0 ? [] : stored.cards.filter((card) => !replaced.has(card.source ?? ''));
    const next = { ...stored, cards: [...incoming, ...kept].slice(0, MAX_CARDS), updatedAt };
    return { next, result: { cards: next.cards, updatedAt } };
  });
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
    if (rest.length >= MAX_DIRECTORIES) return { next: stored, result: { ok: false, errorCode: 'TOO_MANY' } };
    // 最近交代的目录排最前。
    const next = { ...stored, directories: [{ path: resolved, addedAt: now.toISOString() }, ...rest] };
    return { next, result: { ok: true } };
  });
}

export async function removeBotWorkbenchDirectory(userDataDir: string, botId: string, dirPath: string): Promise<void> {
  await mutate(userDataDir, botId, (stored) => ({
    next: { ...stored, directories: stored.directories.filter((dir) => dir.path !== dirPath) },
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

async function resolveBotForSession(
  callerSessionId: string,
): Promise<{ ok: true; botId: string } | Failure> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({
      botId: botSessionLinks.botId,
      role: botSessionLinks.role,
      sessionStatus: sessions.status,
      remoteHostId: sessions.remoteHostId,
      profileStatus: botProfiles.status,
      linkArchivedAt: botSessionLinks.archivedAt,
    })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
    .where(and(eq(botSessionLinks.sessionId, callerSessionId), eq(sessions.source, 'bot')))
    .limit(1);
  if (!row) return { ok: false, errorCode: 'NOT_A_BOT_SESSION', message: '当前任务不属于任何伙伴' };
  if (row.sessionStatus !== 'active' || row.profileStatus !== 'active' || row.linkArchivedAt !== null) {
    return { ok: false, errorCode: 'BOT_SESSION_INACTIVE', message: '已归档的伙伴任务不能更新工作台' };
  }
  if (row.role !== 'canonical') {
    return { ok: false, errorCode: 'BOT_SESSION_READ_ONLY', message: '只有伙伴的主任务可以更新工作台' };
  }
  if (row.remoteHostId) {
    return { ok: false, errorCode: 'REMOTE_WORKBENCH_UNAVAILABLE', message: '远端任务暂不支持工作台' };
  }
  return { ok: true, botId: row.botId };
}

/** `update_workbench` 的宿主实现。 */
export async function updateBotWorkbenchForSession(params: {
  callerSessionId: string;
  cards: WorkbenchCardWire[];
}): Promise<{ ok: true; updatedAt: string; cardCount: number } | Failure> {
  try {
    const scopeKey = activeOwnerScopeKey();
    if (isAppSessionBoundaryPending()) {
      return { ok: false, errorCode: 'OWNER_SCOPE_CHANGED', message: '账号正在切换，请稍后重试' };
    }
    const userDataDir = ownerScopedUserDataPath();
    const bot = await resolveBotForSession(params.callerSessionId);
    if (!bot.ok) return bot;
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== scopeKey) {
      return { ok: false, errorCode: 'OWNER_SCOPE_CHANGED', message: '账号已切换，请重试' };
    }
    const saved = await writeBotWorkbench(userDataDir, bot.botId, params.cards);
    broadcastBotWorkbenchChanged(bot.botId);
    return { ok: true, updatedAt: saved.updatedAt, cardCount: saved.cards.length };
  } catch (error) {
    return { ok: false, errorCode: 'INTERNAL', message: error instanceof Error ? error.message : String(error) };
  }
}
