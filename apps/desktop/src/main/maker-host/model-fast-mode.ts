import type { AgentKind } from '@cindy/model-providers';
import { getActiveCatalog } from './active-catalog.js';

/** Resolve only in the selected connection. Active catalog has already gated account availability. */
export function fastModelId(providerId: string, agent: AgentKind, modelId: string): string | undefined {
  const models = getActiveCatalog().providers.find(p => p.id === providerId)?.models[agent];
  const model = models?.find(m => m.id === modelId);
  if (!model?.supportsFastMode || !model.fastModelId) return undefined;
  const target = models?.find(m => m.id === model.fastModelId && m.status !== 'retired');
  return target?.id;
}

/** Codex's Fast intent is represented by priority; a model variant must not also buy priority. */
export function rewriteFastModel(
  providerId: string, agent: AgentKind, body: Record<string, unknown>, fast: boolean,
): Record<string, unknown> | null {
  if (!fast || typeof body.model !== 'string') return null;
  const target = fastModelId(providerId, agent, body.model);
  if (!target) return null;
  const next: Record<string, unknown> = { ...body, model: target };
  delete next.service_tier;
  return next;
}
