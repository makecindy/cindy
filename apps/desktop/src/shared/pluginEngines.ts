/**
 * Plugin-provided task engines as the Desktop renderer sees them
 * (docs/plans/acp-plugin-bridge.md). Local only: never part of device-link.
 */

export const PLUGIN_ENGINE_AGENT_KIND = 'acp' as const;
export const PLUGIN_ENGINE_PROVIDER_PREFIX = 'acp-plugin:';
/** Model value that lets the engine keep its own default (used until it reported its models). */
export const PLUGIN_ENGINE_DEFAULT_MODEL = 'default';

export const PLUGIN_ENGINES_INVOKE = {
  LIST: 'maker:list-plugin-engines',
  /** Ask engine plugins to republish their models (per-plugin cooldown in main). */
  REFRESH: 'maker:refresh-plugin-engines',
} as const;

export const PLUGIN_ENGINES_PUSH = {
  CHANGED: 'maker:plugin-engines-changed',
} as const;

/** Reasoning levels a plugin engine can offer, low → high (Cindy level ids; see plugin-protocol). */
export const PLUGIN_ENGINE_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type PluginEngineEffort = (typeof PLUGIN_ENGINE_EFFORTS)[number];

export function isPluginEngineEffort(value: unknown): value is PluginEngineEffort {
  return typeof value === 'string' && (PLUGIN_ENGINE_EFFORTS as readonly string[]).includes(value);
}

export interface PluginEngineModel {
  id: string;
  displayName: string;
  description?: string;
  group?: string;
  /** Levels the engine offers for this model, low → high; absent = no selectable level. */
  efforts?: PluginEngineEffort[];
  /** The engine's own level when none is chosen (one of `efforts`). */
  defaultEffort?: PluginEngineEffort;
}

export interface PluginEnginePermissionMode {
  id: 'ask' | 'bypassPermissions';
  displayName: string;
  description?: string;
}

export interface PluginEngineView {
  /** `<pluginInstance>:<harnessId>`. */
  key: string;
  /** Task `providerId` for this engine: `acp-plugin:<key>`. */
  providerId: string;
  ghostId: string;
  harnessId: string;
  /** Localized by the main process. */
  name: string;
  description?: string;
  /** The providing plugin's icon as a data URL; absent = the generic engine mark. */
  iconDataUrl?: string;
  availability: {
    state: 'available' | 'unavailable' | 'unknown';
    reason?: string;
    /** Plugin-provided hint, e.g. how to install the CLI. */
    message?: string;
    version?: string;
  };
  /** Models the agent offered the last time a task ran on it; empty until then. */
  models: PluginEngineModel[];
  permissionModes: PluginEnginePermissionMode[];
}

export function pluginEngineProviderId(key: string): string {
  return `${PLUGIN_ENGINE_PROVIDER_PREFIX}${key}`;
}

/** `acp-plugin:<ghostId>:<harnessId>` → `<ghostId>:<harnessId>`, else null. */
export function pluginEngineKeyFromProviderId(providerId: string | null | undefined): string | null {
  if (!providerId || !providerId.startsWith(PLUGIN_ENGINE_PROVIDER_PREFIX)) return null;
  const key = providerId.slice(PLUGIN_ENGINE_PROVIDER_PREFIX.length);
  const separator = key.lastIndexOf(':');
  return separator > 0 && separator < key.length - 1 ? key : null;
}

export function isPluginEngineKind(kind: unknown): kind is typeof PLUGIN_ENGINE_AGENT_KIND {
  return kind === PLUGIN_ENGINE_AGENT_KIND;
}
