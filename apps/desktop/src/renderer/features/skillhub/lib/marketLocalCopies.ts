import { skillhubCatalogKey, type SkillhubCatalogScope } from '../../../../shared/skillhubCatalog';

export interface MarketLocalIdentity {
  name: string;
  isMine: boolean;
  isCreator?: boolean;
  canManage?: boolean;
  authorId?: string;
  catalogScope?: SkillhubCatalogScope;
}

export function publishedLocalIdentity(local: SkillhubSkill): string | null {
  const registry = local.registryEntry;
  return local.kind === 'skill' && registry?.origin === 'published' && !registry.catalogScope && registry.authorId
    ? JSON.stringify([local.registrySkillName ?? local.name, registry.authorId]) : null;
}

export function publishedMarketIdentity(market: MarketLocalIdentity): string | null {
  // Native publishing records and their visible catalog projection share an owner.
  // Never merge arbitrary same-slug installs or organization-owned records by name alone.
  return market.catalogScope && market.isCreator === true && market.canManage && market.authorId
    ? JSON.stringify([market.name, market.authorId]) : null;
}

export function marketLocalCopies(skills: readonly SkillhubSkill[], market: MarketLocalIdentity): SkillhubSkill[] {
  const publishedIdentity = publishedMarketIdentity(market);
  return skills.filter((local) => {
    const name = local.registryEntry ? local.registrySkillName ?? local.name : local.name;
    if (local.kind !== 'skill' || name !== market.name) return false;
    if (!local.registryEntry) return market.isMine;
    return skillhubCatalogKey(name, local.registryEntry.catalogScope) === skillhubCatalogKey(market.name, market.catalogScope)
      || (publishedIdentity !== null && publishedLocalIdentity(local) === publishedIdentity);
  }).sort((left, right) => {
    const exact = (local: SkillhubSkill) => !!local.registryEntry
      && local.registryEntry.catalogScope === market.catalogScope;
    return Number(right.scope === 'global') - Number(left.scope === 'global')
      || Number(exact(right)) - Number(exact(left));
  });
}
