import { eq } from 'drizzle-orm';
import type { GhostHarnessHistoryPage } from '@cindy/plugin-protocol';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { getMessagesForHistory, type HistoryCursor } from '../localDb/chatHistoryReader.js';
import { sessions } from '../localDb/schema.js';
import { drainPersistQueue } from '../messagePersistBroadcaster.js';
import { ghostActivityId } from './subscriptionGateway.js';
import { projectHarnessContent } from './harnessContent.js';

function fail(code: 'STALE_RUNTIME' | 'INVALID_PARAMS' | 'UNAVAILABLE'): never {
  throw Object.assign(new Error('History is unavailable'), { code });
}

/** Reuse saved history and its database revision. Any concurrent edit invalidates pagination. */
export async function readHarnessHistory(
  sessionId: string,
  name: 'messages' | 'tool-content',
  runtimeId: string,
  limit: number,
  cursor?: string,
): Promise<GhostHarnessHistoryPage> {
  const snapshot = getCurrentDbClientSnapshot();
  if (!snapshot) fail('UNAVAILABLE');
  await drainPersistQueue();
  const revision = async () => {
    if (getCurrentDbClientSnapshot() !== snapshot) fail('STALE_RUNTIME');
    const [row] = await snapshot.client.query<{ changes: number; version: number }>(
      'SELECT total_changes() AS changes, data_version AS version FROM pragma_data_version',
    );
    return `${snapshot.clientEpoch}:${row.version}:${row.changes}`;
  };
  const stamp = await revision();
  let after: HistoryCursor | null = null;
  if (cursor) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
      fail('INVALID_PARAMS');
    }
    if (
      !parsed ||
      parsed.sessionId !== sessionId ||
      parsed.name !== name ||
      parsed.runtimeId !== runtimeId ||
      parsed.revision !== stamp
    )
      fail('STALE_RUNTIME');
    const c = parsed.after as HistoryCursor;
    if (
      !c ||
      typeof c.id !== 'string' ||
      c.id.length > 256 ||
      !Number.isSafeInteger(c.createdAt) ||
      !Number.isSafeInteger(c.rowid) ||
      c.rowid! < 1
    )
      fail('INVALID_PARAMS');
    after = { id: c.id, createdAt: c.createdAt, rowid: c.rowid };
  }
  const [session] = await snapshot.client.drizzle
    .select({ clearedAt: sessions.clearedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!session) fail('UNAVAILABLE');
  const page = await getMessagesForHistory({
    sessionIds: [sessionId],
    workdir: null,
    fromMs: session.clearedAt === null ? null : session.clearedAt + 1,
    toMs: null,
    agentKind: null,
    roles: name === 'messages' ? ['user', 'assistant'] : ['tool_use', 'tool_result'],
    includeRewound: false,
    limit,
    cursor: after,
    order: 'asc',
  });
  if ((await revision()) !== stamp || getCurrentDbClientSnapshot() !== snapshot)
    fail('STALE_RUNTIME');
  return {
    source: 'saved-history',
    items: page.items.map((item) => ({
      id: item.id,
      role: item.role as 'user' | 'assistant' | 'tool_use' | 'tool_result',
      createdAt: item.createdAt,
      ...(item.toolUseId ? { toolId: ghostActivityId(runtimeId, item.toolUseId) } : {}),
      ...projectHarnessContent(item.role, item.content),
    })),
    nextCursor: page.nextCursor
      ? Buffer.from(
          JSON.stringify({ sessionId, name, runtimeId, revision: stamp, after: page.nextCursor }),
        ).toString('base64url')
      : null,
  };
}
