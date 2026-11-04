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

/** Resolve the same precedence without turning inferred modalities into an explicit flag. */
export function modelImageInputDefault(model: ModelImageInputCatalogModel): boolean | null {
  const source = model.imageInputDefault ?? model;
  if (source.supportsImageInput !== undefined) return source.supportsImageInput;
  if (source.modalities) return source.modalities.input.includes('image');
  const capability = classifyVisionCapability(model.id);
  return capability === 'unknown' ? null : capability === 'vision';
}
