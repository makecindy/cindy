/**
 * Writing a task's context snapshot (tokens used, window) to its row, at a turn's end or a Pi
 * compaction boundary, and broadcasting the row's values. Moved verbatim out of
 * sessionSpendBroadcaster.ts (which imports electron) so the Node Host writes the same columns with the
 * same rules; the model-window gate reads them for a task without a live runtime. The rules are
 * documented on sessionSpendBroadcaster.ts recordSessionContextSnapshot, which keeps its name and
 * every caller.
 *
 * Ports, each called where the body used it: the data owner scope capture, its check (after the row
 * is read back), the broadcast and the logger.
 */
import { sql } from 'drizzle-orm';
import { getDbClient } from './client/current';
import { sessions } from './schema';

type OwnerScope = ReturnType<typeof import('../device-link/broadcast-tap.js').captureDataOwnerBroadcastScope>;

export interface SessionContextSnapshotPorts {
  captureOwnerScope: () => OwnerScope | null;
  isOwnerScopeCurrent: (scope: OwnerScope | null) => boolean;
  broadcastContext: (
    payload: { sessionId: string; contextTokens: number; contextWindow: number },
    ownerScope?: OwnerScope | null,
  ) => void;
  log: { warn(message: string, ...args: unknown[]): void };
}

/** recordSessionContextSnapshot (sessionSpendBroadcaster.ts), with its ports first. */
export async function recordSessionContextSnapshotWith(
  ports: SessionContextSnapshotPorts,
  sessionId: string,
  contextTokens: number,
  contextWindow: number,
): Promise<void> {
  const { captureOwnerScope, isOwnerScopeCurrent, broadcastContext, log } = ports;

  if (!sessionId) return;
  if (!Number.isFinite(contextTokens) || contextTokens < 0) return;
  if (contextTokens === 0 && (!Number.isFinite(contextWindow) || contextWindow <= 0)) return;
  const ownerScope = captureOwnerScope();
  try {
    const db = getDbClient().drizzle;
    const updates: { contextTokens: number; contextWindow?: number; contextWindowRuntime?: number } = {
      contextTokens: Math.floor(contextTokens),
    };
    if (Number.isFinite(contextWindow) && contextWindow > 0) {
      updates.contextWindow = Math.floor(contextWindow);
      updates.contextWindowRuntime = updates.contextWindow;
    }
    await db
      .update(sessions)
      .set(updates)
      .where(sql`${sessions.id} = ${sessionId}`)
      .run();
    // 回读保证广播的是 DB 最终值 (而非入参 —— contextWindow 可能没改)
    const row = await db
      .select({
        contextTokens: sessions.contextTokens,
        contextWindow: sessions.contextWindow,
      })
      .from(sessions)
      .where(sql`${sessions.id} = ${sessionId}`)
      .get();
    if (!isOwnerScopeCurrent(ownerScope)) return;
    broadcastContext(
      {
        sessionId,
        contextTokens: row?.contextTokens ?? 0,
        contextWindow: row?.contextWindow ?? 0,
      },
      ownerScope,
    );
  } catch (err) {
    log.warn(
      'recordSessionContextSnapshot failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}
