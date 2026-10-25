import type { AgentKind, Provider } from './types.js';

/** Resolve Fast within the selected connection's current model authority. */
export function createModelFastMode(getCatalog: () => { providers: Pick<Provider, 'id' | 'models'>[] }) {
  function fastModelId(providerId: string, agent: AgentKind, modelId: string): string | undefined {
    const models = getCatalog().providers.find(p => p.id === providerId)?.models[agent];
    const model = models?.find(m => m.id === modelId);
    if (!model?.supportsFastMode || !model.fastModelId) return undefined;
    const target = models?.find(m => m.id === model.fastModelId && m.status !== 'retired');
    return target?.id;
  }
  function rewriteFastModel(providerId: string, agent: AgentKind, body: Record<string, unknown>, fast: boolean | 'ultrafast'): Record<string, unknown> | null {
    if (!fast || typeof body.model !== 'string') return null;
    const target = fastModelId(providerId, agent, body.model);
    if (!target && body.service_tier !== 'priority') return null;
    const next: Record<string, unknown> = { ...body, model: target ?? body.model };
    delete next.service_tier;
    return next;
  }
  return { fastModelId, rewriteFastModel };
}
