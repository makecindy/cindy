import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/select';
import { SettingsBlock } from '@/components/ui/settings-rows';
import {
  CONCURRENCY_LIMIT_OPTIONS,
  CONCURRENCY_LIMIT_UNLIMITED,
  concurrencyLimitFromOption,
  concurrencyLimitOptionValue,
  PROVIDER_GROUP_MAX_WEIGHT,
} from '../../../shared/providerGroup';
import { SAME_SOURCE_ROUTE_STRATEGIES, type RouteStrategy } from '../../../shared/routeStrategy';
import { routeStrategySelectGroups } from '@/features/model-groups/routeStrategyOptions';

const weights = [1, 2, 3, 5, 10, 20, 50, PROVIDER_GROUP_MAX_WEIGHT];

/**
 * 另一台电脑上的电脑组的选法：这台的智能路由管不到它，仍在组的页面里改、存到那台(本机的组在智能路由里改)。
 * 选项、名字与说明和智能路由同一套(shared/routeStrategy.ts、modelGroups.strategy.*)，选的是同一个选择函数。
 */
export function ProviderGroupStrategyControl({ strategy, disabled, onChange }: {
  strategy: RouteStrategy;
  disabled: boolean;
  onChange: (strategy: RouteStrategy) => void;
}) {
  const { t } = useTranslation();
  const label = t('modelGroups.settings.pick');
  return (
    <SettingsBlock className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-13 text-[var(--text-primary)]">{label}</span>
        <Select label={label} value={strategy} disabled={disabled} width="sm"
          groups={routeStrategySelectGroups(SAME_SOURCE_ROUTE_STRATEGIES, t)}
          onValueChange={value => onChange(value as RouteStrategy)} />
      </div>
      <span className="text-12 leading-[1.4] text-[var(--text-secondary)]">{t(`modelGroups.strategy.${strategy}.hint`)}</span>
    </SettingsBlock>
  );
}

export function ProviderGroupLimitSelect({ name, member, disabled, onChange, compact = false }: {
  name: string;
  member: { limit: number; limitSet?: boolean };
  disabled: boolean;
  onChange: (limit: number | null) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  return <Select label={t('providerGroup.member.limitAria', { name })} value={concurrencyLimitOptionValue(member)}
    disabled={disabled} size={compact ? 'compact' : 'default'} width="xs" options={CONCURRENCY_LIMIT_OPTIONS.map(value => ({
      value,
      label: value === CONCURRENCY_LIMIT_UNLIMITED ? t('providerGroup.member.limitUnlimited')
        : t('providerGroup.member.limitOption', { count: Number(value) }),
    }))} onValueChange={value => onChange(concurrencyLimitFromOption(value))} />;
}

export function ProviderGroupWeightSelect({ name, weight, disabled, onChange }: {
  name: string;
  weight: number;
  disabled: boolean;
  onChange: (weight: number) => void;
}) {
  const { t } = useTranslation();
  const options = weights.includes(weight) ? weights : [...weights, weight].sort((a, b) => a - b);
  return (
    <Select
      label={t('providerGroup.member.weightAria', { name })}
      value={String(weight)}
      options={options.map(value => ({ value: String(value), label: t('providerGroup.member.weightOption', { weight: value }) }))}
      onValueChange={value => onChange(Number(value))}
      disabled={disabled}
      width="xs"
    />
  );
}
