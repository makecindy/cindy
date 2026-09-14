/** Exact one-shot catalog pins rendered through the shared model picker. */
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentKind, ProviderView } from '@cindy/model-providers';
import { ModelSelector } from '@/components/new-chat/ModelSelector';
import { PROVIDER_TITLE_KEY } from '@/lib/providerDisplayName';
import { decodeCatalogModelPin } from '../../shared/catalogModelPin';

/** 主侧 cindy-prefs 下发的目录钉条目(与 TextOneshotPinOption 同形)。 */
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
  value, defaultLabel, declaredLabel, legacyPinLabel, options, onChange, ariaLabel,
  dense, defaultOptionLabel, disabled, groupByProvider = false,
}: {
  /** 当前钉值;undefined = 跟随默认。 */
  value?: string;
  /** 系统默认链链首的展示文案(未声明偏好时"跟随默认"行用)。 */
  defaultLabel: string;
  /** 身份卡声明的偏好模型文案(声明存在时"跟随默认"行如实显示它)。 */
  declaredLabel: string | null;
  /** 存量轻量档位钉(目录扩展前钉下的合法档位键)的展示名;null/缺省 = 不是档位钉。 */
  legacyPinLabel?: string | null;
  options: readonly OneshotPinOption[];
  /** null = 清除钉档(恢复跟随默认)。 */
  onChange: (pin: string | null) => void | boolean | Promise<void | boolean>;
  ariaLabel: string;
  /** 紧凑字号(设置页 12px;插件详情页 13px)。 */
  dense?: boolean;
  /** Generic settings surfaces can supply their own automatic-route copy. */
  defaultOptionLabel?: string;
  searchPlaceholder?: string;
  noResultsLabel?: string;
  unavailableLabel?: string;
  budgetLabel?: string;
  subscriptionLabel?: string;
  disabled?: boolean;
  /** Show all routable models in provider groups without exposing the Agent rail. */
  groupByProvider?: boolean;
}): ReactNode {
  const { t } = useTranslation();
  const current = value ? options.find((option) => option.id === value) : undefined;
  const decoded = value ? decodeCatalogModelPin(value) : null;
  const route = current ?? (decoded ? { ...decoded, modelId: decoded.model } : null);
  const automaticLabel = defaultOptionLabel ?? (declaredLabel
    ? t('settings.ghosts.detail.cindyPrefs.defaultOptionDeclared', { model: declaredLabel })
    : t('settings.ghosts.detail.cindyPrefs.defaultOption', { model: defaultLabel }));
  const providers = useMemo(() => oneshotPickerProviders(options).map((provider) => ({
    ...provider,
    name: groupByProvider && PROVIDER_TITLE_KEY[provider.id]
      ? t(PROVIDER_TITLE_KEY[provider.id]!) : provider.name,
  })), [options, groupByProvider, t]);
  const currentAgent = route && knownAgent(route.agentKind) ? route.agentKind : undefined;
  const vendor = currentAgent === 'claude-code' ? 'cc' : currentAgent;
  const unavailable = !!value && !legacyPinLabel && (!current || current.available === false);
  return <ModelSelector
    providersOverride={providers}
    modelId={route?.modelId ?? value ?? ''}
    currentProviderId={route?.providerId ?? null}
    vendorKey={vendor}
    effort=""
    onEffortChange={() => undefined}
    onModelChange={() => false}
    onUnifiedSelect={async ({ providerId, modelId, engine }) => {
      const agent = engine === 'cc' ? 'claude-code' : engine;
      const option = options.find((item) => item.providerId === providerId &&
        item.agentKind === agent && item.modelId === modelId && item.available !== false);
      if (!option) return false;
      if (option.id !== value) return (await onChange(option.id)) !== false;
      return true;
    }}
    // Exact pins include a Harness. Keep its chooser; the projected catalog has no effort/Fast controls.
    configurationEnabled
    triggerVariant="field"
    popoverSide="bottom"
    dense={dense}
    disabled={disabled}
    ariaContext={ariaLabel}
    unknownModelLabel={() => legacyPinLabel ?? current?.modelName ?? value ?? automaticLabel}
    sourceDisconnected={unavailable}
    fallbackOption={{ active: value === undefined, label: automaticLabel,
      onSelect: () => value !== undefined ? onChange(null) : undefined }}
  />;
}
