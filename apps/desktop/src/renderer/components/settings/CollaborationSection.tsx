import { collaborationSettings } from './CollaborationSection.settings-search';
/**
 * CollaborationSection — multi-worker 协同设置 (softLimit / hardLimit / idleReleaseMinutes)。
 */

import { useState, useEffect, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import { DefaultOverrideControls } from './DefaultOverrideControls';
import { SettingsTextInput } from './SettingsTextInput';

/** 数字输入复用标准 Input md 档，设置封装保留旧局部主题覆盖，原生步进器不自绘。 */

interface CollaborationSettings {
  workerSoftLimit: number;
  workerHardLimit: number;
  workerIdleReleaseMinutes: number;
  isCustomized?: boolean;
}

type CollaborationSettingKey =
  | 'workerSoftLimit'
  | 'workerHardLimit'
  | 'workerIdleReleaseMinutes';

export function CollaborationSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<CollaborationSettings | null>(null);
  const idPrefix = useId();

  useEffect(() => {
    void window.electronAPI.localDb.orcaWorkflows
      .getCollaborationSettings?.()
      .then((s) => {
        const c = s as CollaborationSettings;
        if (c && typeof c.workerSoftLimit === 'number') setSettings(c);
      })
      .catch(() => {
        setSettings({ workerSoftLimit: 5, workerHardLimit: 8, workerIdleReleaseMinutes: 0 });
      });
  }, []);

  const persist = (key: CollaborationSettingKey, value: number) => {
    setSettings((prev) => prev ? { ...prev, [key]: value, isCustomized: true } : prev);
    void window.electronAPI.localDb.orcaWorkflows
      .setCollaborationSetting?.(key, value)
      .then((next) => setSettings(next as CollaborationSettings))
      .catch(() => {});
  };

  if (!settings) {
    return (
      <div className="py-8 text-center text-13 text-[var(--text-tertiary)]">
        {t('settings.collaboration.loading')}
      </div>
    );
  }

  return (
    <SettingsSection
      title={t('settings.collaboration.title')}
      action={
        // min-h 锁住标题行高度:DefaultOverrideControls 未自定义时返回 null,若不预留
        // 高度,首次改动让「已自定义」+ 恢复按钮(30px)出现会把整段往下顶,列表抖一下。
        <div className="flex min-h-[30px] items-center">
          <DefaultOverrideControls
            isCustomized={Boolean(settings.isCustomized)}
            onReset={() => {
              void window.electronAPI.localDb.orcaWorkflows
                .resetCollaborationSettings?.()
                .then((next) => {
                  setSettings(next as CollaborationSettings);
                  toast.success(t('settings.defaults.restored'));
                })
                .catch((err) => {
                  toast.error(err instanceof Error ? err.message : t('settings.defaults.restoreFailed'));
                });
            }}
          />
        </div>
      }
    >
      <SettingsCard>
        {/* Worker Soft Limit */}
        <SettingsRow
          title={
            <label id={collaborationSettings.workerSoftLimit.targetId} htmlFor={`${idPrefix}-soft`}>
              {t(collaborationSettings.workerSoftLimit.titleKey)}
            </label>
          }
          hint={<span id={`${idPrefix}-soft-hint`}>{t(collaborationSettings.workerSoftLimit.descriptionKey)}</span>}
          trailing={
            <SettingsTextInput data-setting-id={collaborationSettings.workerSoftLimit.id}
              id={`${idPrefix}-soft`}
              aria-describedby={`${idPrefix}-soft-hint`}
              type="number"
              min={1}
              max={settings.workerHardLimit}
              value={String(settings.workerSoftLimit)}
              onChange={(text) => {
                const v = Math.max(1, Math.min(settings.workerHardLimit, Number(text) || 1));
                persist('workerSoftLimit', v);
              }}
              size="md"
              className="w-24 shrink-0"
            />
          }
        />

        {/* Worker Hard Limit */}
        <SettingsRow
          title={
            <label id={collaborationSettings.workerHardLimit.targetId} htmlFor={`${idPrefix}-hard`}>
              {t(collaborationSettings.workerHardLimit.titleKey)}
            </label>
          }
          hint={<span id={`${idPrefix}-hard-hint`}>{t(collaborationSettings.workerHardLimit.descriptionKey)}</span>}
          trailing={
            <SettingsTextInput data-setting-id={collaborationSettings.workerHardLimit.id}
              id={`${idPrefix}-hard`}
              aria-describedby={`${idPrefix}-hard-hint`}
              type="number"
              min={settings.workerSoftLimit}
              max={20}
              value={String(settings.workerHardLimit)}
              onChange={(text) => {
                const v = Math.max(
                  settings.workerSoftLimit,
                  Math.min(20, Number(text) || settings.workerSoftLimit),
                );
                persist('workerHardLimit', v);
              }}
              size="md"
              className="w-24 shrink-0"
            />
          }
        />

        {/* Idle Release Minutes */}
        <SettingsRow
          title={
            <label id={collaborationSettings.idleRelease.targetId} htmlFor={`${idPrefix}-idle`}>
              {t(collaborationSettings.idleRelease.titleKey)}
            </label>
          }
          hint={<span id={`${idPrefix}-idle-hint`}>{t(collaborationSettings.idleRelease.descriptionKey)}</span>}
          trailing={
            <SettingsTextInput data-setting-id={collaborationSettings.idleRelease.id}
              id={`${idPrefix}-idle`}
              aria-describedby={`${idPrefix}-idle-hint`}
              type="number"
              min={0}
              max={120}
              value={String(settings.workerIdleReleaseMinutes)}
              onChange={(text) => {
                const raw = Number(text);
                const v = Math.max(0, Math.min(120, Number.isFinite(raw) ? Math.trunc(raw) : 0));
                persist('workerIdleReleaseMinutes', v);
              }}
              size="md"
              className="w-24 shrink-0"
            />
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}
