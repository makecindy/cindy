/**
 * Settings → General → Migration Assistant: start new-computer setup, and keep the one-time checklist from the
 * last setup visible until each item is done (docs/product-rules/new-device-setup-migration.md).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import {
  SetupMigrationChecklist,
  startChecklistWalkthrough,
} from '@/features/setup-migration/SetupMigrationChecklist';
import { openChecklistRoute } from '@/features/setup-migration/checklistTargets';
import {
  openSetupMigration,
  subscribeSetupMigrationStateChanged,
} from '@/features/setup-migration/setupMigrationStore';
import type {
  SetupMigrationChecklistItem,
  SetupMigrationDismissRequest,
  SetupMigrationState,
} from '../../../shared/setupMigration';

export function SetupMigrationSection() {
  const { t } = useTranslation();
  const [state, setState] = useState<SetupMigrationState | null>(null);

  const refresh = useCallback(() => {
    // Older preloads (and partial test shells) have no setup bridge; the start button still works.
    const api = window.electronAPI?.setupMigration;
    if (!api) return;
    api
      .state()
      .then(setState)
      .catch(() => setState(null));
  }, []);

  useEffect(() => {
    refresh();
    return subscribeSetupMigrationStateChanged(refresh);
  }, [refresh]);

  const dismiss = (request: SetupMigrationDismissRequest) => {
    window.electronAPI?.setupMigration
      ?.dismiss(request)
      .then(setState)
      .catch(() => {});
  };

  const pending = state?.lastRun?.checklist.filter((item) => !item.done) ?? [];
  const checklist = state?.lastRun?.checklist ?? [];

  return (
    <SettingsSection title={t('setupMigration.settings.title')}>
      <SettingsCard>
        {/* The section title already names the feature; the row carries only its one-line description. */}
        <SettingsRow
          title={t('setupMigration.settings.description')}
          trailing={
            <Button variant="secondary" size="md" className="shrink-0" onClick={() => openSetupMigration()}>
              {t('setupMigration.settings.start')}
            </Button>
          }
        />
        {state?.lastRun && checklist.length > 0 ? (
          <>
            {/* 清单标题行紧贴下方清单，去掉行的下内边距。 */}
            <SettingsRow
              className="pb-0"
              title={
                pending.length > 0
                  ? t('setupMigration.settings.pending', { count: pending.length })
                  : t('setupMigration.settings.allDone')
              }
              hint={t('setupMigration.settings.from', { name: state.lastRun.sourceName })}
              trailing={
                <Button
                  variant="secondary"
                  size="sm"
                  tone="quiet"
                  compact
                  className="shrink-0"
                  onClick={() => dismiss({ kind: 'checklist' })}
                >
                  {t('setupMigration.settings.closeChecklist')}
                </Button>
              }
            />
            <div className="pb-2">
              <SetupMigrationChecklist
                items={checklist}
                variant="settings"
                onOpen={(item: SetupMigrationChecklistItem) => openChecklistRoute(item)}
                onMarkDone={(item) => dismiss({ kind: 'checklist-item', id: item.id })}
                onStartAll={() => startChecklistWalkthrough(checklist, openChecklistRoute)}
              />
            </div>
          </>
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}
