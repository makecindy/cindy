import type { CatalogModel, Effort } from '@cindy/model-providers';


const EFFORT_ORDER: readonly Effort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];


export function resolveCompatibleSessionRuntimeEffort(
  model: CatalogModel,
  requested: Effort | null,
): Effort | null {
  if (model.efforts.length === 0) return null;
  if (requested && model.efforts.includes(requested)) return requested;
  if (model.defaultEffort && model.efforts.includes(model.defaultEffort))
    return model.defaultEffort;
  if (!requested) return model.efforts[0] ?? null;
  const requestedRank = EFFORT_ORDER.indexOf(requested);
  return (
    [...model.efforts].sort(
      (a, b) =>
        Math.abs(EFFORT_ORDER.indexOf(a) - requestedRank) -
        Math.abs(EFFORT_ORDER.indexOf(b) - requestedRank),
    )[0] ?? null
  );
}
