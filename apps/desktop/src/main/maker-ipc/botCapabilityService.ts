import { assertTaskActionCurrent, captureTaskActionSyncGuard, hasTaskActionAuthorization } from './taskActionAuthorization.js';
import { inspectTeammateModelChoices, changeAppDefaultModel } from './appDefaultModelControl.js';
import path from 'node:path';
import { hostname } from 'node:os';
import { realpath } from 'node:fs/promises';
import { readBoundedFileNoFollow } from '../utils/readBoundedFile.js';
import { teammateWorkspaceDir } from './botProjectMemory.js';
import { teammateProfilePatch, teammateGroupRequest, type BotCapabilityCallbacks, type BotControlState, type TeammateGroupRequest, type TeammateGroupBinding, type TeammateVoiceRequest } from '@cindy/mcps';
import { and, eq } from 'drizzle-orm';
import { botProfiles, botProfileVersions, botSessionLinks, sessions } from '../localDb/schema.js';
import { getDbClient } from '../localDb/client/current.js';
import { BOT_AVATAR_MAX_BYTES, validateBotAvatarBuffer } from '../localDb/ipc/botAvatarSelection.js';
import { setBotProfileAvatar, updateBotProfile } from '../localDb/ipc/bots.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { listCustomMcpServers } from '../maker-host/custom-mcp-store.desktop.js';
import { normalizeBotToolCapabilities } from '../../shared/botCapabilitySelection.js';
import { readBotProjectMode } from '../../shared/botProjectMode.js';
import { BOT_BASELINE_PLUGIN_IDS } from '../maker-host/plugins/types.js';
import type { AgentKind, EngineKind, Maker } from '@cindy/maker-core';
import type { PluginRegistry } from '../maker-host/plugins/plugin-registry.js';
import type { BotToolsetContext } from '../../shared/botRemoteCapabilities.js';
import type { BotProfileRuntimeDeps } from './botProfileRuntime.js';
import type { BotModelRoute } from '../../shared/botModelChain.js';
import { readEffectiveBotModelChain, readExplicitBotModelChain } from '../maker-host/bot-model-chain-settings-store.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { joinSharedSkillPreparation } from '../skillhub/sharedSkillPreparation.js';

