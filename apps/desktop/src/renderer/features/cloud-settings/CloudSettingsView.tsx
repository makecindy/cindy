import {
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import {
  Navigate,
  useLocation,
  useNavigate,
  useSearchParams,
  useOutletContext,
} from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Cloud, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  CatalogManagementNotice,
  PLUGIN_MANAGEMENT_FRAME_CLASS,
} from '@/features/plugin/PluginManagementLayout';
import { SettingsCard, SettingsSection } from '@/components/ui/settings-rows';
import {
  CLOUD_RETRY_DELAYS_MS,
  errorCode,
  useBlockRetry,
} from './blockRetry';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { SettingsSidebar } from '@/components/settings/SettingsSidebar';
import { SettingsSidebarNav } from '@/components/settings/SettingsSidebarNav';
import { resolveSettingsSearchEntry } from '@/components/settings/settingsSearchCatalog';
import { SettingsSearchNavigationContext } from '@/components/settings/SettingsSearchNavigation';
import { useSettingsSectionTarget } from '@/components/settings/useSettingsSectionTarget';
import { useAuth } from '@/contexts/AuthContext';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import {
  type CloudSettingsDomain,
  type CloudSettingsState,
  type CloudSettingsTab,
} from '../../../shared/cloudSettings';
import { createCloudSettingsClient, type CloudSettingsClient } from './client';
import { toast } from '@/lib/toast';
import { createCloudSettingsSync } from './cloudSettingsSync';
import { CloudInstanceSection } from './CloudInstanceSection';
import type { CloudInstanceView } from '../../../shared/cloudInstanceControl';
import { useCloudInstanceAccess } from './CloudInstanceAccess';
import { cloudBaseName, cloudDisplayName } from './instanceName';
import { instanceUpgrading } from './instanceState';
import { CloudImSettings, cloudImSettingsSummary, useCloudImDisplays } from './CloudImSettings';
import { CloudBotAuthorization } from './CloudBotAuthorization';
import { CloudMcpAuthorization } from './CloudMcpAuthorization';
import { CloudProvidersSettings } from './CloudProvidersSettings';
import { CLOUD_GROUP_TITLE_KEYS, NativeCloudSections } from './NativeCloudSections';
import type { CloudBotNotificationPreferences } from './CloudBotNotificationSettings';
import { cloudSearchEntryAllowed } from './search';
import type { SettingsSearchEntry } from '@/components/settings/settingsSearchTypes';
import { CloudDesktopFallback } from './CloudDesktopFallback';
import { cloudRefusalKey } from './refusal';
import { CLOUD_INSTANCES_SETTINGS_PATH, cloudInstanceDevicePath } from './cloudInstancesLink';
import {
  CLOUD_SETTINGS_VISIBILITY,
  cloudLinkOpensDeviceCard,
  cloudSearchEntryTab,
  cloudTabDomains,
  cloudTabFromLink,
  type CloudSettingsPageTab,
  type CloudSettingsVisibility,
} from './cloudSettingsVisibility';
// The trial's prompt editor keeps its explicit save button and waits for the receipt.
const CONFIRMED_DOMAINS = new Set<CloudSettingsDomain>(['personalization']);
/**
 * A failed read rebuilds the settings session on its own after a restarted instance, an expired
 * or discarded session (CLOUD_SETTINGS_SCOPE_CHANGED) or a network failure. Three tries over about
 * seven seconds, never while a write is in flight; only then does the page say it cannot read and
 * offer a reload.
 */
export const CLOUD_RECONNECT_DELAYS_MS = CLOUD_RETRY_DELAYS_MS;
// Steppers and number fields send once the user pauses; switches and choices send at once.
const debounced = (set: Record<string, unknown>, clear?: string[]) =>
  !clear?.length &&
  Object.keys(set).length > 0 &&
  Object.values(set).every((value) => typeof value === 'number');
