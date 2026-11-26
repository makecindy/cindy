import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { PluginPublisherBadge } from './PluginPublisherBadge';
import { PluginDetailHero } from './PluginDetailHero';
import { ChevronRight, Info, Plus, RotateCw, Search } from 'lucide-react';
import { Select } from '@/components/ui/select';
import { Tip } from '@/components/ui/tooltip';
import type { GhostPluginListItem } from './lib/ghostPluginViewModel';
import type { PluginMarketDetail } from '../../../shared/pluginMarket';
import { AccountSwitcherDialog } from '@/components/sidebar/AccountSwitcherDialog';
import { useSignInToCindy } from '@/hooks/useSignInToCindy';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SETTINGS_PAGE_TITLE_CLASS } from '@/components/ui/settings-rows';
import { cn } from '@/lib/utils';
import {
  buildPluginVersionRows,
  pluginSubmissionDate,
  pluginSubmissionStatus,
  PluginPublishVersions,
  releaseKey,
  restorePluginVersionSelection,
  versionEventSnapshot,
  versionSnapshotEvent,
  VersionStatusIcon,
} from './PluginPublishVersions';
import { useAuth } from '@/contexts/AuthContext';
import { usePluginReviewUpdates } from '@/contexts/PluginReviewUpdatesContext';
import { AttentionDot } from '@/components/sidebar/AttentionDot';
import { contributionErrorKey, useContributionPreview } from './lib/useContributionPreview';
export { contributionErrorKey } from './lib/useContributionPreview';
import type {
  PluginContributionsApi,
  ContributionReleaseView,
  MyPluginDetailView,
  MyPluginFilter,
  MyPluginPageView,
  MyPluginReleasePageView,
  MyPluginView,
  PreparedPluginContribution,
} from '../../../shared/pluginContributions';
import { PluginDetailTopBar, usePluginDetailScrolled } from './PluginDetailTopBar';
import { PLUGIN_MANAGEMENT_FRAME_CLASS, PluginManagementPage } from './PluginManagementLayout';
import { GhostPluginIcon } from './GhostPluginIcon';
import { PluginPublishDialog, type PluginPublishDialogRequest, type PluginSubmitOptions } from './PluginPublishDialog';
export type { PluginSubmitOptions } from './PluginPublishDialog';
import { usePluginMarketForegroundRefresh } from './lib/usePluginMarketForegroundRefresh';
import './plugin-detail-layout.css';
import './plugin-publish-list.css';

const copy = 'settings.ghosts.contribution';

export interface MyPluginsPageCache {
  ownerKey?: string;
  query?: string;
  filter?: MyPluginFilter;
  page?: MyPluginPageView | null;
  detail?: MyPluginDetailView | null;
  /** In-memory binding of this cached detail to the last Main association read. */
  installationRevision?: string;
  scroll?: number;
  selectedRelease?: { pluginId: string; key: string };
}

