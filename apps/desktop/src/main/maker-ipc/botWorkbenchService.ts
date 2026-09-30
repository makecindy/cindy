/**
 * 伙伴工作台:伙伴经 `update_workbench` 写入的卡片,存放在伙伴自己的家
 * `<ownerRoot>/bots/<botId>/workbench.json`。
 *
 * 卡片只是展示数据,每次整体替换;格式校验在工具层完成,这里再做一次有界裁剪,
 * 防止旧文件或手工改动把渲染层撑坏。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { BrowserWindow } from 'electron';
import { and, eq } from 'drizzle-orm';

import type { WorkbenchCardWire } from '@cindy/mcps';

import type { BotWorkbench, BotWorkbenchCard, BotWorkbenchRow } from '../../shared/botWorkbench.js';
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
const MAX_CARDS = 4;
const MAX_ROWS = 5;

type Failure = { ok: false; errorCode: string; message: string };

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** 渲染前的有界规整:丢掉畸形条目,不信任磁盘上的任何字段。 */
export function normalizeWorkbench(raw: unknown): BotWorkbench | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as { cards?: unknown; updatedAt?: unknown };
  if (!Array.isArray(record.cards)) return null;
  const cards: BotWorkbenchCard[] = [];
  for (const rawCard of record.cards) {
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
  return { cards, updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString() };
}

function workbenchPath(userDataDir: string, botId: string): string {
  return path.join(botProfileDir(userDataDir, botId), WORKBENCH_FILE);
}

export async function readBotWorkbench(userDataDir: string, botId: string): Promise<BotWorkbench | null> {
  try {
    const raw = await fs.readFile(workbenchPath(userDataDir, botId), 'utf8');
    return normalizeWorkbench(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    log.warn('Bot workbench read failed', { botId, error: String(error) });
    return null;
  }
}

export async function writeBotWorkbench(
  userDataDir: string,
  botId: string,
  cards: WorkbenchCardWire[],
  now: Date = new Date(),
): Promise<BotWorkbench> {
  const workbench = normalizeWorkbench({ cards, updatedAt: now.toISOString() }) ?? {
    cards: [],
    updatedAt: now.toISOString(),
  };
  const target = workbenchPath(userDataDir, botId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(workbench, null, 2)}\n`, 'utf8');
  await fs.rename(temp, target);
  return workbench;
}

function broadcastBotWorkbenchChanged(botId: string): void {
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
