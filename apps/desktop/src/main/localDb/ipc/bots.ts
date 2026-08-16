/** Cindy Bots 的 main-side 权威数据边界。
 *
 * Bot profile / channel / Session 归属只在这里写入 SQLite；renderer 的
 * localStorage 只能作为旧版本迁移的临时来源，不能决定 canonical Session。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { OpenDialogOptions } from 'electron';
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';

import { getDbClient, tryGetDbClient } from '../client/current';
import type { BotsReplaceCanonicalSessionResult } from '../client/tx/types.js';
import {
  botChannels,
  botAutomationLinks,
  botAutomationRuns,
  botDelegations,
  botDeliveryOutbox,
  botLifecycleEvents,
  botProfileVersions,
  botProfiles,
  botProjectBindings,
  botRoutes,
  botRuntimeSnapshots,
  botSessionLinks,
  botWorkspaceAttachments,
  botWorkspaceLeases,
  sessions,
} from '../schema';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer.js';
import { isDeviceLinkInvoke } from '../../device-link/invoke-context.js';
import { requireString, throwIpcError } from '../../utils/ipcValidate.js';
import { resolveBusinessSessionId } from '../../sessionIds.js';
import { ensureProjectGitInitialized } from '../../git-snapshot/projectGitBootstrap.js';
import { readGitSafetySettings } from '../../maker-host/git-safety-settings-store.js';
import { ensureDialogueWorkspaceDir } from '../dialogueWorkspace.js';
import { sessionCreateToRow, sessionToCamel } from '../mapper.js';
import { botProfileContentChanged, mergeBotProfileCapabilities } from './botProfileVersioning.js';
import { buildDefaultBotIdentity } from '../../../shared/botProfileDefaults.js';
import { normalizeBotSessionControlMode } from '../../../shared/botSessionControl.js';
import { BOT_WORKSPACE_POLICIES, type BotWorkspacePolicy } from '../../../shared/botWorkspace.js';
import { projectIdentityKey } from '../../../shared/projectKeys.js';
import { normalizeWorkingDirForStorage } from '../../../shared/workingDir.js';
import { BOT_ROUTE_STATUSES, type BotRouteStatus } from '../../../shared/botRoute.js';
import { normalizeBotEventSubscriptionRule } from '../../../shared/botSessionEvents.js';
import {
  botChannelMountIdentity,
  sameBotChannelMountIdentity,
} from '../../../shared/botChannelRegistry.js';
import { setBotRouteStatus, upsertBotRoute } from '../botRouteService.js';
import {
  applyBotImMigration,
  listBotImMigrations,
  planBotImMigration,
  rollbackBotImMigration,
} from '../botImMigrationService.js';
import { cancelBotDelegationsForParentIfReady } from '../../maker-ipc/botDelegationLifecycle.js';
import { coordinateBotCanonicalReplacement } from '../../maker-ipc/botCanonicalReplacementCoordinator.js';
import { searchConversations } from '../conversationSearch.js';
import type {
  BotHealthIssue,
  BotHealthReport,
  BotLifecycleEventView,
} from '../../../shared/botLifecycle.js';
import { CINDY_BOT_BUNDLE_EXTENSION } from '../../../shared/botPortability.js';
import {
  exportBotBehaviorBundle,
  importBotBehaviorBundle,
} from '../botPortabilityService.js';

type ChannelKind =
  'local' | 'telegram' | 'feishu' | 'slack' | 'discord' | 'wechat' | 'dingtalk' | 'wecom' | 'x';
type BotRole = 'canonical' | 'route' | 'history';

const CHANNELS = new Set<ChannelKind>([
  'local',
  'telegram',
  'feishu',
  'slack',
  'discord',
  'wechat',
  'dingtalk',
  'wecom',
  'x',
]);
const ROLES = new Set<BotRole>(['canonical', 'route', 'history']);
const WORKSPACE_POLICIES = new Set<BotWorkspacePolicy>(BOT_WORKSPACE_POLICIES);
const MAX_TEXT = 4000;

export interface CreateBotCanonicalSessionInput {
  botId: string;
  expectedCanonicalSessionId: string | null;
  expectedProfileVersion: number;
  /** Repair a dangling profile pointer only; never renew a task that still exists. */
  recoverMissingOnly?: boolean;
}

type CreateBotCanonicalSessionResult = {
  created: boolean;
  canonicalSessionId: string;
  session: ReturnType<typeof sessionToCamel>;
};

let createBotCanonicalSessionImpl:
  | ((input: CreateBotCanonicalSessionInput) => Promise<CreateBotCanonicalSessionResult>)
  | null = null;

/** Main-side canonical creator shared by Renew, restore and repair. */
export async function createBotCanonicalSession(
  input: CreateBotCanonicalSessionInput,
): Promise<CreateBotCanonicalSessionResult> {
  if (!createBotCanonicalSessionImpl) {
    throwIpcError('PRECONDITION_FAILED', 'Bot 数据服务尚未初始化');
  }
  return createBotCanonicalSessionImpl(input);
}

async function cancelBotDelegationChildren(sessionId: string, reason: string): Promise<void> {
  await cancelBotDelegationsForParentIfReady(sessionId, reason).catch(() => undefined);
}

function botSessionAgentKind(config: Record<string, unknown>): 'cc' | 'codex' | 'pi' {
  return config.harness === 'codex' ? 'codex' : config.harness === 'pi' ? 'pi' : 'cc';
}

function botSessionPermissionMode(config: Record<string, unknown>): 'ask' | 'bypassPermissions' {
  return config.permissions === 'trusted' ? 'bypassPermissions' : 'ask';
}

function readText(value: unknown, field: string, max = MAX_TEXT, required = false): string {
  if (typeof value !== 'string') {
    if (!required && (value === undefined || value === null)) return '';
    throwIpcError('INVALID_PARAMS', `${field} 必须是字符串`);
  }
  const text = value.trim();
  if (required && !text) throwIpcError('INVALID_PARAMS', `${field} 不能为空`);
  if (text.length > max) throwIpcError('INVALID_PARAMS', `${field} 超过长度上限 ${max}`);
  return text;
}

function parseJson(value: string, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : fallback;
  } catch {
    return fallback;
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function readStringList(value: unknown, field: string, maxItems = 100): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throwIpcError('INVALID_PARAMS', `${field} 必须是字符串数组`);
  const out = value.map((item) => readText(item, field, 4000, true));
  if (out.length > maxItems) throwIpcError('INVALID_PARAMS', `${field} 超过数量上限 ${maxItems}`);
  return [...new Set(out)];
}

