import { isGhostControlPointId, type GhostControlPointFailureAction, type GhostControlPointId } from './ghost.js';

/** Task-local opt-in. An installed capability alone never selects a provider. */
export const RUNTIME_PLUGIN_POINTS = ['will-start-turn', 'will-model-request', 'will-compose-context', 'will-search-memory', 'system-prompt'] as const;
export type RuntimePluginPoint = (typeof RUNTIME_PLUGIN_POINTS)[number];
export interface RuntimePluginTarget {
  pluginId: string;
  onFailure: GhostControlPointFailureAction;
}
export type RuntimePluginSettings = Partial<Record<RuntimePluginPoint, RuntimePluginTarget[]>>;

/** Validate the request envelope, leaving provider-specific parameters extensible. */
export function assertRuntimeRequestShape(original: Record<string, unknown>, next: Record<string, unknown>): void {
  if (typeof original.model === 'string' && (typeof next.model !== 'string' || !next.model.trim())) {
    throw new Error('Invalid request model');
  }
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  if (Array.isArray(original.messages) && (!Array.isArray(next.messages) ||
    next.messages.some(item => !record(item) || typeof item.role !== 'string' || !item.role))) {
    throw new Error('Invalid request messages');
  }
  if (Array.isArray(original.contents) && (!Array.isArray(next.contents) ||
    next.contents.some(item => !record(item) || !Array.isArray(item.parts)))) {
    throw new Error('Invalid request contents');
  }
  if (Array.isArray(original.input) && typeof next.input !== 'string' &&
    (!Array.isArray(next.input) || next.input.some(item => !record(item)))) {
    throw new Error('Invalid request input');
  }
  for (const field of ['max_tokens', 'max_output_tokens', 'max_completion_tokens']) {
    if (field in next && (typeof next[field] !== 'number' || !Number.isInteger(next[field]) || (next[field] as number) <= 0)) {
      throw new Error('Invalid request token limit');
    }
  }
  for (const field of ['temperature', 'top_p']) {
    if (field in next && (typeof next[field] !== 'number' || !Number.isFinite(next[field]))) throw new Error('Invalid request parameter');
  }
}

export function isRuntimePluginPoint(value: unknown): value is RuntimePluginPoint {
  return isGhostControlPointId(value) && (RUNTIME_PLUGIN_POINTS as readonly GhostControlPointId[]).includes(value);
}

export function parseRuntimePluginSettings(value: unknown): RuntimePluginSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result: RuntimePluginSettings = {};
  for (const [point, targets] of Object.entries(value)) {
    if (!isRuntimePluginPoint(point) || !Array.isArray(targets)) return null;
    const seen = new Set<string>();
    const parsed: RuntimePluginTarget[] = [];
    for (const target of targets) {
      if (!target || typeof target !== 'object' || Array.isArray(target)
        || typeof target.pluginId !== 'string' || !target.pluginId || target.pluginId.length > 256
        || !['allow', 'skip', 'block'].includes(target.onFailure) || seen.has(target.pluginId)) return null;
      seen.add(target.pluginId);
      if (point === 'will-search-memory' && target.onFailure !== 'allow') return null;
      parsed.push({ pluginId: target.pluginId, onFailure: target.onFailure });
    }
    if (parsed.length) result[point] = parsed;
  }
  return result;
}
