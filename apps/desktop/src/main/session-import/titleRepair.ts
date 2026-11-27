/**
 * 修复较早导入留下的坏标题（打开本地数据库时执行，幂等）。
 *
 * 修复前，WorkBuddy 等来源把注入的 `<system-reminder data-role="user-context">…` 当成标题写进
 * sessions.title；标题截到 120 字，结束标记和真正的提问都不在了，显示时无法还原，只能从这个
 * 任务已导入的第一条用户消息重新取。只动同时满足下列条件的任务：
 *  - 有导入来源记录（session_imports），不是 Cindy 里新建的任务；
 *  - 标题仍以 `<system-reminder` 开头，或是 WorkBuddy 的纯日期时间占位名 —— 用户自己改过的
 *    名字不会长这样；
 *  - 从前几条用户消息里能取到用户说的话；取不到就保持原样，不编标题。
 * 写入带「标题仍是原值」条件，不改 updated_at（不打乱任务列表顺序）。
 */

import type Database from 'better-sqlite3';

import { isTimestampTitle, makeTitle } from './sources/common.js';

const USER_MESSAGES_TO_TRY = 3;

interface CandidateRow {
  id: string;
  title: string;
  source: string;
}

function needsRepair(row: CandidateRow): boolean {
  const title = row.title.trim();
  return /^<system-reminder(?:[\s>]|$)/i.test(title) || (row.source === 'workbuddy' && isTimestampTitle(title));
}

/** messages.content 里的用户消息：JSON 字符串，或带图片时的 `{ text, images, files }`。 */
function userMessageText(content: string): string {
  try {
    const value = JSON.parse(content) as unknown;
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string') {
      return (value as { text: string }).text;
    }
  } catch {
    // 不是 JSON：不是导入器写的用户消息，跳过。
  }
  return '';
}

function hasTable(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** 返回改好的任务数。 */
export function repairImportedSessionTitles(db: Database.Database): number {
  if (!hasTable(db, 'session_imports') || !hasTable(db, 'messages')) return 0;
  const candidates = (db.prepare(`
    SELECT s.id, s.title, i.source
    FROM sessions s
    JOIN session_imports i ON i.session_id = s.id
    WHERE s.status != 'deleted'
      AND (s.title LIKE '<system-reminder%' OR (i.source = 'workbuddy' AND s.title GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'))
  `).all() as CandidateRow[]).filter(needsRepair);
  if (candidates.length === 0) return 0;

  const firstUserMessages = db.prepare(`
    SELECT content FROM messages
    WHERE session_id = ? AND role = 'user'
    ORDER BY created_at, id
    LIMIT ${USER_MESSAGES_TO_TRY}
  `);
  const update = db.prepare('UPDATE sessions SET title = ? WHERE id = ? AND title = ?');
  return db.transaction(() => {
    let changed = 0;
    for (const row of candidates) {
      let title = '';
      for (const m of firstUserMessages.all(row.id) as Array<{ content: string }>) {
        title = makeTitle(userMessageText(m.content), '');
        if (title) break;
      }
      if (title && title !== row.title) changed += update.run(title, row.id, row.title).changes;
    }
    return changed;
  })();
}