async function readProfile(db: ReturnType<typeof getDbClient>['drizzle'], botId: string) {
  const [profile] = await db.select().from(botProfiles).where(eq(botProfiles.id, botId)).limit(1);
  if (!profile) throwIpcError('NOT_FOUND', 'Bot 不存在');
  const channels = await db.select().from(botChannels).where(eq(botChannels.botId, botId));
  const links = await db
    .select()
    .from(botSessionLinks)
    .where(eq(botSessionLinks.botId, botId))
    .orderBy(desc(botSessionLinks.createdAt));
  const sessionRows = links.length
    ? await db
        .select()
        .from(sessions)
        .where(
          inArray(
            sessions.id,
            links.map((link) => link.sessionId),
          ),
        )
    : [];
  const byId = new Map(sessionRows.map((row) => [row.id, row]));
  const runtimeRows = links.length
    ? await db
        .select()
        .from(botRuntimeSnapshots)
        .where(
          inArray(
            botRuntimeSnapshots.sessionId,
            links.map((link) => link.sessionId),
          ),
        )
        .orderBy(desc(botRuntimeSnapshots.preparedAt), desc(botRuntimeSnapshots.appliedAt))
    : [];
  const runtimeBySession = new Map<string, (typeof runtimeRows)[number]>();
  for (const row of runtimeRows) {
    if (!runtimeBySession.has(row.sessionId)) runtimeBySession.set(row.sessionId, row);
  }
  const [version] = await db
    .select()
    .from(botProfileVersions)
    .where(
      and(
        eq(botProfileVersions.botId, botId),
        eq(botProfileVersions.version, profile.currentVersion),
      ),
    )
    .limit(1);
  const projectRows = await db
    .select()
    .from(botProjectBindings)
    .where(eq(botProjectBindings.botId, botId))
    .orderBy(desc(botProjectBindings.updatedAt));
  const leaseRows = await db
    .select()
    .from(botWorkspaceLeases)
    .where(eq(botWorkspaceLeases.botId, botId))
    .orderBy(desc(botWorkspaceLeases.updatedAt));
  const routeRows = await db
    .select()
    .from(botRoutes)
    .where(eq(botRoutes.botId, botId))
    .orderBy(desc(botRoutes.updatedAt));
  const config = parseJson(version?.capabilitiesJson ?? '{}');
  return {
    id: profile.id,
    name: profile.displayName,
    description: profile.description,
    identitySource: version?.identitySource ?? '',
    userContextSource: typeof config.userContextSource === 'string' ? config.userContextSource : '',
    avatar: profile.avatar,
    avatarColor: profile.avatarColor,
    enabled: profile.status === 'active',
    status: profile.status,
    currentVersion: profile.currentVersion,
    canonicalSessionId: profile.canonicalSessionId ?? undefined,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    skills: Array.isArray(config.skills)
      ? config.skills.filter((item): item is string => typeof item === 'string')
      : [],
    capabilities: {
      model: typeof config.model === 'string' ? config.model : 'claude-sonnet-4-6',
      providerId:
        typeof config.providerId === 'string'
          ? config.providerId
          : config.providerId === null
            ? null
            : undefined,
      effort: typeof config.effort === 'string' ? config.effort : '',
      fastMode: config.fastMode === true,
      harness: config.harness === 'codex' || config.harness === 'pi' ? config.harness : 'claude',
      skillMode:
        config.skillMode === 'allowlist'
          ? 'allowlist'
          : config.skillMode === 'inherit'
            ? 'inherit'
            : Array.isArray(config.skills) && config.skills.length > 0
              ? 'allowlist'
              : 'inherit',
      toolsetMode:
        config.toolsetMode === 'allowlist'
          ? 'allowlist'
          : config.toolsetMode === 'inherit'
            ? 'inherit'
            : Array.isArray(config.toolsets) && config.toolsets.length > 0
              ? 'allowlist'
              : 'inherit',
      toolsets: Array.isArray(config.toolsets)
        ? config.toolsets.filter((item): item is string => typeof item === 'string')
        : [],
      mcpMode:
        config.mcpMode === 'allowlist'
          ? 'allowlist'
          : config.mcpMode === 'inherit'
            ? 'inherit'
            : Array.isArray(config.mcpServers) && config.mcpServers.length > 0
              ? 'allowlist'
              : 'inherit',
      mcpServers: Array.isArray(config.mcpServers)
        ? config.mcpServers.filter((item): item is string => typeof item === 'string')
        : [],
      memory: config.memory !== false,
      automation: config.automation === true,
      permissions: config.permissions === 'trusted' ? 'trusted' : 'ask',
      sessionControlMode: normalizeBotSessionControlMode(config.sessionControlMode),
    },
    channels: channels.map((channel) => ({
      id: channel.id,
      kind: channel.kind as ChannelKind,
      enabled: !!channel.enabled,
      config: parseJson(channel.configJson),
    })),
    projectBindings: projectRows.map((binding) => ({
      id: binding.id,
      projectKey: binding.projectKey,
      workingDir: binding.workingDir,
      remoteHostId: binding.remoteHostId ?? undefined,
      defaultBranch: binding.defaultBranch ?? undefined,
      workspacePolicy: binding.workspacePolicy,
      isDefault: binding.isDefault,
      allowedPaths: readStringListFromJson(binding.allowedPathsJson),
      status: binding.status,
      createdAt: binding.createdAt,
      updatedAt: binding.updatedAt,
    })),
    workspaceLeases: leaseRows.map((lease) => ({
      id: lease.id,
      projectBindingId: lease.projectBindingId,
      leaseKey: lease.leaseKey,
      anchorSessionId: lease.anchorSessionId ?? undefined,
      worktreePath: lease.worktreePath ?? undefined,
      baseRepo: lease.baseRepo,
      branch: lease.branch ?? undefined,
      sourceBranch: lease.sourceBranch ?? undefined,
      remoteHostId: lease.remoteHostId ?? undefined,
      generation: lease.generation,
      status: lease.status,
      lastHeartbeatAt: lease.lastHeartbeatAt ?? undefined,
      createdAt: lease.createdAt,
      updatedAt: lease.updatedAt,
      releasedAt: lease.releasedAt ?? undefined,
    })),
    routes: routeRows
      .filter((route) => parseJson(route.capabilitiesJson).mountOnly !== true)
      .map((route) => ({
        id: route.id,
        channelId: route.channelId,
        routeKey: route.routeKey,
        principalKey: route.principalKey,
        scopeKey: route.scopeKey,
        threadKey: route.threadKey ?? undefined,
        currentSessionId: route.currentSessionId ?? undefined,
        projectBindingId: route.projectBindingId ?? undefined,
        capabilities: parseJson(route.capabilitiesJson),
        ownerDeviceId: route.ownerDeviceId ?? undefined,
        ownerGeneration: route.ownerGeneration,
        status: route.status,
        lastActivityAt: route.lastActivityAt ?? undefined,
        createdAt: route.createdAt,
        updatedAt: route.updatedAt,
      })),
    channel: (channels.find((channel) => channel.kind === 'local')?.kind ??
      channels[0]?.kind ??
      'local') as ChannelKind,
    sessions: links.flatMap((link) => {
      const row = byId.get(link.sessionId);
      if (!row) return [];
      return [
        {
          id: row.id,
          title: row.title,
          kind: link.role === 'canonical' ? 'chat' : link.role === 'route' ? 'route' : 'history',
          channel: (channels.find((channel) => channel.id === link.channelId)?.kind ??
            'local') as ChannelKind,
          updatedAt: row.updatedAt,
          status: row.status,
          role: link.role,
          profileVersion: link.profileVersion,
          routeKey: link.routeKey ?? undefined,
          runtimeSnapshot: runtimeBySession.has(row.id)
            ? (() => {
                const runtime = runtimeBySession.get(row.id)!;
                return {
                  profileVersion: runtime.profileVersion,
                  agentKind: runtime.agentKind,
                  status: runtime.status,
                  preparedAt: runtime.preparedAt || runtime.appliedAt || 0,
                  appliedAt: runtime.appliedAt ?? undefined,
                  failedAt: runtime.failedAt ?? undefined,
                  failure: runtime.failureJson ? parseJson(runtime.failureJson) : undefined,
                  configured: parseJson(runtime.configuredJson),
                  resolved: parseJson(runtime.resolvedJson),
                };
              })()
            : undefined,
        },
      ];
    }),
  };
}

/**
 * Device-link only needs enough Bot metadata to render the Mobile directory and
 * open the canonical task. Keep this projection main-side so profile prompts,
 * channel credentials, project paths and runtime state never cross the wire.
 */
