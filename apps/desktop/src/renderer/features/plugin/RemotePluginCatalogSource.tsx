import { pluginSourceWarningKey } from '@cindy/maker-shared/mcp-apps';
import { getPluginToolUi } from '@cindy/plugin-protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { mergePluginSnapshot, usePluginCatalogMemory, pluginCatalogPartitionKey, pluginInstalledGrid, usePluginCatalogState } from './lib/pluginCatalogMemory';
import { samePluginValue, PLUGIN_CATALOG_REFRESH_MS } from './lib/pluginBrowserCache';
import { selectPluginRecommendationBatch } from './lib/PluginRecommendationSlots';
import { usePluginMarketForegroundRefresh } from './lib/usePluginMarketForegroundRefresh';
import {
  REMOTE_RESOURCE_CHANGED_CHANNEL,
  parseRemoteResourceChangedPayload,
} from '@cindy/device-link';
import { Button } from '@/components/ui/button';
import { AddRemoteProjectDialog } from '@/components/new-chat/AddRemoteProjectDialog';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { extractIpcError } from '@/utils/ipcError';
import { toast } from '@/lib/toast';
import {
  GhostInstallConsentContent,
  ghostInstallConsentSourceLabel,
} from '@/cindy-brain/GhostInstallConsentHost';
import { ghostInstallApprovalToken, type InstalledGhost } from '../../../shared/ghost';
import { installedGhostStoragePart } from '../../../shared/pluginIdentity';

import type {
  PluginManagementReceipt,
  PluginManagementProject,
  PluginManagementProjectState,
  RemotePluginPublicationStatus,
} from '../../../shared/pluginManagement';
import type { PluginMarketDetail, PluginMarketItem } from '../../../shared/pluginMarket';
import { GhostPluginCard, MarketPluginCard } from './GhostPluginPage';
import { PLUGIN_PAGE_SIZE } from './PluginCatalogBrowser';
import { usePluginListScrollRestoration } from './lib/usePluginListScrollRestoration';
import { hasPluginCatalogPaging, parsePluginManagementMarketPage, parsePluginManagementRecommendations } from './remotePluginManagementClient';
import { parsePluginMarketSortFields, type PluginMarketQuery, type PluginMarketPage } from '../../../shared/pluginMarket';
import { GhostPluginActions } from './GhostPluginActions';
import { PluginCatalogView } from './PluginCatalogView';
import { PluginPublishDialog, type PluginSubmitOptions } from './PluginPublishDialog';
import { localPublishingUnavailableKey } from './lib/ghostPluginDetailModel';
import type { CatalogDeviceControl } from './useCatalogDevice';
import { RemotePluginConfiguration } from './RemotePluginConfiguration';
import { CatalogManagementNotice } from './PluginManagementLayout';
import { PluginProjectMenu } from './PluginScopePicker';
import { toGhostPluginDetail, toGhostPluginListItem } from './lib/ghostPluginViewModel';
import {
  marketItemMatchesInstalledGhost,
  publicPublisherFilter,
} from './lib/pluginMarketPresentation';
import {
  hasPluginManagement,
  invokePluginManagement,
  parsePluginManagementSnapshot,
  parsePluginManagementProjectState,
  parsePluginManagementProject,
  parsePluginManagementDetail,
  parsePluginManagementReceipt,
  parseRemotePublicationPreview,
  parseRemotePublicationStatus,
  readLegacyManagedPlugins,
  readLegacyManagedPlugin,
  type LegacyManagedPlugin,
  type LegacyManagedPluginDetail,
} from './remotePluginManagementClient';

