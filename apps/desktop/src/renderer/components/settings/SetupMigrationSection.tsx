/**
 * Settings → General → Migration Assistant: start new-computer setup, and keep the one-time checklist from the
 * last setup visible until each item is done (docs/product-rules/new-device-setup-migration.md).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
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
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_ROW_CLASS,
  SETTINGS_ROW_DIVIDER_CLASS,
  SETTINGS_ROW_HINT_CLASS,
  SETTINGS_ROW_LABEL_CLASS,
  SETTINGS_SECTION_TITLE_CLASS,
} from './settingsRowClasses';

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
    <div className="flex flex-col gap-[14px]">
      <h2 className={SETTINGS_SECTION_TITLE_CLASS}>{t('setupMigration.settings.title')}</h2>
      <div className={SETTINGS_CARD_CLASS}>
        <div className={SETTINGS_ROW_CLASS}>
          {/* The section title already names the feature; the row carries only its one-line description. */}
          <span className={cn('min-w-0', SETTINGS_ROW_LABEL_CLASS)}>{t('setupMigration.settings.description')}</span>
          <Button variant="secondary" size="md" className="shrink-0" onClick={() => openSetupMigration()}>
            {t('setupMigration.settings.start')}
          </Button>
        </div>
        {state?.lastRun && checklist.length > 0 ? (
          <>
            <div className={SETTINGS_ROW_DIVIDER_CLASS} />
            <div className="flex items-center justify-between gap-3 px-4 pt-4">
              <span className="flex min-w-0 flex-col gap-1">
                <span className={SETTINGS_ROW_LABEL_CLASS}>
                  {pending.length > 0
                    ? t('setupMigration.settings.pending', { count: pending.length })
                    : t('setupMigration.settings.allDone')}
                </span>
                <span className={SETTINGS_ROW_HINT_CLASS}>
                  {t('setupMigration.settings.from', { name: state.lastRun.sourceName })}
                </span>
              </span>
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
            </div>
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
      </div>
    </div>
  );
}
