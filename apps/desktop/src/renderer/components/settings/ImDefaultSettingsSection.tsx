/**
 * 单个 IM 渠道的新会话设置。
 *
 * 每个渠道保存自己的 Agent / 模型路由。现有 IM 会话不会因为这里保存而被
 * 静默改写；非 thread 渠道通过 `/new` 显式应用。
 */

import {
  connectedProvidersForAgent,
  getModel,
  isModelSelectableForNewRoute,
} from '@cindy/model-providers';
import { MessageSquare } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ClaudeMark } from '@/components/icons/ClaudeMark';
import { CodexMark } from '@/components/icons/CodexMark';
import { PiMark } from '@/components/icons/PiMark';
import { ModelSelector } from '@/components/new-chat/ModelSelector';
import { type ModelDescriptor, useAgentCapabilities } from '@/hooks/useAgentCapabilities';
import { useProviders } from '@/hooks/useProviders';
import { deriveModelsFromProviders } from '@/lib/providerModels';
import { toast } from '@/lib/toast';
import type { Effort } from '@/lib/userPreferences.types';
import { cn } from '@/lib/utils';
import {
  IM_DEFAULT_EFFORT_OVERRIDES,
  IM_DEFAULT_SETTINGS,
  type ImDefaultAgentKind,
  type ImDefaultEffort,
  type ImDefaultSettingsChannel,
  type ImDefaultSettingsPatch,
  type ImDefaultSettingsState,
  isImDefaultEffort,
} from '../../../shared/imDefaultSettings';
import { DefaultOverrideControls } from './DefaultOverrideControls';
import { buildAgentSettingsPatch, mergeSettingsPatch } from './imDefaultSettingsLogic';

const AGENT_OPTIONS: Array<{
  kind: ImDefaultAgentKind;
  Mark: typeof ClaudeMark;
}> = [
  { kind: 'claude-code', Mark: ClaudeMark },
  { kind: 'codex', Mark: CodexMark },
  { kind: 'pi', Mark: PiMark },
];

function vendorKeyFor(agentKind: ImDefaultAgentKind): 'cc' | 'codex' | 'pi' {
  return agentKind === 'claude-code' ? 'cc' : agentKind;
}

export interface ImDefaultSettingsSummary {
  agentKind: ImDefaultAgentKind;
  model: string;
}

