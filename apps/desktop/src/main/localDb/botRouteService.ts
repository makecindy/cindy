import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

import { and, eq, inArray, ne } from 'drizzle-orm';

import type {
  BotRoutePlatform,
  BotRouteRecord,
  BotRouteSource,
  BotRouteStatus,
  ClaimBotRouteInput,
  UpdateBotRouteSessionInput,
  UpsertBotRouteInput,
} from '../../shared/botRoute.js';
import { getDbClient } from './client/current.js';
import type { BotsCreateRouteSessionResult } from './client/tx/types.js';
import {
  botChannels,
  botLifecycleEvents,
  botProfileVersions,
  botProfiles,
  botProjectBindings,
  botRoutes,
  botSessionLinks,
  sessions,
} from './schema.js';
import { ensureDialogueWorkspaceDir } from './dialogueWorkspace.js';
import { sessionCreateToRow } from './mapper.js';
import { resolveBusinessSessionId } from '../sessionIds.js';
import { ensureProjectGitInitialized } from '../git-snapshot/projectGitBootstrap.js';
import { readGitSafetySettings } from '../maker-host/git-safety-settings-store.js';
import { cancelBotDelegationsForParentIfReady } from '../maker-ipc/botDelegationLifecycle.js';
import { coordinateBotCanonicalReplacement } from '../maker-ipc/botCanonicalReplacementCoordinator.js';

type Db = ReturnType<typeof getDbClient>['drizzle'];
type RouteRow = typeof botRoutes.$inferSelect;

const MAX_KEY_LENGTH = 1_000;

function schedulePerTaskWorkspaceReclaim(sessionId: string): void {
  void import('../maker-ipc/botWorkspaceRuntime.js')
    .then((module) => module.schedulePerTaskBotWorkspaceReclaim(sessionId))
    .catch(() => undefined);
}

async function cancelBotDelegationChildren(sessionId: string, reason: string): Promise<void> {
  await cancelBotDelegationsForParentIfReady(sessionId, reason).catch(() => undefined);
}

function normalizeKey(value: string | null | undefined, field: string, required = false): string {
  const normalized = value?.trim() ?? '';
  if (required && !normalized) throw new Error(`${field} is required`);
  if (normalized.length > MAX_KEY_LENGTH) throw new Error(`${field} is too long`);
  return normalized;
}

