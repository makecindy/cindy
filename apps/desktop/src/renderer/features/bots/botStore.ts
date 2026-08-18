import { useSyncExternalStore } from 'react';
import { getDraft } from '@/state/newMakerDraft';
import {
  getBotLastReadAtMap,
  pruneBotReadState,
  seedMissingBotReadState,
} from './botReadState';
import type { BotWorkspacePolicy } from '../../../shared/botWorkspace';
import type { BotChannelConnection } from '../../../shared/botChannelRegistry';
import type { BotImMigrationPlan, BotImMigrationRecord } from '../../../shared/botImMigration';
import type { BotBundleExportResult, BotBundleImportResult } from '../../../shared/botPortability';
import type { BotHealthReport } from '../../../shared/botLifecycle';
import {
  normalizeBotSessionControlMode,
  type BotSessionControlMode,
} from '../../../shared/botSessionControl';
import type { BotEventSubscriptionRule } from '../../../shared/botSessionEvents';

export type BotChannel =
  'telegram' | 'feishu' | 'slack' | 'discord' | 'wechat' | 'dingtalk' | 'wecom' | 'x' | 'local';

export type { BotChannelConnection } from '../../../shared/botChannelRegistry';
export type { BotImMigrationPlan, BotImMigrationRecord } from '../../../shared/botImMigration';

export interface BotCapabilities {
  model: string;
  providerId?: string | null;
  effort: string;
  fastMode: boolean;
  harness: 'claude' | 'codex' | 'pi';
  skillMode: 'inherit' | 'allowlist';
  toolsetMode: 'inherit' | 'allowlist';
  toolsets: string[];
  mcpMode: 'inherit' | 'allowlist';
  mcpServers: string[];
  memory: boolean;
  automation: boolean;
  permissions: 'ask' | 'trusted';
  sessionControlMode: BotSessionControlMode;
}

function vendorForHarness(harness: BotCapabilities['harness']): 'cc' | 'codex' | 'pi' {
  return harness === 'claude' ? 'cc' : harness;
}

function normalizeBotModel(model: unknown, harness: BotCapabilities['harness']): string {
  if (typeof model === 'string' && model.trim()) return model.trim();
  return getDraft().lastByVendor[vendorForHarness(harness)].model;
}

function normalizeBotHarness(value: unknown): BotCapabilities['harness'] {
  return value === 'claude' || value === 'codex' || value === 'pi' ? value : 'claude';
}

function normalizeSkillMode(
  value: unknown,
  configuredSkills: unknown,
): BotCapabilities['skillMode'] {
  if (value === 'inherit' || value === 'allowlist') return value;
  return Array.isArray(configuredSkills) && configuredSkills.length > 0 ? 'allowlist' : 'inherit';
}

function normalizeCapabilityMode(value: unknown, configured: unknown): 'inherit' | 'allowlist' {
  if (value === 'inherit' || value === 'allowlist') return value;
  return Array.isArray(configured) && configured.length > 0 ? 'allowlist' : 'inherit';
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean),
        ),
      ]
    : [];
}

export interface BotSessionProjection {
  id: string;
  title: string;
  kind: 'chat' | 'route' | 'history';
  channel: BotChannel;
  updatedAt: number;
  status?: 'active' | 'archived' | 'deleted';
  profileVersion?: number;
  runtimeSnapshot?: {
    profileVersion: number;
    agentKind: 'claude-code' | 'codex' | 'pi';
    status: 'prepared' | 'applied' | 'degraded' | 'failed';
    preparedAt: number;
    appliedAt?: number;
    failedAt?: number;
    failure?: Record<string, unknown>;
    configured: Record<string, unknown>;
    resolved: Record<string, unknown>;
  };
}

