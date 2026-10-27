import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  REMOTE_RESOURCE_CHANGED_CHANNEL,
  parseRemoteResourceChangedPayload,
} from '@cindy/device-link';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import { CatalogManagementNotice } from '@/features/plugin/PluginManagementLayout';
import type { CatalogDevice, CatalogDeviceControl } from '@/features/plugin/useCatalogDevice';
import {
  parseRemoteSkillReceipt,
  type RemoteSkillItem,
  type RemoteSkillMutation,
  type RemoteSkillProject,
  type RemoteSkillReceipt,
  type RemoteSkillsSnapshot,
} from '../../../shared/remoteSkills';
import {
  invokeRemoteSkills,
  parseRemoteSkills,
  remoteSkillsCapabilities,
} from './remoteSkillsClient';
import {
  SkillhubTargetContext,
  useSkillhubTarget,
  type SkillhubTarget,
  type SkillhubBrowseApi,
} from './SkillhubTargetContext';
import { SkillhubHomeContent } from './SkillhubHomeView';
import { SkillhubMarketListView } from './SkillhubMarketListView';
import { SkillhubDetailView } from './SkillhubDetailView';
import { SkillhubMarketDetailView } from './SkillhubMarketDetailView';
import { LocalSkillControls } from './components/LocalSkillControls';
import { InstallTargetPicker } from './components/InstallTargetPicker';
import { SkillDetailHeader, SkillDetailPage } from './components/SkillDetailLayout';
import { useMarketSkillUpdate } from './hooks/useMarketSkillUpdate';
import type { MarketSkill } from './hooks/useMarketList';
import { marketInfoViewModel } from './lib/marketInfoViewModel';
import { marketLocalCopies } from './lib/marketLocalCopies';

type Detail = { localId?: string; market?: MarketSkill; showingMarket: boolean };

