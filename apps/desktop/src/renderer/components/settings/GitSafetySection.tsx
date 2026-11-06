import { gitSafetySettings } from './GitSafetySection.settings-search';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useGitSafetySettings } from '@/hooks/useGitSafetySettings';
import type { GitSafetyMode } from '@/lib/gitSafetySettingsStore';
import { SegmentedControl } from '@/components/ui/segmented-control';
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
    <div className="flex flex-col gap-[14px]">
      <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
        {t('settings.gitSafety.title')}
      </h2>

      <div
        className={cn(
          'flex flex-col gap-3 rounded-xl px-4 py-4',
          'bg-[var(--settings-theme-card-bg)]',
          'border border-[var(--settings-theme-card-border)]',
        )}
      >
        <div className="cindy-segmented-row">
          <div className="flex min-w-0 flex-col gap-1">
            <p id={gitSafetySettings.autoSnapshotTitle.targetId} className="text-13 font-medium text-[var(--settings-section-sublabel)]">
              {t(gitSafetySettings.autoSnapshotTitle.titleKey)}
            </p>
            <p className="text-12 leading-[1.4] text-[var(--text-secondary)]">{t(gitSafetySettings.autoSnapshotTitle.descriptionKey)}</p>
          </div>

          <div className="cindy-segmented-row-actions">
          <SegmentedControl data-setting-id={gitSafetySettings.autoSnapshotTitle.id}
            value={mode}
            onValueChange={handleModeChange}
            disabled={saving}
            aria-label={t('settings.gitSafety.modeAria')}
            options={gitSafetySettings.autoSnapshotTitle.options.map(({ value, labelKey }) => ({ value, label: t(labelKey) }))}
          />
          <DefaultOverrideControls isCustomized={isCustomized} disabled={saving} onReset={handleReset} />
          </div>
        </div>
      </div>
    </div>
  );
}
