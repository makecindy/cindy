import { useTranslation } from 'react-i18next';
import { CircleCheck, CircleHelp, Download } from 'lucide-react';
import type {
  MakeSourceLatestVersion,
  MakeSourcePreparation,
} from '../../../shared/cindyMakeDoctor';
import { compareCindyMakeSource } from './CindyMakeSourceDetails';

const key = 'cindyMake.summary';

/**
 * The personal version in plain words: which official version it is based on, how
 * many of the user's changes it carries, and whether it has the latest official
 * release. Hashes, branches and local main stay in the technical details.
 */
export function CindyMakeVersionSummary({
  source,
  latestVersion,
  changes,
  showComparison = true,
}: {
  source: MakeSourcePreparation;
  latestVersion?: MakeSourceLatestVersion;
  /** Changes from this computer's history that are part of the personal version. */
  changes?: number;
  /** Progress may replace the comparison while the version facts remain visible. */
  showComparison?: boolean;
}) {
  const { t } = useTranslation();
  const { personalIsLatest, personalNeedsUpdate, personalStatus } = compareCindyMakeSource(
    source,
    latestVersion,
  );
  const channel = latestVersion?.channel ?? source.channel;
  // A base that is the latest release (for example taken in from another computer) is named
  // by that release; otherwise by the official version it was last updated to.
  const ref =
    latestVersion?.status === 'ready' &&
    latestVersion.channel !== 'dev' &&
    !!source.baseCommit &&
    latestVersion.commit === source.baseCommit
      ? latestVersion.ref
      : source.ref;
  const development = channel === 'dev' || ref === 'main';
  const version = development
    ? t(`${key}.development`)
    : ref || source.version
      ? t(`${key}.official`, { version: ref || source.version })
      : t(`${key}.officialUnknown`);
  const basis =
    changes !== undefined && changes > 0
      ? t(`${key}.withChanges`, { version, count: changes })
      : (source.personalAhead ?? 0) > 0
        ? t(`${key}.withOwnChanges`, { version })
        : t(`${key}.noChanges`, { version });
  const latest =
    latestVersion?.status === 'ready'
      ? latestVersion.channel === 'dev'
        ? t(`${key}.latest.dev`)
        : t(`${key}.latest.${latestVersion.channel}`, { version: latestVersion.ref })
      : latestVersion?.status === 'unavailable'
        ? t(`${key}.latest.unavailable`)
        : t(`${key}.latest.unknown`);
  const StatusIcon = personalIsLatest ? CircleCheck : personalNeedsUpdate ? Download : CircleHelp;
  const statusColor = personalIsLatest
    ? 'text-[var(--status-success)]'
    : personalNeedsUpdate
      ? 'text-[var(--upgrade-banner-fg)]'
      : 'text-[var(--text-secondary)]';
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-13">
      <dt className="text-[var(--text-secondary)]">{t(`${key}.personal`)}</dt>
      <dd className="min-w-0 break-words text-[var(--text-primary)]">{basis}</dd>
      <dt className="text-[var(--text-secondary)]">{t(`${key}.latestLabel`)}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[var(--text-primary)]">{latest}</span>
        {showComparison && (
          // The single live status region; the collapsed technical comparison stays silent.
          <span role="status" className={`inline-flex items-center gap-1.5 ${statusColor}`}>
            <StatusIcon size={14} className="shrink-0" aria-hidden />
            {t(`${key}.included.${personalStatus}`)}
          </span>
        )}
      </dd>
    </dl>
  );
}
