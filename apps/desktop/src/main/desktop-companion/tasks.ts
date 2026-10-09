import { and, desc, eq, gte, isNull } from 'drizzle-orm';

import { DESKTOP_COMPANION_TASK_WINDOW_MS } from '../../shared/desktopCompanion.js';
import { getDbClient } from '../localDb/client/current.js';
import { messages, sessions } from '../localDb/schema.js';

import { sanitizeSceneText } from './context.js';

export interface RecentCompanionTask {
  title: string;
}

export async function readRecentCompanionTask(
  now = Date.now(),
  windowMs = DESKTOP_COMPANION_TASK_WINDOW_MS,
): Promise<RecentCompanionTask | null> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({
      title: sessions.title,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(sessions, eq(messages.sessionId, sessions.id))
    .where(
      and(
        eq(messages.role, 'user'),
        isNull(messages.rewindAt),
        gte(messages.createdAt, now - windowMs),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  if (!row) return null;
  const title = sanitizeSceneText(row.title ?? '', 40);
  return title ? { title } : { title: 'current work' };
}
