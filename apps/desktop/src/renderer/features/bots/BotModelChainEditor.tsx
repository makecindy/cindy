import { useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';

import { ModelSelector } from '@/components/new-chat/ModelSelector';
import type { AgentKind } from '@/hooks/useAgentCapabilities';
import { useAvailableAgents } from '@/hooks/useAvailableAgents';
import type { MakerVendor } from '@/lib/ccAgent.types';
import type { SelectableVendor } from '@/lib/agentVendors';
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

function harnessFor(vendor: SelectableVendor): BotHarness | null {
  // Bot model chains only host claude/codex/pi; Grok Build is a chat harness, not a bot route.
  if (vendor === 'grok-build') return null;
  return vendor === 'cc' ? 'claude' : vendor;
}

function agentKindFor(vendor: 'cc' | 'codex' | 'pi'): AgentKind {
  return vendor === 'cc' ? 'claude-code' : vendor;
}

function defaultRoute(vendor: 'cc' | 'codex' | 'pi'): BotModelRoute {
  const harness = harnessFor(vendor);
  if (!harness) throw new Error(`unsupported bot harness vendor: ${vendor}`);
  return { harness, ...getEffectiveBotModelSettings(vendor, null) };
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
}: {
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
    if (!remote && !loaded) return;
    const editable = routes.length ? routes : [{ harness: 'pi' as const, model: '', providerId: null, effort: '', fastMode: false }];
    onChange(editable.map((route, at) => (at === index ? { ...route, ...patch } : route)));
  };
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= routes.length) return;
    const next = [...routes];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };
  const add = () => {
    if (routes.length >= BOT_MODEL_CHAIN_MAX) return;
    const unused = visibleVendors.find(
      (vendor) => !routes.some((route) => vendorFor(route.harness) === vendor),
    );
    const vendor = unused ?? visibleVendors[0];
    if (!vendor) return;
    const route = defaultRoute(vendor);
    if (route.model) onChange([...routes, route]);
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
        unifiedSelectionPolicy="official"
        onUnifiedSelect={(selection) => {
          const engine = selection.engine;
          if (engine !== 'cc' && engine !== 'codex' && engine !== 'pi') return;
          if (!visibleVendors.includes(engine)) return;
          const harness = harnessFor(engine);
          if (!harness) return;
          replace(index, {
            harness,
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
      <div className="flex min-w-0 items-center gap-3">
        {label ? (
          <span className="shrink-0 text-12 text-[var(--text-secondary)]">{label}</span>
        ) : null}
        {picker(routes[0] ?? { harness: 'pi', model: '', providerId: null, effort: '', fastMode: false }, 0)}
      </div>
      <details
        className="mt-1 text-12 text-[var(--text-tertiary)]"
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary className="cursor-pointer py-2">
          {t('bots.modelChain.options', { count: Math.max(0, routes.length - 1) })}
        </summary>
        {expanded ? (
          <div className="space-y-2 pt-2">
            {routes.map((route, index) => (
              <div key={index} className="flex min-w-0 items-center gap-2">
                <span className="w-4 shrink-0 text-11">{index + 1}</span>
                {picker(route, index)}
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    disabled={disabled || index === 0}
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
            ))}
            <button
              type="button"
              disabled={disabled || routes.length >= BOT_MODEL_CHAIN_MAX || visibleVendors.length === 0}
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
                onClick={() => { if (!disabled) onRestoreDefault(); }}
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
