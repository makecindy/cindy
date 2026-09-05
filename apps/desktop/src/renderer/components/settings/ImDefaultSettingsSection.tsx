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
import { MessageSquare, AlertTriangle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AgentSelect } from '@/components/new-chat/AgentSelect';
import { ModelSelector } from '@/components/new-chat/ModelSelector';
import { PermissionSelector } from '@/components/new-chat/PermissionSelector';
import { type ModelDescriptor, useAgentCapabilities } from '@/hooks/useAgentCapabilities';
import { useProviders } from '@/hooks/useProviders';
import { deriveModelsFromProviders } from '@/lib/providerModels';
import { toast } from '@/lib/toast';
import type { Effort } from '@/lib/userPreferences.types';
import { cn } from '@/lib/utils';
import {
  IM_DEFAULT_EFFORT_OVERRIDES,
  IM_DEFAULT_SETTINGS,
  isUnconditionalTurnPolicyChannel,
  isImDefaultPermissionMode,
  type ImDefaultAgentKind,
  type ImDefaultEffort,
  type ImDefaultSettingsChannel,
  type ImDefaultSettingsPatch,
  type ImDefaultSettingsState,
  isImDefaultEffort,
} from '../../../shared/imDefaultSettings';
import { DefaultOverrideControls } from './DefaultOverrideControls';
import {
  buildAgentSettingsPatch,
  mergeSettingsPatch,
  resolveAgentSwitchSettings,
} from './imDefaultSettingsLogic';

function vendorKeyFor(agentKind: ImDefaultAgentKind): 'cc' | 'codex' | 'pi' {
  return agentKind === 'claude-code' ? 'cc' : agentKind;
}

