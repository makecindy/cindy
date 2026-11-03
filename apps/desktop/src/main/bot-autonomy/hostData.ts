/**
 * 观察层的宿主读取：本机数据库、伙伴目录与逐任务责任、设备互联。只读，不写库。
 * 调用方负责账号边界（service 在每次调用前后校验 owner scope）。
 */
import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current.js';
import {
  botDelegations,
  botProfiles,
  botProfileVersions,
  botSessionLinks,
  sessions,
} from '../localDb/schema.js';
import type { BotSystemSkillId } from '../../shared/botSystemSkills.js';
import { readTaskResponsibilities, responsibleSessionIds } from '../maker-ipc/botTaskResponsibility.js';
import { isCompanionShadowed } from '../companion-cloud/homes.js';
import { readAllowSchedulerFollow, readSystemSkillsOff, type FollowerBotState } from './follower.js';
import type { LocalSessionMeta, OwnershipSnapshot, RemoteDeviceTarget } from './taskWatch.js';

const SESSION_BATCH = 256;
/** 手机不运行任务，不进远程轮询（与用量同步的设备过滤同一口径）。 */
const MOBILE_PLATFORMS: ReadonlySet<string> = new Set(['ios', 'android']);

function toMeta(row: {
  id: string;
  title: string;
  workingDir: string | null;
  status: string;
  hiddenAt: number | null;
  source: string;
  orcaRole: string | null;
  activeTurnStartedAt: number | null;
  lastTurnEndedAt: number | null;
  clearedAt: number | null;
}, lane: { role: string; botId: string } | null): LocalSessionMeta {
  const started = row.activeTurnStartedAt;
  return {
    id: row.id,
    title: row.title,
    workingDir: row.workingDir,
    status: row.status,
    hiddenAt: row.hiddenAt,
    source: row.source,
    orcaRole: row.orcaRole,
    laneRole: lane?.role ?? null,
    laneBotId: lane?.botId ?? null,
    interrupted: started !== null && started > (row.lastTurnEndedAt ?? 0) && started > (row.clearedAt ?? 0),
    activeTurnStartedAt: started,
    lastTurnEndedAt: row.lastTurnEndedAt,
  };
}

const metaSelection = {
  id: sessions.id,
  title: sessions.title,
  workingDir: sessions.workingDir,
  status: sessions.status,
  hiddenAt: sessions.hiddenAt,
  source: sessions.source,
  orcaRole: sessions.orcaRole,
  activeTurnStartedAt: sessions.activeTurnStartedAt,
  lastTurnEndedAt: sessions.lastTurnEndedAt,
  clearedAt: sessions.clearedAt,
};

async function laneRoles(ids: readonly string[]): Promise<Map<string, { role: string; botId: string }>> {
  const out = new Map<string, { role: string; botId: string }>();
  const db = getDbClient().drizzle;
  for (let offset = 0; offset < ids.length; offset += SESSION_BATCH) {
    const rows = await db
      .select({ sessionId: botSessionLinks.sessionId, role: botSessionLinks.role, botId: botSessionLinks.botId })
      .from(botSessionLinks)
      .where(inArray(botSessionLinks.sessionId, ids.slice(offset, offset + SESSION_BATCH)));
    for (const row of rows) out.set(row.sessionId, { role: row.role, botId: row.botId });
  }
  return out;
}

export async function readLocalSessionMetas(ids: readonly string[]): Promise<LocalSessionMeta[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const db = getDbClient().drizzle;
  const rows: Array<Parameters<typeof toMeta>[0]> = [];
  for (let offset = 0; offset < unique.length; offset += SESSION_BATCH) {
    rows.push(...await db.select(metaSelection).from(sessions)
      .where(inArray(sessions.id, unique.slice(offset, offset + SESSION_BATCH))));
  }
  const roles = await laneRoles(rows.map((row) => row.id));
  return rows.map((row) => toMeta(row, roles.get(row.id) ?? null));
}

/** 启动兜底：最近被打断（开始了一轮但没有正常收尾）的在用任务。 */
export async function readInterruptedSessionMetas(
  sinceMs: number, limit: number, sessionIds?: readonly string[],
): Promise<LocalSessionMeta[]> {
  const db = getDbClient().drizzle;
  // An explicit empty scope means no query, never the whole account.
  const ids = sessionIds === undefined ? undefined : [...new Set(sessionIds)];
  const batches = ids === undefined ? [undefined] : Array.from(
    { length: Math.ceil(ids.length / SESSION_BATCH) }, (_, index) => ids.slice(index * SESSION_BATCH, (index + 1) * SESSION_BATCH),
  );
  const rows: Array<Parameters<typeof toMeta>[0]> = [];
  for (const batch of batches) {
    rows.push(...await db.select(metaSelection).from(sessions)
      .where(and(
        sql`${sessions.status} = 'active'`,
        isNull(sessions.hiddenAt),
        isNotNull(sessions.activeTurnStartedAt),
        gte(sessions.activeTurnStartedAt, sinceMs),
        sql`${sessions.activeTurnStartedAt} > coalesce(${sessions.lastTurnEndedAt}, 0)`,
        sql`${sessions.activeTurnStartedAt} > coalesce(${sessions.clearedAt}, 0)`,
        batch === undefined ? undefined : inArray(sessions.id, batch),
      ))
      .orderBy(desc(sessions.activeTurnStartedAt))
      .limit(limit));
  }
  const selected = rows.sort((a, b) => (b.activeTurnStartedAt ?? 0) - (a.activeTurnStartedAt ?? 0)).slice(0, limit);
  const roles = await laneRoles(selected.map(row => row.id));
  return selected.map(row => toMeta(row, roles.get(row.id) ?? null));
}