export function ImDefaultSettingsSection({
  channel,
  descriptionChannel = channel,
  embedded = false,
  onSummaryChange,
}: {
  /** Omit to edit the global defaults used by official hook channels. */
  channel?: ImDefaultSettingsChannel;
  /** Channel-specific copy to show when the persisted scope is global. */
  descriptionChannel?: ImDefaultSettingsChannel;
  embedded?: boolean;
  onSummaryChange?: (summary: ImDefaultSettingsSummary | null) => void;
}) {
  const { t } = useTranslation();
  const { providers } = useProviders();
  const cc = useAgentCapabilities('claude-code');
  const codex = useAgentCapabilities('codex');
  const pi = useAgentCapabilities('pi');
  const [settings, setSettings] = useState<ImDefaultSettingsState | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSettings(null);
    setPending(false);
    void window.electronAPI.maker
      .imDefaultSettingsGet(channel)
      .then((state) => {
        if (!cancelled) setSettings(state);
      })
      .catch((err) => {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : t('settings.imBot.defaults.loadFailed'));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [channel, t]);

  useEffect(() => {
    if (!settings) return;
    onSummaryChange?.({
      agentKind: settings.agentKind,
      model: settings.agents[settings.agentKind].model,
    });
  }, [onSummaryChange, settings]);

  const modelsByAgent = useMemo<Record<ImDefaultAgentKind, ModelDescriptor[]>>(() => {
    // 准入口径:IM 默认模型是「从零挑一个」的清单,停用的供应商/模型与能力模型
    // 不该可选 —— 否则 headless runner 派发时才降级换模型,用户无感(PR #744 review)。
    const fromProviders = {
      'claude-code': deriveModelsFromProviders(providers, 'claude-code', {
        admissionFiltered: true,
      }),
      codex: deriveModelsFromProviders(providers, 'codex', { admissionFiltered: true }),
      pi: deriveModelsFromProviders(providers, 'pi', { admissionFiltered: true }),
    };
    return {
      'claude-code': fromProviders['claude-code'].length
        ? fromProviders['claude-code']
        : (cc.capabilities?.availableModels ?? []),
      codex: fromProviders.codex.length
        ? fromProviders.codex
        : (codex.capabilities?.availableModels ?? []),
      pi: fromProviders.pi.length
        ? fromProviders.pi
        : (pi.capabilities?.availableModels ?? []),
    };
  }, [providers, cc.capabilities, codex.capabilities, pi.capabilities]);

  const resolveProviderId = useCallback(
    (agentKind: ImDefaultAgentKind, modelId: string, providerId: string | null): string | null => {
      if (!providerId) return null;
      const provider = connectedProvidersForAgent(providers, agentKind).find(
        (p) => p.id === providerId,
      );
      if (!provider) return null;
      // 只看 id 是否存在不够(issue #882 第 3 点,2026-07 review 第 18 轮):该来源这份
      // 具体条目若是非聊天类型,不能落成 IM 渠道的显式默认来源,否则渠道发消息会打进
      // image/audio/embedding 端点。
      const catalogModel = getModel(provider, modelId, agentKind);
      return catalogModel &&
        isModelSelectableForNewRoute(catalogModel, { userProvider: provider.source === 'user' })
        ? providerId
        : null;
    },
    [providers],
  );

  const resolveEffort = useCallback(
    (agentKind: ImDefaultAgentKind, modelId: string, requested: Effort): ImDefaultEffort => {
      const model = modelsByAgent[agentKind].find((m) => m.id === modelId);
      const requestedEffort = toImDefaultEffort(requested);
      if (!model || model.efforts.length === 0) {
        return requestedEffort ?? IM_DEFAULT_SETTINGS.agents[agentKind].effort;
      }
      if (requestedEffort && model.efforts.includes(requestedEffort)) return requestedEffort;
      const override = IM_DEFAULT_EFFORT_OVERRIDES[modelId];
      if (override && model.efforts.includes(override)) return override;
      const defaultEffort = toImDefaultEffort(model.defaultEffort);
      if (defaultEffort && model.efforts.includes(defaultEffort)) return defaultEffort;
      return toImDefaultEffort(model.efforts[0]) ?? IM_DEFAULT_SETTINGS.agents[agentKind].effort;
    },
    [modelsByAgent],
  );

  const persist = useCallback(
    async (patch: ImDefaultSettingsPatch) => {
      if (!settings || pending) return;
      const previous = settings;
      setPending(true);
      setSettings(mergeSettingsPatch(settings, patch));
      try {
        const next = await window.electronAPI.maker.imDefaultSettingsSet(patch, channel);
        setSettings(next);
      } catch (err) {
        setSettings(previous);
        toast.error(err instanceof Error ? err.message : t('settings.imBot.defaults.saveFailed'));
      } finally {
        setPending(false);
      }
    },
    [channel, pending, settings, t],
  );

  const reset = useCallback(async () => {
    if (pending) return;
    setPending(true);
    try {
      setSettings(await window.electronAPI.maker.imDefaultSettingsReset(channel));
      toast.success(t('settings.defaults.restored'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.defaults.restoreFailed'));
    } finally {
      setPending(false);
    }
  }, [channel, pending, t]);

  if (!settings) {
    return (
      <div
        className={cn(
          'text-[13px] text-[var(--text-tertiary)]',
          embedded
            ? 'py-2'
            : 'rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] px-4 py-5',
        )}
      >
        {t('settings.imBot.defaults.loading')}
      </div>
    );
  }

  const activeSettings = settings.agents[settings.agentKind];

  const changeAgent = (agentKind: ImDefaultAgentKind) => {
    if (agentKind === settings.agentKind) return;
    void persist({ agentKind });
  };

  const changeModel = (model: string, providerId: string | null = activeSettings.providerId) => {
    const nextProviderId = resolveProviderId(settings.agentKind, model, providerId);
    const effort = resolveEffort(settings.agentKind, model, activeSettings.effort);
    void persist(
      buildAgentSettingsPatch(settings.agentKind, {
        ...activeSettings,
        model,
        providerId: nextProviderId,
        effort,
      }),
    );
  };

  const changeEffort = (effort: Effort) => {
    if (!isImDefaultEffort(effort) || effort === activeSettings.effort) return;
    void persist(
      buildAgentSettingsPatch(settings.agentKind, {
        ...activeSettings,
        effort,
      }),
    );
  };

  return (
    <section
      className={cn(
        'flex flex-col gap-[18px]',
        embedded
          ? 'py-1'
          : [
              'rounded-xl p-4',
              'border border-[var(--settings-theme-card-border)]',
              'bg-[var(--settings-theme-card-bg)]',
            ],
      )}
      aria-label={t('settings.imBot.defaults.title')}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--settings-input-bg)]">
            <MessageSquare size={18} className="text-[var(--settings-section-title)]" />
          </div>
          <div className="min-w-0">
            <h3 className="text-[14px] font-medium leading-none text-[var(--settings-section-title)]">
              {t('settings.imBot.defaults.title')}
            </h3>
            <p className="mt-2 text-[12px] leading-[1.45] text-[var(--settings-section-desc)]">
              {t(`settings.imBot.defaults.channelDescriptions.${descriptionChannel}`)}
            </p>
          </div>
        </div>
        <DefaultOverrideControls
          isCustomized={settings.isCustomized}
          disabled={pending}
          onReset={() => void reset()}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-medium text-[var(--text-secondary)]">
            {t('settings.imBot.defaults.agentLabel')}
          </span>
          <div
            className="flex h-10 items-center gap-0.5 rounded-full bg-[var(--surface-chip)] p-[3px]"
            role="tablist"
            aria-label={t('settings.imBot.defaults.agentLabel')}
          >
            {AGENT_OPTIONS.map(({ kind, Mark }) => {
              const active = kind === settings.agentKind;
              return (
                <button
                  key={kind}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  disabled={pending}
                  onClick={() => changeAgent(kind)}
                  className={cn(
                    'flex h-full min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full px-3',
                    'border text-[13px] leading-none transition-colors',
                    active
                      ? 'border-[var(--border-default)] bg-[var(--surface-elevated)] font-medium text-[var(--settings-section-title)]'
                      : 'border-transparent font-normal text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                    pending && 'cursor-not-allowed opacity-55',
                  )}
                >
                  <Mark size={14} className="shrink-0" />
                  <span className="truncate">{t(`settings.imBot.defaults.agents.${kind}`)}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-medium text-[var(--text-secondary)]">
            {t('settings.imBot.defaults.modelLabel')}
          </span>
          <ModelSelector
            modelId={activeSettings.model}
            effort={activeSettings.effort}
            onModelChange={(modelId) => changeModel(modelId)}
            onEffortChange={changeEffort}
            vendorKey={vendorKeyFor(settings.agentKind)}
            currentProviderId={activeSettings.providerId}
            onProviderChange={(providerId, modelId) => {
              changeModel(modelId ?? activeSettings.model, providerId);
            }}
            switching={pending}
            triggerVariant="field"
            popoverSide="bottom"
          />
        </div>
      </div>
    </section>
  );
}

function toImDefaultEffort(effort: Effort | null | undefined): ImDefaultEffort | null {
  return isImDefaultEffort(effort) ? effort : null;
}
