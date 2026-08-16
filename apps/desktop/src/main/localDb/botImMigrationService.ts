import { createHash, randomUUID } from 'node:crypto';

import { and, eq, inArray, ne } from 'drizzle-orm';

import {
  botChannelMountIdentity,
  sameBotChannelMountIdentity,
  type BotChannelConnection,
} from '../../shared/botChannelRegistry.js';
import type {
  ApplyBotImMigrationInput,
  BotImMigrationCandidate,
  BotImMigrationConflict,
  BotImMigrationPlan,
  BotImMigrationRecord,
  BotImMigrationWarning,
} from '../../shared/botImMigration.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { createHookBindingStore, type HookBindingSnapshot } from '../hook-control/bindings.js';
import { hookBotRouteSourceFromExternalKey } from '../hook-control/botRouteTarget.js';
import { getDbClient } from './client/current.js';
import {
  botChannels,
  botImMigrationItems,
  botImMigrations,
  botLifecycleEvents,
  botProfiles,
  botRoutes,
  botSessionLinks,
  imBindings,
  sessions,
} from './schema.js';

type Db = ReturnType<typeof getDbClient>['drizzle'];
type ChannelRow = typeof botChannels.$inferSelect;
type RouteRow = typeof botRoutes.$inferSelect;
type MigrationRow = typeof botImMigrations.$inferSelect;

const ROUTE_KEY = 'default' as const;

function parseObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseArray<T>(value: string | null): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function planHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('base64url');
}

function connectionConfig(connection: BotChannelConnection): Record<string, unknown> {
  return {
    accountKey: connection.accountKey,
    accountName: connection.accountName,
    scopeKey: connection.scopeKey,
    connectionId: connection.id,
    ownership: connection.ownership,
    features: [...connection.features],
    featureCapabilities: connection.featureCapabilities ?? [],
  };
}

function channelMatchesConnection(row: ChannelRow, connection: BotChannelConnection): boolean {
  if (row.kind !== connection.kind) return false;
  const config = parseObject(row.configJson);
  return config?.accountKey === connection.accountKey && config?.ownership === connection.ownership;
}

function generatedChannelId(botId: string, connection: BotChannelConnection): string {
  const digest = createHash('sha256')
    .update(`${connection.kind}\0${connection.ownership}\0${connection.accountKey ?? ''}`)
    .digest('base64url')
    .slice(0, 22);
  return `${botId}:${connection.kind}:${digest}`;
}

async function authoritativeConnection(connectionId: string): Promise<BotChannelConnection | null> {
  const { listBotChannelConnections } = await import('../im/index.js');
  return listBotChannelConnections().find((item) => item.id === connectionId) ?? null;
}

function hookBindingStore() {
  return createHookBindingStore({
    filePath: ownerScopedUserDataPath('hook-bindings.json'),
    log: { warn: () => undefined },
  });
}

function relayBindings(connection: BotChannelConnection): HookBindingSnapshot[] {
  if (connection.ownership !== 'server-relay' || !connection.accountKey) return [];
  return hookBindingStore()
    .list()
    .filter((binding) => {
      const source = hookBotRouteSourceFromExternalKey(binding.externalKey);
      return source?.platform === connection.kind && source.accountKey === connection.accountKey;
    });
}

function ambiguousRelayBindings(connection: BotChannelConnection): HookBindingSnapshot[] {
  if (
    connection.ownership !== 'server-relay' ||
    connection.kind !== 'slack' ||
    !connection.accountKey
  ) {
    return [];
  }
  return hookBindingStore()
    .list()
    .filter((binding) => {
      if (hookBotRouteSourceFromExternalKey(binding.externalKey)) return false;
      // Historical Slack lanes such as team-slack:<channel>:<thread> and
      // slack:dm:<user>:gN omit the workspace identity. With multi-workspace
      // bindings they cannot be assigned safely, so migration must fail closed.
      return /^(?:team-slack:|slack:|dm:)/.test(binding.externalKey);
    });
}

async function legacySessionRows(
  db: Db,
  connection: BotChannelConnection,
  bindings: readonly HookBindingSnapshot[],
) {
  if (!connection.accountKey) return [];
  if (connection.ownership === 'server-relay') {
    const ids = [...new Set(bindings.map((row) => row.sessionId))];
    return ids.length === 0
      ? []
      : db
          .select()
          .from(sessions)
          .where(and(inArray(sessions.id, ids), inArray(sessions.status, ['active', 'archived'])));
  }
  if (connection.kind === 'feishu') {
    return db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.source, 'feishu'),
          eq(sessions.feishuBotAppId, connection.accountKey),
          inArray(sessions.status, ['active', 'archived']),
        ),
      );
  }
  return db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.source, connection.kind),
        eq(sessions.imBotContextId, connection.accountKey),
        inArray(sessions.status, ['active', 'archived']),
      ),
    );
}

