import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/ui/form-field';
import { ErrorNotice } from '@/components/ui/error-notice';
import {
  SettingsBlock,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from '@/components/ui/settings-rows';
import { toast } from '@/lib/toast';
import type { TaskArchiveSettings } from '../../../shared/taskManagement';
import { taskManagementSettings } from './TaskManagement.settings-search';
import { useSettingDefinition } from './useSettingDefinition';

export function TaskManagementSection() {
  const { t } = useTranslation();
  const { dataOwnerId, dataOwnerRecoveryEpoch, dataOwnerGeneration } = useAuth();
  const enabledField = useSettingDefinition(taskManagementSettings.enabled);
  const daysField = useSettingDefinition(taskManagementSettings.days);
  const [settings, setSettings] = useState<TaskArchiveSettings | null>(null);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [custom, setCustom] = useState(false);
  const [daysText, setDaysText] = useState('7');
  const generation = useRef(0);
  const savePending = useRef(false);
  const value = Number(daysText);
  const invalid = custom && (!Number.isInteger(value) || value < 1 || value > 365);

  useEffect(() => {
    const owner = ++generation.current;
    setSettings(null);
    setError(false);
    setSaving(false);
    setCustom(false);
    savePending.current = false;
    if (!dataOwnerId) return;
    const load = async () => {
      try {
        const result = await window.electronAPI.taskManagement.read();
        if (owner !== generation.current) return;
        setSettings(result);
        setError(false);
        setDaysText(String(result.days));
        setCustom(![7, 14, 30].includes(result.days));
      } catch {
        if (owner === generation.current) setError(true);
      }
    };
    void load();
    const off = window.electronAPI.taskManagement.onChanged(() => void load());
    return () => {
      generation.current++;
      off();
    };
  }, [dataOwnerId, dataOwnerRecoveryEpoch, dataOwnerGeneration]);

  const save = async (patch: Partial<TaskArchiveSettings> | null) => {
    if (savePending.current || !dataOwnerId) return;
    const owner = generation.current;
    savePending.current = true;
    setSaving(true);
    try {
      const stamp = { ownerId: dataOwnerId, ownerGeneration: dataOwnerGeneration };
      const result =
        patch === null
          ? await window.electronAPI.taskManagement.reset(stamp)
          : await window.electronAPI.taskManagement.update(patch, stamp);
      if (owner !== generation.current) return;
      setSettings(result);
      if (patch === null) {
        setDaysText(String(result.days));
        setCustom(false);
      }
      // The host broadcasts the committed rule change to this window too.
      // Its onChanged handler reloads settings without scanning task counts.
    } catch {
      if (owner === generation.current) toast.error(t('taskManagement.saveFailed'));
    } finally {
      if (owner === generation.current) {
        savePending.current = false;
        setSaving(false);
      }
    }
  };
  return (
    <SettingsSection
      id={taskManagementSettings.page.targetId}
      aria-label={t(taskManagementSettings.page.titleKey)}
      title={t(taskManagementSettings.page.titleKey)}
      description={t(taskManagementSettings.page.descriptionKey)}
      action={
        <Button
          variant="secondary"
          tone="quiet"
          size="sm"
          disabled={saving || !settings}
          data-settings-search-action="Reset task archive preferences to defaults"
          onClick={() => void save(null)}
        >
          {t('taskManagement.reset')}
        </Button>
      }
    >
      {error && <ErrorNotice message={t('taskManagement.loadFailed')} />}
      {!error && !settings && (
        <p className="text-13 text-[var(--text-secondary)]">{t('taskManagement.loading')}</p>
      )}
      <SettingsCard>
        <SettingsRow
          {...enabledField.anchorProps}
          wrap
          title={enabledField.title}
          hint={enabledField.description}
          trailing={
            <div {...daysField.anchorProps} className="flex min-w-0 max-w-full flex-col gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <Select
                  {...daysField.controlProps}
                  label={daysField.title}
                  width="sm"
                  disabled={!settings || saving}
                  value={custom ? 'custom' : String(settings?.days ?? 7)}
                  options={daysField.options}
                  onValueChange={(choice) => {
                    if (choice === 'custom') {
                      setCustom(true);
                      return;
                    }
                    setCustom(false);
                    setDaysText(choice);
                    void save({ days: Number(choice) });
                  }}
                />
                <Switch
                  {...enabledField.controlProps}
                  aria-label={enabledField.title}
                  checked={settings?.enabled ?? false}
                  disabled={!settings || saving || (invalid && !settings.enabled)}
                  onCheckedChange={(enabled) => void save({ enabled })}
                />
              </div>
              {custom && (
                <FormField
                  label={t('taskManagement.customDays')}
                  error={invalid ? t('taskManagement.invalidDays') : undefined}
                >
                  {(control) => (
                    <Input
                      {...control}
                      {...daysField.controlProps}
                      type="number"
                      min={1}
                      max={365}
                      step={1}
                      inputMode="numeric"
                      value={daysText}
                      disabled={saving}
                      onChange={setDaysText}
                      onBlur={() => {
                        if (!invalid && value !== settings?.days) void save({ days: value });
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                      }}
                    />
                  )}
                </FormField>
              )}
            </div>
          }
        />
        <SettingsBlock>
          <p className="text-12 text-[var(--text-secondary)]">{t('taskManagement.archiveHint')}</p>
        </SettingsBlock>
      </SettingsCard>
    </SettingsSection>
  );
}
