import { eq } from 'drizzle-orm';
import { getDbClient } from './client/current.js';
import { sessions } from './schema.js';
import { createLogger } from '../logger.js';
const log = createLogger('sessions');

export async function getSessionFsSnapshot(id: string): Promise<{
  workingDir: string | null;
  permissionMode: string;
  planModeEnabled: boolean;
  remoteHostId: string | null;
} | null> {
  try {
    const db = getDbClient().drizzle;
    const [row] = await db
      .select({
        workingDir: sessions.workingDir,
        permissionMode: sessions.permissionMode,
        planModeEnabled: sessions.planModeEnabled,
        remoteHostId: sessions.remoteHostId,
      })
      .from(sessions)
      .where(eq(sessions.id, id))
      .limit(1);
    return row ?? null;
  } catch (err) {
    log.warn('getSessionFsSnapshot failed', {
      sessionId: id,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