/** AgentSelect 的 vendor → IM 默认配置的 agentKind。 */
function agentKindOfVendor(vendor: string): ImDefaultAgentKind {
  return vendor === 'cc' ? 'claude-code' : vendor === 'pi' ? 'pi' : 'codex';
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
  /**
   * 只换说明文案的键(不影响读写 scope)。
   *
   * 官方 hook 卡曾有一个 'officialHook' 变体(写 global scope), 已随「新对话配置」
   * 区块一并移除 —— 它与目录行的 agent/model/effort 是同一份配置的两个入口, 画成
   * 平级两套只会让人以为可以分别设。global scope 仍是目录行的兜底层, 只是不再有
   * UI 入口(与 X 卡今天一致)。
   */
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
      if (!settings || pending) return false;
      const previous = settings;
      setPending(true);
      setSettings(mergeSettingsPatch(settings, patch));
      try {
        const next = await window.electronAPI.maker.imDefaultSettingsSet(patch, channel);
        setSettings(next);
        return true;
      } catch (err) {
        setSettings(previous);
        toast.error(err instanceof Error ? err.message : t('settings.imBot.defaults.saveFailed'));
        return false;
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
          'text-13 text-[var(--text-tertiary)]',
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
  // 按选中 Agent 的 capabilities 判断:未声明 / 声明了但 supported.supported !== true
  // 的 Agent(如 Pi)无法在「无条件挂逐条权限确认」的渠道(个人微信)使用。不写死 Pi——
  // 未来 Pi 补上该 capability、或新增其它不支持的 Agent 时,此处自动跟随 main 侧
  // 的 capability 真相,不会误警告 / 漏警告。(Telegram / 钉钉仅在群聊挂 policy,
  // 主人私聊 Pi 可用,设置 UI 不区分群聊/私聊,故不整体警告。)
  const selectedAgentCaps =
    settings.agentKind === 'claude-code'
      ? cc
      : settings.agentKind === 'codex'
        ? codex
        : pi;
  const selectedAgentCapabilitiesReady =
    !selectedAgentCaps.loading &&
    selectedAgentCaps.error === null &&
    selectedAgentCaps.capabilities !== null;
  const selectedTurnPolicy = selectedAgentCaps.capabilities?.turnPermissionPolicy;
  const selectedAgentUnsupported =
    selectedAgentCapabilitiesReady && selectedTurnPolicy?.supported.supported !== true;
  const selectedPermissionModeUnsupported =
    selectedAgentCapabilitiesReady &&
    selectedTurnPolicy?.supported.supported === true &&
    selectedTurnPolicy.unsupportedPermissionModes.includes(settings.permissionMode);
  // 渠道默认权限模式若是换 Agent 后仍不兼容的档位(Claude Code / Codex 的
  // unsupportedPermissionModes 并集:bypassPermissions / acceptEdits),仅换 Agent
  // 会在新会话(/new)上再次命中权限模式错误,警告需附加 /permission 提示。
  const modeUnsupportedAfterSwitch =
    settings.permissionMode === 'bypassPermissions' || settings.permissionMode === 'acceptEdits';
  const turnPolicyWarning =
    channel !== undefined && isUnconditionalTurnPolicyChannel(channel)
      ? selectedAgentUnsupported
        ? 'agent'
        : selectedPermissionModeUnsupported
          ? 'mode'
          : null
      : null;

  const changeAgent = (agentKind: ImDefaultAgentKind) => {
    if (agentKind === settings.agentKind) return;
    // 只写 agentKind 会把目标 agent 上一次的模型原样带回来 —— 那个模型可能已停用
    // 或供应商已断开, UI 照显而派发时静默降级。与 changeModel 同口径收敛。
    const next = resolveAgentSwitchSettings({
      current: settings.agents[agentKind],
      available: modelsByAgent[agentKind],
      // 与 changeModel 共用同一条解析链(model override / defaultEffort 先于 agent 出厂值)
      resolveEffort: (modelId, requested) => resolveEffort(agentKind, modelId, requested),
      resolveProviderId: (modelId, providerId) =>
        resolveProviderId(agentKind, modelId, providerId),
    });
    void persist({ agentKind, ...buildAgentSettingsPatch(agentKind, next) });
  };

  const changeModel = (
    model: string,
    providerId: string | null = activeSettings.providerId,
    reconciledEffort?: Effort,
  ) => {
    const nextProviderId = resolveProviderId(settings.agentKind, model, providerId);
    const effort = isImDefaultEffort(reconciledEffort)
      ? reconciledEffort
      : resolveEffort(settings.agentKind, model, activeSettings.effort);
    return persist(
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
    return persist(
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
            <h3 className="text-14 font-medium leading-none text-[var(--settings-section-title)]">
              {t('settings.imBot.defaults.title')}
            </h3>
            <p className="mt-2 text-12 leading-[1.45] text-[var(--settings-section-desc)]">
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
          <span className="text-12 font-medium text-[var(--text-secondary)]">
            {t('settings.imBot.defaults.agentLabel')}
          </span>
          {/* 与新建对话工具条同一个引擎下拉(AgentSelect, #1350): 手写三选一分段在
              窄列里三等分 + truncate, 引擎一多就挤; 且未选中项置灰看着像不可用。 */}
          <AgentSelect
            value={vendorKeyFor(settings.agentKind)}
            // 字段形态: 与右侧模型选择器同高同宽规格, 面板绑 trigger 宽度
            // (DESIGN.md §4 Select & Dropdown 宽度铁则)。
            triggerVariant="field"
            side="bottom"
            disabled={pending}
            ariaContext={t('settings.imBot.defaults.agentLabel')}
            onChange={(next) => changeAgent(agentKindOfVendor(next))}
          />
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-12 font-medium text-[var(--text-secondary)]">
            {t('settings.imBot.defaults.modelLabel')}
          </span>
          <ModelSelector
            modelId={activeSettings.model}
            effort={activeSettings.effort}
            onModelChange={(modelId) => changeModel(modelId)}
            onEffortChange={changeEffort}
            vendorKey={vendorKeyFor(settings.agentKind)}
            currentProviderId={activeSettings.providerId}
            onProviderChange={(providerId, modelId, reconciledEffort) => {
              changeModel(modelId ?? activeSettings.model, providerId, reconciledEffort);
            }}
            switching={pending}
            triggerVariant="field"
            popoverSide="bottom"
          />
        </div>
      </div>

      {/* 飞书专属: 群里新建任务统一用的权限档(默认自动审批) —— 群里 @bot 开话题、
          群里 /new、群里 /ctr 都以它为准, 上面那个权限档只管私聊。群上下文含成员
          可控内容; 用户显式选择「完全访问」时群护栏取缔(不挂强确认策略, 直接
          执行), 防注入过滤仍独立生效。共享 PermissionSelector — 权限语义与
          新建对话工具栏同一份。 */}
      {channel === 'feishu' && (
        <div className="flex flex-col gap-2">
          <span className="text-12 font-medium text-[var(--text-secondary)]">
            {t('settings.imBot.defaults.groupPermissionLabel')}
          </span>
          <PermissionSelector
            permissionMode={settings.groupPermissionMode}
            vendorKey={vendorKeyFor(settings.agentKind)}
            triggerVariant="field"
            disabled={pending}
            ariaContext={t('settings.imBot.defaults.groupPermissionLabel')}
            onPermissionModeChange={(mode) => {
              if (isImDefaultPermissionMode(mode)) {
                void persist({ groupPermissionMode: mode });
              }
            }}
          />
          <p className="text-11 leading-[1.45] text-[var(--text-secondary)]">
            {t('settings.imBot.defaults.groupPermissionDescription')}
          </p>
        </div>
      )}

      {turnPolicyWarning && (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="flex items-start gap-2 rounded-lg bg-[var(--warning-bg-soft)] px-3 py-2"
        >
          <AlertTriangle
            size={14}
            className="mt-0.5 shrink-0 text-[var(--warning-fg)]"
            aria-hidden
          />
          <div className="min-w-0">
            {turnPolicyWarning === 'agent' ? (
              <>
                <p className="text-11 leading-[1.45] text-[var(--text-secondary)]">
                  {t('settings.imBot.defaults.agentUnsupportedOnChannelHint', {
                    agent: t(`settings.imBot.defaults.agents.${settings.agentKind}`),
                  })}
                </p>
                {modeUnsupportedAfterSwitch && (
                  <p className="mt-1 text-11 leading-[1.45] text-[var(--text-secondary)]">
                    {t('settings.imBot.defaults.agentUnsupportedOnChannelModeHint')}
                  </p>
                )}
              </>
            ) : (
              <p className="text-11 leading-[1.45] text-[var(--text-secondary)]">
                {t('settings.imBot.defaults.permissionModeUnsupportedOnChannelHint')}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function toImDefaultEffort(effort: Effort | null | undefined): ImDefaultEffort | null {
  return isImDefaultEffort(effort) ? effort : null;
}
