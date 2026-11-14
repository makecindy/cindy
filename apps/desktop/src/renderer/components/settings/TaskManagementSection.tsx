import { useCallback, useEffect, useRef, useState } from 'react';
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
import { subscribeAllDraftPresence } from '@/lib/composerDraftStore';
import type { TaskArchivePreview, TaskArchiveSettings } from '../../../shared/taskManagement';
import { taskManagementSettings } from './TaskManagement.settings-search';
import { useSettingDefinition } from './useSettingDefinition';

export function TaskManagementSection() {
  const { t, i18n } = useTranslation();
  const { dataOwnerId, dataOwnerRecoveryEpoch, dataOwnerGeneration } = useAuth();
  const enabledField = useSettingDefinition(taskManagementSettings.enabled);
  const daysField = useSettingDefinition(taskManagementSettings.days);
  const [settings, setSettings] = useState<TaskArchiveSettings | null>(null);
  const [preview, setPreview] = useState<TaskArchivePreview | null>(null);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [custom, setCustom] = useState(false);
  const [daysText, setDaysText] = useState('7');
  const generation = useRef(0);
  const previewRequest = useRef(0);
  const savePending = useRef(false);
  const value = Number(daysText);
  const invalid = custom && (!Number.isInteger(value) || value < 1 || value > 365);

  const refreshPreview = useCallback(async () => {
    const request = ++previewRequest.current;
    const owner = generation.current;
    try {
      const result = await window.electronAPI.taskManagement.preview();
      if (request === previewRequest.current && owner === generation.current) {
        setPreview(result);
        setError(false);
      }
    } catch {
      if (request === previewRequest.current && owner === generation.current) {
        setPreview(null);
        setError(true);
      }
    }
  }, []);
  useEffect(() => {
    const owner = ++generation.current;
    setSettings(null);
    setPreview(null);
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
        setDaysText(String(result.days));
        setCustom(![7, 14, 30].includes(result.days));
        await refreshPreview();
      } catch {
        if (owner === generation.current) setError(true);
      }
    };
    void load();
    const off = window.electronAPI.taskManagement.onChanged(() => void load());
    const offArchived = window.electronAPI.taskManagement.onArchived((notice) => {
      if (notice.ownerId === dataOwnerId) void refreshPreview();
    });
    const offDrafts = subscribeAllDraftPresence(() => void refreshPreview());
    // Returning to this window refreshes counts, without resetting an unfinished
    // custom-days edit. Committed settings changes arrive through onChanged.
    window.addEventListener('focus', refreshPreview);
    return () => {
      generation.current++;
      off();
      offArchived();
      offDrafts();
      window.removeEventListener('focus', refreshPreview);
    };
  }, [dataOwnerId, dataOwnerRecoveryEpoch, dataOwnerGeneration, refreshPreview]);

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
      // Its onChanged handler refreshes the counts once for every save/reset.
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
      <div className="grid min-w-0 gap-8 xl:grid-cols-2">
        <SettingsCard>
          <SettingsRow
            {...enabledField.anchorProps}
            title={enabledField.title}
            hint={enabledField.description}
            trailing={
              <Switch
                {...enabledField.controlProps}
                aria-label={enabledField.title}
                checked={settings?.enabled ?? false}
                disabled={!settings || saving || (invalid && !settings.enabled)}
                onCheckedChange={(enabled) => void save({ enabled })}
              />
            }
          />
          <SettingsRow
            {...daysField.anchorProps}
            wrap
            title={daysField.title}
            hint={daysField.description}
            trailing={
              <div className="flex min-w-0 flex-col gap-3">
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
            <p className="text-12 text-[var(--text-secondary)]">
              {t('taskManagement.archiveHint')}
            </p>
          </SettingsBlock>
        </SettingsCard>
        <SettingsSection title={t('taskManagement.preview')}>
          {error && <ErrorNotice message={t('taskManagement.loadFailed')} />}
          {!error && !preview && (
            <p className="text-13 text-[var(--text-secondary)]">{t('taskManagement.loading')}</p>
          )}
          {preview && (
            <>
              <p className="text-20 font-medium" aria-live="polite">
                {t('taskManagement.candidateCount', { count: preview.candidateCount })}
              </p>
              <p className="text-13 text-[var(--text-secondary)]">
                {t('taskManagement.keptCount', { count: preview.keptCount })}
              </p>
              <p className="text-12 text-[var(--text-tertiary)]">
                {preview.lastCheckAt
                  ? t('taskManagement.lastCheck', {
                      date: new Date(preview.lastCheckAt).toLocaleString(i18n.language),
                    })
                  : t('taskManagement.notChecked')}
              </p>
            </>
          )}
        </SettingsSection>
      </div>
    </SettingsSection>
  );
}
