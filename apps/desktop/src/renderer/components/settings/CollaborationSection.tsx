/**
 * CollaborationSection — multi-worker 协同设置 (softLimit / hardLimit / idleReleaseMinutes)。
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { DefaultOverrideControls } from './DefaultOverrideControls';

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
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.collaboration.title')}
        </h2>
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

      {/* Worker Soft Limit */}
      <label className="flex flex-col gap-1.5">
        <span className="text-12 font-medium text-[var(--text-primary)]">
          {t('settings.collaboration.workerSoftLimit')}
        </span>
        <span className="text-11 text-[var(--text-tertiary)]">
          {t('settings.collaboration.workerSoftLimitHint')}
        </span>
        <input
          type="number"
          min={1}
          max={settings.workerHardLimit}
          value={settings.workerSoftLimit}
          onChange={(e) => {
            const v = Math.max(1, Math.min(settings.workerHardLimit, Number(e.target.value) || 1));
            persist('workerSoftLimit', v);
          }}
          className="mt-0.5 w-20 rounded-lg border border-[var(--border-default)] bg-transparent px-3 py-1.5 text-13 text-[var(--settings-input-text)] outline-none"
        />
      </label>

      {/* Worker Hard Limit */}
      <label className="flex flex-col gap-1.5">
        <span className="text-12 font-medium text-[var(--text-primary)]">
          {t('settings.collaboration.workerHardLimit')}
        </span>
        <span className="text-11 text-[var(--text-tertiary)]">
          {t('settings.collaboration.workerHardLimitHint')}
        </span>
        <input
          type="number"
          min={settings.workerSoftLimit}
          max={20}
          value={settings.workerHardLimit}
          onChange={(e) => {
            const v = Math.max(settings.workerSoftLimit, Math.min(20, Number(e.target.value) || settings.workerSoftLimit));
            persist('workerHardLimit', v);
          }}
          className="mt-0.5 w-20 rounded-lg border border-[var(--border-default)] bg-transparent px-3 py-1.5 text-13 text-[var(--settings-input-text)] outline-none"
        />
      </label>

      {/* Idle Release Minutes */}
      <label className="flex flex-col gap-1.5">
        <span className="text-12 font-medium text-[var(--text-primary)]">
          {t('settings.collaboration.idleRelease')}
        </span>
        <span className="text-11 text-[var(--text-tertiary)]">
          {t('settings.collaboration.idleReleaseHint')}
        </span>
        <input
          type="number"
          min={0}
          max={120}
          value={settings.workerIdleReleaseMinutes}
          onChange={(e) => {
            const raw = Number(e.target.value);
            const v = Math.max(0, Math.min(120, Number.isFinite(raw) ? Math.trunc(raw) : 0));
            persist('workerIdleReleaseMinutes', v);
          }}
          className="mt-0.5 w-20 rounded-lg border border-[var(--border-default)] bg-transparent px-3 py-1.5 text-13 text-[var(--settings-input-text)] outline-none"
        />
      </label>
    </div>
  );
}
