import { eq } from 'drizzle-orm';
import { botDelegations } from '@cindy/runtime-db/schema';
import type { DbClient } from '@cindy/runtime-db/client/DbClient';
function parseRecord(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function hasExplicitSessionTaskModel(getDbClient: () => DbClient, sessionId: string): Promise<boolean> {
  const [row] = await getDbClient().drizzle
    .select({ permissionSnapshotJson: botDelegations.permissionSnapshotJson })
    .from(botDelegations)
    .where(eq(botDelegations.childSessionId, sessionId))
    .limit(1);
  return !!parseRecord(row?.permissionSnapshotJson).taskModelOverride;
}