function parseCapabilities(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function botChannelMatchesSource(
  platform: BotRoutePlatform,
  configJson: string,
  source: BotRouteSource,
): boolean {
  if (platform === 'local') return source.platform === 'local';
  const config = parseCapabilities(configJson);
  const configuredAccount =
    typeof config.accountKey === 'string'
      ? config.accountKey.trim()
      : typeof config.contextId === 'string'
        ? config.contextId.trim()
        : '';
  return configuredAccount.length > 0 && configuredAccount === (source.accountKey?.trim() ?? '');
}

function routeRecord(row: RouteRow, platform: BotRoutePlatform): BotRouteRecord {
  return {
    id: row.id,
    botId: row.botId,
    channelId: row.channelId,
    platform,
    routeKey: row.routeKey,
    principalKey: row.principalKey,
    scopeKey: row.scopeKey,
    threadKey: row.threadKey ?? undefined,
    currentSessionId: row.currentSessionId ?? undefined,
    projectBindingId: row.projectBindingId ?? undefined,
    capabilities: parseCapabilities(row.capabilitiesJson),
    ownerDeviceId: row.ownerDeviceId ?? undefined,
    ownerGeneration: row.ownerGeneration,
    status: row.status,
    lastActivityAt: row.lastActivityAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

type MatchableRoute = {
  scopeKey?: string | null;
  principalKey?: string | null;
  threadKey?: string | null;
};

function routeSpecificity(route: MatchableRoute): number {
  return (route.scopeKey ? 2 : 0) + (route.principalKey ? 4 : 0) + (route.threadKey ? 8 : 0);
}

/**
 * A Route may be a policy template (for example "all messages in this
 * account" or "all threads in this channel"), but only an exact lane Route
 * may own a task.  Keeping those concepts separate prevents unrelated DMs,
 * groups, channels, and topics from sharing one long-running Bot task.
 */
export function botRouteOwnsSourceLane(route: MatchableRoute, source: BotRouteSource): boolean {
  const principalKey = source.principalKey?.trim() ?? '';
  if (!principalKey || !route.principalKey) return false;
  if (route.principalKey !== principalKey) return false;
  const threadKey = source.threadKey?.trim() ?? '';
  if (threadKey) return route.threadKey === threadKey;
  return !route.threadKey;
}

export function botRouteLaneKey(source: BotRouteSource): string {
  const principalKey = normalizeKey(source.principalKey, 'principalKey', true);
  const scopeKey = normalizeKey(source.scopeKey, 'scopeKey');
  const threadKey = normalizeKey(source.threadKey, 'threadKey');
  const digest = createHash('sha256')
    .update(`${source.platform}\0${scopeKey}\0${principalKey}\0${threadKey}`)
    .digest('base64url')
    .slice(0, 32);
  return `lane:${digest}`;
}

export function botRouteMatches(route: MatchableRoute, source: BotRouteSource): boolean {
  if (route.threadKey && route.threadKey !== (source.threadKey ?? '')) return false;
  if (
    route.principalKey &&
    route.principalKey !== (source.principalKey ?? '') &&
    route.principalKey !== (source.parentPrincipalKey ?? '')
  ) {
    return false;
  }
  if (route.scopeKey && route.scopeKey !== (source.scopeKey ?? '')) return false;
  return true;
}

async function requireChannel(db: Db, botId: string, channelId: string) {
  const [channel] = await db
    .select()
    .from(botChannels)
    .where(and(eq(botChannels.id, channelId), eq(botChannels.botId, botId)))
    .limit(1);
  if (!channel) throw new Error('Bot Channel does not exist');
  if (!channel.enabled) throw new Error('Bot Channel is disabled');
  return channel;
}

async function requireProjectBinding(
  db: Db,
  botId: string,
  projectBindingId?: string,
): Promise<void> {
  if (!projectBindingId) return;
  const [binding] = await db
    .select({ id: botProjectBindings.id, status: botProjectBindings.status })
    .from(botProjectBindings)
    .where(and(eq(botProjectBindings.id, projectBindingId), eq(botProjectBindings.botId, botId)))
    .limit(1);
  if (!binding || binding.status !== 'active') {
    throw new Error('Bot Project binding is unavailable');
  }
}

async function requireBotSession(db: Db, botId: string, sessionId?: string): Promise<void> {
  if (!sessionId) return;
  const [owned] = await db
    .select({ sessionId: botSessionLinks.sessionId, sessionStatus: sessions.status })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .where(and(eq(botSessionLinks.botId, botId), eq(botSessionLinks.sessionId, sessionId)))
    .limit(1);
  if (!owned || owned.sessionStatus === 'deleted') {
    throw new Error('Bot task is unavailable');
  }
}

async function readOwnedBotSession(db: Db, botId: string, sessionId: string) {
  const [owned] = await db
    .select({ status: sessions.status, source: sessions.source })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .where(and(eq(botSessionLinks.botId, botId), eq(botSessionLinks.sessionId, sessionId)))
    .limit(1);
  return owned;
}

async function readRoute(
  db: Db,
  routeId: string,
): Promise<{ row: RouteRow; platform: BotRoutePlatform }> {
  const [result] = await db
    .select({
      route: botRoutes,
      platform: botChannels.kind,
      channelConfigJson: botChannels.configJson,
    })
    .from(botRoutes)
    .innerJoin(botChannels, eq(botChannels.id, botRoutes.channelId))
    .where(eq(botRoutes.id, routeId))
    .limit(1);
  if (!result) throw new Error('Bot Route does not exist');
  return { row: result.route, platform: result.platform as BotRoutePlatform };
}

export async function upsertBotRoute(input: UpsertBotRouteInput): Promise<BotRouteRecord> {
  const db = getDbClient().drizzle;
  const botId = normalizeKey(input.botId, 'botId', true);
  const channelId = normalizeKey(input.channelId, 'channelId', true);
  const routeKey = normalizeKey(input.routeKey, 'routeKey', true);
  const principalKey = normalizeKey(input.principalKey, 'principalKey');
  const scopeKey = normalizeKey(input.scopeKey, 'scopeKey');
  const threadKey = normalizeKey(input.threadKey, 'threadKey') || null;
  const channel = await requireChannel(db, botId, channelId);
  await requireProjectBinding(db, botId, input.projectBindingId);
  const [profile] = await db
    .select({ id: botProfiles.id, status: botProfiles.status })
    .from(botProfiles)
    .where(eq(botProfiles.id, botId))
    .limit(1);
  if (!profile || profile.status === 'archived') throw new Error('Bot is unavailable');
  const [existing] = await db
    .select()
    .from(botRoutes)
    .where(and(eq(botRoutes.channelId, channelId), eq(botRoutes.routeKey, routeKey)))
    .limit(1);
  if (existing && input.id && existing.id !== input.id) {
    throw new Error('Route key is already owned by another Bot Route');
  }
  if (existing && existing.botId !== botId) {
    throw new Error('Route key is already owned by another Bot');
  }
  const now = Date.now();
  const id = existing?.id ?? (normalizeKey(input.id, 'routeId') || randomUUID());
  const capabilitiesJson = JSON.stringify(input.capabilities ?? {});
  await db
    .insert(botRoutes)
    .values({
      id,
      botId,
      channelId,
      routeKey,
      principalKey,
      scopeKey,
      threadKey,
      currentSessionId: existing?.currentSessionId ?? null,
      projectBindingId: input.projectBindingId ?? existing?.projectBindingId ?? null,
      capabilitiesJson,
      ownerDeviceId: existing?.ownerDeviceId ?? null,
      ownerGeneration: existing?.ownerGeneration ?? 0,
      status: existing?.status === 'archived' ? 'paused' : (existing?.status ?? 'offline'),
      lastActivityAt: existing?.lastActivityAt ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [botRoutes.channelId, botRoutes.routeKey],
      set: {
        principalKey,
        scopeKey,
        threadKey,
        projectBindingId: input.projectBindingId ?? null,
        capabilitiesJson,
        updatedAt: now,
      },
    });
  // A concurrent first message for the same IM lane may have inserted the
  // channel+route key with another generated id. Read through the unique
  // business key instead of assuming our candidate id won the race.
  const [persisted] = await db
    .select()
    .from(botRoutes)
    .where(and(eq(botRoutes.channelId, channelId), eq(botRoutes.routeKey, routeKey)))
    .limit(1);
  if (!persisted) throw new Error('Bot Route disappeared after upsert');
  return routeRecord(persisted, channel.kind as BotRoutePlatform);
}

export async function resolveBotRoute(source: BotRouteSource): Promise<BotRouteRecord | null> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({
      route: botRoutes,
      platform: botChannels.kind,
      channelConfigJson: botChannels.configJson,
    })
    .from(botRoutes)
    .innerJoin(botChannels, eq(botChannels.id, botRoutes.channelId))
    .innerJoin(botProfiles, eq(botProfiles.id, botRoutes.botId))
    .where(
      and(
        eq(botChannels.kind, source.platform),
        eq(botChannels.enabled, true),
        eq(botProfiles.status, 'active'),
        inArray(botRoutes.status, ['active', 'offline', 'recovering', 'error']),
      ),
    );
  const matches = rows
    .filter(
      ({ route, platform, channelConfigJson }) =>
        botChannelMatchesSource(platform as BotRoutePlatform, channelConfigJson, source) &&
        botRouteMatches(route, source) &&
        parseCapabilities(route.capabilitiesJson).mountOnly !== true &&
        botRouteOwnsSourceLane(route, source),
    )
    .sort(
      (a, b) =>
        routeSpecificity(b.route) - routeSpecificity(a.route) ||
        a.route.createdAt - b.route.createdAt,
    );
  const winner = matches[0];
  return winner ? routeRecord(winner.route, winner.platform as BotRoutePlatform) : null;
}

/**
 * Resolve an exact IM lane Route, creating one from the best matching policy
 * template (or the mounted Channel defaults) on first message.  Channel
 * mounting therefore never creates an account-wide task.
 */
export async function resolveOrCreateBotRoute(
  source: BotRouteSource,
): Promise<BotRouteRecord | null> {
  const existing = await resolveBotRoute(source);
  if (existing) {
    const deliveryKey = source.deliveryKey?.trim() ?? '';
    if (deliveryKey && existing.capabilities.deliveryKey !== deliveryKey) {
      const capabilities = { ...existing.capabilities, deliveryKey };
      await getDbClient()
        .drizzle.update(botRoutes)
        .set({ capabilitiesJson: JSON.stringify(capabilities), updatedAt: Date.now() })
        .where(eq(botRoutes.id, existing.id));
      return { ...existing, capabilities, updatedAt: Date.now() };
    }
    return existing;
  }
  if (source.platform === 'local') return null;
  normalizeKey(source.accountKey, 'accountKey', true);
  normalizeKey(source.principalKey, 'principalKey', true);

  const db = getDbClient().drizzle;
  const channels = await db
    .select({ channel: botChannels, profileStatus: botProfiles.status })
    .from(botChannels)
    .innerJoin(botProfiles, eq(botProfiles.id, botChannels.botId))
    .where(
      and(
        eq(botChannels.kind, source.platform),
        eq(botChannels.enabled, true),
        eq(botProfiles.status, 'active'),
      ),
    );
  const matchingChannels = channels.filter(({ channel }) =>
    botChannelMatchesSource(source.platform, channel.configJson, source),
  );
  if (matchingChannels.length === 0) return null;
  if (matchingChannels.length > 1) {
    throw new Error('Bot Channel account is mounted by more than one Bot');
  }

  const channel = matchingChannels[0]!.channel;
  const templates = (
    await db
      .select()
      .from(botRoutes)
      .where(
        and(
          eq(botRoutes.channelId, channel.id),
          inArray(botRoutes.status, ['active', 'offline', 'recovering', 'error']),
        ),
      )
  )
    .filter((route) => !botRouteOwnsSourceLane(route, source) && botRouteMatches(route, source))
    .sort((a, b) => routeSpecificity(b) - routeSpecificity(a) || a.createdAt - b.createdAt);
  const template = templates[0];
  const channelConfig = parseCapabilities(channel.configJson);
  const templateCapabilities = template
    ? parseCapabilities(template.capabilitiesJson)
    : {
        ownership: channelConfig.ownership,
        connectionId: channelConfig.connectionId,
        features: Array.isArray(channelConfig.features) ? channelConfig.features : [],
      };
  const { mountOnly: _mountOnly, ...capabilities } = templateCapabilities;
  if (source.deliveryKey?.trim()) capabilities.deliveryKey = source.deliveryKey.trim();
  return upsertBotRoute({
    botId: channel.botId,
    channelId: channel.id,
    routeKey: botRouteLaneKey(source),
    principalKey: source.principalKey,
    scopeKey: source.scopeKey,
    threadKey: source.threadKey,
    projectBindingId: template?.projectBindingId ?? undefined,
    capabilities,
  });
}

export async function claimBotRoute(input: ClaimBotRouteInput): Promise<BotRouteRecord> {
  const db = getDbClient().drizzle;
  const routeId = normalizeKey(input.routeId, 'routeId', true);
  const ownerDeviceId = normalizeKey(input.ownerDeviceId, 'ownerDeviceId', true);
  const current = await readRoute(db, routeId);
  if (current.row.status === 'archived') throw new Error('Bot Route is archived');
  if (current.row.status === 'paused') throw new Error('Bot Route is paused');
  if (
    current.row.status === 'active' &&
    current.row.ownerDeviceId &&
    current.row.ownerDeviceId !== ownerDeviceId
  ) {
    throw new Error('Bot Route is owned by another device');
  }
  await requireChannel(db, current.row.botId, current.row.channelId);
  await requireProjectBinding(
    db,
    current.row.botId,
    input.projectBindingId ?? current.row.projectBindingId ?? undefined,
  );
  await requireBotSession(db, current.row.botId, input.currentSessionId);
  const now = Date.now();
  const ownerChanged =
    current.row.ownerDeviceId !== ownerDeviceId || current.row.status !== 'active';
  const nextGeneration = ownerChanged
    ? current.row.ownerGeneration + 1
    : current.row.ownerGeneration;
  const claimedWrite = await db
    .update(botRoutes)
    .set({
      ownerDeviceId,
      ownerGeneration: nextGeneration,
      currentSessionId: input.currentSessionId ?? current.row.currentSessionId,
      projectBindingId: input.projectBindingId ?? current.row.projectBindingId,
      status: 'active',
      lastActivityAt: now,
      updatedAt: now,
    })
    .where(
      and(eq(botRoutes.id, routeId), eq(botRoutes.ownerGeneration, current.row.ownerGeneration)),
    )
    .run();
  if (claimedWrite.changes !== 1) {
    throw new Error('Bot Route ownership changed concurrently');
  }
  const next = await readRoute(db, routeId);
  if (next.row.ownerGeneration !== nextGeneration || next.row.ownerDeviceId !== ownerDeviceId) {
    throw new Error('Bot Route ownership changed concurrently');
  }
  return routeRecord(next.row, next.platform);
}

function botAgentKind(config: Record<string, unknown>): 'cc' | 'codex' | 'pi' {
  return config.harness === 'codex' ? 'codex' : config.harness === 'pi' ? 'pi' : 'cc';
}

function botPermissionMode(config: Record<string, unknown>): 'ask' | 'bypassPermissions' {
  return config.permissions === 'trusted' ? 'bypassPermissions' : 'ask';
}

export async function ensureBotRouteSession(input: {
  routeId: string;
  ownerDeviceId: string;
  forceRenew?: boolean;
}): Promise<{ route: BotRouteRecord; sessionId: string; created: boolean }> {
  const claimed = await claimBotRoute({
    routeId: input.routeId,
    ownerDeviceId: input.ownerDeviceId,
  });
  if (input.forceRenew && claimed.currentSessionId) {
    return coordinateBotCanonicalReplacement(claimed.currentSessionId, async () => {
      const current = await readRoute(getDbClient().drizzle, claimed.id);
      if (
        current.row.currentSessionId !== claimed.currentSessionId ||
        current.row.ownerDeviceId !== input.ownerDeviceId ||
        current.row.ownerGeneration !== claimed.ownerGeneration
      ) {
        throw Object.assign(new Error('Bot Route changed while renewing its task'), {
          code: 'PRECONDITION_FAILED',
        });
      }
      return createOrReuseBotRouteSession(input, claimed);
    });
  }
  return createOrReuseBotRouteSession(input, claimed);
}

async function createOrReuseBotRouteSession(
  input: { routeId: string; ownerDeviceId: string; forceRenew?: boolean },
  claimed: BotRouteRecord,
): Promise<{ route: BotRouteRecord; sessionId: string; created: boolean }> {
  const db = getDbClient().drizzle;
  if (!input.forceRenew && claimed.currentSessionId) {
    const existing = await readOwnedBotSession(db, claimed.botId, claimed.currentSessionId);
    if (existing?.source === 'bot' && existing.status === 'active') {
      return { route: claimed, sessionId: claimed.currentSessionId, created: false };
    }
  }

  const [profile] = await db
    .select()
    .from(botProfiles)
    .where(eq(botProfiles.id, claimed.botId))
    .limit(1);
  if (!profile || profile.status !== 'active') throw new Error('Bot is unavailable');
  const [version] = await db
    .select()
    .from(botProfileVersions)
    .where(
      and(
        eq(botProfileVersions.botId, claimed.botId),
        eq(botProfileVersions.version, profile.currentVersion),
      ),
    )
    .limit(1);
  if (!version) throw new Error('Bot Profile version is unavailable');
  const projectBindingId = claimed.projectBindingId;
  const [binding] = projectBindingId
    ? await db
        .select()
        .from(botProjectBindings)
        .where(
          and(
            eq(botProjectBindings.id, projectBindingId),
            eq(botProjectBindings.botId, claimed.botId),
            eq(botProjectBindings.status, 'active'),
          ),
        )
        .limit(1)
    : [];
  if (projectBindingId && !binding) throw new Error('Bot Route project binding is unavailable');

  const now = Date.now();
  const sessionId = resolveBusinessSessionId(undefined);
  const workspaceKind = binding ? 'project' : 'dialogue';
  const workingDir = binding?.workingDir ?? ensureDialogueWorkspaceDir(sessionId, now);
  const config = parseCapabilities(version.capabilitiesJson);
  try {
    await ensureProjectGitInitialized({
      workingDir,
      workspaceKind,
      remoteHostId: binding?.remoteHostId ?? null,
      sessionId,
      autoSnapshotEnabled: readGitSafetySettings().autoSnapshotEnabled,
      source: 'bot-route-session',
    });
  } catch (error) {
    if (!binding) await fs.rm(workingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  let created = false;
  let resolvedSessionId = sessionId;
  // A DB archive without closing the in-memory Maker runtime leaves the old
  // Route task alive. It can keep emitting after `/new` and compete with the
  // replacement canonical task, so remember only a verified Bot-owned row.
  let archivedRuntimeSessionId: string | null = null;
  try {
    const sessionRow = {
      ...sessionCreateToRow(
          sessionId,
          {
            workspaceKind,
            workingDir,
            model:
              typeof config.model === 'string' && config.model.trim()
                ? config.model.trim()
                : 'claude-sonnet-4-6',
            providerId:
              typeof config.providerId === 'string' && config.providerId.trim()
                ? config.providerId.trim()
                : config.providerId === null
                  ? null
                  : undefined,
            effort:
              typeof config.effort === 'string' && config.effort.trim()
                ? config.effort.trim()
                : undefined,
            fastMode: config.fastMode === true,
            agentKind: botAgentKind(config),
            permissionMode: botPermissionMode(config),
            remoteHostId: binding?.remoteHostId ?? undefined,
            source: 'bot',
          },
          now,
        ),
      title: `${profile.displayName} · ${claimed.routeKey}`.slice(0, 120),
    };
    const result = await getDbClient().tx<BotsCreateRouteSessionResult>('bots.createRouteSession', {
      routeId: claimed.id,
      botId: claimed.botId,
      channelId: claimed.channelId,
      routeKey: claimed.routeKey,
      ownerDeviceId: input.ownerDeviceId,
      ownerGeneration: claimed.ownerGeneration,
      expectedCurrentSessionId: claimed.currentSessionId ?? null,
      profileVersion: profile.currentVersion,
      forceRenew: input.forceRenew === true,
      session: {
        id: sessionRow.id,
        title: sessionRow.title,
        workingDir: sessionRow.workingDir ?? null,
        workspaceKind: sessionRow.workspaceKind,
        model: sessionRow.model,
        effort: sessionRow.effort,
        fastMode: sessionRow.fastMode,
        permissionMode: sessionRow.permissionMode,
        agentKind: sessionRow.agentKind,
        remoteHostId: sessionRow.remoteHostId ?? null,
        providerId: sessionRow.providerId ?? null,
        extraDirs: sessionRow.extraDirs,
        source: sessionRow.source,
        createdAt: sessionRow.createdAt,
        updatedAt: sessionRow.updatedAt,
      },
      now,
    });
    created = result.created;
    resolvedSessionId = result.sessionId;
    archivedRuntimeSessionId = result.archivedRuntimeSessionId;
  } finally {
    if (!created && !binding) {
      const [persisted] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!persisted) {
        await fs.rm(workingDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
  if (archivedRuntimeSessionId) {
    await cancelBotDelegationChildren(
      archivedRuntimeSessionId,
      'Parent Bot route task was replaced by Renew.',
    );
    const { getMakerIfReady } = await import('../maker-host/index.js');
    await getMakerIfReady()
      ?.closeSession(archivedRuntimeSessionId)
      .catch(() => undefined);
    schedulePerTaskWorkspaceReclaim(archivedRuntimeSessionId);
  }
  const route = await readRoute(db, claimed.id);
  return {
    route: routeRecord(route.row, route.platform),
    sessionId: resolvedSessionId,
    created,
  };
}

export async function updateBotRouteSession(
  input: UpdateBotRouteSessionInput,
): Promise<BotRouteRecord> {
  const db = getDbClient().drizzle;
  const current = await readRoute(db, normalizeKey(input.routeId, 'routeId', true));
  if (
    current.row.status !== 'active' ||
    current.row.ownerDeviceId !== normalizeKey(input.ownerDeviceId, 'ownerDeviceId', true) ||
    current.row.ownerGeneration !== input.ownerGeneration
  ) {
    throw new Error('Bot Route ownership is stale');
  }
  await requireBotSession(db, current.row.botId, input.currentSessionId);
  const now = Date.now();
  const updated = await db
    .update(botRoutes)
    .set({ currentSessionId: input.currentSessionId, lastActivityAt: now, updatedAt: now })
    .where(
      and(
        eq(botRoutes.id, current.row.id),
        eq(botRoutes.ownerGeneration, input.ownerGeneration),
        eq(botRoutes.ownerDeviceId, input.ownerDeviceId),
      ),
    )
    .run();
  if (updated.changes !== 1) {
    throw new Error('Bot Route ownership changed concurrently');
  }
  const next = await readRoute(db, current.row.id);
  if (next.row.currentSessionId !== input.currentSessionId) {
    throw new Error('Bot Route ownership changed concurrently');
  }
  return routeRecord(next.row, next.platform);
}

export async function setBotRouteStatus(
  routeId: string,
  status: Extract<BotRouteStatus, 'paused' | 'offline' | 'recovering' | 'error' | 'archived'>,
): Promise<BotRouteRecord> {
  const db = getDbClient().drizzle;
  const current = await readRoute(db, normalizeKey(routeId, 'routeId', true));
  const now = Date.now();
  const archivedSessionId = status === 'archived' ? current.row.currentSessionId : null;
  await getDbClient().tx('bots.setRouteStatus', {
    routeId: current.row.id,
    botId: current.row.botId,
    expectedOwnerGeneration: current.row.ownerGeneration,
    currentOwnerDeviceId: current.row.ownerDeviceId ?? null,
    currentSessionId: current.row.currentSessionId ?? null,
    status,
    now,
  });
  if (archivedSessionId) {
    await cancelBotDelegationChildren(
      archivedSessionId,
      'Parent Bot route was archived.',
    );
    const { getMakerIfReady } = await import('../maker-host/index.js');
    await getMakerIfReady()
      ?.closeSession(archivedSessionId)
      .catch(() => undefined);
    schedulePerTaskWorkspaceReclaim(archivedSessionId);
  }
  const next = await readRoute(db, current.row.id);
  if (next.row.ownerGeneration !== current.row.ownerGeneration + 1) {
    throw new Error('Bot Route ownership changed concurrently');
  }
  return routeRecord(next.row, next.platform);
}
