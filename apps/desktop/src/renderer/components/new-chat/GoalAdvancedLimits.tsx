/**
 * GoalAdvancedLimits —— 目标「高级设置」折叠区(编辑 / 新建弹窗共用)。
 *
 * 三个安全上限改用下拉(各含「不限」=null),默认收起。值类型 number | null。
 * 预设见下方常量;若当前值不在预设里(历史自定义值),会作为额外一项保留显示。
 * 下拉用共享 Select(紧凑 32px、220px),颜色随共享组件；120px 窄档放不下「不限」的译文。
 */

import { Select } from '@/components/ui/select';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

const UNLIMITED = '__unlimited__';

/** 推荐预设(2026-06 与用户确认)。 */
const MAX_TURNS_PRESETS = [10, 20, 50, 100];
const BUDGET_PRESETS = [500_000, 1_000_000, 2_000_000, 5_000_000];
const NO_PROGRESS_PRESETS = [2, 3, 5];

export interface GoalLimitValues {
  maxTurns: number | null;
  budgetTokens: number | null;
  noProgressLimit: number | null;
}

/** 系统默认上限(与 main 端 goal-settings-store DEFAULTS 一致)。新建弹窗初值用它。 */
export const DEFAULT_GOAL_LIMITS: GoalLimitValues = {
  maxTurns: null,
  budgetTokens: null,
  noProgressLimit: 3,
};

/** token 预设的紧凑标签:500000→500K、1000000→1M。 */
function formatTokens(n: number): string {
  if (n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n % 1000 === 0) return `${n / 1000}K`;
  return String(n);
}

function LimitSelect({
  label,
  value,
  onChange,
  presets,
  format,
  noLimitLabel,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  presets: number[];
  format: (n: number) => string;
  noLimitLabel: string;
}): React.ReactElement {
  // 当前值不在预设里(历史自定义)→ 作为额外一项前置,避免编辑时丢值。
  const nums = value != null && !presets.includes(value) ? [value, ...presets] : presets;
  const current = value == null ? UNLIMITED : String(value);
  // 共享 Select(DESIGN.md §4 Desktop settings controls):紧凑 32px、220px。
  return (
    <Select
      label={label}
      value={current}
      size="compact"
      width="sm"
      options={[
        ...nums.map((n) => ({ value: String(n), label: format(n) })),
        { value: UNLIMITED, label: noLimitLabel },
      ]}
      onValueChange={(s) => onChange(s === UNLIMITED ? null : Number(s))}
    />
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-12 font-medium" style={{ color: 'var(--text-primary)' }}>
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * 折叠的「高级设置」区。受控:value/onChange 由父弹窗持有。默认收起(defaultOpen=false)。
 */
export function GoalAdvancedLimits({
  value,
  onChange,
}: {
  value: GoalLimitValues;
  onChange: (next: GoalLimitValues) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const noLimit = t('goal.editGoal.noLimit');
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        className="flex items-center gap-1 text-left text-12 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {t('goal.editGoal.advanced')}
      </button>
      {open && (
        <div className="flex flex-col gap-3">
          <div className="text-11" style={{ color: 'var(--text-tertiary)' }}>
            {t('goal.editGoal.advancedHint')}
          </div>
          <Row label={t('goal.editGoal.maxTurns')}>
            <LimitSelect
              label={t('goal.editGoal.maxTurns')}
              value={value.maxTurns}
              onChange={(v) => onChange({ ...value, maxTurns: v })}
              presets={MAX_TURNS_PRESETS}
              format={(n) => String(n)}
              noLimitLabel={noLimit}
            />
          </Row>
          <Row label={t('goal.editGoal.budgetTokens')}>
            <LimitSelect
              label={t('goal.editGoal.budgetTokens')}
              value={value.budgetTokens}
              onChange={(v) => onChange({ ...value, budgetTokens: v })}
              presets={BUDGET_PRESETS}
              format={formatTokens}
              noLimitLabel={noLimit}
            />
          </Row>
          <Row label={t('goal.editGoal.noProgressLimit')}>
            <LimitSelect
              label={t('goal.editGoal.noProgressLimit')}
              value={value.noProgressLimit}
              onChange={(v) => onChange({ ...value, noProgressLimit: v })}
              presets={NO_PROGRESS_PRESETS}
              format={(n) => String(n)}
              noLimitLabel={noLimit}
            />
          </Row>
        </div>
      )}
    </div>
  );
}
