export interface AstraCatalogRow {
  id: string;
  [key: string]: unknown;
}

export function applyAstraCatalogAdditions(
  providers: Record<string, AstraCatalogRow[]>,
): Record<string, AstraCatalogRow[]>;
