/**
 * Built-in vs plugin engines on Desktop main (docs/plans/acp-plugin-bridge.md).
 *
 * Tasks may run on a plugin ACP engine (`'acp'`). Features that only make sense
 * for the built-in engines (provider routing, subscription accounts, schedules,
 * IM, hooks, bots, Orca, remote devices, ...) call these helpers: they return
 * the built-in kind unchanged, so built-in behavior is identical, and refuse a
 * plugin-engine task with one recognizable error instead of guessing.
 */

import type { AgentKind, EngineKind } from '@cindy/maker-core';

export const PLUGIN_ENGINE_UNSUPPORTED = 'PLUGIN_ENGINE_UNSUPPORTED';

export class PluginEngineUnsupportedError extends Error {
  readonly code = PLUGIN_ENGINE_UNSUPPORTED;

  constructor(readonly feature: string) {
    super(`${feature} is not available for tasks running on a plugin engine`);
    this.name = 'PluginEngineUnsupportedError';
  }
}

/**
 * Returns the kind unchanged unless it is a plugin engine. Only 'acp' is refused:
 * every other value (including ones older callers or fakes leave unset) keeps
 * exactly the path it had before plugin engines existed.
 */
export function requireBuiltinAgentKind(kind: EngineKind, feature: string): AgentKind {
  if (kind === 'acp') throw new PluginEngineUnsupportedError(feature);
  return kind;
}

/** The kind, or null for a plugin engine (and for no kind), for paths that skip plugin-engine tasks. */
export function builtinAgentKindOrNull(kind: EngineKind | null | undefined): AgentKind | null {
  return kind === 'acp' || kind == null ? null : kind;
}

/** Narrows any object carrying an engine kind (Session, SessionMeta, DTOs) to a built-in one. */
export function hasBuiltinAgentKind<T extends { agentKind: EngineKind }>(value: T): value is T & { agentKind: AgentKind } {
  return value.agentKind !== 'acp';
}

export function isPluginEngineTask(value: { agentKind: EngineKind } | null | undefined): boolean {
  return value?.agentKind === 'acp';
}
