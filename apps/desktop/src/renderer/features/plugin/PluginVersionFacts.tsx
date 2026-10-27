import { useTranslation } from 'react-i18next';
import type { MyPluginView } from '../../../shared/pluginContributions';

/** Current facts stay independent of the historical release selection. */
export function PluginVersionFacts({ plugin }: {
  plugin: MyPluginView;
}) {
  const { t } = useTranslation();
  const copy = 'settings.ghosts.contribution';
  const pending = plugin.latestSubmission?.reviewStatus === 'pending' &&
    plugin.latestSubmission.revisionState === 'current' ? plugin.latestSubmission.version : null;
  const facts = [
    ['localVersion', plugin.localInstallation?.state === 'installed'
      ? plugin.localInstallation.version
      : t(`${copy}.localState.${plugin.localInstallation?.state ?? 'unavailable'}`)],
    ['listedVersion', plugin.market.state === 'available' && plugin.market.version
      ? plugin.market.version : t(`${copy}.market.${plugin.market.state}`)],
    ['pendingVersion', pending ?? t(`${copy}.noPendingVersion`)],
  ];
  return <dl aria-label={t(`${copy}.versionFacts`)} className="grid grid-cols-3 gap-x-6 gap-y-3 border-y border-[var(--border-default)] py-3 max-[600px]:grid-cols-1">
    {facts.map(([label, value]) => <div key={label} className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
      <dt className="text-12 leading-5 text-[var(--text-tertiary)]">{t(`${copy}.${label}`)}</dt>
      <dd className="break-words text-14 font-medium leading-5 text-[var(--text-primary)]">{value}</dd>
    </div>)}
  </dl>;
}
