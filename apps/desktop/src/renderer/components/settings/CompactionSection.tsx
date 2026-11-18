/** Settings → Personalization: native Codex compaction preference. */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { SETTINGS_HINT, SettingsCard, SettingsField, SettingsSection } from '@/components/ui/settings-rows';
import { toast } from '@/lib/toast';
import { DefaultOverrideControls } from './DefaultOverrideControls';
import { personalizationSettings } from './PersonalizationSettings.settings-search';

function CodexCompactionCard() {
  const { t } = useTranslation();
  const [state, setState] = useState<{ enabled: boolean; isCustomized: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const owner = getDataOwnerGeneration();
    void window.electronAPI.maker.codexCompactionGet().then(next => {
      if (mounted.current && isDataOwnerGenerationCurrent(owner)) setState(next);
    }).catch(() => {
      if (mounted.current && isDataOwnerGenerationCurrent(owner)) toast.error(t('settings.compaction.codex.loadFailed'));
    });
    return () => { mounted.current = false; };
  }, [t]);
  const save = async (enabled: boolean | null) => {
    const owner = getDataOwnerGeneration();
    setPending(true);
    try {
      const next = await window.electronAPI.maker.codexCompactionSet(enabled, {
        dataOwnerId: owner.dataOwnerId, ownerGeneration: owner.generation,
      });
      if (mounted.current && isDataOwnerGenerationCurrent(owner)) setState(next);
    } catch (error) {
      if (mounted.current && isDataOwnerGenerationCurrent(owner)) {
        toast.error(error instanceof Error ? error.message : t('settings.compaction.codex.saveFailed'));
      }
    } finally {
      if (mounted.current && isDataOwnerGenerationCurrent(owner)) setPending(false);
    }
  };
  return (
    <SettingsCard>
      <SettingsField title={t(personalizationSettings.codexCompaction.titleKey)}
        hint={t(personalizationSettings.codexCompaction.descriptionKey)}
        action={<>
          <DefaultOverrideControls isCustomized={state?.isCustomized ?? false} disabled={pending || !state} onReset={() => void save(null)} />
          <Switch data-setting-id={personalizationSettings.codexCompaction.id} checked={state?.enabled ?? true} disabled={pending || !state}
            onCheckedChange={value => void save(value)} aria-label={t('settings.compaction.codex.label')} />
        </>}
      >
        <p className={SETTINGS_HINT}>{t('settings.compaction.codex.hint')}</p>
      </SettingsField>
    </SettingsCard>
  );
}

export function CompactionSection() {
  const { t } = useTranslation();
  return (
    <SettingsSection title={t('settings.compaction.title')}>
      <CodexCompactionCard />
    </SettingsSection>
  );
}
