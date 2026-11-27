/** Exact one-shot catalog pins rendered through the shared model picker. */
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentKind, ProviderView } from '@cindy/model-providers';
import { ModelSelector } from '@/components/new-chat/ModelSelector';
import { PROVIDER_TITLE_KEY, providerDisplayName } from '@/lib/providerDisplayName';
import { decodeCatalogModelPin } from '../../shared/catalogModelPin';
import { decodeRemoteAuxiliaryModelRef, isRemoteAuxiliaryModelRef } from '../../shared/remoteAuxiliaryModelRef';
import type { ModelSelectorRouteFilter } from '@/components/new-chat/modelSelectorRouteFilter';
import { useTransientModelPickerPreferences } from '@/components/new-chat/modelPickerPreferences';

/** 主侧下发的目录钉条目(与 TextOneshotPinOption 同形;系统辅助模型设置使用)。 */
export interface OneshotPinOption {
  id: string;
  label: string;
  group: string;
  providerId: string;
  agentKind: string;
  modelId: string;
  modelName: string;
  defaultEnabled?: boolean;
  icon?: string;
  budget: boolean;
  subscription: boolean;
  /** Provider['routing'](IPC 载荷;ProviderLogoMark 的厂牌图标判定用)。 */
  routing?: import('@cindy/model-providers').Provider['routing'];
  logoKind?: ProviderView['logoKind'];
  customIcon?: ProviderView['customIcon'];
  /** Agent used by this exact route. Older snapshots may omit it. */
  agentSuffix?: string;
  /** False for a persisted route that is no longer offered or currently usable. */
  available?: boolean;
}


function knownAgent(value: string): value is AgentKind {
  return value === 'claude-code' || value === 'codex' || value === 'pi';
}

/** This projection only contains host-approved pins; it never expands the allowlist. */
export function oneshotPickerProviders(options: readonly OneshotPinOption[]): ProviderView[] {
  const providers = new Map<string, ProviderView>();
  for (const option of options) {
    if (option.available === false || !knownAgent(option.agentKind)) continue;
    let provider = providers.get(option.providerId);
    if (!provider) {
      provider = {
        id: option.providerId, name: option.group, source: 'builtin',
        logoKind: option.logoKind,
        ...(option.customIcon ? { customIcon: option.customIcon } : {}),
        auth: { method: 'none' }, connected: true, agents: [], routing: {}, models: {},
      };
      providers.set(option.providerId, provider);
    }
    const agent = option.agentKind;
    if (!provider.agents.includes(agent)) provider.agents.push(agent);
    provider.routing[agent] = option.routing?.[agent] ?? provider.routing[agent] ?? {
      // A display-only catalog projection; execution resolves this exact pin again in main.
      upstream: '', authStrategy: 'none',
    };
    const models = provider.models[agent] ??= [];
    if (!models.some((model) => model.id === option.modelId)) {
      models.push({ id: option.modelId, name: option.modelName, icon: option.icon,
        contextWindow: 0, efforts: [], defaultEffort: null, mode: 'chat', defaultEnabled: true });
    }
  }
  return [...providers.values()].map((provider) => ({
    ...provider,
    ...(options.filter((option) => option.providerId === provider.id && option.available !== false)
      .every((option) => option.subscription) ? { access: { kind: 'subscription' as const, product: provider.name } } : {}),
  }));
}

