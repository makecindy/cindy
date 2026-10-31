import { getPluginToolUi } from '@cindy/plugin-protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  REMOTE_RESOURCE_CHANGED_CHANNEL,
  parseRemoteResourceChangedPayload,
} from '@cindy/device-link';
import { Button } from '@/components/ui/button';
import { AddRemoteProjectDialog } from '@/components/new-chat/AddRemoteProjectDialog';
import { SegmentedControl } from '@/components/ui/segmented-control';
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
  PluginManagementSnapshot,
  PluginManagementProject,
  PluginManagementProjectState,
} from '../../../shared/pluginManagement';
import type { PluginMarketDetail, PluginMarketItem } from '../../../shared/pluginMarket';
import { GhostPluginCard, MarketPluginCard } from './GhostPluginPage';
import { GhostPluginActions } from './GhostPluginActions';
import type { CatalogDeviceControl } from './useCatalogDevice';
import { GhostPluginDetailView } from './GhostPluginDetailView';
import { RemotePluginConfiguration } from './RemotePluginConfiguration';
import { RemotePluginReadOnlyDetail } from './RemotePluginReadOnlyDetail';
import { MarketPluginDetailView } from './MarketPluginDetailView';
import {
  PluginManagementLayout,
  InstalledCatalogHeader,
  CatalogTargetControls,
  CatalogManagementNotice,
  PluginManagementPage,
  PLUGIN_INSTALLED_CARD_GRID_CLASS,
  PLUGIN_MANAGEMENT_CARD_GRID_CLASS,
} from './PluginManagementLayout';
import { PluginProjectMenu } from './PluginScopePicker';
import { toGhostPluginDetail, toGhostPluginListItem } from './lib/ghostPluginViewModel';
import {
  marketItemMatchesInstalledGhost,
  pluginPresentationOrigin,
} from './lib/pluginMarketPresentation';
import {
  hasPluginManagement,
  invokePluginManagement,
  parsePluginManagementSnapshot,
  parsePluginManagementProjectState,
  parsePluginManagementProject,
  parsePluginManagementDetail,
  parsePluginManagementReceipt,
  readLegacyManagedPlugins,
  readLegacyManagedPlugin,
  type LegacyManagedPlugin,
  type LegacyManagedPluginDetail,
} from './remotePluginManagementClient';

