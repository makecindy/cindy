import { subagentModelSettings } from './SubagentModelSection.settings-search';
import { useAppSettingsRevision } from '@/hooks/useAppSettingsRevision';
/** Settings -> Personalization: Claude Code default Subagent model + Codex smart routing. */

import { useCallback, useEffect, useRef, useState } from 'react';
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
    <SettingsSection
      title={t('settings.subagentModels.title')}
      description={t('settings.subagentModels.description')}
      caption={t('settings.subagentModels.hint')}
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
                onReset={() => void resetKeys(CLAUDE_SUBAGENT_MODEL_KEYS)}
              />
              <div className="min-w-0 flex-1">
                <ModelSelector
                  localOnlyReason="subagent-in-parent-task"
                  modelId={settings.claudeCode ?? ''}
                  effort=""
                  onModelChange={(modelId) => {
                    return setClaudeModel(modelId, settings.claudeCodeProviderId);
                  }}
                  onEffortChange={() => undefined}
                  vendorKey="cc"
                  currentProviderId={settings.claudeCodeProviderId}
                  sourceDisconnected={claudeSourceDisconnected}
                  onNavigateToProviders={
                    providersLoading || hasCatalogClaudeModel
                      ? undefined
                      : () => navigate('/settings?tab=providers')
                  }
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
                onReset={() => void resetKeys(CODEX_SUBAGENT_MODEL_KEYS)}
              />
              <Switch data-setting-id={subagentModelSettings.subagentModelsSmartRoutingLabel.id}
                checked={settings.codexSmartSubagentRouting}
                disabled={pending}
                onCheckedChange={(next) => {
                  void persistPatch({ codexSmartSubagentRouting: next });
                }}
                aria-label={t('settings.subagentModels.smartRouting.aria')}
              />
            </div>
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}
