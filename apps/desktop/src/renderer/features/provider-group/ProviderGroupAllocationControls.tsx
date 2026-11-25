import { useTranslation } from 'react-i18next';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select } from '@/components/ui/select';
import { SettingsBlock } from '@/components/ui/settings-rows';
import {
  CONCURRENCY_LIMIT_OPTIONS,
  CONCURRENCY_LIMIT_UNLIMITED,
  concurrencyLimitFromOption,
  concurrencyLimitOptionValue,
  PROVIDER_GROUP_MAX_WEIGHT,
  PROVIDER_GROUP_STRATEGIES,
  type ProviderGroupStrategy,
} from '../../../shared/providerGroup';

type SelectableStrategy = Exclude<ProviderGroupStrategy, 'usage'>;
const strategies = PROVIDER_GROUP_STRATEGIES.filter((value): value is SelectableStrategy => value !== 'usage');
const weights = [1, 2, 3, 5, 10, 20, 50, PROVIDER_GROUP_MAX_WEIGHT];

export function ProviderGroupStrategyControl({ strategy, disabled, onChange, localAccounts = false }: {
  strategy: ProviderGroupStrategy;
  disabled: boolean;
  onChange: (strategy: SelectableStrategy) => void;
  localAccounts?: boolean;
}) {
  const { t } = useTranslation();
  // Legacy usage is handled by least-busy selection after the shared quota filter.
  const selected = strategy === 'usage' ? 'least' : strategy;
  const label = t(localAccounts ? 'openAiAccountGroup.strategy' : 'providerGroup.strategy.label');
  return (
    <SettingsBlock className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-13 text-[var(--text-primary)]">{label}</span>
        <SegmentedControl
          value={selected}
          onValueChange={onChange}
          aria-label={label}
          options={strategies.map(value => ({ value, label: t(`providerGroup.strategy.${value}`), disabled }))}
        />
        <span className="flex-1" />
        <span className="text-12 text-[var(--text-secondary)]">
          {t(localAccounts && selected === 'least' ? 'openAiAccountGroup.leastHint' : `providerGroup.strategy.description.${selected}`)}
        </span>
      </div>
      <span className="text-12 leading-[1.4] text-[var(--text-tertiary)]">
        {t(localAccounts ? 'openAiAccountGroup.quotaHint' : 'providerGroup.strategy.quotaFirst')}
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
