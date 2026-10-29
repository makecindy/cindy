import { useMemo, useSyncExternalStore } from 'react';

import type { ConversationSearchResponse } from '../../../shared/conversationSearch';

import { useAvailableAgents } from '@/hooks/useAvailableAgents';
import { useProviders } from '@/hooks/useProviders';
import type { MakerVendor } from '@/lib/ccAgent.types';
import type { Session } from '@/lib/ccAgent.types';
import * as sessionService from '@/lib/sessionService';
import { onPatch } from '@/lib/sessionsBus';
import { isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import {
  chooseBotAvatar,
  getEffectiveBotModelChain,
  retryBotInvitation,
  runBotLifecycleAction,
  setBotSchedulerBotId,
  resetBotAutonomySettings,
  subscribeBotGlobalModel,
  updateBotProfile,
  useBotAutonomySettings,
  useBotProfiles,
} from './botStore';
import { botImConnectionApi } from './botImConnectionClient';
import type { BotCapabilityEntry, BotCapabilityKind, BotSettingsTarget } from './botSettingsTarget';

const api = () => window.electronAPI.localDb.bots;
// `projects` lists folders on this computer: a remote teammate's target never offers it.
const ALL_PAGES = ['profile', 'personality', 'memory', 'projects', 'model', 'voice', 'capabilities', 'channels', 'routines', 'history', 'advanced'] as const;

/** Runtime / MCP facts that change which references a teammate can use. */
const CATALOG_PATCH_KEYS = [
  'agentKind', 'model', 'providerId', 'effort', 'fastMode', 'runtimeGeneration',
  'runtimeEffective', 'runtimePending', 'workingDir', 'remoteHostId',
];

/** The catalog the capability page lists, read from this computer's runtime. */
async function loadCatalog(
  bot: { id: string; canonicalSessionId?: string },
  modelChain: unknown,
  isCurrent: () => boolean,
): Promise<Partial<Record<BotCapabilityKind, BotCapabilityEntry[]>>> {
  if (!bot.canonicalSessionId) throw new Error('Missing canonical task');
  const session = await sessionService.get(bot.canonicalSessionId);
  if (!isCurrent()) return {};
  const maker = window.electronAPI.maker;
  const mcpResult = await maker.listCustomMcpServers({
    agentKind:
      session.runtimePending?.profile.agentKind ??
      session.runtimeEffective?.agentKind ??
      (session.agentKind === 'codex' || session.agentKind === 'pi' ? session.agentKind : 'claude-code'),
    botSessionId: bot.canonicalSessionId,
    modelChain: modelChain as never,
  });
  if (!isCurrent()) return {};
  const agentKind = mcpResult.agentKind;
  if (!agentKind) throw new Error('Missing next-turn route');
  const results = await Promise.allSettled([
    api().listSkills(bot.id),
    maker.listAgentSkills(agentKind, {
      forceReload: true,
      workingDir: session.workingDir ?? undefined,
      remoteHostId: session.remoteHostId ?? undefined,
    }),
    maker.plugins.list(session.workingDir ?? undefined, true, {
      botId: bot.id,
      agentKind,
      remoteHostId: session.remoteHostId,
    }),
  ]);
  const [personalResult, skillResult, toolsetResult] = results;
  const next: Partial<Record<BotCapabilityKind, BotCapabilityEntry[]>> = {};
  if (skillResult.status === 'fulfilled' && skillResult.value.success) {
    // Match resolveBotSkillReferences: the last entry for a name wins.
    // Map retains first-seen display order without changing discovery data.
    const skillsByName = new Map((skillResult.value.skills ?? []).map((item) => [item.name, item]));
    next.skill = [...skillsByName.values()].map((item) => ({
      id: item.name,
      name: item.name,
      description: item.description,
      available: item.enabled !== false && item.runtimeStatus !== 'failed',
    }));
  }
  if (personalResult.status === 'fulfilled')
    next.skill = [
      ...personalResult.value.map((item) => ({ id: `personal:${item.slug}`, name: item.name, description: item.description || undefined, available: item.enabled !== false, personal: true })),
      ...(next.skill ?? []),
    ];
  next.mcp = mcpResult.servers.map((item) => ({ id: item.id, name: item.name, available: item.available === true }));
  if (toolsetResult.status === 'fulfilled')
    next.toolset = toolsetResult.value
      .filter((item) => !['memory', 'xdt_helper', 'scheduler', 'lsp'].includes(item.id))
      .map((item) => ({ id: item.id, name: item.name, description: item.description, available: item.available === true }));
  return next;
}

function useDefaultModelChain() {
  // Followed defaults change with providers / available harnesses, not with the profile.
  useSyncExternalStore(subscribeBotGlobalModel, () => JSON.stringify(getEffectiveBotModelChain()));
  return getEffectiveBotModelChain();
}

function useHiddenVendors(): MakerVendor[] {
  // Live provider defaults are display state; load them so the chain editor reflects them.
  useProviders();
  const { availableVendors, loaded } = useAvailableAgents();
  return useMemo<MakerVendor[]>(() => {
    if (!loaded) return [];
    return (['cc', 'codex', 'pi'] as const).filter((item) => !availableVendors.has(item));
  }, [loaded, availableVendors]);
}

/** This computer: the settings pages as they always were, behind the target interface. */
export const localBotSettingsTarget: BotSettingsTarget = {
  kind: 'local',
  mediaModels: () => api().mediaModels(),
  online: true,
  pages: new Set<string>(ALL_PAGES),
  // Store functions are read on use, so a module that never opens these pages never needs them.
  profile: {
    update: (...args) => updateBotProfile(...args),
    chooseAvatar: (...args) => chooseBotAvatar(...args),
    retryInvitation: (...args) => retryBotInvitation(...args),
  },
  lifecycle: { run: (request) => runBotLifecycleAction(request) },
  useDefaultModelChain,
  useHiddenVendors,
  useRoster: () => useBotProfiles(),
  memory: {
    list: (...args) => api().memory.list(...args),
    read: (...args) => api().memory.read(...args),
    update: (...args) => api().memory.update(...args),
    delete: (...args) => api().memory.delete(...args),
  },
  skills: {
    core: () => api().skills.core(),
    read: (...args) => api().skills.read(...args),
    save: (...args) => api().skills.save(...args),
    setEnabled: (...args) => api().skills.setEnabled(...args),
    delete: (...args) => api().skills.delete(...args),
  },
  history: { search: (body) => api().searchHistory(body) as Promise<ConversationSearchResponse> },
  capabilities: {
    load: (bot, modelChain, isCurrent) => loadCatalog(bot, modelChain, isCurrent),
    watch(bot, refresh) {
      const changed = (sessionId: string, patch: Partial<Session>) => {
        if (sessionId === bot.canonicalSessionId && CATALOG_PATCH_KEYS.some((key) => key in patch)) refresh();
      };
      const offLocal = onPatch(changed);
      const offPush = window.electronAPI.localDb?.sessionsPush?.onPatched(({ sessionId, patch }, stamp) => {
        if (isDataOwnerPushCurrent(stamp)) changed(sessionId, patch);
      });
      const offMcp = window.electronAPI.maker.onMcpChanged(refresh);
      return () => {
        offLocal();
        offPush?.();
        offMcp();
      };
    },
  },
  channels: {
    get im() {
      return botImConnectionApi();
    },
    canEnterCredentials: true,
    wechat: null,
    x: null,
  },
  voice: {
    models: () => window.electronAPI.voiceConversation.models(),
    voices: (...args) => window.electronAPI.voiceConversation.voices(...args),
    preference: (...args) => window.electronAPI.voiceConversation.preference(...args),
    setPreference: (...args) => window.electronAPI.voiceConversation.setPreference(...args),
    refreshCatalog: async () => {
      await window.electronAPI.maker.refreshBuiltinProviderModels('xd');
    },
    get previewApi() {
      return window.electronAPI.voiceConversation;
    },
  },
  routines: {
    list: (...args) => window.electronAPI.routines.list(...args),
    save: (...args) => window.electronAPI.routines.save(...args),
    remove: (...args) => window.electronAPI.routines.remove(...args),
    runNow: (...args) => window.electronAPI.routines.runNow(...args),
    history: (...args) => window.electronAPI.routines.history(...args),
    sources: () => window.electronAPI.routines.sources(),
    deliveryTargets: (botId) => window.electronAPI.routines.deliveryTargets?.(botId) ?? Promise.resolve([]),
    onChanged: (listener) => window.electronAPI.routines.onChanged(listener),
  },
  autonomy: {
    useSettings: () => useBotAutonomySettings(),
    setSchedulerBotId: (botId) => setBotSchedulerBotId(botId),
    reset: () => resetBotAutonomySettings(),
  },
};