/** Every async closure belongs to this mounted owner + selected computer. Never uses local Ghost IPC. */
export function RemotePluginCatalogSource({
  device,
  online,
  active = true,
  embedded,
  deviceControl,
  onSelectCatalogTab,
  hideManagingNotice = false,
}: {
  device: { deviceId: string; name: string };
  online: boolean;
  active?: boolean;
  embedded?: boolean;
  deviceControl?: CatalogDeviceControl;
  onSelectCatalogTab?: (tab: 'plugins' | 'skills') => void;
  /**
   * Leaves the notice out while it only says which computer is managed, for a page fixed to that
   * computer that already names it (cloud settings). Offline, loading and failures still show.
   */
  hideManagingNotice?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { confirm } = useConfirmDialog();
  const catalogOwnerKey = pluginCatalogPartitionKey(JSON.stringify([device.deviceId, getDataOwnerGeneration()]), i18n.language);
  const catalogMemory = usePluginCatalogMemory(catalogOwnerKey, device.deviceId);
  const [snapshot, setSnapshot] = usePluginCatalogState(catalogMemory, 'remoteSnapshot');
  const [project, setProject] = useState<PluginManagementProject | null>(null);
  const projectRef = useRef(project);
  projectRef.current = project;
  const [projectState, setProjectState] = useState<PluginManagementProjectState | null>(null);
  const [projectReadStatus, setProjectReadStatus] = useState<'loading' | 'failed' | null>(null);
  const projectReadRevision = useRef(0);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const projectPickerRevision = useRef(0);
  const projectPickerCurrent = useRef(false);
  projectPickerCurrent.current = projectPickerOpen && active && online;
  const [selected, setSelected] = useState<string | null>(null);
  const ghost = snapshot?.ghosts.find((g) => installedGhostStoragePart(g) === selected);
  const [marketDetail, setMarketDetail] = useState<PluginMarketDetail | null>(null);
  const relatedMarketTrail = useRef<PluginMarketDetail[]>([]);
  const [query, setQuery] = usePluginCatalogState(catalogMemory, 'query');
  const [catalogTab, setCatalogTab] = usePluginCatalogState(catalogMemory, 'catalogTab');
  const [catalogPaging, setCatalogPaging] = usePluginCatalogState(catalogMemory, 'catalogPaging');
  const [todayPool, setTodayPool] = usePluginCatalogState(catalogMemory, 'todayPool');
  const [recommendationBatch, setRecommendationBatch] = usePluginCatalogState(catalogMemory, 'recommendationBatch');
  const [consumedToday, setConsumedToday] = usePluginCatalogState(catalogMemory, 'consumedToday');
  const [todayLoaded, setTodayLoaded] = usePluginCatalogState(catalogMemory, 'todayLoaded');
  const installingRecommendation = useRef<string | null>(null);
  const [installedLimit, setInstalledLimit] = usePluginCatalogState(catalogMemory, 'installedLimit');
  const [marketTotal, setMarketTotal] = usePluginCatalogState(catalogMemory, 'marketTotal');
  const browserCache = catalogMemory.browser;
  const installedSentinel = useRef<HTMLDivElement>(null);
  const secondaryTabs = useRef<HTMLDivElement>(null);
  const installedGridCache = pluginInstalledGrid(catalogMemory, query);
  const [originFilter, setOriginFilter] = usePluginCatalogState(catalogMemory, 'originFilter');
  const [searchScope, setSearchScope] = usePluginCatalogState(catalogMemory, 'searchScope');
  const [status, setStatus] = useState<
    'readFailed' | 'unknown' | 'changed' | 'actionFailed' | null
  >(null);
  const [unsupported, setUnsupported] = useState(false);
  const [legacy, setLegacy] = useState<LegacyManagedPlugin[] | null>(null);
  const [legacySelected, setLegacySelected] = useState<LegacyManagedPlugin | null>(null);
  const [legacyDetail, setLegacyDetail] = useState<LegacyManagedPluginDetail | null>(null);
  const [legacyDetailStatus, setLegacyDetailStatus] = useState<'loading' | 'failed' | null>(null);
  const { listRef: catalogScroller, onListScroll, capture: captureCatalogScroll, requestRestore: restoreCatalogScroll } =
    usePluginListScrollRestoration(!ghost && !marketDetail && !legacySelected, catalogMemory.scroll);
  const [receipt, setReceipt] = useState<PluginManagementReceipt | null>(null);
  const scope = useRef({ owner: getDataOwnerGeneration(), alive: true, online });
  scope.current.online = online;
  const readRevision = useRef(0),
    detailRevision = useRef(0);
  const operation = useRef<string | null>(null),
    preparing = useRef(false);
  const [preparingUi, setPreparingUi] = useState(false);
  const dialog = useRef<AbortController | null>(null);
  const answeredConsents = useRef(new Set<string>());
  const current = useCallback(
    () => scope.current.alive && isDataOwnerGenerationCurrent(scope.current.owner),
    [],
  );
  const writable = useCallback(() => current() && scope.current.online, [current]);
  const invoke = useCallback(
    (action: string, input?: Record<string, unknown>, instance?: string) =>
      invokePluginManagement(device.deviceId, action, input, instance),
    [device.deviceId],
  );
  const refreshAt = useRef(catalogMemory.snapshotAt);
  const refresh = useCallback(async (force = true, revalidateCatalog = false) => {
    if (!force && catalogMemory.remoteSnapshot && Date.now() - catalogMemory.snapshotAt < PLUGIN_CATALOG_REFRESH_MS) return;
    const revision = ++readRevision.current;
    if (!writable()) return;
    try {
      const supported = await hasPluginManagement(device.deviceId);
      if (!writable() || revision !== readRevision.current) return;
      setUnsupported(!supported);
      if (!supported) {
        setTodayPool([]);
        setTodayLoaded(true);
        const items = await readLegacyManagedPlugins(device.deviceId, i18n.language);
        if (writable() && revision === readRevision.current) {
          setLegacy(items);
          setLegacySelected((previous) =>
            previous && items.some((item) => item.id === previous.id) ? previous : null,
          );
          setStatus(null);
        }
        return;
      }
      const paging = await hasPluginCatalogPaging(device.deviceId);
      if (!writable() || revision !== readRevision.current) return;
      if (!paging) {
        // False is initially unknown. Only the completed capability probe may
        // end the slots reserved for a newer Host's recommendations.
        setTodayPool([]);
        setTodayLoaded(true);
      }
      const next = parsePluginManagementSnapshot(await invoke('snapshot', paging ? { read: 'installed' } : {}));
      if (writable() && revision === readRevision.current) {
        const previousMarket = catalogMemory.remoteSnapshot?.market;
        setSnapshot(previous => {
          const market = mergePluginSnapshot(previous?.market ?? null, next.market);
          return previous?.market === market && samePluginValue(previous, { ...next, market }) ? previous : { ...next, market };
        });
        catalogMemory.snapshotAt = Date.now(); refreshAt.current = catalogMemory.snapshotAt;
        setCatalogPaging(paging);
        setLegacySelected(null);
        setLegacyDetail(null);
        setStatus(null);
        await browserCache.current.refresh?.({
          force: revalidateCatalog && !samePluginValue(previousMarket, catalogMemory.remoteSnapshot?.market),
        });
      }
    } catch {
      if (writable() && revision === readRevision.current) setStatus('readFailed');
    }
  }, [device.deviceId, i18n.language, invoke, writable, catalogMemory, browserCache, setSnapshot, setCatalogPaging, setTodayPool, setTodayLoaded]);
  usePluginMarketForegroundRefresh(() => { if (active) return refresh(false); }, refreshAt);
  useEffect(() => {
    if (!active || !online || !writable() || !catalogPaging) return;
    let alive = true;
    if (catalogMemory.todayLoaded && Date.now() - catalogMemory.recommendationsAt < PLUGIN_CATALOG_REFRESH_MS) return;
    void invoke('snapshot', { read: 'recommendations', query: { publishers: 'public' } }).then(value => {
      if (alive && writable()) {
        const items = parsePluginManagementRecommendations(value);
        setTodayPool(previous => samePluginValue(previous, items) ? previous : items);
        setTodayLoaded(true); catalogMemory.recommendationsAt = Date.now();
      }
    }).catch(() => { if (alive && writable()) setTodayLoaded(true); });
    return () => { alive = false; };
  }, [active, online, catalogPaging, device.deviceId, invoke, writable, catalogMemory, setTodayPool, setTodayLoaded]);
  useEffect(() => {
    const sentinel = installedSentinel.current;
    if (!sentinel || !catalogScroller.current || (!query.trim() && catalogTab !== 'installed')) return;
    const total = unsupported
      ? (legacy ?? []).filter(item => `${item.name} ${item.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).length
      : snapshot?.ghosts.filter(item => `${item.manifest.name} ${item.manifest.description ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).length ?? 0;
    if (installedLimit >= total) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setInstalledLimit(count => Math.min(count + PLUGIN_PAGE_SIZE, total));
    }, { root: catalogScroller.current, rootMargin: '80px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [snapshot, legacy, unsupported, installedLimit, query, catalogTab, ghost, marketDetail, legacySelected, catalogScroller]);
  const readMarketPage = useCallback(async (input: PluginMarketQuery): Promise<PluginMarketPage> => {
    if (!writable()) throw new Error('UNAVAILABLE');
    if (catalogPaging) {
      const value = await invoke('snapshot', { read: 'catalog', query: input });
      if (!writable()) throw new Error('UNAVAILABLE');
      const { sort, sorts, ...page } = parsePluginManagementMarketPage(value);
      return { ...page, ...parsePluginMarketSortFields({ sort, sorts }) };
    }
    // Explicit legacy Host path: its existing v1 snapshot cannot paginate over the wire.
    // Reconnect can refresh the retained browser before React commits this snapshot.
    const market = catalogMemory.remoteSnapshot?.market;
    const items = (market?.items ?? []).filter(item =>
      `${item.name} ${item.description ?? ''} ${item.ghostId} ${item.author ?? ''}`.toLocaleLowerCase().includes((input.query ?? '').toLocaleLowerCase())
      && (!input.excludeInstalled || (item.installState !== 'installed' && item.installState !== 'update-available')));
    const counts = { all: items.length, public: 0, organization: 0, personal: 0, custom: 0, official: 0, community: 0 };
    for (const item of items) {
      if (item.sourceType !== 'server') counts.custom++;
      else counts[item.scope]++;
      const group = publicPublisherFilter(item);
      if (group) counts[group]++;
    }
    const filtered = items.filter(item => !input.scope || input.scope === 'all'
      || (input.scope === 'custom' ? item.sourceType !== 'server' : item.sourceType === 'server' && item.scope === input.scope));
    const offset = input.cursor ? Number(input.cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('INVALID_PARAMS');
    const selected = filtered.slice(offset, offset + (input.limit ?? PLUGIN_PAGE_SIZE));
    const sourceCounts = new Map<string, number>();
    for (const item of items) if (item.sourceMarketName)
      sourceCounts.set(item.sourceMarketName, (sourceCounts.get(item.sourceMarketName) ?? 0) + 1);
    return { ...(market ?? { unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] }),
      items: selected, counts: input.cursor ? null : counts,
      customSourceCounts: [...sourceCounts].map(([name, count]) => ({ name, count })),
      nextCursor: offset + selected.length < filtered.length ? String(offset + selected.length) : null };
  }, [catalogPaging, invoke, catalogMemory, writable]);
  const loadLegacyDetail = useCallback(
    async (plugin: LegacyManagedPlugin) => {
      const revision = ++detailRevision.current;
      if (!writable()) return;
      setLegacyDetailStatus('loading');
      try {
        const detail = await readLegacyManagedPlugin(device.deviceId, plugin.id, i18n.language);
        if (writable() && revision === detailRevision.current) {
          setLegacyDetail(detail);
          setLegacyDetailStatus(null);
        }
      } catch {
        if (writable() && revision === detailRevision.current) setLegacyDetailStatus('failed');
      }
    },
    [device.deviceId, i18n.language, writable],
  );
  useEffect(() => {
    if (legacySelected && online && active) void loadLegacyDetail(legacySelected);
    return () => {
      ++detailRevision.current;
    };
  }, [legacySelected, legacy, online, active, loadLegacyDetail]);
  const refreshProject = useCallback(async () => {
    const id = projectRef.current?.id;
    const revision = ++projectReadRevision.current;
    if (!id || !writable()) return;
    setProjectReadStatus('loading');
    try {
      const next = parsePluginManagementProjectState(
        await invoke('project-state', { projectId: id }),
        id,
      );
      if (writable() && revision === projectReadRevision.current && projectRef.current?.id === id) {
        setProjectState(next);
        setProjectReadStatus(null);
      }
    } catch {
      if (writable() && revision === projectReadRevision.current && projectRef.current?.id === id)
        setProjectReadStatus('failed');
    }
  }, [invoke, writable]);
  useEffect(() => {
    if (online && active && project?.id) void refreshProject();
  }, [online, active, project?.id, snapshot, refreshProject]);
  useEffect(() => {
    scope.current.alive = true;
    return () => {
      scope.current.alive = false;
      ++projectPickerRevision.current;
      dialog.current?.abort();
      // Cancel only this page's pending request at the original Host, never another target.
      if (operation.current && isDataOwnerGenerationCurrent(scope.current.owner))
        void invoke('cancel', { operationId: operation.current }).catch(() => {});
    };
  }, [invoke]);
  useEffect(() => {
    if (!online || !active) {
      ++projectPickerRevision.current;
      setProjectPickerOpen(false);
    }
  }, [online, active]);
  // A remount may have missed Host pushes while unsubscribed. Reuse the first
  // activation refresh even when its retained snapshot is younger than the TTL.
  const previousVisibility = useRef({ online: false, active: false });
  useEffect(() => {
    const previous = previousVisibility.current;
    previousVisibility.current = { online, active };
    if (!online) {
      ++readRevision.current;
      ++detailRevision.current;
      ++projectReadRevision.current;
      dialog.current?.abort();
    } else if (active) {
      const activating = !previous.online || !previous.active;
      void refresh(activating, activating);
    }
  }, [online, active, refresh]);
  useEffect(
    () =>
      window.electronAPI.deviceLink.onRemotePush((push, stamp) => {
        if (
          active &&
          push.deviceId === device.deviceId &&
          push.channel === REMOTE_RESOURCE_CHANGED_CHANNEL &&
          parseRemoteResourceChangedPayload(push.payload)?.collectionId === 'plugins' &&
          isDeviceLinkRemotePushCurrent(push, stamp) &&
          writable()
        )
          void refresh();
      }),
    [active, device.deviceId, refresh, writable],
  );
  const acceptReceipt = useCallback(
    async (next: PluginManagementReceipt) => {
      if (!writable() || next.operationId !== operation.current) return;
      setReceipt(next);
      if (['succeeded', 'cancelled', 'failed'].includes(next.phase)) {
        if (next.phase === 'succeeded' && installingRecommendation.current) {
          const id = installingRecommendation.current;
          setConsumedToday(previous => new Set(previous).add(id));
        }
        installingRecommendation.current = null;
        operation.current = null;
        setStatus(null);
        const message = t('settings.ghosts.remote.' + (
          next.phase === 'succeeded' ? 'success' : next.phase === 'cancelled' ? 'cancelled' :
          next.errorCode === 'GHOST_ASLEEP' ? 'enableBeforeConfigure' : next.errorCode === 'NOT_FOUND' ? 'changed' : 'actionFailed'
        ));
        if (next.phase === 'succeeded') toast.success(message);
        else if (next.phase === 'cancelled') toast.info(message);
        else toast.error(message);
        if (next.phase === 'succeeded' || next.errorCode === 'GHOST_ASLEEP') void refresh();
        return;
      }
      if (next.phase === 'confirmation' && next.consent && !dialog.current && !answeredConsents.current.has(next.consent.requestId)) {
        const abort = new AbortController();
        dialog.current = abort;
        try {
          const consent = next.consent;
          const confirmed = await confirm(
            {
              title: t('settings.ghosts.remote.confirmOn', {
                device: device.name,
                name: consent.facts.name,
              }),
              description: `${device.name} · ${consent.facts.kind === 'install' ? t('settings.ghosts.installConsent.installMeta', { version: consent.facts.version, source: ghostInstallConsentSourceLabel(t, consent) }) : t('settings.ghosts.installConsent.updateMeta', { from: consent.facts.previousVersion, to: consent.facts.version, source: ghostInstallConsentSourceLabel(t, consent) })}`,
              content: <>
                {consent.purpose === 'ui-capability' && pluginSourceWarningKey(consent.installationSource) && <p className="text-13 text-[var(--warning-fg)]">
                  {t(pluginSourceWarningKey(consent.installationSource)!)}
                </p>}
                <GhostInstallConsentContent facts={consent.facts} origin={consent.origin} communityMarket={consent.communityMarket}
                  capabilityOnly={consent.purpose === 'ui-capability'} />
              </>,
              confirmText: t(
                consent.purpose === 'ui-capability' ? 'newChat.pluginUi.enable' : consent.facts.kind === 'install'
                  ? 'settings.ghosts.installConsent.confirmInstall'
                  : 'settings.ghosts.installConsent.confirmUpdate',
              ),
              cancelText: t('settings.ghosts.installConsent.cancel'),
              maxWidth: 460,
              contentSelectable: true,
            },
            abort.signal,
          );
          if (writable() && !abort.signal.aborted && operation.current === next.operationId) {
            answeredConsents.current.add(consent.requestId);
            await invoke('answer', {
              operationId: next.operationId,
              requestId: consent.requestId,
              confirmed,
            });
          }
        } catch {
          if (writable()) setStatus('unknown');
        } finally {
          if (dialog.current === abort) dialog.current = null;
        }
      }
    },
    [confirm, device.name, invoke, refresh, t, writable],
  );
  const poll = useCallback(async () => {
    const id = operation.current;
    if (!id || !writable()) return;
    try {
      await acceptReceipt(
        parsePluginManagementReceipt(await invoke('operation', { operationId: id }), id),
      );
    } catch {
      if (writable() && id === operation.current) setStatus('unknown');
    }
  }, [acceptReceipt, invoke, writable]);
  useEffect(() => {
    if (!online || !receipt || !operation.current) return;
    // A failure leaves the receipt id intact. Reconnect/retry only reads this id.
    let alive = true,
      timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await poll();
      if (alive && operation.current) timer = setTimeout(tick, 1200);
    };
    timer = setTimeout(tick, 600);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [online, poll, receipt?.operationId]);
  useEffect(() => {
    if (!status || !active || !current()) return;
    const message = t('settings.ghosts.remote.' + status);
    const options = { action: {
      label: t('settings.ghosts.remote.refresh'),
      onClick: () => { if (writable()) { if (operation.current) void poll(); else void refresh(); } },
    } };
    const id = status === 'unknown' ? toast.warning(message, options) : toast.error(message, options);
    return () => toast.dismiss(id);
  }, [status, active, current, writable, poll, refresh, t]);
  const begin = useCallback(
    async (
      kind: string,
      ghost?: InstalledGhost,
      item?: PluginMarketDetail,
      attachment?: string,
    ) => {
      if (!writable() || operation.current || unsupported) return;
      if (['approve-ui', 'defer-ui'].includes(kind) && snapshot?.uiCapabilityApproval !== true) return;
      const scopedToggle = !!project && ['enable', 'disable'].includes(kind);
      if (
        scopedToggle &&
        (!projectState ||
          projectState.projectId !== project.id ||
          projectReadStatus ||
          (kind === 'enable' && !ghost?.enabled))
      )
        return;
      const id = crypto.randomUUID();
      installingRecommendation.current = kind === 'install' ? item?.pluginId ?? null : null;
      operation.current = id;
      setReceipt({ operationId: id, phase: 'running' });
      setStatus(null);
      try {
        const input = {
          operationId: id,
          kind,
          ...(snapshot?.uiCapabilityApproval === true ? { uiConsentVersion: 1 } : {}),
          ...(ghost
            ? { expectedInstalledApproval: ghostInstallApprovalToken(ghost.approval) }
            : {}),
          ...(item
            ? {
                pluginId: item.pluginId,
                expectedReleaseId: item.releaseId,
                expectedManifest: item.manifest,
              }
            : {}),
          ...(attachment ? { attachment } : {}),
          ...(scopedToggle
            ? { projectId: project.id, expectedProjectRevision: projectState!.revision }
            : {}),
        };
        await acceptReceipt(
          parsePluginManagementReceipt(
            await invoke('begin', input, ghost ? installedGhostStoragePart(ghost) : undefined),
            id,
          ),
        );
      } catch (error) {
        if (current() && id === operation.current) {
          const code = extractIpcError(error)?.code;
          if (
            [
              'INVALID_PARAMS',
              'NOT_FOUND',
              'PRECONDITION_FAILED',
              'UNSUPPORTED_CAPABILITY',
              'PERMISSION_DENIED',
            ].includes(code ?? '')
          ) {
            operation.current = null;
            setReceipt({ operationId: id, phase: 'failed', errorCode: code });
            setStatus('actionFailed');
          } else setStatus('unknown');
        }
      }
    },
    [
      acceptReceipt,
      current,
      invoke,
      unsupported,
      writable,
      project,
      projectState,
      projectReadStatus,
      snapshot?.uiCapabilityApproval,
    ],
  );
  const selectMarket = async (item: PluginMarketItem, previous?: PluginMarketDetail) => {
    if (!previous) {
      relatedMarketTrail.current.length = 0;
      captureCatalogScroll();
    }
    const revision = ++detailRevision.current;
    try {
      const detail = parsePluginManagementDetail(
        await invoke('market-detail', { pluginId: item.pluginId }),
      );
      if (writable() && revision === detailRevision.current) {
        if (previous) relatedMarketTrail.current.push(previous);
        setSelected(null);
        setMarketDetail(detail);
      }
    } catch {
      if (writable() && revision === detailRevision.current) setStatus('readFailed');
    }
  };
  const install = async (item: PluginMarketItem) => {
    if (!writable() || operation.current || preparing.current) return;
    preparing.current = true;
    setPreparingUi(true);
    try {
      const detail = parsePluginManagementDetail(
        await invoke('market-detail', { pluginId: item.pluginId }),
      );
      if (!writable() || detail.releaseId !== item.releaseId) {
        if (current()) setStatus('changed');
        return;
      }
      const ghost = snapshot?.ghosts.find((g) => marketItemMatchesInstalledGhost(detail, g));
      await begin('install', ghost, detail);
    } catch {
      if (current()) setStatus('readFailed');
    } finally {
      preparing.current = false;
      if (current()) setPreparingUi(false);
    }
  };
  const installFile = async (target?: InstalledGhost) => {
    if (!writable() || operation.current || preparing.current) return;
    preparing.current = true;
    setPreparingUi(true);
    try {
      const attachment = await window.electronAPI.deviceLink.pickPluginPackage(device.deviceId);
      if (attachment && writable())
        await begin('install-file', target, undefined, attachment.attachment);
    } catch {
      if (current()) setStatus('readFailed');
    } finally {
      preparing.current = false;
      if (current()) setPreparingUi(false);
    }
  };
  const uninstall = async (target: InstalledGhost) => {
    if (!writable() || operation.current || preparing.current) return;
    const abort = new AbortController();
    dialog.current = abort;
    preparing.current = true;
    setPreparingUi(true);
    try {
      const accepted = await confirm(
        {
          title: t('settings.ghosts.remote.uninstallOn', {
            name: target.manifest.name,
            device: device.name,
          }),
          confirmText: t('settings.ghosts.remote.uninstall'),
          confirmVariant: 'destructive',
        },
        abort.signal,
      );
      if (accepted && writable() && !abort.signal.aborted) await begin('uninstall', target);
    } finally {
      preparing.current = false;
      if (dialog.current === abort) dialog.current = null;
      if (current()) setPreparingUi(false);
    }
  };
  const busy = !online || unsupported || preparingUi || !!operation.current;
  const effectiveGhost = (item: InstalledGhost): InstalledGhost =>
    project
      ? {
          ...item,
          enabled:
            item.enabled && !projectState?.disabled.includes(installedGhostStoragePart(item)),
        }
      : item;
  const projectReady =
    !project || (!!projectState && projectState.projectId === project.id && !projectReadStatus);
  const applyProject = (next: PluginManagementProject | null) => {
    ++projectReadRevision.current;
    projectRef.current = next;
    setProject(next);
    setProjectState(null);
    setProjectReadStatus(next ? 'loading' : null);
  };
  const pickProject = (id: string | null) => {
    if (operation.current) return;
    const next = snapshot?.projects?.find((item) => item.id === id) ?? null;
    applyProject(next);
  };
  const update =
    ghost &&
    snapshot?.market.items.find(
      (i) => marketItemMatchesInstalledGhost(i, ghost) && i.installState === 'update-available',
    );
  const configuration = ghost ? (
    <>
      {ghost.enabled && getPluginToolUi(ghost.manifest) && ghost.uiCapabilityApproved !== true && (
        <div className="space-y-2 py-3 text-13 text-[var(--text-secondary)]">
          <p>{t('newChat.pluginUi.title', { name: ghost.manifest.name })}</p>
          {snapshot?.uiCapabilityApproval === true ? <Button size="sm" disabled={busy} onClick={() => void begin('approve-ui', ghost)}>{t('newChat.pluginUi.enable')}</Button> : <p>{t('newChat.pluginUi.updateHost')}</p>}
        </div>
      )}
    <RemotePluginConfiguration
      key={`${device.deviceId}:${installedGhostStoragePart(ghost)}:${ghostInstallApprovalToken(ghost.approval)}`}
      ghost={ghost}
      device={device}
      online={online}
      active={active}
      busy={busy}
      hostPreferences={snapshot?.hostPreferences === true}
      settingsPage={snapshot?.settingsPage === true}
    />
    </>
  ) : null;
  const targetProblem = !online || unsupported || !snapshot;
  const managingOnly =
    !project && !targetProblem && projectReadStatus === null && !!snapshot?.projects;
  const notice = hideManagingNotice && managingOnly ? null : (
    <CatalogManagementNotice
      title={
        project
          ? t('settings.ghosts.projectBanner.title', { name: project.name })
          : t(
              unsupported
                ? 'settings.ghosts.remote.viewingTarget'
                : 'settings.ghosts.remote.managingTarget',
              { device: device.name },
            )
      }
      warning={!online || projectReadStatus === 'failed'}
      action={
        project || (online && (unsupported || projectReadStatus === 'failed')) ? (
          <>
            {online && unsupported ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  if (operation.current) void poll();
                  else void refresh();
                }}
              >
                {t('settings.ghosts.remote.refresh')}
              </Button>
            ) : online && projectReadStatus === 'failed' ? (
              <Button size="sm" variant="secondary" onClick={() => void refreshProject()}>
                {t('settings.ghosts.remote.retry')}
              </Button>
            ) : null}
            {project ? (
              <Button
                size="sm"
                variant="secondary"
                tone="quiet"
                compact
                disabled={!!operation.current}
                onClick={() => pickProject(null)}
              >
                {t('settings.ghosts.projectBanner.backToGlobal')}
              </Button>
            ) : null}
          </>
        ) : null
      }
    >
      {!online
        ? t('settings.ghosts.remote.offlineNotice', { device: device.name })
        : unsupported
            ? t(legacy ? 'settings.ghosts.remote.unsupported' : 'settings.ghosts.remote.loading', {
                device: device.name,
              })
            : !snapshot
              ? t('settings.ghosts.remote.loading')
              : projectReadStatus === 'loading'
                ? t('settings.ghosts.remote.projectLoading')
                : projectReadStatus === 'failed'
                  ? t('settings.ghosts.remote.projectReadFailed')
                  : !snapshot.projects
                    ? t('settings.ghosts.remote.projectsUnsupported')
                    : project
                      ? t('settings.ghosts.projectBanner.desc', { device: device.name })
                      : t('settings.ghosts.remote.managingDescription')}
    </CatalogManagementNotice>
  );
  const filteredLegacy = (legacy ?? []).filter((item) =>
    [item.name, item.description, item.id]
      .join(' ')
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const normalizedQuery = query.toLocaleLowerCase();
  const filteredGhosts = snapshot?.ghosts.filter((item) =>
    `${item.manifest.name} ${item.manifest.description ?? ''}`
      .toLocaleLowerCase()
      .includes(normalizedQuery),
  );
  const todayCandidates = todayPool.filter(item => {
    const latest = snapshot?.market.items.find(row => row.pluginId === item.pluginId) ?? item;
    return !consumedToday.has(item.pluginId) && latest.installState !== 'installed' && latest.installState !== 'update-available';
  });
  const todayItems = selectPluginRecommendationBatch(todayCandidates, recommendationBatch);
  const publicationSupported = snapshot?.communityPublication === true;
  const publishableGhosts = (snapshot?.ghosts ?? []).filter(installed =>
    installed.publishingSource?.kind === 'local' && !localPublishingUnavailableKey(
      installed, snapshot?.market.items.find(item => marketItemMatchesInstalledGhost(item, installed)),
    ),
  );
  const [publicationDialog, setPublicationDialog] = useState<{ instanceId?: string } | null>(null);
  const [publicationReceipt, setPublicationReceipt] = useState<string | null>(null);
  const [publicationBusy, setPublicationBusy] = useState(false);
  const [publicationReadFailed, setPublicationReadFailed] = useState(false);
  const [publicationCheck, setPublicationCheck] = useState(0);
  const submitting = useRef(false);
  useEffect(() => {
    if (!online || !active) setPublicationDialog(null);
  }, [online, active]);
  const publicationReader = useMemo(() => ({
    prepare: async (instanceId: string) => {
      const installed = snapshot?.ghosts.find(item => installedGhostStoragePart(item) === instanceId);
      if (!writable() || !installed) throw new Error('[NOT_FOUND] Target installation is no longer available');
      return parseRemotePublicationPreview(await invoke('publish-prepare', {
        expectedInstalledApproval: ghostInstallApprovalToken(installed.approval),
        expectedVersion: installed.manifest.version,
      }, instanceId));
    },
    discard: async (preparedId: string) => {
      await invoke('publish-discard', { preparedId });
    },
  }), [invoke, snapshot, writable]);
  const finishPublication = useCallback((result: RemotePluginPublicationStatus) => {
    if (result.stage === 'pending') return;
    setPublicationReceipt(null);
    if (result.stage === 'submitted') toast.success(t('settings.ghosts.contribution.pendingVersion'));
    else if ('errorCode' in result) toast.error(t(`settings.ghosts.contribution.errors.${result.errorCode}`, {
      defaultValue: t('settings.ghosts.contribution.submitFailed'),
    }));
  }, [t]);
  useEffect(() => {
    if (!publicationReceipt || !online || !active) return;
    let disposed = false;
    let timer: number | undefined;
    let attempts = 0;
    setPublicationReadFailed(false);
    const check = async () => {
      try {
        const result = parseRemotePublicationStatus(await invoke('publish-status', { preparedId: publicationReceipt }));
        if (disposed || !current()) return;
        if (result.stage !== 'pending') {
          finishPublication(result);
          return;
        }
        if (++attempts < 45) {
          timer = window.setTimeout(() => void check(), 2000);
          return;
        }
      } catch {
        if (disposed || !current()) return;
      }
      setPublicationReadFailed(true);
    };
    void check();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [active, online, publicationReceipt, publicationCheck, invoke, current, finishPublication]);
  const submitPublication = async (instanceId: string, options?: PluginSubmitOptions) => {
    const prepared = options?.prepared;
    if (!writable() || submitting.current || publicationReceipt || !prepared || prepared.instanceId !== instanceId) return false;
    submitting.current = true;
    setPublicationBusy(true);
    try {
      const result = parseRemotePublicationStatus(await invoke('publish-submit', { preparedId: prepared.preparedId }));
      if (!current()) return false;
      if (result.stage === 'pending') {
        setPublicationDialog(null);
        setPublicationReceipt(prepared.preparedId);
      } else finishPublication(result);
      return result.stage !== 'failed';
    } catch {
      // A lost response does not tell us whether B started this submission.
      if (!current()) return false;
      setPublicationDialog(null);
      setPublicationReceipt(prepared.preparedId);
      return true;
    } finally {
      submitting.current = false;
      if (current()) setPublicationBusy(false);
    }
  };
  const publicationPending = publicationBusy || publicationReceipt !== null;
  const publicationUnavailable = !publicationSupported && (snapshot || unsupported) ? (
    <p className="mb-3 text-13 text-[var(--text-secondary)]">
      {t('settings.ghosts.remote.publishOnTarget', { device: device.name })}
    </p>
  ) : null;
  const publicationProgress = publicationReceipt ? (
    <div role="status" className="mb-3 flex items-center gap-3 text-13 text-[var(--text-secondary)]">
      <p>{t(!online || publicationReadFailed ? 'settings.ghosts.remote.unknown' : 'settings.ghosts.contribution.loading')}</p>
      {publicationReadFailed && online ? (
        <Button size="sm" onClick={() => setPublicationCheck(value => value + 1)}>{t('settings.ghosts.remote.retry')}</Button>
      ) : null}
    </div>
  ) : null;
  const publicationOverlay = publicationDialog && publicationSupported && online ? (
    <PluginPublishDialog
      open
      ownerKey={catalogOwnerKey}
      sourceDevice={device.name}
      initialInstanceId={publicationDialog.instanceId}
      reader={publicationReader}
      localPlugins={publishableGhosts.map(installed => toGhostPluginListItem(installed))}
      installedPluginCount={snapshot?.ghosts.length ?? 0}
      installedRevision={JSON.stringify(publishableGhosts.map(installed => [
        installedGhostStoragePart(installed), installed.manifest.version, ghostInstallApprovalToken(installed.approval),
      ]))}
      onOpenChange={open => { if (!open) setPublicationDialog(null); }}
      onClosed={() => {}}
      onSubmitUpdate={submitPublication}
      submitBusy={publicationPending}
    />
  ) : null;
  const projectPicker = projectPickerOpen ? (
    <AddRemoteProjectDialog
      open={projectPickerOpen}
      onOpenChange={(open) => { ++projectPickerRevision.current; setProjectPickerOpen(open); }}
      initialDeviceId={device.deviceId}
      fixedDeviceId={device.deviceId}
      title={t('settings.ghosts.scopePicker.projectsForComputer', { device: device.name })}
      confirmText={t('newChat.folderPicker.selectFolder')}
      errorText={t('settings.ghosts.remote.projectReadFailed')}
      onProjectAdded={async (target) => {
        if (target.kind !== 'device-link' || target.deviceId !== device.deviceId ||
          !projectPickerCurrent.current || !writable() || operation.current) return;
        const revision = ++projectPickerRevision.current;
        const next = parsePluginManagementProject(await invoke('project-select', { path: target.path }));
        if (!projectPickerCurrent.current || !writable() || revision !== projectPickerRevision.current) return;
        // Re-read the Host catalogue so a previous transient browse does not remain selectable.
        await refresh();
        if (!projectPickerCurrent.current || !writable() || revision !== projectPickerRevision.current) return;
        applyProject(next);
      }}
    />
  ) : null;
  const overlay = <>{projectPicker}{publicationOverlay}</>;
  if (unsupported && legacySelected) return (
    <PluginCatalogView overlay={overlay} detail={{ readOnly: {
      detail: legacyDetail?.id === legacySelected.id ? legacyDetail : legacySelected,
      notice: <>{notice}{publicationUnavailable}</>,
      loading: online && legacyDetailStatus === 'loading',
      failed: legacyDetailStatus === 'failed',
      online,
      onBack: () => {
        ++detailRevision.current;
        restoreCatalogScroll();
        setLegacySelected(null);
        setLegacyDetail(null);
        setLegacyDetailStatus(null);
      },
      onRetry: () => void loadLegacyDetail(legacySelected),
    } }} />
  );

  const detailNotice = <>
    {targetProblem || projectReadStatus ? notice : null}
    {publicationUnavailable}
    {publicationProgress}
  </>;
  if (ghost) {
    const installed = effectiveGhost(ghost);
    return (
      <PluginCatalogView overlay={overlay} notice={detailNotice} detail={{ installed: {
        remote: true,
        remoteConfiguration: configuration,
        ghost: installed,
        marketItem: snapshot?.market.items.find(item => marketItemMatchesInstalledGhost(item, ghost)),
        detail: toGhostPluginDetail(installed),
        panelStatus: null,
        onBack: () => { restoreCatalogScroll(); setSelected(null); },
        onToggle: enabled => void begin(enabled ? 'enable' : 'disable', ghost),
        toggleDisabled: busy || !projectReady || (!!project && !ghost.enabled),
        onUse: () => {},
        updateBusy: busy,
        updateVersion: update?.version,
        onUpdate: () => { if (update) void install(update); },
        onUpdateFromFile: () => void installFile(ghost),
        remoteFileUpdate: (ghost.namespace === null || ghost.namespace === 'local') && !ghost.builtin,
        onUninstall: () => void uninstall(ghost),
        onContribute: publicationSupported && publishableGhosts.includes(ghost)
          ? () => setPublicationDialog({ instanceId: installedGhostStoragePart(ghost) }) : undefined,
        contributionBusy: publicationPending,
        contributionUnavailableReason: !online ? t('settings.ghosts.contribution.offline') : undefined,
      } }} />
    );
  }

  if (marketDetail) return (
    <PluginCatalogView overlay={overlay} notice={detailNotice} detail={{ market: {
      detail: marketDetail,
      busy,
      backLabel: relatedMarketTrail.current.length ? t('settings.back') : undefined,
      onBack: () => {
        ++detailRevision.current;
        const previous = relatedMarketTrail.current.pop();
        if (!previous) restoreCatalogScroll();
        setMarketDetail(previous ?? null);
      },
      relatedCatalog: { cache: browserCache, ownerKey: catalogOwnerKey, catalogKey: i18n.language,
        loadPage: readMarketPage, liveItems: snapshot?.market.items, installedGhosts: snapshot?.ghosts, online },
      onOpenRelated: item => { if (!busy) void selectMarket(item, marketDetail); },
      onInstall: marketDetail.installState === 'conflict' ? undefined : () => void install(marketDetail),
      onIconLoadError: () => {},
    } }} />
  );

  return (
    <PluginCatalogView
      overlay={overlay}
      catalog={{
        embedded,
        onSelectCatalogTab,
        query,
        onQueryChange: setQuery,
        searchScope,
        onSearchScope: setSearchScope,
        scrollRef: catalogScroller,
        onScroll: onListScroll,
        tabsRef: secondaryTabs,
        tab: catalogTab,
        onSelectTab: setCatalogTab,
        target: {
          computer: deviceControl ?? {
            selected: device,
            onSelect: () => {},
            directory: { candidates: [], target: undefined, online, relayOnline: online },
          },
          projectLabel: project?.name,
          project: <PluginProjectMenu
            scopeDir={project?.id ?? null}
            activeSessionWorkingDir={undefined}
            recentWorkdirs={[]}
            computerName={device.name}
            projectOptions={snapshot?.projects ?? []}
            onBrowse={snapshot?.projectBrowse ? () => setProjectPickerOpen(true) : undefined}
            disabled={!online || !snapshot || !snapshot.projects || !!operation.current}
            unavailable={unsupported || (!!snapshot && !snapshot.projects)}
            onPick={pickProject}
          />,
        },
        publication: publicationSupported ? {
          onClick: () => setPublicationDialog({}),
          disabled: !online || publicationPending,
        } : undefined,
        notice: publicationUnavailable || publicationProgress ? <>{publicationUnavailable}{publicationProgress}</> : undefined,
        headerActions: unsupported ? undefined : (
          <GhostPluginActions disabled={busy} installTarget={device.name} onInstall={() => void installFile()} />
        ),
        installedTotal: snapshot?.ghosts.length ?? 0,
        installedCount: unsupported ? (legacy ? filteredLegacy.length : undefined) : filteredGhosts?.length,
        installedNotice: notice,
        installedSentinel,
        installedGrid: {
          cache: installedGridCache,
          count: unsupported
            ? Math.min(installedLimit, filteredLegacy.length)
            : !project || projectState?.projectId === project.id
              ? Math.min(installedLimit, filteredGhosts?.length ?? 0)
              : 0,
          renderItem: index => {
            if (unsupported) {
              const item = filteredLegacy[index]!;
              const openDetail = () => {
                captureCatalogScroll();
                setLegacyDetail(null);
                setLegacyDetailStatus('loading');
                setLegacySelected(item);
              };
              return <GhostPluginCard key={item.id} readOnly item={item} showLocalUnread={false} onManage={openDetail} onPrimary={openDetail} />;
            }
            const installed = filteredGhosts![index]!;
            const id = installedGhostStoragePart(installed);
            const item = { ...toGhostPluginListItem(effectiveGhost(installed)), canUse: false, tabPanel: false };
            const marketItem = snapshot?.market.items.find(entry => marketItemMatchesInstalledGhost(entry, installed));
            const update = snapshot?.market.items.find(entry =>
              entry.installState === 'update-available' && marketItemMatchesInstalledGhost(entry, installed),
            );
            return <GhostPluginCard
              key={id}
              item={item}
              author={installed.manifest.author}
              marketItem={marketItem}
              showLocalUnread={false}
              sourceLabel={installed.namespace ?? t('settings.ghosts.remote.personalInstall')}
              onManage={() => {
                captureCatalogScroll();
                ++detailRevision.current;
                setSelected(id);
              }}
              onPrimary={() => { captureCatalogScroll(); setSelected(id); }}
              updateBusy={busy}
              updateVersion={update?.version}
              onUpdate={update ? () => void install(update) : undefined}
            />;
          },
        },
        installedEmpty: (unsupported ? legacy?.length === 0 : snapshot && !snapshot.ghosts.length) ? (
          <p className="text-13 leading-5 text-[var(--text-tertiary)]">{t('settings.ghosts.remote.empty')}</p>
        ) : undefined,
        recommendations: !todayLoaded || todayItems.length === 3 ? {
          loading: !todayLoaded,
          items: todayItems,
          order: catalogMemory.recommendationOrder,
          shuffle: {
            title: t('settings.ghosts.page.todayRecommendations'),
            label: t('newChat.homeSuggestions.shuffle'),
            candidates: todayCandidates,
            onChange: setRecommendationBatch,
          },
          active,
          busy,
          renderItem: (item, featured, deck) => <MarketPluginCard compact featured={featured} item={item}
            recommendationDeck={deck} busy={busy} onSelect={() => void selectMarket(item)}
            onInstall={() => void install(item)} onIconLoadError={() => {}} />,
        } : undefined,
        market: unsupported ? undefined : {
          cacheRef: browserCache,
          ownerKey: JSON.stringify([device.deviceId, scope.current.owner]),
          catalogKey: i18n.language,
          revision: JSON.stringify([snapshot?.market.customSourceNames, snapshot?.market.unavailableCustomSourceNames,
            snapshot?.market.unavailableReason, snapshot?.market.organizationAccessError,
            snapshot?.market.items.filter(item => !catalogPaging || item.sourceType !== 'server').map(item => [item.pluginId, item.version]),
            query.trim() ? snapshot?.market.items.map(item => [item.pluginId, item.installState]) : null]),
          installedItems: snapshot?.market.items,
          installedGhosts: snapshot?.ghosts,
          scope: originFilter,
          onScope: setOriginFilter,
          showOrganization: true,
          visible: active && (!!query.trim() || catalogTab === 'market'),
          loadPage: readMarketPage,
          online,
          onCounts: counts => { if (!query.trim()) setMarketTotal(counts?.all ?? null); },
          renderRevision: busy,
          total: marketTotal,
          renderItem: (item, metric) => <MarketPluginCard key={item.pluginId} item={item} metric={metric} busy={busy}
            onSelect={() => void selectMarket(item)}
            onInstall={item.installState === 'installed' || item.installState === 'update-available' ? undefined : () => void install(item)}
            onIconLoadError={() => {}} />,
        },
      }}
    />
  );
}
