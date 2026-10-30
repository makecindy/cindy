import { deriveLocalInstall, type MarketSkill } from '../hooks/useMarketList';

/** Share detail/install presentation across local and selected-computer routes. */
export function marketInfoViewModel(
  info: SkillhubInfoResult,
  local: SkillhubSkill | null,
  catalogScope: MarketSkill['catalogScope'],
): MarketSkill {
  const primary = local
    ? {
        version: local.registryEntry?.version ?? null,
        absolutePath: local.absolutePath,
        hasRegistryEntry: !!local.registryEntry,
      }
    : undefined;
  const installed = deriveLocalInstall(
    info,
    primary
      ? {
          global: local?.scope === 'global' ? primary : undefined,
          projects: local?.scope === 'project' ? [primary] : [],
        }
      : undefined,
  );
  return {
    ...info,
    icon: info.icon ?? undefined,
    catalogScope,
    ...installed,
    authorAvatarUrl: null,
    avatarInitial: info.authorName.slice(0, 1),
    categories: info.categories ?? [],
    tags: info.tags ?? [],
    githubUrl: info.githubUrl ?? null,
    relativeTime: '',
    latestPublishedFromDeviceId: null,
    cardState: installed.updateAvailable
      ? 'installed-outdated'
      : installed.installedLocally
        ? 'installed-latest'
        : 'not-installed',
  };
}