/** Kept independent of transport DTOs; the Host supplies an owner-fenced read projection. */
export function MyPluginsPage({
  reader,
  localPlugins,
  installedPluginCount,
  onSubmitUpdate,
  onPrepare,
  onViewLocal,
  cache,
  onReadPublished,
  submitBusy = false,
  submissionRevision = 0,
  installedRevision,
}: {
  reader: PluginContributionsApi;
  localPlugins: readonly GhostPluginListItem[];
  installedPluginCount: number;
  cache: MyPluginsPageCache;
  onSubmitUpdate: (instanceId: string, options?: PluginSubmitOptions) => Promise<boolean>;
  onPrepare?: (instanceId: string) => Promise<PreparedPluginContribution>;
  onReadPublished?: (pluginId: string) => Promise<PluginMarketDetail>;
  submitBusy?: boolean;
  submissionRevision?: number;
  installedRevision?: string;
  onViewLocal: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { dataOwnerId, dataOwnerGeneration, user, mode } = useAuth();
  const ownerKey = JSON.stringify([dataOwnerId, dataOwnerGeneration, user?.id, mode]);
  const navigate = useNavigate();
  const location = useLocation();
  const signIn = useSignInToCindy(`${location.pathname}${location.search}`);
  const [picker, setPicker] = useState<PluginPublishDialogRequest | null>(null);
  const pickerSequence = useRef(0);
  const [updateRefresh, setUpdateRefresh] = useState(0);
  const [selectedInstallation, setSelectedInstallation] = useState<{ context: string; instanceId: string } | null>(null);
  const preparePreview = onPrepare ?? reader.prepare;
  const [accountSwitcherOpen, setAccountSwitcherOpen] = useState(false);
  const accountTrigger = useRef<HTMLButtonElement>(null);
  const { confirm } = useConfirmDialog();
  const reviewUpdates = usePluginReviewUpdates();
  const [cancelBusy, setCancelBusy] = useState(false);
  const [publishedContent, setPublishedContent] = useState<{
    key: string; value: PluginMarketDetail | null; loading: boolean;
  } | null>(null);
  const publishedRequest = useRef(0);
  const [cancelResult, setCancelResult] = useState<{
    owner: string;
    pluginId: string;
    releaseId: string;
    cancelled: boolean;
  } | null>(null);
  const cancelling = useRef<symbol | null>(null);
  const saved = cache.ownerKey === ownerKey ? cache : {};
  const [installationRead, setInstallationRead] = useState<{ owner: string; pluginId: string; revision?: string } | null>(() =>
    saved.detail && saved.installationRevision !== undefined
      ? { owner: ownerKey, pluginId: saved.detail.plugin.pluginId, revision: saved.installationRevision } : null);
  const [loadedOwner, setLoadedOwner] = useState(ownerKey);
  const ownerMatches = loadedOwner === ownerKey;
  const [storedSnapshots, setSnapshots] = useState<Record<string, ContributionReleaseView>>({});
  const [storedSnapshotLoading, setSnapshotLoading] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('contribution');
  const [selectedRelease, setSelectedRelease] = useState(saved.selectedRelease);
  const [versionPage, setVersionPage] = useState<
    (MyPluginReleasePageView & { pluginId: string }) | null
  >(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionFailure, setVersionFailure] = useState<string | null>(null);
  const versionRequest = useRef(0);
  const snapshotRequest = useRef(0);
  const selectedPlugin = useRef(selectedId);
  selectedPlugin.current = selectedId;
  const [storedQuery, setQuery] = useState(saved.query ?? '');
  const [storedFilter, setFilter] = useState<MyPluginFilter>(saved.filter ?? 'all');
  const [storedPage, setPage] = useState<MyPluginPageView | null>(saved.page ?? null);
  const [listInstallationRead, setListInstallationRead] = useState<string | null>(null);
  const [storedDetail, setDetail] = useState<MyPluginDetailView | null>(saved.detail ?? null);
  const [storedFailure, setFailure] = useState<string | null>(null);
  const [storedLoading, setLoading] = useState(false);
  // Cached history remains readable; write controls require a successful current
  // detail read in this mount/owner/install generation, never a cached grant.
  const [writeRead, setWriteRead] = useState<string | null>(null);
  const [localRead, setLocalRead] = useState<string | null>(null);
  const writeKey = JSON.stringify([ownerKey, selectedId, installedRevision]);
  const currentWriteKey = useRef(writeKey);
  currentWriteKey.current = writeKey;
  const writeReady = writeRead === writeKey && navigator.onLine;
  const snapshots = ownerMatches ? storedSnapshots : {};
  const snapshotLoading = ownerMatches ? storedSnapshotLoading : null;
  const query = ownerMatches ? storedQuery : '';
  const filter = ownerMatches ? storedFilter : 'all';
  const page = ownerMatches ? storedPage : null;
  const detail = ownerMatches ? storedDetail : null;
  const failure = ownerMatches ? storedFailure : null;
  const loading = ownerMatches && storedLoading;
  const request = useRef(0);
  const mounted = useRef(true);
  const currentOwner = useRef(ownerKey);
  currentOwner.current = ownerKey;
  const lastRefresh = useRef(0);
  const listScroll = useRef(saved.scroll ?? 0);
  const pageKey = useRef(JSON.stringify([query, filter]));
  const scrollFrame = useRef<HTMLElement>(null);
  const { scrolled, onScroll } = usePluginDetailScrolled();
  const contributor = mode === 'cloud' && (user?.membershipKind === 'personal' || user?.membershipKind === 'org');
  const openPicker = () => {
    setPicker({ id: ++pickerSequence.current, owner: ownerKey, open: true });
  };

  useEffect(() => { setPicker(null); }, [selectedId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current++;
      versionRequest.current++;
      snapshotRequest.current++;
      publishedRequest.current++;
    };
  }, []);
  useEffect(() => {
    if (!ownerMatches || (cache.ownerKey !== ownerKey && cache.ownerKey !== undefined)) {
      request.current++;
      setPage(null);
      setDetail(null);
      setInstallationRead(null);
      setFailure(null);
      setPicker(null);
      setPublishedContent(null);
      setSnapshots({});
      setVersionPage(null);
      setSelectedRelease(undefined);
      setVersionsLoading(false);
      setVersionFailure(null);
      cancelling.current = null;
      setCancelBusy(false);
      setCancelResult(null);
      versionRequest.current++;
      snapshotRequest.current++;
      setSnapshotLoading(null);
      setLoading(false);
      setQuery('');
      setFilter('all');
      listScroll.current = 0;
      Object.assign(cache, {
        query: '',
        filter: 'all',
        page: null,
        detail: null,
        installationRevision: undefined,
        scroll: 0,
        selectedRelease: undefined,
      });
    }
    cache.ownerKey = ownerKey;
    setLoadedOwner(ownerKey);
  }, [ownerKey, ownerMatches, cache]);
  useEffect(() => {
    if (ownerMatches && cache.ownerKey === ownerKey)
      Object.assign(cache, {
        query,
        filter,
        page,
        detail,
        installationRevision: installationRead?.owner === ownerKey && installationRead.pluginId === detail?.plugin.pluginId
          ? installationRead.revision : undefined,
        scroll: listScroll.current,
        selectedRelease,
      });
  }, [cache, ownerKey, ownerMatches, query, filter, page, detail, selectedRelease, installationRead]);

  const refresh = useCallback(
    async (cursor?: string) => {
      if (!contributor || !ownerMatches) return;
      const id = ++request.current;
      const owner = ownerKey;
      setLoading(true);
      setWriteRead(null);
      try {
        if (selectedId) {
          const result = await reader.detail(selectedId, cursor);
          if (!mounted.current || request.current !== id || currentOwner.current !== owner) return;
          setInstallationRead({ owner, pluginId: selectedId, revision: installedRevision });
          setWriteRead(JSON.stringify([owner, selectedId, installedRevision]));
          setLocalRead(JSON.stringify([owner, selectedId, installedRevision]));
          setDetail((previous) =>
            cursor && previous?.plugin.pluginId === selectedId
              ? {
                  ...result,
                  history: [...previous.history, ...result.history].filter(
                    (item, index, all) =>
                      all.findIndex((entry) => entry.eventId === item.eventId) === index,
                  ),
                }
              : result,
          );
        } else {
          const result = await reader.list({ query, filter, ...(cursor ? { cursor } : {}) });
          if (!mounted.current || request.current !== id || currentOwner.current !== owner) return;
          setListInstallationRead(JSON.stringify([owner, installedRevision]));
          setPage((previous) =>
            cursor && previous
              ? {
                  ...result,
                  plugins: [...previous.plugins, ...result.plugins].filter(
                    (item, index, all) =>
                      all.findIndex((entry) => entry.pluginId === item.pluginId) === index,
                  ),
                }
              : result,
          );
        }
        lastRefresh.current = Date.now();
        void reviewUpdates.refresh();
        setFailure(null);
      } catch (error) {
        if (mounted.current && request.current === id && currentOwner.current === owner) {
          setLocalRead(null);
          setListInstallationRead(null);
          setFailure(contributionErrorKey(error));
        }
      } finally {
        if (mounted.current && request.current === id && currentOwner.current === owner)
          setLoading(false);
      }
    },
    [reader, selectedId, query, filter, ownerKey, contributor, ownerMatches, reviewUpdates.refresh, installedRevision],
  );

  useEffect(() => {
    // Invalidate old requests immediately when the search changes; do not show a
    // previous query as if it were the result of the new server-side filter.
    request.current++;
    const nextKey = JSON.stringify([query, filter]);
    if (pageKey.current !== nextKey) {
      setPage(null);
      listScroll.current = 0;
      pageKey.current = nextKey;
    }
    if (!selectedId) {
      /* Retain this account's list while returning from a detail. */
    } else setDetail((current) => (current?.plugin.pluginId === selectedId ? current : null));
    const timer = window.setTimeout(() => void refresh(), query ? 200 : 0);
    return () => {
      window.clearTimeout(timer);
      request.current++;
    };
  }, [refresh, selectedId, query, filter, submissionRevision]);
  const loadVersions = useCallback(
    async (cursor?: string) => {
      if (!selectedId || !contributor || !ownerMatches) return;
      const sequence = ++versionRequest.current,
        owner = ownerKey,
        pluginId = selectedId;
      setVersionsLoading(true);
      try {
        const result = await reader.releases(pluginId, cursor);
        if (
          !mounted.current ||
          currentOwner.current !== owner ||
          selectedPlugin.current !== pluginId ||
          versionRequest.current !== sequence
        )
          return;
        setVersionPage((previous) => ({
          ...result,
          pluginId,
          releases: (cursor && previous?.pluginId === pluginId
            ? [...previous.releases, ...result.releases]
            : result.releases
          ).filter(
            (release, index, all) =>
              all.findIndex((candidate) => releaseKey(candidate) === releaseKey(release)) === index,
          ),
        }));
        setVersionFailure(null);
      } catch (error) {
        if (
          mounted.current &&
          currentOwner.current === owner &&
          selectedPlugin.current === pluginId &&
          versionRequest.current === sequence
        )
          setVersionFailure(contributionErrorKey(error));
      } finally {
        if (
          mounted.current &&
          currentOwner.current === owner &&
          versionRequest.current === sequence
        )
          setVersionsLoading(false);
      }
    },
    [selectedId, contributor, ownerMatches, ownerKey, reader],
  );
  useEffect(() => {
    setVersionFailure(null);
    setSnapshotLoading(null);
    void loadVersions();
    return () => {
      versionRequest.current++;
      snapshotRequest.current++;
    };
  }, [loadVersions, submissionRevision]);
  const refreshAll = useCallback(async () => {
    await Promise.all([refresh(), loadVersions()]);
  }, [refresh, loadVersions]);
  const refreshAllRef = useRef(refreshAll);
  refreshAllRef.current = refreshAll;
  const reviewSignature = reviewUpdates.updates.map(item => item.key).sort().join('|');
  const lastReviewRefresh = useRef('');
  useEffect(() => {
    const signature = `${ownerKey}:${reviewSignature}`;
    if (!reviewSignature || lastReviewRefresh.current === signature) return;
    lastReviewRefresh.current = signature;
    void refreshAll();
  }, [ownerKey, reviewSignature, refreshAll]);
  usePluginMarketForegroundRefresh(refreshAll, lastRefresh);
  useEffect(() => {
    const online = () => {
      if (document.visibilityState === 'visible') void refreshAll();
    };
    window.addEventListener('online', online);
    const offline = () => setWriteRead(null);
    window.addEventListener('offline', offline);
    return () => { window.removeEventListener('online', online); window.removeEventListener('offline', offline); };
  }, [refreshAll]);
  useLayoutEffect(() => {
    if (scrollFrame.current)
      scrollFrame.current.scrollTop = selectedId ? 0 : listScroll.current;
  }, [selectedId, page]);

  const loadSnapshot = useCallback(
    async (submissionId: string) => {
      if (!selectedId) return;
      const owner = ownerKey,
        pluginId = selectedId,
        sequence = ++snapshotRequest.current;
      setSnapshotLoading(submissionId);
      try {
        const result = await reader.submission(selectedId, submissionId);
        if (
          mounted.current &&
          currentOwner.current === owner &&
          selectedPlugin.current === pluginId &&
          snapshotRequest.current === sequence
        )
          setSnapshots((previous) => ({ ...previous, [submissionId]: result }));
      } catch (error) {
        if (
          mounted.current &&
          currentOwner.current === owner &&
          selectedPlugin.current === pluginId &&
          snapshotRequest.current === sequence
        )
          setFailure(contributionErrorKey(error));
      } finally {
        if (
          mounted.current &&
          currentOwner.current === owner &&
          snapshotRequest.current === sequence
        )
          setSnapshotLoading(null);
      }
    },
    [selectedId, ownerKey, reader],
  );

  const back = () => {
    if (selectedId) {
      const next = new URLSearchParams(params);
      next.delete('contribution');
      next.delete('contributionTransfer');
      setParams(next, { replace: true });
    } else onViewLocal();
  };
  const openDetail = (pluginId: string) => {
    if (scrollFrame.current) listScroll.current = scrollFrame.current.scrollTop;
    cache.scroll = listScroll.current;
    const next = new URLSearchParams(params);
    next.set('contribution', pluginId);
    next.delete('contributionTransfer');
    setParams(next);
  };
  const timestamp = selectedId ? detail?.queriedAt : page?.queriedAt;
  const formatDate = (value: string | null) =>
    value
      ? new Date(value).toLocaleString(i18n.resolvedLanguage ?? i18n.language)
      : t(`${copy}.timeUnavailable`);
  const formatDetailDate = (value: string) => new Date(value).toLocaleString(i18n.resolvedLanguage ?? i18n.language, {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const detailTime = (value: string | null) => value
    ? <time dateTime={value} title={formatDate(value)}>{formatDetailDate(value)}</time>
    : t(`${copy}.timeUnavailable`);
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const shortDate = useMemo(() => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }), [locale]);

  const currentDetail = detail?.plugin.pluginId === selectedId ? detail : null;
  const plugin = currentDetail?.plugin;
  // A cached author detail must not select a replacement installation before Main
  // has rechecked its exact source and approval in this installation generation.
  const installationIsCurrent = installedRevision === undefined ||
    (installationRead?.owner === ownerKey && installationRead.pluginId === selectedId &&
      installationRead.revision === installedRevision);
  const localInstallation = installationIsCurrent && localRead === writeKey && navigator.onLine
    ? plugin?.localInstallation : undefined;
  const localCandidates = localInstallation && localInstallation.state !== 'installed'
    ? localInstallation.candidates ?? [] : [];
  const installationSelectionContext = JSON.stringify([ownerKey, location.key, selectedId, installedRevision]);
  const installedLocal = localInstallation?.state === 'installed' ? localInstallation
    : selectedInstallation?.context === installationSelectionContext
      ? localCandidates.find(candidate => candidate.instanceId === selectedInstallation.instanceId) ?? null : null;
  const publishedKey = JSON.stringify([writeKey, plugin?.market.releaseId, plugin?.market.version]);
  useEffect(() => {
    const sequence = ++publishedRequest.current;
    if (!plugin || plugin.market.state !== 'available' || !plugin.market.releaseId || !onReadPublished) {
      setPublishedContent(null);
      return;
    }
    const key = publishedKey, expected = plugin.market, pluginId = plugin.pluginId, requestKey = writeKey;
    setPublishedContent(previous => ({ key, value: previous?.key === key ? previous.value : null, loading: true }));
    void onReadPublished(pluginId).then(value => {
      if (!mounted.current || publishedRequest.current !== sequence || currentWriteKey.current !== requestKey) return;
      const exact = value.pluginId === pluginId && value.releaseId === expected.releaseId &&
        value.version === expected.version && value.sourceType === 'server' && value.scope === 'public';
      setPublishedContent({ key, value: exact ? value : null, loading: false });
    }).catch(() => {
      if (mounted.current && publishedRequest.current === sequence && currentWriteKey.current === requestKey)
        setPublishedContent({ key, value: null, loading: false });
    });
    return () => { publishedRequest.current++; };
  }, [publishedKey, onReadPublished, plugin, currentDetail?.queriedAt, writeKey]);
  const candidates =
    ownerMatches && versionPage?.pluginId === selectedId ? versionPage.releases : [];
  const latest = plugin?.latestSubmission ? [plugin.latestSubmission] : [];
  const unreadReview = reviewUpdates.updates.find(item => item.pluginId === selectedId && item.unread);
  const unreadMarket = unreadReview && unreadReview.status !== 'approved' && unreadReview.status !== 'rejected' ? unreadReview : null;
  const detailIsNewer =
    !versionPage || Date.parse(currentDetail?.queriedAt ?? '') >= Date.parse(versionPage.queriedAt);
  const releases = (detailIsNewer ? [...latest, ...candidates] : [...candidates, ...latest]).filter(
    (release, index, all) =>
      all.findIndex((entry) => releaseKey(entry) === releaseKey(release)) === index,
  );
  const unreadRelease = unreadReview && releases.find(item =>
    item.releaseId === unreadReview.releaseId && item.sha256 === unreadReview.sha256 && item.revision === unreadReview.revision);
  const versions = buildPluginVersionRows(plugin, releases, currentDetail?.history ?? [], installedLocal);
  const latestKey = plugin?.latestSubmission ? releaseKey(plugin.latestSubmission) : undefined;
  const savedVersionKey = selectedRelease?.pluginId === selectedId ? selectedRelease?.key : undefined;
  const unreadVersionKey = unreadRelease ? releaseKey(unreadRelease) : undefined;
  const manualVersion = restorePluginVersionSelection(versions, savedVersionKey);
  const selectedVersion = currentDetail
    ? manualVersion ??
      versions.rows.find(row => row.kind === 'submission' &&
        row.release.reviewStatus === 'pending' && row.release.revisionState === 'current') ??
      versions.rows.find(row => row.key === unreadVersionKey) ??
      versions.rows.find(row => row.key === latestKey) ??
      versions.rows.find(row => row.kind === 'submission') ??
      versions.localRow ?? versions.publishedRow ?? versions.rows[0]
    : undefined;
  const selectedSummary = selectedVersion?.kind === 'submission' ? selectedVersion.release : undefined;
  const selectedEvent = versionSnapshotEvent(selectedVersion);
  const primarySubmissionId = selectedSummary?.submissionId ?? selectedEvent?.submissionId;
  const selectedSnapshot = primarySubmissionId ? snapshots[primarySubmissionId] : undefined;
  const latestSnapshot = plugin?.latestSubmission?.submissionId ? snapshots[plugin.latestSubmission.submissionId] : undefined;
  const currentSubmission = plugin?.latestSubmission && latestSnapshot && releaseKey(latestSnapshot) === latestKey
    ? { ...plugin.latestSubmission, content: latestSnapshot.content ?? plugin.latestSubmission.content } : plugin?.latestSubmission;
  const shownRelease = selectedSummary ? {
    ...selectedSummary,
    content: (selectedSnapshot && releaseKey(selectedSnapshot) === selectedVersion?.key ? selectedSnapshot.content : null) ??
      (selectedVersion?.key === latestKey ? currentSubmission?.content : null) ?? selectedSummary.content,
  } : selectedEvent ? versionEventSnapshot(selectedEvent, snapshots) : undefined;
  const exactUnreadResult = unreadReview && unreadRelease && unreadRelease.reviewStatus === unreadReview.status &&
    unreadRelease.reviewedAt === unreadReview.decidedAt;
  const visibleReview = exactUnreadResult && selectedVersion?.key === unreadVersionKey ? unreadReview : null;
  const visibleReviewKey = visibleReview?.key;
  const visibleReviewPlugin = visibleReview?.pluginId;
  const visibleReleaseKey = visibleReview ? unreadVersionKey : undefined;
  useEffect(() => {
    if (!visibleReviewKey || !visibleReviewPlugin || !visibleReleaseKey || document.visibilityState !== 'visible') return;
    // Keep the exact result selected after acknowledging it; do not jump to a newer pending version.
    setSelectedRelease(previous => previous?.pluginId === visibleReviewPlugin && previous.key === visibleReleaseKey
      ? previous : { pluginId: visibleReviewPlugin, key: visibleReleaseKey });
    void reviewUpdates.markRead(visibleReviewPlugin, visibleReviewKey);
  }, [visibleReviewKey, visibleReviewPlugin, visibleReleaseKey, reviewUpdates.markRead]);
  const visibleMarket = unreadMarket && currentDetail && Date.parse(currentDetail.queriedAt) >= Date.parse(unreadMarket.decidedAt) ? unreadMarket : null;
  const visibleMarketKey = visibleMarket?.key;
  const visibleMarketPlugin = visibleMarket?.pluginId;
  useEffect(() => {
    if (!visibleMarketKey || !visibleMarketPlugin) return;
    const acknowledge = () => {
      if (document.visibilityState === 'visible') void reviewUpdates.markRead(visibleMarketPlugin, visibleMarketKey);
    };
    acknowledge();
    document.addEventListener('visibilitychange', acknowledge);
    return () => document.removeEventListener('visibilitychange', acknowledge);
  }, [visibleMarketKey, visibleMarketPlugin, reviewUpdates.markRead]);
  const openUnreadResult = async () => {
    if (!unreadReview) return;
    if (unreadMarket) { await refresh(); return; }
    const target = unreadReview, owner = ownerKey, sequence = ++versionRequest.current;
    setVersionsLoading(true);
    try {
      const collected: ContributionReleaseView[] = [];
      let cursor: string | undefined;
      for (;;) {
        const result = await reader.releases(target.pluginId, cursor);
        if (!mounted.current || currentOwner.current !== owner || selectedPlugin.current !== target.pluginId ||
          versionRequest.current !== sequence) return;
        collected.push(...result.releases);
        const match = collected.find(item => item.releaseId === target.releaseId && item.sha256 === target.sha256 &&
          item.revision === target.revision);
        if (match || !result.nextCursor) {
          setVersionPage({ ...result, pluginId: target.pluginId, releases: collected });
          if (match) {
            setSelectedRelease({ pluginId: target.pluginId, key: releaseKey(match) });
            setVersionFailure(null);
          } else setVersionFailure(`${copy}.loadFailed`);
          return;
        }
        cursor = result.nextCursor;
      }
    } catch (error) {
      if (mounted.current && currentOwner.current === owner && versionRequest.current === sequence)
        setVersionFailure(contributionErrorKey(error));
    } finally {
      if (mounted.current && currentOwner.current === owner && versionRequest.current === sequence)
        setVersionsLoading(false);
    }
  };
  const selectedKey = selectedVersion?.key;
  const visibleHasContent = Boolean(shownRelease?.content);
  const waitingForSelection = !manualVersion && versionPage?.pluginId !== selectedId && !versionFailure &&
    Boolean(savedVersionKey || unreadReview && !unreadMarket && !unreadRelease || selectedVersion?.kind === 'history');
  const snapshotToRead = waitingForSelection ? undefined : primarySubmissionId;
  useEffect(() => {
    snapshotRequest.current++;
    setSnapshotLoading(null);
    if (snapshotToRead && !visibleHasContent) void loadSnapshot(snapshotToRead);
  }, [selectedKey, snapshotToRead, visibleHasContent, loadSnapshot]);
  const isDetail = Boolean(selectedId);
  const listEmpty = page?.plugins.length === 0;
  const cancelReview = async (plugin: MyPluginView, release: ContributionReleaseView) => {
    if (cancelling.current || !writeReady || !plugin.actions.submitUpdate || !release.canCancelReview || !navigator.onLine) return;
    const owner = ownerKey;
    const cancellation = Symbol('cancel-review');
    cancelling.current = cancellation;
    setCancelBusy(true);
    try {
      const accepted = await confirm({
        title: t(`${copy}.cancelReviewTitle`, { name: plugin.name, version: release.version }),
        description: t(`${copy}.cancelReviewDescription`, { version: release.version }),
        confirmText: t(`${copy}.cancelReview`),
        cancelText: t(`${copy}.keepReview`),
      });
      if (
        !accepted ||
        !mounted.current ||
        currentOwner.current !== owner ||
        selectedPlugin.current !== plugin.pluginId
      )
        return;
      const result = await reader.cancelReview(plugin.pluginId, {
        releaseId: release.releaseId,
        sha256: release.sha256,
        revision: release.revision,
      });
      if (!mounted.current || currentOwner.current !== owner) return;
      setCancelResult({
        owner,
        pluginId: plugin.pluginId,
        releaseId: result.releaseId,
        cancelled: result.reviewStatus === 'cancelled',
      });
      // Keep the selected version; the subsequent read supplies its actual final decision.
      setVersionPage((previous) =>
        previous?.pluginId === plugin.pluginId
          ? {
              ...previous,
              releases: previous.releases.map((entry) =>
                entry.releaseId === result.releaseId
                  ? { ...result, content: entry.content }
                  : entry,
              ),
            }
          : previous,
      );
      await refreshAllRef.current();
    } catch (error) {
      if (mounted.current && currentOwner.current === owner)
        setFailure(contributionErrorKey(error));
    } finally {
      if (cancelling.current === cancellation) {
        cancelling.current = null;
        if (mounted.current && currentOwner.current === owner) setCancelBusy(false);
      }
    }
  };
  const chooseRelease = (key: string) => {
    if (selectedId) setSelectedRelease({ pluginId: selectedId, key });
  };
  const refreshButton = (
    <Tip text={t(`${copy}.${isDetail ? 'refreshDetail' : 'refreshList'}`)}>
      <Button
        variant="secondary"
        tone="quiet"
        size="sm"
        className="size-7 p-0"
        aria-label={t(`${copy}.${isDetail ? 'refreshDetail' : 'refreshList'}`)}
        loading={loading || versionsLoading}
        disabled={!contributor}
        onClick={() => void refreshAll()}
      >
        <RotateCw size={16} />
      </Button>
    </Tip>
  );
  const knownPublishBlocker = installedLocal && (
    plugin?.latestSubmission?.reviewStatus === 'pending' && plugin.latestSubmission.revisionState === 'current'
      ? 'PLUGIN_PENDING_RELEASE_EXISTS'
      : releases.some(release => release.version === installedLocal.version) ? 'VERSION_ALREADY_SUBMITTED' : null
  );
  const localCanSubmit = installedLocal && localPlugins.some(item => item.id === installedLocal.instanceId && item.version === installedLocal.version);
  const updateUnavailable = plugin?.publisherKind === 'official' ? t(`${copy}.unavailable.officialGithubRequired`)
    : knownPublishBlocker ? t(`${copy}.errors.${knownPublishBlocker}`) : undefined;
  const canPrepareUpdate = Boolean(installedLocal && localCanSubmit && plugin?.actions.submitUpdate && writeReady && !updateUnavailable);
  const updateInstanceId = installedLocal?.instanceId;
  const updateVersion = installedLocal?.version;
  const updateKey = JSON.stringify([ownerKey, location.key, selectedId, installedRevision, submissionRevision,
    installedLocal?.instanceId, installedLocal?.version, canPrepareUpdate, updateRefresh]);
  const updateContext = useRef({ key: updateKey, token: {} });
  if (updateContext.current.key !== updateKey) updateContext.current = { key: updateKey, token: {} };
  const currentUpdateDraft = useContributionPreview(updateKey,
    canPrepareUpdate ? updateInstanceId : undefined, updateVersion, preparePreview, reader.discard);
  const updateBlocker = currentUpdateDraft?.prepared?.preflight?.blockers[0];
  const published = publishedContent?.key === publishedKey ? publishedContent : null;
  const listedDetail = plugin?.market.state === 'available' ? published?.value : null;
  const listedVersion = plugin?.market.state === 'available' ? plugin.market.version : null;
  const submitVersionAction = installedLocal && canPrepareUpdate && currentUpdateDraft?.prepared?.preflight?.actions.canSubmit && !updateBlocker ? (
    <Button variant="cta" size="lg" loading={submitBusy} disabled={submitBusy}
      onClick={() => {
        const token = updateContext.current.token;
        void onSubmitUpdate(installedLocal.instanceId, {
          prepared: currentUpdateDraft.prepared,
          isCurrent: () => mounted.current && updateContext.current.token === token,
        }).catch(error => {
          if (mounted.current && updateContext.current.token === token) setFailure(contributionErrorKey(error));
        }).finally(() => {
          if (mounted.current && updateContext.current.token === token) setUpdateRefresh(value => value + 1);
        });
      }}>{t(`${copy}.submitVersion`, { version: installedLocal.version })}</Button>
  ) : null;
  const listedContentLoading = plugin?.market.state === 'available' && !listedDetail &&
    (published?.loading === true || (!published && Boolean(onReadPublished && plugin.market.releaseId)));
  const versionCursor = versionPage?.pluginId === selectedId ? versionPage?.nextCursor : null;
  const historyCursor = currentDetail?.nextCursor;
  const loadMoreVersions = async () => {
    const expectedSequence = versionRequest.current + (versionCursor ? 1 : 0);
    if (versionCursor) await loadVersions(versionCursor);
    if (historyCursor && mounted.current && currentWriteKey.current === writeKey &&
      versionRequest.current === expectedSequence)
      await refresh(historyCursor);
  };
  const localVersionPicker = localCandidates.length > 1 ? (
    <Select label={t(`${copy}.localVersion`)} value={installedLocal?.instanceId ?? ''}
      options={localCandidates.map(candidate => ({ value: candidate.instanceId,
        label: `${candidate.version} · ${t(`settings.ghosts.page.origin.${candidate.origin}`)}` }))}
      onValueChange={instanceId => setSelectedInstallation({ context: installationSelectionContext, instanceId })}
      size="compact" className="plugin-publish-version-picker" />
  ) : null;
  const unreadTone = unreadReview?.status === 'approved' || unreadReview?.status === 'enabled' ? 'done' : 'error';
  const unreadAction = unreadReview && (unreadMarket ? !visibleMarket : !exactUnreadResult) ? (
    <Button variant="secondary" size="sm" className="plugin-publish-version-unread"
      loading={versionsLoading} disabled={versionsLoading || !navigator.onLine} onClick={() => void openUnreadResult()}>
      <AttentionDot tone={unreadTone} />
      {unreadMarket ? t(`${copy}.viewMarketResult`) : t(`${copy}.viewReviewResult`, { version: unreadReview.version })}
    </Button>
  ) : null;
  const cancelAction = selectedSummary?.canCancelReview && plugin?.actions.submitUpdate && writeReady ? (
    <Button variant="secondary" size="sm" compact loading={cancelBusy} disabled={cancelBusy}
      className="ms-auto max-w-full whitespace-normal" onClick={() => void cancelReview(plugin, selectedSummary)}>
      {t(`${copy}.cancelReview`)}
    </Button>
  ) : null;
  const cancelMessage = selectedSummary && cancelResult?.owner === ownerKey && cancelResult.pluginId === selectedId &&
    cancelResult.releaseId === selectedSummary.releaseId
    ? t(`${copy}.${cancelResult.cancelled ? 'cancelReviewCompleted' : 'cancelReviewAlreadyFinal'}`) : undefined;
  const publishing = plugin ? (
    <PluginPublishVersions
      key={JSON.stringify([ownerKey, plugin.pluginId])}
      plugin={plugin}
      rows={versions.rows}
      selected={selectedVersion}
      installed={installedLocal}
      installedKey={versions.installedKey}
      installationState={!installedLocal ? (localInstallation?.state === 'missing' ? 'missing' : 'unavailable') : undefined}
      installationPicker={localVersionPicker}
      unreadKey={unreadVersionKey}
      unreadTone={unreadTone}
      unreadAction={unreadAction}
      versionFailure={versionFailure}
      rowRelease={shownRelease}
      primarySubmissionId={primarySubmissionId}
      draft={{
        prepared: currentUpdateDraft?.prepared ?? undefined,
        preparing: canPrepareUpdate && !currentUpdateDraft?.prepared && !currentUpdateDraft?.error,
        versionAlreadySubmitted: updateBlocker?.code === 'VERSION_ALREADY_SUBMITTED',
        error: currentUpdateDraft?.error ?? undefined,
        blocker: updateBlocker
          ? t(`${copy}.errors.${updateBlocker.code}`, { defaultValue: t(`${copy}.errors.PRECONDITION_FAILED`) })
          : plugin.publisherKind === 'official' ? undefined : updateUnavailable,
      }}
      published={listedDetail ?? null}
      publishedLoading={listedContentLoading}
      cancelAction={cancelAction}
      cancelMessage={cancelMessage}
      loadMore={versionCursor || historyCursor ? () => void loadMoreVersions() : undefined}
      loadingMore={versionsLoading || loading}
      onSelect={chooseRelease}
      snapshots={snapshots}
      snapshotLoading={waitingForSelection ? primarySubmissionId ?? null : snapshotLoading}
      loadSnapshot={submissionId => void loadSnapshot(submissionId)}
      detailTime={detailTime}
    />
  ) : null;

  const market = plugin?.market;
  const marketStatus = market ? t(market.state === 'available' ? `${copy}.listedVersion` : `${copy}.market.${market.state}`) : null;
  const marketReasons = [...new Set([market?.reason, versions.noticeEvent?.reason]
    .map(reason => reason?.trim()).filter((reason): reason is string => Boolean(reason)))];
  const showMarketNotice = market && (marketReasons.length > 0 ||
    (market.state === 'not_listed' ? Boolean(versions.noticeEvent?.at) : market.state !== 'available'));
  const description = listedDetail ? listedDetail.description || listedDetail.manifest.description
    : listedContentLoading ? null : currentSubmission?.content?.description;
  const marketNotice = showMarketNotice ? (
    <section className="mt-7 grid grid-cols-[16px_minmax(0,1fr)] gap-x-2.5 rounded-xl bg-[var(--surface-chip)] px-4 py-3.5">
      <Info size={16} className="mt-0.5 text-[var(--text-secondary)]" aria-hidden="true" />
      <div className="min-w-0">
        <h2 className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-14 font-medium leading-normal text-[var(--text-primary)]">
          {marketStatus}
          {versions.noticeEvent ? <span className="text-12 font-normal tabular-nums text-[var(--text-tertiary)]">{detailTime(versions.noticeEvent.at)}</span> : null}
        </h2>
        {marketReasons.map(reason => <p key={reason} className="mt-1 select-text whitespace-pre-wrap text-14 leading-[1.6] text-[var(--text-secondary-mid)] [overflow-wrap:anywhere]">{reason}</p>)}
      </div>
    </section>
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <main
        ref={scrollFrame}
        className={`app-wallpaper-surface min-h-0 flex-1 overflow-y-auto bg-[var(--surface)] ${isDetail ? 'plugin-publish-detail' : 'plugin-publish-list'}`}
        onScroll={(event) => {
          onScroll(event);
          if (!isDetail) listScroll.current = event.currentTarget.scrollTop;
          cache.scroll = listScroll.current;
        }}
      >
        <PluginDetailTopBar
          label={isDetail ? t(`${copy}.backToPublish`) : t('settings.ghosts.title')}
          onBack={back}
          scrolled={scrolled}
          actions={<>
            {contributor ? refreshButton : null}
            {!isDetail && (!listEmpty || query || filter !== 'all') ? (
              <Button variant="cta" size="lg" disabled={!contributor || !ownerMatches} onClick={openPicker}>
                <Plus size={16} aria-hidden="true" />
                {t(`${copy}.publishPlugin`)}
              </Button>
            ) : null}
          </>}
          frameClassName={isDetail ? `${PLUGIN_MANAGEMENT_FRAME_CLASS} plugin-publish-detail-frame` : PLUGIN_MANAGEMENT_FRAME_CLASS}
        />
        <PluginManagementPage className={isDetail ? 'plugin-publish-detail-frame pt-6' : undefined}>
          {isDetail ? (
            <header>
              {plugin ? (
                <PluginDetailHero id={plugin.pluginId} name={plugin.name} iconDataUrl={plugin.iconUrl ?? undefined}
                  author={plugin.displayAuthor} publisherKind={plugin.publisherKind}
                  status={plugin.market.state === 'available' ? undefined : marketStatus}
                  marketItem={listedDetail} version={listedVersion} versionLabel="listed" actions={submitVersionAction} />
              ) : <h1 className={SETTINGS_PAGE_TITLE_CLASS}>{t(`${copy}.myPlugins`)}</h1>}
              {description?.trim() ? (
                <p className="mt-5 select-text whitespace-pre-wrap text-pretty text-15 leading-[1.65] text-[var(--text-secondary-mid)] [overflow-wrap:anywhere]">{description}</p>
              ) : null}
              {market?.state === 'available' && !listedDetail ? (
                <p role="status" className={`${description?.trim() ? 'mt-3' : 'mt-5'} max-w-[680px] text-12 leading-normal text-[var(--text-tertiary)]`}>
                  {t(`${copy}.${listedContentLoading ? 'loading' : 'publishedContentUnavailable'}`)}
                </p>
              ) : null}
              {plugin?.publisherKind === 'official' ? (
                <p role="status" className="mt-3 max-w-[680px] text-12 leading-normal text-[var(--text-tertiary)]">{t(`${copy}.unavailable.officialGithubRequired`)}</p>
              ) : null}
            </header>
          ) : (
            <header className="mb-5 flex min-w-0 flex-wrap items-center justify-between gap-4">
              <div className="flex min-w-0 flex-1 items-center gap-4">
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                    <h1 className={cn('min-w-0 [overflow-wrap:anywhere]', SETTINGS_PAGE_TITLE_CLASS)}>{t(`${copy}.myPlugins`)}</h1>
                  </div>
                </div>
              </div>
              {contributor && (!listEmpty || query || filter !== 'all') ? (
                <div className="flex min-w-0 max-w-full items-center gap-2 max-[540px]:basis-full">
                  <Select label={t(`${copy}.filterLabel`)} value={filter} size="compact" width="xs"
                    truncateOptions options={(['all', 'pending', 'needs_action', 'published'] as const).map(value => ({
                      value, label: t(`${copy}.filter.${value}`),
                    }))}
                    onValueChange={value => setFilter(value as MyPluginFilter)} />
                  <div className="relative min-w-0 max-[540px]:ml-auto">
                    <Search size={15} aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-3 z-raised my-auto text-[var(--text-tertiary)]" />
                    <Input size="sm" type="search" value={query} onChange={setQuery}
                      placeholder={t(`${copy}.search`)} aria-label={t(`${copy}.search`)} inputClassName="pl-9" />
                  </div>
                </div>
              ) : null}
            </header>
          )}
          {!contributor ? (
            <div className="space-y-4">
              <p role="status" className="text-14 leading-6 text-[var(--text-secondary)]">
                {t(`${copy}.signInRequired`)}
              </p>
              <Button
                ref={accountTrigger}
                variant="secondary"
                onClick={() => (mode === 'cloud' ? setAccountSwitcherOpen(true) : void signIn())}
              >
                {t(mode === 'cloud' ? 'sidebar.accountSwitcher.title' : 'login.signIn')}
              </Button>
              <AccountSwitcherDialog
                open={accountSwitcherOpen}
                onOpenChange={setAccountSwitcherOpen}
                triggerRef={accountTrigger}
                onAddAccount={() =>
                  navigate('/add-account', {
                    state: { returnTo: `${location.pathname}${location.search}` },
                  })
                }
              />
            </div>
          ) : (
            <>
              {failure ? (
                <p
                  role="alert"
                  className="mb-4 whitespace-pre-wrap text-14 leading-6 text-[var(--text-secondary)]"
                >
                  {t(failure, { defaultValue: t(`${copy}.loadFailed`) })}
                  {timestamp ? ` · ${t(`${copy}.cachedResult`)}` : ''}
                </p>
              ) : null}
              {!isDetail ? (
                <>
                  {loading && !page ? (
                    <p role="status" className="text-14 text-[var(--text-secondary)]">
                      {t(`${copy}.loading`)}
                    </p>
                  ) : null}
                  {listEmpty ? (
                    <div className="flex min-h-72 flex-col items-center justify-center gap-4 py-8 text-center text-14 leading-6 text-[var(--text-tertiary)]">
                      <p>{t(`${copy}.${query || filter !== 'all' ? 'noMatches' : 'empty'}`)}</p>
                      {!query && filter === 'all' ? (
                        <Button variant="cta" size="lg" onClick={openPicker} disabled={!ownerMatches}>
                          {t(`${copy}.goPublish`)}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  {page?.plugins.length ? (
                    <ul className="-mx-3 grid gap-0.5">
                      {[...page.plugins].sort((a, b) =>
                        Number(b.latestSubmission?.reviewStatus === 'rejected') - Number(a.latestSubmission?.reviewStatus === 'rejected'),
                      ).map((entry) => {
                        const local = listInstallationRead === JSON.stringify([ownerKey, installedRevision]) && navigator.onLine
                          ? entry.localInstallation : undefined;
                        const review = reviewUpdates.updates.find(item => item.pluginId === entry.pluginId && item.unread);
                        const release = entry.latestSubmission;
                        const status = release ? pluginSubmissionStatus(release, entry.market) : null;
                        const rejected = status === 'rejected';
                        const reason = rejected ? release?.reason?.trim() : null;
                        const description = reason || entry.description?.trim();
                        const marketFact = status === 'published' ? null
                          : entry.market.state !== 'available' ? t(`${copy}.market.${entry.market.state}`)
                            : entry.market.version ? t(`${copy}.marketVersion`, { version: entry.market.version })
                              : t(`${copy}.listedVersion`);
                        const localFact = local?.state === 'installed'
                          ? t(`${copy}.localState.installed`, { version: local.version })
                          : t(`${copy}.localState.${local?.state ?? 'unavailable'}`);
                        const date = release?.reviewStatus && status ? pluginSubmissionDate(release, status) : null;
                        const time = date ? new Date(date) : null;
                        return (
                          <li key={entry.pluginId}>
                            <button type="button"
                              className="plugin-publish-list-row grid w-full min-w-0 items-center rounded-xl px-3 py-3.5 text-left transition-colors duration-[var(--motion-fast)] hover:bg-[var(--surface-hover-soft)] active:bg-[var(--surface-chip)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
                              onClick={() => openDetail(entry.pluginId)}
                            >
                              <span className="plugin-publish-list-icon flex">
                                <GhostPluginIcon iconDataUrl={entry.iconUrl ?? undefined} iconId={entry.pluginId} iconName={entry.name} />
                              </span>
                              <span className="plugin-publish-list-info grid min-w-0 gap-px">
                                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-15 font-medium leading-[1.4] text-[var(--text-primary)]">
                                  <span className="min-w-0 [overflow-wrap:anywhere]">{entry.name}</span>
                                  <PluginPublisherBadge kind={entry.publisherKind} />
                                  {review ? <span role="img" className="inline-flex" aria-label={t(`${copy}.unreadReview`)}><AttentionDot tone={review.status === 'approved' || review.status === 'enabled' ? 'done' : 'error'} /></span> : null}
                                </span>
                                {description ? (
                                  <span className="truncate text-13 leading-[1.54] text-[var(--text-secondary)]">
                                    {reason ? (
                                      <Trans i18nKey={`${copy}.rejectionReasonLine`} components={{
                                        reasonLabel: <span className="text-[var(--text-primary)]" />,
                                        reasonText: <span>{reason}</span>,
                                      }} />
                                    ) : description}
                                  </span>
                                ) : null}
                                <span className="text-12 leading-normal tabular-nums text-[var(--text-tertiary)] [overflow-wrap:anywhere]">
                                  {[marketFact, localFact, entry.displayAuthor].filter(Boolean).join(' · ')}
                                </span>
                              </span>
                              <span className="plugin-publish-list-revision grid min-w-0 gap-y-0.5 [overflow-wrap:anywhere]">
                                <span className={`flex min-w-0 items-center gap-1.5 text-13 leading-[1.54] ${rejected ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
                                  {status ? <VersionStatusIcon status={status} size={16} className={rejected ? undefined : 'text-[var(--text-tertiary)]'} /> : null}
                                  <span className="min-w-0">{t(status ? `${copy}.review.${status}` : `${copy}.noSubmission`)}</span>
                                </span>
                                {release ? (
                                  <span className="plugin-publish-list-revision-meta min-w-0 text-12 leading-normal tabular-nums text-[var(--text-tertiary)]">
                                    {release.version}
                                    {date && time && Number.isFinite(time.getTime()) ? (
                                      <> · <time dateTime={date} title={formatDate(date)}>{shortDate.format(time)}</time></>
                                    ) : null}
                                  </span>
                                ) : null}
                              </span>
                              <ChevronRight size={16} aria-hidden="true" className="plugin-publish-list-chevron justify-self-end text-[var(--text-tertiary)]" />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                  {page?.nextCursor ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      compact
                      className="self-start"
                      loading={loading}
                      onClick={() => void refresh(page.nextCursor!)}
                    >
                      {t(`${copy}.loadMore`)}
                    </Button>
                  ) : null}
                </>
              ) : currentDetail && plugin ? (
                <>
                  {marketNotice}
                  {publishing}
                </>
              ) : loading ? (
                <p role="status" className="text-14 text-[var(--text-tertiary)]">
                  {t(`${copy}.loading`)}
                </p>
              ) : null}
              <footer
                className={`flex items-center justify-between gap-3 pb-4 text-12 text-[var(--text-tertiary)] ${isDetail ? 'mt-10 tabular-nums' : 'mt-6'}`}
                aria-live="polite"
              >
                <span>
                  {timestamp
                    ? isDetail ? <span title={formatDate(timestamp)}>{t(`${copy}.lastRefreshed`, { time: formatDetailDate(timestamp) })}</span>
                      : t(`${copy}.lastRefreshed`, { time: formatDate(timestamp) })
                    : ''}
                </span>
              </footer>
            </>
          )}
        </PluginManagementPage>
      </main>
      {picker && contributor && ownerMatches && picker.owner === ownerKey && !selectedId ? (
        <PluginPublishDialog
          key={picker.id}
          open={picker.open}
          ownerKey={ownerKey}
          reader={reader}
          localPlugins={localPlugins}
          installedPluginCount={installedPluginCount}
          onPrepare={onPrepare}
          onSubmitUpdate={onSubmitUpdate}
          submitBusy={submitBusy}
          installedRevision={installedRevision}
          submissionRevision={submissionRevision}
          onOpenChange={open => setPicker(current => current?.id === picker.id ? { ...current, open } : current)}
          onClosed={() => setPicker(current => current?.id === picker.id && !current.open ? null : current)}
        />
      ) : null}
    </div>
  );
}
