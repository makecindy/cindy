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

const weights = [1, 2, 3, 5, 10, 20, 50, PROVIDER_GROUP_MAX_WEIGHT];

/**
 * OpenAI 订阅与 API key 混合的账号组在供应商页里的选法(main 2026-11-26 新增)。选项、名字与说明和智能路由同一套
 * (shared/routeStrategy.ts、modelGroups.strategy.*)，选的是同一个选择函数。
 */
export function ProviderGroupStrategyControl({ strategy, disabled, onChange, localAccounts = false }: {
  strategy: RouteStrategy;
  disabled: boolean;
  onChange: (strategy: RouteStrategy) => void;
  localAccounts?: boolean;
}) {
  const { t } = useTranslation();
  const label = t(localAccounts ? 'openAiAccountGroup.strategy' : 'modelGroups.settings.pick');
  return (
    <SettingsBlock className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-13 text-[var(--text-primary)]">{label}</span>
        <Select label={label} value={strategy} disabled={disabled} width="sm"
          options={SAME_SOURCE_ROUTE_STRATEGIES.map(value => ({ value, label: t(`modelGroups.strategy.${value}.title`) }))}
          onValueChange={value => onChange(value as RouteStrategy)} />
      </div>
      <span className="text-12 leading-[1.4] text-[var(--text-secondary)]">{t(`modelGroups.strategy.${strategy}.hint`)}</span>
      <span className="text-12 leading-[1.4] text-[var(--text-tertiary)]">
        {t(localAccounts ? 'openAiAccountGroup.quotaHint' : 'modelGroups.auto.quotaFirst')}
      </span>
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
