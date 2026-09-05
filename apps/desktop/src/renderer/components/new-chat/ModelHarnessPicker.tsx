import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { UnifiedModelEntry } from '@cindy/model-providers';

import { cn } from '@/lib/utils';
import { MODEL_HARNESS_COLOR } from '@/lib/modelHarnessPresentation';
import { MODEL_PROTOCOL_LABEL } from '@/lib/modelProtocolLabel';
import { ModelCompatibilityNotice } from './ModelCompatibilityNotice';
import { agentOptionOf } from './agentOptions';
import { agentKindOfEngine, engineOfAgentKind, type UnifiedEngine } from './unifiedModelSelection';

/** All available harnesses stay visible; protocol details do not compete with the choices. */
export function ModelHarnessPicker({
  entry,
  value,
  disabled = false,
  locked = false,
  onChange,
}: {
  entry: UnifiedModelEntry;
  value: UnifiedEngine;
  disabled?: boolean;
  locked?: boolean;
  onChange: (engine: UnifiedEngine) => void;
}) {
  const { t } = useTranslation();
  const rank = (agent: UnifiedModelEntry['recommended']) =>
    agent === entry.recommended
      ? 0
      : entry.capabilities[agent]?.protocolMode === 'matching'
        ? 1
        : 2;
  // Candidate membership already reflects the executing device's settings and availability.
  // The selector must never restore compatibility routes the user has turned off.
  const engines = locked
    ? [value]
    : [...entry.candidates].sort((a, b) => rank(a) - rank(b)).map(engineOfAgentKind);
  const current = entry.capabilities[agentKindOfEngine(value)];
  const nativeApi = current?.nativeApi;
  const labelOf = (engine: UnifiedEngine) =>
    engine === 'cc' ? 'Claude Code' : agentOptionOf(engine).label;
  const detailOf = (engine: UnifiedEngine) => {
    const agent = agentKindOfEngine(engine);
    const capability = entry.capabilities[agent];
    const api = capability?.outboundApi && MODEL_PROTOCOL_LABEL[capability.outboundApi];
    return [
      labelOf(engine),
      api,
      t(`settings.providers.models.advanced.protocol.${capability?.protocolMode ?? 'unknown'}`),
      agent === entry.recommended && t('newChat.modelSelector.unified.recommended'),
    ]
      .filter(Boolean)
      .join(' · ');
  };
  const interactive = !disabled && !locked && engines.length > 1;

  return (
    <div role="group" aria-label={t('settings.providers.models.advanced.engines')} className="pt-2">
      {engines.map((engine) => {
        const capability = entry.capabilities[agentKindOfEngine(engine)];
        const mode = capability?.protocolMode ?? 'unknown';
        const option = agentOptionOf(engine);
        const active = value === engine;
        return (
          <div
            key={engine}
            className={cn(
              'relative flex min-h-7 items-center gap-1 rounded-sm pr-1',
              active && 'bg-[var(--model-item-hover)]',
              interactive && 'hover:bg-[var(--model-item-hover)]',
            )}
          >
            <button
              type="button"
              disabled={!interactive}
              onClick={() => interactive && onChange(engine)}
              aria-pressed={active}
              aria-label={detailOf(engine)}
              title={`${t('settings.providers.models.advanced.protocol.reference')}: ${
                (nativeApi && MODEL_PROTOCOL_LABEL[nativeApi]) ||
                t('settings.providers.models.advanced.undeclared')
              } · ${detailOf(engine)}`}
              data-engine-capsule={engine}
              data-engine-active={active ? 'true' : undefined}
              data-engine-support={mode}
              className={cn(
                'flex min-h-7 min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 text-left text-[var(--model-item-text)]',
                interactive && 'cursor-pointer after:absolute after:inset-0 after:rounded-sm',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--model-dropdown-border)]',
                !interactive && 'cursor-default',
                disabled && 'opacity-50',
              )}
            >
              <span
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center"
                style={{ color: MODEL_HARNESS_COLOR[agentKindOfEngine(engine)] }}
                aria-hidden
              >
                <option.Mark size={12} />
              </span>
              <span className="min-w-0 text-12 leading-4">{labelOf(engine)}</span>
            </button>
            {engine === 'codex' && mode === 'compatibility' && (
              <span className="relative z-10 text-10 leading-4">
                <ModelCompatibilityNotice />
              </span>
            )}
            <Check size={12} aria-hidden className={cn('shrink-0', !active && 'invisible')} />
          </div>
        );
      })}
    </div>
  );
}
