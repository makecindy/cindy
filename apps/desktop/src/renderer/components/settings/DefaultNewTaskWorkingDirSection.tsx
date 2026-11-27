import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Folder, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import { isDataOwnerIdCurrent, getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import {
  setDefaultNewTaskWorkingDir,
  useDefaultNewTaskWorkingDir,
} from '@/state/defaultNewTaskWorkingDir';
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
    <SettingsSection title={setting.title}>
      <SettingsCard>
        <SettingsRow
          wrap
          title={t('settings.defaultNewTaskWorkingDir.label')}
          hint={<>
            <span className="block">{t('settings.defaultNewTaskWorkingDir.hint')}</span>
            <span className="mt-2 block break-all" title={path ?? undefined}>
              {path ?? t('settings.defaultNewTaskWorkingDir.unset')}
            </span>
          </>}
          trailing={<div className="flex w-full min-w-0 flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
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
          </div>}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
