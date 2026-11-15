import { useId } from 'react';
import { useTranslation } from 'react-i18next';

export type RebalanceChoice = 'once' | 'auto' | 'off';

/** Mutually exclusive task choices stay aligned, including when translated labels wrap. */
export function SessionRebalanceChoices({ onChange }: { onChange: (choice: RebalanceChoice) => void }) {
  const name = useId();
  const { t } = useTranslation();
  const options = [
    { value: 'once', label: t('providerGroup.rebalance.confirm') },
    { value: 'auto', label: t('providerGroup.rebalance.remember') },
    { value: 'off', label: t('providerGroup.rebalance.disable') },
  ] as const;

  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-13 font-medium text-[var(--confirm-title)]">
        {t('providerGroup.rebalance.choiceLabel')}
      </legend>
      {options.map((option) => (
        <label key={option.value} className="flex min-h-9 cursor-pointer items-start gap-3 py-2 text-13 leading-5 text-[var(--text-primary)]">
          <input
            type="radio"
            name={name}
            value={option.value}
            defaultChecked={option.value === 'once'}
            onChange={() => onChange(option.value)}
            className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-[var(--text-primary)]"
          />
          <span className="min-w-0 [overflow-wrap:anywhere]">{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}