export interface BotProfile {
  id: string;
  name: string;
  channel: BotChannel;
  description: string;
  identitySource?: string;
  userContextSource?: string;
  avatar: string;
  avatarColor: string;
  enabled: boolean;
  status?: import('../../../shared/botLifecycle').BotProfileLifecycleStatus;
  currentVersion?: number;
  skills: string[];
  capabilities: BotCapabilities;
  /** The real Cindy Session that backs this Bot's canonical conversation. */
  canonicalSessionId?: string;
  /**
   * Plain-text preview of the latest visible message in the canonical chat,
   * projected main-side (read-only). Null when the conversation is still empty.
   */
  lastMessagePreview?: string | null;
  /** Timestamp of that message (unix ms), null when there is none. */
  lastMessageAt?: number | null;
  /** Who sent that message — lets the list read like a chat list, not a log. */
  lastMessageRole?: 'user' | 'assistant' | null;
  createdAt: number;
  sessions: BotSessionProjection[];
  channels?: Array<{
    id: string;
    kind: BotChannel;
    enabled: boolean;
    config?: Record<string, unknown>;
  }>;
  projectBindings?: BotProjectBinding[];
  workspaceLeases?: BotWorkspaceLease[];
  routes?: BotRoute[];
}

export interface BotProjectBinding {
  id: string;
  projectKey: string;
  workingDir: string;
  remoteHostId?: string;
  defaultBranch?: string;
  workspacePolicy: BotWorkspacePolicy;
  isDefault: boolean;
  allowedPaths: string[];
  status: 'active' | 'paused' | 'error' | 'archived';
  createdAt: number;
  updatedAt: number;
}

export interface BotWorkspaceLease {
  id: string;
  projectBindingId: string;
  leaseKey: string;
  anchorSessionId?: string;
  worktreePath?: string;
  baseRepo: string;
  branch?: string;
  sourceBranch?: string;
  remoteHostId?: string;
  generation: number;
  status: 'acquiring' | 'active' | 'releasing' | 'released' | 'retained' | 'error';
  lastHeartbeatAt?: number;
  createdAt: number;
  updatedAt: number;
  releasedAt?: number;
}

