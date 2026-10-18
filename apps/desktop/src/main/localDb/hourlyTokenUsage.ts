import { gte } from 'drizzle-orm';
import { hourlyTokenUsage } from './schema.js';
import { getDbClient } from './client/current.js';
import type { HourlyTokenUsageRow } from '../../shared/hourlyTokenUsage.js';

/** Read only aggregate tokens; message history and task contents are never consulted. */
export async function getHourlyTokenUsageSince(sinceDay: string): Promise<HourlyTokenUsageRow[]> {
  return await getDbClient()
    .drizzle.select({
      day: hourlyTokenUsage.day,
      hour: hourlyTokenUsage.hour,
      tokens: hourlyTokenUsage.tokens,
    })
    .from(hourlyTokenUsage)
    .where(gte(hourlyTokenUsage.day, sinceDay))
    .all();
}
