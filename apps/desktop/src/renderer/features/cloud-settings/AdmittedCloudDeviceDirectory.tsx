import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  ArrowUpCircle,
  Clock3,
  Cloud,
  ExternalLink,
  Moon,
  Plus,
  Settings,
  SlidersHorizontal,
  Sun,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import type { MyDevicesCloudSlot } from '@/components/settings/MyDevicesPanel';
import { SETTINGS_HINT, SETTINGS_ROW_LABEL_CLASS } from '@/components/ui/settings-rows';
import type { CloudInstanceView, CloudMaintenanceView } from '../../../shared/cloudInstanceControl';
import type { CloudInstanceFeed } from './CloudInstanceSection';
import { CloudMaintenanceDialog } from './CloudMaintenanceDialog';
import { remoteControlReturnPath } from './cloudInstancesLink';
import {
  canChangeInstancePower,
  instanceStatus,
  instanceUpgrading,
  upgradeOutcome,
} from './instanceState';
import { byShownName, cloudBaseName, cloudDisplayName } from './instanceName';
import { BlockReadFailure, InlineRetry, useBlockRetry } from './blockRetry';
import {
  useCloudInstances,
  type CloudInstancesApi,
  type PowerNote,
  type PowerPending,
} from './useCloudInstances';
import { isCloudDeviceId } from './cloudDeviceId';
import { cloudInstancesApi } from './cloudBridge';
import type { CloudSettingsRendererApi } from '../../../shared/cloudSettingsClient';


type Translate = (key: string, values?: Record<string, string | number>) => string;

const muted = 'text-11 leading-[1.5] text-[var(--text-tertiary)]';
// Standard settings rows (DESIGN.md "Desktop settings rows"). The device card already has the
// row's 16px side padding, so rows and dividers run the width of its content.
// A settings row without side padding: the dialog's own padding lines it up.
const row = 'flex items-center justify-between gap-3 py-4';

function RowText({ label, hint }: { label: string; hint: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className={SETTINGS_ROW_LABEL_CLASS}>{label}</span>
      {hint && <span className={SETTINGS_HINT}>{hint}</span>}
    </span>
  );
}

// From confirming sleep or clicking wake until CIS lists the request, the card shows it under way
// at once, also while an unknown result is read back. Once those reads run out, it shows CIS's
// last state with a notice instead.
const requestedState = (view: CloudInstanceView, pending: PowerPending | undefined) =>
  pending?.deviceId === view.deviceId &&
  view.desiredState !== (pending.action === 'wake' ? 'running' : 'stopped')
    ? pending.action === 'wake'
      ? 'starting'
      : 'stopping'
    : undefined;

/**
 * An update scheduled behind the running tasks (phase requested): the instance is still usable, so
 * the card keeps its lifecycle state (green dot, 「运行中」); only the Updates item says so.
 */
const upgradeQueued = (view: CloudInstanceView, linkOffline: boolean) =>
  upgradeOutcome(view, linkOffline)?.kind === 'queued';
/** The lifecycle state without the upgrade record (what a scheduled update leaves as it is). */
const lifecycleStatus = (view: CloudInstanceView) =>
  instanceStatus({ ...view, upgradeOperation: null, upgradeState: 'idle' });

// The lifecycle state the card shows: CIS's, except while an upgrade has the runtime down.
const cardStatus = (view: CloudInstanceView, linkOffline: boolean, pending?: PowerPending) =>
  requestedState(view, pending) ??
  (upgradeQueued(view, linkOffline)
    ? lifecycleStatus(view)
    : instanceUpgrading(view, linkOffline)
      ? 'upgrading'
      : instanceStatus(view));

// The subtitle carries the lifecycle state; while an upgrade runs, how far it has got instead.
const instanceStatusText = (
  view: CloudInstanceView,
  linkOffline: boolean,
  t: Translate,
  pending?: PowerPending,
) => {
  const requested = requestedState(view, pending);
  if (requested) return t(`cloudSettings.instance.state.${requested}`);
  if (view.loginRequired)
    return t(
      `cloudSettings.onboarding.${view.desiredState === 'stopped' ? 'asleepNeedsLogin' : 'needsLogin'}`,
    );
  const state = cardStatus(view, linkOffline);
  // Updating, also while it restarts and DeviceLink does not have it: the same words.
  if (state === 'upgrading') return t('cloudSettings.instance.cardUpdating');
  return t(`cloudSettings.instance.state.${state}`);
};
/**
 * The card's dot: ready, updating (progress), or neither (grey), only as the subtitle says
 * (MyDevicesPanel). A failed update is said on the Updates mark and in its dialog.
 */
