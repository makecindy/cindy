import type { CodexContextWindowInfo } from '@cindy/maker-core';
import type { ModelPriceOverrideTarget } from './modelPriceOverride';

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
  codexContext?: CodexContextWindowInfo | null;
  limit: number | null;
  isCustomized: boolean;
  /** Legacy per-harness overrides differ; an edit/reset applies to the whole row. */
  mixed?: boolean;
}
