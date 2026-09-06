import type { CatalogModel } from '@cindy/model-providers';

import { modelBrand, type ModelBrand } from '@/lib/modelDisplayNames';
export { modelBrand, type ModelBrand } from '@/lib/modelDisplayNames';

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
function normalizedName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/([a-z])(?=\d)/gi, '$1 ')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Family names A–Z; numeric model versions descending within a family. This is NOT release order. */
export function compareModelNames(
  a: Pick<CatalogModel, 'id' | 'name'>,
  b: Pick<CatalogModel, 'id' | 'name'>,
): number {
  const an = normalizedName(a.name);
  const bn = normalizedName(b.name);
  const family = (name: string) => name.split(/\d/, 1)[0]!.trim();
  return (
    collator.compare(family(an), family(bn)) ||
    collator.compare(bn, an) ||
    collator.compare(a.id, b.id)
  );
}

export const MANAGEMENT_KIND_ORDER = [
  'chat',
  'image',
  'video',
  'tts',
  'stt',
  'realtime',
  'embedding',
  'compression',
  'other',
] as const;
export type ManagementKind = (typeof MANAGEMENT_KIND_ORDER)[number];
export type ManagementView = 'brand' | 'model';

export function groupModelsForManagement<T extends Pick<CatalogModel, 'id' | 'name'>>(
  models: readonly T[],
  view: ManagementView,
  kindOf: (model: T) => ManagementKind,
): Array<{ key: string; kind: ManagementKind; brand?: ModelBrand; models: T[] }> {
  const groups = new Map<
    string,
    { key: string; kind: ManagementKind; brand?: ModelBrand; models: T[] }
  >();
  for (const model of models) {
    const kind = kindOf(model);
    const brand = view === 'brand' && kind === 'chat' ? modelBrand(model) : undefined;
    const key = brand ? `${kind}:${brand.key}` : kind;
    let group = groups.get(key);
    if (!group) {
      group = { key, kind, ...(brand ? { brand } : {}), models: [] };
      groups.set(key, group);
    }
    group.models.push(model);
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        MANAGEMENT_KIND_ORDER.indexOf(a.kind) - MANAGEMENT_KIND_ORDER.indexOf(b.kind) ||
        (a.brand
          ? b.brand
            ? collator.compare(a.brand.label, b.brand.label)
            : -1
          : b.brand
            ? 1
            : 0),
    )
    .map((group) => ({ ...group, models: [...group.models].sort(compareModelNames) }));
}