/** The normal Skill pages, with a target-scoped store and fixed remote executors. */
export function RemoteSkillsPage({
  device,
  online,
  embedded,
  active = true,
  deviceControl,
  onSelectCatalogTab,
}: {
  device: CatalogDevice;
  online: boolean;
  embedded?: boolean;
  active?: boolean;
  deviceControl?: CatalogDeviceControl;
  onSelectCatalogTab?: (tab: 'plugins' | 'skills') => void;
}) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<RemoteSkillsSnapshot | null>(null);
  const [capabilities, setCapabilities] = useState({ management: false, catalog: false });
  const [status, setStatus] = useState<'readFailed' | 'unknown' | null>(null);
  const [checked, setChecked] = useState(false);
  const [page, setPage] = useState<'home' | 'market'>('home');
  const [visitedMarket, setVisitedMarket] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [receipt, setReceipt] = useState<RemoteSkillReceipt | null>(null);
  const owner = useRef(getDataOwnerGeneration()).current;
  const alive = useRef(true),
    onlineRef = useRef(online),
    revision = useRef(0);
  onlineRef.current = online;
  const operation = useRef<{ id: string; resolve(result: RemoteSkillReceipt): void } | null>(null);
  const confirming = useRef(new Set<string>());
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const current = useCallback(() => alive.current && isDataOwnerGenerationCurrent(owner), [owner]);
  const writable = useCallback(() => current() && onlineRef.current, [current]);
  const invoke = useCallback(
    (action: string, input?: Record<string, unknown>, item?: RemoteSkillItem) =>
      invokeRemoteSkills(device.deviceId, action, input, item),
    [device.deviceId],
  );
  const rootFor = useCallback(
    (item: RemoteSkillItem) =>
      `remote-skill/${encodeURIComponent(device.deviceId)}/${owner.generation}/${item.id}/${item.revision}`,
    [device.deviceId, owner],
  );
  const toSkill = useCallback(
    (item: RemoteSkillItem): SkillhubSkill => {
      const root = rootFor(item);
      const entryFile =
        item.entryFile && !/[\\/]/.test(item.entryFile) && !['.', '..'].includes(item.entryFile)
          ? item.entryFile
          : item.kind === 'skill'
            ? 'SKILL.md'
            : `${item.name}.md`;
      return {
        id: item.id,
        urlKey: item.id,
        sourceKey: item.id,
        engine: 'claude-code',
        kind: item.kind,
        scope: item.scope,
        name: item.name,
        description: item.description,
        absolutePath: root,
        discoveredPath: root,
        mdPath: `${root}/${entryFile}`,
        files: [],
        projectRoot: item.projectId ? `remote-project/${item.projectId}` : item.project,
        projectHash: item.projectId,
        linkedEngines: item.engines.map((label) => ({ engine: 'claude-code' as const, label })),
        cindyEnabled: item.enabled,
        canUninstall: item.canUninstall,
        managedByPlugin: item.managedByPlugin,
        builtIn: item.builtIn,
        registrySkillName: item.market?.name,
        registryEntry: item.market
          ? {
              version: item.version ?? '',
              catalogScope: item.market.catalogScope,
              origin: item.market.origin ?? 'installed',
              authorId: item.market.authorId ?? '',
              folderHash: '',
              installedAt: 0,
              updatedAt: 0,
            }
          : null,
      };
    },
    [rootFor],
  );
  const refresh = useCallback(async () => {
    if (!writable()) return [];
    const read = ++revision.current;
    try {
      const nextCapabilities = await remoteSkillsCapabilities(device.deviceId);
      if (!writable() || read !== revision.current) return [];
      setCapabilities(nextCapabilities);
      setChecked(true);
      if (!nextCapabilities.management) return [];
      const next = parseRemoteSkills(await invoke('snapshot', { installedOnly: true }));
      if (!writable() || read !== revision.current) return [];
      setSnapshot(next);
      snapshotRef.current = next;
      setStatus((previous) => (previous === 'readFailed' ? null : previous));
      return next.items.map(toSkill);
    } catch {
      if (writable() && read === revision.current) setStatus('readFailed');
      return [];
    }
  }, [device.deviceId, invoke, toSkill, writable]);
  const accept = useCallback(
    (next: RemoteSkillReceipt) => {
      if (!current() || next.operationId !== operation.current?.id) return;
      setReceipt(next);
      if (['succeeded', 'cancelled', 'failed'].includes(next.phase)) {
        confirming.current.delete(next.operationId);
        const pending = operation.current;
        operation.current = null;
        pending?.resolve(next);
        setStatus(null);
        if (next.phase === 'succeeded') void refresh();
      }
    },
    [current, refresh],
  );
  const poll = useCallback(async () => {
    const pending = operation.current;
    if (!pending || !writable()) return;
    try {
      accept(
        parseRemoteSkillReceipt(await invoke('operation', { operationId: pending.id }), pending.id),
      );
    } catch {
      if (current() && operation.current === pending) setStatus('unknown');
    }
  }, [accept, current, invoke, writable]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      const pending = operation.current;
      if (pending) {
        pending.resolve({ operationId: pending.id, phase: 'cancelled' });
        if (isDataOwnerGenerationCurrent(owner))
          void invoke('cancel', { operationId: pending.id }).catch(() => {});
      }
    };
  }, [invoke, owner]);
  useEffect(() => {
    if (!online) {
      revision.current++;
      return;
    }
    if (active) {
      void refresh();
      void poll();
    }
  }, [online, active, refresh, poll]);
  useEffect(() => {
    if (!online || !operation.current) return;
    const timer = setInterval(() => {
      void poll();
    }, 1200);
    return () => clearInterval(timer);
  }, [online, receipt, poll]);
  useEffect(() => {
    if (!online || receipt?.phase !== 'confirmation' || confirming.current.has(receipt.operationId))
      return;
    const id = receipt.operationId;
    confirming.current.add(id);
    void window.electronAPI.deviceLink
      .confirmSkillMutation(device.deviceId, id)
      .then((result) => {
        if (current()) accept(parseRemoteSkillReceipt(result, id));
      })
      .catch(() => {
        confirming.current.delete(id);
        if (current() && operation.current?.id === id) setStatus('unknown');
      });
  }, [online, receipt, device.deviceId, current, accept]);
  useEffect(() => {
    const focus = () => {
      if (active) void refresh();
    };
    window.addEventListener('focus', focus);
    const off = window.electronAPI.deviceLink.onRemotePush((push, stamp) => {
      if (
        active &&
        push.deviceId === device.deviceId &&
        push.channel === REMOTE_RESOURCE_CHANGED_CHANNEL &&
        parseRemoteResourceChangedPayload(push.payload)?.collectionId === 'skills' &&
        isDeviceLinkRemotePushCurrent(push, stamp)
      )
        void refresh();
    });
    return () => {
      off();
      window.removeEventListener('focus', focus);
    };
  }, [active, device.deviceId, refresh]);

  const mutate = useCallback(
    async (
      kind: RemoteSkillMutation,
      skill?: SkillhubSkill,
      market?: { name: string; catalogScope?: 'market' | 'team'; latestVersion: string },
      project?: RemoteSkillProject,
    ) => {
      if (!writable() || !capabilities.management || operation.current)
        throw new Error('UNAVAILABLE');
      const item = skill
        ? snapshotRef.current?.items.find((entry) => entry.id === skill.id)
        : undefined;
      if (skill && !item) throw new Error('STALE_TARGET');
      const id = crypto.randomUUID();
      const completion = new Promise<RemoteSkillReceipt>((resolve) => {
        operation.current = { id, resolve };
      });
      setReceipt({ operationId: id, phase: 'running' });
      void (async () => {
        try {
          const next = parseRemoteSkillReceipt(
            await invoke(
              'begin',
              {
                operationId: id,
                kind,
                ...(market
                  ? {
                      name: market.name,
                      catalogScope: market.catalogScope ?? 'market',
                      version: market.latestVersion,
                    }
                  : {}),
                ...(project ? { projectId: project.id, projectRevision: project.revision } : {}),
              },
              item,
            ),
            id,
          );
          if (!current() || operation.current?.id !== id) return;
          accept(next);
        } catch (error) {
          if (current() && operation.current?.id === id) {
            const code = extractIpcError(error)?.code;
            if (
              code &&
              [
                'NOT_FOUND',
                'INVALID_PARAMS',
                'UNSUPPORTED_CAPABILITY',
                'PERMISSION_DENIED',
              ].includes(code)
            ) {
              accept({ operationId: id, phase: 'failed' });
              void refresh();
              return;
            }
            setReceipt({ operationId: id, phase: 'running' });
            setStatus('unknown');
          }
        }
      })();
      return completion;
    },
    [accept, capabilities.management, current, invoke, refresh, writable],
  );
  const api = useMemo<SkillhubBrowseApi>(() => {
    const catalog = async <T,>(method: string, input: Record<string, unknown>): Promise<T> => {
      if (!writable()) throw new Error('UNAVAILABLE');
      const result = await invoke('catalog', { method, ...input });
      if (!writable()) throw new Error('STALE_TARGET');
      if (
        !result ||
        typeof result !== 'object' ||
        typeof (result as { success?: unknown }).success !== 'boolean'
      )
        throw new Error('INVALID_RESPONSE');
      return result as T;
    };
    const read = async <T,>(virtualPath: string, children: boolean): Promise<T> => {
      if (!writable()) throw new Error('UNAVAILABLE');
      const item = snapshotRef.current?.items.find(
        (entry) => virtualPath === rootFor(entry) || virtualPath.startsWith(`${rootFor(entry)}/`),
      );
      if (!item) throw new Error('STALE_TARGET');
      const relative = virtualPath.slice(rootFor(item).length).replace(/^\//, '');
      if (!capabilities.catalog && !children && virtualPath === toSkill(item).mdPath) {
        const result = (await invoke('detail', {}, item)) as { markdown?: unknown };
        if (!writable() || typeof result?.markdown !== 'string')
          throw new Error('INVALID_RESPONSE');
        return { success: true, content: result.markdown } as T;
      }
      const result = await invoke(children ? 'children' : 'read-file', { path: relative }, item);
      if (!writable()) throw new Error('STALE_TARGET');
      return result as T;
    };
    return {
      listMarket: (params) => catalog('list', { ...params, scope: params?.scope ?? 'market' }),
      listCategories: (params) => catalog('categories', { scope: params?.scope ?? 'market' }),
      info: (name, scope) => catalog('info', { name, scope: scope ?? 'market' }),
      getPublishedFiles: ({ catalogScope, ...params }) =>
        catalog('files', { ...params, scope: catalogScope ?? 'market' }),
      readPublishedFile: ({ catalogScope, ...params }) =>
        catalog('file', { ...params, scope: catalogScope ?? 'market' }),
      getScanStatus: ({ slug, catalogScope, ...params }) =>
        catalog('scan-status', { ...params, name: slug, scope: catalogScope ?? 'market' }),
      listChildren: ({ dirPath }) => read(dirPath, true),
      readSkill: ({ mdPath }) => read(mdPath, false),
      readSiblingFile: ({ filePath }) => read(filePath, false),
    };
  }, [capabilities.catalog, invoke, rootFor, toSkill, writable]);
  const skills = useMemo(() => (snapshot?.items ?? []).map(toSkill), [snapshot, toSkill]);
  const projects = useMemo(
    () =>
      (snapshot?.projects ?? []).map((project) => ({
        projectRoot: `remote-project/${project.id}`,
        displayName: project.name,
        hash: project.id,
        target: project,
      })),
    [snapshot],
  );
  const state = useMemo<SkillhubTarget['state']>(
    () => ({
      skills,
      projects,
      sources: [],
      loading: !snapshot,
      error: status,
      bootstrapped: !!snapshot,
      learnSkillEnabled: false,
      syncResults: new Map(),
      syncError: null,
      availableUninstalledCount: 0,
    }),
    [skills, projects, snapshot, status],
  );
  const target = useMemo<SkillhubTarget>(() => {
    return {
      name: device.name,
      ready: online && capabilities.catalog,
      writable: online && capabilities.management && !operation.current,
      state,
      projects,
      api,
      refresh,
      current,
      mutate,
      openLocal: (skill) => setDetail({ localId: skill.id, showingMarket: false }),
      openMarket: (market) => setDetail({ market, showingMarket: true }),
      openMarketList: () => {
        setVisitedMarket(true);
        setPage('market');
      },
      back: () => {
        if (detail) setDetail(null);
        else setPage('home');
      },
      displayPath: (value) => {
        const item = snapshot?.items.find(
          (entry) => value === rootFor(entry) || value.startsWith(`${rootFor(entry)}/`),
        );
        const project = item?.project ? ` · ${item.project}` : '';
        return item
          ? `${device.name}${project} · ${item.name}${value.slice(rootFor(item).length)}`
          : device.name;
      },
    };
  }, [
    snapshot,
    state,
    projects,
    device.name,
    online,
    capabilities,
    api,
    refresh,
    current,
    mutate,
    detail,
    rootFor,
    receipt,
  ]);
  const notice = (
    <CatalogManagementNotice
      className="mb-0"
      title={t('settings.ghosts.remote.managingTarget', { device: device.name })}
      warning={!online || !!status}
      action={
        online && (status || (checked && !capabilities.catalog)) ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              if (operation.current) void poll();
              else void refresh();
            }}
          >
            {t('settings.ghosts.remote.retry')}
          </Button>
        ) : null
      }
    >
      {!online
        ? t('settings.ghosts.remote.offlineNotice', { device: device.name })
        : status
          ? t(
              status === 'readFailed'
                ? 'skillhub.remote.readFailed'
                : 'settings.ghosts.remote.unknown',
            )
          : checked && !capabilities.catalog
            ? t('skillhub.remote.unsupported')
            : !snapshot
              ? t('skillhub.remote.loading')
              : t('settings.ghosts.remote.managingDescription')}
    </CatalogManagementNotice>
  );
  return (
    <SkillhubTargetContext.Provider value={target}>
      <div className="relative h-full min-h-0 w-full">
        <div
          className="absolute inset-0"
          style={{ visibility: page === 'home' && !detail ? 'visible' : 'hidden' }}
          aria-hidden={page !== 'home' || !!detail}
          inert={page !== 'home' || !!detail}
        >
          <SkillhubHomeContent
            deviceControl={deviceControl}
            embedded={embedded}
            active={active && page === 'home' && !detail}
            onSelectCatalogTab={onSelectCatalogTab}
            notice={notice}
          />
        </div>
        {visitedMarket && (
          <div
            className="absolute inset-0"
            style={{ visibility: page === 'market' && !detail ? 'visible' : 'hidden' }}
            aria-hidden={page !== 'market' || !!detail}
            inert={page !== 'market' || !!detail}
          >
            <SkillhubMarketListView active={active && page === 'market' && !detail} />
          </div>
        )}
        {detail && (
          <RemoteSkillDetail
            key={detail.localId ?? `${detail.market?.catalogScope}:${detail.market?.name}`}
            detail={detail}
            onChange={setDetail}
          />
        )}
      </div>
    </SkillhubTargetContext.Provider>
  );
}

