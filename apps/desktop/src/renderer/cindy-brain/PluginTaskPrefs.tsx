/**
 * Plugin "Model & tasks" preferences: the plugin's single model field (used by
 * Cindy quick answers and by the tasks the plugin creates) plus the task
 * permission and working-directory rows. Reuses the ordinary model/permission
 * controls; persistence stays in ghost-errand-prefs.json via ghosts:errand-prefs.
 */

import { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, FolderOpen, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useModelPickerAgents } from '@/hooks/useAvailableAgents';
import { extractIpcError } from '@/utils/ipcError';
import { cn } from '@/lib/utils';
import { ModelSelector } from '@/components/new-chat/ModelSelector';
import { PermissionSelector } from '@/components/new-chat/PermissionSelector';
import { getEffortForModel, getFastModeForModel } from '@/state/newMakerDraft';
import type { Effort } from '@/lib/userPreferences.types';

const PERMISSION_ALLOWED = new Set(['ask', 'acceptEdits', 'auto']);

/** Values accepted by the ordinary model picker and Host configuration. */
const TASK_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

interface TaskConfig {
  agentKind?: 'cc' | 'codex' | 'pi';
  model?: string;
  effort?: string;
  fastMode?: boolean;
  providerId?: string;
  permissionMode?: 'ask' | 'plan' | 'acceptEdits' | 'auto';
  workingDir?: string;
}

