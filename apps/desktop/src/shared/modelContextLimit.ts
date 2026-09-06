import type { ModelPriceOverrideTarget } from './modelPriceOverride';

/** One model row can use different wire ids in different harnesses. */
export interface ModelContextLimitTarget extends ModelPriceOverrideTarget {
  relatedTargets?: ModelPriceOverrideTarget[];
}
export interface ModelContextLimitOwner {
  dataOwnerId: string | null;
  ownerGeneration: number;
}
export interface ModelContextLimitView {
  limit: number | null;
  isCustomized: boolean;
  /** Legacy per-harness overrides differ; an edit/reset applies to the whole row. */
  mixed?: boolean;
}
