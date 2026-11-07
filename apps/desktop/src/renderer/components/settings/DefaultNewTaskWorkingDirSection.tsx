import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Folder, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { isDataOwnerIdCurrent, getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import {
  setDefaultNewTaskWorkingDir,
  useDefaultNewTaskWorkingDir,
} from '@/state/defaultNewTaskWorkingDir';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_ROW_CLASS,
  SETTINGS_ROW_HINT_CLASS,
  SETTINGS_ROW_LABEL_CLASS,
  SETTINGS_SECTION_TITLE_CLASS,
} from './settingsRowClasses';
import { generalSettings } from './GeneralSettings.settings-search';
import { useSettingDefinition } from './useSettingDefinition';

export function DefaultNewTaskWorkingDirSection({ ownerId }: { ownerId: string | null }) {
  const { t } = useTranslation();
  const setting = useSettingDefinition(generalSettings.defaultNewTaskWorkingDir);
  const path = useDefaultNewTaskWorkingDir(ownerId);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);

  const update = async (action: 'choose' | 'clear') => {
    if (!ownerId || pending.current) return;
    const owner = getDataOwnerGeneration();
    if (owner.dataOwnerId !== ownerId) return;
    pending.current = true;
    setBusy(true);
    try {
      if (action === 'clear') {
        setDefaultNewTaskWorkingDir(ownerId, null);
        return;
      }
      const result = await window.electronAPI.showOpenDirectoryDialog();
      if (result.canceled || !result.path || !isDataOwnerIdCurrent(owner)) return;
      setDefaultNewTaskWorkingDir(ownerId, result.path);
    } catch {
      toast.error(t('settings.defaultNewTaskWorkingDir.failed'));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-[14px]">
      <h2 className={SETTINGS_SECTION_TITLE_CLASS}>
        {setting.title}
      </h2>
      <div className={SETTINGS_CARD_CLASS}>
        <div className={`${SETTINGS_ROW_CLASS} flex-wrap`}>
          <div className="w-full min-w-0 sm:w-auto sm:flex-1">
            <p className={SETTINGS_ROW_LABEL_CLASS}>
              {t('settings.defaultNewTaskWorkingDir.label')}
            </p>
            <p className={`${SETTINGS_ROW_HINT_CLASS} mt-1`}>
              {t('settings.defaultNewTaskWorkingDir.hint')}
            </p>
            <p
              className="mt-2 break-all text-12 text-[var(--text-secondary)]"
              title={path ?? undefined}
            >
              {path ?? t('settings.defaultNewTaskWorkingDir.unset')}
            </p>
          </div>
          <div className="flex w-full min-w-0 flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
            {path && (
              <Button
                {...setting.controlProps}
                variant="secondary"
                size="md"
                className="w-full gap-1.5 sm:w-auto"
                disabled={busy || !ownerId}
                onClick={() => void update('clear')}
              >
                <RotateCcw size={14} aria-hidden />
                {t('settings.defaultNewTaskWorkingDir.clear')}
              </Button>
            )}
            <Button
              {...setting.controlProps}
              variant="secondary"
              size="md"
              className="w-full gap-1.5 sm:w-auto"
              disabled={busy || !ownerId}
              onClick={() => void update('choose')}
            >
              <Folder size={14} aria-hidden />
              {t('settings.defaultNewTaskWorkingDir.choose')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