/** 伙伴目录：状态、能力位 allowSchedulerFollow、是否关掉「跟进」、是否在别的电脑运行（云端伙伴）。 */
export async function readBotDirectory(): Promise<Map<string, FollowerBotState>> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({
      id: botProfiles.id,
      status: botProfiles.status,
      canonicalSessionId: botProfiles.canonicalSessionId,
      capabilities: botProfileVersions.capabilitiesJson,
    })
    .from(botProfiles)
    .leftJoin(
      botProfileVersions,
      and(sql`${botProfileVersions.botId} = ${botProfiles.id}`, sql`${botProfileVersions.version} = ${botProfiles.currentVersion}`),
    );
  const out = new Map<string, FollowerBotState>();
  for (const row of rows) {
    out.set(row.id, {
      status: row.status,
      allowSchedulerFollow: readAllowSchedulerFollow(row.capabilities),
      shadowed: isCompanionShadowed(row.id),
      canonicalSessionId: row.canonicalSessionId ?? null,
      ...(readSystemSkillsOff(row.capabilities).includes('follow') ? { followOff: true } : {}),
    });
  }
  return out;
}

/** 某个伙伴当前资料里关掉的系统技能；伙伴不存在时按全开（调用方另有存在性检查）。 */
export async function readBotSystemSkillsOffFor(botId: string): Promise<BotSystemSkillId[]> {
  const [row] = await getDbClient().drizzle
    .select({ capabilities: botProfileVersions.capabilitiesJson })
    .from(botProfiles)
    .innerJoin(
      botProfileVersions,
      and(sql`${botProfileVersions.botId} = ${botProfiles.id}`, sql`${botProfileVersions.version} = ${botProfiles.currentVersion}`),
    )
    .where(eq(botProfiles.id, botId))
    .limit(1);
  return readSystemSkillsOff(row?.capabilities);
}

/**
 * 任务归属：委派来源（bot_delegations）与逐任务责任记录（task-responsibility.v1.json）。
 * 某个伙伴的责任文件损坏时失败关闭：不回退到委派证据（文件里可能有解除记录），该伙伴不认领任何任务。
 */
export async function readTaskOwnership(userDataDir: string): Promise<OwnershipSnapshot> {
  const bots = await readBotDirectory();
  const db = getDbClient().drizzle;
  const delegations = await db
    .select({ botId: botDelegations.requestingBotId, sessionId: botDelegations.childSessionId })
    .from(botDelegations)
    .where(isNotNull(botDelegations.childSessionId));
  const delegatedByBot = new Map<string, Set<string>>();
  for (const row of delegations) {
    if (!row.sessionId) continue;
    const set = delegatedByBot.get(row.botId) ?? new Set<string>();
    set.add(row.sessionId);
    delegatedByBot.set(row.botId, set);
  }
  const responsibleByBot = new Map<string, Set<string>>();
  const creatorBySession = new Map<string, string>();
  const takenOver: Array<[string, string]> = [];
  for (const [botId, bot] of bots) {
    if (bot.status === 'archived' || bot.status === 'deleting') continue;
    const delegated = delegatedByBot.get(botId) ?? new Set<string>();
    let ids: string[];
    try {
      ids = responsibleSessionIds(delegated, await readTaskResponsibilities(userDataDir, botId));
    } catch {
      continue;
    }
    responsibleByBot.set(botId, new Set(ids));
    for (const id of ids) {
      if (delegated.has(id)) {
        if (!creatorBySession.has(id)) creatorBySession.set(id, botId);
      } else {
        takenOver.push([id, botId]);
      }
    }
  }
  // 委派来源优先；只有明确接手（没有委派来源）的任务才按接手的伙伴算。
  for (const [id, botId] of takenOver) if (!creatorBySession.has(id)) creatorBySession.set(id, botId);
  return { bots, creatorBySession, responsibleByBot };
}

/** 设备目录 → 可轮询目标：同账号非本机的电脑；手机不跑任务。 */
export function toRemoteTargets(
  devices: ReadonlyArray<{
    deviceId: string;
    name: string;
    platform: string | null;
    appVersion: string | null;
    online: boolean;
    remoteControlEnabled: boolean;
    controlEnabled: boolean;
    isSelf: boolean;
  }>,
  mayServeBackgroundRead: (appVersion: string | null) => boolean,
): RemoteDeviceTarget[] {
  return devices
    .filter((device) => !device.isSelf && !MOBILE_PLATFORMS.has(device.platform ?? ''))
    .map((device) => ({
      deviceId: device.deviceId,
      name: device.name,
      online: device.online,
      eligible: device.remoteControlEnabled && device.controlEnabled && mayServeBackgroundRead(device.appVersion),
    }));
}
