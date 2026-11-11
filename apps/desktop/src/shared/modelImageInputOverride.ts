import { classifyVisionCapability, type CatalogModel } from '@cindy/model-providers';
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
  /** Raw pre-override fields; an empty snapshot means the catalog is undeclared. */
  imageInputDefault?: Pick<CatalogModel, 'supportsImageInput' | 'modalities'>;
}

/** Resolve raw fields first; a union row may supply its bridge-free ID for name inference. */
export function modelImageInputDefault(model: ModelImageInputCatalogModel, canonicalId = model.id): boolean | null {
  const source = model.imageInputDefault ?? model;
  if (source.supportsImageInput !== undefined) return source.supportsImageInput;
  if (source.modalities) return source.modalities.input.includes('image');
  const capability = classifyVisionCapability(canonicalId);
  return capability === 'unknown' ? null : capability === 'vision';
}
