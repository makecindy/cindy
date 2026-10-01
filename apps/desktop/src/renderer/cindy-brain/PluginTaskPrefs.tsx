import { Button } from '@/components/ui/button';
/** User preferences for new plugin tasks; uses the ordinary model/permission controls. */

import { useModelPickerAgents } from '@/hooks/useAvailableAgents';
import { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, FolderOpen, X } from 'lucide-react';

import { extractIpcError } from '@/utils/ipcError';
import { cn } from '@/lib/utils';
import { ModelSelector } from '@/components/new-chat/ModelSelector';
import { PermissionSelector } from '@/components/new-chat/PermissionSelector';
import {
  getEffortForModel,
  getFastModeForModel,
  useNewMakerDraft,
} from '@/state/newMakerDraft';
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
}: {
  ghostId: string;
  /** Plugin detail aligns the card with the shared Plugin surface. */
  appearance?: 'settings' | 'plugin';
  /** Old errand-only plugins retain their original default until the user chooses a mode. */
  legacyDefault?: boolean;
}) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<TaskConfig>(
    () => (window.electronAPI.ghosts.errandPrefsSync(ghostId).config ?? {}) as TaskConfig,
  );
  // This previews panel creation. Calls from a task use its current route.
  const draft = useNewMakerDraft();
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

  const followVendor: 'cc' | 'codex' | 'pi' =
    draft.vendor === 'pi' ? 'pi' : draft.vendor === 'codex' ? 'codex' : 'cc';
  const vendor: 'cc' | 'codex' | 'pi' = config.agentKind ?? followVendor;
  const pickerAgents = useModelPickerAgents(vendor === 'cc' ? 'claude-code' : vendor);

  const customized = [config.agentKind, config.model, config.providerId, config.effort, config.fastMode]
    .some(value => value !== undefined);
  const shownProvider = config.providerId ?? draft.lastByVendor[vendor]?.providerId ?? null;
  const shownModel = config.model ?? draft.lastByVendor[vendor].model;
  const routeEffort = customized ? config.effort : draft.lastByVendor[vendor]?.effort;
  const shownEffort = (routeEffort ??
    getEffortForModel(shownModel) ??
    'high') as Effort;
  const shownFast = config.fastMode ?? getFastModeForModel(shownModel);
  const permissionMode = config.permissionMode ?? (legacyDefault ? 'plan' : 'ask');

  const pickWorkingDir = async (): Promise<void> => {
    const result = await window.electronAPI.showOpenDirectoryDialog();
    if (!result.canceled && result.path) {
      await save({ ...config, workingDir: result.path });
    }
  };

  const labelCls = cn(
    'min-w-0 shrink-0 text-[var(--text-secondary)]',
    appearance === 'plugin' ? 'text-13 leading-5' : 'text-12',
  );
  const row = (key: string, control: ReactNode): ReactNode => (
    <div className="flex min-w-0 items-center justify-between gap-4">
      <span className={labelCls}>{t(`settings.ghosts.detail.errandPrefs.${key}`)}</span>
      {control}
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
      <p
        className={cn(
          'text-[var(--text-tertiary)]',
          appearance === 'plugin' ? 'text-13 leading-5' : 'text-12',
        )}
      >
        {t(`settings.ghosts.detail.errandPrefs.${legacyDefault ? 'legacyDesc' : 'desc'}`)}
      </p>

      {/* 模型选择器占满整行(标题在上、控件 w-full 在下,与 IM 默认配置同款):
          field 形态的面板宽度绑定 trigger 宽度(DESIGN.md §4),压到 60% 会让下拉
          窄到把模型名截断,所以这里给它整行宽度。 */}
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-12 leading-4 text-[var(--text-secondary)]">
            {t(`settings.ghosts.detail.errandPrefs.${customized ? 'sourceCustom' : 'sourceDefault'}`)}
          </span>
          {customized ? <Button type="button" variant="secondary" tone="quiet" size="sm" disabled={saving}
            onClick={() => save({ permissionMode: config.permissionMode, workingDir: config.workingDir })}>
            {t('settings.ghosts.detail.errandPrefs.restoreModel')}
          </Button> : null}
        </div>
        <span className={labelCls}>{t('settings.ghosts.detail.errandPrefs.model')}</span>
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
          currentProviderId={shownProvider}
          triggerVariant="field"
          popoverSide="bottom"
          ariaContext={t('settings.ghosts.detail.errandPrefs.model')}
          onModelChange={(modelId) =>
            // 选模型即整组钉住(agent 一起钉,防草稿随后换 vendor 让模型悬空)。
            save({ ...config, agentKind: vendor, providerId: shownProvider ?? undefined, model: modelId, effort: undefined, fastMode: false })
          }
          onEffortChange={(effort) => {
            if (!TASK_EFFORTS.has(effort)) return;
            return save({ ...config, agentKind: vendor, providerId: shownProvider ?? undefined, model: shownModel, effort, fastMode: shownFast });
          }}
          onFastModeChange={(enabled) =>
            save({ ...config, agentKind: vendor, providerId: shownProvider ?? undefined, model: shownModel,
              effort: TASK_EFFORTS.has(routeEffort ?? '') ? routeEffort : undefined, fastMode: enabled })
          }
          onProviderChange={(providerId, modelId, reconciledEffort, reconciledFast) =>
            save({
              ...config,
              agentKind: vendor,
              model: modelId ?? shownModel,
              effort: TASK_EFFORTS.has(reconciledEffort ?? '')
                ? reconciledEffort
                : undefined,
              providerId: providerId ?? undefined,
              fastMode: reconciledFast ?? false,
            })
          }
        />
      </div>

      {error ? <p role="alert" className="text-12 leading-5 text-[var(--text-secondary)]">{error}</p> : null}

      {row(
        'permission',
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
        />,
      )}

      {row(
        'workdir',
        <div className="flex min-w-0 max-w-[60%] items-center gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-right text-[var(--text-tertiary)]',
              appearance === 'plugin' ? 'text-13 leading-5' : 'text-12',
            )}
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
        </div>,
      )}
    </fieldset>
  );
}
