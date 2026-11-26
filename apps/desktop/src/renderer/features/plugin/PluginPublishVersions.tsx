import { ChevronDown, CircleCheck, CircleDashed, CircleMinus, Clock, Code2, FileText, Info, Monitor, Shield, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AttentionDot, type DotTone } from '@/components/sidebar/AttentionDot';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ghostPermissionItems } from '../../../shared/ghost';
import type {
  ContributionReleaseView,
  MyPluginDetailView,
  MyPluginLocalInstance,
  MyPluginView,
  PreparedPluginContribution,
} from '../../../shared/pluginContributions';
import type { PluginMarketDetail } from '../../../shared/pluginMarket';
import { GhostPluginIcon } from './GhostPluginIcon';
import { PluginDetailRecordRow } from './PluginDetailRecord';
import { PluginPermissionList, usePluginPermissionFacts } from './PluginPermissionList';
import './plugin-publish-versions.css';

const copy = 'settings.ghosts.contribution';

type VersionEvent = MyPluginDetailView['history'][number];
type SubmissionRow = {
  kind: 'submission';
  key: string;
  version: string;
  release: ContributionReleaseView;
  events: VersionEvent[];
};
type VersionRow = SubmissionRow
  | { kind: 'local'; key: string; version: string }
  | { kind: 'published' | 'history'; key: string; version: string; events: VersionEvent[] }
  | { kind: 'market'; key: string; events: VersionEvent[] };

export const releaseKey = (release: ContributionReleaseView) =>
  JSON.stringify([release.releaseId, release.revision, release.sha256, release.submissionId]);
const historyRowKey = (version: string) => JSON.stringify(['history', version]);

export function versionEventKind(event: VersionEvent) {
  return event.pluginStatus === 'archived' ? 'archived' : event.type;
}

function marketNoticeEvent(market: MyPluginView['market'], history: readonly VersionEvent[]) {
  const matching = history.filter((event) => {
    const kind = versionEventKind(event);
    switch (market.state) {
      case 'archived': return kind === 'archived';
      case 'disabled': return kind === 'disabled';
      case 'release_unavailable': return kind === 'revoked' &&
        (!market.releaseId || event.releaseId === market.releaseId);
      case 'not_listed': return kind === 'current_changed' && !event.releaseId;
      case 'available': return Boolean(market.reason?.trim()) &&
        (kind === 'enabled' || kind === 'current_changed') &&
        (!event.releaseId || event.releaseId === market.releaseId);
    }
  });
  const reason = market.reason?.trim();
  return (reason ? matching.filter(event => event.reason?.trim() === reason).at(-1) : undefined)
    ?? matching.at(-1);
}

function submissionForEvent(event: VersionEvent, rows: readonly SubmissionRow[]) {
  const matchingSubmission = event.submissionId
    ? rows.filter(row => row.release.submissionId === event.submissionId)
    : [];
  const matchingRelease = matchingSubmission.length ? matchingSubmission : event.releaseId
    ? rows.filter(row => row.release.releaseId === event.releaseId)
    : [];
  if (matchingRelease.length) {
    const revision = event.revision;
    const exact = revision ? matchingRelease.filter(row => row.release.releaseId === revision.releaseId &&
      row.release.sha256 === revision.sha256 && row.release.revision === revision.displayUpdatedAt) : [];
    if (exact.length === 1) return exact[0];
    return matchingRelease.length === 1 ? matchingRelease[0] : undefined;
  }
  if (event.releaseId || event.submissionId) return undefined;
  const matchingVersion = rows.filter(row => row.version === event.version);
  return matchingVersion.length === 1 ? matchingVersion[0] : undefined;
}

