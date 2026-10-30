import { Method, type ThreadTurnsListParams, type ThreadTurnsListResponse } from './app-server/protocol.js';

/** Resolve a timestamp-backed turn boundary without mutating a paginated thread. */
export async function resolveForkTurnAnchor(
  request: (method: string, params: ThreadTurnsListParams) => Promise<ThreadTurnsListResponse>,
  threadId: string,
  forkAtTimestampMs?: number,
): Promise<string> {
  if (forkAtTimestampMs === undefined) {
    throw new Error('Codex fork requires an unambiguous native anchor or event timestamp');
  }
  if (!Number.isFinite(forkAtTimestampMs) || forkAtTimestampMs <= 0) {
    throw new Error('Codex fork event timestamp is invalid');
  }
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  const seenTurns = new Set<string>();
  // Bound both response size and a broken daemon's pagination loop. No items,
  // reasoning, or tool output are needed to select a native turn boundary.
  for (let page = 0; page < 100; page += 1) {
    const response = await request(Method.ThreadTurnsList, {
      threadId, ...(cursor ? { cursor } : {}),
      limit: 100,
      sortDirection: 'desc', itemsView: 'notLoaded',
    });
    if (!Array.isArray(response.data) || response.data.length === 0) break;
    for (const turn of response.data) {
      if (!turn.id || seenTurns.has(turn.id) || !['completed', 'failed', 'interrupted'].includes(turn.status)) {
        throw new Error('Codex fork requires a stable terminal turn history');
      }
      seenTurns.add(turn.id);
      if (typeof turn.startedAt !== 'number' || !Number.isFinite(turn.startedAt)) {
        throw new Error('Codex fork native turn timestamp is unavailable');
      }
      const eventSecond = Math.floor(forkAtTimestampMs / 1000);
      // Native timestamps have second precision. Do not guess ordering when
      // another turn could have started later in the same second as the event.
      if (turn.startedAt === eventSecond) {
        throw new Error('Codex fork event overlaps an ambiguous native turn boundary');
      }
      if (turn.startedAt < eventSecond) return turn.id;
    }
    if (!response.nextCursor) break;
    if (seenCursors.has(response.nextCursor)) break;
    seenCursors.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  throw new Error('Codex fork turn boundary is unavailable in native history');
}
