/**
 * session-title-user-renames-store —— 用户手动改过名的任务 id。
 *
 * File: <userData>/session-title-user-renames.json
 *
 * 动态标题开关打开后会覆盖「首条自动起名」写出的标题(例如「你好」)。
 * 手动改名必须跨重启仍然受保护,sessions 表没有「谁写的」列,所以单独记一份。
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { desktopMakerLogger } from './maker-host/logger-adapter.js';

const log = desktopMakerLogger.child('session-title-user-renames-store');

const MAX_IDS = 4000;

function filePath(): string {
  return path.join(app.getPath('userData'), 'session-title-user-renames.json');
}

function readIds(): string[] {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return [];
    const ids = (parsed as { ids?: unknown }).ids;
    if (!Array.isArray(ids)) return [];
    return ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
}

const remembered = new Set<string>();
let loaded = false;

function ensureLoaded(): Set<string> {
  if (loaded) return remembered;
  loaded = true;
  for (const id of readIds()) remembered.add(id);
  return remembered;
}

export function hasPersistedManualSessionTitleRename(sessionId: string): boolean {
  if (!sessionId) return false;
  return ensureLoaded().has(sessionId);
}

export function noteSessionTitleManuallyRenamed(sessionId: string): void {
  if (!sessionId) return;
  const ids = ensureLoaded();
  if (ids.has(sessionId)) return;
  ids.add(sessionId);
  const list = [...ids];
  if (list.length > MAX_IDS) list.splice(0, list.length - MAX_IDS);
  try {
    fs.writeFileSync(filePath(), JSON.stringify({ ids: list }, null, 2), 'utf8');
  } catch (err) {
    log.warn('persist manual session title rename failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