export function OneshotModelPinPicker({
  value, options, onChange, ariaLabel, 'data-setting-id': settingId,
  dense, defaultOptionLabel, unavailableLabel, disabled, groupByProvider = false, remote,
}: {
  /** 当前钉值;undefined = 跟随默认。 */
  value?: string;
  'data-setting-id'?: string;
  options: readonly OneshotPinOption[];
  /** null = 清除钉档(恢复跟随默认)。 */
  onChange: (pin: string | null) => void | boolean | Promise<void | boolean>;
  ariaLabel: string;
  /** 紧凑字号(设置页 12px;插件详情页 13px)。 */
  dense?: boolean;
  /** Copy for the "no pin" row (the caller's automatic route). */
  defaultOptionLabel: string;
  searchPlaceholder?: string;
  noResultsLabel?: string;
  unavailableLabel?: string;
  budgetLabel?: string;
  subscriptionLabel?: string;
  disabled?: boolean;
  /** Show all routable models in provider groups without exposing the Agent rail. */
  groupByProvider?: boolean;
  remote?: {
    devices: readonly { deviceId: string; name: string; online: boolean }[];
    open: boolean;
    allows: ModelSelectorRouteFilter;
    encode: (deviceId: string, providerId: string, agent: 'codex' | 'claude-code' | 'pi', model: string) => string | null;
    onOpenChange: (open: boolean) => void;
  };
}): ReactNode {
  const { t } = useTranslation();
  const preferenceStore = useTransientModelPickerPreferences(undefined, { inheritEngines: false });
  const current = value ? options.find((option) => option.id === value) : undefined;
  const remoteRoute = value ? decodeRemoteAuxiliaryModelRef(value) : null;
  const reserved = value ? isRemoteAuxiliaryModelRef(value) : false;
  const decoded = value && !reserved ? decodeCatalogModelPin(value) : null;
  const route = remoteRoute ? { ...remoteRoute, modelId: remoteRoute.model }
    : reserved ? null : current ?? (decoded ? { ...decoded, modelId: decoded.model } : null);
  const providers = useMemo(() => oneshotPickerProviders(options.filter((option) => !isRemoteAuxiliaryModelRef(option.id))).map((provider) => ({
    ...provider,
    name: provider.id === 'xd' ? providerDisplayName(provider, t)
      : groupByProvider && PROVIDER_TITLE_KEY[provider.id]
        ? t(PROVIDER_TITLE_KEY[provider.id]!) : provider.name,
  })), [options, groupByProvider, t]);
  const currentAgent = route && knownAgent(route.agentKind) ? route.agentKind : undefined;
  const vendor = currentAgent === 'claude-code' ? 'cc' : currentAgent;
  const unavailable = !!value && (remoteRoute
    ? !remote?.devices.some((device) => device.deviceId === remoteRoute.deviceId && device.online)
      || (remote.open && !remote.allows(remoteRoute))
    : reserved || !current || current.available === false);
  const remoteDevices = remote?.devices.filter((device) => device.online || device.deviceId === remoteRoute?.deviceId) ?? [];
  return <ModelSelector
    data-setting-id={settingId}
    {...(remote ? { remoteAgent: { devices: remoteDevices, selectedDeviceId: remoteRoute?.deviceId ?? null } }
      : { localOnlyReason: 'one-shot-local-request' as const })}
    deviceId={remoteRoute?.deviceId}
    agentDevice={remoteRoute ? { deviceId: remoteRoute.deviceId,
      name: remoteDevices.find((device) => device.deviceId === remoteRoute.deviceId)?.name ?? remoteRoute.deviceId } : null}
    onOpenChange={remote?.onOpenChange}
    preferenceStore={remote ? preferenceStore : undefined}
    showRemoteSourceLabel={!!remoteRoute}
    routeFilter={remote ? (identity) => identity.deviceId ? remote.allows(identity)
      : options.some((option) => !isRemoteAuxiliaryModelRef(option.id) && option.available !== false
        && option.providerId === identity.providerId && option.agentKind === identity.agentKind && option.modelId === identity.model) : undefined}
    providersOverride={providers}
    modelId={route?.modelId ?? value ?? ''}
    currentProviderId={route?.providerId ?? null}
    vendorKey={vendor}
    effort=""
    onEffortChange={() => undefined}
    onModelChange={() => false}
    onUnifiedSelect={async ({ providerId, modelId, engine, agentDevice }) => {
      const agent = engine === 'cc' ? 'claude-code' : engine;
      if (agentDevice) {
        const pin = remote?.encode(agentDevice.deviceId, providerId, agent, modelId);
        if (!pin) return false;
        return pin === value || (await onChange(pin)) !== false;
      }
      const option = options.find((item) => !isRemoteAuxiliaryModelRef(item.id) && item.providerId === providerId &&
        item.agentKind === agent && item.modelId === modelId && item.available !== false);
      if (!option) return false;
      if (option.id !== value) return (await onChange(option.id)) !== false;
      return true;
    }}
    // This is a one-shot API route, not an Agent configuration.
    configurationEnabled={false}
    fastModeConfigurable={false}
    triggerVariant="field"
    popoverSide="bottom"
    dense={dense}
    disabled={disabled}
    ariaContext={ariaLabel}
    unknownModelLabel={() => remoteRoute?.model ?? (reserved ? unavailableLabel ?? defaultOptionLabel : current?.modelName ?? value ?? defaultOptionLabel)}
    sourceDisconnected={unavailable}
    fallbackOption={{ active: value === undefined, label: defaultOptionLabel,
      onSelect: () => value !== undefined ? onChange(null) : undefined }}
  />;
}
