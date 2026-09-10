import { and, eq } from 'drizzle-orm';
import { botProfiles, botProfileVersions, botSessionLinks, sessions } from '../localDb/schema.js';
import { getDbClient } from '../localDb/client/current.js';
import { updateBotProfile } from '../localDb/ipc/bots.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { listCustomMcpServers } from '../maker-host/custom-mcp-store.js';
import { BOT_BASELINE_PLUGIN_IDS } from '../maker-host/plugins/types.js';
import type { AgentKind, Maker } from '@cindy/maker-core';
import type { PluginRegistry } from '../maker-host/plugins/plugin-registry.js';
import type { BotToolsetContext } from '../../shared/botRemoteCapabilities.js';
import type { BotProfileRuntimeDeps } from './botProfileRuntime.js';
import type { BotModelRoute } from '../../shared/botModelChain.js';
import { readEffectiveBotModelChain } from '../maker-host/bot-model-chain-settings-store.js';
import { throwIpcError } from '../utils/ipcValidate.js';

type Kind = 'skill' | 'mcp' | 'toolset';
type Input = { callerSessionId: string; kind: Kind };
type Entry = { id: string; name: string; description: string; available: boolean; joined: boolean };
export interface BotCapabilityServiceDeps {
  getMaker: () => Pick<Maker, 'listAgentSkills'>;
  resolveBotAgentKind: (sessionId: string, modelChain?: BotModelRoute[]) => Promise<AgentKind | null>;
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
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/** Only the live owner may select capabilities; no caller-supplied Bot or connection config. */
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
      version: botProfiles.currentVersion,
      profileStatus: botProfiles.status,
      canonicalSessionId: botProfiles.canonicalSessionId,
      role: botSessionLinks.role,
      archivedAt: botSessionLinks.archivedAt,
      sessionStatus: sessions.status,
      source: sessions.source,
      workingDir: sessions.workingDir,
      remoteHostId: sessions.remoteHostId,
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
    row.role !== 'canonical' ||
    row.canonicalSessionId !== callerSessionId ||
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
  return { ...row, config, assertOwner };
}

async function catalog(input: Input, ctx: Awaited<ReturnType<typeof context>>, deps: BotCapabilityServiceDeps,
  options?: { modelChain?: BotModelRoute[]; forceReload?: boolean }): Promise<Entry[]> {
  const joined = new Set(strings(ctx.config[fields[input.kind].list]).filter(
    (id) => input.kind !== 'toolset' || !BOT_BASELINE_PLUGIN_IDS.has(id),
  ));
  const { getMaker, getPluginRegistry, isBotToolsetAvailable } = deps;
  // Grants apply next turn, so use the same preview as settings and send-time reconciliation.
  const agentKind = await deps.resolveBotAgentKind(input.callerSessionId, options?.modelChain);
  ctx.assertOwner();
  if (!agentKind) throw new Error('Bot next-turn route is unavailable');
  const workingDir = ctx.workingDir ?? '';
  let items: Omit<Entry, 'joined'>[];
  if (input.kind === 'skill') {
    const result = await getMaker().listAgentSkills(agentKind, {
      workingDir,
      remoteHostId: ctx.remoteHostId ?? undefined,
      ...(options?.forceReload ? { forceReload: true } : {}),
    });
    items = result.skills.map((skill) => ({
      id: skill.name,
      name: skill.name,
      description: skill.description ?? '',
      available: skill.enabled !== false && skill.runtimeStatus !== 'failed',
    }));
  } else if (input.kind === 'mcp') {
    const runtimeCatalog = await deps.listMcpServers({
      agentKind, workingDir, remoteHostId: ctx.remoteHostId ?? undefined,
    });
    const available = new Set(runtimeCatalog
      .filter((entry) => entry.source === 'custom' && entry.available !== false)
      .map((entry) => entry.name));
    // Project only display metadata. URLs, headers and tokens never enter tool results.
    items = (await listCustomMcpServers()).map((mcp) => ({
      id: mcp.id,
      name: mcp.name,
      description: mcp.transport,
      available: available.has(mcp.id),
    }));
  } else {
    const registry = getPluginRegistry();
    items = await Promise.all(
      registry
        .getPlugins()
        .filter((plugin) => plugin.id !== 'collab' && !BOT_BASELINE_PLUGIN_IDS.has(plugin.id))
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
  const result = items.map((item) => ({ ...item, joined: joined.has(item.id) }));
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
    const capabilities = (await catalog(input, ctx, deps)).filter(
      (item) =>
        !query || `${item.id} ${item.name} ${item.description}`.toLocaleLowerCase().includes(query),
    );
    return { ok: true as const, capabilities: capabilities.slice(0, 50) };
  } catch {
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
    if (input.kind === 'toolset' && BOT_BASELINE_PLUGIN_IDS.has(input.id)) {
      return {
        ok: false as const,
        errorCode: 'CAPABILITY_NOT_SELECTABLE',
        message: '该工具集是伙伴固定能力，无需加入且不能移除',
      };
    }
    const field = fields[input.kind];
    const previous = strings(ctx.config[field.list]);
    if (input.joined) {
      const item = (await catalog(input, ctx, deps, { forceReload: true })).find((entry) => entry.id === input.id);
      if (!item?.available)
        return {
          ok: false as const,
          errorCode: 'CAPABILITY_UNAVAILABLE',
          message: '该能力未安装、已停用或当前运行引擎不可用',
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
  } catch {
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
    list: (input: Input & { query?: string }) => findBotCapabilities(input, deps),
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