type Kind = 'skill' | 'mcp' | 'toolset';
type Input = { callerSessionId: string; kind: Kind | 'feature' };
type Entry = { id: string; name: string; description: string; available: boolean; joined: boolean; cindyOfficial?: boolean };
export interface BotCapabilityServiceDeps {
  iMessageGroup?(botId: string, request: TeammateGroupRequest, assertCurrent: () => void, authorize: (match: TeammateGroupBinding, replyMode: string) => Promise<boolean>): Promise<TeammateGroupBinding[]>;
  confirmGroupAccess?(sessionId: string, input: { group: string; name: string; teammate: string; connectionRef: string; replyMode: string }): Promise<boolean>;
  isOwnerInput?(sessionId: string): boolean;
  markOfficialSkills?: <T extends { path?: string }>(skills: readonly T[], remoteHostId?: string) => Promise<Array<T & { cindyOfficial: boolean }>>;
  readConversationConnections?(botId: string): Promise<NonNullable<BotControlState['conversations']>['connections']>;
  getMaker: () => Pick<Maker, 'listAgentSkills'>;
  /**
   * Joins the shared Skill preparation before the Skill catalog is listed. Creation and
   * settings read it before any Agent launches; startup only warms the preparation up.
   */
  prepareSharedSkills?: () => Promise<void>;
  resolveBotAgentKind: (sessionId: string, modelChain?: BotModelRoute[]) => Promise<EngineKind | null>;
  getPluginRegistry: () => Pick<PluginRegistry, 'getPlugins' | 'getEnableState'>;
  isBotToolsetAvailable: (input: BotToolsetContext & { toolsetId: string }) => boolean;
  listMcpServers: NonNullable<BotProfileRuntimeDeps['listMcpServers']>;
}
export interface BotCapabilityUpdate {
  botId: string;
  canonicalSessionId: string | null;
  previous: Record<string, unknown>;
  next: Record<string, unknown>;
}
const fields: Record<Kind, { list: string; mode: string }> = {
  skill: { list: 'skills', mode: 'skillMode' },
  mcp: { list: 'mcpServers', mode: 'mcpMode' },
  toolset: { list: 'toolsets', mode: 'toolsetMode' },
};
/** `kind=feature`: this teammate's own switches (only memory; the V1 system Skills were removed). */
const FEATURES: { id: 'memory'; name: string; description: string }[] = [
  { id: 'memory', name: '记忆', description: '记住主人的偏好与背景；关闭后不读也不存记忆。' },
];
function featureEntries(config: Record<string, unknown>): Entry[] {
  return FEATURES.map((item) => ({ ...item, available: true, joined: config.memory !== false }));
}
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/** Any of the teammate's own chats manages it, like a task in its project; no caller-supplied Bot or connection config. */
async function context(callerSessionId: string, opts?: { allowPaused?: boolean }) {
  const owner = activeOwnerScopeKey();
  const assertOwner = () => {
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner)
      throw new Error('账号正在切换，请重试');
  };
  assertOwner();
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({
      botId: botProfiles.id,
      displayName: botProfiles.displayName,
      avatar: botProfiles.avatar,
      description: botProfiles.description,
      identitySource: botProfileVersions.identitySource,
      version: botProfiles.currentVersion,
      profileStatus: botProfiles.status,
      canonicalSessionId: botProfiles.canonicalSessionId,
      role: botSessionLinks.role,
      archivedAt: botSessionLinks.archivedAt,
      sessionStatus: sessions.status,
      source: sessions.source,
      workingDir: sessions.workingDir,
      remoteHostId: sessions.remoteHostId,
      permissionMode: sessions.permissionMode,
      config: botProfileVersions.capabilitiesJson,
    })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
    .innerJoin(
      botProfileVersions,
      and(
        eq(botProfileVersions.botId, botProfiles.id),
        eq(botProfileVersions.version, botProfiles.currentVersion),
      ),
    )
    .where(eq(botSessionLinks.sessionId, callerSessionId))
    .limit(1);
  assertOwner();
  const profileAllowed =
    row?.profileStatus === 'active' ||
    (opts?.allowPaused === true && row?.profileStatus === 'paused');
  if (
    !row ||
    row.source !== 'bot' ||
    row.archivedAt !== null ||
    row.sessionStatus !== 'active' ||
    !profileAllowed
  ) {
    throw new Error('只有当前伙伴主任务可以管理自己的能力');
  }
  const parsed: unknown = JSON.parse(row.config);
  const config =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return { ...row, config: normalizeBotToolCapabilities(config), assertOwner, refresh: async () => {
    assertOwner();
  } };
}

async function ownProject(ctx: Awaited<ReturnType<typeof context>>, callerSessionId: string) {
  if (ctx.canonicalSessionId !== callerSessionId || ctx.remoteHostId || !readBotProjectMode(ctx.config)) throw new Error('PROJECT_UNAVAILABLE');
  const root = await realpath(ownerScopedUserDataPath());
  const workspace = teammateWorkspaceDir(root, ctx.botId);
  if (await realpath(workspace) !== workspace) throw new Error('PROJECT_UNAVAILABLE');
  ctx.assertOwner();
  return workspace;
}

async function projectDocument(workspace: string, filename: 'profile.json' | 'imessage.json') {
  const raw = await readBoundedFileNoFollow(path.join(workspace, '.cindy', 'settings', filename), 128 * 1024,
    { containWithin: workspace, nonBlocking: true, rejectHardLinks: true, verifyContentStability: true });
  try { return JSON.parse(raw?.toString('utf8') ?? 'null') as unknown; } catch { return null; }
}

