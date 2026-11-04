import type { CatalogModel } from '@cindy/model-providers';
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

/** Desktop-only display provenance; never a model capability override itself. */
export interface ModelImageInputCatalogModel extends CatalogModel {
  /** The capability before the local override; null means undeclared. */
  defaultSupportsImageInput?: boolean | null;
}
