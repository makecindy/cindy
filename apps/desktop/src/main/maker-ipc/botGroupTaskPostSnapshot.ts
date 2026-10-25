/** Freeze the wire payload before its first POST; the task owns it across retries and restarts. */
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDbClient } from '../localDb/client/current.js';
import { botDelegations } from '../localDb/schema.js';
import type { BotGroupTaskCard } from '../../shared/botGroupChat.js';
import type { ChatContentBlock } from './chatServerMigration.js';

const post = z.object({
  actorId: z.string(),
  messages: z.array(z.object({
    operationId: z.string(),
    content: z.array(z.object({ type: z.string() }).passthrough()),
    mentions: z.array(z.string()),
    threadRootId: z.string().optional(),
  })).min(1),
});
export interface BotGroupTaskPostSnapshot {
  actorId: string;
  /** `threadRootId` puts every part in the Thread the task was started from. */
  messages: Array<{ operationId: string; content: Array<BotGroupTaskCard | ChatContentBlock>; mentions: string[]; threadRootId?: string }>;
}

export async function prepareBotGroupTaskPost(
  delegationId: string,
  scope: { endpoint: string; selfId: string; roomId: string; clientId: string },
  prepare: () => Promise<BotGroupTaskPostSnapshot>,
): Promise<BotGroupTaskPostSnapshot> {
  // The task owns delivery snapshots; execution-state updates cannot overwrite them.
  const db = getDbClient().drizzle;
  const key = createHash('sha256').update(JSON.stringify([scope.endpoint, scope.selfId, scope.roomId, scope.clientId])).digest('hex');
  const jsonPath = `$.${key}`;
  const payload = sql<string | null>`json_extract(${botDelegations.groupTaskPostsJson}, ${jsonPath})`;
  const saved = await db.select({ payload }).from(botDelegations).where(eq(botDelegations.id, delegationId)).get();
  if (!saved) throw new Error('TASK_DELIVERY_UNAVAILABLE');
  if (saved.payload !== null) return post.parse(JSON.parse(saved.payload));
  const proposed = post.parse(await prepare());
  // First writer wins, even when two callers prepared concurrently. Keep unrelated task state.
  const [frozen] = await db.update(botDelegations).set({
    groupTaskPostsJson: sql`json_insert(${botDelegations.groupTaskPostsJson}, ${jsonPath}, json(${JSON.stringify(proposed)}))`,
  }).where(eq(botDelegations.id, delegationId)).returning({ payload });
  if (!frozen?.payload) throw new Error('TASK_DELIVERY_UNAVAILABLE');
  return post.parse(JSON.parse(frozen.payload));
}