async function catalog(input: { callerSessionId: string; kind: Kind }, ctx: Pick<Awaited<ReturnType<typeof context>>, 'config' | 'workingDir' | 'remoteHostId' | 'botId' | 'assertOwner'>, deps: BotCapabilityServiceDeps,
  options?: { modelChain?: BotModelRoute[]; forceReload?: boolean; agentKind?: EngineKind }): Promise<Entry[]> {
  const joined = new Set(strings(ctx.config[fields[input.kind].list]).filter(
    (id) => input.kind !== 'toolset' || !BOT_BASELINE_PLUGIN_IDS.has(id),
  ));
  const { getMaker, getPluginRegistry, isBotToolsetAvailable } = deps;
  // Grants apply next turn, so use the same preview as settings and send-time reconciliation.
  const resolvedKind = options?.agentKind ?? await deps.resolveBotAgentKind(input.callerSessionId, options?.modelChain);
  ctx.assertOwner();
  if (!resolvedKind) throw new Error('Bot next-turn route is unavailable');
  const agentKind: AgentKind = resolvedKind === 'acp' ? 'pi' : resolvedKind;
  const workingDir = ctx.workingDir ?? '';
  let items: Omit<Entry, 'joined'>[];
  if (input.kind === 'skill') {
    await joinSharedSkillPreparation(deps.prepareSharedSkills, 'bot-capability');
    const result = await getMaker().listAgentSkills(agentKind, {
      workingDir,
      remoteHostId: ctx.remoteHostId ?? undefined,
      ...(options?.forceReload ? { forceReload: true } : {}),
    });
    const skills = deps.markOfficialSkills
      ? await deps.markOfficialSkills(result.skills, ctx.remoteHostId ?? undefined) : result.skills;
    // Resolve namesakes like the runtime: the last entry wins, except that an
    // active Cindy official Skill keeps the name.
    const byName = new Map<string, Omit<Entry, 'joined'>>();
    for (const skill of skills) {
      const entry = {
        cindyOfficial: skill.cindyOfficial === true,
        id: skill.name,
        name: skill.name,
        description: skill.description ?? '',
        available: skill.enabled !== false && skill.runtimeStatus !== 'failed',
      };
      const kept = byName.get(entry.id);
      if (kept?.cindyOfficial && kept.available && !entry.cindyOfficial) continue;
      byName.set(entry.id, entry);
    }
    items = [...byName.values()];
  } else if (input.kind === 'mcp') {
    const runtimeCatalog = await deps.listMcpServers({
      agentKind, workingDir, remoteHostId: ctx.remoteHostId ?? undefined,
    });
    const available = new Set(runtimeCatalog
      .filter((entry) => entry.source === 'custom' && entry.available !== false)
      .map((entry) => entry.name));
    const harness = runtimeCatalog.filter((entry) => entry.source === 'harness');
    // Legacy collisions remain in custom settings, but cannot replace or duplicate
    // the engine-owned capability in this selection list.
    // Project only display metadata. URLs, headers and tokens never enter tool results.
    items = (await listCustomMcpServers()).filter((mcp) => !harness.some((entry) => entry.name === mcp.id)).map((mcp) => ({
      id: mcp.id,
      name: mcp.name,
      description: mcp.transport,
      available: available.has(mcp.id),
    }));
    items.push(...harness.map((entry) => ({
      id: entry.name, name: entry.name,
      description: 'Engine-provided connectors; not Cindy tasks, routines or plugins.',
      available: entry.available !== false,
    })));
  } else {
    const registry = getPluginRegistry();
    items = await Promise.all(
      registry
        .getPlugins()
        .filter((plugin) => !BOT_BASELINE_PLUGIN_IDS.has(plugin.id))
        .map(async (plugin) => ({
          id: plugin.id,
          name: plugin.name,
          description: plugin.description,
          available:
            (await registry.getEnableState(plugin.id, workingDir)).effectiveEnabled &&
            isBotToolsetAvailable({
              botId: ctx.botId,
              workingDir,
              agentKind,
              remoteHostId: ctx.remoteHostId,
              toolsetId: plugin.id,
            }),
        })),
    );
  }
  ctx.assertOwner();
  // V2: every session of the teammate has everything here; there is no selection.
  const inherit = readBotProjectMode(ctx.config)
    || (input.kind !== 'skill' && ctx.config[fields[input.kind].mode] === 'inherit');
  const result = items.map((item) => ({ ...item, joined: item.cindyOfficial ? item.available : joined.has(item.id) || (inherit && item.available) }));
  // Uninstalled references remain removable, instead of silently disappearing.
  for (const id of joined)
    if (!result.some((item) => item.id === id))
      result.push({ id, name: id, description: '', available: false, joined: true });
  return result;
}