export interface BotRoute {
  id: string;
  channelId: string;
  routeKey: string;
  principalKey: string;
  scopeKey: string;
  threadKey?: string;
  currentSessionId?: string;
  projectBindingId?: string;
  capabilities: Record<string, unknown>;
  ownerDeviceId?: string;
  ownerGeneration: number;
  status: 'active' | 'paused' | 'offline' | 'recovering' | 'error' | 'archived';
  lastActivityAt?: number;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = 'cindy.bots.v1';
const SQLITE_MIGRATION_KEY = 'cindy.bots.v1.sqlite-migrated';

function defaultCapabilities(harness: BotCapabilities['harness'] = 'claude'): BotCapabilities {
  const prefs = getDraft().lastByVendor[vendorForHarness(harness)];
  return {
    model: prefs.model,
    providerId: prefs.providerId ?? null,
    effort: prefs.effort,
    fastMode: getDraft().fastModeByModel[prefs.model] === true,
    harness,
    skillMode: 'inherit',
    toolsetMode: 'inherit',
    toolsets: [],
    mcpMode: 'inherit',
    mcpServers: [],
    memory: true,
    automation: false,
    permissions: 'ask',
    sessionControlMode: 'none',
  };
}

export interface CreateBotProfileInput {
  name: string;
  description: string;
  /** Kept for legacy callers; every new Bot is local-first and Channels mount later. */
  channel?: BotChannel;
  identitySource?: string;
  userContextSource?: string;
  avatar?: string;
  avatarColor?: string;
  skills?: string[];
  capabilities?: Partial<BotCapabilities>;
  eventSubscription?: {
    id?: string;
    name: string;
    status?: 'active' | 'paused';
    rule: Partial<BotEventSubscriptionRule>;
  };
}

function readProfiles(): BotProfile[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): BotProfile[] => {
      if (!item || typeof item !== 'object') return [];
      const value = item as Partial<BotProfile>;
      if (!(
        typeof value.id === 'string' &&
        typeof value.name === 'string' &&
        typeof value.channel === 'string' &&
        typeof value.enabled === 'boolean' &&
        Array.isArray(value.sessions)
      ))
        return [];
      const capabilities = value.capabilities ?? defaultCapabilities();
      const harness = normalizeBotHarness(capabilities.harness);
      const defaults = defaultCapabilities(harness);
      const legacyTools = normalizeStringList(
        (capabilities as unknown as { tools?: unknown }).tools,
      );
      const toolsets =
        normalizeStringList(capabilities.toolsets).length > 0
          ? normalizeStringList(capabilities.toolsets)
          : legacyTools.every((item) => ['files', 'browser', 'mcp'].includes(item))
            ? []
            : legacyTools;
      return [
        {
          ...(value as BotProfile),
          avatar: typeof value.avatar === 'string' ? value.avatar : '🤖',
          avatarColor: typeof value.avatarColor === 'string' ? value.avatarColor : 'violet',
          skills: Array.isArray(value.skills) ? value.skills : [],
          userContextSource:
            typeof value.userContextSource === 'string' ? value.userContextSource : '',
          capabilities: {
            ...defaults,
            ...capabilities,
            harness,
            providerId:
              typeof capabilities.providerId === 'string'
                ? capabilities.providerId
                : capabilities.providerId === null
                  ? null
                  : defaults.providerId,
            effort:
              typeof capabilities.effort === 'string' && capabilities.effort
                ? capabilities.effort
                : defaults.effort,
            fastMode: capabilities.fastMode === true,
            sessionControlMode: normalizeBotSessionControlMode(capabilities.sessionControlMode),
            skillMode: normalizeSkillMode(capabilities.skillMode, value.skills),
            model: normalizeBotModel(capabilities.model, harness),
            toolsetMode: normalizeCapabilityMode(capabilities.toolsetMode, toolsets),
            toolsets,
            mcpMode: normalizeCapabilityMode(capabilities.mcpMode, capabilities.mcpServers),
            mcpServers: normalizeStringList(capabilities.mcpServers),
          },
          canonicalSessionId:
            typeof value.canonicalSessionId === 'string' ? value.canonicalSessionId : undefined,
          sessions: value.sessions.filter(
            (session) => typeof session?.id === 'string' && !session.id.startsWith('bot-chat-'),
          ),
        },
      ];
    });
  } catch {
    return [];
  }
}

let profiles = readProfiles();
const listeners = new Set<() => void>();
let hydrated = false;

function emit(): void {
  for (const listener of listeners) listener();
}

function persist(): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
  }
  emit();
}

function botsApi(): NonNullable<typeof window.electronAPI.localDb>['bots'] | null {
  if (typeof window === 'undefined') return null;
  return window.electronAPI?.localDb?.bots ?? null;
}

