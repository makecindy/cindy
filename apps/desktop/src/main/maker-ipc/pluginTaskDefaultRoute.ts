/**
 * Default model for a plugin's own persistent tasks (created without a source
 * session): follow the system auxiliary-model chain, on the Pi harness when the
 * model is offered there, at the lightest reasoning effort available.
 *
 * Pi first (decided 2026-10-28): on a real install with many plugins, the same
 * deepseek passage reasoned three to five times longer through Codex than
 * through Pi, whose tool surface stays small whatever is installed. Codex and
 * Claude remain the fallback when Pi does not offer the candidate model.
 *
 * The plugin settings page has always described the model row as "follows the
 * system auxiliary model"; routes created from inside a user's session still
 * inherit that session's model (resolveRoute with a sourceSessionId). Only the
 * no-source path used to borrow the new-task composer selection, which made a
 * subtitle translation cost whatever model the user last picked for coding.
 */
import type { AgentKind } from '@cindy/maker-core';
import { getUtilityModelProfile } from '../../shared/utilityModelProfiles.js';
import { parsedAuxiliaryModelRefs } from '../utility-model/resolveAuxiliaryModelChain.js';

export interface PluginTaskDefaultCandidate {
  agentKind: AgentKind;
  providerId: string;
  model: string;
}

/** Lightweight profiles run through the same gateways as one-shot utility calls. */
function profileRoute(id: Parameters<typeof getUtilityModelProfile>[0]): PluginTaskDefaultCandidate {
  const profile = getUtilityModelProfile(id);
  return {
    agentKind: 'codex',
    providerId: profile.transport === 'codex-responses' ? 'openai' : 'xd',
    model: profile.model,
  };
}

/** Ordered, de-duplicated session routes derived from the auxiliary chain refs. */
export function auxiliaryChainSessionCandidates(refs: readonly string[]): PluginTaskDefaultCandidate[] {
  const out: PluginTaskDefaultCandidate[] = [];
  const seen = new Set<string>();
  for (const ref of parsedAuxiliaryModelRefs(refs)) {
    const candidate = ref.kind === 'catalog'
      ? { agentKind: ref.route.agentKind as AgentKind, providerId: ref.route.providerId, model: ref.route.model }
      : profileRoute(ref.id);
    const key = `${candidate.agentKind}\u0000${candidate.providerId}\u0000${candidate.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

/** Reasoning levels light enough for a plugin's background work, cheapest first. */
export const PLUGIN_TASK_LIGHT_EFFORTS = ['low', 'medium'] as const;

/** The same provider/model on Pi first, then on the harness the chain named. */
function harnessVariants<T extends { agentKind: AgentKind }>(candidate: T): T[] {
  return candidate.agentKind === 'pi' ? [candidate] : [{ ...candidate, agentKind: 'pi' }, candidate];
}

/**
 * Route attempts in order: every candidate (Pi variant first) at a light effort
 * before any candidate at its default. A chain head that only offers high/xhigh
 * therefore yields to the next candidate that has a light level, instead of
 * running subtitle passages at high reasoning.
 */
export function pluginTaskRouteAttempts<T extends { agentKind: AgentKind }>(
  candidates: readonly T[],
): Array<{ candidate: T; effort: (typeof PLUGIN_TASK_LIGHT_EFFORTS)[number] | undefined }> {
  const expanded = candidates.flatMap(harnessVariants);
  return [
    ...expanded.flatMap(candidate => PLUGIN_TASK_LIGHT_EFFORTS.map(effort => ({ candidate, effort }))),
    ...expanded.map(candidate => ({ candidate, effort: undefined })),
  ];
}

/** The plugin left the route open when none of the identifying fields is set. */
export function pluginTaskSelectionIsOpen(selection: { agentKind?: unknown; model?: unknown; providerId?: unknown; effort?: unknown; fastMode?: unknown }): boolean {
  return !selection.agentKind && !selection.model && !selection.providerId;
}
