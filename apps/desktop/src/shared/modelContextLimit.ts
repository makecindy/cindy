import type { CodexContextWindowInfo } from '@cindy/maker-core';
import type { ModelPriceOverrideTarget } from './modelPriceOverride';
import type { AgentKind, ProviderView } from '@cindy/model-providers';

export const DEFAULT_MODEL_COMPACTION_PCT = 90;
/** 逐模型自动压缩比例的可选范围；与 maker-core 的 auto-compact-controller 同口径。 */
export const MIN_MODEL_COMPACTION_PCT = 50;
export const MAX_MODEL_COMPACTION_PCT = 95;

/** Decimal units, independent of locale. Bare numbers always mean exact tokens. */
export function parseContextTokenInput(input: string): number | null {
  const match = input.trim().match(/^(\d+(?:\.\d+)?)\s*(k|m|万|萬|tokens?)?$/i);
  if (!match) return null;
  const unit = match[2]?.toLowerCase();
  const places = unit === 'k' ? 3 : unit === 'm' ? 6 : unit === '万' || unit === '萬' ? 4 : 0;
  const [whole, fraction = ''] = match[1].split('.');
  if (/[1-9]/.test(fraction.slice(places))) return null;
  const tokens = Number(whole + fraction.slice(0, places).padEnd(places, '0'));
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null;
}

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
