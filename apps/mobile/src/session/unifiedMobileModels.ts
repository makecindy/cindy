import { unifiedModelEntries, type UnifiedModelEntry } from '@cindy/model-providers';
import { isModelVisible } from '@cindy/model-providers/sections';
import type { AgentKind } from '@cindy/model-providers/types';
import type { ProviderView } from '@cindy/model-providers/registry';
import type { MobileModelMemoryAccessors } from './draftModelMemory';

export interface MobileModelConfiguration {
  providerId: string;
  modelId: string;
  agent: AgentKind;
  effort: string;
  fast: boolean;
}
export interface MobileModelFavorite extends MobileModelConfiguration { uid: string }
export interface MobileModelPreferences {
  favorites: MobileModelFavorite[];
  engines: Record<string, AgentKind>;
}
export const modelKey = (providerId: string, modelId: string) => JSON.stringify([providerId, modelId]);
export function matchesEntry(entry: UnifiedModelEntry, modelId: string) {
  return entry.modelId === modelId || Object.values(entry.capabilities).some(c => c?.wireModelId === modelId);
}
export function mobileUnifiedEntries(providers: readonly ProviderView[], agents: readonly AgentKind[], visibility: Record<string, boolean> | undefined, existing: boolean, keepModel?: {providerId: string | null; modelId: string; agent: AgentKind}) {
  return unifiedModelEntries({ providers, agents, scope: existing ? 'session' : 'draft', keepModel,
    isVisible: (providerId, model, agent) => visibility === undefined || isModelVisible(visibility[`${agent}:${providerId}:${model.id}`], model.defaultEnabled),
  });
}
/** Same precedence as Desktop resolveUnifiedRowConfig: live > explicit > safe session pin > catalog. */
export function resolveMobileModelConfig(entry: UnifiedModelEntry, args: {
  live?: MobileModelConfiguration; pinned?: AgentKind; override?: AgentKind;
  memory?: MobileModelMemoryAccessors; favorite?: MobileModelFavorite;
  fastCapable(agent: AgentKind): boolean;
}): MobileModelConfiguration {
  const usable = (agent?: AgentKind) => agent && entry.candidates.includes(agent) ? agent : undefined;
  const pinned = entry.nativeAgent === null || entry.nativeAgent === args.pinned ? usable(args.pinned) : undefined;
  const agent = args.favorite ? usable(args.favorite.agent) ?? entry.recommended
    : usable(args.live?.agent) ?? usable(args.override) ?? pinned ?? entry.recommended;
  const cap = entry.capabilities[agent]!;
  const effort = args.favorite?.effort ?? args.live?.effort ?? args.memory?.getEffort(agent, entry.providerId, cap.wireModelId);
  const levels: readonly string[] = cap.efforts;
  const fast = args.favorite?.fast ?? args.live?.fast ?? args.memory?.getFast(agent, entry.providerId, cap.wireModelId) ?? false;
  return { providerId: entry.providerId, modelId: cap.wireModelId, agent,
    effort: effort && levels.includes(effort) ? effort : cap.defaultEffort ?? levels[0] ?? '',
    fast: fast && cap.supportsFastMode && args.fastCapable(agent),
  };
}
export function sameConfiguration(a: MobileModelConfiguration, b: MobileModelConfiguration) {
  return a.providerId === b.providerId && a.modelId === b.modelId && a.agent === b.agent && a.effort === b.effort && a.fast === b.fast;
}
export function addModelFavorite(prefs: MobileModelPreferences, value: MobileModelConfiguration, uid: string): MobileModelPreferences {
  if (prefs.favorites.some(item => sameConfiguration(item, value))) return prefs;
  return { ...prefs, favorites: [...prefs.favorites, { ...value, uid }] };
}
