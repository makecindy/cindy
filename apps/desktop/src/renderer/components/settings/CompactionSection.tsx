/**
 * CompactionSection — Settings → Personalization 下的自动上下文压缩阈值。
 *
 * Claude Code 与 Pi 分别保存阈值；Claude 由 host 读取，Pi 在每次启动或恢复任务时写入
 * 原生 settings.json 的 compaction.reserveTokens。renderer 只负责渲染和提交设置。
 */

import { useTranslation } from 'react-i18next';

import { useCompactionSettings, type CompactionAgent } from '@/hooks/useCompactionSettings';
import { Slider } from '@/components/ui/slider';
import { toast } from '@/lib/toast';
import { DefaultOverrideControls } from './DefaultOverrideControls';

type CompactionCardProps = {
  agent: CompactionAgent;
  pct: number;
  isCustomized: boolean;
  resetPct: () => Promise<number>;
  setPct: (next: number) => void;
};

function CompactionCard({ agent, pct, isCustomized, resetPct, setPct }: CompactionCardProps) {
  const { t } = useTranslation();
  const key = agent === 'pi' ? 'settings.compaction.piCard' : 'settings.compaction.card';

  return (
    <div className="flex flex-col gap-[14px] rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-14 font-medium leading-none text-[var(--text-primary)]">
          {t(`${key}.label`)}
        </p>
        <div className="flex items-center gap-2">
          <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-2.5 py-1 text-11 font-medium leading-none text-[var(--text-secondary)]">
            {t(`${key}.badge`)}
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

      <p className="text-12 leading-[1.5] text-[var(--text-secondary)]">{t(`${key}.description`)}</p>

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
            aria-label={t(`${key}.sliderAria`)}
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

      <p className="text-12 leading-[1.5] text-[var(--text-secondary)]">{t(`${key}.hint`)}</p>
    </div>
  );
}

export function CompactionSection() {
  const { t } = useTranslation();
  const claude = useCompactionSettings('claude');
  const pi = useCompactionSettings('pi');

  if (claude.pct === null || pi.pct === null) return null;

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

      <CompactionCard
        agent="claude"
        pct={claude.pct}
        isCustomized={claude.isCustomized}
        resetPct={claude.resetPct}
        setPct={claude.setPct}
      />
      <CompactionCard
        agent="pi"
        pct={pi.pct}
        isCustomized={pi.isCustomized}
        resetPct={pi.resetPct}
        setPct={pi.setPct}
      />
    </div>
  );
}