export function buildPluginVersionRows(
  plugin: MyPluginView | undefined,
  releases: readonly ContributionReleaseView[],
  history: readonly VersionEvent[],
  installation: MyPluginLocalInstance | null,
) {
  const submissions: SubmissionRow[] = releases.map(release => ({
    kind: 'submission', key: releaseKey(release), version: release.version, release, events: [],
  }));
  const market = plugin?.market;
  const listedVersion = market?.state === 'available' ? market.version : null;
  const listedKey = listedVersion ? JSON.stringify(['published', market?.releaseId, listedVersion]) : null;
  const listedSubmission = listedKey && market?.releaseId
    ? submissions.find(row => row.release.releaseId === market.releaseId && row.release.revisionState === 'current')
      ?? submissions.find(row => row.release.releaseId === market.releaseId)
    : undefined;
  const publishedRow: VersionRow | undefined = listedVersion && listedKey && !listedSubmission
    ? { kind: 'published', key: listedKey, version: listedVersion, events: [] }
    : undefined;
  const chronological = [...history].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const noticeEvent = market && marketNoticeEvent(market, chronological);
  const versionEvents = new Map<string, VersionEvent[]>();
  const marketEvents: VersionEvent[] = [];

  for (const event of chronological) {
    if (!event.version) {
      if (event !== noticeEvent) marketEvents.push(event);
      continue;
    }
    const submission = submissionForEvent(event, submissions);
    if (submission) {
      submission.events.push(event);
    } else {
      const group = versionEvents.get(event.version);
      if (group) group.push(event);
      else versionEvents.set(event.version, [event]);
    }
  }

  const installedSubmission = installation?.origin === 'public' && installation.version === listedVersion
    ? listedSubmission
    : submissions.find(row => row.version === installation?.version);
  const installedRow = installedSubmission ?? (publishedRow && installation?.version === listedVersion
    ? publishedRow : undefined);
  const localRow: VersionRow | undefined = installation && !installedRow &&
    installation.version !== listedVersion && !submissions.some(row => row.version === installation.version)
    ? { kind: 'local', key: JSON.stringify(['local', installation.instanceId, installation.version]), version: installation.version }
    : undefined;
  const historyRows: VersionRow[] = [...versionEvents].sort(([, left], [, right]) =>
    Date.parse(right.at(-1)!.at) - Date.parse(left.at(-1)!.at)).map(([version, events]) => ({
    kind: 'history', key: historyRowKey(version), version, events,
  }));
  const rows: VersionRow[] = [
    ...(localRow ? [localRow] : []),
    ...submissions,
    ...(publishedRow ? [publishedRow] : []),
    ...historyRows,
    ...(marketEvents.length ? [{ kind: 'market' as const, key: 'market-changes', events: marketEvents }] : []),
  ];
  return { rows, localRow, publishedRow, listedKey, listedSubmission, noticeEvent, installedKey: installedRow?.key ?? localRow?.key };
}

export function restorePluginVersionSelection(versions: ReturnType<typeof buildPluginVersionRows>, key: string | undefined) {
  if (!key) return undefined;
  const row = versions.rows.find(entry => entry.key === key);
  if (row) return row;
  if (key === versions.listedKey) return versions.listedSubmission;
  // A page of submissions may absorb an event-only row. Keep it selected when the match is unambiguous.
  const matching = versions.rows.filter(entry =>
    entry.kind === 'submission' && entry.events.length > 0 && historyRowKey(entry.version) === key);
  return matching.length === 1 ? matching[0] : undefined;
}

export function versionSnapshotEvent(row: VersionRow | undefined) {
  return row?.kind === 'history' ? row.events.filter(event => event.submissionId).at(-1) : undefined;
}

export function versionEventSnapshot(event: VersionEvent, snapshots: Readonly<Record<string, ContributionReleaseView>>) {
  const snapshot = event.submissionId ? snapshots[event.submissionId] : undefined;
  return snapshot && snapshot.submissionId === event.submissionId &&
    (!event.releaseId || snapshot.releaseId === event.releaseId) &&
    (!event.version || snapshot.version === event.version) ? snapshot : undefined;
}

const statusIcons: Record<string, LucideIcon> = {
  local: CircleDashed,
  rejected: TriangleAlert,
  pending: Clock,
  approved: CircleCheck,
  published: CircleCheck,
  enabled: CircleCheck,
  cancelled: CircleMinus,
};

