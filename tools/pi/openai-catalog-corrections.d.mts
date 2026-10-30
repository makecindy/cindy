export interface AstraCatalogRow {
  id: string;
  [key: string]: unknown;
}

export function applyAstraCatalogAdditions(
  providers: Record<string, AstraCatalogRow[]>,
): Record<string, AstraCatalogRow[]>;

export function applyPinnedAstraCorrections(
  providers: Record<string, import('./catalog-format.mjs').PiImportModel[]>,
  version?: string,
): void;