async function findBotCapabilities(input: Input & { query?: string }, deps: BotCapabilityServiceDeps) {
  try {
    const ctx = await context(input.callerSessionId);
    const query = input.query?.trim().toLocaleLowerCase() ?? '';
    const entries = input.kind === 'feature' ? featureEntries(ctx.config) : await catalog({ ...input, kind: input.kind }, ctx, deps);
    const capabilities = entries.filter(
      (item) =>
        !query || `${item.id} ${item.name} ${item.description}`.toLocaleLowerCase().includes(query),
    );
    await ctx.refresh();
    return { ok: true as const, capabilities: capabilities.slice(0, 50) };
  } catch (error) {
    return {
      ok: false as const,
      errorCode: 'CAPABILITY_DISCOVERY_FAILED',
      message: '无法读取当前伙伴的能力目录，请稍后重试',
    };
  }
}

async function selectBotCapability(input: Input & { id: string; joined: boolean }, deps: BotCapabilityServiceDeps) {
  try {
    const ctx = await context(input.callerSessionId);
    if (input.kind === 'feature') {
      if (input.id !== 'memory') {
        return { ok: false as const, errorCode: 'CAPABILITY_UNAVAILABLE', message: '没有这项功能；可选 memory' };
      }
      ctx.assertOwner();
      await updateBotProfile({ id: ctx.botId, capabilities: { memory: input.joined } }, ctx.version);
      ctx.assertOwner();
      return { ok: true as const, joined: input.joined, effective: 'next-turn' as const };
    }
    const kind = input.kind;
    if (readBotProjectMode(ctx.config)) {
      return {
        ok: false as const,
        errorCode: 'CAPABILITY_NOT_SELECTABLE',
        message: '伙伴的每个对话都能用这台电脑上已有的工具、MCP 与技能，无需加入或移除；要给自己加技能，写进项目的 .agents/skills/',
      };
    }
    if (kind === 'toolset' && BOT_BASELINE_PLUGIN_IDS.has(input.id)) {
      return {
        ok: false as const,
        errorCode: 'CAPABILITY_NOT_SELECTABLE',
        message: '该工具集是伙伴固定能力，无需加入且不能移除',
      };
    }
    if (kind === 'skill') {
      const item = (await catalog({ ...input, kind }, ctx, deps)).find(entry => entry.id === input.id);
      if (item?.cindyOfficial) return {
        ok: false as const, errorCode: 'CAPABILITY_NOT_SELECTABLE',
        message: 'Cindy 官方技能跟随本机的启停设置，无需为伙伴单独加入或移除。',
      };
    }
    const field = fields[kind];
    const previous = kind !== 'skill' && ctx.config[field.mode] === 'inherit'
      ? (await catalog({ ...input, kind }, ctx, deps)).filter((item) => item.joined).map((item) => item.id)
      : strings(ctx.config[field.list]);
    if (input.joined) {
      const item = (await catalog({ ...input, kind }, ctx, deps, { forceReload: true })).find((entry) => entry.id === input.id);
      if (!item?.available)
        return {
          ok: false as const,
          errorCode: 'CAPABILITY_UNAVAILABLE',
          // Weaker models guess kind=skill for memory; point them at the right switch.
          message: !item && FEATURES.some((feature) => feature.id === input.id)
            ? `${input.id} 是伙伴自己的功能开关，请改用 kind=feature`
            : '该能力未安装、已停用或当前运行引擎不可用',
        };
    }
    ctx.assertOwner();
    const selected = input.joined
      ? [...new Set([...previous, input.id])]
      : previous.filter((id) => id !== input.id);
    await updateBotProfile(
      { id: ctx.botId, capabilities: { [field.list]: selected, [field.mode]: 'allowlist' } },
      ctx.version,
    );
    ctx.assertOwner();
    return { ok: true as const, joined: input.joined, effective: 'next-turn' as const };
  } catch (error) {
    return {
      ok: false as const,
      errorCode: 'CAPABILITY_SELECTION_FAILED',
      message: '伙伴状态或配置已变化，请重新查询后重试',
    };
  }
}

