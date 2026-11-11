import { gitSafetySettings } from './GitSafetySection.settings-search';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import { useGitSafetySettings } from '@/hooks/useGitSafetySettings';
import type { GitSafetyMode } from '@/lib/gitSafetySettingsStore';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import { DefaultOverrideControls } from './DefaultOverrideControls';

export function GitSafetySection() {
  const { t } = useTranslation();
  const { mode, setMode, reset, isCustomized } = useGitSafetySettings();
  const [saving, setSaving] = useState(false);

  const handleModeChange = useCallback(
    (next: GitSafetyMode) => {
      if (saving) return;
      setSaving(true);
      void setMode(next)
        .catch((err: unknown) => {
          toast.error(err instanceof Error ? err.message : t('settings.gitSafety.saveFailed'));
        })
        .finally(() => setSaving(false));
    },
    [saving, setMode, t],
  );

  const handleReset = useCallback(() => {
    if (saving) return;
    setSaving(true);
    void reset()
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : t('settings.defaults.restoreFailed'));
      })
      .finally(() => setSaving(false));
  }, [reset, saving, t]);

  return (
    <SettingsSection title={t('settings.gitSafety.title')}>
      <SettingsCard>
        <SettingsRow
          className="cindy-segmented-row"
          title={<span id={gitSafetySettings.autoSnapshotTitle.targetId}>{t(gitSafetySettings.autoSnapshotTitle.titleKey)}</span>}
          hint={t(gitSafetySettings.autoSnapshotTitle.descriptionKey)}
          trailing={
            <div className="cindy-segmented-row-actions">
              {/* Per-setting reset sits left of the control (CONTROLS decision 3). */}
              <DefaultOverrideControls isCustomized={isCustomized} disabled={saving} onReset={handleReset} />
              <SegmentedControl data-setting-id={gitSafetySettings.autoSnapshotTitle.id}
                value={mode}
                onValueChange={handleModeChange}
                disabled={saving}
                aria-label={t('settings.gitSafety.modeAria')}
                options={gitSafetySettings.autoSnapshotTitle.options.map(({ value, labelKey }) => ({ value, label: t(labelKey) }))}
              />
            </div>
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}
