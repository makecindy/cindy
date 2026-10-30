import { Button } from '@/components/ui/button';
import { Fragment, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';

import { DefaultOverrideControls } from '@/components/settings/DefaultOverrideControls';
import {
  SETTINGS_ROW_CLASS,
  SETTINGS_ROW_DIVIDER_CLASS,
  SETTINGS_ROW_HINT_CLASS,
  SETTINGS_ROW_LABEL_CLASS,
} from '@/components/settings/settingsRowClasses';
import { cn } from '@/lib/utils';
import type { AgentKind } from '@/hooks/useAgentCapabilities';
import { useDeviceProviders } from '@/hooks/useDeviceProviders';
import { providerAccountLabel, providerDisplayName } from '@/lib/providerDisplayName';
import { ModelRouteSelector } from '@/components/new-chat/ModelRouteSelector';
import type { MakerVendor } from '@/lib/ccAgent.types';
import {
  BOT_MODEL_CHAIN_MAX,
  type BotHarness,
  type BotModelRoute,
} from '../../../shared/botModelChain';
import { useBotTranslation } from './botPronounContext';

function vendorFor(harness: BotHarness): 'cc' | 'codex' | 'pi' {
  return harness === 'claude' ? 'cc' : harness;
}

function harnessFor(vendor: 'cc' | 'codex' | 'pi'): BotHarness {
  return vendor === 'cc' ? 'claude' : vendor;
}

function agentKindFor(vendor: 'cc' | 'codex' | 'pi'): AgentKind {
  return vendor === 'cc' ? 'claude-code' : vendor;
}

export function BotModelChainEditor({
  value,
  onChange: onValueChange,
  disabled = false,
  hiddenVendors = [],
  remote = false,
  deviceId,
  label,
  onRestoreDefault,
  onNavigateToProviders,
  allowFallbacks = true,
  layout = 'inline',
  settingsRows,
}: {
  value: BotModelRoute[];
  onChange: (next: BotModelRoute[]) => void;
  disabled?: boolean;
  hiddenVendors?: MakerVendor[];
  remote?: boolean;
  /** Device-link target; `remote` alone denotes the existing SSH restrictions. */
  deviceId?: string;
  label?: string;
  onRestoreDefault?: () => void;
  onNavigateToProviders?: () => void;
  allowFallbacks?: boolean;
  /**
   * `settings`:设置页卡片行排法——首选模型一行(左名称说明、右选择器与恢复默认),
   * 备用模型一行(左名称说明、右添加按钮),已有备用逐条列在其下。需传 `settingsRows`。
   * 默认 `inline` 保持伙伴页等既有排法不变。
   */
  layout?: 'inline' | 'settings';
  settingsRows?: { primaryLabel: string; primaryHint: string };
}) {
  const { t } = useBotTranslation();
  const catalog = useDeviceProviders(deviceId);
  const [pendingRoute, setPendingRoute] = useState<BotModelRoute | null>(null);
  const routes = value.slice(0, BOT_MODEL_CHAIN_MAX);
  // Picker content may be portaled outside a form's disabled fieldset.
  const onChange = (next: BotModelRoute[]) => {
    if (!disabled) onValueChange(next);
  };
  const visibleVendors = (['pi', 'codex', 'cc'] as const)
    .filter((vendor) => !hiddenVendors.includes(vendor));
  const unifiedAgents = visibleVendors.map(agentKindFor);

  const replace = (index: number, patch: Partial<BotModelRoute>) => {
    if (disabled) return;
    if (pendingRoute && index === routes.length) {
      const next = { ...pendingRoute, ...patch };
      if (next.model && routes.length < BOT_MODEL_CHAIN_MAX) {
        onChange([...routes, next]);
        setPendingRoute(null);
      } else setPendingRoute(next);
      return;
    }
    const editable = routes.length
      ? routes
      : [{ harness: 'pi' as const, model: '', providerId: null, effort: '', fastMode: false }];
    onChange(editable.map((route, at) => (at === index ? { ...route, ...patch } : route)));
  };
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (index < 1 || target < 1 || target >= routes.length) return;
    const next = [...routes];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };
  const add = () => {
    if (disabled || pendingRoute || routes.length >= BOT_MODEL_CHAIN_MAX) return;
    const unused = visibleVendors.find(
      (vendor) => !routes.some((route) => vendorFor(route.harness) === vendor),
    );
    const vendor = unused ?? visibleVendors[0];
    if (!vendor) return;
    setPendingRoute({ harness: harnessFor(vendor), model: '', providerId: null, effort: '', fastMode: false });
  };

  const picker = (route: BotModelRoute, index: number, wrapperClassName = 'min-w-0 flex-1') => (
    <div className={wrapperClassName}>
      <ModelRouteSelector
        disabled={disabled}
        deviceId={deviceId}
        agentDeviceId={route.agentDeviceId}
        sshRemote={remote && !deviceId}
        vendorKey={vendorFor(route.harness)}
        modelId={route.model}
        effort={route.effort}
        currentProviderId={route.providerId}
        agentIdentity={{ vendorKey: vendorFor(route.harness), state: 'current' }}
        triggerVariant="settings"
        popoverSide="bottom"
        ariaContext={t('bots.modelChain.routeLabel', { index: index + 1 })}
        excludeSubscriptionDirect={remote && !deviceId}
        excludeChatBridgedCodex={remote && !deviceId}
        fastMode={route.fastMode}
        onModelChange={(model) => replace(index, { model })}
        onEffortChange={(effort) => replace(index, { effort })}
        onFastModeChange={(fastMode) => replace(index, { fastMode })}
        onNavigateToProviders={remote || deviceId ? undefined : onNavigateToProviders}
        configurationEnabled
        unifiedPanel
        unifiedAgents={unifiedAgents}
        onUnifiedSelect={(selection) => {
          if (!visibleVendors.includes(selection.engine)) return;
          replace(index, {
            harness: harnessFor(selection.engine),
            ...(route.agentDeviceId || selection.agentDevice ? { agentDeviceId: selection.agentDevice?.deviceId ?? null } : {}),
            providerId: selection.providerId,
            model: selection.modelId,
            effort: selection.effort ?? '',
            fastMode: selection.fast,
          });
        }}
        unknownModelLabel={(model) => t('bots.modelUnavailable', { model })}
        unknownModelDescription={t('settings.auxiliaryModels.unavailable')}
      />
      {deviceId && !route.agentDeviceId && route.providerId
        ? (() => {
            const provider = catalog.providers.find((item) => item.id === route.providerId);
            return provider ? (
              <p className="mt-1 break-words px-2 text-12 text-[var(--text-secondary)]">
                {providerAccountLabel(
                  providerDisplayName(provider, t),
                  provider.openAiAccount?.identity?.trim() ||
                    provider.subscriptionAccount?.identity?.trim(),
                )}
              </p>
            ) : null;
          })()
        : null}
    </div>
  );
  const fallbackRows = routes.slice(1).map((route, fallbackIndex) => {
    const index = fallbackIndex + 1;
    return (
      <div key={index} className="flex min-w-0 items-start gap-2">
        <span className="w-4 shrink-0 pt-1 text-11 leading-5">{index}</span>
        {picker(route, index)}
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            disabled={disabled || index === 1}
            onClick={() => move(index, -1)}
            aria-label={t('bots.modelChain.moveUp')}
            className="rounded-lg p-1.5 hover:bg-[var(--surface-hover)] disabled:opacity-30"
          >
            <ArrowUp size={14} />
          </button>
          <button
            type="button"
            disabled={disabled || index === routes.length - 1}
            onClick={() => move(index, 1)}
            aria-label={t('bots.modelChain.moveDown')}
            className="rounded-lg p-1.5 hover:bg-[var(--surface-hover)] disabled:opacity-30"
          >
            <ArrowDown size={14} />
          </button>
          {routes.length > 1 ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(routes.filter((_, at) => at !== index))}
              aria-label={t('bots.modelChain.remove')}
              className="rounded-lg p-1.5 hover:bg-[var(--danger-bg-soft)] hover:text-[var(--text-danger)]"
            >
              <Trash2 size={14} />
            </button>
          ) : null}
        </div>
      </div>
    );
  });
  const pendingRow: ReactNode =
    pendingRoute && routes.length < BOT_MODEL_CHAIN_MAX ? (
      <div className="flex min-w-0 items-start gap-2">
        {picker(pendingRoute, routes.length)}
        <Button
          variant="secondary"
          tone="quiet"
          size="md"
          compact
          type="button"
          disabled={disabled}
          onClick={() => setPendingRoute(null)}
        >
          {t('bots.cancel')}
        </Button>
      </div>
    ) : null;
  const addDisabled =
    disabled ||
    pendingRoute !== null ||
    routes.length >= BOT_MODEL_CHAIN_MAX ||
    visibleVendors.length === 0;
  const primaryRoute =
    routes[0] ?? { harness: 'pi' as const, model: '', providerId: null, effort: '', fastMode: false };

  if (layout === 'settings' && settingsRows) {
    const listItems = [...fallbackRows, ...(pendingRow ? [pendingRow] : [])];
    return (
      <div className="min-w-0" data-testid="bot-model-chain-editor">
        <div className={cn(SETTINGS_ROW_CLASS, 'cindy-segmented-row flex-wrap')}>
          <div className="flex min-w-0 flex-col gap-1">
            <p className={SETTINGS_ROW_LABEL_CLASS} style={{ letterSpacing: '0.12px' }}>
              {settingsRows.primaryLabel}
            </p>
            <p className={SETTINGS_ROW_HINT_CLASS}>{settingsRows.primaryHint}</p>
          </div>
          <div className="flex min-w-0 max-w-full items-start gap-2">
            {onRestoreDefault ? (
              <DefaultOverrideControls
                isCustomized
                disabled={disabled}
                onReset={() => {
                  if (!disabled) onRestoreDefault();
                }}
              />
            ) : null}
            {picker(primaryRoute, 0, 'min-w-0')}
          </div>
        </div>
        {allowFallbacks ? (
          <>
            <div className={SETTINGS_ROW_DIVIDER_CLASS} />
            <div className={SETTINGS_ROW_CLASS}>
              <div className="flex min-w-0 flex-col gap-1">
                <p className={SETTINGS_ROW_LABEL_CLASS} style={{ letterSpacing: '0.12px' }}>
                  {t('bots.modelChain.options', { count: Math.max(0, routes.length - 1) })}
                </p>
                <p className={SETTINGS_ROW_HINT_CLASS}>{t('bots.modelChain.description')}</p>
              </div>
              <Button
                variant="secondary"
                size="md"
                compact
                type="button"
                className="shrink-0"
                disabled={addDisabled}
                onClick={add}
              >
                <Plus size={14} />
                {t('bots.modelChain.add')}
              </Button>
            </div>
            {listItems.length > 0 ? (
              <div className="space-y-2 px-4 pb-4 text-12 text-[var(--text-tertiary)]">
                {listItems.map((item, at) => (
                  <Fragment key={at}>{item}</Fragment>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="min-w-0" data-testid="bot-model-chain-editor">
      <div className="flex min-w-0 items-start gap-3">
        {label ? (
          <span className="shrink-0 pt-1 text-12 leading-5 text-[var(--text-secondary)]">{label}</span>
        ) : null}
        {picker(primaryRoute, 0)}
      </div>
      {allowFallbacks && <div
        className="mt-1 text-12 text-[var(--text-tertiary)]"
        data-testid="bot-model-fallbacks"
      >
        <p className="py-2">
          {t('bots.modelChain.options', { count: Math.max(0, routes.length - 1) })}
        </p>
        <div className="space-y-2 pt-2">
          {fallbackRows}
          {pendingRow}
          <Button
            variant="secondary"
            size="md"
            tone="quiet"
            compact
            type="button"
            disabled={addDisabled}
            onClick={add}
          >
            <Plus size={14} />
            {t('bots.modelChain.add')}
          </Button>
          {onRestoreDefault ? (
            <Button
              variant="secondary"
              size="md"
              tone="quiet"
              compact
              type="button"
              disabled={disabled}
              onClick={() => {
                if (!disabled) onRestoreDefault();
              }}
              className="ml-2"
            >
              {t('bots.model.restoreDefault')}
            </Button>
          ) : null}
        </div>
      </div>}
    </div>
  );
}
