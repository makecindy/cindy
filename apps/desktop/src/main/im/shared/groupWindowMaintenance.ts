/** 群消息池的入库护栏、容量观测与持久游标惰性清理。官方/个人 bot 共用。 */

import { createHash } from 'node:crypto';

import { and, eq, lt, notExists } from 'drizzle-orm';

import { getDbClient } from '../../localDb/client/current';
import {
  hookGroupContextCursors,
  hookGroupMessages,
  hookGroupMessageStats,
} from '../../localDb/schema';
import { createLogger } from '../../logger';

export const GROUP_WINDOW_ENTRY_TEXT_MAX_BYTES = 16 * 1024;
export const GROUP_CONTEXT_CURSOR_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const CURSOR_RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const NAMESPACE_STATS_LOG_INTERVAL_MS = 5 * 60 * 1000;
const MAX_TRACKED_NAMESPACES = 1000;
const log = createLogger('group-window-maintenance');
const namespaceStatsLoggedAt = new Map<string, number>();
let lastCursorRetentionSweepAt = 0;

function providerFamily(provider: string): string {
  return provider.split(':', 1)[0] || 'unknown';
}

function providerFingerprint(provider: string): string {
  return createHash('sha256').update(provider, 'utf8').digest('hex').slice(0, 12);
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const chars: string[] = [];
  let bytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) break;
    chars.push(char);
    bytes += charBytes;
  }
  return chars.join('');
}

export function prepareGroupWindowText(provider: string, text: string): string {
  const originalBytes = Buffer.byteLength(text, 'utf8');
  const stored = truncateUtf8(text, GROUP_WINDOW_ENTRY_TEXT_MAX_BYTES);
  if (originalBytes > GROUP_WINDOW_ENTRY_TEXT_MAX_BYTES) {
    log.warn(
      JSON.stringify({
        event: 'groupWindow.entryTruncated',
        provider: providerFamily(provider),
        namespace: providerFingerprint(provider),
        originalBytes,
        storedBytes: Buffer.byteLength(stored, 'utf8'),
      }),
    );
  }
  return stored;
}

export async function getGroupWindowNamespaceStats(
  provider: string,
): Promise<{ rows: number; textBytes: number }> {
  const [row] = await getDbClient()
    .drizzle.select({
      rows: hookGroupMessageStats.rowCount,
      textBytes: hookGroupMessageStats.textBytes,
    })
    .from(hookGroupMessageStats)
    .where(eq(hookGroupMessageStats.provider, provider))
    .limit(1);
  return { rows: Number(row?.rows ?? 0), textBytes: Number(row?.textBytes ?? 0) };
}

export async function maybeLogGroupWindowNamespaceStats(
  provider: string,
  now = Date.now(),
): Promise<void> {
  const last = namespaceStatsLoggedAt.get(provider) ?? 0;
  if (now - last < NAMESPACE_STATS_LOG_INTERVAL_MS) return;
  namespaceStatsLoggedAt.set(provider, now);
  if (namespaceStatsLoggedAt.size > MAX_TRACKED_NAMESPACES) {
    const oldest = namespaceStatsLoggedAt.keys().next().value;
    if (oldest !== undefined) namespaceStatsLoggedAt.delete(oldest);
  }
  const identity = { provider: providerFamily(provider), namespace: providerFingerprint(provider) };
  try {
    const stats = await getGroupWindowNamespaceStats(provider);
    log.info(JSON.stringify({ event: 'groupWindow.namespaceStats', ...identity, ...stats }));
  } catch (error) {
    log.warn(
      JSON.stringify({
        event: 'groupWindow.namespaceStatsFailed',
        ...identity,
        error: errorKind(error),
      }),
    );
  }
}

export async function sweepExpiredGroupWindowCursors(now = Date.now()): Promise<number> {
  const db = getDbClient().drizzle;
  const result = await db
    .delete(hookGroupContextCursors)
    .where(
      and(
        lt(hookGroupContextCursors.updatedAt, now - GROUP_CONTEXT_CURSOR_RETENTION_MS),
        // cursor_key 是各车道的稳定 opaque scope，不能可靠反解 chat/thread。
        // 只在整个 provider 已无消息时清理，避免永久历史或官方保留窗口重启后重放。
        notExists(
          db
            .select({ id: hookGroupMessages.id })
            .from(hookGroupMessages)
            .where(eq(hookGroupMessages.provider, hookGroupContextCursors.provider))
            .limit(1),
        ),
      ),
    )
    .run();
  return result.changes;
}

export async function maybeSweepExpiredGroupWindowCursors(now = Date.now()): Promise<void> {
  if (now - lastCursorRetentionSweepAt < CURSOR_RETENTION_SWEEP_INTERVAL_MS) return;
  lastCursorRetentionSweepAt = now;
  try {
    const removed = await sweepExpiredGroupWindowCursors(now);
    if (removed > 0)
      log.info(JSON.stringify({ event: 'groupWindow.cursorRetentionSweep', removed }));
  } catch (error) {
    log.warn(
      JSON.stringify({ event: 'groupWindow.cursorRetentionSweepFailed', error: errorKind(error) }),
    );
  }
}