function normalizeDbProfile(value: unknown): BotProfile | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<BotProfile> & { channels?: BotProfile['channels'] };
  if (typeof item.id !== 'string' || typeof item.name !== 'string') return null;
  const channel =
    item.channel &&
    [
      'telegram',
      'feishu',
      'slack',
      'discord',
      'wechat',
      'dingtalk',
      'wecom',
      'x',
      'local',
    ].includes(item.channel)
      ? item.channel
      : 'local';
  const harness = normalizeBotHarness(item.capabilities?.harness);
  const rawCapabilities = item.capabilities as (BotCapabilities & { tools?: unknown }) | undefined;
  const defaults = defaultCapabilities(harness);
  const legacyTools = normalizeStringList(rawCapabilities?.tools);
  const toolsets =
    normalizeStringList(rawCapabilities?.toolsets).length > 0
      ? normalizeStringList(rawCapabilities?.toolsets)
      : legacyTools.every((entry) => ['files', 'browser', 'mcp'].includes(entry))
        ? []
        : legacyTools;
  return {
    id: item.id,
    name: item.name,
    channel,
    description: typeof item.description === 'string' ? item.description : '',
    identitySource: typeof item.identitySource === 'string' ? item.identitySource : '',
    userContextSource: typeof item.userContextSource === 'string' ? item.userContextSource : '',
    avatar: typeof item.avatar === 'string' ? item.avatar : '🤖',
    avatarColor: typeof item.avatarColor === 'string' ? item.avatarColor : 'violet',
    enabled: item.enabled !== false,
    status:
      item.status === 'active' ||
      item.status === 'paused' ||
      item.status === 'error' ||
      item.status === 'archived' ||
      item.status === 'deleting'
        ? item.status
        : item.enabled === false
          ? 'paused'
          : 'active',
    currentVersion: typeof item.currentVersion === 'number' ? item.currentVersion : undefined,
    skills: Array.isArray(item.skills)
      ? item.skills.filter((x): x is string => typeof x === 'string')
      : [],
    capabilities: {
      ...defaults,
      ...(item.capabilities ?? {}),
      harness,
      providerId:
        typeof rawCapabilities?.providerId === 'string'
          ? rawCapabilities.providerId
          : rawCapabilities?.providerId === null
            ? null
            : defaults.providerId,
      effort:
        typeof rawCapabilities?.effort === 'string' && rawCapabilities.effort
          ? rawCapabilities.effort
          : defaults.effort,
      fastMode: rawCapabilities?.fastMode === true,
      sessionControlMode: normalizeBotSessionControlMode(rawCapabilities?.sessionControlMode),
      skillMode: normalizeSkillMode(item.capabilities?.skillMode, item.skills),
      model: normalizeBotModel(item.capabilities?.model, harness),
      toolsetMode: normalizeCapabilityMode(rawCapabilities?.toolsetMode, toolsets),
      toolsets,
      mcpMode: normalizeCapabilityMode(rawCapabilities?.mcpMode, rawCapabilities?.mcpServers),
      mcpServers: normalizeStringList(rawCapabilities?.mcpServers),
    },
    canonicalSessionId:
      typeof item.canonicalSessionId === 'string' ? item.canonicalSessionId : undefined,
    lastMessagePreview:
      typeof item.lastMessagePreview === 'string' && item.lastMessagePreview
        ? item.lastMessagePreview
        : null,
    lastMessageAt:
      typeof item.lastMessageAt === 'number' && Number.isFinite(item.lastMessageAt)
        ? item.lastMessageAt
        : null,
    lastMessageRole:
      item.lastMessageRole === 'user' || item.lastMessageRole === 'assistant'
        ? item.lastMessageRole
        : null,
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
    sessions: Array.isArray(item.sessions)
      ? item.sessions.filter((s): s is BotSessionProjection => !!s && typeof s.id === 'string')
      : [],
    channels: Array.isArray(item.channels)
      ? item.channels
      : [{ id: `${item.id}:local`, kind: 'local', enabled: true }],
    projectBindings: Array.isArray(item.projectBindings)
      ? (item.projectBindings as BotProjectBinding[])
      : [],
    workspaceLeases: Array.isArray(item.workspaceLeases)
      ? (item.workspaceLeases as BotWorkspaceLease[])
      : [],
    routes: Array.isArray(item.routes) ? (item.routes as BotRoute[]) : [],
  };
}

/**
 * Unread replies per Bot, as counted main-side against this renderer's read
 * positions. Kept beside the profiles rather than inside them: single-Bot
 * refreshes (`get` / `update` / route mutations) carry no read state, so a
 * merged field would blink the badge off on every unrelated settings save.
 */
let unreadCounts: Record<string, number> = {};

function sameCounts(a: Record<string, number>, b: Record<string, number>): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

function applyUnreadCounts(rows: unknown[]): void {
  const next: Record<string, number> = {};
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const item = row as { id?: unknown; unreadCount?: unknown };
    if (typeof item.id !== 'string') continue;
    const count = item.unreadCount;
    if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
      next[item.id] = Math.floor(count);
    }
  }
  if (!sameCounts(unreadCounts, next)) unreadCounts = next;
}

export function getBotUnreadCounts(): Record<string, number> {
  return unreadCounts;
}