/** Every async closure belongs to this mounted owner + selected computer. Never uses local Ghost IPC. */
export function RemotePluginPage({
  device,
  online,
  active = true,
  embedded,
  deviceControl,
  onSelectCatalogTab,
}: {
  device: { deviceId: string; name: string };
  online: boolean;
  active?: boolean;
  embedded?: boolean;
  deviceControl?: CatalogDeviceControl;
  onSelectCatalogTab?: (tab: 'plugins' | 'skills') => void;
}) {
  const { t, i18n } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [snapshot, setSnapshot] = useState<PluginManagementSnapshot | null>(null);
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
  const [query, setQuery] = useState('');
  const [originFilter, setOriginFilter] = useState('all');
  const [status, setStatus] = useState<
    'readFailed' | 'unknown' | 'changed' | 'actionFailed' | null
  >(null);
  const [unsupported, setUnsupported] = useState(false);
  const [legacy, setLegacy] = useState<LegacyManagedPlugin[] | null>(null);
  const [legacySelected, setLegacySelected] = useState<LegacyManagedPlugin | null>(null);
  const [legacyDetail, setLegacyDetail] = useState<LegacyManagedPluginDetail | null>(null);
  const [legacyDetailStatus, setLegacyDetailStatus] = useState<'loading' | 'failed' | null>(null);
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
  const refresh = useCallback(async () => {
    const revision = ++readRevision.current;
    if (!writable()) return;
    try {
      const supported = await hasPluginManagement(device.deviceId);
      if (!writable() || revision !== readRevision.current) return;
      setUnsupported(!supported);
      if (!supported) {
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
      const next = parsePluginManagementSnapshot(await invoke('snapshot'));
      if (writable() && revision === readRevision.current) {
        setSnapshot(next);
        setLegacySelected(null);
        setLegacyDetail(null);
        setStatus(null);
      }
    } catch {
      if (writable() && revision === readRevision.current) setStatus('readFailed');
    }
  }, [device.deviceId, i18n.language, invoke, writable]);
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
  useEffect(() => {
    if (!online) {
      ++readRevision.current;
      ++detailRevision.current;
      ++projectReadRevision.current;
      dialog.current?.abort();
    } else if (active) void refresh();
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
              content: <>{consent.purpose === 'ui-capability' && <p className="text-13 text-[var(--text-secondary)]">{t(`mcpApps.pluginTrust.${consent.trust ?? 'unverified'}`)}</p>}<GhostInstallConsentContent facts={consent.facts} capabilityOnly={consent.purpose === 'ui-capability'} /></>,
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
  const selectMarket = async (item: PluginMarketItem) => {
    const revision = ++detailRevision.current;
    try {
      const detail = parsePluginManagementDetail(
        await invoke('market-detail', { pluginId: item.pluginId }),
      );
      if (writable() && revision === detailRevision.current) {
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
  const notice = (
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
  const availableMarket =
    snapshot?.market.items.filter(
      (i) => !snapshot.ghosts.some((g) => marketItemMatchesInstalledGhost(i, g)),
    ) ?? [];
  const marketOrigins = ['all', ...new Set(availableMarket.map(pluginPresentationOrigin))];
  const effectiveOriginFilter = marketOrigins.includes(originFilter) ? originFilter : 'all';
  const pageHeading = (
    <header className="mb-8" data-catalog-region="heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-28 font-medium leading-tight text-[var(--text-primary)]">
          {t('settings.ghosts.title')}
        </h1>
        <CatalogTargetControls
          computer={
            deviceControl ?? {
              selected: device,
              onSelect: () => {},
              directory: { candidates: [], target: undefined, online, relayOnline: online },
            }
          }
          projectLabel={project?.name}
          project={
            <PluginProjectMenu
              scopeDir={project?.id ?? null}
              activeSessionWorkingDir={undefined}
              recentWorkdirs={[]}
              computerName={device.name}
              projectOptions={snapshot?.projects ?? []}
              onBrowse={snapshot?.projectBrowse ? () => setProjectPickerOpen(true) : undefined}
              disabled={!online || !snapshot || !snapshot.projects || !!operation.current}
              unavailable={unsupported || (!!snapshot && !snapshot.projects)}
              onPick={pickProject}
            />
          }
        />
      </div>
      <p className="mt-2 text-14 leading-6 text-[var(--text-secondary)]">
        {t('settings.ghosts.description')}
      </p>
    </header>
  );
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--surface)]">
      {projectPickerOpen ? (
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
      ) : null}
      {(ghost || marketDetail) && (targetProblem || projectReadStatus) ? notice : null}
      <div className="min-h-0 flex-1">
        {unsupported && legacySelected ? (
          <RemotePluginReadOnlyDetail
            detail={legacyDetail?.id === legacySelected.id ? legacyDetail : legacySelected}
            notice={notice}
            loading={online && legacyDetailStatus === 'loading'}
            failed={legacyDetailStatus === 'failed'}
            online={online}
            onBack={() => {
              ++detailRevision.current;
              setLegacySelected(null);
              setLegacyDetail(null);
              setLegacyDetailStatus(null);
            }}
            onRetry={() => void loadLegacyDetail(legacySelected)}
          />
        ) : ghost ? (
          <GhostPluginDetailView
            remote
            remoteConfiguration={configuration}
            ghost={effectiveGhost(ghost)}
            marketItem={snapshot?.market.items.find((item) =>
              marketItemMatchesInstalledGhost(item, ghost),
            )}
            detail={toGhostPluginDetail(effectiveGhost(ghost))}
            panelStatus={null}
            onBack={() => setSelected(null)}
            onToggle={(enabled) => {
              void begin(enabled ? 'enable' : 'disable', ghost);
            }}
            toggleDisabled={busy || !projectReady || (!!project && !ghost.enabled)}
            onUse={() => {}}
            updateBusy={busy}
            updateVersion={update?.version}
            onUpdate={() => {
              if (update) void install(update);
            }}
            onUpdateFromFile={() => {
              void installFile(ghost);
            }}
            remoteFileUpdate={ghost.namespace === null && !ghost.builtin}
            onUninstall={() => {
              void uninstall(ghost);
            }}
          />
        ) : marketDetail ? (
          <MarketPluginDetailView
            detail={marketDetail}
            busy={busy}
            onBack={() => setMarketDetail(null)}
            onInstall={
              marketDetail.installState === 'conflict'
                ? undefined
                : () => {
                    void install(marketDetail);
                  }
            }
            onIconLoadError={() => {}}
          />
        ) : (
          <PluginManagementLayout
            activeTab="plugins"
            embedded={embedded}
            onSelectTab={onSelectCatalogTab}
            query={query}
            onQueryChange={setQuery}
            headerActions={
              unsupported ? undefined : (
                <GhostPluginActions
                  disabled={busy}
                  installTarget={device.name}
                  onInstall={() => void installFile()}
                />
              )
            }
          >
            <div className="min-h-0 flex-1 overflow-y-auto">
              <PluginManagementPage>
                {pageHeading}
                <section>
                  <InstalledCatalogHeader
                    title={t('settings.ghosts.page.installedSection')}
                    count={
                      unsupported
                        ? legacy
                          ? filteredLegacy.length
                          : undefined
                        : filteredGhosts?.length
                    }
                  />
                  {notice}
                  <div className={PLUGIN_INSTALLED_CARD_GRID_CLASS}>
                    {unsupported
                      ? filteredLegacy.map((item) => (
                          <GhostPluginCard
                            key={item.id}
                            readOnly
                            item={item}
                            showLocalUnread={false}
                            onManage={() => {
                              setLegacyDetail(null);
                              setLegacyDetailStatus('loading');
                              setLegacySelected(item);
                            }}
                            onPrimary={() => {
                              setLegacyDetail(null);
                              setLegacyDetailStatus('loading');
                              setLegacySelected(item);
                            }}
                          />
                        ))
                      : (!project || projectState?.projectId === project.id
                          ? (filteredGhosts ?? [])
                          : []
                        )
                          .map((g) => {
                            const item = {
                              ...toGhostPluginListItem(effectiveGhost(g)),
                              canUse: false,
                              tabPanel: false,
                            };
                            const market = snapshot?.market.items.find(
                              (i) =>
                                marketItemMatchesInstalledGhost(i, g) &&
                                i.installState === 'update-available',
                            );
                            return (
                              <GhostPluginCard
                                key={installedGhostStoragePart(g)}
                                item={item}
                                author={g.manifest.author}
                                marketItem={snapshot?.market.items.find((entry) =>
                                  marketItemMatchesInstalledGhost(entry, g),
                                )}
                                showLocalUnread={false}
                                sourceLabel={
                                  g.namespace ?? t('settings.ghosts.remote.personalInstall')
                                }
                                onManage={() => {
                                  ++detailRevision.current;
                                  setSelected(installedGhostStoragePart(g));
                                }}
                                onPrimary={() => setSelected(installedGhostStoragePart(g))}
                                updateBusy={busy}
                                updateVersion={market?.version}
                                onUpdate={
                                  market
                                    ? () => {
                                        void install(market);
                                      }
                                    : undefined
                                }
                              />
                            );
                          })}
                  </div>
                  {(unsupported ? legacy?.length === 0 : snapshot && !snapshot.ghosts.length) ? (
                    <p className="text-13 leading-5 text-[var(--text-tertiary)]">
                      {t('settings.ghosts.remote.empty')}
                    </p>
                  ) : null}
                </section>
                {!unsupported ? (
                  <section className="mt-8">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
                      <h2 className="text-20 font-medium leading-6 text-[var(--text-primary)]">
                        {t('settings.ghosts.page.recommendedSection')}
                      </h2>
                      <SegmentedControl
                        role="radiogroup"
                        aria-label={t('settings.ghosts.page.filtersAria')}
                        value={effectiveOriginFilter}
                        onValueChange={setOriginFilter}
                        height={32}
                        optionHeight={28}
                        optionClassName="px-3.5 text-12"
                        options={marketOrigins.map((filter) => ({
                          value: filter,
                          label:
                            filter === 'all'
                              ? t('settings.ghosts.page.filterAll')
                              : t('settings.ghosts.page.origin.' + filter),
                        }))}
                      />
                    </div>
                    <p className="mb-4 text-12 leading-5 text-[var(--text-tertiary)]">
                      {t('settings.ghosts.remote.installDestination', { device: device.name })}
                    </p>
                    {snapshot?.market.unavailableReason ? (
                      <p className="mb-3 text-13 leading-5 text-[var(--text-tertiary)]">
                        {t('settings.ghosts.remote.marketUnavailable')}
                      </p>
                    ) : null}
                    <div className={PLUGIN_MANAGEMENT_CARD_GRID_CLASS}>
                      {availableMarket
                        .filter(
                          (i) =>
                            effectiveOriginFilter === 'all' ||
                            pluginPresentationOrigin(i) === effectiveOriginFilter,
                        )
                        .filter((i) =>
                          `${i.name} ${i.description ?? ''}`
                            .toLocaleLowerCase()
                            .includes(normalizedQuery),
                        )
                        .map((item) => (
                          <MarketPluginCard
                            key={item.pluginId}
                            item={item}
                            busy={busy}
                            onSelect={() => {
                              void selectMarket(item);
                            }}
                            onInstall={
                              item.installState === 'conflict'
                                ? undefined
                                : () => {
                                    void install(item);
                                  }
                            }
                            onIconLoadError={() => {}}
                          />
                        ))}
                    </div>
                  </section>
                ) : null}
              </PluginManagementPage>
            </div>
          </PluginManagementLayout>
        )}
      </div>
    </div>
  );
}
