import { useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';

import { ModelSelector } from '@/components/new-chat/ModelSelector';
import type { AgentKind } from '@/hooks/useAgentCapabilities';
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
  onChange,
  hiddenVendors = [],
  remote = false,
  label,
  onRestoreDefault,
}: {
  value: BotModelRoute[];
  onChange: (next: BotModelRoute[]) => void;
  hiddenVendors?: MakerVendor[];
  remote?: boolean;
  label?: string;
  onRestoreDefault?: () => void;
}) {
  const { t } = useBotTranslation();
  const [expanded, setExpanded] = useState(false);
  const routes = value.slice(0, BOT_MODEL_CHAIN_MAX);
  const unifiedAgents = (['pi', 'codex', 'cc'] as const)
    .filter((vendor) => !hiddenVendors.includes(vendor))
    .map(agentKindFor);

  const replace = (index: number, patch: Partial<BotModelRoute>) => {
    onChange(routes.map((route, at) => (at === index ? { ...route, ...patch } : route)));
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
    const visible = (['pi', 'codex', 'cc'] as const).filter(
      (vendor) => !hiddenVendors.includes(vendor),
    );
    const unused = visible.find(
      (vendor) => !routes.some((route) => vendorFor(route.harness) === vendor),
    );
    const vendor = unused ?? visible[0] ?? 'pi';
    const route = defaultRoute(vendor);
    if (route.model) onChange([...routes, route]);
  };

  const picker = (route: BotModelRoute, index: number) => (
    <div className="min-w-0 flex-1">
      <ModelSelector
        modelId={route.model}
        effort={route.effort}
        currentProviderId={route.providerId}
        triggerVariant="toolbar"
        popoverSide="bottom"
        ariaContext={t('bots.modelChain.routeLabel', { index: index + 1 })}
        excludeSubscriptionDirect={remote}
        excludeChatBridgedCodex={remote}
        fastMode={route.fastMode}
        onModelChange={() => undefined}
        onEffortChange={() => undefined}
        configurationEnabled={false}
        unifiedPanel
        unifiedAgents={unifiedAgents}
        unifiedSelectionPolicy="official"
        onUnifiedSelect={(selection) =>
          replace(index, {
            harness: harnessFor(selection.engine),
            providerId: selection.providerId,
            model: selection.modelId,
            effort: selection.effort ?? '',
            fastMode: selection.fast,
          })
        }
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
        {routes[0] ? picker(routes[0], 0) : null}
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
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                    aria-label={t('bots.modelChain.moveUp')}
                    className="rounded-lg p-1.5 hover:bg-[var(--surface-hover)] disabled:opacity-30"
                  >
                    <ArrowUp size={14} />
                  </button>
                  <button
                    type="button"
                    disabled={index === routes.length - 1}
                    onClick={() => move(index, 1)}
                    aria-label={t('bots.modelChain.moveDown')}
                    className="rounded-lg p-1.5 hover:bg-[var(--surface-hover)] disabled:opacity-30"
                  >
                    <ArrowDown size={14} />
                  </button>
                  {routes.length > 1 ? (
                    <button
                      type="button"
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
              disabled={routes.length >= BOT_MODEL_CHAIN_MAX}
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
                onClick={onRestoreDefault}
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
