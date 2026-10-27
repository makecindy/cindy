import type { CodexContextWindowInfo } from '@cindy/maker-core';
import type { ModelPriceOverrideTarget } from './modelPriceOverride';
import type { AgentKind, ProviderView } from '@cindy/model-providers';

export const DEFAULT_MODEL_COMPACTION_PCT = 90;

/** Match the model row identity, removing only the provider's declared bridge prefix. */
export function modelCompactionTarget(
  provider: Pick<ProviderView, 'id' | 'routing'>,
  agent: AgentKind,
  modelId: string,
): { providerId: string; modelId: string } {
  const prefix = provider.routing[agent]?.modelPrefixes?.find((value) => modelId.startsWith(value));
  return { providerId: provider.id, modelId: prefix ? modelId.slice(prefix.length) : modelId };
}

/** One model row can use different wire ids in different harnesses. */
export interface ModelContextLimitTarget extends ModelPriceOverrideTarget {
  /** Read-only lookup of an existing task; never starts/resumes one. */
  sessionId?: string;
  relatedTargets?: ModelPriceOverrideTarget[];
}
export interface ModelContextLimitOwner {
  dataOwnerId: string | null;
  ownerGeneration: number;
}
export interface ModelContextLimitView {
  compaction?: {
    pct: number;
    isCustomized: boolean;
  };
  codexContext?: CodexContextWindowInfo | null;
  limit: number | null;
  isCustomized: boolean;
  /** Legacy per-harness overrides differ; an edit/reset applies to the whole row. */
  mixed?: boolean;
}
