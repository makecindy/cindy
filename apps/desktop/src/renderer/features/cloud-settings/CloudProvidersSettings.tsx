import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  GripVertical,
  KeyRound,
  LogOut,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import {
  isCustomRoutedProvider,
  isOrganizationManagedProvider,
  storedCustomProviderId,
  type CustomProviderConfig,
  type ProviderView,
} from '@cindy/model-providers';
import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';

import { Button } from '@/components/ui/button';
import { LocalModelCatalogNotice } from '@/components/new-chat/LocalModelCatalogNotice';
import { Switch } from '@/components/ui/switch';
import { SettingsPageHeader } from '@/components/ui/settings-rows';
import { Tip } from '@/components/ui/tooltip';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { hasProviderLogo, ProviderLogoMark } from '@/components/icons/ProviderLogoMark';
import { SortableList } from '@/components/sidebar/SortableList';
import { ProviderListEntry } from '@/components/settings/ProviderListEntry';
import { ConnectedPill, ProviderAccountHeader } from '@/components/settings/ProviderAccountHeader';
import { AddProviderWizard, type WizardEntry } from '@/components/settings/AddProviderWizard';
import { ProviderAccountUsageModule } from '@/components/settings/ProviderAccountUsageModule';
import { ProviderConnectionDialog } from '@/components/settings/ProviderConnectionDialog';
import { ProviderSetupSourceContext } from '@/components/settings/providerSetupSource';
import { providerWeeklyQuotaSource } from '@/components/new-chat/useProviderWeeklyQuota';
import { CodexResetCredits } from '@/components/status/CodexResetCredits';
import { SettingsTextInput } from '@/components/settings/SettingsTextInput';
import { buildUnionRows, UnifiedModelList } from '@/components/settings/UnifiedModelList';
import { ModelSettingsSourceContext } from '@/components/settings/modelSettingsSource';
import { useDeviceProviderSubscriptionCard } from '@/components/settings/useProviderSubscriptionCard';
import { QuotaHoverCard } from '@/components/status/QuotaHoverCard';
import { ProviderShareEntryButton } from '@/features/provider-share/ProviderShareEntryButton';
import { ProviderShareManagePage } from '@/features/provider-share/ProviderShareManagePage';
import { SubscriptionFastSetting } from '@/features/provider-share/SubscriptionFastSetting';
import { ProviderSharePasteButton } from '@/features/provider-share/ProviderSharePasteDialog';
import {
  ProviderShareReceivedDetail,
  ProviderShareReceivedRailGroup,
} from '@/features/provider-share/ProviderShareReceivedRail';
import {
  ProviderShareSourceContext,
  type ProviderShareSource,
} from '@/features/provider-share/providerShareSource';
import type { ReceivedSnapshot } from '@/features/provider-share/providerShareStore';
import { providerShareGate } from '@/features/provider-share/providerShareFormat';
import { useProviderSharePendingRequests } from '@/features/provider-share/providerShareStore';
import { useDeviceProviders } from '@/hooks/useDeviceProviders';
import { useCodexRateLimitReset } from '@/hooks/useCodexRateLimitReset';
import { providerViewToCustomProviderConfig } from '@/lib/customProviders';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { providerDisplayName } from '@/lib/providerDisplayName';
import { providerMonogram } from '@/lib/providerModels';
import {
  customProviderSubtitleForDisplay,
  providerSubtitleForDisplay,
} from '@/lib/providerSubtitle';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { ManagementItem, ManagementResult } from '../../../shared/settingsManagement';
import {
  CLOUD_PROVIDER_SETUP_ITEM,
  type CloudProviderSettingsRequest,
  type CloudProviderSettingsWriteReceipt,
} from '../../../shared/cloudProviderSettings';
import type { ByokStatus, ModelAccessStatus } from '../../../shared/modelAccess';
import type { ProviderAccountUsageResult } from '../../../shared/providerAccountUsage';
import type { DetectedProviderDraft } from '../../../shared/providerDetection';
import { isBuiltinApiKeyProviderId } from '../../../shared/providerSecrets';
import { MANAGED_LLAMACPP_PROVIDER_ID } from '../../../shared/llamaCpp';
import {
  MANAGED_LMSTUDIO_PROVIDER_ID,
  MANAGED_OLLAMA_PROVIDER_ID,
} from '../../../shared/localModelRuntime';
import { applyProviderOrder } from '../../../shared/providerOrder';
import { localCliDisplayName, type LocalCliDetection } from '../../../shared/localCliDetect';
import { isBuiltinRefreshableProviderId } from '../../../shared/providerModelRefresh';
import { providerGroupDeviceCount } from '../../../shared/providerGroup';
import { remoteProviderGroupOf } from '../../../shared/remoteProviderGroups';
import { CloudProviderAuthorization } from './CloudProviderAuthorization';
import { CloudAddProviderDialog } from './CloudAddProviderDialog';
import { CloudXdQuota } from './CloudXdQuota';
import { useCloudProviderCatalog, type CloudProviderWrite } from './cloudProviderCatalog';
import { CloudLoginPrompt, useCloudProviderSetup } from './cloudProviderSetup';
import { useForeground } from './foreground';
import { useCloudAuthorization, type CloudAuthorizationProps } from './useCloudAuthorization';

type Action = ManagementItem['actions'][number];
type ShareCommand = Extract<CloudProviderSettingsRequest, { op: 'share' }>['command'];
type Phase = Extract<ManagementResult, { kind: 'operation' }>['phase'];

function providerHasModels(provider: ProviderView): boolean {
  return (
    provider.agents.some((agent) => (provider.models[agent]?.length ?? 0) > 0) ||
    (provider.imageModels?.length ?? 0) > 0 ||
    (provider.videoModels?.length ?? 0) > 0 ||
    (provider.audioModels?.length ?? 0) > 0 ||
    (provider.embeddingModels?.length ?? 0) > 0
  );
}

/** Same rail rule as the local page: removed and never-connected built-ins stay out. */
export function cloudRailProviders(providers: readonly ProviderView[]): ProviderView[] {
  return providers.filter((p) => {
    if (p.removed) return false;
    if (p.source === 'builtin')
      return (
        p.id === 'xd' ||
        p.connected ||
        p.removed === false ||
        p.openAiAccount?.reconnectRequired === true ||
        (p.id === 'openai' && (p.imageModels?.length ?? 0) > 0)
      );
    if (isOrganizationManagedProvider(p)) return true;
    return (
      p.source === 'user' &&
      (p.id === MANAGED_OLLAMA_PROVIDER_ID ||
        p.id === MANAGED_LLAMACPP_PROVIDER_ID ||
        p.id === MANAGED_LMSTUDIO_PROVIDER_ID ||
        providerHasModels(p) ||
        (p.auth.method === 'oauth' && (!!p.auth.oauth || !!p.auth.native)))
    );
  });
}

function providerIcon(p: ProviderView, size: number): ReactNode {
  return hasProviderLogo(p.id, p.routing) ? (
    <ProviderLogoMark providerId={p.id} routing={p.routing} size={size} />
  ) : (
    <span className="text-15 font-medium leading-none">{providerMonogram(p.name)}</span>
  );
}

function CustomTag({ label }: { label: string }) {
  return (
    <span
      className="flex h-[18px] shrink-0 items-center rounded-full px-2 text-11 font-medium"
      style={{
        border: '1px solid var(--settings-integration-avatar-border)',
        color: 'var(--text-tertiary)',
      }}
    >
      {label}
    </span>
  );
}

function ReconnectRequiredPill() {
  const { t } = useTranslation();
  return (
    <span
      className="flex h-[22px] shrink-0 select-none items-center gap-1 rounded-full px-2.5 text-11 font-medium"
      style={{
        backgroundColor: 'var(--settings-btn-secondary-bg)',
        color: 'var(--settings-section-desc)',
      }}
    >
      <RefreshCw size={11} />
      {t('settings.providers.openai.reconnectRequired')}
    </span>
  );
}