async function readRemoteBotProfile(
  db: ReturnType<typeof getDbClient>['drizzle'],
  botId: string,
) {
  const [profile] = await db
    .select({
      id: botProfiles.id,
      name: botProfiles.displayName,
      description: botProfiles.description,
      avatar: botProfiles.avatar,
      avatarColor: botProfiles.avatarColor,
      status: botProfiles.status,
      currentVersion: botProfiles.currentVersion,
      canonicalSessionId: botProfiles.canonicalSessionId,
    })
    .from(botProfiles)
    .where(eq(botProfiles.id, botId))
    .limit(1);
  if (!profile) throwIpcError('NOT_FOUND', 'Bot 不存在');
  const channels = await db
    .select({ kind: botChannels.kind, enabled: botChannels.enabled })
    .from(botChannels)
    .where(eq(botChannels.botId, botId));
  return {
    ...profile,
    canonicalSessionId: profile.canonicalSessionId ?? undefined,
    channels: channels.map((channel) => ({
      kind: channel.kind,
      enabled: !!channel.enabled,
    })),
  };
}

function readStringListFromJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function normalizeAllowedPaths(
  value: unknown,
  workingDir: string,
  remoteHostId: string | null,
): string[] {
  const paths = readStringList(value, 'allowedPaths');
  const pathApi = remoteHostId ? path.posix : path;
  const root = pathApi.resolve(workingDir);
  return paths.map((item) => {
    const candidate = pathApi.resolve(item);
    const relative = pathApi.relative(root, candidate);
    if (
      relative === '..'
      || relative.startsWith(`..${pathApi.sep}`)
      || pathApi.isAbsolute(relative)
    ) {
      throwIpcError('INVALID_PARAMS', 'allowedPaths 必须位于绑定项目目录内');
    }
    return remoteHostId ? candidate : normalizeWorkingDirForStorage(candidate) ?? candidate;
  });
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

export function registerBotIpc(): void {
  ipcMain.handle('local-db:bots:list', async (event) => {
    const remote = isDeviceLinkInvoke();
    if (!remote) assertTrustedAppRendererEvent(event);
    const client = tryGetDbClient();
    if (!client) return [];
    const db = client.drizzle;
    const profiles = await db
      .select({ id: botProfiles.id })
      .from(botProfiles)
      .orderBy(desc(botProfiles.updatedAt));
    return Promise.all(
      profiles.map(({ id }) => remote ? readRemoteBotProfile(db, id) : readProfile(db, id)),
    );
  });

  ipcMain.handle('local-db:bots:get', async (event, rawId: unknown) => {
    const remote = isDeviceLinkInvoke();
    if (!remote) assertTrustedAppRendererEvent(event);
    const db = getDbClient().drizzle;
    const botId = requireString(rawId, 'botId');
    return remote ? readRemoteBotProfile(db, botId) : readProfile(db, botId);
  });

  ipcMain.handle('local-db:bots:export', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
    const botId = readText(body.botId, 'botId', 128, true);
    const db = getDbClient().drizzle;
    const [profile] = await db
      .select({ displayName: botProfiles.displayName })
      .from(botProfiles)
      .where(eq(botProfiles.id, botId))
      .limit(1);
    if (!profile) throwIpcError('NOT_FOUND', 'Bot 不存在');
    const safeName = profile.displayName
      .normalize('NFKC')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
      .replace(/\s+/g, '-')
      .slice(0, 80) || 'cindy-bot';
    const owner = BrowserWindow.fromWebContents(event.sender);
    const picked = owner
      ? await dialog.showSaveDialog(owner, {
          title: '导出 Bot 配置',
          defaultPath: `${safeName}${CINDY_BOT_BUNDLE_EXTENSION}`,
          filters: [{ name: 'Cindy Bot', extensions: ['cindybot'] }],
        })
      : await dialog.showSaveDialog({
          title: '导出 Bot 配置',
          defaultPath: `${safeName}${CINDY_BOT_BUNDLE_EXTENSION}`,
          filters: [{ name: 'Cindy Bot', extensions: ['cindybot'] }],
        });
    if (picked.canceled || !picked.filePath) return { canceled: true };
    const outputPath = picked.filePath.endsWith(CINDY_BOT_BUNDLE_EXTENSION)
      ? picked.filePath
      : `${picked.filePath}${CINDY_BOT_BUNDLE_EXTENSION}`;
    return { canceled: false, ...(await exportBotBehaviorBundle(botId, outputPath)) };
  });

  ipcMain.handle('local-db:bots:import', async (event) => {
    assertTrustedAppRendererEvent(event);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: '导入 Bot 配置',
      properties: ['openFile'],
      filters: [{ name: 'Cindy Bot', extensions: ['cindybot'] }],
    };
    const picked = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
    return importBotBehaviorBundle(picked.filePaths[0]);
  });

  ipcMain.handle('local-db:bots:health', async (event, rawBotId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botId = readText(rawBotId, 'botId', 128, true);
    const db = getDbClient().drizzle;
    const [profile] = await db.select().from(botProfiles).where(eq(botProfiles.id, botId)).limit(1);
    if (!profile) throwIpcError('NOT_FOUND', 'Bot 不存在');
    const canonicalSessionId = profile.canonicalSessionId ?? null;
    const [canonicalSession, canonicalLink, runtimeSnapshots, routes, automations, deliveries, leases] =
      await Promise.all([
        canonicalSessionId
          ? db.select().from(sessions).where(eq(sessions.id, canonicalSessionId)).limit(1)
          : Promise.resolve([]),
        canonicalSessionId
          ? db
              .select()
              .from(botSessionLinks)
              .where(eq(botSessionLinks.sessionId, canonicalSessionId))
              .limit(1)
          : Promise.resolve([]),
        canonicalSessionId
          ? db
              .select()
              .from(botRuntimeSnapshots)
              .where(eq(botRuntimeSnapshots.sessionId, canonicalSessionId))
              .orderBy(desc(botRuntimeSnapshots.preparedAt))
              .limit(1)
          : Promise.resolve([]),
        db.select({ status: botRoutes.status }).from(botRoutes).where(eq(botRoutes.botId, botId)),
        db
          .select({ status: botAutomationLinks.status })
          .from(botAutomationLinks)
          .where(eq(botAutomationLinks.botId, botId)),
        db
          .select({ status: botDeliveryOutbox.status })
          .from(botDeliveryOutbox)
          .where(eq(botDeliveryOutbox.botId, botId)),
        db
          .select({ status: botWorkspaceLeases.status })
          .from(botWorkspaceLeases)
          .where(eq(botWorkspaceLeases.botId, botId)),
      ]);

    const sessionRow = canonicalSession[0];
    const linkRow = canonicalLink[0];
    const runtime = runtimeSnapshots[0];
    const activeRoutes = routes.filter((row) => row.status !== 'archived');
    const activeAutomations = automations.filter((row) => row.status !== 'archived');
    const activeLeases = leases.filter((row) => row.status !== 'released');
    const recoveringRoutes = activeRoutes.filter((row) => row.status === 'recovering').length;
    const errorRoutes = activeRoutes.filter((row) => row.status === 'error').length;
    const errorAutomations = activeAutomations.filter((row) => row.status === 'error').length;
    const failedDeliveries = deliveries.filter((row) => row.status === 'failed').length;
    const deadLetterDeliveries = deliveries.filter((row) => row.status === 'dead-letter').length;
    const errorWorkspaceLeases = activeLeases.filter((row) => row.status === 'error').length;
    const issues: BotHealthIssue[] = [];

    if (profile.status === 'error') issues.push({ code: 'profile-error' });
    if (profile.status === 'deleting') issues.push({ code: 'lifecycle-incomplete' });
    if (profile.status === 'active' && !canonicalSessionId) issues.push({ code: 'missing-canonical' });
    if (canonicalSessionId && !sessionRow) issues.push({ code: 'canonical-session-missing' });
    if (sessionRow?.status === 'deleted') issues.push({ code: 'canonical-session-deleted' });
    if (canonicalSessionId && !linkRow) issues.push({ code: 'canonical-link-missing' });
    if (
      linkRow &&
      (linkRow.botId !== botId || linkRow.role !== 'canonical')
    ) {
      issues.push({ code: 'canonical-link-mismatch' });
    }
    if (linkRow && linkRow.profileVersion < profile.currentVersion) {
      issues.push({ code: 'profile-update-pending' });
    }
    if (runtime?.status === 'degraded') issues.push({ code: 'runtime-degraded' });
    if (runtime?.status === 'failed') issues.push({ code: 'runtime-failed' });
    if (recoveringRoutes > 0) issues.push({ code: 'routes-recovering', count: recoveringRoutes });
    if (errorRoutes > 0) issues.push({ code: 'routes-error', count: errorRoutes });
    if (errorAutomations > 0) issues.push({ code: 'automation-error', count: errorAutomations });
    if (failedDeliveries > 0) issues.push({ code: 'delivery-failed', count: failedDeliveries });
    if (deadLetterDeliveries > 0) {
      issues.push({ code: 'delivery-dead-letter', count: deadLetterDeliveries });
    }
    if (errorWorkspaceLeases > 0) {
      issues.push({ code: 'workspace-error', count: errorWorkspaceLeases });
    }

    const recoveringCodes = new Set([
      'missing-canonical',
      'canonical-session-missing',
      'canonical-session-deleted',
      'routes-recovering',
    ]);
    const status: BotHealthReport['status'] =
      profile.status === 'paused' || profile.status === 'archived'
        ? 'paused'
        : issues.some((issue) => recoveringCodes.has(issue.code))
          ? 'recovering'
          : issues.length > 0
            ? 'attention'
            : 'healthy';
    const report: BotHealthReport = {
      botId,
      status,
      checkedAt: Date.now(),
      canonical: {
        sessionId: canonicalSessionId,
        sessionStatus: canonicalSessionId
          ? sessionRow?.status ?? 'missing'
          : null,
        linked: !!linkRow && linkRow.botId === botId && linkRow.role === 'canonical',
        profileVersion: linkRow?.profileVersion ?? null,
        runtimeStatus: runtime?.status ?? 'not-started',
      },
      counts: {
        routes: activeRoutes.length,
        recoveringRoutes,
        errorRoutes,
        automations: activeAutomations.length,
        errorAutomations,
        deliveries: deliveries.length,
        failedDeliveries,
        deadLetterDeliveries,
        workspaceLeases: activeLeases.length,
        errorWorkspaceLeases,
      },
      issues,
    };
    return report;
  });

  ipcMain.handle('local-db:bots:lifecycle-events', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
    const botId = readText(body.botId, 'botId', 128, true);
    const limit = typeof body.limit === 'number' && Number.isFinite(body.limit)
      ? Math.max(1, Math.min(200, Math.floor(body.limit)))
      : 50;
    const rows = await getDbClient().drizzle
      .select()
      .from(botLifecycleEvents)
      .where(eq(botLifecycleEvents.botId, botId))
      .orderBy(desc(botLifecycleEvents.createdAt))
      .limit(limit);
    return rows.map((row): BotLifecycleEventView => ({
      id: row.id,
      botId: row.botId,
      sessionId: row.sessionId ?? null,
      eventType: row.eventType,
      payload: parseJson(row.payloadJson),
      createdAt: row.createdAt,
    }));
  });

  ipcMain.handle('local-db:bots:search-history', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
    const botId = readText(body.botId, 'botId', 128, true);
    const query = readText(body.query, 'query', 500, true);
    const limit = typeof body.limit === 'number' && Number.isFinite(body.limit)
      ? Math.max(1, Math.min(50, Math.floor(body.limit)))
      : 20;
    const db = getDbClient().drizzle;
    const [profile] = await db
      .select({ id: botProfiles.id })
      .from(botProfiles)
      .where(eq(botProfiles.id, botId))
      .limit(1);
    if (!profile) throwIpcError('NOT_FOUND', 'Bot 不存在');
    const links = await db
      .select({ sessionId: botSessionLinks.sessionId })
      .from(botSessionLinks)
      .where(eq(botSessionLinks.botId, botId));
    return searchConversations(
      {
        query,
        limit,
        semanticMode: 'hybrid',
        filters: {
          status: 'all',
          sessionIds: links.map((row) => row.sessionId),
        },
      },
      // The Bot-owned Session id set above is authoritative. Passing null here
      // allows migrated IM history to retain its original source while keeping
      // the renderer unable to widen the search scope.
      { sessionSources: null },
    );
  });

  ipcMain.handle('local-db:bots:create', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const name = readText(body.name ?? body.displayName, 'name', 200, true);
    const description = readText(body.description, 'description');
    const id =
      readText(body.id, 'id', 128) || `bot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const avatar = readText(body.avatar, 'avatar', 16) || '🤖';
    const avatarColor = readText(body.avatarColor, 'avatarColor', 32) || 'violet';
    const identitySource =
      readText(body.identitySource, 'identitySource', 12000) || buildDefaultBotIdentity(name);
    const skills = Array.isArray(body.skills)
      ? body.skills.filter((item): item is string => typeof item === 'string').slice(0, 100)
      : [];
    const capabilities =
      body.capabilities &&
      typeof body.capabilities === 'object' &&
      !Array.isArray(body.capabilities)
        ? (body.capabilities as Record<string, unknown>)
        : {};
    const userContextSource = readText(body.userContextSource, 'userContextSource', 12000);
    let eventSubscription:
      { id: string; name: string; status: 'active' | 'paused'; ruleJson: string } | undefined;
    if (body.eventSubscription !== undefined) {
      if (
        !body.eventSubscription ||
        typeof body.eventSubscription !== 'object' ||
        Array.isArray(body.eventSubscription)
      ) {
        throwIpcError('INVALID_PARAMS', 'eventSubscription 必须是对象');
      }
      const subscription = body.eventSubscription as Record<string, unknown>;
      const suffix = readText(subscription.id, 'eventSubscription.id', 80) || 'control-events';
      if (
        subscription.status !== undefined &&
        subscription.status !== 'active' &&
        subscription.status !== 'paused'
      ) {
        throwIpcError('INVALID_PARAMS', 'eventSubscription.status 无效');
      }
      if (
        !subscription.rule ||
        typeof subscription.rule !== 'object' ||
        Array.isArray(subscription.rule)
      ) {
        throwIpcError('INVALID_PARAMS', 'eventSubscription.rule 必须是对象');
      }
      const status = subscription.status === 'paused' ? 'paused' : 'active';
      eventSubscription = {
        id: `bot-${suffix}:${id}`,
        name: readText(subscription.name, 'eventSubscription.name', 120, true),
        status,
        ruleJson: safeJson(normalizeBotEventSubscriptionRule(subscription.rule)),
      };
    }
    const now = Date.now();
    const client = getDbClient();
    const db = client.drizzle;
    await client.tx('bots.createProfile', {
      id,
      displayName: name,
      description,
      avatar,
      avatarColor,
      identitySource,
      capabilitiesJson: safeJson({ ...capabilities, skills, userContextSource }),
      eventSubscription,
      now,
    });
    return readProfile(db, id);
  });

  ipcMain.handle('local-db:bots:migrate-legacy', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const id = readText(body.id, 'id', 128, true);
    const name = readText(body.name ?? body.displayName, 'name', 200, true);
    const description = readText(body.description, 'description');
    const avatar = readText(body.avatar, 'avatar', 16) || '🤖';
    const avatarColor = readText(body.avatarColor, 'avatarColor', 32) || 'violet';
    const identitySource =
      readText(body.identitySource, 'identitySource', 12000) || buildDefaultBotIdentity(name);
    const capabilities =
      body.capabilities &&
      typeof body.capabilities === 'object' &&
      !Array.isArray(body.capabilities)
        ? (body.capabilities as Record<string, unknown>)
        : {};
    const skills = Array.isArray(body.skills)
      ? body.skills.filter((item): item is string => typeof item === 'string').slice(0, 100)
      : [];
    const channelKind = readText(body.channel, 'channel', 32) as ChannelKind;
    if (channelKind && !CHANNELS.has(channelKind)) {
      throwIpcError('INVALID_PARAMS', `invalid channel kind: ${channelKind}`);
    }
    const legacySessionId = readText(body.canonicalSessionId, 'canonicalSessionId', 128);
    const db = getDbClient().drizzle;
    const now = Date.now();
    await getDbClient().tx('bots.migrateLegacyProfile', {
      id,
      displayName: name,
      description,
      avatar,
      avatarColor,
      identitySource,
      capabilitiesJson: safeJson({ ...capabilities, skills }),
      channelKind: channelKind || null,
      legacySessionId: legacySessionId || null,
      now,
    });
    return readProfile(db, id);
  });

  ipcMain.handle('local-db:bots:update', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const id = readText(body.id, 'botId', 128, true);
    const db = getDbClient().drizzle;
    const [current] = await db.select().from(botProfiles).where(eq(botProfiles.id, id)).limit(1);
    if (!current) throwIpcError('NOT_FOUND', 'Bot 不存在');
    const now = Date.now();
    const patch: Partial<typeof botProfiles.$inferInsert> = { updatedAt: now };
    if (body.name !== undefined || body.displayName !== undefined)
      patch.displayName = readText(body.name ?? body.displayName, 'name', 200, true);
    if (body.description !== undefined)
      patch.description = readText(body.description, 'description');
    if (body.avatar !== undefined) patch.avatar = readText(body.avatar, 'avatar', 16, true);
    if (body.avatarColor !== undefined)
      patch.avatarColor = readText(body.avatarColor, 'avatarColor', 32, true);
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean')
        throwIpcError('INVALID_PARAMS', 'enabled 必须是 boolean');
      patch.status = body.enabled ? 'active' : 'paused';
    }
    const [version] = await db
      .select()
      .from(botProfileVersions)
      .where(
        and(
          eq(botProfileVersions.botId, id),
          eq(botProfileVersions.version, current.currentVersion),
        ),
      )
      .limit(1);
    const previous = parseJson(version?.capabilitiesJson ?? '{}');
    const nextConfig = mergeBotProfileCapabilities({
      previous,
      capabilities:
        body.capabilities &&
        typeof body.capabilities === 'object' &&
        !Array.isArray(body.capabilities)
          ? (body.capabilities as Record<string, unknown>)
          : undefined,
      skills: body.skills,
      hasSkills: Object.prototype.hasOwnProperty.call(body, 'skills'),
    });
    if (Object.prototype.hasOwnProperty.call(body, 'userContextSource')) {
      nextConfig.userContextSource = readText(body.userContextSource, 'userContextSource', 12000);
    }
    const nextIdentitySource =
      body.identitySource !== undefined
        ? readText(body.identitySource, 'identitySource', 12000) ||
          buildDefaultBotIdentity(patch.displayName ?? current.displayName)
        : (version?.identitySource ?? '');
    const profileContentChanged = botProfileContentChanged({
      previousCapabilities: previous,
      nextCapabilities: nextConfig,
      previousIdentitySource: version?.identitySource ?? '',
      nextIdentitySource,
    });
    await getDbClient().tx('bots.updateProfile', {
      id,
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.avatar !== undefined ? { avatar: patch.avatar } : {}),
      ...(patch.avatarColor !== undefined ? { avatarColor: patch.avatarColor } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      identitySource: nextIdentitySource,
      capabilitiesJson: safeJson(nextConfig),
      profileContentChanged,
      expectedCurrentVersion: current.currentVersion,
      now,
    });
    return readProfile(db, id);
  });

  ipcMain.handle('local-db:bots:channel-upsert', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const botId = readText(body.botId, 'botId', 128, true);
    const kind = readText(body.kind, 'kind', 32, true) as ChannelKind;
    if (!CHANNELS.has(kind)) throwIpcError('INVALID_PARAMS', `invalid channel kind: ${kind}`);
    const id = readText(body.id, 'channelId', 256) || `${botId}:${kind}`;
    const enabled = body.enabled === undefined ? true : body.enabled;
    if (typeof enabled !== 'boolean') throwIpcError('INVALID_PARAMS', 'enabled 必须是 boolean');
    const now = Date.now();
    const db = getDbClient().drizzle;
    await getDbClient().tx('bots.upsertChannel', {
      id,
      botId,
      kind,
      enabled,
      configJson:
        body.config && typeof body.config === 'object' && !Array.isArray(body.config)
          ? safeJson(body.config)
          : body.config === undefined
            ? null
            : '{}',
      now,
    });
    // Mounting an IM account does not create an account-wide Route task.
    // The first message in each concrete DM/group/thread lane creates its own
    // Route lazily in botRouteService, preserving independent context/history.
    return readProfile(db, botId);
  });

  ipcMain.handle('local-db:bots:im-migration-plan', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    return planBotImMigration({
      botId: readText(body.botId, 'botId', 128, true),
      connectionId: readText(body.connectionId, 'connectionId', 512, true),
    });
  });

  ipcMain.handle('local-db:bots:im-migration-apply', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    return applyBotImMigration({
      botId: readText(body.botId, 'botId', 128, true),
      connectionId: readText(body.connectionId, 'connectionId', 512, true),
      planHash: readText(body.planHash, 'planHash', 128, true),
      requestId: readText(body.requestId, 'requestId', 128, true),
    });
  });

  ipcMain.handle('local-db:bots:im-migrations-list', async (event, rawBotId: unknown) => {
    assertTrustedAppRendererEvent(event);
    return listBotImMigrations(readText(rawBotId, 'botId', 128, true));
  });

  ipcMain.handle('local-db:bots:im-migration-rollback', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    return rollbackBotImMigration(readText(body.migrationId, 'migrationId', 128, true));
  });

  ipcMain.handle('local-db:bots:route-upsert', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const botId = readText(body.botId, 'botId', 128, true);
    const capabilities =
      body.capabilities &&
      typeof body.capabilities === 'object' &&
      !Array.isArray(body.capabilities)
        ? (body.capabilities as Record<string, unknown>)
        : {};
    await upsertBotRoute({
      id: readText(body.id, 'routeId', 128) || undefined,
      botId,
      channelId: readText(body.channelId, 'channelId', 128, true),
      routeKey: readText(body.routeKey, 'routeKey', 1_000, true),
      principalKey: readText(body.principalKey, 'principalKey', 1_000) || undefined,
      scopeKey: readText(body.scopeKey, 'scopeKey', 1_000) || undefined,
      threadKey: readText(body.threadKey, 'threadKey', 1_000) || undefined,
      projectBindingId: readText(body.projectBindingId, 'projectBindingId', 128) || undefined,
      capabilities,
    });
    return readProfile(getDbClient().drizzle, botId);
  });

  ipcMain.handle('local-db:bots:route-set-status', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const routeId = readText(body.routeId ?? body.id, 'routeId', 128, true);
    const status = readText(body.status, 'status', 32, true) as BotRouteStatus;
    if (
      !BOT_ROUTE_STATUSES.includes(status) ||
      (status !== 'paused' && status !== 'offline' && status !== 'archived')
    ) {
      throwIpcError('INVALID_PARAMS', 'renderer 只能暂停、恢复或归档 Bot Route');
    }
    const route = await setBotRouteStatus(routeId, status);
    return readProfile(getDbClient().drizzle, route.botId);
  });

  ipcMain.handle('local-db:bots:project-binding-upsert', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const botId = readText(body.botId, 'botId', 128, true);
    const workingDirRaw = readText(body.workingDir, 'workingDir', 4000, true);
    const workingDir = normalizeWorkingDirForStorage(workingDirRaw);
    if (!workingDir) throwIpcError('INVALID_PARAMS', 'workingDir 无效');
    const remoteHostId = readText(body.remoteHostId, 'remoteHostId', 256) || null;
    const workspacePolicy = readText(
      body.workspacePolicy ?? 'none',
      'workspacePolicy',
      32,
      true,
    ) as BotWorkspacePolicy;
    if (!WORKSPACE_POLICIES.has(workspacePolicy)) {
      throwIpcError('INVALID_PARAMS', `invalid workspace policy: ${workspacePolicy}`);
    }
    const defaultBranch = readText(body.defaultBranch, 'defaultBranch', 512) || null;
    const isDefault = body.isDefault === undefined ? false : body.isDefault;
    if (typeof isDefault !== 'boolean') throwIpcError('INVALID_PARAMS', 'isDefault 必须是 boolean');
    const allowedPaths = normalizeAllowedPaths(body.allowedPaths, workingDir, remoteHostId);
    const projectKey = projectIdentityKey(
      remoteHostId ? 'remote' : 'local',
      workingDir,
      remoteHostId,
    );
    const id = readText(body.id, 'projectBindingId', 128) || randomUUID();
    const now = Date.now();
    const db = getDbClient().drizzle;
    await getDbClient().tx('bots.upsertProjectBinding', {
      id,
      botId,
      projectKey,
      workingDir,
      remoteHostId,
      defaultBranch,
      workspacePolicy,
      isDefault,
      allowedPathsJson: JSON.stringify(allowedPaths),
      now,
      eventId: `${botId}:project-binding:${now}`,
    });
    return readProfile(db, botId);
  });

  ipcMain.handle('local-db:bots:project-binding-archive', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const botId = readText(body.botId, 'botId', 128, true);
    const id = readText(body.id, 'projectBindingId', 128, true);
    const db = getDbClient().drizzle;
    const activeLeases = await db
      .select({ id: botWorkspaceLeases.id })
      .from(botWorkspaceLeases)
      .where(
        and(
          eq(botWorkspaceLeases.botId, botId),
          eq(botWorkspaceLeases.projectBindingId, id),
          inArray(botWorkspaceLeases.status, ['acquiring', 'active', 'releasing', 'error']),
        ),
      )
      .limit(1);
    if (activeLeases.length > 0) {
      throwIpcError('PRECONDITION_FAILED', '项目仍有 active Bot workspace lease');
    }
    const now = Date.now();
    await db
      .update(botProjectBindings)
      .set({ status: 'archived', isDefault: false, updatedAt: now })
      .where(and(eq(botProjectBindings.id, id), eq(botProjectBindings.botId, botId)));
    return readProfile(db, botId);
  });

  ipcMain.handle('local-db:bots:workspace-lease-release', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const botId = readText(body.botId, 'botId', 128, true);
    const leaseId = readText(body.leaseId, 'leaseId', 128, true);
    if (!Number.isInteger(body.expectedGeneration) || Number(body.expectedGeneration) < 1) {
      throwIpcError('INVALID_PARAMS', 'expectedGeneration 必须是正整数');
    }
    const expectedGeneration = Number(body.expectedGeneration);
    const db = getDbClient().drizzle;
    const [lease] = await db
      .select()
      .from(botWorkspaceLeases)
      .where(and(eq(botWorkspaceLeases.id, leaseId), eq(botWorkspaceLeases.botId, botId)))
      .limit(1);
    if (!lease) throwIpcError('NOT_FOUND', 'Bot workspace lease 不存在');
    if (lease.generation !== expectedGeneration) {
      throwIpcError('PRECONDITION_FAILED', 'Bot workspace lease 已被另一处操作更新');
    }
    if (lease.status === 'released') return readProfile(db, botId);
    if (lease.status !== 'active' && lease.status !== 'error' && lease.status !== 'retained') {
      throwIpcError('PRECONDITION_FAILED', `Bot workspace lease 当前状态为 ${lease.status}`);
    }

    const attachments = await db
      .select()
      .from(botWorkspaceAttachments)
      .where(
        and(
          eq(botWorkspaceAttachments.leaseId, leaseId),
          isNull(botWorkspaceAttachments.detachedAt),
        ),
      );
    const attachedSessionIds = attachments.map((attachment) => attachment.sessionId);
    const attachedSessions = attachedSessionIds.length
      ? await db
          .select({ id: sessions.id, status: sessions.status })
          .from(sessions)
          .where(inArray(sessions.id, attachedSessionIds))
      : [];
    const statusBySession = new Map(
      attachedSessions.map((session) => [session.id, session.status]),
    );
    if (
      attachedSessionIds.some((sessionId) => {
        const status = statusBySession.get(sessionId);
        return status !== 'archived' && status !== 'deleted';
      })
    ) {
      throwIpcError('PRECONDITION_FAILED', '仍有 active Bot Session 使用该 workspace lease');
    }

    const activeAutomation = await db
      .select({ id: botAutomationRuns.id })
      .from(botAutomationRuns)
      .where(
        and(
          eq(botAutomationRuns.workspaceLeaseId, leaseId),
          inArray(botAutomationRuns.status, ['claimed', 'running', 'completing']),
        ),
      )
      .limit(1);
    if (activeAutomation.length > 0) {
      throwIpcError('PRECONDITION_FAILED', '仍有 Bot Automation 使用该 workspace lease');
    }

    if (attachedSessionIds.length > 0) {
      const activeDelegations = await db
        .select({
          id: botDelegations.id,
          parentSessionId: botDelegations.parentSessionId,
          childSessionId: botDelegations.childSessionId,
        })
        .from(botDelegations)
        .where(inArray(botDelegations.status, ['queued', 'running', 'waiting']));
      const attached = new Set(attachedSessionIds);
      if (
        activeDelegations.some(
          (delegation) =>
            (delegation.parentSessionId && attached.has(delegation.parentSessionId)) ||
            (delegation.childSessionId && attached.has(delegation.childSessionId)),
        )
      ) {
        throwIpcError('PRECONDITION_FAILED', '仍有 Bot delegation 使用该 workspace lease');
      }
    }

    const now = Date.now();
    const [claimed] = await db
      .update(botWorkspaceLeases)
      .set({ status: 'releasing', updatedAt: now })
      .where(
        and(
          eq(botWorkspaceLeases.id, leaseId),
          eq(botWorkspaceLeases.generation, expectedGeneration),
          inArray(botWorkspaceLeases.status, ['active', 'error', 'retained']),
        ),
      )
      .returning();
    if (!claimed) {
      throwIpcError('PRECONDITION_FAILED', 'Bot workspace lease 已被另一处操作更新');
    }

    try {
      const [{ getMakerIfReady }, worktree, remoteWorkspace] = await Promise.all([
        import('../../maker-host/index.js'),
        import('../../worktree/index.js'),
        import('../../maker-ipc/botRemoteWorkspaceService.js'),
      ]);
      const maker = getMakerIfReady();
      if (attachedSessionIds.some((sessionId) => maker?.isSessionAlive(sessionId) === true)) {
        throwIpcError('PRECONDITION_FAILED', '仍有 Bot Session runtime 使用该 workspace lease');
      }
      if (claimed.worktreePath && !claimed.anchorSessionId) {
        throwIpcError('PRECONDITION_FAILED', 'workspace lease 缺少可恢复的 anchor Session');
      }
      if (claimed.remoteHostId && claimed.worktreePath) {
        if (!claimed.branch) {
          throwIpcError('PRECONDITION_FAILED', '远程 workspace lease 缺少受管分支信息');
        }
        await remoteWorkspace.removeRemoteBotWorktree({
          remoteHostId: claimed.remoteHostId,
          baseRepo: claimed.baseRepo,
          worktreePath: claimed.worktreePath,
          branch: claimed.branch,
        });
      } else if (claimed.anchorSessionId) {
        await worktree.WorktreeManager.removeWorktreeForSession(claimed.anchorSessionId, {
          isSessionRuntimeAlive: (sessionId) => maker?.isSessionAlive(sessionId) ?? false,
          canRemove: async () => {
            const [current] = await db
              .select({
                status: botWorkspaceLeases.status,
                generation: botWorkspaceLeases.generation,
              })
              .from(botWorkspaceLeases)
              .where(eq(botWorkspaceLeases.id, leaseId))
              .limit(1);
            return current?.status === 'releasing' && current.generation === expectedGeneration;
          },
        });
      }
      const registered =
        !claimed.remoteHostId && claimed.worktreePath
          ? worktree.WorktreeManager.listAll().some(
              (meta) => path.resolve(meta.path) === path.resolve(claimed.worktreePath!),
            )
          : false;
      const remainsOnDisk = claimed.worktreePath
        ? claimed.remoteHostId
          ? (
              await remoteWorkspace.inspectRemoteBotWorktree({
                remoteHostId: claimed.remoteHostId,
                worktreePath: claimed.worktreePath,
                baseRepo: claimed.baseRepo,
                branch: claimed.branch,
              })
            ).exists
          : await fileExists(claimed.worktreePath)
        : false;
      if (registered || remainsOnDisk) {
        throwIpcError(
          'PRECONDITION_FAILED',
          'worktree 被安全保护策略保留；请处理运行中引用、分支状态或 .worktree-keep 后重试',
        );
      }

      await getDbClient().tx('bots.finalizeWorkspaceLeaseRelease', {
        leaseId,
        botId,
        expectedGeneration,
        anchorSessionId: claimed.anchorSessionId,
        releasedAt: now,
        eventId: `${botId}:workspace-released:${leaseId}:${now}`,
        eventType: 'workspace-lease-released',
      });
      return readProfile(db, botId);
    } catch (error) {
      await db
        .update(botWorkspaceLeases)
        .set({ status: 'error', updatedAt: Date.now() })
        .where(
          and(
            eq(botWorkspaceLeases.id, leaseId),
            eq(botWorkspaceLeases.generation, expectedGeneration),
            eq(botWorkspaceLeases.status, 'releasing'),
          ),
        );
      throw error;
    }
  });

  const createBotCanonicalSessionUnlocked = async (
    input: CreateBotCanonicalSessionInput,
  ): Promise<CreateBotCanonicalSessionResult> => {
    const botId = readText(input.botId, 'botId', 128, true);
    const expectedCanonicalSessionId = input.expectedCanonicalSessionId;
    if (!Number.isInteger(input.expectedProfileVersion) || input.expectedProfileVersion < 1) {
      throwIpcError('INVALID_PARAMS', 'expectedProfileVersion 必须是正整数');
    }
    const expectedProfileVersion = input.expectedProfileVersion;
    const db = getDbClient().drizzle;
    const [profile] = await db.select().from(botProfiles).where(eq(botProfiles.id, botId)).limit(1);
    if (!profile) throwIpcError('NOT_FOUND', 'Bot 不存在');
    if (profile.status !== 'active' && profile.status !== 'paused') {
      throwIpcError('PRECONDITION_FAILED', `Bot 当前状态为 ${profile.status}`);
    }
    if (input.recoverMissingOnly) {
      if (!expectedCanonicalSessionId || profile.canonicalSessionId !== expectedCanonicalSessionId) {
        throwIpcError('PRECONDITION_FAILED', 'Bot 主任务已变化，请刷新后重试');
      }
      const [existingCanonical] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, expectedCanonicalSessionId))
        .limit(1);
      if (existingCanonical) {
        throwIpcError('PRECONDITION_FAILED', 'Bot 主任务仍然存在，不能按丢失任务恢复');
      }
    }
    const [profileVersion] = await db
      .select()
      .from(botProfileVersions)
      .where(
        and(
          eq(botProfileVersions.botId, botId),
          eq(botProfileVersions.version, profile.currentVersion),
        ),
      )
      .limit(1);
    if (!profileVersion) throwIpcError('PRECONDITION_FAILED', 'Bot 当前 Profile 版本不存在');
    const [defaultProjectBinding] = await db
      .select()
      .from(botProjectBindings)
      .where(
        and(
          eq(botProjectBindings.botId, botId),
          eq(botProjectBindings.status, 'active'),
          eq(botProjectBindings.isDefault, true),
        ),
      )
      .limit(1);

    // Allocate the app-owned workspace before opening the SQLite write
    // transaction. The transaction re-checks the canonical CAS; if another
    // window wins while the workspace is being prepared, the unused exact
    // UUID directory is removed and no hidden Session row is left behind.
    const now = Date.now();
    const sessionId = resolveBusinessSessionId(undefined);
    const workspaceKind = defaultProjectBinding ? 'project' : 'dialogue';
    const workingDir =
      defaultProjectBinding?.workingDir ?? ensureDialogueWorkspaceDir(sessionId, now);
    const config = parseJson(profileVersion.capabilitiesJson);
    const insertRow = {
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
          agentKind: botSessionAgentKind(config),
          permissionMode: botSessionPermissionMode(config),
          remoteHostId: defaultProjectBinding?.remoteHostId ?? undefined,
          source: 'bot',
        },
        now,
      ),
      title: profile.displayName,
    };
    try {
      await ensureProjectGitInitialized({
        workingDir,
        workspaceKind,
        remoteHostId: defaultProjectBinding?.remoteHostId ?? null,
        sessionId,
        autoSnapshotEnabled: readGitSafetySettings().autoSnapshotEnabled,
        source: 'local-db:bots:create-canonical-session',
      });
    } catch (error) {
      if (!defaultProjectBinding) {
        await fs.rm(workingDir, { recursive: true, force: true }).catch(() => {});
      }
      throw error;
    }

    let canonicalSessionId: string | null = null;
    let archivedCanonicalSessionId: string | null = null;
    let created = false;
    try {
      const result = await getDbClient().tx<BotsReplaceCanonicalSessionResult>(
        'bots.replaceCanonicalSession', {
        botId,
        expectedCanonicalSessionId,
        expectedProfileVersion,
        session: {
          id: insertRow.id,
          title: insertRow.title,
          workingDir: insertRow.workingDir ?? null,
          workspaceKind: insertRow.workspaceKind,
          model: insertRow.model,
          effort: insertRow.effort,
          fastMode: insertRow.fastMode,
          permissionMode: insertRow.permissionMode,
          agentKind: insertRow.agentKind,
          remoteHostId: insertRow.remoteHostId ?? null,
          providerId: insertRow.providerId ?? null,
          extraDirs: insertRow.extraDirs,
          source: insertRow.source,
          createdAt: insertRow.createdAt,
          updatedAt: insertRow.updatedAt,
        },
          now,
        },
      );
      canonicalSessionId = result.canonicalSessionId;
      archivedCanonicalSessionId = result.archivedCanonicalSessionId;
      created = result.created;
    } finally {
      if (!created) {
        const [persisted] = await db
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1);
        // Project bindings are user-owned. Only the exact dialogue workspace
        // allocated by this attempt is eligible for failure compensation.
        if (!persisted && workspaceKind === 'dialogue') {
          await fs.rm(workingDir, { recursive: true, force: true }).catch(() => {});
        }
      }
    }

    if (!canonicalSessionId) {
      throwIpcError('PRECONDITION_FAILED', 'Bot 主任务创建失败');
    }
    if (archivedCanonicalSessionId) {
      await cancelBotDelegationChildren(
        archivedCanonicalSessionId,
        'Parent Bot task was replaced by Renew.',
      );
      const [{ getMakerIfReady }, workspaceRuntime] = await Promise.all([
        import('../../maker-host/index.js'),
        import('../../maker-ipc/botWorkspaceRuntime.js'),
      ]);
      await getMakerIfReady()
        ?.closeSession(archivedCanonicalSessionId)
        .catch(() => undefined);
      workspaceRuntime.schedulePerTaskBotWorkspaceReclaim(archivedCanonicalSessionId);
    }
    const [canonical] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, canonicalSessionId))
      .limit(1);
    if (!canonical) throwIpcError('NOT_FOUND', 'Bot 主任务不存在');
    return {
      created,
      canonicalSessionId,
      session: sessionToCamel({
        ...canonical,
        messageCount: 0,
        latestMessageContent: null,
        latestMessageRole: null,
      }),
    };
  };

  createBotCanonicalSessionImpl = async (input) => {
    const previousSessionId = input.expectedCanonicalSessionId;
    if (!previousSessionId) return createBotCanonicalSessionUnlocked(input);
    return coordinateBotCanonicalReplacement(
      previousSessionId,
      () => createBotCanonicalSessionUnlocked(input),
    );
  };

  ipcMain.handle('local-db:bots:create-canonical-session', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const botId = readText(body.botId, 'botId', 128, true);
    if (!Object.prototype.hasOwnProperty.call(body, 'expectedCanonicalSessionId')) {
      throwIpcError('INVALID_PARAMS', 'expectedCanonicalSessionId 必须显式提供');
    }
    const expectedCanonicalSessionId =
      body.expectedCanonicalSessionId === null
        ? null
        : readText(body.expectedCanonicalSessionId, 'expectedCanonicalSessionId', 128, true);
    if (!Number.isInteger(body.expectedProfileVersion) || Number(body.expectedProfileVersion) < 1) {
      throwIpcError('INVALID_PARAMS', 'expectedProfileVersion 必须是正整数');
    }
    if (body.recoverMissingOnly !== undefined && typeof body.recoverMissingOnly !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'recoverMissingOnly 必须是 boolean');
    }
    return createBotCanonicalSession({
      botId,
      expectedCanonicalSessionId,
      expectedProfileVersion: Number(body.expectedProfileVersion),
      recoverMissingOnly: body.recoverMissingOnly === true,
    });
  });

  ipcMain.handle('local-db:bots:link-session', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const botId = readText(body.botId, 'botId', 128, true);
    const sessionId = readText(body.sessionId, 'sessionId', 128, true);
    const role = readText(body.role, 'role', 16, true) as BotRole;
    if (!ROLES.has(role)) throwIpcError('INVALID_PARAMS', `invalid Bot Session role: ${role}`);
    const db = getDbClient().drizzle;
    const [bot] = await db.select().from(botProfiles).where(eq(botProfiles.id, botId)).limit(1);
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!bot || !session) throwIpcError('NOT_FOUND', 'Bot 或 Session 不存在');
    if (session.source !== 'bot') {
      // A renderer-held id is never authority to reclassify an existing task.
      // Reclassification would hide arbitrary desktop/Review tasks from the
      // normal Session list and would also bypass their immutable-field rules.
      throwIpcError('INVALID_PARAMS', '只有 source=bot 的 Session 才能绑定到 Bot');
    }
    const channelId =
      typeof body.channelId === 'string' && body.channelId.trim() ? body.channelId.trim() : null;
    const routeKey = typeof body.routeKey === 'string' ? body.routeKey.trim().slice(0, 500) : '';
    const hasExpectedCanonical = Object.prototype.hasOwnProperty.call(
      body,
      'expectedCanonicalSessionId',
    );
    const expectedCanonicalSessionId = hasExpectedCanonical
      ? body.expectedCanonicalSessionId === null
        ? null
        : readText(body.expectedCanonicalSessionId, 'expectedCanonicalSessionId', 128)
      : undefined;
    if (role === 'route' && (!channelId || !routeKey)) {
      throwIpcError('INVALID_PARAMS', 'route Session 必须带 Channel 和 routeKey');
    }
    if (channelId) {
      const [channel] = await db
        .select({ id: botChannels.id, botId: botChannels.botId })
        .from(botChannels)
        .where(eq(botChannels.id, channelId))
        .limit(1);
      if (!channel || channel.botId !== botId)
        throwIpcError('INVALID_PARAMS', 'Channel 不属于该 Bot');
    }
    const existing = await db
      .select({
        id: botSessionLinks.id,
        botId: botSessionLinks.botId,
        role: botSessionLinks.role,
        sessionId: botSessionLinks.sessionId,
      })
      .from(botSessionLinks)
      .where(eq(botSessionLinks.sessionId, sessionId))
      .limit(1);
    if (existing[0] && existing[0].botId !== botId) {
      throwIpcError('PRECONDITION_FAILED', 'Session 已绑定到另一个 Bot');
    }
    if (role === 'history' && bot.canonicalSessionId === sessionId) {
      throwIpcError('PRECONDITION_FAILED', 'canonical Session 必须通过 Renew 原子替换');
    }
    if (role === 'route' && bot.canonicalSessionId === sessionId) {
      throwIpcError('PRECONDITION_FAILED', 'canonical Session 不能同时作为 route Session');
    }
    const now = Date.now();
    const { archivedCanonicalSessionIds } = await getDbClient().tx('bots.linkSession', {
      botId,
      sessionId,
      role,
      channelId,
      routeKey: routeKey || null,
      hasExpectedCanonical,
      expectedCanonicalSessionId: expectedCanonicalSessionId ?? null,
      now,
      eventId: `${botId}:linked:${sessionId}:${now}`,
    });
    if (archivedCanonicalSessionIds.length > 0) {
      const [{ getMakerIfReady }, workspaceRuntime] = await Promise.all([
        import('../../maker-host/index.js'),
        import('../../maker-ipc/botWorkspaceRuntime.js'),
      ]);
      for (const archivedSessionId of archivedCanonicalSessionIds) {
        await cancelBotDelegationChildren(
          archivedSessionId,
          'Parent Bot task was replaced by a new canonical task.',
        );
        await getMakerIfReady()
          ?.closeSession(archivedSessionId)
          .catch(() => undefined);
        workspaceRuntime.schedulePerTaskBotWorkspaceReclaim(archivedSessionId);
      }
    }
    return readProfile(db, botId);
  });

  ipcMain.handle('local-db:bots:history', async (event, rawBotId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botId = readText(rawBotId, 'botId', 128, true);
    const db = getDbClient().drizzle;
    const links = await db
      .select()
      .from(botSessionLinks)
      .where(and(eq(botSessionLinks.botId, botId), eq(botSessionLinks.role, 'history')))
      .orderBy(desc(botSessionLinks.archivedAt));
    const result = [];
    for (const link of links) {
      const [row] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, link.sessionId))
        .limit(1);
      if (!row) continue;
      result.push(
        sessionToCamel({
          ...row,
          messageCount: 0,
          latestMessageContent: null,
          latestMessageRole: null,
        }),
      );
    }
    return result;
  });
}
