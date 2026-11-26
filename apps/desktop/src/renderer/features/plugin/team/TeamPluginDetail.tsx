/**
 * Organization ("团队共享") plugin detail on the 「发布插件」 page (#1541).
 *
 * Sections and wording follow the product prototype (makecindy/cindy#12495 「产品交互对照」): 本地版本
 * → 可见范围 → 维护者 → 已上架 → 当前提审 → 发布记录, with what only organization plugins have (#1504
 * permission table): the visibility audience and maintainers (creator adds and removes, maintainers
 * only view), delist / list (an administrator's delisting can only be undone by an administrator)
 * and cancelling a pending review. The public detail moved to a version rail in #12773; this one
 * keeps the prototype's sections (product decision) with the redesign's header, type and spacing.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { ChevronRight, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AttentionDot } from '@/components/sidebar/AttentionDot';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Input } from '@/components/ui/input';
import { usePluginReviewUpdates } from '@/contexts/PluginReviewUpdatesContext';
import { useWindowShown } from '@/hooks/useWindowVisible';
import {
  COLLEAGUE_SEARCH_MAX_LENGTH,
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
  audienceOverLimit,
  audienceSummaryNames,
  draftOf,
  memberDetail,
  memberLabel,
  type AudienceDraft,
} from '../audience/audienceDraft';
import type { GhostPluginListItem } from '../lib/ghostPluginViewModel';
import { contributionErrorKey } from '../lib/useContributionPreview';
import { PluginDetailHero } from '../PluginDetailHero';
import { VersionStatusIcon } from '../PluginPublishVersions';
import { teamLatestStateKey, teamListingActions, teamMarketState, teamPendingRelease, teamPluginIconUrl } from './teamPluginModel';

const copy = 'settings.ghosts.contribution';
const teamCopy = 'settings.ghosts.contribution.team';
const audienceCopy = 'settings.ghosts.audience';
const SEARCH_DEBOUNCE_MS = 200;

type Busy = null | 'listing' | 'cancel' | 'audience' | 'maintainer' | 'publish';

type FailurePlace = 'audience' | 'addMaintainer';

export function TeamPluginDetail({
  pluginId,
  memberId,
  orgName,
  localPlugins,
  onStartPublish,
  renderHeaderAction,
  renderFrame,
  refreshSignal,
}: {
  pluginId: string;
  /** The signed-in member's membership id: their own maintainer row reads 「（你）」. */
  memberId: string | null;
  /** For 「{企业名}全部成员」. */
  orgName: string;
  /** The member's local development copies that may be published to team sharing. */
  localPlugins: readonly GhostPluginListItem[];
  onStartPublish: (instanceId: string) => Promise<boolean>;
  renderHeaderAction?: (refresh: () => void, loading: boolean) => ReactNode;
  /**
   * Places the page around the detail: the header action (refresh) goes to the page's top bar
   * instead of the header, as on the redesigned plugin pages (#12773).
   */
  renderFrame?: (headerAction: ReactNode, body: ReactNode) => ReactNode;
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
  /**
   * A failed write started from the audience dialog or the add-maintainer search: shown there, next
   * to the choice the user is still looking at, not at the top of the page behind the dialog.
   */
  const [placedFailure, setPlacedFailure] = useState<{ place: FailurePlace; key: string } | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [departments, setDepartments] = useState<AuthorDepartment[] | null>(null);
  /**
   * The audience being edited, and the server audience when the dialog opened (`base`). Only a
   * difference from `base` is the user's change; a refresh never counts as one.
   */
  const [audienceDialog, setAudienceDialog] = useState<{
    draft: AudienceDraft; base: AudienceDraft; changedElsewhere: boolean;
  } | null>(null);
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

  /**
   * 「发布记录」 starts expanded (product prototype) and is read with the detail, then page by page on
   * demand; collapsing drops it and reopening reads it again.
   */
  const historyStarted = useRef(false);
  const loadHistory = useCallback((cursor: string | null) => {
    if (!cursor) historyStarted.current = true;
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
  useEffect(() => {
    if (!historyStarted.current) loadHistory(null);
  }, [loadHistory]);
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
      historyStarted.current = false;
      setHistory(null);
    }
  }, [load, loadHistory]);

  // A publish started from this page, or any other change, must not leave the detail (and its
  // submit button) on the old state (Greptile review on #12469). The first value is the mount read.
  const seenSignal = useRef(refreshSignal);
  useEffect(() => {
    if (seenSignal.current === refreshSignal) return;
    seenSignal.current = refreshSignal;
    reload();
  }, [refreshSignal, reload]);

  // Like the public plugin detail: opening the detail while the window is shown reads its review
  // result, and a dot beside 「当前提审」 marks it for the rest of this visit. A newer result
  // arriving meanwhile reloads through `refreshSignal`.
  const reviews = usePluginReviewUpdates();
  const unreadReview = reviews.updates.find((item) =>
    item.unread && item.pluginId === `${ORGANIZATION_REVIEW_ID_PREFIX}${pluginId}`);
  const { markRead } = reviews;
  // A minimized or hidden window can still report visibilityState 'visible' while background
  // throttling is off, so Main's window-hidden signal must also say the window is shown.
  const visible = useWindowShown();
  const [freshResult, setFreshResult] = useState<'done' | 'error' | null>(null);
  useEffect(() => {
    if (!detail || !unreadReview || !visible) return;
    setFreshResult(unreadReview.status === 'approved' || unreadReview.status === 'enabled' ? 'done' : 'error');
    void markRead(unreadReview.pluginId, unreadReview.key);
  }, [detail, unreadReview, visible, markRead]);

  const audienceDraft = useMemo(
    () => (detail ? draftOf(detail.visibilityAudience, detail.visibilityAudienceMembers ?? []) : null),
    [detail],
  );
  // Greptile review on #12495: a refresh while the dialog is open must not turn the old copy into
  // a "change" that, once saved, restores an audience someone else has just narrowed. When the
  // server audience moved away from the one the dialog opened with, the dialog says so and starts
  // over from the latest audience; saving needs a new edit.
  useEffect(() => {
    if (!audienceDraft || busy === 'audience') return;
    setAudienceDialog((current) => {
      if (!current) return current;
      if (JSON.stringify(audienceOf(current.base)) === JSON.stringify(audienceOf(audienceDraft))) return current;
      return { draft: audienceDraft, base: audienceDraft, changedElsewhere: true };
    });
  }, [audienceDraft, busy]);
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
    // The colleague search rejects longer text, and such text cannot match anyone anyway.
    if (keyword.length > COLLEAGUE_SEARCH_MAX_LENGTH) {
      setFound([]);
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
  const write = async (kind: Busy, action: () => Promise<unknown>, place?: FailurePlace): Promise<boolean> => {
    if (busy) return false;
    setBusy(kind);
    setFailure(null);
    setPlacedFailure(null);
    try {
      const result = await action();
      if (!mounted.current) return false;
      if (result && typeof result === 'object' && 'ghostId' in result) setDetail(result as PersonalPluginDetail);
      reload();
      return true;
    } catch (error) {
      if (!mounted.current) return false;
      // The dialog or search stays open with the user's choice; the error is shown inside it.
      if (place) setPlacedFailure({ place, key: contributionErrorKey(error) });
      else setFailure(contributionErrorKey(error));
      return false;
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  // Closing the dialog or the search drops its error; it is not carried to the page.
  useEffect(() => {
    if ((placedFailure?.place === 'audience' && audienceDialog === null) || (placedFailure?.place === 'addMaintainer' && !adding)) {
      setPlacedFailure(null);
    }
  }, [placedFailure, audienceDialog, adding]);
  const placedError = (place: FailurePlace) => placedFailure?.place === place ? (
    <p role="alert" className="whitespace-pre-wrap text-13 leading-[1.54] text-[var(--text-secondary)]">
      {t(placedFailure.key, { defaultValue: t(`${copy}.loadFailed`) })}
    </p>
  ) : null;

  const formatDate = (value: string | null | undefined) =>
    value ? new Date(value).toLocaleString(i18n.resolvedLanguage ?? i18n.language) : t(`${copy}.timeUnavailable`);

  if (!detail) {
    const pending = (
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
    return renderFrame ? renderFrame(null, pending) : pending;
  }

  const localPlugin = localPlugins.find((local) => local.ghostId === detail.ghostId) ?? null;
  const market = teamMarketState(detail);
  const pending = teamPendingRelease(detail);
  const listing = teamListingActions(detail);
  const isCreator = detail.myRole === 'creator';
  const current = detail.currentRelease ?? null;
  const localBlocker = localPlugin
    ? pending ? 'PLUGIN_PENDING_RELEASE_EXISTS'
      : detail.latestRelease?.version === localPlugin.version || current?.version === localPlugin.version
        ? 'VERSION_ALREADY_SUBMITTED' : null
    : null;

  // 当前提审 shows the latest submission like the public detail, whatever its result: its version
  // and state, when it was submitted, and why it was returned. Times and reasons the detail does not
  // carry come from the release history, which is read with the page.
  const latest = detail.latestRelease ?? pending ?? null;
  const latestKey = latest ? teamLatestStateKey({ ...detail, latestRelease: latest }) : null;
  const latestFromHistory = latest ? history?.releases.find((release) => release.id === latest.id) : undefined;
  const latestSubmittedAt = latest
    ? latest.publishedAt ?? (pending?.id === latest.id ? pending.publishedAt : null)
      ?? (current?.id === latest.id ? current.publishedAt : null)
      ?? latestFromHistory?.publishedAt ?? latestFromHistory?.createdAt ?? null
    : null;
  const latestReason = latest?.reviewStatus === 'rejected'
    ? detail.lastRejection?.detail?.reason?.trim()
      || (latestFromHistory?.review?.outcome === 'rejected' ? latestFromHistory.review.reason?.trim() : null)
      || null
    : null;

  const describeAudience = (draft: AudienceDraft | null) => {
    if (!draft || draft.mode === 'all') return t(`${audienceCopy}.allMembersOf`, { org: orgName });
    const names = audienceSummaryNames(draft, departments, {
      unknownDepartment: t(`${audienceCopy}.picker.unknownDepartment`),
      role: (role) => t(`${audienceCopy}.roleLabels.${role}`, { defaultValue: role }),
      memberId: (id) => t(`${audienceCopy}.picker.memberId`, { id }),
    });
    if (names === null) return t(`${audienceCopy}.picker.loading`);
    return names.length > 3
      ? t(`${audienceCopy}.namesMore`, { names: names.slice(0, 3).join(t(`${audienceCopy}.separator`)), count: names.length })
      : names.join(t(`${audienceCopy}.separator`));
  };
  const nextAudience = audienceDialog ? audienceOf(audienceDialog.draft) : null;
  const audienceChanged = Boolean(nextAudience && audienceDialog &&
    JSON.stringify(nextAudience) !== JSON.stringify(audienceOf(audienceDialog.base)));
  // Over the protocol's per-kind limit the save would only fail on the server; it stays disabled.
  const audienceSavable = audienceChanged && audienceDialog !== null && !audienceOverLimit(audienceDialog.draft);

  const confirmListing = async (next: 'active' | 'disabled') => {
    const accepted = await confirmStill({
      // Product prototype: 「上架插件」 asks without the name; 下架「{{name}}」？ names it.
      title: next === 'active' ? t(`${teamCopy}.listTitle`) : t(`${teamCopy}.delistTitle`, { name: detail.name }),
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
      confirmVariant: 'destructive',
    });
    if (accepted) await write('maintainer', () => api.removeMaintainer(detail.id, maintainer.id));
  };
  const closeAddMaintainer = () => { setAdding(false); setSearch(''); };
  const candidates = (found ?? []).filter((member) => !maintainers?.some((item) => item.membershipId === member.membershipId));

  // Section rhythm and headings of the redesigned plugin details (#12773).
  const sectionClass = 'space-y-3';
  const heading = 'text-16 font-medium leading-normal text-[var(--text-primary)]';
  const body = 'text-14 leading-[1.714] text-[var(--text-secondary)]';
  const listedBody = market.state === 'available' ? null
    : market.state === 'disabled' && current
      ? t(`${teamCopy}.${listing.delistedByAdmin ? 'delistedByAdminVersion' : 'delistedVersion'}`, { version: current.version })
      : t(`${copy}.market.${market.state}`);

  const headerAction = renderHeaderAction?.(reload, loading);
  const page = (
    <>
      <header>
        <PluginDetailHero id={detail.id} name={detail.name} iconDataUrl={teamPluginIconUrl(detail)}
          versionLabel="listed" version={market.state === 'available' ? market.version : null}
          status={market.state === 'available' ? undefined : t(`${copy}.market.${market.state}`)}
          // Download and use counts only mean something once a version has been listed.
          usage={current ? { downloadCount: detail.downloadStatistics?.requestCount, usageCount: detail.usageStatistics?.usageCount } : undefined}
          actions={renderFrame ? undefined : headerAction} />
      </header>
      {failure ? (
        <p role="alert" className="mb-4 whitespace-pre-wrap text-14 leading-[1.714] text-[var(--text-secondary)]">
          {t(failure, { defaultValue: t(`${copy}.loadFailed`) })}
        </p>
      ) : null}
      <div className="mt-10 space-y-10 pb-8">
        <section aria-label={t(`${copy}.localVersion`)} className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <h2 className={heading}>{t(`${copy}.localVersion`)}</h2>
              <p className={body}>
                {localPlugin ? t(`${teamCopy}.localDevelopment`, { version: localPlugin.version }) : t(`${copy}.localState.missing`)}
              </p>
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
        <section aria-label={t(`${audienceCopy}.title`)} className={sectionClass}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className={heading}>{t(`${audienceCopy}.title`)}</h2>
            {detail.status !== 'archived' && audienceDraft ? (
              <Button variant="secondary" size="sm" disabled={busy !== null}
                onClick={() => setAudienceDialog({ draft: audienceDraft, base: audienceDraft, changedElsewhere: false })}>{t(`${teamCopy}.edit`)}</Button>
            ) : null}
          </div>
          <p className="break-words text-14 leading-[1.714] text-[var(--text-primary)]">{describeAudience(audienceDraft)}</p>
        </section>
        <section aria-label={t(`${teamCopy}.maintainers`)} className={sectionClass}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className={heading}>{t(`${teamCopy}.maintainers`)}</h2>
            {isCreator && detail.status !== 'archived' ? (
              <Button variant="secondary" size="sm" disabled={busy !== null} aria-label={t(`${teamCopy}.addMaintainer`)}
                onClick={() => setAdding(true)}><Plus size={14} aria-hidden="true" />{t(`${teamCopy}.add`)}</Button>
            ) : null}
          </div>
          {maintainers === null ? <p className={body}>{t(`${copy}.loadFailed`)}</p> : (
            <ul aria-label={t(`${teamCopy}.maintainers`)}
              className="divide-y divide-[var(--border-default)] rounded-lg border border-[var(--border-default)]">
              {maintainers.map((maintainer) => {
                const self = maintainer.membershipId === memberId;
                const detailText = memberDetail(maintainer);
                return (
                  <li key={maintainer.id} className="flex min-h-11 min-w-0 items-center gap-3 px-3 py-2">
                    <span className="min-w-0 flex-1 truncate">
                      <span className="text-14 text-[var(--text-primary)]">{memberLabel(maintainer)}</span>
                      {self ? <span className="text-14 text-[var(--text-tertiary)]">{t(`${teamCopy}.self`)}</span> : null}
                      {detailText ? <span className="ml-2 text-12 text-[var(--text-tertiary)]">{detailText}</span> : null}
                    </span>
                    {maintainer.authorizationRole === 'creator' ? (
                      <span className="shrink-0 text-12 text-[var(--text-tertiary)]">{t(`${teamCopy}.role.creator`)}</span>
                    ) : isCreator && !self ? (
                      <Button variant="secondary" tone="quiet" size="sm" compact disabled={busy !== null}
                        onClick={() => void removeMaintainer(maintainer)}>{t(`${teamCopy}.removeMaintainer`)}</Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
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
          {listedBody === null
            ? <p className="select-text whitespace-pre-wrap break-words text-14 leading-[1.714] text-[var(--text-primary)]">{detail.description}</p>
            : <p className={body}>{listedBody}</p>}
        </section>
        <section aria-label={t(`${copy}.currentSubmission`)} className={sectionClass}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className={`${heading} flex items-center gap-2`}>
              {t(`${copy}.currentSubmission`)}
              {freshResult ? (
                <span role="img" className="inline-flex" aria-label={t(`${copy}.unreadReview`)}><AttentionDot tone={freshResult} /></span>
              ) : null}
            </h2>
            {pending ? (
              <Button variant="secondary" size="sm" loading={busy === 'cancel'} disabled={busy !== null}
                onClick={() => void cancelPendingReview()}>{t(`${copy}.cancelReview`)}</Button>
            ) : null}
          </div>
          {latest ? <>
            <p className="flex flex-wrap gap-x-2 text-14 leading-[1.714] text-[var(--text-primary)]">
              <span>{latest.version}</span>
              {latestKey ? <><span aria-hidden="true">·</span><span>{t(`${copy}.${latestKey}`)}</span></> : null}
            </p>
            <dl className="flex flex-wrap gap-x-2 text-12 leading-[1.667] text-[var(--text-tertiary)]">
              <dt>{t(`${copy}.submittedAt`)}</dt>
              <dd>{formatDate(latestSubmittedAt)}</dd>
            </dl>
            {latestReason ? (
              <p className="select-text whitespace-pre-wrap break-words text-14 leading-[1.714] text-[var(--text-primary)]">{latestReason}</p>
            ) : null}
          </> : <p className={body}>{t(`${copy}.noSubmission`)}</p>}
        </section>
        <details
          ref={historyPanel}
          open
          className="group/history"
          onToggle={(event) => {
            if (event.currentTarget.open) {
              if (!historyStarted.current) loadHistory(null);
              return;
            }
            // Collapsing drops the list and any read still on its way, so opening again reads anew.
            historyRequest.current += 1;
            historyStarted.current = false;
            setHistory(null);
          }}
        >
          <summary className="flex cursor-pointer list-none items-center gap-2 text-16 font-medium leading-normal text-[var(--text-primary)] [&::-webkit-details-marker]:hidden">
            <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)] group-open/history:rotate-90" />{t(`${copy}.history`)}
          </summary>
          <div className="space-y-3 pt-3.5">
            {history?.releases.length ? (
              <ol aria-label={t(`${copy}.history`)} className="space-y-3">
                {history.releases.map((release) => {
                  const outcome = release.review?.outcome
                    ?? (release.reviewStatus === 'pending' ? 'pending' : null);
                  const reason = release.review?.outcome === 'rejected' ? release.review.reason?.trim() : null;
                  // The listed version reads 「已上架」 / 「已下架」, as in 当前提审 and the list.
                  const listedKey = release.id === current?.id && (outcome === 'approved' || release.reviewStatus === 'approved')
                    ? detail.status === 'active' ? 'review.published' : detail.status === 'disabled' ? 'market.disabled' : null
                    : null;
                  return (
                    // Card of the redesigned version panel (#12773); content as in the prototype: version
                    // and result, when it was submitted, then the reason, without headings.
                    <li key={release.id} className="min-w-0 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-5 py-4">
                      <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                        <span className="text-16 font-medium leading-normal tabular-nums text-[var(--text-primary)]">{release.version}</span>
                        {listedKey || outcome ? (
                          <span className="inline-flex items-center gap-1.5 text-13 leading-normal text-[var(--text-secondary)]">
                            <VersionStatusIcon status={listedKey === 'review.published' ? 'published' : listedKey === 'market.disabled' ? 'disabled' : outcome!} size={16} secondary />
                            <span>{t(listedKey ? `${copy}.${listedKey}` : `${copy}.review.${outcome}`)}</span>
                          </span>
                        ) : null}
                      </p>
                      <p className="mt-1 text-12 leading-normal tabular-nums text-[var(--text-tertiary)]">
                        {formatDate(release.publishedAt ?? release.createdAt)}
                      </p>
                      {reason ? (
                        <p className="mt-2 select-text whitespace-pre-wrap break-words text-14 leading-[1.6] text-[var(--text-secondary-mid)] [overflow-wrap:anywhere]">{reason}</p>
                      ) : null}
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
            aria-describedby={undefined}
            onInteractOutside={(event) => event.preventDefault()}
            className="modal-panel fixed left-1/2 top-1/2 z-modal-raised flex max-h-[85vh] w-[calc(100vw-32px)] max-w-[480px] -translate-x-1/2 -translate-y-1/2 flex-col p-6">
            <Dialog.Title className="text-18 font-medium text-[var(--confirm-title)]">{t(`${teamCopy}.editAudienceTitle`)}</Dialog.Title>
            <div className="my-4 min-h-0 space-y-3 overflow-y-auto p-1">
              {audienceDialog?.changedElsewhere ? (
                <p role="alert" className="text-13 leading-[1.54] text-[var(--text-secondary)]">{t(`${teamCopy}.audienceChangedElsewhere`)}</p>
              ) : null}
              {audienceDialog ? (
                <AudienceEditor draft={audienceDialog.draft} api={api} disabled={busy === 'audience'} hideLegend
                  onChange={(draft) => setAudienceDialog((current) => current && { ...current, draft })} />
              ) : null}
              {/* Only here: who can install after saving, and what happens to people left out. */}
              {audienceSavable && audienceDialog ? (
                <p className="text-13 leading-[1.54] text-[var(--text-secondary)]">
                  {t(`${teamCopy}.saveImpact`, { audience: describeAudience(audienceDialog.draft) })}
                </p>
              ) : null}
            </div>
            {placedError('audience') ? <div className="mb-3 shrink-0">{placedError('audience')}</div> : null}
            <div className="flex shrink-0 justify-end gap-2">
              <Button variant="secondary" palette="confirmation" size="lg" disabled={busy === 'audience'} onClick={() => setAudienceDialog(null)}>
                {t(`${audienceCopy}.picker.cancel`)}
              </Button>
              <Button variant="primary" palette="confirmation" size="lg" loading={busy === 'audience'} disabled={!audienceSavable || busy !== null}
                onClick={() => {
                  if (!nextAudience) return;
                  // Closed with the saved answer, before the detail shows it, so the saved audience is
                  // not mistaken for a change made elsewhere.
                  void write('audience', async () => {
                    const saved = await api.updatePlugin(detail.id, { visibilityAudience: nextAudience });
                    if (mounted.current) setAudienceDialog(null);
                    return saved;
                  }, 'audience');
                }}>{t(`${teamCopy}.save`)}</Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={adding} onOpenChange={(open) => { if (!open && busy !== 'maintainer') closeAddMaintainer(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="modal-scrim fixed inset-0 z-modal" />
          <Dialog.Content
            aria-describedby={undefined}
            onInteractOutside={(event) => event.preventDefault()}
            className="modal-panel fixed left-1/2 top-1/2 z-modal-raised flex max-h-[70vh] w-[calc(100vw-32px)] max-w-[420px] -translate-x-1/2 -translate-y-1/2 flex-col p-6">
            <Dialog.Title className="text-18 font-medium text-[var(--confirm-title)]">{t(`${teamCopy}.addMaintainer`)}</Dialog.Title>
            <div className="mt-4 shrink-0">
              <Input type="search" autoFocus value={search} onChange={setSearch}
                ariaLabel={t(`${teamCopy}.searchMaintainer`)} placeholder={t(`${teamCopy}.searchMaintainer`)} />
            </div>
            <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
              {keyword ? found === null
                ? <p role="status" className="px-2 py-2 text-12 text-[var(--text-tertiary)]">{t(`${audienceCopy}.picker.loading`)}</p>
                : candidates.length === 0
                  ? <p className="px-2 py-6 text-center text-13 text-[var(--text-tertiary)]">{t(`${audienceCopy}.picker.noMembers`)}</p>
                  : (
                    <ul aria-label={t(`${audienceCopy}.picker.members`)}>
                      {candidates.map((member) => {
                        const detailText = memberDetail(member);
                        return (
                          <li key={member.membershipId}>
                            <button type="button" disabled={busy !== null}
                              aria-label={`${t(`${teamCopy}.add`)} ${memberLabel(member)}`}
                              onClick={() => void write('maintainer', () => api.addMaintainer(detail.id, member.membershipId), 'addMaintainer')
                                .then((done) => { if (done && mounted.current) closeAddMaintainer(); })}
                              className="flex w-full min-w-0 items-center gap-3 rounded-lg px-2 py-2.5 text-left enabled:hover:bg-[var(--surface-hover)] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]">
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-14 leading-[1.43] text-[var(--text-primary)]">{memberLabel(member)}</span>
                                {detailText ? <span className="block truncate text-12 leading-[1.333] text-[var(--text-tertiary)]">{detailText}</span> : null}
                              </span>
                              <span className="shrink-0 text-13 text-[var(--text-secondary)]">{t(`${teamCopy}.add`)}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
            </div>
            {placedError('addMaintainer') ? <div className="mt-2 shrink-0">{placedError('addMaintainer')}</div> : null}
            <div className="mt-3 flex shrink-0 justify-end">
              <Button variant="secondary" palette="confirmation" size="lg" disabled={busy === 'maintainer'} onClick={closeAddMaintainer}>{t(`${audienceCopy}.picker.done`)}</Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
  return renderFrame ? renderFrame(headerAction, page) : page;
}