function isManagedLocalProvider(id: string): boolean {
  return id === MANAGED_OLLAMA_PROVIDER_ID || id === MANAGED_LLAMACPP_PROVIDER_ID;
}

/** Native sign-ins the add flow always offers, so an unconnected one needs no row of its own. */
const ADD_FLOW_BUILTINS = ['openai', 'anthropic', 'xai'];

/**
 * The rail without unconnected built-ins that "Add provider" can still reach. The others
 * (xd, a kept disconnected connection) are not offered there, so they keep their row.
 */
export function cloudConnectedRail(rail: readonly ProviderView[]): ProviderView[] {
  return rail.filter(
    (p) =>
      !(
        p.source === 'builtin' &&
        ADD_FLOW_BUILTINS.includes(p.id) &&
        !p.connected &&
        p.openAiAccount?.reconnectRequired !== true
      ),
  );
}

/** The local rule for built-in connections that can be removed from the list. */
function supportsConnectionManagement(p: ProviderView): boolean {
  return (
    p.source === 'builtin' &&
    p.id !== 'xd' &&
    (['openai', 'anthropic', 'xai'].includes(p.id) ||
      (p.auth.method === 'oauth' && !!p.auth.oauth) ||
      (p.auth.method === 'apiKey' && isBuiltinApiKeyProviderId(p.id)))
  );
}

/** The subscription badge with the plan name, as the local header shows it. */
function CloudSubscriptionTag({
  provider,
  deviceId,
  product,
}: {
  provider: ProviderView;
  deviceId: string;
  product: string;
}) {
  const { t } = useTranslation();
  const plan = useDeviceProviderSubscriptionCard(provider, deviceId)?.planLabel;
  return (
    <CustomTag
      label={
        plan
          ? plan.toLowerCase().startsWith(product.toLowerCase())
            ? plan
            : `${product} ${plan}`
          : t('settings.providers.models.subscriptionProduct', { product })
      }
    />
  );
}

/**
 * The cloud instance's model providers, composed from the local page's components. The
 * catalog and model management go over the instance's private settings channel; logins,
 * keys and new connections stay on the CIS management tickets. An older runtime, or a
 * viewer who does not own the instance, keeps the ticket-only list.
 */
export function CloudProvidersSettings({
  management = true,
  ...props
}: CloudAuthorizationProps & {
  deviceId: string;
  /** Sharing, joining by link, CLI suggestions and model visibility, as on the local page. */
  management?: boolean;
}) {
  const catalog = useCloudProviderCatalog({
    deviceId: props.deviceId,
    online: props.online,
    active: props.active,
    refresh: props.refresh,
  });
  if (props.trial || !props.deviceId || catalog.status === 'unsupported')
    return (
      <div className="h-full overflow-y-auto pb-32">
        <CloudProviderAuthorization {...props} />
      </div>
    );
  return <CloudProviderCatalogPage {...props} catalog={catalog} management={management} />;
}

