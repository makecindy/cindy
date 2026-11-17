/**
 * CompactionSection — Settings → Personalization 下的自动上下文压缩阈值。
 *
 * Claude Code 与 Pi 分别保存阈值；Claude 由 host 读取，Pi 在每次启动或恢复任务时写入
 * 原生 settings.json 的 compaction.reserveTokens。renderer 只负责渲染和提交设置。
 */

import { useTranslation } from 'react-i18next';

import { useCompactionSettings, type CompactionAgent } from '@/hooks/useCompactionSettings';
import { Slider } from '@/components/ui/slider';
import { SETTINGS_HINT, SettingsCard, SettingsField, SettingsSection } from '@/components/ui/settings-rows';
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
    <SettingsCard>
      <SettingsField
        title={t(`${key}.label`)}
        hint={t(`${key}.description`)}
        action={<>
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
        </>}
      >
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

        <p className={SETTINGS_HINT}>{t(`${key}.hint`)}</p>
      </SettingsField>
    </SettingsCard>
  );
}

export function CompactionSection() {
  const { t } = useTranslation();
  const claude = useCompactionSettings('claude');
  const pi = useCompactionSettings('pi');

  if (claude.pct === null || pi.pct === null) return null;

  return (
    <SettingsSection
      title={t('settings.compaction.title')}
      description={t('settings.compaction.description')}
    >
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
    </SettingsSection>
  );
}