/** Source switching and management use the same detail components as this computer. */
function RemoteSkillDetail({
  detail,
  onChange,
}: {
  detail: Detail;
  onChange(value: Detail): void;
}) {
  const target = useSkillhubTarget()!;
  const { t } = useTranslation();
  const explicit = target.state.skills.find((skill) => skill.id === detail.localId);
  const [market, setMarket] = useState<MarketSkill | null>(detail.market ?? null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const update = useMarketSkillUpdate();
  const reference = explicit?.registryEntry
    ? {
        name: explicit.registrySkillName ?? explicit.name,
        catalogScope: explicit.registryEntry.catalogScope,
      }
    : detail.market;
  useEffect(() => {
    if (!reference || !target.ready) return;
    let cancelled = false;
    void target.api
      .info(reference.name, reference.catalogScope)
      .then((result) => {
        if (!cancelled && result.success && result.info)
          setMarket(marketInfoViewModel(result.info, explicit ?? null, reference.catalogScope));
      })
      .catch(() => {
        if (!cancelled) toast.error(t('skillhub.unifiedDetail.marketUnavailable'));
      });
    return () => {
      cancelled = true;
    };
  }, [
    reference?.name,
    reference?.catalogScope,
    target.api,
    target.ready,
    explicit?.registryEntry?.version,
    t,
  ]);
  const copies = market
    ? marketLocalCopies(target.state.skills, market)
    : explicit
      ? [explicit]
      : [];
  const selected = explicit ?? copies[0];
  const navigation = (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-default)] px-4 py-2">
      <div
        className="flex items-center gap-1"
        role="group"
        aria-label={t('skillhub.unifiedDetail.contentSource')}
      >
        {selected && (
          <Button
            variant={detail.showingMarket ? 'secondary' : 'primary'}
            aria-pressed={!detail.showingMarket}
            onClick={() => onChange({ ...detail, localId: selected.id, showingMarket: false })}
          >
            {t('skillhub.unifiedDetail.local')}
          </Button>
        )}
        {market && (
          <Button
            variant={detail.showingMarket ? 'primary' : 'secondary'}
            aria-pressed={detail.showingMarket}
            onClick={() => onChange({ ...detail, market, showingMarket: true })}
          >
            {t('skillhub.unifiedDetail.market')}
          </Button>
        )}
      </div>
      {copies.length > 1 && (
        <Select
          label={t('skillhub.sidebar.marketInstalledHeading')}
          value={selected?.id ?? ''}
          className="max-w-sm"
          onValueChange={(id) => onChange({ ...detail, localId: id })}
          options={copies.map((copy) => ({
            value: copy.id,
            label: `${
              copy.scope === 'global'
                ? t('skillhub.detail.scopeGlobal')
                : (target.projects.find((project) => project.projectRoot === copy.projectRoot)
                    ?.displayName ?? '')
            } · ${target.displayPath(copy.absolutePath)}`,
          }))}
        />
      )}
      {detail.showingMarket && selected && (
        <span
          className="min-w-0 truncate text-xs text-[var(--text-secondary)]"
          title={target.displayPath(selected.absolutePath)}
        >
          {target.displayPath(selected.absolutePath)}
        </span>
      )}
    </div>
  );
  if (!detail.showingMarket && selected)
    return (
      <SkillhubDetailView
        entryOverride={selected}
        renderNavigation={() => navigation}
        onUninstalled={target.back}
      />
    );
  if (!market)
    return (
      <SkillDetailPage>
        <SkillDetailHeader
          title={explicit?.name ?? detail.market?.name ?? ''}
          backLabel={t('skillhub.detail.backToSkillhub')}
          onBack={target.back}
        />
        {navigation}
      </SkillDetailPage>
    );
  const currentMarket = marketInfoViewModel(market, selected ?? null, market.catalogScope);
  return (
    <>
      <SkillhubMarketDetailView
        skill={currentMarket}
        onClose={target.back}
        navigation={navigation}
        primaryAction="clone"
        onClone={() => setPickerOpen(true)}
        learnSkillEnabled={false}
        onUpdate={update.update}
        updating={update.updatingNames.has(market.name)}
        localActions={
          selected ? (
            <LocalSkillControls key={selected.id} skill={selected} disabled={!target.writable} />
          ) : null
        }
      />
      <InstallTargetPicker
        open={pickerOpen}
        skill={currentMarket}
        onClose={() => setPickerOpen(false)}
        onInstallComplete={() => {
          setPickerOpen(false);
          void target.refresh();
        }}
      />
    </>
  );
}
