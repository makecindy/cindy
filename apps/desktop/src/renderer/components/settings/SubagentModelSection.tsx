import { subagentModelSettings } from './SubagentModelSection.settings-search';
import { useAppSettingsRevision } from '@/hooks/useAppSettingsRevision';
/** Settings -> Personalization: Claude Code default Subagent model + Codex smart routing. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  connectedProvidersForAgent,
  getModel,
  isModelSelectableForNewRoute,
  visibleModelUnion,
} from '@cindy/model-providers';

import { ClaudeMark } from '@/components/icons/ClaudeMark';
import { CodexMark } from '@/components/icons/CodexMark';
import { ModelSelector } from '@/components/new-chat/ModelSelector';
import type { ModelGroupsPickerProps } from '@/components/new-chat/ModelGroupsPickerSection';
import { useModelGroups } from '@/features/model-groups/modelGroupsClient';
import { auxiliaryRouteRefId, encodeAuxiliaryRouteRef } from '../../../shared/auxiliaryModelChain';
import { SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import { Switch } from '@/components/ui/switch';
import { useProviders } from '@/hooks/useProviders';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import {
  CODEX_SUBAGENT_MODEL_KEYS,
  CLAUDE_SUBAGENT_MODEL_KEYS,
  SUBAGENT_MODEL_SETTINGS_DEFAULTS,
  type SubagentModelSettingsPatch,
  type SubagentModelSettingsState,
} from '../../../shared/subagentModelSettings';
import { DefaultOverrideControls } from './DefaultOverrideControls';

const log = createLogger('SubagentModelSection');

function defaultsPatchFor(
  keys: readonly (keyof SubagentModelSettingsPatch)[],
): SubagentModelSettingsPatch {
  const patch: SubagentModelSettingsPatch = {};
  for (const key of keys) {
    (patch as Record<string, unknown>)[key] = SUBAGENT_MODEL_SETTINGS_DEFAULTS[key];
  }
  return patch;
}

export function SubagentModelSection() {
  const settingsRevision = useAppSettingsRevision('subagent-models');
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { providers, loading: providersLoading } = useProviders();
  // Subagent 也能选一条智能路由(2026-11-26 用户裁决)：只列自己排的、含本机 Claude Code 来源的路由。子代理跑在主任务的
  // 来源上，用的是路由里与主任务同一个供应商的那个模型；合并整个供应商的路由对它等于直接选模型，不另列。
  const { config: groupsConfig } = useModelGroups();
  const subagentRoutes = useMemo(() => ({
    ...groupsConfig,
    routes: groupsConfig.routes.filter((route) => !route.parent
      && route.candidates.some((candidate) => candidate.agentKind === 'cc' && !candidate.agentDeviceId && !candidate.off)),
  }), [groupsConfig]);
  const [settings, setSettings] = useState<SubagentModelSettingsState | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const settingsRef = useRef<SubagentModelSettingsState | null>(null);
  settingsRef.current = settings;

  useEffect(() => {
    let disposed = false;
    void window.electronAPI.maker
      .subagentModelSettingsGet()
      .then((next) => {
        if (!disposed) setSettings(next);
      })
      .catch((error) => log.warn('subagentModelSettingsGet failed', error));
    return () => {
      disposed = true;
    };
  }, [settingsRevision]);

  const persistPatch = useCallback(
    async (
      patch: SubagentModelSettingsPatch,
      opts?: { successToast?: string; errorToast?: string },
    ): Promise<boolean> => {
      if (pendingRef.current) return false;
      pendingRef.current = true;
      setPending(true);
      try {
        const next = await window.electronAPI.maker.subagentModelSettingsSet(patch);
        setSettings(next);
        const suffix = next.codexRestartDeferred
          ? t('settings.subagentModels.toast.deferredSuffix')
          : '';
        if (suffix || opts?.successToast) {
          toast.success(
            `${opts?.successToast ?? t('settings.subagentModels.toast.saved')}${suffix}`,
          );
        }
        return true;
      } catch (error) {
        log.warn('subagentModelSettingsSet failed', error);
        toast.error(
          opts?.errorToast ??
            (error instanceof Error ? error.message : t('settings.subagentModels.saveFailed')),
        );
        return false;
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [t],
  );

  const resolveClaudeProviderId = useCallback(
    (modelId: string, providerId: string | null): string | null => {
      if (!providerId) return null;
      const provider = connectedProvidersForAgent(providers, 'claude-code').find(
        (entry) => entry.id === providerId,
      );
      const model = provider ? getModel(provider, modelId, 'claude-code') : undefined;
      return provider &&
        model &&
        isModelSelectableForNewRoute(model, {
          userProvider: provider.source === 'user',
        })
        ? providerId
        : null;
    },
    [providers],
  );

  const setClaudeModel = useCallback(
    async (model: string | null, providerId: string | null) => {
      const current = settingsRef.current;
      if (!current) return false;
      const nextProviderId = model === null ? null : providerId;
      if (model === current.claudeCode && nextProviderId === current.claudeCodeProviderId) return;
      return persistPatch({ claudeCode: model, claudeCodeProviderId: nextProviderId });
    },
    [persistPatch],
  );

  const resetKeys = useCallback(
    async (keys: readonly (keyof SubagentModelSettingsPatch)[]) => {
      await persistPatch(defaultsPatchFor(keys), {
        successToast: t('settings.defaults.restored'),
        errorToast: t('settings.defaults.restoreFailed'),
      });
    },
    [persistPatch, t],
  );

  if (!settings) return null;

  const claudeSourceDisconnected = Boolean(
    !providersLoading &&
    settings.claudeCodeProviderId &&
    !connectedProvidersForAgent(providers, 'claude-code').some((provider) => {
      if (provider.id !== settings.claudeCodeProviderId) return false;
      if (settings.claudeCode === null) return true;
      const model = getModel(provider, settings.claudeCode, 'claude-code');
      return Boolean(
        model && isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' }),
      );
    }),
  );
  const hasCatalogClaudeModel = visibleModelUnion(providers, 'claude-code', () => true).length > 0;
  const claudeCustomized = settings.customizedKeys.some((key) =>
    (CLAUDE_SUBAGENT_MODEL_KEYS as readonly string[]).includes(key),
  );
  const smartRoutingCustomized = settings.customizedKeys.some((key) =>
    (CODEX_SUBAGENT_MODEL_KEYS as readonly string[]).includes(key),
  );

  return (
    <SubagentModelSectionView
      claudeCode={settings.claudeCode}
      claudeCodeProviderId={settings.claudeCodeProviderId}
      codexSmartSubagentRouting={settings.codexSmartSubagentRouting}
      claudeCustomized={claudeCustomized}
      smartRoutingCustomized={smartRoutingCustomized}
      pending={pending}
      providersLoading={providersLoading}
      claudeSourceDisconnected={claudeSourceDisconnected}
      onNavigateToProviders={
        providersLoading || hasCatalogClaudeModel
          ? undefined
          : () => navigate('/settings?tab=providers')
      }
      setClaudeModel={setClaudeModel}
      {...(subagentRoutes.routes.length > 0 || auxiliaryRouteRefId(settings.claudeCode ?? '') ? {
        modelGroups: {
          config: subagentRoutes,
          active: auxiliaryRouteRefId(settings.claudeCode ?? '') ? { type: 'route' as const, id: auxiliaryRouteRefId(settings.claudeCode!)! } : null,
          onSelect: (selection) => { void setClaudeModel(encodeAuxiliaryRouteRef(selection.id), null); },
          onManage: () => navigate('/settings?tab=model-groups'),
        } satisfies ModelGroupsPickerProps,
      } : {})}
      resolveClaudeProviderId={resolveClaudeProviderId}
      resetClaude={() => void resetKeys(CLAUDE_SUBAGENT_MODEL_KEYS)}
      resetSmartRouting={() => void resetKeys(CODEX_SUBAGENT_MODEL_KEYS)}
      setSmartRouting={(next) => void persistPatch({ codexSmartSubagentRouting: next })}
    />
  );
}

/** Subagent 卡片的展示部分;云实例设置传入目标实例的值与 deviceId(模型目录所在设备)。 */
export function SubagentModelSectionView({
  claudeCode,
  claudeCodeProviderId,
  codexSmartSubagentRouting,
  claudeCustomized,
  smartRoutingCustomized,
  pending,
  providersLoading,
  claudeSourceDisconnected,
  onNavigateToProviders,
  deviceId,
  setClaudeModel,
  modelGroups,
  resolveClaudeProviderId,
  resetClaude,
  resetSmartRouting,
  setSmartRouting,
  headingStatus,
}: {
  claudeCode: string | null;
  claudeCodeProviderId: string | null;
  codexSmartSubagentRouting: boolean;
  claudeCustomized: boolean;
  smartRoutingCustomized: boolean;
  pending: boolean;
  providersLoading: boolean;
  claudeSourceDisconnected: boolean;
  onNavigateToProviders?: () => void;
  deviceId?: string;
  setClaudeModel: (model: string | null, providerId: string | null) => Promise<boolean | undefined>;
  /** 本机设置才传：Subagent 能选的智能路由；选中时 claudeCode 存为 route:<路由 id>。 */
  modelGroups?: ModelGroupsPickerProps;
  resolveClaudeProviderId: (modelId: string, providerId: string | null) => string | null;
  resetClaude: () => void;
  resetSmartRouting: () => void;
  setSmartRouting: (next: boolean) => void;
  /** Cloud settings: a group that could not be read says so here, in place of the heading's action. */
  headingStatus?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const settings = { claudeCode, claudeCodeProviderId, codexSmartSubagentRouting };

  return (
    <SettingsSection
      title={t('settings.subagentModels.title')}
      description={t('settings.subagentModels.description')}
      caption={t('settings.subagentModels.hint')}
      action={headingStatus}
    >
      <SettingsCard>
        <SettingsRow
          lead={<ClaudeMark size={16} className="text-[var(--text-secondary)]" />}
          title="Claude Code"
          trailing={
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {/* Per-setting reset: left of the control, only while customized. */}
              <DefaultOverrideControls
                isCustomized={claudeCustomized}
                disabled={pending}
                onReset={resetClaude}
              />
              <div className="min-w-0 flex-1">
                <ModelSelector
                  {...(deviceId
                    ? { deviceId, remoteAgent: undefined }
                    : { localOnlyReason: 'subagent-in-parent-task' as const })}
                  modelId={auxiliaryRouteRefId(settings.claudeCode ?? '') ? '' : (settings.claudeCode ?? '')}
                  {...(modelGroups ? { modelGroups } : {})}
                  effort=""
                  onModelChange={(modelId) => {
                    return setClaudeModel(modelId, settings.claudeCodeProviderId);
                  }}
                  onEffortChange={() => undefined}
                  vendorKey="cc"
                  currentProviderId={settings.claudeCodeProviderId}
                  sourceDisconnected={claudeSourceDisconnected}
                  onNavigateToProviders={onNavigateToProviders}
                  reselectEmitsChange
                  onProviderChange={(providerId, modelId) => {
                    const nextModel = modelId ?? settings.claudeCode;
                    if (!nextModel) return false;
                    return setClaudeModel(nextModel, resolveClaudeProviderId(nextModel, providerId));
                  }}
                  switching={pending}
                  disabled={providersLoading}
                  triggerVariant="field"
                  popoverSide="bottom"
                  configurationEnabled={false}
                  unknownModelLabel={(id) => id}
                  fallbackOption={{
                    active: settings.claudeCode === null,
                    label: t('settings.subagentModels.unspecified'),
                    onSelect: () => {
                      return setClaudeModel(null, null);
                    },
                  }}
                />
              </div>
            </div>
          }
        />

        <SettingsRow
          lead={<CodexMark size={16} className="shrink-0 text-[var(--text-secondary)]" />}
          title={
            <span id={subagentModelSettings.subagentModelsSmartRoutingLabel.targetId}>
              {t(subagentModelSettings.subagentModelsSmartRoutingLabel.titleKey)}
            </span>
          }
          hint={
            settings.codexSmartSubagentRouting
              ? t('settings.subagentModels.smartRouting.enabledHint')
              : t('settings.subagentModels.smartRouting.nativeHint')
          }
          trailing={
            <div className="flex shrink-0 items-center gap-3">
              <DefaultOverrideControls
                isCustomized={smartRoutingCustomized}
                disabled={pending}
                onReset={resetSmartRouting}
              />
              <Switch data-setting-id={subagentModelSettings.subagentModelsSmartRoutingLabel.id}
                checked={settings.codexSmartSubagentRouting}
                disabled={pending}
                onCheckedChange={setSmartRouting}
                aria-label={t('settings.subagentModels.smartRouting.aria')}
              />
            </div>
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}
