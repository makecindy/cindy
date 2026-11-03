import type { ModelPriceOverrideTarget } from './modelPriceOverride';

export interface ModelImageInputTarget extends ModelPriceOverrideTarget {
  relatedTargets?: ModelPriceOverrideTarget[];
}

export interface ModelImageInputOwner {
  dataOwnerId: string | null;
  ownerGeneration: number;
}

export interface ModelImageInputView {
  /** null follows the current catalog; false is an explicit user choice. */
  value: boolean | null;
  mixed: boolean;
}