export function CloudSettingsPanel({
  name,
  client: ownClient,
  online,
  onBack,
  trial = false,
  focusMaintenance = false,
  version,
  initialTab,
  visibility = CLOUD_SETTINGS_VISIBILITY,
  onOpenDeviceCard,
  upgrading = false,
  plugins,
  connecting = false,
}: {
  name: string;
  client: CloudSettingsClient;
  online: boolean;
  /** The instance's availability has not been read yet: not offline, just not known. */
  connecting?: boolean;
  onBack(): void;
  trial?: boolean;
  focusMaintenance?: boolean;
  /** Runtime version CIS reports for the instance; shown in About like the local app version. */
  version?: string;
  initialTab?: CloudSettingsPageTab;
  visibility?: CloudSettingsVisibility;
  /** Status and waking live on the device card; shown when the page cannot reach the instance. */
  onOpenDeviceCard?(): void;
  /** Offline because an upgrade has the runtime down: say so rather than "unavailable". */
  upgrading?: boolean;
  /** The native client's plugin page for this instance. Absent in a browser, which opens the desktop. */
  plugins?: (active: boolean) => ReactNode;
}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const client = ownClient;
  const groups = visibility.tabs;
  const showInstance = visibility.instance && !!client.instance;
  const [tab, setTab] = useState<CloudSettingsPageTab>(
    initialTab ?? (showInstance ? 'instance' : (groups[0] ?? 'more')),
  );
  const activeDomains = cloudTabDomains(visibility, tab);
  const outlet = useOutletContext<{ sidebarWidth?: number } | null>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [searchNavigation, setSearchNavigation] = useState<{
    entry: SettingsSearchEntry | null;
    activation: number;
  }>({ entry: null, activation: 0 });
  const [mcpAuthorization, setMcpAuthorization] = useState(false);
  const [botAuthorization, setBotAuthorization] = useState(false);
  const [providerAuthorization, setProviderAuthorization] = useState(false);
  // Like the local Plugins tab, the plugin page fills the panel and scrolls inside itself.
  const pluginPage = tab === 'ghosts' && !!plugins;
  const fills = tab === 'providers' || pluginPage;
  const [deviceId, setDeviceId] = useState('');
  const [cpuCount, setCpuCount] = useState<number | undefined>();
  const [states, setStates] = useState<Partial<Record<CloudSettingsDomain, CloudSettingsState>>>(
    {},
  );
  const [domains, setDomains] = useState<CloudSettingsDomain[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const copy = useRef({ t, trial });
  copy.current = { t, trial };
  const alive = useRef(true);
  const dirty = useRef(new Set<string>());
  // The page's own notice already says it cannot reach the instance.
  const unreachableShown = useRef(false);
  const sync = useMemo(() => {
    const next = createCloudSettingsSync({
      client,
      onChange: () => {
        if (!alive.current) return;
        setStates(next.view());
        setSyncing(next.busy());
      },
      onSaved: (domain, application) => {
        dirty.current.delete(domain);
        // Saved but not applied everywhere on the instance: a warning toast.
        if (application === 'failed') toast.warning(copy.current.t('hostSettings.savedApplyFailed'));
        setResult(copy.current.trial ? 'cloudSettings.trialSaved' : 'cloudSettings.saved');
      },
      onFailure: ({ reason }) => {
        if (reason === 'unreachable' && unreachableShown.current) return;
        // As the client's settings: a toast with no button; the control shows the
        // instance's value again.
        toast.error(copy.current.t(`cloudSettings.sync.${reason}`));
      },
    });
    return next;
  }, [client]);
  // Leaving by any route: waiting changes are sent, not dropped.
  useEffect(() => () => void sync.dispose(), [sync]);
  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: 0 });
  }, [tab]);
  const [loading, setLoading] = useState(false);
  // "Reading…" only before the page has shown anything; later reads refresh in place.
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [failure, setFailure] = useState<'readFailed' | 'unsupported' | 'refused'>();
  // CIS refused the instance (transferred, suspended, …): final, so the page says why and does not retry.
  const [refusal, setRefusal] = useState<string>();
  const refused = (error: unknown) => {
    const key = cloudRefusalKey(error);
    if (!key) return false;
    setRefusal(key);
    setFailure('refused');
    return true;
  };
  unreachableShown.current = failure === 'readFailed' && tab !== 'instance';
  // The code stays for diagnostics; the client does not show it.
  const [, setFailureCode] = useState<string>();
  const connectedOnce = useRef(false);
  const recovery = useRef({ attempts: 0, running: false });
  const onlineRef = useRef(online);
  onlineRef.current = online;
  // Read after the category has loaded, so the settings come first in the instance's queue,
  // and again for a channel whose saved settings change, so the automatic route follows them.
  const [loadedTab, setLoadedTab] = useState<string>();
  const imDisplays = useCloudImDisplays(
    deviceId,
    online && !trial && tab === 'im-bot' && loadedTab === tab && !loading,
    states,
  );
  const [result, setResult] = useState<string>();
  const [epoch, setEpoch] = useState(0);
  // Only the explicit-save path waits; it keeps the page still until the receipt arrives.
  const pending = useRef(false);
  const [writing, setWriting] = useState(false);
  const fresh = useRef(false);
  const changed = useMemo(
    () => (domain: string, value: boolean) => {
      if (value) dirty.current.add(domain);
      else dirty.current.delete(domain);
    },
    [],
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      client.cancelAuthorizations?.();
    };
  }, [client]);
  // What the shown values were last read for. A finished save reads its own domain
  // back, so a save alone does not reread the whole category (seconds on IM and model
  // categories); a load it interrupted, a new tab or an explicit refresh still does.
  const loadedFor = useRef<readonly unknown[] | null>(null);
  useEffect(() => {
    if (!online || writing) return;
    const key = [client, online, tab, epoch];
    if (fresh.current && loadedFor.current?.every((value, index) => value === key[index])) return;
    let current = true;
    fresh.current = false;
    loadedFor.current = null;
    setLoading(true);
    void client
      .connect()
      .then(async (cap) => {
        const wanted = activeDomains.filter((domain) => cap.domains.includes(domain));
        const stamp = sync.stamp();
        const values = wanted.length ? await client.read(wanted) : [];
        if (!current) return;
        fresh.current = true;
        loadedFor.current = key;
        setLoadedTab(tab);
        connectedOnce.current = true;
        recovery.current.attempts = 0;
        setFailure(undefined);
        setRefusal(undefined);
        setFailureCode(undefined);
        setLoadedOnce(true);
        setDomains(cap.domains);
        setCpuCount(cap.cpuCount);
        setDeviceId(cap.deviceId);
        setProviderAuthorization(cap.providerAuthorization === 1);
        setMcpAuthorization(cap.mcpAuthorization === 1);
        setBotAuthorization(cap.botAuthorization === 1);
        // A read that started before a local change or a confirmed write never overwrites it.
        sync.retain(cap.domains);
        sync.ingest(values, stamp);
      })
      .catch((error) => {
        if (!current) return;
        if (refused(error)) return;
        // An instance without settings sessions answers the first open this way.
        if (!connectedOnce.current && errorCode(error) === 'CLOUD_SETTINGS_UNSUPPORTED')
          setFailure('unsupported');
        else void recover(errorCode(error));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      fresh.current = false;
    };
  }, [client, sync, online, tab, epoch, writing]);
  useEffect(() => {
    const visibility = () => {
      fresh.current = false;
      if (document.visibilityState !== 'hidden') setEpoch((value) => value + 1);
    };
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, []);
  const leave = async (destination: () => void = onBack) => {
    if (pending.current) return;
    if (
      dirty.current.size &&
      !(await confirm({
        // As leaving another device's settings on this computer (RemoteBotSettings).
        title: t('bots.memory.unsavedTitle'),
        description: t('bots.remoteSettings.leaveDescription'),
        confirmText: t('bots.memory.discard'),
        cancelText: t('bots.memory.continueEditing'),
      }))
    )
      return;
    // Close the session only after the flushed writes have gone out.
    void sync.dispose().then(() => client.close());
    destination();
  };
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  // A new session, then the open category again (the read effect, through epoch).
  const reconnect = async () => {
    // Reconnecting would cut off a write in flight; it waits for the write instead.
    while (alive.current && (pending.current || sync.busy())) await wait(500);
    if (!alive.current || !onlineRef.current) throw new Error('CLOUD_SETTINGS_NOT_READY');
    fresh.current = false;
    await client.reconnect();
    if (alive.current) setEpoch((value) => value + 1);
  };
  const recover = async (code: string) => {
    const state = recovery.current;
    if (state.running) return;
    state.running = true;
    setReconnecting(true);
    try {
      while (alive.current && onlineRef.current) {
        if (state.attempts >= CLOUD_RECONNECT_DELAYS_MS.length) {
          setFailure('readFailed');
          setFailureCode(code);
          return;
        }
        await wait(CLOUD_RECONNECT_DELAYS_MS[state.attempts]!);
        state.attempts += 1;
        try {
          await reconnect();
          return;
        } catch (error) {
          code = errorCode(error);
          if (refused(error)) return;
          if (code === 'CLOUD_SETTINGS_UNSUPPORTED' && !connectedOnce.current) {
            setFailure('unsupported');
            return;
          }
        }
      }
    } finally {
      state.running = false;
      if (alive.current) setReconnecting(false);
    }
  };
  // Groups of the open category the instance answered without a value: read them again, alone.
  // A group read before keeps its last value meanwhile, not editable (sync.stale).
  const unreadable = activeDomains.filter(
    (domain) => states[domain]?.status === 'unreadable' || sync.stale(domain),
  );
  const [blockLoading, setBlockLoading] = useState(false);
  const [blockFailures, setBlockFailures] = useState(0);
  const rereadBlock = async () => {
    if (!unreadable.length || !alive.current) return;
    setBlockLoading(true);
    try {
      const stamp = sync.stamp();
      const values = await client.read(unreadable);
      if (!alive.current) return;
      sync.ingest(values, stamp);
      if (values.some((value) => value.status === 'unreadable'))
        setBlockFailures((count) => count + 1);
    } catch (error) {
      // The session itself: the page reconnects on its own.
      if (alive.current) void recover(errorCode(error));
    } finally {
      if (alive.current) setBlockLoading(false);
    }
  };
  const blockRetry = useBlockRetry({
    failed: online && !loading && unreadable.length > 0,
    failures: blockFailures,
    retry: () => void rereadBlock(),
    paused: !!failure,
  });
  // The reload in the read-failure notice (and an IM card's): one new session now.
  const reload = async () => {
    if (pending.current || loading || reconnecting || !online || sync.busy()) return;
    setLoading(true);
    setReconnecting(true);
    try {
      await reconnect();
    } catch (error) {
      if (alive.current && !refused(error)) {
        setFailure('readFailed');
        setFailureCode(errorCode(error));
      }
    } finally {
      if (alive.current) {
        setLoading(false);
        setReconnecting(false);
      }
    }
  };
  // Shows the change at once and writes it in the background; failures are reported by the sync.
  const save = async (
    state: CloudSettingsState,
    set: Record<string, unknown>,
    clear?: string[],
  ) => {
    if (CONFIRMED_DOMAINS.has(state.domain)) return confirmedSave(state, set, clear);
    if (!alive.current || !online || reconnecting || document.visibilityState === 'hidden')
      throw new Error('NOT_READY');
    setResult(undefined);
    return sync.change(state.domain, set, clear, debounced(set, clear));
  };
  const confirmedSave = async (
    state: CloudSettingsState,
    set: Record<string, unknown>,
    clear?: string[],
  ) => {
    if (
      !alive.current ||
      !fresh.current ||
      !online ||
      pending.current ||
      document.visibilityState === 'hidden'
    )
      throw new Error('NOT_READY');
    pending.current = true;
    setWriting(true);
    setResult(undefined);
    try {
      const saved = await sync.commit(state, set, clear);
      if (!alive.current) throw new Error('CLOUD_SETTINGS_SCOPE_CHANGED');
      setStates(sync.view());
      // The saved domain was just read back; the others are as current as before the save.
      fresh.current = true;
      dirty.current.delete(state.domain);
      if (saved.application === 'failed') toast.warning(t('hostSettings.savedApplyFailed'));
      setResult(trial ? 'cloudSettings.trialSaved' : 'cloudSettings.saved');
      return saved.state;
    } catch (error) {
      fresh.current = false;
      // The outcome may be unknown: read once and take the instance's value. Never write again.
      let latest: CloudSettingsState | undefined;
      try {
        [latest] = await client.read([state.domain]);
      } catch (readError) {
        if (alive.current && !refused(readError)) {
          setFailure('readFailed');
          setFailureCode(errorCode(readError));
        }
        throw error;
      }
      if (!alive.current || latest?.status !== 'ready') throw error;
      sync.ingest([latest], sync.stamp());
      setStates(sync.view());
      fresh.current = true;
      if (
        Object.entries(set).every(
          ([key, value]) => JSON.stringify(latest.value?.[key]) === JSON.stringify(value),
        ) &&
        (clear ?? []).every((key) => !latest.customizedKeys?.includes(key))
      ) {
        // It did arrive: nothing to report.
        dirty.current.delete(state.domain);
        return latest;
      }
      // It did not: the editor keeps the text and reports that it was not saved.
      throw error;
    } finally {
      pending.current = false;
      setWriting(false);
    }
  };
  // Target values shown in the native notification sections of the IM cards.
  const ready = (domain: CloudSettingsDomain) =>
    states[domain]?.status === 'ready' && !sync.stale(domain) ? states[domain] : undefined;
  const wecomNotifications = ready('wecomNotifications');
  const desktopNotifications = ready('desktopNotifications');
  const notificationPreferences: CloudBotNotificationPreferences = {
    wecomEnabled: wecomNotifications && wecomNotifications.value?.enabled === true,
    feishuSessionEnabled:
      desktopNotifications && desktopNotifications.value?.feishuNotificationsEnabled === true,
    setWecomEnabled: async (enabled) => {
      if (!wecomNotifications) throw new Error('NOT_READY');
      await save(wecomNotifications, { enabled });
    },
    setFeishuSessionEnabled: async (enabled) => {
      if (!desktopNotifications) throw new Error('NOT_READY');
      await save(desktopNotifications, { feishuNotificationsEnabled: enabled });
    },
    refresh: () => setEpoch((value) => value + 1),
  };
  // Until the instance has answered every category stays listed, so the default one is not a
  // jump; an answer that rules the open category out moves to the first one it supports.
  const capabilitiesKnown = !!deviceId;

  // The page's one notice (as the client's RemoteSkillsPage / RemotePluginPage): who is
  // managed, and in its text what the page is doing: reading, could not read, offline, updating,
  // not supported. Until the instance has been read it is not known to be offline. The plugin
  // page reads over DeviceLink, not these settings, so there it says only the instance's state;
  // the plugin and skill pages report their own reads below it.
  const retryButton = (onClick: () => void, disabled: boolean) => (
    <Button size="sm" variant="secondary" disabled={disabled} onClick={onClick}>
      {t('settings.ghosts.remote.retry')}
    </Button>
  );
  const notice: { text: string; warning?: boolean; action?: ReactNode } = trial
    ? { text: t('cloudSettings.trial') }
    : connecting
      ? { text: t('settings.ghosts.remote.configurationLoading') }
      : !online
        ? {
            text: upgrading
              ? t('cloudSettings.upgradingNotice', { name })
              : t('settings.ghosts.remote.offlineNotice', { device: name }),
            warning: true,
            // Waking and the instance's state live on its card (cloud only).
            action: onOpenDeviceCard && (
              <Button size="sm" variant="secondary" onClick={() => void leave(onOpenDeviceCard)}>
                {t('settings.tabs.remoteControl')}
              </Button>
            ),
          }
        : pluginPage
          ? { text: t('settings.ghosts.remote.managingDescription') }
        : failure === 'refused' && refusal
          ? { text: t(refusal), warning: true }
          : failure === 'unsupported'
          ? { text: t('bots.remoteSettings.unsupported'), warning: true }
          : failure === 'readFailed' ||
              (blockRetry.exhausted &&
                tab !== 'im-bot' &&
                unreadable.some((domain) => !CLOUD_GROUP_TITLE_KEYS[domain]))
            ? {
                text: t('bots.remoteSettings.loadFailed'),
                warning: true,
                action:
                  failure === 'readFailed'
                    ? retryButton(
                        () => void reload(),
                        loading || reconnecting || writing || syncing,
                      )
                    : retryButton(blockRetry.reload, loading || blockLoading || reconnecting),
              }
            : (loading || reconnecting) && !loadedOnce
              ? { text: t('settings.ghosts.remote.configurationLoading') }
              : { text: t('settings.ghosts.remote.managingDescription') };
  const pageNotice = (
    <CatalogManagementNotice
      // The plugin page below starts with its own top padding.
      className={pluginPage ? 'mb-0 shrink-0' : 'shrink-0'}
      title={t('settings.ghosts.remote.managingTarget', { device: name })}
      warning={notice.warning}
      action={notice.action}
    >
      {notice.text}
    </CatalogManagementNotice>
  );
  const tabs = groups.filter((group) =>
    !capabilitiesKnown
      ? true
      : group === 'providers'
        ? providerAuthorization
        : group === 'im-bot'
          ? botAuthorization
          : group === 'ghosts'
            ? true
            : !domains.length ||
              cloudTabDomains(visibility, group).some((d) => domains.includes(d)),
  );
  const tabAvailable =
    tab === 'instance' || tab === 'more' || !capabilitiesKnown || tabs.includes(tab);
  useEffect(() => {
    if (!tabAvailable) setTab(tabs[0] ?? 'more');
  }, [tabAvailable]);
  const visibleDomains = new Set(groups.flatMap((group) => cloudTabDomains(visibility, group)));
  const allowSearchEntry = (entry: SettingsSearchEntry) =>
    cloudSearchEntryTab(visibility, entry) !== null &&
    (visibility.memoryAgentRows || !entry.id.startsWith('settings.memory.agents.')) &&
    (entry.tab === 'providers'
      ? providerAuthorization && entry.id === 'providers'
      : entry.tab === 'im-bot'
        ? botAuthorization && entry.id === 'im-bot'
        : entry.tab === 'ghosts'
          ? entry.id === 'ghosts'
          : cloudSearchEntryAllowed(
              entry,
              domains.filter(
                (domain) =>
                  visibleDomains.has(domain) &&
                  (!states[domain] || states[domain]?.status === 'ready'),
              ),
              trial,
            ));
  // A category's panel reads only what the list gives it.
  const statesOf = (group: CloudSettingsTab) =>
    Object.fromEntries(
      cloudTabDomains(visibility, group).map((domain) => [domain, states[domain]]),
    ) as typeof states;
  useSettingsSectionTarget(
    searchNavigation.entry?.targetId ?? null,
    scrollRef,
    `${tab}:${searchNavigation.activation}:${loading}`,
    searchNavigation.entry?.fallbackTargetId,
  );
  return (
    <SettingsSearchNavigationContext.Provider value={searchNavigation}>
      <div
        className="h-full w-full overflow-hidden bg-[var(--settings-bg)]"
        role="main"
        aria-label={t('cloudSettings.title')}
        data-testid="cloud-settings"
      >
        <div className="flex h-full min-h-0 w-full justify-start pb-5">
          <SettingsSidebar
            title={t('settings.title')}
            width={outlet?.sidebarWidth}
            onBack={() => void leave()}
            disabled={writing}
          >
            <SettingsSidebarNav
              tabIds={tabs}
              // A moved setting is found under its original category, then opens where it is.
              searchTabIds={visibility.tabs.includes('general') ? tabs : [...tabs, 'general']}
              activeTab={tab === 'instance' || tab === 'more' ? null : tab}
              leadingTab={
                showInstance
                  ? {
                      id: 'instance',
                      label: t('cloudSettings.instance.title'),
                      icon: Cloud,
                      selected: tab === 'instance',
                      onSelect: () => {
                        if (!pending.current) {
                          setTab('instance');
                          setSearchNavigation({ entry: null, activation: 0 });
                        }
                      },
                    }
                  : undefined
              }
              trailingTab={
                visibility.more
                  ? {
                      id: 'more',
                      label: t('cloudSettings.moreSettings'),
                      icon: MoreHorizontal,
                      selected: tab === 'more',
                      onSelect: () => {
                        if (!pending.current) {
                          setTab('more');
                          setSearchNavigation({ entry: null, activation: 0 });
                          setResult(undefined);
                        }
                      },
                    }
                  : undefined
              }
              allowSearchEntry={allowSearchEntry}
              onSelectTab={(next) => {
                if (!pending.current) {
                  setTab(next as CloudSettingsTab);
                  setSearchNavigation({ entry: null, activation: 0 });
                  setResult(undefined);
                }
              }}
              onSelectSearchResult={({ tab: next, sectionId }) => {
                if (!pending.current) {
                  const entry = resolveSettingsSearchEntry(next, sectionId);
                  setTab(
                    (entry && cloudSearchEntryTab(visibility, entry)) ?? (next as CloudSettingsTab),
                  );
                  setSearchNavigation((previous) => ({
                    entry,
                    activation: previous.activation + 1,
                  }));
                }
              }}
            />
          </SettingsSidebar>
          <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col pl-4 pr-6">
            {/* Providers scroll inside their card, as on the local settings page. */}
            <div
              ref={scrollRef}
              className={`min-h-0 flex-1 [scrollbar-gutter:stable] ${fills ? 'overflow-hidden' : 'overflow-y-auto'}`}
            >
              <div
                className={`mx-auto w-full min-w-0 animate-fade-in ${pluginPage ? 'max-w-none' : 'max-w-[920px] px-1'} ${fills ? 'flex h-full min-h-0 flex-col' : 'pb-32'}`}
              >
                {/* As the client shows another computer it manages: one notice
                    at the top, whose text says what the page is doing. On the plugin page it
                    stays above every tab, aligned with that page's own frame, which then shows
                    only what it alone knows (offline, loading, project). */}
                {pluginPage ? (
                  <div className={`${PLUGIN_MANAGEMENT_FRAME_CLASS} shrink-0`}>{pageNotice}</div>
                ) : (
                  pageNotice
                )}
                {/* Read by screen readers only: a save says nothing on screen, as on this computer. */}
                <span className="sr-only" role="status">
                  {result ? t(result) : ''}
                </span>
                {/* A category the instance does not offer at all. Groups it offers but could
                    not read say so in their own heading row. */}
                {activeDomains.length > 0 &&
                  online &&
                  loadedOnce &&
                  !loading &&
                  !reconnecting &&
                  !failure &&
                  !activeDomains.some((d) => states[d]?.status === 'ready' || states[d]?.status === 'unreadable') && (
                    <p className="py-3 text-13 text-[var(--text-secondary)]">
                      {t('bots.remoteSettings.unsupported')}
                    </p>
                  )}
                {showInstance && (
                  <div
                    hidden={tab !== 'instance'}
                    role="tabpanel"
                    id="settings-panel-instance"
                    aria-labelledby="settings-tab-instance"
                  >
                    <CloudInstanceSection
                      client={client}
                      name={name}
                      active={tab === 'instance'}
                      changed={changed}
                      focusMaintenance={focusMaintenance}
                    />
                  </div>
                )}
                {groups.map((group) => (
                  <div
                    key={group}
                    hidden={tab !== group}
                    className={group === 'providers' || (group === 'ghosts' && !!plugins) ? 'min-h-0 flex-1' : undefined}
                    role="tabpanel"
                    id={`settings-panel-${group}`}
                    aria-labelledby={`settings-tab-${group}`}
                  >
                    {group === 'im-bot' ? (
                      botAuthorization && (
                        <CloudBotAuthorization
                          deviceId={deviceId}
                          summary={(itemId) =>
                            // The collapsed row is one short line like the local "Pi · auto";
                            // the full automatic explanation stays in the expanded picker.
                            cloudImSettingsSummary(
                              itemId,
                              states,
                              t('hostSettings.card.automatic'),
                              imDisplays[itemId.replace(/^bot:/, '')],
                            )
                          }
                          settings={(itemId, section) => (
                            <CloudImSettings
                              itemId={itemId}
                              section={section}
                              deviceId={deviceId}
                              name={name}
                              display={imDisplays[itemId.replace(/^bot:/, '')]}
                              states={states}
                              supportedDomains={domains}
                              loading={loading}
                              readFailed={!!failure || !online}
                              retry={() => void reload()}
                              retryDisabled={
                                !online || loading || writing || syncing || tab !== group
                              }
                              disabled={
                                !online || reconnecting || writing || !!failure || tab !== group
                              }
                              save={save}
                            />
                          )}
                          notificationPreferences={notificationPreferences}
                          client={client}
                          name={name}
                          online={online}
                          active={tab === group}
                          trial={trial}
                          refresh={epoch}
                          pageFailed={!!failure}
                        />
                      )
                    ) : group === 'ghosts' ? (
                      plugins ? (
                        plugins(tab === group)
                      ) : (
                        // A browser has no plugin page: the instance's own settings.
                        <CloudDesktopFallback
                          deviceId={deviceId}
                          name={name}
                          description={t('bots.remoteSettings.finishOnHost', { device: name })}
                        />
                      )
                    ) : group === 'providers' ? (
                      providerAuthorization && (
                        <CloudProvidersSettings
                          client={client}
                          name={name}
                          online={online}
                          active={tab === group}
                          trial={trial}
                          refresh={epoch}
                          pageFailed={!!failure}
                          deviceId={deviceId}
                          management={visibility.providerManagement}
                        />
                      )
                    ) : (
                      (() => {
                        const sections = (
                          <fieldset
                            disabled={!online || reconnecting || writing || !!failure || tab !== group}
                            className="m-0 min-w-0 border-0 p-0"
                          >
                            <NativeCloudSections
                              tab={group}
                              deviceId={deviceId}
                              name={name}
                              states={statesOf(group)}
                              memoryAgentRows={visibility.memoryAgentRows}
                              unreadableNotice={
                                blockRetry.exhausted && tab === group
                                  ? {
                                      reload: blockRetry.reload,
                                      disabled: loading || blockLoading || reconnecting,
                                    }
                                  : undefined
                              }
                              stale={sync.stale}
                              // Hidden categories do not read (e.g. the instance prompt) on every save.
                              disabled={!online || reconnecting || writing || !!failure || tab !== group}
                              cpuCount={cpuCount}
                              appVersion={version}
                              trial={trial}
                              save={save}
                              changed={changed}
                            />
                          </fieldset>
                        );
                        if (group !== 'builtin-tools') return sections;
                        // As on the local Tools page: one page title over built-in and external tools.
                        return (
                          <SettingsSection variant="page" title={t('settings.tabs.builtinTools')}>
                            {sections}
                            {mcpAuthorization && (
                              <CloudMcpAuthorization
                                client={client}
                                name={name}
                                online={online}
                                active={tab === group}
                                trial={trial}
                                refresh={epoch}
                                pageFailed={!!failure}
                              />
                            )}
                          </SettingsSection>
                        );
                      })()
                    )}
                  </div>
                ))}
                {visibility.more && (
                  <div
                    hidden={tab !== 'more'}
                    role="tabpanel"
                    id="settings-panel-more"
                    aria-labelledby="settings-tab-more"
                  >
                    {/* A page title as on this computer's pages. */}
                    <SettingsSection variant="page" title={t('cloudSettings.moreSettings')}>
                      <SettingsCard className="p-5">
                        <CloudDesktopFallback
                          deviceId={deviceId}
                          name={name}
                          description={t('cloudSettings.moreSettingsFallback', { name })}
                          disabled={!online || !deviceId}
                        />
                      </SettingsCard>
                    </SettingsSection>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </SettingsSearchNavigationContext.Provider>
  );
}

/** The native client's plugin page for one instance; see CloudPluginManagement. */
type CloudPluginPage = ComponentType<{ deviceId: string; name: string; active: boolean }>;

export function CloudSettingsView({ plugins }: { plugins?: CloudPluginPage }) {
  const access = useCloudInstanceAccess();
  if (access === 'checking') return null;
  if (access !== 'allowed') return <Navigate to="/settings" replace />;
  return <AuthorizedCloudSettingsView plugins={plugins} />;
}

/** Loads the plugin page, and reads the instance for it, only once the category is opened. */
function PluginPageGate({ active, children }: { active: boolean; children: ReactNode }) {
  const [opened, setOpened] = useState(active);
  useEffect(() => {
    if (active) setOpened(true);
  }, [active]);
  return opened ? <Suspense fallback={null}>{children}</Suspense> : null;
}

function AuthorizedCloudSettingsView({ plugins: Plugins }: { plugins?: CloudPluginPage }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const visibility = CLOUD_SETTINGS_VISIBILITY;
  const { dataOwnerId } = useAuth();
  const devices = useDeviceLinkDeviceList();
  const candidates =
    devices?.filter(
      (device) => !device.isSelf && /^cloud-device-[a-f0-9]{24}$/.test(device.deviceId),
    ) ?? [];
  const selected = params.get('deviceId');
  const device = candidates.find((item) => item.deviceId === selected);
  const owner = getDataOwnerGeneration();
  const scope = JSON.stringify([dataOwnerId, owner.generation, selected]);
  const current = useRef({ scope });
  current.current = { scope };
  const [availability, setAvailability] = useState<{ scope: string; view?: CloudInstanceView }>();
  const settingsApi = window.electronAPI?.cloudSettings;
  const own = useMemo(
    () =>
      selected && settingsApi
        ? createCloudSettingsClient(selected, settingsApi, () => {
            if (!isDataOwnerGenerationCurrent(owner) || current.current.scope !== scope)
              throw new Error('CLOUD_SETTINGS_SCOPE_CHANGED');
          })
        : undefined,
    [scope, settingsApi],
  );
  useEffect(() => {
    if (!own?.instance) return;
    let disposed = false;
    let inFlight = false;
    const refresh = async () => {
      if (disposed || inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const view = await own.instance!();
        if (!disposed && current.current.scope === scope)
          setAvailability({ scope, view: view.deviceId === selected ? view : undefined });
      } catch {
        if (!disposed && current.current.scope === scope) setAvailability({ scope });
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30_000);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [own, scope, selected, device?.online]);
  const client = own;
  const instance = availability?.scope === scope ? availability.view : undefined;
  // Settings use CIS, not the local relay. A stopped/revoked relay can have an
  // empty device directory even while the owned cloud runtime is healthy.
  // Reads and writes still pass Main/CIS ownership and runtime checks.
  // CIS can still report running/ready while an upgrade has the runtime down (instanceUpgrading);
  // connecting then fails with a scope change, so the page says it is upgrading instead.
  const upgrading = !!instance && instanceUpgrading(instance, !device?.online);
  const online = own?.instance
    ? !!instance?.ready &&
      instance.desiredState === 'running' &&
      !instance.loginRequired &&
      !upgrading
    : !!device?.online;
  // Until CIS has answered for this instance its state is unknown, which is not offline.
  const connecting = !!own?.instance && availability?.scope !== scope;
  const returnTo: unknown = location.state?.returnTo;
  const back = () =>
    navigate(
      typeof returnTo === 'string' &&
        returnTo.startsWith('/') &&
        !returnTo.startsWith('//') &&
        (!returnTo.startsWith('/cloud-settings') || (returnTo === '/cloud-settings' && !!selected))
        ? returnTo
        : '/cc-agent',
    );
  if (selected && /^cloud-device-[a-f0-9]{24}$/.test(selected) && client) {
    const linkedTab = params.get('tab');
    if (cloudLinkOpensDeviceCard(visibility, linkedTab, params.get('section')))
      return <Navigate to={cloudInstanceDevicePath(selected)} replace />;
    // The name its card shows, 「(n)」 included when another device has the same name.
    const ownName = cloudBaseName(t, selected, device?.name, instance);
    const name = cloudDisplayName(selected, ownName, [
      ...(devices ?? []).map((item) =>
        item.deviceId === selected
          ? { deviceId: item.deviceId, name: ownName }
          : candidates.includes(item)
            ? { deviceId: item.deviceId, name: cloudBaseName(t, item.deviceId, item.name, undefined) }
            : item,
      ),
      ...(device ? [] : [{ deviceId: selected, name: ownName }]),
    ]);
    return (
      <>
        <CloudSettingsPanel
          key={scope}
          name={name}
          plugins={
            Plugins &&
            ((active) => (
              <PluginPageGate active={active}>
                <Plugins deviceId={selected} name={name} active={active} />
              </PluginPageGate>
            ))
          }
          client={client}
          online={online}
          connecting={connecting}
          onBack={back}
          focusMaintenance={params.get('section') === 'maintenance'}
          version={instance?.version ?? undefined}
          upgrading={upgrading}
          initialTab={cloudTabFromLink(visibility, linkedTab)}
          visibility={visibility}
          // To this cloud Cindy's own card, not just the list (with several, the one in question).
          onOpenDeviceCard={
            own?.instance ? () => navigate(cloudInstanceDevicePath(selected)) : undefined
          }
        />
      </>
    );
  }
  return <Navigate to={CLOUD_INSTANCES_SETTINGS_PATH} replace />;
}
