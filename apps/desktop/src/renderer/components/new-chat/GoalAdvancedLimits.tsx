/**
 * GoalAdvancedLimits —— 目标「高级设置」折叠区(编辑 / 新建弹窗共用)。
 *
 * 三个安全上限改用下拉(各含「不限」=null),默认收起。值类型 number | null。
 * 预设见下方常量;若当前值不在预设里(历史自定义值),会作为额外一项保留显示。
 * 颜色全走主题 token(规则 16):trigger 用 settings-input,下拉面板用 model-dropdown。
 */

import * as Select from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
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

function LimitItem({ value, label }: { value: string; label: string }): React.ReactElement {
  return (
    <Select.Item
      value={value}
      className="flex cursor-pointer items-center justify-between gap-3 rounded-[8px] px-2.5 py-1.5 text-12 outline-none data-[highlighted]:bg-[var(--model-item-hover)]"
      style={{ color: 'var(--model-item-text)' }}
    >
      <Select.ItemText>{label}</Select.ItemText>
      <Select.ItemIndicator>
        <Check size={13} className="shrink-0" />
      </Select.ItemIndicator>
    </Select.Item>
  );
}

function LimitSelect({
  value,
  onChange,
  presets,
  format,
  noLimitLabel,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  presets: number[];
  format: (n: number) => string;
  noLimitLabel: string;
}): React.ReactElement {
  // 当前值不在预设里(历史自定义)→ 作为额外一项前置,避免编辑时丢值。
  const nums = value != null && !presets.includes(value) ? [value, ...presets] : presets;
  const current = value == null ? UNLIMITED : String(value);
  return (
    <Select.Root value={current} onValueChange={(s) => onChange(s === UNLIMITED ? null : Number(s))}>
      <Select.Trigger
        className="flex h-8 w-[140px] items-center justify-between gap-1 rounded-full border px-3 text-12 outline-none"
        style={{
          backgroundColor: 'var(--settings-input-bg)',
          borderColor: 'var(--settings-input-border)',
          color: 'var(--settings-input-text)',
        }}
      >
        <Select.Value />
        <Select.Icon>
          <ChevronDown size={13} className="opacity-60" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          className="z-[10002] overflow-hidden rounded-[12px] border p-1"
          style={{
            // 宽度严格跟随 trigger(radix popper 暴露的变量),避免 popup 按内容宽度自适应。
            width: 'var(--radix-select-trigger-width)',
            backgroundColor: 'var(--model-dropdown-bg)',
            borderColor: 'var(--model-dropdown-border)',
          }}
        >
          <Select.Viewport>
            {nums.map((n) => (
              <LimitItem key={n} value={String(n)} label={format(n)} />
            ))}
            <LimitItem value={UNLIMITED} label={noLimitLabel} />
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
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
              value={value.maxTurns}
              onChange={(v) => onChange({ ...value, maxTurns: v })}
              presets={MAX_TURNS_PRESETS}
              format={(n) => String(n)}
              noLimitLabel={noLimit}
            />
          </Row>
          <Row label={t('goal.editGoal.budgetTokens')}>
            <LimitSelect
              value={value.budgetTokens}
              onChange={(v) => onChange({ ...value, budgetTokens: v })}
              presets={BUDGET_PRESETS}
              format={formatTokens}
              noLimitLabel={noLimit}
            />
          </Row>
          <Row label={t('goal.editGoal.noProgressLimit')}>
            <LimitSelect
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