export function VersionStatusIcon({ status, size, secondary = false, className }: {
  status: string;
  size: number;
  secondary?: boolean;
  className?: string;
}) {
  const Icon = statusIcons[status] ?? Info;
  return <Icon size={size} aria-hidden="true" className={cn(
    'shrink-0',
    status === 'rejected' ? 'text-[var(--warning-fg)]'
      : secondary ? 'text-[var(--text-secondary)]'
        : status === 'published' ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]',
    className,
  )} />;
}

export function pluginSubmissionStatus(release: ContributionReleaseView, market: MyPluginView['market']) {
  if (release.reviewStatus === 'approved' && release.revisionState === 'current' &&
    market.state === 'available' && market.releaseId === release.releaseId) return 'published';
  return release.reviewStatus ?? release.revisionState;
}

function rowStatus(row: VersionRow, market: MyPluginView['market']) {
  if (row.kind === 'local') return 'local';
  if (row.kind === 'published') return 'published';
  if (row.kind === 'submission') return pluginSubmissionStatus(row.release, market);
  const event = row.events.at(-1);
  return event ? versionEventKind(event) : 'current';
}

export function pluginSubmissionDate(release: ContributionReleaseView, status: string) {
  if (status === 'cancelled') return release.cancelledAt ?? null;
  if (status === 'approved' || status === 'published') return release.approvedAt ?? null;
  if (status === 'rejected') return release.reviewedAt;
  return release.submittedAt;
}

function rowDate(row: VersionRow, status: string) {
  if (row.kind === 'local') return null;
  const eventStatus = status === 'published' ? 'enabled' : status === 'pending' ? 'submitted' : status;
  const event = row.events.filter(entry => versionEventKind(entry) === eventStatus).at(-1) ?? row.events.at(-1);
  if (event) return event.at;
  return row.kind === 'submission' ? pluginSubmissionDate(row.release, status) : null;
}