export function PluginTaskPrefs({
  ghostId,
  appearance = 'settings',
  legacyDefault = false,
  showTaskRows = true,
}: {
  ghostId: string;
  /** Plugin detail aligns the card with the shared Plugin surface. */
  appearance?: 'settings' | 'plugin';
  /** Old errand-only plugins retain their original default until the user chooses a mode. */
  legacyDefault?: boolean;
  /** Plugins that cannot create tasks (quick answers only) show just the model row. */
  showTaskRows?: boolean;
}) {
  const { t } = useTranslation();
  const [initial] = useState(() => window.electronAPI.ghosts.errandPrefsSync(ghostId));
  const [config, setConfig] = useState<TaskConfig>(() => (initial.config ?? {}) as TaskConfig);
  const auxiliaryModelLabel = initial.auxiliaryModelLabel ?? null;
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = useCallback(
    async (next: TaskConfig) => {
      const prev = config;
      setError(null);
      setSaving(true);
      setConfig(next);
      try {
        const result = await window.electronAPI.ghosts.setErrandConfig(
          ghostId,
          next as Record<string, unknown>,
        );
        setConfig((result.config ?? {}) as TaskConfig);
        return true;
      } catch (cause) {
        setConfig(prev);
        setError(extractIpcError(cause)?.message || t('settings.ghosts.errors.generic'));
        return false;
      } finally { setSaving(false); }
    },
    [config, ghostId, t],
  );

  // Explicit model = the complete saved combination. Without one the plugin follows
  // the system auxiliary model (quick answers) and the originating task (new tasks).
  const customized = [config.agentKind, config.model, config.providerId, config.effort, config.fastMode]
    .some(value => value !== undefined);
  const vendor = config.agentKind;
  const pickerAgents = useModelPickerAgents(
    vendor === 'cc' ? 'claude-code' : (vendor ?? 'codex'),
  );
  const shownModel = config.model ?? '';
  const shownEffort = (config.effort ?? getEffortForModel(shownModel) ?? 'high') as Effort;
  const shownFast = config.fastMode ?? getFastModeForModel(shownModel);
  const permissionMode = config.permissionMode ?? (legacyDefault ? 'plan' : 'ask');
  const restoreModel = (): Promise<boolean> =>
    save({ permissionMode: config.permissionMode, workingDir: config.workingDir });
  const followLabel = auxiliaryModelLabel
    ? t('settings.ghosts.detail.errandPrefs.followAuxiliary', { model: auxiliaryModelLabel })
    : t('settings.ghosts.detail.errandPrefs.followAuxiliaryUnset');

  const pickWorkingDir = async (): Promise<void> => {
    const result = await window.electronAPI.showOpenDirectoryDialog();
    if (!result.canceled && result.path) {
      await save({ ...config, workingDir: result.path });
    }
  };

  const textCls = appearance === 'plugin' ? 'text-13 leading-5' : 'text-12 leading-4';
  // Label column keeps its own width: a full-width field trigger must never
  // squeeze the label to zero and cover it (its title tooltip then appeared over
  // the label text).
  const row = (key: string, control: ReactNode): ReactNode => (
    <div className="flex min-w-0 items-center gap-4" data-plugin-task-row={key}>
      <span className={cn('w-24 shrink-0 text-[var(--text-secondary)]', textCls)}>
        {t(`settings.ghosts.detail.errandPrefs.${key}`)}
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-2">{control}</div>
    </div>
  );

  return (
    <fieldset disabled={saving}
      className={cn(
        'ghost-errand-prefs min-w-0 max-w-full flex flex-col gap-3 rounded-xl border px-5 py-4',
        appearance === 'plugin'
          ? 'border-[color-mix(in_srgb,var(--border-default)_72%,transparent)] bg-[color-mix(in_srgb,var(--surface-elevated)_82%,var(--surface))]'
          : 'border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]',
      )}
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Bot size={14} className="text-[var(--text-tertiary)]" />
          <p
            className={cn(
              'font-medium text-[var(--text-primary)]',
              appearance === 'plugin' ? 'text-14 leading-[1.571]' : 'text-13',
            )}
          >
            {t('settings.ghosts.detail.errandPrefs.title')}
          </p>
        </div>
        <p className={cn('text-[var(--text-tertiary)]', textCls)}>
          {t(`settings.ghosts.detail.errandPrefs.${showTaskRows ? 'desc' : 'descModelOnly'}`)}
        </p>
      </div>

      {row(
        'model',
        <>
          <div className="min-w-0 flex-1">
            <ModelSelector
              disabled={saving}
              unifiedAgents={pickerAgents}
              onUnifiedSelect={({ engine, providerId, modelId, effort, fast }) => save({
                ...config,
                agentKind: engine,
                providerId,
                model: modelId,
                effort: TASK_EFFORTS.has(effort ?? '') ? effort : undefined,
                fastMode: fast,
              })}
              modelId={shownModel}
              effort={shownEffort}
              fastMode={shownFast}
              vendorKey={vendor}
              currentProviderId={config.providerId ?? null}
              triggerVariant="field"
              popoverSide="bottom"
              dense={appearance !== 'plugin'}
              ariaContext={t('settings.ghosts.detail.errandPrefs.model')}
              fallbackOption={{
                active: !customized,
                label: followLabel,
                onSelect: () => (customized ? restoreModel() : undefined),
              }}
              onModelChange={(modelId) => {
                // 选模型即整组钉住(agent 一起钉);未选过时没有可钉的 agent,交给统一面板。
                if (!vendor) return false;
                return save({ ...config, agentKind: vendor, model: modelId, effort: undefined, fastMode: false });
              }}
              onEffortChange={(effort) => {
                if (!customized || !TASK_EFFORTS.has(effort)) return;
                return save({ ...config, effort, fastMode: shownFast });
              }}
              onFastModeChange={(enabled) => {
                if (!customized) return false;
                return save({ ...config, fastMode: enabled });
              }}
              onProviderChange={(providerId, modelId, reconciledEffort, reconciledFast) => {
                if (!vendor) return false;
                return save({
                  ...config,
                  agentKind: vendor,
                  model: modelId ?? config.model,
                  effort: TASK_EFFORTS.has(reconciledEffort ?? '') ? reconciledEffort : undefined,
                  providerId: providerId ?? undefined,
                  fastMode: reconciledFast ?? false,
                });
              }}
            />
          </div>
          {customized ? (
            <Button type="button" variant="secondary" tone="quiet" size="sm" disabled={saving}
              className="shrink-0" onClick={() => void restoreModel()}>
              {t('settings.ghosts.detail.errandPrefs.restoreModel')}
            </Button>
          ) : null}
        </>,
      )}

      {showTaskRows ? row(
        'permission',
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <PermissionSelector
            disabled={saving}
            permissionMode={permissionMode}
            fallbackModeLabel={permissionMode === 'plan' ? t('settings.ghosts.detail.errandPrefs.legacyPermission') : undefined}
            vendorKey={vendor}
            triggerVariant="field"
            ariaContext={t('settings.ghosts.detail.errandPrefs.permission')}
            disabledModes={{
              default: t('settings.ghosts.detail.errandPrefs.permissionDisabled'),
              bypassPermissions: t('settings.ghosts.detail.errandPrefs.permissionDisabled'),
            }}
            onPermissionModeChange={(mode) => {
              // disabledModes 已灰置非法档;这里再执一道白名单(UI 不是安全边界,
              // 存储层与协议层各有一道,三道口径一致)。
              if (!PERMISSION_ALLOWED.has(mode)) return;
              save({
                ...config,
                permissionMode: mode as 'ask' | 'acceptEdits' | 'auto',
              });
            }}
          />
          {legacyDefault && config.permissionMode === undefined ? (
            <p className="text-12 leading-4 text-[var(--text-tertiary)]">
              {t('settings.ghosts.detail.errandPrefs.legacyPermissionHint')}
            </p>
          ) : null}
        </div>,
      ) : null}

      {showTaskRows ? row(
        'workdir',
        <>
          <span
            className={cn('min-w-0 flex-1 truncate text-[var(--text-tertiary)]', textCls)}
            title={config.workingDir}
          >
            {config.workingDir ?? t('settings.ghosts.detail.errandPrefs.workdirDefault')}
          </span>
          {config.workingDir ? (
            <button
              type="button"
              onClick={() => save({ ...config, workingDir: undefined })}
              aria-label={t('settings.ghosts.detail.errandPrefs.workdirClear')}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)]"
            >
              <X size={13} />
            </button>
          ) : null}
          <Button
            variant="secondary"
            size="md"
            compact
            type="button"
            onClick={() => void pickWorkingDir()}
            className="shrink-0"
          >
            <FolderOpen size={13} />
            {t('settings.ghosts.detail.errandPrefs.workdirPick')}
          </Button>
        </>,
      ) : null}

      {error ? <p role="alert" className="text-12 leading-5 text-[var(--text-secondary)]">{error}</p> : null}
    </fieldset>
  );
}