/** Unread badge source for the Bots sidebar; shares the profile listener set. */
export function useBotUnreadCounts(): Record<string, number> {
  return useSyncExternalStore(subscribeBotProfiles, getBotUnreadCounts, getBotUnreadCounts);
}

async function hydrateFromDatabase(): Promise<void> {
  const api = botsApi();
  if (!api || hydrated) return;
  hydrated = true;
  try {
    const rows = await api.list({ lastReadAtByBotId: getBotLastReadAtMap() });
    const dbProfiles = rows.map(normalizeDbProfile).filter((item): item is BotProfile => !!item);
    const migrationComplete = window.localStorage.getItem(SQLITE_MIGRATION_KEY) === '1';
    const migrationCandidates = migrationComplete ? [] : [...profiles];
    let migrationPending = false;
    for (const old of migrationCandidates) {
      try {
        await api.migrateLegacy({
          id: old.id,
          name: old.name,
          description: old.description,
          avatar: old.avatar,
          avatarColor: old.avatarColor,
          skills: old.skills,
          capabilities: old.capabilities,
          identitySource: old.identitySource ?? '',
          channel: old.channel,
          canonicalSessionId: old.canonicalSessionId,
        });
      } catch {
        // Keep the legacy copy visible and retry on the next explicit refresh;
        // never silently discard a profile because one IPC call raced DB ready.
        migrationPending = true;
      }
    }
    const migratedRows =
      migrationCandidates.length > 0
        ? await api.list({ lastReadAtByBotId: getBotLastReadAtMap() })
        : rows;
    const migratedProfiles = migratedRows
      .map(normalizeDbProfile)
      .filter((item): item is BotProfile => !!item);
    const migratedIds = new Set(migratedProfiles.map((item) => item.id));
    const pendingLegacy = profiles.filter((old) => !migratedIds.has(old.id));
    profiles = migrationPending ? [...migratedProfiles, ...pendingLegacy] : migratedProfiles;
    if (!migrationPending) window.localStorage.setItem(SQLITE_MIGRATION_KEY, '1');
    applyUnreadCounts(migratedRows);
    // A Bot we have never tracked starts read: shipping unread badges must not
    // retroactively mark every existing conversation as unread. Pruning keeps
    // the stored map from growing with deleted Bots.
    const visibleIds = profiles.map((bot) => bot.id);
    seedMissingBotReadState(visibleIds);
    pruneBotReadState(visibleIds);
    emit();
    if (migrationPending) hydrated = false;
  } catch {
    // DB readiness can race the first renderer render during account/bootstrap.
    // The Bots layout explicitly calls refreshBotProfiles when entered, so do
    // not keep polling a signed-out renderer in the background.
    hydrated = false;
  }
}

void hydrateFromDatabase();

export function refreshBotProfiles(): void {
  hydrated = false;
  void hydrateFromDatabase();
}

export async function exportBotBundle(botId: string): Promise<BotBundleExportResult> {
  const api = botsApi();
  if (!api) throw new Error('Bot storage is not ready');
  return api.export({ botId });
}

export async function importBotBundle(): Promise<BotBundleImportResult> {
  const api = botsApi();
  if (!api) throw new Error('Bot storage is not ready');
  const result = await api.import();
  if (!result.canceled && result.botId) {
    const value = await api.get(result.botId);
    const imported = normalizeDbProfile(value);
    if (imported) {
      profiles = [imported, ...profiles.filter((bot) => bot.id !== imported.id)];
      persist();
    }
  }
  return result;
}

export async function getBotHealth(botId: string): Promise<BotHealthReport> {
  const api = botsApi();
  if (!api) throw new Error('Bot storage is not ready');
  return api.health(botId);
}