/** Host callbacks are bound at initialization, without importing the host singleton. */
export function createBotCapabilityService(deps: BotCapabilityServiceDeps) {
  return {
    async models(input: { callerSessionId: string }) {
      try {
        const ctx = await context(input.callerSessionId);
        // A teammate may also run on this computer's plugin engines; those choices are marked
        // teammateOnly and are refused as the application default.
        const selection = await inspectTeammateModelChoices();
        await ctx.refresh();
        return { ok: true as const, ...selection };
      } catch (error) {
        return { ok: false as const, errorCode: 'MODEL_SETTINGS_UNAVAILABLE', message: '无法读取当前用户的默认模型和可用型号' };
      }
    },
    async setDefaultModel(input: { callerSessionId: string; id: string; effort?: string; fastMode?: boolean | 'ultrafast' }) {
      try {
        const ctx = await context(input.callerSessionId);
        const result = await changeAppDefaultModel(input.id, input.effort, async () => { await ctx.refresh(); ctx.assertOwner(); await assertTaskActionCurrent(); }, input.fastMode);
        ctx.assertOwner();
        return { ok: true as const, ...result };
      } catch (error) {
        return { ok: false as const, errorCode: 'MODEL_DEFAULT_NOT_CONFIRMED', message: '默认模型未确认保存；型号可能已停用、账号或选择已变化，请重新查询当前设置。' };
      }
    },
    async inspect(input: { callerSessionId: string }) {
      try {
        const ctx = await context(input.callerSessionId);
        const explicit = readExplicitBotModelChain(ctx.config);
        const candidates = await readEffectiveBotModelChain(ctx.config);
        const privateConversation = ctx.canonicalSessionId === input.callerSessionId && !ctx.remoteHostId;
        const conversations: BotControlState['conversations'] = {
          scope: 'local',
          teammateId: ctx.botId,
          connections: privateConversation ? await deps.readConversationConnections?.(ctx.botId) ?? [] : [],
          connectionsAvailable: Boolean(deps.readConversationConnections),
          guidance: 'Recall a topic with search_chat_history(query, teammate_id=teammateId), without a workdir or creation-date filter. list_sessions(teammate_id=teammateId, time_field=activity) includes old active, archived and topic/channel chats. Read matching originals with get_chat_history. If no match, existing account-history permission permits a bounded topic search without teammate_id for unlinked legacy records; report companion=null as unverified ownership, never infer it from a current connection, name or directory. device=all queries online authorized computers; unavailable/older devices and capped results are incomplete coverage.',
        };
        await ctx.refresh();
        const state: BotControlState = {
          ...(privateConversation ? { conversations, settings: {
            directory: readBotProjectMode(ctx.config) ? '.cindy/settings' : null,
            device: hostname(), permissionMode: ctx.permissionMode, permissionAuthority: 'host' as const,
          } } : {}),
          profile: { id: ctx.botId, name: ctx.displayName, description: ctx.description,
            identitySource: ctx.identitySource, version: ctx.version, avatar: ctx.avatar,
            ...(privateConversation && deps.isOwnerInput?.(input.callerSessionId)
              ? { userContextSource: typeof ctx.config.userContextSource === 'string' ? ctx.config.userContextSource : '' } : {}) },
          session: { id: input.callerSessionId, workingDir: ctx.workingDir, remoteHostId: ctx.remoteHostId },
          model: { source: explicit === null ? 'default' : 'override', candidates },
          memory: { enabled: ctx.config.memory !== false, scope: 'self' },
          references: { skills: strings(ctx.config.skills), mcpServers: strings(ctx.config.mcpServers),
            toolsets: strings(ctx.config.toolsets) },
        };
        return { ok: true as const, state };
      } catch (error) {
        return { ok: false as const, errorCode: 'BOT_STATE_UNAVAILABLE', message: '无法读取当前伙伴状态，请稍后重试' };
      }
    },
    async removePersonalSkill(input: { callerSessionId: string; slug: string }) {
      try {
        const ctx = await context(input.callerSessionId);
        const workspace = await ownProject(ctx, input.callerSessionId);
        const guard = captureTaskActionSyncGuard();
        if (!guard || !hasTaskActionAuthorization(input.callerSessionId)) throw new Error('OWNER_REQUEST_REQUIRED');
        const { removeProjectPersonalSkill } = await import('./botProjectTemplate.js');
        await assertTaskActionCurrent();
        const changed = await removeProjectPersonalSkill(workspace, input.slug, () => {
          ctx.assertOwner();
          guard();
          if (!deps.isOwnerInput?.(input.callerSessionId)) throw new Error('OWNER_REQUEST_REQUIRED');
        });
        if (changed) {
          const { requestBotRuntimeEpochRefresh } = await import('./botRuntimeEpochRefreshSignal.js');
          await requestBotRuntimeEpochRefresh(input.callerSessionId, 'resource');
        }
        ctx.assertOwner();
        return { ok: true as const, changed };
      } catch {
        return { ok: false as const, errorCode: 'PERSONAL_SKILL_UNCONFIRMED', message: '请在伙伴主对话核实个人技能名称、归属和启用状态' };
      }
    },
    async restoreStandard(input: { callerSessionId: string }) {
      try {
        const ctx = await context(input.callerSessionId);
        const workspace = await ownProject(ctx, input.callerSessionId);
        const { ensureTeammateTemplate } = await import('./botProjectMode.js');
        ctx.assertOwner();
        const changed = await ensureTeammateTemplate({ workspace, botId: ctx.botId, displayName: ctx.displayName });
        ctx.assertOwner();
        return { ok: true as const, changed };
      } catch {
        return { ok: false as const, errorCode: 'STANDARD_REPAIR_UNCONFIRMED', message: '请在伙伴主对话查看项目标准技能及其启用状态' };
      }
    },
    async voice(input: { callerSessionId: string; request: TeammateVoiceRequest }) {
      try {
        const ctx = await context(input.callerSessionId);
        const api = (await import('../voice-conversation/index.js')).getVoiceSettingsHostApi();
        ctx.assertOwner();
        if (ctx.remoteHostId || ctx.canonicalSessionId !== input.callerSessionId || !api) throw new Error('VOICE_UNAVAILABLE');
        const request = input.request;
        if (request.action === 'voices') {
          const voices = await api.voices(request.route);
          ctx.assertOwner();
          return { ok: true as const, result: voices };
        }
        if (request.action === 'apply') {
          if (request.selection === undefined && request.sentencePlayback === undefined) throw new Error('EMPTY_PATCH');
          await api.setPreference(ctx.botId, request.selection, request.sentencePlayback, request.revision);
          ctx.assertOwner();
        }
        const preference = await api.selfPreference(ctx.botId);
        ctx.assertOwner();
        return { ok: true as const, result: { preference, models: api.models() } };
      } catch {
        return { ok: false as const, errorCode: 'VOICE_PREFERENCE_UNCONFIRMED', message: '请重新读取本机音色设置和可用型号后重试' };
      }
    },
    async iMessageGroup(input: Parameters<NonNullable<BotCapabilityCallbacks['iMessageGroup']>>[0]) {
      try {
        const ctx = await context(input.callerSessionId);
        const guard = captureTaskActionSyncGuard();
        if (ctx.canonicalSessionId !== input.callerSessionId || ctx.remoteHostId || !deps.iMessageGroup
          || !hasTaskActionAuthorization(input.callerSessionId) || !guard) throw new Error('OWNER_REQUEST_REQUIRED');
        const assertCurrent = () => {
          ctx.assertOwner();
          guard();
          if (!deps.isOwnerInput?.(input.callerSessionId)) throw new Error('OWNER_REQUEST_REQUIRED');
        };
        await assertTaskActionCurrent();
        assertCurrent();
        let request = input.request;
        if (request.action === 'applyFromProject') {
          const workspace = await ownProject(ctx, input.callerSessionId);
          const saved = teammateGroupRequest.safeParse(await projectDocument(workspace, 'imessage.json'));
          if (!saved.success || saved.data.action !== 'apply' || saved.data.revision !== request.revision)
            throw new Error('INVALID_PROJECT_SETTINGS');
          request = saved.data;
          assertCurrent();
        }
        const groups = await deps.iMessageGroup(ctx.botId, request, assertCurrent, async (match, replyMode) => {
          assertCurrent();
          return await deps.confirmGroupAccess?.(input.callerSessionId, { group: match.group, name: match.name,
            teammate: ctx.displayName, connectionRef: match.connectionRef, replyMode }) ?? false;
        });
        assertCurrent();
        return { ok: true as const, groups };
      } catch (error) {
        const code = error instanceof Error && /^(?:BLUEBUBBLES_(SERVER|CHAT|CALLBACK)_([A-Z_0-9]+)|GROUP_ROUTE_CHANGED|GROUP_BUSY|GROUP_HAS_TASK_BINDING|GROUP_ACCESS_NOT_GRANTED|GROUP_RECIPIENT_UNAVAILABLE|INVALID_PROJECT_SETTINGS|GROUP_NOT_CONNECTED|OWNER_REQUEST_REQUIRED)$/.test(error.message)
          ? error.message : 'IMESSAGE_ROUTE_UNCONFIRMED';
        return { ok: false as const, errorCode: code, message: `iMessage 群配置未确认（${code}）。请重新检查连接和该群的归属。` };
      }
    },
    async updateProfile(input: Parameters<NonNullable<BotCapabilityCallbacks['updateProfile']>>[0]) {
      try {
        const ctx = await context(input.callerSessionId);
        if (ctx.version !== input.expectedVersion) throw new Error('Profile changed');
        if (input.fromProject) {
          const workspace = await ownProject(ctx, input.callerSessionId);
          const parsed = teammateProfilePatch.safeParse(await projectDocument(workspace, 'profile.json'));
          ctx.assertOwner();
          if (!parsed.success || parsed.data.expectedVersion !== ctx.version || Object.keys(parsed.data).length < 2) {
            return { ok: false as const, errorCode: 'INVALID_PROJECT_SETTINGS', message: '请核对 profile.json 中的字段和伙伴资料版本' };
          }
          input = { callerSessionId: input.callerSessionId, ...parsed.data };
        }
        if (input.userContextSource !== undefined && ctx.canonicalSessionId !== input.callerSessionId)
          throw new Error('Owner conversation required');
        if (input.avatar !== undefined || input.avatarFile !== undefined || input.expectedAvatar !== undefined) {
          if (input.expectedAvatar !== ctx.avatar || (input.avatar === undefined) === (input.avatarFile === undefined))
            throw new Error('Avatar changed');
          if (input.avatarFile) {
            if (Object.keys(input).length !== 4) throw new Error('Apply the image separately');
            const workspace = await ownProject(ctx, input.callerSessionId);
            const bytes = await readBoundedFileNoFollow(path.join(workspace, '.cindy', 'settings', input.avatarFile), BOT_AVATAR_MAX_BYTES,
              { containWithin: workspace, nonBlocking: true, rejectHardLinks: true, verifyContentStability: true });
            if (!bytes) throw new Error('Invalid image');
            ctx.assertOwner();
            await setBotProfileAvatar(ctx.botId, { buffer: bytes, mimeType: validateBotAvatarBuffer(bytes) }, input.expectedVersion, input.expectedAvatar);
            ctx.assertOwner();
            return { ok: true as const, effective: 'next-turn' as const };
          }
        }
        let modelChain: BotModelRoute[] | null | undefined;
        if (input.modelChain === null) modelChain = null;
        else if (input.modelChain !== undefined) {
          const { available } = await inspectTeammateModelChoices();
          ctx.assertOwner();
          if (!input.modelChain.length || input.modelChain.length > 5) throw new Error('Invalid model chain');
          const seen = new Set<string>();
          modelChain = input.modelChain.map(selection => {
            const choice = available.find(item => item.id === selection.id);
            if (!choice || seen.has(selection.id)
              || (selection.effort !== undefined && selection.effort !== '' && !choice.efforts.some(effort => effort === selection.effort))
              || (selection.fastMode && (!choice.supportsFastMode || (selection.fastMode === 'ultrafast' && !choice.supportsUltrafastMode)))) {
              throw new Error('Model route or settings are unavailable');
            }
            seen.add(selection.id);
            return { ...choice.route,
              ...(selection.effort !== undefined ? { effort: selection.effort } : {}),
              ...(selection.fastMode !== undefined ? { fastMode: selection.fastMode } : {}),
            };
          });
        }
        ctx.assertOwner();
        await updateBotProfile({ id: ctx.botId,
          // Supplying a model selection explicitly accepts it even when its
          // value is unchanged; unrelated profile edits retain automation state.
          ...(modelChain !== undefined ? { acceptSavedModelSelectionVersion: input.expectedVersion } : {}),
          ...(input.avatar !== undefined ? { avatar: input.avatar, expectedAvatar: input.expectedAvatar } : {}),
          ...(input.userContextSource !== undefined ? { userContextSource: input.userContextSource } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.identitySource !== undefined ? { identitySource: input.identitySource } : {}),
          ...(modelChain !== undefined ? { capabilities: {
            modelChainOverride: modelChain, modelOverride: null,
          } } : {}),
        }, input.expectedVersion);
        ctx.assertOwner();
        return { ok: true as const, effective: 'next-turn' as const };
      } catch (error) {
        return { ok: false as const, errorCode: 'BOT_PROFILE_UPDATE_FAILED',
          message: '伙伴资料已变化，或所选模型及档位不可用；请重新读取伙伴状态和可用型号后重试' };
      }
    },
    /** Read the same metadata before a profile exists; this never joins or executes a capability. */
    async forCreation(input: { botId: string; workingDir: string; agentKind: EngineKind; assertOwner: () => void }) {
      const ctx = { ...input, remoteHostId: null, config: normalizeBotToolCapabilities({}) };
      const result = {} as Record<Kind, Entry[]>;
      for (const kind of ['skill', 'mcp', 'toolset'] as const)
        result[kind] = (await catalog({ callerSessionId: '', kind }, ctx, deps, { agentKind: input.agentKind })).filter(entry => entry.available);
      return result;
    },
    list: (input: Input & { query?: string }) => findBotCapabilities(input, deps),
    /** Settings use the complete catalog, including removable unavailable references. */
    async forSettings(input: { callerSessionId: string; kind: Kind }) {
      const ctx = await context(input.callerSessionId, { allowPaused: true });
      return catalog(input, ctx, deps);
    },
    select: (input: Input & { id: string; joined: boolean }) => selectBotCapability(input, deps),
    /** Renderer saves may contain stale selections; validate only new references before persistence. */
    async validateAdditions(update: BotCapabilityUpdate): Promise<void> {
      const additions = (Object.keys(fields) as Kind[]).map((kind) => {
        const field = fields[kind].list;
        const previous = new Set(strings(update.previous[field]));
        return { kind, ids: strings(update.next[field]).filter((id) => !previous.has(id)) };
      }).filter((entry) => entry.ids.length > 0);
      if (additions.length === 0) return;
      try {
        if (!update.canonicalSessionId) throw new Error('Missing canonical task');
        // Settings remain editable while paused; model-initiated list/select stay active-only.
        const ctx = await context(update.canonicalSessionId, { allowPaused: true });
        if (ctx.botId !== update.botId) throw new Error('Canonical task owner mismatch');
        const modelChain = await readEffectiveBotModelChain(update.next);
        for (const { kind, ids } of additions) {
          const entries = await catalog({ callerSessionId: update.canonicalSessionId, kind }, ctx, deps,
            { modelChain, forceReload: true });
          if (ids.some((id) => !entries.some((entry) => entry.id === id && entry.available))) {
            throw new Error('Capability unavailable');
          }
        }
        ctx.assertOwner();
      } catch {
        throwIpcError('PRECONDITION_FAILED', '所选能力已不可用或伙伴状态已变化，请刷新后重试');
      }
    },
  };
}

