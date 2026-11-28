import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import type { MyPluginView } from '../../../shared/pluginContributions';

/** Current facts stay independent of the historical release selection. */
export function PluginVersionFacts({ plugin, localDetails, listedDetails }: {
  plugin: MyPluginView;
  localDetails?: ReactNode;
  listedDetails?: ReactNode;
}) {
  const { t } = useTranslation();
  const copy = 'settings.ghosts.contribution';
  const pending = plugin.latestSubmission?.reviewStatus === 'pending' &&
    plugin.latestSubmission.revisionState === 'current' ? plugin.latestSubmission.version : null;
  const facts = [
    ['localVersion', plugin.localInstallation?.state === 'installed'
      ? plugin.localInstallation.version
      : t(`${copy}.localState.${plugin.localInstallation?.state ?? 'unavailable'}`)],
    ['pendingVersion', pending ?? t(`${copy}.noPendingVersion`)],
  ];
  return <dl aria-label={t(`${copy}.versionFacts`)} className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
    {facts.map(([label, value]) => <div key={label} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
      <dt className="text-12 leading-[1.667] text-[var(--text-tertiary)]">{t(`${copy}.${label}`)}</dt>
      <dd className="break-words text-13 tabular-nums leading-[1.538] text-[var(--text-secondary)]">{value}</dd>
      {label === 'localVersion' && localDetails ? <dd>{localDetails}</dd> : null}
    </div>)}
    <div className="min-w-0 border-t border-[var(--border-default)] pt-3 sm:col-span-2">
      <dt className="sr-only">{t(`${copy}.listedVersion`)}</dt>
      <dd>{listedDetails}</dd>
    </div>
  </dl>;
}