function migrationRecord(row: MigrationRow, migratedSessionCount: number): BotImMigrationRecord {
  const error = parseObject(row.errorJson);
  const bindingRestoreConflictCount =
    typeof error?.bindingRestoreConflictCount === 'number' ? error.bindingRestoreConflictCount : 0;
  return {
    id: row.id,
    requestId: row.requestId,
    botId: row.botId,
    channelId: row.channelId,
    routeId: row.routeId,
    connectionId: row.connectionId,
    ownership: row.ownership,
    kind: row.kind,
    accountKey: row.accountKey,
    planHash: row.planHash,
    status: row.status,
    migratedSessionCount,
    createdAt: row.createdAt,
    ...(row.appliedAt ? { appliedAt: row.appliedAt } : {}),
    ...(row.rolledBackAt ? { rolledBackAt: row.rolledBackAt } : {}),
    ...(bindingRestoreConflictCount > 0
      ? {
          warnings: [
            {
              code: 'binding-restore-conflict' as const,
              count: bindingRestoreConflictCount,
            },
          ],
        }
      : {}),
  };
}

async function readMigrationRecord(db: Db, row: MigrationRow): Promise<BotImMigrationRecord> {
  const items = await db
    .select({ id: botImMigrationItems.id })
    .from(botImMigrationItems)
    .where(eq(botImMigrationItems.migrationId, row.id));
  return migrationRecord(row, items.length);
}