export async function runBotLifecycleAction(
  request: import('../../../shared/botLifecycle').BotLifecycleActionRequest,
): Promise<import('../../../shared/botLifecycle').BotLifecycleActionResult> {
  const result = await window.electronAPI.maker.runBotLifecycleAction(request);
  const api = botsApi();
  if (result.status === 'deleted') {
    profiles = profiles.filter((bot) => bot.id !== request.botId);
    persist();
    return result;
  }
  if (api) {
    const refreshed = normalizeDbProfile(await api.get(request.botId));
    if (refreshed) {
      profiles = profiles.map((bot) => (bot.id === request.botId ? refreshed : bot));
      persist();
    }
  }
  return result;
}

export function getBotProfiles(): BotProfile[] {
  return profiles;
}

export function subscribeBotProfiles(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBotProfiles(): BotProfile[] {
  return useSyncExternalStore(subscribeBotProfiles, getBotProfiles, getBotProfiles);
}

export function addBotProfile(input: CreateBotProfileInput): BotProfile {
  const now = Date.now();
  const harness = normalizeBotHarness(input.capabilities?.harness);
  const capabilities = {
    ...defaultCapabilities(harness),
    ...(input.capabilities ?? {}),
    harness,
    sessionControlMode: normalizeBotSessionControlMode(input.capabilities?.sessionControlMode),
  };
  const bot: BotProfile = {
    id: `bot_${now}_${Math.random().toString(36).slice(2, 8)}`,
    name: input.name.trim() || 'New Bot',
    // A Bot is always created as a local profile. IM surfaces are mounts, not
    // the Bot's identity/type; the requested channel is attached below.
    channel: 'local',
    description: input.description.trim(),
    identitySource: input.identitySource?.trim() || undefined,
    userContextSource: input.userContextSource?.trim() ?? '',
    avatar: input.avatar?.trim() || '🤖',
    avatarColor: input.avatarColor?.trim() || 'violet',
    enabled: true,
    skills: normalizeStringList(input.skills),
    capabilities,
    createdAt: now,
    // The real canonical Session is created by BotsHomeView after the profile
    // exists. Never create a fake bot-chat-* projection.
    sessions: [],
  };
  profiles = [bot, ...profiles];
  persist();
  return bot;
}

/** Create the local projection and wait until main/SQLite owns the profile. */
export async function addBotProfileAndWait(input: CreateBotProfileInput): Promise<BotProfile> {
  const bot = addBotProfile(input);
  const api = botsApi();
  if (!api) return bot;
  try {
    const created = normalizeDbProfile(
      await api.create({
        id: bot.id,
        name: bot.name,
        description: bot.description,
        avatar: bot.avatar,
        avatarColor: bot.avatarColor,
        skills: bot.skills,
        capabilities: bot.capabilities,
        identitySource: bot.identitySource ?? '',
        userContextSource: bot.userContextSource ?? '',
        eventSubscription: input.eventSubscription,
      }),
    );
    if (!created) throw new Error('Bot profile create returned an invalid profile');
    profiles = profiles.map((item) => (item.id === bot.id ? created : item));
    persist();
    if (input.channel && input.channel !== 'local') {
      await api.upsertChannel({ botId: bot.id, kind: input.channel, enabled: true });
    }
  } catch (error) {
    // The renderer projection is optimistic, but a failed main/SQLite create
    // must not leave a ghost Bot that can never be opened or migrated.
    profiles = profiles.filter((item) => item.id !== bot.id);
    persist();
    throw error;
  }
  return profiles.find((item) => item.id === bot.id) ?? bot;
}

export function updateBotProfile(
  id: string,
  patch: Partial<
    Pick<
      BotProfile,
      | 'name'
      | 'description'
      | 'identitySource'
      | 'userContextSource'
      | 'avatar'
      | 'avatarColor'
      | 'enabled'
      | 'skills'
      | 'capabilities'
      | 'canonicalSessionId'
      | 'sessions'
    >
  >,
): Promise<BotProfile> {
  const previous = profiles;
  profiles = profiles.map((bot) => (bot.id === id ? { ...bot, ...patch } : bot));
  persist();
  const optimistic = profiles.find((bot) => bot.id === id);
  if (!optimistic) return Promise.reject(new Error('Bot not found'));
  const api = botsApi();
  if (!api) return Promise.resolve(optimistic);
  return api
    .update({ id, ...patch, identitySource: patch.identitySource })
    .then((value) => {
      const next = normalizeDbProfile(value);
      if (!next) throw new Error('Bot profile update returned invalid data');
      profiles = profiles.map((bot) => (bot.id === id ? next : bot));
      persist();
      return next;
    })
    .catch((error) => {
      profiles = previous;
      persist();
      throw error;
    });
}

/** Mount or update a message surface without changing the Bot identity. */
export async function upsertBotChannel(
  botId: string,
  kind: BotChannel,
  enabled = true,
  config?: Record<string, unknown>,
  id?: string,
): Promise<void> {
  const api = botsApi();
  if (!api) throw new Error('Bot storage is not ready');
  await api.upsertChannel({ botId, kind, enabled, config, id });
  const refreshed = await api.get(botId);
  const normalized = normalizeDbProfile(refreshed);
  if (normalized) {
    profiles = profiles.map((bot) => (bot.id === botId ? normalized : bot));
    persist();
  }
}

/** Update the durable route map after a user changes a Bot's channel routing. */
export async function upsertBotRoute(
  botId: string,
  input: {
    id?: string;
    channelId: string;
    routeKey: string;
    principalKey?: string;
    scopeKey?: string;
    threadKey?: string;
    projectBindingId?: string;
    capabilities?: Record<string, unknown>;
  },
): Promise<void> {
  const api = botsApi();
  if (!api) throw new Error('Bot storage is not ready');
  const value = await api.upsertRoute({ botId, ...input });
  const normalized = normalizeDbProfile(value);
  if (normalized) {
    profiles = profiles.map((bot) => (bot.id === botId ? normalized : bot));
    persist();
  }
}

/** Pause, resume (offline/unclaimed), or permanently archive a Bot route. */
export async function setBotRouteStatus(
  botId: string,
  routeId: string,
  status: 'paused' | 'offline' | 'archived',
): Promise<void> {
  const api = botsApi();
  if (!api) throw new Error('Bot storage is not ready');
  const value = await api.setRouteStatus({ routeId, status });
  const normalized = normalizeDbProfile(value);
  if (normalized) {
    profiles = profiles.map((bot) => (bot.id === botId ? normalized : bot));
    persist();
  }
}

export async function listBotChannelConnections(): Promise<BotChannelConnection[]> {
  const api = botsApi();
  if (!api) return [];
  const rows = await api.listChannelConnections();
  return rows.filter(
    (item): item is BotChannelConnection =>
      !!item &&
      typeof item === 'object' &&
      typeof item.kind === 'string' &&
      typeof item.id === 'string' &&
      (item.ownership === 'local-adapter' || item.ownership === 'server-relay') &&
      typeof item.status === 'string' &&
      typeof item.connected === 'boolean' &&
      (typeof item.accountKey === 'string' || item.accountKey === null),
  );
}

export async function planBotImMigration(
  botId: string,
  connectionId: string,
): Promise<BotImMigrationPlan> {
  const api = botsApi();
  if (!api) throw new Error('Bot storage is not ready');
  return api.planImMigration({ botId, connectionId });
}

export async function applyBotImMigration(
  botId: string,
  connectionId: string,
  planHash: string,
  requestId: string,
): Promise<BotImMigrationRecord> {
  const api = botsApi();
  if (!api) throw new Error('Bot storage is not ready');
  const result = await api.applyImMigration({ botId, connectionId, planHash, requestId });
  const normalized = normalizeDbProfile(await api.get(botId));
  if (normalized) {
    profiles = profiles.map((bot) => (bot.id === botId ? normalized : bot));
    persist();
  }
  return result;
}

export async function listBotImMigrations(botId: string): Promise<BotImMigrationRecord[]> {
  const api = botsApi();
  if (!api) return [];
  return api.listImMigrations(botId);
}

export async function rollbackBotImMigration(
  botId: string,
  migrationId: string,
): Promise<BotImMigrationRecord> {
  const api = botsApi();
  if (!api) throw new Error('Bot storage is not ready');
  const result = await api.rollbackImMigration({ migrationId });
  const normalized = normalizeDbProfile(await api.get(botId));
  if (!normalized) throw new Error('Bot disappeared after rollback');
  profiles = profiles.map((bot) => (bot.id === botId ? normalized : bot));
  persist();
  return result;
}

export async function upsertBotProjectBinding(
  botId: string,
  input: {
    id?: string;
    workingDir: string;
    remoteHostId?: string | null;
    defaultBranch?: string | null;
    workspacePolicy: BotWorkspacePolicy;
    isDefault: boolean;
    allowedPaths?: string[];
  },
): Promise<void> {
  const api = botsApi();
  if (!api) throw new Error('Bot storage is not ready');
  const value = await api.upsertProjectBinding({ botId, ...input });
  const normalized = normalizeDbProfile(value);
  if (normalized) {
    profiles = profiles.map((bot) => (bot.id === botId ? normalized : bot));
    persist();
  }
}

export async function archiveBotProjectBinding(botId: string, id: string): Promise<void> {
  const api = botsApi();
  if (!api) throw new Error('Bot storage is not ready');
  const value = await api.archiveProjectBinding({ botId, id });
  const normalized = normalizeDbProfile(value);
  if (normalized) {
    profiles = profiles.map((bot) => (bot.id === botId ? normalized : bot));
    persist();
  }
}

export async function releaseBotWorkspaceLease(
  botId: string,
  leaseId: string,
  expectedGeneration: number,
): Promise<void> {
  const api = botsApi();
  if (!api) throw new Error('Bot storage is not ready');
  const value = await api.releaseWorkspaceLease({ botId, leaseId, expectedGeneration });
  const normalized = normalizeDbProfile(value);
  if (normalized) {
    profiles = profiles.map((bot) => (bot.id === botId ? normalized : bot));
    persist();
  }
}

/**
 * Move the previous canonical Session into the Bot history projection and make
 * the supplied Session the new canonical chat. The real transcript remains in
 * the shared sessions/messages tables; this projection only owns Bot navigation.
 */
export function setCanonicalBotSession(
  botId: string,
  session: Pick<BotSessionProjection, 'id' | 'title' | 'updatedAt'>,
): void {
  profiles = profiles.map((bot) => {
    if (bot.id !== botId) return bot;
    const previousId = bot.canonicalSessionId;
    const current = bot.sessions.find((item) => item.id === session.id);
    if (
      previousId === session.id &&
      current?.kind === 'chat' &&
      current.status === 'active' &&
      current.title === session.title
    ) {
      return bot;
    }
    const history = bot.sessions
      .filter((item) => item.id !== session.id)
      .map((item) =>
        item.id === previousId
          ? { ...item, kind: 'history' as const, status: 'archived' as const }
          : item,
      );
    return {
      ...bot,
      canonicalSessionId: session.id,
      sessions: [
        {
          id: session.id,
          title: session.title,
          kind: 'chat' as const,
          channel: bot.channel,
          updatedAt: session.updatedAt,
          status: 'active' as const,
        },
        ...history,
      ],
    };
  });
  persist();
}

export function markBotSessionArchived(
  botId: string,
  sessionId: string,
  updatedAt = Date.now(),
): void {
  profiles = profiles.map((bot) =>
    bot.id === botId
      ? {
          ...bot,
          sessions: bot.sessions.map((item) =>
            item.id === sessionId
              ? { ...item, kind: 'history' as const, status: 'archived' as const, updatedAt }
              : item,
          ),
        }
      : bot,
  );
  persist();
  const api = botsApi();
  if (api) void api.linkSession({ botId, sessionId, role: 'history' }).catch(() => undefined);
}

export function removeBotProfile(id: string): void {
  profiles = profiles.filter((bot) => bot.id !== id);
  persist();
}