const cardDot = (view: CloudInstanceView, linkOffline: boolean, pending?: PowerPending) => {
  const state = cardStatus(view, linkOffline, pending);
  return {
    live: state === 'running' && !view.loginRequired,
    // Updating shows its progress dot also while it restarts, never a grey dot.
    progress: state === 'upgrading',
  };
};

/**
 * The admitted account's cloud instance operations on Settings → Remote connections → My
 * devices. CloudDeviceDirectory loads this module only once the account is admitted.
 */
export function AdmittedCloudDeviceDirectory({
  directory,
  names,
  offline,
  devicesOpen,
  children,
}: {
  directory: readonly string[] | null;
  names?: ReadonlyMap<string, string>;
  offline: readonly string[];
  devicesOpen: boolean;
  children(cloud: MyDevicesCloudSlot): ReactNode;
}) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const api = useMemo<CloudInstancesApi & Pick<CloudSettingsRendererApi, 'instanceRead'>>(
    cloudInstancesApi,
    [],
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const openSettings = useCallback(
    (deviceId: string) =>
      navigate(`/cloud-settings?${new URLSearchParams({ deviceId })}`, {
        state: { returnTo: remoteControlReturnPath(devicesOpen) },
      }),
    [devicesOpen, navigate],
  );
  const cloud = useCloudInstances(api, openSettings);
  // A failed list read is tried again at once, after 2 s and after 5 s before the card says so.
  const listRetry = useBlockRetry({
    failed: cloud.error === 'readFailed',
    failures: cloud.failures,
    retry: () => void cloud.load(),
  });
  /**
   * The instance's status could not be read (the device list itself did load): the card keeps its
   * last-known info with a grey dot and 「状态加载失败」 in place of the state, no button in the meta
   * line, as the local per-device quota (GroupMemberQuota.tsx). The list keeps polling, and its
   * 「刷新」 reads the instances too.
   */
  const statusUnreadable = cloud.error === 'readFailed' && listRetry.exhausted;
  // What the list's 「刷新」 does, also beside each 「请重试」; also the instance limit.
  // While that read runs, the retry beside the failure spins, as the list's 「刷新」 does.
  const [listReading, setListReading] = useState(false);
  const [powerRetrying, setPowerRetrying] = useState<string | null>(null);
  const rereadList = () => {
    if (listReading) return;
    setListReading(true);
    void cloud.load(true).finally(() => {
      if (mounted.current) setListReading(false);
    });
  };
  const statusRetry = (
    <InlineRetry onRetry={rereadList} disabled={cloud.busy} loading={listReading} />
  );
  // The list, or a sleep or wake's read-back, could not be read for this instance.
  const unreadableFor = (view: CloudInstanceView) =>
    statusUnreadable || cloud.powerNote(view.deviceId)?.kind === 'unreadable';
  // One updates dialog for the list; it returns focus to whichever control opened it.
  const [maintenanceFor, setMaintenanceFor] = useState<string | null>(null);
  const maintenanceOpener = useRef<HTMLElement | null>(null);
  const openMaintenance = useCallback((deviceId: string, opener: HTMLElement | null) => {
    maintenanceOpener.current = opener;
    setMaintenanceFor(deviceId);
  }, []);
  // The list carries no maintenance policy; CIS serves it per instance. Read it only when the
  // maintenance dialog opens (and after its explicit refresh), never on the list's polling timer.
  const [policies, setPolicies] = useState<ReadonlyMap<string, CloudMaintenanceView | null>>(
    new Map(),
  );
  const storePolicy = useCallback((deviceId: string, policy: CloudMaintenanceView | null) => {
    if (mounted.current) setPolicies((before) => new Map(before).set(deviceId, policy));
  }, []);
  const readPolicy = useCallback(
    async (deviceId: string) => {
      storePolicy(deviceId, (await api.instanceRead({ deviceId })).maintenance);
    },
    [api, storePolicy],
  );
  const live = useMemo(
    () =>
      (cloud.instances ?? [])
        .filter((view) => view.desiredState !== 'deleted')
        .map((view) => ({ ...view, maintenance: policies.get(view.deviceId) ?? null })),
    [cloud.instances, policies],
  );
  const byDevice = new Map(live.map((view) => [view.deviceId, view]));
  // A cloud Cindy's own name: the device list's (what its card shows and its rename changes),
  // CIS's where the list has none yet.
  const baseName = (view: CloudInstanceView, listedName?: string) =>
    cloudBaseName(t, view.deviceId, names?.get(view.deviceId) ?? listedName, view);
  // Every listed device by its own name, plus the cloud Cindys not listed yet: two with the same
  // name get the client's usual 「(1)」「(2)」, as in the sidebar and the device pickers.
  const nameSources = [
    ...[...(names ?? new Map<string, string>())].map(([deviceId, listed]) => {
      const view = byDevice.get(deviceId);
      return { deviceId, name: view ? baseName(view, listed) : listed };
    }),
    ...live
      .filter((view) => !names?.has(view.deviceId))
      .map((view) => ({ deviceId: view.deviceId, name: baseName(view) })),
  ];
  // One name per cloud Cindy, the same on its card, in its menu, dialogs and toasts.
  const name = (view: CloudInstanceView, listedName?: string) =>
    cloudDisplayName(view.deviceId, baseName(view, listedName), nameSources);
  // Cards in name order, so 「(1)」 comes before 「(2)」 whichever the list or CIS gives first.
  const shownPlace = new Map(
    [...live]
      .sort((a, b) => byShownName(name(a), name(b)))
      .map((view, index) => [view.deviceId, index] as const),
  );
  // DeviceLink does not have the runtime: offline in the directory, or not listed there at all.
  const linkOffline = (deviceId: string) =>
    offline.includes(deviceId) || (directory !== null && !directory.includes(deviceId));
  // Once the read-backs of a sleep or wake ran out, the card shows CIS's last state and says so.
  const shownPending = (deviceId: string) =>
    cloud.powerNote(deviceId)?.kind === 'unreadable' ? undefined : cloud.powerPending(deviceId);
  // An update this page saw under way that ends while its dialog is closed is said once.
  // Not started is said only in the dialog, where it was asked for.
  const underWay = useRef(new Set<string>());
  const announceEnded = (view: CloudInstanceView, ended: string | undefined) => {
    const shown = name(view);
    if (ended === 'done')
      toast.success(
        t('cloudSettings.instance.toastUpgraded', {
          name: shown,
          version: view.version ?? view.latestVersion ?? '',
        }),
        { duration: 5000 },
      );
    else if (ended === 'failed')
      toast.error(t('cloudSettings.instance.toastUpgradeFailed', { name: shown }), {
        action: {
          label: t('cloudSettings.instance.viewUpdate'),
          onClick: () => setMaintenanceFor(view.deviceId),
        },
      });
  };
  const openDialog = useRef(maintenanceFor);
  openDialog.current = maintenanceFor;
  useEffect(() => {
    for (const view of live) {
      const outcome = upgradeOutcome(view, linkOffline(view.deviceId));
      if (outcome?.kind === 'queued' || outcome?.kind === 'updating') {
        underWay.current.add(view.deviceId);
        continue;
      }
      if (!underWay.current.delete(view.deviceId) || openDialog.current === view.deviceId) continue;
      announceEnded(view, outcome?.kind);
    }
  }, [live, offline, directory]);
  const actionsOf = (view: CloudInstanceView, displayName: string): InstanceActionHandlers => ({
    model: instanceActions(view, linkOffline(view.deviceId), {
      busy: cloud.busy,
      listError: !!cloud.error,
      pending: cloud.powerPending(view.deviceId),
      note: cloud.powerNote(view.deviceId),
    }),
    onOpenSettings: () => openSettings(view.deviceId),
    onOpenMaintenance: (opener) => openMaintenance(view.deviceId, opener),
    onPower: () => void cloud.power(view, displayName),
    onReloadPower: () => void cloud.reloadPower(view.deviceId),
    // 「休眠失败 / 唤醒失败，请重试」: the same request again, without a second confirmation.
    retryingPower: powerRetrying === view.deviceId,
    onRetryPower: () => {
      if (powerRetrying) return;
      setPowerRetrying(view.deviceId);
      void cloud.power(view, displayName, { confirmed: true }).finally(() => {
        if (mounted.current) setPowerRetrying(null);
      });
    },
  });
  const headerActions = (view: CloudInstanceView, displayName: string) => (
    <CloudHeaderActions deviceId={view.deviceId} {...actionsOf(view, displayName)} />
  );
  // Focus returns to the control that opened the dialog, or, if that control is gone since (the
  // card re-rendered), to the one that opens it now.
  const openerOf = (deviceId: string): RefObject<HTMLElement | null> => ({
    get current() {
      const opener = maintenanceOpener.current;
      return opener?.isConnected
        ? opener
        : document.querySelector<HTMLElement>(`[data-cloud-updates-opener="${deviceId}"]`);
    },
  });
  const controls = (view: CloudInstanceView, displayName: string) => (
    <CloudInstanceControls
      key={view.instanceId}
      view={view}
      name={displayName}
      {...actionsOf(view, displayName)}
      reload={async () => {
        await Promise.all([readPolicy(view.deviceId), cloud.load()]);
      }}
      onPolicySaved={(policy) => storePolicy(view.deviceId, policy)}
      onHurry={() => cloud.hurry()}
      busy={cloud.busy}
      listError={!!cloud.error}
      waiting={cloud.waiting === view.deviceId}
      onLogin={() => void cloud.act(false, view.deviceId)}
      maintenanceOpen={maintenanceFor === view.deviceId}
      onMaintenanceOpenChange={(open) => setMaintenanceFor(open ? view.deviceId : null)}
      opener={openerOf(view.deviceId)}
    />
  );
  return (
    <>
      {children({
        isManaged: (deviceId) =>
          isCloudDeviceId(deviceId) && (cloud.instances === null || byDevice.has(deviceId)),
        remoteDesktopReady: (deviceId) => {
          const view = byDevice.get(deviceId);
          return (
            !view ||
            (cardStatus(view, linkOffline(deviceId), shownPending(deviceId)) === 'running' &&
              !view.loginRequired)
          );
        },
        status: (deviceId) => {
          // Until the list answers, the state is being read, not the directory's online
          // state (the local version row's pending status: a spinner and what it is reading).
          if (cloud.instances === null && isCloudDeviceId(deviceId))
            return statusUnreadable
              ? { label: t('cloudSettings.instance.statusUnreadable'), live: false, action: statusRetry }
              : { label: t('cloudSettings.instance.statusLoading'), live: false, pending: true };
          const view = byDevice.get(deviceId);
          if (!view) return null;
          // One neutral line in the state's own place; 「刷新」 reads it again.
          if (unreadableFor(view))
            return { label: t('cloudSettings.instance.statusUnreadable'), live: false, action: statusRetry };
          // DeviceLink does not have a running instance, and no update explains it: the
          // directory's own offline state (grey dot, last seen), as for any other device.
          if (
            linkOffline(deviceId) &&
            !view.loginRequired &&
            cardStatus(view, true, shownPending(deviceId)) === 'running'
          )
            return null;
          return {
            label: instanceStatusText(view, linkOffline(deviceId), t, shownPending(deviceId)),
            ...cardDot(view, linkOffline(deviceId), shownPending(deviceId)),
          };
        },
        displayName: (device) => {
          const view = byDevice.get(device.deviceId);
          return view ? name(view, device.name) : null;
        },
        baseName: (device) => {
          const view = byDevice.get(device.deviceId);
          return view ? baseName(view, device.name) : null;
        },
        // CIS-only rows sit among the directory's cards in name order; the claim rows last.
        order: (deviceId) => shownPlace.get(deviceId) ?? Number.MAX_SAFE_INTEGER,
        extras: (device) => {
          const view = byDevice.get(device.deviceId);
          return view ? controls(view, name(view, device.name)) : null;
        },
        headerActions: (device: { deviceId: string; name: string }) => {
          const view = byDevice.get(device.deviceId);
          return view ? headerActions(view, name(view, device.name)) : null;
        },
        // CIS instances the device directory does not list (login pending, never started,
        // relay unreachable) still get a row, after the directory's own devices.
        extraRows: [
          ...live
            .filter((view) => directory !== null && !directory.includes(view.deviceId))
            .map((view) => ({
              deviceId: view.deviceId,
              // Same card as a directory device: header, then the instance rows.
              node: (
                <>
                  <div className="flex items-center gap-3">
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        !unreadableFor(view) && cardDot(view, true, shownPending(view.deviceId)).live
                          ? 'bg-[var(--remote-status-ready)]'
                          : 'bg-[var(--remote-status-disconnected)]'
                      }`}
                      aria-hidden
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-13 font-medium text-[var(--text-primary)]">
                        {name(view)}
                      </span>
                      <span className="flex flex-wrap items-center gap-x-1">
                        <span className="break-words text-11 text-[var(--text-tertiary)]">
                          {[
                            view.version && `Linux · Cindy ${view.version}`,
                            unreadableFor(view)
                              ? t('cloudSettings.instance.statusUnreadable')
                              : instanceStatusText(view, true, t, shownPending(view.deviceId)),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                        {unreadableFor(view) && statusRetry}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {headerActions(view, name(view))}
                    </div>
                  </div>
                  {controls(view, name(view))}
                </>
              ),
            })),
          ...(cloud.instances !== null && !live.length
            ? [
                {
                  deviceId: 'cloud-claim',
                  node: (
                    <div className="flex flex-col gap-2">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
                          <span className="text-13 font-medium text-[var(--text-primary)]">
                            {t('cloudSettings.onboarding.emptyTitle')}
                          </span>
                          {/* While claiming and while an unknown claim is read back, only the button
                              spins; the description changes only for what was found. */}
                          {/* A failure in a card is an 11px red line, as MyDevicesPanel's connectionIssue. */}
                          <span
                            className={
                              cloud.claim === 'notClaimed'
                                ? 'text-11 leading-[1.5] text-[var(--error-fg)]'
                                : muted
                            }
                            role={cloud.claim ? 'status' : undefined}
                          >
                            {t(
                              `cloudSettings.onboarding.${
                                cloud.claim === 'notClaimed' ? 'claimNotDone' : 'emptyDescription'
                              }`,
                            )}
                          </span>
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-2">
                          <Button
                            size="sm"
                            loading={cloud.busy || cloud.claim === 'checking'}
                            disabled={cloud.claim === 'unreadable' || !!cloud.error}
                            onClick={() => void cloud.act(true)}
                          >
                            <Cloud size={14} />
                            {t('cloudSettings.onboarding.claim')}
                          </Button>
                        </div>
                      </div>
                      {cloud.claim === 'unreadable' && (
                        <BlockReadFailure
                          bare
                          title={t('cloudSettings.onboarding.claimUnreadable')}
                          disabled={cloud.busy}
                          onReload={() => void cloud.reloadClaim()}
                        />
                      )}
                    </div>
                  ),
                },
              ]
            : []),
          // Below the owner's limit another instance can be claimed, after the cards it adds to. An
          // owner allowed several who has them all sees the count and why there is no button.
          ...(live.length &&
          cloud.capacity &&
          (cloud.capacity.used < cloud.capacity.limit || cloud.capacity.limit > 1)
            ? [
                {
                  deviceId: 'cloud-claim-another',
                  node: (
                    <div className="flex flex-col gap-2">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
                          <span className="text-13 font-medium tabular-nums text-[var(--text-primary)]">
                            {t('cloudSettings.onboarding.capacity', {
                              used: cloud.capacity.used,
                              limit: cloud.capacity.limit,
                            })}
                          </span>
                          <span
                            className={
                              cloud.claim === 'notClaimed'
                                ? 'text-11 leading-[1.5] text-[var(--error-fg)]'
                                : muted
                            }
                            role={cloud.claim ? 'status' : undefined}
                          >
                            {cloud.claim === 'notClaimed'
                              ? t('cloudSettings.onboarding.claimNotDone')
                              : cloud.capacity.used < cloud.capacity.limit
                                ? t('cloudSettings.onboarding.capacityRemaining', {
                                    n: cloud.capacity.limit - cloud.capacity.used,
                                  })
                                : t('cloudSettings.onboarding.capacityFull')}
                          </span>
                        </div>
                        {cloud.capacity.used < cloud.capacity.limit && (
                          <Button
                            variant="secondary"
                            size="sm"
                            loading={cloud.busy || cloud.claim === 'checking'}
                            disabled={cloud.claim === 'unreadable' || !!cloud.error}
                            onClick={() => void cloud.claimAnother()}
                          >
                            <Plus size={14} />
                            {t('cloudSettings.onboarding.claimAnother')}
                          </Button>
                        )}
                      </div>
                      {cloud.claim === 'unreadable' && (
                        <BlockReadFailure
                          bare
                          title={t('cloudSettings.onboarding.claimUnreadable')}
                          disabled={cloud.busy}
                          onReload={() => void cloud.reloadClaim()}
                        />
                      )}
                    </div>
                  ),
                },
              ]
            : []),
        ],
        // A list that failed to read is said on the card (statusUnreadable); with no card, in the
        // device list's own error line.
        notice:
          cloud.error && cloud.error !== 'readFailed'
            ? t(cloud.error.startsWith('cloudSettings.') ? cloud.error : `cloudSettings.onboarding.${cloud.error}`)
            : null,
        // A line with room: the text and a small 「重试」, as the client's read-failure notices.
        listError:
          statusUnreadable && !live.length ? (
            <span className="inline-flex flex-wrap items-center justify-center gap-2">
              {t('cloudSettings.onboarding.readFailed')}
              <Button
                variant="secondary"
                size="sm"
                compact
                disabled={cloud.busy}
                loading={listReading}
                onClick={rereadList}
              >
                {t('commonUi.retry')}
              </Button>
            </span>
          ) : null,
        refresh: rereadList,
      })}
    </>
  );
}

/** What the card's actions show and allow, the same whichever layout presents them. */
function instanceActions(
  view: CloudInstanceView,
  /** DeviceLink does not have the instance (an update restarts it). */
  linkOffline: boolean,
  list: {
    busy: boolean;
    listError: boolean;
    pending?: PowerPending;
    note?: PowerNote;
  },
) {
  // An upgrade has the runtime down, whatever CIS's last observation says (instanceUpgrading).
  const upgrading = instanceUpgrading(view, linkOffline);
  const outcome = upgradeOutcome(view, linkOffline);
  // Scheduled behind the running tasks: still usable, as before the request.
  const queued = outcome?.kind === 'queued';
  const state = queued ? lifecycleStatus(view) : upgrading ? 'upgrading' : instanceStatus(view);
  const running = state === 'running';
  const asleep = view.desiredState === 'stopped';
  const loginWake = !!(view.loginRequired && asleep && view.loginWakeSupported);
  return {
    upgrading: state === 'upgrading',
    queued,
    running,
    asleep,
    loginWake,
    /**
     * The user's own sleep or wake is under way, its read-back included: only this spins the power
     * item. A start or stop CIS reports on its own only disables it.
     */
    powerRequested: !!list.pending && list.note?.kind !== 'unreadable',
    /** Sleeping and then waking restarts a runtime in error; power is allowed there. */
    recoveryHint: state === 'error' && !view.loginRequired,
    // A runtime waiting for sign-in stays 'starting' indefinitely: nothing to spin for.
    changing:
      (!!list.pending && list.note?.kind !== 'unreadable') ||
      (!view.loginRequired && ['starting', 'stopping', 'upgrading'].includes(state)),
    updateAvailable: view.updateAvailable && !view.upgradeOperation?.active,
    /** The Updates item's mark: an update to take, one under way, or one that failed. */
    updateMark: queued
      ? 'badgeScheduled'
      : upgrading
      ? 'badgeUpdating'
      : outcome?.kind === 'failed'
        ? 'upgradeFailed'
        : view.updateAvailable && !view.upgradeOperation?.active
          ? 'updateBadge'
          : null,
    linkOffline,
    /** Settings and updates; a runtime waiting for sign-in offers neither. */
    showInstance: !view.loginRequired,
    /** Sleep or wake; signing in already wakes an asleep instance that supports it. */
    showPower: !loginWake,
    /** Why sleep or wake waits: an update scheduled or running, as settingsReasonKey says. */
    powerReasonKey:
      queued || upgrading ? (asleep ? 'wakeAfterUpdate' : 'sleepAfterUpdate') : null,
    settingsReasonKey:
      view.loginRequired || running
        ? null
        : state === 'upgrading'
          ? 'settingsUpgrading'
          : state === 'asleep'
            ? 'settingsWakeFirst'
            : 'settingsNotRunning',
    // Only this instance's own sleep or wake holds it (changing); another's never does.
    powerDisabled:
      list.busy ||
      list.listError ||
      upgrading ||
      !canChangeInstancePower(view),
    /** What an unknown sleep or wake turned out to be, or that it could not be read. */
    note: list.note,
  };
}
type InstanceActions = ReturnType<typeof instanceActions>;
type InstanceActionHandlers = {
  model: InstanceActions;
  onOpenSettings(): void;
  onOpenMaintenance(opener: HTMLElement | null): void;
  onPower(): void;
  onReloadPower(): void;
  onRetryPower(): void;
  retryingPower: boolean;
};

// The header row's remote desktop glyph (MyDevicesPanel.tsx: 16px, --text-primary, round hover),
// in a 32px box (DESIGN.md desktop icon buttons), with aria-disabled so a disabled action still
// shows why in its tooltip.
const headerIcon =
  'relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--text-primary)] hover:bg-[var(--surface-chip)] aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent';
// The menu entry: 26 × 44, a 26px hover circle, also while its menu is open.
const menuEntry =
  'relative inline-flex h-11 w-[26px] shrink-0 items-center justify-center text-[var(--text-primary)] before:pointer-events-none before:absolute before:left-1/2 before:top-1/2 before:h-[26px] before:w-[26px] before:-translate-x-1/2 before:-translate-y-1/2 before:rounded-full before:content-[""] hover:before:bg-[var(--surface-chip)] aria-expanded:before:bg-[var(--surface-chip)]';
// "Update available" on the glyph's top right: the client's one registered button-corner reminder
// dot (FilterReminderDot, features/cc-agent/sidebar: size-1.5, --status-bar-accent). Its own
// corner offset sits on the 16px glyph itself here, so the dot is placed as before.
const glyph = (icon: ReactNode, marked = false) => (
  <span className="relative inline-flex">
    {icon}
    {marked && (
      <span
        aria-hidden
        className="absolute -right-[3px] -top-[3px] size-1.5 rounded-full bg-[var(--status-bar-accent)]"
      />
    )}
  </span>
);

const HeaderIcon = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; reason?: string | null; inactive?: boolean }
>(function HeaderIcon({ label, reason, inactive, onClick, children, ...rest }, ref) {
  const reasonId = useId();
  return (
    <Tip text={reason ? `${label} · ${reason}` : label}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-disabled={inactive || undefined}
        aria-describedby={reason ? reasonId : undefined}
        className={headerIcon}
        onClick={(event) => {
          if (!inactive) onClick?.(event);
        }}
        {...rest}
      >
        {children}
        {reason && (
          <span id={reasonId} className="sr-only">
            {reason}
          </span>
        )}
      </button>
    </Tip>
  );
});

/**
 * The card's actions: one "⋯" menu in the header row, before remote desktop. The card shows by
 * default, with this menu.
 */
function CloudHeaderActions({
  deviceId,
  model,
  onOpenSettings,
  onOpenMaintenance,
  onPower,
}: InstanceActionHandlers & { deviceId: string }) {
  const { t } = useTranslation();
  const trInstance = (key: string) => t(`cloudSettings.instance.${key}`);
  const settingsReason = model.settingsReasonKey && trInstance(model.settingsReasonKey);
  const powerReason = model.powerReasonKey && trInstance(model.powerReasonKey);
  const powerLabel = trInstance(model.asleep ? 'wake' : 'sleep');
  const PowerIcon = model.asleep ? Sun : Moon;
  const menuButton = useRef<HTMLButtonElement>(null);
  // The updates dialog takes focus as the menu closes; the menu must not take it back.
  const dialogOpening = useRef(false);
  // The user's own sleep or wake in progress; an upgrade spins on Updates instead.
  const powerChanging = model.powerRequested;
  const manage = trInstance('manage');
  // Never a spinner: what is in progress spins on its own item, inside.
  return (
    <span data-cloud-header-actions="menu" className="inline-flex shrink-0 items-center">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <HeaderIcon
            ref={menuButton}
            className={menuEntry}
            data-cloud-updates-opener={deviceId}
            // Just 「管理」, as its sibling 「远程桌面」: the dot is decoration and the menu's
            // 「更新」 row says the state (FilterReminderDot).
            label={manage}
          >
            {glyph(<SlidersHorizontal size={16} className="relative" />, model.updateAvailable)}
          </HeaderIcon>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(event) => {
            if (dialogOpening.current) event.preventDefault();
            dialogOpening.current = false;
          }}
        >
          {model.showInstance && (
            <>
              <DropdownMenuItem disabled={!model.running} onSelect={onOpenSettings}>
                <Settings size={14} className="mr-2.5 shrink-0" aria-hidden />
                <span className="flex min-w-0 flex-col">
                  {t('cloudSettings.onboarding.openSettings')}
                  {settingsReason && <span className={muted}>{settingsReason}</span>}
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  dialogOpening.current = true;
                  onOpenMaintenance(menuButton.current);
                }}
              >
                {model.upgrading ? (
                  <Spinner size={14} className="mr-2.5 shrink-0" />
                ) : model.queued ? (
                  // Scheduled: the clock the dialog's status row uses.
                  <Clock3 size={14} className="mr-2.5 shrink-0" aria-hidden />
                ) : (
                  <ArrowUpCircle size={14} className="mr-2.5 shrink-0" aria-hidden />
                )}
                {trInstance('updates')}
                {model.updateMark && (
                  // The mark's text stays neutral, as the client's version row status (HarnessVersionMenuRow)
                  // and its rule that semantic colour goes on an icon only (DESIGN.md: Toast, ErrorNotice).
                  // The trigger's dot is the one coloured element.
                  <span className="ml-auto pl-3 text-12 text-[var(--text-secondary)]">
                    {trInstance(model.updateMark)}
                  </span>
                )}
              </DropdownMenuItem>
            </>
          )}
          {model.showPower && (
            <DropdownMenuItem disabled={model.powerDisabled || model.changing} onSelect={onPower}>
              {powerChanging ? (
                <Spinner size={14} className="mr-2.5 shrink-0" />
              ) : (
                <PowerIcon size={14} className="mr-2.5 shrink-0" aria-hidden />
              )}
              <span className="flex min-w-0 flex-col">
                {powerLabel}
                {powerReason && <span className={muted}>{powerReason}</span>}
              </span>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

/**
 * The instance's part of its card: the sign-in row, the recovery hint and an unconfirmed sleep or
 * wake under the header, and updates and maintenance in a dialog. The
 * lifecycle state is in the card's subtitle (status()); the actions are in the header's menu
 * (CloudHeaderActions). Shared by directory and CIS-only rows.
 */
function CloudInstanceControls({
  view,
  name,
  model,
  reload,
  onPolicySaved,
  onHurry,
  busy,
  listError,
  waiting,
  onLogin,
  onRetryPower,
  retryingPower,
  maintenanceOpen,
  onMaintenanceOpenChange,
  opener,
}: InstanceActionHandlers & {
  view: CloudInstanceView;
  name: string;
  reload(): Promise<void>;
  onPolicySaved(policy: CloudMaintenanceView): void;
  /** An update was just requested in the dialog: read the list more often for a while. */
  onHurry(): void;
  busy: boolean;
  listError: boolean;
  waiting: boolean;
  onLogin(): void;
  maintenanceOpen: boolean;
  onMaintenanceOpenChange(open: boolean): void;
  opener: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const tr = (key: string, values?: Record<string, string | number>) =>
    t(`cloudSettings.onboarding.${key}`, values);
  const trInstance = (key: string) => t(`cloudSettings.instance.${key}`);
  const feed: CloudInstanceFeed = {
    view,
    reload,
    onPolicySaved,
    linkOffline: model.linkOffline,
    hurry: onHurry,
  };
  const dialog = (
    <CloudMaintenanceDialog
      open={maintenanceOpen}
      onOpenChange={onMaintenanceOpenChange}
      deviceId={view.deviceId}
      name={name}
      feed={feed}
      opener={opener}
    />
  );
  if (
    !view.loginRequired &&
    model.note?.kind !== 'notTaken' &&
    model.note?.kind !== 'refused' &&
    !model.recoveryHint
  )
    return dialog;
  return (
    <div
      className="mt-3 flex flex-col gap-2 border-t border-[var(--border-default)] pt-3"
      data-cloud-instance={view.deviceId}
    >
      {view.loginRequired && (
        <div className={cn(row, 'flex-wrap pt-0')}>
          <span className="flex min-w-0 flex-1 basis-48">
            <RowText
              label={tr('identity')}
              hint={tr(
                waiting
                  ? 'waitingLogin'
                  : view.loginWakeSupported
                    ? 'recoveryDescription'
                    : 'loginDescription',
                { name },
              )}
            />
          </span>
          <Button
            size="sm"
            disabled={
              busy ||
              listError ||
              model.powerRequested ||
              !!view.upgradeOperation?.active ||
              !!view.resourceChanging ||
              view.upgradeState === 'verifying'
            }
            onClick={onLogin}
          >
            <ExternalLink size={14} />
            {tr(model.loginWake ? 'wakeAndLogin' : waiting ? 'reopenLogin' : 'initialize')}
          </Button>
        </div>
      )}
      {/* What the user can do, no button, as the local card's standby hint: 11px tertiary. */}
      {model.recoveryHint && <p className={muted}>{trInstance('errorRecovery')}</p>}
      {/* No client line puts a retry beside an action failure; the closest re-labels the action
          button itself (LocalModelDownloadUI: 「重试下载」). The action here is in the menu, so a
          small 「重试」 goes right after the red line, as the device list's error line. */}
      {model.note?.kind === 'notTaken' && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status" className="text-11 leading-[1.5] text-[var(--error-fg)]">
            {trInstance(`${model.note.action}NotTaken`)}
          </p>
          <Button
            variant="secondary"
            size="sm"
            compact
            loading={retryingPower}
            disabled={busy || model.powerDisabled}
            onClick={onRetryPower}
          >
            {t('commonUi.retry')}
          </Button>
        </div>
      )}
      {/* CIS refused the sleep or wake: nothing changed and trying again would be refused too, so
          the red line says why, without a retry. */}
      {model.note?.kind === 'refused' && model.note.refusal && (
        <p role="alert" className="text-11 leading-[1.5] text-[var(--error-fg)]">
          {t(model.note.refusal)}
        </p>
      )}
      {dialog}
    </div>
  );
}