async function buildPlan(
  db: Db,
  botId: string,
  connection: BotChannelConnection,
): Promise<{ plan: BotImMigrationPlan; bindings: HookBindingSnapshot[] }> {
  const conflicts: BotImMigrationConflict[] = [];
  const warnings: BotImMigrationWarning[] = [];
  const [bot] = await db
    .select({ id: botProfiles.id })
    .from(botProfiles)
    .where(eq(botProfiles.id, botId))
    .limit(1);
  if (!bot) throw new Error('Bot does not exist');
  if (!connection.accountKey) {
    conflicts.push({
      code: 'connection-unavailable',
      message: 'Channel connection has no account identity',
    });
  }
  if (!connection.routable) {
    conflicts.push({
      code: 'connection-not-routable',
      message: 'Channel connection is not routable',
    });
  }
  if (!connection.connected) warnings.push({ code: 'connection-offline' });

  const channels = await db.select().from(botChannels).where(eq(botChannels.kind, connection.kind));
  const matchingChannels = channels.filter((row) => channelMatchesConnection(row, connection));
  for (const row of matchingChannels) {
    if (row.botId !== botId && row.enabled) {
      conflicts.push({
        code: 'channel-owned-by-another-bot',
        message: 'This IM account is already mounted by another Bot',
        botId: row.botId,
      });
    }
  }
  const ownChannel = matchingChannels.find((row) => row.botId === botId);
  const channelId = ownChannel?.id ?? generatedChannelId(botId, connection);
  const bindings = relayBindings(connection);
  const ambiguousBindings = ambiguousRelayBindings(connection);
  if (ambiguousBindings.length > 0) {
    conflicts.push({
      code: 'ambiguous-legacy-binding',
      message: 'Legacy Slack tasks are missing a workspace identity',
    });
  }
  const sessionRows = await legacySessionRows(db, connection, bindings);
  const sessionIds = sessionRows.map((row) => row.id);
  const links = sessionIds.length
    ? await db.select().from(botSessionLinks).where(inArray(botSessionLinks.sessionId, sessionIds))
    : [];
  const linkBySession = new Map(links.map((row) => [row.sessionId, row]));
  const takeoverRows = sessionIds.length
    ? await db.select().from(imBindings).where(inArray(imBindings.targetSessionId, sessionIds))
    : [];
  for (const takeover of takeoverRows) {
    conflicts.push({
      code: 'im-takeover-active',
      message: 'A legacy /ctr takeover still targets this task',
      sessionId: takeover.targetSessionId,
    });
  }
  const candidates: BotImMigrationCandidate[] = sessionRows
    .map((row) => {
      const link = linkBySession.get(row.id);
      if (link && link.botId !== botId) {
        conflicts.push({
          code: 'session-owned-by-another-bot',
          message: 'A legacy IM task is already linked to another Bot',
          sessionId: row.id,
          botId: link.botId,
        });
      } else if (link && link.role !== 'history') {
        conflicts.push({
          code: 'session-role-conflict',
          message: 'A legacy IM task already has a non-history Bot role',
          sessionId: row.id,
        });
      }
      return {
        sessionId: row.id,
        title: row.title,
        status: row.status as 'active' | 'archived',
        source: row.source,
        updatedAt: row.updatedAt,
        alreadyLinked: link?.botId === botId && link.role === 'history',
      };
    })
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  if (candidates.length === 0) warnings.push({ code: 'no-legacy-tasks' });

  const existingRoutes = ownChannel
    ? await db.select().from(botRoutes).where(eq(botRoutes.channelId, ownChannel.id))
    : [];
  const duplicateDefault = existingRoutes.filter((row) => row.routeKey === ROUTE_KEY);
  if (duplicateDefault.length > 1) {
    conflicts.push({
      code: 'route-overlap',
      message: 'The account has overlapping default Bot Routes',
    });
  }
  const hash = planHash({
    botId,
    connection: {
      id: connection.id,
      kind: connection.kind,
      ownership: connection.ownership,
      accountKey: connection.accountKey,
      scopeKey: connection.scopeKey,
      routable: connection.routable,
      features: [...connection.features].sort(),
      featureCapabilities: connection.featureCapabilities ?? [],
    },
    channelId,
    channel: ownChannel
      ? { id: ownChannel.id, enabled: ownChannel.enabled, configJson: ownChannel.configJson }
      : null,
    route: duplicateDefault[0]
      ? {
          id: duplicateDefault[0].id,
          status: duplicateDefault[0].status,
          updatedAt: duplicateDefault[0].updatedAt,
        }
      : null,
    candidates: candidates.map((row) => ({
      sessionId: row.sessionId,
      status: row.status,
      updatedAt: row.updatedAt,
      alreadyLinked: row.alreadyLinked,
    })),
    bindings: bindings.map((row) => ({
      connectionId: row.connectionId,
      externalKey: row.externalKey,
      sessionId: row.sessionId,
      updatedAt: row.updatedAt,
    })),
    ambiguousBindings: ambiguousBindings.map((row) => ({
      connectionId: row.connectionId,
      externalKey: row.externalKey,
      sessionId: row.sessionId,
      updatedAt: row.updatedAt,
    })),
    conflicts,
  });
  return {
    plan: {
      botId,
      connection,
      channelId,
      routeKey: ROUTE_KEY,
      planHash: hash,
      candidates,
      conflicts,
      warnings,
      alreadyMounted: Boolean(ownChannel?.enabled && duplicateDefault.length === 1),
      canApply: conflicts.length === 0,
    },
    bindings,
  };
}

export async function planBotImMigration(input: {
  botId: string;
  connectionId: string;
}): Promise<BotImMigrationPlan> {
  const connection = await authoritativeConnection(input.connectionId);
  if (!connection) {
    throw new Error('Channel connection is no longer available');
  }
  return (await buildPlan(getDbClient().drizzle, input.botId, connection)).plan;
}

export async function listBotImMigrations(botId: string): Promise<BotImMigrationRecord[]> {
  const db = getDbClient().drizzle;
  const rows = await db.select().from(botImMigrations).where(eq(botImMigrations.botId, botId));
  return Promise.all(
    rows.sort((a, b) => b.createdAt - a.createdAt).map((row) => readMigrationRecord(db, row)),
  );
}

async function runConnectionExclusive<T>(
  connection: BotChannelConnection,
  operation: () => Promise<T>,
): Promise<T> {
  if (connection.ownership === 'server-relay') {
    const { runHookBotMigrationExclusive } = await import('../hook-control/ipc.js');
    return runHookBotMigrationExclusive(
      `${connection.kind}:${connection.accountKey ?? connection.id}`,
      operation,
    );
  }
  const { runImMigrationExclusive } = await import('../im/accountBoundary.js');
  return runImMigrationExclusive(connection.kind, operation);
}