function VersionNotes({ value, state }: { value: unknown; state?: 'loading' | 'snapshotUnavailable' | 'publishedContentUnavailable' }) {
  const { t } = useTranslation();
  const id = useId();
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const notes = typeof value === 'string' && value.trim() ? value : null;

  useLayoutEffect(() => {
    const paragraph = ref.current;
    if (!notes || !paragraph || expanded) return;
    const measure = () => {
      const { width } = paragraph.getBoundingClientRect();
      const lineHeight = Number.parseFloat(getComputedStyle(paragraph).lineHeight);
      if (!width || !Number.isFinite(lineHeight)) return;

      // A clamped Chromium paragraph can report only its visible height.
      const measurement = paragraph.cloneNode(true) as HTMLParagraphElement;
      measurement.removeAttribute('id');
      measurement.classList.remove('line-clamp-10');
      Object.assign(measurement.style, {
        position: 'fixed', width: `${width}px`, visibility: 'hidden', pointerEvents: 'none',
      });
      paragraph.parentElement?.appendChild(measurement);
      const fullHeight = measurement.getBoundingClientRect().height;
      measurement.remove();
      setOverflows(fullHeight > 10 * lineHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(paragraph);
    return () => observer.disconnect();
  }, [notes, expanded]);

  return (
    <section className="mt-5">
      <h4 className="mb-1 text-13 font-medium leading-[1.54] text-[var(--text-tertiary)]">{t(`${copy}.releaseNotes`)}</h4>
      <p
        id={id}
        ref={ref}
        role={state === 'loading' ? 'status' : undefined}
        className={cn(
          'select-text whitespace-pre-wrap text-14 leading-[1.7] [overflow-wrap:anywhere]',
          notes ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]',
          notes && !expanded && 'line-clamp-10',
        )}
      >
        {notes ?? t(`${copy}.${state ?? 'noReleaseNotes'}`)}
      </p>
      {notes && overflows ? (
        <Button type="button" variant="secondary" tone="quiet" size="sm" compact
          aria-controls={id} aria-expanded={expanded} className="mt-1 -ml-2"
          onClick={() => setExpanded(value => !value)}>
          {t(expanded ? 'settings.ghosts.detail.descriptionCollapse' : `${copy}.expandReleaseNotes`)}
          <ChevronDown size={14} aria-hidden="true" className={expanded ? 'rotate-180' : undefined} />
        </Button>
      ) : null}
    </section>
  );
}

function VersionIntroduction({ content, icon, id }: {
  content: { name: string; description?: string };
  icon?: string | null;
  id: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex min-w-0 items-center gap-2.5 text-14 font-medium text-[var(--text-primary)]">
        {icon !== undefined ? <GhostPluginIcon iconDataUrl={icon ?? undefined} iconId={id} iconName={content.name} size="sm" /> : null}
        <span className="min-w-0 [overflow-wrap:anywhere]">{content.name}</span>
      </div>
      {content.description ? (
        <p className="select-text whitespace-pre-wrap text-13 leading-[1.6] text-[var(--text-secondary-mid)] [overflow-wrap:anywhere]">{content.description}</p>
      ) : null}
    </div>
  );
}

function VersionTechnicalFields({ release }: { release: ContributionReleaseView }) {
  const { t } = useTranslation();
  const fields = [
    ['releaseSha', release.sha256],
    ['uploadedSha', release.uploadedSha256],
    ['releaseId', release.releaseId],
    ['revision', release.revision],
  ];
  return (
    <div className="select-text text-12 leading-normal text-[var(--text-secondary)]">
      {release.source ? <p className="mb-2">{t(`${copy}.source.${release.source}`, { defaultValue: t(`${copy}.source.unknown`) })}</p> : null}
      <dl className="grid gap-2">
        {fields.map(([name, value]) => value ? (
          <div key={name}>
            <dt className="text-[var(--text-tertiary)]">{t(`${copy}.${name}`)}</dt>
            <dd className="break-all tabular-nums">{value}</dd>
          </div>
        ) : null)}
      </dl>
      {release.content ? <pre className="mt-3 whitespace-pre-wrap [overflow-wrap:anywhere]">{JSON.stringify(release.content.manifestView, null, 2)}</pre> : null}
    </div>
  );
}

function VersionSubmittedContent({ release, loading }: { release?: ContributionReleaseView; loading: boolean }) {
  const { t } = useTranslation();
  const content = release?.content;
  const permissions = usePluginPermissionFacts(content?.permissions ?? []);
  const notes = content?.manifestView.releaseNotes;
  if (loading) return <p role="status">{t(`${copy}.loading`)}</p>;
  return (
    <div className="space-y-4 text-13 leading-normal text-[var(--text-secondary)]">
      {content && release ? (
        <>
          <VersionIntroduction content={content} icon={content.iconUrl} id={release.releaseId} />
          {typeof notes === 'string' && notes.trim() ? (
            <div className="space-y-1">
              <p className="font-medium">{t(`${copy}.releaseNotes`)}</p>
              <p className="select-text whitespace-pre-wrap [overflow-wrap:anywhere]">{notes}</p>
            </div>
          ) : null}
          {permissions.length ? <PluginPermissionList items={permissions} showAll /> : null}
        </>
      ) : <p>{t(`${copy}.snapshotUnavailable`)}</p>}
      {release ? <VersionTechnicalFields release={release} /> : null}
    </div>
  );
}

interface VersionSnapshots {
  snapshots: Readonly<Record<string, ContributionReleaseView>>;
  snapshotLoading: string | null;
  loadSnapshot: (submissionId: string) => void;
  detailTime: (value: string | null) => ReactNode;
}

function VersionTechnicalDetails({
  release, events, primarySubmissionId, snapshots, snapshotLoading, loadSnapshot, detailTime,
}: VersionSnapshots & {
  release?: ContributionReleaseView;
  events: readonly VersionEvent[];
  primarySubmissionId?: string | null;
}) {
  const { t } = useTranslation();
  return (
    <PluginDetailRecordRow icon={Code2} title={t(`${copy}.technicalDetails`)}>
      {release ? <VersionTechnicalFields release={release} /> : null}
      {events.length ? (
        <ul className={cn('grid gap-3', release && 'mt-3 border-t border-[var(--border-default)] pt-3')}>
          {events.map(event => {
            const submissionId = event.submissionId;
            const snapshot = versionEventSnapshot(event, snapshots);
            return (
              <li key={event.eventId} className="min-w-0 text-13 leading-normal text-[var(--text-secondary)]">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium text-[var(--text-primary)]">{t(`${copy}.event.${versionEventKind(event)}`)}</span>
                  {detailTime(event.at)}
                </p>
                {event.revision ? (
                  <p className="break-all text-12 leading-normal text-[var(--text-tertiary)]">
                    {event.revision.releaseId}<br />
                    {event.revision.sha256}<br />
                    {detailTime(event.revision.displayUpdatedAt)}
                  </p>
                ) : null}
                {submissionId && submissionId !== primarySubmissionId ? (
                  <PluginDetailRecordRow icon={FileText} title={t(`${copy}.submittedContent`)} onOpenChange={open => {
                    if (open && !snapshot && snapshotLoading !== submissionId) loadSnapshot(submissionId);
                  }}>
                    <VersionSubmittedContent release={snapshot} loading={snapshotLoading === submissionId} />
                  </PluginDetailRecordRow>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </PluginDetailRecordRow>
  );
}

interface LocalDraft {
  prepared?: PreparedPluginContribution;
  preparing: boolean;
  versionAlreadySubmitted: boolean;
  error?: string;
  blocker?: string;
}

interface VersionCardProps extends VersionSnapshots {
  row: VersionRow;
  plugin: MyPluginView;
  status: string;
  statusLabel: string;
  release?: ContributionReleaseView;
  primarySubmissionId?: string | null;
  installation: MyPluginLocalInstance | null;
  installationText: string | null;
  draft: LocalDraft;
  published: PluginMarketDetail | null;
  publishedLoading: boolean;
  cancelAction: ReactNode;
  cancelMessage?: string;
}

function VersionCard({
  row, plugin, status, statusLabel, release, primarySubmissionId,
  installation, installationText, draft, published, publishedLoading, cancelAction, cancelMessage, ...snapshots
}: VersionCardProps) {
  const { t } = useTranslation();
  const { detailTime, snapshotLoading } = snapshots;
  const events = row.kind === 'local' ? [] : row.events;
  const marketContent = row.kind === 'published' ? published : null;
  const preview = row.kind === 'local' ? draft.prepared : undefined;
  const content = release?.content;
  const permissions = usePluginPermissionFacts(content?.permissions ?? (marketContent ? ghostPermissionItems(marketContent.manifest) : []));
  const reasons = [...new Set([release?.reason, ...events.map(event => event.reason)]
    .map(reason => reason?.trim()).filter((reason): reason is string => Boolean(reason)))];
  const alreadySubmitted = installation && status !== 'pending' && row.kind !== 'local' && row.kind !== 'market' &&
    plugin.publisherKind !== 'official' && (row.kind === 'submission' || draft.versionAlreadySubmitted);
  const alreadySubmittedMessage = alreadySubmitted ? t(`${copy}.errors.VERSION_ALREADY_SUBMITTED`) : null;
  const submissionLoading = Boolean(primarySubmissionId && snapshotLoading === primarySubmissionId && !content);
  const contentState = row.kind === 'published' && !marketContent
    ? publishedLoading ? 'loading' : 'publishedContentUnavailable'
    : (row.kind === 'submission' || row.kind === 'history') && !content
      ? submissionLoading ? 'loading' : 'snapshotUnavailable' : undefined;
  const notes = row.kind === 'published' ? marketContent?.manifest.releaseNotes
    : row.kind === 'local' ? preview?.releaseNotes : content?.manifestView.releaseNotes;
  const fallbackTimes = release && !events.length ? [
    { key: 'submittedAt', at: release.submittedAt },
    ...(release.reviewStatus === 'approved' ? [{ key: 'approvedAt', at: release.approvedAt ?? null }] : []),
    ...(release.reviewStatus === 'cancelled' || release.cancelledAt ? [{ key: 'cancelledAt', at: release.cancelledAt ?? null }] : []),
  ] : [];
  const hasTechnicalDetails = Boolean(release) ||
    (row.kind === 'market' ? events.some(event => event.revision || event.submissionId) : events.length > 0);

  return (
    <div className="animate-fade-in">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <h3 className="min-w-0 text-20 font-medium leading-[1.3] tabular-nums text-[var(--text-primary)] [overflow-wrap:anywhere]">
            {row.kind === 'market' ? t(`${copy}.marketChanges`) : row.version}
          </h3>
          {row.kind !== 'local' && row.kind !== 'market' ? (
            <span className="inline-flex max-w-full items-center gap-1.5 text-13 leading-normal text-[var(--text-secondary)]">
              <VersionStatusIcon status={status} size={16} secondary />
              <span className="min-w-0 [overflow-wrap:anywhere]">{statusLabel}</span>
            </span>
          ) : null}
        </div>
        {cancelAction}
      </div>
      {row.kind === 'market' ? (
        <ul className="mt-3 grid gap-3">
          {events.map(event => (
            <li key={event.eventId} className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-14 font-medium">{t(`${copy}.event.${versionEventKind(event)}`)}</span>
                <span className="text-12 text-[var(--text-tertiary)]">{detailTime(event.at)}</span>
              </div>
              {event.reason?.trim() ? <p className="mt-1 select-text whitespace-pre-wrap text-14 leading-[1.6] text-[var(--text-secondary-mid)] [overflow-wrap:anywhere]">{event.reason}</p> : null}
            </li>
          ))}
        </ul>
      ) : row.kind !== 'local' ? (
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-12 leading-normal tabular-nums text-[var(--text-tertiary)]">
          {events.length ? events.map(event => (
            <span key={event.eventId}>{t(`${copy}.event.${versionEventKind(event)}`)} {detailTime(event.at)}</span>
          )) : fallbackTimes.length ? fallbackTimes.map(({ key, at }) => (
            <span key={key}>{t(`${copy}.${key}`)} {detailTime(at)}</span>
          )) : <span>{detailTime(null)}</span>}
        </div>
      ) : null}
      {installationText ? (
        <p className="mt-1.5 flex items-center gap-1.5 text-12 leading-normal text-[var(--text-secondary)]">
          <Monitor size={14} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />{installationText}
        </p>
      ) : null}
      {reasons.length && row.kind !== 'market' ? (
        <div className="mt-[18px] rounded-lg bg-[var(--surface-chip)] px-3.5 py-3">
          <h4 className="text-13 font-medium leading-[1.54] text-[var(--text-primary)]">{t(`${copy}.${status === 'rejected' ? 'rejectionReason' : 'reason'}`)}</h4>
          {reasons.map(reason => (
            <p key={reason} className="mt-0.5 select-text whitespace-pre-wrap text-14 leading-[1.6] text-[var(--text-primary)] [overflow-wrap:anywhere]">{reason}</p>
          ))}
          {alreadySubmittedMessage ? <p className="mt-2 text-13 leading-normal text-[var(--text-secondary)]">{alreadySubmittedMessage}</p> : null}
        </div>
      ) : null}
      {cancelMessage ? <p role="status" className="mt-3 text-13 leading-normal text-[var(--text-secondary)]">{cancelMessage}</p> : null}
      {row.kind === 'local' && (draft.error || draft.preparing || draft.blocker) ? (
        <p role={draft.error ? 'alert' : 'status'} className="mt-[18px] rounded-lg bg-[var(--surface-chip)] px-3.5 py-3 text-14 leading-[1.6] text-[var(--text-secondary)]">
          {draft.error ? t(draft.error) : draft.blocker ?? t(`${copy}.preparing`)}
        </p>
      ) : null}
      {row.kind !== 'market' && (row.kind !== 'local' || preview) ? (
        <VersionNotes value={notes} state={contentState} />
      ) : null}
      {!reasons.length && alreadySubmittedMessage ? (
        <p className="mt-4 text-12 leading-normal text-[var(--text-tertiary)]">{alreadySubmittedMessage}</p>
      ) : null}
      <div className="plugin-publish-version-records">
        {permissions.length ? (
          <PluginDetailRecordRow icon={Shield} title={t('settings.ghosts.detail.permissionsTitle')} summary={t('settings.ghosts.perm.itemCount', { count: permissions.length })}>
            <PluginPermissionList items={permissions} />
          </PluginDetailRecordRow>
        ) : null}
        {content || marketContent || preview ? (
          <PluginDetailRecordRow icon={FileText} title={t('settings.ghosts.detail.readmeTitle')}>
            {content && release ? <VersionIntroduction content={content} icon={content.iconUrl} id={release.releaseId} />
              : marketContent ? <VersionIntroduction content={{
                name: marketContent.name, description: marketContent.description || marketContent.manifest.description,
              }} icon={marketContent.icon?.url ?? null} id={marketContent.pluginId} />
              : preview ? <VersionIntroduction content={preview} id={preview.ghostId} /> : null}
          </PluginDetailRecordRow>
        ) : null}
        {hasTechnicalDetails ? (
          <VersionTechnicalDetails {...snapshots} release={release} events={events} primarySubmissionId={primarySubmissionId} />
        ) : null}
      </div>
    </div>
  );
}

export function PluginPublishVersions({
  plugin, rows, selected, installedKey, installed, installationState, installationPicker,
  unreadKey, unreadTone, unreadAction, versionFailure, rowRelease, primarySubmissionId,
  draft, published, publishedLoading, cancelAction, cancelMessage, loadMore, loadingMore, onSelect, ...snapshots
}: VersionSnapshots & {
  plugin: MyPluginView;
  rows: readonly VersionRow[];
  selected?: VersionRow;
  installedKey?: string;
  installed: MyPluginLocalInstance | null;
  installationState?: 'missing' | 'unavailable';
  installationPicker: ReactNode;
  unreadKey?: string;
  unreadTone: DotTone;
  unreadAction: ReactNode;
  versionFailure: string | null;
  rowRelease?: ContributionReleaseView;
  primarySubmissionId?: string | null;
  draft: LocalDraft;
  published: PluginMarketDetail | null;
  publishedLoading: boolean;
  cancelAction: ReactNode;
  cancelMessage?: string;
  loadMore?: () => void;
  loadingMore: boolean;
  onSelect: (key: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const panelId = useId();
  const rail = useRef<HTMLElement>(null);
  const selectedButton = useRef<HTMLButtonElement>(null);
  const installationText = installed
    ? `${t(`settings.ghosts.page.origin.${installed.origin}`)} · ${t(`${copy}.${installed.enabled ? 'localEnabled' : 'localDisabled'}`)}`
    : null;
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const shortDate = useMemo(() => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }), [locale]);
  const versionLabel = (row: VersionRow) => row.kind === 'market' ? t(`${copy}.marketChanges`) : row.version;
  const statusLabel = (row: VersionRow, status: string) => row.kind === 'local' ? installationText ?? ''
    : t(`${copy}.${row.kind === 'history' || row.kind === 'market' ? 'event' : 'review'}.${status}`);

  useLayoutEffect(() => {
    const container = rail.current;
    const button = selectedButton.current;
    if (!container || !button) return;
    const keepSelectedVisible = () => {
      if (container.scrollWidth <= container.clientWidth) return;
      const bounds = container.getBoundingClientRect();
      const selectedBounds = button.getBoundingClientRect();
      const delta = selectedBounds.left < bounds.left ? selectedBounds.left - bounds.left
        : selectedBounds.right > bounds.right ? selectedBounds.right - bounds.right : 0;
      if (delta) container.scrollLeft += delta;
    };
    keepSelectedVisible();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(keepSelectedVisible);
    observer.observe(container);
    return () => observer.disconnect();
  }, [selected?.key, rows.length, locale]);

  const selectedStatus = selected ? rowStatus(selected, plugin.market) : null;
  return (
    <section aria-label={t(`${copy}.versionManagement`)} className="plugin-publish-versions mt-11">
      <h2 id={titleId} className="mb-3.5 text-16 font-medium leading-normal text-[var(--text-primary)]">{t(`${copy}.history`)}</h2>
      {versionFailure ? <p role="alert" className="mb-3 text-13 text-[var(--text-secondary)]">
        {t(versionFailure, { defaultValue: t(`${copy}.loadFailed`) })}
      </p> : null}
      <div className="plugin-publish-versions-grid">
        <nav ref={rail} aria-labelledby={titleId} className="plugin-publish-versions-rail">
          {unreadAction}
          {installationPicker}
          {rows.map(row => {
            const status = rowStatus(row, plugin.market);
            const date = rowDate(row, status);
            const time = date ? new Date(date) : null;
            const current = row.key === selected?.key;
            return (
              <button key={row.key} ref={current ? selectedButton : undefined} type="button"
                aria-current={current || undefined} aria-controls={panelId}
                className="plugin-publish-version-row rounded-lg transition-colors duration-[var(--motion-fast)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
                onClick={() => onSelect(row.key)}>
                <VersionStatusIcon status={status} size={16} />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-14 font-medium leading-[1.429] tabular-nums text-[var(--text-primary)]">
                    <span className="min-w-0 [overflow-wrap:anywhere]">{versionLabel(row)}</span>
                    {row.key === installedKey ? <span className="text-12 font-normal leading-normal text-[var(--text-tertiary)]">
                      {t('settings.devices.thisDevice')}
                    </span> : null}
                    {row.key === unreadKey ? <span role="img" aria-label={t(`${copy}.unreadReview`)} className="inline-flex self-center"><AttentionDot tone={unreadTone} /></span> : null}
                  </span>
                  <span className="plugin-publish-version-row-status block text-12 leading-normal tabular-nums [overflow-wrap:anywhere]">
                    {statusLabel(row, status)}
                    {time && Number.isFinite(time.getTime()) ? <> · <time dateTime={date!}>{shortDate.format(time)}</time></> : null}
                  </span>
                </span>
              </button>
            );
          })}
          {installationState ? (
            <p className="plugin-publish-version-local-state text-12 leading-normal text-[var(--text-tertiary)]">
              <Monitor size={16} aria-hidden="true" className="shrink-0" />
              {t(`${copy}.localState.${installationState}`)}
            </p>
          ) : null}
          {loadMore ? (
            <Button type="button" variant="secondary" size="sm" compact className="plugin-publish-version-more"
              loading={loadingMore} disabled={loadingMore} onClick={loadMore}>{t(`${copy}.loadMore`)}</Button>
          ) : null}
        </nav>
        {selected && selectedStatus ? (
          <article id={panelId} aria-label={versionLabel(selected)} className="plugin-publish-version-card">
            <VersionCard key={selected.key} {...snapshots} row={selected} status={selectedStatus}
              statusLabel={statusLabel(selected, selectedStatus)} plugin={plugin} release={rowRelease}
              primarySubmissionId={primarySubmissionId} installation={selected.key === installedKey ? installed : null}
              installationText={selected.key === installedKey ? installationText : null} draft={draft}
              published={published} publishedLoading={publishedLoading} cancelAction={cancelAction} cancelMessage={cancelMessage} />
          </article>
        ) : <p id={panelId} className="text-14 text-[var(--text-tertiary)]">{t(`${copy}.noSubmission`)}</p>}
      </div>
    </section>
  );
}
