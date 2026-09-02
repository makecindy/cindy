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
}: {
  value: BotModelRoute[];
  onChange: (next: BotModelRoute[]) => void;
  hiddenVendors?: MakerVendor[];
  remote?: boolean;
}) {
  const { t } = useBotTranslation();
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

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="bot-model-chain-editor">
      {routes.map((route, index) => {
        return (
          <div
            key={`${index}:${route.harness}:${route.providerId ?? ''}:${route.model}`}
            className="rounded-xl border border-[var(--border-default)] bg-[var(--surface)] p-4"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-12 font-medium text-[var(--text-primary)]">
                {index === 0
                  ? t('bots.modelChain.primary')
                  : t('bots.modelChain.fallback', { index })}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  aria-label={t('bots.modelChain.moveUp')}
                  className="rounded-lg p-1.5 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] disabled:opacity-30"
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  disabled={index === routes.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label={t('bots.modelChain.moveDown')}
                  className="rounded-lg p-1.5 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] disabled:opacity-30"
                >
                  <ArrowDown size={14} />
                </button>
                {routes.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => onChange(routes.filter((_, at) => at !== index))}
                    aria-label={t('bots.modelChain.remove')}
                    className="rounded-lg p-1.5 text-[var(--text-tertiary)] hover:bg-[var(--danger-bg-soft)] hover:text-[var(--text-danger)]"
                  >
                    <Trash2 size={14} />
                  </button>
                ) : null}
              </div>
            </div>
            <div className="min-w-0">
              <ModelSelector
                modelId={route.model}
                effort={route.effort}
                currentProviderId={route.providerId}
                triggerVariant="field"
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
                unifiedLayout="badge"
                unifiedLayoutControls={false}
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
          </div>
        );
      })}
      <button
        type="button"
        disabled={routes.length >= BOT_MODEL_CHAIN_MAX}
        onClick={add}
        className={cn(
          'inline-flex h-9 items-center justify-center gap-2 self-start rounded-full border border-[var(--border-default)] px-4',
          'text-12 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:opacity-40',
        )}
      >
        <Plus size={14} />
        {t('bots.modelChain.add')}
      </button>
      <p className="text-11 leading-5 text-[var(--text-tertiary)]">
        {t('bots.modelChain.description')}
      </p>
    </div>
  );
}