async function publishMigratedSessionStatus(
  sessionIds: readonly string[],
  status: 'active' | 'archived',
): Promise<void> {
  if (sessionIds.length === 0) return;
  const [{ getMakerIfReady }, { broadcastSessionPatched }, { notifyAgentIslandSessionPatch }] =
    await Promise.all([
      import('../maker-host/index.js'),
      import('./ipc/sessions.js'),
      import('./agentIslandSessionPatch.js'),
    ]);
  for (const sessionId of [...new Set(sessionIds)]) {
    if (status === 'archived') {
      // Migration is rollback-capable, so preserve the old task worktree and
      // message stores. Only stop the live runtime; a later rollback can
      // reactivate the exact same task without reconstructing user data.
      await getMakerIfReady()
        ?.closeSession(sessionId)
        .catch(() => undefined);
    }
    notifyAgentIslandSessionPatch(sessionId, { status });
    broadcastSessionPatched(sessionId, { status });
  }
}

async function migratedSessionIds(
  db: Db,
  migrationId: string,
  status: 'active' | 'archived',
): Promise<string[]> {
  const items = await db
    .select({
      sessionId: botImMigrationItems.sessionId,
      sessionArchived: botImMigrationItems.sessionArchived,
      originalStatus: botImMigrationItems.originalStatus,
      currentStatus: sessions.status,
    })
    .from(botImMigrationItems)
    .innerJoin(sessions, eq(sessions.id, botImMigrationItems.sessionId))
    .where(eq(botImMigrationItems.migrationId, migrationId));
  return items
    .filter((item) =>
      status === 'archived'
        ? item.sessionArchived && item.currentStatus === 'archived'
        : item.originalStatus === 'active' && item.currentStatus === 'active',
    )
    .map((item) => item.sessionId);
}

export async function applyBotImMigration(
  input: ApplyBotImMigrationInput,
): Promise<BotImMigrationRecord> {
  const db = getDbClient().drizzle;
  const [replay] = await db
    .select()
    .from(botImMigrations)
    .where(eq(botImMigrations.requestId, input.requestId))
    .limit(1);
  if (replay && replay.status !== 'applying') return readMigrationRecord(db, replay);
  if (replay) {
    const replayConnection =
      (await authoritativeConnection(replay.connectionId)) ??
      ({
        id: replay.connectionId,
        kind: replay.kind,
        ownership: replay.ownership,
        status: 'unavailable',
        connected: false,
        accountKey: replay.accountKey,
        accountName: null,
        scopeKey: replay.accountKey,
        routable: true,
        features: [],
      } satisfies BotChannelConnection);
    return runConnectionExclusive(replayConnection, async () => {
      const bindings = parseArray<HookBindingSnapshot>(replay.adapterBindingsJson);
      if (replay.ownership === 'server-relay') hookBindingStore().removeMany(bindings);
      await publishMigratedSessionStatus(
        await migratedSessionIds(db, replay.id, 'archived'),
        'archived',
      );
      await db
        .update(botImMigrations)
        .set({ status: 'applied', appliedAt: Date.now(), errorJson: null })
        .where(and(eq(botImMigrations.id, replay.id), eq(botImMigrations.status, 'applying')));
      const [recovered] = await db
        .select()
        .from(botImMigrations)
        .where(eq(botImMigrations.id, replay.id))
        .limit(1);
      if (!recovered) throw new Error('Migration audit record disappeared');
      return readMigrationRecord(db, recovered);
    });
  }
  const connection = await authoritativeConnection(input.connectionId);
  if (!connection) throw new Error('Channel connection is no longer available');
  return runConnectionExclusive(connection, async () => {
    const [insideReplay] = await db
      .select()
      .from(botImMigrations)
      .where(eq(botImMigrations.requestId, input.requestId))
      .limit(1);
    if (insideReplay) return readMigrationRecord(db, insideReplay);
    const rebuilt = await buildPlan(db, input.botId, connection);
    if (rebuilt.plan.planHash !== input.planHash) {
      throw new Error('Migration plan changed; run the preflight again');
    }
    if (!rebuilt.plan.canApply || !connection.accountKey) {
      throw new Error('Migration preflight has blocking conflicts');
    }
    const accountKey = connection.accountKey;
    const now = Date.now();
    const migrationId = randomUUID();
    const channelId = rebuilt.plan.channelId;
    const routeId = `${channelId}:${ROUTE_KEY}`;
    const capabilities = {
      ownership: connection.ownership,
      connectionId: connection.id,
      features: [...connection.features],
      featureCapabilities: connection.featureCapabilities ?? [],
      // Migration audit rows currently retain a Route FK.  This hidden
      // sentinel records mount ownership only; it is never eligible to own a
      // task. Concrete DM/group/thread Routes are created lazily per lane.
      mountOnly: true,
    };
    await getDbClient().tx('bots.applyImMigration', {
      migrationId,
      requestId: input.requestId,
      botId: input.botId,
      channelId,
      routeId,
      connectionId: connection.id,
      ownership: connection.ownership,
      kind: connection.kind,
      accountKey,
      planHash: rebuilt.plan.planHash,
      channelConfigJson: JSON.stringify(connectionConfig(connection)),
      capabilitiesJson: JSON.stringify(capabilities),
      adapterBindingsJson: JSON.stringify(rebuilt.bindings),
      candidates: rebuilt.plan.candidates.map((candidate) => ({
        sessionId: candidate.sessionId,
        status: candidate.status,
        updatedAt: candidate.updatedAt,
      })),
      now,
      eventId: `${input.botId}:im-migration:${migrationId}`,
    });
    if (connection.ownership === 'server-relay') {
      hookBindingStore().removeMany(rebuilt.bindings);
    }
    await publishMigratedSessionStatus(
      rebuilt.plan.candidates
        .filter((candidate) => candidate.status === 'active')
        .map((candidate) => candidate.sessionId),
      'archived',
    );
    const appliedAt = Date.now();
    await db
      .update(botImMigrations)
      .set({ status: 'applied', appliedAt, errorJson: null })
      .where(and(eq(botImMigrations.id, migrationId), eq(botImMigrations.status, 'applying')));
    const [row] = await db
      .select()
      .from(botImMigrations)
      .where(eq(botImMigrations.id, migrationId))
      .limit(1);
    if (!row) throw new Error('Migration audit record disappeared');
    return readMigrationRecord(db, row);
  });
}

