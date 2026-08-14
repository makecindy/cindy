/**
 * CollaborationSection — multi-worker 协同设置 (softLimit / hardLimit / idleReleaseMinutes)。
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { DefaultOverrideControls } from './DefaultOverrideControls';

/** 带分割线的多行卡片:卡片自身不留内边距,由每行 `px-4 py-4` 承担(房规见 SubagentModelSection 卡 2)。 */
const CARD_CLASS = cn(
  'flex flex-col rounded-xl',
  'bg-[var(--settings-theme-card-bg)]',
  'border border-[var(--settings-theme-card-border)]',
);
/** 卡片内一行:左侧标签 + 说明,右侧控件相对整块垂直居中。 */
const ROW_CLASS = 'flex items-center justify-between gap-3 px-4 py-4';
const ROW_LABEL_CLASS = 'text-13 font-medium text-[var(--settings-section-sublabel)]';
const ROW_HINT_CLASS =
  'text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70';
/** 行间分割线:左右缩进与行内边距对齐。 */
const DIVIDER_CLASS = 'mx-4 h-px bg-[var(--settings-theme-card-border)]';

/**
 * 数字输入框的框体规格,与设置页统一输入框 `SettingsTextInput` 的 md 档一致
 * (DESIGN.md §4-5:单行输入走药丸圆角;fill 必须是 `--surface-elevated` —— 设置卡片
 * 本身是 ivory,ivory 输入压在 ivory 卡上会与背景同色、填充对比度归零)。
 * 上下调节沿用浏览器原生步进器,不自绘 —— 设置页的控件样式统一是独立议题,留待整体收敛。
 */
const NUMBER_INPUT_CLASS = cn(
  'h-9 w-24 shrink-0 rounded-full px-4 text-13 outline-none transition-colors',
  'bg-[var(--surface-elevated)] text-[var(--settings-input-text)]',
  'border border-[var(--settings-input-border)] focus:border-[var(--settings-input-border-focus)]',
  'focus:ring-2 focus:ring-[var(--focus-ring)]',
);

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
    <div className="flex flex-col gap-[14px]">
      {/* min-h 锁住标题行高度:DefaultOverrideControls 未自定义时返回 null,若不预留
          高度,首次改动让「已自定义」+ 恢复按钮(30px)出现会把整段往下顶,列表抖一下。 */}
      <div className="flex min-h-[30px] items-center justify-between gap-3">
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

      <div className={CARD_CLASS}>
        {/* Worker Soft Limit */}
        <label className={ROW_CLASS}>
          <span className="flex min-w-0 flex-col gap-1">
            <span className={ROW_LABEL_CLASS} style={{ letterSpacing: '0.12px' }}>
              {t('settings.collaboration.workerSoftLimit')}
            </span>
            <span className={ROW_HINT_CLASS}>
              {t('settings.collaboration.workerSoftLimitHint')}
            </span>
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
            className={NUMBER_INPUT_CLASS}
          />
        </label>

        <div className={DIVIDER_CLASS} />

        {/* Worker Hard Limit */}
        <label className={ROW_CLASS}>
          <span className="flex min-w-0 flex-col gap-1">
            <span className={ROW_LABEL_CLASS} style={{ letterSpacing: '0.12px' }}>
              {t('settings.collaboration.workerHardLimit')}
            </span>
            <span className={ROW_HINT_CLASS}>
              {t('settings.collaboration.workerHardLimitHint')}
            </span>
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
            className={NUMBER_INPUT_CLASS}
          />
        </label>

        <div className={DIVIDER_CLASS} />

        {/* Idle Release Minutes */}
        <label className={ROW_CLASS}>
          <span className="flex min-w-0 flex-col gap-1">
            <span className={ROW_LABEL_CLASS} style={{ letterSpacing: '0.12px' }}>
              {t('settings.collaboration.idleRelease')}
            </span>
            <span className={ROW_HINT_CLASS}>
              {t('settings.collaboration.idleReleaseHint')}
            </span>
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
            className={NUMBER_INPUT_CLASS}
          />
        </label>
      </div>
    </div>
  );
}
