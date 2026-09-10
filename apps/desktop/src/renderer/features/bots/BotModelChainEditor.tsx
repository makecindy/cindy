import { useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';

import { ModelSelector } from '@/components/new-chat/ModelSelector';
import type { AgentKind } from '@/hooks/useAgentCapabilities';
import { useAvailableAgents } from '@/hooks/useAvailableAgents';
import type { MakerVendor } from '@/lib/ccAgent.types';
import { cn } from '@/lib/utils';
import {
  BOT_MODEL_CHAIN_MAX,
  type BotHarness,
  type BotModelRoute,
} from '../../../shared/botModelChain';
import { getEffectiveBotModelSettings } from './botStore';
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

function defaultRoute(vendor: 'cc' | 'codex' | 'pi'): BotModelRoute {
  return { harness: harnessFor(vendor), ...getEffectiveBotModelSettings(vendor, null) };
}

export function BotModelChainEditor({
  value,
  onChange: onValueChange,
  disabled = false,
  hiddenVendors = [],
  remote = false,
  label,
  onRestoreDefault,
  onNavigateToProviders,
  fallbackOnly = false,
}: {
  fallbackOnly?: boolean;
  value: BotModelRoute[];
  onChange: (next: BotModelRoute[]) => void;
  disabled?: boolean;
  hiddenVendors?: MakerVendor[];
  remote?: boolean;
  label?: string;
  onRestoreDefault?: () => void;
  onNavigateToProviders?: () => void;
}) {
  const { t } = useBotTranslation();
  const { availableVendors, loaded } = useAvailableAgents();
  const [expanded, setExpanded] = useState(false);
  const [pendingRoute, setPendingRoute] = useState<BotModelRoute | null>(null);
  const routes = value.slice(0, BOT_MODEL_CHAIN_MAX);
  // Picker content may be portaled outside a form's disabled fieldset.
  const onChange = (next: BotModelRoute[]) => {
    if (!disabled) onValueChange(next);
  };
  // All local entry points, including empty-chain recovery, use the runtime
  // roster. Remote callers supply their own device's hiddenVendors instead.
  const visibleVendors = (['pi', 'codex', 'cc'] as const)
    .filter((vendor) => !hiddenVendors.includes(vendor))
    .filter((vendor) => remote || (loaded && availableVendors.has(vendor)));
  const unifiedAgents = visibleVendors.map(agentKindFor);

  const replace = (index: number, patch: Partial<BotModelRoute>) => {
    if (disabled || (!remote && !loaded)) return;
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
    const route = defaultRoute(vendor);
    if (route.model) onChange([...routes, route]);
    else setPendingRoute(route);
  };

  const picker = (route: BotModelRoute, index: number) => (
    <div className="min-w-0 flex-1">
      <ModelSelector
        disabled={disabled || (!remote && !loaded)}
        vendorKey={vendorFor(route.harness)}
        modelId={route.model}
        effort={route.effort}
        currentProviderId={route.providerId}
        triggerVariant="toolbar"
        popoverSide="bottom"
        ariaContext={t('bots.modelChain.routeLabel', { index: index + 1 })}
        excludeSubscriptionDirect={remote}
        excludeChatBridgedCodex={remote}
        fastMode={route.fastMode}
        onModelChange={(model) => replace(index, { model })}
        onEffortChange={(effort) => replace(index, { effort })}
        onFastModeChange={(fastMode) => replace(index, { fastMode })}
        onNavigateToProviders={remote ? undefined : onNavigateToProviders}
        configurationEnabled
        unifiedPanel
        unifiedAgents={unifiedAgents}
        onUnifiedSelect={(selection) => {
          if (!visibleVendors.includes(selection.engine)) return;
          replace(index, {
            harness: harnessFor(selection.engine),
            providerId: selection.providerId,
            model: selection.modelId,
            effort: selection.effort ?? '',
            fastMode: selection.fast,
          });
        }}
        unknownModelLabel={(model) => t('bots.modelUnavailable', { model })}
      />
    </div>
  );
  return (
    <div className="min-w-0" data-testid="bot-model-chain-editor">
      <div hidden={fallbackOnly && routes.length > 0} className="flex min-w-0 items-center gap-3">
        {label ? (
          <span className="shrink-0 text-12 text-[var(--text-secondary)]">{label}</span>
        ) : null}
        {picker(
          routes[0] ?? { harness: 'pi', model: '', providerId: null, effort: '', fastMode: false },
          0,
        )}
      </div>
      <details
        open={fallbackOnly || undefined}
        className="mt-1 text-12 text-[var(--text-tertiary)]"
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary hidden={fallbackOnly} className="cursor-pointer py-2">
          {t('bots.modelChain.options', { count: Math.max(0, routes.length - 1) })}
        </summary>
        {expanded || fallbackOnly ? (
          <div className="space-y-2 pt-2">
            {routes.slice(1).map((route, fallbackIndex) => {
              const index = fallbackIndex + 1;
              return (
                <div key={index} className="flex min-w-0 items-center gap-2">
                  <span className="w-4 shrink-0 text-11">{index}</span>
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
            })}
            {pendingRoute && routes.length < BOT_MODEL_CHAIN_MAX ? (
              <div className="flex min-w-0 items-center gap-2">
                {picker(pendingRoute, routes.length)}
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => setPendingRoute(null)}
                  className="h-8 rounded-lg px-3 text-12"
                >
                  {t('bots.cancel')}
                </button>
              </div>
            ) : null}
            <button
              type="button"
              disabled={
                disabled ||
                pendingRoute !== null ||
                routes.length >= BOT_MODEL_CHAIN_MAX ||
                visibleVendors.length === 0
              }
              onClick={add}
              className={cn(
                'inline-flex h-8 items-center gap-2 rounded-full px-3 text-12',
                'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-40',
              )}
            >
              <Plus size={14} />
              {t('bots.modelChain.add')}
            </button>
            {onRestoreDefault ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  if (!disabled) onRestoreDefault();
                }}
                className="ml-2 h-8 rounded-full px-3 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
              >
                {t('bots.model.restoreDefault')}
              </button>
            ) : null}
            <p className="text-11 leading-5">{t('bots.modelChain.description')}</p>
          </div>
        ) : null}
      </details>
    </div>
  );
}
