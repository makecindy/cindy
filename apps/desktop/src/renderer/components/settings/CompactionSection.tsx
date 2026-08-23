/**
 * CompactionSection — Settings → Personalization 下的自动上下文压缩阈值。
 * Claude Code 与 Pi 共用同一份设置；Codex 由上游自己压，不读这里。
 *
 * main 的 <userData>/compaction-settings.json 是 source of truth。renderer 只负责
 * 拉取、渲染和把滑块数值提交给 IPC；实际 clamp 与 runtimeConfig 注入都在 main 完成。
 */

import { useTranslation } from 'react-i18next';

import { useCompactionSettings } from '@/hooks/useCompactionSettings';
import { Slider } from '@/components/ui/slider';
import { toast } from '@/lib/toast';
import { DefaultOverrideControls } from './DefaultOverrideControls';

export function CompactionSection() {
  const { t } = useTranslation();
  const { pct, isCustomized, resetPct, setPct } = useCompactionSettings();

  if (pct === null) return null;

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex flex-col gap-1">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.compaction.title')}
        </h2>
        <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
          {t('settings.compaction.description')}
        </p>
      </div>

      <div className="flex flex-col gap-[14px] rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-14 font-medium leading-none text-[var(--text-primary)]">
            {t('settings.compaction.card.label')}
          </p>
          <div className="flex items-center gap-2">
            <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-2.5 py-1 text-11 font-medium leading-none text-[var(--text-secondary)]">
              {t('settings.compaction.card.badge')}
            </span>
            <DefaultOverrideControls
              isCustomized={isCustomized}
              onReset={() => {
                void resetPct()
                  .then(() => toast.success(t('settings.defaults.restored')))
                  .catch((err) => {
                    toast.error(err instanceof Error ? err.message : t('settings.defaults.restoreFailed'));
                  });
              }}
            />
          </div>
        </div>

        <p className="text-12 leading-[1.5] text-[var(--text-secondary)]">
          {t('settings.compaction.card.description')}
        </p>

        <div className="flex items-center gap-[14px]">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Slider
              value={[pct]}
              min={50}
              max={95}
              step={1}
              onValueChange={(value: number[]) => {
                const next = value[0];
                if (typeof next === 'number') setPct(next);
              }}
              aria-label={t('settings.compaction.card.sliderAria')}
            />
            <div className="flex items-center justify-between text-11 leading-none text-[var(--text-tertiary)]">
              <span>50%</span>
              <span>95%</span>
            </div>
          </div>
          <span className="shrink-0 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-1.5 text-13 font-medium leading-none text-[var(--text-primary)]">
            {pct}%
          </span>
        </div>

        <p className="text-12 leading-[1.5] text-[var(--text-secondary)]">
          {t('settings.compaction.card.hint')}
        </p>
      </div>
    </div>
  );
}
