import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Folder, Info, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SETTINGS_HINT, SettingsBlock, SettingsCard, SettingsRow } from '@/components/ui/settings-rows';
import { Tip } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';
import type { TaskExportDirectoryState } from '../../../shared/taskExportDirectory';
import { storageManagementCardSettings } from './StorageManagementCard.settings-search';
import { useSettingDefinition } from './useSettingDefinition';

/** Where Agent task exports are saved without asking. Unset keeps the save dialog. */
export function TaskExportDirectorySection() {
  const { t } = useTranslation();
  const setting = useSettingDefinition(storageManagementCardSettings.taskExportDirectory);
  const [state, setState] = useState<TaskExportDirectoryState | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const revision = useRef(0);
  const api = window.electronAPI.taskExportDirectory;

  useEffect(() => {
    if (!api) return;
    let active = true;
    const request = ++revision.current;
    void api.get().then((value) => { if (active && request === revision.current) setState(value); }).catch((error) => {
      if (active) toast.error(t(mapIpcErrorToI18nKey(error, { fallback: 'settings.about.storage.taskExportDirectoryFailed' })));
    });
    return () => { active = false; revision.current++; };
  }, [api, t]);

  const update = async (action: 'choose' | 'reset') => {
    if (!api || pending.current) return;
    pending.current = true;
    const request = ++revision.current;
    setBusy(true);
    try {
      const value = await api[action]();
      if (request === revision.current) setState(value);
    } catch (error) {
      toast.error(t(mapIpcErrorToI18nKey(error, { fallback: 'settings.about.storage.taskExportDirectoryFailed' })));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  if (!api) return null;
  // Unreadable or missing folders need attention; exports fail until the owner fixes them.
  const warning = !!state && (state.unreadable || (!!state.path && !state.exists));
  const badge = state && (state.unreadable
    ? t('settings.about.storage.taskExportDirectoryUnreadable')
    : !state.path ? t('settings.about.storage.taskExportDirectoryUnset')
      : !state.exists ? t('settings.about.storage.taskExportDirectoryMissing') : null);
  const canReset = !!state && (state.unreadable || !!state.path);
  return (
    <SettingsCard {...setting.anchorProps}>
      <SettingsRow
        wrap
        title={<span role="heading" aria-level={3}>{setting.title}</span>}
        tag={badge && (
          <span className={cn('rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-11',
            warning ? 'text-[var(--warning-fg)]' : 'text-[var(--text-secondary)]')}>
            {badge}
          </span>
        )}
        hint={state?.path && (
          <span className="flex min-w-0 items-center gap-1.5" title={state.path}>
            <Folder size={15} className="shrink-0" aria-hidden />
            <span className="min-w-0 select-text truncate">{state.path}</span>
          </span>
        )}
        trailing={
          <div className="flex shrink-0 items-center gap-2">
            {canReset && (
              <Tip text={t('settings.about.storage.taskExportDirectoryReset')}>
                <Button data-settings-search-action="Ask for a location on each session export" variant="secondary" tone="quiet" size="sm" className="w-7 px-0" disabled={busy} aria-label={t('settings.about.storage.taskExportDirectoryReset')} onClick={() => void update('reset')}>
                  <RotateCcw size={15} aria-hidden />
                </Button>
              </Tip>
            )}
            <Button {...setting.controlProps} variant="secondary" size="md" className="gap-1.5" disabled={busy} onClick={() => void update('choose')}>
              {t('settings.about.storage.taskExportDirectoryChoose')}<ChevronRight size={14} aria-hidden />
            </Button>
          </div>
        }
      />
      <SettingsBlock>
        <p className={cn('flex items-start gap-1.5', SETTINGS_HINT)}>
          <Info size={13} className="mt-0.5 shrink-0" aria-hidden />{setting.description}
        </p>
      </SettingsBlock>
    </SettingsCard>
  );
}