export async function rollbackBotImMigration(migrationId: string): Promise<BotImMigrationRecord> {
  const db = getDbClient().drizzle;
  const [migration] = await db
    .select()
    .from(botImMigrations)
    .where(eq(botImMigrations.id, migrationId))
    .limit(1);
  if (!migration) throw new Error('Migration does not exist');
  if (migration.status === 'rolled-back') return readMigrationRecord(db, migration);
  if (
    migration.status !== 'applied' &&
    migration.status !== 'applying' &&
    migration.status !== 'rolling-back'
  ) {
    throw new Error(`Migration cannot be rolled back from ${migration.status}`);
  }
  const connection =
    (await authoritativeConnection(migration.connectionId)) ??
    ({
      id: migration.connectionId,
      kind: migration.kind,
      ownership: migration.ownership,
      status: 'unavailable',
      connected: false,
      accountKey: migration.accountKey,
      accountName: null,
      scopeKey: migration.accountKey,
      routable: true,
      features: [],
    } satisfies BotChannelConnection);
  return runConnectionExclusive(connection, async () => {
    const [fresh] = await db
      .select()
      .from(botImMigrations)
      .where(eq(botImMigrations.id, migrationId))
      .limit(1);
    if (!fresh) throw new Error('Migration does not exist');
    if (fresh.status === 'rolled-back') return readMigrationRecord(db, fresh);
    const bindings = parseArray<HookBindingSnapshot>(fresh.adapterBindingsJson);
    if (fresh.status !== 'rolling-back') {
      const now = Date.now();
      await getDbClient().tx('bots.beginImMigrationRollback', {
        migrationId,
        now,
        eventId: `${fresh.botId}:im-migration-rollback:${migrationId}`,
      });
    }
    await publishMigratedSessionStatus(await migratedSessionIds(db, fresh.id, 'active'), 'active');
    const restoreResult =
      fresh.ownership === 'server-relay'
        ? hookBindingStore().restoreMany(bindings)
        : { restored: 0, skippedConflicts: 0 };
    await db
      .update(botImMigrations)
      .set({
        status: 'rolled-back',
        rolledBackAt: Date.now(),
        errorJson:
          restoreResult.skippedConflicts > 0
            ? JSON.stringify({ bindingRestoreConflictCount: restoreResult.skippedConflicts })
            : null,
      })
      .where(and(eq(botImMigrations.id, migrationId), eq(botImMigrations.status, 'rolling-back')));
    const [row] = await db
      .select()
      .from(botImMigrations)
      .where(eq(botImMigrations.id, migrationId))
      .limit(1);
    if (!row) throw new Error('Migration audit record disappeared');
    return readMigrationRecord(db, row);
  });
}