function CloudProviderCatalogPage({
  catalog,
  management,
  ...props
}: CloudAuthorizationProps & {
  deviceId: string;
  catalog: ReturnType<typeof useCloudProviderCatalog>;
  management: boolean;
}) {
  const { name, online, deviceId } = props;
  const foreground = useForeground(props.active);
  const auth = useCloudAuthorization(props, 'providers', { all: true });
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const reducedMotion = useReducedMotion();
  const pending = useProviderSharePendingRequests();
  const remote = useDeviceProviders(deviceId);
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [shareProviderId, setShareProviderId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [keyFormFor, setKeyFormFor] = useState<string | null>(null);
  const [addStart, setAddStart] = useState<string | null>(null);
  const [selectedShareId, setSelectedShareId] = useState<string | null>(null);
  const [shares, setShares] = useState<ReceivedSnapshot>({ received: [], loaded: false });
  const shareSupported = catalog.supportedOps.includes('share');
  // Shares as the instance sees them; trust and leaving run on the instance too.
  const loadShares = useCallback(() => {
    if (!shareSupported) return;
    void catalog
      .send({ op: 'share', command: { action: 'received' } })
      .then((receipt) => {
        if (Array.isArray(receipt.value))
          setShares({ received: receipt.value as ReceivedSnapshot['received'], loaded: true });
      })
      .catch(() => undefined);
  }, [shareSupported, deviceId]);
  useEffect(() => loadShares(), [loadShares]);
  const shareSource = useMemo<ProviderShareSource>(
    () => ({
      received: shares,
      command: (async (command: { action: string }) => {
        // The share's quota and usage as the instance (the member) reads them. Instances that
        // do not list `insights` do not run it; this computer's own reading stays the fallback.
        if (command.action === 'insights' && !catalog.shareActions.includes('insights'))
          return window.electronAPI.providerShare.command(
            command as Parameters<typeof window.electronAPI.providerShare.command>[0],
          );
        if (
          command.action !== 'get-credential-consent' &&
          command.action !== 'set-credential-consent' &&
          command.action !== 'leave' &&
          command.action !== 'insights'
        )
          throw new Error('[UNSUPPORTED] not available for the cloud instance');
        const receipt = await catalog.send({
          op: 'share',
          command: command as ShareCommand,
        });
        if (command.action === 'leave') loadShares();
        return receipt.value;
      }) as ProviderShareSource['command'],
    }),
    [shares, loadShares, catalog.send, catalog.shareActions],
  );
  const selectedShare = shares.received.find((share) => share.shareId === selectedShareId) ?? null;
  const [detections, setDetections] = useState<LocalCliDetection[]>([]);
  const scanSupported = management && catalog.supportedOps.includes('cli-scan');
  // The instance's own CLIs, scanned once like the local page; suggestions are optional.
  useEffect(() => {
    if (!scanSupported) return;
    let cancelled = false;
    void catalog
      .send({ op: 'cli-scan' })
      .then((receipt) => {
        const value = receipt.value as { detections?: LocalCliDetection[] } | undefined;
        if (!cancelled) setDetections(Array.isArray(value?.detections) ? value.detections : []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [scanSupported, deviceId]);
  const rail = useMemo(() => {
    const listed = cloudRailProviders(catalog.providers);
    return applyProviderOrder(
      management ? listed : cloudConnectedRail(listed),
      catalog.providerOrder,
    );
  }, [catalog.providers, catalog.providerOrder, management]);
  const list = pendingOrder ? applyProviderOrder(rail, pendingOrder) : rail;
  useEffect(() => setPendingOrder(null), [catalog.providerOrder]);
  const selected = list.find((p) => p.id === selectedId) ?? list[0] ?? null;
  const railIds = new Set(list.map((p) => p.id));
  const unlisted = useMemo(
    () =>
      new Set(
        catalog.providers
          .filter((p) => p.source === 'builtin' && !rail.some((row) => row.id === p.id))
          .map((p) => p.id),
      ),
    [catalog.providers, rail],
  );
  // Same rule as the local page: installed, in the catalog, not connected and not in the rail.
  const suggestions = detections
    .filter((d) => d.installed && !railIds.has(d.providerId))
    .map((d) => ({ detection: d, provider: catalog.providers.find((p) => p.id === d.providerId) }))
    .filter(
      (s): s is { detection: LocalCliDetection; provider: ProviderView } =>
        !!s.provider && !s.provider.connected && !s.provider.removed,
    );
  const itemFor = (p: ProviderView) =>
    auth.items.find((item) => item.id === `provider:${p.id}` || item.id === `builtin-key:${p.id}`);
  const disabled = !online || auth.requesting || auth.loading;

  const persistOrder = (ids: string[]) => {
    if (ids.every((id, index) => id === list[index]?.id)) return;
    setPendingOrder(ids);
    void catalog.write({ op: 'order', providerIds: ids }).then((ok) => {
      if (!ok) {
        setPendingOrder(null);
        toast.error(t('settings.providers.order.saveFailed'));
      }
    });
  };
  const moveWithKeyboard = (id: string, delta: -1 | 1) => {
    const ids = list.map((p) => p.id);
    const index = ids.indexOf(id);
    const next = index + delta;
    if (index < 0 || next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next]!, ids[index]!];
    persistOrder(ids);
  };
  const writeOrToast = async (
    request: Parameters<typeof catalog.write>[0],
    failure = 'settings.providers.models.accessWriteFailed',
  ) => {
    const ok = await catalog.write(request);
    if (!ok) toast.error(t(failure));
    return ok;
  };
  const runAction = (
    item: ManagementItem,
    action: Action,
    values?: Record<string, string>,
    confirmed = false,
  ) =>
    new Promise<Phase>(
      (resolve) =>
        void auth.run(item, action, values, { confirmed, settled: (phase) => resolve(phase) }),
    ).then((phase) => {
      // The instance changed the catalog through its own handlers; reread it.
      void catalog.load();
      return phase;
    });

  const setupApi = useCloudProviderSetup({
    supported:
      catalog.supportedOps.includes('setup-stage') &&
      auth.items.some((item) => item.id === CLOUD_PROVIDER_SETUP_ITEM),
    send: catalog.send,
    auth,
  });
  const setup = setupApi.source;
  const [nativeLogin, setNativeLogin] = useState<string | null>(null);
  const [wizard, setWizard] = useState<null | {
    entry?: WizardEntry;
    detected?: DetectedProviderDraft;
  }>(null);
  const [dialog, setDialog] = useState<
    | null
    | { mode: 'create'; draft?: DetectedProviderDraft }
    | { mode: 'edit'; config: CustomProviderConfig }
  >(null);
  // A runtime with the setup ticket always gets the local wizard: a click before its ticket
  // list is read waits for it instead of opening the older runtimes' dialog.
  const openingAdd = useRef(false);
  const openAdd = async (providerId: string | null) => {
    if (openingAdd.current) return;
    openingAdd.current = true;
    try {
      const ready =
        !!setup ||
        (catalog.supportedOps.includes('setup-stage') &&
          !!(await auth.load())?.some((item) => item.id === CLOUD_PROVIDER_SETUP_ITEM));
      if (ready) {
        setWizard(providerId ? { entry: { kind: 'builtin', providerId } } : {});
        return;
      }
      setAddStart(providerId);
      setAdding(true);
    } finally {
      openingAdd.current = false;
    }
  };
  const editProvider = async (p: ProviderView) => {
    if (!setup) return;
    try {
      // The full view (endpoints included) comes from the instance; keys stay there.
      const view = await setup.readProvider(p.id);
      if (!view) throw new Error('NOT_FOUND');
      setDialog({ mode: 'edit', config: providerViewToCustomProviderConfig(view) });
    } catch {
      toast.error(t('cloudSettings.readFailed'));
    }
  };

  // Cindy AI credential state and actions of the instance, as the local header reads them.
  const [xdStatus, setXdStatus] = useState<ModelAccessStatus | null>(null);
  const [xdBusy, setXdBusy] = useState<string | null>(null);
  const xdSupported = catalog.supportedOps.includes('xd');
  const xdSelected = selected?.id === 'xd';
  useEffect(() => {
    if (!xdSupported || !xdSelected) return;
    let cancelled = false;
    void catalog
      .send({ op: 'xd', action: 'status' })
      .then((receipt) => {
        if (!cancelled) setXdStatus(receipt.value as ModelAccessStatus);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [xdSupported, xdSelected, deviceId, catalog.providers]);
  const xdAction = async (action: 'retry' | 'rotate' | 'disconnect') => {
    if (
      action !== 'retry' &&
      !(await confirm({
        title: t(
          `settings.providers.xd.${action === 'rotate' ? 'rotate' : 'disconnect'}Confirm.title`,
        ),
        description: t(
          `settings.providers.xd.${action === 'rotate' ? 'rotate' : 'disconnect'}Confirm.description`,
        ),
        confirmText: t(
          action === 'rotate'
            ? 'settings.providers.xd.rotateConfirm.confirm'
            : 'settings.providers.button.disconnect',
        ),
        cancelText: t('settings.connections.codex.logoutConfirm.cancel'),
      }))
    )
      return;
    setXdBusy(action);
    try {
      const receipt = await catalog.send({ op: 'xd', action });
      setXdStatus(receipt.value as ModelAccessStatus);
      if (action === 'rotate') toast.success(t('settings.providers.xd.rotateSuccess'));
    } catch {
      if (action === 'rotate') toast.error(t('settings.providers.xd.rotateFailed'));
    } finally {
      setXdBusy(null);
    }
  };

  // Organization connections: the instance's enterprise configuration state and refresh.
  const [byokState, setByokState] = useState<'ready' | 'pending' | 'unavailable' | null>(null);
  const [byokBusy, setByokBusy] = useState(false);
  const byokSupported = catalog.supportedOps.includes('byok');
  const managedId = selected && isOrganizationManagedProvider(selected) ? selected.id : null;
  const byokStateOf = (status: unknown, id: string) =>
    (status as ByokStatus | null)?.providers?.find((item) => item.providerId === id)?.state ??
    'unavailable';
  useEffect(() => setByokState(null), [byokSupported, managedId, deviceId]);
  // Read while the page is shown in a window in front of the user, one call at a time: the
  // next read is scheduled when the previous one settles. A pending configuration is read
  // every 5 s like the local page; a settled one only every 15 s (§8.7). Coming back reads at
  // once.
  const byokPolling = byokSupported && !!managedId && online && props.active && foreground;
  useEffect(() => {
    if (!byokPolling || !managedId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () =>
      void catalog
        .send({ op: 'byok', action: 'status' })
        .then((receipt) => {
          const state = byokStateOf(receipt.value, managedId);
          if (!disposed) setByokState(state);
          return state;
        })
        .catch(() => undefined)
        .then((state) => {
          if (disposed) return;
          timer = setTimeout(read, state && state !== 'pending' ? 15_000 : 5_000);
        });
    read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [byokPolling, managedId, deviceId]);
  const refreshByok = async () => {
    if (byokBusy || !managedId) return;
    setByokBusy(true);
    try {
      const receipt = await catalog.send({ op: 'byok', action: 'retry' });
      setByokState(byokStateOf(receipt.value, managedId));
      if ((receipt.value as ByokStatus | null)?.state === 'failed')
        toast.error(t('settings.providers.byok.refreshFailed'));
    } catch {
      toast.error(t('settings.providers.byok.refreshFailed'));
    } finally {
      setByokBusy(false);
    }
  };

  if (shareProviderId) {
    const provider = catalog.providers.find((p) => p.id === shareProviderId);
    return (
      <ProviderShareManagePage
        key={`${deviceId}:${shareProviderId}`}
        providerId={shareProviderId}
        providerName={provider ? providerDisplayName(provider, t) : shareProviderId}
        providerIcon={provider ? providerIcon(provider, 18) : null}
        deviceId={deviceId}
        deviceName={name}
        remoteProvider={provider}
        gate={providerShareGate({
          remoteControlEnabled: true,
          invocationEnabled: !provider || provider.remoteInvocationEnabled === true,
        })}
        onBack={() => {
          setSelectedId(shareProviderId);
          setShareProviderId(null);
        }}
      />
    );
  }

  const header = (p: ProviderView, children: ReactNode) => {
    const item = itemFor(p);
    const actions = item?.actions ?? [];
    const authorize = actions.find((a) => a.intent === 'authorize');
    const disconnect = actions.find((a) => a.intent === 'disconnect');
    const connectKey = actions.find((a) => a.intent === 'connect' && a.fields.length);
    const remove = actions.find((a) => a.intent === 'delete');
    const loginRunning = auth.busy && auth.operationItem === CLOUD_PROVIDER_SETUP_ITEM;
    const owns =
      (!!item && auth.operationItem === item.id) || (loginRunning && nativeLogin === p.id);
    const loggingIn = owns && auth.busy;
    const reconnectRequired = p.openAiAccount?.reconnectRequired === true;
    const managed = isOrganizationManagedProvider(p);
    const builtinKey =
      p.source === 'builtin' && p.auth.method === 'apiKey' && isBuiltinApiKeyProviderId(p.id);
    const customApiKey =
      p.source === 'user' &&
      !managed &&
      !(p.auth.method === 'oauth' && (!!p.auth.oauth || !!p.auth.native));
    const customOAuth = p.source === 'user' && !managed && !customApiKey;
    // The instance's own Claude Code / Codex / Grok sign-in, as the local headers offer it.
    const native = p.source === 'builtin' && ['anthropic', 'openai', 'xai'].includes(p.id);
    const signIn = (method?: 'browser' | 'device') => {
      if (!setup) {
        if (authorize) void runAction(item!, authorize);
        return;
      }
      setNativeLogin(p.id);
      void setupApi
        .nativeLogin(
          p.id === 'anthropic' ? 'claude' : p.id === 'openai' ? 'codex' : 'xai',
          p.id === 'xai' ? method : undefined,
        )
        .then((result) => {
          if (!result.ok && result.reason !== 'login_cancelled')
            toast.error(t('settings.providers.wizard.authorizeFailed', { name: p.name }));
        })
        .catch(() => toast.error(t('settings.providers.wizard.authorizeFailed', { name: p.name })))
        .finally(() => {
          setNativeLogin(null);
          void catalog.load();
        });
    };
    const xd = p.id === 'xd' ? xdStatus : null;
    const xdServerManaged = xd?.state === 'ok' && xd.source === 'server';
    const status: { kind: 'connected' | 'reconnect-required' | 'neutral'; label?: string } | null =
      p.id === 'xd'
        ? xd?.state === 'unsupported'
          ? { kind: 'neutral', label: t('settings.providers.xd.sync.unsupported') }
          : xd?.state === 'syncing'
            ? { kind: 'neutral', label: t('settings.providers.xd.sync.syncing') }
            : xd?.state === 'failed'
              ? null
              : p.connected
                ? { kind: 'connected' }
                : {
                    kind: 'neutral',
                    label: t(
                      xd?.state === 'disabled'
                        ? 'settings.providers.xd.sync.disabled'
                        : 'settings.providers.xd.sync.autoProvision',
                    ),
                  }
        : managed
          ? byokState === 'ready' || (!byokState && p.agents.length)
            ? { kind: 'connected' }
            : { kind: 'neutral', label: t(`settings.providers.byok.${byokState ?? 'pending'}`) }
          : builtinKey || customApiKey
            ? {
                kind: 'neutral',
                label: t(
                  p.connected
                    ? 'settings.providers.pill.configured'
                    : 'settings.providers.pill.unconfigured',
                ),
              }
            : reconnectRequired
              ? { kind: 'reconnect-required' }
              : p.connected
                ? { kind: 'connected' }
                : native || customOAuth || authorize
                  ? {
                      kind: 'neutral',
                      label: t(
                        loggingIn
                          ? 'settings.providers.pill.connecting'
                          : 'settings.providers.pill.disconnected',
                      ),
                    }
                  : null;
    const cancelLogin = () =>
      void auth.operate('cancel').finally(() => {
        setNativeLogin(null);
      });
    const deviceFlow = p.auth.method === 'oauth' && p.auth.oauth?.flow === 'device-code';
    const primary: { label: string; onClick: () => void; disabled?: boolean } | null = loggingIn
      ? { label: t('settings.providers.button.cancel'), onClick: cancelLogin }
      : managed
        ? byokSupported
          ? {
              label: t('settings.providers.byok.refresh'),
              onClick: () => void refreshByok(),
              disabled: byokBusy,
            }
          : null
        : p.id === 'xd'
          ? null
          : p.connected && !reconnectRequired
            ? // Like the local custom header: only a key-based endpoint offers disconnect.
              customApiKey && (!disconnect || p.auth.method !== 'apiKey')
              ? null
              : disconnect
                ? {
                    label: t('settings.providers.button.disconnect'),
                    onClick: () => void runAction(item!, disconnect),
                  }
                : null
            : customApiKey && setup
              ? {
                  label: t('settings.providers.custom.editAria'),
                  onClick: () => void editProvider(p),
                }
              : native && (setup || authorize)
                ? {
                    label: t(
                      p.id === 'anthropic'
                        ? 'settings.providers.localAccount.useClaude'
                        : p.id === 'openai'
                          ? reconnectRequired
                            ? 'settings.providers.openai.reconnect'
                            : 'settings.providers.openai.connect'
                          : 'settings.providers.button.authorize',
                    ),
                    onClick: () => signIn('browser'),
                  }
                : authorize
                  ? {
                      label: t(
                        reconnectRequired
                          ? 'settings.providers.openai.reconnect'
                          : deviceFlow
                            ? 'settings.providers.wizard.authorizeWithDeviceCode'
                            : 'settings.providers.button.authorize',
                      ),
                      onClick: () => void runAction(item!, authorize),
                    }
                  : connectKey && !p.connected
                    ? {
                        label: t('settings.providers.builtinApiKey.saveKey'),
                        onClick: () => setKeyFormFor(p.id),
                      }
                    : null;
    const canRename = p.id !== 'xd' && !managed;
    const canEdit = !!setup && (customApiKey || (customOAuth && !p.auth.native));
    const builtinRemovable =
      p.source === 'builtin' && p.id !== 'xd' && !managed && supportsConnectionManagement(p);
    const removeProvider = async () => {
      // Same confirmation and feedback as the local page; deleting is never one click.
      const ollama = p.id === MANAGED_OLLAMA_PROVIDER_ID;
      const ok = await confirm({
        title: t(
          ollama
            ? 'settings.providers.local.deleteConfirmTitle'
            : 'settings.providers.custom.deleteConfirm.title',
        ),
        description: ollama
          ? t('settings.providers.local.deleteConfirmBody')
          : t('settings.providers.custom.deleteConfirm.description', { name: p.name }),
        confirmText: t('settings.providers.custom.deleteConfirm.confirm'),
        cancelText: t('settings.providers.custom.deleteConfirm.cancel'),
      });
      if (!ok) return;
      if (remove || (setup && p.source === 'user')) {
        // A custom connection and its keys are deleted on the instance.
        const deleted = remove
          ? (await runAction(item!, remove)) === 'succeeded'
          : await setup!.deleteCustomProvider(p.id).then(
              () => true,
              () => false,
            );
        if (deleted) toast.success(t('settings.providers.custom.toast.deleted'));
        else if (!remove) toast.error(t('settings.providers.custom.toast.deleteFailed'));
        if (!remove) void catalog.load();
        return;
      }
      // A built-in connection is hidden only after its login is gone.
      if (
        p.connected &&
        disconnect &&
        (await runAction(item!, disconnect, undefined, true)) !== 'succeeded'
      )
        return;
      if (
        await writeOrToast(
          { op: 'presentation', providerId: p.id, action: 'remove' },
          'settings.providers.custom.toast.deleteFailed',
        )
      )
        toast.success(t('settings.providers.custom.toast.deleted'));
    };
    const subscriptionProduct = p.access?.kind === 'subscription' ? p.access.product : null;
    const singleAgent =
      p.agents.length === 1
        ? t('settings.providers.detail.singleAgentNote', {
            agent:
              p.agents[0] === 'claude-code' ? 'Claude Code' : p.agents[0] === 'pi' ? 'Pi' : 'Codex',
          })
        : null;
    const accountLine = (source: string, identity?: string | null) =>
      [t(`settings.providers.openai.accountSource.${source}`), identity]
        .filter(Boolean)
        .join(' · ');
    // The local headers' subtitles, by provider kind.
    const subtitle =
      p.id === 'xd'
        ? t('settings.providers.xd.simpleSubtitle')
        : managed
          ? t('settings.providers.byok.managed')
          : p.id === 'anthropic' && p.source === 'builtin'
            ? providerSubtitleForDisplay(p, t('settings.providers.anthropic.modelLabel'), {
                fallback: t('settings.providers.anthropic.subtitle'),
              })
            : p.id === 'openai' && p.source === 'builtin'
              ? p.openAiAccount
                ? accountLine(p.openAiAccount.source, p.openAiAccount.identity)
                : t('settings.providers.openai.subtitle')
              : p.id === 'xai' && p.source === 'builtin'
                ? providerSubtitleForDisplay(p, t('settings.providers.xai.modelLabel'), {
                    fallback: t('settings.providers.xai.subtitle'),
                  })
                : builtinKey
                  ? t('settings.providers.builtinApiKey.subtitle')
                  : p.id === MANAGED_OLLAMA_PROVIDER_ID || p.id === MANAGED_LLAMACPP_PROVIDER_ID
                    ? t('settings.providers.local.subtitle')
                    : customOAuth || (p.source === 'builtin' && p.auth.oauth)
                      ? p.openAiAccount
                        ? accountLine(p.openAiAccount.source, p.openAiAccount.identity)
                        : p.subscriptionAccount
                          ? accountLine('oauth', p.subscriptionAccount.identity)
                          : t('settings.providers.genericOAuth.subtitle')
                      : p.source === 'user'
                        ? customProviderSubtitleForDisplay(p)
                        : providerSubtitleForDisplay(p, '');
    const prompt = owns ? <CloudLoginPrompt auth={auth} disabled={disabled} /> : null;
    const detail =
      owns && (auth.prompt || auth.settling) ? (
        prompt
      ) : keyFormFor === p.id && connectKey && item ? (
        <KeyForm
          disabled={disabled || auth.busy}
          onCancel={() => setKeyFormFor(null)}
          submit={async (apiKey) => {
            if ((await runAction(item, connectKey, { apiKey })) === 'succeeded')
              setKeyFormFor(null);
          }}
        />
      ) : p.id === 'xai' && native && !p.connected && !loggingIn && setup ? (
        <Button variant="secondary" size="md" disabled={disabled} onClick={() => signIn('device')}>
          {t('settings.connections.xai.deviceLogin')}
        </Button>
      ) : p.id === 'xd' && xd?.state === 'failed' ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-[400px] text-13 leading-relaxed text-[var(--text-secondary)]">
            {t('settings.providers.xd.asset.syncFailed')}
          </p>
          <Button
            variant="secondary"
            size="md"
            disabled={disabled}
            onClick={() => void xdAction('retry')}
          >
            {t('settings.providers.xd.sync.retry')}
          </Button>
        </div>
      ) : undefined;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ProviderAccountHeader
          icon={providerIcon(p, 18)}
          title={providerDisplayName(p, t)}
          subtitle={`${subtitle}${singleAgent ? ` · ${singleAgent}` : ''}`}
          badges={
            <>
              {p.id === 'xd' && xd?.accountTier === 'free' && (
                <span
                  data-testid="cindy-ai-free-tier-badge"
                  className="inline-flex shrink-0 items-center rounded-full bg-[var(--surface-chip)] px-2 py-[1px] text-11 font-medium leading-[1.45] text-[var(--text-secondary)]"
                >
                  {t('settings.providers.xd.accountTier.free')}
                </span>
              )}
              {subscriptionProduct && (
                <CloudSubscriptionTag
                  provider={p}
                  deviceId={deviceId}
                  product={subscriptionProduct}
                />
              )}
              {p.suspended && <CustomTag label={t('settings.providers.pill.suspended')} />}
            </>
          }
          actions={
            <>
              {status?.kind === 'connected' ? (
                <ConnectedPill />
              ) : status?.kind === 'reconnect-required' ? (
                <ReconnectRequiredPill />
              ) : status?.label ? (
                <span role="status" className="text-12 text-[var(--text-tertiary)]">
                  {status.label}
                </span>
              ) : null}
              {primary && (
                <Button
                  variant="secondary"
                  size="md"
                  disabled={primary.disabled || disabled || (auth.busy && !owns)}
                  onClick={primary.onClick}
                >
                  {primary.label}
                </Button>
              )}
            </>
          }
          menu={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Tip text={t('settings.providers.detail.moreActionsAria')}>
                  <button
                    type="button"
                    aria-label={t('settings.providers.detail.moreActionsAria')}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--surface-hover)]"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    <MoreHorizontal size={18} />
                  </button>
                </Tip>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canRename && (
                  <DropdownMenuItem disabled={!online} onClick={() => void rename(p)}>
                    <Pencil size={18} className="mr-2.5" />
                    {t('settings.providers.pill.rename')}
                  </DropdownMenuItem>
                )}
                {canEdit && (
                  <DropdownMenuItem
                    disabled={!online || loggingIn}
                    onClick={() => void editProvider(p)}
                  >
                    <Pencil size={18} className="mr-2.5" />
                    {t('settings.providers.custom.editAria')}
                  </DropdownMenuItem>
                )}
                {connectKey && p.connected && (!setup || builtinKey) && (
                  <DropdownMenuItem disabled={!online} onClick={() => setKeyFormFor(p.id)}>
                    <Pencil size={18} className="mr-2.5" />
                    {t('settings.providers.builtinApiKey.replaceKey')}
                  </DropdownMenuItem>
                )}
                {/* Cindy AI credentials, as on the local page (the key itself stays on the instance). */}
                {xdServerManaged && (
                  <DropdownMenuItem disabled={!online} onClick={() => void xdAction('retry')}>
                    <RefreshCw size={14} className="mr-2.5 text-[var(--text-tertiary)]" />
                    {t('settings.providers.xd.sync.refresh')}
                  </DropdownMenuItem>
                )}
                {xdServerManaged && (
                  <DropdownMenuItem
                    disabled={!online || xdBusy !== null}
                    onClick={() => void xdAction('rotate')}
                  >
                    <KeyRound size={14} className="mr-2.5 text-[var(--text-tertiary)]" />
                    {xdBusy === 'rotate'
                      ? t('settings.providers.xd.sync.rotating')
                      : t('settings.providers.xd.sync.rotate')}
                  </DropdownMenuItem>
                )}
                {p.id === 'xd' && p.connected && xd && (
                  <DropdownMenuItem disabled={!online} onClick={() => void xdAction('disconnect')}>
                    <LogOut size={14} className="mr-2.5 text-[var(--text-tertiary)]" />
                    {t('settings.providers.button.disconnect')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  disabled={!online}
                  onClick={() =>
                    void writeOrToast({
                      op: 'model-disable',
                      kind: 'provider',
                      providerId: p.id,
                      disabled: !p.suspended,
                    })
                  }
                >
                  {t(
                    p.suspended
                      ? 'settings.providers.menu.enableProvider'
                      : 'settings.providers.menu.disableProvider',
                  )}
                </DropdownMenuItem>
                {(remove || builtinRemovable || (setup && p.source === 'user')) && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled={!online || auth.busy}
                      onClick={() => void removeProvider()}
                    >
                      <Trash2 size={18} className="mr-2.5" />
                      {t('settings.providers.custom.deleteAria')}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
        <div
          data-testid="provider-detail-scroll"
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain [&>*]:shrink-0"
        >
          {owns && auth.busy && !auth.prompt && auth.phaseText && (
            <p role="status" className="px-5 pb-2 text-13 text-[var(--text-secondary)]">
              {auth.phaseText}
            </p>
          )}
          {detail && <div className="px-5 pb-4">{detail}</div>}
          {p.subscriptionFastPolicy && (
            <div className="px-5 pb-4">
              <SubscriptionFastSetting key={p.id} provider={p} deviceId={deviceId} />
            </div>
          )}
          {p.id === 'xd' ? (
            xd?.state === 'failed' ? null : (
              <CloudXdQuota deviceId={deviceId} online={online} />
            )
          ) : (
            <CloudProviderQuota provider={p} deviceId={deviceId} catalog={catalog} />
          )}
          {children}
        </div>
      </div>
    );
  };

  const rename = async (p: ProviderView) => {
    let next = p.name;
    const ok = await confirm({
      title: t('settings.providers.pill.rename'),
      content: (
        <RenameInput
          initialName={p.name}
          onChange={(value) => {
            next = value;
          }}
        />
      ),
      confirmText: t('settings.providers.custom.save'),
      cancelText: t('settings.providers.custom.cancel'),
    });
    if (!ok || !next.trim()) return;
    await writeOrToast(
      { op: 'presentation', providerId: p.id, action: 'rename', name: next.trim() },
      'settings.providers.custom.toast.saveFailed',
    );
  };

  const refreshModels = async (p: ProviderView) => {
    setRefreshing(p.id);
    try {
      await writeOrToast({
        op: isBuiltinRefreshableProviderId(p.id) ? 'refresh' : 'rediscover',
        providerId: p.id,
      });
    } finally {
      setRefreshing(null);
    }
  };

  return (
    // The real model list, panel and price dialog read and write the instance through this.
    <ModelSettingsSourceContext.Provider value={catalog.source}>
      <ProviderShareSourceContext.Provider value={shareSupported ? shareSource : null}>
        <section
          className="flex h-full min-h-0 flex-col gap-[14px]"
          aria-label={t('settings.providers.title')}
        >
          {/* The local page's header. Joining by link is an account action, as there. */}
          <div className="shrink-0">
            <SettingsPageHeader
              title={t('settings.providers.title')}
              description={t('settings.providers.subtitle')}
              action={management ? <ProviderSharePasteButton /> : undefined}
            />
          </div>
          {auth.failure && auth.failure !== 'readFailed' && (
            <p role="alert" className="text-13 text-[var(--text-secondary)]">
              {t(`cloudSettings.${auth.failure}`)}
            </p>
          )}
          {/* The provider list or its sign-ins could not be read: the client's one notice for a
              model list it cannot update. While reading, nothing. */}
          {(catalog.status === 'unavailable' || auth.readFailure) && (
            <LocalModelCatalogNotice
              failure={{ reason: 'catalog-unavailable' }}
              onRetry={async () => {
                if (auth.readFailure) auth.readFailure.reload();
                if (catalog.status === 'unavailable') await catalog.load();
                return true;
              }}
            />
          )}
          {catalog.status === 'ready' && (
            <div
              className="flex min-h-0 flex-1 overflow-hidden rounded-xl border"
              style={{
                backgroundColor: 'var(--settings-theme-card-bg)',
                borderColor: 'var(--settings-theme-card-border)',
              }}
            >
              <div
                className="flex w-[224px] shrink-0 flex-col border-r"
                style={{ borderColor: 'var(--settings-theme-card-border)' }}
              >
                <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
                  {list.length > 1 && (
                    <div className="select-none px-1.5 pb-1 pt-1">
                      <span className="text-11" style={{ color: 'var(--text-tertiary)' }}>
                        {t('settings.providers.order.hint')}
                      </span>
                    </div>
                  )}
                  <SortableList
                    items={list}
                    getId={(p) => p.id}
                    onReorder={persistOrder}
                    renderItem={(p, index) => (
                      <RailRow
                        provider={p}
                        selected={selected?.id === p.id}
                        onSelect={() => {
                          setSelectedShareId(null);
                          setSelectedId(p.id);
                        }}
                        position={index + 1}
                        total={list.length}
                        onMove={(delta) => moveWithKeyboard(p.id, delta)}
                        sortable={list.length > 1 && online}
                      />
                    )}
                    disabled={list.length < 2 || !online}
                    reducedMotion={reducedMotion}
                    filter="input, textarea, select, a, [data-no-drag]"
                    className="flex flex-col gap-0.5"
                    rowClassName="provider-settings-sortable-row"
                  />
                  {/* Only the instance's own list; never this computer's shares in its place. */}
                  {shareSupported && (
                    <ProviderShareReceivedRailGroup
                      selectedShareId={selectedShare?.shareId ?? null}
                      onSelect={(shareId) => setSelectedShareId(shareId)}
                    />
                  )}
                  {suggestions.length > 0 && (
                    <>
                      {/* Not uppercased like the local label: this one carries the product name. */}
                      <span
                        className="px-2.5 pb-1 pt-3 text-11 font-medium"
                        style={{ color: 'var(--text-tertiary)', letterSpacing: '0.5px' }}
                      >
                        {t('cloudSettings.cliDetect.groupLabel')}
                      </span>
                      {suggestions.map((s) => (
                        <SuggestionRow
                          key={s.detection.cli}
                          detection={s.detection}
                          provider={s.provider}
                          disabled={!online}
                          onClick={() => void openAdd(s.provider.id)}
                        />
                      ))}
                    </>
                  )}
                </div>
                <div
                  id="settings-search-settings-providers-addProvider"
                  className="border-t p-2"
                  style={{ borderColor: 'var(--settings-theme-card-border)' }}
                >
                  <Button
                    variant="secondary"
                    size="lg"
                    type="button"
                    disabled={!online}
                    onClick={() => void openAdd(null)}
                    className="w-full"
                  >
                    <Plus size={15} />
                    {t('settings.providers.addProvider')}
                  </Button>
                </div>
              </div>
              <div
                key={selectedShare ? `share:${selectedShare.shareId}` : selected?.id}
                className="flex min-h-0 min-w-0 flex-1 flex-col"
              >
                {selectedShare ? (
                  <ProviderShareReceivedDetail share={selectedShare} />
                ) : (
                  selected &&
                  header(
                    selected,
                    <>
                      {selected.suspended && (
                        <div
                          className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-5 py-3 text-13"
                          style={{ borderColor: 'var(--settings-theme-card-border)' }}
                        >
                          <span style={{ color: 'var(--text-tertiary)' }}>
                            {t('settings.providers.detail.suspendedBanner')}
                          </span>
                          <Button
                            variant="secondary"
                            size="md"
                            disabled={!online}
                            onClick={() =>
                              void writeOrToast({
                                op: 'model-disable',
                                kind: 'provider',
                                providerId: selected.id,
                                disabled: false,
                              })
                            }
                          >
                            {t('settings.providers.button.enableProvider')}
                          </Button>
                        </div>
                      )}
                      {management &&
                        !selected.suspended &&
                        selected.connected &&
                        selected.agents.length > 0 &&
                        selected.remoteInvocationEnabled !== undefined && (
                          <CloudRemoteAccessRow
                            key={selected.id}
                            provider={selected}
                            disabled={!online}
                            groupSize={(() => {
                              const view = remote.providers.find((p) => p.id === selected.id);
                              const group = view ? remoteProviderGroupOf(view) : null;
                              return group ? providerGroupDeviceCount(group.members) : null;
                            })()}
                            pendingShareRequests={
                              pending.filter(
                                (request) =>
                                  request.hostDeviceId === deviceId &&
                                  request.share.providerId === selected.id,
                              ).length
                            }
                            onManageShare={() => setShareProviderId(selected.id)}
                            write={(enabled) =>
                              catalog.write({
                                op: 'remote-access',
                                providerId: selected.id,
                                enabled,
                              })
                            }
                          />
                        )}
                      {!selected.suspended &&
                        catalog.source &&
                        (providerHasModels(selected) ||
                          isCustomRoutedProvider(selected) ||
                          isBuiltinRefreshableProviderId(selected.id)) && (
                          <>
                            <div
                              className="border-t"
                              style={{ borderColor: 'var(--settings-theme-card-border)' }}
                            />
                            <UnifiedModelList
                              provider={selected}
                              visibilityControls={management}
                              emptyMessage={
                                selected.source === 'user' && selected.modelDiscoveryFailure
                                  ? t(
                                      `settings.providers.detail.discoveryFailed.${selected.modelDiscoveryFailure.kind}`,
                                    )
                                  : t(
                                      selected.connected
                                        ? 'settings.providers.detail.emptyModelsConnected'
                                        : 'settings.providers.detail.emptyModels',
                                    )
                              }
                              compactWhenEmpty={isManagedLocalProvider(selected.id)}
                              compact={isManagedLocalProvider(selected.id)}
                              {...(isBuiltinRefreshableProviderId(selected.id) ||
                              (selected.source === 'user' &&
                                selected.id !== MANAGED_LLAMACPP_PROVIDER_ID)
                                ? {
                                    onRefresh: () => void refreshModels(selected),
                                    refreshing: refreshing === selected.id,
                                    refreshDisabled: refreshing !== null || !online,
                                    ...(isBuiltinRefreshableProviderId(selected.id)
                                      ? {
                                          refreshIdleLabel: t(
                                            'settings.providers.models.refreshBuiltinAria',
                                          ),
                                        }
                                      : {}),
                                  }
                                : {})}
                            />
                          </>
                        )}
                    </>,
                  )
                )}
              </div>
            </div>
          )}
          {/* The local wizard and connection form, writing the instance. */}
          {setup && (
            <ProviderSetupSourceContext.Provider value={setup}>
              {wizard && (
                <AddProviderWizard
                  providers={catalog.providers}
                  entry={wizard.entry}
                  detected={wizard.detected}
                  onReturnCustom={(draft) => {
                    setWizard(null);
                    setDialog({ mode: 'create', draft });
                  }}
                  onOpenCustomForm={() => {
                    setWizard(null);
                    setDialog({ mode: 'create' });
                  }}
                  onClose={() => setWizard(null)}
                  onDone={async (providerId) => {
                    await catalog.load();
                    setWizard(null);
                    if (providerId) setSelectedId(providerId);
                  }}
                />
              )}
              {dialog && (
                <ProviderConnectionDialog
                  draft={dialog.mode === 'create' ? dialog.draft : undefined}
                  onDetected={(detected) => {
                    setDialog(null);
                    setWizard({ detected });
                  }}
                  initial={dialog.mode === 'edit' ? dialog.config : undefined}
                  catalogModels={
                    dialog.mode === 'edit'
                      ? catalog.providers.find(
                          (p) =>
                            p.source === 'user' &&
                            storedCustomProviderId(p.id) === dialog.config.id,
                        )?.models
                      : undefined
                  }
                  existingIds={catalog.providers.map((p) => p.id)}
                  onClose={() => setDialog(null)}
                  onSaved={() => {
                    setDialog(null);
                    void catalog.load();
                  }}
                />
              )}
            </ProviderSetupSourceContext.Provider>
          )}
          <CloudAddProviderDialog
            open={adding}
            onOpenChange={(next) => {
              setAdding(next);
              if (!next) setAddStart(null);
            }}
            auth={auth}
            disabled={disabled}
            run={runAction}
            unlisted={unlisted}
            start={addStart}
          />
        </section>
      </ProviderShareSourceContext.Provider>
    </ModelSettingsSourceContext.Provider>
  );
}

/** The local built-in API key editor: the key is typed here and stored on the instance. */
function KeyForm({
  disabled,
  onCancel,
  submit,
}: {
  disabled: boolean;
  onCancel: () => void;
  submit: (apiKey: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [key, setKey] = useState('');
  return (
    <form
      className="flex flex-col gap-2"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        const value = key.trim();
        if (!value || disabled) return;
        setKey('');
        void submit(value);
      }}
    >
      <SettingsTextInput
        aria-label={t('settings.providers.custom.fields.apiKey')}
        type="password"
        autoComplete="new-password"
        spellCheck={false}
        placeholder={t('settings.providers.builtinApiKey.keyPlaceholder')}
        value={key}
        maxLength={1024}
        disabled={disabled}
        onChange={setKey}
      />
      <div className="flex gap-2">
        <Button type="submit" variant="secondary" size="md" disabled={disabled || !key.trim()}>
          {t('settings.providers.builtinApiKey.saveKey')}
        </Button>
        <Button type="button" variant="secondary" size="md" onClick={onCancel}>
          {t('settings.providers.button.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** The detection row: the instance's CLI is installed and its provider is not connected. The local
 * page's copy says "this computer", which here would mean the wrong one. */
function SuggestionRow({
  detection,
  provider,
  disabled,
  onClick,
}: {
  detection: LocalCliDetection;
  provider: ProviderView;
  disabled: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const cliName = localCliDisplayName(detection.cli);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={t(
        detection.loggedIn
          ? 'cloudSettings.cliDetect.hintLoggedIn'
          : 'cloudSettings.cliDetect.hintInstalled',
        { cli: cliName },
      )}
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[var(--settings-menu-bg-hover)]"
    >
      <div
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg opacity-70"
        style={{
          backgroundColor: 'var(--settings-integration-avatar-bg)',
          border: '1px solid var(--settings-integration-avatar-border)',
          color: 'var(--settings-integration-avatar-icon)',
        }}
      >
        {providerIcon(provider, 14)}
      </div>
      <span className="min-w-0 flex-1 truncate text-13" style={{ color: 'var(--text-secondary)' }}>
        {providerDisplayName(provider, t)}
      </span>
      <span
        className="flex h-[22px] shrink-0 items-center rounded-full border px-2.5 text-11 font-medium"
        style={{
          borderColor: 'var(--settings-btn-secondary-border)',
          color: 'var(--text-secondary)',
        }}
      >
        {t('cloudSettings.cliDetect.action')}
      </span>
    </button>
  );
}

function RenameInput({
  initialName,
  onChange,
}: {
  initialName: string;
  onChange: (name: string) => void;
}) {
  const [value, setValue] = useState(initialName);
  return (
    <SettingsTextInput
      value={value}
      maxLength={128}
      autoFocus
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

function RailRow({
  provider,
  selected,
  onSelect,
  position,
  total,
  onMove,
  sortable,
}: {
  provider: ProviderView;
  selected: boolean;
  onSelect: () => void;
  position: number;
  total: number;
  onMove: (delta: -1 | 1) => void;
  sortable: boolean;
}) {
  const { t } = useTranslation();
  const modelCount = useMemo(
    () => (providerHasModels(provider) ? buildUnionRows(provider).length : null),
    [provider],
  );
  const title = providerDisplayName(provider, t);
  const reconnectRequired = provider.openAiAccount?.reconnectRequired === true;
  return (
    <div
      className={cn(
        'relative flex w-full items-center rounded-lg text-left transition-colors',
        selected
          ? 'bg-[var(--settings-menu-bg-selected)]'
          : 'hover:bg-[var(--settings-menu-bg-hover)]',
      )}
    >
      {sortable && (
        <button
          type="button"
          className="provider-order-handle absolute inset-y-0 left-0 z-[1] my-auto flex h-9 w-3 cursor-grab items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring-soft)]"
          aria-label={t('settings.providers.order.handle', { provider: title, position, total })}
          aria-keyshortcuts="ArrowUp ArrowDown"
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            onMove(event.key === 'ArrowUp' ? -1 : 1);
          }}
          style={{ color: 'var(--text-tertiary)' }}
        >
          <GripVertical size={12} />
        </button>
      )}
      <Tip text={title} side="right" contentClassName="max-w-[360px] break-words">
        <ProviderListEntry
          title={title}
          icon={providerIcon(provider, 14)}
          selected={selected}
          onSelect={onSelect}
          muted={provider.suspended}
          annotation={
            reconnectRequired ? (
              <span
                className="shrink-0 select-none text-11"
                style={{ color: 'var(--settings-integration-warning)' }}
              >
                {t('settings.providers.openai.reconnectRequired')}
              </span>
            ) : provider.suspended ? (
              <span
                className="shrink-0 select-none text-11"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {t('settings.providers.pill.suspended')}
              </span>
            ) : (
              provider.id !== 'xd' &&
              modelCount !== null && (
                <span
                  className="shrink-0 text-11 tabular-nums"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  {t('settings.providers.models.modelCount', { count: modelCount })}
                </span>
              )
            )
          }
          statusColor={
            reconnectRequired
              ? 'var(--remote-status-failed)'
              : provider.connected && !provider.suspended
                ? 'var(--remote-status-ready)'
                : 'var(--border-default)'
          }
        />
      </Tip>
    </div>
  );
}

/** The local remote-access row, writing the instance's setting. The instance always accepts remote control. */
function CloudRemoteAccessRow({
  provider,
  disabled,
  groupSize,
  pendingShareRequests,
  onManageShare,
  write,
}: {
  provider: ProviderView;
  disabled: boolean;
  groupSize: number | null;
  pendingShareRequests: number;
  onManageShare: () => void;
  write: (enabled: boolean) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(provider.remoteInvocationEnabled === true);
  const [busy, setBusy] = useState(false);
  useEffect(
    () => setEnabled(provider.remoteInvocationEnabled === true),
    [provider.remoteInvocationEnabled],
  );
  const gate = providerShareGate({ remoteControlEnabled: true, invocationEnabled: enabled });
  return (
    <div
      data-testid="provider-remote-access"
      data-share-gate={gate}
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t px-5 py-3"
      style={{ borderColor: 'var(--settings-theme-card-border)' }}
    >
      <div className="flex min-w-[min(100%,240px)] flex-1 flex-col gap-1">
        <span className="text-13 font-medium text-[var(--text-primary)]">
          {t('settings.providers.detail.remoteAccess.label')}
        </span>
        <span className="text-12 leading-[1.4] text-[var(--text-tertiary)]">
          {gate === 'invocation-off'
            ? t('providerShare.entry.descriptionOff')
            : groupSize !== null
              ? t('settings.providers.detail.remoteAccess.descriptionGroup')
              : t('settings.providers.detail.remoteAccess.description')}
        </span>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-3">
        <ProviderShareEntryButton
          groupSize={groupSize}
          pendingCount={pendingShareRequests}
          onOpen={onManageShare}
        />
        <Switch
          checked={enabled}
          disabled={busy || disabled}
          aria-label={t('settings.providers.detail.remoteAccess.ariaLabel')}
          onCheckedChange={(next) => {
            const previous = enabled;
            setEnabled(next);
            setBusy(true);
            void write(next)
              .then((ok) => {
                if (ok) return;
                setEnabled(previous);
                toast.error(t('settings.providers.detail.remoteAccess.writeFailed'));
              })
              .finally(() => setBusy(false));
          }}
        />
      </div>
    </div>
  );
}

/** The instance's Codex rate limits, read like the local panel's (no push updates). */
function useCloudCodexRateLimits(
  send: (request: CloudProviderWrite) => Promise<CloudProviderSettingsWriteReceipt>,
  providerId: string,
  enabled: boolean,
) {
  const [snapshot, setSnapshot] = useState<MobileCodexRateLimitsResult | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(() => {
    if (!enabled) return;
    const id = ++sequence.current;
    void send({ op: 'codex-limits', ...(providerId !== 'openai' ? { providerId } : {}) })
      .then((receipt) => {
        const next = receipt.value as MobileCodexRateLimitsResult | null;
        if (id !== sequence.current || !next) return;
        if (providerId !== 'openai' && next.providerId !== providerId) return;
        setSnapshot(next);
      })
      .catch(() => undefined);
  }, [enabled, providerId, send]);
  useEffect(() => {
    setSnapshot(null);
    refresh();
  }, [refresh]);
  return { snapshot: enabled ? snapshot : null, refresh };
}

/** The local header's usage module: subscription quota (with Codex resets) or account balance. */
function CloudProviderQuota({
  provider,
  deviceId,
  catalog,
}: {
  provider: ProviderView;
  deviceId: string;
  catalog: ReturnType<typeof useCloudProviderCatalog>;
}) {
  const { t } = useTranslation();
  const account = useDeviceProviderSubscriptionCard(provider, deviceId);
  const resetEnabled =
    !!account &&
    catalog.supportedOps.includes('codex-limits') &&
    providerWeeklyQuotaSource({ ...provider, suspended: false }) === 'codex';
  const limits = useCloudCodexRateLimits(catalog.send, provider.id, resetEnabled);
  const manualReset = useCodexRateLimitReset(
    limits.snapshot,
    limits.refresh,
    provider.id,
    async (idempotencyKey, providerId) =>
      (
        await catalog.send({
          op: 'codex-reset',
          idempotencyKey,
          ...(providerId && providerId !== 'openai' ? { providerId } : {}),
        })
      ).value as never,
  );
  const usageReader = useMemo(
    () =>
      catalog.supportedOps.includes('account-usage')
        ? async ({ providerId, forceRefresh }: { providerId: string; forceRefresh: boolean }) =>
            (await catalog.send({ op: 'account-usage', providerId, forceRefresh }))
              .value as ProviderAccountUsageResult
        : undefined,
    [catalog.supportedOps, catalog.send],
  );
  if (!account)
    return usageReader ? (
      <ProviderAccountUsageModule provider={provider} reader={usageReader} />
    ) : null;
  const subscriptionProduct =
    provider.access?.kind === 'subscription' ? provider.access.product : null;
  const claude = provider.id === 'anthropic' || provider.auth.native === 'claude';
  const xai = provider.id === 'xai' || provider.auth.native === 'xai';
  return (
    <div
      data-testid="provider-usage-module"
      className="border-t px-1 py-2"
      style={{ borderColor: 'var(--settings-theme-card-border)' }}
    >
      <QuotaHoverCard
        variant="embedded"
        hideIdentity={Boolean(subscriptionProduct)}
        account={account}
        dashboardLabel={
          claude
            ? t('settings.providers.usage.openClaudeUsage')
            : xai
              ? t('settings.providers.xai.asset.openUsage')
              : undefined
        }
        onOpenDashboard={
          claude
            ? () => void window.electronAPI.openExternal('https://claude.ai/settings/usage')
            : xai
              ? () => void window.electronAPI.openExternal('https://grok.com')
              : undefined
        }
      >
        {resetEnabled ? (
          <CodexResetCredits
            providerId={provider.id}
            onChanged={limits.refresh}
            variant="embedded"
            snapshot={limits.snapshot}
            busy={manualReset.busy}
            canReset={manualReset.canReset}
            canRetry={manualReset.canRetry}
            onReset={(credit) => void manualReset.reset(credit)}
          />
        ) : null}
      </QuotaHoverCard>
    </div>
  );
}
