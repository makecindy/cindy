/**
 * Organization ("团队共享") plugin detail on the 「发布插件」 page (#1541).
 *
 * Same structure and wording as the public plugin detail (overview, 本地版本, 已上架, 当前提审),
 * plus what only organization plugins have (#1504 permission table): the visibility audience,
 * maintainers (creator adds/removes, maintainers only view), delist / list (an administrator's
 * delisting can only be undone by an administrator) and cancelling a pending review.
 * The release history waits for the per-release review contract from the server.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Input } from '@/components/ui/input';
import { usePluginReviewUpdates } from '@/contexts/PluginReviewUpdatesContext';
import { useWindowShown } from '@/hooks/useWindowVisible';
import {
  ORGANIZATION_REVIEW_ID_PREFIX,
  type AuthorDepartment,
  type Colleague,
  type PersonalPluginDetail,
  type PersonalRelease,
  type PluginMaintainer,
} from '../../../../shared/pluginAuthor';
import { AudienceEditor } from '../audience/AudienceEditor';
import {
  audienceOf,
  audienceSummaryNames,
  draftOf,
  memberLabel,
  type AudienceDraft,
} from '../audience/audienceDraft';
import { GhostPluginIcon } from '../GhostPluginIcon';
import type { GhostPluginListItem } from '../lib/ghostPluginViewModel';
import { contributionErrorKey } from '../lib/useContributionPreview';
import { PluginUsageCounters } from '../PluginSharedUsage';
import { VersionFactsList } from '../PluginVersionFacts';
import { teamListingActions, teamMarketState, teamPendingRelease, teamPluginIconUrl } from './teamPluginModel';

const copy = 'settings.ghosts.contribution';
const teamCopy = 'settings.ghosts.contribution.team';
const audienceCopy = 'settings.ghosts.audience';
const SEARCH_DEBOUNCE_MS = 200;

type Busy = null | 'listing' | 'cancel' | 'audience' | 'maintainer' | 'publish';

export function TeamPluginDetail({
  pluginId,
  memberName,
  localPlugins,
  onStartPublish,
  renderHeaderAction,
  refreshSignal,
}: {
  pluginId: string;
  memberName: string | null;
  /** The member's local development copies that may be published to team sharing. */
  localPlugins: readonly GhostPluginListItem[];
  onStartPublish: (instanceId: string) => Promise<boolean>;
  renderHeaderAction?: (refresh: () => void, loading: boolean) => React.ReactNode;
  /**
   * Changes when this plugin may have changed elsewhere (the organization change signal, a team
   * publish that succeeded); the open detail then reads again.
   */
  refreshSignal?: string;
}) {
  const { t, i18n } = useTranslation();
  const { confirm } = useConfirmDialog();
  const api = window.electronAPI.pluginAuthor;
  const [detail, setDetail] = useState<PersonalPluginDetail | null>(null);
  const [maintainers, setMaintainers] = useState<PluginMaintainer[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [departments, setDepartments] = useState<AuthorDepartment[] | null>(null);
  const [audienceDialog, setAudienceDialog] = useState<AudienceDraft | null>(null);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<Colleague[] | null>(null);
  const [history, setHistory] = useState<{
    releases: PersonalRelease[]; nextCursor: string | null; loading: boolean; failed: boolean;
  } | null>(null);
  const historyRequest = useRef(0);
  const request = useRef(0);
  const mounted = useRef(true);
  // Closes open confirmations when the page goes away (owner switches remount this component).
  const lifetime = useRef(new AbortController());
  useEffect(() => {
    mounted.current = true;
    lifetime.current = new AbortController();
    return () => {
      mounted.current = false;
      request.current += 1;
      lifetime.current.abort();
    };
  }, []);
  /** A confirmation answered after the page or account went away must not send anything. */
  const confirmStill = async (options: Parameters<typeof confirm>[0]) => {
    const signal = lifetime.current.signal;
    const accepted = await confirm(options, signal);
    return accepted && mounted.current && !signal.aborted;
  };

  /** Version history is read when 「发布记录」 is opened, then page by page on demand. */
  const loadHistory = useCallback((cursor: string | null) => {
    const id = ++historyRequest.current;
    setHistory((current) => ({
      releases: cursor ? current?.releases ?? [] : [], nextCursor: cursor, loading: true, failed: false,
    }));
    api.releases(pluginId, cursor ?? undefined).then(
      (page) => {
        if (historyRequest.current !== id || !mounted.current) return;
        setHistory((current) => ({
          releases: [...(cursor ? current?.releases ?? [] : []), ...page.releases],
          nextCursor: page.nextCursor, loading: false, failed: false,
        }));
      },
      () => {
        if (historyRequest.current !== id || !mounted.current) return;
        setHistory((current) => current ? { ...current, loading: false, failed: true } : null);
      },
    );
  }, [api, pluginId]);

  const load = useCallback(() => {
    const id = ++request.current;
    setLoading(true);
    Promise.all([api.plugin(pluginId), api.maintainers(pluginId).catch(() => null)]).then(
      ([plugin, people]) => {
        if (request.current !== id) return;
        setDetail(plugin);
        setMaintainers(people);
        setFailure(null);
      },
      (error: unknown) => {
        if (request.current === id) setFailure(contributionErrorKey(error));
      },
    ).finally(() => {
      if (request.current === id) setLoading(false);
    });
  }, [api, pluginId]);
  useEffect(load, [load]);
  const historyPanel = useRef<HTMLDetailsElement>(null);
  /**
   * Release history read before a refresh may be stale (a new review result, a cancelled
   * submission): reread it now when 「发布记录」 is open, otherwise drop it so opening reads again.
   */
  const reload = useCallback(() => {
    load();
    if (historyPanel.current?.open) {
      loadHistory(null);
    } else {
      historyRequest.current += 1;
      setHistory(null);
    }
  }, [load, loadHistory]);

  // Opening the detail reads the review result shown here (issue #1541 rule 5): only once the
  // detail on screen shows that exact result and the page is visible. A newer result arriving
  // through the change signal reloads the detail first.
  // A publish started from this page, or any other change, must not leave the detail (and its
  // submit button) on the old state (Greptile review on #12469). The first value is the mount read.
  const seenSignal = useRef(refreshSignal);
  useEffect(() => {
    if (seenSignal.current === refreshSignal) return;
    seenSignal.current = refreshSignal;
    reload();
  }, [refreshSignal, reload]);

  const reviews = usePluginReviewUpdates();
  const unreadReview = reviews.updates.find((item) =>
    item.unread && item.pluginId === `${ORGANIZATION_REVIEW_ID_PREFIX}${pluginId}`);
  // The event on screen; reading it marks exactly that event read (#1593 latestReviewEvent.id).
  const shownKey = detail?.latestReviewEvent?.id ?? null;
  const { markRead } = reviews;
  // A minimized or hidden window can still report visibilityState 'visible' while background
  // throttling is off, so Main's window-hidden signal must also say the window is shown.
  const visible = useWindowShown();
  const reloadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!detail || !unreadReview) return;
    if (unreadReview.key === shownKey) {
      if (visible) void markRead(unreadReview.pluginId, unreadReview.key);
    } else if (reloadedFor.current !== unreadReview.key) {
      reloadedFor.current = unreadReview.key;
      reload();
    }
  }, [detail, unreadReview, shownKey, visible, markRead, reload]);

  const audienceDraft = useMemo(
    () => (detail ? draftOf(detail.visibilityAudience, detail.visibilityAudienceMembers ?? []) : null),
    [detail],
  );
  const needsDepartments = (audienceDraft?.departmentIds.length ?? 0) > 0;
  useEffect(() => {
    if (!needsDepartments || departments) return;
    api.departments().then((value) => { if (mounted.current) setDepartments(value); }, () => undefined);
  }, [api, needsDepartments, departments]);

  const keyword = search.trim();
  useEffect(() => {
    if (!adding || !keyword) {
      setFound(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api.searchColleagues(keyword).then(
        (members) => { if (!cancelled) setFound(members.filter((member) => member.active)); },
        () => { if (!cancelled) setFound([]); },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, adding, keyword]);

  /** Runs one write, then rereads; failures show the shared contribution error wording. */
  const write = async (kind: Busy, action: () => Promise<unknown>): Promise<boolean> => {
    if (busy) return false;
    setBusy(kind);
    setFailure(null);
    try {
      const result = await action();
      if (!mounted.current) return false;
      if (result && typeof result === 'object' && 'ghostId' in result) setDetail(result as PersonalPluginDetail);
      reload();
      return true;
    } catch (error) {
      if (mounted.current) setFailure(contributionErrorKey(error));
      return false;
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const formatDate = (value: string | null | undefined) =>
    value ? new Date(value).toLocaleString(i18n.resolvedLanguage ?? i18n.language) : t(`${copy}.timeUnavailable`);

  if (!detail) {
    return (
      <div className="space-y-3">
        {failure ? (
          <>
            <p role="alert" className="text-14 leading-[1.714] text-[var(--text-secondary)]">
              {t(failure, { defaultValue: t(`${copy}.loadFailed`) })}
            </p>
            {/* The header refresh only appears with a loaded detail; a first failed read retries here. */}
            <Button variant="secondary" size="sm" loading={loading} disabled={loading} onClick={reload}>
              {t(`${audienceCopy}.picker.retry`)}
            </Button>
          </>
        ) : loading ? (
          <p role="status" className="text-14 text-[var(--text-tertiary)]">{t(`${copy}.loading`)}</p>
        ) : null}
      </div>
    );
  }

  const localPlugin = localPlugins.find((local) => local.ghostId === detail.ghostId) ?? null;
  const market = teamMarketState(detail);
  const pending = teamPendingRelease(detail);
  const rejected = detail.latestRelease?.reviewStatus === 'rejected' ? detail.latestRelease : null;
  const rejectionReason = detail.lastRejection?.detail?.reason?.trim();
  const listing = teamListingActions(detail);
  const isCreator = detail.myRole === 'creator';
  const localBlocker = localPlugin
    ? pending ? 'PLUGIN_PENDING_RELEASE_EXISTS'
      : detail.latestRelease?.version === localPlugin.version || detail.currentRelease?.version === localPlugin.version
        ? 'VERSION_ALREADY_SUBMITTED' : null
    : null;
  const audienceNames = audienceDraft && audienceDraft.mode === 'matchAny'
    ? audienceSummaryNames(audienceDraft, departments, {
      unknownDepartment: t(`${audienceCopy}.picker.unknownDepartment`),
      role: (role) => t(`${audienceCopy}.roleLabels.${role}`, { defaultValue: role }),
      memberId: (id) => t(`${audienceCopy}.picker.memberId`, { id }),
    })
    : null;
  const audienceSummary = !audienceDraft || audienceDraft.mode === 'all'
    ? t(`${audienceCopy}.all`)
    : audienceNames === null
      ? t(`${audienceCopy}.picker.loading`)
      : audienceNames.length > 3
        ? t(`${audienceCopy}.namesMore`, { names: audienceNames.slice(0, 3).join(t(`${audienceCopy}.separator`)), count: audienceNames.length })
        : audienceNames.join(t(`${audienceCopy}.separator`));
  const nextAudience = audienceDialog ? audienceOf(audienceDialog) : null;
  const audienceChanged = Boolean(nextAudience && audienceDraft &&
    JSON.stringify(nextAudience) !== JSON.stringify(audienceOf(audienceDraft)));

  const confirmListing = async (next: 'active' | 'disabled') => {
    const accepted = await confirmStill({
      title: t(`${teamCopy}.${next === 'active' ? 'listTitle' : 'delistTitle'}`, { name: detail.name }),
      description: t(`${teamCopy}.${next === 'active' ? 'listDescription' : 'delistDescription'}`),
      confirmText: t(`${teamCopy}.${next === 'active' ? 'list' : 'delist'}`),
      cancelText: t(`${audienceCopy}.picker.cancel`),
    });
    if (accepted) await write('listing', () => api.updatePlugin(detail.id, { status: next }));
  };
  const cancelPendingReview = async () => {
    if (!pending) return;
    const accepted = await confirmStill({
      title: t(`${copy}.cancelReviewTitle`, { name: detail.name, version: pending.version }),
      description: t(`${copy}.cancelReviewDescription`, { version: pending.version }),
      confirmText: t(`${copy}.cancelReview`),
      cancelText: t(`${copy}.keepReview`),
    });
    if (accepted) await write('cancel', () => api.cancelReview(detail.id, pending.id));
  };
  const removeMaintainer = async (maintainer: PluginMaintainer) => {
    const name = memberLabel(maintainer);
    const accepted = await confirmStill({
      title: t(`${teamCopy}.removeMaintainerTitle`, { name }),
      description: t(`${teamCopy}.removeMaintainerDescription`),
      confirmText: t(`${teamCopy}.removeMaintainer`),
      cancelText: t(`${audienceCopy}.picker.cancel`),
    });
    if (accepted) await write('maintainer', () => api.removeMaintainer(detail.id, maintainer.id));
  };

  const sectionClass = 'space-y-3 border-t border-[var(--border-default)] pt-5';
  const heading = 'text-16 font-medium leading-[1.5] text-[var(--text-primary)]';
  const body = 'text-14 leading-[1.714] text-[var(--text-secondary)]';

  return (
    <>
      <header className="mb-6 flex min-w-0 flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-4">
          <GhostPluginIcon iconDataUrl={teamPluginIconUrl(detail)} iconId={detail.id} iconName={detail.name} size="detail" />
          <div className="min-w-0">
            <h1 className="min-w-0 break-words text-20 font-medium leading-[1.4] text-[var(--text-primary)] [overflow-wrap:anywhere]">{detail.name}</h1>
            <div className="plugin-detail-metadata mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-13 leading-[1.54] text-[var(--text-tertiary)]">
              {memberName ? <span className="min-w-0 break-words">{memberName}</span> : null}
              {market.state === 'available' ? <>
                {memberName ? <span aria-hidden="true">·</span> : null}
                <span>v{market.version}</span>
              </> : null}
              <PluginUsageCounters
                downloadCount={detail.downloadStatistics?.requestCount}
                usageCount={detail.usageStatistics?.usageCount}
              />
            </div>
          </div>
        </div>
        {renderHeaderAction?.(reload, loading)}
      </header>
      {failure ? (
        <p role="alert" className="mb-4 whitespace-pre-wrap text-14 leading-[1.714] text-[var(--text-secondary)]">
          {t(failure, { defaultValue: t(`${copy}.loadFailed`) })}
        </p>
      ) : null}
      <div className="space-y-6 pb-8">
        <VersionFactsList
          local={localPlugin ? localPlugin.version : t(`${copy}.localState.missing`)}
          listed={market.state === 'available' ? market.version : t(`${copy}.market.${market.state}`)}
          pending={pending ? pending.version : t(`${copy}.noPendingVersion`)}
        />
        <section aria-label={t(`${copy}.localVersion`)} className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <h2 className={heading}>{t(`${copy}.localVersion`)}</h2>
              <p className={body}>{localPlugin ? localPlugin.version : t(`${copy}.localState.missing`)}</p>
            </div>
            {localPlugin && !localBlocker && detail.status !== 'archived' ? (
              <Button variant="cta" size="sm" loading={busy === 'publish'} disabled={busy !== null}
                onClick={() => {
                  // Opens the confirmation screen; the publish itself continues in Main.
                  setBusy('publish');
                  setFailure(null);
                  void onStartPublish(localPlugin.id).then((started) => {
                    if (!mounted.current) return;
                    setBusy(null);
                    if (!started) setFailure(`${copy}.teamStartFailed`);
                  });
                }}>
                {t(`${copy}.submitVersion`, { version: localPlugin.version })}
              </Button>
            ) : null}
          </div>
          {localPlugin && localBlocker ? (
            <p role="status" className="text-12 leading-[1.667] text-[var(--text-tertiary)]">{t(`${copy}.errors.${localBlocker}`)}</p>
          ) : null}
        </section>
        <section aria-label={t(`${copy}.listedVersion`)} className={sectionClass}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className={heading}>
              {t(`${copy}.listedVersion`)}{market.state === 'available' ? ` · ${market.version}` : ''}
            </h2>
            {listing.canDelist ? (
              <Button variant="secondary" size="sm" loading={busy === 'listing'} disabled={busy !== null}
                onClick={() => void confirmListing('disabled')}>{t(`${teamCopy}.delist`)}</Button>
            ) : listing.canList ? (
              <Button variant="secondary" size="sm" loading={busy === 'listing'} disabled={busy !== null}
                onClick={() => void confirmListing('active')}>{t(`${teamCopy}.list`)}</Button>
            ) : null}
          </div>
          {market.state === 'available'
            ? <p className="select-text whitespace-pre-wrap break-words text-14 leading-[1.714] text-[var(--text-primary)]">{detail.description}</p>
            : <p className={body}>{t(`${copy}.market.${market.state}`)}</p>}
          {listing.delistedByAdmin ? <p role="status" className={body}>{t(`${teamCopy}.delistedByAdmin`)}</p> : null}
        </section>
        <section aria-label={t(`${copy}.currentSubmission`)} className={sectionClass}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className={heading}>{t(`${copy}.currentSubmission`)}</h2>
            {pending ? (
              <Button variant="secondary" size="sm" loading={busy === 'cancel'} disabled={busy !== null}
                onClick={() => void cancelPendingReview()}>{t(`${copy}.cancelReview`)}</Button>
            ) : null}
          </div>
          {pending ? <>
            <p className="flex flex-wrap gap-x-2 text-14 leading-[1.714] text-[var(--text-primary)]">
              <span>{pending.version}</span><span aria-hidden="true">·</span><span>{t(`${copy}.review.pending`)}</span>
            </p>
            <p className="text-13 leading-[1.54] text-[var(--text-secondary)]">{t(`${copy}.submittedAt`)} · {formatDate(pending.publishedAt)}</p>
          </> : rejected ? <>
            <p className="flex flex-wrap gap-x-2 text-14 leading-[1.714] text-[var(--text-primary)]">
              <span>{rejected.version}</span><span aria-hidden="true">·</span><span>{t(`${copy}.review.rejected`)}</span>
            </p>
            {rejectionReason ? <>
              <h3 className="text-13 font-medium leading-[1.54] text-[var(--text-secondary)]">{t(`${copy}.reason`)}</h3>
              <p className="select-text whitespace-pre-wrap break-words text-14 leading-[1.714] text-[var(--text-primary)]">{rejectionReason}</p>
            </> : null}
          </> : <p className={body}>{t(`${copy}.noSubmission`)}</p>}
        </section>
        <section aria-label={t(`${audienceCopy}.title`)} className={sectionClass}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className={heading}>{t(`${audienceCopy}.title`)}</h2>
            {detail.status !== 'archived' && audienceDraft ? (
              <Button variant="secondary" size="sm" disabled={busy !== null}
                onClick={() => setAudienceDialog(audienceDraft)}>{t(`${teamCopy}.edit`)}</Button>
            ) : null}
          </div>
          <p className="break-words text-14 leading-[1.714] text-[var(--text-primary)]">{audienceSummary}</p>
          <p className="text-12 leading-[1.333] text-[var(--text-tertiary)]">{t(`${audienceCopy}.impact`)}</p>
        </section>
        <section aria-label={t(`${teamCopy}.maintainers`)} className={sectionClass}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className={heading}>{t(`${teamCopy}.maintainers`)}</h2>
            {isCreator && detail.status !== 'archived' && !adding ? (
              <Button variant="secondary" size="sm" disabled={busy !== null}
                onClick={() => setAdding(true)}>{t(`${teamCopy}.addMaintainer`)}</Button>
            ) : null}
          </div>
          {maintainers === null ? <p className={body}>{t(`${copy}.loadFailed`)}</p> : (
            <ul aria-label={t(`${teamCopy}.maintainers`)} className="divide-y divide-[var(--border-default)]">
              {maintainers.map((maintainer) => (
                <li key={maintainer.id} className="flex min-h-11 items-center gap-3 py-2">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-14 text-[var(--text-primary)]">{memberLabel(maintainer)}</span>
                    {maintainer.email && maintainer.email !== memberLabel(maintainer)
                      ? <span className="truncate text-12 text-[var(--text-tertiary)]">{maintainer.email}</span> : null}
                  </span>
                  <span className="shrink-0 text-12 text-[var(--text-tertiary)]">
                    {t(`${teamCopy}.role.${maintainer.authorizationRole}`)}
                  </span>
                  {isCreator && maintainer.authorizationRole !== 'creator' ? (
                    <Button variant="secondary" tone="quiet" size="sm" compact disabled={busy !== null}
                      onClick={() => void removeMaintainer(maintainer)}>{t(`${teamCopy}.removeMaintainer`)}</Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {adding ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Input type="search" size="sm" value={search} onChange={setSearch} className="min-w-0 max-w-xs"
                  ariaLabel={t(`${teamCopy}.searchMaintainer`)} placeholder={t(`${teamCopy}.searchMaintainer`)} />
                <Button variant="secondary" tone="quiet" size="sm" compact
                  onClick={() => { setAdding(false); setSearch(''); }}>{t(`${audienceCopy}.picker.cancel`)}</Button>
              </div>
              {keyword ? found === null
                ? <p role="status" className="text-12 text-[var(--text-tertiary)]">{t(`${audienceCopy}.picker.loading`)}</p>
                : found.length === 0
                  ? <p className="text-12 text-[var(--text-tertiary)]">{t(`${audienceCopy}.picker.noMembers`)}</p>
                  : (
                    <ul aria-label={t(`${audienceCopy}.picker.members`)}>
                      {found.map((member) => {
                        const existing = maintainers?.some((item) => item.membershipId === member.membershipId);
                        return (
                          <li key={member.membershipId} className="flex min-h-9 items-center gap-2">
                            <span className="flex min-w-0 flex-1 items-baseline gap-2">
                              <span className="shrink-0 truncate text-13 text-[var(--text-primary)]">{memberLabel(member)}</span>
                              {member.email && member.email !== memberLabel(member)
                                ? <span className="min-w-0 truncate text-12 text-[var(--text-tertiary)]">{member.email}</span> : null}
                            </span>
                            <Button variant="secondary" size="sm" compact disabled={busy !== null || existing}
                              loading={busy === 'maintainer'}
                              onClick={() => void write('maintainer', () => api.addMaintainer(detail.id, member.membershipId))
                                .then((done) => { if (done && mounted.current) { setAdding(false); setSearch(''); } })}>
                              {existing ? t(`${teamCopy}.role.maintainer`) : t(`${teamCopy}.add`)}
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
            </div>
          ) : null}
        </section>
        <details
          ref={historyPanel}
          className="group/history border-t border-[var(--border-default)] pt-4"
          onToggle={(event) => { if (event.currentTarget.open && !history) loadHistory(null); }}
        >
          <summary className="flex cursor-pointer list-none items-center gap-2 text-13 font-medium leading-[1.54] text-[var(--text-secondary)] [&::-webkit-details-marker]:hidden">
            <ChevronRight size={14} aria-hidden="true" className="shrink-0 group-open/history:rotate-90" />{t(`${copy}.history`)}
          </summary>
          <div className="space-y-3 pt-3">
            {history?.releases.length ? (
              <ol aria-label={t(`${copy}.history`)} className="divide-y divide-[var(--border-default)]">
                {history.releases.map((release) => {
                  const outcome = release.review?.outcome
                    ?? (release.reviewStatus === 'pending' ? 'pending' : null);
                  const reason = release.review?.outcome === 'rejected' ? release.review.reason?.trim() : null;
                  return (
                    <li key={release.id} className="space-y-1 py-3">
                      <p className="flex flex-wrap gap-x-2 text-14 leading-[1.714] text-[var(--text-primary)]">
                        <span>{release.version}</span>
                        {outcome ? <><span aria-hidden="true">·</span><span>{t(`${copy}.review.${outcome}`)}</span></> : null}
                      </p>
                      <p className="text-13 leading-[1.54] text-[var(--text-secondary)]">
                        {t(`${copy}.submittedAt`)} · {formatDate(release.publishedAt ?? release.createdAt)}
                      </p>
                      {release.review ? (
                        <p className="text-13 leading-[1.54] text-[var(--text-secondary)]">
                          {t(`${teamCopy}.decidedAt`)} · {formatDate(release.review.decidedAt)}
                        </p>
                      ) : null}
                      {reason ? <>
                        <h3 className="text-13 font-medium leading-[1.54] text-[var(--text-secondary)]">{t(`${copy}.reason`)}</h3>
                        <p className="select-text whitespace-pre-wrap break-words text-14 leading-[1.714] text-[var(--text-primary)]">{reason}</p>
                      </> : null}
                    </li>
                  );
                })}
              </ol>
            ) : history && !history.loading && !history.failed ? (
              <p className={body}>{t(`${copy}.noSubmission`)}</p>
            ) : null}
            {history?.failed ? <p role="alert" className={body}>{t(`${copy}.loadFailed`)}</p> : null}
            {history?.loading && !history.releases.length ? <p role="status" className={body}>{t(`${copy}.loading`)}</p> : null}
            {history && (history.nextCursor || history.failed) && !(history.loading && !history.releases.length) ? (
              <Button variant="secondary" size="sm" loading={history.loading} disabled={history.loading}
                onClick={() => loadHistory(history.failed && !history.releases.length ? null : history.nextCursor)}>
                {history.failed ? t(`${audienceCopy}.picker.retry`) : t(`${copy}.loadMoreVersions`)}
              </Button>
            ) : null}
          </div>
        </details>
      </div>
      <Dialog.Root open={audienceDialog !== null} onOpenChange={(open) => { if (!open && busy !== 'audience') setAudienceDialog(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="modal-scrim fixed inset-0 z-modal" />
          <Dialog.Content
            onInteractOutside={(event) => event.preventDefault()}
            className="modal-panel fixed left-1/2 top-1/2 z-modal-raised flex max-h-[85vh] w-[calc(100vw-32px)] max-w-[480px] -translate-x-1/2 -translate-y-1/2 flex-col p-4">
            <Dialog.Title className="text-18 font-medium text-[var(--text-primary)]">
              {t(`${teamCopy}.editAudienceTitle`, { name: detail.name })}
            </Dialog.Title>
            <Dialog.Description className="sr-only">{t(`${audienceCopy}.impact`)}</Dialog.Description>
            <div className="my-4 min-h-0 overflow-y-auto">
              {audienceDialog ? <AudienceEditor draft={audienceDialog} onChange={setAudienceDialog} api={api} disabled={busy === 'audience'} /> : null}
            </div>
            <div className="flex shrink-0 justify-end gap-2">
              <Button variant="secondary" disabled={busy === 'audience'} onClick={() => setAudienceDialog(null)}>
                {t(`${audienceCopy}.picker.cancel`)}
              </Button>
              <Button variant="cta" loading={busy === 'audience'} disabled={!audienceChanged || busy !== null}
                onClick={() => {
                  if (!nextAudience) return;
                  void write('audience', () => api.updatePlugin(detail.id, { visibilityAudience: nextAudience }))
                    .then((done) => { if (done && mounted.current) setAudienceDialog(null); });
                }}>{t(`${teamCopy}.save`)}</Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
